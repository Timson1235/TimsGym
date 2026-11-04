"""Small synthetic fixtures and explicit behavioral assertions, not an LLM judge."""
from copy import deepcopy

FIXTURE_VERSION = 'edge-smoke-v2.1-leg-browse'
FIXED_NOW = '2026-10-23T12:00:00+02:00'
CASES = {
    'leg_session_browse': {
        'message': 'Find my most recent legs-only workout by inspecting its exercises, not just the title. Browse lightweight summaries first, using pages of at most 3 sessions, and follow older pages if needed. Then retrieve the selected workout details and show its date, exercises, individual warm-up and working sets with weights/reps, reported RIR where known, and comments. Do not create or change a workout.',
        'description': 'Find a neutrally titled leg session beyond page one, reject newer upper/full-body/draft sessions, then report original sets and effort.',
    },
    'ambiguous_logging': {
        'message': 'Log 6 reps at 40 kg for overhead press.',
        'description': 'Ambiguous barbell/dumbbell exercise: clarify without changing workout state.',
    },
    'missing_effort': {
        'message': 'Can I increase my barbell squat weight next session? Check my recorded progression evidence first. Do not create a workout.',
        'description': 'Completed targets with missing reported effort: retrieve evidence and hold, without inventing RIR.',
    },
    'repeat_adapt': {
        'message': 'Find my last full-body workout and propose another with one additional working set of barbell overhead press. Check its latest performance separately. Keep the squat and row set counts, use only those same three exercises, and keep all working weights unchanged. Create the workout preview.',
        'description': 'Older full-body reference, newer unrelated workout, newer draft and separate exercise performance; preserve explicit targets.',
    },
    'log_set': {
        'message': 'Log 6 reps at 40 kg for Barbell Back Squat.',
        'description': 'Cheap control: exactly one set, unchanged plan and unknown actual effort.',
    },
    'general_rir': {
        'message': 'In two short sentences, what does RIR mean? Explain RIR 0 and RIR 2. Do not create a workout.',
        'description': 'Cheap control: a brief factual explanation without tools or mutations.',
    },
}
DEFAULT_CASES = ('ambiguous_logging', 'missing_effort', 'repeat_adapt')

LIBRARY = [
    {'id': 'squat', 'name': 'Barbell Back Squat', 'category': 'Legs', 'equipment': 'Barbell'},
    {'id': 'press', 'name': 'Barbell Overhead Press', 'category': 'Shoulders', 'equipment': 'Barbell'},
    {'id': 'dbpress', 'name': 'Dumbbell Overhead Press', 'category': 'Shoulders', 'equipment': 'Dumbbell'},
    {'id': 'row', 'name': 'Barbell Row', 'category': 'Back', 'equipment': 'Barbell'},
]


def entry(exercise_id, weight, count=2, *, effort=8):
    exercise = next(item for item in LIBRARY if item['id'] == exercise_id)
    return {'exerciseId': exercise_id, 'exerciseName': exercise['name'], 'category': exercise['category'],
            'progression': {'version': 1, 'strategy': 'double_progression', 'repMin': 6, 'repMax': 8,
                            'targetRir': 2, 'weightIncrement': 2.5, 'requiredSessions': 2},
            'sets': [{'id': f'{exercise_id}-{i}', 'setNumber': i + 1, 'weight': weight, 'reps': 8,
                      'type': 'working', 'completed': True, 'rpe': effort,
                      'planned': {'weight': weight, 'reps': 8, 'type': 'working', 'rir': 2}}
                     for i in range(count)]}


