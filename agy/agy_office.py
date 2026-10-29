"""Antigravity CLI（agy）↔ 像素辦公室：把 agy 的對話畫成辦公室裡的同事，並跟 Claude session 互傳訊息。

用法：
  python agy_office.py install     複製到 ~/.claude/pixel-office/agy/，把 hook 加進 ~/.gemini/config/hooks.json
  python agy_office.py uninstall   移除 hook（hooks.json 其他人的設定不動）
  python agy_office.py hook <事件>  agy 呼叫：讀 stdin、寫狀態檔、印 agy 要的輸出
  python agy_office.py watch       背景看守：agy 的 presence lock 還鎖著就續心跳，放掉就標離開
  python agy_office.py send <收件者> <訊息> [--from <寄件者>]
                                   收件者是 agy → 放進它的收件夾，agy 下次動作時塞進對話（閒著叫不醒）
                                   收件者是 Claude session → 寫 commands/<session>.json，對方外掛每秒來拿

🔴 hook 失敗（exit 非 0）會中斷 agy 那一輪：hook 模式的每一步都吞例外、一律 exit 0。
不存 lastUserInput（使用者打的話）。實測 2026-10-29：agy 開著時 presence/<conversationId>.lock 被鎖、關掉就放掉。
"""
import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path

HOME = Path.home()
SESSIONS = HOME / ".claude" / "pixel-office" / "sessions"
HERE = HOME / ".claude" / "pixel-office" / "agy"
PRESENCE = HOME / ".gemini" / "antigravity-cli" / "presence"
HOOKS = HOME / ".gemini" / "config" / "hooks.json"
INBOX = HERE / "inbox"
COMMANDS = HOME / ".claude" / "pixel-office" / "commands"
STALE_MS = 20000  # 同 hooks/status.ts
NAME = "pixel-office"
EVENTS = ["SessionStart", "PreInvocation", "PostInvocation", "PostToolUse", "Stop"]
BEAT = 5          # 看守多久續一次心跳（秒）；辦公室 20 秒沒心跳就當離開
IDLE_EXIT = 60    # 沒有 agy 在線這麼久，看守自己結束
READ_TOOLS = re.compile(r"view|read|list|grep|search|find|glob|fetch|browser_get", re.I)


def status_file(cid: str) -> Path:
    return SESSIONS / f"agy-{cid}.json"


