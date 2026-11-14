"""接手一個角色（skill pixel-office:team roles.md §3）的前置工作一次做完，只印要用的，省掉逐檔讀。

  python takeover.py <角色或卡上的 office_name> [--office <協作目錄>] [--cwd <專案資料夾>]

印出（不寫任何檔）：
- 角色卡的定義（拿掉註解與 frontmatter）
- 卡的啟動位置（卡上沒寫：別處的卡用它所在專案根目錄）不是目前資料夾 → 印 MOVE 與開新視窗的 open_role.py 指令、exit 3，其他都不印
- 你是誰：~/.claude/sessions 裡這個 session 的名稱；跟角色名（卡上有 office_name 用它）不同 → 提醒請使用者 /rename（session 名稱＝角色名，換人接手下屬的 team 才接得上；jacky 2026-11-08）
- 撞角色：辦公室裡別的在線 session 職稱＝這個角色，或這份對話同時開在兩個視窗 → 印 STOP，停下來問使用者
- 登記辦公室那一行（office_profile 的參數；卡的 office_name／office_title 優先）
- 最後一筆檢查點
- collab.md 只取「主管」「在線」「檔案佔用」三節，引言拿掉、長欄位截短；其他節用到才查
- 接手主管時多印「待處理」：在線表、佔用表裡 [ref] 已不在線的列，佔用起始超過 STALE_D 天的列
改 collab.md 的主管列、在線列仍由模型用檔案工具做（各專案格式不同，腳本不碰）
"""
import argparse
import glob
import json
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from open_role import live_sessions  # noqa: E402

KEEP = ('主管', '在線', '檔案佔用')
CELL = 80          # collab 表格每格最多字數
ONLINE_S = 120     # 辦公室狀態檔多久沒更新算離線（秒）
STALE_D = 7        # 檔案佔用起始超過幾天提醒
REF = re.compile(r'\[([0-9a-f]{6})\]')
DATE = re.compile(r'(\d{4})-(\d{2})-(\d{2})')


def project_office(cwd):
    """(<主 repo>, <office>)，跟 team skill 同規則：projects.json 有設定用它，否則 <主 repo>/.claude/office"""
    try:
        r = subprocess.run(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], cwd=cwd,
                           capture_output=True, text=True, timeout=5)
        main = os.path.dirname(os.path.normpath(r.stdout.strip())) if r.returncode == 0 else cwd
    except OSError:
        main = cwd
    try:
        with open(os.path.join(os.path.expanduser('~'), '.claude', 'office', 'projects.json'), encoding='utf-8') as f:
            for k, v in json.load(f).items():
                if os.path.normcase(os.path.normpath(k)) == os.path.normcase(os.path.normpath(main)):
                    return main, os.path.normpath(os.path.join(main, v))
    except (OSError, ValueError, AttributeError):
        pass
    return main, os.path.join(main, '.claude', 'office')


def here(cwd, start):
    """已經在啟動位置：同一個資料夾、在它底下，或同一個主 repo 的 worktree"""
    n = lambda p: os.path.normcase(os.path.normpath(os.path.abspath(p)))
    s, c = n(start), n(cwd)
    return c == s or c.startswith(s.rstrip(os.sep) + os.sep) or n(project_office(cwd)[0]) == s


def office_dir(cwd):
    return project_office(cwd)[1]


def front(text):
    m = re.match(r'---\r?\n(.*?)\r?\n---\r?\n?', text, re.S)
    if not m:
        return {}, text
    meta = dict(re.findall(r'^(\w[\w-]*):\s*(.*?)\s*$', m.group(1), re.M))
    return meta, text[m.end():]


def my_session():
    sid = os.environ.get('CLAUDE_CODE_SESSION_ID', '')
    for p in glob.glob(os.path.join(os.path.expanduser('~'), '.claude', 'sessions', '*.json')):
        try:
            with open(p, encoding='utf-8') as f:
                j = json.load(f)
        except (OSError, ValueError):
            continue
        if sid and j.get('sessionId') == sid:
            return j
    return {'sessionId': sid}


