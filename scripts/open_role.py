"""開一個角色視窗：一個角色一個 PowerShell 視窗跑 claude（skill pixel-office:team 的「開角色」）。

  python open_role.py --role <角色> [--dir <工作位置>] [--kickoff <開場檔>] [--team <主管的 ListAgents 名稱>]
                      [--title <職稱>] [--plate <名牌>] [--plugin-dir <外掛資料夾>] [--force] [--dry-run]

- 開之前：已有在線的 session 名稱或職稱＝這個角色 → STOP、exit 3（--force 照開）；對角色卡（roles.py）：名字沒卡但有相近的、
  --dir 跟卡的啟動位置不同、同名多張 → 印 Note 不擋；找到唯一一張卡就把路徑寫進開場句（含 --kickoff）

- 子程序的環境拿掉 DROP_ENV、claude 自己的子行程變數，上層是 Claude Desktop 時再拿掉它塞的（child_env，理由見下）；指令用 -EncodedCommand 傳，不經 -Command 的引號剖析，路徑有空白、單雙引號都照原樣
- 先產生 session id 帶 --session-id，並寫 ~/.claude/pixel-office/presets/<id>.json（title／team／名牌／role=staff）：
  外掛在那個 session 第一次啟動時套用，開場檔不必再寫「開工先登記辦公室」；agent 與 ref 外掛本來就會自己讀 ListAgents 填
- --dir 省略 → 用角色卡的啟動位置（roles.py；卡上沒寫用卡所在專案根目錄）；--kickoff 省略 → 開場句「你是 <角色>，接手」
- 路徑不存在 → 報錯、不開；--dry-run 只印要跑的指令與預設登記，不開視窗、不寫檔
- --agent agy（0.64.5）：視窗跑 agy；預先登記寫 presets/agp-<8 碼>.json，用環境變數 PO_PRESET 交給 agy 外掛（agy/agy_office.py apply_preset），印出的 sid 是那個暫代 id
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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))  # python -I（伺服器這樣叫）不會把本檔所在資料夾放進 sys.path，roles／takeover 要 import

# 一律拿掉：
# CLAUDE_CODE_CHILD_SESSION：從 Claude session 開出來會繼承，CLI 就不寫 ~/.claude/sessions/<pid>.json →
#   ListAgents 列不出、SendMessage 送不到、transcript 不存檔（2026-10-26 實測）
# ANTHROPIC_API_KEY：繼承下去會停用 claude.ai 連接器、改走 API key 計費（jacky 2026-10-26 裁示用 claude.ai 登入）
DROP_ENV = ('CLAUDE_CODE_CHILD_SESSION', 'ANTHROPIC_API_KEY')
# claude 替自己的工具子行程設的（2026-11-14 從 open_role.py 開的視窗的 Bash 裡看到的就是這些）：
#   傳訊權杖、session 編號都是上層的，帶下去新視窗會頂著上層的身分
CLAUDE_OWN = ('CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ID',
              'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN')
# 上層是 Claude Desktop 代管的（有下面兩個之一）：Desktop 另外塞了 HOST_SESSION_ID、ANTHROPIC_BASE_URL、OAUTH_SCOPES…約 25 個（2026-11-14 實測），
#   這時 CLAUDE_CODE_*、CLAUDE_AGENT_SDK_*、CLAUDE_PREVIEW_*、ANTHROPIC_BASE_URL 除了登錄檔（使用者層、系統層）有的都拿掉。
#   Desktop 從開始選單啟動，沒有使用者在 .bat、shell profile 設的變數，所以不在登錄檔的就是 Desktop 塞的。
#   上層是終端機時只拿掉 CLAUDE_OWN：使用者可能在 .bat 設了 CLAUDE_CODE_GIT_BASH_PATH、ANTHROPIC_BASE_URL 等，要照留
DESKTOP_MARKERS = ('CLAUDE_CODE_HOST_SESSION_ID', 'CLAUDE_CODE_DESKTOP_APP_VERSION')
HOST_PREFIXES = ('CLAUDE_CODE_', 'CLAUDE_AGENT_SDK_', 'CLAUDE_PREVIEW_')
HOST_NAMES = ('ANTHROPIC_BASE_URL',)
KEEP_ENV = ('CLAUDE_CONFIG_DIR',)  # 多公司：開出的視窗沿用同一套設定



def cli_sessions_dir():
    """Claude Code 自己的 sessions 資料夾：CLAUDE_CONFIG_DIR 底下，沒設才是 ~/.claude（2026-11-23，跟外掛 0.62.6、takeover.py 同一個修法）"""
    cfg = os.environ.get('CLAUDE_CONFIG_DIR', '').strip()
    return os.path.join(os.path.expanduser(cfg) if cfg else os.path.join(os.path.expanduser('~'), '.claude'), 'sessions')

def persistent_env_names():
    """登錄檔裡使用者層與系統層的環境變數名稱（大寫）；不是 Windows 回 None"""
    if sys.platform != 'win32':
        return None
    import winreg
    out = set()
    for root, path in ((winreg.HKEY_CURRENT_USER, 'Environment'),
                       (winreg.HKEY_LOCAL_MACHINE, r'SYSTEM\CurrentControlSet\Control\Session Manager\Environment')):
        try:
            with winreg.OpenKey(root, path) as k:
                i = 0
                while True:
                    try:
                        out.add(winreg.EnumValue(k, i)[0].upper())
                    except OSError:
                        break
                    i += 1
        except OSError:
            pass
    return out


def dropped(name, persistent, desktop):
    """這個變數要不要從子行程拿掉。persistent＝persistent_env_names()（None：沒有登錄檔可對）；desktop＝上層是 Desktop 代管"""
    u = name.upper()
    if u in DROP_ENV or u in CLAUDE_OWN:
        return True
    if not desktop or u in KEEP_ENV or not (u.startswith(HOST_PREFIXES) or u in HOST_NAMES):
        return False
    return persistent is None or u not in persistent


def child_env(env=None, persistent=...):
    env = os.environ if env is None else env
    desktop = any(env.get(m) for m in DESKTOP_MARKERS)
    persistent = (persistent_env_names() if desktop else None) if persistent is ... else persistent
    return {k: v for k, v in env.items() if not dropped(k, persistent, desktop)}


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
    for p in glob.glob(os.path.join(cli_sessions_dir(), '*.json')):
        try:
            with open(p, encoding='utf-8') as f:
                j = json.load(f)
        except (OSError, ValueError):
            continue
        if j.get('sessionId') == session_id and isinstance(j.get('pid'), int) and pid_alive(j['pid']):
            out.append((j['pid'], j.get('name') or ''))
    return out


def sessions_named(name, cwd, since_ms=0):
    """在線、--name 與資料夾都相同的程序：[(pid, sessionId, startedAt)]。/clear 會讓同一個程序換 session 編號，
    只比編號就抓不到「同一個角色又開了一份」（2026-11-04 實測：team json 記 5b0e6c1e，程序已是 3d5446f6）"""
    want = os.path.normcase(os.path.abspath(cwd))
    out = []
    for p in glob.glob(os.path.join(cli_sessions_dir(), '*.json')):
        try:
            with open(p, encoding='utf-8') as f:
                j = json.load(f)
        except (OSError, ValueError):
            continue
        if (j.get('name') == name and isinstance(j.get('pid'), int) and j.get('sessionId') and os.path.normcase(os.path.abspath(j.get('cwd') or '')) == want
                and (j.get('startedAt') or 0) >= since_ms and pid_alive(j['pid'])):
            out.append((j['pid'], j['sessionId'], j.get('startedAt') or 0))
    return out


def preset_file(session_id):
    return os.path.join(os.path.expanduser('~'), '.claude', 'pixel-office', 'presets', f'{session_id}.json')


SINGLE_QUOTES = "'‘’‚‛"  # PowerShell 把這四個也當單引號（iPhone 智慧標點會把 ' 換成 ’）


def q(s):
    """PowerShell 單引號字串：每種單引號都重複一次才是字面值"""
    return "'" + ''.join(c + c if c in SINGLE_QUOTES else c for c in s) + "'"


def ps_script(role, folder, prompt, session_id, plugin_dir=None, extra=()):
    """extra：額外的 claude 參數（--model、--permission-mode、--add-dir…），每個都照字面加引號"""
    plugin = f' --plugin-dir {q(plugin_dir)}' if plugin_dir else ''
    more = ''.join(f' {q(x)}' for x in extra)
    return (f'Set-Location -LiteralPath {q(folder)}; $host.UI.RawUI.WindowTitle = {q(role)}; '
            f'claude --name {q(role)} --session-id {q(session_id)}{plugin}{more}' + (f' {q(prompt)}' if prompt else ''))


AGY_MODES = {'acceptEdits': 'accept-edits', 'auto': 'auto', 'plan': 'plan'}  # agy --mode 只有這三種（agy 1.5.8 --help）；其他的照 agy 預設


def ps_agy(role, folder, prompt, extra=()):
    """agy 版（0.64.5）：沒有 --session-id、--name；開場句用 -i 帶（互動模式先跑這句）"""
    more = ''.join(f' {q(x)}' for x in extra)
    return (f'Set-Location -LiteralPath {q(folder)}; $host.UI.RawUI.WindowTitle = {q(role)}; '
            f'agy{more}' + (f' -i {q(prompt)}' if prompt else ''))


def card_dir(role):
    """--dir 沒給：從角色卡的啟動位置拿（卡上沒寫就是卡所在專案的根目錄）；找不到或同名多張回 None"""
    from roles import find  # roles → takeover → 本檔，放這裡免得循環
    hits = [r for r in find(role) if r['start']]
    return hits[0]['start'] if len(hits) == 1 else None


def online_as(*names):
    """在線、session 名稱、名牌或辦公室職稱（不分大小寫）是其中一個名字的人（撞角色：兩個 session 頂同一角色，檢查點會交錯）。
    職稱會隨工作改掉，主要靠 session 名稱（open_role.py 用 --name <角色> 開）；剛開還沒寫狀態檔的視窗擋不到"""
    from takeover import live
    want = {n.lower() for n in names if n}
    out = set()
    for s in live():
        agent = (s.get('agent') or '').split(' [')[0]
        if want & {(agent or '').lower(), (s.get('name') or '').lower(), (s.get('title') or '').lower()}:
            out.add(agent or s.get('id', '')[:8])
    return sorted(out)


def card_notes(role, folder):
    """開之前對角色卡：(卡的資料列或 None, 提醒)。名字沒卡但有相近的卡、--dir 跟卡的啟動位置不同 → 提醒（只提醒不擋）"""
    from roles import all_roles, norm
    rows, k = all_roles(), role.lower()
    exact = [r for r in rows if k in (r['role'].lower(), r['name'].lower())]
    if not exact:
        near = [r for r in rows if len(os.path.commonprefix([k, r['role'].lower()])) >= 2 or k in r['role'].lower() or r['role'].lower() in k]
        return None, [f'No role card named {role}; similar cards: ' + ', '.join(f"{r['role']} ({r['card']})" for r in near)
                      + ' -> use that name instead? (skill pixel-office:team roles.md §5)'] if near else [
            f'No role card named {role} on this computer: ask the user to create one (roles.md §1) or open it as a one-off session']
    if len(exact) > 1:
        return None, [f'{len(exact)} role cards named {role}: ' + ', '.join(r['card'] for r in exact)]
    r = exact[0]
    if folder and r['start'] and norm(os.path.abspath(os.path.expanduser(r['start']))) != norm(os.path.abspath(folder)):
        return r, [f"--dir {folder} differs from the card's start folder {r['start']} ({r['card']})"]
    return r, []


def encoded(script):
    return base64.b64encode(script.encode('utf-16-le')).decode('ascii')


PERMISSION_MODES = ('acceptEdits', 'auto', 'bypassPermissions', 'manual', 'dontAsk', 'plan', 'default')  # claude --help 2026-11-26；default 是舊名
EFFORTS = ('low', 'medium', 'high', 'xhigh', 'max')


def session_uuid(v):
    try:
        return str(uuid.UUID(v))
    except ValueError:
        raise argparse.ArgumentTypeError('not a uuid')


def main(argv=None):
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser(description='Open one role window (PowerShell running claude) with office presets.')
    ap.add_argument('--role', required=True, help='role name: --name, window title, default title')
    ap.add_argument('--dir', help="working folder (must exist; default: the role card's start folder)")
    ap.add_argument('--kickoff', help='kickoff file the role reads first (must exist; default: say "你是 <role>，接手")')
    ap.add_argument('--task-file', help='UTF-8 file whose text is the opening message (phone hire; instead of --kickoff)')
    ap.add_argument('--card', help='role card path, added to the opening line (default: the single card named --role)')
    ap.add_argument('--name-only', action='store_true', help='a new hire without a role card: no card lookup, no "already online" check; no opening line unless --task-file')
    ap.add_argument('--team', help="manager's ListAgents name (office team)")
    ap.add_argument('--title', help='office title, max 16 chars (default: role)')
    ap.add_argument('--plate', help='nameplate, 1-12 letters/digits (default: from --name if ASCII)')
    ap.add_argument('--role-type', choices=('staff', 'manager'), default='staff', help='office role in the preset (default staff)')
    ap.add_argument('--session-id', type=session_uuid, help='session id to use (default: a new uuid)')
    ap.add_argument('--agent', choices=('claude', 'agy'), default='claude',
                    help='agy: run Antigravity CLI instead (preset via PO_PRESET; --model/--effort/--add-dir passed on, --permission-mode mapped to agy --mode)')
    ap.add_argument('--model', help='claude --model')
    ap.add_argument('--permission-mode', choices=PERMISSION_MODES, help='claude --permission-mode')
    ap.add_argument('--effort', choices=EFFORTS, help='claude --effort')
    ap.add_argument('--add-dir', action='append', default=[], help='claude --add-dir (repeatable; created if missing)')
    ap.add_argument('--chrome', action='store_true', help='claude --chrome')
    ap.add_argument('--remote-control', action='store_true', help='claude --remote-control <role>')
    ap.add_argument('--plugin-dir', help='extra --plugin-dir for claude (must exist)')
    ap.add_argument('--force', action='store_true', help='open even if a session with this name or title is already online')
    ap.add_argument('--json', action='store_true', help='print one JSON line {"sid","pid"} (or {"error","code"}) instead of text')
    ap.add_argument('--dry-run', action='store_true', help='print the command and preset only; open nothing, write nothing')
    a = ap.parse_args(argv)

    def fail(code, msg):
        if a.json:
            print(json.dumps({'error': msg, 'code': code}, ensure_ascii=False))
        else:
            print(msg, file=sys.stderr)
        return code

    card, notes = (None, []) if a.name_only else card_notes(a.role, a.dir)
    for n in notes:
        print('Note: ' + n, file=sys.stderr)
    a.card = a.card or (card and card['card'])
    taken = [] if a.name_only else online_as(a.role, *((card['role'], card['name']) if card else ()))
    if taken and not a.force:  # --dry-run 照樣印指令，最後才 exit 3
        msg = f'STOP: {", ".join(taken)} already online as {a.role} -> message it instead (SendMessage), or ask the user; --force opens a second one'
        if not a.dry_run:
            return fail(3, msg)
        print(msg, file=sys.stderr)
    a.dir = a.dir or (None if a.name_only else card_dir(a.role))
    if not a.dir:
        return fail(1, f'No --dir and no single role card with a start folder for {a.role} (python roles.py {a.role})')
    missing = [p for p in (a.dir, a.kickoff, a.task_file, a.plugin_dir) if p and not os.path.exists(p)]
    if missing:
        return fail(1, 'Not found: ' + ', '.join(missing))
    task = ''
    if a.task_file:
        with open(a.task_file, encoding='utf-8') as f:
            task = f.read().strip()
    title = (a.title or (card and (card['title'] or card['role'])) or a.role)[:16]  # 用 office_name 叫的也登記成卡名，takeover 才認得持有者
    agy = a.agent == 'agy'
    # agy 開之前不知道它的對話 id：用暫代 id（agp-<8 碼>）當預先登記的檔名與座位的鑰匙，agy 外掛開場時套用、記成 launch
    sid = f'agp-{uuid.uuid4().hex[:8]}' if agy else a.session_id or str(uuid.uuid4())
    preset = {'title': title, 'role': a.role_type, **({'team': a.team} if a.team else {}), **({'name': a.plate} if a.plate else {})}
    if agy:
        preset.update(agent=a.role, launch=sid)
    if task:
        prompt = task
    elif a.kickoff:
        prompt = f'請讀 {os.path.abspath(a.kickoff)} 並照做' + (f'（你的角色卡：{a.card}）' if a.card else '') + '。'
    elif a.name_only:
        prompt = ''  # 沒交代工作的新人不送開場句（同 tmux 招聘）
    else:
        prompt = f'你是 {a.role}，接手' + (f'。角色卡：{a.card}' if a.card else '')
    if a.team and prompt:  # 卡上寫的主管是正式流程的那位；實際開你的人以這句與名單上的 team 為準（jacky 2026-11-08）
        prompt = prompt.rstrip('。') + f'。開你的是 {a.team}，它是你的主管，有事向它回報'
    if prompt.startswith('-'):  # 不能被 claude 當成參數
        prompt = '任務：' + prompt
    add_dirs = []
    for d in a.add_dir:
        d = os.path.abspath(d)
        if d in add_dirs or d == os.path.abspath(a.dir):
            continue
        if not a.dry_run:
            try:
                os.makedirs(d, exist_ok=True)
            except OSError:
                continue
        add_dirs.append(d)
    extra = [*(['--model', a.model] if a.model else []), *(['--permission-mode', a.permission_mode] if a.permission_mode else []),
             *(['--effort', a.effort] if a.effort else []), *[x for d in add_dirs for x in ('--add-dir', d)],
             *(['--remote-control', a.role] if a.remote_control else []), *(['--chrome'] if a.chrome else [])]
    if agy:
        extra = [*(['--model', a.model] if a.model else []), *(['--mode', AGY_MODES[a.permission_mode]] if a.permission_mode in AGY_MODES else []),
                 *(['--effort', a.effort] if a.effort else []), *[x for d in add_dirs for x in ('--add-dir', d)]]
        script = ps_agy(a.role, os.path.abspath(a.dir), prompt, extra)
    else:
        script = ps_script(a.role, os.path.abspath(a.dir), prompt, sid,
                           os.path.abspath(a.plugin_dir) if a.plugin_dir else None, extra)
    if a.dry_run:
        if a.json:
            print(json.dumps({'sid': sid, 'pid': None, 'dry_run': True, 'preset': preset, 'script': script}, ensure_ascii=False))
        else:
            print(f'env drop: {", ".join(sorted(k for k in os.environ if k not in child_env())) or "(none)"}')
            print(f'preset {preset_file(sid)}: {json.dumps(preset, ensure_ascii=False)}')
            print(f'powershell -NoExit -EncodedCommand <{script}>')
        return 3 if taken and not a.force else 0
    if sys.platform != 'win32':
        return fail(2, 'Opening a window is Windows-only; use --dry-run to see the command.')
    os.makedirs(os.path.dirname(preset_file(sid)), exist_ok=True)
    with open(preset_file(sid), 'w', encoding='utf-8') as f:
        json.dump(preset, f, ensure_ascii=False)
    env = {**child_env(), 'PO_PRESET': preset_file(sid)} if agy else child_env()
    proc = subprocess.Popen(['powershell', '-NoExit', '-EncodedCommand', encoded(script)], env=env,
                            creationflags=subprocess.CREATE_NEW_CONSOLE)
    if a.json:
        print(json.dumps({'sid': sid, 'pid': proc.pid}))
    else:
        print(f'Opened: {a.role} ({a.dir}), session {sid}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