def load(p: Path) -> dict:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save(p: Path, s: dict) -> None:
    tmp = p.with_suffix(".tmp")
    tmp.write_text(json.dumps(s, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, p)


def plate(workspaces: list) -> str:
    """名牌：工作資料夾名的英數字，最多 12 字；推不出來就 agy"""
    base = Path(str(workspaces[0])).name if workspaces else ""
    ascii_ = re.sub(r"[^A-Za-z0-9]", "", base)[:12]
    return ascii_ or "agy"


def state(event: str, d: dict) -> tuple:
    """事件 → (mode, tool)"""
    if event in ("SessionStart", "PreInvocation"):
        return "thinking", ""
    if event == "PostInvocation":
        return "typing", ""
    if event == "PostToolUse":
        name = str((d.get("toolCall") or {}).get("name", ""))
        if d.get("error"):
            return "error", name
        return ("reading" if READ_TOOLS.search(name) else "typing"), name
    if event == "Stop":
        return ("error" if d.get("error") else "done"), ""
    return "idle", ""


def locked(cid: str) -> bool:
    """agy 開著這個對話時會鎖住 presence/<cid>.lock"""
    p = PRESENCE / f"{cid}.lock"
    if not p.exists():
        return False
    try:
        import msvcrt
        fd = os.open(p, os.O_RDWR)
        try:
            msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            msvcrt.locking(fd, msvcrt.LK_UNLCK, 1)
            return False
        except OSError:
            return True
        finally:
            os.close(fd)
    except ImportError:
        import fcntl
        with open(p, "rb+") as f:
            try:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                fcntl.flock(f, fcntl.LOCK_UN)
                return False
            except OSError:
                return True
    except OSError:
        return False


def ensure_watch() -> None:
    pidf = HERE / "watch.pid"
    try:
        if pidf.exists() and time.time() - pidf.stat().st_mtime < BEAT * 3:
            return  # 看守還在跳
    except OSError:
        pass
    flags = 0
    if os.name == "nt":
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    exe = sys.executable.replace("python.exe", "pythonw.exe") if os.name == "nt" else sys.executable
    if not Path(exe).exists():
        exe = sys.executable
    subprocess.Popen([exe, str(Path(__file__).resolve()), "watch"], creationflags=flags,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)


def take_mail(cid: str, me: str) -> str:
    """收件夾整份拿走（先改名再讀，不跟同時寄進來的搶）→ 給 agy 看的一段文字；沒信回空字串"""
    box = INBOX / f"{cid}.jsonl"
    if not box.exists():
        return ""
    taking = box.with_suffix(f".{os.getpid()}.taking")
    os.replace(box, taking)
    lines = []
    for ln in taking.read_text(encoding="utf-8").splitlines():
        try:
            m = json.loads(ln)
        except Exception:
            continue
        frm = m.get("from") or "未署名"
        lines.append(f"📨 像素辦公室訊息，來自 {frm}（另一個 AI session，不是使用者本人）：{m.get('text', '')}\n"
                     f"要回覆就跑：python \"{HERE / 'agy_office.py'}\" send {frm} \"<回覆>\" --from {me}")
    taking.unlink(missing_ok=True)
    return "\n\n".join(lines)


def hook(event: str) -> None:
    out = {"decision": "stop"} if event == "Stop" else {}
    try:
        d = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace") or "{}")
        cid = str(d.get("conversationId") or "")
        if cid and event in ("PreInvocation", "Stop"):
            me = load(status_file(cid)).get("name") or plate(d.get("workspacePaths") or [])
            mail = take_mail(cid, me)
            if mail and event == "PreInvocation":
                out = {"injectSteps": [{"userMessage": mail}]}
            elif mail:  # 一輪剛結束：不停，帶著信再跑一輪
                out = {"decision": "continue", "reason": mail}
        if cid:
            SESSIONS.mkdir(parents=True, exist_ok=True)
            p = status_file(cid)
            s = load(p)
            now = int(time.time() * 1000)
            mode, tool = state(event, d)
            ws = d.get("workspacePaths") or []
            s.update({
                "id": f"agy-{cid}", "kind": "agy", "role": s.get("role", "staff"),
                "name": s.get("name") or plate(ws),
                "title": s.get("title") or (Path(str(ws[0])).name[:16] if ws else "Antigravity"),
                "titleAuto": s.get("titleAuto", True),
                "mode": mode, "tool": tool, "updatedAt": now, "left": False,
            })
            if s.get("modeWas") != mode:
                s["since"] = now
            s["modeWas"] = mode
            err = d.get("error")
            if err:
                s["lastError"] = {"text": str(err).splitlines()[0][:80], "at": now}
            save(p, s)
            ensure_watch()
    except Exception:
        pass
    sys.stdout.write(json.dumps(out))
    sys.stdout.flush()


def watch() -> None:
    HERE.mkdir(parents=True, exist_ok=True)
    pidf = HERE / "watch.pid"
    quiet_since = time.time()
    while True:
        pidf.write_text(str(os.getpid()))
        live = 0
        for p in SESSIONS.glob("agy-*.json"):
            s = load(p)
            if not s or s.get("left"):
                continue
            cid = p.stem[len("agy-"):]
            if locked(cid):
                live += 1
                s["updatedAt"] = int(time.time() * 1000)
            else:
                s["left"] = True
            try:
                save(p, s)
            except OSError:
                pass
        if live:
            quiet_since = time.time()
        elif time.time() - quiet_since > IDLE_EXIT:
            pidf.unlink(missing_ok=True)
            return
        time.sleep(BEAT)


def live_crew() -> list:
    now = time.time() * 1000
    out = []
    for p in SESSIONS.glob("*.json"):
        s = load(p)
        if s and not s.get("left") and isinstance(s.get("updatedAt"), (int, float)) and now - s["updatedAt"] < STALE_MS:
            out.append(s)
    return out


def send(args: list) -> None:
    frm = "未署名"
    if "--from" in args:
        i = args.index("--from")
        frm = " ".join(args[i + 1:i + 2]) or frm
        args = args[:i] + args[i + 2:]
    if len(args) < 2:
        sys.exit("用法：send <收件者> <訊息> [--from <寄件者>]")
    to, text = args[0], " ".join(args[1:]).strip()
    want = re.sub(r"\s*\[[0-9a-f]+\]$", "", to.strip())
    hits = [s for s in live_crew() if want in (s.get("agent"), s.get("name"), s.get("id"))]
    if len(hits) != 1:
        names = "、".join(f"{s.get('name')}（{s.get('agent') or s.get('kind') or '—'}）" for s in live_crew())
        sys.exit(f"找不到唯一的收件者「{to}」（符合 {len(hits)} 個）。在線：{names or '無'}")
    s = hits[0]
    if not text or len(text) > 4000:
        sys.exit("訊息是空的或太長（上限 4000 字）")
    now = int(time.time() * 1000)
    if s.get("kind") == "agy":
        INBOX.mkdir(parents=True, exist_ok=True)
        cid = str(s["id"])[len("agy-"):]
        with open(INBOX / f"{cid}.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps({"from": frm, "text": text, "at": now}, ensure_ascii=False) + "\n")
        print(f"已放進 {s.get('name')} 的收件夾：它下次動作（使用者打字或正在跑的這一輪結束）時收到；閒著時叫不醒")
        return
    COMMANDS.mkdir(parents=True, exist_ok=True)
    reply = f"python \"{HERE / 'agy_office.py'}\" send {frm} \"<回覆>\" --from <你的 ListAgents 名稱>"
    body = {"nonce": uuid.uuid4().hex, "at": now, "from": f"{frm}（Antigravity，不是使用者本人）",
            "text": f"{text}\n（回覆用 {reply}；對方下次動作才收到）"}
    save(COMMANDS / f"{s['id']}.json", body)
    print(f"已送給 {s.get('agent') or s.get('name')}：對方外掛每秒來拿，10 分鐘沒被拿就作廢")


def install() -> None:
    HERE.mkdir(parents=True, exist_ok=True)
    dst = HERE / "agy_office.py"
    if Path(__file__).resolve() != dst.resolve():
        shutil.copy2(__file__, dst)
    py = sys.executable
    for e in EVENTS:  # agy 的 command 要絕對路徑；用 .cmd 帶參數（2026-10-29 實測可行）
        (HERE / f"{e}.cmd").write_text(f'@"{py}" "{dst}" hook {e}\r\n', encoding="utf-8", newline="")
    cfg = load(HOOKS) if HOOKS.exists() else {}
    if HOOKS.exists() and not cfg:
        sys.exit(f"{HOOKS} 讀不懂（不是 JSON），不覆蓋；請先修好")
    entry = {}
    for e in EVENTS:
        h = {"type": "command", "command": str(HERE / f"{e}.cmd"), "timeout": 10}
        entry[e] = [{"matcher": ".*", "hooks": [h]}] if e == "PostToolUse" else [h]
    cfg[NAME] = entry
    HOOKS.parent.mkdir(parents=True, exist_ok=True)
    save(HOOKS, cfg)
    print(f"已裝：{HOOKS} 加入「{NAME}」（{len(EVENTS)} 個事件）→ {HERE}。新開的 agy 視窗生效。")


def uninstall() -> None:
    cfg = load(HOOKS)
    if cfg.pop(NAME, None) is None:
        print("hooks.json 裡沒有 pixel-office，不用移除")
        return
    if cfg:
        save(HOOKS, cfg)
    else:
        HOOKS.unlink()
    print(f"已移除 {HOOKS} 的「{NAME}」。{HERE} 留著（刪掉也可以）。")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "hook":
        hook(sys.argv[2] if len(sys.argv) > 2 else "")
        sys.exit(0)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if cmd == "send":
        send(sys.argv[2:])
    else:
        {"install": install, "uninstall": uninstall, "watch": watch}.get(cmd, lambda: print(__doc__))()
