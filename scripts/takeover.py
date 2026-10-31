"""接手一個角色（skill pixel-office:team roles.md §3）的前置工作一次做完，只印要用的，省掉逐檔讀。

  python takeover.py <角色> [--office <協作目錄>] [--cwd <專案資料夾>]

印出（不寫任何檔）：
- 角色卡的定義（拿掉註解與 frontmatter）
- 你是誰：~/.claude/sessions 裡這個 session 的名稱；卡上有 office_name 而名稱不同 → 提醒請使用者 /rename
- 撞角色：辦公室裡別的在線 session 職稱＝這個角色，或這份對話同時開在兩個視窗 → 印 STOP，停下來問使用者
- 登記辦公室那一行（office_profile 的參數；卡的 office_name／office_title 優先）
- 最後一筆檢查點
- collab.md 只取「主管」「在線」「檔案佔用」三節，引言拿掉、長欄位截短；其他節用到才查
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


def office_dir(cwd):
    """跟 team skill 的 <office> 同規則：projects.json 有設定用它，否則 <主 repo>/.claude/office"""
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
                    return os.path.normpath(os.path.join(main, v))
    except (OSError, ValueError, AttributeError):
        pass
    return os.path.join(main, '.claude', 'office')


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


def holders(role, me):
    """辦公室裡在線、職稱＝角色、不是自己的人"""
    out = []
    now = time.time() * 1000
    for p in glob.glob(os.path.join(os.path.expanduser('~'), '.claude', 'pixel-office', 'sessions', '*.json')):
        try:
            with open(p, encoding='utf-8') as f:
                s = json.load(f)
        except (OSError, ValueError):
            continue
        fresh = isinstance(s.get('updatedAt'), (int, float)) and now - s['updatedAt'] < ONLINE_S * 1000
        if s.get('title') == role and s.get('id') != me and fresh and not s.get('left'):
            out.append(s.get('agent') or s.get('name') or s.get('id', '')[:8])
    return out


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


def main(argv=None):
    for s in (sys.stdout, sys.stderr):
        if hasattr(s, 'reconfigure'):
            s.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser(description='Take over a role: print only what the takeover needs (writes nothing).')
    ap.add_argument('role')
    ap.add_argument('--office', help='collab dir (default: same rule as skill pixel-office:team)')
    ap.add_argument('--cwd', default=os.getcwd(), help='project folder (default: current)')
    a = ap.parse_args(argv)

    office = a.office or office_dir(a.cwd)
    card = os.path.join(office, 'roles', f'{a.role}.md')
    if not os.path.isfile(card):
        print(f'No role card: {card}', file=sys.stderr)
        if not a.office:
            print('卡放在別的 repo → 在 ~/.claude/office/projects.json 加 {"<這個 repo>": "<那個 repo 的 .claude/office 絕對路徑>"}，或這次帶 --office', file=sys.stderr)
        return 1
    meta, body = front(open(card, encoding='utf-8').read())
    body = re.sub(r'<!--.*?-->', '', body, flags=re.S).strip()
    me = my_session()
    name = me.get('name') or '(unnamed)'
    want = meta.get('office_name')
    others = holders(meta.get('office_title') or a.role, me.get('sessionId')) + holders(a.role, me.get('sessionId'))

    print(f'# 接手 {a.role}（卡 {card}）')
    print(body)
    print('\n# 你')
    print(f'名稱 {name}（session {me.get("sessionId", "?")[:8]}）'
          + (f'；卡要求名稱 {want} → 請使用者 /rename {want}（只有使用者能改）' if want and want != name else ''))
    if others:
        print(f'STOP：{", ".join(sorted(set(others)))} 也登記這個角色且在線 → 先問使用者，不要接')
    twins = live_sessions(me.get('sessionId')) if me.get('sessionId') else []
    if len(twins) > 1:
        print(f'STOP：這份對話同時開在 {len(twins)} 個視窗（pid {", ".join(str(p) for p, _ in twins)}）→ 請使用者關掉一個再接')
    args = [f'name={want}' if want else None, f'title={cut(meta.get("office_title") or a.role, 16)}',
            'role=主管' if meta.get('layer', '1') == '1' and a.role == '主管' else None]
    print('登記：office_profile(' + ', '.join(x for x in args if x) + ', team=<主管的 ListAgents 名稱，沒有就不帶>, auto=<auto 模式就 true>)')
    cp = last_checkpoint(os.path.join(office, 'checkpoints', f'{a.role}.md'))
    print('\n# 上次檢查點')
    print(cut(cp, 1500) if cp else '（沒有）')
    if cp and '（自動：下線前沒存）' in cp.splitlines()[0]:
        print('→ 上一位沒存檢查點，這筆是外掛代寫的：先照「對話」那行 resume 讀末段，或問主管，再開工')
    digest = collab_digest(os.path.join(office, 'collab.md'))
    print(f'\n# collab.md 摘要（{os.path.join(office, "collab.md")}；只列{"／".join(KEEP)}，其他節用到才查）')
    print(digest if digest else '（沒有 collab.md）')
    return 0


if __name__ == '__main__':
    sys.exit(main())
