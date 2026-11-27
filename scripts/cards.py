"""角色卡清單：團隊視窗（關係圖）與手機頁共用（設計 windows-hire 4.；2026-11-26 從 team-window/team_window.py 搬出來，行為不變）。

  python cards.py roster [--session <id>] [--project <資料夾>]     被點的人所在專案的第 1 層卡＋整台電腦的小隊＋其他專案的第 1 層卡（others，0.64.2）
  python cards.py projects [--root <資料夾> ...] [--people-stdin]   有主管卡（第一階）的專案；--people-stdin 從 stdin 讀 state.json 的 people，標出在線的主管
  python cards.py launch --card <卡> [--project <資料夾>]           卡上「## 啟動位置」解析出的 ready／choices／fallback、has_start

一律印一行 JSON（含卡的路徑，給本機程式用；手機頁要的只有名字、說明，由伺服器挑）。
"""
import argparse
import glob
import json
import os
import re
import subprocess
import sys


def main_repo(cwd):
    """git repo 取 --git-common-dir 的上一層（所有 worktree 算同一個專案）；不是 git repo 就是目前資料夾"""
    try:
        common = subprocess.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], cwd=cwd,
                                capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=5,
                                creationflags=0x08000000 if sys.platform == 'win32' else 0)
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


def duty(body):
    """「## 職責」底下第一行非空的字（手機列卡時的一行說明），最多 80 字"""
    sec = re.search(r'^## 職責\s*\n(.*?)(?=^## |\Z)', body, re.M | re.S)
    line = next((x.strip(' -*\t') for x in (sec.group(1) if sec else '').splitlines() if x.strip()), '')
    return line[:80]


def cards(folder, layer):
    found = []
    for p in sorted(glob.glob(os.path.join(folder, '*.md'))):
        try:
            meta, body = front(p)
        except OSError:
            continue
        if meta.get('layer', '1') == layer:
            found.append({'name': meta.get('role') or os.path.splitext(os.path.basename(p))[0], 'file': p, '_body': body, 'desc': duty(body),
                          'top': meta.get('reports_to', '') in ('使用者', 'user') or str(meta.get('role', '')).endswith('主管')})  # <範圍>主管（jacky 2026-11-08）
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


def roster_cards(session_id=None, fallback_project=None):
    """團隊清單：被點的人（session id）所在專案的第 1 層角色卡、整台電腦的第 2 層小隊；查不到他在哪就用 fallback_project（團隊視窗＝team.json 的 project）。
    專案的第 2 層卡寫「通用定義見小隊 <小隊> 的 <角色> 卡」、卡名 <組名><角色> → 依組名分組成 options（lead＝組名），叫小隊時開專案卡"""
    where = session_id and session_cwd(session_id)
    project = main_repo(where) if where else fallback_project
    if not project:
        return {'project': [], 'squads': [], 'project_dir': None, 'from_session': False}
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
            if m:  # 卡名＝<組名><角色>（例 willy實作）：前綴就是組；卡上不寫主管是誰（jacky 2026-11-08）
                group = c['name'][:-len(m.group(1))] if c['name'].endswith(m.group(1)) else ''
                groups.setdefault(group, {})[m.group(1)] = public(c)
        options = [{'lead': lead, 'roles': [got.get(g['name'], public(g)) for g in generic]} for lead, got in groups.items()]
        squads.append({'name': name, 'when': when.group(1).strip() if when else '',
                       'roles': [public(g) for g in generic], 'options': options})
    return {'project': [public(c) for c in cards(roles, '1')], 'squads': squads, 'others': other_projects(project),
            'project_dir': project, 'from_session': bool(where)}


def other_projects(exclude, roots=None):
    """跨專案叫人（0.64.2，jacky 11-27「有時候我需要跨專案叫人，在當下的主管下面」）：exclude 以外每個專案的第 1 層卡（含主管卡）"""
    skip = os.path.normcase(os.path.normpath(exclude))
    found = []
    for key, project in project_dirs(roots).items():
        if key == skip:
            continue
        roles = [public(c) for c in cards(os.path.join(office_dir(project), 'roles'), '1')]
        if roles:
            found.append({'project_dir': project, 'name': os.path.basename(project), 'roles': roles})
    return sorted(found, key=lambda e: e['name'].lower())


def online_managers(people):
    """state.json 的 people → {專案（normcase）: [在線主管的名字]}"""
    online = {}
    for p in people or []:
        where = p.get('role') == 'manager' and session_cwd(p.get('id'))
        if where:
            online.setdefault(os.path.normcase(main_repo(where)), []).append(p.get('agent') or p.get('plate'))
    return online


def project_dirs(roots=None):
    """有角色卡資料夾的專案 {normcase: 路徑}：roots（預設 ~/.aaproject）底下兩層的 <專案>/.claude/office/roles，加上 ~/.claude/office/projects.json 指定的目錄"""
    dirs = {}
    for root in roots or [os.path.join(os.path.expanduser('~'), '.aaproject')]:
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
    return dirs


def manager_projects(roots=None, online=None):
    """關係圖空白處右鍵：有「主管」卡（第一階，top）的專案，開專案從這裡開（找法見 project_dirs）。
    online＝online_managers() 的結果，在線的 ★ 主管寫進 managers"""
    found = []
    for key, project in project_dirs(roots).items():
        top = [public(c) for c in cards(os.path.join(office_dir(project), 'roles'), '1') if c['top']]
        if top:
            found.append({'project_dir': project, 'name': os.path.basename(project), 'managers': (online or {}).get(key, []), 'roles': top})
    return {'projects': sorted(found, key=lambda e: e['name'].lower())}


def launch_options(card_file, project):
    """叫出前看啟動位置：ready 就直接開；否則 choices 給人選（每項 label、path、exists），fallback 是卡上寫的退路"""
    try:
        return launch_plan(front(card_file)[1], project)
    except OSError as e:
        return {'ready': None, 'choices': [], 'fallback': None, 'template': None, 'error': str(e)}


def main(argv=None):
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser(description='Role card lists shared by the team window and the phone page (prints one JSON line).')
    sub = ap.add_subparsers(dest='cmd', required=True)
    r = sub.add_parser('roster', help="layer-1 cards of a session's project + squads")
    r.add_argument('--session', help='session id of the person clicked')
    r.add_argument('--project', help='project folder when the session is not found')
    p = sub.add_parser('projects', help='projects that have a manager card')
    p.add_argument('--root', action='append', help='where to look for projects (repeatable; default ~/.aaproject)')
    p.add_argument('--people-stdin', action='store_true', help="read state.json's people (JSON list) from stdin to mark online managers")
    l = sub.add_parser('launch', help="a card's start folder")
    l.add_argument('--card', required=True)
    l.add_argument('--project')
    ap.add_argument('--json', action='store_true', help='(always JSON; accepted for symmetry with open_role.py)')
    a = ap.parse_args(argv)
    if a.cmd == 'roster':
        out = roster_cards(a.session, a.project)
    elif a.cmd == 'projects':
        people = []
        if a.people_stdin:
            try:
                people = json.loads(sys.stdin.read() or '[]')
            except ValueError:
                people = []
        out = manager_projects(a.root, online_managers(people))
    else:
        out = launch_options(a.card, a.project)
        try:  # 卡上有沒有「## 啟動位置」（沒有時 ready＝專案；叫小隊成員時改開在叫的人的資料夾，同團隊視窗 summon_role）
            out['has_start'] = bool(re.search(r'^## 啟動位置', front(a.card)[1], re.M))
        except OSError:
            out['has_start'] = False
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == '__main__':
    sys.exit(main())
