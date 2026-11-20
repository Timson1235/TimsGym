// Synthetic viewer fixture; no sign-in, real account, provider or database access.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { ExecutionTraces } from '../src/components/ExecutionTraces';
import '../src/index.css';
let finished=false;
const start=Date.now()/1000;
const button=document.createElement('button');button.textContent='Finish synthetic agent loop';
button.onclick=()=>{finished=true;button.textContent='Synthetic loop finished';};
document.body.prepend(button);
const load=async(path='')=>{
  const trace={id:'synthetic-live-trace',thread_id:'synthetic-chat',name:'Coach request',kind:'chat',status:finished?'completed':'running',started_at:start,ended_at:finished?start+3:null,parent_trace_id:null};
  const span=(id:string,sequence:number,kind:string,name:string,parent:string|null)=>({id,sequence,kind,name,parent_span_id:parent,
    status:finished||sequence===2?'completed':'running',started_at:start,ended_at:finished?start+3:sequence===2?start+0.5:null,
    input_payload_id:`input-${id}`,output_payload_id:`output-${id}${finished?"-finished":""}`,error_type:null});
  const spans=[span('request',1,'request','Coach request',null),span('context',2,'context','Build model context','request'),span('round',3,'model_round','Claude round 1','request')];
  if(finished)spans.push(span('tool',4,'tool','get_exercise_history','round'),span('round2',5,'model_round','Claude round 2','request'));
  if(path.includes('/payload/'))return{data:path.includes('input-')?{model:'synthetic-model',messages:[{role:'user',content:'What should I train?'}]}:{streamedText:finished?'Use the latest saved workout as a starting point.':'Checking the previous workout…',usage:finished?{input_tokens:420,output_tokens:65}:null}};
  if(path.includes('?payloads=true'))return{trace,spans,payloads:{synthetic:{message:'Synthetic export'}}};
  return path?{trace,spans}:{traces:[trace]};
};
createRoot(document.getElementById('root')!).render(<ExecutionTraces load={load}/>);
