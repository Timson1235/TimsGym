import unittest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import SQLModel, Session, create_engine
from app import crud
from app.auth import current_user
from app.db import get_session
from app.models import User
from app.routers.ai import router as ai_router
from app.routers.db import router as db_router
from test_progression import workout, CONFIG


class ProgressionRouteTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine('sqlite://',connect_args={'check_same_thread':False},poolclass=StaticPool)
        SQLModel.metadata.create_all(self.engine)
        self.app = FastAPI()
        self.app.include_router(ai_router)
        self.app.include_router(db_router)
        self.app.dependency_overrides[current_user] = lambda: User(id=1,uid='owner',email='owner@example.com')
        def sessions():
            with Session(self.engine) as session: yield session
        self.app.dependency_overrides[get_session] = sessions
        with Session(self.engine) as session:
            session.add(User(id=1,uid='owner',email='owner@example.com'))
            session.add(User(id=2,uid='other',email='other@example.com'))
            session.commit()
            crud.save_user_exercise(session,1,dict(id='squat',name='Squat',category='Legs',equipment='Barbell'))
            source = workout()
            source.update(title='Strength',durationMinutes=30,totalVolume=1170)
            crud.save_user_workout(session,1,source)
            source['id'] = 'foreign'
            crud.save_user_workout(session,2,source)
        self.client = TestClient(self.app)

    def tearDown(self):
        self.client.close()
        self.engine.dispose()

    def test_review_is_account_scoped_and_does_not_call_a_model(self):
        response = self.client.get('/api/ai/workout-review/w20')
        self.assertEqual(response.status_code,200)
        result = response.json()['recommendations'][0]
        self.assertEqual(result['status'],'add_reps')
        self.assertEqual(self.client.get('/api/ai/workout-review/foreign').status_code,404)

    def test_accepted_targets_round_trip_without_overwriting_outcomes(self):
        source = self.client.get('/api/db').json()['workouts'][0]
        source['exercises'][0]['nextTarget'] = dict(version=1,sourceWorkoutId='w20',acceptedAt='2026-10-21T12:00:00Z',
            sets=[dict(weight=65,reps=7,type='working',rir=2)]*3)
        response = self.client.post('/api/db/workout',json=source)
        self.assertEqual(response.status_code,200)
        saved = response.json()['db']['workouts'][0]['exercises'][0]
        self.assertEqual(saved['nextTarget']['sets'][0]['reps'],7)
        self.assertEqual(saved['sets'][0]['reps'],6)
        self.assertEqual(saved['sets'][0]['planned']['reps'],6)

    def test_bad_structured_fields_return_422(self):
        source = self.client.get('/api/db').json()['workouts'][0]
        source['exercises'][0]['progression']['repMax'] = 1
        self.assertEqual(self.client.post('/api/db/workout',json=source).status_code,422)
        config = {**CONFIG,'targetRir':99}
        self.assertEqual(self.client.post('/api/ai/suggest-weight',json=dict(exerciseId='squat',progression=config)).status_code,422)
