import re


WORKOUT_CONFIRMATION_QUESTION = "Soll ich dieses Workout so starten?"


def is_explicit_workout_confirmation(message: str) -> bool:
    normalized = re.sub(r"\s+", " ", (message or "").strip().lower())
    patterns = [
        r"^(ja|yes|jep|jo)([,!. ]|$)",
        r"\b(starte|start|lade|übernimm)\b.*\b(workout|training|plan)\b",
        r"\b(workout|training|plan)\b.*\b(starten|starten bitte|laden|übernehmen)\b",
        r"^(los geht'?s|leg los|auf geht'?s|los|start|starte|mach das|genau so|passt so)[!. ]*$",
    ]
    return any(re.search(pattern, normalized) for pattern in patterns)


def has_pending_workout_draft(history: list) -> bool:
    assistants_checked = 0
    for message in reversed(history):
        if message.role == "assistant":
            assistants_checked += 1
            content = message.content.lower()
            if WORKOUT_CONFIRMATION_QUESTION.lower() in content:
                return True
            looks_like_plan = re.search(r"\b(workout|training|trainingsplan|plan)\b", content)
            set_prescriptions = re.findall(r"\b\d+\s*[x×]\s*\d+\b", content)
            if looks_like_plan and len(set_prescriptions) >= 2:
                return True
            if assistants_checked >= 4:
                break
    return False
