"""Google Flow (flow.google.com) backend client.

A headless Chrome holds the saved Google login (gflow's Playwright profile) only to own the session;
every operation is a direct call to Flow's own batchexecute RPCs (or its media endpoints) made with
fetch() inside that page. No UI clicks and no Flow agent.
"""
from __future__ import annotations

import json, os, pathlib, re, threading, time, urllib.parse
from typing import Any

import config
import proxy


def _profile() -> str:
    """Chrome profile folder that is signed in to Google Flow: config `profile` / env FLOW_PROFILE, else the default
    profile of gflow-cli (`gflow auth login`), else state/chrome-profile next to this file."""
    p = config.get('profile', 'FLOW_PROFILE')
    if p:
        return str(p)
    base = pathlib.Path(os.environ.get('LOCALAPPDATA', '')) / 'ffroliva' / 'gflow-cli'
    try:
        m = re.search(r'default_profile\s*=\s*"([^"]+)"', (base / 'config.toml').read_text(encoding='utf-8'))
        if m:
            return str(base / f'profile_{m.group(1)}')
    except OSError:
        pass
    return str(config.HERE / 'state' / 'chrome-profile')


PROFILE = _profile()
ROOT = 'https://flow.google.com/'
BE = 'https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute'


class FlowError(RuntimeError):
    pass


def parse_batch(text: str) -> dict[str, Any]:
    """batchexecute body -> {rpcid: decoded payload}; an error frame becomes FlowError text."""
    out: dict[str, Any] = {}
    body = text[text.find('\n') + 1:] if text.startswith(")]}'") else text
    dec = json.JSONDecoder()
    for line in body.splitlines():
        line = line.strip()
        if not line.startswith('['):
            continue
        try:
            rows, _ = dec.raw_decode(line)
        except ValueError:
            continue
        for r in rows if isinstance(rows, list) else []:
            if isinstance(r, list) and len(r) > 2 and r[0] == 'wrb.fr':
                if isinstance(r[2], str):
                    out[r[1]] = json.loads(r[2])
                else:
                    out[r[1]] = FlowError(f'{r[1]} failed: status {r[5] if len(r) > 5 else None}')
    return out


def _proxy_kw() -> dict:
    u = proxy.ensure()
    return {'proxy': {'server': u}} if u else {}