def live():
    """辦公室裡在線的人（狀態檔 ONLINE_S 內更新過、沒標離開）"""
    out = []
    now = time.time() * 1000
    for p in glob.glob(os.path.join(os.path.expanduser('~'), '.claude', 'pixel-office', 'sessions', '*.json')):
        try:
            with open(p, encoding='utf-8') as f:
                s = json.load(f)
        except (OSError, ValueError):
            continue
        if isinstance(s.get('updatedAt'), (int, float)) and now - s['updatedAt'] < ONLINE_S * 1000 and not s.get('left'):
            out.append(s)
    return out


def is_lead(role):
    """主管角色：名字是「<範圍>主管」（例 willy主管；jacky 2026-11-08 定不能只叫「主管」，舊卡的「主管」照樣認）"""
    return role.endswith('主管')


def holders(role, me):
    """辦公室裡在線、職稱＝角色、不是自己的人"""
    return [s.get('agent') or s.get('name') or s.get('id', '')[:8]
            for s in live() if s.get('title') == role and s.get('id') != me]


def last_checkpoint(path):
    try:
        text = open(path, encoding='utf-8').read()
    except OSError:
        return None
    parts = re.split(r'(?m)^(?=## )', text)
    entries = [p for p in parts if p.startswith('## ')]
    return entries[-1].strip() if entries else None


def cut(s, n=CELL):
    s = s.strip()
    return s if len(s) <= n else s[:n - 1] + '…'


def collab_digest(path):
    try:
        text = open(path, encoding='utf-8').read()
    except OSError:
        return None
    _, body = front(text)
    out, keep = [], False
    for line in body.splitlines():
        h = re.match(r'#\s+(.+?)\s*$', line)
        if h:
            keep = re.split(r'[\s（(]', h.group(1))[0] in KEEP  # 「主管裁定」不算「主管」
            if keep:
                out.append(line)
            continue
        if not keep or not line.strip() or line.lstrip().startswith('>') or re.match(r'\s*\|[\s\-|:]+\|\s*$', line):
            continue
        if line.lstrip().startswith('|'):
            cells = [cut(c.replace('**', '')) for c in line.strip().strip('|').split('|')]
            out.append('| ' + ' | '.join(cells) + ' |')
        else:
            out.append(cut(line.replace('**', ''), 200))
    return '\n'.join(out)


def collab_todo(path, refs, today):
    """在線表、佔用表裡該清的列：[ref] 都不在線、佔用起始超過 STALE_D 天。沒寫 [ref] 的列不判"""
    try:
        _, body = front(open(path, encoding='utf-8').read())
    except OSError:
        return []
    out, sec = [], None
    for line in body.splitlines():
        h = re.match(r'#\s+(.+?)\s*$', line)
        if h:
            sec = re.split(r'[\s（(]', h.group(1))[0]
            continue
        if sec not in ('在線', '檔案佔用') or not line.lstrip().startswith('|'):
            continue
        cells = [c.replace('**', '').strip() for c in line.strip().strip('|').split('|')]
        who = cells[0] if sec == '在線' else (cells[1] if len(cells) > 1 else '')
        gone = REF.findall(who) and not set(REF.findall(who)) & refs
        if sec == '在線':
            if gone:
                out.append(f'在線表「{cut(who, 40)}」已不在線 → 刪列')
            continue
        d = DATE.search(cells[-1])
        days = (today - time.mktime((int(d[1]), int(d[2]), int(d[3]), 0, 0, 0, 0, 0, -1))) // 86400 if d else 0
        why = '佔用者不在線' if gone else ''
        if days > STALE_D:
            why += ('、' if why else '') + f'起始 {d[0]} 已 {int(days)} 天'
        if why:
            out.append(f'佔用「{cut(cells[0], 40)}」← {cut(who, 40)}：{why}')
    if out:
        out.append('→ 前任主管名下的佔用改成自己；別人的先問使用者（名稱消失不等於棄坑）')
    return out


