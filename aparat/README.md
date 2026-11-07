# aparat

> **Quick setup:** give your AI agent this line: *Download https://github.com/Sajjad-Majdi/my-tools/releases/download/aparat/aparat.zip, unzip it, and set it up for me by following its README.md.*

Uploads a video to your own Aparat channel (aparat.com) from the command line, with no browser UI. It replays the requests of Aparat's web upload page (chunked upload, then the metadata form), and can publish a saved draft. Unofficial and reverse-engineered, so it can break when Aparat changes its site.

## Requirements
- Python 3.9+ and the `requests` package (`pip install requests`).
- `ffprobe` (part of ffmpeg) on PATH: used to read the video duration.
- An Aparat account with a channel, signed in in a normal browser (to copy cookies from).
- Direct network access to aparat.com (the script ignores system proxy settings).

## Setup for an agent
1. `pip install requests` and check `ffprobe -version`.
2. Login, one time, done by YOU (the agent cannot sign in for you):
   1. In Chrome, open https://www.aparat.com and sign in to the account that owns your channel.
   2. Press F12, open the **Application** tab, then **Storage > Cookies > https://www.aparat.com**.
   3. Find `AuthV1` and copy its **Value**.
   4. The agent creates `cookies.json` here as `{"AuthV1": ""}`; open it in a text editor and paste the value between the quotes. Never paste it into the chat.
   If the test below fails with an auth error, add the other aparat.com cookies from the same list the same way (`"name": "value"` pairs).
   - Optional automation: `grab_cookies.py` (run by `aparat.py refresh-cookies`, and automatically when `cookies.json` is missing) copies them through the "Browser Bridge" Chrome extension. It needs `bridge_path` and `bridge_profile` in the config (below). Without them it stops with a message; just write `cookies.json` by hand.
3. Test: `python aparat.py categories` (prints category ids and names; fails with an HTTP error if the cookies are wrong or expired).

## Configuration
Only the optional cookie automation needs settings. Copy `config.example.json` to `config.local.json` (private, git-ignored), or use env vars:

| Key / env var | Meaning |
|---|---|
| `bridge_path` / `BROWSER_BRIDGE_PATH` | folder of the Browser Bridge (`bb.py`) |
| `bridge_profile` / `BROWSER_BRIDGE_PROFILE` | Chrome profile name in the Browser Bridge |

Per upload you pass `--title`, `--descr`, `--tags` (3 to 5 comma-separated tags) and `--category` (default 3; ids from `python aparat.py categories`). `*.log` files here are old run logs and can be deleted.

## Usage
```
python aparat.py categories
python aparat.py upload D:\videos\clip.mp4 --title "My video" --descr "About it" --tags "a,b,c" --category 3 --draft
python aparat.py publish <videohash>
python aparat.py upload clip.mp4 --title "..." --tags "a,b,c"      # publishes right away
python aparat.py refresh-cookies
```
The script prints chunk progress and ends with `UPLOADED ...`. `<videohash>` is the code in the video's `aparat.com/v/<videohash>` link (visible in your channel after a `--draft` upload).

## Notes
- Upload goes in 3 MB chunks with retries. If only the final form fails, the script prints an `IDS --upload-id ... --uid ... --server ...` line; resend just the form with `python aparat.py form --title ... --tags ... --upload-id ... --uid ... --server ... [--duration SECONDS]`.
- Cookies expire; refresh them when requests start failing.
- Use `--draft` first when testing so nothing goes public by accident.
