// Isolated manual UI fixture. No real account, network or workout persistence.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ActiveWorkout } from '../src/components/ActiveWorkout';
import { createGuestDatabase } from '../src/db/guest';
import { repeatWithTargets } from '../src/lib/trainingTargets';
import type { WorkoutSession } from '../src/types';
import '../src/index.css';
const db = createGuestDatabase();
const exercise = db.exercises[0];
const initial: WorkoutSession = { id:'test',title:'Progression test',date:'2026-10-21',isCompleted:false,totalVolume:0,durationMinutes:0,
  exercises:[{id:'we-test',exerciseId:exercise.id,exerciseName:exercise.name,category:exercise.category,
    sets:[{id:'s-test',setNumber:1,type:'working',weight:40,reps:6,completed:false,planned:{weight:40,reps:6,type:'working',rir:2}}]}] };
function Fixture() {
  const [session,setSession] = useState(initial);
  return <main className="mx-auto max-w-5xl p-4"><ActiveWorkout db={db} activeWorkout={session} onUpdateWorkout={setSession}
    onFinishWorkout={(completed) => setSession(repeatWithTargets({...completed,exercises:completed.exercises.map(e => ({...e,
      nextTarget:{version:1,sourceWorkoutId:completed.id,acceptedAt:new Date().toISOString(),sets:[{weight:42.5,reps:6,type:'working',rir:2}]}}))}))}
    onCancelWorkout={() => {}} onStartRestTimer={() => {}} onNewPR={() => {}} /></main>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
