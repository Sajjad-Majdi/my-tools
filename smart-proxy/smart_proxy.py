"""smart-proxy: one always-working local proxy built from all your v2rayN profiles.

xray runs hidden with every profile as an outbound (plus a TLS-fragment variant of each ws/xhttp/grpc TLS profile),
and a leastPing balancer that keeps traffic on the fastest profile that currently works (xray observatory probes
each one every minute). A supervisor loop checks the proxy end to end; when nothing works it re-reads the v2rayN
profiles, rebuilds and restarts xray, and logs DEAD so a human or agent can add a new config.

  python smart_proxy.py run      # supervisor (start hidden at login with start-hidden.vbs)
  python smart_proxy.py build    # only write state/xray.json
  python smart_proxy.py test     # one end-to-end check through the proxy, prints the result
  python smart_proxy.py status   # which outbound the balancer uses now (from the log)

Proxy: HTTP 127.0.0.1:<http_port> (default 10820), SOCKS5 127.0.0.1:<socks_port> (default 10821).
Settings: config.json next to this file (all optional), see README.md.
"""
import json, os, socket, sqlite3, subprocess, sys, time, urllib.error, urllib.request
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATE = HERE / 'state'; STATE.mkdir(exist_ok=True)
CFG = {
    'v2rayn_dir': r'D:\Softwares\VPN\v2rayN-windows-64',
    'http_port': 10820, 'socks_port': 10821, 'api_port': 10822,
    'probe_url': 'https://www.google.com/generate_204',
    'check_urls': ['https://www.google.com/generate_204', 'https://sketchfab.com/'],
    'check_sec': 120, 'fails_before_rebuild': 3,
    'fragment': {'packets': 'tlshello', 'length': '10-20', 'interval': '10-20'},
    'extra_links_file': 'extra_profiles.json',
    # sites that block Cloudflare exit IPs: route them only through profiles whose exit is not a Cloudflare Worker/edge
    'noncf_domains': ['domain:sketchfab.com', 'domain:sketchfab-prod-media.s3.amazonaws.com'],
    'cf_markers': ['workers.dev', 'edge.', '104.1', '188.114.', '162.159.', '172.6'],   # optional list of xray outbound objects you add by hand
}
try:
    CFG.update(json.loads((HERE / 'config.json').read_text(encoding='utf-8')))
except FileNotFoundError:
    pass
V2 = Path(CFG['v2rayn_dir'])
XRAY = V2 / 'bin' / 'xray' / 'xray.exe'
CONF = STATE / 'xray.json'
LOG = HERE / 'smart_proxy.log'
NOWIN = 0x08000000


def log(msg):
    with open(LOG, 'a', encoding='utf-8') as f:
        f.write(f'{datetime.now():%Y-%m-%d %H:%M:%S} {msg}\n')
    try:
        if LOG.stat().st_size > 1_000_000:
            LOG.write_text(''.join(LOG.read_text(encoding='utf-8').splitlines(True)[-3000:]), encoding='utf-8')
    except OSError:
        pass


def _j(s):
    try:
        return json.loads(s) if s else {}
    except Exception:
        return {}


