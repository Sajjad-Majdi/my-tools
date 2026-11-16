# smart-proxy

One local proxy that keeps working: it turns every profile in your v2rayN (VLESS / Trojan / VMess; raw, ws, xhttp, grpc; TLS or REALITY) into an xray outbound, adds a TLS-fragment variant of each ws/xhttp/grpc TLS profile, and lets xray's leastPing balancer pick the fastest profile that works right now (each one is probed every minute). No system VPN needed: point only the programs that need it at the proxy.

Quick setup prompt for an agent: "Set up smart-proxy from this folder: check v2rayn_dir, run `python smart_proxy.py build`, start it hidden, add start-hidden.vbs to the Startup folder, then `python smart_proxy.py test` must print OK."

## Setup
1. v2rayN installed with your profiles (it supplies `bin/xray/xray.exe`, geo files and `guiConfigs/guiNDB.db`). v2rayN itself does not need to be connected.
2. Python 3 (standard library only).
3. Optional `config.json`: `v2rayn_dir`, `http_port` (10820), `socks_port` (10821), `api_port` (10822, also the single-copy lock), `probe_url`, `check_urls`, `check_sec` (120), `fails_before_rebuild` (3), `fragment`, `noncf_domains` (sites that block Cloudflare exit IPs; routed only through non-Cloudflare profiles), `cf_markers`.
4. Optional `extra_profiles.json`: a JSON list of extra xray outbound objects (for configs not in v2rayN).
5. Edit the paths in `start-hidden.vbs`, run it, and copy it into `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\`.

## Use
- HTTP proxy `http://127.0.0.1:10820`, SOCKS5 `127.0.0.1:10821`. Examples: `curl -x http://127.0.0.1:10820 URL`, or set `HTTPS_PROXY` for one command.
- `python smart_proxy.py test` -> OK / FAIL. Log: `smart_proxy.log` (start, failed checks, `DEAD` when no profile works; then add or build a new config and it is picked up on the next rebuild).
- `state/xray.json` holds your profile secrets: never share it (git-ignored).
