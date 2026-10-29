# Structured progression

Workout JSON remains the source of truth. No database migration or extra model call is needed. Existing workouts remain readable; missing historical prescriptions are never reconstructed from outcomes.

## Stored shape

```json
{
  "exerciseId": "canonical-library-id",
  "progression": {
    "version": 1,
    "strategy": "double_progression",
    "repMin": 6,
    "repMax": 10,
    "targetRir": 2,
    "requiredSessions": 2,
    "weightIncrement": 2.5
  },
  "sets": [{
    "planned": {"weight": 40, "reps": 6, "type": "working", "rir": 2},
    "weight": 40, "reps": 5, "rpe": 9, "completed": true
  }],
  "nextTarget": {
    "version": 1,
    "sourceWorkoutId": "workout-id",
    "acceptedAt": "2026-10-21T12:00:00Z",
    "sets": [{"weight": 40, "reps": 6, "type": "working", "rir": 2}]
  }
}
```

`planned` is the original prescription. Existing top-level weight/reps/rpe are outcomes when completed. Unknown actual effort stays absent/null. RIR input maps to the existing RPE storage convention (`rpe = 10 - rir`). `nextTarget` is written only after explicit acceptance and consumed when repeating that saved workout; it does not alter historical outcomes.

For skills, `strategy: "skill"` adds `goal: {targetMovement, currentVariation, targetSets, targetReps}`. The engine reports when the current variation meets that criterion; selecting a harder variation remains a coaching decision. Assistance, duration and range-of-motion measurements are not modeled yet.

## Retrieval and decisions

- No new domain tool: the existing `suggest_weight` now calls the shared deterministic engine. (The catalog later gained `batch_retrieve` and `discover_tools`; see [Coach prompts](COACH_PROMPTS.md).)
- Inspect at most the latest three completed sessions for one canonical exercise. A historical review excludes later workouts.
- Compare matching configurations, working-set counts and loads, without skipping incompatible sessions to find older successes.
- Return only status, reasoning, next targets and bounded evidence arrays. Full details remain available through `get_workout_details` on demand.
- Missing prescriptions/configuration, skipped sets, missing effort or failed targets do not cause a load increase.
- Successful sets below the ceiling receive one extra total repetition. Repeated success at the ceiling permits only an explicitly configured equipment increment, with reps reset to the lower boundary.
- Numeric workout records stay in structured JSON; chat summaries are not the training log.

## Changed files and key code

| File | Change / key code |
| --- | --- |
| [progression.py](/Users/tim/Work/TimsGym/backend/app/agent/progression.py) | New validated, versioned models and shared engine: `ProgressionConfig.model_validate(raw_config)`; `if len(records) == 3: break`. |
| [workout_builder.py](/Users/tim/Work/TimsGym/backend/app/agent/workout_builder.py) | AI proposals store `"rpe": None` and a separate `"planned": SetPlan(...).model_dump(...)`; preserve structured goals. |
| [tools.py](/Users/tim/Work/TimsGym/backend/app/agent/tools.py) | Extend proposal schema; `suggest_weight` reads account history; logging preserves plans; history projects actual set fields with 20-set cap. |
| [coach.py](/Users/tim/Work/TimsGym/backend/app/agent/coach.py) | Prompt calls compact progression retrieval first; tool feedback uses `json.dumps(result, separators=(",", ":"))`. |
| [crud.py](/Users/tim/Work/TimsGym/backend/app/crud.py) | `existing.exercises_data = validate_exercises(...)` before saving JSON. |
| [routers/ai.py](/Users/tim/Work/TimsGym/backend/app/routers/ai.py) | Authenticated `/workout-review/{workout_id}` and `/suggest-weight` use the same engine. |
| [routers/db.py](/Users/tim/Work/TimsGym/backend/app/routers/db.py) | Invalid structured data returns HTTP 422. |
| [types.ts](/Users/tim/Work/TimsGym/src/types.ts) | Add `SetPlan`, `ProgressionConfig`, `ProgressionRecommendation`, `planned` and `nextTarget`. |
| [trainingTargets.ts](/Users/tim/Work/TimsGym/src/lib/trainingTargets.ts) | `updateOutcome` preserves plans; `applyTargets` edits unfinished sets; `repeatWithTargets` consumes accepted targets and clears actual effort. |
| [api.ts](/Users/tim/Work/TimsGym/src/lib/api.ts) | Typed recommendation/review requests. Evaluation uses authenticated server history; guest evaluation is not available. |
| [ProgressionSettings.tsx](/Users/tim/Work/TimsGym/src/components/ProgressionSettings.tsx) | Explicit rep range, RIR, available increment, confirmation count and skill criteria before the first completed set. |
| [ActiveWorkout.tsx](/Users/tim/Work/TimsGym/src/components/ActiveWorkout.tsx) | Display original plan beside actual inputs; blank actual RIR; explicit target application and request error handling. |
| [ProgressionReview.tsx](/Users/tim/Work/TimsGym/src/components/ProgressionReview.tsx) | Review and explicit acceptance: `nextTarget: { version: 1, sourceWorkoutId: workout.id, acceptedAt: ..., sets: ... }`. |
| [WorkoutHistory.tsx](/Users/tim/Work/TimsGym/src/components/WorkoutHistory.tsx) | Reopen review with “Nächste Ziele”. |
| [App.tsx](/Users/tim/Work/TimsGym/src/App.tsx) | Review after saving; `setActiveWorkout(repeatWithTargets(session))` when repeating. |
| [test_progression.py](/Users/tim/Work/TimsGym/backend/tests/test_progression.py) | Decision, legacy, skill, validation, evidence bounds and logging tests. |
| [test_progression_routes.py](/Users/tim/Work/TimsGym/backend/tests/test_progression_routes.py) | Account isolation, accepted-target persistence, outcomes preserved, HTTP validation. |
| [trainingTargets.test.ts](/Users/tim/Work/TimsGym/tests/trainingTargets.test.ts) | Immutable plans, unfinished-only application, repeated targets and cleared actual effort. |
| [progression.browser.tsx](/Users/tim/Work/TimsGym/tests/progression.browser.tsx), [HTML entry](/Users/tim/Work/TimsGym/tests/progression.browser.html) | Synthetic manual browser fixture with no account or persistence; finish simulates repeating an accepted target. |

## Manual test

1. Signed in, start a workout and open “Progressionsziel einrichten” before completing a set.
2. Choose rep range/RIR and the real available increment. Click “Ziel festlegen”.
3. Change actual reps/weight: original `Plan` should remain unchanged. Enter actual RIR explicitly.
4. Finish, inspect “nächste Ziele”, and accept a target. Reopen this from History if needed.
5. Repeat that workout: accepted targets become new prescriptions and actual RIR is blank.
6. Older logs without original plans should request setup, not fabricate a progression baseline.
