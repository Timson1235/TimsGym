import unittest
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import patch
from app.agent.coach import suggest_weight
from app.agent.progression import recommend_progression, validate_exercises, workout_review
from app.agent.tools import handle_log_set, handle_correct_log, TOOL_DECLARATIONS
from app.agent.workout_builder import build_workout_proposal

CONFIG = dict(version=1, strategy='double_progression', repMin=6, repMax=10,
              targetRir=2, weightIncrement=2.5, requiredSessions=2)


def workout(day=20, reps=6, rpe=8):
    return dict(id=f'w{day}', date=f'2026-10-{day:02}', isCompleted=True, exercises=[dict(
        exerciseId='squat', exerciseName='Squat', progression=deepcopy(CONFIG), sets=[dict(
            id=f's{i}', type='working', completed=True, weight=65, reps=reps, rpe=rpe,
            planned=dict(weight=65, reps=6, type='working', rir=2)) for i in range(3)])])


def database(*workouts):
    return dict(exercises=[dict(id='squat', name='Squat', category='Legs')], workouts=list(workouts))


class ProgressionTests(unittest.TestCase):
    def recommend(self, *workouts, **kwargs):
        return recommend_progression(database(*workouts), exercise_id='squat', **kwargs)

    def test_adds_one_total_rep_and_preserves_source(self):
        source = workout()
        before = deepcopy(source)
        result = self.recommend(source)
        self.assertEqual(result['status'], 'add_reps')
        self.assertEqual([s['reps'] for s in result['next']['sets']], [7,6,6])
        self.assertEqual(source, before)
        self.assertEqual(result['evidence'][0]['actualRir'], [2,2,2])

    def test_unknown_effort_missed_reps_and_skips_hold(self):
        for reps,rpe,completed in [(6,None,True),(5,8,True),(6,9,True),(6,8,False)]:
            source = workout(reps=reps,rpe=rpe)
            source['exercises'][0]['sets'][0]['completed'] = completed
            result = self.recommend(source)
            self.assertEqual(result['status'], 'hold')
            self.assertEqual(result['next']['sets'][0]['reps'], 6)

    def test_invalid_effort_cannot_trigger_progression(self):
        for rpe in (-2, 11, float('nan')):
            self.assertEqual(self.recommend(workout(rpe=rpe))['status'], 'needs_review')

    def test_load_requires_two_consecutive_comparable_successes(self):
        self.assertEqual(self.recommend(workout(reps=10))['status'], 'hold')
        result = self.recommend(workout(reps=10), workout(19,reps=10))
        self.assertEqual(result['status'], 'increase_load')
        self.assertEqual([(s['weight'],s['reps']) for s in result['next']['sets']], [(67.5,6)]*3)

    def test_does_not_skip_changed_configuration(self):
        changed = workout(19,reps=10)
        changed['exercises'][0]['progression']['targetRir'] = 3
        self.assertEqual(self.recommend(workout(reps=10),changed,workout(18,reps=10))['status'], 'hold')

    def test_unknown_increment_and_bodyweight_do_not_invent_load(self):
        for weight in (0,65):
            sessions = [workout(reps=10),workout(19,reps=10)]
            for source in sessions:
                source['exercises'][0]['progression'].pop('weightIncrement')
                for item in source['exercises'][0]['sets']:
                    item['weight'] = item['planned']['weight'] = weight
            self.assertEqual(self.recommend(*sessions)['status'], 'needs_increment')

    def test_skill_uses_explicit_criterion_without_switching_exercises(self):
        sessions = [workout(reps=8),workout(19,reps=8)]
        for source in sessions:
            source['exercises'][0]['progression'].update(strategy='skill', goal=dict(
                targetMovement='Handstand push-up',currentVariation='Pike push-up',targetSets=3,targetReps=8))
        result = self.recommend(*sessions)
        self.assertEqual(result['status'], 'review_variant')
        self.assertEqual(result['exerciseId'], 'squat')

    def test_legacy_is_not_reinterpreted_as_prescription(self):
        source = workout()
        source['exercises'][0].pop('progression')
        source['exercises'][0]['sets'][0].pop('planned')
        self.assertEqual(self.recommend(source)['status'], 'needs_setup')
        self.assertIsNone(self.recommend(source)['next'])
        self.assertNotIn('planned', validate_exercises(source['exercises'],'w20')[0]['sets'][0])

    def test_review_excludes_future_and_evidence_is_bounded(self):
        sessions = [workout(day,reps=10) for day in range(10,25)]
        review = workout_review(database(*sessions),'w15')['recommendations'][0]
        self.assertEqual(review['sourceWorkoutId'], 'w15')
        self.assertLessEqual(len(review['evidence']), 3)
        self.assertTrue(all(e['date'] <= '2026-10-15' for e in review['evidence']))
        self.assertEqual(workout_review(database(),'foreign')['status'],'not_found')

    def test_mixed_loads_and_rir_mismatch_require_review(self):
        for field,value in [('weight',70),('rir',1)]:
            source = workout()
            source['exercises'][0]['sets'][0]['planned'][field] = value
            self.assertEqual(self.recommend(source)['status'],'needs_review')

    def test_validation_rejects_invalid_config_and_target_source(self):
        source = workout()['exercises']
        source[0]['progression']['repMax'] = 1
        with self.assertRaises(ValueError): validate_exercises(source,'w20')
        source = workout()['exercises']
        source[0]['nextTarget'] = dict(version=1,sourceWorkoutId='other',acceptedAt='2026-10-21T12:00:00Z',sets=[dict(weight=65,reps=7)])
        with self.assertRaises(ValueError): validate_exercises(source,'w20')

    def test_proposal_separates_plan_and_unknown_actual_effort(self):
        result = build_workout_proposal(database(),dict(exercises=[dict(exerciseName='Squat',progression=CONFIG,
            sets=[dict(weight=65,reps=6,rir=2)])]))
        item = result['exercises'][0]['sets'][0]
        self.assertIsNone(item['rpe'])
        self.assertEqual(item['planned']['rir'],2)
        item['completed'] = False
        handle_log_set(None,1,database(),dict(exercise_name='Squat',weight=60,reps=5),active_workout_state=result)
        self.assertEqual(item['planned']['weight'],65)
        self.assertEqual(item['weight'],60)
        self.assertIsNone(item['rpe'])

    def test_compatibility_response_and_tool_count(self):
        with patch('app.agent.coach.crud.get_user_database_state',return_value=database(workout())):
            result = suggest_weight(None,SimpleNamespace(id=1),'Squat')
        self.assertEqual((result['suggestedWeight'],result['suggestedReps']),(65,7))
        self.assertEqual(len(TOOL_DECLARATIONS),16)

    def test_logging_without_workout_fails(self):
        with self.assertRaises(ValueError): handle_log_set(None,1,{},dict(exercise_name='Squat',weight=65,reps=6))
        with self.assertRaises(ValueError): handle_correct_log(None,1,{},dict(exercise_name='Squat',new_weight=65))