class Flow:
    """One headless browser session. Thread-safe: calls are serialized."""

    def __init__(self, headless: bool = True):
        self.headless = headless
        self._lock = threading.RLock()
        self._pw = self._ctx = self._pg = None
        self._req = 1000 + int(time.time()) % 9000

    # ---- session -------------------------------------------------------------------------
    def open(self) -> 'Flow':
        with self._lock:
            if self._pg:
                return self
            from playwright.sync_api import sync_playwright
            self._pw = sync_playwright().start()
            self._ctx = self._pw.chromium.launch_persistent_context(
                PROFILE, headless=self.headless, viewport={'width': 1280, 'height': 800}, **_proxy_kw(),
                channel='chrome', args=['--password-store=basic'],
                ignore_default_args=['--no-sandbox'], accept_downloads=True)
            self._pg = self._ctx.pages[0] if self._ctx.pages else self._ctx.new_page()
            for i in range(4):
                try:
                    self._pg.goto(ROOT, wait_until='domcontentloaded', timeout=180000)
                    break
                except Exception:
                    if i == 3:
                        raise
                    self._pg.wait_for_timeout(3000)
            for _ in range(60):
                if self._pg.evaluate("() => !!(window.WIZ_global_data && WIZ_global_data.SNlM0e)"):
                    break
                self._pg.wait_for_timeout(1000)
            else:
                raise FlowError(f'Flow app did not load (url {self._pg.url}); login may be gone')
            return self

    def close(self) -> None:
        with self._lock:
            try:
                if self._ctx:
                    self._ctx.close()
                if self._pw:
                    self._pw.stop()
            finally:
                self._pw = self._ctx = self._pg = None

    # ---- raw RPC -------------------------------------------------------------------------
    WRITES = ('jHPbke', 'o8DA4', 'C4BZMd', 'Sc7aEb', 'rqZuUc', 'Uxbujd')  # creates: never retried (a retry could duplicate)

    def rpc(self, rpcid: str, payload: Any, source_path: str = '/', timeout_s: float = 240) -> Any:
        """Call one batchexecute RPC; read-only RPCs are retried when the proxy link drops."""
        for i in range(1 if rpcid in self.WRITES else 3):
            try:
                return self._rpc(rpcid, payload, source_path, timeout_s)
            except FlowError as e:
                if 'HTTP -1' not in str(e) or i == 2 or rpcid in self.WRITES:
                    raise
                time.sleep(3)

    def _rpc(self, rpcid: str, payload: Any, source_path: str, timeout_s: float) -> Any:
        with self._lock:
            self.open()
            self._req += 100000
            res = self._pg.evaluate(
                """async ([be, rpcid, payload, sp, reqid, ms]) => {
                    const w = window.WIZ_global_data;
                    const q = new URLSearchParams({rpcids: rpcid, 'source-path': sp, bl: w.cfb2h, 'f.sid': w.FdrFJe,
                                                   hl: 'en', _reqid: String(reqid), rt: 'c'});
                    const body = new URLSearchParams({'f.req': JSON.stringify([[[rpcid, payload, null, 'generic']]]), at: w.SNlM0e});
                    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
                    try {
                      const r = await fetch(be + '?' + q, {method: 'POST', body, credentials: 'include', signal: ctl.signal,
                        headers: {'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'x-same-domain': '1'}});
                      return {status: r.status, text: await r.text()};
                    } catch (e) { return {status: -1, text: String(e)}; } finally { clearTimeout(t); }
                }""", [BE, rpcid, json.dumps(payload, separators=(',', ':')), source_path, self._req, int(timeout_s * 1000)])
        if res['status'] != 200:
            raise FlowError(f'{rpcid}: HTTP {res["status"]}: {res["text"][:300]}')
        frames = parse_batch(res['text'])
        if rpcid not in frames:
            raise FlowError(f'{rpcid}: no reply frame: {res["text"][:300]}')
        if isinstance(frames[rpcid], FlowError):
            raise frames[rpcid]
        return frames[rpcid]

    # ---- account ----------------------------------------------------------------------
    def credits(self) -> dict:
        r = self.rpc('nzlxg', [])
        return {'balance': r[0], 'raw': r}

    def models(self) -> dict:
        """Live model catalog (HTrJv) + the families enabled for this account (yBhWQ)."""
        cat = self.rpc('HTrJv', [])[0]
        enabled = [k for k, on in (self.rpc('yBhWQ', [])[0] or []) if on]
        video = []
        for fam in cat[4] or []:
            for m in fam[1] or []:
                costs = {t[0]: _at(t, 1, 0, 1) for t in (m[4] or []) if isinstance(_at(t, 1, 0, 1), int)}
                video.append({'family': fam[0], 'key': m[0], 'seconds': _at(m, 16), 'credits': max(costs.values()) if costs else None})
        image = []
        for fam in cat[5] or []:
            for m in fam[1] or []:
                costs = {t[0]: _at(t, 1, 0, 1) for t in (m[4] or []) if isinstance(_at(t, 1, 0, 1), int)}
                image.append({'family': fam[0].replace('\U0001F34C', '').strip(), 'key': m[0], 'id': _at(fam, 3),
                              'credits': max(costs.values()) if costs else None})
        return {'enabled_families': enabled, 'video': video, 'image': image}

    # ---- projects ----------------------------------------------------------------------
    def list_projects(self, limit: int = 20, page_token: str | None = None) -> dict:
        r = self.rpc('UpteDb', ['projects/*', limit, page_token, None, None, None, [1]])
        items = [{'id': p[0], 'title': _at(p, 1, 0), 'created': _ts(_at(p, 1, 2))} for p in (r[0] or [])]
        return {'projects': items, 'next_page_token': _at(r, 1)}

    def create_project(self, title: str) -> dict:
        r = self.rpc('jHPbke', ['projects/*', [None, [title]]])
        return {'id': r[0], 'title': _at(r, 1, 0)}

    def rename_project(self, project_id: str, title: str) -> dict:
        r = self.rpc('o8DA4', [f'projects/{project_id}', [title], [['project_title']]])
        return {'id': project_id, 'title': r[0]}

    # ---- media -------------------------------------------------------------------------
    def list_media(self, project_id: str) -> list[dict]:
        r = self.rpc('Zzl0ze', [f'projects/{project_id}', None, None, None, [1]], source_path=f'/project/{project_id}')
        names = {_at(w, 0): _at(w, 3, 0) for w in (_at(r, 1) or [])}
        return [_media(rec, names) for rec in (_at(r, 2) or []) if isinstance(rec, list)]

    def get_media(self, project_id: str, media_id: str) -> dict:
        m = _media(self.rpc('as29s', [media_id]), {})
        if m['project_id'] != project_id:
            raise FlowError(f'media {media_id} belongs to project {m["project_id"]}, not {project_id}')
        return m

    def download(self, project_id: str, media_id: str, path: str) -> dict:
        m = self.get_media(project_id, media_id)
        url = m.get('video_url') or m.get('image_url')
        if not url:
            raise FlowError(f'{media_id}: no downloadable url yet (status {m.get("status")})')
        out = pathlib.Path(path)
        if out.is_dir() or not out.suffix:
            out.mkdir(parents=True, exist_ok=True)
            out = out / f'{media_id}{".mp4" if m.get("video_url") else ".jpg"}'
        out.parent.mkdir(parents=True, exist_ok=True)
        _fetch(url, out)
        body = out.read_bytes()
        return {'media_id': media_id, 'path': str(out), 'bytes': len(body), 'kind': m['kind']}

    def wait_media(self, project_id: str, media_id: str, timeout_s: float = 900, every_s: float = 10) -> dict:
        """Poll a generation until it is done or failed."""
        t0 = time.time()
        while True:
            m = self.get_media(project_id, media_id)
            if m['status'] not in ('running', 'submitted') or time.time() - t0 > timeout_s:
                return m
            time.sleep(every_s)

    # ---- generation (the page's own direct composer submits; no token handling here) ----------
    SUBMITS = ('ogiZ0b', 'YhhmEf', 'eb1hJf', 'MZZa6b', 'nprQif')

    def _open_project(self, project_id: str):
        pg = self.page()
        for i in range(3):  # the proxy links drop at times: reload instead of failing
            try:
                pg.goto(f'https://flow.google.com/project/{project_id}', wait_until='domcontentloaded', timeout=180000)
                pg.get_by_label('What do you want to create?').wait_for(timeout=150000)
                break
            except Exception:  # noqa: BLE001
                if i == 2:
                    raise FlowError(f'project {project_id} page did not load (proxy or login)')
        pg.wait_for_timeout(2000)
        if '/404' in pg.url:
            raise FlowError(f'project {project_id} opens as 404')
        if pg.get_by_label('Dismiss announcement').count():
            pg.get_by_label('Dismiss announcement').click()
        ag = pg.get_by_role('button', name='Agent', exact=True).first
        if ag.get_attribute('aria-pressed') == 'true':  # direct composer, not Flow's agent
            ag.click(); pg.wait_for_timeout(1200)
        return pg

    @staticmethod
    def _radio(pg, name: str):
        # only VISIBLE radios: the panel keeps hidden toggle groups too (e.g. a hidden "9:16" for the other
        # media type), and clicking a hidden one times out (2026-11-10)
        r = pg.get_by_role('radio', name=name, exact=True).filter(visible=True)
        if not r.count():  # some radios carry an icon word in their text, e.g. "360p info"
            r = pg.locator('[role=radio]:visible').filter(has_text=re.compile(rf'^\s*{re.escape(name)}'))
        if not r.count():
            have = [' '.join(t.split()) for t in pg.locator('[role=radio]').all_inner_texts()]
            pg.keyboard.press('Escape')
            raise FlowError(f'option "{name}" is not offered for this model/mode; panel has {have}')
        if r.first.get_attribute('aria-checked') == 'true':
            return  # already set; clicking could also hit a hover card lying over it
        pg.mouse.move(5, 5); pg.wait_for_timeout(300)  # drop hover cards (e.g. a model's info popover)
        r.first.click(); pg.wait_for_timeout(400)

    @staticmethod
    def _length(pg, seconds: int):
        """Set the Omni 1.2 "Length" slider (3-15 s) with the keyboard and verify the label."""
        sl = pg.get_by_label('Length', exact=True)
        if not sl.count():  # the Extend panel names it "Extend Length" (2026-11-10)
            sl = pg.get_by_label('Extend Length', exact=True)
        if not sl.count():
            pg.keyboard.press('Escape')
            raise FlowError(f'no "{seconds}s" option and no Length slider for this model')
        sl.first.focus(); pg.keyboard.press('Home')
        for _ in range(seconds - 3):
            pg.keyboard.press('ArrowRight')
        pg.wait_for_timeout(500)
        txt = pg.locator('.cdk-overlay-pane').last.inner_text()
        if f'{seconds} Sec' not in txt:
            pg.keyboard.press('Escape')
            raise FlowError(f'could not set length {seconds}s (panel shows: {" ".join(txt.split())[:200]})')

    @staticmethod
    def _pick(pg, tokens: list[str], what: str):
        """Select the picker row whose thumbnail carries one of the media's /asb/ tokens."""
        for _ in range(30):
            rows = pg.locator('[role=option].asset-item')
            for i in range(rows.count()):
                src = rows.nth(i).locator('img').first.get_attribute('src') or '' if rows.nth(i).locator('img').count() else ''
                if any(t and t in src for t in tokens):
                    rows.nth(i).click(); pg.wait_for_timeout(600)
                    return
            pg.evaluate("() => { const v = document.querySelector('[aria-label=\"Asset list\"]'); if (v) v.scrollTop += 250; }")
            pg.wait_for_timeout(700)
        raise FlowError(f'{what} not found in the picker')

    # ---- composer safety (2026-11-10: a multi-line prompt became 8 paid submits, Enter = submit) ----
    PROMPT_BOX = '[aria-label="What do you want to create?"]'

    @staticmethod
    def _flat(text: str) -> str:
        """The composer sends on Enter, so a prompt must be ONE line: collapse every newline/whitespace run."""
        return ' '.join((text or '').split())

    @classmethod
    def _composer(cls, pg) -> dict:
        """What the main composer holds now: character chips, image chips, typed text."""
        return pg.evaluate("""(sel) => {
          const box = document.querySelector(sel);
          if (!box) return {chars: -1, images: -1, text: null};
          let c = box; for (let i = 0; i < 6 && c && !c.classList.contains('prompt-box-content'); i++) c = c.parentElement;
          const alts = [...(c || box).querySelectorAll('img.chip-image')].map(i => i.alt || '');
          return {chars: alts.filter(a => /character/i.test(a)).length,
                  images: alts.filter(a => !/character/i.test(a)).length,
                  text: (box.innerText || '').replace(/\\s+/g, ' ').trim()};
        }""", cls.PROMPT_BOX)

    @classmethod
    def _clear_composer(cls, pg):
        """Remove stale text and ingredient chips left from an earlier run, and prove the box is empty."""
        for _ in range(3):
            st = cls._composer(pg)
            if st['chars'] == 0 and st['images'] == 0 and not st['text']:
                return
            b = pg.locator('[aria-label="Clear prompt"]:visible')
            if b.count():
                b.first.click(); pg.wait_for_timeout(800)
            chips = pg.locator('.prompt-box-content button.chip-container:visible')
            for _ in range(chips.count()):
                chips.first.click(); pg.wait_for_timeout(500)
            st = cls._composer(pg)
            if st['text']:
                pg.locator(cls.PROMPT_BOX).click()
                pg.keyboard.press('Control+A'); pg.keyboard.press('Delete'); pg.wait_for_timeout(400)
        st = cls._composer(pg)
        if st['chars'] or st['images'] or st['text']:
            raise FlowError(f'could not clear the composer before use: {st}')

    @staticmethod
    def _picker_open(pg) -> bool:
        return pg.locator('[role=option].asset-item').count() > 0

    @classmethod
    def _add_character(cls, pg, name: str):
        """Add a Flow character (avatar) as an ingredient. A Character row is added at once and closes the picker."""
        if not cls._picker_open(pg):
            pg.get_by_label('Add ingredients to the prompt box').click(); pg.wait_for_timeout(2500)
        search = pg.get_by_placeholder('Search assets')
        if search.count():
            search.first.fill(name); pg.wait_for_timeout(2000)
        for _ in range(20):
            rows = pg.locator('[role=option].asset-item')
            for i in range(rows.count()):
                lines = [x.strip() for x in rows.nth(i).inner_text().split('\n') if x.strip()]
                if lines and lines[0] == name and 'Character' in lines:
                    rows.nth(i).click(); pg.wait_for_timeout(1200)
                    if cls._picker_open(pg):  # older behaviour: needs the button
                        btn = pg.get_by_role('button', name='Add to prompt')
                        if btn.count():
                            btn.click(); pg.wait_for_timeout(1200)
                    return
            pg.wait_for_timeout(700)
        pg.keyboard.press('Escape')
        raise FlowError(f'character "{name}" not found in the ingredients picker')

    @classmethod
    def _add_image(cls, pg, tokens: list[str], what: str):
        """Add one project image as an ingredient: pick its row, then "Add to prompt"."""
        if not cls._picker_open(pg):
            pg.get_by_label('Add ingredients to the prompt box').click(); pg.wait_for_timeout(2500)
        search = pg.get_by_placeholder('Search assets')
        if search.count() and search.first.input_value():
            search.first.fill(''); pg.wait_for_timeout(1500)
        cls._pick(pg, tokens, what)
        pg.wait_for_timeout(800)
        # generated images only preview and need "Add to prompt"; some rows (uploads) are added at once and the
        # picker closes. The composer chip check before Start proves the result either way.
        btn = pg.get_by_role('button', name='Add to prompt')
        if cls._picker_open(pg) and btn.count():
            btn.click(); pg.wait_for_timeout(1500)

    def _dry_shot(self, pg, tag: str) -> str:
        d = pathlib.Path(__file__).resolve().parent / 'state'
        d.mkdir(exist_ok=True)
        p = d / f'dryrun_{tag}_{time.strftime("%Y%m%d_%H%M%S")}.png'
        pg.screenshot(path=str(p))
        return str(p)

    def generate(self, project_id: str, prompt: str, kind: str = 'image', model: str | None = None,
                 aspect: str = '16:9', count: int = 1, quality: str | None = None, resolution: str | None = None,
                 seconds: int | None = None, references: list[str] | None = None, start_frame: str | None = None,
                 end_frame: str | None = None, wait: bool = True, timeout_s: float = 900,
                 max_credits: int | None = None, dry_run: bool = False) -> dict:
        """Generate images or videos with Flow's direct composer (agent off). The page builds and sends the
        submit itself, exactly as when a person clicks; we only set the controls and read results back.
        references: project media ids and/or "char:<Character name>" (Flow characters / avatars).
        The prompt is sent as ONE line (Enter would submit). Before submitting, the composer is checked:
        exactly the asked chips and exactly the prompt text, else nothing is sent.
        dry_run: do everything except pressing Start; returns planned credits, settings, the composer check
        and a screenshot path, then clears the composer. Spends nothing."""
        kind = kind.lower()
        if kind not in ('image', 'video'):
            raise FlowError('kind must be image or video')
        prompt = self._flat(prompt)
        if not prompt:
            raise FlowError('empty prompt')
        refs = references or []
        chars = [r[5:].strip() for r in refs if r.startswith('char:')]
        refs = [r for r in refs if not r.startswith('char:')]
        frames = [m for m in (start_frame, end_frame) if m]
        if frames and (refs or chars):
            raise FlowError('start/end frames (Frames mode) cannot be mixed with references or characters')
        bal0 = self.credits()['balance']
        need = refs + frames
        media0 = {m['media_id']: m for m in self.list_media(project_id)} if need else {}
        missing = [m for m in need if m not in media0]
        if missing:
            raise FlowError(f'media not in project {project_id}: {missing}')
        for m in need:  # newer media are matched by id in the picker's thumbnail URL
            media0[m]['thumb_tokens'] = list(media0[m].get('thumb_tokens') or []) + [m]
        if chars:
            have = {c['name'] for c in self.list_characters(project_id)}
            unknown = [c for c in chars if c not in have]
            if unknown:
                raise FlowError(f'characters not in project {project_id}: {unknown}; it has {sorted(have)}')
        submits: list[dict] = []
        with self._lock:
            pg = self._open_project(project_id)

            def on_resp(r):
                if 'batchexecute' not in r.url:
                    return
                rid = next((x for x in self.SUBMITS if f'rpcids={x}' in r.url), None)
                if not rid:
                    return
                try:
                    body = r.request.post_data or ''
                    text = r.text()
                except Exception as e:  # noqa: BLE001
                    submits.append({'rpc': rid, 'error': f'reply unreadable: {e!r}'[:200]}); return
                keys = sorted(set(re.findall(r'\b(?:abra|veo|omni|macaron)[a-z0-9_]*|\b(?:BELUGA|GEM_PIX_2|HARBOR_SEAL|NARWHAL)\b',
                                             urllib.parse.unquote_plus(body))))
                errs = re.findall(r'PUBLIC_ERROR_[A-Z_]+', text)
                ids = []
                for payload in parse_batch(text).values():
                    if not isinstance(payload, FlowError):
                        ids += _record_ids(payload, project_id)
                submits.append({'rpc': rid, 'model_keys': keys, 'errors': errs, 'ok': not errs and '"wrb.fr"' in text,
                                'media_ids': list(dict.fromkeys(ids))})
            pg.on('response', on_resp)
            try:
                pg.get_by_label('Settings trigger').click(); pg.wait_for_timeout(1200)
                self._radio(pg, 'Image' if kind == 'image' else 'Video')
                if kind == 'video':
                    self._radio(pg, 'Frames' if frames else 'Ingredients')
                if model:
                    pg.get_by_label('Select model family').click(); pg.wait_for_timeout(1000)
                    items = pg.get_by_role('menuitem')
                    names = [items.nth(i).inner_text().replace('volume_up', '').replace('\U0001F34C', '').strip()
                             for i in range(items.count())]
                    hit = [i for i, n in enumerate(names) if n.lower() == model.lower()] or \
                          [i for i, n in enumerate(names) if model.lower() in n.lower()]
                    if not hit:
                        pg.keyboard.press('Escape')
                        raise FlowError(f'model "{model}" not offered; menu has {names}')
                    items.nth(hit[0]).click(); pg.wait_for_timeout(800)
                    pg.mouse.move(5, 5); pg.wait_for_timeout(500)  # close the model's hover card
                self._radio(pg, aspect)
                if kind == 'image' and quality:
                    self._radio(pg, quality.capitalize())
                if kind == 'video' and resolution:
                    self._radio(pg, resolution)
                if kind == 'video' and seconds:
                    if pg.get_by_role('radio', name=f'{seconds}s', exact=True).count():
                        self._radio(pg, f'{seconds}s')
                    else:  # Omni 1.2: a "Length" slider, 3-15 s, input value = seconds - 3
                        self._length(pg, seconds)
                self._radio(pg, f'x{count}')
                planned = None
                m_ = re.search(r'will use (\d+) credits', pg.locator('.cdk-overlay-pane').last.inner_text())
                if m_:
                    planned = int(m_.group(1))
                if kind == 'video' and max_credits is not None and planned is not None and planned > max_credits:
                    pg.keyboard.press('Escape')
                    raise FlowError(f'Flow would charge {planned} credits, above max_credits={max_credits}; nothing was submitted')
                pg.keyboard.press('Escape'); pg.wait_for_timeout(800)
                settings = pg.get_by_label('Settings trigger').inner_text().replace('\n', ' ').replace('\U0001F34C', '').strip()

                if not frames:
                    self._clear_composer(pg)
                else:  # Frames mode: best-effort clear of a stale prompt / frames; the check below still guards
                    b = pg.locator('[aria-label="Clear prompt"]:visible')
                    if b.count():
                        b.first.click(); pg.wait_for_timeout(800)
                for c in chars:  # characters first: each one closes the picker
                    self._add_character(pg, c)
                for m in refs:   # then images, one "Add to prompt" each
                    self._add_image(pg, media0[m]['thumb_tokens'], f'reference {m}')
                for slot, m in (('Start', start_frame), ('End', end_frame)):
                    if m:
                        pg.get_by_text(slot, exact=True).last.click(); pg.wait_for_timeout(2500)
                        self._pick(pg, media0[m]['thumb_tokens'], f'{slot.lower()} frame {m}')
                        if pg.get_by_role('button', name='Add to prompt').count():
                            pg.get_by_role('button', name='Add to prompt').click()
                        pg.wait_for_timeout(1500)

                box = pg.locator(self.PROMPT_BOX)
                box.click(); pg.keyboard.type(prompt, delay=3); pg.wait_for_timeout(800)
                st = self._composer(pg)
                check = {'characters': st['chars'], 'images': st['images'],
                         'expected_characters': len(chars), 'expected_images': len(refs) + len(frames),
                         'text_ok': st['text'] == prompt}
                ok = check['text_ok'] and st['chars'] == len(chars) and st['images'] == len(refs) + len(frames)
                if dry_run or not ok:
                    shot = self._dry_shot(pg, 'generate')
                    b = pg.locator('[aria-label="Clear prompt"]:visible')
                    if frames and b.count():
                        b.first.click(); pg.wait_for_timeout(800)
                    elif not frames:
                        self._clear_composer(pg)
                    if not ok:
                        raise FlowError(f'composer check failed, NOTHING was submitted: {check}; typed {st["text"]!r}; screenshot {shot}')
                    return {'dry_run': True, 'project_id': project_id, 'settings': settings, 'planned_credits': planned,
                            'composer_check': check, 'prompt_sent': prompt, 'screenshot': shot, 'credits_before': bal0}
                pg.get_by_label('Start generation').click()
                t_submit = t0 = time.time()
                while not submits and time.time() - t0 < 600:  # the extend/edit reply can take minutes (2026-11-10)
                    pg.wait_for_timeout(1000)
                pg.wait_for_timeout(8000)  # catch any extra submit (should never happen now)
            finally:
                pg.remove_listener('response', on_resp)
        if not submits:
            raise FlowError('no submit reply seen within 600 s (outcome unknown: check flow_list_media before retrying)')
        sub = submits[0]
        if sub.get('errors'):
            raise FlowError(f'Flow refused the submit: {sub["errors"]} (if UNUSUAL_ACTIVITY: Google flagged the browser; stop)')
        out = {'project_id': project_id, 'settings': settings, 'planned_credits': planned, 'submit': sub, 'credits_before': bal0,
               'composer_check': check}
        if len(submits) > 1:
            out['WARNING'] = f'{len(submits)} submits seen for one call: {submits[1:]}'
        t0 = time.time()
        ids = sub.get('media_ids') or []
        if not ids:  # fall back to the (large) project listing: media created since the submit
            since = time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(t_submit - 60))
            while time.time() - t0 < timeout_s:
                ids = [m['media_id'] for m in self.list_media(project_id)
                       if m['media_id'] not in media0 and (m['created'] or '') >= since]
                if len(ids) >= count:
                    break
                time.sleep(15)
        if wait:
            out['media'] = [self.wait_media(project_id, i, max(60.0, timeout_s - (time.time() - t0))) for i in ids]
        else:
            out['media'] = [self.get_media(project_id, i) for i in ids]
        out['credits_after'] = self.credits()['balance']
        out['credits_spent'] = out['credits_before'] - out['credits_after']
        if planned is not None and out['credits_spent'] > planned:
            out['WARNING'] = (out.get('WARNING', '') + f' spent {out["credits_spent"]} > planned {planned} '
                              '(another session may also be spending; check flow_list_media)').strip()
        for m in out['media']:
            m.pop('thumb_tokens', None)
        return out

    def _open_media(self, project_id: str, media_id: str):
        m = self.get_media(project_id, media_id)
        pg = self.page()
        for i in range(3):
            try:
                pg.goto(f'https://flow.google.com/project/{project_id}/edit/{m["workflow_id"]}', wait_until='domcontentloaded', timeout=180000)
                pg.get_by_label('Download media').wait_for(timeout=150000)
                break
            except Exception:  # noqa: BLE001
                if i == 2:
                    raise FlowError(f'media page for {media_id} did not load')
        pg.wait_for_timeout(2500)
        return pg, m

    def upscale(self, project_id: str, media_id: str, target: str, path: str, timeout_s: float = 1200,
                max_credits: int = 0) -> dict:
        """Upscale a video (or image) through the media page's own Download menu, e.g. "720p" for an Omni 360p clip,
        "1080p"/"4K" for 720p clips, and save it. The menu item can carry a price ("720p Upscaled · 4 credits", seen
        on extended chains, 2026-11-10); it is refused unless max_credits covers it. The page upscales the WHOLE
        chain (workflow) shown on the media page, and only for 3-15 s."""
        bal0 = self.credits()['balance']
        with self._lock:
            pg, m = self._open_media(project_id, media_id)
            pg.get_by_label('Download media').click(); pg.wait_for_timeout(2000)
            items = pg.get_by_role('menuitem')
            names = [' '.join(t.split()) for t in items.all_inner_texts()]
            hit = [i for i, n in enumerate(names) if n.lower().startswith(target.lower())]
            if not hit:
                pg.keyboard.press('Escape')
                raise FlowError(f'"{target}" not offered; menu has {names}')
            if items.nth(hit[0]).get_attribute('disabled') is not None:
                pg.keyboard.press('Escape')
                raise FlowError(f'"{names[hit[0]]}" is disabled here (Flow upscales only 3-15 s; the page shows the whole chain)')
            price = re.search(r'(\d+)\s*credits?', names[hit[0]])
            if price and int(price.group(1)) > max_credits:
                pg.keyboard.press('Escape')
                raise FlowError(f'"{names[hit[0]]}" costs {price.group(1)} credits > max_credits={max_credits}; nothing was spent')
            out = pathlib.Path(path)
            with pg.expect_download(timeout=timeout_s * 1000) as dl:
                items.nth(hit[0]).click()
            if out.is_dir() or not out.suffix:
                out.mkdir(parents=True, exist_ok=True)
                out = out / (dl.value.suggested_filename or f'{media_id}_{target}.mp4')
            out.parent.mkdir(parents=True, exist_ok=True)
            dl.value.save_as(str(out))
        return {'media_id': media_id, 'option': names[hit[0]], 'path': str(out), 'bytes': out.stat().st_size,
                'credits_before': bal0, 'credits_after': self.credits()['balance']}

    def edit_video(self, project_id: str, media_id: str, instruction: str, wait: bool = True, timeout_s: float = 1200,
                   max_credits: int | None = None, dry_run: bool = False) -> dict:
        """Omni video edit ("Describe how to edit this video") on the media page. SPENDS CREDITS
        (flow_models: abra_edit 20, abra_edit_360p 10). Returns the new media.
        The instruction is sent as ONE line and checked in the box before the single Enter. dry_run: stop before Enter."""
        instruction = self._flat(instruction)
        if not instruction:
            raise FlowError('empty instruction')
        bal0 = self.credits()['balance']
        submits: list[dict] = []
        with self._lock:
            pg, m = self._open_media(project_id, media_id)

            def on_resp(r):
                if 'batchexecute' not in r.url or any(f'rpcids={x}' in r.url for x in ('Zzl0ze', 'as29s', 'nzlxg', 'WuwhI')):
                    return
                try:
                    body = urllib.parse.unquote_plus(r.request.post_data or '')
                    text = r.text()
                except Exception:  # noqa: BLE001
                    return
                if not re.search(r'abra|macaron|edit', body, re.I):
                    return
                ids = []
                for payload in parse_batch(text).values():
                    if not isinstance(payload, FlowError):
                        ids += _record_ids(payload, project_id)
                submits.append({'rpc': re.search(r'rpcids=([^&]+)', r.url).group(1),
                                'model_keys': sorted(set(re.findall(r'\b(?:abra|macaron|veo|omni)[a-z0-9_]*', body))),
                                'errors': re.findall(r'PUBLIC_ERROR_[A-Z_]+', text),
                                'media_ids': [i for i in dict.fromkeys(ids) if i != media_id]})
            pg.on('response', on_resp)
            try:
                if max_credits is not None and pg.locator('[aria-label="Settings trigger"]:visible').count():
                    pg.locator('[aria-label="Settings trigger"]:visible').first.click(); pg.wait_for_timeout(1200)
                    m_ = re.search(r'will use (\d+) credits', pg.locator('.cdk-overlay-pane').last.inner_text())
                    pg.keyboard.press('Escape'); pg.wait_for_timeout(600)
                    if m_ and int(m_.group(1)) > max_credits:
                        raise FlowError(f'Flow would charge {m_.group(1)} credits, above max_credits={max_credits}; nothing was submitted')
                ed = pg.locator('.prosemirror-editor:visible').last
                ed.click()
                pg.keyboard.press('Control+A'); pg.keyboard.press('Delete')
                pg.keyboard.type(instruction, delay=3); pg.wait_for_timeout(800)
                typed = ' '.join((ed.inner_text() or '').split())
                if dry_run or typed != instruction:
                    shot = self._dry_shot(pg, 'edit')
                    pg.keyboard.press('Control+A'); pg.keyboard.press('Delete'); pg.keyboard.press('Escape')
                    if typed != instruction:
                        raise FlowError(f'edit text check failed, NOTHING was submitted; typed {typed!r}; screenshot {shot}')
                    return {'dry_run': True, 'instruction_sent': instruction, 'text_ok': True, 'screenshot': shot,
                            'credits_before': bal0}
                pg.keyboard.press('Enter')  # the single submit; the instruction itself has no newline
                t0 = time.time()
                while not submits and time.time() - t0 < 600:  # the extend/edit reply can take minutes (2026-11-10)
                    pg.wait_for_timeout(1000)
                pg.wait_for_timeout(8000)  # catch any extra submit
            finally:
                pg.remove_listener('response', on_resp)
        if not submits:
            raise FlowError('no edit submit seen within 600 s (outcome unknown: check flow_list_media before retrying)')
        sub = submits[0]
        if sub['errors']:
            raise FlowError(f'Flow refused the edit: {sub["errors"]}')
        res = [self.wait_media(project_id, i, timeout_s) if wait else self.get_media(project_id, i) for i in sub['media_ids']]
        for r in res:
            r.pop('thumb_tokens', None)
        return {'submit': sub, 'media': res, 'credits_before': bal0, 'credits_after': self.credits()['balance']}

    def extend_video(self, project_id: str, media_id: str, prompt: str, seconds: int = 4, wait: bool = True,
                     timeout_s: float = 1200, max_credits: int | None = None, dry_run: bool = False) -> dict:
        """Extend a video ("Add clip" -> "Extend" -> "What happens next?") on the media page. SPENDS CREDITS
        (the page shows "Generating will use N credits"; max_credits refuses before submitting). Returns the new media.
        The prompt is sent as ONE line and checked in the box before the single Enter. dry_run: stop before Enter."""
        prompt = self._flat(prompt)
        if not prompt:
            raise FlowError('empty prompt')
        bal0 = self.credits()['balance']
        submits: list[dict] = []
        with self._lock:
            pg, m = self._open_media(project_id, media_id)

            def on_resp(r):
                if 'batchexecute' not in r.url or any(f'rpcids={x}' in r.url for x in ('Zzl0ze', 'as29s', 'nzlxg', 'WuwhI', 'HTrJv')):
                    return
                try:
                    body = urllib.parse.unquote_plus(r.request.post_data or '')
                    text = r.text()
                except Exception:  # noqa: BLE001
                    return
                if not re.search(r'abra|macaron|veo|extend', body, re.I):
                    return
                ids = []
                for payload in parse_batch(text).values():
                    if not isinstance(payload, FlowError):
                        ids += _record_ids(payload, project_id)
                submits.append({'rpc': re.search(r'rpcids=([^&]+)', r.url).group(1),
                                'model_keys': sorted(set(re.findall(r'\b(?:abra|macaron|veo|omni)[a-z0-9_]*', body))),
                                'errors': re.findall(r'PUBLIC_ERROR_[A-Z_]+', text),
                                'media_ids': [i for i in dict.fromkeys(ids) if i != media_id]})
            pg.on('response', on_resp)
            try:
                pg.locator('[aria-label="Add clip"]:visible').first.click(); pg.wait_for_timeout(1200)
                pg.get_by_role('menuitem', name=re.compile('Extend')).click(); pg.wait_for_timeout(2000)
                pg.locator('[aria-label="Settings trigger"]:visible').first.click(); pg.wait_for_timeout(1200)
                self._length(pg, seconds)
                m_ = re.search(r'will use (\d+) credits', pg.locator('.cdk-overlay-pane').last.inner_text())
                planned = int(m_.group(1)) if m_ else None
                if max_credits is not None and planned is not None and planned > max_credits:
                    pg.keyboard.press('Escape')
                    raise FlowError(f'Flow would charge {planned} credits, above max_credits={max_credits}; nothing was submitted')
                pg.keyboard.press('Escape'); pg.wait_for_timeout(800)
                ed = pg.locator('.prosemirror-editor:visible').last
                ed.click()
                pg.keyboard.press('Control+A'); pg.keyboard.press('Delete')
                pg.keyboard.type(prompt, delay=3); pg.wait_for_timeout(800)
                typed = ' '.join((ed.inner_text() or '').split())
                if dry_run or typed != prompt:
                    shot = self._dry_shot(pg, 'extend')
                    pg.keyboard.press('Control+A'); pg.keyboard.press('Delete'); pg.keyboard.press('Escape')
                    if typed != prompt:
                        raise FlowError(f'extend text check failed, NOTHING was submitted; typed {typed!r}; screenshot {shot}')
                    return {'dry_run': True, 'planned_credits': planned, 'prompt_sent': prompt, 'text_ok': True,
                            'screenshot': shot, 'credits_before': bal0}
                pg.keyboard.press('Enter')  # the single submit; the prompt itself has no newline
                t0 = time.time()
                while not submits and time.time() - t0 < 600:  # the extend/edit reply can take minutes (2026-11-10)
                    pg.wait_for_timeout(1000)
                pg.wait_for_timeout(8000)  # catch any extra submit
            finally:
                pg.remove_listener('response', on_resp)
        if not submits:
            raise FlowError('no extend submit seen within 600 s (outcome unknown: check flow_list_media before retrying)')
        sub = submits[0]
        if sub['errors']:
            raise FlowError(f'Flow refused the extend: {sub["errors"]}')
        res = [self.wait_media(project_id, i, timeout_s) if wait else self.get_media(project_id, i) for i in sub['media_ids']]
        for r in res:
            r.pop('thumb_tokens', None)
        out = {'submit': sub, 'planned_credits': planned, 'media': res, 'credits_before': bal0, 'credits_after': self.credits()['balance']}
        out['credits_spent'] = bal0 - out['credits_after']
        warn = []
        if len(submits) > 1:
            warn.append(f'{len(submits)} submits seen for one call')
        if planned is not None and out['credits_spent'] > planned:
            warn.append(f'spent {out["credits_spent"]} > planned {planned}')
        if warn:
            out['WARNING'] = '; '.join(warn)
        return out

    def add_scene_clip(self, project_id: str, scene_id: str, media_id: str, position: int = 0) -> dict:
        """Add a video of the project to a scene's timeline (Flow copies it as a new clip). Free."""
        wf = self.get_media(project_id, media_id)['workflow_id']
        r = self.rpc('oWTRd', [project_id, scene_id, [wf], position], source_path=f'/project/{project_id}/scene/{scene_id}')
        clips = [{'clip_workflow_id': _at(c, 0, 0), 'title': _at(c, 0, 3, 0), 'timing': _at(c, 2)} for c in (_at(r, 0) or [])]
        return {'scene_id': scene_id, 'added': clips}

    def project_assets(self, project_id: str) -> dict:
        """Preset voices, avatars and the counts of characters/scenes that Flow returns with the project."""
        r = self.rpc('Zzl0ze', [f'projects/{project_id}', None, None, None, [1]], source_path=f'/project/{project_id}')
        voices = [{'id': v[0], 'name': v[2], 'description': _at(v, 3, 10, 0, 1), 'sample': _at(v, 3, 10, 0, 3)}
                  for v in (_at(r, 3) or [])]
        avatars = [{'id': a[0], 'name': a[1], 'created': _ts(_at(a, 2))} for a in (_at(r, 8) or [])]
        return {'voices': voices, 'avatars': avatars,
                'other_slots': {i: (len(r[i]) if isinstance(r[i], list) else None) for i in (4, 5, 6, 7) if i < len(r)}}

    def upload_ingredient(self, project_id: str, file: str, timeout_s: float = 300) -> dict:
        """Upload a reference image through the project page's own upload control (the page sends
        maseQ itself); returns the new media id read from Flow's reply."""
        f = pathlib.Path(file).resolve()
        if not f.is_file():
            raise FlowError(f'no such file {f}')
        with self._lock:
            pg = self.page()
            got: dict = {}

            def on_resp(r):
                if 'rpcids=maseQ' in r.url and not got:
                    try:
                        got.update(parse_batch(r.text()))
                    except Exception as e:  # noqa: BLE001
                        got['err'] = e
            pg.goto(f'https://flow.google.com/project/{project_id}', wait_until='domcontentloaded', timeout=180000)
            pg.get_by_label('Add ingredients to the prompt box').wait_for(timeout=120000)
            pg.wait_for_timeout(1500)
            if pg.get_by_label('Dismiss announcement').count():
                pg.get_by_label('Dismiss announcement').click()
            pg.on('response', on_resp)
            try:
                pg.get_by_label('Add ingredients to the prompt box').click()
                with pg.expect_file_chooser(timeout=30000) as fc:
                    pg.get_by_role('button', name='Upload media').click()
                fc.value.set_files(str(f))
                t0 = time.time()
                while not got and time.time() - t0 < timeout_s:
                    pg.wait_for_timeout(1000)
            finally:
                pg.remove_listener('response', on_resp)
                pg.keyboard.press('Escape')
                pg.goto(ROOT, wait_until='domcontentloaded', timeout=180000)
        if not got:
            raise FlowError(f'upload of {f.name}: no maseQ reply within {timeout_s}s')
        r = got.get('maseQ')
        if not isinstance(r, list):
            raise FlowError(f'upload of {f.name} failed: {r or got.get("err")}')
        rec = r[0]
        return {'media_id': rec[0], 'project_id': rec[1], 'file': f.name, 'dims': _at(rec, 6, 2)}

    # ---- characters, scenes, collections, media metadata (plain RPCs, mapped 2026-11-07; 0 credits) ----
    def _slots(self, project_id: str, view: int = 1) -> Any:
        """Zzl0ze: the project's big listing. view 1: [.., media, .., voices, scenes(4), characters(5), ..];
        view 2: [collections, media]."""
        return self.rpc('Zzl0ze', [f'projects/{project_id}', None, None, None, [view]], source_path=f'/project/{project_id}')

    def list_characters(self, project_id: str) -> list[dict]:
        return [_char(c) for c in (_at(self._slots(project_id), 5) or [])]

    def set_character_image(self, project_id: str, character_id: str, media_id: str, slot: str = 'portrait') -> dict:
        """Make an image that is ALREADY in the project the character's portrait (slot "portrait") or full body
        ("body"). Flow copies the image; reply is the new media. No generation, no credits, no reCAPTCHA."""
        if slot not in ('portrait', 'body'):
            raise FlowError('slot must be portrait or body')
        import uuid
        r = self.rpc('Sc7aEb', [media_id, None, None, project_id, None, None, None,
                                [None, None, [character_id, [0 if slot == 'portrait' else 1]]], None,
                                str(uuid.uuid4()).upper(), str(uuid.uuid4()).upper()], source_path=f'/project/{project_id}/character/{character_id}')
        rec = r[0]
        return {'character_id': character_id, 'slot': slot, 'media_id': rec[0], 'workflow_id': rec[2], 'title': _at(r, 1, 3, 0),
                'dims': _at(rec, 6, 2)}

    def update_character(self, project_id: str, character_id: str, name: str | None = None, personality: str | None = None,
                         voice: str | None = None) -> dict:
        """Set the character's name, personality notes and/or preset voice id (e.g. "achird"; ids from flow_project_assets)."""
        sp = f'/project/{project_id}/character/{character_id}'
        base = [project_id, character_id, None]
        rec = None
        if name is not None:
            rec = self.rpc('rzMKMb', [base + [[1, name]], [['entity_info.display_name']]], source_path=sp)
        if personality is not None:
            rec = self.rpc('rzMKMb', [base + [[1, None, [None, None, personality]]],
                                      [['entity_info.character_info.personality_notes']]], source_path=sp)
        if voice is not None:
            rec = self.rpc('rzMKMb', [base + [[1, None, [None, [[None, voice.lower()]]]]],
                                      [['entity_info.character_info.audio_references']]], source_path=sp)
        if rec is None:
            raise FlowError('give name, personality or voice')
        return _char(rec[0])

    def create_character(self, project_id: str, name: str, image_media_id: str, body_media_id: str | None = None,
                         personality: str | None = None, voice: str | None = None) -> dict:
        """Create a character from images already in the project (upload them first with flow_upload_ingredient).
        image_media_id = portrait, body_media_id = optional full-body image. Free, no generation."""
        sp = f'/project/{project_id}'
        r = self.rpc('C4BZMd', [[project_id, None, None, [1, 'Untitled character', []]]], source_path=sp)
        cid = r[0][1]
        try:
            self.set_character_image(project_id, cid, image_media_id, 'portrait')
            if body_media_id:
                self.set_character_image(project_id, cid, body_media_id, 'body')
            rec = self.update_character(project_id, cid, name, None, None)
            if personality:
                rec = self.update_character(project_id, cid, None, personality, None)
            if voice:
                rec = self.update_character(project_id, cid, None, None, voice)
        except FlowError as e:
            raise FlowError(f'character {cid} was created but a later step failed: {e}') from e
        return rec

    def list_scenes(self, project_id: str) -> list[dict]:
        return [{'id': s[0], 'title': s[1], 'created': _ts(_at(s, 3)), 'updated': _ts(_at(s, 4))}
                for s in (_at(self._slots(project_id), 4) or [])]

    def create_scene(self, project_id: str, title: str | None = None) -> dict:
        """Create an empty scene (timeline). Add clips from videos in the UI; the add-clip call is not mapped yet."""
        r = self.rpc('rqZuUc', [f'projects/{project_id}', None, None, None, 2], source_path=f'/project/{project_id}')
        s = r[0]
        out = {'id': s[0], 'title': s[1]}
        return self.rename_scene(project_id, s[0], title) if title else out

    def rename_scene(self, project_id: str, scene_id: str, title: str) -> dict:
        r = self.rpc('BpMsoe', [project_id, scene_id, [None, title], [['display_name']]], source_path=f'/project/{project_id}/scene/{scene_id}')
        return {'id': r[0][0], 'title': r[0][1]}

    def list_collections(self, project_id: str) -> list[dict]:
        return [{'id': c[0], 'title': _at(c, 2, 0), 'created': _ts(_at(c, 2, 3))} for c in (_at(self._slots(project_id, 2), 0) or [])]

    def create_collection(self, project_id: str, title: str) -> dict:
        import uuid
        cid = str(uuid.uuid4())
        self.rpc('Uxbujd', [f'projects/{project_id}', [cid, None, ['Untitled collection'], project_id]], source_path=f'/project/{project_id}')
        return self.rename_collection(project_id, cid, title)

    def rename_collection(self, project_id: str, collection_id: str, title: str) -> dict:
        r = self.rpc('O2COMe', [[collection_id, None, [title], project_id], [['metadata.display_name']]], source_path=f'/project/{project_id}')
        return {'id': r[0], 'title': _at(r, 2, 0)}

    def _meta(self, project_id: str, media_id: str, value: list, mask: str) -> dict:
        wf = self.get_media(project_id, media_id)['workflow_id']
        r = self.rpc('mYWVGd', [[wf, None, None, value, project_id], [[mask]]], source_path=f'/project/{project_id}')
        return {'media_id': media_id, 'workflow_id': wf, 'title': _at(r, 3, 0), 'favorite': bool(_at(r, 3, 3))}

    def rename_media(self, project_id: str, media_id: str, title: str) -> dict:
        return self._meta(project_id, media_id, [title], 'metadata.display_name')

    def favorite_media(self, project_id: str, media_id: str, favorite: bool = True) -> dict:
        return self._meta(project_id, media_id, [None, None, None, 1 if favorite else 0], 'metadata.favorited')

    def set_project_cover(self, project_id: str, media_id: str) -> dict:
        """Use an image or video of the project as the project's cover."""
        title = _at(self.rpc('ngNC2', [f'tools/PINHOLE/projects/{project_id}']), 1, 0)
        r = self.rpc('o8DA4', [f'projects/{project_id}', [title, media_id, 1], [['thumbnail_media_key', 'is_thumbnail_set_by_user']], [None, 22]])
        return {'project_id': project_id, 'title': r[0], 'cover_media_id': r[1]}

    def page(self):
        self.open()
        return self._pg

    def context(self):
        self.open()
        return self._ctx