def outbound(r):
    """Turn one v2rayN ProfileItem row into an xray outbound (None if unsupported)."""
    ctype, net, sec = r['ConfigType'], (r['Network'] or 'raw'), (r['StreamSecurity'] or '')
    te, pe = _j(r['TransportExtra']), _j(r['ProtoExtra'])
    addr, port, secret = r['Address'], int(r['Port']), r['Password'] or r['Id']
    if ctype == 5:      # VLESS
        o = {'protocol': 'vless', 'settings': {'vnext': [{'address': addr, 'port': port, 'users': [
            {'id': secret, 'encryption': pe.get('VlessEncryption') or 'none', 'flow': pe.get('Flow') or ''}]}]}}
    elif ctype == 6:    # Trojan
        o = {'protocol': 'trojan', 'settings': {'servers': [{'address': addr, 'port': port, 'password': secret}]}}
    elif ctype == 1:    # VMess
        o = {'protocol': 'vmess', 'settings': {'vnext': [{'address': addr, 'port': port, 'users': [
            {'id': secret, 'alterId': int(pe.get('AlterId') or 0), 'security': pe.get('VmessSecurity') or 'auto'}]}]}}
    else:
        return None
    net = {'tcp': 'raw'}.get(net, net)
    ss = {'network': net, 'security': sec or 'none'}
    alpn = [a for a in (r['Alpn'] or '').split(',') if a]
    if sec == 'tls':
        ss['tlsSettings'] = {'serverName': r['Sni'] or te.get('Host') or addr, 'fingerprint': r['Fingerprint'] or 'chrome',
                             'allowInsecure': bool(r['AllowInsecure'] == 'true')}
        if alpn:
            ss['tlsSettings']['alpn'] = alpn
    elif sec == 'reality':
        ss['realitySettings'] = {'serverName': r['Sni'] or '', 'publicKey': r['PublicKey'] or '', 'shortId': r['ShortId'] or '',
                                 'fingerprint': r['Fingerprint'] or 'chrome', 'spiderX': r['SpiderX'] or ''}
    if net == 'ws':
        ss['wsSettings'] = {'path': te.get('Path') or '/', 'host': te.get('Host') or r['Sni'] or ''}
    elif net == 'grpc':
        ss['grpcSettings'] = {'serviceName': te.get('GrpcServiceName') or '', 'authority': te.get('GrpcAuthority') or '',
                              'multiMode': te.get('GrpcMode') == 'multi'}
    elif net == 'xhttp':
        ss['xhttpSettings'] = {'host': te.get('Host') or '', 'path': te.get('Path') or '/', 'mode': te.get('XhttpMode') or 'auto'}
        if _j(te.get('XhttpExtra')):
            ss['xhttpSettings']['extra'] = _j(te.get('XhttpExtra'))
    elif net == 'raw' and (te.get('RawHeaderType') or 'none') == 'http':
        ss['rawSettings'] = {'header': {'type': 'http'}}
    o['streamSettings'] = ss
    return o


def build():
    db = sqlite3.connect(str(V2 / 'guiConfigs' / 'guiNDB.db'))
    db.row_factory = sqlite3.Row
    outs = []
    for r in db.execute('select * from ProfileItem'):
        o = outbound(r)
        if not o:
            continue
        outs.append(o)
        ss = o['streamSettings']
        if ss.get('security') == 'tls' and ss['network'] in ('ws', 'xhttp', 'grpc'):
            f = json.loads(json.dumps(o))
            f['streamSettings']['sockopt'] = {'dialerProxy': 'frag'}
            outs.append(f)
    extra = HERE / CFG['extra_links_file']
    if extra.exists():
        outs += json.loads(extra.read_text(encoding='utf-8'))
    for i, o in enumerate(outs):
        blob = json.dumps(o.get('settings', {})) + json.dumps(o.get('streamSettings', {}))
        cf = any(m in blob for m in CFG['cf_markers'])
        o['tag'] = f"p{'c' if cf else 'n'}{i:02d}"
    conf = {
        'log': {'loglevel': 'warning'},
        'inbounds': [
            {'tag': 'http', 'listen': '127.0.0.1', 'port': CFG['http_port'], 'protocol': 'http'},
            {'tag': 'socks', 'listen': '127.0.0.1', 'port': CFG['socks_port'], 'protocol': 'socks',
             'settings': {'udp': True}, 'sniffing': {'enabled': True, 'destOverride': ['http', 'tls']}},
        ],
        'outbounds': outs + [
            {'tag': 'frag', 'protocol': 'freedom', 'settings': {'fragment': CFG['fragment']},
             'streamSettings': {'sockopt': {'tcpNoDelay': True}}},
            {'tag': 'direct', 'protocol': 'freedom'},
        ],
        'observatory': {'subjectSelector': ['p'], 'probeUrl': CFG['probe_url'], 'probeInterval': '60s', 'enableConcurrency': True},
        'routing': {'domainStrategy': 'AsIs', 'balancers': [
            {'tag': 'best', 'selector': ['p'], 'strategy': {'type': 'leastPing'}, 'fallbackTag': outs[0]['tag']},
            {'tag': 'noncf', 'selector': ['pn'], 'strategy': {'type': 'leastPing'}, 'fallbackTag': outs[0]['tag']}],
            'rules': [{'type': 'field', 'ip': ['127.0.0.0/8', '10.0.0.0/8', '192.168.0.0/16'], 'outboundTag': 'direct'},
                      {'type': 'field', 'domain': CFG['noncf_domains'], 'balancerTag': 'noncf'},
                      {'type': 'field', 'network': 'tcp,udp', 'balancerTag': 'best'}]},
    }
    CONF.write_text(json.dumps(conf, indent=1), encoding='utf-8')
    return len(outs)


