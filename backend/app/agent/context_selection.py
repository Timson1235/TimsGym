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
The backend automatically budgets read-result context, even without _context.
Compacted results are incomplete previews, NOT evidence of absent records.
Restore a prior read with results mode=full alongside your next useful call, or
repeat its original read tool to retrieve the exact cached result. Large results
may still exceed the budget: fetch one workout or one exercise instead of a page
of full workouts. Never infer omitted sets, effort, notes or search coverage.
suggest_weight includes lastPerformance (recorded actual sets, not a target).
Batch those checks for all selected exercises; do not separately fetch histories
unless more than the latest performance is genuinely needed. For vague references,
browse recent unfiltered summaries first instead of trying multiple title searches.
"""


def _encode(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))


def _preview(content, limit):
    """Bounded exact excerpt, never a generated summary or an implied full result."""
    if len(content) <= limit:
        return content
    # This string deliberately is not parsed as a complete JSON document.
    return content[:max(0, limit - 30)] + ' [INCOMPLETE; restore original]'


class ContextSelection:
    def __init__(self, messages, read_budget_chars=12000):
        self.initial_count = len(messages)
        self.history = 'all'
        self.results = {}
        self.read_ids = set()
        self.tool_names = None
        self.read_budget_chars = read_budget_chars
        self.stats = {}

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
        self._budget_reads(view)
        return view

    def _budget_reads(self, view):
        calls = {block['id']: block.get('name') for message in view
                 if isinstance(message.get('content'), list) for block in message['content']
                 if block.get('type') == 'tool_use'}
        reads = [block for message in view if isinstance(message.get('content'), list)
                 for block in message['content'] if block.get('type') == 'tool_result'
                 and block['tool_use_id'] in self.read_ids]
        original_size = sum(len(block['content']) for block in reads)
        for block in reads:
            if calls.get(block['tool_use_id']) == 'discover_tools':
                try:
                    result = json.loads(block['content'])
                    if 'availableNextRound' in result:
                        block['content'] = _encode({'availableNextRound': [
                            item['name'] for item in result['availableNextRound']]})
                except (ValueError, TypeError, KeyError):
                    pass  # Preserve error feedback rather than inventing success.
        # Keep the latest copy of identical evidence, never a dangling read-* ref.
        latest, candidates = {}, []
        for block in reversed(reads):
            content, call_id = block['content'], block['tool_use_id']
            receipt = {'compacted': True, 'callId': call_id}
            if content in latest:
                receipt['sameAsCallId'] = latest[content]
            else:
                latest[content] = call_id
            candidates.append((block, content, receipt))
            block['content'] = _encode(receipt)
        remaining = self.read_budget_chars - sum(len(block['content']) for block in reads)
        if remaining < 0:
            raise RuntimeError('Read-result receipt budget exceeded; no model call sent')
        # Explicit full retention gets priority, but cannot bypass the hard budget.
        candidates.sort(key=lambda item: self.results.get(item[0]['tool_use_id'], {}).get('mode') != 'full')
        pending = []
        for block, content, receipt in candidates:
            extra = len(content) - len(block['content'])
            if 'sameAsCallId' not in receipt and extra <= remaining:
                remaining -= extra
                block['content'] = content
            else:
                pending.append((block, content, receipt))
        for block, content, receipt in pending:
            if 'sameAsCallId' in receipt:
                continue
            preview = _encode({**receipt, 'excerpt': _preview(content, min(900, remaining // 2))})
            extra = len(preview) - len(block['content'])
            if extra <= remaining:
                block['content'] = preview
                remaining -= extra
        self.stats = {'readCharactersBefore': original_size,
                      'readCharactersAfter': sum(len(block['content']) for block in reads),
                      'readBudgetCharacters': self.read_budget_chars,
                      'compactedResults': sum(block['content'].startswith('{"compacted":true') for block in reads)}
