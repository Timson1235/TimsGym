"""Bridge the synchronous coach to an SSE response without sharing DB sessions."""
import json
import logging
from queue import Queue, Empty
from threading import Event, Thread
from typing import Callable, Iterator

logger = logging.getLogger(__name__)


def stream_events(work: Callable[[Callable[[dict], None]], dict]) -> Iterator[str]:
    events: Queue = Queue()
    disconnected = Event()

    def emit(event: dict):
        if not disconnected.is_set():
            events.put(event)

    def run():
        try:
            result = work(emit)
            emit({"type": "final", "result": result})
        except Exception as error:
            logger.error("Streaming coach failed (%s)", type(error).__name__)
            emit({"type": "error", "message": "The connection to the coach failed. Changes may already have been saved; reload the chat and check your workout before retrying."})

    # On disconnect the worker finishes persistence, but stops buffering events.
    # Never automatically retry a potentially mutating request.
    Thread(target=run, daemon=True).start()
    try:
        while True:
            try:
                event = events.get(timeout=10)
            except Empty:
                yield ": keepalive\n\n"
                continue
            yield "data: " + json.dumps(event, ensure_ascii=False, separators=(",", ":")) + "\n\n"
            if event["type"] in {"final", "error"}:
                break
    finally:
        disconnected.set()