def _listening(port):
    with socket.socket() as s:
        s.settimeout(0.5)
        return s.connect_ex(('127.0.0.1', port)) == 0


def kill_xray():
    pidf = STATE / 'xray.pid'
    if pidf.exists():
        subprocess.run(['taskkill', '/F', '/PID', pidf.read_text().strip()], capture_output=True, creationflags=NOWIN)
        pidf.unlink(missing_ok=True)
        time.sleep(1)


def start_xray():
    kill_xray()
    n = build()
    p = subprocess.Popen([str(XRAY), 'run', '-c', str(CONF)], cwd=str(STATE), creationflags=NOWIN,
                         stdout=open(STATE / 'xray.out', 'w'), stderr=subprocess.STDOUT,
                         env={**os.environ, 'XRAY_LOCATION_ASSET': str(V2 / 'bin')})
    (STATE / 'xray.pid').write_text(str(p.pid))
    for _ in range(20):
        if _listening(CFG['http_port']):
            break
        time.sleep(0.5)
    log(f'xray started pid={p.pid} outbounds={n}')
    return p


def check():
    op = urllib.request.build_opener(urllib.request.ProxyHandler(
        {'http': f"http://127.0.0.1:{CFG['http_port']}", 'https': f"http://127.0.0.1:{CFG['http_port']}"}))
    ok = 0
    for u in CFG['check_urls']:
        try:
            op.open(urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'}), timeout=20).read(64)
            ok += 1
        except urllib.error.HTTPError:
            ok += 1  # the site answered (e.g. 403 bot check): the tunnel works
        except Exception:
            pass
    return ok == len(CFG['check_urls'])


def run():
    lock = socket.socket()
    try:
        lock.bind(('127.0.0.1', CFG['api_port']))
    except OSError:
        sys.exit(0)  # already running
    proc = start_xray()
    time.sleep(70)  # let the observatory probe every profile once
    fails = 0
    while True:
        if proc.poll() is not None:
            log(f'xray exited ({proc.returncode}); restarting')
            proc = start_xray(); time.sleep(70)
        good = check()
        fails = 0 if good else fails + 1
        if not good:
            log(f'check failed ({fails})')
        if fails >= CFG['fails_before_rebuild']:
            log('DEAD: no profile works; re-reading v2rayN profiles and restarting xray')
            proc = start_xray(); time.sleep(70); fails = 0
        time.sleep(CFG['check_sec'])


if __name__ == '__main__':
    cmd = sys.argv[1] if len(sys.argv) > 1 else 'run'
    if cmd == 'build':
        print('outbounds:', build())
    elif cmd == 'test':
        print('OK' if check() else 'FAIL')
    elif cmd == 'status':
        print(LOG.read_text(encoding='utf-8')[-1500:] if LOG.exists() else 'no log')
    else:
        run()
