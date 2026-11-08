"""Codex CLI ↔ 像素辦公室。這個資料夾本身就是一個 Codex 外掛（.codex-plugin/plugin.json、hooks/hooks.json）。

用法：
  python codex_office.py hook <事件>   hooks/hooks.json 呼叫：寫狀態檔、最後一則回覆、收信
  python codex_office.py send <收件者> <訊息> [--from <寄件者>]
                                      給 Claude session 用：codex queue 送進那個 Codex（閒置也會馬上回）；不能用時退回收件夾，下次使用者送出訊息時塞進那一輪
  python codex_office.py mcp          .mcp.json 呼叫：stdio MCP server（office_profile／office_roster／office_send），Codex 主動傳話給 Claude 用
  python codex_office.py watch        背景看守：Codex 程式還在就續心跳，結束就標離開
  python codex_office.py install      印出安裝指令（不替使用者改 Codex 設定）

🔴 hook 失敗不能擋 Codex：每一步吞例外、一律 exit 0；Stop 一定印 JSON（{}）。
不存使用者打的話（UserPromptSubmit 的 prompt）。設計與實測：pixel-office 的 docs/designs/codex.md。
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
BASE = HOME / ".claude" / "pixel-office"
SESSIONS = BASE / "sessions"
REPLIES = BASE / "replies"   # 同 remote/server.ts lastReply：{text, at}
DATA = BASE / "codex"        # 收件夾、看守 pid、最近一次各事件的欄位；也放一份腳本給 Claude 端跑 send
CLI = DATA / "codex_office.py"
INBOX = DATA / "inbox"
STALE_MS = 20000  # 同 hooks/status.ts
SHARED_IDLE_MS = 30 * 60 * 1000  # 桌面 App／常駐程式（多個對話共用一個行程）：這麼久沒 hook 事件就當離開
BEAT = 5          # 看守多久續一次心跳（秒）
IDLE_EXIT = 60    # 沒有 Codex 在線這麼久，看守自己結束
DONE_MS = 5000    # 「完成」顯示多久後改回閒置（同 hooks/register.tsx revertLater）
READ_TOOLS = re.compile(r"read|view|list|grep|search|find|glob|fetch", re.I)


def status_file(sid: str) -> Path:
    return SESSIONS / f"codex-{sid}.json"


def load(p: Path) -> dict:
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save(p: Path, s: dict) -> None:
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(s, ensure_ascii=False), encoding="utf-8")
    for i in range(5):  # Windows：別人正在讀時 replace 會被拒，等一下再試
        try:
            os.replace(tmp, p)
            return
        except PermissionError:
            time.sleep(0.05 * (i + 1))
    tmp.unlink(missing_ok=True)
    raise PermissionError(str(p))


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


def plate(cwd: str, sid: str) -> str:
    """預設名牌：工作資料夾名的英數字（最多 12 字）；跟在線的人撞名就接 session id 前 4 碼"""
    base = re.sub(r"[^A-Za-z0-9]", "", Path(cwd).name if cwd else "")[:12] or "codex"
    if any(s.get("name") == base and s.get("id") != f"codex-{sid}" for s in live_crew()):
        base = base[:8] + re.sub(r"[^A-Za-z0-9]", "", sid)[-4:]  # 取尾碼：Codex 的 id 照時間排，前幾碼都一樣
    return base


def state(event: str, d: dict) -> tuple:
    """事件 → (mode, tool)"""
    if event == "SessionStart":
        return "idle", ""
    if event == "UserPromptSubmit":
        return "thinking", ""
    if event == "PostToolUse":
        name = str(d.get("tool_name") or "")
        return ("reading" if READ_TOOLS.search(name) else "typing"), name
    if event == "Stop":
        return "done", ""
    return "idle", ""


# ---------------------------------------------------------------- 找 Codex 程式（續心跳用）

def _procs() -> dict:
    """{pid: (ppid, exe 名小寫)}"""
    out = {}
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        class PE(ctypes.Structure):
            _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                        ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                        ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD),
                        ("szExeFile", ctypes.c_wchar * 260)]
        k = ctypes.windll.kernel32
        k.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
        snap = k.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
        if snap in (None, wintypes.HANDLE(-1).value):
            return out
        try:
            e = PE()
            e.dwSize = ctypes.sizeof(PE)
            ok = k.Process32FirstW(snap, ctypes.byref(e))
            while ok:
                out[e.th32ProcessID] = (e.th32ParentProcessID, e.szExeFile.lower())
                ok = k.Process32NextW(snap, ctypes.byref(e))
        finally:
            k.CloseHandle(snap)
        return out
    try:
        r = subprocess.run(["ps", "-A", "-o", "pid=,ppid=,comm="], capture_output=True, text=True, timeout=5)
        for ln in r.stdout.splitlines():
            parts = ln.split(None, 2)
            if len(parts) == 3 and parts[0].isdigit() and parts[1].isdigit():
                out[int(parts[0])] = (int(parts[1]), os.path.basename(parts[2]).lower())
    except Exception:
        pass
    return out


def codex_pid() -> int:
    """往上找第一個叫 codex 的祖先程式（hook 可能隔著 shell）；找不到回 0"""
    procs = _procs()
    pid = os.getpid()
    for _ in range(12):
        ppid, _exe = procs.get(pid, (0, ""))
        if not ppid or ppid == pid:
            return 0
        exe = procs.get(ppid, (0, ""))[1]
        if exe.startswith("codex"):
            return ppid
        pid = ppid
    return 0


def writer_locked(sid: str):
    """Codex 開著一個對話時會鎖住 ~/.codex/thread-writer-locks/<id>.lock（2026-11-09 實測：開著的鎖住、關掉的放掉或刪掉）。
    True＝開著、False＝關了、None＝看不出來（沒有這個資料夾或不是 Windows）"""
    d = Path(os.environ.get("CODEX_HOME") or HOME / ".codex") / "thread-writer-locks"
    if os.name != "nt" or not sid or not d.is_dir():
        return None
    f = d / f"{sid}.lock"
    if not f.exists():
        return False
    import msvcrt
    try:
        with open(f, "r+b") as fh:
            try:
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                return True
            msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
            return False
    except PermissionError:
        return True
    except OSError:
        return None


def shared_host(pid: int) -> bool:
    """這個 Codex 行程是不是多個對話共用的（app-server 常駐程式、桌面 App）：它活著不代表對話還開著"""
    path = codex_exe(pid).lower().replace("/", "\\") if pid else ""
    return "app-server" in path or "\\openai\\codex\\bin\\" in path


def alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        import ctypes
        k = ctypes.windll.kernel32
        h = k.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not h:
            return False
        try:
            code = ctypes.c_ulong()
            return bool(k.GetExitCodeProcess(h, ctypes.byref(code))) and code.value == 259  # STILL_ACTIVE
        finally:
            k.CloseHandle(h)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def sync_cli() -> None:
    """把自己複製一份到 DATA：Claude 端寄信用固定路徑，外掛升版也跟上"""
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
            return
    except OSError:
        pass
    flags = 0
    if os.name == "nt":
        flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    try:
        DATA.mkdir(parents=True, exist_ok=True)
        pidf.write_text("starting")  # 新看守寫出自己的 pid 前，後面的 hook 別再開第二個
    except OSError:
        pass
    exe = sys.executable.replace("python.exe", "pythonw.exe") if os.name == "nt" else sys.executable
    if not Path(exe).exists():
        exe = sys.executable
    script = CLI if CLI.exists() else Path(__file__).resolve()  # 跑 DATA 那份：不佔外掛 cache 夾，重裝才換得掉
    subprocess.Popen([exe, str(script), "watch"], cwd=str(DATA), creationflags=flags,
                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)


# ---------------------------------------------------------------- 寄信

def deliver(to: str, text: str, frm: str) -> str:
    """寄給在線的 Codex；成功回說明，失敗丟 ValueError"""
    want = re.sub(r"\s*\[[0-9a-f]+\]$", "", to.strip())
    crew = live_crew()
    hits = [s for s in crew if s.get("kind") == "codex" and want in (s.get("name"), s.get("id"), str(s.get("id", ""))[len("codex-"):])]
    if len(hits) != 1:
        names = ", ".join(s.get("name", "?") for s in crew if s.get("kind") == "codex")
        raise ValueError(f"No unique Codex session \"{to}\" ({len(hits)} matches). Codex online: {names or 'none'}")
    text = text.strip()
    if not text or len(text) > 4000:
        raise ValueError("Message is empty or too long (max 4000 characters)")
    sid = str(hits[0]["id"])[len("codex-"):]
    exe = codex_exe(int(hits[0].get("pid") or 0))
    if exe:  # codex queue：開著的 Codex 閒置時會自己撿起來回（2026-11-09 實測，不用 --resume）
        try:
            r = subprocess.run([exe, "queue", "--thread", sid, "--message", mail_line(frm, text)],
                               capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20)
            if r.returncode == 0:
                return f"Queued in {hits[0].get('name')}'s Codex session: it answers right away if idle, after its current turn if busy"
        except (OSError, subprocess.SubprocessError):
            pass
    INBOX.mkdir(parents=True, exist_ok=True)
    with open(INBOX / f"{sid}.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps({"from": frm, "text": text, "at": now_ms()}, ensure_ascii=False) + "\n")
    return f"codex queue unavailable; put in {hits[0].get('name')}'s inbox: delivered when its user next sends it a message"


def mail_line(frm: str, text: str) -> str:
    return f"📨 Pixel office message from {frm or 'unsigned'} (another AI session, not the user): {text}"


def codex_exe(pid: int) -> str:
    """那個 Codex 行程本身的執行檔（Windows 的 npm codex.cmd 會經過 cmd.exe，訊息裡的 & % ^ 會出事）；找不到回空字串"""
    if os.name == "nt" and pid > 0:
        import ctypes
        from ctypes import wintypes
        k = ctypes.windll.kernel32
        h = k.OpenProcess(0x1000, False, pid)
        if h:
            try:
                buf = ctypes.create_unicode_buffer(1024)
                n = wintypes.DWORD(1024)
                if k.QueryFullProcessImageNameW(h, 0, buf, ctypes.byref(n)):
                    return buf.value
            finally:
                k.CloseHandle(h)
    found = shutil.which("codex") or ""
    return "" if found.lower().endswith((".cmd", ".bat")) else found


def take_mail(sid: str) -> str:
    """收件夾整份拿走（先改名再讀，不跟同時寄進來的搶）→ 給 Codex 看的一段文字；沒信回空字串"""
    box = INBOX / f"{sid}.jsonl"
    if box.exists():
        os.replace(box, box.with_suffix(f".{os.getpid()}.taking"))
    lines = []
    for taking in sorted(INBOX.glob(f"{sid}.*.taking")):  # 連上次沒送完（逾時被殺）留下的一起送
        for ln in taking.read_text(encoding="utf-8").splitlines():
            try:
                m = json.loads(ln)
            except Exception:
                continue
            lines.append(mail_line(m.get("from"), m.get("text", "")))
        taking.unlink(missing_ok=True)
    return "\n\n".join(lines)


# ---------------------------------------------------------------- MCP server（Codex 叫的工具；在沙箱外跑，寫得到 ~/.claude）

COMMANDS = BASE / "commands"   # Claude 端外掛每秒撿一次（手機下命令、agy 寄信同一套）
NAME_OK = re.compile(r"^[A-Za-z0-9]{1,12}$")
TOOLS = [
    {"name": "office_profile",
     "description": "Set your nameplate and/or job title in the pixel office (shown to every Claude/agy/Codex session). "
                    "name: 1-12 ASCII letters/digits. title: what you are working on, max 16 chars, Chinese OK.",
     "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}, "title": {"type": "string"}}}},
    {"name": "office_roster",
     "description": "List everyone online in the pixel office: nameplate, title, kind (Claude/agy/Codex), what they are doing. Use it to find who to message.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "office_send",
     "description": "Send a message to another session in the pixel office (Claude Code, agy or another Codex). to: their nameplate or 'Send to' from office_roster.",
     "inputSchema": {"type": "object", "properties": {"to": {"type": "string"}, "text": {"type": "string"}}, "required": ["to", "text"]}},
]


def caller(params: dict) -> str:
    """呼叫工具的是哪個 Codex session：Codex 在 _meta 帶 sessionId（2026-11-09 實測），不猜"""
    meta = params.get("_meta") or {}
    sid = str(meta.get("sessionId") or meta.get("threadId") or (meta.get("x-codex-turn-metadata") or {}).get("session_id") or "")
    if not re.fullmatch(r"[0-9A-Za-z-]{8,64}", sid):
        raise ValueError("Codex did not say which session is calling (_meta has no sessionId)")
    if not status_file(sid).exists():
        raise ValueError("The office has no status for this session yet: its hooks have not run (trust them with /hooks, then send one message)")
    return sid


def tool_profile(sid: str, a: dict) -> str:
    p = status_file(sid)
    s = load(p)
    s["updatedAt"] = now_ms()  # 看守讀寫之間改的名牌不會被蓋回去
    name, title = a.get("name"), a.get("title")
    if name is not None:
        name = str(name).strip()
        if not NAME_OK.match(name):
            raise ValueError("Nameplate must be 1-12 letters or digits")
        if any(c.get("name") == name and c.get("id") != s.get("id") for c in live_crew()):
            raise ValueError(f"Nameplate {name} is taken, pick another")
        s["name"] = name
    if title is not None:
        s.update(title=str(title).strip()[:16], titleAuto=False)
    save(p, s)
    return f"Registered: nameplate {s.get('name')}, title {s.get('title')}"


def tool_roster() -> str:
    rows = ["| Name | Title | Kind | Send to | Now |", "|---|---|---|---|---|"]
    for s in sorted(live_crew(), key=lambda c: str(c.get("name"))):
        kind = {"agy": "agy", "codex": "Codex"}.get(s.get("kind"), "Claude")
        rows.append(f"| {s.get('name')} | {s.get('title') or '—'} | {kind} | {s.get('agent') or s.get('name')} | {s.get('mode')} {s.get('tool') or ''} |")
    return "\n".join(rows) if len(rows) > 2 else "Nobody in the office right now"


def tool_send(sid: str, a: dict) -> str:
    me = load(status_file(sid)).get("name") or "codex"
    to, text = str(a.get("to", "")), str(a.get("text", "")).strip()
    want = re.sub(r"\s*\[[0-9a-f]+\]$", "", to.strip())
    crew = live_crew()
    hits = []
    for key in ("id", "agent", "name", "title"):  # 名牌可能撞名（兩個 Office）：依序找，先找到唯一的就用
        hits = [s for s in crew if s.get(key) == want]
        if len(hits) == 1:
            break
    if len(hits) != 1:
        names = ", ".join(f"{s.get('name')} ({s.get('agent') or s.get('kind') or '—'})" for s in crew)
        raise ValueError(f"No unique recipient \"{to}\" ({len(hits)} matches). Online: {names or 'nobody'}")
    if not text or len(text) > 4000:
        raise ValueError("Message is empty or too long (max 4000 characters)")
    s = hits[0]
    if s.get("id") == f"codex-{sid}":
        raise ValueError("That is you; pick someone else from office_roster")
    if s.get("kind") == "codex":
        return deliver(str(s["id"]), text, me)
    if s.get("kind") == "agy":
        box = BASE / "agy" / "inbox"
        box.mkdir(parents=True, exist_ok=True)
        with open(box / f"{str(s['id'])[len('agy-'):]}.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps({"from": me, "text": text, "at": now_ms()}, ensure_ascii=False) + "\n")
        return f"Put in {s.get('name')}'s inbox: delivered on its next action"
    reply = f"python \"{CLI}\" send {sid} \"<reply>\" --from <your ListAgents name>"  # 用 session id：名牌會改、會撞
    save(COMMANDS / f"{s['id']}.json", {
        "nonce": uuid.uuid4().hex, "at": now_ms(), "from": f"{me} (Codex, not the user)",
        "text": f"{text}\n(Reply with {reply}; it reaches this Codex session right away)"})
    return f"Sent to {s.get('agent') or s.get('name')}: its plugin picks it up within a second; discarded if not picked up in 10 minutes. Its reply arrives as a new message in this conversation."


def mcp() -> None:
    def reply(mid, result=None, error=None):
        m = {"jsonrpc": "2.0", "id": mid}
        m.update({"error": error} if error else {"result": result})
        sys.stdout.write(json.dumps(m, ensure_ascii=False) + "\n")
        sys.stdout.flush()

    sync_cli()
    for raw in sys.stdin.buffer:  # 🔴 用 UTF-8 讀：Windows 預設 cp950，中文參數會變亂碼或解碼失敗讓整支結束（2026-11-09 Codex 看到「工具連線中斷」）
        try:
            m = json.loads(raw.decode("utf-8", "replace"))
        except Exception:
            continue
        mid, meth, params = m.get("id"), m.get("method"), m.get("params") or {}
        if mid is None:
            continue
        if meth == "initialize":
            reply(mid, {"protocolVersion": params.get("protocolVersion", "2025-06-18"), "capabilities": {"tools": {}},
                        "serverInfo": {"name": "pixel-office", "version": "1"}})
        elif meth == "ping":
            reply(mid, {})
        elif meth == "tools/list":
            reply(mid, {"tools": TOOLS})
        elif meth == "tools/call":
            name, args = params.get("name"), params.get("arguments") or {}
            try:  # 實測用：記下 Codex 帶了哪些 _meta 與環境變數名（不記內容）
                save(DATA / "payloads" / "mcp.json", {"meta": params.get("_meta"), "env": sorted(k for k in os.environ if "CODEX" in k.upper()), "cwd": os.getcwd()})
            except Exception:
                pass
            if name not in ("office_profile", "office_roster", "office_send"):
                reply(mid, error={"code": -32602, "message": f"No such tool: {name}"})
                continue
            try:
                if name == "office_roster":
                    text = tool_roster()
                else:
                    sid = caller(params)
                    text = tool_profile(sid, args) if name == "office_profile" else tool_send(sid, args)
                reply(mid, {"content": [{"type": "text", "text": text}]})
            except Exception as e:
                reply(mid, {"content": [{"type": "text", "text": str(e)}], "isError": True})
        else:
            reply(mid, error={"code": -32601, "message": f"Method not found: {meth}"})


# ---------------------------------------------------------------- hook

def hook(event: str) -> None:
    out = ""
    try:
        sync_cli()
        d = json.loads(sys.stdin.buffer.read().decode("utf-8", "replace") or "{}")
        sid = str(d.get("session_id") or "")
        if sid:
            DATA.mkdir(parents=True, exist_ok=True)
            try:  # 實測用：各事件最近一次有哪些欄位（不存使用者打的字與內容）
                seen = {k: (v if k not in ("prompt", "last_assistant_message", "tool_input", "tool_response") else "…") for k, v in d.items()}
                save(DATA / "payloads" / f"{event}.json", seen)
            except Exception:
                pass
            p = status_file(sid)
            s = load(p)
            now = now_ms()
            if event == "SessionEnd":
                s.update({"left": True, "updatedAt": now})
                save(p, s)
                return
            mode, tool = state(event, d)
            cwd = str(d.get("cwd") or "")
            if event == "UserPromptSubmit":
                out = take_mail(sid)  # 純文字 stdout 會當成這一輪的額外上下文
            if event == "Stop":
                reply = str(d.get("last_assistant_message") or "").strip()
                if reply:
                    save(REPLIES / f"codex-{sid}.json", {"text": reply[:4000], "at": now})
            if not s.get("pid") or not alive(int(s.get("pid") or 0)):
                s["pid"] = codex_pid()
                s["shared"] = shared_host(s["pid"])
            s["lastHook"] = now  # /clear、/new、fork 換了 session id：舊的放掉寫入鎖，看守 20 秒內標離開
            s.update({
                "id": f"codex-{sid}", "kind": "codex", "role": s.get("role", "staff"),
                "name": s.get("name") or plate(cwd, sid),
                "title": s.get("title") or (Path(cwd).name[:16] if cwd else "Codex"),
                "titleAuto": s.get("titleAuto", True),
                "mode": mode, "tool": tool, "updatedAt": now, "left": False,
            })
            if s.get("modeWas") != mode:
                s["since"] = now
            s["modeWas"] = mode
            save(p, s)
            ensure_watch()
    except Exception:
        pass
    finally:
        if event == "Stop":
            sys.stdout.write("{}")  # Stop 回 exit 0 時要印 JSON
        elif out:
            sys.stdout.write(out)
        sys.stdout.flush()


# ---------------------------------------------------------------- 看守

def watch() -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    pidf = DATA / "watch.pid"
    quiet_since = time.time()
    while True:
        live = 0
        try:
            pidf.write_text(str(os.getpid()))
            for p in SESSIONS.glob("codex-*.json"):
                s = load(p)
                if not s or s.get("left"):
                    continue
                was = s.get("updatedAt")
                pid = int(s.get("pid") or 0)
                held = writer_locked(str(s.get("id", ""))[len("codex-"):])
                quiet = now_ms() - s.get("lastHook", s.get("updatedAt", 0))
                if held is False and quiet > STALE_MS and (s.get("shared") or not (pid and alive(pid))):
                    s["left"] = True  # 對話關了：Codex 放掉了它的寫入鎖（剛開的對話給 20 秒拿鎖）
                elif held is None and s.get("shared") and quiet > SHARED_IDLE_MS:
                    s["left"] = True  # 看不到鎖、又是共用的常駐程式：太久沒事件就當離開
                elif held or (pid and alive(pid)):
                    live += 1
                    s["updatedAt"] = now_ms()
                    if s.get("mode") == "done" and now_ms() - s.get("since", 0) > DONE_MS:
                        s.update(mode="idle", modeWas="idle", since=now_ms())
                elif pid or now_ms() - s.get("updatedAt", 0) > STALE_MS:
                    s["left"] = True  # 程式結束；找不到程式的，hook 停了 20 秒也當離開
                else:
                    continue
                if load(p).get("updatedAt") == was:  # 讀完到現在 hook 寫過就不蓋它
                    save(p, s)
        except Exception:
            pass  # 看守不能因一次讀寫失敗就停：停了，停在提示字元的 Codex 20 秒後就離線
        if live:
            quiet_since = time.time()
        elif time.time() - quiet_since > IDLE_EXIT:
            pidf.unlink(missing_ok=True)
            return
        time.sleep(BEAT)


# ---------------------------------------------------------------- 安裝

def install() -> None:
    here = Path(__file__).resolve().parent
    print("Run these yourself (they change your Codex config), then open Codex and trust the hooks with /hooks:")
    print(f'  codex plugin marketplace add "{here}"')
    print("  codex plugin add pixel-office@pixel-office-codex")
    print("Untrusted hooks are skipped silently. After changing this folder, run the two commands again (Codex runs a cached copy).")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    if cmd == "hook":
        hook(sys.argv[2] if len(sys.argv) > 2 else "")
        sys.exit(0)
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
        {"install": install, "watch": watch, "mcp": mcp}.get(cmd, lambda: print(__doc__))()
