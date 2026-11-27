// 手機版人事室（2026-11-22 從使用者本機的客製伺服器併進來）：
//   招聘（開新對話）、調智力（換模型）、打斷／整理記憶／清空、解雇（結束並刪除對話）、員工檔案、薪水單（今天用量）、
//   完整對話（像 Claude app 一樣看整段）、升職／調部門、排班（每天幾點替某位員工送一道命令）
// 每位同事是哪種（狀態檔 addr 的 /tmp/cc-socks/<pid>.sock → <configDir>/sessions/<pid>.json）：
//   entrypoint=sdk-cli → 從 Claude app 開的（沒有終端機：換模型、打斷要靠對話裡的外掛，見 hooks/register.tsx 的「人事」段）
//   有 tmux 欄位       → 背景 tmux 裡的終端機對話：可以替他打 /model、/compact、按 Esc
// 招聘：Mac／Linux 開在 tmux；Windows 呼叫 scripts/open_role.py 開獨立視窗（hireWindows）。Codex 招聘只有 Mac／Linux
import { chmodSync, closeSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type Person = { id: string; name: string; agent?: string; code?: string; role?: string; team?: string }
export type HrDeps = {
  base: string
  /** 招聘用的設定資料夾（CLAUDE_CONFIG_DIR）與可選的上班地點 */
  hireConfigDir: () => string | undefined
  hireDirs: () => { name: string; path: string }[]
  people: () => Person[]
  sendCommand: (id: string, text: string, now?: number) => string | undefined
  port: () => number
  /** 整桌排班（0.62.13）：協作桌名字（找不到＝沒有這張桌）、到時間對這桌做事（server.ts 給） */
  tableName?: (table: number) => string | undefined
  tableRun?: (table: number, action: 'report' | 'meet', text: string, now: number) => { ok: boolean; msg: string }
}
let D: HrDeps
export function initHr(deps: HrDeps) {
  D = deps
  mkdirSync(join(D.base, 'hr'), { recursive: true })
}

export const MODELS: Record<string, string> = { fable: 'Fable 5.2', opus: 'Opus 5.5', sonnet: 'Sonnet 5.5', haiku: 'Haiku 5.5' }
// 對話裡的外掛改請求用完整名稱（別名只有 /model、--model 認）
const MODEL_ID: Record<string, string> = { fable: 'claude-fable-5-2', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5' }
const TMUX = ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find(p => existsSync(p))
const claudeBin = () => Bun.which('claude') ?? join(homedir(), '.local', 'bin', 'claude')
const dayOf = (t: number) => new Date(t).toLocaleDateString('sv-SE')

type Proc = { pid: number; sessionId: string; cwd: string; configDir: string; app: boolean; pane?: string; tmuxSession?: string; bridge?: string }

/** <configDir>/sessions/<pid>.json 裡 sessionId＝id 的那個 pid（同一份對話開兩次取最新的檔）；找不到回 undefined */
export function pidBySession(dir: string, id: string): number | undefined {
  let best: { pid: number; t: number } | undefined
  let names: string[] = []
  try { names = readdirSync(dir) } catch { return }
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue
    try {
      const f = join(dir, n), j = JSON.parse(readFileSync(f, 'utf8'))
      if (j.sessionId !== id) continue
      const pid = Number(n.slice(0, -5))
      try { process.kill(pid, 0) } catch (e: any) { if (e?.code !== 'EPERM') continue } // 強制結束會留下舊檔
      const t = statSync(f).mtimeMs
      if (!best || t > best.t) best = { pid, t }
    } catch {}
  }
  return best?.pid
}
function procOf(id: string): Proc | undefined {
  let s: any
  try { s = JSON.parse(readFileSync(join(D.base, 'sessions', `${id}.json`), 'utf8')) } catch { return }
  const m = /cc-socks\/(\d+)\.sock$/.exec(String(s.addr ?? ''))
  const cfg = String(s.configDir || join(homedir(), '.claude')).replace(/\/+$/, '') // 沒寫 configDir＝沒設 CLAUDE_CONFIG_DIR，用預設 ~/.claude（0.63.59，桌面 app 的對話）
  // Windows 的 addr 是 named pipe（\\.\pipe\LOCAL\cc-msg-<雜湊>），沒有 pid：改從 <cfg>/sessions/<pid>.json 用 sessionId 找（0.63.61）
  const pid = m ? Number(m[1]) : process.platform === 'win32' ? pidBySession(join(cfg, 'sessions'), id) : undefined
  if (!pid || !cfg) return
  let j: any
  try { j = JSON.parse(readFileSync(join(cfg, 'sessions', `${pid}.json`), 'utf8')) } catch { return }
  try { process.kill(pid, 0) } catch (e: any) { if (e?.code !== 'EPERM') return }
  const app = j.entrypoint === 'sdk-cli' || j.entrypoint === 'claude-desktop' // claude-desktop＝Windows 版 Claude Desktop 的分頁（0.63.62）
  const t = !app && typeof j.tmux === 'string' ? /^(.*):@\d+\.(%\d+)$/.exec(j.tmux) : null
  return { pid, sessionId: String(j.sessionId ?? ''), cwd: String(j.cwd ?? ''), configDir: cfg, app, pane: TMUX ? t?.[2] : undefined, tmuxSession: t?.[1],
    bridge: typeof j.bridgeSessionId === 'string' ? j.bridgeSessionId : undefined }
}
/**
 * 這位開在哪個 tmux pane（0.63.50，完整對話頁的「正在寫」擷取用）：Claude 看 sessions/<pid>.json 的 tmux 欄位，
 * Codex 看 codexProc（App 的共用程序沒有 pane）；App 分頁、agy、一般終端機都回 undefined（不擷取）
 */
export function paneFor(id: string, kind?: string): string | undefined {
  if (kind === 'codex') { const c = codexProc(id); return c && !c.shared ? c.pane : undefined }
  if (kind) return
  const p = procOf(id)
  return p && !p.app ? p.pane : undefined
}

// ---------- 對話裡的外掛（hooks/register.tsx「人事」段，舊名 po-hr）：寫 hr/<sessionId>.json，外掛每秒來拿，做完寫 .done.json；.alive.json 是心跳 ----------
const hrDir = () => join(D.base, 'hr')
function hrAlive(sessionId: string, now = Date.now()): { archive: boolean } | undefined {
  try {
    const j = JSON.parse(readFileSync(join(hrDir(), `${sessionId}.alive.json`), 'utf8'))
    return now - Number(j.at) < 30000 ? { archive: !!j.archive } : undefined
  } catch { return }
}
async function hrAsk(sessionId: string, req: Record<string, unknown>, waitMs = 10000): Promise<{ ok: boolean; msg: string } | undefined> {
  const nonce = crypto.randomUUID()
  writeFileSync(join(hrDir(), `${sessionId}.json`), JSON.stringify({ ...req, nonce, at: Date.now() }))
  const until = Date.now() + waitMs
  while (Date.now() < until) {
    await Bun.sleep(400)
    try {
      const d = JSON.parse(readFileSync(join(hrDir(), `${sessionId}.done.json`), 'utf8'))
      if (d.nonce === nonce && d.state === 'done') return { ok: !!d.ok, msg: String(d.msg ?? '') }
    } catch {}
  }
  return undefined
}
const NO_HR = '這位的對話還沒載入新版像素辦公室外掛：請在那個對話裡打 /reload-plugins（或重開一次對話），之後就能從這裡操作'

// ---------- 對話紀錄（<configDir>/projects/*/<sessionId>.jsonl）：一路往下讀（記住讀到哪），整理出最後用的模型、今天的用量、最近交代的事 ----------
// 第一次只讀最後 8 MB：很長的對話，今天早一點的用量可能沒算到
type Use = { i: number; o: number; cw: number; cr: number }
type Scan = { file: string; off: number; model?: string; day: string; usage: Map<string, Use>; asks: { text: string; at: number }[]; first?: number; hookSkip?: { by: string; at: number } }
const transcripts = new Map<string, string>()
const scans = new Map<string, Scan>()
const FIRST_READ = 8 * 1024 * 1024
function scan(p: Proc): Scan | undefined {
  let f = transcripts.get(p.sessionId)
  if (!f) {
    try {
      // 同一個對話換過工作資料夾時，兩個 projects 夾都會有同名紀錄：挑最近寫過的那份
      let best = 0
      for (const d of readdirSync(join(p.configDir, 'projects'))) {
        const x = join(p.configDir, 'projects', d, `${p.sessionId}.jsonl`)
        try { const t = statSync(x).mtimeMs; if (t > best) { best = t; f = x } } catch {}
      }
    } catch {}
    if (!f) return
    transcripts.set(p.sessionId, f)
  }
  let fd: number | undefined
  try {
    fd = openSync(f, 'r')
    const size = fstatSync(fd).size
    let s = scans.get(p.sessionId)
    if (!s || size < s.off) {
      s = { file: f, off: Math.max(0, size - FIRST_READ), day: dayOf(Date.now()), usage: new Map(), asks: [] }
      scans.set(p.sessionId, s)
    }
    const today = dayOf(Date.now())
    if (s.day !== today) { s.day = today; s.usage.clear() }
    if (size <= s.off) return s
    const buf = Buffer.alloc(size - s.off)
    readSync(fd, buf, 0, buf.length, s.off)
    let text = buf.toString('utf8')
    const skipFirst = s.off > 0 && s.first === undefined // 從檔案中間開始讀：第一行不完整
    const end = text.lastIndexOf('\n')
    if (end < 0) return s
    text = text.slice(0, end)
    s.off += Buffer.byteLength(text, 'utf8') + 1
    const lines = text.split('\n')
    if (skipFirst) lines.shift()
    s.first ??= Date.now()
    for (const line of lines) {
      if (line.includes('"subtype":"informational"') && line.includes('pixel-office: its classic.PermissionRequest hook was skipped')) {
        try { const j = JSON.parse(line), by = HOOK_SKIP.exec(String(j.content ?? '')); if (by) s.hookSkip = { by: by[1], at: Date.parse(j.timestamp) || Date.now() } } catch {}
        continue
      }
      if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"')) continue
      let j: any
      try { j = JSON.parse(line) } catch { continue }
      const at = Date.parse(j.timestamp) || 0
      const m = j.message
      if (j.type === 'assistant' && m) {
        if (typeof m.model === 'string' && !m.model.startsWith('<')) s.model = m.model
        const u = m.usage
        if (u && dayOf(at) === s.day && !j.isSidechain) s.usage.set(m.id ?? j.uuid, { i: u.input_tokens || 0, o: u.output_tokens || 0, cw: u.cache_creation_input_tokens || 0, cr: u.cache_read_input_tokens || 0 })
      } else if (j.type === 'user' && m && !j.isMeta && !j.isSidechain && !j.isCompactSummary) { // 壓縮摘要不是交代的事（0.63.62，完整對話那邊另顯示成 note）
        const c = m.content
        const t = typeof c === 'string' ? c : Array.isArray(c) && !c.some((x: any) => x?.type === 'tool_result') ? c.filter((x: any) => x?.type === 'text').map((x: any) => x.text).join(' ') : ''
        const clean = String(t).trim()
        if (clean && !clean.startsWith('<') && !clean.startsWith('[Request interrupted')) {
          s.asks.push({ text: clean.slice(0, 300), at })
          if (s.asks.length > 30) s.asks.shift()
        }
      }
    }
    return s
  } catch {
    return
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
const modelOf = (p: Proc) => scan(p)?.model
/**
 * 核准被擋（設計 windows-hire 7.）：別的 plugin 排在前面、把外掛的 classic.PermissionRequest 跳過時，Claude Code 在對話紀錄寫一行
 * {"type":"system","subtype":"informational","content":"pixel-office: its classic.PermissionRequest hook was skipped. \"<plugin>\" runs first…"}
 * （2026-11-26 在本機紀錄看到其他 classic.* 的同款字）。回擋住的 plugin 名；沒看到回 undefined
 */
export const HOOK_SKIP = /^pixel-office: its classic\.PermissionRequest hook was skipped\. "([^"]{1,80})" runs first/
export function hookSkipOf(id: string): string | undefined { const p = procOf(id); return p ? scan(p)?.hookSkip?.by : undefined }
function usageOf(p: Proc): Use {
  const t: Use = { i: 0, o: 0, cw: 0, cr: 0 }
  for (const u of scan(p)?.usage.values() ?? []) { t.i += u.i; t.o += u.o; t.cw += u.cw; t.cr += u.cr }
  return t
}
/** claude-opus-5-5 → Opus 5.5 */
export const prettyModel = (m?: string) => {
  if (!m) return undefined
  const x = /claude-([a-z]+)-(\d+)-(\d+)/.exec(m)
  return x ? `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}.${x[3]}` : m
}
// 剛換模型、下一輪還沒跑之前，紀錄裡還是舊的：先顯示「切換中」10 分鐘
const switching = new Map<string, { model: string; at: number; from?: string }>()

/** state.json 每個人多帶的人事欄位：host（app／tmux／other）、ctl（網頁能不能替他操作）、model、switching、usage */
export function hrOf(id: string, now = Date.now()) {
  const p = procOf(id)
  if (!p) return { host: 'unknown' as const, ...capUnknown }
  const actual = modelOf(p)
  const sw = switching.get(id)
  if (sw && (now - sw.at > 10 * 60000 || (actual && actual !== sw.from))) switching.delete(id)
  const pending = switching.get(id)
  const ctl = !!p.pane || !!hrAlive(p.sessionId, now)
  return { host: p.app ? 'app' as const : p.pane ? 'tmux' as const : 'other' as const, ctl, model: prettyModel(actual), switching: pending ? MODELS[pending.model] : undefined, usage: usageOf(p), ...modeOf(id, p, now), ...claudeCap(p, !!hrAlive(p.sessionId, now)) }
}

// 外部指令一律限時（0.62.16）：一個卡住的指令不能卡死整台伺服器；逾時 exitCode 不是 0，照失敗的退路走
export const EXT_TIMEOUT_MS = 3000
/**
 * Bun 在 Windows 閒置一分鐘以上後，第一次 spawnSync 的 timeout 會立刻觸發：6 毫秒就 SIGKILL，exitedDueToTimeout 也是 true；
 * 同一秒再叫一次就正常（2026-11-27 重現，像是用了閒置前的舊時間算逾時）。Windows 上實際沒到時間、也還沒有任何輸出 → 重試一次
 */
type SyncOpts = NonNullable<Parameters<typeof Bun.spawnSync>[1]>
export function spawnSyncW(argv: string[], opts: SyncOpts & { timeout?: number }, win = process.platform === 'win32', run: typeof Bun.spawnSync = Bun.spawnSync) {
  const t0 = Date.now()
  const r = run(argv, opts)
  if (!win || r.exitCode !== null || !opts.timeout || Date.now() - t0 >= opts.timeout - 500 || r.stdout?.length || r.stderr?.length) return r
  return run(argv, opts)
}
const tmuxRaw = (args: string[], stdin?: string) => Bun.spawnSync([TMUX ?? 'tmux', ...args], { stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin), stdout: 'pipe', stderr: 'pipe', timeout: EXT_TIMEOUT_MS, killSignal: 'SIGKILL' })
/**
 * tmux 3.8：伺服器上只要有一個唯讀的 client（tmux attach -r）連著，從外面下的 send-keys 一律回「client is read-only」
 * （2026-11-24 實測：使用者用 attach -r 看主管的 tmux 對話的那段時間，招聘的員工全都送不了按鍵）。
 * 退路：一般文字與 Enter 改用 load-buffer＋paste-buffer 貼進去（不經過 client）。貼上的控制字元 TUI 會當成字面
 * （實測 Codex：貼 ESC 變成「^[」、貼 Ctrl-U 變成「^U」），所以 Escape、方向鍵、Shift+Tab 沒有退路，回清楚的原因
 */
export const READONLY_TEXT = '有人用唯讀方式連著電腦上的 tmux（tmux attach -r），這時 tmux 不讓外面送按鍵：請關掉那個唯讀視窗再試'
export function keysAsBytes(args: string[]): { target: string; bytes: string } | undefined {
  const t = args.indexOf('-t')
  if (args[0] !== 'send-keys' || t < 0) return
  const rest = args.slice(1).filter((_, i) => i !== t - 1 && i !== t)
  if (rest[0] === '-l') return rest.length > 1 && !/[\x00-\x1f\x7f]/.test(rest.slice(1).join(' ')) ? { target: args[t + 1], bytes: rest.slice(1).join(' ') } : undefined
  return rest.length > 0 && rest.every(k => k === 'Enter') ? { target: args[t + 1], bytes: '\r'.repeat(rest.length) } : undefined
}
let readonlySeen = 0
/** 最近 1 分鐘碰過唯讀 client：送按鍵失敗時拿來說明原因 */
export const tmuxReadonly = () => Date.now() - readonlySeen < 60e3
const tmux = (...args: string[]) => {
  const r = tmuxRaw(args)
  if (r.exitCode === 0 || !/read-only/.test(r.stderr.toString())) return r
  readonlySeen = Date.now()
  const k = keysAsBytes(args)
  if (!k) return r
  const buf = `po-key-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  if (tmuxRaw(['load-buffer', '-b', buf, '-'], k.bytes).exitCode !== 0) return r
  return tmuxRaw(['paste-buffer', '-d', '-b', buf, '-t', k.target])
}
const nameOf = (id: string) => D.people().find(c => c.id === id)?.name ?? '這位'

/** 招聘。opts.cwd：自動多開幫手（helpers.ts）用主管的工作資料夾，不限 hireDirs（請求來自本機外掛、使用者按了「加」） */
/** --add-dir 要帶的資料夾：存在的才帶（不存在先建），去重；建不起來的略過 */
export function addDirArgs(dirs: (string | undefined)[] = [], cwd?: string): string[] {
  const out: string[] = []
  for (const d of dirs) {
    if (!d || d === cwd || out.includes(d)) continue
    try { mkdirSync(d, { recursive: true }) } catch { continue }
    out.push(d)
  }
  return out.flatMap(d => ['--add-dir', d])
}

/**
 * opts.addDirs：坐協作桌的人要讀寫的資料夾（這桌的協作資料夾：議題、檢查點、會議都在底下）。
 * 開 claude 時帶 --add-dir，免得每讀一次工作資料夾外的檔就停下來問（0.62.16）
 */
export function hire(b: any, opts: { cwd?: string; addDirs?: (string | undefined)[] } = {}): { ok: boolean; text: string; sid?: string; need?: string } {
  if (process.platform === 'win32') return hireWindows(b, opts)
  if (!TMUX) return { ok: false, text: '這台電腦沒有 tmux，招聘目前只支援 Mac／Linux' }
  const name = String(b?.name ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim()
  if (!name || [...name].length > 20) return { ok: false, text: '名字要 1～20 個字' }
  const model = String(b.model ?? 'sonnet')
  if (!(model in MODELS)) return { ok: false, text: '不認得的智力等級' }
  const dirs = D.hireDirs()
  const dir = opts.cwd && existsSync(opts.cwd) ? { name: opts.cwd, path: opts.cwd } : dirs.find(d => d.path === b.dir) ?? dirs[0]
  const team = typeof b.team === 'string' && b.team.trim() ? b.team.trim().slice(0, 60) : undefined
  let task = typeof b.task === 'string' ? b.task.trim().slice(0, 4000) : ''
  if (task && team) task += `。開你的是 ${team}，它是你的主管，有事向它回報`
  if (task.startsWith('-')) task = `任務：${task}`
  const mode = claudeModeArgs(b)
  if (typeof mode === 'string') return { ok: false, text: mode }
  const sid = crypto.randomUUID()
  // 預先登記名牌、職稱、主管（register.tsx 的 applyPreset 套用）
  mkdirSync(join(D.base, 'presets'), { recursive: true })
  writeFileSync(join(D.base, 'presets', `${sid}.json`), JSON.stringify({ title: [...(typeof b.title === 'string' && b.title.trim() ? b.title.trim() : name)].slice(0, 16).join(''), role: b.role === 'manager' ? 'manager' : 'staff', ...(team ? { team } : {}) }))
  const cfg = D.hireConfigDir()
  const r = tmux('new-session', '-d', '-s', `po-${sid.slice(0, 8)}`, '-c', dir.path,
    'env', '-u', 'CLAUDE_CODE_CHILD_SESSION', '-u', 'ANTHROPIC_API_KEY', '-u', 'CLAUDECODE', ...(cfg ? [`CLAUDE_CONFIG_DIR=${cfg}`] : []),
    claudeBin(), '--name', name, ...addDirArgs(opts.addDirs, dir.path), '--remote-control', name, '--model', model, ...mode.args, '--session-id', sid, ...(b.chrome === true ? ['--chrome'] : []), ...(task ? [task] : []))
  if (r.exitCode !== 0) return { ok: false, text: `開不起來：${r.stderr.toString().trim() || r.exitCode}` }
  watchHire(`po-${sid.slice(0, 8)}`, name)
  ctlSet(sid, { effort: mode.effort, perm: mode.perm })
  return { ok: true, text: `🧑‍💼 招聘了 ${name}（${MODELS[model]}${b.chrome === true ? '，可以操作瀏覽器' : ''}），大約十幾秒後進辦公室`, sid }
}

// ---------- Windows 招聘（設計 windows-hire 第 1 期）：沒有 tmux，改呼叫 scripts/open_role.py 開一個獨立的 PowerShell 視窗 ----------
// 抓不到畫面：開之前看資料夾信任過沒（最常見的卡點），開了 90 秒還沒進辦公室就在通知卡提醒到電腦看那個視窗
export const OPEN_ROLE = join(import.meta.dir, '..', 'scripts', 'open_role.py')
export type OpenRoleRun = (args: string[], env: Record<string, string | undefined>) => { code: number | null; out: string; err: string; sig?: string; ms?: number }
/** python -I 不讀 PYTHONUTF8，roles.py 讀子程序輸出會用 cp950 解碼炸掉（2026-11-26 實測）：一定要帶 -X utf8 */
export const openRoleArgv = (args: string[]) => [Bun.which('python') ?? Bun.which('py') ?? 'python', '-X', 'utf8', '-I', OPEN_ROLE, ...args]
export const OPEN_ROLE_MS = 20000
let openRoleRun: OpenRoleRun = (args, env) => {
  const t0 = Date.now()
  try {
    const r = spawnSyncW(openRoleArgv(args), { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: OPEN_ROLE_MS, killSignal: 'SIGKILL' })
    return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString(), sig: r.signalCode ?? undefined, ms: Date.now() - t0 }
  } catch (e: any) { return { code: null, out: '', err: `叫不起 python：${e?.message ?? e}`, ms: Date.now() - t0 } }
}
/** 測試換成假的 open_role（回傳原本的） */
export function _setOpenRoleRun(fn: OpenRoleRun): OpenRoleRun { const old = openRoleRun; openRoleRun = fn; return old }

/** 呼叫 open_role.py --json：回 { sid, pid } 或錯誤字 */
export function runOpenRole(args: string[], cfgDir?: string): { sid: string; pid?: number } | { error: string; code?: number } {
  const r = openRoleRun([...args, '--json'], { ...process.env, ...(cfgDir ? { CLAUDE_CONFIG_DIR: cfgDir } : {}) })
  const last = r.out.trim().split('\n').pop() ?? ''
  try {
    const j = JSON.parse(last)
    // 印出 sid＝預先登記寫了、視窗開了（open_role.py 最後一步才印）：之後才被中斷也算開成，不然手機會再開一份
    if (typeof j?.sid === 'string' && j.dry_run !== true) return { sid: j.sid, pid: typeof j.pid === 'number' ? j.pid : undefined }
    if (typeof j?.error === 'string') return { error: j.error, code: typeof j.code === 'number' ? j.code : r.code ?? undefined }
  } catch {}
  const tail = r.err.trim().split('\n').slice(-3).map(l => l.trim()).join(' / ').slice(-300)
  if (r.code === null) { // 結束碼 null：逾時被砍，或被訊號／當掉中斷（W3 實測 3 秒就 null）；看得到的都帶給手機
    if ((r.ms ?? 0) >= OPEN_ROLE_MS - 500) return { error: '開窗程式 20 秒沒有回應，電腦上可能沒開出視窗' }
    return { error: `開窗程式被中斷（訊號 ${r.sig ?? '無'}、${r.ms ?? '?'} 毫秒）${tail ? '：' + tail : '，沒有錯誤訊息'}；電腦上可能沒開出視窗` }
  }
  return { error: (tail || `open_role.py 結束碼 ${r.code}`).slice(0, 300), code: r.code }
}

/**
 * 這個資料夾在 Claude Code 信任過沒（設定檔 .claude.json 的 projects.<路徑>.hasTrustDialogAccepted）。
 * 照 Claude Code 的正式判斷（2026-11-26 讀 claude 2.x 的 Rh()）：從這層往上找，任何一層信任過就算；
 * 但資料夾在 git repo 裡時只找到 git 根目錄為止（實測：家目錄信任過，底下新 git init 的資料夾 claude 照樣問）。
 * 讀不到設定檔回 undefined（不擋）。只讀，不改
 */
export function folderTrusted(dir: string, cfgDir?: string, home = homedir()): boolean | undefined {
  let projects: Record<string, any>
  try { projects = JSON.parse(readFileSync(join(cfgDir || home, '.claude.json'), 'utf8'))?.projects ?? {} } catch { return }
  const win = /^[A-Za-z]:/.test(dir)
  // 路徑統一成正斜線、去掉結尾斜線（根目錄留 / 或 C:/）；Windows 不分大小寫
  const norm = (p: string) => { const s = p.replace(/\\/g, '/').replace(/\/+$/, ''); const t = s === '' || /^[A-Za-z]:$/.test(s) ? s + '/' : s; return win ? t.toLowerCase() : t }
  const trusted = new Set(Object.entries(projects).filter(([, v]) => v?.hasTrustDialogAccepted === true).map(([k]) => norm(k)))
  const parts = dir.replace(/\\/g, '/').replace(/\/+$/, '').split('/')
  const at = (i: number) => parts.slice(0, i).join('/') || '/'
  let stop = 1 // git 根目錄（有 .git 資料夾或檔案的那層）：找到就不再往上
  for (let i = parts.length; i >= 1; i--) if (existsSync(join(at(i), '.git'))) { stop = i; break }
  for (let i = parts.length; i >= stop; i--) if (trusted.has(norm(at(i)))) return true
  return false
}

export const TRUST_TEXT = (path: string, name?: string) => `${name && name !== path ? `「${name}」（${path}）` : `「${path}」`}這個資料夾還沒在 Claude Code 信任過：開了會停在「要不要信任這個資料夾」，要到電腦上按。`

/** Windows 版招聘：參數檢查與 hire() 相同，開視窗交給 open_role.py（預先登記也由它寫） */
export function hireWindows(b: any, opts: { cwd?: string; addDirs?: (string | undefined)[]; cpFile?: string } = {}): { ok: boolean; text: string; sid?: string; need?: string } {
  const name = String(b?.name ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim()
  if (!name || [...name].length > 20) return { ok: false, text: '名字要 1～20 個字' }
  if (b?.agent === 'agy') return hireAgyWin(b, name, opts)
  if (b?.agent === 'codex') return hireCodexWin(b, name, opts)
  const model = String(b.model ?? 'sonnet')
  if (!(model in MODELS)) return { ok: false, text: '不認得的智力等級' }
  const dirs = D.hireDirs()
  const dir = opts.cwd && existsSync(opts.cwd) ? { name: opts.cwd, path: opts.cwd } : dirs.find(d => d.path === b.dir) ?? dirs[0]
  if (!dir) return { ok: false, text: '沒有可以上班的資料夾（remote.json 的 hireDirs）' }
  const team = typeof b.team === 'string' && b.team.trim() ? b.team.trim().slice(0, 60) : undefined
  const task = typeof b.task === 'string' ? b.task.trim().slice(0, 4000) : ''
  const mode = claudeModeArgs(b)
  if (typeof mode === 'string') return { ok: false, text: mode }
  const cfg = D.hireConfigDir()
  if (b.trustOk !== true && folderTrusted(dir.path, cfg) === false) return { ok: false, need: 'trust', text: TRUST_TEXT(dir.path, dir.name) }
  const sid = crypto.randomUUID()
  const title = [...(typeof b.title === 'string' && b.title.trim() ? b.title.trim() : name)].slice(0, 16).join('')
  let taskFile: string | undefined
  if (task) { taskFile = join(hrDir(), `task-${sid}.txt`); mkdirSync(hrDir(), { recursive: true }); writeFileSync(taskFile, task) }
  const add = addDirArgs(opts.addDirs, dir.path).filter((_, i) => i % 2 === 1)
  const r = (() => {
    try {
      return runOpenRole(['--role', name, '--name-only', '--dir', dir.path, '--session-id', sid, '--title', title, '--role-type', b.role === 'manager' ? 'manager' : 'staff',
        ...(team ? ['--team', team] : []), '--model', model, ...mode.args, ...add.flatMap(d => ['--add-dir', d]), '--remote-control', ...(b.chrome === true ? ['--chrome'] : []),
        ...(taskFile ? ['--task-file', taskFile] : [])], cfg)
    } finally { if (taskFile) rmSync(taskFile, { force: true }) }
  })()
  if ('error' in r) return { ok: false, text: `開不起來：${r.error}` }
  if (r.pid) winLaunchSet(r.sid, r.pid)
  watchWinHire(r.sid, name, r.pid, undefined, undefined, undefined, dir.path)
  ctlSet(r.sid, { effort: mode.effort, perm: mode.perm })
  return { ok: true, text: `🧑‍💼 招聘了 ${name}（${MODELS[model]}${b.chrome === true ? '，可以操作瀏覽器' : ''}），電腦上開了一個標題「${name}」的視窗，大約十幾秒後進辦公室`, sid: r.sid }
}
/**
 * 這間辦公室在 Windows 開的視窗（sid → 外層 PowerShell 的 pid）：解雇時 claude 結束了，-NoExit 的視窗還留著，
 * 要一起關。存檔是因為伺服器重開後還要認得；留 7 天
 */
const winLaunchFile = () => join(hrDir(), 'win-launch.json')
export function winLaunches(): Record<string, { pid: number; at: number }> { try { return JSON.parse(readFileSync(winLaunchFile(), 'utf8')) ?? {} } catch { return {} } }
export function winLaunchSet(sid: string, pid: number, now = Date.now()) {
  try {
    const all = Object.fromEntries(Object.entries(winLaunches()).filter(([, v]) => now - v.at < 7 * 86400e3))
    all[sid] = { pid, at: now }
    mkdirSync(hrDir(), { recursive: true }); writeFileSync(winLaunchFile(), JSON.stringify(all))
  } catch {}
}
/** 程序的父程序 pid（Windows：Get-CimInstance；查不到回 undefined） */
export type ParentOf = (pid: number) => number | undefined
export const parentPidWin: ParentOf = pid => {
  const r = spawnSyncW(['powershell', '-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Math.floor(pid)}").ParentProcessId`], { stdout: 'pipe', stderr: 'ignore', timeout: 8000, killSignal: 'SIGKILL' })
  const n = Number(r.stdout.toString().trim())
  return r.exitCode === 0 && n > 0 ? n : undefined
}
/**
 * 解雇前呼叫：這位是這間辦公室在 Windows 開的、而且記下的 PowerShell 現在還是他的父程序 → 回那個 pid（claude 結束後一起關掉視窗）。
 * 對不上（pid 被別的程序重用、/clear 換了編號、不是我們開的）回 undefined，只結束 claude
 */