def fixture(case):
    workouts = [
        {'id': 'full-reference', 'title': 'Full Body A', 'date': '2026-10-15', 'isCompleted': True,
         'exercises': [entry('squat', 40), entry('press', 20), entry('row', 30)]},
        {'id': 'latest-press', 'title': 'Upper body', 'date': '2026-10-21', 'isCompleted': True,
         'exercises': [entry('press', 20)]},
        {'id': 'draft-full', 'title': 'Full Body draft', 'date': '2026-10-22', 'isCompleted': False,
         'exercises': [entry('squat', 90), entry('press', 90), entry('row', 90)]},
    ]
    if case == 'missing_effort':
        workouts.append({'id': 'squat-missing-effort', 'title': 'Squat session', 'date': '2026-10-22',
                         'isCompleted': True, 'exercises': [entry('squat', 40, effort=None)]})
    if case == 'leg_session_browse':
        leg = entry('squat', 40)
        leg['notes'] = 'Controlled descent.'
        leg['sets'].insert(0, {'id': 'squat-warmup', 'setNumber': 0, 'weight': 10, 'reps': 5,
                              'type': 'warmup', 'completed': True, 'rpe': None})
        hinge = entry('squat', 60)
        hinge.update(exerciseId='rdl', exerciseName='Romanian Deadlift')
        for i, item in enumerate(hinge['sets']):
            item.update(id=f'rdl-{i}', reps=6)
            item['planned']['reps'] = 6
        workouts += [
            {'id': 'upper-new', 'title': 'Session D', 'date': '2026-10-22', 'isCompleted': True,
             'exercises': [entry('press', 20)]},
            {'id': 'upper-second', 'title': 'Session C', 'date': '2026-10-20', 'isCompleted': True,
             'exercises': [entry('press', 20), entry('row', 30)]},
            {'id': 'leg-reference', 'title': 'Session B', 'date': '2026-10-10', 'isCompleted': True,
             'durationMinutes': 40, 'notes': 'Finished with time to spare.', 'exercises': [leg, hinge]},
        ]
    active = None
    if case in ('ambiguous_logging', 'log_set'):
        active = {'id': 'active', 'title': 'Current session', 'date': '2026-10-23', 'isCompleted': False,
                  'exercises': [entry('squat', 40), entry('press', 20), entry('dbpress', 12)]}
        for exercise in active['exercises']:
            for item in exercise['sets']:
                item.update(completed=False, rpe=None)
    library = deepcopy(LIBRARY)
    if case == 'leg_session_browse':
        library.append({'id': 'rdl', 'name': 'Romanian Deadlift', 'category': 'Legs', 'equipment': 'Barbell'})
    return {'profile': {'name': 'Synthetic athlete', 'preferredUnit': 'kg', 'experienceLevel': 'Intermediate',
                        'primaryGoal': 'General Fitness', 'personalMemories': ['Prefers sessions under 45 minutes.']},
            'exercises': library, 'workouts': workouts}, active


