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
import json, os, random, socket, sqlite3, ssl, subprocess, sys, time, urllib.error, urllib.request
from concurrent.futures import ThreadPoolExecutor
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
    'use_v2rayn': True,          # false = only the tunnel (and extra_profiles.json)
    'tunnel_file': 'tunnel.json',  # {"uuid", "path", "host"} of a cf-edge-tunnel Worker; its edge IPs are found automatically
    'edge_prefixes': ['104.16', '104.17', '104.18', '104.19', '104.21', '104.24', '104.26', '172.64', '172.66', '172.67',
                      '188.114.96', '188.114.97', '188.114.98', '188.114.99', '162.159.192', '162.159.193'],
    'edge_pick': 4,              # how many of the fastest working edge IPs to use
    'edge_fragment_only': True,  # filtered networks reset plain TLS to edge IPs; fragmented ClientHello survives
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


def _edge_ok(ip, host):
    """Seconds for an HTTPS GET of the tunnel Worker's front page through one Cloudflare edge IP, or None."""
    t = time.time()
    try:
        raw = socket.create_connection((ip, 443), timeout=5)
        with ssl.create_default_context().wrap_socket(raw, server_hostname=host) as s:
            s.settimeout(5)
            s.sendall(f'GET / HTTP/1.1\r\nHost: {host}\r\nUser-Agent: Mozilla/5.0\r\nConnection: close\r\n\r\n'.encode())
            body = b''
            while len(body) < 4096 and (chunk := s.recv(4096)):
                body += chunk
        return time.time() - t if b'It works' in body else None
    except Exception:
        return None


def tunnel_outbounds():
    """Outbounds for the tunnel Worker through the fastest Cloudflare edge IPs that answer from here right now."""
    f = HERE / CFG['tunnel_file']
    if not f.exists():
        return []
    tun = json.loads(f.read_text(encoding='utf-8'))
    ips = [f'{p}.{random.randint(1, 254)}' if p.count('.') == 2 else f'{p}.{random.randint(0, 255)}.{random.randint(1, 254)}'
           for p in CFG['edge_prefixes'] for _ in range(2)]
    with ThreadPoolExecutor(16) as pool:
        timed = [(t, ip) for ip, t in zip(ips, pool.map(lambda ip: _edge_ok(ip, tun['host']), ips)) if t]
    best = [ip for _, ip in sorted(timed)[:CFG['edge_pick']]] or [tun['host']]
    log(f'edge scan: {len(timed)}/{len(ips)} IPs answer; using {best}')
    outs = []
    for ip in best:
        for frag in (True,) if CFG['edge_fragment_only'] else (True, False):  # fragment first: the balancer's fallback
            ss = {'network': 'ws', 'security': 'tls',
                  'tlsSettings': {'serverName': tun['host'], 'fingerprint': 'chrome', 'alpn': ['http/1.1']},
                  'wsSettings': {'path': tun['path'] + '?ed=2048', 'headers': {'Host': tun['host']}}}
            if frag:
                ss['sockopt'] = {'dialerProxy': 'frag'}
            outs.append({'protocol': 'vless', 'streamSettings': ss, 'settings': {'vnext': [
                {'address': ip, 'port': 443, 'users': [{'id': tun['uuid'], 'encryption': 'none'}]}]}})
    return outs


def build():
    outs = []
    if CFG['use_v2rayn']:
        db = sqlite3.connect(str(V2 / 'guiConfigs' / 'guiNDB.db'))
        db.row_factory = sqlite3.Row
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
    outs += tunnel_outbounds()
    extra = HERE / CFG['extra_links_file']
    if extra.exists():
        outs += json.loads(extra.read_text(encoding='utf-8'))
    for i, o in enumerate(outs):
        blob = json.dumps(o.get('settings', {})) + json.dumps(o.get('streamSettings', {}))
        cf = any(m in blob for m in CFG['cf_markers'])
        o['tag'] = f"p{'c' if cf else 'n'}{i:02d}"
    rules = [{'type': 'field', 'ip': ['127.0.0.0/8', '10.0.0.0/8', '192.168.0.0/16'], 'outboundTag': 'direct'},
             {'type': 'field', 'network': 'tcp,udp', 'balancerTag': 'best'}]
    balancers = [{'tag': 'best', 'selector': ['p'], 'strategy': {'type': 'leastPing'}, 'fallbackTag': outs[0]['tag']}]
    if any(o['tag'].startswith('pn') for o in outs):  # a non-Cloudflare exit exists for sites that block Cloudflare
        rules.insert(1, {'type': 'field', 'domain': CFG['noncf_domains'], 'balancerTag': 'noncf'})
        balancers.append({'tag': 'noncf', 'selector': ['pn'], 'strategy': {'type': 'leastPing'}, 'fallbackTag': outs[0]['tag']})
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
        'routing': {'domainStrategy': 'AsIs', 'balancers': balancers, 'rules': rules},
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
            log('DEAD: no profile works; re-reading profiles, re-scanning edge IPs and restarting xray')
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
