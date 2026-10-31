@echo off
rem Double-click to open the team window; another team: start.bat other-team.json
start "" pythonw "%~dp0team_window.py" %*
