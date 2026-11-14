# runflare-api

Quick setup prompt: "Set up runflare-api from github.com/Sajjad-Majdi/my-tools (folder runflare-api) and call the Runflare panel API with it."

A tiny command-line client for the full Runflare panel API (`https://api.runflare.com`), the API the web panel itself uses. The official Runflare CLI only deploys and shows logs; this tool reaches everything else: projects, apps, env vars, volumes, domains, restarts, backups, deploy logs.

It needs only Python 3.9+ (standard library, no packages).

## One-time login
1. The agent installs the official Runflare CLI (binary from `https://get.runflare.com/latest/runflare-windows-amd64.exe`, or the install script for Mac/Linux from docs.runflare.com).
2. The user runs `runflare login` in a terminal and types their own Runflare username and password. The agent never types them.
3. The CLI saves its login in `%APPDATA%\.runflare\token` (Windows) or `~/.runflare/token`. This tool reads that file and refreshes the access token by itself when it expires.

## Use
```
python rf.py GET /project/
python rf.py GET /project/<project_id>/items/short/
python rf.py PATCH /project/<project_id>/items/<item_id>/restart/
python rf.py POST /project/<project_id>/items/<item_id>/envs/ '{"envs": [...]}'
python rf.py endpoints project      # search the known endpoints
```
- `endpoints.txt` lists the endpoints found in the panel's code. Request bodies are not documented: open the panel, do the action once, and read the request in the browser's network tab.
- Output is the JSON reply; the exit code is 1 on an HTTP error.
- Set `RUNFLARE_API` to use another API root.
- Useful reads: `GET /server-package/server-list/` (locations, `is_free`, `is_full`), `GET /log/deploy/<project>/<item>` (deploy logs).

The token file holds a live login: never share it or commit it.
