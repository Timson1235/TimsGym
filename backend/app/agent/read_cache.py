"""Request-local read reuse and model-only references; raw evidence stays in traces."""
from copy import deepcopy
import json

from .. import tracing
from .exercise_identity import resolve_exercise, normalize_exercise_name
from .tools import _recorded_sets

READ_NAMES = {'get_session_summary', 'get_workout_details', 'get_exercise_history', 'resolve_exercise', 'suggest_weight'}


class RequestReadCache:
    def __init__(self):
        self.generation = 0
        self.values, self.sent, self.workouts, self.workout_refs = {}, {}, {}, {}
        self.hits = self.misses = 0
        self.sequence = 0

    def invalidate(self):
        self.generation += 1
        self.values.clear()
        self.sent.clear()
        self.workouts.clear()
        self.workout_refs.clear()
        tracing.event('cache', 'Invalidate request reads', output={'generation': self.generation})

    def key(self, name, args, db):
        normalized = deepcopy(args)
        if name in {'get_exercise_history', 'suggest_weight', 'resolve_exercise'}:
            exercise = next((ex for ex in db.get('exercises', []) if ex['id'] == args.get('exercise_id')), None) if args.get('exercise_id') else None
            query = args.get('query', '') if name == 'resolve_exercise' else args.get('exercise_name', '')
            if not exercise and not args.get('exercise_id'):
                exercise, _ = resolve_exercise(db.get('exercises', []), query)
            normalized = {'exercise_id': exercise['id']} if exercise else {'exercise_id':args['exercise_id']} if args.get('exercise_id') else {'query': normalize_exercise_name(query)}
            if name == 'get_exercise_history':
                normalized['limit'] = max(1, min(10, int(args.get('limit') or 5)))
        elif name == 'get_session_summary':
            normalized = {'filter': (args.get('search_title_or_date') or '').strip().lower(),
                          'limit': max(1, min(10, int(args.get('limit') or 3))),
                          'include_details': bool(args.get('include_details')),
                          'cursor': args.get('cursor')}
        return name, json.dumps(normalized, sort_keys=True, separators=(',', ':'), allow_nan=False)

    def read(self, name, args, db, load):
        if name not in READ_NAMES:
            raise ValueError('Only approved read tools may use the request cache.')
        key = self.key(name, args, db)
        hit = key in self.values
        source = 'exact_read'
        if hit:
            value = self.values[key]
        elif name == 'get_workout_details' and args.get('workout_id') in self.workouts:
            value = {'status': 'found', 'workout': self.workouts[args['workout_id']]}
            hit, source = True, 'previous_full_workout'
            self.values[key] = deepcopy(value)
        else:
            value = load()
            self.values[key] = deepcopy(value)
        self.hits += int(hit)
        self.misses += int(not hit)
        tracing.event('cache', 'Request read', output={'tool':name, 'hit':hit, 'source':source, 'generation':self.generation})
        return deepcopy(value)

    def feedback(self, name, args, value, db):
        if name == 'batch_retrieve':
            requests = {item['key']:item for item in args['requests']}
            output = deepcopy(value)
            for item in output['results']:
                if item.get('success') and 'result' in item:
                    request = requests[item['key']]
                    item['result'] = self.feedback(request['tool'], request['arguments'], item['result'], db)
            return output
        key = self.key(name, args, db)
        if key in self.sent:
            return {'reused': True, 'resultRef': self.sent[key]}
        self.sequence += 1
        ref = f'read-{self.generation}-{self.sequence}'
        self.sent[key] = ref
        output = deepcopy(value)
        if name == 'get_session_summary':
            for index, session in enumerate(output.get('sessions', [])):
                if isinstance(session.get('workout'), dict):
                    session['workout'] = self._workout(session['workout'], f'{ref}#/sessions/{index}/workout')
        elif name == 'get_workout_details' and isinstance(output.get('workout'), dict):
            output['workout'] = self._workout(output['workout'], f'{ref}#/workout')
        elif name == 'get_exercise_history':
            for history in output.get('history', []):
                wid = history.get('workoutId')
                full = self.workouts.get(wid)
                if full is None:
                    continue
                for index, exercise in enumerate(full.get('exercises', [])):
                    if (exercise.get('exerciseId') == history.get('exerciseId')
                            and _recorded_sets(exercise) == history.get('sets') and history.get('sets')):
                        reference = {'dataRef': f'{self.workout_refs[wid]}/exercises/{index}/sets',
                                     'projection': 'Completed outcome sets only, first 20; ignore planned values. Notes limited to 300 characters.',
                                     'returnedSetCount': len(history['sets'])}
                        # A small set list can be shorter than its projection reference.
                        encode = lambda item: json.dumps(item, ensure_ascii=False, separators=(',', ':'))
                        if len(encode(reference)) < len(encode(history['sets'])):
                            history['sets'] = reference
                        break
        output['resultRef'] = ref
        return output

    def _workout(self, workout, path):
        wid = workout.get('id')
        if wid and self.workouts.get(wid) == workout:
            return {'dataRef': self.workout_refs[wid]}
        if wid:
            self.workouts[wid] = deepcopy(workout)
            self.workout_refs[wid] = path
        return workout
