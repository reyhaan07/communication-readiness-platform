import pytest


@pytest.fixture(autouse=True)
def _no_live_web_search(monkeypatch):
    """Tests never reach DuckDuckGo; a test that needs results patches DDGS itself."""
    monkeypatch.setattr("app.tools.web_search.DDGS", None)
