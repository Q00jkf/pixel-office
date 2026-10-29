"""Antigravity CLI（agy）↔ 像素辦公室。這個資料夾本身就是一個 agy 外掛（plugin.json、hooks.json、mcp_config.json、skills/）。

用法：
  python agy_office.py install     移除舊版全域 hook，`agy plugin install` 這個資料夾（要先關掉所有 agy 視窗）
  python agy_office.py uninstall   `agy plugin uninstall pixel-office`＋移除舊版全域 hook
  python agy_office.py send <收件者> <訊息> [--from <寄件者>]   給 Claude session 用（agy 用 MCP 工具 office_send）
                                   收件者是 agy → 收件夾，agy 下次動作時塞進對話（閒著叫不醒）
                                   收件者是 Claude session → commands/<session>.json，對方外掛每秒來拿
  python agy_office.py hook <事件>  agy 的 hooks.json 呼叫：寫狀態檔、收信、寄完等回信
  python agy_office.py mcp         agy 的 mcp_config.json 呼叫：stdio MCP server（office_profile／office_roster／office_send）
  python agy_office.py watch       背景看守：agy 的 presence lock 還鎖著就續心跳，放掉就標離開

🔴 hook 失敗（exit 非 0）會中斷 agy 那一輪：hook 模式的每一步都吞例外、一律 exit 0。
不存 lastUserInput（使用者打的話）。實測與設計：pixel-office 的 docs/designs/agy.md。
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
COMMANDS = HOME / ".claude" / "pixel-office" / "commands"
DATA = HOME / ".claude" / "pixel-office" / "agy"  # 收件夾、等回信標記、看守 pid；也放一份腳本給 Claude 端跑 send
CLI = DATA / "agy_office.py"
INBOX = DATA / "inbox"
AWAIT = DATA / "awaiting"
PRESENCE = HOME / ".gemini" / "antigravity-cli" / "presence"
LEGACY_HOOKS = HOME / ".gemini" / "config" / "hooks.json"  # 0.27～0.29 寫在這裡的全域 hook
PLUGIN = "pixel-office"
STALE_MS = 20000  # 同 hooks/status.ts
BEAT = 5          # 看守多久續一次心跳（秒）；辦公室 20 秒沒心跳就當離開
IDLE_EXIT = 60    # 沒有 agy 在線這麼久，看守自己結束
DONE_MS = 5000    # 「完成」顯示多久後改回閒置（同 hooks/register.tsx revertLater 5000）
WAIT_S = 90       # 寄過信的那一輪，Stop 最多等回信幾秒（等待中 agy 轉圈、不能打字，Esc 可中斷）；hooks.json 的 Stop timeout 要比它長
MAX_CHAIN = 5     # 沒有使用者介入時，最多自動續跑幾輪（防兩個 AI 無限互回）
READ_TOOLS = re.compile(r"view|read|list|grep|search|find|glob|fetch|browser_get", re.I)
SENT = re.compile(r"agy_office\.py\S*\s+send\s")  # agy 用 shell 跑 send（舊寫法）也算寄過信
NAME_OK = re.compile(r"^[A-Za-z0-9]{1,12}$")       # 同辦公室名牌規則


def status_file(cid: str) -> Path:
    return SESSIONS / f"agy-{cid}.json"


def load(p: Path) -> dict:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save(p: Path, s: dict) -> None:
    tmp = p.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(s, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, p)


def now_ms() -> int:
    return int(time.time() * 1000)


def live_crew() -> list:
    now = now_ms()
    out = []
    for p in SESSIONS.glob("*.json"):
        s = load(p)
        if s and not s.get("left") and isinstance(s.get("updatedAt"), (int, float)) and now - s["updatedAt"] < STALE_MS:
            out.append(s)
    return out


def plate(workspaces: list, cid: str) -> str:
    """預設名牌：工作資料夾名的英數字（最多 12 字）；跟在線的 agy 撞名就接對話 id 前 4 碼"""
    base = re.sub(r"[^A-Za-z0-9]", "", Path(str(workspaces[0])).name if workspaces else "")[:12] or "agy"
    if any(s.get("name") == base and s.get("id") != f"agy-{cid}" for s in live_crew()):
        base = base[:8] + re.sub(r"[^A-Za-z0-9]", "", cid)[:4]
    return base


def state(event: str, d: dict) -> tuple:
    """事件 → (mode, tool)"""
    if event in ("SessionStart", "PreInvocation"):
        return "thinking", ""
    if event == "PostInvocation":
        return "typing", ""
    if event == "PostToolUse":
        tc = d.get("toolCall") or {}
        name = str(tc.get("name", ""))
        if name == "call_mcp_tool":
            name = str((tc.get("args") or {}).get("ToolName") or name)
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


def sync_cli() -> None:
    """把自己複製一份到 DATA：Claude 端寄信用固定路徑，agy 外掛升版也跟上"""
    me = Path(__file__).resolve()
    try:
        if me == CLI.resolve():
            return
        if CLI.exists() and CLI.stat().st_size == me.stat().st_size and CLI.stat().st_mtime >= me.stat().st_mtime:
            return
        DATA.mkdir(parents=True, exist_ok=True)
        shutil.copy2(me, CLI)
    except OSError:
        pass


def ensure_watch() -> None:
    pidf = DATA / "watch.pid"
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
    # 跑 DATA 那份、工作目錄放 DATA：看守若佔著外掛資料夾，agy plugin install 會換不掉
    script = CLI if CLI.exists() else Path(__file__).resolve()
    subprocess.Popen([exe, str(script), "watch"], cwd=str(DATA), creationflags=flags,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)


# ---------------------------------------------------------------- 寄信

def deliver(to: str, text: str, frm: str) -> str:
    """寄一封信；成功回說明，失敗丟 ValueError"""
    want = re.sub(r"\s*\[[0-9a-f]+\]$", "", to.strip())
    crew = live_crew()
    hits = [s for s in crew if want in (s.get("agent"), s.get("name"), s.get("id"))]
    if len(hits) != 1:
        names = ", ".join(f"{s.get('name')} ({s.get('agent') or s.get('kind') or '—'})" for s in crew)
        raise ValueError(f"No unique recipient \"{to}\" ({len(hits)} matches). Online: {names or 'nobody'}")
    text = text.strip()
    if not text or len(text) > 4000:
        raise ValueError("Message is empty or too long (max 4000 characters)")
    s = hits[0]
    if s.get("kind") == "agy":
        INBOX.mkdir(parents=True, exist_ok=True)
        with open(INBOX / f"{str(s['id'])[len('agy-'):]}.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps({"from": frm, "text": text, "at": now_ms()}, ensure_ascii=False) + "\n")
        return f"Put in {s.get('name')}'s inbox: delivered on its next action (the user types, or its current turn ends); an idle agy cannot be woken"
    COMMANDS.mkdir(parents=True, exist_ok=True)
    reply = f"python \"{CLI}\" send {frm} \"<reply>\" --from <your ListAgents name>"
    save(COMMANDS / f"{s['id']}.json", {
        "nonce": uuid.uuid4().hex, "at": now_ms(), "from": f"{frm} (Antigravity, not the user)",
        "text": f"{text}\n(Reply with {reply}; the sender waits about 90 s for a reply, after that it arrives on its next action)"})
    return f"Sent to {s.get('agent') or s.get('name')}: its plugin picks it up every second; discarded if not picked up in 10 minutes"


def take_mail(cid: str) -> str:
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
        frm = m.get("from") or "unsigned"
        lines.append(f"📨 Pixel office message from {frm} (another AI session, not the user): {m.get('text', '')}\n"
                     f"To reply, call call_mcp_tool(ServerName=\"pixel-office_office\", ToolName=\"office_send\", Arguments={{\"to\": \"{frm}\", \"text\": \"<reply>\"}}) (call it even if it is not in your tool list).")
    taking.unlink(missing_ok=True)
    return "\n\n".join(lines)


def mark_awaiting(cid: str) -> None:
    """這一輪寄過信：一輪結束時等回信"""
    AWAIT.mkdir(parents=True, exist_ok=True)
    (AWAIT / cid).touch()


def wait_reply(cid: str) -> str:
    """這一輪寄過信才等：最多 WAIT_S 秒、每秒看收件夾。
    <cid>＝這一輪寄過信（用一次就刪）；<cid>.n＝這一串已自動續跑幾輪，沒等到或續跑滿 MAX_CHAIN 就歸零"""
    armed, count = AWAIT / cid, AWAIT / f"{cid}.n"
    if not armed.exists():
        count.unlink(missing_ok=True)  # 這一輪沒寄信＝一串結束
        return ""
    armed.unlink(missing_ok=True)
    try:
        n = int(count.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        n = 0
    if n < MAX_CHAIN:
        end = time.time() + WAIT_S
        while time.time() < end:
            time.sleep(1)
            mail = take_mail(cid)
            if mail:
                count.write_text(str(n + 1), encoding="utf-8")
                return mail
    count.unlink(missing_ok=True)
    return ""


# ---------------------------------------------------------------- hook

def hook(event: str) -> None:
    out = {"decision": "stop"} if event == "Stop" else {}
    try:
        sync_cli()
        d = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace") or "{}")
        cid = str(d.get("conversationId") or "")
        if cid and event == "PreInvocation":
            mail = take_mail(cid)
            if mail:
                out = {"injectSteps": [{"userMessage": mail}]}
        elif cid and event == "Stop":
            mail = take_mail(cid) or wait_reply(cid)
            if mail:  # 一輪剛結束：不停，帶著信再跑一輪
                out = {"decision": "continue", "reason": mail}
        elif cid and event == "PostToolUse" and SENT.search(str(((d.get("toolCall") or {}).get("args") or {}).get("CommandLine", ""))):
            mark_awaiting(cid)
        if cid:
            SESSIONS.mkdir(parents=True, exist_ok=True)
            p = status_file(cid)
            s = load(p)
            now = now_ms()
            mode, tool = state(event, d)
            ws = d.get("workspacePaths") or []
            s.update({
                "id": f"agy-{cid}", "kind": "agy", "role": s.get("role", "staff"),
                "name": s.get("name") or plate(ws, cid),
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


# ---------------------------------------------------------------- MCP server（stdio，每行一則 JSON-RPC）

TOOLS = [
    {"name": "office_profile",
     "description": "Set your nameplate and/or job title in the pixel office (shown to every Claude/agy session). "
                    "name: 1-12 ASCII letters/digits. title: what you are working on, max 16 chars, Chinese OK.",
     "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}, "title": {"type": "string"}}}},
    {"name": "office_roster",
     "description": "List everyone online in the pixel office: nameplate, title, kind (Claude/agy), what they are doing. Use it to find who to message.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "office_send",
     "description": "Send a message to another session in the pixel office (Claude Code or another agy). to: their nameplate or ListAgents name from office_roster. "
                    "After sending, this turn waits up to 90 s for a reply at its end.",
     "inputSchema": {"type": "object", "properties": {"to": {"type": "string"}, "text": {"type": "string"}}, "required": ["to", "text"]}},
]


def tool_profile(cid: str, a: dict) -> str:
    p = status_file(cid)
    s = load(p)
    if not s:
        raise ValueError("The office has no status for you yet (let this conversation run one turn first)")
    name, title = a.get("name"), a.get("title")
    if name is not None:
        name = str(name).strip()
        if not NAME_OK.match(name):
            raise ValueError("Nameplate must be 1–12 letters or digits")
        if any(c.get("name") == name and c.get("id") != s["id"] for c in live_crew()):
            raise ValueError(f"Nameplate {name} is taken, pick another")
        s["name"] = name
    if title is not None:
        s.update(title=str(title).strip()[:16], titleAuto=False, titleAt=now_ms())
    save(p, s)
    return f"Registered: nameplate {s.get('name')}, title {s.get('title')}"


def tool_roster() -> str:
    rows = ["| Name | Title | Kind | Send to | Now |", "|---|---|---|---|---|"]
    for s in sorted(live_crew(), key=lambda c: str(c.get("name"))):
        kind = "agy" if s.get("kind") == "agy" else "Claude"
        rows.append(f"| {s.get('name')} | {s.get('title') or '—'} | {kind} | {s.get('agent') or s.get('name')} | {s.get('mode')} {s.get('tool') or ''} |")
    return "\n".join(rows) if len(rows) > 2 else "Nobody in the office right now"


def tool_send(cid: str, a: dict) -> str:
    me = load(status_file(cid)).get("name") or "agy"
    msg = deliver(str(a.get("to", "")), str(a.get("text", "")), me)
    mark_awaiting(cid)
    return msg + ". This turn will wait up to 90 s for a reply when it ends."


def mcp() -> None:
    def reply(mid, result=None, error=None):
        m = {"jsonrpc": "2.0", "id": mid}
        m.update({"error": error} if error else {"result": result})
        sys.stdout.write(json.dumps(m, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    for line in sys.stdin:
        try:
            m = json.loads(line)
        except Exception:
            continue
        mid, meth, params = m.get("id"), m.get("method"), m.get("params") or {}
        if mid is None:
            continue  # 通知不用回
        if meth == "initialize":
            reply(mid, {"protocolVersion": params.get("protocolVersion", "2025-06-18"), "capabilities": {"tools": {}},
                        "serverInfo": {"name": "pixel-office", "version": "1"}})
        elif meth == "ping":
            reply(mid, {})
        elif meth == "tools/list":
            reply(mid, {"tools": TOOLS})
        elif meth == "tools/call":
            # agy 在 _meta 帶呼叫者的對話 id（2026-10-29 實測）
            cid = str((params.get("_meta") or {}).get("antigravity.google/conversation_id") or "")
            name, args = params.get("name"), params.get("arguments") or {}
            try:
                if not cid:
                    raise ValueError("No conversation id (_meta has no antigravity.google/conversation_id)")
                text = {"office_profile": lambda: tool_profile(cid, args), "office_roster": tool_roster,
                        "office_send": lambda: tool_send(cid, args)}[name]()
                reply(mid, {"content": [{"type": "text", "text": text}]})
            except KeyError:
                reply(mid, error={"code": -32602, "message": f"No such tool: {name}"})
            except Exception as e:
                reply(mid, {"content": [{"type": "text", "text": str(e)}], "isError": True})
        else:  # 包括新版的 server/discover：回「沒有這個方法」，agy 會改走 initialize
            reply(mid, error={"code": -32601, "message": f"Method not found: {meth}"})


# ---------------------------------------------------------------- 看守

def watch() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    pidf = DATA / "watch.pid"
    quiet_since = time.time()
    while True:
        pidf.write_text(str(os.getpid()))
        live = 0
        for p in SESSIONS.glob("agy-*.json"):
            s = load(p)
            if not s or s.get("left"):
                continue
            if locked(p.stem[len("agy-"):]):
                live += 1
                s["updatedAt"] = now_ms()
                if s.get("mode") == "done" and now_ms() - s.get("since", 0) > DONE_MS:
                    s.update(mode="idle", modeWas="idle", since=now_ms())
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


# ---------------------------------------------------------------- 安裝

def agy_exe() -> str:
    found = shutil.which("agy")
    local = Path(os.environ.get("LOCALAPPDATA", "")) / "agy" / "bin" / "agy.exe"
    return found or (str(local) if local.exists() else "agy")


def drop_legacy() -> None:
    cfg = load(LEGACY_HOOKS)
    if cfg.pop(PLUGIN, None) is None:
        return
    if cfg:
        save(LEGACY_HOOKS, cfg)
    else:
        LEGACY_HOOKS.unlink()
    print(f"Removed the old global hook (\"{PLUGIN}\" in {LEGACY_HOOKS})")


def install() -> None:
    drop_legacy()
    sync_cli()
    r = subprocess.run([agy_exe(), "plugin", "install", str(Path(__file__).resolve().parent)])
    if r.returncode:
        sys.exit("agy plugin install failed: most likely an agy window is open and holds the plugin folder. Close all agy windows and run again")
    print("Takes effect in newly opened agy windows.")


def uninstall() -> None:
    drop_legacy()
    subprocess.run([agy_exe(), "plugin", "uninstall", PLUGIN])
    print(f"{DATA} is kept (safe to delete).")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "hook":
        hook(sys.argv[2] if len(sys.argv) > 2 else "")
        sys.exit(0)
    if cmd == "mcp":
        if hasattr(sys.stdin, "reconfigure"):
            sys.stdin.reconfigure(encoding="utf-8")
            sys.stdout.reconfigure(encoding="utf-8")
        mcp()
        sys.exit(0)
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if cmd == "send":
        args = sys.argv[2:]
        frm = "unsigned"
        if "--from" in args:
            i = args.index("--from")
            frm = " ".join(args[i + 1:i + 2]) or frm
            args = args[:i] + args[i + 2:]
        if len(args) < 2:
            sys.exit("Usage: send <to> <message> [--from <sender>]")
        try:
            print(deliver(args[0], " ".join(args[1:]), frm))
        except ValueError as e:
            sys.exit(str(e))
    else:
        {"install": install, "uninstall": uninstall, "watch": watch}.get(cmd, lambda: print(__doc__))()