# ---- helpers ---------------------------------------------------------------------------------
def _fetch(url: str, out: pathlib.Path, tries: int = 8) -> None:
    """Download a signed Flow URL through the proxy, resuming with Range after a dropped link."""
    import urllib.request
    pu = proxy.ensure()
    op = urllib.request.build_opener(urllib.request.ProxyHandler({'https': pu, 'http': pu} if pu else {}))
    part = out.with_name(out.name + '.part')
    part.unlink(missing_ok=True)
    total = None
    for i in range(tries):
        have = part.stat().st_size if part.exists() else 0
        if total is not None and have >= total:
            break
        req = urllib.request.Request(url, headers={'Range': f'bytes={have}-'} if have else {})
        try:
            with op.open(req, timeout=60) as r, open(part, 'ab' if have and r.status == 206 else 'wb') as f:
                if r.status == 206:
                    total = int(r.headers['Content-Range'].split('/')[-1])
                elif r.status == 200:
                    total = int(r.headers.get('Content-Length') or 0) or None
                while chunk := r.read(65536):
                    f.write(chunk)
            if total is None or part.stat().st_size >= total:
                break
        except Exception:  # noqa: BLE001 - dropped link: resume
            time.sleep(3)
    if not part.exists() or (total and part.stat().st_size < total):
        raise FlowError(f'download failed after {tries} tries ({part.stat().st_size if part.exists() else 0}/{total} bytes)')
    part.replace(out)


