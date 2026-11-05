import base64
import io
import json
import os
import time
import urllib.error

import pytest

from mypeople import llm
from mypeople.extract import Extraction


def jwt(claims):
    enc = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b"=").decode()
    return f"{enc({'alg': 'none'})}.{enc(claims)}.sig"


@pytest.fixture
def auth(tmp_path):
    def write(expires_in=3600, account="acct-1", access="tok"):
        p = tmp_path / "auth.json"
        entry = {"type": "oauth", "access": access, "refresh": "r", "expires": int((time.time() + expires_in) * 1000)}
        if account:
            entry["accountId"] = account
        p.write_text(json.dumps({"openai-codex": entry, "other": {}}))
        return p

    return write


def test_load_auth(auth, tmp_path):
    assert llm.load_auth(auth()) == ("tok", "acct-1")
    token = jwt({llm.JWT_CLAIM: {"chatgpt_account_id": "from-jwt"}})
    assert llm.load_auth(auth(account=None, access=token)) == (token, "from-jwt")
    with pytest.raises(llm.LLMError, match="expired"):
        llm.load_auth(auth(expires_in=-10))
    with pytest.raises(llm.LLMError, match="No pi auth file"):
        llm.load_auth(tmp_path / "missing.json")


def test_strict_schema():
    schema = llm.strict_schema(Extraction.model_json_schema())
    event = schema["$defs"]["ExtractedEvent"]
    assert event["additionalProperties"] is False
    assert set(event["required"]) == set(event["properties"])
    assert schema["additionalProperties"] is False


def sse(*events):
    return io.BytesIO("".join(f"event: x\ndata: {json.dumps(e)}\n\n" for e in events).encode())


def test_read_sse():
    stream = sse(
        {"type": "response.created"},
        {"type": "response.output_text.delta", "delta": '{"events": '},
        {"type": "response.output_text.delta", "delta": "[]}"},
        {"type": "response.completed", "response": {}},
    )
    assert llm._read_sse(stream) == '{"events": []}'
    with pytest.raises(llm.LLMError, match="usage limit"):
        llm._read_sse(sse({"type": "response.failed", "response": {"error": {"message": "usage limit reached"}}}))
    with pytest.raises(llm.LLMError, match="ended early"):
        llm._read_sse(sse({"type": "response.output_text.delta", "delta": "x"}))


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def test_complete_request_shape(auth, monkeypatch):
    sent = {}

    def urlopen(request, timeout):
        sent["url"], sent["headers"], sent["body"] = request.full_url, dict(request.header_items()), json.loads(request.data)
        return FakeResponse(sse({"type": "response.output_text.delta", "delta": '{"events": []}'}, {"type": "response.completed"}).getvalue())

    monkeypatch.setattr(llm.urllib.request, "urlopen", urlopen)
    out = llm.complete("be brief", "hi", schema=Extraction.model_json_schema(), name="extraction", auth_path=auth())
    assert out == '{"events": []}'
    assert sent["url"] == "https://chatgpt.com/backend-api/codex/responses"
    assert sent["headers"]["Authorization"] == "Bearer tok"
    assert sent["headers"]["Chatgpt-account-id"] == "acct-1"
    body = sent["body"]
    assert body["model"] == "gpt-6.1-sol" and body["store"] is False and body["stream"] is True
    assert body["instructions"] == "be brief"
    assert body["text"]["format"]["type"] == "json_schema" and body["text"]["format"]["strict"] is True


def test_complete_401(auth, monkeypatch):
    def urlopen(request, timeout):
        raise urllib.error.HTTPError(request.full_url, 401, "no", {}, io.BytesIO(b"bad token"))

    monkeypatch.setattr(llm.urllib.request, "urlopen", urlopen)
    with pytest.raises(llm.LLMError, match="log in again"):
        llm.complete("x", "y", auth_path=auth())


def test_backend_selection(monkeypatch):
    monkeypatch.setenv("MYPEOPLE_LLM", "lmstudio")
    monkeypatch.setenv("MYPEOPLE_MODEL", "qwen/other")
    b = llm.backend()
    assert (b.name, b.model, b.local, b.url) == ("lmstudio", "qwen/other", True, "http://127.0.0.1:1234/v1")
    monkeypatch.setenv("MYPEOPLE_LLM", "nope")
    with pytest.raises(llm.LLMError, match="Unknown"):
        llm.backend()


