"""Live-interview calls go first: background LLM calls wait while they run."""
from unittest.mock import patch

from app.services import llm_priority


class FakeRedis:
    def __init__(self):
        self.store = {}

    def incr(self, key):
        self.store[key] = int(self.store.get(key, 0)) + 1
        return self.store[key]

    def decr(self, key):
        self.store[key] = int(self.store.get(key, 0)) - 1
        return self.store[key]

    def expire(self, key, seconds):
        return True

    def get(self, key):
        return self.store.get(key)

    def set(self, key, value, ex=None):
        self.store[key] = value


def test_interactive_calls_are_counted_while_they_run():
    fake = FakeRedis()
    with patch.object(llm_priority, "get_redis", return_value=fake):
        assert llm_priority.interactive_calls_in_flight() == 0
        with llm_priority.interactive():
            assert llm_priority.interactive_calls_in_flight() == 1
            assert llm_priority.is_interactive()
        assert llm_priority.interactive_calls_in_flight() == 0
        assert not llm_priority.is_interactive()


def test_background_waits_only_while_interviews_run_and_never_forever():
    fake = FakeRedis()
    with patch.object(llm_priority, "get_redis", return_value=fake), patch.object(llm_priority.time, "sleep"):
        assert llm_priority.yield_to_interactive(max_wait_seconds=2) == 0.0
        fake.store[llm_priority._KEY] = 3
        assert llm_priority.yield_to_interactive(max_wait_seconds=2, poll_seconds=0.5) == 2.0


def test_interactive_callers_never_wait():
    fake = FakeRedis()
    fake.store[llm_priority._KEY] = 5
    with patch.object(llm_priority, "get_redis", return_value=fake), patch.object(llm_priority.time, "sleep") as slept:
        with llm_priority.interactive():
            assert llm_priority.yield_to_interactive(max_wait_seconds=2) == 0.0
        slept.assert_not_called()


def test_without_redis_nothing_blocks():
    with patch.object(llm_priority, "get_redis", return_value=None):
        with llm_priority.interactive():
            pass
        assert llm_priority.yield_to_interactive() == 0.0
