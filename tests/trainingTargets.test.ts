import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateOutcome, applyTargets, repeatWithTargets } from '../src/lib/trainingTargets';
import type { WorkoutSet, WorkoutExercise, WorkoutSession } from '../src/types';
const set: WorkoutSet = { id:'s1', setNumber:1, type:'working', weight:40, reps:6, completed:false,
  planned:{weight:40,reps:6,type:'working',rir:2} };
const exercise: WorkoutExercise = { id:'we1',exerciseId:'press',exerciseName:'Press',category:'Shoulders',sets:[set] };
const session: WorkoutSession = { id:'w1',title:'Workout',date:'2026-10-20',isCompleted:true,totalVolume:240,durationMinutes:10,exercises:[exercise] };

test('outcome edits preserve the original plan and do not invent reported effort', () => {
  const edited = updateOutcome(set,'reps',5);
  assert.equal(edited.reps,5);
  assert.equal(edited.planned!.reps,6);
  assert.equal(edited.rpe,undefined);
  assert.equal(set.reps,6);
  const { planned, ...legacy } = set;
  assert.equal(updateOutcome({...legacy,completed:true},'weight',45).planned,undefined);
});

test('targets apply by original working-set position, only to unfinished sets', () => {
  const result = applyTargets({...exercise,sets:[{...set,completed:true},{...set,id:'s2'}]},[
    {weight:42.5,reps:6,type:'working'}, {weight:42.5,reps:7,type:'working'},
  ]);
  assert.equal(result.sets[0].weight,40);
  assert.equal(result.sets[1].reps,7);
  assert.equal(result.sets[1].planned!.weight,42.5);
});

test('repeating carries accepted targets without changing historical outcomes or effort', () => {
  const source: WorkoutSession = {...session,exercises:[{...exercise,sets:[{...set,completed:true,rpe:8}],
    nextTarget:{version:1,sourceWorkoutId:'w1',acceptedAt:'2026-10-21T10:00:00Z',sets:[{weight:42.5,reps:6,type:'working',rir:2}]}}]};
  const repeat = repeatWithTargets(source,1792576800000);
  assert.equal(repeat.isCompleted,false);
  assert.equal(repeat.exercises[0].sets[0].weight,42.5);
  assert.equal(repeat.exercises[0].sets[0].completed,false);
  assert.equal(repeat.exercises[0].sets[0].rpe,undefined);
  assert.equal(repeat.exercises[0].nextTarget,undefined);
  assert.equal(source.exercises[0].sets[0].weight,40);
  assert.equal(source.exercises[0].sets[0].rpe,8);
});
