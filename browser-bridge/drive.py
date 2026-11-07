import json, os, requests, certifi
BASE = os.path.expanduser('~/.config/google-drive-mcp/')
def token(alias):
    acc = json.load(open(BASE + 'tokens.json'))['accounts'][alias]
    key = json.load(open(BASE + 'gcp-oauth.keys.json'))['installed']
    r = requests.post(key['token_uri'], data=dict(client_id=key['client_id'], client_secret=key['client_secret'],
                      refresh_token=acc['refreshToken'], grant_type='refresh_token'), verify=certifi.where())
    r.raise_for_status(); return r.json()['access_token']
class Drive:
    def __init__(self, alias):
        self.s = requests.Session(); self.s.verify = certifi.where()
        self.s.headers['Authorization'] = 'Bearer ' + token(alias)
    def ls(self, q, fields='files(id,name,mimeType,size,parents,modifiedTime)'):
        out, page = [], None
        while True:
            r = self.s.get('https://www.googleapis.com/drive/v3/files', params=dict(q=q, fields='nextPageToken,'+fields, pageSize=1000, pageToken=page)); r.raise_for_status()
            j = r.json(); out += j['files']; page = j.get('nextPageToken')
            if not page: return out
    def children(self, pid): return self.ls(f"'{pid}' in parents and trashed=false")
    def find(self, name, pid='root', folder=True):
        q = f"name='{name}' and '{pid}' in parents and trashed=false" + (" and mimeType='application/vnd.google-apps.folder'" if folder else '')
        f = self.ls(q); return f[0]['id'] if f else None
    def mkdir(self, name, pid):
        fid = self.find(name, pid)
        if fid: return fid
        r = self.s.post('https://www.googleapis.com/drive/v3/files', json=dict(name=name, parents=[pid], mimeType='application/vnd.google-apps.folder')); r.raise_for_status(); return r.json()['id']
    def upload(self, path, pid, name=None, mime='application/octet-stream'):
        name = name or os.path.basename(path); size = os.path.getsize(path)
        old = self.find(name, pid, folder=False)
        meta = {} if old else dict(name=name, parents=[pid])
        url = f'https://www.googleapis.com/upload/drive/v3/files/{old}?uploadType=resumable' if old else 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable'
        r = (self.s.patch if old else self.s.post)(url, json=meta, headers={'X-Upload-Content-Type': mime, 'X-Upload-Content-Length': str(size)}); r.raise_for_status()
        loc = r.headers['Location']; chunk = 512*1024; pos = 0
        import time
        with open(path, 'rb') as fh:
            while pos < size:
                fh.seek(pos); data = fh.read(chunk); end = pos + len(data) - 1
                for attempt in range(8):
                    try:
                        r = self.s.put(loc, data=data, headers={'Content-Range': f'bytes {pos}-{end}/{size}'}, timeout=120); break
                    except requests.RequestException as e:
                        print('retry', attempt, type(e).__name__, flush=True); time.sleep(5 * (attempt + 1))
                        q = self.s.put(loc, headers={'Content-Range': f'bytes */{size}'}, timeout=60)
                        if q.status_code in (200, 201): r = q; break
                        rng = q.headers.get('Range'); pos = int(rng.split('-')[1]) + 1 if rng else 0
                        fh.seek(pos); data = fh.read(chunk); end = pos + len(data) - 1
                else: raise RuntimeError('upload failed')
                if r.status_code in (200, 201): break
                if r.status_code != 308: r.raise_for_status()
                rng = r.headers.get('Range'); pos = int(rng.split('-')[1]) + 1 if rng else 0
                print(f'{pos/size:.0%}', end=' ', flush=True)
        return r.json()
    def download(self, fid, path):
        r = self.s.get(f'https://www.googleapis.com/drive/v3/files/{fid}', params={'alt': 'media'}); r.raise_for_status(); open(path, 'wb').write(r.content)
