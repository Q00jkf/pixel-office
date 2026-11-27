"""Codex CLI ↔ 像素辦公室。這個資料夾本身就是一個 Codex 外掛（.codex-plugin/plugin.json、hooks/hooks.json）。

用法：
  python codex_office.py hook <事件>   hooks/hooks.json 呼叫：寫狀態檔、最後一則回覆、收信
  python codex_office.py send <收件者> <訊息> [--from <寄件者>]
                                      給 Claude session 用：codex queue 送進那個 Codex（閒置也會馬上回）；不能用時退回收件夾，下次使用者送出訊息時塞進那一輪
  python codex_office.py mcp          .mcp.json 呼叫：stdio MCP server（office_profile／office_roster／office_send），Codex 主動傳話給 Claude 用
  python codex_office.py watch        背景看守：Codex 程式還在就續心跳，結束就標離開
  python codex_office.py install      印出安裝指令（不替使用者改 Codex 設定）
  python codex_office.py locked <thread> [CODEX_HOME]  那段對話的寫入鎖有沒有人握著（true／false／none）

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


ORDERS = BASE / "orders"
ORDER_TTL_MS = 10 * 60 * 1000  # 同 hooks/register.tsx COMMAND_TTL_MS：人事令 10 分鐘作廢


def read_order(oid: str, applied: str = ""):
    """人事令（0.63.6，跟 Claude 端 register.tsx takeOrder／orderInput 同一套）：orders/<id>.json {nonce, at, role?, team?, title?}，
    手機版伺服器寫、看守與 hook 直接改狀態檔，不經模型；收過的 nonce 記在 <id>.done.json，同一道令只套一次，10 分鐘作廢。
    有效的回 (nonce, 要改的欄位)，沒有回 None"""
    try:
        if not oid.startswith("codex-"):
            return None
        f = ORDERS / f"{oid}.json"
        if not f.exists():
            return None
        o = load(f)
        nonce = o.get("nonce")
        # 套過沒有看狀態檔自己記的 orderNonce（0.63.10，審查第 3 項）：hook 用舊的 s 存回、把剛套的欄位蓋掉時，
        # orderNonce 也一起回到舊值，下一輪就會再套一次（人事欄位是「設成」，重套沒有副作用）
        if not isinstance(nonce, str) or not nonce or nonce == applied:
            return None
        if not (now_ms() - float(o.get("at") or 0) < ORDER_TTL_MS):
            return None
        out = {}
        if o.get("role") == "staff":  # 主管只能是 Claude（0.63.14，審查第 5 項）：manager 的令不收，其他欄位照套
            out["role"] = "staff"
        for k, n in (("team", 64), ("title", 16)):
            if isinstance(o.get(k), str) and o[k].strip():
                out[k] = o[k].strip()[:n]
        cp = o.get("cpFile")  # 檢查點檔（0.63.6）：絕對路徑的 .md
        if isinstance(cp, str) and cp.endswith(".md") and os.path.isabs(cp) and len(cp) < 512:
            out["cpFile"] = cp
        return (nonce, out) if out else None
    except Exception:
        return None


def apply_fields(s: dict, o: dict, nonce: str = "") -> None:
    if nonce:
        s["orderNonce"] = nonce
    if "role" in o:
        s["role"] = o["role"]
    if "team" in o:
        if o["team"].lower() == "off":
            s.pop("team", None)
        else:
            s["team"] = o["team"]
    if "title" in o:
        s.update(title=o["title"], titleAuto=False)
    if "cpFile" in o and o["cpFile"] != s.get("cpFile"):  # 換了檢查點檔：從現在起算一小時
        s.update(cpFile=o["cpFile"], cpBase=now_ms(), cpWorked=False, cpNoted=False)


def apply_preset(s: dict, sid: str):
    """手機在 Windows 招聘、叫角色開的 Codex（0.64.6）：open_role.py --agent codex 把預先登記寫在 PO_PRESET 指的檔
    （職稱、主管、角色、檢查點檔、名牌、agent、launch），這個視窗第一個對話開場時套用一次。開之前不知道 thread id，所以靠環境變數；
    要 --no-daemon，hook 才是這個視窗的 Codex 開的、拿得到環境變數。launch＝伺服器釘座位用的暫代 id（cxw-<8 碼>）。
    回登記檔的路徑：存好狀態檔才刪（同 agy_office.py）"""
    f = os.environ.get("PO_PRESET")
    if not f or s.get("id"):
        return None
    pre = load(Path(f))
    if not pre:
        return None
    apply_fields(s, {k: str(v) for k, v in pre.items() if k in ("role", "team", "title", "cpFile") and v})
    name = str(pre.get("name") or "")
    if NAME_OK.match(name) and not any(c.get("name") == name and c.get("id") != f"codex-{sid}" for c in live_crew()):
        s["name"] = name
    for k in ("agent", "launch"):
        if pre.get(k):
            s[k] = str(pre[k])[:64]
    return Path(f)


def apply_order_now(p: Path, s: dict, order) -> bool:
    """看守套人事令：重讀最新的狀態檔再改、條件寫入；寫進去了才標已收（codex-trust 複驗 ①，比照 hook），沒寫成下一輪再套"""
    fresh = load(p) or s
    apply_fields(fresh, order[1], order[0])
    if save_if(p, fresh, fresh.get("owner")):
        mark_order(str(s["id"]), *order)
        return True
    return False


def mark_order(oid: str, nonce: str, o: dict) -> None:
    try:
        save(ORDERS / f"{oid}.done.json", {"nonce": nonce, "at": now_ms(), "result": ", ".join(f"{k}={v}" for k, v in o.items())})
    except Exception:
        pass


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


def writer_locked(sid: str, home: str = ""):
    """Codex 開著一個對話時會鎖住 ~/.codex/thread-writer-locks/<id>.lock（2026-11-09 實測：開著的鎖住、關掉的放掉或刪掉）。
    True＝開著、False＝關了、None＝看不出來（沒有這個資料夾）。
    Mac／Linux 用 flock（2026-11-23 實測 Codex Desktop：開著的對話 flock 鎖住，關掉的鎖檔還在但沒人鎖）"""
    d = Path(home or os.environ.get("CODEX_HOME") or HOME / ".codex") / "thread-writer-locks"  # 那個 Codex 自己的 home（0.63.15，審查第 9 項）
    if not sid or not d.is_dir():
        return None
    f = d / f"{sid}.lock"
    if not f.exists():
        return False
    if os.name != "nt":
        import fcntl
        try:
            with open(f, "rb") as fh:
                try:
                    fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    return True  # 有人鎖著
                except OSError:
                    return None  # 其他錯誤：看不出來（審查第 9 項：原本一律當成鎖著）
                fcntl.flock(fh, fcntl.LOCK_UN)
                return False
        except OSError:
            return None
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


CODEX_OPT_VALUE = {"-c", "--config", "-m", "--model", "-C", "--cd", "--add-dir", "-s", "--sandbox", "-a", "--ask-for-approval",
                   "-p", "--profile", "-i", "--image", "--enable", "--disable", "--local-provider", "--remote"}


def is_shared_cmd(cmd: str) -> bool:
    """ps 的命令列 → 是不是 App 的常駐程式：子指令（第一個不是選項、也不是選項值的參數）是 app-server 或 exec-server。
    只看子指令的位置（0.63.18，複驗第 1 項）：原本整串找字，招聘的第一句話裡出現 app-server 也會被當成 App 的"""
    t = cmd.split()[1:]
    i = 0
    while i < len(t):
        if t[i].startswith("-"):
            i += 1 if "=" in t[i] or t[i] not in CODEX_OPT_VALUE else 2
            continue
        return t[i] in ("app-server", "exec-server")
    return False


def shared_host(pid: int) -> bool:
    """這個 Codex 行程是不是多個對話共用的（app-server 常駐程式、桌面 App）：它活著不代表對話還開著"""
    path = codex_exe(pid).lower().replace("/", "\\") if pid else ""
    if os.name != "nt" and pid:  # Mac：App 的常駐程式是 …/codex app-server（app-server 在命令列參數，不在執行檔路徑）
        try:
            cmd = subprocess.run(["ps", "-o", "command=", "-p", str(pid)], capture_output=True, text=True, timeout=5).stdout
            # 看參數，不看路徑（0.63.10，審查第 1 項）：~/.local/bin/codex 是指向 ChatGPT.app 裡執行檔的 wrapper，
            # tmux 開的 CLI 路徑也在 /ChatGPT.app/ 底下；共用的是 App 的常駐程式（app-server／exec-server 子指令）
            return is_shared_cmd(cmd)
        except Exception:
            pass
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


TMUX_PATHS = ("/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux")


def _tmux(*args: str):
    """跑 tmux：回 (returncode, stdout, stderr)；找不到 tmux、逾時、執行失敗回 None"""
    exe = shutil.which("tmux") or next((x for x in TMUX_PATHS if os.path.exists(x)), "")
    if not exe:
        return None
    try:
        r = subprocess.run([exe, *args], capture_output=True, text=True, timeout=2)
        return r.returncode, r.stdout.strip(), r.stderr.strip()
    except (OSError, subprocess.SubprocessError):
        return None


# 「這個 session（或整個 tmux 伺服器）不存在」的回覆；其他錯誤一律當「查不到」（未知）
TMUX_ABSENT = re.compile(r"no such session|can't find session|no server running|error connecting to .*\(No such file or directory\)", re.I)


def _launch_marker(session: str) -> str:
    """查 tmux session 的 @po_launch：回標記字串；session 不存在回 ""；查不到（逾時、其他錯誤）回 None"""
    r = _tmux("show-options", "-v", "-t", f"={session}:", "@po_launch")
    if r is None:
        return None
    code, out, err = r
    if code == 0:
        return out
    if TMUX_ABSENT.search(err):
        return ""
    if re.search(r"invalid option|unknown option", err, re.I):
        return ""  # session 在、但沒有這個標記：不是那次接回
    return None


def owner_state(s: dict) -> str:
    """hook 端驗世代（handoff 審查第 9 項；trust 審查 ④ 改三態）。hr.ts 接回後台時寫 owner＝tmux:<session>@<marker>，
    marker 也存在那個 session 的 @po_launch。回：
      none＝沒有 owner；mine＝這個 hook 就是從 owner 那個 tmux 跑的；other＝owner 還在、這個 hook 來自別的（舊）程序；
      gone＝確認 owner 已失效（session 不在、或標記換了）；unknown＝查不到（tmux 找不到、逾時、其他錯誤）
    呼叫端：other、unknown 都不寫狀態、保留 owner；gone 才清掉 owner"""
    own = s.get("owner")
    if not isinstance(own, str) or not own:
        return "none"
    m = re.match(r"^tmux:(.+)@([0-9A-Za-z-]+)$", own)
    if not m:
        return "unknown"
    pane = os.environ.get("TMUX_PANE") if os.environ.get("TMUX") else None
    if pane:
        r = _tmux("display", "-p", "-t", pane, "#{session_name}")
        if r is None or r[0] != 0:
            return "unknown"
        if r[1] == m.group(1):
            mk = _launch_marker(m.group(1))
            if mk is None:
                return "unknown"
            if mk == m.group(2):
                return "mine"
            return "gone"  # 我就在那個 session 名稱裡，但標記換了：owner 那次接回已經不在
    mk = _launch_marker(m.group(1))
    if mk is None:
        return "unknown"
    return "other" if mk == m.group(2) else "gone"


try:
    import fcntl  # 狀態檔鎖用核心的檔案鎖：程序結束就自動放，不用清「留下來的鎖」（codex-trust 第三輪複驗 ①）
except ImportError:  # Windows：不在 codex-trust 範圍，照舊不鎖
    fcntl = None
STATUS_LOCK_WAIT = 2.0  # 秒


class StatusLock:
    """拿到的鎖：記著自己的 fd，只關一次。重複放鎖是空動作（fd 號碼關掉後會被重用，不能再按號碼關，免得關到別人的新鎖）"""

    def __init__(self, fd: int):
        self.fd = fd

    def release(self) -> None:
        fd, self.fd = self.fd, -1
        if fd >= 0:
            try:
                os.close(fd)
            except OSError:
                pass


def status_lock(p: Path):
    """拿狀態檔的鎖：狀態檔旁的 <檔名>.flock（flock，跟 hr.ts writeStatusLocked 同一把）。
    回 StatusLock（Windows 回不鎖的空鎖）或 None（等 2 秒還拿不到）。鎖檔留著不刪：刪了會讓兩邊鎖到不同的檔"""
    if fcntl is None:
        return StatusLock(-1)
    try:
        p.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(str(p) + ".flock", os.O_RDWR | os.O_CREAT, 0o600)
    except OSError:
        return None
    end = time.monotonic() + STATUS_LOCK_WAIT
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return StatusLock(fd)
        except BlockingIOError:
            if time.monotonic() >= end:
                break
            time.sleep(0.05)
        except OSError:
            break
    os.close(fd)
    return None


def status_unlock(lock) -> None:
    """放鎖＝關掉自己的 fd（只會放自己的；重複放是空動作）"""
    if isinstance(lock, StatusLock):
        lock.release()


def update_status(p: Path, fn) -> bool:
    """在鎖裡重讀最新的狀態檔、套 fn(s) 再寫；拿不到鎖回 False（什麼都沒寫）"""
    fd = status_lock(p)
    if fd is None:
        return False
    try:
        s = load(p)
        fn(s)
        save(p, s)
        return True
    finally:
        status_unlock(fd)


_ANY = object()  # save_if 不比 updatedAt


def save_if(p: Path, s: dict, owner0, was=_ANY) -> bool:
    """條件寫入（trust 審查 ④、複驗 ②）：拿狀態檔的鎖，在鎖裡重讀；owner 世代跟讀進來時不同（hr.ts 剛好接回、發布了新 owner），
    或給了 was 而 updatedAt 變了（別人剛寫過），就不寫，回 False。搶不到鎖也不寫"""
    fd = status_lock(p)
    if fd is None:
        return False
    try:
        cur = load(p)
        if cur.get("owner") != owner0 or (was is not _ANY and cur.get("updatedAt") != was):
            return False
        save(p, s)
        return True
    finally:
        status_unlock(fd)


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


WATCH_VER = "2"  # 看守的版本（0.63.21，複驗第 10 項）：watch.pid 寫「pid 版本」；舊版只寫 pid、沒有自退，hook 看到就換掉它


def ensure_watch() -> None:
    pidf = DATA / "watch.pid"
    try:
        if pidf.exists() and time.time() - pidf.stat().st_mtime < BEAT * 3:
            parts = pidf.read_text().split()
            if parts and parts[0] == "starting" or len(parts) > 1 and parts[1] >= WATCH_VER:
                return
            if parts and parts[0].isdigit() and alive(int(parts[0])):  # 舊版看守：結束它，下面開新版的
                try:
                    os.kill(int(parts[0]), 15)
                except OSError:
                    pass
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

def deliver(to: str, text: str, frm: str, hit: dict = None) -> str:
    """寄給在線的 Codex；成功回說明，失敗丟 ValueError。hit＝已經找到的收件人（不再查第二次；複驗第 8 項）"""
    return _deliver_to(hit if hit is not None else find_codex(to), text, frm)


def find_codex(to: str) -> dict:
    """收件者（名牌、id、thread，可帶「 [ref]」）→ 唯一一位在線的 Codex；找不到或不只一位丟 ValueError"""
    want = re.sub(r"\s*\[[0-9a-f]+\]$", "", to.strip())
    crew = live_crew()
    hits = [s for s in crew if s.get("kind") == "codex" and want in (s.get("name"), s.get("id"), str(s.get("id", ""))[len("codex-"):])]
    if len(hits) != 1:
        names = ", ".join(s.get("name", "?") for s in crew if s.get("kind") == "codex")
        raise ValueError(f"No unique Codex session \"{to}\" ({len(hits)} matches). Codex online: {names or 'none'}")
    return hits[0]


def _deliver_to(target: dict, text: str, frm: str) -> str:
    hits = [target]
    text = text.strip()
    if not text or len(text) > 4000:
        raise ValueError("Message is empty or too long (max 4000 characters)")
    sid = str(hits[0]["id"])[len("codex-"):]
    exe = codex_exe(int(hits[0].get("pid") or 0))
    if exe:  # codex queue：開著的 Codex 閒置時會自己撿起來回（2026-11-09 實測，不用 --resume）
        try:
            home = str(hits[0].get("codexHome") or "")  # 照收件人自己的 CODEX_HOME 排（複驗第 8 項）
            env = {**os.environ, "CODEX_HOME": home} if home and ".." not in home else None
            r = subprocess.run([exe, "queue", "--thread", sid, "--message", mail_line(frm, text)], env=env,
                               capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=20)
            if r.returncode == 0:  # 排進去了，不等於已經讀到（複驗第 8 項：原本說閒著就會馬上回）
                return f"Queued in {hits[0].get('name')}'s Codex session: it is handled when that session is free (usually soon if idle)"
        except subprocess.TimeoutExpired:
            # 逾時不退回收件夾（0.63.15，審查第 8 項）：queue 可能其實已經排進去，退回會送兩次
            return f"codex queue did not answer in 20s; the message may still arrive in {hits[0].get('name')}'s session. Check before resending"
        except (OSError, subprocess.SubprocessError):
            pass
    INBOX.mkdir(parents=True, exist_ok=True)
    with open(INBOX / f"{sid}.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps({"from": frm, "text": text, "at": now_ms()}, ensure_ascii=False) + "\n")
    return f"codex queue unavailable; put in {hits[0].get('name')}'s inbox: delivered when its user next sends it a message"


CHAT_OUTBOX = BASE / "chat" / "outbox"


def chat_out(frm: dict, to: dict, text: str, extra: dict = None) -> None:
    """傳話記進協作桌聊天室（0.63.8）：寫一份待記，手機版伺服器（server.ts drainChatOutbox）照座位記到寄件人、收件人坐的桌。
    Claude 的外掛送出時自己記；Codex 這邊不知道座位，交給伺服器。失敗不影響傳話"""
    try:
        CHAT_OUTBOX.mkdir(parents=True, exist_ok=True)
        save(CHAT_OUTBOX / f"{now_ms()}-{uuid.uuid4().hex[:8]}.json", {"at": now_ms(), "from": frm, "to": to, "text": text[:20000], **(extra or {})})
    except Exception:
        pass


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
# 接手角色：說明寫明什麼時候用，不靠 skill 觸發（2026-11-14 實測：只說「接手」時 Codex 不讀也不存檢查點）。agy_office.py 有同一段
TAKEOVER_TOOL = {
    "name": "office_takeover",
    "description": "Use FIRST when the user says \"你是 <role>，接手\" / \"you are <role>, take over\" (a pixel-office role card). "
                   "Returns the role card, the previous holder's last checkpoint, the team status, and the steps to follow "
                   "(register with office_profile, report to the manager with office_send, append a checkpoint). "
                   "role: the role name the user said. cwd: your working folder (absolute).",
    "inputSchema": {"type": "object", "properties": {"role": {"type": "string"}, "cwd": {"type": "string"}}, "required": ["role"]}}


def find_script(name: str):
    """Claude 那半的 scripts/<name>：Codex／agy 外掛只複製自己的資料夾。先找同一個 repo，再找 Claude 外掛快取裡版號最大的"""
    here = Path(__file__).resolve().parent.parent / "scripts" / name
    if here.is_file():
        return here

    def ver(p):
        try:
            return tuple(int(x) for x in p.parent.parent.name.split("."))
        except ValueError:
            return ()
    hits = sorted((HOME / ".claude" / "plugins" / "cache" / "pixel-office" / "pixel-office").glob(f"*/scripts/{name}"), key=ver)
    return hits[-1] if hits else None


def run_takeover(kind: str, office_id: str, me: str, a: dict) -> str:
    role = str(a.get("role") or "").strip()
    if not role:
        raise ValueError("role is required: the role name the user said")
    script = find_script("takeover.py")
    if not script:
        raise ValueError("Claude Code's pixel-office plugin (scripts/takeover.py) is not on this computer: install it to use role cards")
    r = subprocess.run([sys.executable, str(script), role, "--kind", kind, "--as", me, "--id", office_id, "--cwd", str(a.get("cwd") or os.getcwd())],
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60, env={**os.environ, "PYTHONIOENCODING": "utf-8"})
    if "--kind" in r.stderr and "unrecognized" in r.stderr:
        raise ValueError(f"{script} is too old for {kind} (needs pixel-office 0.61.0+): ask the user to update the Claude Code plugin")
    return (r.stdout + ("\n" + r.stderr if r.stderr.strip() else "")).strip() or f"takeover.py exited {r.returncode} with no output"


# 「你是 X，接手」：只靠工具說明不穩（2026-11-14 同一句實測，一次叫了 office_takeover、一次直接說「已接手」），hook 直接提示
TAKEOVER_ASK = re.compile(r"你是\s*[「『]?\s*([^\s，,。「」『』]+?)\s*[」』]?\s*[，,、]?\s*(?:來)?接手|you are\s+(.+?)\s*,?\s*take over", re.I)


def takeover_hint(prompt: str) -> str:
    m = TAKEOVER_ASK.search(prompt or "")
    if not m:
        return ""
    role = (m.group(1) or m.group(2) or "").strip()
    return (f"Pixel office: the user asked you to take over the role \"{role}\". Call the MCP tool office_takeover(role=\"{role}\") FIRST, "
            "before anything else, then follow the steps it returns. Do not just say you took over.")

CP_REMIND_MS = 60 * 60000  # 跟 register.tsx 一樣：持有角色、做了事、一小時沒存 → 下一輪提醒一次


def took_role(out: str):
    """takeover.py 的輸出：接成了（有第 5 步的檢查點檔、沒有 STOP）回檢查點檔路徑，否則 None"""
    m = re.search(r"^5\. .*?在 (.+?\.md) 檔尾", out.split("# 接手後要做的")[-1], re.M)  # 只看最後那段：卡與檢查點內文不算
    return m.group(1) if m and not re.search("^STOP：", out, re.M) else None


def hold_role(p: Path, out: str) -> bool:
    """office_takeover 接成了：記下檢查點檔與起算時間，hook 照這個提醒（第 2 層卡沒有第 5 步＝不提醒；有 STOP＝沒接）。
    在鎖裡重讀再改；狀態檔忙（拿不到鎖）回 False"""
    cp = took_role(out)

    def fn(s):
        if cp:
            s.update({"cpFile": cp, "cpBase": now_ms(), "cpWorked": False, "cpNoted": False})
        else:  # 沒接成、第 2 層卡：先前接的角色也不再提醒
            for k in ("cpFile", "cpBase", "cpWorked", "cpNoted"):
                s.pop(k, None)
    return update_status(p, fn)


def cp_note(s: dict) -> str:
    """每則指令前：檔案比起算時間新＝剛存過，重新起算；做過事、滿一小時、這段沒提醒過 → 回提醒（會改 s，呼叫的人負責存）"""
    try:  # 出錯不能連累同一輪的收信
        f = s.get("cpFile")
        if not f:
            return ""
        try:
            m = int(os.path.getmtime(f) * 1000)
        except OSError:
            m = 0
        if m > int(s.get("cpBase") or 0):
            s.update({"cpBase": m, "cpWorked": False, "cpNoted": False})
        if s.get("cpWorked") and not s.get("cpNoted") and now_ms() - int(s.get("cpBase") or 0) >= CP_REMIND_MS:
            s["cpNoted"] = True
            return (f"Pixel office: you hold a role and have not saved a checkpoint for an hour. At a good stopping point append one entry "
                    f"to {f} (## YYYY-MM-DD HH:mm <you> / - 做完： / - 卡在： / - 下一步：).")
    except Exception:
        pass
    return ""


def compact_note(s: dict) -> str:
    """對話剛被壓縮（SessionStart source=compact）：有檢查點檔就提示先重讀最後一筆（Claude 端 register.tsx 的 /compact 同一個用意）"""
    f = s.get("cpFile")
    if not f:
        return ""
    return (f"Pixel office: your conversation was just compacted. Before continuing, re-read the last entry of your checkpoint {f} "
            "(做完／卡在／下一步) and pick up from 下一步. If the file does not exist yet, write one entry now.")


NAME_OK = re.compile(r"^[A-Za-z0-9]{1,12}$")
TOOLS = [
    {"name": "office_profile",
     "description": "Set your nameplate, job title and/or manager in the pixel office (shown to every Claude/agy/Codex session). "
                    "name: 1-12 ASCII letters/digits. title: what you are working on, max 16 chars, Chinese OK. "
                    "team: your manager's name from office_roster (you sit in its team); off to leave.",
     "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}, "title": {"type": "string"}, "team": {"type": "string"}}}},
    TAKEOVER_TOOL,
    {"name": "office_roster",
     "description": "List everyone online in the pixel office: nameplate, title, kind (Claude/agy/Codex), what they are doing. Use it to find who to message.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "office_send",
     "description": "Send a message to another session in the pixel office (Claude Code, agy or another Codex). to: the 'Send to' value from office_roster (a name that fits more than one person is refused).",
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
    name, title, team = a.get("name"), a.get("title"), a.get("team")
    if name is not None:
        name = str(name).strip()
        if not NAME_OK.match(name):
            raise ValueError("Nameplate must be 1-12 letters or digits")
        if any(c.get("name") == name and c.get("id") != f"codex-{sid}" for c in live_crew()):
            raise ValueError(f"Nameplate {name} is taken, pick another")
    if team is not None:
        team = str(team).strip()
    done = {}

    def fn(s):  # 在鎖裡重讀最新的狀態檔再改（第三輪複驗 ②）
        s["updatedAt"] = now_ms()  # 看守讀寫之間改的名牌不會被蓋回去
        if name is not None:
            s["name"] = name
        if title is not None:
            s.update(title=str(title).strip()[:16], titleAuto=False)
        if team is not None:  # 掛到主管底下（Claude 的 office_profile 同一欄）；off 或空字串拿掉
            if team.lower() in ("", "off"):
                s.pop("team", None)
            else:
                s["team"] = team[:64]
        done.update(s)
    if not update_status(p, fn):
        raise ValueError("The office status file is busy, nothing was saved. Call office_profile again in a moment.")
    return f"Registered: nameplate {done.get('name')}, title {done.get('title')}, team {done.get('team') or '—'}"


def tool_takeover(sid: str, a: dict) -> str:
    s = load(status_file(sid))
    out = run_takeover("codex", f"codex-{sid}", s.get("name") or "codex", {**a, "cwd": a.get("cwd") or s.get("cwd")})
    if not hold_role(status_file(sid), out):
        if took_role(out):  # 確認接成了：接手的步驟已經做了（有副作用），不叫它重接，只說提醒沒記下
            out += ("\n\n(Pixel office: the office status file was busy, so the hourly checkpoint reminder for this role was not recorded. "
                    "The takeover itself is done: do NOT call office_takeover again. Save checkpoints as the steps above say.)")
        else:  # 沒接成（STOP 等）：原本的指示照舊，只補一句
            out += "\n\n(Pixel office: the office status file was busy, so the reminder state was not updated.)"
    return out


def tool_roster() -> str:
    rows = ["| Name | Title | Kind | Send to | Now |", "|---|---|---|---|---|"]
    crew = live_crew()
    for s in sorted(crew, key=lambda c: str(c.get("name"))):
        kind = {"agy": "agy", "codex": "Codex"}.get(s.get("kind"), "Claude")
        to = s.get("agent") or s.get("name")
        if sum(to in (c.get("id"), c.get("agent"), c.get("name"), c.get("title")) for c in crew) > 1:
            to = s.get("id")  # 撞名就給 id，office_send 才對得到唯一一人
        rows.append(f"| {s.get('name')} | {s.get('title') or '—'} | {kind} | {to} | {s.get('mode')} {s.get('tool') or ''} |")
    return "\n".join(rows) if len(rows) > 2 else "Nobody in the office right now"


def tool_send(sid: str, a: dict) -> str:
    me = load(status_file(sid)).get("name") or "codex"
    to, text = str(a.get("to", "")), str(a.get("text", "")).strip()
    want = re.sub(r"\s*\[[0-9a-f]+\]$", "", to.strip())
    crew = live_crew()
    # 任一欄對到就算；對到兩人以上就拒絕，不猜（「Office」曾對到另一個 ListAgents 叫 Office 的人）
    hits = [s for s in crew if want in (s.get("id"), s.get("agent"), s.get("name"), s.get("title"))]
    if len(hits) != 1:
        pool = hits or crew
        names = "; ".join(f"{s.get('agent') or s.get('name')} (title {s.get('title') or '—'}, id {s.get('id')})" for s in pool)
        head = f"\"{to}\" matches {len(hits)} people, ask your user which one and resend with its id" if hits else f"Nobody called \"{to}\""
        raise ValueError(f"{head}. {'Candidates' if hits else 'Online'}: {names or 'nobody'}")
    if not text or len(text) > 4000:
        raise ValueError("Message is empty or too long (max 4000 characters)")
    s = hits[0]
    if s.get("id") == f"codex-{sid}":
        raise ValueError("That is you; pick someone else from office_roster")
    _LAST_NONCE[0] = ""
    r = _send_to(sid, me, s, text)
    # 聊天室待記標上送達狀態（0.63.20，複驗 C）：給 Claude 的帶佇列 nonce，伺服器等它收過才記；不確定、進收件夾的照實標
    extra = {"ack": {"kind": "claude", "id": s.get("id"), "nonce": _LAST_NONCE[0]}} if s.get("kind") not in ("codex", "agy") and _LAST_NONCE[0] else \
        {"state": "unsure"} if r.startswith("codex queue did not answer") else {"state": "inbox"} if "inbox" in r and not r.startswith("Queued") else {}
    chat_out({"id": f"codex-{sid}", "name": me}, {"id": s.get("id"), "name": s.get("agent") or s.get("name")}, text, extra)
    return r


_LAST_NONCE = [""]


def _send_to(sid: str, me: str, s: dict, text: str) -> str:
    if s.get("kind") == "codex":
        return deliver(str(s["id"]), text, me, hit=s)
    if s.get("kind") == "agy":
        box = BASE / "agy" / "inbox"
        box.mkdir(parents=True, exist_ok=True)
        with open(box / f"{str(s['id'])[len('agy-'):]}.jsonl", "a", encoding="utf-8") as f:
            f.write(json.dumps({"from": me, "text": text, "at": now_ms()}, ensure_ascii=False) + "\n")
        return f"Put in {s.get('name')}'s inbox: delivered on its next action"
    reply = f"python \"{CLI}\" send {sid} \"<reply>\" --from <your ListAgents name>"  # 用 session id：名牌會改、會撞
    _LAST_NONCE[0] = enqueue_command(str(s["id"]), {
        "nonce": uuid.uuid4().hex, "at": now_ms(), "from": f"{me} (Codex, not the user)",
        "text": f"{text}\n(Reply with {reply}; it reaches this Codex session right away)"})
    return f"Sent to {s.get('agent') or s.get('name')}: its plugin picks it up within a second; discarded if not picked up in 10 minutes. Its reply arrives as a new message in this conversation."


def enqueue_command(cid: str, item: dict) -> str:
    """commands/<id>.json 是佇列（0.63.17，複驗 D；跟 remote/server.ts enqueueCommand 同一套）：拿掉收過的、過期的，新的接在後面。
    寫的人共用一把鎖（0.63.22，最後複驗第 1 項）：commands/<id>.lock 資料夾，搶到才寫，5 秒以上的當成留下來的清掉。
    滿 20 則丟 ValueError（不靜默丟舊的）"""
    COMMANDS.mkdir(parents=True, exist_ok=True)
    lock = COMMANDS / f"{cid}.lock"
    got = False
    for _ in range(40):
        try:
            lock.mkdir()
            got = True
            break
        except FileExistsError:
            try:
                if time.time() - lock.stat().st_mtime > 5:
                    shutil.rmtree(lock, ignore_errors=True)
                    continue
            except OSError:
                pass
            time.sleep(0.05)
    if not got:
        raise ValueError("The recipient's inbox is busy, try again shortly")
    try:
        f = COMMANDS / f"{cid}.json"
        c, d = load(f), load(COMMANDS / f"{cid}.done.json")
        done = set(x for x in (d.get("nonces") or []) if isinstance(x, str)) | {d.get("nonce")}
        items = c.get("items") if isinstance(c.get("items"), list) else ([{k: c[k] for k in ("nonce", "text", "at", "from") if k in c}] if isinstance(c.get("nonce"), str) else [])
        now = int(time.time() * 1000)
        keep = [i for i in items if isinstance(i, dict) and i.get("nonce") not in done and now - (i.get("at") or 0) < 10 * 60 * 1000]
        if len(keep) >= 20:
            raise ValueError(f"The recipient still has {len(keep)} unread messages; wait for it to catch up before sending more")
        save(f, {**item, "items": keep + [item]})
        return item["nonce"]
    finally:
        shutil.rmtree(lock, ignore_errors=True)


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
            if name not in ("office_profile", "office_roster", "office_send", "office_takeover"):
                reply(mid, error={"code": -32602, "message": f"No such tool: {name}"})
                continue
            try:
                if name == "office_roster":
                    text = tool_roster()
                else:
                    sid = caller(params)
                    text = {"office_profile": tool_profile, "office_send": tool_send, "office_takeover": tool_takeover}[name](sid, args)
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
            owner0 = s.get("owner")
            st = owner_state(s)
            if st in ("other", "unknown"):  # 這段對話已經被接回某個 tmux、這個 hook 來自舊程序；或查不到：不蓋狀態、不標結束、保留 owner
                return
            if st == "gone":
                s.pop("owner", None)  # 確認失效才清
            if event == "SessionEnd":
                s.update({"left": True, "ended": True, "updatedAt": now})  # ended：Codex 自己說結束了（看守不會因為鎖還在就叫回來）
                save_if(p, s, owner0)
                return
            used = apply_preset(s, sid)
            mode, tool = state(event, d)
            cwd = str(d.get("cwd") or "")
            # 人事令先套（0.63.15，審查第 6 項）：同一個事件帶來的 cpFile，下面的壓縮提示、每小時提醒才看得到
            order = read_order(f"codex-{sid}", str(s.get("orderNonce") or ""))
            if order:
                apply_fields(s, order[1], order[0])
            tp = d.get("transcript_path")
            if isinstance(tp, str) and tp.endswith(".jsonl"):
                s["transcriptPath"] = tp  # 完整對話照這個讀（審查第 9 項：fork 出來的檔名是 …_<thread>.jsonl，掃資料夾找不到）
            s["codexHome"] = os.environ.get("CODEX_HOME") or str(HOME / ".codex")  # 寫入鎖照它自己的 home 看
            if event == "SessionStart" and d.get("source") == "compact":
                # 壓縮完：提示重讀自己的檢查點（0.63.6）。SessionStart 的輸出會進上下文（審查第 6 項：官方確認），只提示這一次
                out = compact_note(s)
            if event == "UserPromptSubmit":
                s.pop("cpAfterCompact", None)  # 舊版留下的
                out = "\n\n".join(x for x in (takeover_hint(str(d.get("prompt") or "")), take_mail(sid), cp_note(s)) if x)  # 純文字 stdout 會當成這一輪的額外上下文；prompt 只比對、不存
            if event == "PostToolUse" and s.get("cpFile") and "office_" not in tool:  # 接手、登記、報到不算做事
                s["cpWorked"] = True
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
                "mode": mode, "tool": tool, "updatedAt": now, "left": False, "ended": False,
                **({"cwd": cwd} if cwd else {}),  # office_takeover 沒給 cwd 時用
            })
            if s.get("modeWas") != mode:
                s["since"] = now
            s["modeWas"] = mode
            if not save_if(p, s, owner0):  # 讀完到現在 hr.ts 換了 owner：這一輪的狀態作廢
                return
            if used:
                used.unlink(missing_ok=True)
            if order:
                mark_order(f"codex-{sid}", *order)  # 存好了才記收過
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
    me = Path(__file__).resolve()

    def stamp():
        try:
            return me.stat().st_mtime
        except OSError:
            return None
    born = stamp()
    while True:
        # 外掛更新後（sync_cli 換掉了這支腳本）自己結束，下一個 hook 的 ensure_watch 會開新版的看守（0.63.15，審查第 10 項）
        if stamp() != born:
            pidf.unlink(missing_ok=True)
            ensure_watch()  # 自己開新版的接班，不用等下一個 hook（複驗第 10 項：閒著的 Codex 會斷心跳）
            return
        live = 0
        shared_now: dict = {}  # 這一輪：pid → 是不是共用的 App 程序（同一個 App 程序只查一次）
        try:
            pidf.write_text(f"{os.getpid()} {WATCH_VER}")
            # 同一個程序最近一次 hook 的時間（複驗第 9 項）：/new、fork 後同一個 Codex 程序換了 thread，舊的那筆放了鎖、
            # 程序卻還活著，原本會一直算在線
            newest: dict = {}
            for q in SESSIONS.glob("codex-*.json"):
                t = load(q)
                if t and not t.get("left") and t.get("pid"):
                    newest[int(t["pid"])] = max(newest.get(int(t["pid"]), 0), int(t.get("lastHook") or 0))
            for p in SESSIONS.glob("codex-*.json"):
                s = load(p)
                if not s:
                    continue
                if s.get("left"):
                    # 以鎖為準（2026-11-23）：被標離開、但對話的寫入鎖還握著（Desktop 開著、只是很久沒 hook 事件）→ 叫回來；
                    # Codex 自己送 SessionEnd 結束的（ended）不叫
                    if not s.get("ended") and writer_locked(str(s.get("id", ""))[len("codex-"):], str(s.get("codexHome") or "")) is True:
                        s.update(left=False, updatedAt=now_ms(), lastHook=now_ms())
                        save_if(p, s, s.get("owner"))
                        live += 1
                    continue
                was = s.get("updatedAt")
                pid = int(s.get("pid") or 0)
                held = writer_locked(str(s.get("id", ""))[len("codex-"):], str(s.get("codexHome") or ""))
                quiet = now_ms() - s.get("lastHook", s.get("updatedAt", 0))
                # 每輪重新判斷是不是共用的 App 程序（舊版寫的狀態檔 shared 可能是錯的）；共用的：只要鎖放了就當關了（2026-11-23）
                if pid and pid not in shared_now:
                    shared_now[pid] = shared_host(pid)
                shared = shared_now.get(pid, bool(s.get("shared")))
                if shared != bool(s.get("shared")):
                    s["shared"] = shared
                replaced = pid and int(s.get("lastHook") or 0) < newest.get(pid, 0)  # 同一個程序已經換到別的 thread
                if held is False and quiet > STALE_MS and (shared or replaced or not (pid and alive(pid))):
                    s["left"] = True  # 對話關了：Codex 放掉了它的寫入鎖（剛開的對話給 20 秒拿鎖）
                elif held is None and shared and quiet > SHARED_IDLE_MS:
                    s["left"] = True  # 看不到鎖、又是共用的常駐程式：太久沒事件就當離開
                elif held or (pid and alive(pid)):
                    live += 1
                    order = read_order(str(s.get("id", "")), str(s.get("orderNonce") or ""))  # 人事令（0.63.6）：閒著沒 hook 事件也在幾秒內生效
                    if order:  # 馬上單獨存（重讀最新的檔再改），不受下面「hook 寫過就不蓋」影響；存好了才記收過
                        apply_order_now(p, s, order)
                        continue  # 這一輪不再用舊的 s 存回（複驗第 3 項：會蓋掉 hook 剛寫的欄位）；下一輪重算
                    s["updatedAt"] = now_ms()
                    if s.get("mode") == "done" and now_ms() - s.get("since", 0) > DONE_MS:
                        s.update(mode="idle", modeWas="idle", since=now_ms())
                elif pid or now_ms() - s.get("updatedAt", 0) > STALE_MS:
                    s["left"] = True  # 程式結束；找不到程式的，hook 停了 20 秒也當離開
                else:
                    continue
                save_if(p, s, s.get("owner"), was)  # 讀完到現在 hook 或 hr.ts 寫過（updatedAt、owner 變了）就不蓋它；鎖裡比對再寫
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
    if os.name == "nt":  # Windows（0.64.6）：codex-win/ 啟動器，跑 Claude 外掛 cache 最新版的這支；Claude 外掛升版就跟著升
        win = Path(__file__).resolve().parent.parent / "codex-win"
        print("Run these yourself (they change your Codex config), then open Codex and pick Trust all once:")
        print("  codex plugin marketplace remove pixel-office-codex")
        print(f"  codex plugin marketplace add {win}")
        print("  codex plugin remove pixel-office@pixel-office-codex")
        print("  codex plugin add pixel-office@pixel-office-codex")
        print("The Windows plugin (codex-win) never changes: it runs codex/codex_office.py from the newest installed")
        print("Claude Code pixel-office plugin, so later upgrades (claude plugin update) need no reinstall and no new Trust all.")
        return
    stub = "~/.claude/pixel-office/release/codex-stub"  # 固定寫上線資料夾（trust 審查 ⑤：不從自己的位置推，同步副本、開發資料夾都印同一行）
    print("Run these yourself (they change your Codex config), then open Codex and pick Trust all once:")
    print("  codex plugin marketplace remove pixel-office-codex")
    print(f"  codex plugin marketplace add {stub}")
    print("  codex plugin remove pixel-office@pixel-office-codex")
    print("  codex plugin add pixel-office@pixel-office-codex")
    print("The Codex plugin (codex-stub) never changes: it runs ~/.claude/pixel-office/release/codex/codex_office.py,")
    print("so later pixel-office upgrades need no reinstall and no new Trust all.")


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
            target = find_codex(args[0])
            out = deliver(args[0], " ".join(args[1:]), frm, hit=target)
            print(out)
            # Claude 寄給 Codex 的也記進聊天室（--from 是 ListAgents 名稱，去掉「 [ref]」；伺服器照名稱找人）
            extra = {"state": "unsure"} if out.startswith("codex queue did not answer") else {"state": "inbox"} if "inbox" in out and not out.startswith("Queued") else {}
            chat_out({"name": re.sub(r"\s*\[[0-9a-f]+\]$", "", frm)}, {"id": target.get("id"), "name": target.get("name")}, " ".join(args[1:]), extra)
        except ValueError as e:
            sys.exit(str(e))
    elif cmd == "locked":  # 給手機版伺服器（交給 App／接回後台，0.63.28）：那段對話的寫入鎖有沒有人握著 → true／false／none
        r = writer_locked(sys.argv[2] if len(sys.argv) > 2 else "", sys.argv[3] if len(sys.argv) > 3 else "")
        print({True: "true", False: "false"}.get(r, "none"))
    else:
        {"install": install, "watch": watch, "mcp": mcp}.get(cmd, lambda: print(__doc__))()