export function winWindowOf(sid: string, claudePid: number, parentOf: ParentOf = parentPidWin): number | undefined {
  const rec = winLaunches()[sid]
  if (!rec) return
  return parentOf(claudePid) === rec.pid ? rec.pid : undefined
}
/**
 * 從角色卡叫人（手機「叫他的團隊成員」「開專案」，設計 windows-hire 4.）：卡、資料夾、主管由伺服器從 cards.py 的清單挑好才進來。
 * Windows → open_role.py（帶 --card；它自己擋「已經在線」→ 結束碼 3）；Mac／Linux → hire() 帶「你是 <角色>，接手。角色卡：…」
 */
export function summonRole(o: { name: string; card: string; cwd: string; team?: string; manager?: boolean; b: any }): { ok: boolean; text: string; sid?: string; need?: string; online?: boolean } {
  if (o.b?.agent === 'codex' && process.platform === 'win32') { // 0.64.6：用 Codex 開這個角色（Windows；Mac／Linux 照舊只開 Claude）
    if (!codexInstalled()) return { ok: false, text: '這台電腦沒有 codex 指令（先裝 Codex CLI）' }
    if (o.manager) return { ok: false, text: 'Codex 先只能當員工，主管請用 Claude 開' }
    if (!existsSync(o.cwd)) return { ok: false, text: `資料夾不存在：${o.cwd}` }
    const a = codexArgsWin({ perm: o.b?.perm, effort: o.b?.effort, model: o.b?.codexModel })
    if (typeof a === 'string') return { ok: false, text: a }
    const r = runOpenRole(['--agent', 'codex', '--role', o.name, '--dir', o.cwd, '--card', o.card, '--role-type', 'staff', ...(o.team ? ['--team', o.team] : []),
      ...(a.model ? ['--model', a.model] : []), ...a.mode.args.map(x => `--agent-arg=${x}`)])
    if ('error' in r) return r.code === 3 ? { ok: false, online: true, text: `${o.name} 已經在線：改傳話給他` } : { ok: false, text: `開不起來：${r.error}` }
    if (r.pid) winLaunchSet(r.sid, r.pid)
    watchWinHire(r.sid, o.name, r.pid, undefined, undefined, undefined, o.cwd)
    return { ok: true, text: `📇 用 Codex 叫了 ${o.name}${o.team ? `（掛在 ${o.team} 底下）` : ''}：電腦上開了一個標題「${o.name}」的 Codex 視窗；會花 ChatGPT 的用量`, sid: r.sid }
  }
  if (o.b?.agent === 'agy') { // 0.64.5：用 agy 開這個角色（開場句一樣是「你是 X，接手。角色卡：…」，agy 外掛有 office_takeover）
    if (!agyInstalled()) return { ok: false, text: '這台電腦沒有 agy（Antigravity CLI）' }
    if (o.manager) return { ok: false, text: 'agy 先只能當員工，主管請用 Claude 開' }
    if (!existsSync(o.cwd)) return { ok: false, text: `資料夾不存在：${o.cwd}` }
    const mode = agyModeArgs({ ...o.b, model: o.b?.agyModel })
    if (typeof mode === 'string') return { ok: false, text: mode }
    const r = runOpenRole(['--agent', 'agy', '--role', o.name, '--dir', o.cwd, '--card', o.card, '--role-type', 'staff', ...(o.team ? ['--team', o.team] : []), ...mode.args])
    if ('error' in r) return r.code === 3 ? { ok: false, online: true, text: `${o.name} 已經在線：改傳話給他` } : { ok: false, text: `開不起來：${r.error}` }
    if (r.pid) winLaunchSet(r.sid, r.pid)
    watchWinHire(r.sid, o.name, r.pid, undefined, undefined, undefined, o.cwd)
    return { ok: true, text: `📇 用 agy 叫了 ${o.name}${o.team ? `（掛在 ${o.team} 底下）` : ''}：電腦上開了一個標題「${o.name}」的 agy 視窗；會花 Google 的用量`, sid: r.sid }
  }
  const model = String(o.b?.model ?? 'opus')
  if (!(model in MODELS)) return { ok: false, text: '不認得的智力等級' }
  const mode = claudeModeArgs(o.b)
  if (typeof mode === 'string') return { ok: false, text: mode }
  if (!existsSync(o.cwd)) return { ok: false, text: `資料夾不存在：${o.cwd}` }
  if (process.platform !== 'win32')
    return hire({ name: o.name, model, effort: mode.effort, perm: mode.perm, role: o.manager ? 'manager' : 'staff', team: o.team, task: `你是 ${o.name}，接手。角色卡：${o.card}` }, { cwd: o.cwd })
  const cfg = D.hireConfigDir()
  if (o.b?.trustOk !== true && folderTrusted(o.cwd, cfg) === false) return { ok: false, need: 'trust', text: TRUST_TEXT(o.cwd) }
  const r = runOpenRole(['--role', o.name, '--dir', o.cwd, '--card', o.card, '--role-type', o.manager ? 'manager' : 'staff', ...(o.team ? ['--team', o.team] : []),
    '--model', model, ...mode.args, '--remote-control'], cfg)
  if ('error' in r) return r.code === 3 ? { ok: false, online: true, text: `${o.name} 已經在線：改傳話給他` } : { ok: false, text: `開不起來：${r.error}` }
  if (r.pid) winLaunchSet(r.sid, r.pid)
  watchWinHire(r.sid, o.name, r.pid, undefined, undefined, undefined, o.cwd)
  ctlSet(r.sid, { effort: mode.effort, perm: mode.perm })
  return { ok: true, text: `📇 叫了 ${o.name}${o.team ? `（掛在 ${o.team} 底下）` : ''}：電腦上開了一個標題「${o.name}」的視窗，大約十幾秒後進辦公室`, sid: r.sid }
}
/**
 * agy（Antigravity CLI）的招聘、叫角色（0.64.5，jacky 11-27「先做 agy」；只有 Windows）：open_role.py --agent agy 開一個跑 agy 的視窗。
 * 開之前不知道它的對話 id：open_role.py 回暫代 id（agp-<8 碼>），預先登記（名牌、職稱、主管、launch）由 agy 外掛開場時套用；
 * 座位先釘在暫代 id，它上線後 server 的 resolveAgyPins 照 launch 換過去。手機不能替它按允許、換模型（agyCap），只能傳話
 */
