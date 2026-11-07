// Browser Bridge 2: one persistent WebSocket to the local relay (bb.exe), commands run over CDP.
importScripts('config.js'); // TOKEN, PORT (generated, never commit or print)

let ws = null, instance = null, label = null, retry = null;
const attached = new Set();

async function ident() {
  const s = await chrome.storage.local.get(['instance', 'label']);
  instance = s.instance || crypto.randomUUID();
  if (!s.instance) await chrome.storage.local.set({ instance });
  label = s.label;
  if (!label) {
    try { label = (await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' })).email; } catch {}
    label = label || instance;
  }
}

function connect() {
  if (ws && ws.readyState <= 1) return;
  const q = new URLSearchParams({ token: TOKEN, instance, label });
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?${q}`);
  ws.onmessage = e => run(JSON.parse(e.data));
  ws.onclose = () => { ws = null; schedule(); };
  ws.onerror = () => {};
}

// Retrying every second keeps the worker alive (each extension API call resets its idle timer),
// so a relay that starts later is picked up within a second.
function schedule() {
  clearTimeout(retry);
  retry = setTimeout(async () => { await chrome.runtime.getPlatformInfo(); connect(); }, 1000);
}

// One shared ident() run: start() fires from several events at once, and a second caller used to
// connect before the label was read, so the profile showed up as "undefined".
let identity = null;
async function start() { await (identity ||= ident()); connect(); }
setInterval(() => { if (ws && ws.readyState === 1) ws.send('{"ping":1}'); }, 20000);
chrome.alarms.create('wake', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(start);
chrome.runtime.onStartup.addListener(start);
chrome.runtime.onInstalled.addListener(start);
start();

// ------------------------------------------------------------------ tabs and CDP

async function getTab(t) {
  if (t == null || t === '') {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) throw new Error('no focused tab');
    return tab;
  }
  if (typeof t === 'number' || /^\d+$/.test(t)) return chrome.tabs.get(Number(t));
  const s = String(t).toLowerCase();
  const hits = (await chrome.tabs.query({})).filter(x =>
    (x.url || '').toLowerCase().includes(s) || (x.title || '').toLowerCase().includes(s));
  if (!hits.length) throw new Error(`no tab matches ${t}`);
  return hits.find(x => x.active) || hits[0];
}

async function att(id) {
  if (attached.has(id)) return;
  try { await chrome.debugger.attach({ tabId: id }, '1.3'); }
  catch (e) { if (!/already attached/i.test(e.message)) throw e; }
  attached.add(id);
}
chrome.debugger.onDetach.addListener(s => attached.delete(s.tabId));

async function send(id, method, params = {}) { await att(id); return chrome.debugger.sendCommand({ tabId: id }, method, params); }

async function evalIn(id, expression) {
  const r = await send(id, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}

function waitLoad(id, ms = 30000) {
  return new Promise(res => {
    const f = (tid, info) => { if (tid === id && info.status === 'complete') done(); };
    const t = setTimeout(done, ms);
    function done() { clearTimeout(t); chrome.tabs.onUpdated.removeListener(f); res(); }
    chrome.tabs.onUpdated.addListener(f);
  });
}

// ------------------------------------------------------------------ input

const NAMED = {
  Enter: [13, 'Enter', '\r'], Tab: [9, 'Tab', '\t'], Escape: [27, 'Escape'], Esc: [27, 'Escape'],
  Backspace: [8, 'Backspace'], Delete: [46, 'Delete'], Insert: [45, 'Insert'], Space: [32, 'Space', ' '],
  ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'],
  Up: [38, 'ArrowUp'], Down: [40, 'ArrowDown'], Left: [37, 'ArrowLeft'], Right: [39, 'ArrowRight'],
  Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'],
};
for (let i = 1; i <= 12; i++) NAMED['F' + i] = [111 + i, 'F' + i];
const PUNCT = { '.': [190, 'Period'], ',': [188, 'Comma'], '/': [191, 'Slash'], '-': [189, 'Minus'], '=': [187, 'Equal'],
  ';': [186, 'Semicolon'], "'": [222, 'Quote'], '[': [219, 'BracketLeft'], ']': [221, 'BracketRight'], '\\': [220, 'Backslash'], '`': [192, 'Backquote'] };
const MODS = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Shift: 8 };
const EDIT = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo', y: 'redo' };

async function chord(id, spec) {
  const parts = spec.split('+'), key = parts.pop() || '+';
  let mods = 0; for (const p of parts) mods |= MODS[p] || 0;
  let vk, code, text;
  if (NAMED[key]) [vk, code, text] = NAMED[key];
  else if (/^[a-z]$/i.test(key)) { vk = key.toUpperCase().charCodeAt(0); code = 'Key' + key.toUpperCase(); text = mods & 8 ? key.toUpperCase() : key.toLowerCase(); }
  else if (/^[0-9]$/.test(key)) { vk = key.charCodeAt(0); code = 'Digit' + key; text = key; }
  else if (PUNCT[key]) { [vk, code] = PUNCT[key]; text = key; }
  else throw new Error(`unknown key ${key}`);
  if (mods & 7) text = undefined; // no text with Ctrl/Alt/Meta
  const base = { key: text || NAMED[key]?.[1] || key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: mods };
  const cmd = (mods & 6) && EDIT[key.toLowerCase()];
  await send(id, 'Input.dispatchKeyEvent', { ...base, type: text ? 'keyDown' : 'rawKeyDown', text, ...(cmd ? { commands: [cmd] } : {}) });
  await send(id, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
}

async function clickAt(id, x, y, count = 1) {
  const m = { x, y, button: 'left', clickCount: count };
  await send(id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (let i = 1; i <= count; i++) {
    await send(id, 'Input.dispatchMouseEvent', { ...m, clickCount: i, type: 'mousePressed' });
    await send(id, 'Input.dispatchMouseEvent', { ...m, clickCount: i, type: 'mouseReleased' });
  }
}

const SNAPSHOT = `(() => {
  const sel = 'a,button,input,select,textarea,summary,label,[role],[onclick],[tabindex],[contenteditable]';
  const W = innerWidth, H = innerHeight, out = []; let n = 0;
  document.querySelectorAll('[data-bb-ref]').forEach(e => e.removeAttribute('data-bb-ref'));
  for (const e of document.querySelectorAll(sel)) {
    const r = e.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const st = getComputedStyle(e); if (st.visibility === 'hidden' || st.display === 'none') continue;
    const ref = 'r' + (++n); e.setAttribute('data-bb-ref', ref);
    const role = e.getAttribute('role') || e.tagName.toLowerCase() + (e.type ? ':' + e.type : '');
    const name = (e.getAttribute('aria-label') || e.innerText || e.value || e.placeholder || e.title || e.alt || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    const x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
    out.push([ref, role, name, x, y, x >= 0 && y >= 0 && x < W && y < H]);
  }
  return { url: location.href, title: document.title, elements: out };
})()`;

const refPoint = ref => `(() => { const e = document.querySelector('[data-bb-ref="${ref}"]'); if (!e) return null;
  e.scrollIntoView({ block: 'center', inline: 'center' }); const r = e.getBoundingClientRect();
  return [r.left + r.width / 2, r.top + r.height / 2]; })()`;

// ------------------------------------------------------------------ on-page feedback
// A soft blue glow fades in from the edges while the bridge works a tab and fades out 2.5 s after the
// last command. A large cursor glides to every click point, presses there and leaves a short ripple,
// so the user can follow where the agent clicks. Never intercepts input.

const fxCode = (x, y) => `(() => {
  const d = document, Z = 'pointer-events:none;z-index:2147483647;position:fixed;';
  let g = d.getElementById('__bb_glow');
  if (!g) {
    g = d.createElement('div'); g.id = '__bb_glow';
    g.style.cssText = Z + 'inset:0;opacity:0;transition:opacity .35s ease;box-shadow:inset 0 0 70px 12px rgba(80,145,255,.34),inset 0 0 16px 2px rgba(140,120,255,.42)';
    (d.body || d.documentElement).appendChild(g); void g.offsetWidth;
  }
  g.style.opacity = '1';
  let c = d.getElementById('__bb_cursor');
  clearTimeout(window.__bbT); window.__bbT = setTimeout(() => { g.style.opacity = '0'; if (c) c.style.opacity = '0'; }, 2500);
  ${x == null ? '' : `let moved = 0;
  if (!c) {
    c = d.createElement('div'); c.id = '__bb_cursor';
    c.style.cssText = Z + 'left:0;top:0;width:34px;height:40px;opacity:0;transform:translate(${x}px,${y}px);transition:transform .26s cubic-bezier(.3,.7,.2,1),opacity .3s ease;filter:drop-shadow(0 2px 6px rgba(20,40,120,.45)) drop-shadow(0 0 10px rgba(80,145,255,.7))';
    c.innerHTML = '<svg width="34" height="40" viewBox="0 0 34 40"><path d="M3 2 L3 33 L11 25.5 L16.5 38 L22 35.6 L16.6 23.4 L28 23.4 Z" fill="#3d7bff" stroke="#f4f7ff" stroke-width="2.6" stroke-linejoin="round"/></svg>';
    (d.body || d.documentElement).appendChild(c); void c.offsetWidth;
  } else moved = (window.__bbX - ${x}) ** 2 + (window.__bbY - ${y}) ** 2 > 4;
  window.__bbX = ${x}; window.__bbY = ${y};
  c.style.opacity = '1'; c.style.transform = 'translate(${x - 3}px,${y - 2}px)';
  setTimeout(() => { c.firstChild.style.transform = 'scale(.82)'; c.firstChild.style.transformOrigin = '3px 2px'; c.firstChild.style.transition = 'transform .12s'; setTimeout(() => { c.firstChild.style.transform = ''; }, 130); }, moved ? 260 : 0);
  const r = d.createElement('div');
  r.style.cssText = Z + 'left:${x - 15}px;top:${y - 15}px;width:30px;height:30px;border-radius:50%;border:2px solid rgba(80,145,255,.95);background:rgba(80,145,255,.22);box-shadow:0 0 14px rgba(80,145,255,.85);transform:scale(.35);opacity:1;transition:transform .45s cubic-bezier(.2,.8,.3,1),opacity .7s ease-out';
  (d.body || d.documentElement).appendChild(r); void r.offsetWidth;
  setTimeout(() => { r.style.transform = 'scale(1.7)'; r.style.opacity = '0'; }, moved ? 260 : 0); setTimeout(() => r.remove(), 1100);
  return moved;`}
})()`;

// Returns true when the cursor had to travel, so the click waits until it arrives.
async function fx(id, x, y) { try { return await evalIn(id, fxCode(x, y)); } catch { return false; } }

// ------------------------------------------------------------------ commands

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function exec(c, tabHint) {
  const t = c.tab ?? tabHint;
  const tab = () => getTab(t);
  switch (c.type) {
    case 'tabs': return (await chrome.tabs.query({})).map(x => ({ id: x.id, title: x.title, url: x.url, active: x.active, window: x.windowId }));
    case 'text': {
      const id = (await tab()).id; await fx(id);
      return evalIn(id, `(() => { const e = document.querySelector(${JSON.stringify(c.selector || 'body')});
        let s = e ? e.innerText : ''; const m = ${Number(c.max) || 20000};
        return ${c.tail ? 's.slice(-m)' : 's.slice(0, m)'}; })()`);
    }
    case 'snapshot': { const id = (await tab()).id; await fx(id); return evalIn(id, SNAPSHOT); }
    case 'eval': return { value: await evalIn((await tab()).id, c.expr) };
    case 'click': {
      const id = (await tab()).id;
      let x = c.x, y = c.y;
      if (c.ref) { const p = await evalIn(id, refPoint(c.ref)); if (!p) throw new Error(`ref ${c.ref} is gone; take a new snapshot`); [x, y] = p; }
      if (await fx(id, x, y)) await sleep(260);
      await clickAt(id, x, y, c.count || 1); return { x, y };
    }
    case 'type': { const id = (await tab()).id; await fx(id); await send(id, 'Input.insertText', { text: c.text }); return {}; }
    case 'keys': { const id = (await tab()).id; await fx(id); for (const k of c.chord.trim().split(/\s+/)) await chord(id, k); return {}; }
    case 'scroll': {
      const id = (await tab()).id; await fx(id); const [w, h] = await evalIn(id, '[innerWidth, innerHeight]');
      await send(id, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: c.x ?? w / 2, y: c.y ?? h / 2, deltaX: c.dx || 0, deltaY: c.dy || 0 });
      return {};
    }
    case 'navigate': { const id = (await tab()).id; const w = waitLoad(id); await chrome.tabs.update(id, { url: c.url }); await w; await fx(id); return {}; }
    case 'reload': { const id = (await tab()).id; const w = waitLoad(id); await chrome.tabs.reload(id); await w; return {}; }
    case 'open': { const x = await chrome.tabs.create({ url: c.url, active: !!c.active }); await waitLoad(x.id); return { id: x.id }; }
    case 'activate': { const x = await tab(); await chrome.tabs.update(x.id, { active: true }); await chrome.windows.update(x.windowId, { focused: true }); return {}; }
    case 'close': { await chrome.tabs.remove((await tab()).id); return {}; }
    case 'detach': { const id = (await tab()).id; if (attached.has(id)) await chrome.debugger.detach({ tabId: id }); attached.delete(id); return {}; }
    case 'cdp': return send((await tab()).id, c.method, c.params || {});
    case 'shot': {
      const id = (await tab()).id;
      await evalIn(id, "['__bb_glow', '__bb_cursor'].forEach(i => document.getElementById(i)?.remove())").catch(() => {});
      const r = await send(id, 'Page.captureScreenshot', { format: 'jpeg', quality: c.quality || 70, ...(c.full ? { captureBeyondViewport: true } : {}) });
      return { format: 'jpeg', data: r.data };
    }
    case 'wait': await sleep(c.ms || 500); return {};
    case 'update': setTimeout(() => chrome.runtime.reload(), 100); return { reloading: true }; // picks up edited extension files
    case 'rename': await chrome.storage.local.set({ label: c.name }); label = c.name; setTimeout(() => ws && ws.close(), 50); return { label };
    case 'batch': {
      const out = [];
      for (const s of c.steps) out.push(await exec(s, t));
      return out;
    }
    default: throw new Error(`unknown command ${c.type}`);
  }
}

async function run(msg) {
  if (msg.id == null) return;
  let reply;
  try { reply = { id: msg.id, result: await exec(msg) }; }
  catch (e) { reply = { id: msg.id, error: String(e && e.message || e) }; }
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(reply));
}