def assertions(case, result, before, reads):
    actions = result.get('actionsExecuted') or []
    after = result.get('activeWorkoutState')
    reply = result.get('reply', '').lower()
    checks = {'completed': result.get('trace', {}).get('terminationReason') == 'completed',
              'nonempty_reply': bool(reply.strip())}
    if case == 'leg_session_browse':
        browsed = [item for item in reads if item['tool'] == 'get_session_summary']
        detailed = [item for item in reads if item['tool'] == 'get_workout_details'
                    and item.get('result', {}).get('workout', {}).get('id') == 'leg-reference']
        checks.update(
            browsed_lightweight=bool(browsed) and all(item['result'].get('projection') == 'summary' for item in browsed),
            small_pages=bool(browsed) and all(item['result'].get('effectiveLimit', 99) <= 3 for item in browsed),
            followed_cursor=any(item.get('arguments', {}).get('cursor') for item in browsed),
            found_candidate=any(w.get('id') == 'leg-reference' for item in browsed for w in item['result'].get('sessions', [])),
            selected_exact_details=bool(detailed),
            details_after_browsing=bool(detailed) and any(item.get('sequence', 0) < detailed[0].get('sequence', 0)
                and any(w.get('id') == 'leg-reference' for w in item['result'].get('sessions', [])) for item in browsed),
            no_other_detail_dumps=all(item.get('result', {}).get('workout', {}).get('id') == 'leg-reference'
                                     for item in reads if item['tool'] == 'get_workout_details'),
            reports_exercises='squat' in reply and 'romanian deadlift' in reply,
            reports_loads=all(value in reply for value in ('10', '40', '60')),
            reports_set_types='warm' in reply and 'working' in reply,
            mentions_rir='rir' in reply or 'reserve' in reply,
            reports_notes='controlled descent' in reply and 'time to spare' in reply,
            no_mutation=not actions,
        )
    elif case == 'ambiguous_logging':
        checks.update(no_mutation=not actions, active_unchanged=after == before,
                      clarification_question='?' in reply,
                      identifies_ambiguity=('barbell' in reply and 'dumbbell' in reply)
                      or ('langhantel' in reply and 'kurzhantel' in reply))
    elif case == 'log_set':
        sets = [item for exercise in (after or {}).get('exercises', []) for item in exercise.get('sets', []) if item.get('completed')]
        checks.update(exactly_one_log=len(actions) == 1 and actions[0].get('type') == 'set_logged',
                      exact_actual=len(sets) == 1 and sets[0]['weight'] == 40 and sets[0]['reps'] == 6,
                      no_invented_effort=len(sets) == 1 and sets[0].get('rpe') is None,
                      preserved_plan=len(sets) == 1 and sets[0].get('planned') == before['exercises'][0]['sets'][0]['planned'])
    elif case == 'missing_effort':
        holds = [item for item in reads if item['tool'] == 'suggest_weight' and item.get('result', {}).get('exerciseId') == 'squat']
        checks.update(retrieved_progression=bool(holds),
                      held_target=bool(holds) and all(item['result'].get('status') == 'hold' for item in holds),
                      no_mutation=not actions,
                      mentions_missing_effort=any(word in reply for word in ('missing', 'unknown', 'fehlt', 'unbekannt')),
                      explicitly_holds=any(word in reply for word in ('hold', 'keep', 'maintain', 'beibehalten', 'halten')))
    elif case == 'repeat_adapt':
        session_reads = [item['result'] for item in reads if item['tool'] == 'get_session_summary']
        history_reads = [item['result'] for item in reads if item['tool'] == 'get_exercise_history']
        checks['correct_reference_retrieved'] = any(item.get('id') == 'full-reference' for data in session_reads for item in data.get('sessions', []))
        checks['separate_press_history'] = any(data.get('exerciseId') == 'press' and any(item.get('workoutId') == 'latest-press' for item in data.get('history', [])) for data in history_reads)
        proposals = [action['data'] for action in actions if action.get('type') == 'workout_proposed']
        checks['preview_created'] = bool(proposals)
        checks['only_preview_action'] = bool(actions) and all(action.get('type') == 'workout_proposed' for action in actions)
        exercises = {exercise.get('exerciseId'): exercise for exercise in proposals[-1].get('exercises', [])} if proposals else {}
        checks['same_exercises'] = set(exercises) == {'squat', 'press', 'row'}
        for ident, weight, count in [('squat', 40, 2), ('press', 20, 3), ('row', 30, 2)]:
            working = [item for item in exercises.get(ident, {}).get('sets', []) if item.get('type') == 'working']
            checks[f'{ident}_unchanged_load_and_requested_volume'] = len(working) == count and all(item.get('weight') == weight for item in working)
        checks['preview_not_completed'] = bool(proposals) and not proposals[-1].get('isCompleted')
        checks['no_invented_actuals'] = bool(exercises) and all(not item.get('completed') and item.get('rpe') is None for ex in exercises.values() for item in ex.get('sets', []))
    else:
        checks.update(no_tools=not result.get('toolsUsed'), no_mutation=not actions,
                      explains_rir=('reserve' in reply or 'übrig' in reply) and '0' in reply and '2' in reply)
    return checks