def main(argv=None):
    for s in (sys.stdout, sys.stderr):
        if hasattr(s, 'reconfigure'):
            s.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser(description='Take over a role: print only what the takeover needs (writes nothing).')
    ap.add_argument('role')
    ap.add_argument('--office', help='collab dir (default: same rule as skill pixel-office:team)')
    ap.add_argument('--cwd', default=os.getcwd(), help='project folder (default: current)')
    ap.add_argument('--kind', choices=('claude', 'codex', 'agy'), default='claude',
                    help='who takes over; codex/agy skip the Claude session file and /rename, and print the steps after takeover')
    ap.add_argument('--as', dest='who', help='codex/agy: your office nameplate (default: the kind)')
    ap.add_argument('--id', help="codex/agy: your office status id (codex-<session>, agy-<conversation>), so you don't count as another holder")
    a = ap.parse_args(argv)
    other = a.kind != 'claude'  # agy、Codex：沒有 Claude 的 session 紀錄、沒有 /rename、沒有 skill（2026-11-14 實測被認成開它的 Claude）

    from roles import find, start_of  # roles.py 反過來 import 本檔，放這裡免得循環
    office = a.office or office_dir(a.cwd)
    card = os.path.join(office, 'roles', f'{a.role}.md')
    start = None
    if not os.path.isfile(card) and not a.office:
        hits = find(a.role)
        if len(hits) == 1:
            card, start = hits[0]['card'], hits[0]['start']
            a.role = hits[0]['role']
            office = os.path.dirname(os.path.dirname(card))
            print(f'（本專案沒有這張卡，用別處的：{card}；啟動位置 {start or "依派工單"}）')
        elif hits:
            print(f'STOP：別處有 {len(hits)} 張同名卡 → 問使用者用哪張，再帶 --office 重跑', file=sys.stderr)
            for r in hits:
                print(f'  {r["card"]}', file=sys.stderr)
            return 2
    if not os.path.isfile(card):
        print(f'No role card: {card}（整台電腦也沒有；全部角色：python roles.py）', file=sys.stderr)
        return 1
    meta, body = front(open(card, encoding='utf-8').read())
    body = re.sub(r'<!--.*?-->', '', body, flags=re.S).strip()
    start = start_of(body) or start
    if start and os.path.isabs(start) and os.path.isdir(start) and not here(a.cwd, start):
        if other:  # open_role.py 只會開 Claude
            print(f'MOVE：{a.role} 的啟動位置是 {os.path.normpath(start)}，這裡是 {a.cwd} → 不要在這裡接。'
                  f'請使用者在 {os.path.normpath(start)} 開一個新的 {a.kind}，再說「你是 {a.role}，接手」（卡 {card}）')
            return 3
        name = meta.get('office_name') or a.role
        cmd = (f'python "{os.path.join(os.path.dirname(os.path.abspath(__file__)), "open_role.py")}" --role "{name}" '
               f'--dir "{os.path.normpath(start)}" --title "{cut(meta.get("office_title") or a.role, 16)}"')
        print(f'MOVE：{a.role} 的啟動位置是 {os.path.normpath(start)}，這裡是 {a.cwd} → 不要在這裡接。')
        print(f'問使用者一次「要在 {os.path.normpath(start)} 開新視窗接手 {a.role} 嗎？」，好就跑：')
        print(f'  {cmd}')
        print(f'開好後這個 session 不接這個角色（卡 {card}）')
        return 3
    me = {'name': a.who or a.kind, 'sessionId': a.id} if other else my_session()
    name = me.get('name') or '(unnamed)'
    want = meta.get('office_name')
    rename_to = name if other else want or a.role  # session 名稱一律＝角色名：下屬的 team 記的是這個名字，換人接手也接得上（jacky 2026-11-08）
    others = holders(meta.get('office_title') or a.role, me.get('sessionId')) + holders(a.role, me.get('sessionId'))

    print(f'# 接手 {a.role}（卡 {card}）')
    print(body)
    print('\n# 你')
    if other:
        print(f'{a.kind}，名牌 {name}' + (f'（辦公室 id {a.id}）' if a.id else '') + '：session 名稱不用改，辦公室靠職稱認你是這個角色')
    else:
        print(f'名稱 {name}（session {me.get("sessionId", "?")[:8]}）'
              + (f'；session 名稱要＝角色名 → 請使用者 /rename {rename_to}（只有使用者能改；改好後，team 記這個名字的下屬自動接上）' if rename_to != name else ''))
    taken = [] if other else sorted({s.get('agent') for s in live() if s.get('agent') == rename_to and s.get('id') != me.get('sessionId')})
    if a.role == '主管' or meta.get('reports_to') == '主管':
        print('提醒：角色名或 reports_to 只叫「主管」，會跟別的專案撞名 → 請使用者把卡改成 <範圍>主管（例 willy主管；skill roles.md §1）')
    if taken and rename_to != name:
        print(f'STOP：已有在線的 session 叫 {rename_to}（舊的持有者還開著？）→ 先問使用者關掉或改名，不要改成同名')
    if others:
        print(f'STOP：{", ".join(sorted(set(others)))} 也登記這個角色且在線 → 先問使用者，不要接')
    twins = live_sessions(me.get('sessionId')) if me.get('sessionId') and not other else []
    if len(twins) > 1:
        print(f'STOP：這份對話同時開在 {len(twins)} 個視窗（pid {", ".join(str(p) for p, _ in twins)}）→ 請使用者關掉一個再接')
    args = [f'name={want}' if want else None, f'title={cut(meta.get("office_title") or a.role, 16)}',
            'role=主管' if meta.get('layer', '1') == '1' and is_lead(a.role) else None]
    boss = f'主管：開場句寫的「開你的是 X」；沒寫就找 office_roster 上職稱或名稱＝卡上 reports_to（{meta.get("reports_to") or "沒寫"}）的人，找不到就不帶'
    if other:  # agy、Codex 的 office_profile 只有 name、title、team
        print(f'登記：office_profile(title={cut(meta.get("office_title") or a.role, 16)}, team=<{boss}>)')
    else:
        print('登記：office_profile(' + ', '.join(x for x in args if x) + ', team=<主管的 session 名稱（＝它的角色名；卡上有 office_name 就是 office_name），沒有就不帶>, auto=<auto 模式就 true>)')
    cp_file = os.path.join(office, 'checkpoints', f'{a.role}.md')
    if meta.get('layer') == '2':  # 小隊卡只放怎麼做：不讀檢查點、不讀 collab（jacky 2026-11-08）
        print('\n# 第 2 層')
        print('不讀檢查點、不讀 collab.md：照派工單做，做完交付、回報開你的人（名單上的 team）就收工')
        if other:
            print(after_steps(a.role, name, None))
        return 0
    cp = last_checkpoint(cp_file)
    print('\n# 上次檢查點')
    print(cut(cp, 1500) if cp else '（沒有）')
    if cp and '（自動：下線前沒存）' in cp.splitlines()[0]:
        print('→ 上一位沒存檢查點，這筆是外掛代寫的：先照「對話」那行 resume 讀末段，或問主管，再開工')
    digest = collab_digest(os.path.join(office, 'collab.md'))
    print(f'\n# collab.md 摘要（{os.path.join(office, "collab.md")}；只列{"／".join(KEEP)}，其他節用到才查）')
    print(digest if digest else '（沒有 collab.md）')
    if is_lead(a.role) or is_lead(meta.get('role') or ''):
        todo = collab_todo(os.path.join(office, 'collab.md'), {s['ref'] for s in live() if s.get('ref')}, time.time())
        if todo:
            print('\n# 待處理（只有主管改 collab）')
            print('\n'.join(todo))
    if other:
        print(after_steps(a.role, name, cp_file, cp))
    return 0


