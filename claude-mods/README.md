# claude-mods

> **Quick setup:** give your AI agent this line: *Download https://github.com/Sajjad-Majdi/my-tools/releases/download/claude-mods/claude-mods.zip, unzip it, and set it up for me by following its README.md.*

A small collection of Claude Code "mods" (plugins that change Claude Code's own interface, written against its `claude-code` hooks API). Marketplace name: `sajjad-mods`. It currently holds one mod:

- `context-meter`: a context-window ring (percent of the window used, with the compaction point) in the prompt footer, plus a counter of running subagents and background tasks, each with a hover card (model, effort, status, a Compact button).

## Requirements

- Claude Code (CLI or desktop app) recent enough to have mods and the `claude plugin` command group (`marketplace`, `install`, `validate`, `test`). Tested with build 2.1.317; the mod uses `$.ui`, `$.agent`, `$.session`, `$.clock` and `ui.render` hooks. Run `claude plugin --help` to check.
- No Node build step, no npm install, no accounts, no secrets. The module is TypeScript/TSX loaded directly by Claude Code.

## Setup (for an agent)

1. Pick a stable folder for this repo (do not move it later; the marketplace points to it). Below, `<repo>` is the full path of this `claude-mods` folder.
2. Validate: `claude plugin validate "<repo>\context-meter"` (must report no errors).
3. Register the folder as a marketplace and install: `claude plugin marketplace add "<repo>"` then `claude plugin install context-meter@sajjad-mods` (choose the user scope so it applies to every project).
4. Restart Claude Code, or run `/reload-plugins` in the session. The mod then draws by itself; there is nothing to start.
5. Verify: `claude plugin list` shows `context-meter@sajjad-mods` enabled, and after the first reply the prompt footer shows a ring such as `66%`. Optional: `claude plugin test "<repo>\context-meter"` runs `tests/widget.test.tsx` with seeded state.
6. Try-out without installing: `claude --plugin-dir "<repo>\context-meter"` loads it for that session only. Where no flag can be given (a session the desktop app starts), put the folder in the `CLAUDE_CODE_PLUGIN_DIRS` environment variable (or the `env` block of `~/.claude/settings.json`).
7. If the mod is installed from this folder as a marketplace, edits to the files are re-read by `/reload-plugins`. To publish for others, push the repo to GitHub; they install with `/plugin install context-meter --marketplace <owner>/<repo>`.

## Configuration

- Nothing is required. There are no user options, tokens or hard-coded paths or ids.
- Cosmetic: model families and their colours are in `context-meter/hooks/register.tsx` (`shortModel`, `famColor`, `tone`); the ring colours switch at 60 percent and 85 percent. A new model family needs a line there to get its own name and colour; unknown models show their raw id.
- The marketplace is named `sajjad-mods` (author's name; it is only an id, nothing personal runs from it). Keep that name when installing: an installed plugin is recorded as `context-meter@sajjad-mods`, so renaming the marketplace breaks existing installs. It is set in `.claude-plugin/marketplace.json`, together with the author field `owner.name`; change both only for a separate copy you publish under your own name.

## Usage

```
claude plugin marketplace add "C:\path\to\claude-mods"
claude plugin install context-meter@sajjad-mods
claude plugin disable context-meter@sajjad-mods      # turn off; "enable" turns it on again
claude plugin uninstall context-meter@sajjad-mods
```
In a session: hover the ring or the subagent/background counters for details; the Compact button runs `/compact`.

## Notes

- Mods are a recent, fast-changing Claude Code feature; if the API changes, `claude plugin validate` and the dim "hook skipped" lines in the transcript show what broke (`types/index.d.ts` is only the mod's own state contract).
- The Compact button queues `/compact` until the session is idle.
- Surfaces differ (terminal, desktop, VS Code); the ring and counters are drawn on the ones that offer the prompt-footer band.
