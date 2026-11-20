"""Versioned training targets and deterministic, bounded progression evidence."""
from copy import deepcopy
from datetime import datetime
from math import isfinite
from typing import Literal
from pydantic import BaseModel, ConfigDict, Field, model_validator
from .exercise_identity import resolve_exercise


class SetPlan(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    weight: float = Field(ge=0)
    reps: int = Field(ge=1, le=1000)
    type: Literal['warmup', 'working', 'drop', 'failure'] = 'working'
    rir: float | None = Field(default=None, ge=0, le=10)


class SkillGoal(BaseModel):
    model_config = ConfigDict(extra='forbid')
    targetMovement: str = Field(min_length=1, max_length=100)
    currentVariation: str = Field(min_length=1, max_length=100)
    targetSets: int = Field(ge=1, le=20)
    targetReps: int = Field(ge=1, le=100)


class ProgressionConfig(BaseModel):
    model_config = ConfigDict(extra='forbid', allow_inf_nan=False)
    version: Literal[1] = 1
    strategy: Literal['double_progression', 'skill'] = 'double_progression'
    repMin: int = Field(ge=1, le=100)
    repMax: int = Field(ge=1, le=100)
    targetRir: float = Field(ge=0, le=10)
    weightIncrement: float | None = Field(default=None, gt=0, le=100)
    requiredSessions: int = Field(default=2, ge=1, le=3)
    goal: SkillGoal | None = None

    @model_validator(mode='after')
    def valid_range(self):
        if self.repMax < self.repMin:
            raise ValueError('repMax must be at least repMin')
        if self.strategy == 'skill' and self.goal is None:
            raise ValueError('Skill progression requires a structured goal')
        if self.goal and not self.repMin <= self.goal.targetReps <= self.repMax:
            raise ValueError('Goal repetitions must lie within the progression range')
        return self


class AcceptedTarget(BaseModel):
    model_config = ConfigDict(extra='forbid')
    version: Literal[1] = 1
    sourceWorkoutId: str
    acceptedAt: datetime
    sets: list[SetPlan] = Field(min_length=1, max_length=20)


def validate_exercises(exercises: list[dict], workout_id: str) -> list[dict]:
    """Validate only new structured fields; legacy outcomes are never inferred as plans."""
    result = deepcopy(exercises)
    for exercise in result:
        if exercise.get('progression') is not None:
            exercise['progression'] = ProgressionConfig.model_validate(exercise['progression']).model_dump(exclude_none=True)
        if exercise.get('nextTarget') is not None:
            target = AcceptedTarget.model_validate(exercise['nextTarget'])
            if target.sourceWorkoutId != workout_id:
                raise ValueError('Accepted target must reference this workout')
            exercise['nextTarget'] = target.model_dump(mode='json', exclude_none=True)
        for item in exercise.get('sets', []):
            if item.get('planned') is not None:
                item['planned'] = SetPlan.model_validate(item['planned']).model_dump(exclude_none=True)
    return result


def recommend_progression(db: dict, *, exercise_id=None, exercise_name='', progression=None, reference_workout_id=None) -> dict:
    exercise = next((e for e in db.get('exercises', []) if e['id'] == exercise_id), None) if exercise_id else None
    candidates = []
    if not exercise and not exercise_id:
        exercise, candidates = resolve_exercise(db.get('exercises', []), exercise_name)
    base = {'version': 1, 'exerciseId': exercise['id'] if exercise else exercise_id,
            'exerciseName': exercise['name'] if exercise else exercise_name, 'next': None, 'evidence': []}
    def result(status, reason, next_sets=None):
        return {**base, 'status': status, 'reasoning': reason,
                'next': {'sets': next_sets} if next_sets else None}
    if not exercise:
        return result('ambiguous' if candidates else 'not_found', 'Übung bitte eindeutig aus der Bibliothek auswählen.')

    workouts = sorted(db.get('workouts', []), key=lambda w: w.get('date') or '', reverse=True)
    if reference_workout_id:
        position = next((i for i,w in enumerate(workouts) if w.get('id') == reference_workout_id), None)
        if position is None:
            return result('not_found', 'Referenz-Workout nicht gefunden.')
        workouts = workouts[position:]  # Never use later sessions when reviewing an older workout.
    records = []
    for workout in workouts:
        if not workout.get('isCompleted', True):
            continue
        entry = next((e for e in workout.get('exercises', []) if e.get('exerciseId') == exercise['id']), None)
        if entry and any(s.get('completed') and s.get('type', 'working') == 'working' for s in entry.get('sets', [])):
            records.append((workout, entry))
        if len(records) == 3:
            break
    if not records:
        return result('insufficient_data', 'Noch keine abgeschlossenen Arbeitssätze vorhanden; kein Ausgangsgewicht wird erfunden.')
    source, latest = records[0]
    if reference_workout_id and source.get('id') != reference_workout_id:
        return result('insufficient_data', 'In dieser Einheit wurden keine Arbeitssätze dieser Übung abgeschlossen.')
    base['sourceWorkoutId'] = source.get('id')
    base['sourceDate'] = source.get('date')
    raw_config = progression or latest.get('progression')
    if not raw_config:
        return result('needs_setup', 'Zuerst einen Wiederholungsbereich und eine Ziel-RIR festlegen. Alte Ist-Werte werden nicht nachträglich als Plan interpretiert.')
    config = ProgressionConfig.model_validate(raw_config).model_dump(exclude_none=True)
    base['progression'] = config
    working = [s for s in latest.get('sets', []) if s.get('type', 'working') == 'working']
    if len(working) > 20:
        return result('needs_review', 'Mehr als 20 Arbeitssätze: bitte den Coach den Plan prüfen lassen.')
    if not working or any(not s.get('planned') for s in working):
        return result('needs_setup', 'Für diese Einheit fehlen ursprüngliche Planwerte; keine automatische Steigerung.')
    plans = [SetPlan.model_validate(s['planned']).model_dump(exclude_none=True) for s in working]
    if any(p['type'] != 'working' for p in plans) or len({p['weight'] for p in plans}) != 1:
        return result('needs_review', 'Gemischte Satztypen oder Arbeitsgewichte: individuelle Progression mit dem Coach prüfen.')
    if any(not config['repMin'] <= p['reps'] <= config['repMax'] for p in plans):
        return result('needs_review', 'Plan und Wiederholungsbereich passen nicht zusammen.')
    if any(p.get('rir') is not None and p['rir'] != config['targetRir'] for p in plans):
        return result('needs_review', 'Plan und Ziel-RIR passen nicht zusammen; zunächst die Einstellungen prüfen.')
    ceiling = config['goal']['targetReps'] if config['strategy'] == 'skill' else config['repMax']

    next_sets = deepcopy(plans)
    for target in next_sets:
        target['rir'] = config['targetRir']
    comparable = []
    for workout, entry in records:
        sets = [s for s in entry.get('sets', []) if s.get('type', 'working') == 'working']
        invalid = any(s.get('completed') and (
            not isinstance(s.get('reps'), (int, float)) or not 0 <= s['reps'] <= 1000
            or not isinstance(s.get('weight'), (int, float)) or not isfinite(s['weight']) or s['weight'] < 0
            or (s.get('rpe') is not None and (not isinstance(s['rpe'], (int, float)) or not 0 <= s['rpe'] <= 10))) for s in sets)
        if invalid:
            if workout is source:
                return result('needs_review', 'Ungültige Ist-Werte: Gewicht, Wiederholungen und berichtete Anstrengung prüfen.')
            break
        same_config = entry.get('progression') and ProgressionConfig.model_validate(entry['progression']).model_dump(exclude_none=True) == config
        compatible = bool(same_config and len(sets) == len(working) and all(
            s.get('planned') and s['planned'].get('weight') == plans[0]['weight']
            and s.get('weight') == plans[0]['weight'] for s in sets))
        base['evidence'].append({'workoutId': workout.get('id'), 'date': workout.get('date'),
            'actualReps': [s.get('reps') if s.get('completed') else None for s in sets[:20]],
            'actualRir': [round(10-s['rpe'], 1) if s.get('completed') and s.get('rpe') is not None else None for s in sets[:20]],
            'plannedReps': [s.get('planned', {}).get('reps') for s in sets[:20]], 'comparable': compatible})
        # A break in comparable training cannot be skipped to cherry-pick old success.
        if not compatible:
            break
        comparable.append(sets)
    if not comparable:
        return result('hold', 'Plan, Variante oder Einstellungen wurden verändert: zunächst den neuen Zielwert bestätigen.', next_sets)
    recent = comparable[0]
    if any(not s.get('completed') for s in recent):
        return result('hold', 'Nicht alle geplanten Arbeitssätze abgeschlossen; Ziel zunächst beibehalten.', next_sets)
    if any(s.get('rpe') is None for s in recent):
        return result('hold', 'Berichtete Anstrengung fehlt in Arbeitssätzen; keine automatische Steigerung.', next_sets)
    if any(s['reps'] < p['reps'] or 10-s['rpe'] < config['targetRir'] for s,p in zip(recent,plans)):
        return result('hold', 'Wiederholungsziel verfehlt oder weniger Reserve als vorgesehen; Ziel beibehalten.', next_sets)
    if any(s['reps'] < ceiling for s in recent):
        # One extra total repetition, rather than increasing every set at once.
        index = min(range(len(recent)), key=lambda i: recent[i]['reps'])
        for i,target in enumerate(next_sets):
            target['reps'] = min(ceiling, max(target['reps'], recent[i]['reps']))
        next_sets[index]['reps'] = min(ceiling, next_sets[index]['reps'] + 1)
        return result('add_reps', 'Ziel mit Reserve erreicht: insgesamt eine Wiederholung mehr versuchen, Gewicht unverändert.', next_sets)
    required = config['requiredSessions']
    for target in next_sets:
        target['reps'] = ceiling
    successes = len(comparable) >= required and all(
        all(s.get('completed') and s.get('rpe') is not None and s['reps'] >= ceiling
            and 10-s['rpe'] >= config['targetRir'] for s in sets)
        for sets in comparable[:required])
    if not successes:
        return result('hold', f'Obere Wiederholungsgrenze erst in {required} vergleichbaren Einheiten mit Reserve bestätigen.', next_sets)
    if config['strategy'] == 'skill':
        goal = config['goal']
        if len(recent) >= goal['targetSets'] and all(s['reps'] >= goal['targetReps'] for s in recent):
            return result('review_variant', 'Kriterium für diese Variante bestätigt. Nächste Variante mit dem Coach festlegen; kein automatischer Übungswechsel.', next_sets)
        return result('hold', 'Das Kriterium für die aktuelle Variante ist noch nicht erfüllt.', next_sets)
    increment = config.get('weightIncrement')
    if increment is None or plans[0]['weight'] <= 0:
        return result('needs_increment', 'Obere Grenze bestätigt. Verfügbaren Gewichtsschritt festlegen oder Variante mit dem Coach prüfen.', next_sets)
    for target in next_sets:
        target['weight'] = round(target['weight'] + increment, 3)
        target['reps'] = config['repMin']
    return result('increase_load', f'Obere Grenze in {required} Einheiten bestätigt: kleinsten hinterlegten Gewichtsschritt nutzen und unten im Wiederholungsbereich beginnen.', next_sets)


def workout_review(db: dict, workout_id: str) -> dict:
    workout = next((w for w in db.get('workouts', []) if w.get('id') == workout_id), None)
    if not workout:
        return {'status': 'not_found', 'recommendations': []}
    return {'version': 1, 'workoutId': workout_id, 'recommendations': [
        recommend_progression(db, exercise_id=e.get('exerciseId'), reference_workout_id=workout_id)
        for e in workout.get('exercises', [])[:20]]}
