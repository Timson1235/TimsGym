"""Bounded, read-only retrieval batches using the existing account-scoped tools."""
from copy import deepcopy
import json

from .. import tracing
from .tools import TOOL_DECLARATIONS

# No mutation, discovery, recursive batch execution or arbitrary handler dispatch.
READ_TOOLS = ('get_session_summary', 'get_exercise_history', 'get_workout_details',
              'resolve_exercise', 'suggest_weight')
MAX_BATCH_REQUESTS = 16


def _declaration():
    # Reuse parameter descriptions/types; do not maintain another copy of them.
    properties = {}
    for declaration in TOOL_DECLARATIONS:
        if declaration['name'] in READ_TOOLS:
            properties.update(deepcopy(declaration['parameters'].get('properties', {})))
    return {
        'name': 'batch_retrieve',
        'description': (
            'Retrieve up to 16 independent facts in ONE call: mix workout summaries, '
            'exercise histories, exact workouts, exercise resolution and progression checks. '
            'Prefer this for multiple lookups or suggest_weight for several exercises. '
            'Give every request a unique key; each result has that key and success/error. '
            'Use only the arguments of its chosen tool. Session summaries accept limit, '
            'search_title_or_date, include_details and cursor; follow hasMore/nextCursor for older pages; histories accept exercise_id or '
            'exercise_name and limit; details require workout_id; resolution requires query; '
            'suggest_weight accepts exercise_id or exercise_name. Names/aliases are resolved '
            'by history/progression tools; ambiguity is returned, never guessed. '
            'Use limit=1 for last performance and include_details=true for repeat/adapt. '
            'Results preserve canonical exercise IDs. Batch progression checks once IDs '
            'are known; do not repeat history merely to obtain progression. '
            'This tool never writes data. Missing/failed items do not erase other results. '
            'Requests cannot reference sibling results: dependent lookups belong next round. '
            'Duplicate tool/argument pairs are returned as duplicateOf references, not repeated data.'
        ),
        'parameters': {'type': 'OBJECT', 'properties': {
            'requests': {'type': 'ARRAY', 'minItems': 1, 'maxItems': MAX_BATCH_REQUESTS,
                'items': {'type': 'OBJECT', 'properties': {
                    'key': {'type': 'STRING', 'minLength': 1, 'maxLength': 80},
                    'tool': {'type': 'STRING', 'enum': list(READ_TOOLS)},
                    'arguments': {'type': 'OBJECT', 'properties': properties},
                }, 'required': ['key', 'tool', 'arguments']}},
        }, 'required': ['requests']},
    }


BATCH_DECLARATION = _declaration()


def handle_batch_retrieve(session, user_id, db, args, **kwargs):
    # Runtime import avoids a registry/declarations import cycle. Each child uses
    # its original schema and account-scoped handler; it need not be discovered
    # individually because discovering this read-only batch grants these reads.
    from .tool_registry import REGISTRY
    requests = args.get('requests')
    if not isinstance(requests, list) or not 1 <= len(requests) <= MAX_BATCH_REQUESTS:
        raise ValueError(f'Provide 1–{MAX_BATCH_REQUESTS} retrieval requests.')
    keys = [request.get('key') for request in requests]
    if any(not isinstance(key, str) or not key.strip() for key in keys) or len(set(keys)) != len(keys):
        raise ValueError('Every retrieval request needs a unique, nonempty key.')

    results, seen = [], {}
    for request in requests:
        key, name, arguments = request['key'], request.get('tool'), request.get('arguments')
        with tracing.Span('retrieval', name or 'Unknown retrieval', {'key': key, 'arguments': arguments}) as span:
            try:
                if name not in READ_TOOLS or not REGISTRY[name].read_only:
                    raise ValueError('Only the listed read-only retrieval tools are allowed.')
                spec = REGISTRY[name]
                spec.validate(arguments)
                signature = (name, json.dumps(arguments, sort_keys=True, separators=(',', ':'), allow_nan=False))
                if signature in seen:
                    item = {'key': key, 'tool': name, 'success': True, 'duplicateOf': seen[signature]}
                else:
                    cache = kwargs.get('read_cache')
                    load = lambda: spec.handler(session, user_id, db, arguments, **kwargs)
                    data = cache.read(name, arguments, db, load) if cache else load()
                    if name == 'get_session_summary':
                        # include_details already contains all sets; avoid returning
                        # the same exercise/set data again in the summary projection.
                        data = deepcopy(data)
                        for entry in data.get('sessions', []):
                            if entry.get('workout') is not None:
                                entry.pop('exercises', None)
                    item = {'key': key, 'tool': name, 'success': True, 'result': data}
                    seen[signature] = key
            except Exception as error:
                span.error(error)
                item = {'key': key, 'tool': name, 'success': False,
                        'error': str(error)}
            span.output(item)
            results.append(item)
    return {'results': results}
