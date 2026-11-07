"""Tiny config loader shared by flowapi.py, proxy.py and server.py.

Order for every key: environment variable, else `config.local.json` next to this file, else the default.
`config.local.json` is private (git-ignored); copy `config.example.json` to create it. Use forward slashes
(or doubled backslashes) in paths inside the JSON file.
"""
import json, os, pathlib

HERE = pathlib.Path(__file__).resolve().parent
_PATH = HERE / 'config.local.json'
try:
    _FILE = json.loads(_PATH.read_text(encoding='utf-8-sig'))
except FileNotFoundError:
    _FILE = {}
except ValueError as e:
    raise RuntimeError(f'{_PATH} is not valid JSON ({e}); use forward slashes in paths') from None


def get(key: str, env: str | None = None, default=None):
    v = os.environ.get(env) if env else None
    if v not in (None, ''):
        return v
    v = _FILE.get(key)
    return default if v in (None, '') else v
