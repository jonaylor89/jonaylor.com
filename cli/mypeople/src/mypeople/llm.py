"""The model. Pick a backend with MYPEOPLE_LLM:

- codex (default): GPT-6.1 Sol through the ChatGPT Codex backend, using pi's
  ChatGPT login. Credentials are read from pi's auth file and never written: pi
  rotates the refresh token under a file lock, so refreshing here could log pi
  out. When the access token expires, running `pi` once refreshes it.
- lmstudio: a model served by LM Studio on this Mac.
- ds4: DeepSeek V4 Flash served by DwarfStar (ds4-server) on this Mac.
- claude: Claude Opus 5.5 through the Anthropic API, keyed by ANTHROPIC_API_KEY
  (read from the environment or a .env file).

Local backends keep message text on the machine.
"""

from __future__ import annotations

import base64
import http.client
import json
import os
import re
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any

EFFORT = os.environ.get("MYPEOPLE_EFFORT", "medium")
AUTH_PATH = Path(os.environ.get("MYPEOPLE_PI_AUTH", Path.home() / ".pi" / "agent" / "auth.json"))
URL = "https://chatgpt.com/backend-api/codex/responses"
JWT_CLAIM = "https://api.openai.com/auth"
TIMEOUT = int(os.environ.get("MYPEOPLE_TIMEOUT", "600"))  # local servers can be slow, or busy with another run
# Seconds of silence before giving up on a ChatGPT stream; stalled connections otherwise hang for TIMEOUT.
CODEX_TIMEOUT = 180
RETRIES = 3


class LLMError(RuntimeError):
    pass


@dataclass(frozen=True)
class Backend:
    name: str
    model: str
    url: str
    chunk_chars: int  # message text per extraction call; local servers run smaller contexts
    local: bool


BACKENDS = {
    "codex": Backend("codex", "gpt-6.1-sol", URL, 150_000, local=False),
    "lmstudio": Backend("lmstudio", "qwen/qwen3.8-27b", "http://127.0.0.1:1234/v1", 40_000, local=True),
    "ds4": Backend("ds4", "deepseek-v4-flash", "http://127.0.0.1:8000/v1", 40_000, local=True),
    "claude": Backend("claude", "claude-opus-5-5", "https://api.anthropic.com", 150_000, local=False),
}


def load_env_file(path: Path | None = None) -> None:
    """Read a private env file without overriding existing environment variables.

    Default to ~/.mypeople/secrets.ini, or MYPEOPLE_ENV_FILE when explicitly set.
    Never discover credentials relative to the source tree or working directory.
    """
    path = path or Path(os.environ.get("MYPEOPLE_ENV_FILE", Path.home() / ".mypeople" / "secrets.ini")).expanduser()
    if not path.is_file():
        return
    for line in path.read_text().splitlines():
        key, sep, value = line.strip().partition("=")
        if sep and key and not key.startswith("#"):
            os.environ.setdefault(key.removeprefix("export ").strip(), value.strip().strip("'\""))


def backend() -> Backend:
    name = os.environ.get("MYPEOPLE_LLM", "codex")
    if name not in BACKENDS:
        raise LLMError(f"Unknown MYPEOPLE_LLM {name!r}; choose one of {', '.join(BACKENDS)}.")
    b = BACKENDS[name]
    return Backend(
        b.name,
        os.environ.get("MYPEOPLE_MODEL", b.model),
        os.environ.get("MYPEOPLE_LLM_URL", b.url),
        b.chunk_chars,
        b.local,
    )


def load_auth(path: Path = AUTH_PATH) -> tuple[str, str]:
    """Return (access_token, account_id) from pi's openai-codex login."""
    try:
        entry = json.loads(path.read_text())["openai-codex"]
    except FileNotFoundError:
        raise LLMError(f"No pi auth file at {path}. Log in with `pi` and choose ChatGPT.") from None
    except (KeyError, json.JSONDecodeError):
        raise LLMError(f"No ChatGPT (openai-codex) login in {path}. Log in with `pi` and choose ChatGPT.") from None
    token = entry.get("access")
    if not token:
        raise LLMError(f"The openai-codex entry in {path} has no access token.")
    if entry.get("expires", 0) / 1000 < time.time() + 60:
        raise LLMError("Your ChatGPT login in pi has expired. Run `pi` once to refresh it, then retry.")
    return token, entry.get("accountId") or _account_from_jwt(token)


