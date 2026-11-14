# gemini-agent

Quick setup prompt: "Set up gemini-agent from github.com/Sajjad-Majdi/my-tools (folders gemini-agent and gemini-web) and run a coding task with a Gemini web model."

A coding agent for Gemini models. It runs on the Gemini web app (gemini.google.com) with your own Google account (no API key; usage comes from your Gemini plan), and falls back to the Gemini API with your keys when the web app fails. It is [mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) (a small
bash-only agent harness) with a model class that talks to the Gemini web chat through the `gemini-web` tool's login.
The model writes one shell command per reply in a text block, so no tool-calling API is needed.

## Setup
1. Set up the `gemini-web` tool first (its README) and sign in once. This tool reads its `cookies.json`.
2. In this folder:
   ```
   uv venv .venv --python 3.12
   uv pip install --python .venv/Scripts/python.exe -r requirements.txt
   ```
3. Windows: Git Bash must be installed (`C:\Program Files\Git\bin\bash.exe`, or set `GEMINI_AGENT_BASH`).

## Use
```
.venv/Scripts/python.exe run.py "task text" --cwd <project folder> [--model gemini-4-hydrogen] [--backend auto|web|api] [--steps 30] [--out traj.json]
```
- `--model`: any model id your Gemini web account lists (`gweb.py status` in gemini-web), for example
  `gemini-4-hydrogen`, `gemini-carbon`, `gemini-pro`, `gemini-flash-lite`.
- Commands run in bash, hidden, one at a time, 120 s limit each (`--timeout`). The agent runs without asking before
  each command, so point `--cwd` at a folder it may change.
- Prints `EXIT Submitted` when the agent finished; exit code 0 then, 1 otherwise. `--out` saves the full trajectory.
- Env: `GWEB_DIR` (gemini-web folder, default `../gemini-web`), `GWEB_PROXY` (HTTP proxy, default none),
  `GWEB_TIMEOUT` (seconds per model reply, default 300), `GEMINI_AGENT_MODEL` (default model), `GEMINI_AGENT_BACKEND`.

## API fallback
- `--backend auto` (default): web first; if the web app fails, the run continues on the Gemini API. `web` or `api` forces one.
- Keys: `GEMINI_API_KEYS` (comma list), or `config.local.json` (git-ignored) with `"api_key_envs": ["ENV_NAME", ...]`
  (names of env vars that hold keys). Optional `"gemini_api_base"` (default Google's OpenAI-compatible endpoint) and
  `"api_headers_env": {"header": "ENV_NAME"}` for a relay that needs an extra header. Keys are tried in turn on errors.
- When both fail, the run stops with an error instead of retrying forever.

## Notes
- One web chat per run (sent as a temporary chat): the first message holds the system prompt and task, later ones only
  the command output.
- On build-from-scratch tasks the web model may use its own code tool and claim it is done without writing files;
  always check the result yourself.
- Every reply uses your Gemini plan's quota. Heavy automated use can make Google flag the account or IP; keep runs small.
