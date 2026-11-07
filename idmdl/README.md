# idmdl

`idm.exe`: a command-line controller for Internet Download Manager (IDM) written in one C# file (`idm.cs`). It starts downloads, adds many links into a dedicated IDM queue, reports progress from IDM's registry and live logs, stops downloads, and leaves no IDM window on the screen after each command.

## Requirements

- Windows 10/11 with IDM installed and licensed by you. The IDM path is read from the registry (`HKCU\Software\DownloadManager\ExePath`), with the default install path as fallback, or set `IDM_EXE`.
- No SDK: the C# compiler of .NET Framework 4 that ships with Windows (`csc.exe`) is enough. `idm.exe` is git-ignored, so it must be built (a built copy may already sit in this folder).
- The code drives IDM's Persian-language interface (window titles and button texts are Persian). With another IDM language only `add`, `status`, `watch`, `stopall`, `remove`, `hide` keep working; `queue`, `start`, `stopq` and `stop` need the texts below changed.

## Setup (for an agent)

1. Build in this folder (PowerShell):
   ```
   $fw = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319"
   & "$fw\csc.exe" -nologo -optimize -out:idm.exe -r:"$fw\WPF\UIAutomationClient.dll" -r:"$fw\WPF\UIAutomationTypes.dll" -r:"$fw\WPF\WindowsBase.dll" -r:System.Windows.Forms.dll idm.cs
   ```
   (Checked: it compiles with one harmless warning.) Keep `idm.exe` where it is, or add its folder to the user PATH.
2. Optional settings: copy `idm.config.example` to `idm.config` next to `idm.exe` (git-ignored) or set environment variables with the same names (see Configuration). Without them the defaults apply.
3. Only if you want the queue commands: in IDM open the Scheduler and create a queue (default name `Agent Queue`; any name via `IDM_QUEUE`). Add one download to it, then read `HKCU\Software\DownloadManager\<download id>\queueID` for that download and set `IDM_QUEUE_ID` if the number is not 3. If `queue` cannot move rows into the queue, also find the WM_COMMAND id of the context menu item "Move to queue > <your queue>" and set `IDM_MOVE_CMD` (default 10038).
4. Smoke test: `.\idm.exe status` prints the last downloads of IDM's list (or nothing) and a time in ms, and must leave no IDM window open. Do not start a real download unless the owner asks.

## Configuration

Each setting is an environment variable or a `NAME=value` line in `idm.config` beside `idm.exe` (environment wins). No source edit and no rebuild is needed.
- `IDM_EXE`: path of `IDMan.exe` (default: registry `ExePath`, else `C:\Program Files (x86)\Internet Download Manager\IDMan.exe`).
- `IDM_QUEUE`: IDM queue name the tool may use (default `Agent Queue`); `IDM_QUEUE_ID`: its `queueID` in the registry (default 3); `IDM_MOVE_CMD`: menu command id of "Move to queue" (default 10038, from IDM 6.4x).
- `IDM_DEBUG=1` prints extra diagnostics.
- Still in `idm.cs`: the other IDM menu/dialog command ids (`CMD_START_QUEUE`, `CMD_STOP_QUEUE`, `CMD_STOP_ALL`, `CMD_REMOVE`, `CMD_SCHEDULER`, `CMD_ADD_FROM_CLIPBOARD`, control ids 1232/1233/1079/1359/1353) and the Persian window texts `ايست` (Stop), `ادامه` (Resume), `زمان بند` (Scheduler title), `حافظه ويندوز` (clipboard-list dialog title). Replace those for another IDM version or language, then rebuild.
- `names.tsv` (created next to `idm.exe` on every `add`) is a runtime log of `url<TAB>file name`; it is git-ignored and may contain URLs, so do not share it.
- No tokens or accounts. Do not put access tokens in URLs you share in logs.

## Usage

```
idm.exe add "https://example.com/big.zip" "D:\Downloads" big.zip     # start now, progress window hidden
idm.exe queue "D:\Downloads" URL1 URL2 URL3 --start                   # all into the agent queue, one file at a time
idm.exe status           (or: status big.zip --all)     idm.exe watch big.zip 10
idm.exe stop big.zip     idm.exe stopall     idm.exe stopq     idm.exe remove big.zip     idm.exe hide
```

## Notes

- `status` reads IDM's registry (`HKCU\Software\DownloadManager`) and per-item logs in `...\IDM\DwnlData`, so it works while IDM is hidden.
- `queue` fills IDM's "add from clipboard list" dialog, so it overwrites the clipboard.
- `stop` on a queued item stops the whole agent queue (it runs one file at a time).
- A command can briefly show IDM transparent and off-screen while it uses IDM's own dialogs; do not click anything in IDM meanwhile.
- A large download is best started with `add`; IDM resumes interrupted files, many other tools restart from zero.