def _at(node: Any, *path: int) -> Any:
    for i in path:
        if not isinstance(node, list) or i >= len(node):
            return None
        node = node[i]
    return node


def _char(c: list) -> dict:
    """Character record [proj, id, _, [1, name, [[portrait_wf, body_wf], [[_, voice]], personality]], image_media, dims, created, updated]."""
    return {'id': _at(c, 1), 'name': _at(c, 3, 1), 'portrait_workflow': _at(c, 3, 2, 0, 0, 0), 'body_workflow': _at(c, 3, 2, 0, 1, 0),
            'voice': _at(c, 3, 2, 1, 0, 1), 'personality': _at(c, 3, 2, 2), 'portrait_media_id': _at(c, 4),
            'created': _ts(_at(c, 6)), 'updated': _ts(_at(c, 7))}


def _record_ids(node: Any, project_id: str) -> list[str]:
    """Media ids of every record-shaped list [media_id, project_id, workflow_id, ...] under node."""
    out = []
    if isinstance(node, list):
        if len(node) > 5 and node[1] == project_id and isinstance(node[0], str) and re.fullmatch(r'[0-9a-f-]{36}', node[0])                 and isinstance(node[5], list):
            out.append(node[0])
        for c in node:
            out += _record_ids(c, project_id)
    return out


