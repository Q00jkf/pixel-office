# Team window

One window per team, one tab per role (each tab is a real `claude` session), with the pixel office on the left.
Right-click a coworker for Rename, Managers, Close session.

**Windows only** (Win32 clipboard, `taskkill`, PowerShell).

## Run

```powershell
pip install pywebview pywinpty
.\start.bat                 # first run copies team.example.json to team.json
.\start.bat other-team.json # another team
.\start-relations.bat       # Relations only: the team tree and its right-click menu, no tabs
```

**Relations only** (`team_window.py --relations`): just the Relations graph, same right-click menu (Open role, Summon squad, Close session).

**Summon squad** (right-click a person): the squad's roles in order (1 實作, 2 測試, 3 確認); a click opens just that one, hung under the clicked person (`team`) and opened in that person's current folder. A card start location is used only when it needs no choosing. Roles already under that person show ✓. If that person is still staff, their next prompt carries a note to step up to department lead (`squad.md` §2), with no question to the user.
No tabs and no `team.json`: each role it opens gets its own PowerShell window via `scripts/open_role.py`, in the card's start location; a role already open there is not opened twice.

Edit `team.json` (not committed): `title`, `project`, and one entry per role in `agents`
(`name`, `role`, `cwd`, `prompt`, optional `args`). Session ids are filled in on first start.
The pixel office plugin must be installed for the left pane; `scripts/open_role.py` in this repo is used for the child environment.

Test hook: `TW_EVAL=<file.js>` runs the script in the page and prints `window.__test` until it has `done: true`.
