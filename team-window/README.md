# Team window

One window per team, one tab per role (each tab is a real `claude` session), with the pixel office on the left.
Right-click a coworker for Rename, Managers, Close session.

**Windows only** (Win32 clipboard, `taskkill`, PowerShell).

## Run

```powershell
pip install pywebview pywinpty
.\start.bat                 # first run copies team.example.json to team.json
.\start.bat other-team.json # another team
```

Edit `team.json` (not committed): `title`, `project`, and one entry per role in `agents`
(`name`, `role`, `cwd`, `prompt`, optional `args`). Session ids are filled in on first start.
The pixel office plugin must be installed for the left pane; `scripts/open_role.py` in this repo is used for the child environment.

Test hook: `TW_EVAL=<file.js>` runs the script in the page and prints `window.__test` until it has `done: true`.
