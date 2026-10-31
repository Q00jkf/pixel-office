"""一個團隊一個視窗，每個角色一個分頁，左欄是像素辦公室。用法：pythonw team_window.py [團隊設定.json]"""
import base64
import glob
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import ctypes
import ctypes.wintypes

try:
    import webview
    from winpty import PtyProcess
except ImportError as e:  # pythonw 沒有主控台，缺套件要跳視窗講
    msg = f'{e}\n\nInstall first:  pip install pywebview pywinpty'
    ctypes.windll.user32.MessageBoxW(0, msg, 'Pixel Office team window', 0x10)
    sys.exit(msg)

HERE = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(HERE, 'web')
CFG = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, 'team.json'))
if len(sys.argv) == 1 and not os.path.exists(CFG):  # 第一次開：從範例建一份自己的 team.json（不進 git）
    shutil.copyfile(os.path.join(HERE, 'team.example.json'), CFG)


def plugin_scripts():
    """pixel-office 的 scripts/：先找同一個 repo 的，再找已安裝的版本，最後用 marketplace 指的原始碼目錄"""
    base = os.path.join(os.path.expanduser('~'), '.claude', 'plugins')
    found = [os.path.dirname(HERE)]
    try:
        with open(os.path.join(base, 'installed_plugins.json'), encoding='utf-8') as f:
            found += [e.get('installPath') for e in json.load(f).get('plugins', {}).get('pixel-office@pixel-office', [])]
        with open(os.path.join(base, 'known_marketplaces.json'), encoding='utf-8') as f:
            found.append(json.load(f).get('pixel-office', {}).get('installLocation'))
    except (OSError, ValueError):
        pass
    for p in found:
        if p and os.path.isfile(os.path.join(p, 'scripts', 'open_role.py')):
            return os.path.join(p, 'scripts')
    sys.exit('pixel-office plugin with scripts/open_role.py not found (needs 0.36.0+)')


sys.path.insert(0, plugin_scripts())
from open_role import child_env  # 開分頁時拿掉哪些環境變數，跟外掛開角色視窗共用一份
try:
    from open_role import live_sessions  # 外掛 0.39.0 起
except ImportError:
    def live_sessions(session_id):
        return []
# 主畫面輸入框底下的提示；信任資料夾、MCP 核准等詢問畫面沒有這兩句
READY = ('shift+tabtocycle', 'forshortcuts')
ANSI = re.compile(r'\x1b\[[0-9;?<>=]*[a-zA-Z~]|\x1b\][^\x07]*\x07|\x1b[=>()][B0]?|\s')


def save_team(team):
    out = {**team, 'agents': [{k: v for k, v in a.items() if not k.startswith('_')} for a in team['agents']]}
    with open(CFG, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=2)


def load_team():
    with open(CFG, encoding='utf-8') as f:
        team = json.load(f)
    if any(not a.get('id') for a in team['agents']):
        for a in team['agents']:
            a.setdefault('id', str(uuid.uuid4()))
        save_team(team)
    return team


def main_repo(cwd):
    """git repo 取 --git-common-dir 的上一層（所有 worktree 算同一個專案）；不是 git repo 就是目前資料夾"""
    try:
        common = subprocess.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], cwd=cwd,
                                capture_output=True, text=True, timeout=5, creationflags=0x08000000)
        return os.path.dirname(os.path.normpath(common.stdout.strip())) if common.returncode == 0 else cwd
    except OSError:
        return cwd


def session_cwd(session_id):
    """~/.claude/sessions/<pid>.json 記著每個在線 session 的 sessionId 與 cwd"""
    for p in glob.glob(os.path.join(os.path.expanduser('~'), '.claude', 'sessions', '*.json')):
        try:
            with open(p, encoding='utf-8') as f:
                j = json.load(f)
        except (OSError, ValueError):
            continue
        if j.get('sessionId') == session_id and j.get('cwd') and os.path.isdir(j['cwd']):
            return j['cwd']
    return None