def after_steps(role, who, cp_file, cp=None):
    """agy、Codex 沒有 skill：接手後要做的直接印給它（Claude 照 skill roles.md §3～§4 做）"""
    nxt = re.search(r'下一步：(.*)', cp or '')
    out = ['\n# 接手後要做的（照順序）',
           '1. 上面有 STOP → 先停下來問使用者，不要接',
           '2. office_profile 照上面「登記」那行（title＝角色名；team＝主管）',
           f'3. office_send 給主管報到一則：「接手：{role}（{who}）」' + ('；上次檢查點：' + nxt.group(1).strip().rstrip('。') if nxt else '')
           + '。沒有主管就跳過',
           '4. 照卡上的職責、邊界、必讀做事；卡上沒寫的不做，碰到邊界就回報主管']
    if cp_file:
        out.append(f'5. 做到一個段落、要收工時，在 {cp_file} 檔尾**加**一筆檢查點（只往後加，不改前面的；檔案不在就建）：\n'
                   f'   ## YYYY-MM-DD HH:mm {who}      ← 當地時間\n'
                   '   - 做完：一兩行（指檔案或 commit，不抄內容）\n'
                   '   - 卡在：沒有寫「無」\n'
                   '   - 下一步：接手的人第一件要做的事')
    return '\n'.join(out)


if __name__ == '__main__':
    sys.exit(main())