export const AGY_PERMS = [
  { v: 'auto', name: '自動', desc: 'agy 自己判斷要不要問' },
  { v: 'default', name: '手動', desc: '照 agy 預設，動作前會問' }, // 不是手機頁招的預設用這個（hirePerm）；open_role.py 不帶 --mode
  { v: 'acceptEdits', name: '接受編輯', desc: '自動接受檔案編輯' },
  { v: 'plan', name: '規劃', desc: '先規劃、不動檔案' },
] as const
export function agyModeArgs(b: any): { args: string[] } | string {
  const model = b?.model === undefined || b?.model === '' || b?.model === 'default' ? undefined : String(b.model)
  const effort = b?.effort === undefined || b?.effort === '' ? undefined : String(b.effort)
  const perm = b?.perm === undefined || b?.perm === '' ? 'auto' : String(b.perm)
  if (model !== undefined && !/^[A-Za-z0-9][\w.\-]{0,63}$/.test(model)) return '不認得的模型'
  if (effort !== undefined && !has(EFFORTS, effort)) return '不認得的投入程度'
  if (!AGY_PERMS.some(p => p.v === perm)) return '不認得的模式'
  return { args: [...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []), '--permission-mode', perm] }
}
/** 這台電腦有沒有 agy（PATH 上，或 %LOCALAPPDATA%\agy\bin\agy.exe）；只有 Windows 能從手機開 */
export function agyInstalled(): boolean {
  if (process.platform !== 'win32') return false
  return !!(Bun.which('agy') || (process.env.LOCALAPPDATA && existsSync(join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe'))))
}
/** agy models 的清單（第一次叫時在背景跑，之後用快取；還沒拿到回空的，手機只顯示「agy 預設」） */
let agyModelCache: { slug: string; name: string }[] | undefined, agyModelAsk = false
export function agyModels(): { slug: string; name: string }[] {
  if (!agyModelCache && !agyModelAsk && agyInstalled()) {
    agyModelAsk = true
    ;(async () => {
      try {
        const p = Bun.spawn(['agy', 'models'], { stdout: 'pipe', stderr: 'ignore', stdin: 'ignore' })
        const t = setTimeout(() => p.kill(), 30e3)
        const out = await new Response(p.stdout).text(); clearTimeout(t)
        const l = out.split(/\r?\n/).map(x => /^(\S+)\t(.+)$/.exec(x.trim())).filter((m): m is RegExpExecArray => !!m).map(m => ({ slug: m[1], name: m[2].trim() }))
        if (l.length) agyModelCache = l; else agyModelAsk = false
      } catch { agyModelAsk = false }
    })()
  }
  return agyModelCache ?? []
}
/** 照暫代 id 找已上線的 agy／Codex（狀態檔的 launch，agy_office.py／codex_office.py 的 apply_preset 寫的）：回它的辦公室 id（agy-…／codex-…） */
export const LAUNCH_PREFIX = /^(agp|cxw)-[0-9a-f]{8}$/
export function agyByLaunch(launch: string, dir = join(D.base, 'sessions')): string | undefined {
  let names: string[] = []
  try { names = readdirSync(dir).filter(n => /^(agy|codex)-/.test(n) && n.endsWith('.json')) } catch { return }
  for (const n of names) {
    try { const s = JSON.parse(readFileSync(join(dir, n), 'utf8')); if (s?.launch === launch && !s.left && typeof s.id === 'string') return s.id } catch {}
  }
}
function hireAgyWin(b: any, name: string, opts: { cwd?: string; addDirs?: (string | undefined)[] }): { ok: boolean; text: string; sid?: string } {
  if (!agyInstalled()) return { ok: false, text: '這台電腦沒有 agy（Antigravity CLI）' }
  if (b.role === 'manager') return { ok: false, text: 'agy 先只能當員工或行政' }
  const mode = agyModeArgs(b)
  if (typeof mode === 'string') return { ok: false, text: mode }
  const dirs = D.hireDirs()
  const dir = opts.cwd && existsSync(opts.cwd) ? { name: opts.cwd, path: opts.cwd } : dirs.find(d => d.path === b.dir) ?? dirs[0]
  if (!dir) return { ok: false, text: '沒有可以上班的資料夾（remote.json 的 hireDirs）' }
  const team = typeof b.team === 'string' && b.team.trim() ? b.team.trim().slice(0, 60) : undefined
  const task = typeof b.task === 'string' ? b.task.trim().slice(0, 4000) : ''
  const title = [...(typeof b.title === 'string' && b.title.trim() ? b.title.trim() : name)].slice(0, 16).join('')
  const plate = /^[A-Za-z0-9]{1,12}$/.test(name) ? name : undefined
  let taskFile: string | undefined
  if (task) { taskFile = join(hrDir(), `task-agy-${crypto.randomUUID()}.txt`); mkdirSync(hrDir(), { recursive: true }); writeFileSync(taskFile, task) }
  const add = addDirArgs(opts.addDirs, dir.path).filter((_, i) => i % 2 === 1)
  const r = (() => {
    try {
      return runOpenRole(['--agent', 'agy', '--role', name, '--name-only', '--dir', dir.path, '--title', title, '--role-type', 'staff', ...(plate ? ['--plate', plate] : []),
        ...(team ? ['--team', team] : []), ...mode.args, ...add.flatMap(d => ['--add-dir', d]), ...(taskFile ? ['--task-file', taskFile] : [])])
    } finally { if (taskFile) rmSync(taskFile, { force: true }) }
  })()
  if ('error' in r) return { ok: false, text: `開不起來：${r.error}` }
  if (r.pid) winLaunchSet(r.sid, r.pid)
  watchWinHire(r.sid, name, r.pid, undefined, undefined, undefined, dir.path)
  return { ok: true, text: `🧑‍💼 招聘了 agy ${name}：電腦上開了一個標題「${name}」的 agy 視窗，它第一次動作後進辦公室；會花 Google 的用量`, sid: r.sid }
}
/**
 * Windows 招聘 Codex（0.64.6，jacky 11-27「你做好我到codex 上面按即可」）：open_role.py --agent codex 開一個跑 `codex --no-daemon` 的視窗。
 * 跟 agy 一樣靠 PO_PRESET 事先登記（職稱、主管、檢查點、名牌、launch），座位先釘暫代 id（cxw-），上線後換過去。
 * 沒有 tmux：手機不能替它按允許、換模型、按鍵、交給 App，只能傳話（codex queue）。要裝 codex-win 外掛（使用者按一次 Trust all）才進得了辦公室
 */
export const codexInstalled = () => process.platform === 'win32' ? !!Bun.which('codex') : existsSync(codexBin())
function codexArgsWin(b: any): { model: string; mode: { args: string[]; effort?: string; perm: string } } | string {
  const model = typeof b?.model === 'string' && b.model && b.model !== 'default' ? b.model : ''
  if (model && (!SLUG.test(model) || !codexAllModels().some(m => m.slug === model))) return '不認得的智力等級'
  const mode = codexModeArgs(b)
  if (typeof mode === 'string') return mode
  if (mode.effort) {
    const m = model || codexModels()[0]?.slug, lv = codexEffortsOf(m)
    if (lv && !lv.includes(mode.effort)) return `${m} 沒有這個投入程度`
  }
  return { model, mode }
}
function hireCodexWin(b: any, name: string, opts: { cwd?: string; addDirs?: (string | undefined)[]; cpFile?: string }): { ok: boolean; text: string; sid?: string } {
  if (!codexInstalled()) return { ok: false, text: '這台電腦沒有 codex 指令（先裝 Codex CLI）' }
  if (b.role === 'manager') return { ok: false, text: '主管只能是 Claude；Codex 可以當員工或行政' }
  const a = codexArgsWin(b)
  if (typeof a === 'string') return { ok: false, text: a }
  const dirs = D.hireDirs()
  const dir = opts.cwd && existsSync(opts.cwd) ? { name: opts.cwd, path: opts.cwd } : dirs.find(d => d.path === b.dir) ?? dirs[0]
  if (!dir) return { ok: false, text: '沒有可用的上班地點' }
  const team = typeof b.team === 'string' && b.team.trim() ? b.team.trim().slice(0, 60) : undefined
  const title = [...(typeof b.title === 'string' && b.title.trim() ? b.title.trim() : name)].slice(0, 16).join('')
  const cpFile = opts.cpFile ?? join(D.base, 'checkpoints', `${name.replace(/[\\/:*?"<>|\s]+/g, '-')}-${crypto.randomUUID().slice(0, 6)}.md`)
  const add = a.mode.perm === 'read-only' ? [] : addDirArgs([...(opts.addDirs ?? []), dirname(cpFile)], dir.path).filter((_, i) => i % 2 === 1) // 唯讀不能帶 --add-dir
  const plate = /^[A-Za-z0-9]{1,12}$/.test(name) ? name : undefined
  mkdirSync(hrDir(), { recursive: true })
  const taskFile = join(hrDir(), `task-codex-${crypto.randomUUID()}.txt`)
  writeFileSync(taskFile, codexBrief({ name, title: b.title, team, role: b.role, task: b.task, cpFile }))
  const r = (() => {
    try {
      return runOpenRole(['--agent', 'codex', '--role', name, '--name-only', '--dir', dir.path, '--title', title, '--role-type', 'staff', ...(plate ? ['--plate', plate] : []),
        ...(team ? ['--team', team] : []), '--cp-file', cpFile, ...(a.model ? ['--model', a.model] : []), ...a.mode.args.map(x => `--agent-arg=${x}`),
        ...add.flatMap(d => ['--add-dir', d]), '--task-file', taskFile])
    } finally { rmSync(taskFile, { force: true }) }
  })()
  if ('error' in r) return { ok: false, text: `開不起來：${r.error}` }
  if (r.pid) winLaunchSet(r.sid, r.pid)
  watchWinHire(r.sid, name, r.pid, undefined, undefined, undefined, dir.path)
  return { ok: true, text: `🧑‍💼 招聘了 ${name}（Codex${a.model ? ` ${a.model}` : ''}）：電腦上開了一個標題「${name}」的 Codex 視窗，大約二十秒後進辦公室（會花 ChatGPT 的用量）`, sid: r.sid }
}
export const CODEX_WIN_TEXT = 'Windows 上還不能從手機開 Codex 生圖幫手（要靠 tmux 抓畫面、交件）：請在電腦上開 Codex' // 0.64.6 起招聘可以了，只剩生圖幫手用這句

export async function setModel(id: string, model: string): Promise<{ ok: boolean; text: string }> {
  if (!(model in MODELS)) return { ok: false, text: '不認得的智力等級' }
  const p = procOf(id)
  if (!p) return { ok: false, text: '這位已經不在線' }
  // 對話裡的外掛在線就交給它（不跳確認、不動新對話的預設）；沒有才走 tmux 打 /model
  if (hrAlive(p.sessionId)) {
    const from = modelOf(p)
    const r = await hrAsk(p.sessionId, { op: 'model', model: MODEL_ID[model] })
    if (!r) return { ok: false, text: '他沒有回應，晚點再試' }
    if (!r.ok) return { ok: false, text: `沒換成：${r.msg}` }
    switching.set(id, { model, at: Date.now(), from })
    return { ok: true, text: `🧠 ${nameOf(id)} 換成 ${MODELS[model]}（下一次回覆開始）` }
  }
  if (!p.pane) return { ok: false, text: NO_HR }
  // /model 會順便把它存成那套設定「新對話的預設模型」（settings.json 的 model）：換完 5 秒後改回原本的預設，只換這一位
  const settings = join(p.configDir, 'settings.json')
  let before: { ok: boolean; model?: string } = { ok: false }
  try { before = { ok: true, model: JSON.parse(readFileSync(settings, 'utf8')).model } } catch {}
  if (before.ok) setTimeout(() => {
    try {
      const j = JSON.parse(readFileSync(settings, 'utf8'))
      if (j.model === before.model) return
      if (before.model === undefined) delete j.model
      else j.model = before.model
      writeFileSync(settings, JSON.stringify(j, null, 2) + '\n')
    } catch {}
  }, 5000)
  const no = await typeLine(p.pane, `/model ${model}`, nameOf(id))
  if (no) return { ok: false, text: no }
  // 對話有紀錄時 Claude Code 會問「Switch model? 1. Yes」：看到就替他按 Enter（預設就是 Yes）。
  // 只認最底下這一段就是 Switch model 的確認（0.63.56 複審：不能是允許詢問，或畫面上別處印著這幾個字）
  for (const ms of [1200, 3000]) setTimeout(() => {
    const tail = tmux('capture-pane', '-p', '-t', p.pane!).stdout.toString().split('\n').filter(l => l.trim()).slice(-12).join('\n')
    if (/Switch model\?/.test(tail) && /❯ 1\. Yes/.test(tail) && !/Do you want to|Bash command|Tab to amend/i.test(tail)) tmux('send-keys', '-t', p.pane!, 'Enter')
  }, ms)
  switching.set(id, { model, at: Date.now(), from: modelOf(p) })
  return { ok: true, text: `🧠 ${nameOf(id)} 換成 ${MODELS[model]}（下一輪開始生效）` }
}

/**
 * 對 tmux 的 Claude 打一行字再按 Enter（0.63.56，安全審 F-2 與複審）：/compact、/clear、/model、/effort 都走這裡。
 * 先抓畫面：抓不到、或停在確認畫面（允許詢問等，Enter 會選到「1. Yes」）就不送，回原因；gapMs＝打字和 Enter 之間等多久
 */
export async function typeLine(pane: string, text: string, who: string, gapMs = 0, run: (...a: string[]) => { exitCode: number | null; stdout: { toString(): string } } = tmux): Promise<string | undefined> {
  const cap = run('capture-pane', '-p', '-t', pane)
  if (cap.exitCode !== 0) return '看不到他的畫面，先不送'
  if (confirmScreen(cap.stdout.toString())) return `${who} 正停在確認畫面（例如等你允許），先到電腦上處理完再試`
  if (run('send-keys', '-t', pane, '-l', text).exitCode !== 0) return tmuxReadonly() ? READONLY_TEXT : '送不過去'
  if (gapMs) await Bun.sleep(gapMs)
  if (run('send-keys', '-t', pane, 'Enter').exitCode !== 0) return tmuxReadonly() ? READONLY_TEXT : '按鍵送不過去'
  return undefined
}
/**
 * 畫面最後一段是不是確認畫面（0.63.56，F-2）：有編號選項（「1. Yes」、「❯ 1.」）、「Esc to cancel」「Do you want to」「Press enter to confirm」
 * 這類字，或 stuckTitle 認得的卡住畫面。寧可多擋：擋錯只是要使用者到電腦上按
 */
export function confirmScreen(screen: string): boolean {
  const tail = screen.split('\n').filter(l => l.trim()).slice(-20)
  // 游標停在編號選項上（「❯ 1. Yes」、Codex 的「› 1. Yes, proceed」）；回覆裡的一般編號清單沒有游標，不算
  if (tail.some(l => /^\s*[❯›>]\s*[1-9]\.\s+\S/.test(l))) return true
  if (tail.some(l => /Esc to cancel|Do you want to|Press enter to confirm|Enter to confirm|\(y\/n\)|\[y\/N\]/i.test(l))) return true
  return !!stuckTitle(screen)
}
export async function pressKey(id: string, key: string): Promise<{ ok: boolean; text: string }> {
  const p = procOf(id)
  if (!p) return { ok: false, text: '這位已經不在線' }
  const who = nameOf(id)
  if (!p.pane) {
    if (!['esc', 'compact', 'clear'].includes(key)) return { ok: false, text: '不認得的動作' }
    if (!hrAlive(p.sessionId)) return { ok: false, text: NO_HR }
    // 整理記憶要跑一陣子：不等結果，先回話
    const r = await hrAsk(p.sessionId, { op: key }, key === 'compact' ? 2500 : 8000)
    if (key === 'compact' && !r) return { ok: true, text: `🗜 ${who} 在整理記憶` }
    if (!r) return { ok: false, text: '他沒有回應（可能正在忙，晚點再試）' }
    return { ok: r.ok, text: r.ok ? (key === 'esc' ? `✋ ${who}：${r.msg}` : key === 'compact' ? `🗜 ${who}：${r.msg}` : `🧹 ${who} 的記憶清空了，從頭開始`) : `沒做成：${r.msg}` }
  }
  if (key === 'esc') { tmux('send-keys', '-t', p.pane, 'Escape'); return { ok: true, text: `✋ 叫 ${who} 先停下來` } }
  const cmd = key === 'compact' ? '/compact' : key === 'clear' ? '/clear' : ''
  if (!cmd) return { ok: false, text: '不認得的動作' }
  // F-2（0.63.56）：送 Enter 前先看畫面（typeLine）。停在允許詢問或任何確認畫面時，Enter 會選到「1. Yes」＝替他按了允許
  const no = await typeLine(p.pane, cmd, who)
  if (no) return { ok: false, text: no }
  return { ok: true, text: key === 'compact' ? `🗜 ${who} 在整理記憶` : `🧹 ${who} 的記憶清空了，從頭開始` }
}

/**
 * 解雇＝刪除這個對話：
 *   1. Claude app 裡的那筆：請另一位在線、能用遠端工作階段工具的同事封存它（沒有「刪除」的工具，封存後從清單消失）
 *   2. 結束電腦上的對話行程；背景 tmux（po-）一起關
 *   3. 電腦上的對話紀錄（jsonl 與同名資料夾）搬到垃圾桶的「像素辦公室解雇」資料夾，倒垃圾前都還救得回來
 *      （沒有 ~/.Trash 的系統放 ~/.claude/pixel-office/fired/）
 */
/**
 * 關掉（設計 windows-hire 6.）：結束對話但不刪紀錄，之後在電腦上 claude --resume <id> 接得回來；解雇（fire）是結束＋紀錄丟垃圾桶。
 * 只給終端機、tmux 開的 Claude：從 Claude app 開的請在 App 裡關。Windows 上連開窗的 PowerShell 一起關（同 fire）
 */
export async function closeSession(id: string): Promise<{ ok: boolean; text: string }> {
  const p = procOf(id)
  if (!p) return { ok: false, text: '這位已經不在線' }
  if (p.app) return { ok: false, text: '從 Claude app 開的，請在 App 裡關' }
  const who = nameOf(id)
  const win = process.platform === 'win32' ? winWindowOf(p.sessionId, p.pid) : undefined
  try { process.kill(p.pid, 'SIGTERM') } catch { return { ok: false, text: `${who} 關不掉` } }
  if (p.tmuxSession?.startsWith('po-')) setTimeout(() => tmux('kill-session', '-t', p.tmuxSession!), 4000)
  if (win) { try { process.kill(win) } catch {} }
  return { ok: true, text: `🚪 關掉了 ${who}，對話紀錄留著：要接回來就在電腦上 ${p.cwd} 跑 claude --resume ${p.sessionId}` }
}

export async function fire(id: string): Promise<{ ok: boolean; text: string }> {
  const p = procOf(id)
  if (!p) return { ok: false, text: '這位已經不在線' }
  const who = nameOf(id)
  const notes: string[] = []
  // 終端機開的（--remote-control）結束時 app 那筆會自動封存；只有從 app 開的要請同事代封存
  if (p.bridge && !p.app) notes.push('Claude app 裡的對話會跟著封存')
  if (p.app && !p.bridge) notes.push('Claude app 裡那個分頁要自己關或封存') // Windows 版 Desktop 沒有 bridge，沒辦法代封存（0.63.62）
  if (p.bridge && p.app) {
    const now = Date.now()
    const helpers = D.people().map(c => procOf(c.id)).filter((q): q is Proc => !!q && q.sessionId !== p.sessionId && !!hrAlive(q.sessionId, now)?.archive)
    let done: { ok: boolean; msg: string } | undefined
    for (const h of helpers.slice(0, 3)) {
      done = await hrAsk(h.sessionId, { op: 'archive', bridge: p.bridge }, 15000)
      if (done?.ok) break
    }
    notes.push(done?.ok ? 'Claude app 裡的對話已封存' : helpers.length ? `Claude app 裡的對話沒封存成功（${done?.msg || '沒有回應'}），要自己到 app 刪` : 'Claude app 裡的對話沒封存（沒有可代辦的同事），要自己到 app 刪')
  }
  const win = process.platform === 'win32' ? winWindowOf(p.sessionId, p.pid) : undefined // 先查：claude 結束後就查不到父程序了
  try { process.kill(p.pid, 'SIGTERM') } catch { return { ok: false, text: `${who} 關不掉` } }
  if (p.tmuxSession?.startsWith('po-')) setTimeout(() => tmux('kill-session', '-t', p.tmuxSession!), 4000)
  if (win) { try { process.kill(win) } catch {} notes.push('電腦上那個視窗也關了') }
  await Bun.sleep(1500)
  const f = transcripts.get(p.sessionId) ?? (() => { scan(p); return transcripts.get(p.sessionId) })()
  if (f) {
    const bin = existsSync(join(homedir(), '.Trash')) ? join(homedir(), '.Trash') : join(D.base, 'fired')
    const trash = join(bin, `像素辦公室解雇-${dayOf(Date.now())}`)
    mkdirSync(trash, { recursive: true })
    const tag = `${who.replace(/[\/\\:]/g, '_')}-${p.sessionId.slice(0, 8)}`
    let moved = 0
    for (const [src, dst] of [[f, join(trash, `${tag}.jsonl`)], [f.replace(/\.jsonl$/, ''), join(trash, tag)]]) {
      if (!existsSync(src) || existsSync(dst)) continue
      try { renameSync(src, dst); moved++ } catch {}
    }
    transcripts.delete(p.sessionId)
    scans.delete(p.sessionId)
    notes.push(moved ? '電腦上的對話紀錄丟到垃圾桶了' : '電腦上的對話紀錄沒搬動')
  }
  if (p.tmuxSession && !p.tmuxSession.startsWith('po-')) notes.push('他是常駐的，有看門狗的話會被叫回來')
  return { ok: true, text: `👋 刪除了 ${who}：${notes.join('；') || '對話已結束'}` }
}

/** 員工檔案：最近交代的事（新的在前）、今天用量、在哪裡上班 */
export function profileOf(id: string) {
  const p = procOf(id)
  if (!p) return { ok: false, text: '這位已經不在線' }
  const s = scan(p)
  return { ok: true, cwd: p.cwd, host: p.app ? 'app' : p.pane ? 'tmux' : 'other', model: prettyModel(s?.model), usage: usageOf(p), asks: [...(s?.asks ?? [])].reverse().slice(0, 15) }
}

// ---------- 💬 完整對話：從對話紀錄 jsonl 整理成一則一則 ----------
// 你說的（user）、它回的（ai）、工具呼叫（tool）與結果（result，前端用 id 接回 tool）、系統事件（note）。
// 不顯示：思考過程、子代理內部（isSidechain）、系統插入的提示（isMeta、<system-reminder> 這類）。
// 分頁用檔案位置（byte）：before＝往前再拿一段（往上滑），after＝從上次讀到的地方拿新的（開著時每 2 秒）
type ChatItem = { k: 'user' | 'ai' | 'tool' | 'result' | 'note'; at?: number; text?: string; id?: string; name?: string; desc?: string; input?: string; err?: boolean; img?: number }
const CHAT_PAGE = 60
const CUT = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n…（後面省略 ${s.length - n} 字）` : s)
function toolDesc(x: any): string {
  if (!x || typeof x !== 'object') return ''
  const v = x.description ?? x.command ?? x.file_path ?? x.pattern ?? x.url ?? x.query ?? x.prompt ?? x.skill ?? x.path
  if (typeof v === 'string') return v.replace(/\s+/g, ' ').slice(0, 120)
  const s = JSON.stringify(x)
  return s.length > 120 ? `${s.slice(0, 120)}…` : s
}
const resultText = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => (x?.type === 'text' ? x.text : x?.type === 'image' ? '（圖片）' : '')).filter(Boolean).join('\n') : ''
function userText(t: string): string | undefined {
  const s = t.trim()
  if (!s) return
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(s)
  if (cmd) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(s)?.[1]?.trim()
    return `${cmd[1].trim()}${args ? ' ' + args : ''}`
  }
  if (s.startsWith('<') || s.startsWith('Caveat:')) return
  return s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim() || undefined
}
export function lineItems(line: string): ChatItem[] {
  if (!line.includes('"type":"assistant"') && !line.includes('"type":"user"') && !line.includes('"type":"system"')) return []
  let j: any
  try { j = JSON.parse(line) } catch { return [] }
  if (j.isSidechain) return []
  const at = Date.parse(j.timestamp) || undefined
  const m = j.message
  if (j.type === 'system') return j.subtype === 'compact_boundary' ? [{ k: 'note', at, text: '🗜 整理過記憶（之前的對話已壓縮）' }] : []
  if (!m) return []
  const c = m.content
  if (j.type === 'assistant') {
    if (!Array.isArray(c)) return []
    const out: ChatItem[] = []
    for (const b of c) {
      if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        if (/^(No response requested\.?)$/.test(b.text.trim())) continue
        out.push({ k: 'ai', at, text: CUT(b.text, 60000) })
      } else if (b?.type === 'tool_use') {
        const input = b.input && typeof b.input === 'object' && typeof b.input.command === 'string' ? b.input.command : JSON.stringify(b.input ?? {}, null, 1)
        out.push({ k: 'tool', at, id: b.id, name: String(b.name ?? ''), desc: toolDesc(b.input), input: CUT(input, 4000) })
      }
    }
    return out
  }
  if (j.isCompactSummary) return [{ k: 'note', at, text: '🗜 記憶整理後的摘要（給它自己看的）' }]
  if (typeof c === 'string') {
    if (c.startsWith('[Request interrupted')) return [{ k: 'note', at, text: '✋ 被打斷' }]
    if (j.isMeta) return []
    const t = userText(c)
    return t ? [{ k: 'user', at, text: CUT(t, 20000) }] : []
  }
  if (!Array.isArray(c)) return []
  const out: ChatItem[] = []
  const texts: string[] = []
  let img = 0
  for (const b of c) {
    if (b?.type === 'tool_result') out.push({ k: 'result', id: b.tool_use_id, err: !!b.is_error, text: CUT(resultText(b.content), 4000) })
    else if (b?.type === 'text' && typeof b.text === 'string') {
      if (b.text.startsWith('[Request interrupted')) out.push({ k: 'note', at, text: '✋ 被打斷' })
      else if (!j.isMeta) { const t = userText(b.text); if (t) texts.push(t) }
    } else if (b?.type === 'image' && !j.isMeta) img++
  }
  if (texts.length || img) out.unshift({ k: 'user', at, text: CUT(texts.join('\n'), 20000), img: img || undefined })
  return out
}
function transcriptOf(p: Proc): string | undefined {
  const f = transcripts.get(p.sessionId)
  if (f && existsSync(f)) return f
  transcripts.delete(p.sessionId)
  scan(p)
  return transcripts.get(p.sessionId)
}
/** before：往前拿到湊滿一頁（或到檔頭）；after：從 after 拿到檔尾。位置都落在換行之後 */
export function chatOf(id: string, before?: number, after?: number, limit?: number) {
  const p = procOf(id)
  if (!p) return { ok: false, text: '這位已經不在線' }
  const f = transcriptOf(p)
  if (!f) return { ok: true, sid: p.sessionId, items: [], start: 0, end: 0 }
  return pageChat(f, p.sessionId, before, after, lineItems, limit)
}

/**
 * 對話紀錄檔（jsonl）分頁：before＝往前拿到湊滿一頁（或到檔頭）；after＝從 after 拿到檔尾。位置都落在換行之後。
 * Claude（lineItems）與 Codex（codexLineItems，0.62.19）共用
 */
export function pageChat(f: string, sid: string, before: number | undefined, after: number | undefined, parse: (line: string) => ChatItem[], limit?: number) {
  let fd: number | undefined
  // 一頁幾則（0.63.50：完整對話頁第一頁用 20）：1～200，沒給照 CHAT_PAGE
  const page = limit !== undefined && Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : CHAT_PAGE
  try {
    fd = openSync(f, 'r')
    const size = fstatSync(fd).size
    // 快速路徑（0.63.50）：after 已經在檔尾（每秒輪詢多半是這樣）：只 fstat、不讀檔
    if (after !== undefined && after === size) return { ok: true, sid, items: [], end: after }
    const read = (from: number, to: number) => { const b = Buffer.alloc(to - from); readSync(fd!, b, 0, b.length, from); return b }
    // 檔尾可能是還沒寫完的一行：end 退到最後一個換行之後
    let end = size
    for (let back = 64 * 1024; end > 0; back *= 4) {
      const from = Math.max(0, size - back)
      const i = read(from, size).lastIndexOf(10)
      if (i >= 0) { end = from + i + 1; break }
      if (from === 0) { end = 0; break }
    }
    if (after !== undefined) {
      if (after > end) return { ok: true, sid, reset: true, items: [], start: end, end }
      const to = Math.min(end, after + 4 * 1024 * 1024)
      const buf = read(after, to)
      const cut = to === end ? buf.length : buf.lastIndexOf(10) + 1
      const items = buf.subarray(0, cut).toString('utf8').split('\n').flatMap(parse)
      return { ok: true, sid, items, end: after + cut }
    }
    let pos = Math.min(before ?? end, end)
    const items: ChatItem[] = []
    let chunk = 256 * 1024, spent = 0, count = 0
    // 從後往前一行一行解析：湊滿一頁就停在那一行的開頭（start 是那行的位置，下一頁從這裡往前接；0.63.50 起不會多給一整段）
    while (pos > 0 && count < page && spent < 24 * 1024 * 1024) {
      const from = Math.max(0, pos - chunk)
      const buf = read(from, pos)
      spent += buf.length
      let s = 0
      if (from > 0) {
        const i = buf.indexOf(10)
        if (i < 0 || i === buf.length - 1) { chunk *= 2; continue } // 一行比這段還長：讀大一點
        s = i + 1
      }
      let lineEnd = buf.length
      for (let k = buf.length - 1; k >= s - 1 && count < page; k--) {
        if (k >= s && buf[k] !== 10) continue
        const lineStart = k + 1 // k＝上一行的換行（或 s-1：這段的第一行）
        if (lineStart < lineEnd) {
          const got = parse(buf.subarray(lineStart, lineEnd).toString('utf8').replace(/\n$/, ''))
          items.unshift(...got)
          count += got.filter(x => x.k !== 'result').length
        }
        lineEnd = lineStart
        pos = from + lineStart
      }
    }
    return { ok: true, sid, items, start: pos, end }
  } catch {
    return { ok: false, text: '對話紀錄讀不到' }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

// ---------- Codex 的完整對話（0.62.19）：~/.codex/sessions/YYYY/MM/DD/rollout-<時間>-<thread id>.jsonl ----------
const codexFiles = new Map<string, string>()
/** 找 thread 的紀錄檔：CODEX_HOME（沒設用 ~/.codex）底下 sessions 的日期資料夾，新的先找；找到就記住 */
export function codexTranscript(thread: string, home = process.env.CODEX_HOME || join(homedir(), '.codex')): string | undefined {
  // hook 記下的 transcript_path 優先、而且先於快取（0.63.15 審查第 9 項；0.63.20 複驗第 9 項：快取在前會用到舊路徑）。
  // 只信在 sessions 資料夾裡、檔名以這個 thread 結尾的（複驗 A：不然可能讀錯、解雇時搬錯檔）
  try {
    const tp = JSON.parse(readFileSync(join(D.base, 'sessions', `codex-${thread}.json`), 'utf8')).transcriptPath
    if (typeof tp === 'string' && /\/sessions\//.test(tp) && !tp.includes('..') && (tp.endsWith(`-${thread}.jsonl`) || tp.endsWith(`_${thread}.jsonl`)) && existsSync(tp)) { codexFiles.set(thread, tp); return tp }
  } catch {}
  const hit = codexFiles.get(thread)
  if (hit && existsSync(hit)) return hit
  const root = join(home, 'sessions')
  const desc = (d: string) => { try { return readdirSync(d).sort().reverse() } catch { return [] } }
  for (const y of desc(root)) for (const m of desc(join(root, y))) for (const d of desc(join(root, y, m))) {
    const f = desc(join(root, y, m, d)).find(n => n.endsWith(`-${thread}.jsonl`) || n.endsWith(`_${thread}.jsonl`))
    if (f) { const full = join(root, y, m, d, f); codexFiles.set(thread, full); return full }
  }
  return undefined
}
const codexText = (c: any): string =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((x: any) => (typeof x?.text === 'string' ? x.text : x?.type === 'input_image' ? '（圖片）' : '')).filter(Boolean).join('\n') : ''
/** Codex 紀錄的一行 → 畫面項目：你說的、它回的、工具呼叫與結果（跟 Claude 的 lineItems 同一套欄位） */
export function codexLineItems(line: string): ChatItem[] {
  if (!line.includes('"type":"response_item"') && !line.includes('"turn_aborted"') && !line.includes('"type":"compacted"')) return []
  let j: any
  try { j = JSON.parse(line) } catch { return [] }
  const at = Date.parse(j.timestamp) || undefined
  const p = j.payload ?? {}
  if (j.type === 'compacted') return [{ k: 'note', at, text: '🗜 整理過記憶（之前的對話已壓縮）' }]
  if (j.type === 'event_msg') return p.type === 'turn_aborted' ? [{ k: 'note', at, text: '✋ 被打斷' }] : []
  if (j.type !== 'response_item') return []
  if (p.type === 'message') {
    if (p.role === 'assistant') {
      const t = codexText(p.content).trim()
      return t ? [{ k: 'ai', at, text: CUT(t, 60000) }] : []
    }
    if (p.role !== 'user' || !Array.isArray(p.content)) return []
    // 開場的環境說明、AGENTS.md 規則是給它自己看的，不算使用者說的話
    const texts = p.content.filter((x: any) => x?.type === 'input_text' && typeof x.text === 'string').map((x: any) => x.text.trim()).filter((t: string) => t && !t.startsWith('<') && !t.startsWith('# AGENTS.md'))
    const img = p.content.filter((x: any) => x?.type === 'input_image').length
    return texts.length || img ? [{ k: 'user', at, text: CUT(texts.join('\n'), 20000), img: img || undefined }] : []
  }
  if (p.type === 'custom_tool_call' || p.type === 'function_call') {
    const raw = p.type === 'custom_tool_call' ? String(p.input ?? '') : String(p.arguments ?? '')
    // Codex 的 exec 把 shell 指令包在 JS 裡（tools.exec_command({cmd:`…`})）：有就只顯示指令
    const cmd = /cmd:\s*([`"'])([\s\S]*?)\1/.exec(raw)?.[2]
    let desc = (cmd ?? raw).replace(/\s+/g, ' ').slice(0, 120)
    if (p.type === 'function_call') { try { desc = toolDesc(JSON.parse(raw)) || desc } catch {} }
    return [{ k: 'tool', at, id: String(p.call_id ?? ''), name: String(p.name ?? ''), desc, input: CUT(raw, 4000) }]
  }
  if (p.type === 'custom_tool_call_output' || p.type === 'function_call_output') return [{ k: 'result', id: String(p.call_id ?? ''), text: CUT(codexText(p.output), 4000) }]
  return []
}

/**
 * 人事令：orders/<id>.json { nonce, at, role?, team?, title?, cpFile? }。Claude 的外掛（register.tsx takeOrder）、
 * Codex 的看守（codex_office.py apply_order，0.63.6）直接改身分，不經模型；同一道令只套一次（.done.json 記 nonce），10 分鐘作廢。
 * id 可以是招聘中的 cxp-xxxxxxxx（Codex 還沒有 thread id）：server.ts resolveCodexOrders 對到 codex-<thread> 後改名
 */
export type Order = { role?: 'manager' | 'staff'; team?: string; title?: string; cpFile?: string }
export function writeOrder(id: string, o: Order, now = Date.now()) {
  const d = join(D.base, 'orders')
  mkdirSync(d, { recursive: true })
  const f = join(d, `${id}.json`)
  // 還沒套用的令不蓋掉，併進來（0.63.10，審查第 2 項）：同一位連下兩道令（例如先升職、接著改主管）原本後一道蓋掉前一道。
  // 欄位都是「設成」，併完換新 nonce，收過舊令的再套一次新令也沒副作用
  const old = pendingOrder(id, now)
  const tmp = `${f}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ ...(old ?? {}), ...o, nonce: crypto.randomUUID(), at: now }))
  renameSync(tmp, f)
}
/**
 * 這位還沒過期的人事令（欄位，不含 nonce／at）；沒有回 undefined。
 * 收過了也算（0.63.18，複驗第 3 項）：看守用狀態檔裡的 orderNonce 判斷要不要再套，被蓋回去時會重套；這時伺服器若以為收過、
 * 下一道令就不併，舊欄位就丟了。欄位都是「設成」，10 分鐘內的都併進來，重套沒有副作用
 */
export function pendingOrder(id: string, now = Date.now()): Order | undefined {
  try {
    const { nonce, at, ...o } = JSON.parse(readFileSync(join(D.base, 'orders', `${id}.json`), 'utf8'))
    return nonce && now - Number(at) < 10 * 60e3 ? o : undefined
  } catch { return }
}
/** 人事令直接生效的：Claude（外掛）與 Codex（看守）；agy 照舊送一句話請它自己改 */
export const takesOrders = (p?: { id?: string; kind?: string }) => !p?.kind || p.kind === 'codex' || !!p.id?.startsWith('cxp-')

/** 升職、調部門：Codex 走人事令（0.63.6）；其他照舊送命令請那位自己用 office_profile 改（app 開的也收得到） */
export function staffing(id: string, b: any): { ok: boolean; text: string } {
  const who = nameOf(id)
  const pre = '（人事命令，來自手機像素辦公室）請用 office_profile 工具'
  let cmd = '', done = ''
  if (b?.op === 'promote') { cmd = `${pre}把 role 設成 manager，設好回一句就好，不用做別的事`; done = `⭐ 請 ${who} 升為主管` }
  else if (b?.op === 'demote') { cmd = `${pre}把 role 設成 staff，設好回一句就好，不用做別的事`; done = `請 ${who} 改回員工` }
  else if (b?.op === 'team') {
    const t = typeof b.team === 'string' ? b.team.trim().slice(0, 60) : ''
    cmd = t ? `${pre}把 team 設成「${t}」（你的新主管），設好回一句就好，不用做別的事` : `${pre}把 team 設成 off（不掛主管），設好回一句就好，不用做別的事`
    done = t ? `🔀 請 ${who} 調到 ${t} 底下` : `請 ${who} 不掛主管`
  } else return { ok: false, text: '不認得的人事動作' }
  if (/^(codex|agy)-/.test(id) && b?.op === 'promote') return { ok: false, text: '主管只能是 Claude（使用者 2026-11-24 決定）' } // 降職照舊可以（審查第 5 項）
  if (id.startsWith('codex-')) {
    writeOrder(id, b.op === 'team' ? { team: (typeof b.team === 'string' && b.team.trim().slice(0, 60)) || 'off' } : { role: b.op === 'promote' ? 'manager' : 'staff' })
    return { ok: true, text: `${done}（辦公室直接改，幾秒內生效）` }
  }
  const err = D.sendCommand(id, cmd)
  return err ? { ok: false, text: err } : { ok: true, text: `${done}（他收到後自己改，幾秒到一兩分鐘）` }
}

// ---------- 📅 排班：每天（或平日）幾點幾分，替某位員工送一道命令。存在 remote-schedule-<port>.json ----------
// 認人：先比 session id，不在線就找同 ListAgents 名稱、再找同名牌的（對話重開 id 會換）
// 整桌排班（roadmap 第 8 項，0.62.13）：table＝協作桌號（到時間送給當下坐在這桌的每個人，不存固定名單）；action＝report（各自回報主管、主管整理一份）或 meet（照第 9 項整桌開會，題目＝text）；
// days 多 weekly（每週幾，dow＝0 週日～6 週六）
type Shift = { sid: string; who: { id: string; agent?: string; name: string }; time: string; days: 'daily' | 'weekdays' | 'weekly'; dow?: number; table?: number; action?: 'report' | 'meet'; text: string; on: boolean; autoDay?: string; last?: { day: string; at: number; ok: boolean; msg: string } }
const DOW = ['週日', '週一', '週二', '週三', '週四', '週五', '週六']
export const daysText = (x: { days: string; dow?: number }) => (x.days === 'weekdays' ? '平日' : x.days === 'weekly' ? `每${DOW[x.dow ?? 1]}` : '每天')
/** 這筆排班今天要不要跑 */
export const dayMatch = (x: { days: string; dow?: number }, d: Date) => x.days === 'daily' || (x.days === 'weekdays' ? d.getDay() >= 1 && d.getDay() <= 5 : x.days === 'weekly' ? d.getDay() === (x.dow ?? 1) : false)
const shiftFile = () => join(D.base, `remote-schedule-${D.port()}.json`)
export function shifts(): Shift[] {
  try { const j = JSON.parse(readFileSync(shiftFile(), 'utf8')); return Array.isArray(j) ? j : [] } catch { return [] }
}
const saveShifts = (list: Shift[]) => writeFileSync(shiftFile(), JSON.stringify(list, null, 1))
export function editShift(b: any): { ok: boolean; text: string } {
  const list = shifts()
  if (b?.op === 'add' && b.table !== undefined && b.table !== null && b.table !== '') {
    const table = Number(b.table), name = D.tableName?.(table)
    if (!name) return { ok: false, text: '找不到這張協作桌' }
    const time = String(b.time ?? '')
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { ok: false, text: '時間要像 08:30' }
    const action = b.action === 'meet' ? 'meet' : 'report'
    const text = typeof b.text === 'string' ? b.text.trim().slice(0, action === 'meet' ? 40 : 2000) : ''
    if (!text) return { ok: false, text: action === 'meet' ? '開會要有題目' : '要交代什麼？' }
    if (list.length >= 50) return { ok: false, text: '排班太多了（最多 50 筆）' }
    const days = b.days === 'weekdays' ? 'weekdays' : b.days === 'weekly' ? 'weekly' : 'daily'
    const dow = days === 'weekly' ? Math.max(0, Math.min(6, Math.floor(Number(b.dow)) || 0)) : undefined
    const x: Shift = { sid: crypto.randomUUID().slice(0, 8), who: { id: `table:${table}`, name: `整桌：${name}` }, time, days, ...(dow !== undefined ? { dow } : {}), table, action, text, on: true }
    list.push(x)
    saveShifts(list)
    return { ok: true, text: `📅 排好了：${daysText(x)} ${time} ${action === 'meet' ? `「${name}」整桌開會：${text}` : `「${name}」整桌各自回報`}` }
  }
  if (b?.op === 'add') {
    const c = D.people().find(x => x.id === b.id)
    if (!c) return { ok: false, text: '這位已經不在線' }
    const time = String(b.time ?? '')
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return { ok: false, text: '時間要像 08:30' }
    const text = typeof b.text === 'string' ? b.text.trim().slice(0, 2000) : ''
    if (!text) return { ok: false, text: '要交代什麼？' }
    if (list.length >= 50) return { ok: false, text: '排班太多了（最多 50 筆）' }
    const days = b.days === 'weekdays' ? 'weekdays' : b.days === 'weekly' ? 'weekly' : 'daily'
    const x: Shift = { sid: crypto.randomUUID().slice(0, 8), who: { id: c.id, agent: c.agent, name: c.name }, time, days, ...(days === 'weekly' ? { dow: Math.max(0, Math.min(6, Math.floor(Number(b.dow)) || 0)) } : {}), text, on: true }
    list.push(x)
    saveShifts(list)
    return { ok: true, text: `📅 排好了：${daysText(x)} ${time} 叫 ${c.name}` }
  }
  const i = list.findIndex(x => x.sid === b?.sid)
  if (i < 0) return { ok: false, text: '找不到這筆排班' }
  if (b.op === 'del') { const [x] = list.splice(i, 1); saveShifts(list); return { ok: true, text: `刪掉 ${x.who.name} ${x.time} 的排班` } }
  if (b.op === 'toggle') { list[i].on = !list[i].on; saveShifts(list); return { ok: true, text: list[i].on ? '排班恢復' : '排班暫停' } }
  if (b.op === 'run') return { ok: true, text: runShift(list, i, Date.now()) }
  return { ok: false, text: '不認得的動作' }
}
function runShift(list: Shift[], i: number, now: number, auto = false): string {
  const x = list[i]
  if (auto) x.autoDay = dayOf(now) // 只有自動跑的才記「今天跑過」；手動「現在跑」不影響當天的排班
  if (x.table !== undefined) {
    const r = D.tableRun ? D.tableRun(x.table, x.action ?? 'report', x.text, now) : { ok: false, msg: '這台伺服器不支援整桌排班' }
    x.last = { day: dayOf(now), at: now, ok: r.ok, msg: r.msg }
    saveShifts(list)
    return `${x.who.name}：${r.msg}`
  }
  const people = D.people()
  const c = people.find(q => q.id === x.who.id) ?? (x.who.agent ? people.find(q => q.agent === x.who.agent) : undefined) ?? people.find(q => q.name === x.who.name)
  const err = c ? D.sendCommand(c.id, `⏰ 排班：${x.text}`, now) : '不在線，沒送出'
  if (c) x.who = { id: c.id, agent: c.agent, name: c.name }
  x.last = { day: dayOf(now), at: now, ok: !err, msg: err ?? '已交代' }
  saveShifts(list)
  return err ? `${x.who.name}：${err}` : `已交代 ${x.who.name}`
}
/** 伺服器開著時每 20 秒看一次排班（只在 import.meta.main 時由 server.ts 叫，測試不會跑） */
export function startShiftClock() {
  setInterval(() => {
    const now = Date.now()
    const d = new Date(now)
    const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    const list = shifts()
    list.forEach((x, i) => {
      if (x.on && x.time === hm && dayMatch(x, d) && x.autoDay !== dayOf(now)) runShift(list, i, now, true)
    })
  }, 20000)
}

// ---------- 從手機招聘 Codex（0.62.20）：在 tmux 開 codex CLI；換智力／打斷／解雇走 tmux 退路 ----------
// 職稱、主管：0.63.6 起走人事令（writeOrder，Codex 看守直接改狀態檔）；之前是寫在第一句話請它自己設；
// 座位：先用暫代 id（cxp-<8 碼>，也是 tmux 名 po-cxp-<8 碼>）釘著，等它登記成 codex-<thread> 再由 server 換過去（resolveCodexPins）
const codexBin = () => Bun.which('codex') ?? join(homedir(), '.local', 'bin', 'codex')
const CODEX_HOME = () => process.env.CODEX_HOME || join(homedir(), '.codex')
/** 招聘頁的 Codex 智力：~/.codex/models_cache.json 裡可見的前 4 個（第一個＝預設） */
export function codexModels(home = CODEX_HOME()): { slug: string; name: string; efforts?: string[] }[] {
  try {
    const j = JSON.parse(readFileSync(join(home, 'models_cache.json'), 'utf8'))
    const list: any[] = Array.isArray(j) ? j : Array.isArray(j.models) ? j.models : []
    return list.filter(m => m && m.visibility === 'list' && typeof m.slug === 'string').sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99)).slice(0, 4).map(m => { const e = (m.supported_reasoning_levels ?? []).map((l: any) => (typeof l === 'string' ? l : l?.effort)).filter((x: unknown) => typeof x === 'string'); return { slug: m.slug, name: String(m.display_name ?? m.slug), ...(e.length ? { efforts: e } : {}) } })
  } catch { return [] }
}
const SLUG = /^[a-z0-9][a-z0-9.\-]{0,40}$/

/** 第一句話：先登記名牌、職稱、主管，再做任務（Codex 沒有預先登記） */
export function codexBrief(o: { name: string; title?: string; team?: string; role?: string; task?: string; cpFile?: string }): string {
  // 職稱、主管由辦公室的人事令直接設（0.63.6，codex_office.py 看守套用），不用它自己呼叫 office_profile
  return [
    `你是「${o.name}」，從手機像素辦公室招進來的 Codex，一律用繁體中文。`,
    `辦公室已替你登記職稱「${[...(o.title || o.name)].slice(0, 16).join('')}」${o.team ? `、主管 ${o.team}（有事用 office_send 向它回報）` : ''}，名牌由辦公室自動給，不用自己設。`,
    ...(!o.cpFile ? [] : o.task?.includes(o.cpFile) ? [`對話被壓縮後，先重讀 ${o.cpFile} 的最後一筆再繼續。`]
      : [`做到一個段落、收工前，在 ${o.cpFile} 存一筆檢查點（「## YYYY-MM-DD HH:mm ${o.name}」＋做完／卡在／下一步，只往後加）。對話被壓縮後，先重讀這個檔的最後一筆再繼續。`]),
    o.task?.trim() ? `任務：${o.task.trim()}` : '回一句「到了」就好，等使用者交代。',
  ].join('\n')
}