def office_dir(cwd):
    """pixel-office team skill 的 <office>：projects.json 有設定用它，否則 <主 repo>/.claude/office"""
    main = main_repo(cwd)
    key = lambda p: os.path.normpath(p).replace('\\', '/').lower()
    try:
        with open(os.path.join(os.path.expanduser('~'), '.claude', 'office', 'projects.json'), encoding='utf-8') as f:
            hit = {key(k): v for k, v in json.load(f).items()}.get(key(main))
        if hit:
            return os.path.normpath(os.path.join(main, hit))
    except (OSError, ValueError, AttributeError):
        pass
    return os.path.join(main, '.claude', 'office')


def front(path):
    """卡片開頭 --- 之間的 key: value（# 後是註解）＋其餘內文"""
    with open(path, encoding='utf-8') as f:
        text = f.read()
    m = re.match(r'---\s*\n(.*?)\n---\s*\n?(.*)', text, re.S)
    if not m:
        return {}, text
    meta = {}
    for line in m.group(1).splitlines():
        k, sep, v = line.partition(':')
        if sep:
            meta[k.strip()] = v.split('#')[0].strip()
    return meta, m.group(2)


def cards(folder, layer):
    found = []
    for p in sorted(glob.glob(os.path.join(folder, '*.md'))):
        try:
            meta, body = front(p)
        except OSError:
            continue
        if meta.get('layer', '1') == layer:
            found.append({'name': meta.get('role') or os.path.splitext(os.path.basename(p))[0], 'file': p, '_body': body,
                          'top': meta.get('reports_to', '') in ('使用者', 'user') or meta.get('role') == '主管'})
    return found


def launch_plan(body, project):
    """卡上「## 啟動位置」：第一個絕對路徑（「`<X>` 是 `…`」先代進去）。
    沒佔位 → ready；有佔位 → 第一段佔位換成實際存在的資料夾讓人選（_ 開頭不列）。
    fallback＝卡上「先開在 `…`」寫的退路；沒有這一節才開在專案。"""
    sec = re.search(r'^## 啟動位置\s*\n(.*?)(?=^## |\Z)', body, re.M | re.S)
    if not sec:
        return {'ready': project, 'choices': [], 'fallback': None, 'template': None}
    text = sec.group(1)
    defs = dict(re.findall(r'`(<[^>`]+>)`\s*是\s*`([^`]+)`', text))
    fb = re.search(r'先開在\s*`([^`]+)`', text)
    fb = fb and os.path.normpath(os.path.join(os.path.dirname(project), fb.group(1)))
    plan = {'ready': None, 'choices': [], 'fallback': fb if fb and os.path.isdir(fb) else None, 'template': None}
    for p in re.findall(r'`([^`]+)`', text):
        if p in defs:
            continue
        for k, v in defs.items():
            p = p.replace(k, v.rstrip('\\/'))
        if os.path.isabs(p):
            plan['template'] = p = os.path.normpath(p)
            break
    else:
        return plan
    if '<' not in p:
        plan['ready'] = p if os.path.isdir(p) else None
        return plan
    parts = re.split(r'[\\/]', p)
    k = next(i for i, x in enumerate(parts) if '<' in x)
    parent, rest = os.sep.join(parts[:k]) + os.sep, parts[k + 1:]
    for d in sorted(glob.glob(os.path.join(parent, re.sub(r'<[^>]+>', '*', parts[k])))):
        name = os.path.basename(d)
        if os.path.isdir(d) and not name.startswith('_'):
            full = os.path.join(d, *rest)
            plan['choices'].append({'label': name, 'path': full, 'exists': os.path.isdir(full) and '<' not in full})
    return plan


def public(card):
    return {k: v for k, v in card.items() if not k.startswith('_')}


def office_port():
    try:
        with open(os.path.join(os.path.expanduser('~'), '.claude', 'pixel-office', 'remote.json'), encoding='utf-8') as f:
            return int(json.load(f).get('port') or 8767)
    except (OSError, ValueError):
        return 8767


def has_transcript(sid):
    return bool(glob.glob(os.path.join(os.path.expanduser('~'), '.claude', 'projects', '*', sid + '.jsonl')))


def stop(tab):
    """結束分頁的 claude；已經自己結束時 TerminateProcess 會丟 WinError 5（存取被拒），那算成功"""
    try:
        if tab.proc and tab.proc.isalive():
            tab.proc.terminate(force=True)
    except OSError as e:
        if tab.proc.isalive():
            print('could not stop', tab.agent['name'], e, flush=True)


