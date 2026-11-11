"""Lossless decision projections. No generated facts or string-sliced JSON."""
from copy import deepcopy
import json


def compact_progression(value):
    result = deepcopy(value)
    evidence = result.pop('evidence', None)
    if evidence:
        result['supportingHistoryOmitted'] = len(evidence)
    # Repeated set field names dominate payloads. A table preserves every value,
    # including explicit nulls, set types and unknown effort, without aggregation.
    latest = result.get('lastPerformance')
    if isinstance(latest, dict) and isinstance(latest.get('sets'), list):
        sets = latest['sets']
        columns = sorted({key for row in sets for key in row})
        table = {'columns': columns, 'rows': [[row.get(key) for key in columns] for row in sets]}
        if len(json.dumps(table)) < len(json.dumps(sets)):
            latest['sets'] = table
    result['projection'] = 'decision_and_latest_performance'
    return result


def project_result(name, value):
    if not isinstance(value, dict):
        return value
    if name == 'suggest_weight':
        return compact_progression(value)
    if name == 'batch_retrieve':
        result = deepcopy(value)
        for item in result.get('results', []):
            if item.get('success') and 'result' in item:
                item['result'] = project_result(item.get('tool'), item['result'])
        return result
    return value


def has_decisions(name, value):
    if not isinstance(value, dict):
        return False
    if name == 'suggest_weight':
        return 'status' in value
    return name == 'batch_retrieve' and any(
        item.get('success') and has_decisions(item.get('tool'), item.get('result'))
        for item in value.get('results', []))
