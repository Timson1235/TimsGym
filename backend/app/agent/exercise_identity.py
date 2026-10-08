"""Deterministic exercise-name resolution shared by all agent write tools."""
import re
import unicodedata
from typing import Optional


ALIASES = {
    "kniebeuge": "Barbell Back Squat",
    "squat": "Barbell Back Squat",
    "back squat": "Barbell Back Squat",
    "barbell squat": "Barbell Back Squat",
    "rdl": "Romanian Deadlift",
    "romanian dead lift": "Romanian Deadlift",
    "schragbank": "Schrägbank 30°",
    "schragbank 30": "Schrägbank 30°",
    "schragbank 30 grad": "Schrägbank 30°",
    "schraegbank 30 grad": "Schrägbank 30°",
    "incline barbell press": "Schrägbank 30°",
    "rudern maschine": "Rudermaschine",
    "chest supported row": "Rudermaschine",
    "schulterdrucken kh": "Schulterdrücken KH",
    "dumbbell shoulder press": "Schulterdrücken KH",
    "cable bicep curl": "Bizeps Kabel",
    "kabel bizeps": "Bizeps Kabel",
    "kabel seitheben": "Kabel-Seitheben",
    "pallof press kabelzug": "Pallof Press",
}


def normalize_exercise_name(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value or "")
    ascii_value = "".join(char for char in decomposed if not unicodedata.combining(char))
    return re.sub(r"[^a-z0-9]+", " ", ascii_value.lower()).strip()


def resolve_exercise(exercises: list[dict], query: str) -> tuple[Optional[dict], list[dict]]:
    normalized = normalize_exercise_name(query)
    by_name = {normalize_exercise_name(item.get("name", "")): item for item in exercises}
    direct = by_name.get(normalized)
    if direct:
        return direct, []

    alias_target = ALIASES.get(normalized)
    if alias_target:
        alias_match = by_name.get(normalize_exercise_name(alias_target))
        if alias_match:
            return alias_match, []

    candidates = [
        item for key, item in by_name.items()
        if normalized and (normalized in key or key in normalized)
    ]
    return (candidates[0], []) if len(candidates) == 1 else (None, candidates)
