"""找整台電腦建過的角色卡（skill pixel-office:team roles.md §3 第 1 步「卡在別的專案」）。

  python roles.py                 列出全部：角色、職稱、專案、啟動位置
  python roles.py <關鍵字>         角色名或職稱含關鍵字的
  python roles.py --path <角色>    只印那張卡的路徑（沒有 exit 1；同名多張全列、exit 2）

只看各處 .claude/office/roles/ 這一層，不全文搜尋、不翻對話紀錄（印出、不寫檔）：
- ~/.claude.json 的 projects：開過 Claude Code 的每個資料夾，換算成 <office>（worktree 併回主 repo）
- ~/.claude/office/projects.json 登記的專案
- 小隊 ~/.claude/office/squads/*/roles/（專案欄寫「小隊 <名>」，沒有啟動位置）
系統暫存資料夾底下的（測試用）跳過。
"""
import argparse
import glob
import json
import os
import re
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from takeover import front, project_office  # noqa: E402

HOME = os.path.expanduser('~')
START = re.compile(r'^##\s*啟動位置\s*\n+\s*`?([^`\n]+?)`?\s*$', re.M)


def norm(p):
    return os.path.normcase(os.path.normpath(p))


def candidates():
    out = []
    try:
        with open(os.path.join(HOME, '.claude.json'), encoding='utf-8') as f:
            out += list(json.load(f).get('projects') or {})
    except (OSError, ValueError, AttributeError):
        pass
    try:
        with open(os.path.join(HOME, '.claude', 'office', 'projects.json'), encoding='utf-8') as f:
            out += list(json.load(f))
    except (OSError, ValueError, AttributeError):
        pass
    tmp = norm(tempfile.gettempdir())
    return [p for p in out if os.path.isdir(p) and not norm(p).startswith(tmp)]


def read_card(card, project, start=None):
    try:
        meta, body = front(open(card, encoding='utf-8').read())
    except OSError:
        return None
    m = START.search(body)
    return {'role': os.path.splitext(os.path.basename(card))[0], 'title': meta.get('office_title', ''),
            'card': os.path.normpath(card), 'project': project, 'start': m.group(1).strip() if m else start}


def all_roles():
    out, seen = [], set()
    for p in candidates():
        main, office = project_office(p)
        if norm(office) in seen:
            continue
        seen.add(norm(office))
        for card in sorted(glob.glob(os.path.join(office, 'roles', '*.md'))):
            r = read_card(card, os.path.normpath(main), os.path.normpath(main))
            if r:
                out.append(r)
    for card in sorted(glob.glob(os.path.join(HOME, '.claude', 'office', 'squads', '*', 'roles', '*.md'))):
        r = read_card(card, '小隊 ' + os.path.basename(os.path.dirname(os.path.dirname(card))))
        if r:
            out.append(r)
    return out


def find(role):
    """角色名完全相同的卡（不分大小寫）"""
    return [r for r in all_roles() if r['role'].lower() == role.lower()]


def main(argv=None):
    for s in (sys.stdout, sys.stderr):
        if hasattr(s, 'reconfigure'):
            s.reconfigure(encoding='utf-8')
    ap = argparse.ArgumentParser(description='Find role cards across every project on this computer (prints only).')
    ap.add_argument('keyword', nargs='?', help='match role name or office title (substring, case-insensitive)')
    ap.add_argument('--path', metavar='ROLE', help='print only the card path of this exact role')
    a = ap.parse_args(argv)

    if a.path:
        hits = find(a.path)
        for r in hits:
            print(r['card'])
        return 0 if len(hits) == 1 else (1 if not hits else 2)
    k = (a.keyword or '').lower()
    rows = [r for r in all_roles() if k in r['role'].lower() or k in r['title'].lower()]
    if not rows:
        print('（沒有符合的角色卡）')
        return 1
    print('| 角色 | 職稱 | 專案 | 啟動位置 |\n|---|---|---|---|')
    for r in rows:
        print(f"| {r['role']} | {r['title']} | {r['project']} | {r['start'] or '（依派工單）'} |")
    return 0


if __name__ == '__main__':
    sys.exit(main())