def test_clean_output():
    assert llm.clean_output('<think>hmm\nok</think>\n```json\n{"events": []}\n```') == '{"events": []}'


def test_local_completion_and_retry(monkeypatch, tmp_path):
    from mypeople.extract import default_model

    monkeypatch.setenv("MYPEOPLE_LLM", "ds4")
    sent = []
    replies = iter(['{"events": [{"type": "job"}]}', '<think>fix it</think>{"events": []}'])

    def urlopen(request, timeout):
        sent.append((request.full_url, json.loads(request.data)))
        body = {"choices": [{"message": {"content": next(replies)}, "finish_reason": "stop"}]}
        return FakeResponse(json.dumps(body).encode())

    monkeypatch.setattr(llm.urllib.request, "urlopen", urlopen)
    assert default_model()("system", "user") == Extraction(events=[])
    url, body = sent[0]
    assert url == "http://127.0.0.1:8000/v1/chat/completions"
    assert body["model"] == "deepseek-v4-flash" and body["response_format"]["type"] == "json_schema"
    assert "JSON schema" in body["messages"][0]["content"]
    assert "not valid for the schema" in sent[1][1]["messages"][1]["content"]


def test_local_unreachable(monkeypatch):
    monkeypatch.setenv("MYPEOPLE_LLM", "lmstudio")

    def urlopen(request, timeout):
        raise urllib.error.URLError("connection refused")

    monkeypatch.setattr(llm.urllib.request, "urlopen", urlopen)
    with pytest.raises(llm.LLMError, match="lms server start"):
        llm.complete("x", "y")


def test_usage_limit_not_retried(auth, monkeypatch):
    calls = []
    detail = json.dumps({"error": {"type": "usage_limit_reached", "resets_in_seconds": 522}}).encode()

    def urlopen(request, timeout):
        calls.append(1)
        raise urllib.error.HTTPError(request.full_url, 429, "limit", {}, io.BytesIO(detail))

    monkeypatch.setattr(llm.urllib.request, "urlopen", urlopen)
    with pytest.raises(llm.LLMError, match="resets in 9 min"):
        llm.complete("x", "y", auth_path=auth())
    assert len(calls) == 1


def test_claude_backend(monkeypatch, tmp_path):
    import types

    import anthropic

    monkeypatch.setenv("MYPEOPLE_LLM", "claude")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    sent = {}

    class FakeMessages:
        def create(self, **kwargs):
            sent.update(kwargs)
            block = types.SimpleNamespace(type="text", text='{"events": []}')
            return types.SimpleNamespace(content=[block], stop_reason="end_turn")

    class FakeClient:
        def __init__(self, *a, **k):
            self.beta = types.SimpleNamespace(messages=FakeMessages())

    monkeypatch.setattr(anthropic, "Anthropic", FakeClient)
    assert llm.complete("sys", "hi", schema=Extraction.model_json_schema()) == '{"events": []}'
    assert sent["model"] == "claude-opus-5-5" and sent["fallbacks"] == "default"
    assert sent["output_config"]["format"]["schema"]["additionalProperties"] is False


def test_load_env_file(tmp_path, monkeypatch):
    env = tmp_path / ".env"
    env.write_text('# comment\nexport MYPEOPLE_TEST_A="one"\nMYPEOPLE_TEST_B=two\n')
    monkeypatch.setenv("MYPEOPLE_TEST_B", "already")
    monkeypatch.delenv("MYPEOPLE_TEST_A", raising=False)
    llm.load_env_file(env)
    assert os.environ["MYPEOPLE_TEST_A"] == "one" and os.environ["MYPEOPLE_TEST_B"] == "already"
    monkeypatch.delenv("MYPEOPLE_TEST_A")


def test_dropped_connection_retried(auth, monkeypatch):
    calls = []

    def urlopen(request, timeout):
        calls.append(1)
        raise ConnectionResetError(54, "Connection reset by peer")

    monkeypatch.setattr(llm.urllib.request, "urlopen", urlopen)
    monkeypatch.setattr(llm.time, "sleep", lambda s: None)
    with pytest.raises(llm.LLMError, match="Couldn't reach ChatGPT"):
        llm.complete("x", "y", auth_path=auth())
    assert len(calls) == llm.RETRIES
