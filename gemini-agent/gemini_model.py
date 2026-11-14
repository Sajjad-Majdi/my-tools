"""mini-swe-agent models for Gemini: the web app first (your own Google login), the Gemini API as the fallback.

Web: reuses the cookies of the gemini-web tool (its cookies.json) and keeps ONE web chat per agent run: the first
query sends the system prompt + task, later queries send only the new messages (command output).
API: the Gemini API's OpenAI-compatible endpoint through litellm, with a list of keys tried in turn.
Both use mini-swe-agent's text protocol (one ```mswea_bash_command block per reply), so no tool-calling API is needed.

Settings: env vars, or config.local.json next to this file (same names, lower case; values or env-var NAMES):
  GWEB_DIR        gemini-web folder (default ../gemini-web)
  GWEB_PROXY      HTTP proxy for the web app (default none)
  GWEB_TIMEOUT    seconds per reply (default 300)
  GEMINI_API_BASE API root (default https://generativelanguage.googleapis.com/v1beta/openai)
  GEMINI_API_KEYS comma list of keys; or config "api_key_envs": list of env-var names holding keys
  config "api_headers_env": {"header-name": "ENV_VAR_NAME"} extra headers read from env vars (e.g. a relay secret)
"""
import asyncio
import json
import os
import pathlib
import random
import sys
import threading
from types import SimpleNamespace

import litellm

from minisweagent.models.litellm_textbased_model import LitellmTextbasedModel

HERE = pathlib.Path(__file__).resolve().parent
_CFG_FILE = HERE / "config.local.json"
CFG = json.loads(_CFG_FILE.read_text(encoding="utf-8")) if _CFG_FILE.exists() else {}


def setting(name: str, default=None):
    v = os.environ.get(name)
    return v if v not in (None, "") else CFG.get(name.lower(), default)


GWEB_DIR = pathlib.Path(setting("GWEB_DIR", HERE.parent / "gemini-web"))
os.environ.setdefault("GEMINI_COOKIE_PATH", str(GWEB_DIR / "cookie_cache"))


def api_keys() -> list[str]:
    keys = [k.strip() for k in (os.environ.get("GEMINI_API_KEYS") or "").split(",") if k.strip()]
    keys += [os.environ[n] for n in CFG.get("api_key_envs", []) if os.environ.get(n)]
    return keys


def api_headers() -> dict:
    h = {"User-Agent": "gemini-agent/1.0"}
    h.update({k: os.environ[v] for k, v in CFG.get("api_headers_env", {}).items() if os.environ.get(v)})
    return h


def _say(text: str):
    print(f"[gemini-agent] {text}", file=sys.stderr, flush=True)


class _Loop:
    """One background event loop, so the async web client and chat survive between sync query() calls."""

    def __init__(self):
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, daemon=True).start()

    def run(self, coro, timeout=None):
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout)


WEB_NOTE = (
    "IMPORTANT: you are driving a REAL shell on the user's computer through the ```mswea_bash_command block. "
    "Do NOT use your own code-execution or file tools: nothing you run there exists on the user's computer. "
    "A file exists only after a shell command you send creates it (for example with a heredoc), and a check counts "
    "only when its output came back to you from the user's shell. Send exactly one command block per reply."
)


def _flatten(messages: list[dict]) -> str:
    parts = []
    for m in messages:
        content = m.get("content") or ""
        if isinstance(content, list):
            content = "\n".join(p.get("text", "") for p in content if isinstance(p, dict))
        role = m.get("role", "user")
        parts.append(content if role == "user" else f"[{role.upper()}]\n{content}")
    return "\n\n".join(parts)


def _response(text: str, model: str, backend: str):
    msg = SimpleNamespace(content=text, role="assistant",
                          model_dump=lambda **_: {"role": "assistant", "content": text})
    return SimpleNamespace(choices=[SimpleNamespace(message=msg, finish_reason="stop")],
                           model_dump=lambda **_: {"content": text, "model": model, "backend": backend})


