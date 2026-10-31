"""開一個角色視窗：一個角色一個 PowerShell 視窗跑 claude（skill pixel-office:team 的「開角色」）。

  python open_role.py --role <角色> --dir <工作位置> --kickoff <開場檔> [--team <主管的 ListAgents 名稱>]
                      [--title <職稱>] [--plate <名牌>] [--plugin-dir <外掛資料夾>] [--dry-run]

- 子程序的環境拿掉 DROP_ENV（理由見下）；指令用 -EncodedCommand 傳，不經 -Command 的引號剖析，路徑有空白、單雙引號都照原樣
- 先產生 session id 帶 --session-id，並寫 ~/.claude/pixel-office/presets/<id>.json（title／team／名牌／role=staff）：
  外掛在那個 session 第一次啟動時套用，開場檔不必再寫「開工先登記辦公室」；agent 與 ref 外掛本來就會自己讀 ListAgents 填
- 路徑不存在 → 報錯、不開；--dry-run 只印要跑的指令與預設登記，不開視窗、不寫檔
- 團隊視窗（pty 分頁）import DROP_ENV、child_env()、live_sessions()，兩邊不各寫一份
"""
import argparse
import base64
import glob
import json
import os
import subprocess
import sys
import uuid

# CLAUDE_CODE_CHILD_SESSION：從 Claude session 開出來會繼承，CLI 就不寫 ~/.claude/sessions/<pid>.json →
#   ListAgents 列不出、SendMessage 送不到、transcript 不存檔（2026-10-26 實測）
# ANTHROPIC_API_KEY：繼承下去會停用 claude.ai 連接器、改走 API key 計費（jacky 2026-10-26 裁示用 claude.ai 登入）
DROP_ENV = ('CLAUDE_CODE_CHILD_SESSION', 'ANTHROPIC_API_KEY')


def child_env(env=None):
    return {k: v for k, v in (os.environ if env is None else env).items() if k not in DROP_ENV}


def pid_alive(pid):
    if sys.platform != 'win32':
        try:
            os.kill(pid, 0)
        except PermissionError:
            return True
        except OSError:
            return False
        return True
    import ctypes
    import ctypes.wintypes
    h = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION；Windows 的 os.kill 會結束程序，不能拿來探
    if not h:
        return False
    code = ctypes.wintypes.DWORD()
    ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))
    ctypes.windll.kernel32.CloseHandle(h)
    return code.value == 259  # STILL_ACTIVE


def live_sessions(session_id):
    """正在跑這個 session 的程序：[(pid, 名稱)]。~/.claude/sessions/<pid>.json 強制結束時會留下，所以另外確認 pid 還活著。
    兩筆以上＝同一份對話開在兩個視窗（--resume 接到開著的對話，2026-10-31 團隊視窗實測）"""
    out = []
    for p in glob.glob(os.path.join(os.path.expanduser('~'), '.claude', 'sessions', '*.json')):
        try:
            with open(p, encoding='utf-8') as f:
                j = json.load(f)
        except (OSError, ValueError):
            continue
        if j.get('sessionId') == session_id and isinstance(j.get('pid'), int) and pid_alive(j['pid']):
            out.append((j['pid'], j.get('name') or ''))
    return out


def preset_file(session_id):
    return os.path.join(os.path.expanduser('~'), '.claude', 'pixel-office', 'presets', f'{session_id}.json')


def q(s):
    """PowerShell 單引號字串"""
    return "'" + s.replace("'", "''") + "'"


def ps_script(role, folder, kickoff, session_id, plugin_dir=None):
    plugin = f' --plugin-dir {q(plugin_dir)}' if plugin_dir else ''
    return (f'Set-Location -LiteralPath {q(folder)}; $host.UI.RawUI.WindowTitle = {q(role)}; '
            f'claude --name {q(role)} --session-id {q(session_id)}{plugin} {q(f"請讀 {kickoff} 並照做。")}')


def encoded(script):
    return base64.b64encode(script.encode('utf-16-le')).decode('ascii')


def main(argv=None):
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser(description='Open one role window (PowerShell running claude) with office presets.')
    ap.add_argument('--role', required=True, help='role name: --name, window title, default title')
    ap.add_argument('--dir', required=True, help='working folder (must exist)')
    ap.add_argument('--kickoff', required=True, help='kickoff file the role reads first (must exist)')
    ap.add_argument('--team', help="manager's ListAgents name (office team)")
    ap.add_argument('--title', help='office title, max 16 chars (default: role)')
    ap.add_argument('--plate', help='nameplate, 1-12 letters/digits (default: from --name if ASCII)')
    ap.add_argument('--plugin-dir', help='extra --plugin-dir for claude (must exist)')
    ap.add_argument('--dry-run', action='store_true', help='print the command and preset only; open nothing, write nothing')
    a = ap.parse_args(argv)

    missing = [p for p in (a.dir, a.kickoff, a.plugin_dir) if p and not os.path.exists(p)]
    if missing:
        print('Not found: ' + ', '.join(missing), file=sys.stderr)
        return 1
    title = (a.title or a.role)[:16]
    sid = str(uuid.uuid4())
    preset = {'title': title, 'role': 'staff', **({'team': a.team} if a.team else {}), **({'name': a.plate} if a.plate else {})}
    script = ps_script(a.role, os.path.abspath(a.dir), os.path.abspath(a.kickoff), sid,
                       os.path.abspath(a.plugin_dir) if a.plugin_dir else None)
    if a.dry_run:
        print(f'env drop: {", ".join(DROP_ENV)}')
        print(f'preset {preset_file(sid)}: {json.dumps(preset, ensure_ascii=False)}')
        print(f'powershell -NoExit -EncodedCommand <{script}>')
        return 0
    if sys.platform != 'win32':
        print('Opening a window is Windows-only; use --dry-run to see the command.', file=sys.stderr)
        return 2
    os.makedirs(os.path.dirname(preset_file(sid)), exist_ok=True)
    with open(preset_file(sid), 'w', encoding='utf-8') as f:
        json.dump(preset, f, ensure_ascii=False)
    subprocess.Popen(['powershell', '-NoExit', '-EncodedCommand', encoded(script)], env=child_env(),
                     creationflags=subprocess.CREATE_NEW_CONSOLE)
    print(f'Opened: {a.role} ({a.dir}), session {sid}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
