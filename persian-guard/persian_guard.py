"""Stop hook: if the user wrote in Persian and the reply is not Persian, block the stop and make Claude rewrite it.

Written notes did not stop English replies, so this enforces it.
Also blocks any line that starts with a Latin word or digit, and judges the language by
the user's last OWN message (peer cross-session notes are ignored for the language check).
"""
import json, re, sys

FA = re.compile(r'[؀-ۿ]')
LAT = re.compile(r'[A-Za-z]')


def strip(t):
    t = re.sub(r'<([a-zA-Z_-]+)[^>]*>.*?</\1>', ' ', t, flags=re.S)  # system-reminder etc.
    t = re.sub(r'```.*?```', ' ', t, flags=re.S)
    t = re.sub(r'`[^`]*`', ' ', t)
    t = re.sub(r'\]\([^)]*\)', ']', t)          # markdown link targets
    t = re.sub(r'https?://\S+', ' ', t)
    return t


def texts(content):
    if isinstance(content, str):
        return [content], False
    out, tool = [], False
    for c in content or []:
        if c.get('type') == 'text':
            out.append(c.get('text', ''))
        elif c.get('type') == 'tool_result':
            tool = True
    return out, tool


LEAD = re.compile('^[\\s\\-*•#>\\[\\]()_~|‌‏‎«»"\'.:،!?]+')


def bad_lines(raw):
    """Lines whose first word is Latin or a digit (breaks RTL)."""
    t = re.sub(r'<([a-zA-Z_-]+)[^>]*>.*?</\1>', ' ', raw, flags=re.S)
    t = re.sub(r'```.*?```', ' ', t, flags=re.S)
    t = re.sub(r'`[^`]*`', 'X', t)           # inline code at line start counts as Latin
    t = re.sub(r'\]\([^)]*\)', ']', t)
    out = []
    for ln in t.splitlines():
        s = LEAD.sub('', ln)
        if s and re.match(r'[A-Za-z0-9۰-۹٠-٩]', s):
            out.append(ln.strip()[:40])
    return out


def main():
    data = json.loads(sys.stdin.read() or '{}')
    if data.get('stop_hook_active'):
        return
    rows = []
    with open(data['transcript_path'], encoding='utf-8') as f:
        for line in f:
            try:
                rows.append(json.loads(line))
            except Exception:
                pass
    user, reply = None, []
    for r in rows:
        m = r.get('message') or {}
        if r.get('type') == 'user' and not r.get('isMeta'):
            t, tool = texts(m.get('content'))
            raw = ' '.join(t)
            body = strip(raw).strip()
            if not tool and body and not body.startswith('[SYSTEM NOTIFICATION'):
                reply = []
                if '<cross-session-message' not in raw:   # a peer note is not the user's language
                    user = body
        elif r.get('type') == 'assistant':
            t, _ = texts(m.get('content'))
            if any(x.strip() for x in t):
                reply = t  # last assistant text block wins
    if not user or not reply:
        return
    u = strip(user)
    if len(FA.findall(u)) < 3 or len(FA.findall(u)) < len(LAT.findall(u)):
        return  # the user's last own message was not Persian
    raw = '\n'.join(reply)
    a = strip(raw)
    fa, lat = len(FA.findall(a)), len(LAT.findall(a))
    bad = bad_lines(raw)
    if lat > fa or bad:
        why = "Your last reply is not Persian." if lat > fa else (
            "These lines start with a Latin word or a digit, which breaks right-to-left display: "
            + " | ".join(bad) + ".")
        print(json.dumps({"decision": "block", "reason":
            "The user writes in Persian. " + why + " Rewrite the WHOLE reply in Persian now "
            "(max 4 lines, EVERY line starts with a Persian word; put a Persian word before any name, term or number, "
            "e.g. «سشن Model Trainer ...», «مدل r2 ...»). Do not apologise; just give the corrected answer."},
            ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        pass