def host_shell(pid):
    """claude 的上一層若是專門開來跑它的 PowerShell 視窗（-NoExit -Command … claude …，開角色 session 的寫法），回它的 pid；不然 None"""
    ps = ("$c = Get-CimInstance Win32_Process -Filter 'ProcessId=%d'; "
          "$p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $c.ParentProcessId); "
          "if ($p.Name -eq 'powershell.exe') { [string]$p.ProcessId + ' ' + $p.CommandLine }") % pid
    try:
        out = subprocess.run(['powershell', '-NoProfile', '-Command', ps], capture_output=True, text=True,
                             encoding='utf-8', errors='replace', timeout=15, creationflags=0x08000000).stdout.strip()
    except (OSError, subprocess.TimeoutExpired):
        return None
    head, _, cmd = out.partition(' ')
    enc = re.search(r'-EncodedCommand\s+(\S+)', cmd)  # 外掛 open_role.py 開的視窗
    if enc:
        try:
            cmd += ' ' + base64.b64decode(enc.group(1)).decode('utf-16-le')
        except ValueError:
            pass
    return int(head) if head.isdigit() and '-NoExit' in cmd and 'claude' in cmd else None


def alive(pid):
    h = ctypes.windll.kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return False
    code = ctypes.wintypes.DWORD()
    ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))
    ctypes.windll.kernel32.CloseHandle(h)
    return code.value == 259  # STILL_ACTIVE


class Tab:
    def __init__(self, agent, cwd):
        self.agent, self.cwd = agent, agent.get('cwd') or cwd
        self.proc = None
        self.removed = False
        self.buf, self.lock = [], threading.Lock()
        self.pending, self.seen = None, ''
        self.after = None  # 開場句按下 Enter 後的畫面，用來確認真的送出了

    def argv(self):
        a = self.agent
        exe = shutil.which('claude') or 'claude'
        if has_transcript(a['id']):
            return [exe, '--resume', a['id']] + a.get('args', [])
        self.pending = a.get('prompt')  # 等輸入框出現再打，第一次的詢問畫面才不會把它吃掉
        return [exe, '--session-id', a['id'], '--name', a['name']] + a.get('args', [])

    def start(self, cols, rows):
        # 同一份對話已在別處開著還 --resume → 兩個程序共用一個 session，辦公室只看得到一個、撞角色抓不到（2026-10-31 客製實作）
        twins = live_sessions(self.agent['id']) if has_transcript(self.agent['id']) else []
        if twins:
            where = '、'.join(f"{n or '?'}（pid {p}，~/.claude/sessions/{p}.json）" for p, n in twins)
            with self.lock:
                self.buf.append(f'\x1b[33m這份對話已經開在 {where}，不再開第二份。關掉那個後按 Enter 再接；'
                                f'找不到那個視窗（強制結束留下的檔、pid 被重用）→ 刪掉上面的 json 再按 Enter。\x1b[0m\r\n')
            return
        env = child_env()
        self.proc = PtyProcess.spawn(self.argv(), cwd=self.cwd, env=env, dimensions=(rows, cols))
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self):
        while True:
            try:
                data = self.proc.read(4096)
            except EOFError:
                break
            if data and not self.removed:
                with self.lock:
                    self.buf.append(data)
                if self.after is not None:
                    self.after = (self.after + ANSI.sub('', data))[-2000:]
                if self.pending:
                    self.seen = (self.seen + ANSI.sub('', data))[-2000:]
                    if any(k in self.seen for k in READY):
                        threading.Thread(target=self._type, args=(self.pending,), daemon=True).start()
                        self.pending = None
        if not self.removed:
            with self.lock:
                self.buf.append('\r\n\x1b[33m[exited, press Enter to restart]\x1b[0m\r\n')

    def _type(self, text):
        """整段用 bracketed paste 送（claude 開了 ?2004h），Enter 另外按：一次湧入的字會被當成貼上，
        緊跟在後的 Enter 會變成換行（2026-10-30 客製測試分頁實測）。按完看畫面有沒有 esc to interrupt，沒有就再按，最多五次（2026-10-30 實測常是第 2 次才送出：剛開時第一下會被吃掉）"""
        time.sleep(0.5)
        self.proc.write('\x1b[200~' + text + '\x1b[201~')
        for n in range(5):
            time.sleep(0.8)
            self.after = ''
            self.proc.write('\r')
            time.sleep(3)
            if 'esctointerrupt' in self.after:
                print('opening line sent', self.agent['name'], 'enter x', n + 1, flush=True)
                break
        else:
            print('opening line typed but not submitted', self.agent['name'], repr(self.after[-300:]), flush=True)
        self.after = None

    def take(self):
        with self.lock:
            s, self.buf = ''.join(self.buf), []
        return s


