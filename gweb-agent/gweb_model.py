"""mini-swe-agent model that talks to the Gemini web app (gemini.google.com) with your own Google login.

It reuses the cookies of the gemini-web tool (its cookies.json) and keeps ONE web chat per agent run: the first
query sends the system prompt + task, later queries send only the new messages (command output). The model writes
its shell command in a ```mswea_bash_command block (mini-swe-agent's text-based protocol), so no tool-calling API
is needed.

Settings (env): GWEB_DIR (gemini-web folder, default ../gemini-web), GWEB_PROXY (default: none),
GWEB_TIMEOUT (seconds per reply, default 300).
"""
import asyncio
import json
import os
import pathlib
import threading
import time
from types import SimpleNamespace

from minisweagent.models.litellm_textbased_model import LitellmTextbasedModel

HERE = pathlib.Path(__file__).resolve().parent
GWEB_DIR = pathlib.Path(os.environ.get("GWEB_DIR", HERE.parent / "gemini-web"))
os.environ.setdefault("GEMINI_COOKIE_PATH", str(GWEB_DIR / "cookie_cache"))


class _Loop:
    """One background event loop, so the async client and chat survive between sync query() calls."""

    def __init__(self):
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, daemon=True).start()

    def run(self, coro, timeout=None):
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout)


def _flatten(messages: list[dict]) -> str:
    parts = []
    for m in messages:
        content = m.get("content") or ""
        if isinstance(content, list):  # multimodal parts -> text only
            content = "\n".join(p.get("text", "") for p in content if isinstance(p, dict))
        role = m.get("role", "user")
        parts.append(content if role == "user" else f"[{role.upper()}]\n{content}")
    return "\n\n".join(parts)


class GwebModel(LitellmTextbasedModel):
    """config: model_name = a Gemini web model id, e.g. gemini-4-hydrogen, gemini-carbon, gemini-pro."""

    def __init__(self, **kwargs):
        kwargs.setdefault("cost_tracking", "ignore_errors")
        super().__init__(**kwargs)
        self._loop = _Loop()
        self._client = None
        self._chat = None
        self._sent = 0  # how many messages of the agent history the web chat has already seen
        self._timeout = float(os.environ.get("GWEB_TIMEOUT", 300))

    async def _connect(self):
        from gemini_webapi import GeminiClient, set_log_level
        set_log_level("WARNING")
        jar = json.loads((GWEB_DIR / "cookies.json").read_text(encoding="utf-8-sig"))
        c = GeminiClient(jar["__Secure-1PSID"], jar.get("__Secure-1PSIDTS", ""),
                         proxy=os.environ.get("GWEB_PROXY") or None)
        c.cookies = jar
        await c.init(timeout=600, auto_close=False, auto_refresh=True)
        return c

    async def _ask(self, prompt: str) -> str:
        if self._client is None:
            self._client = await self._connect()
        if self._chat is None:
            self._chat = self._client.start_chat(model=self.config.model_name)
        resp = await self._client.generate_content(prompt, model=self.config.model_name, chat=self._chat,
                                                   temporary=True)
        return resp.text or ""

    def _query(self, messages: list[dict], **kwargs):
        # The agent sends its whole history every time; the web chat already holds the part sent before.
        if self._chat is None or len(messages) < self._sent:
            self._chat, self._sent = None, 0
        new = messages[self._sent:]
        if self._sent:  # the model's own last reply is already in the web chat
            new = [m for m in new if m.get("role") != "assistant"]
        t = time.time()
        text = self._loop.run(self._ask(_flatten(new)), timeout=self._timeout)
        self._sent = len(messages) + 1  # + the reply we are about to return
        msg = SimpleNamespace(content=text, role="assistant",
                              model_dump=lambda **_: {"role": "assistant", "content": text})
        choice = SimpleNamespace(message=msg, finish_reason="stop")
        return SimpleNamespace(choices=[choice], seconds=round(time.time() - t, 1),
                               model_dump=lambda **_: {"content": text, "model": self.config.model_name})

    def _calculate_cost(self, response) -> dict[str, float]:
        return {"cost": 0.0}
