@echo off
rem Double-click to open the Relations-only window (team tree; roles it opens get their own PowerShell window)
start "" pythonw "%~dp0team_window.py" --relations
