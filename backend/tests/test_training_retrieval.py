import unittest
from copy import deepcopy
from datetime import datetime, timezone
from sqlmodel import Session, SQLModel, create_engine

from app import crud
from app.models import Workout
from app.agent.tools import (
    handle_get_exercise_history, handle_get_session_summary, handle_get_workout_details,
)

LIBRARY = [
    {"id": "squat", "name": "Barbell Back Squat", "category": "Legs"},
    {"id": "rdl", "name": "Romanian Deadlift", "category": "Legs"},
    {"id": "press", "name": "Barbell Overhead Press", "category": "Shoulders"},
    {"id": "dbpress", "name": "Dumbbell Overhead Press", "category": "Shoulders"},
]


def workout(wid, date, title, exercise_id, completed=True):
    exercise = next(e for e in LIBRARY if e['id'] == exercise_id)
    return {"id": wid, "date": date, "title": title, "isCompleted": completed,
            "durationMinutes": 45, "notes": "Session note", "exercises": [{
                "exerciseId": exercise_id, "exerciseName": exercise['name'],
                "category": exercise['category'], "notes": "Exercise cue",
                "sets": [
                    {"weight": 20, "reps": 5, "type": "warmup", "completed": True},
                    {"weight": 40, "reps": 6, "type": "working", "rpe": 8,
                     "completed": True, "notes": "Per side"},
                    {"weight": 40, "reps": 6, "type": "working", "completed": False},
                ],
            }]}


class TrainingRetrievalTests(unittest.TestCase):
    def setUp(self):
        self.db = {"exercises": deepcopy(LIBRARY), "workouts": [
            workout('old', '2026-10-01', 'Ganzkörper A', 'squat'),
            workout('draft', '2026-10-22', 'Full Body', 'press', False),
            workout('base', '2026-10-18', 'Full-Body B', 'squat'),
            workout('last', '2026-10-20', 'Shoulders', 'press'),
        ]}

    def test_latest_matching_session_and_independent_exercise(self):
        result = handle_get_session_summary(None, 1, self.db, {
            'search_title_or_date': 'Ganzkörper', 'limit': 1, 'include_details': True,
        })
        self.assertEqual(result['sessions'][0]['id'], 'base')
        self.assertEqual(result['sessions'][0]['workout'], self.db['workouts'][2])
        history = handle_get_exercise_history(None, 1, self.db, {'exercise_id': 'press', 'limit': 1})
        self.assertEqual(history['history'][0]['workoutId'], 'last')
        self.assertEqual(len(history['history'][0]['sets']), 2)
        self.assertEqual(history['history'][0]['sets'][1]['rpe'], 8)

    def test_latest_overall_and_date_filter(self):
        recent = handle_get_session_summary(None, 1, self.db, {'limit': 1})
        self.assertEqual(recent['sessions'][0]['id'], 'last')
        dated = handle_get_session_summary(None, 1, self.db, {'search_title_or_date': '2026-10-01'})
        self.assertEqual(dated['sessions'][0]['id'], 'old')
        self.assertEqual(recent['sessions'][0]['exercises'][0]['sets'][1]['weight'], 40)

    def test_aliases_resolve_and_ambiguous_names_do_not_pick_first_match(self):
        resolved = handle_get_exercise_history(None, 1, self.db, {'exercise_name': 'Kniebeuge'})
        self.assertEqual(resolved['exerciseId'], 'squat')
        self.assertEqual([h['workoutId'] for h in resolved['history']], ['base', 'old'])
        ambiguous = handle_get_exercise_history(None, 1, self.db, {'exercise_name': 'Overhead Press'})
        self.assertEqual(ambiguous['status'], 'ambiguous')
        self.assertEqual(ambiguous['history'], [])
        self.assertEqual(len(ambiguous['candidates']), 2)

    def test_exact_id_is_authoritative_over_conflicting_name(self):
        self.db['workouts'][3]['exercises'][0]['exerciseName'] = 'Old exercise label'
        result = handle_get_exercise_history(None, 1, self.db, {'exercise_id': 'press'})
        self.assertEqual(result['history'][0]['workoutId'], 'last')
        self.db['workouts'][3]['exercises'][0]['exerciseId'] = 'dbpress'
        self.db['workouts'][3]['exercises'][0]['exerciseName'] = 'Barbell Overhead Press'
        self.assertEqual(handle_get_exercise_history(None, 1, self.db, {'exercise_id': 'press'})['status'], 'no_history')

    def test_legacy_record_without_id_uses_canonical_alias(self):
        entry = self.db['workouts'][3]['exercises'][0]
        entry.pop('exerciseId')
        entry['exerciseName'] = 'barbell overhead press'
        result = handle_get_exercise_history(None, 1, self.db, {'exercise_id': 'press'})
        self.assertEqual(result['history'][0]['workoutId'], 'last')

    def test_exact_details_preserve_all_fields_and_do_not_mutate_source(self):
        result = handle_get_workout_details(None, 1, self.db, {'workout_id': 'base'})
        self.assertEqual(result['workout'], self.db['workouts'][2])
        result['workout']['exercises'][0]['sets'][0]['weight'] = 999
        self.assertEqual(self.db['workouts'][2]['exercises'][0]['sets'][0]['weight'], 20)
        self.assertEqual(handle_get_workout_details(None, 1, self.db, {'workout_id': 'other-user'})['status'], 'not_found')

    def test_unknown_exercise_or_unmatched_session_does_not_fabricate_baseline(self):
        self.assertEqual(handle_get_exercise_history(None, 1, self.db, {'exercise_name': 'Mystery lift'})['status'], 'not_found')
        self.assertEqual(handle_get_session_summary(None, 1, self.db, {'search_title_or_date': 'Push day'})['sessions'], [])

    def test_limits_are_bounded(self):
        for i in range(20):
            self.db['workouts'].append(workout(f'many{i}', '2026-10-19', 'Full body', 'squat'))
        self.assertEqual(len(handle_get_session_summary(None, 1, self.db, {'limit': 500})['sessions']), 10)
        self.assertEqual(len(handle_get_exercise_history(None, 1, self.db, {'exercise_id': 'squat', 'limit': 500})['history']), 10)

    def test_database_snapshot_is_scoped_and_ordered_with_same_day_tiebreaker(self):
        engine = create_engine('sqlite://')
        SQLModel.metadata.create_all(engine)
        try:
            with Session(engine) as session:
                for wid, uid, date, hour in [('old', 1, '2026-10-01', 12), ('early', 1, '2026-10-20', 9),
                                              ('late', 1, '2026-10-20', 18), ('foreign', 2, '2026-10-21', 12)]:
                    session.add(Workout(id=wid, user_id=uid, title=wid, date=date,
                                        created_at=datetime(2026, 10, 20, hour, tzinfo=timezone.utc)))
                session.commit()
                snapshot = crud.get_user_database_state(session, 1)
                self.assertEqual([w['id'] for w in snapshot['workouts']], ['late', 'early', 'old'])
                self.assertEqual(handle_get_workout_details(session, 1, snapshot, {'workout_id': 'foreign'})['status'], 'not_found')
        finally:
            engine.dispose()
