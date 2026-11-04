"""Request-local, reversible context views for the experimental Claude loop."""
from copy import deepcopy
import json

from jsonschema import Draft202012Validator


CONTROL_SCHEMA = {
    'type': 'object', 'additionalProperties': False,
    'properties': {
        'history': {'type': 'string', 'enum': ['all', 'recent', 'current']},
        'results': {'type': 'array', 'maxItems': 32, 'items': {
            'type': 'object', 'additionalProperties': False,
            'properties': {'call_id': {'type': 'string'},
                           'mode': {'type': 'string', 'enum': ['full', 'summary']},
                           'summary': {'type': 'string', 'maxLength': 600}},
            'required': ['call_id', 'mode']}},
        'tools': {'type': 'array', 'maxItems': 32, 'uniqueItems': True,
                  'items': {'type': 'string'}},
    },
}

INSTRUCTION = """
Experimental context control: tool inputs accept optional _context, consumed by
the backend, not the tool. Use it alongside useful work, not in a separate round.
history: all (default), recent (last four historical messages), or current
(current user request only). Never discard relevant user constraints.
results: [{call_id, mode: full|summary, summary?: short factual note}]. Select
previous read-only tool results by their tool_use IDs, not read-* evidence refs.
Summarize irrelevant candidates once you have selected a workout; preserve exact
sets, units, effort and sources needed for the answer. Summaries are model notes,
not verified source data. Full results remain recoverable with mode=full.
tools: names to offer NEXT round; discover_tools always remains available.
Omit tools to keep the previous selection. Newly discovered tools become available.
Mutation exchanges cannot be compacted. Context choices do not execute tools.
Prefer compact workout summaries first, then details for the selected workout.
"""


class ContextSelection:
    def __init__(self, messages):
        self.initial_count = len(messages)
        self.history = 'all'
        self.results = {}
        self.read_ids = set()
        self.tool_names = None

    def split(self, arguments, conversation):
        arguments = deepcopy(arguments)
        control = arguments.pop('_context', None)
        if control is not None:
            Draft202012Validator(CONTROL_SCHEMA).validate(control)
            available = {block['tool_use_id'] for message in conversation
                         if isinstance(message.get('content'), list)
                         for block in message['content'] if block.get('type') == 'tool_result'}
            for item in control.get('results', []):
                if item['call_id'] not in available or item['call_id'] not in self.read_ids:
                    raise ValueError('Only existing read-only result call IDs may be selected.')
                if item['mode'] == 'summary' and not item.get('summary', '').strip():
                    raise ValueError('A summary selection requires a factual summary.')
        return arguments, control

    def apply(self, control):
        if control is None:
            return
        self.history = control.get('history', self.history)
        for item in control.get('results', []):
            self.results[item['call_id']] = item
        if 'tools' in control:
            self.tool_names = set(control['tools'])

    def view(self, conversation):
        # Keep the original exchange archive immutable; views can restore any read.
        view = deepcopy(conversation)
        start = 0 if self.history == 'all' else max(0, self.initial_count - 5) if self.history == 'recent' else self.initial_count - 1
        view = view[start:]
        for message in view:
            if not isinstance(message.get('content'), list):
                continue
            for block in message['content']:
                if block.get('type') == 'tool_use':
                    block.get('input', {}).pop('_context', None)
                elif block.get('type') == 'tool_result':
                    selection = self.results.get(block['tool_use_id'])
                    if selection and selection['mode'] == 'summary':
                        block['content'] = json.dumps({
                            'compacted': True, 'callId': block['tool_use_id'],
                            'modelNote': selection['summary'],
                            'restore': 'Select this call_id with mode=full in _context.'})
        return view
