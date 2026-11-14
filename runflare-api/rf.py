"""Small CLI for the Runflare panel API (api.runflare.com).

It reuses the login of the official Runflare CLI: run `runflare login` once,
then this tool reads the saved token and calls any panel endpoint.

    python rf.py GET /project/
    python rf.py GET /project/123/items/short/
    python rf.py PATCH /project/123/items/456/restart/
    python rf.py POST /project/123/items/456/envs/ '{"envs": [...]}'
    python rf.py endpoints [word]      # list known endpoints (endpoints.txt)

Output is the JSON reply. Exit code 1 on an HTTP error.
"""
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request
from pathlib import Path

API = os.environ.get('RUNFLARE_API', 'https://api.runflare.com')
TOKEN_FILE = Path(os.environ.get('APPDATA', Path.home())) / '.runflare' / 'token'
HERE = Path(__file__).resolve().parent


def load():
    raw = TOKEN_FILE.read_text(encoding='utf-8').strip()
    return json.loads(base64.b64decode(raw + '=' * (-len(raw) % 4)))


def save(data):
    raw = base64.b64encode(json.dumps(data, separators=(',', ':')).encode()).decode()
    TOKEN_FILE.write_text(raw, encoding='utf-8')


def call(method, path, body=None, token=None):
    url = API + (path if path.startswith('/') else '/' + path)
    data = json.dumps(body).encode() if body is not None else None
    headers = {'Accept': 'application/json', 'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, timeout=60) as r:
        text = r.read().decode('utf-8', 'replace')
        return r.status, (json.loads(text) if text.strip() else None)


def refresh(cred):
    status, reply = call('POST', '/account/refresh/', {'refresh': cred['refresh']})
    cred['token'] = reply.get('access') or reply.get('token') or cred['token']
    if reply.get('refresh'):
        cred['refresh'] = reply['refresh']
    save(cred)
    return cred


def main(argv):
    sys.stdout.reconfigure(encoding='utf-8')
    if len(argv) < 2 or argv[1] in ('-h', '--help'):
        print(__doc__)
        return 0
    if argv[1] == 'endpoints':
        word = argv[2] if len(argv) > 2 else ''
        for line in (HERE / 'endpoints.txt').read_text(encoding='utf-8').splitlines():
            if word in line:
                print(line)
        return 0
    if not TOKEN_FILE.exists():
        print('No Runflare login found. Run `runflare login` first.', file=sys.stderr)
        return 1
    method, path = argv[1].upper(), argv[2]
    # Git Bash turns "/project/" into "C:/Program Files/Git/project/": undo that.
    git_root = re.match(r'^[A-Za-z]:/.*?/Git(/.*)$', path)
    if git_root:
        path = git_root.group(1)
    body = json.loads(argv[3]) if len(argv) > 3 else None
    cred = load()
    try:
        try:
            status, reply = call(method, path, body, cred['token'])
        except urllib.error.HTTPError as e:
            if e.code != 401:
                raise
            cred = refresh(cred)
            status, reply = call(method, path, body, cred['token'])
    except urllib.error.HTTPError as e:
        print(json.dumps({'status': e.code, 'error': e.read().decode('utf-8', 'replace')[:2000]}, ensure_ascii=False))
        return 1
    print(json.dumps(reply, ensure_ascii=False, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv))
