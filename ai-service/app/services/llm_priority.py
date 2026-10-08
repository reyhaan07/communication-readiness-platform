"""Live interviews before background work when the LLM quota is shared (bulkhead).

The API process (live interview questions, answer scoring, resume reading) and the
agent worker process (4-week plans) draw from the same per-minute LLM quota. During a
busy interview session the plans would otherwise compete with — and slow down —
students who are waiting for their next question.

Interactive calls register themselves in a Redis counter shared by both processes;
background calls wait (up to a bound, so plans still finish) while that counter is
above zero. Without Redis both functions are no-ops.
"""
from __future__ import annotations

import contextvars
import time
from contextlib import contextmanager
from typing import Iterator

from app.cache.redis_client import get_redis

_KEY = "llm:interactive_inflight"
# A crashed request must not block background work forever
_KEY_TTL_SECONDS = 180

# "interactive" inside an API request that a student is waiting on; "background" otherwise
_role: contextvars.ContextVar[str] = contextvars.ContextVar("llm_role", default="background")


def is_interactive() -> bool:
    return _role.get() == "interactive"


@contextmanager
def interactive() -> Iterator[None]:
    """Mark the enclosed LLM work as a student waiting on it."""
    token = _role.set("interactive")
    redis = None
    try:
        redis = get_redis()
        if redis is not None:
            redis.incr(_KEY)
            redis.expire(_KEY, _KEY_TTL_SECONDS)
    except Exception:
        redis = None  # Redis trouble never blocks an interview
    try:
        yield
    finally:
        _role.reset(token)
        if redis is not None:
            try:
                if redis.decr(_KEY) < 0:
                    redis.set(_KEY, 0, ex=_KEY_TTL_SECONDS)
            except Exception:
                pass


def interactive_calls_in_flight() -> int:
    try:
        redis = get_redis()
        value = redis.get(_KEY) if redis is not None else None
        return max(0, int(value or 0))
    except Exception:
        return 0


def yield_to_interactive(max_wait_seconds: float = 25.0, poll_seconds: float = 0.5) -> float:
    """Background callers wait while live-interview calls are running. Returns seconds waited."""
    if is_interactive():
        return 0.0
    waited = 0.0
    while waited < max_wait_seconds and interactive_calls_in_flight() > 0:
        time.sleep(poll_seconds)
        waited += poll_seconds
    return waited
