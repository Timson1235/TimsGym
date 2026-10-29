"""Request-local discovery of native tools; never a generic execution gateway."""
from copy import deepcopy
from dataclasses import dataclass
import json
from typing import Callable

from jsonschema import Draft202012Validator

from .tools import TOOL_DECLARATIONS, HANDLERS
from .batch_retrieval import BATCH_DECLARATION, handle_batch_retrieve


DISCOVER_DECLARATION = {
    'name': 'discover_tools',
    'description': 'Activate named tools from the catalog for the NEXT model round. Batch all tools you need. This does not execute them. Activated tools remain available for this request.',
    'parameters': {'type': 'OBJECT', 'properties': {
        'names': {'type': 'ARRAY', 'items': {'type': 'STRING'}, 'minItems': 1, 'maxItems': 32},
    }, 'required': ['names']},
}


def validation_schema(schema):
    """Convert our provider-neutral schema to JSON Schema, rejecting unknown fields."""
    result = deepcopy(schema)
    if 'type' in result:
        result['type'] = result['type'].lower()
    if result.get('type') == 'object':
        result['additionalProperties'] = False
        result['properties'] = {key: validation_schema(value) for key, value in result.get('properties', {}).items()}
    if 'items' in result:
        result['items'] = validation_schema(result['items'])
    return result


@dataclass(frozen=True)
class ToolSpec:
    declaration: dict
    handler: Callable | None
    read_only: bool
    summary: str

    def validate(self, args):
        # Reject non-JSON values (including NaN) as well as schema violations.
        json.dumps(args, allow_nan=False)
        errors = sorted(Draft202012Validator(validation_schema(self.declaration['parameters'])).iter_errors(args),
                        key=lambda error: str(list(error.path)))
        if errors:
            error = errors[0]
            path = '.'.join(map(str, error.path)) or 'arguments'
            raise ValueError(f'{path}: {error.message}')


_READ_ONLY = {'get_exercise_history', 'get_session_summary', 'get_workout_details', 'resolve_exercise', 'suggest_weight'}
_SUMMARIES = {
    'save_personal_memory': 'Save a personal fact, only when explicitly requested.',
    'remove_personal_memory': 'Forget a saved personal fact on request.',
    'start_workout_session': 'Create or replace a complete workout preview/start button; does not start it.',
    'log_set': 'Record stated actual set values in the active workout.',
    'correct_log': 'Correct a recorded active-workout set on request.',
    'get_exercise_history': 'Retrieve one exercise across completed workouts, including its last performance.',
    'get_session_summary': 'Find completed workouts by title/date, optionally including full details.',
    'get_workout_details': 'Read a specific saved workout by ID.',
    'resolve_exercise': 'Resolve an exercise name or alias to a canonical library identity.',
    'open_flag': 'Record a temporary symptom or training limitation.',
    'resolve_flag': 'Resolve an existing temporary limitation.',
    'suggest_weight': 'Get deterministic progression targets and bounded evidence for a trained exercise.',
    'log_workout': 'Save a completed workout, distinct from a preview or active session.',
    'add_exercise': 'Add a missing canonical exercise to the library.',
    'update_profile': 'Update the user profile on request.',
    'delete_workout': 'Delete an identified saved workout on request.',
}
assert {item['name'] for item in TOOL_DECLARATIONS} == set(HANDLERS) == set(_SUMMARIES)
REGISTRY = {item['name']: ToolSpec(item, HANDLERS[item['name']], item['name'] in _READ_ONLY, _SUMMARIES[item['name']])
            for item in TOOL_DECLARATIONS}
REGISTRY['batch_retrieve'] = ToolSpec(BATCH_DECLARATION, handle_batch_retrieve, True,
    'Batch multiple session summaries, exercise histories, workout details, identity and progression checks in one read-only call.')
REGISTRY['discover_tools'] = ToolSpec(DISCOVER_DECLARATION, None, True, 'Activate catalog tools for the next round.')


def catalog():
    return '\n'.join(f'- {name}: {spec.summary}' for name, spec in REGISTRY.items() if name != 'discover_tools')


class ToolSession:
    def __init__(self, active_workout: bool):
        self.active = {'discover_tools'}
        if active_workout:
            self.active.update(('log_set', 'correct_log', 'resolve_exercise'))
        self.initial = self.names()
        self.advertised = frozenset(self.active)
        self.discovery_results = []

    def names(self):
        return sorted(self.active)

    def declarations(self):
        # Freeze per-round capabilities: discovery cannot authorize a sibling call.
        self.advertised = frozenset(self.active)
        return [deepcopy(REGISTRY[name].declaration) for name in self.names()]

    def validate(self, name, args):
        if name not in REGISTRY:
            raise ValueError(f'Unknown tool {name}; choose a name from the catalog.')
        if name not in self.advertised:
            raise ValueError(f'Tool {name} is inactive. Call discover_tools with its name, then use it next round.')
        REGISTRY[name].validate(args)
        return REGISTRY[name]

    def discover(self, names):
        names = list(dict.fromkeys(names))
        unknown = [name for name in names if name not in REGISTRY or name == 'discover_tools']
        if unknown:
            raise ValueError(f'Unknown catalog tools: {", ".join(unknown)}. Use exact catalog names.')
        self.active.update(names)
        result = {'availableNextRound': [
            {'name': name, 'guidance': REGISTRY[name].declaration['description']} for name in names]}
        self.discovery_results.append(result)
        return result


# Up to eight tool-capable rounds, then one answer-only round. A genuine
# repeat/adapt workflow can need resolution, retrieval, progression and preview.
MAX_MODEL_ROUNDS = 9
FINAL_RESPONSE_INSTRUCTION = (
    'The tool budget for this request is now exhausted. Do not call any more tools. '
    'Reply to the user in the language of their latest request using only confirmed '
    'tool results. State what succeeded and what remains unfinished. Do not claim '
    'a workout preview exists unless its creation succeeded, or that a workout started. '
    'Do not infer unlogged performance. Keep the response concise.'
)


class RoundBudget:
    """Six work rounds, two discovery-only rounds; final response is separate."""
    def __init__(self, ordinary_limit=6, discovery_limit=2):
        self.ordinary_limit, self.discovery_limit = ordinary_limit, discovery_limit
        self.ordinary = self.discovery = 0

    @property
    def exhausted(self):
        return self.ordinary >= self.ordinary_limit

    def record(self, names):
        if names and set(names) == {'discover_tools'}:
            self.discovery += 1
            if self.discovery > self.discovery_limit:
                self.ordinary = self.ordinary_limit
        else:
            self.ordinary += 1
