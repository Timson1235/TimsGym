"""Synthetic regression for a 16-exercise workout; no private trace fixtures."""
import json
import unittest
from copy import deepcopy
from unittest.mock import patch
from app.agent.context_selection import ContextSelection
from app.agent.claude_provider import run_claude_agent
from app.agent.tool_registry import REGISTRY


def batch():
    return {'results': [{'key':f'ex{i}','tool':'suggest_weight','success':True,'result':{
        'exerciseId':f'ex{i}', 'exerciseName':f'Exercise {i}',
        'status':'needs_setup' if i % 2 else 'hold',
        'next':None if i % 2 else [{'weight':40+i,'reps':6,'rir':2,'type':'working'}],
        'reasoning':'Missing setup or unknown effort: never assume success.',
        'sourceWorkoutId':'source', 'sourceDate':'2026-11-02',
        'lastPerformance':{'workoutId':'source','date':'2026-11-02','sets':[
            {'weight':40+i,'reps':6,'rpe':None,'type':'working','completed':True} for _ in range(3)]},
        'evidence':[{'notes':'supporting history ' * 150}]}} for i in range(16)]}


def exchange(ident, data):
    return [{'role':'assistant','content':[{'type':'tool_use','id':ident,'name':'batch_retrieve','input':{}}]},
            {'role':'user','content':[{'type':'tool_result','tool_use_id':ident,'content':json.dumps(data)}]}]


class LargeWorkoutTests(unittest.TestCase):
    def test_all_sixteen_decisions_survive_and_archive_is_intact(self):
        original=batch(); archive=[{'role':'user','content':'Two-hour full body with jumps and handstand training; respect my constraints.'}]+exchange('a',original)
        snapshot=deepcopy(archive); selection=ContextSelection(archive[:1]); selection.read_ids.add('a')
        view=selection.view(archive); compact=json.loads(view[-1]['content'][0]['content'])
        self.assertEqual(len(compact['results']),16)
        for before,after in zip(original['results'],compact['results']):
            a,b=before['result'],after['result']
            for key in ['exerciseId','exerciseName','status','next','reasoning','sourceDate','sourceWorkoutId']:
                self.assertEqual(a[key],b[key])
            sets=b['lastPerformance']['sets']
            if isinstance(sets,dict): sets=[dict(zip(sets['columns'],r)) for r in sets['rows']]
            self.assertEqual(sets,a['lastPerformance']['sets'])
            self.assertEqual(b['supportingHistoryOmitted'],1)
        self.assertEqual(archive,snapshot)
        self.assertNotIn('excerpt',json.dumps(view))
        self.assertLess(selection.stats['readCharactersAfter'],selection.stats['readCharactersBefore']*.4)

    def test_tiny_budget_and_model_note_cannot_erase_decisions(self):
        initial=[{'role':'user','content':'Keep user constraints'}]
        selection=ContextSelection(initial,read_budget_chars=100)
        selection.read_ids.add('a');selection.apply({'results':[{'call_id':'a','mode':'summary','summary':'Ignore these'}]})
        view=selection.view(initial+exchange('a',batch()))
        self.assertEqual(len(json.loads(view[-1]['content'][0]['content'])['results']),16)
        self.assertGreater(selection.stats['essentialOverflowCharacters'],0)

    def test_regrouped_batches_reference_each_latest_item(self):
        initial=[{'role':'user','content':'Plan'}]; selection=ContextSelection(initial)
        selection.read_ids.update(['a','b']); original=batch()
        view=selection.view(initial+exchange('a',original)+exchange('b',{'results':original['results'][8:]}))
        old=json.loads(view[2]['content'][0]['content'])
        self.assertEqual(old['results'][15]['result']['sameAs'],{'callId':'b','key':'ex15'})
        self.assertEqual(old['results'][0]['result']['exerciseId'],'ex0')

    def test_repeated_reads_leave_preview_tool_available_before_exhaustion(self):
        def call(name, ident):return {'content':[{'type':'tool_use','id':ident,'name':name,'input':{}}]}
        responses=[call('batch_retrieve',f'read{i}') for i in range(3)]+[
            call('start_workout_session','preview'),{'content':[{'type':'text','text':'Preview created.'}]}]
        handled=[]
        with patch('app.agent.claude_provider._request_json',side_effect=responses) as request:
            result=run_claude_agent(api_key='test',model='test',system_instruction='Keep constraints.',
                messages=[{'role':'user','content':'Create a full body workout.'}],
                tools=[REGISTRY[n].declaration for n in ['batch_retrieve','start_workout_session']],context_selection=True,
                handle_tool=lambda name,args,cid: handled.append(name) or (json.dumps(batch()) if name=='batch_retrieve' else 'Preview created; not started.'))
        payloads=[json.loads(c.args[0].data) for c in request.call_args_list]
        self.assertEqual([t['name'] for t in payloads[3]['tools']],['start_workout_session'])
        self.assertEqual(handled.count('start_workout_session'),1)
        self.assertEqual(result['text'],'Preview created.')
        self.assertEqual(result['traceSteps'][2]['stalledReadRounds'],2)