class GeminiDown(RuntimeError):
    """Both the web app and the API failed: stop the run instead of retrying forever."""


class GeminiModel(LitellmTextbasedModel):
    """model_name = a Gemini model id (e.g. gemini-4-hydrogen). backend: auto (web, then API), web, or api."""

    def __init__(self, backend: str = "auto", api_model: str | None = None, **kwargs):
        kwargs.setdefault("cost_tracking", "ignore_errors")
        super().__init__(**kwargs)
        self.backend = backend
        self.abort_exceptions = [*self.abort_exceptions, GeminiDown]
        self.api_model = api_model or self.config.model_name
        self.used = "api" if backend == "api" else "web"
        self._loop = _Loop()
        self._client = None
        self._chat = None
        self._sent = 0
        self._timeout = float(setting("GWEB_TIMEOUT", 300))

    # ------------------------------------------------------------------ web
    async def _connect(self):
        from gemini_webapi import GeminiClient, set_log_level
        set_log_level("ERROR")
        jar = json.loads((GWEB_DIR / "cookies.json").read_text(encoding="utf-8-sig"))
        c = GeminiClient(jar["__Secure-1PSID"], jar.get("__Secure-1PSIDTS", ""), proxy=setting("GWEB_PROXY") or None)
        c.cookies = jar
        await c.init(timeout=120, auto_close=False, auto_refresh=True)
        return c

    async def _ask(self, prompt: str) -> str:
        if self._client is None:
            self._client = await self._connect()
        if self._chat is None:
            self._chat = self._client.start_chat(model=self.config.model_name)
        resp = await self._client.generate_content(prompt, model=self.config.model_name, chat=self._chat,
                                                   temporary=True)
        if not (resp.text or "").strip():
            raise RuntimeError("empty reply from the web app")
        return resp.text

    def _query_web(self, messages: list[dict]) -> str:
        if self._chat is None or len(messages) < self._sent:
            self._chat, self._sent = None, 0
        new = messages[self._sent:]
        if self._sent:  # the model's own last reply is already in the web chat
            new = [m for m in new if m.get("role") != "assistant"]
        prompt = _flatten(new)
        if not self._sent:  # the web app has its own code tool; the agent must use the user's shell instead
            prompt = WEB_NOTE + "\n\n" + prompt
        text = self._loop.run(self._ask(prompt), timeout=self._timeout)
        self._sent = len(messages) + 1  # + the reply we return now
        return text

    # ------------------------------------------------------------------ api
    def _query_api(self, messages: list[dict]) -> str:
        keys = api_keys()
        if not keys:
            raise GeminiDown("no Gemini API key (set GEMINI_API_KEYS or api_key_envs in config.local.json)")
        random.shuffle(keys)
        base = setting("GEMINI_API_BASE", "https://generativelanguage.googleapis.com/v1beta/openai")
        last = None
        for key in keys[:6]:
            try:
                r = litellm.completion(model=f"openai/{self.api_model}", api_base=base, api_key=key,
                                       messages=[{"role": m["role"], "content": m.get("content") or ""} for m in messages],
                                       extra_headers=api_headers(), timeout=self._timeout)
                text = r.choices[0].message.content or ""
                if text.strip():
                    return text
                last = RuntimeError("empty reply")
            except Exception as e:  # 429 / 403 on one key: try the next
                last = e
        raise GeminiDown(f"Gemini API failed on {min(len(keys), 6)} keys: {last}")

    # ------------------------------------------------------------------ both
    def _query(self, messages: list[dict], **kwargs):
        if self.used == "web":
            try:
                return _response(self._query_web(messages), self.config.model_name, "web")
            except Exception as e:
                if self.backend == "web":
                    raise
                _say(f"web app failed ({type(e).__name__}: {str(e)[:200]}); switching to the Gemini API")
                self.used = "api"
        return _response(self._query_api(messages), self.api_model, "api")

    def _calculate_cost(self, response) -> dict[str, float]:
        return {"cost": 0.0}