/** 這次開的 tmux 的不可變身分（0.63.38，生圖幫手審查第 4、6 項）：session ID（$N）、pane ID（%N）、session 選項 @po_launch 的標記 */
/** pid／start＝pane 裡那支程序（pane_pid）和它的啟動時間（世代，0.63.39）：沒有 id 的回收只認這一支 */
export type Launch = { tmux: string; pane: string; marker: string; pid?: number; start?: string }
export function hireCodex(b: any, opts: { cwd?: string; addDirs?: (string | undefined)[]; cpFile?: string; launch?: boolean; hold?: boolean } = {}): { ok: boolean; text: string; sid?: string; launch?: Launch } {
  if (!TMUX) return { ok: false, text: '這台電腦沒有 tmux，招聘目前只支援 Mac／Linux' }
  const exe = codexBin()
  if (!existsSync(exe)) return { ok: false, text: '這台電腦沒有 codex 指令（先裝 Codex CLI）' }
  const name = String(b?.name ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim()
  if (!name || [...name].length > 20) return { ok: false, text: '名字要 1～20 個字' }
  const model = typeof b.model === 'string' && b.model && b.model !== 'default' ? b.model : ''
  if (model && !SLUG.test(model)) return { ok: false, text: '不認得的智力等級' }
  const dirs = D.hireDirs()
  const dir = opts.cwd && existsSync(opts.cwd) ? { name: opts.cwd, path: opts.cwd } : dirs.find(d => d.path === b.dir) ?? dirs[0]
  if (!dir) return { ok: false, text: '沒有可用的上班地點' }
  const team = typeof b.team === 'string' && b.team.trim() ? b.team.trim().slice(0, 60) : undefined
  const mode = codexModeArgs(b)
  if (typeof mode === 'string') return { ok: false, text: mode }
  if (model && !codexAllModels().some(m => m.slug === model)) return { ok: false, text: '不認得的智力等級' }
  if (mode.effort) { // 投入程度照選的模型（沒選＝預設那個）驗（0.63.19）
    const m = model || codexModels()[0]?.slug, lv = codexEffortsOf(m)
    if (lv && !lv.includes(mode.effort)) return { ok: false, text: `${m} 沒有這個投入程度` }
  }
  const sid = `cxp-${crypto.randomUUID().slice(0, 8)}`
  // 檢查點（0.63.6）：坐協作桌的寫在那桌的 checkpoints/（hireAt 給）；不坐桌的寫在 pixel-office/checkpoints/。資料夾帶 --add-dir 才寫得進去
  const cpFile = opts.cpFile ?? join(D.base, 'checkpoints', `${name.replace(/[\\/:*?"<>|\s]+/g, '-')}-${sid.slice(4, 10)}.md`)
  // （坐協作桌的 cpFile 由 hireAt 給，檔名是名字；同桌兩位 Codex 同名時共用筆記照各自綁定的 cpFile 讀，不靠檔名）
  const add = mode.perm === 'read-only' ? [] : addDirArgs([...(opts.addDirs ?? []), dirname(cpFile)], dir.path) // 唯讀不能帶 --add-dir（Codex 會直接結束）
  const r = tmux('new-session', '-d', ...(opts.launch ? ['-P', '-F', '#{session_id} #{pane_id} #{pane_pid}'] : []), '-x', '220', '-y', '50', '-s', `po-${sid}`, '-c', dir.path,
    'env', '-u', 'CLAUDE_CODE_CHILD_SESSION', '-u', 'ANTHROPIC_API_KEY', '-u', 'CLAUDECODE',
    exe, '--no-daemon', ...mode.args, '-C', dir.path, ...add, ...(model ? ['-m', model] : []),
    codexBrief({ name, title: b.title, team, role: b.role, task: b.task, cpFile }),
    // hold（0.63.56）：同一次 tmux 呼叫裡先開 remain-on-exit，Codex 一開就結束時畫面和結束碼留著給 codexStarted 讀（之後它會關掉這個選項）
    ...(opts.hold ? [';', 'set-option', '-w', '-t', `=po-${sid}:`, 'remain-on-exit', 'on'] : []))
  if (r.exitCode !== 0) return { ok: false, text: `開不起來：${r.stderr.toString().trim() || r.exitCode}` }
  // 要追蹤的（生圖幫手）：記下這次的 $N／%N，設啟動標記並讀回確認；設不上就只收這次的 pane，不留沒人管的 Codex
  let launch: Launch | undefined
  if (opts.launch) {
    const [tsid = '', pane = '', ppid = ''] = r.stdout.toString().trim().split(/\s+/)
    const marker = crypto.randomUUID()
    const okId = /^\$\d+$/.test(tsid) && /^%\d+$/.test(pane)
    const pid = /^\d+$/.test(ppid) ? Number(ppid) : 0, start = pid ? pidStart(pid) : undefined
    if (!okId || !pid || !start || tmux('set-option', '-t', tsid, '@po_launch', marker).exitCode !== 0 || tmux('show-options', '-v', '-t', tsid, '@po_launch').stdout.toString().trim() !== marker) {
      const gone = okId && reapOwn(tsid, pane, undefined)
      return { ok: false, text: gone ? '開了，但啟動標記設不上，已經收掉，晚點再試' : `開了，但啟動標記設不上，也沒能確定收掉：請到電腦上看 tmux po-${sid}` }
    }
    launch = { tmux: tsid, pane, marker, pid, start }
  }
  // 職稱、主管走人事令：先記在暫代 id（cxp-），它登記成 codex-<thread> 後 server.ts resolveCodexOrders 改名過去，看守套用
  writeOrder(sid, { role: 'staff', cpFile, title: [...(typeof b.title === 'string' && b.title.trim() ? b.title.trim() : name)].slice(0, 16).join(''), team: team || 'off' })
  watchHire(`po-${sid}`, name)
  ctlSet(sid, { ...(model ? { model } : {}), ...(mode.effort ? { effort: mode.effort } : {}), perm: mode.perm }) // 登記成 codex-<thread> 後 server.ts 改名過去
  return { ok: true, text: `🧑‍💼 招聘了 ${name}（Codex${model ? ` ${model}` : ''}），大約二十秒後進辦公室（會花 ChatGPT 的用量）`, sid, ...(launch ? { launch } : {}) }
}

/** 結束畫面的最後幾行（0.63.56）：去掉空行和 tmux 的「Pane is dead」那行，路徑縮成檔名，最多 6 行、400 字 */
export function deadScreen(screen: string): string {
  const lines = screen.split('\n').map(l => l.trimEnd()).filter(l => l.trim() && !/^Pane is dead/.test(l.trim()))
  return lines.slice(-6).map(l => l.trim().replace(/(?:~|\/(?:Users|private|var|home|tmp|opt|Volumes))(?:\/[^\s'"\/:]+)*\/([^\s'"\/:]+)/g, '…/$1')).join(' ／ ').slice(-400)
}
export const START_CHECK_MS = 4000
/**
 * 招聘的 Codex 有沒有活過開頭幾秒（0.63.56；11-26 ~/.codex/config.toml 重複的 key，Codex 一啟動就結束，招聘卻回成功）。
 * hireCodex({ hold }) 開的視窗有 remain-on-exit：期間內 pane 死了就讀畫面最後幾行和結束碼、收掉這個 session（只收這次開的那個 pane），回失敗；
 * 撐過就把 remain-on-exit 關掉（之後正常結束照舊關視窗）。session 已經不在（沒能保留畫面）也回失敗
 */
export async function codexStarted(session: string, run: (a: string[], ms: number) => Promise<{ code: number | null; out: string; err: string }> = (a, ms) => spawnBounded([TMUX ?? 'tmux', ...a], ms), sleep: (ms: number) => Promise<unknown> = ms => Bun.sleep(ms), ms = START_CHECK_MS): Promise<{ ok: true } | { ok: false; text: string }> {
  const t = `=${session}:`, until = Date.now() + ms
  for (;;) {
    const r = await run(['display', '-p', '-t', t, '#{session_id} #{pane_id} #{pane_dead} #{pane_dead_status}'], 1500)
    const [sid = '', pane = '', dead = '', status = ''] = r.code === 0 ? r.out.trim().split(/\s+/) : []
    // 找不到這個 session：tmux 有時回錯誤、有時回 0 但印空的（實測），兩種都算已經不在
    if ((r.code === 0 && !/^\$\d+$/.test(sid)) || (r.code !== 0 && r.code !== null && /can't find|no server running|not found/i.test(r.err))) return { ok: false, text: 'Codex 視窗一開就關了，沒有留下畫面（看不到結束碼）：請到電腦上用 codex 開一次看錯誤' }
    if (r.code === 0) {
      if (dead === '1') {
        const screen = await run(['capture-pane', '-p', '-S', '-50', '-t', pane || t], 1500) // 連捲動紀錄：死掉時畫面會往上推（實測）
        const last = screen.code === 0 ? deadScreen(screen.out) : ''
        await reapOwnAsync(sid, pane, undefined, run, Date.now() + 3000).catch(() => false)
        return { ok: false, text: `Codex 一開就結束了（結束碼 ${status || '?'}）${last ? `：${last}` : '，畫面沒有留下訊息'}` }
      }
    }
    if (Date.now() >= until) break
    await sleep(250)
  }
  await run(['set-option', '-w', '-t', t, 'remain-on-exit', 'off'], 1500)
  return { ok: true }
}

type CodexProc = { pid: number; thread: string; pane?: string; tmuxSession?: string; shared: boolean }
/** codex-<thread> → 它的程序與 tmux 位置：辦公室的 sessions/codex-*.json 有 pid；往上找祖先程序對到 tmux 的 pane */
export function codexProc(id: string): CodexProc | undefined {
  const thread = /^codex-([0-9a-f-]{8,64})$/.exec(id)?.[1]
  if (!thread) return
  let s: any
  try { s = JSON.parse(readFileSync(join(D.base, 'sessions', `${id}.json`), 'utf8')) } catch { return }
  const pid = Number(s.pid) || 0
  if (!pid || s.left) return
  try { process.kill(pid, 0) } catch (e: any) { if (e?.code !== 'EPERM') return }
  const host = paneOfPid(pid)
  // 共用（App 的常駐程式）伺服器自己看命令列判斷（0.63.10，審查第 1 項）：舊版看守把 ChatGPT.app 路徑底下的 tmux CLI 也寫成 shared
  return { pid, thread, shared: sharedPid(pid) ?? !!s.shared, ...(host ?? {}) }
}
/** App 的常駐程式＝參數裡有 app-server／exec-server 子指令（不看路徑：~/.local/bin/codex 指向 ChatGPT.app 裡的執行檔）；ps 失敗回 undefined */
const CODEX_OPT_VALUE = new Set(['-c', '--config', '-m', '--model', '-C', '--cd', '--add-dir', '-s', '--sandbox', '-a', '--ask-for-approval', '-p', '--profile', '-i', '--image', '--enable', '--disable', '--local-provider', '--remote'])
/** 子指令（第一個不是選項、也不是選項值的參數）是 app-server／exec-server 才算（0.63.18，複驗第 1 項：原本整串找字，第一句話裡有這個詞也會誤判） */
export function isSharedCmd(cmd: string): boolean {
  const t = cmd.trim().split(/\s+/).slice(1)
  for (let i = 0; i < t.length;) {
    if (t[i].startsWith('-')) { i += t[i].includes('=') || !CODEX_OPT_VALUE.has(t[i]) ? 1 : 2; continue }
    return t[i] === 'app-server' || t[i] === 'exec-server'
  }
  return false
}
const sharedSeen = new Map<number, { v: boolean; at: number }>()
// Windows 沒有 ps（0.64.8：從 PowerShell 啟動的伺服器 PATH 裡沒有 Git Bash 的 ps，丟例外讓整個 /state.json 回 500）：
// Windows 一律回 undefined，照狀態檔的 shared；其他平台 ps 叫不起來也一樣
export function sharedPid(pid: number, now = Date.now()): boolean | undefined {
  if (process.platform === 'win32') return
  const c = sharedSeen.get(pid)
  if (c && now - c.at < 60e3) return c.v
  let r: ReturnType<typeof Bun.spawnSync>
  try { r = Bun.spawnSync(['ps', '-o', 'command=', '-p', String(pid)], { stdout: 'pipe', stderr: 'pipe', timeout: EXT_TIMEOUT_MS, killSignal: 'SIGKILL' }) } catch { return }
  if (r.exitCode !== 0) return
  const v = isSharedCmd(r.stdout.toString())
  sharedSeen.set(pid, { v, at: now })
  return v
}
/** 程序在哪個 tmux pane：列出所有 pane 的 shell pid，沿 ppid 往上最多 8 層 */
let paneProbeFailed = false
export function paneOfPid(pid: number): { pane: string; tmuxSession: string } | undefined {
  if (!TMUX) return
  const panes = new Map<number, { pane: string; tmuxSession: string }>()
  const lp = tmux('list-panes', '-a', '-F', '#{pane_pid} #{pane_id} #{session_name}')
  // tmux 查不到（逾時、伺服器沒開以外的錯）：記下來，codexCap 回 unknown，不當成「開在一般終端機」（0.63.21，複驗 B）
  paneProbeFailed = lp.exitCode !== 0 && !/no server running|error connecting/i.test(lp.stderr.toString())
  for (const l of lp.stdout.toString().split('\n')) {
    const m = /^(\d+) (%\d+) (.+)$/.exec(l.trim()); if (m) panes.set(+m[1], { pane: m[2], tmuxSession: m[3] })
  }
  let p = pid
  for (let i = 0; i < 8 && p > 1; i++) {
    const hit = panes.get(p); if (hit) return hit
    const r = Bun.spawnSync(['ps', '-o', 'ppid=', '-p', String(p)], { stdout: 'pipe', stderr: 'pipe', timeout: EXT_TIMEOUT_MS, killSignal: 'SIGKILL' })
    p = Number(r.stdout.toString().trim()) || 0
  }
  return
}
const NOT_TMUX = 'Codex 開在 ChatGPT／Codex App 裡：手機沒辦法替它換智力、打斷或解雇，請到 App 裡操作（只有從手機招聘、開在電腦背景的 Codex 可以）'
/** 開在 tmux 的 Codex 才能替它操作（手機招的、或自己在 tmux 開的） */
export const codexCtl = (id: string) => { const p = codexProc(id); return !!(p && p.pane && !p.shared) }

export async function codexKey(id: string, key: string): Promise<{ ok: boolean; text: string }> {
  const p = codexProc(id)
  if (!p) return { ok: false, text: '這位已經不在線' }
  if (!p.pane || p.shared) return { ok: false, text: NOT_TMUX }
  if (key === 'esc') { // 送不出去不能回成功（複驗 B：唯讀 client 連著時 Escape 會失敗）
    if (tmux('send-keys', '-t', p.pane, 'Escape').exitCode !== 0) return { ok: false, text: tmuxReadonly() ? READONLY_TEXT : '按鍵送不過去' }
    return { ok: true, text: '✋ 叫 Codex 先停下來' }
  }
  const cmd = key === 'compact' ? '/compact' : key === 'clear' ? '/new' : ''
  if (!cmd) return { ok: false, text: '不認得的動作' }
  const why = await codexSend(p.pane, cmd)
  if (why) return { ok: false, text: why }
  return { ok: true, text: key === 'compact' ? '🗜 Codex 在整理記憶' : '🧹 Codex 開了新對話' }
}

/**
 * 在 Codex 打斜線指令（0.63.12，審查第 11 項）：先確認可以安全操作才打字——輸入框是空的（只有灰色提示字）、沒開選單、
 * 沒停在確認畫面；不然回原因，不送（不會把使用者打到一半的字跟著送出去）。送出後字還在輸入框（第一次 Enter 只關掉指令提示）才再按一次
 */
export function codexReady(screenWithEscapes: string): string | undefined {
  const plain = screenWithEscapes.replace(/\x1b\[[0-9;]*m/g, '')
  if (stuckTitle(plain)) return '他正停在確認畫面，先處理那個'
  if (/enter (select|confirm|default)|esc (back|skip)/i.test(plain.split('\n').filter(l => l.trim()).slice(-4).join('\n'))) return '他開著選單，晚點再試'
  const line = screenWithEscapes.split('\n').filter(l => l.includes('›')).pop()
  if (line === undefined) return '找不到他的輸入框，晚點再試'
  const after = line.slice(line.indexOf('›') + 1).replace(/^(\x1b\[0?m|\s)+/, '') // 只去掉重設與空白，保留灰色（ESC[2m）的記號
  if (after !== '' && !after.startsWith('\x1b[2m')) return '他的輸入框裡有還沒送出的字，先不動'
  return
}
/** 同一個 pane 一次只做一件事（0.63.19，複驗第 11 項）：手機連按兩個鍵，字會交錯、讀回會讀到別人的結果 */
const paneBusy = new Map<string, Promise<unknown>>()
export async function withPane<T>(pane: string, fn: () => Promise<T>): Promise<T> {
  const prev = paneBusy.get(pane) ?? Promise.resolve()
  const run = prev.catch(() => undefined).then(fn)
  paneBusy.set(pane, run)
  try { return await run } finally { if (paneBusy.get(pane) === run) paneBusy.delete(pane) }
}
/** 輸入框目前的整段文字：最後一行「›」之後（去掉框線、頭尾空白） */
export function composerText(screen: string): string {
  const line = screen.split('\n').filter(l => l.includes('›')).pop() ?? ''
  return line.slice(line.indexOf('›') + 1).replace(/[│┃║]\s*$/, '').trim()
}
async function codexSend(pane: string, cmd: string, sleep = (ms: number) => Bun.sleep(ms)): Promise<string | undefined> {
  // 視窗太窄時長指令會在輸入框折行，Codex 會只送出折行前那段（0.63.28 實測 80 欄：「on-req」＋剩下「uest」留在框裡）：先把視窗撐寬
  if (Number(tmux('display', '-p', '-t', pane, '#{pane_width}').stdout.toString().trim()) < 200) { tmux('resize-window', '-t', pane, '-x', '220', '-y', '50'); await sleep(300) }
  const why = codexReady(tmux('capture-pane', '-e', '-p', '-t', pane).stdout.toString())
  if (why) return why
  // 0.63.56 複審：跟 Claude 那邊（typeLine）同一個確認畫面檢查，停在任何確認畫面都不打字、不按 Enter
  if (confirmScreen(tmux('capture-pane', '-p', '-t', pane).stdout.toString())) return '他正停在確認畫面（例如等你允許），先到電腦上處理完再試'
  if (tmux('send-keys', '-t', pane, '-l', cmd).exitCode !== 0) return tmuxReadonly() ? READONLY_TEXT : '送不過去'
  // 等輸入框真的出現整串指令再按 Enter（0.63.28 實測：Codex 把快速打進來的字當成貼上、分批放進輸入框，
  // 太早按 Enter 只會送出前半段，例如「--reasoni」，剩下「ng=low」留在框裡）。最多等 3 秒
  // 審查第 10 項（0.63.29）：要輸入框「整欄」就是這串指令才按 Enter；3 秒內沒對上就清掉自己打的字、回失敗，不按 Enter
  let full = false
  for (let i = 0; i < 15 && !full; i++) {
    await sleep(200)
    full = composerText(tmux('capture-pane', '-p', '-t', pane).stdout.toString()) === cmd
  }
  if (!full) {
    // 複驗新問題 2（0.63.30）：只有輸入框裡全是我們打的字（指令的前半段）才清掉；有別的字（使用者在打）就保留，回錯
    const now = composerText(tmux('capture-pane', '-p', '-t', pane).stdout.toString())
    if (now && cmd.startsWith(now)) tmux('send-keys', '-t', pane, 'C-u')
    return '指令沒有完整進到輸入框，沒有送出；晚點再試'
  }
  if (tmux('send-keys', '-t', pane, 'Enter').exitCode !== 0) return tmuxReadonly() ? READONLY_TEXT : '按鍵送不過去'
  await sleep(300)
  const line = tmux('capture-pane', '-p', '-t', pane).stdout.toString().split('\n').filter(l => l.includes('›')).pop() ?? ''
  if (line.includes(cmd) && tmux('send-keys', '-t', pane, 'Enter').exitCode !== 0) return tmuxReadonly() ? READONLY_TEXT : '按鍵送不過去'
  return
}
/** /status 讀回目前的設定（看新多出來的那一段，不會讀到畫面上舊的） */
async function codexStatus(pane: string, sleep = (ms: number) => Bun.sleep(ms)): Promise<{ model?: string; effort?: string; perm?: string } | undefined> {
  // Codex 是全螢幕、沒有捲回的紀錄：舊的 /status 會被推出畫面，不能用「多了幾段」判斷。改成畫面有變、而且最底下 30 行裡有新的那段
  // 帶一點捲回的紀錄（0.63.28：窄視窗時 /status 會折行，回顯那行被推出可見範圍）
  const cap = () => tmux('capture-pane', '-p', '-S', '-80', '-t', pane).stdout.toString()
  const before = cap()
  if (await codexSend(pane, '/status', sleep)) return
  await sleep(1200)
  const txt = cap()
  if (txt === before) return
  // 只讀這次 /status 那一段（複驗第 11 項）：Codex 會先印一行「/status」再印設定，取最後一行「/status」之後的
  const lines = txt.split('\n'), echo = lines.map(l => l.trim()).lastIndexOf('/status')
  if (echo < 0) return
  const block = lines.slice(echo + 1).join('\n')
  if (!/Permissions:/.test(block)) return
  return parseCodexStatus(block)
}
/** /status 的「Model: GPT-6.2-Sol (reasoning high, …)」「Permissions: Workspace (Approve for me)」→ 值 */
export function parseCodexStatus(txt: string): { model?: string; effort?: string; perm?: string } {
  // 折行的接回去（0.63.28：「Workspace [<資料夾>] (Approve for me)」會跨兩三行）：開頭一串空白、不是「名稱:」的行是上一行的續行
  // 框線先拿掉（審查第 11 項：「│ Permissions: … │」這種帶左右框線的也要認得）
  const t = txt.split('\n').map(l => l.replace(/^\s*[│┃║]/, ' ').replace(/[│┃║]\s*$/, '')).reduce<string[]>((a, l) => (a.length && /^\s{8,}\S/.test(l) && !/^\s*[A-Z][\w .]+:\s/.test(l) ? (a[a.length - 1] += ' ' + l.trim(), a) : (a.push(l), a)), []).join('\n')
  const m = /Model:\s+(.+?)\s*\(reasoning (\w+)/.exec(t), p = /Permissions:\s+(.+)/.exec(t)?.[1] ?? ''
  // 帶了額外資料夾時是「Workspace [<資料夾>] (…)」：看括號裡的審核方式
  const perm = /^Read Only/i.test(p) ? 'read-only' : /^Workspace\b.*\(Approve for me\)/i.test(p) ? 'auto' : /^Workspace\b.*\(Ask for approval\)/i.test(p) ? 'default' : p ? 'other' : undefined
  return { ...(m ? { model: m[1], effort: m[2] } : {}), ...(perm ? { perm } : {}) }
}
/** 換智力：在 Codex 裡打 /model <slug>（實測 0.171：「Model changed to … for this session only」） */
export async function codexModel(id: string, model: string): Promise<{ ok: boolean; text: string }> {
  const p = codexProc(id)
  if (!p) return { ok: false, text: '這位已經不在線' }
  if (!p.pane || p.shared) return { ok: false, text: NOT_TMUX }
  if (!SLUG.test(model) || !codexAllModels().some(m => m.slug === model)) return { ok: false, text: '不認得的智力等級' } // 名單外的不收（0.63.19）
  // 只打 /model <slug> 會回到那個模型的預設投入程度：手機設過的、新模型也有的，一起帶上（0.63.9）
  const eff = codexSettings(id).effort, keep = eff && codexEffortsOf(model)?.includes(eff)
  const why = await codexSend(p.pane, `/model ${model}${keep ? ` --reasoning=${eff}` : ''}`)
  if (why) return { ok: false, text: why }
  await Bun.sleep(800)
  const st = await codexStatus(p.pane) // 讀回才算（複驗第 11 項）
  const got = st?.model ? codexSlugOf(st.model) : undefined
  if (!got) return { ok: false, text: '送了，但讀不到目前的設定，晚點再看一次' }
  ctlSet(id, { model: got, ...(st?.effort ? { effort: st.effort } : {}) })
  if (got !== model) return { ok: false, text: `送了，但現在還是 ${st!.model}` }
  return { ok: true, text: `🧠 Codex 換成 ${st!.model}` }
}

/** 解雇：結束程序、關 tmux，紀錄檔搬到垃圾桶的「像素辦公室解雇-<日期>」（倒垃圾前救得回來；主管 2026-11-23：不用 codex delete 永久刪） */
export async function codexFire(id: string): Promise<{ ok: boolean; text: string }> {
  const p = codexProc(id)
  if (!p) return { ok: false, text: '這位已經不在線' }
  if (!p.pane || p.shared) return { ok: false, text: NOT_TMUX }
  const who = nameOf(id)
  const f = codexTranscript(p.thread)
  try { process.kill(p.pid, 'SIGTERM') } catch { return { ok: false, text: `${who} 關不掉` } }
  for (let i = 0; i < 20; i++) { await Bun.sleep(250); try { process.kill(p.pid, 0) } catch { break } }
  if (p.tmuxSession?.startsWith('po-')) tmux('kill-session', '-t', p.tmuxSession)
  let moved = false
  if (f && existsSync(f)) {
    const bin = existsSync(join(homedir(), '.Trash')) ? join(homedir(), '.Trash') : join(D.base, 'fired')
    const trash = join(bin, `像素辦公室解雇-${dayOf(Date.now())}`)
    const dst = join(trash, `${who.replace(/[\/\\:]/g, '_')}-codex-${p.thread.slice(0, 8)}.jsonl`)
    try { mkdirSync(trash, { recursive: true }); if (!existsSync(dst)) { renameSync(f, dst); moved = true } } catch {}
  }
  return { ok: true, text: `👋 刪除了 ${who}（Codex）：${moved ? '對話紀錄丟到垃圾桶了' : '對話紀錄沒搬動'}` }
}

// ---------- 新員工卡在確認畫面（0.63.3）----------
// 手機招的 claude／codex 開在電腦背景的 tmux：剛開時可能停在自己的確認畫面（Codex 外掛重裝後的「Hooks need review」、
// 信任資料夾、工作資料夾外的讀取…），手機上什麼都看不到，像招不了。開出後 60 秒內每 3 秒 capture-pane 看一次，
// 看到就放進通知列；不代按（要使用者自己到電腦上決定）。畫面不在了就自己拿掉
export const STUCK_PATTERNS: [RegExp, string][] = [
  [/Hooks need review/i, 'Hooks need review（Codex 要你確認外掛的 hook）'],
  [/trust (the files in )?this folder|trust the contents of this directory|Do you trust|I trust this folder/i, '要不要信任這個資料夾'],
  [/Allow this read outside/i, 'Allow this read outside the working directories?'],
  [/New MCP server found|Use this and all future MCP servers/i, '要不要啟用這個資料夾的 MCP 伺服器'],
  [/Select login method|Sign in with ChatGPT|Please run \/login|Not logged in/i, '要登入'],
  [/Choose the text style|Let's get started/i, '第一次使用的設定畫面'],
  [/Do you want to (proceed|make this edit|allow)|Would you like to run the following command|Allow command\?/i, '權限確認'],
]
/** 從畫面認出確認畫面：回傳標題（認不出回 undefined） */
export function stuckTitle(screen: string): string | undefined {
  for (const [re, t] of STUCK_PATTERNS) if (re.test(screen)) return t
  return
}
export const STUCK_WATCH_MS = 60e3, STUCK_EVERY_MS = 3000, STUCK_KEEP_MS = 30 * 60e3
export type StuckOpt = { id: string; label: string }
type Stuck = { id: string; name: string; session: string; title: string; at: number; options: StuckOpt[]; win?: boolean; dir?: string }
const stuck = new Map<string, Stuck>()
/** 招聘開出後呼叫：60 秒內偵測；偵測到之後每 5 秒確認畫面還在，最多留 30 分鐘 */
export function watchHire(session: string, name: string, capture = (s: string) => tmux('capture-pane', '-p', '-t', `=${s}:`).stdout.toString(), t0 = Date.now()) {
  const check = () => {
    const now = Date.now()
    const r = tmux('has-session', '-t', `=${session}`)
    const screen = r.exitCode === 0 ? capture(session) : ''
    const title = screen ? stuckTitle(screen) : undefined
    if (title) {
      const s = stuck.get(session)
      stuck.set(session, { id: s?.id ?? crypto.randomUUID().slice(0, 8), name, session, title, at: s?.at ?? now, options: stuckOptions(screen).map(o => ({ id: o.id, label: o.label })) })
      if (now - t0 < STUCK_KEEP_MS) setTimeout(check, 5000)
      else stuck.delete(session)
      return
    }
    const was = stuck.delete(session)
    if (r.exitCode !== 0) return
    if (was || now - t0 < STUCK_WATCH_MS) setTimeout(check, was ? 5000 : STUCK_EVERY_MS)
  }
  setTimeout(check, STUCK_EVERY_MS)
}
/**
 * Windows 招聘開出後呼叫（沒有畫面可抓）：90 秒內名冊沒有這個 sid → 通知卡「可能停在確認畫面，請到電腦看標題是 <名字> 的視窗」，
 * 不給選項按鈕。之後每 5 秒再看：進辦公室了、視窗程序結束了、或滿 30 分鐘就拿掉
 */
export const WIN_STUCK_MS = 90e3
export function watchWinHire(sid: string, name: string, pid?: number, t0 = Date.now(), alive = (p: number) => pidAlive(p), every = 5000, dir?: string) {
  const key = `win-${sid}`
  const check = () => {
    const now = Date.now()
    if (D.people().some(p => p.id === sid) || (LAUNCH_PREFIX.test(sid) && agyByLaunch(sid)) || (pid && !alive(pid)) || now - t0 > STUCK_KEEP_MS) { stuck.delete(key); return }
    if (now - t0 >= WIN_STUCK_MS && !stuck.has(key)) stuck.set(key, { id: crypto.randomUUID().slice(0, 8), name, session: name, title: '開了但還沒進辦公室', at: now, options: [], win: true, ...(dir ? { dir } : {}) })
    setTimeout(check, every).unref?.()
  }
  setTimeout(check, every).unref?.()
}
/** 給手機通知列 */
export const stuckView =() => [...stuck.values()].map(s => ({ ...s, options: s.options.map(o => ({ ...o })) }))

// ---------- 在手機上按確認（0.63.4）----------
// 使用者在通知卡上點選項 → 伺服器對那個 tmux 送按鍵。只限上面 watchHire 盯著的、正卡住的 po-* session；
// 只送畫面上解析出來的選項（方向鍵移到那一項＋Enter、Esc、y／n），不能送任意字。送之前重抓畫面再解析一次，
// 對不上（畫面換了、那個選項不見了）就不送
type ParsedOpt = StuckOpt & { keys: string[] }
const BOX = /^\s*[│┃║]|[\s│┃║]+$/g
/** 從畫面解析可以按的選項：最後一段 1. 2. 3. 編號清單（游標 ❯／› 所在＝目前選的那項）；沒有編號清單時看 (y/n)；有 Esc 提示加「取消」 */
export function stuckOptions(screen: string): ParsedOpt[] {
  const lines = screen.split('\n').map(l => l.replace(BOX, ''))
  let run: { n: number; label: string; cur: boolean }[] = [], best: typeof run = []
  for (const l of lines) {
    const m = /^\s*([❯›>▶]\s*)?(\d{1,2})[.)]\s+(.{1,80}?)\s*$/.exec(l)
    if (m && +m[2] === run.length + 1) run.push({ n: +m[2], label: m[3], cur: !!m[1] })
    else if (m && +m[2] === 1) run = [{ n: 1, label: m[3], cur: !!m[1] }]
    else if (l.trim() && !/^\s{2,}\S/.test(l)) { if (run.length >= 2) best = run; run = [] } // 選項底下縮排的說明行不斷開清單
    if (run.length >= 2) best = run
  }
  const out: ParsedOpt[] = []
  if (best.length >= 2) {
    const cur = Math.max(0, best.findIndex(o => o.cur))
    for (const o of best) {
      const d = o.n - 1 - cur
      out.push({ id: `n${o.n}`, label: `${o.n}. ${o.label}`, keys: [...Array(Math.abs(d)).fill(d > 0 ? 'Down' : 'Up'), 'Enter'] })
    }
  } else if (/\((y|Y)\/(n|N)\)|\[(y|Y)\/(n|N)\]/.test(screen)) {
    out.push({ id: 'y', label: '是（y）', keys: ['y', 'Enter'] }, { id: 'n', label: '否（n）', keys: ['n', 'Enter'] })
  } else if (/enter to (confirm|continue)|press enter/i.test(screen)) {
    out.push({ id: 'enter', label: '確認（Enter）', keys: ['Enter'] })
  }
  if (/esc(ape)? (to )?(cancel|exit|go back|skip)/i.test(screen)) out.push({ id: 'esc', label: '取消（Esc）', keys: ['Escape'] })
  return out
}

export type StuckIO = { capture: (s: string) => string; send: (s: string, key: string) => boolean; sleep: (ms: number) => Promise<void> }
const realIO: StuckIO = {
  capture: s => tmux('capture-pane', '-p', '-t', s).stdout.toString(),
  send: (s, k) => tmux('send-keys', '-t', s, k).exitCode === 0,
  sleep: ms => new Promise(r => setTimeout(r, ms)),
}
/** 使用者在手機上點了卡片的選項 */
export async function pressStuck(id: string, opt: string, io: StuckIO = realIO): Promise<{ ok: boolean; text: string }> {
  const s = [...stuck.values()].find(x => x.id === id)
  if (!s) return { ok: false, text: '這個確認畫面已經不在了' }
  if (!s.options.some(o => o.id === opt)) return { ok: false, text: '卡片上沒有這個選項' }
  const now = io.capture(s.session)
  const title = stuckTitle(now), o = stuckOptions(now).find(x => x.id === opt)
  if (!title) { stuck.delete(s.session); return { ok: false, text: '畫面已經離開了（可能在電腦上處理掉了），沒有送按鍵' } }
  if (title !== s.title || !o || o.label !== s.options.find(x => x.id === opt)!.label) {
    s.title = title; s.options = stuckOptions(now).map(x => ({ id: x.id, label: x.label }))
    return { ok: false, text: '畫面換了，沒有送按鍵；看一下新的選項再按' }
  }
  for (const k of o.keys) { if (!io.send(s.session, k)) return { ok: false, text: tmuxReadonly() ? READONLY_TEXT : '按鍵送不過去（tmux 失敗）' }; await io.sleep(80) }
  await io.sleep(1500)
  const after = io.capture(s.session), t2 = stuckTitle(after)
  if (!t2) { stuck.delete(s.session); return { ok: true, text: `✅ 替 ${s.name} 按了「${o.label}」，確認畫面已經離開` } }
  const o2 = stuckOptions(after).map(x => ({ id: x.id, label: x.label }))
  const same = t2 === s.title && JSON.stringify(o2) === JSON.stringify(s.options) && after === now
  s.title = t2; s.options = o2
  return same ? { ok: false, text: `按了「${o.label}」，但畫面沒變；可能要到電腦上 tmux attach -t ${s.session} 看` }
    : { ok: true, text: `按了「${o.label}」，接著又出現：${t2}` }
}
/** 測試用 */
export const _stuck = stuck

// ---------- 投入程度＋模式（0.63.9；像素顧問定案規格，使用者確認過）----------
// Claude：投入程度（effort）隨時可換：外掛在線就由外掛改每次請求的 effort（不動設定），不然 tmux 打 /effort
//   （/effort 會順手存成新對話的預設：5 秒後改回原值，同 setModel）。模式只有 tmux 開的能換：Shift+Tab 循環
//   auto → manual → accept edits → plan，讀畫面最底下那行確認；外掛沒有切模式的方法，App 開的回原因。
// Codex（只限 tmux 開的）：/model --reasoning=<級>（只換這個對話）；/permissions 開選單、照標籤移過去選（實測 0.171）。
//   不提供 --dangerously-bypass-approvals-and-sandbox；Full Access（danger-full-access）等主管問使用者
// 目前的值：Claude 的 effort 由外掛回報（alive.json），tmux 的模式讀畫面；其他（Codex 全部）記在 hr/<id>.ctl.json（招聘時、手機換過的）
export const EFFORTS = [{ v: 'low', name: '低' }, { v: 'medium', name: '中' }, { v: 'high', name: '高' }, { v: 'xhigh', name: '很高' }, { v: 'max', name: '最高' }] as const
export const PERMS = [
  { v: 'auto', name: '自動', desc: 'Claude 處理權限決策' },
  { v: 'default', name: '手動', desc: '進行變更前一律先詢問' },
  { v: 'acceptEdits', name: '接受編輯', desc: '自動接受所有檔案編輯' },
  { v: 'plan', name: '規劃', desc: '進行變更前先建立計畫' },
] as const
export const CODEX_EFFORTS = [...EFFORTS, { v: 'ultra', name: '極限' }] as const
export const CODEX_PERMS = [
  { v: 'read-only', name: '唯讀', desc: '只能讀工作資料夾，修改和上網都要先問' },
  { v: 'default', name: '手動', desc: '可讀寫工作資料夾、執行指令；Codex 判斷需要時才停下來問你（上網、改工作資料夾外的檔）' },
  { v: 'auto', name: '自動', desc: '只有看起來有風險的動作才問（手機招聘的預設）' },
] as const
const PERM_CLI: Record<string, string> = { auto: 'auto', default: 'manual', acceptEdits: 'acceptEdits', plan: 'plan' }
/** Codex 招聘時的權限參數 */
// 手動、唯讀明定 reviewer＝user（0.63.21，複驗第 12 項：使用者設定的預設若是 auto_review，「手動」會變成自動）
export const CODEX_PERM_ARGS: Record<string, string[]> = { auto: ['--approve-for-me'], default: ['-s', 'workspace-write', '-a', 'on-request', '-c', 'approvals_reviewer="user"'], 'read-only': ['-s', 'read-only', '-a', 'on-request', '-c', 'approvals_reviewer="user"'] }
const own = (o: object, k: string) => Object.hasOwn(o, k) // 查表只認自己的鍵（複驗第 12 項：perm＝constructor 之類會拿到繼承的屬性）
const has = (list: readonly { v: string }[], v: unknown) => list.some(x => x.v === v)

// 每欄各記時間（0.63.22，最後複驗第 2 項）：原本整份一個 at，只換權限也把招聘時的舊模型「刷新」成比紀錄新，卡片就退回舊模型
type Ctl = { model?: string; effort?: string; perm?: string; modelAt?: number; effortAt?: number; permAt?: number; at?: number }
const ctlFile = (id: string) => join(hrDir(), `${id}.ctl.json`)
export function ctlGet(id: string): Ctl { try { return JSON.parse(readFileSync(ctlFile(id), 'utf8')) ?? {} } catch { return {} } }
export function ctlSet(id: string, patch: Pick<Ctl, 'model' | 'effort' | 'perm'>) {
  try {
    const now = Date.now(), next: Ctl = { ...ctlGet(id), at: now }
    for (const k of ['model', 'effort', 'perm'] as const) if (k in patch) { if (patch[k] === undefined) { delete next[k]; delete next[`${k}At`] } else { next[k] = patch[k]; next[`${k}At`] = now } }
    mkdirSync(hrDir(), { recursive: true }); writeFileSync(ctlFile(id), JSON.stringify(next))
  } catch {}
}

/** Claude 畫面最底下那行 → 模式 */
export function permOfScreen(screen: string): string | undefined {
  const tail = screen.split('\n').filter(l => l.trim()).slice(-3).join('\n')
  if (/auto mode on/i.test(tail)) return 'auto'
  if (/manual mode on/i.test(tail)) return 'default'
  if (/accept edits on/i.test(tail)) return 'acceptEdits'
  if (/plan mode on/i.test(tail)) return 'plan'
  return
}
const permSeen = new Map<string, { v?: string; at: number }>()
function permCached(id: string, pane: string, now = Date.now()) {
  const c = permSeen.get(id)
  if (c && now - c.at < 5000) return c.v
  const v = permOfScreen(tmux('capture-pane', '-p', '-t', pane).stdout.toString())
  permSeen.set(id, { v: v ?? c?.v, at: now })
  return v ?? c?.v
}
const effSwitching = new Map<string, { v: string; at: number }>()
/** hrOf 多帶的：effort、perm、permCtl（能不能換模式）、effortSwitching */
export function modeOf(id: string, p: { sessionId: string; pane?: string }, now = Date.now()) {
  let alive: any
  try { alive = JSON.parse(readFileSync(join(hrDir(), `${p.sessionId}.alive.json`), 'utf8')) } catch {}
  const ctl = ctlGet(id)
  const effort = typeof alive?.effort === 'string' ? alive.effort : ctl.effort
  const sw = effSwitching.get(id)
  if (sw && (now - sw.at > 10 * 60e3 || sw.v === alive?.effort)) effSwitching.delete(id)
  const perm = p.pane ? permCached(id, p.pane, now) : undefined
  return { effort, perm, permCtl: !!p.pane, ...(effSwitching.get(id) ? { effortSwitching: effSwitching.get(id)!.v } : {}) }
}

/** /effort、/model 會順手改「新對話的預設」：記下 settings.json 那幾欄，5 秒後改回（同 setModel 的做法） */
function restoreSettingsLater(configDir: string, keys: string[]) {
  const f = join(configDir, 'settings.json')
  let before: Record<string, unknown>
  try { const j = JSON.parse(readFileSync(f, 'utf8')); before = Object.fromEntries(keys.map(k => [k, j[k]])) } catch { return }
  setTimeout(() => {
    try {
      const j = JSON.parse(readFileSync(f, 'utf8'))
      if (keys.every(k => JSON.stringify(j[k]) === JSON.stringify(before[k]))) return
      for (const k of keys) { if (before[k] === undefined) delete j[k]; else j[k] = before[k] }
      writeFileSync(f, JSON.stringify(j, null, 2) + '\n')
    } catch {}
  }, 5000)
}

export async function setEffort(id: string, effort: string): Promise<{ ok: boolean; text: string }> {
  if (!has(EFFORTS, effort)) return { ok: false, text: '不認得的投入程度' }
  const p = procOf(id)
  if (!p) return { ok: false, text: '這位已經不在線' }
  const name = EFFORTS.find(x => x.v === effort)!.name
  if (hrAlive(p.sessionId)) {
    const r = await hrAsk(p.sessionId, { op: 'effort', effort })
    if (!r) return { ok: false, text: '他沒有回應，晚點再試' }
    // 外掛還是舊版（不認得 effort）：開在 tmux 的退回打 /effort，不然請他重載外掛
    if (!r.ok && !(p.pane && /不認得的動作/.test(r.msg))) return { ok: false, text: /不認得的動作/.test(r.msg) ? NO_HR : `沒換成：${r.msg}` }
    if (r.ok) {
      ctlSet(id, { effort }); effSwitching.set(id, { v: effort, at: Date.now() })
      return { ok: true, text: `🎚 ${nameOf(id)} 投入程度換成「${name}」（下一次回覆開始）` }
    }
  }
  if (!p.pane) return { ok: false, text: NO_HR }
  restoreSettingsLater(p.configDir, ['effortLevel', 'modelSettings'])
  const no = await typeLine(p.pane, `/effort ${effort}`, nameOf(id), 200)
  if (no) return { ok: false, text: no }
  await Bun.sleep(1200)
  // 看最底下幾行有沒有「換成這一級」的新訊息（審查第 11 項：不要讀到畫面上舊的成功訊息）
  const ok = new RegExp(`Set effort level to ${effort}\\b`, 'i').test(tmux('capture-pane', '-p', '-t', p.pane).stdout.toString().split('\n').slice(-15).join('\n'))
  ctlSet(id, { effort })
  return ok ? { ok: true, text: `🎚 ${nameOf(id)} 投入程度換成「${name}」` } : { ok: false, text: '送了 /effort，但畫面上沒看到換好（可能正在忙），晚點再看一次' }
}

export async function setPerm(id: string, perm: string, sleep = (ms: number) => Bun.sleep(ms)): Promise<{ ok: boolean; text: string }> {
  if (!has(PERMS, perm)) return { ok: false, text: '不認得的模式' }
  const p = procOf(id)
  if (!p) return { ok: false, text: '這位已經不在線' }
  if (!p.pane) return { ok: false, text: 'App 開的 Claude 要在 App 裡切模式（外掛沒辦法替它切；只有從手機招聘、開在電腦背景的可以）' }
  const name = PERMS.find(x => x.v === perm)!.name
  for (let i = 0; i < 6; i++) {
    const screen = tmux('capture-pane', '-p', '-t', p.pane).stdout.toString()
    const cur = permOfScreen(screen)
    if (cur === perm) { permSeen.set(id, { v: perm, at: Date.now() }); ctlSet(id, { perm }); return { ok: true, text: `🔐 ${nameOf(id)} 換成「${name}」模式` } }
    if (!cur) return { ok: false, text: stuckTitle(screen) ? '他正停在確認畫面，先處理那個再換模式' : '看不出他現在是什麼模式（可能開著選單），晚點再試' }
    if (tmux('send-keys', '-t', p.pane, 'BTab').exitCode !== 0) return { ok: false, text: tmuxReadonly() ? READONLY_TEXT : '按鍵送不過去' }
    await sleep(700)
  }
  return { ok: false, text: '按了幾次 Shift+Tab 還是沒切到，請到電腦上看一下' }
}

/** 招聘 Claude 時：模式、投入程度的參數（沒帶＝auto、medium） */
export function claudeModeArgs(b: any): { args: string[]; effort: string; perm: string } | string {
  const effort = b?.effort === undefined || b?.effort === '' ? 'medium' : String(b.effort)
  const perm = b?.perm === undefined || b?.perm === '' ? 'auto' : String(b.perm)
  if (!has(EFFORTS, effort)) return '不認得的投入程度'
  if (!has(PERMS, perm)) return '不認得的模式'
  return { args: ['--permission-mode', PERM_CLI[perm], '--effort', effort], effort, perm }
}
/** 招聘 Codex 時：權限、投入程度的參數（沒帶＝auto、模型預設） */
export function codexModeArgs(b: any): { args: string[]; effort?: string; perm: string } | string {
  const perm = b?.perm === undefined || b?.perm === '' ? 'auto' : String(b.perm)
  const effort = b?.effort === undefined || b?.effort === '' || b?.effort === 'default' ? undefined : String(b.effort)
  if (!own(CODEX_PERM_ARGS, perm)) return '不認得的權限'
  if (effort !== undefined && !has(CODEX_EFFORTS, effort)) return '不認得的投入程度'
  return { args: [...CODEX_PERM_ARGS[perm], ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : [])], effort, perm }
}

/** 模型支援的投入程度（models_cache.json 的 supported_reasoning_levels） */
export function codexEffortsOf(slug: string | undefined, home = CODEX_HOME()): string[] | undefined {
  try {
    const j = JSON.parse(readFileSync(join(home, 'models_cache.json'), 'utf8'))
    const m = (Array.isArray(j) ? j : j.models ?? []).find((x: any) => x?.slug === slug)
    return m ? (m.supported_reasoning_levels ?? []).map((l: any) => (typeof l === 'string' ? l : l?.effort)).filter((x: unknown) => typeof x === 'string') : undefined
  } catch { return }
}

export async function codexEffort(id: string, effort: string, sleep = (ms: number) => Bun.sleep(ms)): Promise<{ ok: boolean; text: string }> {
  if (!has(CODEX_EFFORTS, effort)) return { ok: false, text: '不認得的投入程度' }
  const p = codexProc(id)
  if (!p) return { ok: false, text: '這位已經不在線' }
  if (!p.pane || p.shared) return { ok: false, text: NOT_TMUX }
  const cur = codexSettings(id).model // 照實際的模型驗（0.63.19：原本只看 ctl 快取）
  const ok = codexEffortsOf(cur)
  if (cur && !ok) return { ok: false, text: `不認得目前的模型 ${cur}，先不換投入程度` }
  if (ok && !ok.includes(effort)) return { ok: false, text: `${cur} 沒有這個投入程度` }
  const why = await codexSend(p.pane, `/model --reasoning=${effort}`, sleep)
  if (why) return { ok: false, text: why }
  await sleep(800)
  const st = await codexStatus(p.pane, sleep) // 讀回實際生效的值（審查第 11 項：不看畫面上可能是舊的「Model changed」）
  if (!st?.effort) return { ok: false, text: '送了，但讀不到目前的設定，晚點再看一次' }
  ctlSet(id, { effort: st.effort, ...(st.model && codexSlugOf(st.model) ? { model: codexSlugOf(st.model) } : {}) })
  if (st.effort !== effort) return { ok: false, text: `送了，但現在還是「${st.effort}」` }
  return { ok: true, text: `🎚 Codex 投入程度換成「${CODEX_EFFORTS.find(x => x.v === effort)!.name}」` }
}

/**
 * Codex 的權限（0.63.12，審查第 12 項）：用 /permissions <profile> --reviewer=… 直接設（實測 0.171），不再照英文標籤在選單裡移；
 * 換完用 /status 讀回實際生效的值才算
 */
// 審核方式、核准政策都明定（複驗第 12 項；實測 0.171 收 --approval-policy）
const CODEX_PERM_CMD: Record<string, string> = { 'read-only': ':read-only --reviewer=user --approval-policy=on-request', default: ':workspace --reviewer=user --approval-policy=on-request', auto: ':workspace --reviewer=auto_review --approval-policy=on-request' }
export async function codexPerm(id: string, perm: string, sleep = (ms: number) => Bun.sleep(ms)): Promise<{ ok: boolean; text: string }> {
  if (!own(CODEX_PERM_CMD, perm)) return { ok: false, text: '不認得的權限' }
  const arg = CODEX_PERM_CMD[perm]
  const p = codexProc(id)
  if (!p) return { ok: false, text: '這位已經不在線' }
  if (!p.pane || p.shared) return { ok: false, text: NOT_TMUX }
  const why = await codexSend(p.pane, `/permissions ${arg}`, sleep)
  if (why) return { ok: false, text: why }
  await sleep(800)
  const st = await codexStatus(p.pane, sleep)
  if (!st?.perm) return { ok: false, text: '送了，但讀不到目前的設定，晚點再看一次' }
  if (st.perm !== 'other') ctlSet(id, { perm: st.perm })
  if (st.perm !== perm) return { ok: false, text: '送了，但讀回來的權限不是你選的，請到電腦上看一下' }
  return { ok: true, text: `🔐 Codex 換成「${CODEX_PERMS.find(x => x.v === perm)!.name}」` }
}


// ---------- 每個人實際開在哪、手機能替他做什麼（0.63.16，審查第 14 項；欄位跟像素工程師對過）----------
// src：'tmux'（手機招聘、開在電腦背景）｜'app'（Claude／ChatGPT App 裡）｜'terminal'（一般終端機視窗）｜'other'｜'unknown'
// can：{ model, effort, perm, key, fire }；why：不能做的理由（某鍵沒給就看 all）。前端有 can 就以它為準，不再用 !ctl 推論
export type Cap = { src: 'tmux' | 'app' | 'terminal' | 'other' | 'unknown'; can: { model: boolean; effort: boolean; perm: boolean; key: boolean; fire: boolean; handoffApp?: boolean; handoffTmux?: boolean }; why?: Partial<Record<'model' | 'effort' | 'perm' | 'key' | 'fire' | 'all' | 'handoffApp' | 'handoffTmux', string>> }
const capUnknown: Cap = { src: 'unknown', can: { model: false, effort: false, perm: false, key: false, fire: false }, why: { all: '還判斷不出開在哪，先不能從手機操作' } }
function claudeCap(p: { app: boolean; pane?: string }, alive: boolean): Cap {
  const src = p.pane ? 'tmux' : p.app ? 'app' : 'terminal'
  const reach = !!p.pane || alive // 外掛在線（新版）或開在 tmux：換智力、投入程度、打斷都行
  const why: Cap['why'] = {}
  if (!reach) why.all = NO_HR
  if (!p.pane) why.perm = p.app ? 'App 開的 Claude 要在 App 裡切模式' : '不是從手機招聘、開在電腦背景的，沒辦法替它切模式（外掛沒有切模式的方法）'
  return { src, can: { model: reach, effort: reach, perm: !!p.pane, key: reach, fire: true }, why }
}
/** Codex：只有開在 tmux（不是 App 的共用程序）的能操作 */
export function codexCap(id: string): Cap {
  const p = codexProc(id)
  if (!p) return capUnknown
  if (p.shared) { // 審查第 14 項：App 還開著這段（握著寫入鎖）就不能接回，給原因
    const held = codexLocked(p.thread, typeof codexSession(id)?.codexHome === 'string' ? codexSession(id).codexHome : undefined)
    return { src: 'app', can: { model: false, effort: false, perm: false, key: false, fire: false, handoffApp: false, handoffTmux: held === false }, why: { all: NOT_TMUX, handoffApp: '已經在 App 裡', ...(held !== false ? { handoffTmux: held ? '這段對話還開在 App 裡，先在 App 關掉' : '看不出這段對話有沒有開在別的地方' } : {}) } }
  }
  if (!p.pane && paneProbeFailed) return capUnknown
  if (!p.pane) return { src: 'terminal', can: { model: false, effort: false, perm: false, key: false, fire: false }, why: { all: '開在一般終端機視窗的 Codex 沒辦法從手機操作（只有從手機招聘、開在電腦背景的可以）' } }
  return { src: 'tmux', can: { model: true, effort: true, perm: true, key: true, fire: true, handoffApp: true, handoffTmux: false }, why: { handoffTmux: '已經在電腦背景' } }
}
export const agyCap: Cap = { src: 'other', can: { model: false, effort: false, perm: false, key: false, fire: false }, why: { all: 'agy 不能從手機操作' } }

/** models_cache 裡看得到的全部模型（換模型只接受這些；0.63.19） */
export function codexAllModels(home = CODEX_HOME()): { slug: string; name: string; efforts: string[] }[] {
  try {
    const j = JSON.parse(readFileSync(join(home, 'models_cache.json'), 'utf8'))
    return (Array.isArray(j) ? j : j.models ?? []).filter((m: any) => m && m.visibility === 'list' && typeof m.slug === 'string')
      .map((m: any) => ({ slug: m.slug, name: String(m.display_name ?? m.slug), efforts: (m.supported_reasoning_levels ?? []).map((l: any) => (typeof l === 'string' ? l : l?.effort)).filter((x: unknown) => typeof x === 'string') }))
  } catch { return [] }
}
/** /status 顯示的名稱（GPT-6.1 Terra）→ slug（gpt-6.1-terra） */
export function codexSlugOf(display: string, home = CODEX_HOME()): string | undefined {
  const d = display.trim()
  return codexAllModels(home).find(m => m.name === d || m.slug === d.toLowerCase().replace(/\s+/g, '-'))?.slug
}
/** turn_context 的權限 → 手機的值：唯讀／手動（reviewer user）／自動（auto_review）；其他（例如 Full Access）回 other */
export function permOfContext(p: any): string | undefined {
  // 新版記 active_permission_profile.id；舊一點的只有 sandbox_policy.type（2026-11-24 兩種都看過）
  const id = p?.active_permission_profile?.id ?? ({ 'read-only': ':read-only', 'workspace-write': ':workspace', 'danger-full-access': ':danger-full-access' } as Record<string, string>)[p?.sandbox_policy?.type]
  if (!id) return
  if (id === ':read-only') return 'read-only'
  if (id === ':workspace') return p.approvals_reviewer === 'auto_review' ? 'auto' : 'default'
  return 'other'
}
/** 模型的預設投入程度（turn_context 的 effort 是 null＝照模型預設） */
export function codexDefaultEffort(slug: string | undefined, home = CODEX_HOME()): string | undefined {
  try {
    const j = JSON.parse(readFileSync(join(home, 'models_cache.json'), 'utf8'))
    const m = (Array.isArray(j) ? j : j.models ?? []).find((x: any) => x?.slug === slug)
    return typeof m?.default_reasoning_level === 'string' ? m.default_reasoning_level : undefined
  } catch { return }
}
/**
 * Codex 目前的模型、投入程度、權限（0.63.19）：讀它對話紀錄最後一個 turn_context（每一輪開始時 Codex 記下的實際設定），
 * 不用打字進它的對話。手機剛換過、下一輪還沒跑的，ctl 檔比紀錄新就用 ctl
 */
const ctxSeen = new Map<string, { mtime: number; v: { model?: string; effort?: string; perm?: string } }>()
export function codexSettings(id: string): { model?: string; effort?: string; perm?: string } {
  const thread = /^codex-([0-9a-f-]{8,64})$/.exec(id)?.[1]
  const ctl = ctlGet(id)
  const f = thread ? codexTranscript(thread) : undefined
  let fromLog: { model?: string; effort?: string; perm?: string } = {}, mtime = 0
  if (f) {
    try {
      mtime = statSync(f).mtimeMs
      const hit = ctxSeen.get(f)
      if (hit && hit.mtime === mtime) fromLog = hit.v
      else {
        const fd = openSync(f, 'r'), size = fstatSync(fd).size, n = Math.min(size, 512 * 1024), buf = Buffer.alloc(n)
        try { readSync(fd, buf, 0, n, size - n) } finally { closeSync(fd) }
        const line = buf.toString('utf8').split('\n').reverse().find(l => l.includes('"type":"turn_context"'))
        const p = line ? JSON.parse(line).payload : undefined
        const eff = typeof p?.effort === 'string' ? p.effort : typeof p?.model === 'string' ? codexDefaultEffort(p.model) : undefined
        fromLog = p ? { ...(typeof p.model === 'string' ? { model: p.model } : {}), ...(eff ? { effort: eff } : {}), ...(permOfContext(p) ? { perm: permOfContext(p) } : {}) } : {}
        ctxSeen.set(f, { mtime, v: fromLog })
      }
    } catch {}
  }
  // 每欄自己比：那一欄手機換過、而且比紀錄新才用手機記的（舊格式沒有每欄時間的，當成跟紀錄一樣舊）
  const pick = (k: 'model' | 'effort' | 'perm') => (Number(ctl[`${k}At`] ?? 0) > mtime ? ctl[k] ?? fromLog[k] : fromLog[k] ?? ctl[k])
  const out: { model?: string; effort?: string; perm?: string } = {}
  for (const k of ['model', 'effort', 'perm'] as const) { const v = pick(k); if (v) out[k] = v }
  return out
}

// ---------- 關掉 App 分頁就解雇（0.63.24，remote/apptabs.ts）用的程序資訊 ----------
// Windows 沒有 ps（0.63.62）：一次撈整張程序表（父程序、啟動時間），留 10 秒；Claude Desktop 的分頁跟 Mac 一樣都是同一個主程序的子程序（2026-11-26 實測）
let winTable: { at: number; m: Map<number, { ppid: string; start: string }> } | undefined
function winProc(pid: number) {
  if (!winTable || Date.now() - winTable.at > 10e3) {
    const m = new Map<number, { ppid: string; start: string }>()
    const r = spawnSyncW(['powershell', '-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.CreationDate.ToString(\'o\'))" }'], { stdout: 'pipe', stderr: 'pipe', timeout: EXT_TIMEOUT_MS, killSignal: 'SIGKILL' })
    if (r.exitCode === 0) for (const l of r.stdout.toString().split(/\r?\n/)) { const [a, b, c] = l.trim().split(' '); if (a && b && c) m.set(Number(a), { ppid: b, start: c }) }
    winTable = { at: Date.now(), m }
  }
  return winTable.m.get(pid)
}
const psOf = (pid: number, field: 'ppid' | 'lstart') => process.platform === 'win32' ? (field === 'ppid' ? winProc(pid)?.ppid : winProc(pid)?.start) ?? '' : psUnix(pid, field)
const psUnix = (pid: number, field: string) => { try { const r = Bun.spawnSync(['ps', '-o', `${field}=`, '-p', String(pid)], { stdout: 'pipe', stderr: 'pipe', timeout: EXT_TIMEOUT_MS, killSignal: 'SIGKILL' }); return r.exitCode === 0 ? r.stdout!.toString().trim() : '' } catch { return '' } }
const tabSeen = new Map<number, { host: number; hostStart: string; at: number }>()
/** 這位是不是 Claude app 的分頁（entrypoint＝sdk-cli；Remote Control 接起來的對話也是）：是就回它的程序、父程序與父程序的啟動時間 */
export function appTabOf(id: string, now = Date.now()): { pid: number; host: number; hostStart: string } | undefined {
  const p = procOf(id)
  if (!p || !p.app) return
  const c = tabSeen.get(p.pid)
  if (c && now - c.at < 60e3) return { pid: p.pid, host: c.host, hostStart: c.hostStart }
  const host = Number(psOf(p.pid, 'ppid')) || 0
  const hostStart = host > 1 ? psOf(host, 'lstart') : ''
  if (!host || !hostStart) return
  tabSeen.set(p.pid, { host, hostStart, at: now })
  return { pid: p.pid, host, hostStart }
}
export const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true } catch (e: any) { return e?.code === 'EPERM' } }
export const pidStart = (pid: number) => psOf(pid, 'lstart') || undefined

/** 只讓這一個 Claude 對話重載外掛（0.63.25；驗證用，手機上沒有按鈕）：走對話裡外掛的人事通道，回它的回應 */
export async function hrReload(id: string): Promise<{ ok: boolean; text: string }> {
  const p = procOf(id)
  if (!p) return { ok: false, text: '這位已經不在線' }
  if (!hrAlive(p.sessionId)) return { ok: false, text: NO_HR }
  const r = await hrAsk(p.sessionId, { op: 'reload' })
  return r ? { ok: r.ok, text: r.msg } : { ok: false, text: '他沒有回應' }
}

// ---------- Codex「交給 App」「接回後台」（0.63.28；像素顧問定案、使用者「交給主管」）----------
// 交給 App：tmux 開的 Codex 打 /quit 自己收尾、放掉寫入鎖、關 tmux；記下上班地點、權限（hr/<id>.inapp.json），座位職稱主管不動。
// 接回後台：App 已經放掉寫入鎖（關掉那段對話）才在 tmux 用 codex resume 接同一段；握著就提示先在 App 關掉，不搶。
// 實測依據（2026-11-24／25）：App 的 app-server 只握開著的對話的鎖，關掉的放掉；鎖被握著時 resume 被拒（already has an active writer）
const CODEX_OFFICE_PY = join(import.meta.dir, '..', 'codex', 'codex_office.py')
/** 那段對話的寫入鎖有沒有人握著：true／false；看不出來 undefined（codex_office.py locked，Python 的 flock） */
export function codexLocked(thread: string, home?: string, timeoutMs = EXT_TIMEOUT_MS): boolean | undefined {
  const py = Bun.which('python3') ?? '/usr/bin/python3'
  if (timeoutMs < 200) return undefined
  const r = spawnSyncW([py, CODEX_OFFICE_PY, 'locked', thread, home ?? ''], { stdout: 'pipe', stderr: 'pipe', timeout: timeoutMs, killSignal: 'SIGKILL' })
  const v = r.stdout.toString().trim()
  return v === 'true' ? true : v === 'false' ? false : undefined
}
/** 非同步跑外部指令、限時（0.63.31：接回的探針不卡住伺服器）；回 stdout（失敗、逾時回空字串） */
async function runAsync(argv: string[], timeoutMs: number): Promise<string> {
  const r = await spawnBounded(argv, timeoutMs)
  return r.code === 0 ? r.out.trim() : ''
}
/**
 * 跑一個指令、最多等 ms：時間到就 SIGKILL 並立刻回逾時（code＝null），不等 stdout／stderr 結束（BUG-13：tmux 伺服器被暫停時，
 * 殺了 client 管子還可能被別的程序開著，等 EOF 會拖 60～90 秒）。拋錯也回 null。讀到的輸出在逾時時丟掉
 */
export async function spawnBounded(argv: string[], ms: number): Promise<{ code: number | null; out: string; err: string }> {
  const none = { code: null, out: '', err: '' }
  if (ms <= 0) return none
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' })
    // 自己拿 reader 讀：逾時時 cancel()，不留一直掛著的讀取（代審 N-1）
    const readers = [p.stdout, p.stderr].map(st => (st as ReadableStream<Uint8Array>).getReader())
    const readAll = async (rd: ReadableStreamDefaultReader<Uint8Array>) => { const parts: Uint8Array[] = []; for (;;) { const { done, value } = await rd.read(); if (done) break; parts.push(value) } return Buffer.concat(parts).toString() }
    const late = new Promise<'late'>(r => { timer = setTimeout(() => { try { p.kill(9) } catch {} r('late') }, ms) })
    const work = (async () => {
      const [out, err] = await Promise.all(readers.map(readAll))
      await p.exited
      return { code: p.exitCode as number | null, out, err }
    })()
    work.catch(() => {}) // 逾時後還在讀的那一份：出錯也不要變成未處理的拒絕
    const r = await Promise.race([work, late])
    if (r === 'late') { for (const rd of readers) rd.cancel().catch(() => {}); return none }
    return r
  } catch { return none } finally { clearTimeout(timer) }
}
/** 誰開著那段對話的寫入鎖檔（lsof -t）：核對持鎖的就是我們開的那個程序（0.63.30，複驗第 6 項） */
export function codexLockHolders(thread: string, home?: string): number[] {
  const f = join(home ?? CODEX_HOME(), 'thread-writer-locks', `${thread}.lock`)
  const r = Bun.spawnSync(['lsof', '-t', f], { stdout: 'pipe', stderr: 'pipe', timeout: EXT_TIMEOUT_MS, killSignal: 'SIGKILL' })
  return r.stdout.toString().split('\n').map(Number).filter(n => n > 0)
}
export const codexSession = (id: string): any => { try { return JSON.parse(readFileSync(join(D.base, 'sessions', `${id}.json`), 'utf8')) } catch { return undefined } }
const inAppFile = (id: string) => join(hrDir(), `${id}.inapp.json`)
export type InApp = { at: number; cwd?: string; perm?: string; home?: string; name?: string; addDirs?: string[]; state?: 'pending' | 'ready' }
export const inAppOf = (id: string): InApp | undefined => { try { return JSON.parse(readFileSync(inAppFile(id), 'utf8')) } catch { return } }
const BUSY_MODES = new Set(['thinking', 'typing', 'reading'])

const THREAD_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const pidDead = (pid: number) => { try { process.kill(pid, 0); return false } catch (e: any) { return e?.code !== 'EPERM' } }
/** 原子寫檔（暫存檔＋改名） */
function writeAtomic(f: string, data: unknown) { const tmp = `${f}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(data)); renameSync(tmp, f) }
/**
 * 在狀態檔的鎖裡改狀態檔（codex-trust 複驗 ②、第三輪 ①）：鎖是狀態檔旁的 <檔名>.flock，用核心的 flock，
 * codex/codex_office.py 的 status_lock 拿同一把；程序結束鎖就自動放，不用清「留下來的鎖」，也不會刪到別人的鎖。
 * Bun 沒有 flock，交給一小段 Python：拿鎖（最多等 waitMs）→ 重讀現在的檔（沒有就用 base）→ 蓋上 patch → 原子寫入。成功回 true
 */
const STATUS_WRITE_PY = [
  'import fcntl,json,os,sys,time',
  'f=sys.argv[1]; wait=float(sys.argv[2]); d=json.load(sys.stdin)',
  'os.makedirs(os.path.dirname(f), exist_ok=True)',
  "fd=os.open(f+'.flock', os.O_RDWR|os.O_CREAT, 0o600)",
  'end=time.monotonic()+wait',
  'while True:',
  '    try:',
  '        fcntl.flock(fd, fcntl.LOCK_EX|fcntl.LOCK_NB); break',
  '    except BlockingIOError:',
  '        if time.monotonic()>=end: sys.exit(3)',
  '        time.sleep(0.05)',
  'try:',
  "    cur=json.load(open(f, encoding='utf-8'))",
  'except Exception:',
  '    cur=None',
  "s=dict(cur if isinstance(cur, dict) else (d.get('base') or {})); s.update(d['patch'])",
  "tmp=f+'.%d.tmp' % os.getpid()",
  "open(tmp, 'w', encoding='utf-8').write(json.dumps(s, ensure_ascii=False)); os.replace(tmp, f)",
  "print('ok')",
].join('\n')
export async function writeStatusLocked(f: string, base: unknown, patch: Record<string, unknown>, waitMs = 2000): Promise<boolean> {
  try { // 非同步（Bun.spawn＋await）：等鎖的時候不卡住整個伺服器
    const p = Bun.spawn(['python3', '-I', '-B', '-c', STATUS_WRITE_PY, f, String(waitMs / 1000)], { stdin: new Blob([JSON.stringify({ base, patch })]), stdout: 'pipe', stderr: 'ignore' })
    const kill = setTimeout(() => { try { p.kill(9) } catch {} }, waitMs + 5000)
    const out = await new Response(p.stdout).text()
    const code = await p.exited
    clearTimeout(kill)
    return code === 0 && out.trim() === 'ok'
  } catch { return false }
}
/** 只關「這個功能開的、而且只有一個 pane」的 tmux session（審查第 3 項：不要連帶關掉別的 pane） */
function killOwnSession(session?: string, marker?: string) {
  if (!session || !/^po-cx[pr]-[0-9a-f-]+$/.test(session)) return
  const t = sessionIdOf(session) // 完整名稱對到的不可變 ID，不讓 tmux 用前綴對到別的 session（複驗新問題 1）
  if (!t) return
  const r = tmux('list-panes', '-s', '-t', t, '-F', '#{pane_id}')
  if (r.exitCode !== 0) return // 列不出來就不關（複驗第 3 項）
  if (marker !== undefined && launchMarker(session) !== marker) return // 只關證實是這次開的
  if (r.stdout.toString().trim().split('\n').filter(Boolean).length === 1) tmux('kill-session', '-t', t)
}
/**
 * 回收接回時自己開的那一格（0.63.33，複驗 0.63.32）：只關「這次建立的 pane」（kill-pane -t <pane ID>），不關整個 session，
 * 列舉之後使用者分割出來的 pane 也不會被一起關掉；session 剩空會自己結束。
 * 要 pane 還在這次的 session（$N）裡、標記驗過（marker＝undefined 時不驗，用在標記設不上的那條）；關完要 tmux 明確回
 * 列出所有 pane（指令成功）而且清單裡沒有它，才算收掉；逾時（exitCode null）或列舉失敗一律當成沒確認，回 false、保留標記
 */
type Run = (...a: string[]) => { exitCode: number | null; stdout: Buffer; stderr?: Buffer }
export function reapOwn(sid: string, pane: string, marker: string | undefined, run: Run = tmux): boolean {
  if (!/^\$\d+$/.test(sid) || !/^%\d+$/.test(pane)) return false
  if (marker !== undefined) { const m = run('show-options', '-v', '-t', sid, '@po_launch'); if (m.exitCode !== 0 || m.stdout.toString().trim() !== marker) return false }
  const owner = run('display', '-p', '-t', pane, '#{session_id}')
  if (owner.exitCode !== 0 || owner.stdout.toString().trim() !== sid) return false
  run('kill-pane', '-t', pane)
  // 確認不在了：列出所有 pane（指令要成功），清單裡沒有它才算（tmux 對已經不在的 pane 下 display 不會報錯，0.63.33 實測）
  const after = run('list-panes', '-a', '-F', '#{pane_id}')
  // 關掉的是最後一個 session 時 tmux 伺服器跟著結束：no server running＝確定不在了（0.63.46）
  if (after.exitCode !== 0) return /no server running/i.test(after.stderr?.toString() ?? '')
  return !after.stdout.toString().split('\n').map(l => l.trim()).includes(pane)
}
/**
 * 這次開的 pane 現在的狀態（0.63.38，生圖幫手審查第 1、4 項）：alive＝pane 還在、在原本的 session（$N）、標記對得上；
 * gone＝tmux 明確列出所有 pane 而沒有它，或 pane 已經換到別的 session、標記換了；unknown＝查不到（逾時、錯誤），不當成不在
 */
export function launchState(L: Launch, run: Run = tmux): 'alive' | 'gone' | 'unknown' { return launchProbe(L, run).state }
/** 確定不存在才算 gone（0.63.39，複驗第 2 項）：沒有 tmux 伺服器、列舉成功但沒有這格、session 確定不在；其他錯誤（連不上、逾時）一律 unknown */
const GONE_ERR = /no server running|can't find session|no such session/i
/**
 * 招聘的令（orders/cxp-xxxxxxxx.json）的去留（2026-11-25；審查 team-v2/codex-review-2026-11-25-order.md 後改）。
 * 原本兩小時就刪：卡在信任畫面一整晚的 Codex 進辦公室時令已經沒了（codex-x1）。現在：
 *   24 小時內：live（照常等它登記、對到就併），不查 tmux；
 *   超過 7 天：drop（tmux 還在也刪：防同名的舊令一直留著）；
 *   24 小時～7 天：看 tmux po-cxp-xxxxxxxx——alive＝live；gone（tmux 明確說沒有）＝drop；
 *   unknown（查不到）＝wait：不刪、也先不併，下一輪再查。
 * 併之前也照這個判斷：drop 的直接刪、不併；wait 的留到查得到再說
 */
export const CXP_ORDER_MIN_KEEP_MS = 24 * 3600e3, CXP_ORDER_MAX_KEEP_MS = 7 * 24 * 3600e3
export type CxpFate = 'live' | 'wait' | 'drop'
export function cxpOrderFate(ageMs: number, session: () => 'alive' | 'gone' | 'unknown'): CxpFate {
  if (ageMs <= CXP_ORDER_MIN_KEEP_MS) return 'live'
  if (ageMs > CXP_ORDER_MAX_KEEP_MS) return 'drop'
  const s = session()
  return s === 'alive' ? 'live' : s === 'gone' ? 'drop' : 'wait'
}
/**
 * 一次列出所有 tmux session 名稱：只有 tmux 伺服器有回應（exit 0）才算 ok＋名單；其他一律 unknown：
 * 逾時、啟動就拋錯（ENOENT 等）、連不上 socket（"no server running"、"error connecting … (No such file or directory)"）。
 * 連不上不等於伺服器不在：macOS 會清 /tmp 裡的 socket 檔，tmux 伺服器還活著（測試報告 2026-11-25 BUG-1）。
 * 代價：tmux 真的全關時，24 小時～7 天的招聘令要等到 7 天才刪（主管裁示可接受）。
 * fresh：這份名單是不是這一輪剛查的（快取拿到的是 false）。只有剛查的名單能證實「不在」（複驗新發現第 1 項）
 */
export type SessionList = { ok: true; names: Set<string>; fresh: boolean } | { ok: false; fresh: boolean }
export function tmuxSessionList(run: Run = tmux): SessionList {
  try {
    const r = run('list-sessions', '-F', '#{session_name}')
    if (r.exitCode === 0) return { ok: true, names: new Set(r.stdout.toString().split('\n').map(l => l.trim()).filter(Boolean)), fresh: true }
  } catch {} // 複驗新發現第 2 項：spawn 本身拋錯不能傳出名冊
  return { ok: false, fresh: true }
}
/** 名單限速：60 秒內共用上一次的結果（不在名冊請求裡逐檔跑 tmux），查不到的結果也照樣快取；只有真的要查時才呼叫 */
export const SESSION_LIST_EVERY_MS = 60e3
export function sessionListCache(list: () => SessionList = tmuxSessionList, every = SESSION_LIST_EVERY_MS) {
  let at = -Infinity, last: SessionList = { ok: false, fresh: false }
  return (now: number): SessionList => {
    if (now - at >= every) {
      at = now
      try { last = list() } catch { last = { ok: false, fresh: true } }
      return { ...last, fresh: true }
    }
    return { ...last, fresh: false }
  }
}
/**
 * 有了名單之後，某個 session 的狀態：名單上有＝alive；剛查、伺服器有回應的名單上沒有＝gone（唯一能刪的證據）；
 * 快取名單上沒有＝unknown（可能是查完之後才重開的，不能拿來刪；等下一份剛查的名單）；名單查不到＝unknown
 */
export const sessionState = (l: SessionList, name: string): 'alive' | 'gone' | 'unknown' => !l.ok ? 'unknown' : l.names.has(name) ? 'alive' : l.fresh ? 'gone' : 'unknown'
/**
 * 這一輪每張招聘令要怎麼處理：merge（對到了、而且 live）／drop（刪掉、不併）／keep（留著）。
 * 名單只在有令超過 24 小時、又沒對到人時才查（lazy），整輪共用一份；拿名單拋錯當查不到。對到人（codexProc 剛從 tmux 查到它在 po-cxp-xxx 裡）
 * 本身就是 tmux 還在的證據，比最多 60 秒前的名單新，當 alive；7 天上限照樣適用
 */
export function planCxpOrders(files: { k: string; ageMs: number; hit: boolean }[], list: () => SessionList): { k: string; act: 'merge' | 'drop' | 'keep' }[] {
  let l: SessionList | undefined
  const state = (k: string) => {
    if (!l) try { l = list() } catch { l = { ok: false, fresh: true } }
    return sessionState(l, `po-${k}`)
  }
  return files.map(f => {
    const fate = cxpOrderFate(f.ageMs, () => (f.hit ? 'alive' : state(f.k)))
    return { k: f.k, act: fate === 'drop' ? 'drop' : fate === 'live' && f.hit ? 'merge' : 'keep' }
  })
}
function launchProbe(L: Launch, run: Run): { state: 'alive' | 'gone' | 'unknown'; pid?: number } {
  if (!/^\$\d+$/.test(L?.tmux ?? '') || !/^%\d+$/.test(L?.pane ?? '')) return { state: 'gone' }
  const lp = run('list-panes', '-a', '-F', '#{pane_id} #{session_id} #{pane_pid}')
  if (lp.exitCode !== 0) return { state: lp.exitCode !== null && GONE_ERR.test(lp.stderr?.toString() ?? '') ? 'gone' : 'unknown' }
  const row = lp.stdout.toString().split('\n').map(l => l.trim().split(/\s+/)).find(([p]) => p === L.pane)
  if (!row || row[1] !== L.tmux) return { state: 'gone' }
  const m = run('show-options', '-v', '-t', L.tmux, '@po_launch')
  if (m.exitCode !== 0) return { state: m.exitCode !== null && GONE_ERR.test(m.stderr?.toString() ?? '') ? 'gone' : 'unknown' }
  return m.stdout.toString().trim() === L.marker ? { state: 'alive', pid: Number(row[2]) || undefined } : { state: 'gone' }
}
/** 格裡還是不是招聘時那一支程序（pane_pid＋啟動時間相同）：same／changed／unknown */
export function launchGen(L: Launch, run: Run = tmux, startOf: (pid: number) => string | undefined = pidStart): 'same' | 'changed' | 'unknown' {
  if (!L.pid || !L.start) return 'unknown'
  const p = launchProbe(L, run)
  if (p.state !== 'alive') return p.state === 'gone' ? 'changed' : 'unknown'
  if (p.pid !== L.pid) return 'changed'
  const st = startOf(L.pid)
  return st === undefined ? 'unknown' : st === L.start ? 'same' : 'changed'
}
/** 在線的這位 Codex 是不是跑在這次開的 pane 裡：程序往上對到的 pane＝L.pane，而且 pane 還在原 session、標記對（只有都對才 yes） */
export function launchOwner(id: string, L: Launch, proc: (id: string) => { pane?: string } | undefined = codexProc, run: Run = tmux): 'yes' | 'no' | 'unknown' {
  const p = proc(id)
  if (!p) return 'no'
  if (!p.pane) return paneProbeFailed ? 'unknown' : 'no'
  if (p.pane !== L.pane) return 'no'
  const st = launchState(L, run)
  return st === 'alive' ? 'yes' : st === 'gone' ? 'no' : 'unknown'
}
/**
 * 關 Codex 生圖幫手（0.63.38，審查第 6 項）：不用 codexFire（它會 SIGTERM、按名稱關整個 session、搬走對話）。
 * 有 id 就先驗它還跑在這次的 pane（身分對才關）；只收這次的 pane（reapOwn：$N＋%N＋標記），對話紀錄留著不搬
 */
export function closeCodexHelper(id: string | undefined, L: Launch, owner: (id: string, L: Launch) => 'yes' | 'no' | 'unknown' = launchOwner, run: Run = tmux, startOf: (pid: number) => string | undefined = pidStart): { ok: boolean; text: string } {
  if (id !== undefined) {
    const o = owner(id, L)
    if (o !== 'yes') return { ok: false, text: o === 'no' ? '這位已經不在當初開的視窗裡，不關' : '查不到它在哪個視窗，先不關' }
  } else {
    // 沒有 id（還沒登記的回收，0.63.39 複驗第 1 項）：格裡要證實還是招聘時那一支程序（pane_pid＋啟動時間）
    const g = launchGen(L, run, startOf)
    if (g !== 'same') return { ok: false, text: g === 'changed' ? '視窗裡已經不是當初開的那支程序，不關' : '證實不了視窗裡還是當初那支程序，先不關' }
  }
  return reapOwn(L.tmux, L.pane, L.marker, run) ? { ok: true, text: '關掉了（對話紀錄保留）' } : { ok: false, text: '沒能確定關掉，下一輪再試' }
}
/** 接回後台開的 tmux 帶一個這次的啟動標記（session 選項 @po_launch），之後只認這個標記 */
/** 名稱完全相同的 tmux session 的不可變 ID（$N）；沒有回 undefined（show-options 等指令不認「=名稱」，0.63.31 實測） */
export const sessionIdOf = (name: string) => tmux('list-sessions', '-F', '#{session_name}\t#{session_id}').stdout.toString().split('\n').map(l => l.split('\t')).find(([n]) => n === name)?.[1]
const launchMarker = (session: string) => { const id = sessionIdOf(session); if (!id) return; const r = tmux('show-options', '-v', '-t', id, '@po_launch'); return r.exitCode === 0 ? r.stdout.toString().trim() : undefined }
/** 喚起 Codex 看守（審查第 9 項：只剩這一位時看守可能已經自己結束，接回後沒人續心跳、套人事令） */
function wakeWatcher() {
  const data = join(D.base, 'codex'), pidf = join(data, 'watch.pid'), script = join(data, 'codex_office.py')
  try { if (Date.now() - statSync(pidf).mtimeMs < 15e3) return } catch {}
  if (!existsSync(script)) return
  try { Bun.spawn([Bun.which('python3') ?? '/usr/bin/python3', script, 'watch'], { cwd: data, stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' }).unref() } catch {}
}

/** 交給 App。interrupt＝使用者確認過要打斷正在做的事 */
export async function codexToApp(id: string, o: { interrupt?: boolean; addDirs?: string[] } = {}, sleep = (ms: number) => Bun.sleep(ms)): Promise<{ ok: boolean; text: string; need?: 'interrupt' }> {
  const p = codexProc(id)
  if (!p) return { ok: false, text: '這位已經不在線' }
  if (!p.pane || p.shared) return { ok: false, text: '只有從手機招聘、開在電腦背景的 Codex 能交給 App' }
  if (!THREAD_RE.test(p.thread)) return { ok: false, text: '不認得這段對話的編號' }
  const s = codexSession(id) ?? {}
  const who = s.title || s.name || 'Codex'
  const busy = () => BUSY_MODES.has(codexSession(id)?.mode)
  if (busy() && !o.interrupt) return { ok: false, need: 'interrupt', text: `${who} 還在做事，要打斷嗎？` }
  if (busy()) { // 審查第 2 項：打斷後等它真的停下來（狀態不是做事中）才往下，最多 8 秒
    if (tmux('send-keys', '-t', p.pane, 'Escape').exitCode !== 0) return { ok: false, text: tmuxReadonly() ? READONLY_TEXT : '按鍵送不過去' }
    for (let i = 0; i < 16 && busy(); i++) await sleep(500)
    if (busy()) return { ok: false, text: `${who} 還沒停下來，晚點再試` }
  }
  const thread = p.thread, home = typeof s.codexHome === 'string' ? s.codexHome : undefined
  const st = codexSettings(id)
  // 審查第 5 項：先落一筆「交接中」再請它結束；確認放鎖才改成可以接回。失敗時這筆留著，接回後台照樣找得到它
  mkdirSync(hrDir(), { recursive: true })
  const rec: InApp = { at: Date.now(), cwd: s.cwd, perm: st.perm, home, name: who, addDirs: o.addDirs, state: 'pending' }
  writeAtomic(inAppFile(id), rec)
  // 送 /quit 之前再看一次（審查第 2 項：預檢之後使用者可能又叫它做事）
  if (busy()) { try { rmSync(inAppFile(id), { force: true }) } catch {} return { ok: false, need: 'interrupt', text: `${who} 又開始做事了，要打斷嗎？` } }
  const why = await codexSend(p.pane, '/quit', sleep)
  if (why) { try { rmSync(inAppFile(id), { force: true }) } catch {} return { ok: false, text: why } }
  // 審查第 3 項：明確的 20 秒期限；鎖「看不出來」不算放了，繼續等；不硬殺
  const deadline = Date.now() + 20e3
  let freed = false
  while (!freed && Date.now() < deadline) {
    await sleep(Math.min(500, Math.max(0, deadline - Date.now())))
    freed = pidDead(p.pid) && codexLocked(thread, home, deadline - Date.now()) === false // 探針只用剩下的時間（複驗第 3 項）
  }
  if (!freed) {
    // 沒交成：還開著就撤掉「交接中」，不卡住（複驗第 5 項）；已經結束但鎖看不出來的留著，接回後台、重新評估都找得到
    if (!pidDead(p.pid)) try { rmSync(inAppFile(id), { force: true }) } catch {}
    return { ok: false, text: `${who} 還沒確定結束（寫入鎖沒確定放掉），晚點再看；它的畫面在 tmux attach -t ${p.tmuxSession ?? ''}` }
  }
  killOwnSession(p.tmuxSession)
  writeAtomic(inAppFile(id), { ...rec, at: Date.now(), state: 'ready' })
  return { ok: true, text: `📲 ${who} 交給 App 了：在 ChatGPT／Codex App 的對話紀錄打開它就能接著聊` }
}

/** 接回後台時要用的權限（審查第 7 項）：照交出去時記的、讀不到就照對話紀錄的實際設定；不在三個選項裡或讀不到，用比較嚴的「手動」 */
function resumePerm(id: string, inapp?: InApp): string {
  const known = (v?: string) => (v && own(CODEX_PERM_ARGS, v) ? v : undefined)
  return known(inapp?.perm) ?? known(codexSettings(id).perm) ?? (inapp ? 'default' : 'auto')
}
/** 上班地點、可寫資料夾只收認得的（審查第 13 項）：存在的資料夾、不含「..」 */
const okDir = (d?: string) => { if (!d || d.includes('..')) return false; try { return statSync(realpathSync(d)).isDirectory() } catch { return false } }
/** 真實路徑在家目錄底下（照路徑段比，/Users/x2 不算 /Users/x 底下）；是就回真實路徑 */
export function underHome(d: string): string | undefined {
  try { const r = realpathSync(d), h = realpathSync(homedir()); return r === h || r.startsWith(h + '/') ? r : undefined } catch { return }
}

/**
 * 接回後台。o.addDirs：伺服器照他的座位（不在線時用釘住的座位）給那桌的協作資料夾。
 * 審查第 6 項：要等新的 tmux 那邊真的接手（寫入鎖握在手上、沒有「open in another app」），才改名冊、套人事令、清交接記錄；
 * 沒接成就關掉自己開的 tmux、記錄留著，可以再按一次
 */
/**
 * 接回時 codex 的錯誤輸出（0.63.46；使用者實機「接回後台」多次失敗，手機只說「標記設不上」）：
 * 用 sh 包一層，把 stderr 直接 append 到這次嘗試自己的紀錄檔，再 exec 成 codex 本身（pane 的程序還是 codex，持鎖比對照舊）。畫面（stdout）不受影響。
 * 不用 FIFO 和背景讀取者（複驗 resume2：只留前 4 KB 會漏掉最後的錯誤；讀取者故障會讓啟動阻塞或 SIGPIPE；清理有競態）。
 * 紀錄檔：hr/launch/（0700，不是連結）底下每次嘗試獨占建立一個 0600 的新檔（O_EXCL）；失敗時只讀最後 4 KB（對齊 UTF-8）。
 * 每條結束路徑都刪檔；下次嘗試前、接成功時再依 id 前綴清一次（BUG-12）。接成功後 codex 的 stderr 寫進已刪的檔，codex 結束才釋放；
 * 正常執行時 stderr 是空的（實測 0 位元組），沒有上限是已知事項（CHANGELOG）
 */
export const LAUNCH_LOG_MAX = 4096
/**
 * 包裝（O-16）：紀錄路徑的環境變數在 exec 前拿掉，不外洩給 codex 與它的子指令。檔案不在（已被清掉）或是連結就不接 stderr、照常開；
 * 開檔時暫時 umask 077（萬一被重建也是 0600），exec codex 前改回原本的 umask。`command exec` 開不了檔也不會讓 sh 結束，照常開 codex
 */
const LAUNCH_SH = 'L=$PO_LAUNCH_LOG; unset PO_LAUNCH_LOG; ' +
  'if [ -f "$L" ] && [ ! -h "$L" ]; then u=$(umask); umask 077; command exec 2>> "$L"; umask "$u"; fi; ' +
  'exec "$@"'
export function launchArgv(log: string, argv: string[]): string[] {
  return ['env', `PO_LAUNCH_LOG=${log}`, '/bin/sh', '-c', LAUNCH_SH, 'sh', ...argv]
}
/** 這次嘗試的紀錄檔：私有資料夾（不是連結）、獨占建立 0600；先清掉同一位以前留下的和超過一天的（BUG-12）；建不起來回 undefined（照舊接，只是拿不到錯誤） */
export function newLaunchLog(dir: string, id: string, now = Date.now()): string | undefined {
  try {
    mkdirSync(dirname(dir), { recursive: true })
    try { mkdirSync(dir, { mode: 0o700 }) } catch (e: any) { if (e?.code !== 'EEXIST') throw e }
    if (!launchDirOk(dir)) return // 指向別處的連結、檔案或別人的資料夾：不用（複驗 resume2、resume3）
    chmodSync(dir, 0o700)
    dropOldLaunchLogs(dir, id, now)
    const f = join(dir, `${id}-${crypto.randomUUID()}.log`)
    closeSync(openSync(f, 'wx', 0o600))
    return f
  } catch { return undefined }
}
/** hr/launch 本身可以用嗎：是資料夾（lstat，不是連結）、而且是自己的；建立與每個清理入口共用（複驗 resume3） */
export function launchDirOk(dir: string): boolean {
  try { const st = lstatSync(dir); return st.isDirectory() && !st.isSymbolicLink() && st.uid === process.getuid?.() } catch { return false }
}
/** 紀錄檔名：<id>-<uuid>.log（newLaunchLog 取的）；其他檔名一律不碰 */
const LAUNCH_LOG_NAME = /^([A-Za-z0-9-]+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.log$/
/**
 * 清舊紀錄檔（BUG-12）：同一位（<id>-<uuid>.log）以前留下的全清（停在確認畫面、沒能確定收掉的那幾次），別人的超過一天才清。
 * 資料夾驗不過（連結、不是自己的、讀不到）就整個略過；只刪符合檔名格式的一般檔（複驗 resume3）。
 * 舊程序若還開著舊檔：刪路徑不影響它，之後的 stderr 寫進已刪的檔（沒有上限，見 CHANGELOG 已知事項）
 */
export function dropOldLaunchLogs(dir: string, id: string | undefined, now = Date.now()) {
  if (!launchDirOk(dir)) return
  let names: string[]
  try { names = readdirSync(dir) } catch { return }
  for (const n of names) {
    const m = LAUNCH_LOG_NAME.exec(n)
    if (!m) continue
    const f = join(dir, n)
    try {
      const st = lstatSync(f)
      if (!st.isFile()) continue
      if (m[1] === id || now - st.mtimeMs > 24 * 3600e3) rmSync(f, { force: true })
    } catch {}
  }
}
/** 讀紀錄檔最後 4 KB（不讀整檔） */
function logTail(log: string): string | undefined {
  try {
    const fd = openSync(log, 'r')
    try {
      const size = fstatSync(fd).size, n = Math.min(size, LAUNCH_LOG_MAX), buf = Buffer.alloc(n)
      readSync(fd, buf, 0, n, size - n)
      // 開頭被切開的 UTF-8 字元尾巴跳過（O-17）：從中間開始讀時；完整的檔不會以接續位元組開頭
      let k = 0
      while (k < buf.length && k < 4 && (buf[k] & 0xc0) === 0x80) k++
      return buf.subarray(k).toString('utf8')
    } finally { closeSync(fd) }
  } catch { return }
}
/** codex 啟動就結束時的錯誤：去掉控制碼，取最後兩行非空的，連省略號最多 300 字；沒有回 undefined */
export function launchError(log: string): string | undefined {
  const raw = logTail(log)
  if (raw === undefined) return
  const text = raw.replace(/\x1b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '').replace(/\x1b[()*+][0-9A-Za-z]/g, '').replace(/\x1b[@-_]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  if (!lines.length) return
  // 300 字（含省略號）優先給最後一行（O-18）：最後一行太長就只放它；有剩再放前一行的結尾
  const last = lines[lines.length - 1]
  if (last.length > 300) return last.slice(0, 299) + '…'
  const prev = lines.length > 1 ? lines[lines.length - 2] : undefined, room = 300 - last.length - 3
  if (!prev || room < 2) return last
  return `${prev.length <= room ? prev : '…' + prev.slice(prev.length - (room - 1))} ／ ${last}`
}
/** 結束時收尾：刪掉這次的紀錄檔（每條結束路徑都刪；程序若還在，之後的 stderr 寫進已刪的檔） */
export function closeLaunchLog(log: string | undefined) {
  if (log) try { rmSync(log, { force: true }) } catch {}
}

/** 接回時的外部探針（測試換成假的）；ms＝剩餘時間 */
export type LaunchIO = {
  state: (sid: string, ms: number) => Promise<'alive' | 'gone' | 'unknown'>
  panePid: (sid: string, ms: number) => Promise<number>
  screen: (sid: string, ms: number) => Promise<string>
  holds: (pid: number, ms: number) => Promise<boolean>
  /** until＝絕對期限：每個 tmux 指令各自重算剩下的時間（複驗 resume2）；非同步，不卡其他請求 */
  reap: (sid: string, pane: string, marker: string | undefined, until: number) => Promise<boolean>
  sleep: (ms: number) => Promise<unknown>
}
/** tmux 的 session（$N）在不在：列表讀成功而沒有它、或 tmux 回 no server running＝gone；逾時或其他錯誤＝unknown（不當成不在） */
export async function tmuxSessionState(sid: string, ms: number, bin = TMUX, pre: string[] = []): Promise<'alive' | 'gone' | 'unknown'> {
  if (!bin || ms <= 0) return 'unknown'
  const r = await spawnBounded([bin, ...pre, 'list-sessions', '-F', '#{session_id}'], ms)
  if (r.code === null) return 'unknown' // 逾時（含伺服器被暫停，BUG-13）或拋錯
  if (r.code === 0) return r.out.split('\n').map(l => l.trim()).includes(sid) ? 'alive' : 'gone'
  return /no server running/i.test(r.err) ? 'gone' : 'unknown'
}
/** pre＝接在 tmux 後面的參數（測試用獨立 socket：['-L', 名稱]；O-19） */
export const launchIO = (lockFile: string, pre: string[] = []): LaunchIO => ({
  state: (sid, ms) => tmuxSessionState(sid, ms, TMUX, pre),
  panePid: async (sid, ms) => Number((await runAsync([TMUX!, ...pre, 'list-panes', '-t', sid, '-F', '#{pane_pid}'], ms)).split('\n')[0]) || 0,
  screen: (sid, ms) => runAsync([TMUX!, ...pre, 'capture-pane', '-p', '-t', sid], ms),
  holds: async (pid, ms) => !pidDead(pid) && (await runAsync(['lsof', '-t', lockFile], ms)).split('\n').map(Number).includes(pid),
  // 回收也在同一個期限裡：每個 tmux 指令最多等剩下的時間
  reap: (sid, pane, marker, until) => reapOwnAsync(sid, pane, marker, (a, ms) => spawnBounded([TMUX ?? 'tmux', ...pre, ...a], ms), until),
  sleep: ms => Bun.sleep(ms),
})
/** reapOwn 的非同步版（接回後台用）：每一步前重算到 until 剩下的時間，用完就停、回「沒能確定收掉」 */
export async function reapOwnAsync(sid: string, pane: string, marker: string | undefined, run: (a: string[], ms: number) => Promise<{ code: number | null; out: string; err: string }>, until: number, now = () => Date.now()): Promise<boolean> {
  if (!/^\$\d+$/.test(sid) || !/^%\d+$/.test(pane)) return false
  const left = () => until - now()
  if (marker !== undefined) { const m = await run(['show-options', '-v', '-t', sid, '@po_launch'], left()); if (m.code !== 0 || m.out.trim() !== marker) return false }
  const owner = await run(['display', '-p', '-t', pane, '#{session_id}'], left())
  if (owner.code !== 0 || owner.out.trim() !== sid) return false
  if ((await run(['kill-pane', '-t', pane], left())).code === null) return false
  const after = await run(['list-panes', '-a', '-F', '#{pane_id}'], left())
  if (after.code !== 0) return after.code !== null && /no server running/i.test(after.err)
  return !after.out.split('\n').map(l => l.trim()).includes(pane)
}
/** 程序剛結束時紀錄可能還沒寫完：還是空的就再等一下（最多 500 毫秒，不超過期限） */
async function errorSoon(log: string | undefined, ms: number, sleep: (ms: number) => Promise<unknown>): Promise<string | undefined> {
  if (!log) return
  const until = Date.now() + Math.min(500, Math.max(0, ms))
  let e = launchError(log)
  while (e === undefined && Date.now() < until) { await sleep(50); e = launchError(log) }
  return e
}
/** 設標記失敗時：session 是不是剛好自己結束了（伺服器剛啟動的第一次，sh 立刻結束、列表還來不及更新；測試員 BUG-9）。最多看 1.5 秒 */
export async function goneSoon(sid: string, io: Pick<LaunchIO, 'state' | 'sleep'>, ms: number): Promise<boolean> {
  const until = Date.now() + Math.min(1500, Math.max(0, ms))
  for (;;) {
    const st = await io.state(sid, Math.max(1, until - Date.now()))
    if (st === 'gone') return true
    if (Date.now() >= until) return false
    await io.sleep(100)
  }
}
/** 回收要留的時間：等接手最多到期限前這麼久，剩下的給回收；期限內來不及就回「未確認」 */
export const REAP_RESERVE_MS = 2500
export type Settled = { took: true; pid: number } | { took: false; text: string; cleared: boolean; exited?: boolean }
/**
 * 開了之後等接手（0.63.46 審查修正）：tmux 的程序活著、持鎖的就是它、畫面沒有「open in another app」。
 * 程序自己結束了（session 確定不在）就停、不回收，讀它的錯誤；還在才回收（保留逾時、App 搶先、確認畫面的原因）。
 * 等待、探針、回收共用同一個期限；回收前時間不夠就回「未確認」
 */
export async function settleLaunch(o: { sid: string; pane: string; marker: string; name: string; session: string; deadline: number; log?: string }, io: LaunchIO, now = () => Date.now()): Promise<Settled> {
  const left = () => Math.max(0, o.deadline - now())
  const waitLeft = () => Math.max(0, left() - REAP_RESERVE_MS)
  let pid = 0, took = false, blocked = false, exited = false, screen = ''
  while (!took && !blocked && !exited && waitLeft() > 0) {
    await io.sleep(Math.min(500, waitLeft()))
    pid = await io.panePid(o.sid, waitLeft())
    if (!pid && (await io.state(o.sid, waitLeft())) === 'gone') { exited = true; break }
    const got = await io.screen(o.sid, waitLeft())
    if (got) screen = got // 期限用完時回空字串，不蓋掉上一次讀到的畫面（確認畫面要留給使用者處理）
    blocked = /open in another app/i.test(screen)
    took = !!pid && (await io.holds(pid, waitLeft()))
  }
  if (took) return { took: true, pid }
  // 等不到時再確認一次是不是自己結束了（逾時那一刻剛好結束的）
  // 這一次最多用剩下時間的一半，另一半留給回收（複驗 resume2：最後的探針不能吃光回收的時間）
  if (!exited && !blocked && left() > 0 && (await io.state(o.sid, Math.min(1000, Math.floor(left() / 2)))) === 'gone') exited = true
  if (exited) {
    const err = await errorSoon(o.log, left(), io.sleep)
    return { took: false, exited: true, cleared: true, text: `codex 啟動就結束：${err ?? '沒有留下錯誤訊息'}` }
  }
  if (stuckTitle(screen) && !blocked) return { took: false, cleared: false, text: `${o.name} 的 Codex 停在確認畫面：在通知列處理（或 tmux attach -t ${o.session}）後再按一次接回` }
  if (left() <= 0) return { took: false, cleared: false, text: `${o.name} 沒有接成，期限內沒能確認接回的視窗收掉了沒：請到電腦上看 tmux ${o.session}` }
  // 只回收這次開的（session ID、標記、單一 pane 都對得上），而且確認關掉了才算收掉
  if (!(await io.reap(o.sid, o.pane, o.marker, o.deadline))) return { took: false, cleared: false, text: `${o.name} 沒有接成，接回的視窗沒能確定收掉：請到電腦上看 tmux ${o.session}` }
  return { took: false, cleared: true, text: blocked ? '這段對話被 App 搶先打開了：先在 App 關掉它，再按一次' : `${o.name} 沒有接成（可能還在啟動），晚點再按一次` }
}

/**
 * 接回後台設啟動標記（0.63.49；使用者 0.63.48 實機「標記設不上」、原因看不出來）：
 * 只用 session ID（不用名稱繞回去找）；set-option 後用同一個 ID 讀回比對；失敗時在期限內最多試 3 次（間隔 200 毫秒）。
 * 每次 tmux 指令最多等 3 秒或剩下的時間。回 ok，或失敗的是哪一步（sid 格式／設定／讀回／讀回不符）、tmux 的 stderr、花了多久
 */
export type MarkRun = (args: string[], ms: number) => Promise<{ code: number | null; out: string; err: string }>
export async function markLaunch(sid: string, marker: string, until: number, run: MarkRun, sleep: (ms: number) => Promise<unknown> = ms => Bun.sleep(ms), now = () => Date.now()): Promise<{ ok: true; tries: number; ms: number } | { ok: false; why: string; ms: number; tries: number }> {
  const t0 = now()
  if (!/^\$\d+$/.test(sid)) return { ok: false, why: `session ID 不對（${JSON.stringify(sid).slice(0, 40)}）`, ms: 0, tries: 0 }
  const left = () => Math.min(EXT_TIMEOUT_MS, until - now())
  const brief = (r: { code: number | null; err: string }) => (r.code === null ? '逾時' : `exit ${r.code}${r.err.trim() ? '：' + r.err.trim().slice(0, 160) : ''}`)
  let why = '期限內沒時間設', tries = 0
  for (; tries < 3 && left() > 0; ) {
    tries++
    const set = await run(['set-option', '-t', sid, '@po_launch', marker], left())
    if (set.code !== 0) why = `設定失敗（${brief(set)}）`
    else {
      const got = await run(['show-options', '-v', '-t', sid, '@po_launch'], left())
      if (got.code !== 0) why = `讀回失敗（${brief(got)}）`
      else if (got.out.trim() === marker) return { ok: true, tries, ms: now() - t0 }
      else why = `讀回不符（讀到「${got.out.trim().slice(0, 40)}」）`
    }
    if (tries < 3 && until - now() > 200) await sleep(200)
  }
  return { ok: false, why, ms: now() - t0, tries }
}

export async function codexToTmux(id: string, o: { addDirs?: string[] } = {}, sleep = (ms: number) => Bun.sleep(ms)): Promise<{ ok: boolean; text: string }> {
  if (!TMUX) return { ok: false, text: '這台電腦沒有 tmux' }
  const thread = /^codex-(.+)$/.exec(id)?.[1] ?? ''
  if (!THREAD_RE.test(thread)) return { ok: false, text: '不認得這段對話的編號' }
  const s = codexSession(id)
  if (!s) return { ok: false, text: '辦公室沒有這段 Codex 對話的紀錄' }
  const p = codexProc(id)
  if (p?.pane && !p.shared) return { ok: false, text: '他已經在電腦背景了' }
  // CODEX_HOME 要在家目錄底下（真實路徑、照路徑段比；複驗第 13 項）；設了但不合法就拒絕，免得在別的 home 查鎖
  let home: string | undefined
  if (typeof s.codexHome === 'string' && s.codexHome) { home = underHome(s.codexHome); if (!home) return { ok: false, text: '這段對話的 CODEX_HOME 不在家目錄底下，不接' } }
  // tmux 名稱用完整 UUID（複驗新問題 1：前八碼會撞）；續接只認這次的啟動標記
  const session = `po-cxr-${thread}`
  const launchFile = join(hrDir(), `${id}.launch`)
  let launchLog: string | undefined
  let want: string | undefined, pane = ''
  try { const [m, pn] = readFileSync(launchFile, 'utf8').trim().split(/\s+/); want = m || undefined; pane = pn ?? '' } catch {}
  const ours = !!sessionIdOf(session) && !!want && launchMarker(session) === want
  if (!ours) {
    const held = codexLocked(thread, home)
    if (held === true) return { ok: false, text: '這段對話還開在 App 裡：先在 App 關掉它，關好再按一次（不會硬搶）' }
    if (held === undefined) return { ok: false, text: '看不出這段對話有沒有開在別的地方，先不接' }
  }
  const inapp = inAppOf(id)
  const dirs = D.hireDirs() as { name: string; path: string; default?: boolean }[]
  const cwd = okDir(inapp?.cwd) ? inapp!.cwd! : (dirs.find(d => d.default) ?? dirs[0])?.path
  if (!cwd || !okDir(cwd)) return { ok: false, text: '沒有可用的上班地點' }
  const perm = resumePerm(id, inapp)
  const name = String(s.title || s.name || 'Codex')
  const cpFile = typeof s.cpFile === 'string' && /\/checkpoints\/[^/]+\.md$/.test(s.cpFile) && !s.cpFile.includes('..') ? s.cpFile : join(D.base, 'checkpoints', `${name.replace(/[\\/:*?"<>|\s]+/g, '-')}-${thread.slice(0, 6)}.md`)
  const addDirs = (o.addDirs ?? inapp?.addDirs ?? []).filter(okDir)
  if (sessionIdOf(session) && !ours) return { ok: false, text: `已經有一個 ${session}，不是這次開的，先不動它` }
  const marker = want ?? crypto.randomUUID()
  let sid = ours ? sessionIdOf(session) ?? '' : ''
  let deadline = Date.now() + 15e3
  const io = launchIO(join(home ?? CODEX_HOME(), 'thread-writer-locks', `${thread}.lock`))
  if (!ours) {
    const exe = codexBin()
    if (!existsSync(exe)) return { ok: false, text: '這台電腦沒有 codex 指令' }
    try { mkdirSync(hrDir(), { recursive: true }); writeFileSync(launchFile, marker) } catch { return { ok: false, text: '記不下這次接回的標記，先不接' } }
    launchLog = newLaunchLog(join(hrDir(), 'launch'), id)
    // 取回不可變的 session ID（0.63.31，最後一輪 ①）：之後設標記、讀畫面、回收都用它，不怕名稱被別人重用
    const r = tmux('new-session', '-d', '-P', '-F', '#{session_id} #{pane_id}', '-x', '220', '-y', '50', '-s', session, '-c', cwd,
      'env', '-u', 'CLAUDE_CODE_CHILD_SESSION', '-u', 'ANTHROPIC_API_KEY', '-u', 'CLAUDECODE', ...(home ? [`CODEX_HOME=${home}`] : []),
      // 唯讀時不能帶 --add-dir：Codex 會直接結束（「Ignoring --add-dir … the effective permissions do not allow additional writable roots」，0.63.29 實測）
      ...(() => { const argv = [exe, 'resume', '--no-daemon', ...CODEX_PERM_ARGS[perm], '-C', cwd, ...(perm === 'read-only' ? [] : addDirArgs([...addDirs, dirname(cpFile)], cwd)), '--', thread]; return launchLog ? launchArgv(launchLog, argv) : argv })())
    if (r.exitCode !== 0) { closeLaunchLog(launchLog); return { ok: false, text: `開不起來：${r.stderr.toString().trim() || r.exitCode}` } }
    ;[sid, pane] = r.stdout.toString().trim().split(/\s+/) as [string, string]
    deadline = Date.now() + 15e3 // 整個接回（設標記、等接手、回收）共用這一個期限
    try { writeFileSync(launchFile, `${marker} ${pane ?? ''}`) } catch {}
    // 標記要確認落盤才往下（最後一輪 ①）：設不進去就只回收這次開的（依 session ID），不留佔鎖的對話。
    // 0.63.49：只用 ID 設與讀回、期限內重試，失敗寫出是哪一步、tmux 說什麼、花多久
    const mk = await markLaunch(sid, marker, deadline - REAP_RESERVE_MS, (a, ms) => spawnBounded([TMUX ?? 'tmux', ...a], ms), sleep)
    if (!mk.ok) {
      // codex 啟動就結束（session 確定已經不在）：手機顯示 codex 自己的錯誤，不說「標記設不上」（0.63.46）
      if (/^\$\d+$/.test(sid) && (await goneSoon(sid, { ...io, sleep }, deadline - Date.now()))) {
        const err = await errorSoon(launchLog, deadline - Date.now(), sleep)
        closeLaunchLog(launchLog)
        try { rmSync(launchFile, { force: true }) } catch {}
        return { ok: false, text: `codex 啟動就結束：${err ?? '沒有留下錯誤訊息'}` }
      }
      // 剛開的、還沒標記：不驗標記，但一樣要只有一個 pane、關完確認不在了（③：ID 解析不了就不能說收掉了）
      const gone = deadline - Date.now() > 0 && (await io.reap(sid, pane ?? '', undefined, deadline))
      closeLaunchLog(launchLog)
      if (gone) try { rmSync(launchFile, { force: true }) } catch {}
      const detail = `${mk.why}；試了 ${mk.tries} 次、${mk.ms} 毫秒`
      return { ok: false, text: gone ? `接回的視窗開了但標記設不上（${detail}），已經收掉，晚點再試` : `接回的視窗開了但標記設不上（${detail}），也沒能確定收掉：請到電腦上看 tmux ${session}` }
    }
    watchHire(session, name)
  }
  // 等接手、回收：settleLaunch（自己結束的不回收、讀錯誤；還在的才回收；共用期限）
  const st = await settleLaunch({ sid, pane, marker, name, session, deadline, log: launchLog }, { ...io, sleep }, () => Date.now())
  if (!st.took) {
    closeLaunchLog(launchLog)
    if (ours) dropOldLaunchLogs(join(hrDir(), 'launch'), id) // 續接（沒有新檔）失敗：以前留下的也清（BUG-12）
    if (st.cleared) try { rmSync(launchFile, { force: true }) } catch {}
    return { ok: false, text: st.text }
  }
  const pid = st.pid
  // 接手確定了才改名冊：狀態檔原子改指到新的程序、清 left／ended，記下接手的世代（審查第 9 項），喚起看守
  const now = Date.now(), sf = join(D.base, 'sessions', `${id}.json`)
  // 狀態檔寫不進去不算接回成功（複驗第 9 項）：tmux 留著（它已經接手），記錄留著，再按一次會用同一個標記續接
  // 鎖裡重讀再寫（codex-trust 複驗 ②）：跟 Codex hook、看守同一把鎖
  if (!(await writeStatusLocked(sf, s, { pid, shared: false, left: false, ended: false, mode: 'idle', updatedAt: now, lastHook: now, since: now, cwd, owner: `tmux:${session}@${marker}` }))) { closeLaunchLog(launchLog); return { ok: false, text: '接手了，但辦公室的狀態檔寫不進去，晚點再按一次接回' } }
  wakeWatcher()
  closeLaunchLog(launchLog) // 接成功：錯誤輸出不留（之後 codex 的 stderr 進已刪的檔，codex 結束才釋放；正常是 0 位元組）
  dropOldLaunchLogs(join(hrDir(), 'launch'), id) // 以前沒結案的那幾次（例如停在確認畫面、這次續接成功）一起清（BUG-12）
  // 從 App 新開的當新人（審查第 8 項：清掉舊的主管、照招聘預設當員工）；交過去的人事令只補檢查點
  if (!inapp) writeOrder(id, { role: 'staff', cpFile, title: name, team: 'off' })
  else writeOrder(id, { cpFile })
  ctlSet(id, { perm })
  try { rmSync(inAppFile(id), { force: true }); rmSync(launchFile, { force: true }) } catch {}
  return { ok: true, text: `🖥 ${name} 接回後台了（tmux ${session}），大約十幾秒後就能從手機操作` }
}

/**
 * 不在名冊上、但可以接回後台的 Codex（0.63.28）：交出去的（hr/*.inapp.json，一天內）＋ App 開的、最近一天關掉的（狀態檔 shared、left）。
 * resumable＝寫入鎖已放（現在按「接回後台」接得回來）
 */
type Away = { id: string; plate: string; title: string; at: number; handedOff: boolean; resumable: boolean; why?: string }
const awaySeen = { at: 0, v: [] as Away[] }
/**
 * 名牌記憶（0.63.48，乙案）：在線時卡片上的名字（名牌＋同名編號，例如「行程助理②」），離線後灰卡和人事室清單照用，
 * 使用者認得出是剛才那位。存在 hr/plates.json（伺服器重開也在），只留 7 天內的
 */
const PLATE_KEEP_MS = 7 * 24 * 3600e3
let plateMem: Record<string, { plate: string; at: number }> | undefined
const platesFile = () => join(hrDir(), 'plates.json')
function plates(): Record<string, { plate: string; at: number }> {
  if (!plateMem) { try { plateMem = JSON.parse(readFileSync(platesFile(), 'utf8')) } catch {} if (!plateMem || typeof plateMem !== 'object') plateMem = {} }
  return plateMem
}
/** 名牌記憶的下一版（純函式，測試用）：Codex 的名牌有變就記、一小時更新一次最後在線、7 天沒在線就刪；回有沒有變 */
export function nextPlates(m: Record<string, { plate: string; at: number }>, people: { id: string; kind?: string; plate: string }[], now: number): boolean {
  let dirty = false
  for (const p of people) {
    if (p.kind !== 'codex' || !p.plate) continue
    const cur = m[p.id]
    if (!cur || cur.plate !== p.plate) { m[p.id] = { plate: p.plate, at: now }; dirty = true }
    else if (now - cur.at > 3600e3) { cur.at = now; dirty = true } // 一小時更新一次「最後在線」，不每輪寫檔
  }
  for (const [k, v] of Object.entries(m)) if (!(now - Number(v?.at) < PLATE_KEEP_MS)) { delete m[k]; dirty = true }
  return dirty
}
/** 名冊每次算完呼叫：記下 Codex 現在的名牌（有變才寫檔） */
export function rememberPlates(people: { id: string; kind?: string; plate: string }[], now = Date.now()) {
  const m = plates()
  if (nextPlates(m, people, now)) try { mkdirSync(hrDir(), { recursive: true }); writeAtomic(platesFile(), m) } catch {}
}
/** 卡片名字的規則（同 hooks/officeV2.ts chinesePlates）：ListAgents 名有中文用它，否則職稱，再不然名字；最多 10 字 */
const awayBase = (s: any): string => {
  const agent = typeof s?.agent === 'string' ? s.agent.trim() : ''
  const title = typeof s?.title === 'string' ? s.title.replace(/\s+/g, ' ').trim() : ''
  return [...(agent && /[\u3400-\u9fff]/.test(agent) ? agent : title || String(s?.name ?? ''))].slice(0, 10).join('')
}
/** 接回清單的外部查詢（測試換成假的）：對話紀錄在不在、寫入鎖誰拿著、記下的名牌 */
export type AwayDeps = { transcript: (thread: string, home?: string) => string | undefined; locked: (thread: string, home?: string) => boolean | undefined; plate: (id: string) => string | undefined }
/**
 * 候選（交出去的、在 App 關掉的）→ 清單（純函式，0.63.48 乙案）：對話紀錄不在的不列；名字用在線時記下的名牌（沒有就照卡片規則）；
 * 同名的都列（主管裁示：同名可能是不同、都還接得回的對話，用關掉時間區分），新的在前
 */
export function awayView(cands: { id: string; s: any; handedOff: boolean; at: number }[], deps: AwayDeps): Away[] {
  const out: Away[] = []
  for (const { id, s, handedOff, at } of cands) {
    const thread = id.slice('codex-'.length)
    const home = typeof s.codexHome === 'string' && s.codexHome ? s.codexHome : undefined
    if (!deps.transcript(thread, home)) continue // 丟垃圾桶、解雇搬走：接不回來
    const held = deps.locked(thread, home)
    const base = awayBase(s)
    out.push({ id, plate: deps.plate(id) || base, title: String(s.title ?? s.name ?? ''), at, handedOff, resumable: held === false, ...(held === true ? { why: '這段對話還開在 App 裡，先在 App 關掉' } : held === undefined ? { why: '看不出這段對話有沒有開在別的地方' } : {}) })
  }
  return out.sort((a, b) => b.at - a.at)
}
export function codexAway(online: Set<string>, now = Date.now()) {
  if (now - awaySeen.at < 30e3) return awaySeen.v.filter(x => !online.has(x.id))
  const cands: { id: string; s: any; handedOff: boolean; at: number }[] = [], seen = new Set<string>()
  const add = (id: string, handedOff: boolean, at: number) => {
    if (seen.has(id) || online.has(id)) return
    const s = codexSession(id)
    if (!s) return
    seen.add(id)
    cands.push({ id, s, handedOff, at })
  }
  try { for (const f of readdirSync(hrDir())) { const m = /^(codex-[0-9a-f-]+)\.inapp\.json$/.exec(f); if (m) { const r = inAppOf(m[1]); if (r && now - r.at < 24 * 3600e3) add(m[1], true, r.at) } } } catch {}
  try {
    for (const f of readdirSync(join(D.base, 'sessions'))) {
      if (!/^codex-[0-9a-f-]+\.json$/.test(f)) continue
      const s = codexSession(f.slice(0, -5))
      if (s?.shared && s.left && now - Number(s.updatedAt) < 24 * 3600e3) add(f.slice(0, -5), false, Number(s.updatedAt))
    }
  } catch {}
  awaySeen.at = now
  awaySeen.v = awayView(cands, { transcript: (t, h) => codexTranscript(t, h), locked: (t, h) => codexLocked(t, h), plate: id => plates()[id]?.plate })
  return awaySeen.v
}
/** 剛交給 App 的通知（一小時內） */
export function codexHandoffs(now = Date.now()): { id: string; plate: string; title: string; at: number }[] {
  const out: { id: string; plate: string; title: string; at: number }[] = []
  try { for (const f of readdirSync(hrDir())) { const m = /^(codex-[0-9a-f-]+)\.inapp\.json$/.exec(f); if (!m) continue; const r = inAppOf(m[1]); if (r && r.state !== 'pending' && now - r.at < 3600e3) { const s = codexSession(m[1]) ?? {}; out.push({ id: m[1], plate: String(s.name ?? ''), title: String(r.name ?? s.title ?? ''), at: r.at }) } } } catch {}
  return out
}

/**
 * 「交接中」重新評估（0.63.30，複驗第 5 項）：超過 1 分鐘還是 pending，而且他還開在 tmux（沒交出去）就撤掉，
 * 不會卡住解雇；已經結束的改成 ready（可以接回）。回現在的記錄
 */
export function settlePending(id: string, now = Date.now()): InApp | undefined {
  const r = inAppOf(id)
  if (!r || r.state !== 'pending' || now - r.at < 60e3) return r
  const p = codexProc(id)
  if (p?.pane && !p.shared && !pidDead(p.pid)) { try { rmSync(inAppFile(id), { force: true }) } catch {} return }
  const next = { ...r, state: 'ready' as const }
  try { writeAtomic(inAppFile(id), next) } catch {}
  return next
}
