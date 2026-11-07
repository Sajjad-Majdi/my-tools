# tg-mcp

> **Quick setup:** give your AI agent this line: *Download https://github.com/Sajjad-Majdi/my-tools/releases/download/tg-mcp/tg-mcp.zip, unzip it, and set it up for me by following its README.md.*

Gives AI agents one personal Telegram account (user account, not a bot) through a single local background daemon, a stdio MCP server (`server.mjs`) and a CLI (`tg`). Tools: list chats, read history, search, unread, download media, mark read, send text/files/voice, forward, edit own messages, press bot buttons, folders, archive. There is no delete tool on purpose. Node.js, GramJS.

## Requirements

- Windows 10/11 (launchers are `.cmd`/`.vbs`), Node.js 18+ (24 tested) with npm.
- A Telegram account, plus its `api_id` and `api_hash` from <https://my.telegram.org> (API development tools).
- A Cloudflare account (free) to deploy the included Worker. As written, the client reaches Telegram only through that Worker (`src/tg.mjs` builds `wss://<relayHost>/<relaySecret>/<dc>/apiws`); there is no direct-connection mode.
- Optional: `ffmpeg` and `ffprobe` on PATH (or the winget Links folder) to send videos and voice notes.

## Setup (for an agent)

Run in this folder.
1. `npm install` (the dependency list is in `package.json`; use `--registry <mirror>` if the registry is slow or blocked).
2. Deploy the relay Worker: `cd worker`, `npx wrangler login` (the owner approves in the browser), `npx wrangler deploy`, then `npx wrangler secret put RELAY_SECRET` and enter a long random string (e.g. 32 hex chars). The deploy prints `https://tg-user-relay.<subdomain>.workers.dev`; the host part is your `relayHost`. If my.telegram.org is blocked for you, open `https://<relayHost>/<RELAY_SECRET>/my` in a browser to reach it through the Worker.
3. Copy `config.example.json` to `config.json` (git-ignored) and fill `relayHost` (`tg-user-relay.<subdomain>.workers.dev`), `relaySecret` (the same `RELAY_SECRET`), `apiId` and `apiHash`. The owner types the real values; never print or commit them.
4. Optional offline self-checks (never touch Telegram): `node scripts\core-check.mjs`, `node scripts\owner-check.mjs`.
5. Login, done by the account owner in their own terminal (never in chat): `login.cmd` (= `node login.mjs`). They type phone, code and 2FA password. It writes `session.txt` (full account access, ignored by git).
6. Register the MCP server: Claude Code `claude mcp add --scope user tg -- node "<full path>\server.mjs"`. Codex: add `[mcp_servers.tg]`, `command = "node"`, `args = ["<full path with \\>\\server.mjs"]` to `%USERPROFILE%\.codex\config.toml`. Restart the agent to see the tools.
7. Optional: put this folder on the user PATH so `tg` (`tg.cmd`) works in any shell; put a shortcut (not a copy) to `start-daemon.vbs` in the Startup folder so the daemon starts at login; it finds `daemon.mjs` next to itself and runs it with `node` from PATH. Without that, any `tg` or MCP call starts the daemon hidden on demand (3-8 s).
8. Smoke test (read-only): `tg status` (JSON, loggedIn true), then `tg dialogs --limit 3 --compact`.

## Configuration

- `config.json` (start from `config.example.json`): `relayHost`, `relaySecret`, `apiId`, `apiHash`; optional `ownerPort` (default 47613, env `TG_MCP_PORT`) and `identity` {deviceModel, systemVersion, appVersion, langCode, systemLangCode, langPack}.
- `identity.deviceModel` defaults to the host name; set it to your machine model if you want it to look like Telegram Desktop on that PC. `apiId`/`apiHash` should be your own from my.telegram.org.
- No paths are hard-coded: the login message, `downloads\`, `logs\` and the daemon all resolve from this folder. If `node` is not on PATH, edit `NODE` in `start-daemon.vbs`.
- Optional `cleanup-preselect.txt` (chat ids) only pre-ticks the clean-up page opened by `tg cleanup`.
- Secrets, all git-ignored: `config.json`, `session.txt`, `daemon.key` (local HTTP key, created automatically).

## Usage

```
tg dialogs --limit 10 --compact
tg history me --limit 20            # chat = numeric id, @username, t.me link, "me", or title part
tg search "invoice" --since 2026-10-01
tg send me "hello"                  # also: send-file, forward, edit, press, read, unread, download, archive
tg log --n 40                       # daemon log; also: tg stop | restart | pause | resume
```
Output is JSON. In Windows PowerShell 5.1 add `--ascii` for Persian text.

## Notes

- Never run a second program that logs in with `session.txt`: two clients on one login from different IPs make Telegram revoke it (AUTH_KEY_DUPLICATED); the daemon exists to prevent this.
- Calls are throttled (>= 1.1 s apart, sends 3 s); FLOOD_WAIT is honoured. A send that times out says it MAY have been sent.
- A revoked login makes every call say to log in again until `session.txt` changes.
- Do not send, forward or edit toward other people without the owner's approval of that exact message.
