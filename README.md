# Tools

Small tools for working with AI agents on Windows. Each folder is one tool and has its own `README.md` with a short setup guide.

## Set up one tool (no clone needed)
Every tool has its own zip in [Releases](https://github.com/Sajjad-Majdi/my-tools/releases). Give your AI agent one line:

> Download `https://github.com/Sajjad-Majdi/my-tools/releases/download/<tool>/<tool>.zip`, unzip it, and set it up for me by following its README.md.

Replace `<tool>` with a folder name below (for example `flow-mcp`). Every value you must supply (tokens, cookies, accounts, paths) is listed in that tool's README and goes in a local config file that is never committed. No secrets are stored in this repo.

## Agent control
| Tool | What it does |
|---|---|
| [browser-bridge](browser-bridge/) | Lets any agent drive your real Chrome (tabs, clicks, keys, screenshots) through a small extension and a local relay |
| [fastdesk](fastdesk/) | Runs chains of Windows desktop steps (click, type, read) by element name, with no model between steps |
| [tg-mcp](tg-mcp/) | Your own Telegram account as a CLI (`tg`) and an MCP server, through one safe background daemon |
| [claude-mods](claude-mods/) | Claude Code plugins; `context-meter` shows context use, subagents and background tasks |
| [persian-guard](persian-guard/) | Claude Code Stop hook that keeps replies in Persian when you write Persian |

## Downloads and media
| Tool | What it does |
|---|---|
| [idmdl](idmdl/) | Fast command line for Internet Download Manager (add, queue, status, stop) |
| [flow-mcp](flow-mcp/) | Google Flow (image and video generation) as an MCP server |
| [gemini-web](gemini-web/) | The Gemini web app from the command line, with your own account |
| [aparat](aparat/) | Upload and publish videos to your Aparat channel without a browser |

## Backup
`bash backup.sh` copies the browser-bridge sources in, commits every change and pushes. `bash release.sh [tool]` rebuilds the release zips.
