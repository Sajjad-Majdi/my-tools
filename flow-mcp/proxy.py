"""Optional private xray proxy for Flow, for countries where Google answers 403.

Mode (config key `proxy` / env FLOW_PROXY):
  none (default)      no proxy; Chrome and downloads connect directly
  http://host:port    use that existing HTTP proxy as is
  xray                build an xray config from the first working trojan/vless link in the links file and run xray hidden
                      on 127.0.0.1:<proxy_port>. One copy only: if the port already answers, it is reused.
Other keys: xray_path (FLOW_XRAY_PATH, default `xray.exe` on PATH), proxy_links_file (FLOW_PROXY_LINKS, default
proxy_links.txt next to this file; one trojan:// or vless:// link per line), proxy_order (FLOW_PROXY_ORDER, e.g. "0,1,2":
0-based link indexes to try, default all in file order), proxy_port (FLOW_PROXY_PORT, default 10818).
Never touches any other proxy tool's own config."""
import json, os, pathlib, socket, subprocess, time, urllib.parse

import config

HERE = pathlib.Path(__file__).parent
MODE = str(config.get('proxy', 'FLOW_PROXY', 'none')).strip()
XRAY = str(config.get('xray_path', 'FLOW_XRAY_PATH', 'xray.exe'))
LINKS = pathlib.Path(str(config.get('proxy_links_file', 'FLOW_PROXY_LINKS', HERE / 'proxy_links.txt')))
CONF = HERE / 'state' / 'xray.json'
PIDF = HERE / 'state' / 'xray.pid'
PORT = int(config.get('proxy_port', 'FLOW_PROXY_PORT', 10818))
URL = f'http://127.0.0.1:{PORT}'


def _outbound(link: str) -> dict:
    u = urllib.parse.urlsplit(link.strip())
    q = dict(urllib.parse.parse_qsl(u.query))
    sec = q.get('security', 'tls')
    stream = {'network': q.get('type', 'tcp'), 'security': sec}
    if sec == 'tls':
        stream['tlsSettings'] = {'serverName': q.get('sni', u.hostname), 'allowInsecure': False}
    elif sec == 'reality':
        stream['realitySettings'] = {'serverName': q.get('sni', ''), 'publicKey': q.get('pbk', ''), 'shortId': q.get('sid', ''),
                                     'fingerprint': q.get('fp', 'chrome'), 'spiderX': q.get('spx', '')}
    if stream['network'] == 'ws':
        stream['wsSettings'] = {'path': q.get('path', '/'), 'headers': {'Host': q.get('host', q.get('sni', ''))}}
    user = urllib.parse.unquote(u.username or '')
    if u.scheme == 'trojan':
        settings = {'servers': [{'address': u.hostname, 'port': u.port or 443, 'password': user}]}
    elif u.scheme == 'vless':
        settings = {'vnext': [{'address': u.hostname, 'port': u.port or 443,
                               'users': [{'id': user, 'encryption': 'none', 'flow': q.get('flow', '')}]}]}
    else:
        raise ValueError(f'unsupported link scheme {u.scheme}')
    return {'protocol': u.scheme, 'settings': settings, 'streamSettings': stream}


def _listening() -> bool:
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(('127.0.0.1', PORT)) == 0


def _works() -> bool:
    """Flow answers through the proxy within 30 s."""
    r = subprocess.run(['curl', '-s', '-o', 'NUL', '-m', '30', '-x', URL, '-w', '%{http_code}', 'https://flow.google.com/'],
                       capture_output=True, text=True, creationflags=0x08000000)
    return r.stdout.strip() == '200'


def _links() -> list[str]:
    if not LINKS.exists():
        raise RuntimeError(f'proxy links file not found: {LINKS} (set proxy_links_file / FLOW_PROXY_LINKS)')
    return [l.strip() for l in LINKS.read_text(encoding='utf-8-sig').splitlines() if l.strip().startswith(('trojan://', 'vless://'))]


def _order(n: int) -> list[int]:
    v = config.get('proxy_order', 'FLOW_PROXY_ORDER')
    if v is None:
        return list(range(n))
    if isinstance(v, (list, tuple)):
        return [int(x) for x in v]
    return [int(x) for x in str(v).split(',') if x.strip()]


def ensure(index: int | None = None) -> str | None:
    """Return the proxy URL to use, or None for a direct connection. In xray mode: start xray on PORT unless
    something already listens there; without an index, try the links in proxy_order until Flow answers."""
    if MODE.lower() in ('', 'none', 'off', 'direct'):
        return None
    if MODE.lower().startswith(('http://', 'https://')):
        return MODE
    if MODE.lower() != 'xray':
        raise RuntimeError(f"unknown proxy mode {MODE!r}: use none, xray or http://host:port")
    if _listening():
        return URL
    if index is None:
        for i in _order(len(_links())):
            try:
                ensure(i)
                if _works():
                    return URL
            except (RuntimeError, IndexError, ValueError, OSError):
                pass
            stop()
        raise RuntimeError('no proxy link in the links file reaches flow.google.com')
    links = _links()
    cfg = {'log': {'loglevel': 'warning'},
           'inbounds': [{'listen': '127.0.0.1', 'port': PORT, 'protocol': 'http'}],
           'outbounds': [_outbound(links[index]), {'protocol': 'freedom', 'tag': 'direct'}]}
    CONF.parent.mkdir(exist_ok=True)
    CONF.write_text(json.dumps(cfg), encoding='utf-8')
    p = subprocess.Popen([XRAY, 'run', '-c', str(CONF)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         creationflags=0x08000000)  # CREATE_NO_WINDOW
    PIDF.write_text(str(p.pid))
    for _ in range(40):
        if _listening():
            return URL
        time.sleep(0.25)
    raise RuntimeError('private xray did not start')


def stop() -> None:
    """Stop the xray this module started (by saved pid only)."""
    if PIDF.exists():
        subprocess.run(['taskkill', '/PID', PIDF.read_text().strip(), '/F'], capture_output=True, creationflags=0x08000000)
        PIDF.unlink()


if __name__ == '__main__':
    import sys
    if sys.argv[1:] == ['stop']:
        stop(); print('stopped')
    else:
        print(ensure() or 'direct (no proxy)')