class Api:
    def __init__(self, team):
        self._team = team
        cwd = os.path.abspath(os.path.join(os.path.dirname(CFG), team.get('cwd', '.')))
        self._cwd = cwd
        self._project = os.path.abspath(os.path.join(os.path.dirname(CFG), team.get('project') or cwd))
        self._tabs = [Tab(a, cwd) for a in team['agents']]
        self._window = None
        self._add_lock = threading.Lock()
        self._closed = False

    def tabs(self):
        return {'title': self._team.get('title', ''),
                'names': [a['name'] for a in self._team['agents']], 'ids': [a['id'] for a in self._team['agents']],
                'roles': [a.get('role', a['name']) for a in self._team['agents']]}  # role＝/rename 前的角色名

    def names(self):
        """分頁目前的名字：claude 裡 /rename 過的，以 ~/.claude/sessions/<pid>.json 的 name 為準，順手寫回 team.json；關掉的分頁是 None"""
        live = {}
        for p in glob.glob(os.path.join(os.path.expanduser('~'), '.claude', 'sessions', '*.json')):
            try:
                with open(p, encoding='utf-8') as f:
                    j = json.load(f)
            except (OSError, ValueError):
                continue
            if j.get('sessionId') and j.get('name'):
                live[j['sessionId']] = j['name']
        changed = False
        for t in self._tabs:
            new = live.get(t.agent['id'])
            if new and new != t.agent['name'] and not t.removed:
                t.agent.setdefault('role', t.agent['name'])  # 原本的角色名，add_tab 靠它認「這個角色已有分頁」
                t.agent['name'], changed = new, True
        if changed:
            try:
                save_team(self._team)
            except OSError:
                pass
        return [None if t.removed else t.agent['name'] for t in self._tabs]

    def close_session(self, session_id):
        """右鍵關掉一個在線 session：本視窗的分頁就停掉它（分頁留著，Enter 可重開）；
        別處開的（PowerShell 視窗、Desktop）就用 ~/.claude/sessions/<pid>.json 找 pid，連子程序一起結束。對話在 transcript，之後可 --resume"""
        for t in self._tabs:
            if t.agent['id'] == session_id and not t.removed:
                stop(t)
                return {'closed': t.agent['name'], 'tab': True}
        for p in glob.glob(os.path.join(os.path.expanduser('~'), '.claude', 'sessions', '*.json')):
            try:
                with open(p, encoding='utf-8') as f:
                    j = json.load(f)
            except (OSError, ValueError):
                continue
            if j.get('sessionId') != session_id or not j.get('pid'):
                continue
            if j['pid'] == os.getppid():
                return {'error': 'That session started this window; close the window instead.'}
            host = host_shell(j['pid'])
            r = subprocess.run(['taskkill', '/PID', str(j['pid']), '/T', '/F'], capture_output=True,
                               text=True, encoding='mbcs', errors='replace', creationflags=0x08000000)
            if r.returncode and alive(j['pid']):
                return {'error': f"Could not close {j.get('name') or session_id}: {(r.stderr or r.stdout).strip()}"}
            if host:
                subprocess.run(['taskkill', '/PID', str(host), '/F'], capture_output=True, creationflags=0x08000000)
            try:
                os.remove(p)  # 強制結束的 claude 不會自己清掉，留著 ListAgents／辦公室會當它還在線
            except OSError:
                pass
            return {'closed': j.get('name') or session_id, 'tab': False}
        return {'error': 'That session is not running.'}

    def roster_cards(self, session_id=None):
        """團隊清單：被點的人（session id）所在專案的第 1 層角色卡、整台電腦的第 2 層小隊；查不到他在哪就用 team.json 的 project。
        專案的第 2 層卡寫「通用定義見小隊 <小隊> 的 <角色> 卡」＋「部門主管是 <名>」→ 依部門主管分組成 options，叫小隊時開專案卡"""
        where = session_id and session_cwd(session_id)
        project = main_repo(where) if where else self._project
        roles = os.path.join(office_dir(project), 'roles')
        local = cards(roles, '2')
        squads = []
        for sq in sorted(glob.glob(os.path.join(os.path.expanduser('~'), '.claude', 'office', 'squads', '*', 'squad.md'))):
            try:
                meta, body = front(sq)
            except OSError:
                continue
            name = meta.get('squad') or os.path.basename(os.path.dirname(sq))
            when = re.search(r'什麼時候用[:：]\s*(.+)', body)
            generic = cards(os.path.join(os.path.dirname(sq), 'roles'), '2')
            groups = {}
            for c in local:
                m = re.search(rf'通用定義見小隊\s*{re.escape(name)}\s*的\s*(\S+?)\s*卡', c['_body'])
                if m:
                    lead = re.search(r'部門主管是\s*([^\s。，,]+)', c['_body'])
                    groups.setdefault(lead.group(1) if lead else '', {})[m.group(1)] = public(c)
            options = [{'lead': lead, 'roles': [got.get(g['name'], public(g)) for g in generic]} for lead, got in groups.items()]
            squads.append({'name': name, 'when': when.group(1).strip() if when else '',
                           'roles': [public(g) for g in generic], 'options': options})
        return {'project': [public(c) for c in cards(roles, '1')], 'squads': squads,
                'project_dir': project, 'from_session': bool(where)}

    def manager_projects(self):
        """關係圖空白處右鍵：有「主管」卡（第一階，top）的專案，開專案從這裡開。
        找法：team.json 的 project_roots（預設 ~/.aaproject）底下兩層的 <專案>/.claude/office/roles，
        加上 ~/.claude/office/projects.json 指定的目錄；在線的 ★ 主管寫進 managers"""
        dirs = {}
        roots = self._team.get('project_roots') or [os.path.join(os.path.expanduser('~'), '.aaproject')]
        for root in roots:
            for pat in ('*', os.path.join('*', '*')):
                for d in glob.glob(os.path.join(root, pat, '.claude', 'office', 'roles')):
                    project = os.path.dirname(os.path.dirname(os.path.dirname(d)))
                    dirs[os.path.normcase(project)] = project
        try:
            with open(os.path.join(os.path.expanduser('~'), '.claude', 'office', 'projects.json'), encoding='utf-8') as f:
                for k in json.load(f):
                    dirs[os.path.normcase(os.path.normpath(k))] = os.path.normpath(k)
        except (OSError, ValueError, AttributeError):
            pass
        online = {}
        try:
            with urllib.request.urlopen(Proxy.office + '/state.json', timeout=5) as r:
                for p in json.load(r).get('people', []):
                    where = p.get('role') == 'manager' and session_cwd(p.get('id'))
                    if where:
                        online.setdefault(os.path.normcase(main_repo(where)), []).append(p.get('agent') or p.get('plate'))
        except (OSError, ValueError):
            pass
        found = []
        for key, project in dirs.items():
            top = [public(c) for c in cards(os.path.join(office_dir(project), 'roles'), '1') if c['top']]
            if top:
                found.append({'project_dir': project, 'name': os.path.basename(project), 'managers': online.get(key, []), 'roles': top})
        return {'projects': sorted(found, key=lambda e: e['name'].lower())}

    def launch_options(self, card_file, project=None):
        """叫出前看啟動位置：ready 就直接開；否則 choices 給人選（每項 label、path、exists），fallback 是卡上寫的退路"""
        try:
            return launch_plan(front(card_file)[1], project or self._project)
        except OSError as e:
            return {'ready': None, 'choices': [], 'fallback': None, 'template': None, 'error': str(e)}

    def add_tab(self, name, card_file, cwd=None, project=None):
        """執行中加一個分頁並寫回團隊設定；同名（或改名前是這個角色名）的分頁已在就回原本那個。
        cwd 不給 → 用啟動位置的 ready；沒有 ready → 回 error=choose 加上 launch_options 的內容，請前端讓人選。
        給了但不存在 → 用卡上的退路；沒有退路 → 回 error，不開分頁（不默默退回專案）"""
        with self._add_lock:
            for i, t in enumerate(self._tabs):
                if name in (t.agent['name'], t.agent.get('role')) and not t.removed:
                    return {'i': i, 'name': t.agent['name'], 'id': t.agent['id'], 'existed': True}
            plan = self.launch_options(card_file, project)  # project＝roster_cards 回的 project_dir
            if cwd is None:
                if not plan['ready']:
                    return {'error': 'choose', **plan}
                cwd = plan['ready']
            elif not os.path.isdir(cwd):
                if not plan['fallback']:
                    return {'error': f'Path does not exist: {cwd}'}
                cwd = plan['fallback']
            a = {'name': name, 'id': str(uuid.uuid4()), 'cwd': cwd, 'prompt': f'你是 {name}，接手。角色卡：{card_file}'}
            if self._team.get('args'):
                a['args'] = list(self._team['args'])
            self._team['agents'].append(a)
            self._tabs.append(Tab(a, self._cwd))
            save_team(self._team)
            return {'i': len(self._tabs) - 1, 'name': name, 'id': a['id'], 'existed': False, 'cwd': cwd}

    def remove_tab(self, i):
        """結束那個 claude、從團隊設定拿掉（對話紀錄留著）；index 不重排，_tabs[i] 留著標記已移除"""
        with self._add_lock:
            t = self._tabs[i]
            if t.removed:
                return False
            t.removed = True
            stop(t)
            self._team['agents'] = [a for a in self._team['agents'] if a['id'] != t.agent['id']]
            try:
                save_team(self._team)
            except OSError as e:
                return {'error': f'Removed the tab, but could not update team.json: {e}'}
            return True

    def start(self, i, cols, rows):
        t = self._tabs[i]
        if not t.removed and not (t.proc and t.proc.isalive()):
            t.start(cols, rows)
            if t.proc and t.proc.isalive():
                print('start', t.agent['name'], t.proc.pid, flush=True)

    def write(self, i, data):
        t = self._tabs[i]
        if t.removed:
            return
        if os.environ.get('TW_DEBUG_KEYS'):
            print('key', t.agent['name'], repr(data), flush=True)
        if t.proc and t.proc.isalive():
            t.proc.write(data)
        elif '\r' in data:
            t.start(t.agent.get('_cols', 100), t.agent.get('_rows', 30))

    def resize(self, i, cols, rows):
        t = self._tabs[i]
        t.agent['_cols'], t.agent['_rows'] = cols, rows
        if not t.removed and t.proc and t.proc.isalive():
            t.proc.setwinsize(rows, cols)

    def _flush_loop(self):
        while not self._closed:
            time.sleep(0.015)
            for i, t in enumerate(self._tabs):
                s = t.take()
                if s and not t.removed:
                    self._window.evaluate_js(f'out({i},{json.dumps(s)})')

    def copy(self, text):
        """xterm 選取的文字放進 Windows 剪貼簿（navigator.clipboard 不能用時的保底）"""
        k, u = ctypes.windll.kernel32, ctypes.windll.user32
        k.GlobalAlloc.restype = k.GlobalLock.restype = ctypes.c_void_p
        k.GlobalLock.argtypes = k.GlobalUnlock.argtypes = [ctypes.c_void_p]
        u.SetClipboardData.argtypes = [ctypes.c_uint, ctypes.c_void_p]
        data = (text + '\0').encode('utf-16-le')
        if not u.OpenClipboard(None):
            return False
        try:
            u.EmptyClipboard()
            h = k.GlobalAlloc(0x0002, len(data))  # GMEM_MOVEABLE
            ctypes.memmove(k.GlobalLock(h), data, len(data))
            k.GlobalUnlock(h)
            return bool(u.SetClipboardData(13, h))  # CF_UNICODETEXT
        finally:
            u.CloseClipboard()

    def minimize(self):
        self._window.minimize()

    def toggle_maximize(self):
        """無邊框視窗最大化會蓋住工作列：先把最大化範圍設成螢幕工作區"""
        from System.Windows.Forms import FormWindowState, Screen
        form = self._window.native
        if form.WindowState == FormWindowState.Maximized:
            self._window.restore()
        else:
            form.MaximizedBounds = Screen.FromHandle(form.Handle).WorkingArea
            self._window.maximize()

    def is_maximized(self):
        from System.Windows.Forms import FormWindowState
        return self._window.native.WindowState == FormWindowState.Maximized

    def close_window(self):
        self._close()
        self._window.destroy()

    def bounds(self):
        """[x, y, w, h]（螢幕像素）：無邊框沒有系統邊框可拉，頁面自己算新大小再 set_bounds"""
        r = ctypes.wintypes.RECT()
        ctypes.windll.user32.GetWindowRect(self._window.native.Handle.ToInt32(), ctypes.byref(r))
        return [r.left, r.top, r.right - r.left, r.bottom - r.top]

    def set_bounds(self, x, y, w, h):
        SWP_NOZORDER, SWP_NOACTIVATE = 0x4, 0x10
        ctypes.windll.user32.SetWindowPos(self._window.native.Handle.ToInt32(), 0, int(x), int(y),
                                          max(int(w), 640), max(int(h), 400), SWP_NOZORDER | SWP_NOACTIVATE)

    def _close(self):
        if self._closed:
            return
        self._closed = True  # 視窗關了就不再送輸出，免得對已處置的 WebView2 呼叫
        for t in self._tabs:
            if t.pending and not t.removed:
                print('opening line never sent', t.agent['name'], repr(t.seen[-300:]), flush=True)
        for t in self._tabs:
            stop(t)


