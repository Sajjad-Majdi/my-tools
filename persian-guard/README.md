# persian-guard

> **Quick setup:** give your AI agent this line: *Download https://github.com/Sajjad-Majdi/my-tools/releases/download/persian-guard/persian-guard.zip, unzip it, and set it up for me by following its README.md.*

A Claude Code `Stop` hook (one Python file, no dependencies). When the user's last own message was in Persian, it checks the assistant's final reply and, if the reply is mostly Latin letters or any line starts with a Latin word or a digit (which breaks right-to-left display), it blocks the stop and tells Claude to rewrite the whole reply in Persian. It never changes files and never calls a network.

## Requirements

- Claude Code (CLI or desktop) with hooks, on Windows. Python 3.8+ on the machine (standard library only, `-X utf8` needs 3.7+).
- Nothing else: no accounts, tokens or packages.

## Setup (for an agent)

1. Copy `persian_guard.py` to a fixed folder, e.g. `%USERPROFILE%\tools\persian-guard\`. Find the Python path with `where python` (use the full path if `python` is not on PATH for Claude Code).
2. Smoke test the script alone (it must print nothing and exit 0 for empty input): `echo {} | python -X utf8 persian_guard.py`
3. Register it in the user settings file `%USERPROFILE%\.claude\settings.json` (merge into the existing `hooks`, do not overwrite other hooks):
   ```json
   { "hooks": { "Stop": [ { "hooks": [ {
       "type": "command",
       "command": "python -X utf8 \"C:/Users/<you>/tools/persian-guard/persian_guard.py\"",
       "timeout": 10 } ] } ] } }
   ```
   Use forward slashes in the path and the full path to `python.exe` if needed. `-X utf8` is required: the hook reads UTF-8 JSON on stdin and prints Persian JSON on stdout, and Windows' default code page garbles both. (The owner's file uses `PYTHONIOENCODING=utf-8 <python> "<script>"`, which only works where hook commands run under Git Bash; `-X utf8` works in any shell.)
4. Restart Claude Code (or open `/hooks` to confirm the Stop hook is listed).
5. Test: in a new session write a Persian message that asks for an answer in English. The first reply is blocked once and Claude rewrites it in Persian.

## Configuration

- No tokens, paths or ids inside the script. The only per-user values are the hook command path in `settings.json` and the Python executable; nothing personal is in the script.
- The block message in `main()` tells Claude that the user writes in Persian and demands at most 4 lines, each starting with a Persian word, with a Persian example in guillemets. Edit that text (the string passed as `reason`) for your own rules.
- Thresholds in `main()`: the user's last message counts as Persian when it has at least 3 Persian letters and more Persian than Latin letters; the reply is flagged when Latin letters outnumber Persian ones, or when any line (outside code blocks and inline code) starts with a Latin letter or digit. Persian letters are the Unicode range U+0600 to U+06FF (`FA`); change `FA`, `LAT` and `bad_lines` for another language.
- To use it only in some projects, put the hook in that project's `.claude/settings.json` instead of the user file.

## Usage

There is no command to run; it works on every `Stop` event. Manual test with a saved transcript (a `.jsonl` whose last user line is Persian and last assistant text is English), in Git Bash:
```
echo '{"transcript_path":"C:/path/to/session.jsonl"}' | python -X utf8 persian_guard.py
```
It prints a JSON `{"decision":"block","reason":...}` only when the rule is broken.

## Notes

- It blocks at most once per turn (it returns at once when `stop_hook_active` is set), so it cannot loop.
- Code blocks, inline code, URLs, markdown link targets and tags like `<system-reminder>` are ignored when counting; a reply that is entirely code is not judged.
- Any error inside the script is swallowed (the hook then does nothing), so a broken install is silent: test it with step 2 and step 5.
- The language check reads the transcript file Claude Code passes in `transcript_path`; messages from other sessions (`<cross-session-message`) are not treated as the user's language.
