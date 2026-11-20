"""Cooperative request interruption for the single-process API runtime."""
from dataclasses import dataclass, field
from threading import Event, Lock


class ChatInterrupted(BaseException):
    """Control flow, not a provider failure eligible for fallback/replay."""


@dataclass
class ChatControl:
    user_id: int
    thread_id: str
    stopped: Event = field(default_factory=Event)


_lock = Lock()
_requests: dict[str, ChatControl] = {}


def register(request_id: str, user_id: int, thread_id: str) -> ChatControl:
    with _lock:
        if request_id in _requests or any(
            item.user_id == user_id and item.thread_id == thread_id for item in _requests.values()
        ):
            raise ValueError('This chat already has a request running. Wait for it to finish before retrying.')
        control = ChatControl(user_id, thread_id)
        _requests[request_id] = control
        return control


def interrupt(request_id: str, user_id: int) -> bool:
    with _lock:
        control = _requests.get(request_id)
        if control is None or control.user_id != user_id:
            return False
        control.stopped.set()
        return True


def release(request_id: str, control: ChatControl):
    with _lock:
        if _requests.get(request_id) is control:
            del _requests[request_id]