def _ts(v: Any) -> str | None:
    s = v[0] if isinstance(v, list) and v else v
    return time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(s)) if isinstance(s, (int, float)) else None


def _urls(node: Any) -> list[str]:
    if isinstance(node, str):
        return [node] if node.startswith('https://') else []
    return [u for c in node for u in _urls(c)] if isinstance(node, list) else []


_STATUS = {2: 'running', 3: 'done', 6: 'submitted'}


def _media(rec: list, names: dict) -> dict:
    """Decode one media record [media_id, project_id, workflow_id, _, _, DETAILS, IMAGE_INFO, VIDEO_INFO]."""
    det = _at(rec, 5) or []
    urls = _urls(rec)
    video = next((u for u in urls if '/video/' in u and 'flow-content' in u), None)
    image = next((u for u in urls if '/image/' in u and 'flow-content' in u), None)
    thumb = next((u for u in urls if '/asb/' in u), None)
    st = _at(det, 8, 0)
    model = _at(rec, 7, 0, 12) or _at(det, 6, 1, 0, 0)
    prompt = _at(rec, 7, 0, 7) or _at(det, 1) or _at(det, 6, 2, 0, 0)
    is_video = bool(video or (model or '').startswith(('abra', 'veo', 'omni', 'macaron')))
    status = _STATUS.get(st, st) if st is not None else ('done' if (video or image or (thumb and not is_video)) else None)
    dims = _at(rec, 6, 2) if isinstance(_at(rec, 6, 2), list) else None
    return {'media_id': _at(rec, 0), 'project_id': _at(rec, 1), 'workflow_id': _at(rec, 2),
            'title': names.get(_at(rec, 2)), 'kind': 'video' if is_video else 'image', 'status': status,
            'model': model, 'prompt': (prompt or '')[:300] or None, 'created': _ts(_at(det, 0)),
            'bytes': _at(det, 13), 'dims': dims, 'video_url': video, 'image_url': image if not video else None,
            'thumb_tokens': sorted({u.split('/asb/')[1][:60] for u in urls if '/asb/' in u})}
