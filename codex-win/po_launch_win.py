# pixel-office Codex launcher for Windows. DO NOT EDIT: Codex ties hook trust to every byte of this plugin folder,
# so any change here makes every user press Trust all again (see CHANGELOG 0.64.6).
#
# It runs codex/codex_office.py from the newest installed Claude Code pixel-office plugin
# (<home>/.claude/plugins/cache/pixel-office/pixel-office/<version>/), so upgrading pixel-office with
# `claude plugin update` also upgrades the Codex side: no reinstall, no new Trust all.
# Anything missing or failing: exit 0 quietly, so Codex keeps working.
# Windows only: on macOS / Linux it does nothing (they use codex-stub/).
import os
import re
import runpy
import sys


def version_key(name):
    return tuple(int(x) for x in name.split("."))


def find_target(home):
    root = os.path.join(home, ".claude", "plugins", "cache", "pixel-office", "pixel-office")
    try:
        names = [n for n in os.listdir(root) if re.fullmatch(r"\d+(\.\d+){1,3}", n)]
    except OSError:
        return None
    for n in sorted(names, key=version_key, reverse=True):
        f = os.path.join(root, n, "codex", "codex_office.py")
        if os.path.isfile(f):
            return f
    return None


def main(argv):
    try:
        if os.name != "nt":
            return 0
        f = find_target(os.path.expanduser("~"))
        if not f:
            return 0
        sys.argv = [f] + list(argv)
        runpy.run_path(f, run_name="__main__")
    except BaseException:
        pass
    return 0


if __name__ == "__main__":
    rc = main(sys.argv[1:])
    try:
        sys.stdout.flush()
    except BaseException:
        pass
    os._exit(rc)