class Proxy(BaseHTTPRequestHandler):
    """/team/* 給這個視窗的頁面；其他轉給 pixel-office 的手機面板伺服器，辦公室頁就跟我們同源、讀得到它點了誰。"""
    office = 'http://127.0.0.1:8767'

    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path.startswith('/team/'):
            p = os.path.normpath(os.path.join(WEB, self.path[6:].split('?')[0]))
            if not p.startswith(WEB) or not os.path.isfile(p):
                return self.send_error(404)
            with open(p, 'rb') as f:
                body = f.read()
            ctype = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css'}.get(os.path.splitext(p)[1], 'application/octet-stream')
            return self._reply(200, ctype, body)
        self._forward()

    def do_POST(self):
        self._forward(self.rfile.read(int(self.headers.get('content-length') or 0)))

    def _forward(self, body=None):
        req = urllib.request.Request(self.office + self.path, data=body, method=self.command)
        if self.headers.get('content-type'):
            req.add_header('content-type', self.headers['content-type'])
        if body is not None:
            req.add_header('origin', self.office)
        try:
            with urllib.request.urlopen(req, timeout=5) as r:
                self._reply(r.status, r.headers.get('content-type', ''), r.read())
        except urllib.error.HTTPError as e:
            self._reply(e.code, e.headers.get('content-type', ''), e.read())
        except OSError:
            self._reply(502, 'text/plain; charset=utf-8', b'Office server is not running: ~/.claude/pixel-office/start-remote.bat')

    def _reply(self, code, ctype, body):
        self.send_response(code)
        self.send_header('content-type', ctype)
        self.send_header('cache-control', 'no-store')
        self.send_header('content-length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main():
    # 自己的工作列分組，才不會跟其他 python 視窗疊在一起、顯示 Python 圖示
    ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID('pixeloffice.teamwindow')
    team = load_team()
    api = Api(team)
    Proxy.office = f'http://127.0.0.1:{office_port()}'
    server = ThreadingHTTPServer(('127.0.0.1', 0), Proxy)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    api._window = webview.create_window('Pixel Office', f'http://127.0.0.1:{server.server_port}/team/index.html',
                                        js_api=api, width=1400, height=800, frameless=True,
                                        easy_drag=False)  # 預設 True＝按住視窗任何地方都在搬視窗；只留標題列（pywebview-drag-region）
    api._window.events.closing += api._close
    def boot():
        threading.Thread(target=api._flush_loop, daemon=True).start()
        script = os.environ.get('TW_EVAL')
        if script:
            time.sleep(4)
            with open(script, encoding='utf-8') as f:
                api._window.evaluate_js(f.read())
            for _ in range(300):
                time.sleep(2)
                state = api._window.evaluate_js('JSON.stringify(window.__test || null)')
                print('test', state, flush=True)
                if state and '"done":true' in state:
                    break
    webview.start(boot, icon=os.path.join(HERE, 'icon.ico'))


if __name__ == '__main__':
    main()