def _account_from_jwt(token: str) -> str:
    try:
        payload = token.split(".")[1]
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        return claims[JWT_CLAIM]["chatgpt_account_id"]
    except (IndexError, KeyError, ValueError):
        raise LLMError("Couldn't find a ChatGPT account id in the pi login.") from None


def strict_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Make a pydantic JSON schema acceptable to strict structured outputs."""
    schema = json.loads(json.dumps(schema))

    def visit(node: Any) -> None:
        if isinstance(node, dict):
            if node.get("type") == "object" and "properties" in node:
                node["additionalProperties"] = False
                node["required"] = list(node["properties"])
            node.pop("default", None)
            for value in node.values():
                visit(value)
        elif isinstance(node, list):
            for value in node:
                visit(value)

    visit(schema)
    return schema


def _resets_in(detail: str) -> str:
    try:
        seconds = json.loads(detail)["error"]["resets_in_seconds"]
    except (ValueError, KeyError, TypeError):
        return ""
    return f"; it resets in {max(1, round(seconds / 60))} min"


def _request_body(instructions: str, user: str, schema: dict[str, Any] | None, name: str, model: str) -> dict[str, Any]:
    body: dict[str, Any] = {
        "model": model,
        "store": False,  # the Codex backend requires it
        "stream": True,
        "instructions": instructions,
        "input": [{"role": "user", "content": [{"type": "input_text", "text": user}]}],
        "reasoning": {"effort": EFFORT},
        "text": {"verbosity": "low"},
    }
    if schema is not None:
        body["text"]["format"] = {"type": "json_schema", "name": name, "schema": strict_schema(schema), "strict": True}
    return body


def _read_sse(lines) -> str:
    """Collect output text from a Responses event stream."""
    text: list[str] = []
    for raw in lines:
        line = raw.decode("utf-8", errors="replace").rstrip("\r\n") if isinstance(raw, bytes) else raw.rstrip("\r\n")
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data or data == "[DONE]":
            continue
        event = json.loads(data)
        kind = event.get("type")
        if kind == "response.output_text.delta":
            text.append(event.get("delta", ""))
        elif kind in ("response.completed", "response.done"):
            return "".join(text)
        elif kind == "response.incomplete":
            reason = (event.get("response") or {}).get("incomplete_details") or {}
            raise LLMError(f"Response cut off ({reason.get('reason', 'unknown reason')}).")
        elif kind == "response.failed":
            error = (event.get("response") or {}).get("error") or {}
            raise LLMError(f"Model request failed: {error.get('message', 'unknown error')}")
        elif kind == "error":
            raise LLMError(f"Model error: {event.get('message') or event.get('error') or event}")
    raise LLMError("The response stream ended early.")


def complete(
    instructions: str, user: str, schema: dict[str, Any] | None = None, name: str = "output", auth_path: Path = AUTH_PATH
) -> str:
    """One model call. Returns the output text (JSON when a schema is given)."""
    b = backend()
    if b.local:
        return _complete_local(b, instructions, user, schema, name)
    if b.name == "claude":
        return _complete_claude(b, instructions, user, schema)
    token, account_id = load_auth(auth_path)
    payload = json.dumps(_request_body(instructions, user, schema, name, b.model)).encode()
    headers = {
        "Authorization": f"Bearer {token}",
        "chatgpt-account-id": account_id,
        "OpenAI-Beta": "responses=experimental",
        "originator": "mypeople",
        "User-Agent": "mypeople/0.1",
        "accept": "text/event-stream",
        "content-type": "application/json",
    }
    for attempt in range(RETRIES):
        request = urllib.request.Request(URL, data=payload, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=CODEX_TIMEOUT) as response:
                return _read_sse(response)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", errors="replace")[:500]
            if e.code == 401:
                raise LLMError("ChatGPT rejected the pi login (401). Run `pi` to log in again.") from None
            if "usage_limit_reached" in detail:
                raise LLMError(f"ChatGPT usage limit reached{_resets_in(detail)}. Meanwhile, try --llm lmstudio or --llm ds4.") from None
            if (e.code == 429 or e.code >= 500) and attempt < RETRIES - 1:
                time.sleep(float(e.headers.get("retry-after") or 2 ** (attempt + 1)))
                continue
            raise LLMError(f"Model request failed ({e.code}): {detail}") from None
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException) as e:
            # Includes a connection dropped mid-stream; retrying the whole request is safe.
            if attempt < RETRIES - 1:
                time.sleep(2 ** (attempt + 1))
                continue
            raise LLMError(f"Couldn't reach ChatGPT: {e}") from None
    raise AssertionError("unreachable")


_THINK = re.compile(r"<think>.*?</think>", re.S)
_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$")


def clean_output(text: str) -> str:
    """Drop inline reasoning and code fences some local models wrap answers in."""
    text = _THINK.sub("", text).strip()
    return _FENCE.sub("", text).strip()


def _complete_local(b: Backend, instructions: str, user: str, schema: dict[str, Any] | None, name: str) -> str:
    """An OpenAI-style chat completion against a server on this machine."""
    body: dict[str, Any] = {
        "model": b.model,
        "messages": [{"role": "system", "content": instructions}, {"role": "user", "content": user}],
        "stream": False,
    }
    if b.name == "ds4" and os.environ.get("MYPEOPLE_THINK", "1") == "0":
        body["think"] = False  # answer directly; much faster on long extraction batches
    if schema is not None:
        strict = strict_schema(schema)
        # LM Studio constrains decoding to the schema; servers without that still get it in the prompt.
        body["response_format"] = {"type": "json_schema", "json_schema": {"name": name, "schema": strict, "strict": True}}
        body["messages"][0]["content"] += (
            "\n\nRespond with only a JSON object matching this JSON schema, no other text:\n" + json.dumps(strict)
        )
    request = urllib.request.Request(
        f"{b.url.rstrip('/')}/chat/completions",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT) as response:
            data = json.load(response)
    except urllib.error.HTTPError as e:
        raise LLMError(f"{b.name} request failed ({e.code}): {e.read().decode('utf-8', errors='replace')[:500]}") from None
    except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
        hint = {
            "lmstudio": "Start it with `lms server start` and `lms load qwen/qwen3.8-27b --context-length 32768`.",
            "ds4": "Start it with `./ds4-server --ctx 32768 --power 50` in ~/Repos/ds4.",
        }.get(b.name, "")
        raise LLMError(f"Couldn't reach {b.name} at {b.url}: {e}. {hint}".strip()) from None
    choice = (data.get("choices") or [{}])[0]
    if choice.get("finish_reason") == "length":
        raise LLMError(f"{b.name} ran out of context or output tokens; try a larger --ctx / context length.")
    message = choice.get("message") or {}
    text = clean_output(message.get("content") or "")
    # LM Studio puts schema-constrained output from reasoning models in reasoning_content.
    return text or clean_output(message.get("reasoning_content") or "")


def _complete_claude(b: Backend, instructions: str, user: str, schema: dict[str, Any] | None) -> str:
    import anthropic

    load_env_file()
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise LLMError("Set ANTHROPIC_API_KEY (in the environment or .env) to use --llm claude.")
    output_config: dict[str, Any] = {"effort": EFFORT}
    if schema is not None:
        output_config["format"] = {"type": "json_schema", "schema": strict_schema(schema)}
    try:
        response = anthropic.Anthropic().beta.messages.create(
            model=b.model,
            max_tokens=16000,
            # If a safety classifier declines, the API retries on a fallback model in the same call.
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
            output_config=output_config,
            system=instructions,
            messages=[{"role": "user", "content": user}],
        )
    except anthropic.AuthenticationError:
        raise LLMError("Anthropic rejected ANTHROPIC_API_KEY.") from None
    except anthropic.RateLimitError as e:
        raise LLMError(f"Anthropic rate limit: {e.message}") from None
    except anthropic.APIStatusError as e:
        raise LLMError(f"Anthropic request failed ({e.status_code}): {e.message}") from None
    except anthropic.APIConnectionError as e:
        raise LLMError(f"Couldn't reach Anthropic: {e}") from None
    if response.stop_reason == "refusal":
        raise LLMError("Claude declined this request.")
    if response.stop_reason == "max_tokens":
        raise LLMError("Claude's answer was cut off at the output limit.")
    return "".join(block.text for block in response.content if block.type == "text").strip()
