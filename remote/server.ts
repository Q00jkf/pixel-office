// 手機版辦公室（第 3 期）：本機 HTTP 伺服器，讀 ~/.claude/pixel-office/ 共用資料夾。
// 對外二選一：Cloudflare Tunnel＋Cloudflare Access（只放行 owner），或 tailscale serve（tailnet 裡的裝置都放行）；只聽 127.0.0.1。
// 啟動：bun <這個檔>；設定在 ~/.claude/pixel-office/remote.json：{ "port": 8767, "owner": "<Access 登入的 email>" }
// 選填（v2，2026-11-22 起）：
//   "owners": ["a@x", "b@y"]                         多放行幾個 Access 登入的 email
//   "configDirs": ["/Users/me/.claude-work"]          只顯示、只能指揮這幾套設定（CLAUDE_CONFIG_DIR）的 Claude 對話；沒寫＝全部。Codex、agy 不受限；可寫 ~/…（0.63.60 起展開）
//   "hireDirs": [{ "name": "知識庫", "path": "/Users/me/kb" }]   招聘新員工時可選的上班地點；沒寫＝家目錄
// 環境變數：PO_CONFIG 換設定檔名（例：remote-office2.json，同一支程式開第二間辦公室）；PO_PORT 蓋過設定檔的 port（測試用）
// 畫面（v2）：page.html＋v2/scene.js 用 v2/assets/ 的圖畫辦公室（上方協作區、下方辦公區、四種角色全身圖）；
//   座位與協作桌在 office.ts、人事室（招聘、換模型、解雇、排班、完整對話…）在 hr.ts；/scene.svg（向量圖）照舊提供
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'

import type { Coworker } from '../types'
import { MIN_ROWS, assignSeats, isDeptLead, layout, setSpread, shownName } from '../hooks/scene'
import { STALE_MS, parseStatus } from '../hooks/status'
import { drawVector, sameNameNumbers, vectorSvg } from '../hooks/vector'
import { accessKeys, verifyAccessJwt, type KeySource } from './access'
import { accessShouldLog, devMode, gate, gateClass, highRisk, hostOk, keyMatches, loadLocalKey, rotateLog } from './gate'
import { APPROVE_COOLDOWN_MS, approveChatLine, approveLog, phoneOffCard, phoneOffWhy, claudeApproval, claudeDecision, codexApproval, codexPress, codexPrompt, parseSlip, phoneBeat, type ApprovalInfo } from './approve'
import { CXP_ORDER_MAX_KEEP_MS, planCxpOrders, sessionListCache, type SessionList, closeCodexHelper, codexStarted, launchOwner, launchState, codexCtl, codexFire, codexKey, codexModel, codexModels, codexProc, hireCodex, stuckView, pressStuck, writeOrder, pendingOrder, takesOrders, EFFORTS, PERMS, CODEX_EFFORTS, CODEX_PERMS, ctlGet, codexSettings, codexEffortsOf, withPane, appTabOf, pidAlive, pidStart, codexToApp, codexToTmux, READONLY_TEXT, codexAway, codexHandoffs, rememberPlates, codexSession, underHome, paneFor, spawnBounded, inAppOf, settlePending, setEffort, setPerm, codexEffort, codexPerm, codexCap, agyCap, codexLineItems, codexTranscript, pageChat, daysText, CODEX_WIN_TEXT, summonRole, closeSession, EXT_TIMEOUT_MS, MODELS, chatOf, editShift, fire, hire, hrOf, initHr, pressKey, profileOf, setModel, shifts, staffing, startShiftClock } from './hr'
import { v2PanelSvg } from '../hooks/v2panel'
import { answerAsk, helperView, initHelpers, keepHelper, startHelperClock, type HelperDeps } from './helpers'
import { tickAppTabs, loadTabs, resetAppTabs } from './apptabs'
import { teamPreview, teamUp, type TeamDeps, type TeamPerson } from './teamup'
import { endMeeting, initMeetings, meetingResult, meetingView, startMeeting, tickMeetings } from './meeting'
import { answerHandover, handovers as handoverList, handoverView, initHandover, startHandover, tickHandovers, type Handover } from './handover'
import { CHAT_KEEP_MS, CHAT_TEXT_MAX, chatTables, TASK_KEEP_MS, parseTask, taskCard, type PartState, adminBrief, latestCheckpoints, mdSections, suggestAdmin, tableRows, officeFor, assign, atTable, chatDir, chatFile, chinesePlates, parseChat, type ChatEntry, demoPeople, editTables, emptyStore, moveSeat, parseStore, pinSeat, retarget, unpin, species, tableLabel, tablesOut, type HandoverHint, type Store } from '../hooks/officeV2'

const BASE = join(homedir(), '.claude', 'pixel-office')
const SESSIONS = join(BASE, 'sessions')
const COMMANDS = join(BASE, 'commands')
const REPLIES = join(BASE, 'replies')
const UPLOADS = join(BASE, 'uploads')
const UPLOAD_MAX = 8 * 1024 * 1024
const UPLOAD_KEEP_MS = 7 * 24 * 3600 * 1000 // 手機傳的照片留 7 天
const COMMAND_TTL_MS = 10 * 60 * 1000 // 跟 hooks/register.tsx 的 COMMAND_TTL_MS 一樣

type Config = { port: number; owner?: string; owners: string[]; configDirs?: string[]; hireDirs: { name: string; path: string; default?: boolean }[]
  /** 手機核准（0.63.54）：Cloudflare Access 的 team、aud；phoneApprove:false 強制關；approveWaitMs 等手機多久 */
  access?: { team?: unknown; aud?: unknown }; phoneApprove?: boolean; approveWaitMs?: number
  /** tailscale serve 連進來（0.63.56）：沒帶驗證的請求只能讀；預設 false＝沒驗證什麼都讀不到 */
  tailscale?: boolean
  /** 對外網址（0.63.56，F-1）：Cloudflare、Tailscale 的主機名，Host 檢查放行這些（只寫名稱，不帶 https:// 和埠） */
  publicHosts?: string[] }
/** 測試用：蓋掉 remote.json 的部分欄位（正式不會設） */
let configPatch: Partial<Config> | undefined
export const _setConfigPatch = (p: Partial<Config> | undefined) => { configPatch = p }
const trimDir = (d: string) => d.replace(/[\\/]+$/, '')
/** configDirs 的路徑（0.63.60，N-1）：開頭的 ~ 或 ~/ 換成家目錄，再去掉結尾斜線；~user 這種不動 */
export const configDirOf = (d: string) => trimDir(d === '~' ? homedir() : d.startsWith('~/') ? join(homedir(), d.slice(2)) : d)
export function config(): Config {
  let j: any = {}
  try {
    j = JSON.parse(readFileSync(join(BASE, process.env.PO_CONFIG || 'remote.json'), 'utf8')) ?? {}
  } catch {}
  const owner = typeof j.owner === 'string' && j.owner.trim() ? j.owner.trim().toLowerCase() : undefined
  const owners = [owner, ...(Array.isArray(j.owners) ? j.owners : [])].filter((x: unknown): x is string => typeof x === 'string' && x.trim() !== '').map(x => x.trim().toLowerCase())
  const dirs = Array.isArray(j.configDirs) ? j.configDirs.filter((x: unknown): x is string => typeof x === 'string' && x !== '').map(configDirOf) : undefined
  const hireDirs = (Array.isArray(j.hireDirs) ? j.hireDirs : [])
    .filter((d: any) => d && typeof d.path === 'string' && existsSync(d.path))
    .map((d: any) => ({ name: typeof d.name === 'string' && d.name ? d.name : String(d.path).split(/[\\/]/).pop(), path: trimDir(d.path) }))
  // defaultHireDir（選填，0.62.8）：招聘「在哪裡上班」預設選它（寫 hireDirs 裡的 name 或 path）；沒設＝清單第一個
  const list: { name: string; path: string; default?: boolean }[] = hireDirs.length ? hireDirs : [{ name: '家目錄', path: homedir() }]
  const want = typeof j.defaultHireDir === 'string' ? trimDir(j.defaultHireDir.trim()) : ''
  const def = list.find(d => want && (d.name === want || d.path === want)) ?? list[0]
  return {
    port: Number(process.env.PO_PORT) || Number(j.port) || 8767, owner, owners: [...new Set(owners)], configDirs: dirs?.length ? dirs : undefined,
    hireDirs: list.map(d => (d === def ? { ...d, default: true } : d)),
    // 手機核准的三個欄位（F-1，0.63.54：原本沒帶出來，合法 JWT 也一律驗不過）
    ...(j.access && typeof j.access === 'object' ? { access: { team: j.access.team, aud: j.access.aud } } : {}),
    ...(typeof j.phoneApprove === 'boolean' ? { phoneApprove: j.phoneApprove } : {}),
    ...(typeof j.approveWaitMs === 'number' ? { approveWaitMs: j.approveWaitMs } : {}),
    ...(j.tailscale === true ? { tailscale: true } : {}),
    ...(Array.isArray(j.publicHosts) ? { publicHosts: j.publicHosts.filter((x: unknown): x is string => typeof x === 'string' && x.trim() !== '').map((x: string) => x.trim().toLowerCase()) } : {}),
    ...configPatch,
  }
}

/**
 * remote.json 有 configDirs 時：Claude 對話只留那幾套設定的；Codex、agy 照常。
 * 沒有 configDir 欄位＝沒設 CLAUDE_CONFIG_DIR，用的是預設 ~/.claude（0.63.59：原本一律濾掉，桌面 app 的對話因此看不到）
 */
export function visibleKind(c: Coworker, dirs: string[] | undefined): boolean {
  if (!dirs || c.kind) return true
  return dirs.includes(c.configDir ? trimDir(c.configDir) : join(homedir(), '.claude'))
}

/** 在線的人（跟面板同一套判斷）＋一次性對話數 */
export function crew(now = Date.now()): { people: (Coworker & { code: string })[]; oneshots: Coworker[] } {
  const dirs = config().configDirs
  const found: Coworker[] = []
  let names: string[] = []
  try {
    names = readdirSync(SESSIONS).filter(n => n.endsWith('.json') && n !== 'me.json')
  } catch {}
  for (const n of names) {
    const p = join(SESSIONS, n)
    try {
      if (now - statSync(p).mtimeMs > STALE_MS) continue
      const c = parseStatus(JSON.parse(readFileSync(p, 'utf8')), now)
      if (c && visibleKind(c, dirs)) found.push(c)
    } catch {}
  }
  const people = chinesePlates(found.filter(c => !c.oneshot).sort((a, b) => a.id.localeCompare(b.id)))
  return { people, oneshots: found.filter(c => c.oneshot) }
}

function meeting(now: number, people: (Coworker & { code?: string })[]): { meeting: boolean; attendees: string[] } {
  try {
    const j = JSON.parse(readFileSync(join(BASE, 'meeting.json'), 'utf8'))
    const named: string[] = Array.isArray(j.participants) ? j.participants.filter((x: unknown) => typeof x === 'string') : []
    // 會議名單可能寫舊名牌：換成中文名牌後補上新的那個
    const who = [...named, ...people.filter(c => c.code && named.includes(c.code)).map(c => c.name)]
    const on = now < (Number(j.until) || 0) && (named.length === 0 || people.some(c => who.includes(c.agent ?? '') || who.includes(c.name)))
    return { meeting: on, attendees: who }
  } catch {
    return { meeting: false, attendees: [] }
  }
}

let seats: ReturnType<typeof assignSeats> | undefined
let seatKey = ''
let box = { w: 64, h: 128 } // 上一張圖的 viewBox，給點人換算座標

/** 手機要幾排桌：有 peer 在線的主管一隊一排（只有一位主管時照舊有一排），沒 team 的人每 8 個一排、至少一排 */
export function deskRowsNeeded(people: Coworker[]): number {
  const ofBoss = (c: Coworker, m: Coworker) => c !== m && c.team !== undefined && (c.team === m.agent || c.team === m.name)
  const tops = people.filter(c => c.role === 'manager' && !isDeptLead(c, people))
  // 部門主管底下有人才自成一隊，否則跟一般 peer 一樣坐上一層主管那一隊
  const bosses = [...tops, ...people.filter(c => isDeptLead(c, people) && people.some(s => ofBoss(s, c)))]
  const staff = people.filter(c => !tops.includes(c))
  const teams = bosses.length === 1 ? 1 : bosses.filter(m => staff.some(c => !bosses.includes(c) && ofBoss(c, m))).length
  const loose = staff.filter(c => !bosses.some(m => m === c || ofBoss(c, m))).length
  return teams + Math.max(1, Math.ceil(loose / 8))
}

/** 排數：至少撐滿螢幕，桌子排不下就往下長（手機頁可以上下滑） */
export function phoneRows(width: number, aspect: number, people: Coworker[]): number {
  let rows = Math.max(MIN_ROWS, Math.round((width * aspect) / 2))
  const need = deskRowsNeeded(people)
  while (layout(width, rows).clusters.length / layout(width, rows).cols < need && rows < 400) rows += 1
  return rows
}

/** 舊的向量辦公室（/scene.svg）：寬 w 單位（48～112），高照螢幕比例撐滿，桌子不夠就加長。v2 頁面不用，留給舊頁面與測試 */
export function sceneSvg(w: number, aspect: number, now = Date.now()): string {
  const width = Math.max(48, Math.min(112, Math.round(w)))
  const { people, oneshots } = crew(now)
  const rows = phoneRows(width, aspect, people)
  const m = meeting(now, people)
  box = { w: width, h: rows * 2 }
  const key = `${width}x${rows}`
  if (key !== seatKey) seats = undefined // 版面變了座位重排
  seatKey = key
  setSpread(true)
  seats = assignSeats(people, width, rows, seats, m.meeting, m.attendees)
  const by = new Map<string, number>()
  for (const c of oneshots) {
    const k = c.label ? c.label.split('-')[0] || c.label : 'one-shot'
    by.set(k, (by.get(k) ?? 0) + 1)
  }
  const t = new Date(now)
  const clock = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
  const queue = people.filter(c => c.mode === 'waiting').sort((a, b) => (a.since ?? 0) - (b.since ?? 0)).map(c => c.id)
  const v = drawVector(people, Math.floor(now / 250), width, rows, [], seats, { ...m, queue, clock, oneshots: [...by].map(([label, n]) => ({ label, n })) })
  return vectorSvg(v)
}

// 狀態給人看的字（手機、面板、共用筆記同一套；0.62.14 起中文，跟手機狀態卡的 ZH 一樣）。給模型看的 office_roster 在 register.tsx，照舊英文
export const MODE_TEXT: Record<string, string> = { idle: '閒著', thinking: '思考中', typing: '正在寫', reading: '正在讀', waiting: '等你回覆', done: '剛做完', blocked: '卡住了' }

// ---------- v2 座位表：每個 port 一份 office-<port>.json ----------
let store: Store | undefined
const officeFile = () => join(BASE, `office-${config().port}.json`)
/** 刪掉的桌（0.63.60）：一行一張，含刪的時間、桌子本身、指到這桌的釘選與座位；0600，只增不改 */
export const deletedFile = () => join(BASE, `office-${config().port}.deleted.jsonl`)
export function tableSnapshot(S: Store, id: number) {
  const t = S.tables.find(x => x.id === id)
  if (!t) return undefined
  const pre = `t${id}.`
  return {
    table: structuredClone(t),
    pins: Object.fromEntries(Object.entries(S.pins).filter(([, k]) => k.startsWith(pre))),
    ...(S.pinBy ? { pinBy: Object.fromEntries(Object.entries(S.pinBy).filter(([who]) => S.pins[who]?.startsWith(pre))) } : {}),
    seats: Object.fromEntries(Object.entries(S.seats).filter(([, s]) => s.key.startsWith(pre)).map(([who, s]) => [who, s.key])),
  }
}
export function saveDeletedTable(snap: NonNullable<ReturnType<typeof tableSnapshot>>, now = Date.now()) {
  const f = deletedFile()
  try { appendFileSync(f, JSON.stringify({ at: now, ...snap }) + '\n', { mode: 0o600 }); chmodSync(f, 0o600) } catch {}
}
const office = () => (store ??= parseStore(existsSync(officeFile()) ? readFileSync(officeFile(), 'utf8') : undefined))
const saveStore = (file: string, S: Store) => writeFileSync(file, JSON.stringify(S, null, 1))
const DEMO_AT = Date.now() // 示意資料裡要穩定的時間（伺服器啟動時）
const demoStores = new Map<number, Store>() // 示意模式：只放在記憶體，伺服器重開就回到預設
const demoStore = (n: number) => { let S = demoStores.get(n); if (!S) demoStores.set(n, (S = emptyStore())); return S }

/** Codex 能不能從手機操作（開在 tmux）：要跑 tmux／ps，10 秒算一次 */
const capSeen = new Map<string, { v: ReturnType<typeof codexCap>; at: number }>()
function codexCapCached(id: string, now: number) {
  const c = capSeen.get(id)
  if (c && now - c.at < 10e3) return c.v
  const v = codexCap(id)
  capSeen.set(id, { v, at: now })
  return v
}
/** ctl 跟 can 用同一次探測（0.63.21，複驗 B：分開探可能一個說能、一個說不能） */
function codexCtlCached(id: string, now: number): boolean {
  return codexCapCached(id, now).can.key
}

/**
 * 手機招的 Codex（0.62.20）：招的時候還不知道它的 id，座位先釘在暫代 id（cxp-xxxxxxxx＝tmux po-cxp-xxxxxxxx）；
 * 它登記成 codex-<thread> 後，看它開在哪個 tmux，把座位換過去。暫代的超過 10 分鐘沒人來就放掉
 */
const cxpSeen = new Map<string, number>()
let cxpCheck = 0
export function resolveCodexPins(S: Store, people: { id: string; kind?: string }[], now = Date.now()): void {
  const pend = Object.keys(S.pins).filter(k => k.startsWith('cxp-'))
  if (!pend.length || now - cxpCheck < 3000) return
  cxpCheck = now
  let dirty = false
  for (const k of pend) {
    if (!cxpSeen.has(k)) cxpSeen.set(k, now)
    const hit = people.find(p => p.kind === 'codex' && !S.pins[p.id] && codexProc(p.id)?.tmuxSession === `po-${k}`)
    if (hit) { pinSeat(S, hit.id, S.pins[k], 'hire', now); unpin(S, k); cxpSeen.delete(k); dirty = true } // 轉正：招聘的釘選，記 hire（0.63.58）
    else if (now - cxpSeen.get(k)! > 10 * 60e3) { unpin(S, k); cxpSeen.delete(k); dirty = true }
  }
  if (dirty) try { saveStore(officeFile(), S) } catch {}
}

/** Codex 的模型、投入程度、權限：招聘時與手機換過的（hr/<id>.ctl.json；0.63.9） */
function codexMode(id: string) {
  const st = codexSettings(id) // 0.63.19：對話紀錄的 turn_context（實際設定）＋手機剛換過的；不是手機招的 Codex 也有
  // 這位目前模型支援的投入程度（0.63.22，最後複驗第 5 項：codexModels 只列前四款，用第五款的手機原本沒有級數可選）
  const efforts = st.model ? codexEffortsOf(st.model) : undefined
  return { ...st, ...(efforts?.length ? { efforts } : {}) }
}

/** 名牌上的名字（美術 A #14）：規則在 hooks/scene.ts shownName（外掛的 Desktop 面板用同一條） */
export { shownName }
/** 點人用：每個人的詳細資料、v2 座位（seat）、外型（species）、人事欄位；最上層帶協作桌、排班、可選的智力與上班地點 */
/**
 * 排座位、認主管會用到的人員欄位（id、種類、name、名牌、短代號、角色、職稱、team、ListAgents 名稱）：完整名冊 roster() 與只讀名冊 peekRoster()
 * 共用這一個（第六輪複驗：peek 漏了 name，assign 比對 team 時主管對不上、被算到辦公區）
 */
export function seatPerson(c: Coworker & { code: string }, no: Map<string, string>) {
  return { id: c.id, kind: c.kind, name: c.name, plate: shownName(c) + (no.get(c.id) ?? ''), code: c.code, role: c.role, title: c.title, team: c.team, agent: c.agent }
}
/** 在線名單 → 排座位用的人員（同名編號＋seatPerson）；roster() 與 peekRoster() 都從這裡來 */
export function seatList(people: (Coworker & { code: string })[]) {
  const no = sameNameNumbers(people)
  return people.map(c => ({ c, p: seatPerson(c, no) }))
}
/** 在線、開在 Codex App 裡的 Codex（S-1，0.63.51）：手機只能看 */
const APP_CODEX_TEXT = '在 Codex App 裡，先接回後台才能傳話'
function appCodex(id: string): boolean {
  const c = crew().people.find(p => p.id === id)
  return c?.kind === 'codex' && codexCapCached(id, Date.now()).src === 'app'
}
// ---------- 辦公室裡按允許（0.63.51；remote/approve.ts）----------
const approvalsDir = () => join(BASE, 'approvals')
const readSlipText = (f: string) => { try { return readFileSync(f, 'utf8') } catch { return undefined } }
/** Codex 確認畫面的擷取：同一格 1.5 秒內共用；第一次看到某張卡的時間（冷卻從這裡算） */
const promptSeen = new Map<string, { at: number; screen: string | undefined }>()
const cardSeen = new Map<string, number>()
function codexScreen(pane: string, now: number): string | undefined {
  const c = promptSeen.get(pane)
  if (c && now - c.at < 1500) return c.screen
  // C-1（0.63.53）：只抓可視範圍（不含捲動紀錄），確認畫面要在最底下才算（codexPrompt）
  const r = Bun.spawnSync([Bun.which('tmux') ?? 'tmux', 'capture-pane', '-p', '-J', '-t', pane], { stdout: 'pipe', stderr: 'pipe', timeout: 1500, killSignal: 'SIGKILL' })
  const screen = r.exitCode === 0 ? r.stdout.toString() : undefined
  promptSeen.set(pane, { at: now, screen })
  if (promptSeen.size > 100) for (const [k, x] of promptSeen) if (now - x.at > 60e3) promptSeen.delete(k)
  return screen
}
/** 這位現在有沒有等著按允許的卡：Claude 看外掛的單（status 有 approval 才讀）；Codex 只看開在 tmux 的畫面 */
export function approvalInfoOf(c: { id: string; kind?: string; approval?: unknown }, o: { src?: string; host?: string }, now: number): ApprovalInfo | undefined {
  if (!c.kind) {
    if (!c.approval) return
    const slip = parseSlip(readSlipText(join(approvalsDir(), `${c.id}.json`)), now)
    if (!slip || slip.session !== c.id) return
    return claudeApproval(slip, o.src === 'app' || o.host === 'app' ? 'app' : o.src === 'tmux' || o.host === 'tmux' ? 'tmux' : 'other')
  }
  if (c.kind !== 'codex' || o.src !== 'tmux') return
  const pane = paneFor(c.id, 'codex')
  const screen = pane ? codexScreen(pane, now) : undefined
  const p = screen ? codexPrompt(screen) : undefined
  if (!p || !pane) return
  const probe = codexApproval(p, pane, now)
  if (!cardSeen.has(probe.nonce)) cardSeen.set(probe.nonce, now)
  if (cardSeen.size > 200) for (const [k, t] of cardSeen) if (now - t > 3600e3) cardSeen.delete(k)
  return codexApproval(p, pane, cardSeen.get(probe.nonce)!)
}
/**
 * 手機頁的身分（0.63.53，安全審 A-1）：只認 Cloudflare Access 簽的 JWT（Cf-Access-Jwt-Assertion），不信 cf-ray、email 這些本機也能帶的標頭；
 * remote.json 沒設 access（team、aud）就一律不通過（手機核准不開）
 */
let keySource: KeySource = accessKeys
/** 測試用：換掉 Access 金鑰的來源（正式是抓 team 的 certs） */
export const _setKeySource = (k: KeySource | undefined) => { keySource = k ?? accessKeys }
async function phoneAuth(h: Headers, now = Date.now()) {
  const c = config()
  return verifyAccessJwt(h.get('cf-access-jwt-assertion'), c.access, c.owners ?? [], now, keySource)
}
/**
 * 手機在看（A-2）：只在 JWT 驗過的 state.json 請求記下時間（記憶體，不寫檔）；外掛向伺服器問 GET /phone-live，不看任何檔案。
 * remote.json 的 phoneApprove:false 強制關；approveWaitMs 調等待時間
 */
let phoneSeenAt = 0
export function phoneLive(now = Date.now()) {
  const b = phoneBeat(now, config())
  return b.off || now - phoneSeenAt > 60e3 ? { live: false } : { live: true, waitMs: b.waitMs }
}
/** 手機按的決定（A-3）：只放記憶體，等待程式向伺服器問 GET /approve-result；不寫 decisions 檔（本機任何人都能寫那個檔） */
const phoneDecisions = new Map<string, Record<string, unknown> & { at: number }>()
const decisionKey = (session: string, toolUseId: string, nonce: string) => `${session}\n${toolUseId}\n${nonce}`
export function approveResult(q: URLSearchParams, now = Date.now()) {
  for (const [k, v] of phoneDecisions) if (now - v.at > 10 * 60e3) phoneDecisions.delete(k)
  const d = phoneDecisions.get(decisionKey(q.get('session') ?? '', q.get('toolUseId') ?? '', q.get('nonce') ?? ''))
  return d ? d : { state: 'none' }
}
/**
 * 每次按都記一筆（D-1，0.63.53）：完整內容只進 approve-log.jsonl（0600）；那位坐在協作桌時，桌聊只寫誰、工具、允許／拒絕（不帶指令，同桌的 AI 讀得到）
 */
function logApprove(who: { id: string; plate: string; seat?: string }, info: { tool: string; desc: string }, key: 'allow' | 'deny', reason: string, now: number) {
  const f = join(BASE, 'approve-log.jsonl')
  try { appendFileSync(f, JSON.stringify({ at: now, id: who.id, text: approveLog(who.plate, info, key, reason) }) + '\n', { mode: 0o600 }); chmodSync(f, 0o600) } catch {}
  const t = /^t(\d+)\./.exec(who.seat ?? '')?.[1]
  if (t) logChat(Number(t), { at: now, from: { name: '📱 手機' }, to: { id: who.id, name: who.plate }, text: approveChatLine(who.plate, info.tool, key) }, now)
}
/** POST /approve { id, key:'allow'|'deny', nonce, reason? } */
export async function approveAt(b: any, now = Date.now()): Promise<{ ok: boolean; text: string }> {
  const id = String(b?.id ?? '')
  const r = roster(now)
  const who = r.people.find((p: any) => p.id === id) as any
  if (!who) return { ok: false, text: '這位已經不在線' }
  const info: ApprovalInfo | undefined = who.approvalInfo
  if (!info) return { ok: false, text: '已在電腦上處理了（或已經不等了）' }
  if (b.nonce !== info.nonce) return { ok: false, text: '這張已經換了，請重看' }
  const key = b.key === 'allow' || b.key === 'deny' ? b.key as 'allow' | 'deny' : undefined
  if (!key || !info.options.some(o => o.key === key)) return { ok: false, text: info.why ?? '這張卡不能這樣按' }
  if (key === 'allow' && now - info.at < APPROVE_COOLDOWN_MS) return { ok: false, text: '剛出現，先看完再按（1 秒後才能允許）' }
  const reason = typeof b.reason === 'string' ? b.reason.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 300) : ''
  if (info.kind === 'claude') {
    const d = claudeDecision(parseSlip(readSlipText(join(approvalsDir(), `${id}.json`)), now), { key, nonce: b.nonce, reason }, now)
    if ('error' in d) return { ok: false, text: d.error }
    const w = d.write as { session: string; toolUseId: string; nonce: string }
    phoneDecisions.set(decisionKey(w.session, w.toolUseId, w.nonce), { ...d.write, at: now }) // 記憶體（A-3）
    logApprove(who, info, key, reason, now)
    return { ok: true, text: d.text }
  }
  // Codex：按之前重抓畫面，還是同一張才送；只送 y（允許）或 Esc（拒絕）（codexPress，remote/approve.ts）
  const pane = paneFor(id, 'codex')
  if (!pane) return { ok: false, text: '找不到它在電腦上的視窗' }
  promptSeen.delete(pane)
  const TM = Bun.which('tmux') ?? 'tmux'
  const run = (a: string[]) => Bun.spawnSync([TM, ...a], { stdout: 'pipe', stderr: 'pipe', timeout: 1500, killSignal: 'SIGKILL' })
  const pr = await codexPress(pane, info.nonce, key, {
    capture: pn => { const r = run(['capture-pane', '-p', '-J', '-t', pn]); return r.exitCode === 0 ? r.stdout.toString() : undefined }, // 只抓可視範圍（C-1）
    socketOk: pn => { const r = run(['display', '-p', '-t', pn, '#{socket_path}']); return r.exitCode === 0 && /\/tmux-\d+\/default$/.test(r.stdout.toString().trim()) }, // 主伺服器
    send: (pn, k) => { const r = run(['send-keys', '-t', pn, k]); return { ok: r.exitCode === 0, readOnly: /read-only/.test(r.stderr.toString()) } },
    sleep: ms => Bun.sleep(ms),
  })
  promptSeen.delete(pane)
  if (pr.sent) logApprove(who, info, key, reason, now)
  if (pr.sent && key === 'deny' && reason) await deliverAsync(id, `📱 拒絕原因：${reason}`).catch(() => undefined)
  if (!pr.ok) return { ok: false, text: pr.text === 'READONLY' ? READONLY_TEXT : pr.text }
  return { ok: true, text: key === 'allow' ? `✅ 替 ${who.plate} 按了「Yes, proceed」` : `🚫 替 ${who.plate} 拒絕了${reason ? `，原因已傳給它` : ''}` }
}

/**
 * 手機能對這位做什麼（0.63.50，完整對話頁用）：由現有的 src、can 推，前端不用自己猜。
 * send／photo＝傳話、傳照片（每種都送得到；agy 下一個動作才看得到）；interrupt、keys＝打斷、按鍵；cfg＝換智力／投入程度／模式其中一項；
 * approve＝能在手機按允許（② 做好之前一律 false）；handoff：Codex 開在電腦背景＝toApp（交給 App）、在 App 裡且放了鎖＝toBg（接回後台）
 */
export function capsOf(p: { kind?: string; src?: string; can?: Record<string, boolean | undefined> }) {
  const can = p.can ?? {}
  const appCx = p.kind === 'codex' && p.src === 'app' // S-1：在 App 裡的 Codex 只能看
  return {
    send: !appCx,
    photo: !appCx,
    interrupt: !!can.key,
    cfg: !!(can.model || can.effort || can.perm),
    keys: !!can.key,
    approve: false,
    handoff: p.kind === 'codex' ? (can.handoffApp ? 'toApp' as const : can.handoffTmux ? 'toBg' as const : null) : null,
  }
}
export function roster(now = Date.now()) {
  const { people, oneshots } = crew(now)
  const list = seatList(people).map(({ c, p }) => {
    const at = seats?.get(c.id)?.stand
    const o = {
      ...p,
      ver: c.ver, // 外掛載入的版號（0.63.25：手機看得到誰還沒換新版）
      cmd: commandState(c.id, now),
      reply: lastReply(c.id),
      mode: c.mode,
      modeText: MODE_TEXT[c.mode] ?? c.mode,
      tool: c.tool || undefined,
      since: c.since,
      approval: c.approval?.tool,
      lastError: c.lastError,
      ctx: c.ctxPct,
      // 傳話（SendMessage）：手機畫紙飛機用；收件人在伺服器這邊對好（agent 或通訊位址），手機只拿 id
      sentToId: c.sentTo ? recipientId(people, c.sentTo) : undefined,
      sentAt: c.sentAt,
      gotAt: c.gotAt,
      x: at?.x,
      y: at?.y,
      staff: true,
      species: species(c),
      ...(c.kind ? { host: c.kind, ...(c.kind === 'codex' ? { ctl: codexCtlCached(c.id, now), ...codexMode(c.id), ...codexCapCached(c.id, now) } : agyCap) } : hrOf(c.id, now)),
    }
    const approvalInfo = approvalInfoOf(c, o as any, now) // 辦公室裡按允許（0.63.51）
    const caps = capsOf(o as any)
    return { ...o, caps: { ...caps, approve: !!approvalInfo?.options.length }, ...(approvalInfo ? { approvalInfo } : {}) } // 手機能做什麼（0.63.50）
  })
  const S = office()
  resolveCodexPins(S, list, now)
  resolveCodexOrders(list, now)
  // 換好主管的交接紀錄（0.63.58，顧問裁示 a）：認桌時照紀錄，優先於比名字和主管座；桌子已經改給別位在線主管就不算（審查 H-1）
  let done: HandoverHint[] = []
  try { done = handoverList().filter(h => h.state === 'done').map(h => ({ id: h.id, table: h.table, newSid: h.newSid, oldHandle: h.oldHandle, at: h.doneAt ?? h.at })) } catch {}
  const { map, dirty } = assign(S, list, now, done)
  if (dirty) try { saveStore(officeFile(), S) } catch {}
  drainChatOutbox(list, map, now)
  appTabsTick(list.map(p => ({ ...p, seat: map.get(p.id) })), now)
  rememberPlates(list, now) // Codex 在線時的名牌記下來：離線後灰卡、人事室清單照用（0.63.48 乙案）
  sweepChat(S, now)
  const cfg = config()
  let bossBack = false
  const out = {
    box,
    oneshots: oneshots.length,
    people: list.map(p => ({ ...p, seat: map.get(p.id) })),
    tables: tablesOut(S, list, map).map(t => {
      const tb = S.tables.find(x => x.id === t.id)
      const adminOn = !!tb?.admin && list.some(p => p.id === tb.admin)
      const boss = list.find(p => p.role === 'manager' && map.get(p.id)?.startsWith(`t${t.id}.`))
      // 主管關掉 App 分頁被解雇（0.63.24）：這桌標「缺主管」直到有新主管，不管幾個人（桌牌原本 4 人以上才標）
      if (tb?.bossLeft && boss) { delete tb.bossLeft; bossBack = true }
      const bossLeft = !!tb?.bossLeft && !boss
      return { ...t, ...(adminOn ? { admin: tb!.admin } : {}), ...(bossLeft ? { noBoss: true } : {}), suggestAdmin: suggestAdmin((t as any).count ?? 0, adminOn), decide: decideCount(t.id, boss?.id, now), tasks: activeTasks(t.id, boss, now) }
    }),
    shifts: shifts().map(x => ({ sid: x.sid, name: x.who.name, id: x.who.id, time: x.time, days: x.days, dow: x.dow, daysText: daysText(x), table: x.table, action: x.action, text: x.text, on: x.on, last: x.last })),
    models: MODELS,
    codexModels: codexModels(),
    efforts: EFFORTS, perms: PERMS, codexEfforts: CODEX_EFFORTS, codexPerms: CODEX_PERMS, // 投入程度＋模式（0.63.9）
    hireDirs: cfg.hireDirs.map(d => ({ name: d.name, path: d.path, ...(d.default ? { default: true } : {}) })),
    ...(process.platform === 'win32' ? { noCodexHire: CODEX_WIN_TEXT } : {}), // Windows 招聘不能選 Codex（設計 windows-hire 3.）
  }
  if (bossBack) try { saveStore(officeFile(), S) } catch {}
  return out
}

// ---------- 桌子聊天室（第 12 項）：chat/<port>/t<桌號>/ 一則一檔；30 天前的刪掉，桌子不在了整個資料夾刪掉 ----------
const chatBase = () => join(BASE, 'chat', String(config().port))
function logChat(tableId: number, e: ChatEntry, now = Date.now(), name = chatFile(now, crypto.randomUUID().slice(0, 8))): boolean {
  const d = chatDir(BASE, config().port, tableId)
  try { mkdirSync(d, { recursive: true }); writeFileSync(join(d, name), JSON.stringify({ ...e, text: e.text.slice(0, CHAT_TEXT_MAX) })); return true } catch { return false }
}
/**
 * Codex 傳的話記進協作桌聊天室（0.63.8）：Claude 是自己的外掛送出時寫（register.tsx logTableChat）；Codex 的 office_send
 * 與 Claude 用 `codex_office.py send` 寄給 Codex 的，由 codex_office.py 寫一份待記到 chat/outbox/，這裡照座位記到寄件人、收件人坐的桌。
 * 每台伺服器記自己 port 的聊天室，各自記哪些處理過（chat/outbox-seen-<port>.json）；待記放一天後刪
 */
const OUTBOX = join(BASE, 'chat', 'outbox')
const OUTBOX_KEEP_MS = 24 * 3600e3
let outboxSeen: Map<string, number> | undefined
// 處理過的（值是時間）和還在等對方收的（值是 { at, tables }：第一次看到時就固定的目的桌）
let outboxHold: Map<string, { at: number; tables: number[]; written?: boolean }> | undefined
export function drainChatOutbox(list: { id: string; plate: string; agent?: string; name?: string }[], map: Map<string, string>, now = Date.now()) {
  let files: string[] = []
  try { files = readdirSync(OUTBOX).filter(f => f.endsWith('.json')) } catch { return }
  if (!files.length) return
  const seenFile = join(BASE, 'chat', `outbox-seen-${config().port}.json`)
  if (!outboxSeen || !outboxHold) {
    const j = readJson(seenFile) ?? {}
    outboxSeen = new Map(Object.entries(j).filter(([, v]) => typeof v === 'number') as [string, number][])
    outboxHold = new Map(Object.entries(j).filter(([, v]: [string, any]) => v && typeof v === 'object' && Array.isArray(v.tables)) as [string, { at: number; tables: number[]; written?: boolean }][])
  }
  let dirty = false
  // 先比 id；只有名字的（Claude 用 CLI 寄的 --from）要剛好對到一位才算，對到兩位以上不猜（0.63.12，審查第 4 項）
  const who = (x: any) => {
    if (typeof x?.id === 'string') return list.find(p => p.id === x.id) // 有 id 就只認 id，找不到不退回同名（複驗第 4 項）
    if (typeof x?.name !== 'string' || !x.name) return
    const hits = list.filter(p => p.agent === x.name || p.plate === x.name || p.name === x.name)
    return hits.length === 1 ? hits[0] : undefined
  }
  for (const f of files) {
    if (outboxSeen.has(f)) continue
    const e = readJson(join(OUTBOX, f)), at = Number(e?.at)
    if (!e || typeof e.text !== 'string' || !(now - at < OUTBOX_KEEP_MS)) { try { rmSync(join(OUTBOX, f), { force: true }) } catch {} continue }
    // 目的桌在第一次看到時就固定（0.63.22，最後複驗第 3 項）：原本等對方收過（最多 10 分鐘）才照那時的座位記，換桌會記錯桌、離桌整則不記
    const from = who(e.from), to = who(e.to)
    let hold = outboxHold.get(f)
    // 寫檔之前就固定（最後複驗第 3 項追加）：只寫成一桌、或第一次寫失敗，重試也照這幾桌，不會用換桌後的新座位
    if (!hold) { hold = { at: now, tables: chatTables(map, from?.id ?? '', to?.id) }; outboxHold.set(f, hold); dirty = true }
    const tables = hold.tables
    // 送達狀態（0.63.20，複驗 C）：給 Claude 的等它的外掛收過（done 檔有這個 nonce）；先記「送出中」，收過或 10 分鐘到了再改同一則
    let note = e.state === 'unsure' ? '（可能沒送到）' : e.state === 'inbox' ? '（放進收件夾，對方下次動作時才收到）' : ''
    let waiting = false
    if (e.ack?.kind === 'claude' && typeof e.ack.id === 'string' && typeof e.ack.nonce === 'string') {
      const d = readJson(join(COMMANDS, `${e.ack.id}.done.json`))
      const got = new Set([...(Array.isArray(d?.nonces) ? d.nonces : []), d?.nonce])
      if (!got.has(e.ack.nonce)) { if (now - at < COMMAND_TTL_MS) { waiting = true; note = '（送出中…）' } else note = '（沒送到）' }
    }
    if (waiting && hold.written) continue // 已經記了「送出中」、桌也固定了：等收過
    // 檔名沿用待記的檔名（同一則改狀態會蓋同一個檔，不會多一則）；全部寫成功才記處理過，失敗的下一輪再試（審查第 4 項）
    const ok = tables.every(t => logChat(t, { at, from: { ...(from ? { id: from.id } : {}), name: from?.plate ?? String(e.from?.name ?? '?') }, to: { ...(to ? { id: to.id } : {}), name: to?.plate ?? String(e.to?.name ?? '?') }, text: note ? `${e.text}\n${note}` : e.text }, at, f))
    if (!ok) continue // 桌已經固定，下一輪照同樣的桌重寫（同一個檔名，重寫不會多一則）
    if (waiting) hold.written = true
    else { outboxHold.delete(f); outboxSeen.set(f, now) }
    dirty = true
  }
  for (const [k, v] of outboxSeen) if (now - v > OUTBOX_KEEP_MS) { outboxSeen.delete(k); dirty = true; try { rmSync(join(OUTBOX, k), { force: true }) } catch {} }
  if (dirty) try { writeFileSync(seenFile, JSON.stringify({ ...Object.fromEntries(outboxSeen), ...Object.fromEntries(outboxHold) })) } catch {}
}
/**
 * 關掉 Claude app 分頁就自動解雇（0.63.24；判斷在 remote/apptabs.ts）：只有正式那台（remote.json 的 port）做，15 秒最多一次。
 * 解雇＝拿掉座位、釘選、行政；他是主管的那桌標 bossLeft（桌牌顯示「缺主管」，沿用現有提示）；那桌聊天室記一行
 */
const appTabsFile = () => join(BASE, `app-tabs-${config().port}.json`)
let appTabsAt = 0
function appTabsTick(people: { id: string; plate: string; role?: string; kind?: string; seat?: string }[], now: number) {
  let main = 8767
  try { main = Number(JSON.parse(readFileSync(join(BASE, 'remote.json'), 'utf8')).port) || 8767 } catch {}
  if (config().port !== main && !process.env.PO_APPTABS) return
  if (now - appTabsAt < 15e3) return
  appTabsAt = now
  tickAppTabs(people, {
    file: appTabsFile(), tabOf: id => appTabOf(id, now), alive: pidAlive, startOf: pidStart,
    remove: (id, t) => {
      unseat(id)
      if (t.table === undefined) return
      if (t.boss) { const S = office(), tb = S.tables.find(x => x.id === t.table); if (tb) { tb.bossLeft = now; try { saveStore(officeFile(), S) } catch {} } }
      logChat(t.table, { at: now, from: { name: '🏢 辦公室' }, to: { name: '📣 整桌' }, text: `${t.plate} 已離開（關掉 App 分頁）` }, now)
    },
  }, now)
}

let chatSwept = 0
/** 清聊天室：桌子不在了（刪掉、自動開的收掉）整桌刪；超過 30 天的那則刪。force＝馬上做（刪桌子後），否則一分鐘最多一次 */
export function sweepChat(S: Store, now = Date.now(), force = false) {
  if (!force && now - chatSwept < 60e3) return
  chatSwept = now
  let dirs: string[] = []
  try { dirs = readdirSync(chatBase()) } catch { return }
  for (const n of dirs) {
    const m = /^t(\d+)$/.exec(n), d = join(chatBase(), n)
    if (!m || !S.tables.some(t => t.id === +m[1])) { try { rmSync(d, { recursive: true, force: true }) } catch {} continue }
    try {
      for (const f of readdirSync(d)) { const at = Number(f.split('-')[0]); if (!(now - at < CHAT_KEEP_MS)) rmSync(join(d, f), { force: true }) }
    } catch {}
  }
}
/** 一張桌子的聊天室：照時間排（舊→新），最多最近 200 則 */
export function tableChat(tableId: number, now = Date.now()): { ok: boolean; items: ChatEntry[]; text?: string } {
  const S = office()
  if (!S.tables.some(t => t.id === tableId)) return { ok: false, items: [], text: '找不到這張桌子' }
  sweepChat(S, now)
  const d = chatDir(BASE, config().port, tableId), items: ChatEntry[] = []
  let names: string[] = []
  try { names = readdirSync(d).filter(n => n.endsWith('.json')) } catch {}
  for (const n of names) { try { const c = parseChat(readFileSync(join(d, n), 'utf8'), now); if (c) items.push(c) } catch {} }
  items.sort((a, b) => a.at - b.at)
  return { ok: true, items: items.slice(-200) }
}
/** 示意共用筆記：一張桌的假段落（什麼都不讀） */
function demoNotes(n: number, tableId: number, now = Date.now()) {
  const j = demoRoster(n, now), t = j.tables.find(x => x.id === tableId)
  if (!t) return { ok: false, text: '找不到這張桌子' }
  const at = j.people.filter(p => p.seat?.startsWith(`t${tableId}.`))
  const boss = at.find(p => p.role === 'manager')
  return { ok: true, demo: true, id: tableId, label: t.label, dir: '（示意）', hasBoss: !!boss, boss: boss?.plate,
    decide: boss ? [{ text: '（示意）報價要不要含運費', where: 'collab.md', at: '11-23' }, { text: '（示意）週五前交初稿可以嗎', where: '', at: '11-23' }] : [],
    auto: at.map(p => ({ id: p.id, plate: p.plate, title: p.title, role: p.role, doing: p.approval ? `卡在等你按允許（${p.approval}）` : MODE_TEXT[p.mode] ?? p.mode, waiting: p.mode === 'waiting', blocked: p.mode === 'blocked' })),
    progress: at.map((p, i) => ({ plate: p.plate, head: i % 2 ? undefined : '2026-11-23 10:00 ' + p.plate, text: i % 2 ? undefined : '- 做完：（示意）初稿\n- 卡在：無\n- 下一步：（示意）改第二版' })),
    asks: ['2026-11-23 09:30 （示意）今天先把報價做完'],
    tasks: boss ? { active: [taskCard({ id: 'demo0001', title: '（示意）報價單', boss: boss.id, parts: at.slice(1, 4).map((p, i) => ({ who: p.plate, what: ['查價', '寫報價', '校對'][i], ...(i ? { after: [i - 1] } : {}) })), at: now }, new Map([[0, { state: 'done' as const, at: now }]]))], done: [] } : { active: [], done: [] },
    bossPart: boss ? { scope: '（示意）報價與合約', parts: [{ title: '目標', text: '（示意）週五前交報價' }] } : undefined,
    admin: undefined, at: now }
}

/** 示意聊天室：每桌幾則假的（含一則長的），什麼都不讀 */
function demoChatOf(n: number, tableId: number, now = Date.now()) {
  const j = demoRoster(n, now), t = j.tables.find(x => x.id === tableId)
  if (!t) return { ok: false, items: [], text: '找不到這張桌子' }
  const ppl = j.people.filter(p => p.seat?.startsWith(`t${tableId}.`))
  if (ppl.length < 2) return { ok: true, items: [] }
  const [a, b] = ppl
  return { ok: true, demo: true, items: [
    { at: now - 3600e3, from: { id: b.id, name: b.plate }, to: { id: a.id, name: a.plate }, text: '（示意）報價單初稿好了，放在共用資料夾' },
    { at: now - 1800e3, from: { id: a.id, name: a.plate }, to: { id: b.id, name: b.plate }, text: '（示意）收到，幾個地方要改：\n1. 單價改成含稅\n2. 付款條件寫 30 天\n3. 加上交期' },
    { at: now - 600e3, from: { name: '📱 使用者' }, to: { name: '📣 整桌' }, text: '（示意）大家今天五點前回報進度' },
  ] }
}

/**
 * 整桌等你回覆（roadmap 第 7 項，0.62.7）：回給這桌指定的幾位（一位＝單張卡片送出；多位＝「全部回同一句」）。
 * 只送給坐在這桌、正在等你回覆（mode＝waiting、不是卡在按允許）的人；走 sendCommand（Codex 走 codex queue），送到的記進這桌聊天室。
 * demo：只回報會送給誰
 */
export function replyAtTable(tableId: number, ids: string[], text: string, demo?: number, now = Date.now()): { ok: boolean; text: string; sent: string[] } {
  const t = text.trim()
  if (!t || t.length > 3800) return { ok: false, text: '話是空的或太長（最多 3800 字）', sent: [] }
  const j = demo !== undefined ? demoRoster(demo, now) : roster(now)
  if (!j.tables.some(x => x.id === tableId)) return { ok: false, text: '找不到這張桌子', sent: [] }
  const seat = new Map(j.people.filter(p => p.seat).map(p => [p.id, p.seat as string]))
  const who = atTable(tableId, j.people, seat).filter(p => ids.includes(p.id) && p.mode === 'waiting' && !p.approval)
  if (!who.length) return { ok: false, text: '這幾位已經不在等你回覆了', sent: [] }
  if (demo !== undefined) return { ok: true, text: `（示意）會回給 ${who.map(p => p.plate).join('、')}`, sent: who.map(p => p.id) }
  const sent: string[] = [], bad: string[] = []
  for (const p of who) (sendCommand(p.id, t, now) ? bad : sent).push(p.id)
  const name = (id: string) => who.find(p => p.id === id)!.plate
  for (const id of sent) logChat(tableId, { at: now, from: { name: '📱 使用者' }, to: { id, name: name(id) }, text: t }, now)
  if (sent.length) ccBoss(sent, t, now) // 回覆等你的人也算傳給員工：主管收一份副本（多位合成一則）
  const okText = sent.length ? `回給 ${sent.map(name).join('、')}` : ''
  const badText = bad.length ? `${okText ? '；' : ''}沒送到：${bad.map(name).join('、')}` : ''
  return { ok: sent.length > 0, text: okText + badText, sent }
}

/** 收件者名稱（SendMessage 的 to）→ 辦公室裡那個人的 id；跟 hooks/register.tsx findRecipient 同一套比法 */
export function recipientId(people: Coworker[], to: string): string | undefined {
  const want = to.trim().replace(/\s*\[[0-9a-f]+\]$/i, '')
  return people.find(c => (c.agent !== undefined && c.agent === want) || (c.addr !== undefined && c.addr === want))?.id
}

/**
 * 傳話給整桌（roadmap 第 2 項）：一句話送給坐在這張協作桌的每個人，開頭標「手機傳給整桌」；走 sendCommand（Codex 走 codex queue）。
 * demo：示意資料，什麼都不送。回傳 { ok, text, sent: 送到的 id }
 */
export type TableSayDeps = { roster: (now: number) => ReturnType<typeof roster>; deliver: (id: string, text: string, now: number) => Delivery | Promise<Delivery>; save: typeof savePhoto; base: (now: number) => string; log: typeof logChat }
const tableSayDeps: TableSayDeps = { roster: now => roster(now), deliver: (id, text, now) => deliverAsync(id, text, now), save: (...a) => savePhoto(...a), base: now => photoBase(now), log: (...a) => logChat(...a) }
export async function sayToTable(tableId: number, text: string, demo?: number, now = Date.now(), photo?: Uint8Array, dep: TableSayDeps = tableSayDeps): Promise<{ ok: boolean; text: string; sent: string[]; failed?: { id: string; why: string }[]; unsure?: { id: string; why: string }[] }> {
  const t = text.trim()
  if (photo) { // 整桌傳照片（顧問 11-25）：附的話可以空；照片只存一份、只轉一次 JPEG，同桌每位讀同一個檔
    const bad = photoBad(photo, t)
    if (bad) return { ok: false, text: bad, sent: [] }
  } else if (!t || t.length > 3800) return { ok: false, text: '話是空的或太長（最多 3800 字）', sent: [] }
  const j = demo !== undefined ? demoRoster(demo, now) : dep.roster(now)
  const table = j.tables.find(x => x.id === tableId)
  if (!table) return { ok: false, text: '找不到這張桌子', sent: [] }
  const seat = new Map(j.people.filter(p => p.seat).map(p => [p.id, p.seat as string]))
  const who = atTable(tableId, j.people, seat)
  if (!who.length) return { ok: false, text: '這張桌子現在沒有人', sent: [] }
  const label = tableLabel(table.name, table.teamName)
  if (demo !== undefined) return { ok: true, text: `（示意）會嘗試傳給 ${who.length} 位${photo ? '一張照片' : ''}：${who.map(p => p.plate).join('、')}`, sent: who.map(p => p.id) }
  // 每人實際要送的那句先組好、驗長度（審查 photo ⑤：存檔前就知道會不會超過 4000 字）；照片訊息不附全員名單
  const base = photo ? dep.base(now) : '', path = `${base}.jpg`
  const msgOf = (p: { kind?: string }) => photo
    ? `📣 手機傳給整桌「${label}」一張照片：\n${t ? `${t}\n` : ''}${photoLine(p.kind, path)}`
    : `📣 手機傳給整桌「${label}」（同桌 ${who.length} 位：${who.map(p => p.agent ?? p.plate).join('、')}）：\n${t}`
  if (who.some(p => msgOf(p).length > 4000)) return { ok: false, text: photo ? '附照片時文字太長' : '話太長（加上桌名、同桌名單超過 4000 字）', sent: [] }
  if (photo) {
    const s = await dep.save(photo, isHeic(photo), who.some(p => p.kind === 'codex'), base) // 有 Codex 就轉成它讀得了的（JPEG、長邊 1600），Claude 讀同一個檔
    if (!s.path) return { ok: false, text: s.err ?? '照片存不下來', sent: [] }
  }
  // 存照片、排隊等並行槽都要時間，這段時間有人換了桌（或桌子沒了）：每一位要送之前才用當下的名冊重查（第三輪複驗 ①），
  // 不在原桌的不送、標「已離桌」；投遞丟例外的只算那一位「沒送出」，其他人照常（第三輪複驗 ②）
  const stillHere = (pid: string): string | undefined => {
    const j2 = dep.roster(Date.now()), table2 = j2.tables.find(x => x.id === tableId)
    if (!table2) return '桌子已經不在'
    const seat2 = new Map(j2.people.filter(p => p.seat).map(p => [p.id, p.seat as string]))
    return atTable(tableId, j2.people, seat2).some(p => p.id === pid) ? undefined : '已離桌'
  }
  const sent: string[] = [], failed: { id: string; why: string }[] = [], unsure: { id: string; why: string }[] = [], notes: string[] = []
  // 一次最多 4 位同時送（Codex 的 codex queue 非同步），不卡伺服器、也不要一位卡住整批
  const ds = await mapLimit(who, 4, async (p): Promise<{ p: typeof p; d: Delivery }> => {
    try {
      const gone = stillHere(p.id)
      if (gone) return { p, d: { state: 'failed', text: gone } }
      return { p, d: await dep.deliver(p.id, msgOf(p), now) }
    } catch (e) { return { p, d: { state: 'failed', text: `送的時候出錯：${String((e as Error)?.message ?? e).slice(0, 120)}` } } }
  })
  for (const { p, d } of ds) {
    if (d.state === 'sent') { sent.push(p.id); if (d.note) notes.push(`${p.plate}：${d.note}`) }
    else (d.state === 'unsure' ? unsure : failed).push({ id: p.id, why: d.text ?? '' })
  }
  const what = photo ? `📷 傳了一張照片${t ? `：${t}` : ''}` : t
  if (sent.length || unsure.length) dep.log(tableId, { at: now, from: { name: '📱 使用者' }, to: { name: '📣 整桌' }, text: sent.length ? what : `（不確定有沒有收到）${what}` }, now)
  const name = (id: string) => who.find(p => p.id === id)!.plate
  const cx = photo && sent.some(id => who.find(p => p.id === id)!.kind === 'codex') ? '（已請 Codex 打開來看，打不開會在回覆裡說）' : ''
  const parts = [
    sent.length ? `${photo ? '照片' : ''}傳給 ${sent.length} 位：${sent.map(name).join('、')}${cx}` : '',
    unsure.length ? `不確定有沒有收到（先看他們有沒有收到再決定要不要重送）：${unsure.map(u => `${name(u.id)}（${u.why}）`).join('、')}` : '',
    failed.length ? `沒送出：${failed.map(f => `${name(f.id)}（${f.why}）`).join('、')}` : '',
    notes.join('；'),
  ].filter(Boolean)
  return { ok: sent.length + unsure.length > 0, text: parts.join('；'), sent, failed, unsure }
}

const ORDERS = join(BASE, 'orders')
// 人事令寫檔在 hr.ts writeOrder（Claude 外掛、Codex 看守都直接改身分，不經模型）

/**
 * 招聘中的 Codex 的人事令（0.63.6）：hireCodex 先寫在 orders/cxp-<8 碼>.json；它登記成 codex-<thread>（tmux 是 po-cxp-<8 碼>）後
 * 併成 orders/codex-<thread>.json 給它的看守套用。去留、能不能併照 hr.ts cxpOrderFate（至少留 24 小時、最多 7 天，
 * 中間看 tmux 在不在：只有這一輪剛查的名單證實不在才刪，快取名單上沒有、或查不到都不刪、下一輪再查）。
 * tmux 名單一次列全部、60 秒最多查一次。deps 給測試換資料夾、名單、找人
 */
let cxoCheck = 0
const cxpSessions = sessionListCache()
/** 招聘令的年齡起點：令裡的 at（招聘那一刻）；沒有或不像時間才退回檔案 mtime（測試報告 O-1：mtime 會因搬檔、時鐘、重寫而變） */
export function cxpOrderAt(f: string): number {
  try {
    const at = Number(JSON.parse(readFileSync(f, 'utf8'))?.at)
    if (Number.isFinite(at) && at > 0) return at
  } catch {}
  return statSync(f).mtimeMs
}
type CxpDeps = { dir: string; hrDir: string; list: () => SessionList; procOf: (id: string) => { tmuxSession?: string } | undefined }
export function resolveCodexOrders(people: { id: string; kind?: string }[], now = Date.now(), deps?: CxpDeps): void {
  if (!deps) { // 節流只管正式路徑；測試帶 deps 直接跑（別的測試會用示意時間碰到這個共用的節流）
    if (now - cxoCheck < 3000) return
    cxoCheck = now
  }
  // 整段包起來（複驗新發現第 2 項）：這裡出任何錯都只影響招聘令，名冊照常回
  try {
    const { dir, hrDir, list, procOf } = deps ?? { dir: ORDERS, hrDir: join(BASE, 'hr'), list: () => cxpSessions(now), procOf: codexProc }
    let names: string[] = []
    try { names = readdirSync(dir).filter(f => /^cxp-[0-9a-f]{8}\.json$/.test(f)) } catch { return }
    const files: { k: string; ageMs: number; hit: boolean }[] = [], hits = new Map<string, { id: string }>()
    for (const f of names) {
      const k = f.slice(0, -5)
      try {
        const ageMs = now - cxpOrderAt(join(dir, f))
        // 7 天必刪的先排除，不去逐令找人（複驗第 5 項）
        const hit = ageMs > CXP_ORDER_MAX_KEEP_MS ? undefined : people.find(p => p.kind === 'codex' && procOf(p.id)?.tmuxSession === `po-${k}`)
        if (hit) hits.set(k, hit)
        files.push({ k, ageMs, hit: !!hit })
      } catch {}
    }
    for (const { k, act } of planCxpOrders(files, list)) {
      const src = join(dir, `${k}.json`), hit = hits.get(k)
      try {
        if (act === 'drop') rmSync(src, { force: true })
        else if (act === 'merge' && hit) {
          // 併進它名下還沒套用的令（後寫的蓋先寫的），期限從對到的這一刻重算（0.63.10，審查第 2 項：卡在信任畫面太久，招聘的令原本會過期）
          const { nonce: _n, at: hireAt0, ...hire } = JSON.parse(readFileSync(src, 'utf8'))
          // 它登記之後已經收過比招聘還新的令（例如使用者馬上換了主管）：招聘令的 role／team 不要蓋回去，只帶職稱、檢查點（複驗第 2 項）
          const done = readJson(join(dir, `${hit.id}.done.json`))
          const newer = Number(done?.at) > Number(hireAt0)
          const { role: _r, team: _t, ...keep } = hire
          writeOrder(hit.id, { ...(newer ? keep : hire), ...(pendingOrder(hit.id, now) ?? {}) }, now)
          rmSync(src, { force: true })
          try { renameSync(join(hrDir, `${k}.ctl.json`), join(hrDir, `${hit.id}.ctl.json`)) } catch {}
        }
      } catch {}
    }
  } catch {}
}

// 0.63.15 拿掉 syncCodexCheckpoints（換到協作桌就改 cpFile 到那桌）：審查第 7 項，--add-dir 只在啟動時設，
// 新桌的資料夾 Codex 可能寫不進去；改成 cpFile 跟著人（招聘時給的位置），共用筆記另外讀它（tableNotes ownCp）

/**
 * 缺主管的桌子挑一位升主管（roadmap 第 5 項）：他 role＝manager、同桌其他人 team 指向他（ListAgents 名稱，沒有就用名牌），
 * 桌子記在他名下（座位不會因為變成新團隊被搬到別張桌）；Claude、Codex 走人事令（外掛／看守直接改，Codex 0.63.6 起），agy 送一句話請它自己用 office_profile 改。
 * 新主管另外收一句話，知道自己升了、同桌是誰
 */
export function promoteAtTable(tableId: number, id: string, demo?: number, now = Date.now()): { ok: boolean; text: string } {
  const j = demo !== undefined ? demoRoster(demo, now) : roster(now)
  const table = j.tables.find(x => x.id === tableId)
  if (!table) return { ok: false, text: '找不到這張桌子' }
  const seat = new Map(j.people.filter(p => p.seat).map(p => [p.id, p.seat as string]))
  const who = atTable(tableId, j.people, seat)
  const boss = who.find(p => p.id === id)
  if (!boss) return { ok: false, text: '這位不在這張桌子' }
  if (boss.role === 'manager') return { ok: false, text: `${boss.plate} 已經是主管` }
  if (boss.kind) return { ok: false, text: '主管只能是 Claude（使用者 2026-11-24 決定）' } // agy、Codex 都不行（審查第 5 項）
  const handle = boss.agent || boss.code || boss.plate
  const mates = who.filter(p => p !== boss)
  if (demo !== undefined) return { ok: true, text: `（示意）會請 ${boss.plate} 升主管，同桌 ${mates.length} 位掛到他底下` }
  const S = office(), t = S.tables.find(x => x.id === tableId)
  if (t) { t.team = handle; t.auto = false; try { saveStore(officeFile(), S) } catch {} }
  const ask = (p: { id: string }, what: string) => sendCommand(p.id, `（人事命令，來自手機像素辦公室）請用 office_profile 工具${what}，設好回一句就好，不用做別的事`, now)
  const bad: string[] = []
  if (!takesOrders(boss)) { if (ask(boss, '把 role 設成 manager')) bad.push(boss.plate) } else writeOrder(boss.id, { role: 'manager' }, now)
  for (const p of mates) {
    if (!takesOrders(p)) { if (ask(p, `把 team 設成「${handle}」（你的新主管）`)) bad.push(p.plate) } else writeOrder(p.id, { team: handle }, now)
  }
  if (!boss.kind) sendCommand(boss.id, `（人事命令，來自手機像素辦公室）使用者把你升為協作桌「${tableLabel(table.name, table.teamName)}」的主管；外掛已替你設 role=manager，同桌 ${mates.length} 位（${mates.map(p => p.agent ?? p.plate).join('、')}）的 team 改成你。若 office_roster 看到你還是 staff，自己用 office_profile 設 role=manager。照 pixel-office:team skill 當主管，回一句收到就好`, now)
  return { ok: bad.length === 0, text: `⭐ ${boss.plate} 升主管、同桌 ${mates.length} 位掛到他底下（幾秒內生效）${bad.length ? `；沒送到：${bad.join('、')}` : ''}` }
}

/**
 * 協作桌「一鍵設成一組」（0.63.45；判斷與寫檔在 remote/teamup.ts）：手機桌子選單 → 確認卡（op=preview）→ 確定（op=go）
 */
/** 成組用到的外部來源（正式接線＝realTeamSrc；測試換成假的，驗「每次查桌都重取當下名冊」） */
export type TeamSrc = {
  /** 開頭用：完整名冊（roster() 會分配座位、寫辦公室狀態等，跟手機每次讀畫面一樣）；一次成組只叫一次 */
  roster: () => { people: (TeamPerson & { seat?: string })[] }
  /** 最後一查用：只讀，不寫任何檔（第五輪複驗第 2 項） */
  peek: () => { people: (TeamPerson & { seat?: string })[] }
  store: () => Store
  persist: (S: Store) => void
  order: (p: TeamPerson, o: { role?: 'manager'; team?: string }) => boolean
  deliver: (p: TeamPerson, text: string) => Promise<Delivery>
  mail: (to: string, text: string) => boolean
  dir: (id: number, bossId: string) => string
}
const realTeamSrc = (now: number): TeamSrc => ({
  roster: () => roster(Date.now()),
  peek: () => peekRoster(Date.now()),
  store: () => office(),
  persist: S => saveStore(officeFile(), S),
  order: (p, o) => { if (!takesOrders(p)) return false; writeOrder(p.id, o, now); return true },
  deliver: (p, text) => deliverAsync(p.id, text, now),
  mail: (to, text) => {
    try {
      const d = join(BASE, 'mail'); mkdirSync(d, { recursive: true })
      writeFileSync(join(d, `${now}-${crypto.randomUUID().slice(0, 8)}.json`), JSON.stringify({ from: '📱 像素辦公室', to, text, at: now, state: 'pending', match: 'agent' }))
      return true
    } catch { return false }
  },
  dir: (id, bossId) => notesDir(id, bossId),
})
/**
 * 只讀的名冊：在線名單（狀態檔）＋辦公室檔的座位表算出座位，不呼叫 roster()（它會分配座位存檔、併招聘令、排 outbox、記 App 分頁）。
 * 座位用辦公室檔的「複本」跑 assign，所以不寫檔；跟 roster() 的差別：還沒對上的 Codex 釘選（resolveCodexPins）不套
 */
export function peekRoster(now = Date.now()) {
  const list = seatList(crew(now).people).map(x => x.p)
  const { map } = assign(parseStore(JSON.stringify(office())), list, now)
  return { people: list.map(p => ({ ...p, seat: map.get(p.id) })) }
}
export const teamDeps = (src: TeamSrc): TeamDeps => {
  // 開頭（確認版本、執行前檢查）共用同一份完整名冊；最後一查（live）每次重取只讀名冊，看得到通知等待期間的換座、換主管（複驗第四、五輪）
  let first: ReturnType<TeamSrc['roster']> | undefined
  return {
  table: (id, live) => {
    const j = live ? src.peek() : (first ??= src.roster())
    const tb = src.store().tables.find(x => x.id === id)
    if (!tb) return undefined
    const seat = new Map(j.people.filter(p => p.seat).map(p => [p.id, p.seat as string]))
    return { name: tb.name, people: atTable(id, j.people, seat), group: tb.group }
  },
  // 別張桌已經掛同一個主管：自動分桌只挑第一張符合的桌，同名掛兩張會讓沒釘選的人跑到另一桌（審查第 2 列）
  elsewhere: (team, id) => src.store().tables.find(x => x.id !== id && x.team === team)?.name,
  dir: src.dir,
  order: src.order,
  deliver: src.deliver,
  mail: src.mail,
  save: (id, g, team) => {
    const S = src.store(), t = S.tables.find(x => x.id === id)
    if (!t) return false
    // 桌子記在主管名下、不再是自動開的（跟 promoteAtTable 升主管同一做法）：座位不會因為成了新團隊被搬走、桌子不會被當成自動桌收掉
    t.group = g; t.team = team; t.auto = false
    try { src.persist(S); return true } catch { return false }
  },
  }
}
export function tableTeamPreview(id: number, demo?: number, now = Date.now()) {
  if (demo !== undefined) return { ok: true, text: '', ver: 'demo', boss: '示意主管', team: '示意主管', members: ['員工甲', '員工乙'], dir: DEMO_TEAM_DIR, notify: 3, again: false }
  return teamPreview(id, teamDeps(realTeamSrc(now)))
}
export async function tableTeamUp(id: number, ver: string, demo?: number, now = Date.now(), src: TeamSrc = realTeamSrc(now)) {
  if (demo !== undefined) return ver === 'demo' ? { ok: true, text: '（示意）會把這桌設成一組：登記主管與成員、建協作紀錄、通知每個人' } : { ok: false, text: '桌上有變動（人、主管或協作資料夾），請重看確認卡' }
  return teamUp(id, ver, teamDeps(src), now)
}
/** 示意的協作資料夾：故意很長、沒有斷點（e2e 量確認卡會不會橫向溢出，審查第 9 列） */
const DEMO_TEAM_DIR = '~/.claude/pixel-office/notes/示意-very-long-collaboration-folder-name-without-any-break-point-to-test-wrapping/agents'

// ---------- 協作桌的協作資料夾（0.62.9）：桌子自己記（table.collab）；沒設才退回「主管工作資料夾 → projects.json → <主 repo>/.claude/office」 ----------
const expandHome = (p: string) => (p.startsWith('~') ? homedir() + p.slice(1) : p)
/** 一個工作資料夾的協作資料夾：跟 takeover.py／skill 同規則（git 主 repo → ~/.claude/office/projects.json） */
const gitTop = new Map<string, { top: string; at: number }>()
export function officeOfDir(dir: string): string {
  // git 限時 3 秒（0.62.16：雲端同步資料夾第一次被讀時 macOS 等「允許存取」，git 卡住會卡死整台伺服器）；
  // 逾時或不是 git → 當作資料夾本身；結果留 10 分鐘，不用每次都跑
  let main = dir
  const hit = gitTop.get(dir)
  if (hit && Date.now() - hit.at < 10 * 60e3) main = hit.top
  else {
    try {
      const r = Bun.spawnSync(['git', '-C', dir, 'rev-parse', '--show-toplevel'], { stdout: 'pipe', stderr: 'pipe', timeout: EXT_TIMEOUT_MS, killSignal: 'SIGKILL' })
      if (r.exitCode === 0) main = r.stdout.toString().trim() || dir
    } catch {}
    gitTop.set(dir, { top: main, at: Date.now() })
  }
  let projects: unknown
  try { projects = JSON.parse(readFileSync(join(homedir(), '.claude', 'office', 'projects.json'), 'utf8')) } catch {}
  return officeFor(main, projects)
}
/** session 的工作資料夾：Claude Code 自己的紀錄（各設定資料夾的 sessions/*.json，有 sessionId 與 cwd） */
export function sessionCwd(id: string): string | undefined {
  const dirs = [...new Set([...(config().configDirs ?? []), join(homedir(), '.claude')])]
  for (const d of dirs) {
    let names: string[] = []
    try { names = readdirSync(join(d, 'sessions')).filter(n => n.endsWith('.json')) } catch { continue }
    for (const n of names) {
      try { const j = JSON.parse(readFileSync(join(d, 'sessions', n), 'utf8')); if (j.sessionId === id && typeof j.cwd === 'string') return j.cwd } catch {}
    }
  }
  return undefined
}
/** 這桌的協作資料夾：桌子記的優先，沒有就解析主管（bossId）的工作資料夾 */
export function collabOf(tableId: number, bossId?: string): string | undefined {
  const t = office().tables.find(x => x.id === tableId)
  if (t?.collab) return expandHome(t.collab)
  const cwd = bossId ? sessionCwd(bossId) : undefined
  return cwd ? officeOfDir(cwd) : undefined
}

// ---------- 同桌共用筆記（roadmap 第 11 項，0.62.10）----------
// 筆記資料夾＝這桌的協作資料夾（collabOf）；找不到就放 ~/.claude/pixel-office/notes/<port>-t<桌號>/。桌子解散時筆記保留不刪
const NOTES = join(BASE, 'notes')
export function notesDir(tableId: number, bossId?: string): string {
  return collabOf(tableId, bossId) ?? join(NOTES, `${config().port}-t${tableId}`)
}
const readText = (p: string) => { try { return readFileSync(p, 'utf8') } catch { return undefined } }
const MODE_ZH = MODE_TEXT
const hhmm = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

/** 一張桌子的共用筆記（照段落）：待你決定（最上面）、分工與進度（自動）、各人做到哪（檢查點最新一筆）、使用者交代、主管寫的、行政整理 */
export function tableNotes(tableId: number, now = Date.now()) {
  const S = office(), t = S.tables.find(x => x.id === tableId)
  if (!t) return { ok: false as const, text: '找不到這張桌子' }
  const j = roster(now)
  const map = new Map(j.people.filter(p => p.seat).map(p => [p.id, p.seat as string]))
  const at = atTable(tableId, j.people, map)
  const boss = at.find(p => p.role === 'manager')
  const dir = notesDir(tableId, boss?.id)
  const collab = readText(join(dir, 'collab.md'))
  const sec = collab ? mdSections(collab) : new Map<string, string>()
  const decide = tableRows(sec.get('待使用者裁示') ?? '').map(r => ({ text: r[1] ?? r.join(' '), where: r[2] ?? '', at: r[3] ?? '' }))
  let cpFiles: { name: string; text: string }[] = []
  try { cpFiles = readdirSync(join(dir, 'checkpoints')).filter(n => n.endsWith('.md')).map(n => ({ name: n, text: readText(join(dir, 'checkpoints', n)) ?? '' })) } catch {}
  const cps = latestCheckpoints(cpFiles)
  const auto = at.map(p => ({ id: p.id, plate: p.plate, agent: p.agent, title: p.title, role: p.id === t.admin ? 'admin' : p.role, doing: p.approval ? `卡在等你按允許（${p.approval}）` : MODE_ZH[p.mode] ?? p.mode, waiting: p.mode === 'waiting', blocked: p.mode === 'blocked' }))
  // Codex 的檢查點在它自己的 cpFile（招聘時給的、它寫得進去的位置；0.63.15 審查第 7 項：換桌不改路徑），不一定在這桌的 checkpoints/
  const ownCp = (p: { id: string; kind?: string }) => {
    if (p.kind !== 'codex') return
    const f = readJson(join(BASE, 'sessions', `${p.id}.json`))?.cpFile
    // 只讀 checkpoints 資料夾裡的 .md（複驗 A：狀態檔的路徑不能隨便信）
    const text = typeof f === 'string' && /\/checkpoints\/[^/]+\.md$/.test(f) && !f.includes('..') ? readText(f) : undefined
    return text ? [...latestCheckpoints([{ name: f.split('/').pop()!, text }]).values()].pop() : undefined
  }
  // Codex 先看它自己綁定的 cpFile（複驗第 7 項：桌上剛好有同名的檔會顯示錯人的進度）
  const progress = at.map(p => { const c = ownCp(p) || (p.agent && cps.get(p.agent)) || (p.title && cps.get(p.title)) || cps.get(p.plate); return { plate: p.plate, head: c?.head, text: c?.text } })
  const asks = (readText(join(dir, '交代.md')) ?? '').split(/\r?\n/).filter(l => l.startsWith('- ')).slice(-20).map(l => l.slice(2))
  const bossPart = !boss && !collab ? undefined : {
    scope: tableRows(sec.get('主管') ?? '')[0]?.[1],
    parts: ['目標', '交接紀錄', '重要檔案'].filter(k => sec.get(k)).map(k => ({ title: k, text: sec.get(k)! })),
  }
  const admin = t.admin ? at.find(p => p.id === t.admin) : undefined
  const tasks = boss ? tableTasks([boss.id], boss.agent ? [boss.agent] : [], now) : { active: [], done: [] }
  // 會議紀錄（第 9 項）：<筆記資料夾>/會議/<日期>-<題目>/，有 方案.md＝有結論（新→舊，最多 10 場）
  let mdirs: string[] = []
  try { mdirs = readdirSync(join(dir, '會議')).sort().reverse().slice(0, 10) } catch {}
  const meetingsLog = mdirs.map(n => { const r = readText(join(dir, '會議', n, '方案.md')); return { name: n, done: r !== undefined, result: r ? (r.length > 3000 ? r.slice(0, 3000) + '\n…' : r) : undefined } })
  const view = { ok: true as const, tasks, meetings: meetingsLog, id: tableId, label: tableLabel(t.name, boss?.plate), dir, hasBoss: !!boss, boss: boss?.plate, decide, auto, progress, asks, bossPart, admin: admin ? { plate: admin.plate, text: readText(join(dir, '行政.md')) ?? '' } : undefined, at: now }
  // 給 Desktop 面板（唯讀）：外掛讀這份快照，不自己去找協作資料夾
  try { mkdirSync(NOTES, { recursive: true }); writeFileSync(join(NOTES, `${config().port}-t${tableId}.view.json`), JSON.stringify(view)) } catch {}
  return view
}

// ---------- 任務卡片（roadmap 第 10 項，0.62.11）：tasks/<id>.json（主管）＋ tasks/<id>.<n>.json（那份的負責人）----------
const TASKS = join(BASE, 'tasks')
/** 這桌的任務：開任務的主管坐在這桌（session id 或 ListAgents 名稱對得上）；進行中（舊→新）、已完成（7 天內，新→舊）。順便刪掉完成超過 7 天的、60 天沒完成的 */
export function tableTasks(bossIds: string[], bossAgents: string[], now = Date.now()) {
  let names: string[] = []
  try { names = readdirSync(TASKS) } catch {}
  const active: ReturnType<typeof taskCard>[] = [], done: ReturnType<typeof taskCard>[] = []
  for (const n of names.filter(n => /^[0-9a-f]{8}\.json$/.test(n))) {
    const def = parseTask(readText(join(TASKS, n)))
    if (!def) continue
    const status = new Map<number, { state: PartState; at: number; note?: string }>()
    def.parts.forEach((_, i) => { try { const j = JSON.parse(readFileSync(join(TASKS, `${def.id}.${i}.json`), 'utf8')); if (['waiting', 'doing', 'done', 'stuck'].includes(j.state)) status.set(i, { state: j.state, at: Number(j.at) || def.at, note: typeof j.note === 'string' ? j.note : undefined }) } catch {} })
    const card = taskCard(def, status)
    const stale = card.doneAt ? now - card.doneAt > TASK_KEEP_MS : now - def.at > 60 * 24 * 3600e3
    if (stale) { for (const f of names.filter(f => f.startsWith(`${def.id}.`))) try { rmSync(join(TASKS, f), { force: true }) } catch {} continue }
    if (!bossIds.includes(def.boss) && !(def.bossAgent && bossAgents.includes(def.bossAgent))) continue
    ;(card.doneAt ? done : active).push(card)
  }
  return { active: active.sort((a, b) => a.at - b.at), done: done.sort((a, b) => (b.doneAt ?? 0) - (a.doneAt ?? 0)) }
}
const taskCache = new Map<number, { at: number; n: number }>()
function activeTasks(tableId: number, boss: { id: string; agent?: string } | undefined, now: number): number {
  if (!boss) return 0
  const c = taskCache.get(tableId)
  if (c && now - c.at < 15e3) return c.n
  const n = tableTasks([boss.id], boss.agent ? [boss.agent] : [], now).active.length
  taskCache.set(tableId, { at: now, n })
  return n
}

/** 📎 副本（roadmap 第 10 項）：使用者從手機傳話給有主管的員工時，主管同時收到一份（只要知道、不用回）。傳給主管自己的、📣 整桌的不送 */
export function ccTargets(ppl: Coworker[], ids: string[]): Map<string, string[]> {
  const by = new Map<string, string[]>()
  for (const id of ids) {
    const p = ppl.find(x => x.id === id)
    if (!p || p.role === 'manager' || !p.team) continue
    const boss = ppl.find(x => x.role === 'manager' && x.id !== p.id && (x.agent === p.team || x.name === p.team || x.code === p.team))
    if (boss && !ids.includes(boss.id)) by.set(boss.id, [...(by.get(boss.id) ?? []), p.agent ?? p.name])
  }
  return by
}
export function ccBoss(ids: string[], text: string, now = Date.now()): void {
  for (const [bossId, names] of ccTargets(crew(now).people, ids)) sendCommand(bossId, `📎 副本：使用者傳給 ${names.join('、')}（你知道就好，不用回）：${text.length > 1500 ? text.slice(0, 1500) + '…' : text}`, now)
}

/** 「待你決定」幾件（桌牌選單的紅點）：讀 collab.md，每張桌 15 秒最多讀一次 */
const decideCache = new Map<number, { at: number; n: number }>()
function decideCount(tableId: number, bossId: string | undefined, now: number): number {
  const c = decideCache.get(tableId)
  if (c && now - c.at < 15e3) return c.n
  const md = readText(join(notesDir(tableId, bossId), 'collab.md'))
  const n = md ? tableRows(mdSections(md).get('待使用者裁示') ?? '').length : 0
  decideCache.set(tableId, { at: now, n })
  return n
}

/** 整桌開會（第 9 項）：開在這桌、主持人＝這桌主管；會議資料夾在這桌的筆記資料夾（協作資料夾）底下 */
export function meetAtTable(tableId: number, topic: string, ids: string[], now = Date.now(), by?: string): { ok: boolean; text: string; id?: string } {
  const S = office(), t = S.tables.find(x => x.id === tableId)
  if (!t) return { ok: false, text: '找不到這張桌子' }
  const j = roster(now)
  const map = new Map(j.people.filter(p => p.seat).map(p => [p.id, p.seat as string]))
  const who = atTable(tableId, j.people, map)
  const boss = who.find(p => p.role === 'manager')
  return startMeeting({ table: tableId, label: tableLabel(t.name, boss?.plate), topic, ids, who, notesDir: notesDir(tableId, boss?.id), by }, now)
}

/**
 * 整桌排班到時間（第 8 項，0.62.13）：送給「當下坐在這桌」的每個人（不存固定名單）。
 * report：各自回報——組員把回報傳給主管，主管整理一份給使用者（沒主管就各自回報使用者）；meet：照第 9 項直接整桌開會（不先問）。
 * 不在線的略過：最近 7 天坐過這桌、現在不在線的人，結果註明「某某不在線」
 */
export function runTableShift(tableId: number, action: 'report' | 'meet', text: string, now = Date.now()): { ok: boolean; msg: string } {
  const S = office(), t = S.tables.find(x => x.id === tableId)
  if (!t) return { ok: false, msg: '這張協作桌不在了' }
  const j = roster(now)
  const map = new Map(j.people.filter(p => p.seat).map(p => [p.id, p.seat as string]))
  const who = atTable(tableId, j.people, map)
  const away = Object.entries(S.seats).filter(([id, s]) => s.key.startsWith(`t${tableId}.`) && now - s.seen < 7 * 24 * 3600e3 && !j.people.some(p => p.id === id)).map(([id]) => sessionName(id) ?? id.slice(0, 8))
  const awayText = away.length ? `；${away.join('、')} 不在線` : ''
  if (!who.length) return { ok: false, msg: `這桌現在沒有人${awayText}` }
  if (action === 'meet') {
    const r = meetAtTable(tableId, text, who.map(p => p.id), now, 'shift')
    return { ok: r.ok, msg: `${r.text}${awayText}` }
  }
  const boss = who.find(p => p.role === 'manager'), handle = boss ? boss.agent || boss.plate : undefined
  let n = 0
  for (const p of who) {
    const msg = !boss ? `⏰ 整桌排班（各自回報）：${text}。這桌沒有主管，直接回報使用者。`
      : p === boss ? `⏰ 整桌排班（各自回報）：${text}。組員會各自把回報傳給你（${who.length - 1} 位：${who.filter(x => x !== boss).map(x => x.agent || x.plate).join('、') || '無'}${awayText}），收齊後整理一份給使用者。`
      : `⏰ 整桌排班（各自回報）：${text}。用 SendMessage 把回報傳給主管 ${handle}（主管會整理一份給使用者）。`
    if (!sendCommand(p.id, msg, now)) n++
  }
  return { ok: n > 0, msg: `已交代 ${n} 位${awayText}` }
}
/** 不在線的人叫什麼：讀他最後的狀態檔（ListAgents 名稱或名牌） */
function sessionName(id: string): string | undefined {
  try { const j = JSON.parse(readFileSync(join(SESSIONS, `${id}.json`), 'utf8')); return j.agent || j.name } catch { return undefined }
}

/** 📝 交代：直接記進這桌的 交代.md（記時間），同時傳給主管；不經主管轉寫 */
export function noteToTable(tableId: number, text: string, demo?: number, now = Date.now()): { ok: boolean; text: string } {
  const t = text.replace(/\s+/g, ' ').trim()
  if (!t || t.length > 2000) return { ok: false, text: '交代是空的或太長（最多 2000 字）' }
  if (demo !== undefined) return { ok: true, text: '（示意）會記進交代、傳給主管' }
  const S = office(), table = S.tables.find(x => x.id === tableId)
  if (!table) return { ok: false, text: '找不到這張桌子' }
  const j = roster(now)
  const map = new Map(j.people.filter(p => p.seat).map(p => [p.id, p.seat as string]))
  const boss = atTable(tableId, j.people, map).find(p => p.role === 'manager')
  const dir = notesDir(tableId, boss?.id), f = join(dir, '交代.md')
  try {
    mkdirSync(dir, { recursive: true })
    const old = readText(f) ?? '# 使用者交代（伺服器記，一行一則；只有手機「📝 交代」寫）\n\n'
    writeFileSync(f, `${old}${old.endsWith('\n') ? '' : '\n'}- ${hhmm(now)} ${t}\n`)
  } catch (e) {
    return { ok: false, text: `記不進去：${String(e).slice(0, 120)}` }
  }
  if (!boss) return { ok: true, text: '記進交代了（這桌還沒有主管，沒有傳）' }
  const err = sendCommand(boss.id, `📝 使用者交代協作桌「${tableLabel(table.name, boss.plate)}」（已記進 ${f}，不用你轉寫）：${t}`, now)
  return err ? { ok: true, text: `記進交代了，但沒傳到主管：${err}` } : { ok: true, text: `記進交代、傳給 ${boss.plate} 了` }
}

/**
 * 招聘時選身分與座位（roadmap 第 6 項，0.62.8）。seat：桌號／'new'（開新桌，主管才行）／'none'（辦公區）。組合：
 * ① 員工＋有主管的桌：入座、team＝那桌主管 ② 員工＋沒主管的桌：入座、不掛（滿 4 人照第 5 項變紅）
 * ③ 主管＋開新桌：開一張以他命名的桌、坐 0 號主管椅 ④ 主管＋沒主管的桌：當這桌主管，同桌其他人 team＝他（人事令）
 * ⑤ 主管＋已有主管的桌：要 b.replace＝true（手機先問過），新人以員工入座、走交接流程（handover.ts）
 * 座位用 pins 先佔好（新人還沒上線），上線後 assign 照 pins 坐
 */
/** 剛招、還沒上線的主管（桌號 → 誰）：這段時間招進同桌的員工照樣掛他底下（0.62.17） */
const PENDING_BOSS_MS = 10 * 60e3
const pendingBoss = new Map<number, { sid: string; name: string; at: number }>()

/** 解雇後清掉他的座位（0.62.17：釘選沒清會被當成「在路上的新人」一直佔位） */
export function unseat(id: string): void {
  const S = office()
  if (!(id in S.pins) && !(id in S.seats)) return
  unpin(S, id); delete S.seats[id]
  for (const t of S.tables) if (t.admin === id) delete t.admin
  saveStore(officeFile(), S)
}

export function hireAt(b: any, now = Date.now(), hireFn: (b: any, opts?: { addDirs?: (string | undefined)[]; cpFile?: string }) => { ok: boolean; text: string; sid?: string } = hire): { ok: boolean; text: string; need?: string } {
  const role = b?.role === 'manager' ? 'manager' : b?.role === 'admin' ? 'admin' : 'staff'
  if (role === 'admin' && !/^\d+$/.test(String(b?.seat ?? ''))) return { ok: false, text: '行政要選一張協作桌（坐那桌主管旁邊）' }
  const seat = b?.seat === 'new' || b?.seat === 'none' || b?.seat === undefined || b?.seat === '' ? (b?.seat || 'none') : Number(b.seat)
  const name = String(b?.name ?? '').replace(/[\x00-\x1f\x7f]/g, '').trim()
  if (seat === 'none') return hireFn({ ...b, role })
  const S = office()
  if (seat === 'new') {
    if (role !== 'manager') return { ok: false, text: '開新桌要選「主管」（員工請選現有的桌）' }
    // 開新桌：協作資料夾預設放 ~/.claude/pixel-office/notes/<port>-t<桌號>（0.62.17；原本用主管工作資料夾解析出來的，
    // 會寫進別的團隊的辦公室資料夾、又在工作資料夾外要信任）；之後可在單張協作桌選單改
    const id = S.nextId
    const collab = join(NOTES, `${config().port}-t${id}`)
    const r = hireFn({ ...b, role, team: '' }, { addDirs: [collab] })
    if (!r.ok || !r.sid) return r
    S.nextId = Math.max(S.nextId, id + 1)
    const t = { id, name: [...`${name}桌`].slice(0, 12).join(''), size: 4, team: name, collab }
    S.tables.push(t)
    pinSeat(S, r.sid, `t${t.id}.0`, 'hire')
    saveStore(officeFile(), S)
    pendingBoss.set(t.id, { sid: r.sid, name, at: now })
    return { ok: true, text: `${r.text}；開了一張「${t.name}」，他坐主管椅` }
  }
  const j = roster(now)
  const table = S.tables.find(t => t.id === seat)
  if (!table) return { ok: false, text: '找不到這張桌子' }
  const map = new Map(j.people.filter(p => p.seat).map(p => [p.id, p.seat as string]))
  const at = atTable(table.id, j.people, map)
  const pinned = Object.entries(S.pins).filter(([id, k]) => k.startsWith(`t${table.id}.`) && !j.people.some(p => p.id === id)).map(([, k]) => k) // 還在路上的新人
  const used = new Set([...at.map(p => map.get(p.id)!), ...pinned])
  const free = Array.from({ length: table.size }, (_, i) => `t${table.id}.${i}`).filter(k => !used.has(k))
  if (!free.length) return { ok: false, text: `「${table.name}」坐滿了（${table.size} 人），先改大或選別張` }
  const boss = at.find(p => p.role === 'manager')
  const pend = boss ? undefined : pendingBoss.get(table.id)
  const waitBoss = pend && now - pend.at < PENDING_BOSS_MS && !j.people.some(p => p.id === pend.sid) ? pend.name : undefined
  const label = tableLabel(table.name, boss?.plate ?? waitBoss)
  // 坐協作桌的人：第一句加上「檢查點寫在這桌的筆記資料夾」（共用筆記的「各人做到哪」讀它，0.62.10）
  const dir = notesDir(table.id, boss?.id)
  // Codex 的檢查點檔名加短碼（0.63.22，最後複驗第 4 項：同桌兩位同名的 Codex 會綁到同一個檔）；共用筆記照它綁定的 cpFile 讀，不靠檔名
  const cpName = b?.agent === 'codex' ? `${name}-${crypto.randomUUID().slice(0, 6)}` : name
  const cpFile = join(dir, 'checkpoints', `${cpName}.md`) // Codex：人事令帶給看守，每小時提醒、壓縮後提示重讀（0.63.6）
  // 開場句的路徑跟 cpFile 同一份（0.63.62：原本手接 `/checkpoints/`，Windows 上變成 \ 與 / 混用）
  const cpNote = `做到一個段落、收工前，在 ${cpFile} 存一筆檢查點（「## YYYY-MM-DD HH:mm ${name}」＋做完／卡在／下一步，只往後加），這桌的共用筆記會顯示最新一筆。`
  const withCp = (task: unknown) => `${typeof task === 'string' && task.trim() ? `${task.trim()}\n` : ''}${cpNote}`
  if (role === 'admin') {
    const team = boss ? boss.agent || boss.code || boss.plate : waitBoss ?? ''
    const r = hireFn({ ...b, role: 'staff', team, title: '行政', task: `${adminBrief(label, boss ? boss.agent || boss.plate : waitBoss, dir)}\n${withCp(b.task)}` }, { addDirs: [dir], cpFile })
    if (!r.ok || !r.sid) return r
    const near = free.includes(`t${table.id}.1`) ? `t${table.id}.1` : free.find(k => k !== `t${table.id}.0`) ?? free[0] // 座位在主管旁邊：1 號優先
    pinSeat(S, r.sid, near, 'hire')
    table.admin = r.sid
    saveStore(officeFile(), S)
    return { ok: true, text: `${r.text}；當「${label}」的行政${boss || waitBoss ? `，掛在 ${boss?.plate ?? waitBoss} 底下` : ''}` }
  }
  b = { ...b, task: withCp(b.task) }
  if (role === 'staff') {
    const r = hireFn({ ...b, role, team: boss ? boss.agent || boss.code || boss.plate : waitBoss ?? '' }, { addDirs: [dir], cpFile })
    if (!r.ok || !r.sid) return r
    pinSeat(S, r.sid, free[0], 'hire')
    saveStore(officeFile(), S)
    return { ok: true, text: `${r.text}；坐「${label}」${boss ? `，掛在 ${boss.plate} 底下` : waitBoss ? `，掛在 ${waitBoss} 底下（他還在路上）` : '（這桌沒有主管）'}` }
  }
  if (!boss) {
    const r = hireFn({ ...b, role, team: '' }, { addDirs: [dir], cpFile })
    if (!r.ok || !r.sid) return r
    const head = `t${table.id}.0`
    const sitter = at.find(p => map.get(p.id) === head)
    if (sitter) pinSeat(S, sitter.id, free.find(k => k !== head) ?? free[0], 'hire') // 主管椅有人：請他換到空位
    pinSeat(S, r.sid, used.has(head) && !sitter ? free[0] : head, 'hire')
    table.team = name; table.auto = false
    saveStore(officeFile(), S)
    pendingBoss.set(table.id, { sid: r.sid, name, at: now })
    for (const p of at) { if (!takesOrders(p)) sendCommand(p.id, `（人事命令，來自手機像素辦公室）請用 office_profile 工具把 team 設成「${name}」（你的新主管），設好回一句就好`, now); else writeOrder(p.id, { team: name }, now) }
    return { ok: true, text: `${r.text}；當「${label}」的主管，同桌 ${at.length} 位掛到他底下` }
  }
  const bossName = boss.agent || boss.plate // 名牌可能被截斷（「像素辦公室 v2 整」）：訊息寫 ListAgents 名稱
  if (!b.replace) return { ok: false, need: 'replace', text: `要讓新人取代 ${bossName} 當這桌主管嗎？${bossName} 會先交接。` }
  const r = hireFn({ ...b, role: 'staff', team: boss.agent || boss.code || boss.plate }, { addDirs: [dir], cpFile })
  if (!r.ok || !r.sid) return r
  pinSeat(S, r.sid, free[0], 'hire')
  saveStore(officeFile(), S)
  startHandover({ table: table.id, label, collab: collabOf(table.id, boss.id), newSid: r.sid, newName: name, oldId: boss.id, oldName: bossName, oldHandle: boss.agent || boss.code || boss.plate, oldTeam: boss.team, at: now })
  return { ok: true, text: `${r.text}；先以員工身分坐「${label}」，等 ${bossName} 交接完再換成主管` }
}

/** 交接完正式換主管（handover.ts 呼叫）：改身分（人事令；Codex／agy 送一句話）、桌子歸屬、新人坐 0 號 */
/** 交接完成後桌子要記的主管名：名冊上的 agent，沒有才退回招聘時的名字 */
export const newBossHandle = (people: { id: string; agent?: string }[], h: { newSid: string; newName: string }) =>
  people.find(p => p.id === h.newSid)?.agent || h.newName

export function swapBoss(h: Handover, now = Date.now()): string {
  const j = roster(now), S = office()
  const map = new Map(j.people.filter(p => p.seat).map(p => [p.id, p.seat as string]))
  const at = atTable(h.table, j.people, map)
  const order = (id: string, o: { role?: 'manager' | 'staff'; team?: string }) => {
    const p = j.people.find(x => x.id === id)
    if (!takesOrders(p ?? { id })) sendCommand(id, `（人事命令，來自手機像素辦公室）請用 office_profile 工具${o.role ? `把 role 設成 ${o.role}` : ''}${o.role && o.team ? '、' : ''}${o.team ? `把 team 設成「${o.team}」` : ''}，設好回一句就好`, now)
    else writeOrder(id, o, now)
  }
  // 桌子歸屬與組員的 team 用新主管在名冊上的 agent（ListAgents 名；0.63.57）：排座位用 agent 找桌，寫招聘時的名字會對不到
  const handle = newBossHandle(j.people, h)
  order(h.newSid, { role: 'manager', ...(h.oldTeam ? { team: h.oldTeam } : {}) })
  order(h.oldId, { role: 'staff', team: handle })
  for (const p of at) if (p.id !== h.newSid && p.id !== h.oldId) order(p.id, { team: handle })
  const t = S.tables.find(x => x.id === h.table)
  if (t) { retarget(t, handle); t.auto = false }
  if (map.get(h.newSid) || S.pins[h.newSid]) {
    const mine = map.get(h.newSid) ?? S.pins[h.newSid], head = `t${h.table}.0`
    pinSeat(S, h.newSid, head, 'hire')
    if (map.get(h.oldId) === head || S.pins[h.oldId] === head) pinSeat(S, h.oldId, mine, 'hire')
  }
  saveStore(officeFile(), S)
  sendCommand(h.oldId, `（手機像素辦公室）交接完成：${h.newName} 接任「${h.label}」主管，你改當員工留在這桌（team＝${handle}）。沒做完的事由新主管決定要不要派回給你，回一句收到就好`, now)
  return `${h.oldName} → ${h.newName}`
}

/** 示意資料（?demo=N）：伺服器產生，團隊同桌、協作桌編輯也能試；什麼都不送出 */
/** 保留的座位收掉：人回到名冊（在 App 打開或接回）、或交接記錄已經不在（0.63.29） */
function releaseReserved(online: string[]): {} {
  const S = office()
  if (!S.reserved) return {}
  let dirty = false
  // 跟交接記錄同一個有效期（一天）：過期的記錄一起收掉（複驗新問題 3）
  for (const id of Object.keys(S.reserved)) {
    const r = inAppOf(id)
    if (online.includes(id) || !r || Date.now() - r.at > 24 * 3600e3) { delete S.reserved[id]; dirty = true; if (r && Date.now() - r.at > 24 * 3600e3) try { rmSync(join(BASE, 'hr', `${id}.inapp.json`), { force: true }) } catch {} }
  }
  if (dirty) try { saveStore(officeFile(), S) } catch {}
  return {}
}
/** codexAway 每筆帶它被釘住的座位（像素工程師：座位上畫「X・在 App 裡」的名牌） */
function withPinnedSeat<T extends { id: string }>(list: T[]): (T & { seat?: string })[] {
  const pins = office().pins
  return list.map(x => (pins[x.id] ? { ...x, seat: pins[x.id] } : x))
}
/** 示意：第二位在等按允許（0.63.51，前端做允許卡用；POST /approve 帶 demo 只回示意文字） */
const demoApproval = (now: number): ApprovalInfo => ({ kind: 'claude', tool: 'Bash', desc: '（示意）git push origin main\n# 第二行：長指令前端可收合', nonce: 'demo-approve', at: now - 5000, deadline: now + 100000, options: [{ key: 'allow', label: '允許這一次' }, { key: 'deny', label: '拒絕' }], where: 'tmux' })
/** 示意：最後一位當成手機招聘、開在 tmux 的 Codex（0.63.28：前端測「交給 App」按鈕） */
const DEMO_TMUX_CODEX = { kind: 'codex', src: 'tmux', ctl: true, model: 'gpt-6.2-sol', effort: 'low', perm: 'auto', can: { model: true, effort: true, perm: true, key: true, fire: true, handoffApp: true, handoffTmux: false } }
export function demoRoster(n: number, now = Date.now()) {
  const S = demoStore(n), people = demoPeople(n, MODE_TEXT, now).map((p, _, all) => ({ ...p, sentToId: p.sentTo ? recipientId(all, p.sentTo) : undefined }))
  const { map } = assign(S, people, now)
  // 示意幫手：一則請求、一則快被關的通知（按了什麼都不會開或關）
  const boss = people.find(p => p.role === 'manager'), t0 = S.tables[0]
  const helpers = boss ? {
    asks: [{ id: 'demo-ask', plate: boss.plate, table: t0?.name, reason: '（示意）改程式改很久了', task: '（示意）幫忙跑測試', at: now, online: true },
      { id: 'demo-ask-art', kind: 'codex-art', plate: boss.plate, table: t0?.name, reason: '（示意）新家具要參考圖', task: '（示意）畫咖啡杯、垃圾桶', at: now, online: true }],
    notices: [{ sid: 'demo-helper', name: `${boss.plate}幫手`, closeAt: Math.floor(now / 3600e3) * 3600e3 + 3600e3 }], list: [],
    checks: [{ id: 'demo-check', at: DEMO_AT, name: '（示意）生圖幫手', why: '一直沒進辦公室名冊', retry: false, session: 'po-cxp-demo0001' }],
  } : { asks: [], notices: [], checks: [], list: [] }
  // 示意交接：第一張桌交接中，一則「原主管沒交接，要等還是直接換」、一則「換好了」
  const handovers = boss && t0 ? {
    asks: [{ id: 'demo-ho', kind: 'wait', label: t0.name, oldName: boss.plate, newName: '新主管（示意）' }],
    done: [{ id: 'demo-hodone', label: t0.name, newName: '新主管（示意）', oldName: boss.plate, at: now }], tables: [t0.id],
  } : { asks: [], done: [], tables: [] }
  // 示意整桌開會：第二張團隊桌開會中（桌牌、頭上泡泡）
  const meetT = S.tables.filter(t => t.team)[1]
  const meetIds = meetT ? people.filter(p => map.get(p.id)?.startsWith(`t${meetT.id}.`)).map(p => p.id) : []
  const tables = tablesOut(S, people, map).map(t => ({
    ...t, ...(handovers.tables.includes(t.id) ? { handover: true } : {}), ...(meetT && t.id === meetT.id ? { meeting: '（示意）本週計畫', meetingId: 'demo-meet' } : {}),
    suggestAdmin: suggestAdmin((t as any).count ?? 0, false), decide: (t as any).members?.some((id: string) => people.find(p => p.id === id)?.role === 'manager') ? 2 : 0, tasks: (t as any).members?.some((id: string) => people.find(p => p.id === id)?.role === 'manager') ? 1 : 0, // 示意：有主管的桌 2 件待你決定
  }))
  const meetings = { done: meetT ? [{ id: 'demo-meetdone', table: meetT.id, label: meetT.name, topic: '（示意）上週回顧', at: now }] : [] }
  // 示意交接通知、在 App 裡的 Codex 用固定時間：畫面用 id＋at 認「哪一次交接」（審查 18），每次輪詢都給新的 at 會被當成新通知、通知列一直重畫重開
  const codexHandoffs = n ? [{ id: 'codex-demo-handoff', plate: 'cxdemo', title: '（示意）報價小幫手', at: DEMO_AT }] : []
  const codexAway = n ? [{ id: 'codex-demo-away', plate: 'cxaway', title: '（示意）在 App 裡的 Codex', at: DEMO_AT, handedOff: true, resumable: true, seat: 'o5' }, { id: 'codex-demo-away2', plate: 'cxnew', title: '（示意）App 新開的 Codex', at: DEMO_AT, handedOff: false, resumable: false, why: '這段對話還開在 App 裡，先在 App 關掉' }] : []
  const stuck = n ? [{ id: 'demo-stuck', name: '新同事（示意）', session: 'po-cxp-1234abcd', title: 'Hooks need review（Codex 要你確認外掛的 hook）', at: now, options: [{ id: 'n1', label: '1. Review' }, { id: 'n2', label: '2. Trust all and continue' }, { id: 'n3', label: '3. Continue without trusting' }] }] : []
  return { box, oneshots: 0, demo: true, helpers, handovers, meetings, stuck, codexHandoffs, codexAway, people: people.map((p, i) => ({ ...p, seat: map.get(p.id), ...(meetIds.includes(p.id) ? { meeting: true } : {}), ...(i === people.length - 1 ? DEMO_TMUX_CODEX : {}) })).map((p, i) => i === 1 ? { ...p, caps: { ...capsOf(p as any), approve: true }, approvalInfo: demoApproval(now) } : { ...p, caps: capsOf(p as any) }), tables, shifts: [], models: MODELS, efforts: EFFORTS, perms: PERMS, codexEfforts: CODEX_EFFORTS, codexPerms: CODEX_PERMS, codexModels: codexModels(), hireDirs: [] }
}

function readJson(p: string): any {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return undefined
  }
}

/** 最近一道命令：送出未收（pending）、已收（delivered）、沒被收就過期（expired） */
export function commandState(id: string, now = Date.now()): { text: string; at: number; state: 'pending' | 'delivered' | 'expired' } | undefined {
  const c = readJson(join(COMMANDS, `${id}.json`))
  if (!c || typeof c.text !== 'string' || typeof c.nonce !== 'string') return undefined
  const done = readJson(join(COMMANDS, `${id}.done.json`))
  const got = new Set([...(Array.isArray(done?.nonces) ? done.nonces : []), done?.nonce])
  const state = got.has(c.nonce) ? 'delivered' : now - Number(c.at) < COMMAND_TTL_MS ? 'pending' : 'expired'
  return { text: c.text, at: Number(c.at), state }
}

/** 那個 session 最後一輪的回覆（hooks/register.tsx saveReply 寫的；Codex 的由 codex/codex_office.py 寫） */
export function lastReply(id: string): { text: string; at: number; ask?: string } | undefined {
  const r = readJson(join(REPLIES, `${id}.json`))
  if (!r || typeof r.text !== 'string' || typeof r.at !== 'number') return undefined
  return { text: r.text, at: r.at, ask: typeof r.ask === 'string' ? r.ask : undefined }
}

/** Codex 的 session id 是 codex-<thread id>：送話不走 commands/（Codex 那半不收），改用 codex queue 排進那個 Codex 對話 */
export const codexThread = (id: string) => /^codex-([0-9a-f-]{8,64})$/.exec(id)?.[1]
/**
 * 送一句話的結果（審查 photo ⑤）：sent＝對方收下了（排進佇列）；failed＝確定沒送出；unsure＝逾時，可能稍後才到（不要叫人重送）
 * note：送到了但要補一句（例如 agy 要等它下一個動作才看得到）
 */
export type Delivery = { state: 'sent' | 'failed' | 'unsure'; text?: string; note?: string }
function deliverCodex(thread: string, text: string): Delivery {
  const exe = Bun.which('codex') ?? join(homedir(), '.local', 'bin', 'codex')
  if (!existsSync(exe) || /\.(cmd|bat)$/i.test(exe)) return { state: 'failed', text: '這台電腦沒有 codex 指令，送不過去' }
  try {
    // 照那個 Codex 自己的 CODEX_HOME 排（0.63.21，複驗第 8 項；hook 記在狀態檔的 codexHome）
    const home = readJson(join(SESSIONS, `codex-${thread}.json`))?.codexHome
    const env = typeof home === 'string' && home && !home.includes('..') ? { ...process.env, CODEX_HOME: home } : process.env
    const p = Bun.spawnSync([exe, 'queue', '--thread', thread, '--message', `📱 從像素辦公室手機版傳來（使用者）：${text}`], { env, stdout: 'pipe', stderr: 'pipe', timeout: 2 * EXT_TIMEOUT_MS, killSignal: 'SIGKILL' })
    // 逾時可能其實已經排進去：不叫使用者「晚點再送」，免得送兩次
    return p.exitCode === 0 ? { state: 'sent' } : p.signalCode ? { state: 'unsure', text: 'Codex 沒及時回應：可能稍後才收到，先看它有沒有收到再決定要不要重送' } : { state: 'failed', text: `Codex 沒收下：${errBrief(p.stderr.toString())}` }
  } catch {
    return { state: 'failed', text: 'Codex 沒收下' }
  }
}
/** agy 不收 commands/（那是 Claude 外掛的）：照 agy/agy_office.py 的收件夾寫一行（agy/inbox/<id 去掉 agy->.jsonl），它下一個動作才看得到 */
const AGY_INBOX = join(BASE, 'agy', 'inbox')
function deliverAgy(id: string, text: string, now: number): Delivery {
  const key = id.replace(/^agy-/, '')
  if (!/^[\w.-]{1,80}$/.test(key)) return { state: 'failed', text: '這位 agy 的代號不對，送不過去' }
  try {
    mkdirSync(AGY_INBOX, { recursive: true })
    appendFileSync(join(AGY_INBOX, `${key}.jsonl`), JSON.stringify({ src: 'phone', from: '📱 使用者（手機像素辦公室）', text, at: now }) + '\n') // src＝phone：agy 那頭標成使用者本人、不叫它回信（複驗 ④）
    return { state: 'sent', note: 'agy 要等它下一個動作才看得到（閒著的叫不醒）' }
  } catch { return { state: 'failed', text: 'agy 的收件夾寫不進去' } }
}
/** 手機下命令：Claude 寫 commands/<session>.json（外掛每秒來拿，hooks/register.tsx takeCommand）；Codex 走 codex queue；agy 走它的收件夾 */
export function deliver(id: string, text: string, now = Date.now()): Delivery {
  const t = text.trim()
  if (t === '' || t.length > 4000) return { state: 'failed', text: '話是空的或太長（最多 4000 字）' }
  const who = crew(now).people.find(c => c.id === id)
  if (!who) return { state: 'failed', text: '這位已經不在線' }
  const thread = who.kind === 'codex' ? codexThread(id) : undefined
  if (thread) return deliverCodex(thread, t)
  if (who.kind === 'agy') return deliverAgy(id, t, now)
  const err = enqueueCommand(id, { nonce: crypto.randomUUID(), text: t, at: now }, now)
  return err ? { state: 'failed', text: err } : { state: 'sent' }
}
/** S-4（0.63.51）：Codex 的錯誤只留最後一行、路徑縮成檔名，最多 200 字（手機上不出現家目錄、CODEX_HOME 這類完整路徑） */
export const errBrief = (err: string) => (err.trim().split('\n').filter(l => l.trim()).pop() ?? '').replace(/(?:~|\/(?:Users|private|var|home|tmp|opt|Volumes))(?:\/[^\s'"\/:]+)*\/([^\s'"\/:]+)/g, '…/$1').slice(0, 200)
/** 非同步版的 Codex 投遞（複驗 ③）：codex queue 用 Bun.spawn，不卡住伺服器；逾時一樣算 unsure */
async function deliverCodexAsync(thread: string, text: string): Promise<Delivery> {
  const exe = Bun.which('codex') ?? join(homedir(), '.local', 'bin', 'codex')
  if (!existsSync(exe) || /\.(cmd|bat)$/i.test(exe)) return { state: 'failed', text: '這台電腦沒有 codex 指令，送不過去' }
  try {
    const home = readJson(join(SESSIONS, `codex-${thread}.json`))?.codexHome
    const env = typeof home === 'string' && home && !home.includes('..') ? { ...process.env, CODEX_HOME: home } : process.env
    const p = Bun.spawn([exe, 'queue', '--thread', thread, '--message', `📱 從像素辦公室手機版傳來（使用者）：${text}`], { env, stdout: 'ignore', stderr: 'pipe' })
    let late = false
    const kill = setTimeout(() => { late = true; try { p.kill(9) } catch {} }, 2 * EXT_TIMEOUT_MS)
    const err = await new Response(p.stderr).text()
    const code = await p.exited
    clearTimeout(kill)
    return code === 0 && !late ? { state: 'sent' } : late || p.signalCode ? { state: 'unsure', text: 'Codex 沒及時回應：可能稍後才收到，先看它有沒有收到再決定要不要重送' } : { state: 'failed', text: `Codex 沒收下：${errBrief(err)}` }
  } catch {
    return { state: 'failed', text: 'Codex 沒收下' }
  }
}
/** 非同步投遞：Codex 走 deliverCodexAsync，其他跟 deliver 一樣（寫檔，很快） */
export async function deliverAsync(id: string, text: string, now = Date.now()): Promise<Delivery> {
  const t = text.trim()
  const who = t && t.length <= 4000 ? crew(now).people.find(c => c.id === id) : undefined
  const thread = who?.kind === 'codex' ? codexThread(id) : undefined
  return thread ? deliverCodexAsync(thread, t) : deliver(id, text, now)
}
/** 有上限的並行：一次最多 n 個 */
export async function mapLimit<T, R>(xs: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length)
  let i = 0
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, async () => { while (i < xs.length) { const k = i++; out[k] = await fn(xs[k]) } }))
  return out
}
/** 舊的介面：送到回 undefined，其他回原因（逾時的原因裡有寫「可能稍後才收到」） */
export function sendCommand(id: string, text: string, now = Date.now()): string | undefined {
  const d = deliver(id, text, now)
  return d.state === 'sent' ? undefined : d.text ?? '沒送出'
}

/**
 * commands/<id>.json 是佇列（0.63.17，複驗 D）：拿掉收過的（done 檔的 nonces）、過期的，再把新的接在後面；最上層的 nonce／text 是最新那則
 * （還沒更新的舊外掛照舊只看它）。外掛一次送一則、依序。原本直接蓋掉：短時間連傳三則只剩第三則
 */
export const COMMAND_QUEUE_MAX = 20
export function enqueueCommand(id: string, item: { nonce: string; text: string; at: number; from?: string }, now = Date.now()): string | undefined {
  mkdirSync(COMMANDS, { recursive: true })
  // 寫的人（伺服器、Codex、agy）共用一把鎖（0.63.22，最後複驗第 1 項）：commands/<id>.lock 資料夾，mkdir 搶得到才寫；
  // 5 秒以上的鎖當成留下來的、清掉。沒鎖時兩邊同時讀整隊、各自接一則再整檔蓋回，會互吞
  const lock = join(COMMANDS, `${id}.lock`)
  let got = false
  for (let i = 0; i < 40 && !got; i++) {
    try { mkdirSync(lock); got = true } catch {
      try { if (Date.now() - statSync(lock).mtimeMs > 5000) rmSync(lock, { recursive: true, force: true }) } catch {}
      if (!got) Bun.sleepSync(50)
    }
  }
  if (!got) return '對方的收件佇列正忙，晚點再送'
  try {
    const f = join(COMMANDS, `${id}.json`), c = readJson(f), d = readJson(join(COMMANDS, `${id}.done.json`))
    const done = new Set([...(Array.isArray(d?.nonces) ? d.nonces : []), d?.nonce].filter(x => typeof x === 'string'))
    const items: any[] = Array.isArray(c?.items) ? c.items : c && typeof c.nonce === 'string' ? [{ nonce: c.nonce, text: c.text, at: c.at, ...(c.from ? { from: c.from } : {}) }] : []
    const keep = items.filter(i => i && typeof i.nonce === 'string' && !done.has(i.nonce) && now - Number(i.at) < COMMAND_TTL_MS)
    if (keep.length >= COMMAND_QUEUE_MAX) return `對方還有 ${keep.length} 則沒收，先等它收完再送` // 滿了回報，不靜默丟舊的
    const tmp = `${f}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ ...item, items: [...keep, item] }))
    renameSync(tmp, f)
    return undefined
  } finally { try { rmSync(lock, { recursive: true, force: true }) } catch {} }
}

/** 照片檔頭：JPEG（FF D8 FF）、HEIC／HEIF（ftyp 盒子的主品牌或相容品牌是 heic、heix、mif1…；iPhone 原檔） */
const isJpeg = (b: Uint8Array) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff
const HEIF_BRANDS = /^(heic|heix|heim|heis|hevc|hevx|mif1|msf1)$/
export function isHeic(b: Uint8Array): boolean {
  if (b.length < 16 || String.fromCharCode(...b.slice(4, 8)) !== 'ftyp') return false
  const size = Math.min(b.length, ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0, 256)
  for (let i = 8; i + 4 <= size; i += 4) if (i !== 12 && HEIF_BRANDS.test(String.fromCharCode(...b.slice(i, i + 4)))) return true // 第 12～16 位元組是版本號
  return false
}
/** 照片最長邊：手機網頁送來前已縮到 1600；原檔（網頁解不了的 HEIC）在伺服器縮。Codex 的 view_image 讀不了 HEIC、太大的圖要它自己再縮（2026-11-25 實測） */
const PHOTO_EDGE = 1600, PHOTO_PIXELS = 100e6 // 像素上限：一億（iPhone 4800 萬畫素原檔也過）
const SIPS = '/usr/bin/sips'
/** 轉檔、量尺寸最多同時兩個（審查 photo ③：改非同步、有限並行，不卡住整個伺服器） */
const CONV_MAX = 2, CONV_QUEUE_MAX = 6, CONV_DEADLINE_MS = 45e3
let convRunning = 0
const convWait: (() => void)[] = []
/** 拿一個轉檔槽：排隊最多 6 個，等到 deadline 還沒輪到就放棄（複驗 ⑤）；拿不到回 undefined */
async function convSlot<T>(fn: () => Promise<T>, deadline: number): Promise<T | undefined> {
  while (convRunning >= CONV_MAX) {
    if (convWait.length >= CONV_QUEUE_MAX) return undefined
    let wake!: () => void
    const got = await new Promise<boolean>(r => { wake = () => r(true); convWait.push(wake); setTimeout(() => r(false), Math.max(0, deadline - Date.now())) })
    if (!got) { const i = convWait.indexOf(wake); if (i >= 0) convWait.splice(i, 1); return undefined }
  }
  convRunning++
  try { return await fn() } finally { convRunning--; convWait.shift()?.() }
}
/** 跑一個外部程式，到 deadline 就砍；回 { code, out } 或 undefined（逾時） */
async function runUntil(argv: string[], deadline: number): Promise<{ code: number; out: string } | undefined> {
  const left = deadline - Date.now()
  if (left <= 0) return undefined
  const p = Bun.spawn(argv, { stdout: 'pipe', stderr: 'ignore' }) // stderr 不接（複驗 ⑤：沒人讀的管子塞滿會卡住）
  const kill = setTimeout(() => { try { p.kill(9) } catch {} }, left)
  try {
    const out = await new Response(p.stdout).text()
    const code = await p.exited
    return p.signalCode ? undefined : { code, out }
  } finally { clearTimeout(kill) }
}
/** 照片存放處的新檔名（不含副檔名）：時間＋亂數，由伺服器產生 */
export const photoBase = (now = Date.now()) => join(UPLOADS, `${new Date(now).toISOString().slice(0, 19).replace(/[:T]/g, '-')}-${crypto.randomUUID().slice(0, 8)}`)
/** 刪掉 uploads/ 裡 7 天前的照片，和 1 小時前沒做完的暫存檔（.orig.*、.part.jpg）；伺服器開著時每小時跑一次 */
export function sweepUploads(now = Date.now()) {
  try {
    for (const n of readdirSync(UPLOADS)) {
      const f = join(UPLOADS, n)
      try { const age = now - statSync(f).mtimeMs; if (age > UPLOAD_KEEP_MS || (/\.(orig\.\w+|part\.jpg)$/.test(n) && age > 3600e3)) rmSync(f) } catch {}
    }
  } catch {}
}
/**
 * 存一張照片到 base＋'.jpg'（審查 photo ③）：先寫原檔（.orig），用 sips 量尺寸（同時驗得出是不是真的圖片）；
 * HEIC、或要給 Codex 又長邊超過 1600 的，轉成 JPEG 到 .part.jpg，成功才改名成正式檔（看得到的檔一定是完整的）。
 * 失敗：清掉原檔與不完整的輸出、回錯（不回退原檔）。沒有 sips（不是 Mac）：JPEG 照原檔存、HEIC 回錯
 */
export async function savePhoto(img: Uint8Array, heic: boolean, forCodex: boolean, base: string, deadline = Date.now() + CONV_DEADLINE_MS): Promise<{ path?: string; err?: string }> {
  mkdirSync(UPLOADS, { recursive: true })
  const out = `${base}.jpg`, raw = `${base}.orig.${heic ? 'heic' : 'jpg'}`, part = `${base}.part.jpg`
  const clean = () => { for (const f of [raw, part]) try { rmSync(f, { force: true }) } catch {} }
  if (!existsSync(SIPS)) {
    if (heic) return { err: '這台電腦轉不了 HEIC 照片（沒有 sips）：請在手機上改用 JPEG' }
    writeFileSync(part, img); renameSync(part, out); return { path: out }
  }
  if (convRunning >= CONV_MAX && convWait.length >= CONV_QUEUE_MAX) return { err: '照片處理排隊太多，等一下再送' } // 還沒寫檔就先擋
  writeFileSync(raw, img)
  try {
    return (await convSlot(async () => {
      const dim = await runUntil([SIPS, '-g', 'pixelWidth', '-g', 'pixelHeight', raw], deadline)
      if (!dim) return { err: '照片處理太久，沒送出' }
      const nums = [...dim.out.matchAll(/pixel(?:Width|Height):\s*(\d+)/g)].map(m => +m[1])
      if (dim.code !== 0 || nums.length !== 2 || !nums[0] || !nums[1]) return { err: '讀不出這張照片（檔案可能壞了）' }
      if (nums[0] * nums[1] > PHOTO_PIXELS) return { err: '照片像素太多（最多一億）' }
      const big = Math.max(...nums) > PHOTO_EDGE
      if (!heic && !(forCodex && big)) { renameSync(raw, out); return { path: out } } // 不用轉：原檔就是正式檔
      const r = await runUntil([SIPS, '-s', 'format', 'jpeg', '-s', 'formatOptions', '85', ...(big ? ['-Z', String(PHOTO_EDGE)] : []), raw, '--out', part], deadline)
      if (!r) return { err: '照片處理太久，沒送出' }
      if (r.code !== 0 || !existsSync(part) || !isJpeg(new Uint8Array(readFileSync(part).subarray(0, 4)))) return { err: '照片轉成 JPEG 失敗，沒送出' }
      renameSync(part, out)
      return { path: out }
    }, deadline)) ?? { err: '照片處理排隊太久，沒送出（等一下再送）' }
  } finally { clean() }
}
/** 請那位打開照片的那一句：Codex 用 view_image（打不開要說），其他（Claude、agy）照舊用 Read */
export const photoLine = (kind: string | undefined, path: string) => kind === 'codex'
  ? `（手機傳來一張圖片：${path}，請用 view_image 打開來看；打不開就直接回「照片打不開」和原因）`
  : `（手機傳來一張圖片：${path}，請用 Read 打開來看）`
/** 照片的格式檢查（存檔前）：回錯誤訊息或 undefined */
export function photoBad(img: Uint8Array, text: string): string | undefined {
  if (img.length === 0 || img.length > UPLOAD_MAX) return '照片是空的或太大（最多 8 MB）'
  if (!isJpeg(img) && !isHeic(img)) return '只收 JPEG 或 HEIC 照片'
  if (text.trim().length > 3000) return '附照片時文字太長（最多 3000 字）'
  return undefined
}
/**
 * 手機傳照片給一位：收 JPEG 或 HEIC（看檔頭）、≤ 8 MB；檔名由伺服器產生，存 uploads/（辦公室暫存處，7 天清），再傳一句話請那位打開。
 * - Claude、agy：請它用 Read 打開（照舊）
 * - Codex（tmux、App 開的都一樣走 codex queue，2026-11-25 實測兩邊都讀得到 uploads/）：請它用 view_image 打開，打不開直接說；
 *   HEIC 一律先轉 JPEG（Codex 讀不了 HEIC），長邊超過 1600 也縮
 */
export async function sendPhoto(id: string, text: string, img: Uint8Array, now = Date.now()): Promise<Delivery> {
  const bad = photoBad(img, text)
  if (bad) return { state: 'failed', text: bad }
  const t = text.trim()
  const who = crew(now).people.find(c => c.id === id)
  if (!who) return { state: 'failed', text: '這位已經不在線' }
  const base = photoBase(now), msg = `${t ? `${t}\n` : ''}${photoLine(who.kind, `${base}.jpg`)}`
  if (msg.length > 4000) return { state: 'failed', text: '附照片時文字太長' } // 照實際要送的那句驗（存檔前）
  const p = await savePhoto(img, isHeic(img), who.kind === 'codex', base)
  if (!p.path) return { state: 'failed', text: p.err }
  return deliverAsync(id, msg, now)
}
/** 送出照片後手機上顯示的話：只確認排進去了，不說它看到了（審查 photo 次要） */
export const photoSentText = (who?: { kind?: string; name?: string }, d?: Delivery) => who?.kind === 'codex'
  ? `照片已排進 ${who.name || 'Codex'} 的對話，已請它打開來看；打不開會在回覆裡說`
  : `照片已送出，等它接收${d?.note ? `（${d.note}）` : ''}`

/**
 * Codex 的完整對話（0.62.19）：讀 ~/.codex/sessions 的紀錄檔，跟 Claude 一樣分頁（往上滑拿更早、開著時拿新的）。
 * agy 或找不到紀錄檔（別台電腦、CODEX_HOME 不一樣）：退回只顯示最後一則回覆
 */
/**
 * 「正在寫」的畫面整理（0.63.50，GET /live.json）：capture-pane 的文字 → 這一輪（最後一句使用者輸入之後）到輸入框之前的內容，
 * 去掉 TUI 的框線、輸入框、狀態列、轉圈那一行；最多 2000 字（留最後面的）。Claude 的輸入框夾在兩條 ─ 線之間；Codex 的輸入框是最後一個「› 」
 */
export function liveText(screen: string, kind?: string): string | null {
  let lines = screen.replace(/\r/g, '').split('\n').map(l => l.replace(/[│┃║╭╮╰╯]/g, '').replace(/\s+$/, ''))
  if (kind === 'codex') {
    let cut = -1
    for (let i = lines.length - 1; i >= 0; i--) if (/^› /.test(lines[i])) { cut = i; break }
    if (cut >= 0) lines = lines.slice(0, cut)
    let user = -1
    for (let i = lines.length - 1; i >= 0; i--) if (/^› /.test(lines[i])) { user = i; break }
    lines = lines.slice(user + 1).filter(l => !/^\s*• Working \(/.test(l))
  } else {
    const rules: number[] = []
    lines.forEach((l, i) => { if (/^\s*─{10,}/.test(l)) rules.push(i) }) // 輸入框上緣可能帶 session 名稱（「──── 像素工程師B ─」）
    if (rules.length >= 2) lines = lines.slice(0, rules[rules.length - 2])
    else if (rules.length === 1) lines = lines.slice(0, rules[0])
    let user = -1
    for (let i = lines.length - 1; i >= 0; i--) if (/^[❯>] \S/.test(lines[i])) { user = i; break }
    // 轉圈那行（新版沒有符號、結尾「· 3s」）、背景執行提示、Tip
    lines = lines.slice(user + 1).filter(l => !/esc to interrupt|↓ \d+ tokens|· \d+[smh]\s*$|\(\d+[smh] ·|to run in background\)|^\s*⎿\s+Tip:/.test(l))
  }
  const text = lines.join('\n').replace(/^\n+|\n+$/g, '')
  if (!text.trim()) return null
  return text.length > 2000 ? text.slice(text.length - 2000) : text
}
type LiveState = 'writing' | 'tool' | 'approval' | 'waiting' | 'idle'
/** 名冊上的狀態 → live 的 state */
export function liveState(c: { mode?: string; tool?: string; approval?: unknown }): LiveState {
  if (c.approval) return 'approval'
  if (c.mode === 'waiting') return 'waiting'
  if (c.mode === 'thinking' || c.mode === 'typing' || c.mode === 'reading') return c.tool ? 'tool' : 'writing'
  return 'idle'
}
type LiveDeps = { who: (id: string) => { kind?: string; mode?: string; tool?: string; approval?: unknown } | undefined; pane: (id: string, kind?: string) => string | undefined; capture: (pane: string) => Promise<string | undefined> }
const liveSeen = new Map<string, { at: number; v: Promise<Record<string, unknown>> }>()
/**
 * GET /live.json?id=（0.63.50）：同一位 0.7 秒內只擷取一次（多人、多分頁看同一位共用）；只在 writing／tool／approval 時擷取，
 * 沒有 tmux pane 的（App 分頁、App 的 Codex、agy、一般終端機）writing 一律 null。只讀（capture-pane），不送鍵
 */
export function liveOf(id: string, now = Date.now(), deps: LiveDeps = liveDeps): Promise<Record<string, unknown>> {
  const hit = liveSeen.get(id)
  if (hit && now - hit.at < 700) return hit.v
  const v = (async () => {
    const c = deps.who(id)
    if (!c) return { ok: false, text: '這位已經不在線' }
    const state = liveState(c)
    let writing: string | null = null
    if (state === 'writing' || state === 'tool' || state === 'approval') {
      const pane = deps.pane(id, c.kind)
      const screen = pane ? await deps.capture(pane) : undefined
      writing = screen ? liveText(screen, c.kind) : null
    }
    return { ok: true, state, writing, at: now }
  })()
  liveSeen.set(id, { at: now, v })
  if (liveSeen.size > 200) for (const [k, x] of liveSeen) if (now - x.at > 5000) liveSeen.delete(k)
  return v
}
/** 測試用：清快取 */
export const _liveSeen = liveSeen
const liveDeps: LiveDeps = {
  who: id => crew().people.find(c => c.id === id),
  pane: (id, kind) => paneFor(id, kind),
  capture: async pane => { const r = await spawnBounded([Bun.which('tmux') ?? 'tmux', 'capture-pane', '-p', '-J', '-t', pane, '-S', '-120'], 1500); return r.code === 0 ? r.out : undefined },
}

/**
 * 不在線的 Codex（0.63.50：灰卡、人事室「在 App 裡的 Codex」）：只限 codexAway 清單上的，用 thread 找紀錄檔唯讀回傳（readOnly）；
 * 不在清單上的照舊回「不在線」
 */
export function awayChat(id: string, before?: number, after?: number, limit?: number) {
  const a = codexAway(new Set(crew().people.map(p => p.id))).find(x => x.id === id)
  if (!a) return { ok: false, text: '這位已經不在線' }
  const thread = codexThread(id), s = codexSession(id)
  // S-2（0.63.51）：狀態檔裡的 CODEX_HOME 要在家目錄底下（同接回後台）；不合法就不讀
  let home: string | undefined
  if (typeof s?.codexHome === 'string' && s.codexHome) { home = underHome(s.codexHome); if (!home) return { ok: false, text: '這段對話的 CODEX_HOME 不在家目錄底下，不讀' } }
  const f = thread ? codexTranscript(thread, home) : undefined
  if (!f) return { ok: false, text: '對話紀錄讀不到' }
  return { ...pageChat(f, id, before, after, codexLineItems, limit), readOnly: true }
}
export function codexChat(id: string, before?: number, after?: number, limit?: number) {
  const thread = codexThread(id), f = thread ? codexTranscript(thread) : undefined
  if (f) return pageChat(f, id, before, after, codexLineItems, limit)
  const more = before !== undefined || after !== undefined
  const r = lastReply(id)
  const items = more ? [] : [{ k: 'note', text: 'Codex 的完整對話在 Codex 那邊；這裡顯示最後一則回覆，送出的話會排進那個 Codex 對話' }, ...(r ? [{ k: 'ai', text: r.text, at: r.at }] : [])]
  return { ok: true, sid: id, start: 0, end: 2, items }
}

/** POST 內容大小上限：一般 1 MB；照片（/upload、/table-say）＝8 MB 照片的 base64＋附話 */
const BODY_MAX = 1024 * 1024, PHOTO_BODY_MAX = Math.ceil(UPLOAD_MAX * 4 / 3) + 64 * 1024
/** 邊讀邊算：超過上限就停、回 undefined（Content-Length 先看一次） */
export async function readCapped(req: Request, max: number): Promise<string | undefined> {
  const cl = Number(req.headers.get('content-length') ?? NaN)
  if (Number.isFinite(cl) && cl > max) return undefined
  if (!req.body) return ''
  const rd = req.body.getReader(), parts: Uint8Array[] = []
  let n = 0
  for (;;) {
    const { done, value } = await rd.read()
    if (done) break
    n += value.length
    if (n > max) { try { await rd.cancel() } catch {} return undefined }
    parts.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(parts))
}
/** 照片的 base64：只收標準字元（Buffer.from 遇到怪字元會默默跳過），回位元組或 undefined */
export function b64Photo(x: unknown): Uint8Array | undefined {
  if (typeof x !== 'string' || !x || x.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(x)) return undefined
  return Buffer.from(x, 'base64')
}

/** 送命令只收同源的 JSON：跨站表單送不了 application/json，跨站 fetch 會卡在 CORS 預檢 */
export function sameOrigin(req: Request): boolean {
  if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) return false
  const origin = req.headers.get('origin')
  return !origin || origin === new URL(req.url).origin || origin === `https://${req.headers.get('host')}`
}

/** 經 Cloudflare 進來的要求必須帶 Access 驗過的 owner email；本機直連（沒有 cf-ray）放行，方便測試 */
export function allowed(h: Headers, owner: string | undefined): boolean {
  if (!h.get('cf-ray')) return true
  const who = h.get('cf-access-authenticated-user-email')?.toLowerCase()
  return !!owner && who === owner
}
/** owners 名單裡任一位都放行；名單是空的時跟 allowed(h, undefined) 一樣（只放本機） */
export const allowedAny = (h: Headers, owners: string[]) => (owners.length ? owners.some(o => allowed(h, o)) : allowed(h, undefined))

const PAGE = readFileSync(join(import.meta.dir, 'page.html'), 'utf8')
const MANIFEST = JSON.stringify({ name: 'Pixel Office', short_name: 'Office', start_url: '/', display: 'standalone', background_color: '#e4eef6', theme_color: '#3b2412', icons: [
  { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
  { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
  { src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
] })
// 主畫面圖示：Android 不吃 SVG（會退成網址字首），用 build_icon.py 產的 PNG
const PNGS = new Map(['icon-192.png', 'icon-512.png', 'icon-maskable.png'].map(n => [`/${n}`, readFileSync(join(import.meta.dir, n))]))
// 回覆的 Markdown：marked 轉、DOMPurify 過濾（授權見 vendor/LICENSE-*）；只放行這兩個檔
export const VENDOR = new Map(['marked.umd.js', 'purify.min.js'].map(n => [`/vendor/${n}`, readFileSync(join(import.meta.dir, 'vendor', n), 'utf8')]))
// v2 場景：程式與樣式（每次讀現檔，改了重新整理就生效）、美術零件 v2/assets/<名字>.png、manifest.json
const V2 = join(import.meta.dir, 'v2')
const V2_FILES: Record<string, string> = { '/v2/scene.js': 'text/javascript', '/v2/scene.css': 'text/css' }
// 0.63.1：圖片網址帶內容雜湊（?v=），換圖後重新整理就拿新的，沒換的圖放心長期快取（瀏覽器、Cloudflare 都放一年）。
// 每個檔只在大小或修改時間變了才重算雜湊；scene.js（__ASSET_V__ 換成對照表）、scene.css（url 補上 ?v=）傳出前代換，兩者都 no-store
const assetMemo = new Map<string, { k: string, v: string }>()
export function assetVers(): Record<string, string> {
  const dir = join(V2, 'assets'), out: Record<string, string> = {}
  for (const f of readdirSync(dir)) {
    const m = /^([a-z0-9_]+)\.(png|json|webp)$/.exec(f)
    if (!m) continue
    out[m[2] === 'png' ? m[1] : f] = assetVer(f)!
  }
  return out
}
/** 單一素材檔的版本（內容雜湊前 8 碼）；檔案不在回 undefined。大小或修改時間沒變就用記住的 */
export function assetVer(f: string): string | undefined {
  const p = join(V2, 'assets', f)
  let st; try { st = statSync(p) } catch { return undefined }
  const k = `${st.size}-${st.mtimeMs}`
  let e = assetMemo.get(f)
  if (!e || e.k !== k) assetMemo.set(f, e = { k, v: Bun.hash(readFileSync(p)).toString(36).slice(0, 8) })
  return e.v
}
const v2File = (path: string) => {
  const s = readFileSync(join(V2, path.slice(4)), 'utf8'), av = assetVers()
  if (path === '/v2/scene.js') return s.replace("'__ASSET_V__'", JSON.stringify(av))
  return s.replace(/url\(\/v2\/assets\/([a-z0-9_]+)\.png\)/g, (all, n) => av[n] ? `url(/v2/assets/${n}.png?v=${av[n]})` : all)
}
// 首次載入畫面（0.63.46）：page.html 直接寫 /v2/assets/kv_splash_<角色>_sm.webp，傳出前補 ?v=（跟 scene.css 一樣長期快取）。
// 只查頁面裡寫到的這幾張（審查 kv：不對全部素材掃描）；還沒交件的檔不補，載不到就換下一位、都沒有只顯示字
export const pageHtml = (page = PAGE, ver: (f: string) => string | undefined = assetVer) => page.replace(/\/v2\/assets\/(kv_splash_[a-z0-9_]+\.webp)/g, (all, f) => { const v = ver(f); return v ? `${all}?v=${v}` : all })
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#29366f"/><rect x="3" y="8" width="10" height="4" fill="#f4f7fa"/><circle cx="8" cy="5.5" r="2.2" fill="#ffcd75"/></svg>'
const OFFLINE = '這位已經不在線'

const online = (id: string) => crew().people.find(c => c.id === id)

/** 本機金鑰（0.63.56）：第一次用到時讀（不在就產），驗不過就沒有金鑰（本機程式都過不了，手機頁照常），原因寫 log */
const LOCAL_KEY_FILE = join(BASE, 'local-key')
let localKey: { key?: string; tried?: boolean } = {}
function serverKey(): string | undefined {
  if (!localKey.tried) {
    const r = loadLocalKey(LOCAL_KEY_FILE)
    localKey = { tried: true, ...('key' in r ? { key: r.key } : {}) }
    if ('error' in r) console.error(`pixel-office: ${r.error}（${LOCAL_KEY_FILE}）`)
  }
  return localKey.key
}
/**
 * F-5（0.63.56，主管複審後收緊）：不是手機頁（JWT）的招聘只准不會略過允許的模式：Claude 的 default、plan，Codex 的 default、read-only；
 * 沒指定就用 default。要 auto、acceptEdits 等回 403（要使用者在手機上招）。手機頁照舊
 */
const SAFE_PERMS = new Set(['default', 'plan', 'read-only'])
// ---------- 手機叫角色、開專案（設計 windows-hire 4.）：清單由 scripts/cards.py 算（跟團隊視窗的關係圖同一份）----------
// 手機只拿到卡名、說明、分組與代號（卡路徑的雜湊），不拿卡的全文、路徑；/summon 只收這次重算出的清單裡有的代號
const CARDS_PY = join(import.meta.dir, '..', 'scripts', 'cards.py')
export type CardsRun = (args: string[], stdin?: string) => any
let cardsRun: CardsRun = (args, stdin) => {
  const r = Bun.spawnSync([Bun.which('python') ?? Bun.which('py') ?? 'python', '-X', 'utf8', '-I', CARDS_PY, ...args], { stdin: stdin === undefined ? 'ignore' : Buffer.from(stdin), stdout: 'pipe', stderr: 'pipe', timeout: 20000, killSignal: 'SIGKILL' })
  if (r.exitCode !== 0) return
  try { return JSON.parse(r.stdout.toString().trim().split('\n').pop() ?? '') } catch { return }
}
/** 測試換成假的 cards.py（回傳原本的） */
export function _setCardsRun(f: CardsRun): CardsRun { const o = cardsRun; cardsRun = f; return o }
export const cardCode = (file: string) => new Bun.CryptoHasher('sha256').update(file).digest('hex').slice(0, 12)
export type CardPick = { code: string; name: string; desc: string; group: string; file: string; project: string; managers?: string[] }
const pick = (c: any, group: string, project: string, extra: Partial<CardPick> = {}): CardPick | undefined =>
  typeof c?.file === 'string' && typeof c?.name === 'string' ? { code: cardCode(c.file), name: c.name.slice(0, 40), desc: String(c.desc ?? '').slice(0, 80), group, file: c.file, project, ...extra } : undefined
const dedupe = (l: (CardPick | undefined)[]) => { const seen = new Set<string>(); return l.filter((c): c is CardPick => !!c && !seen.has(c.code) && !!seen.add(c.code)) }
/** 被點的人所在專案的第 1 層卡＋小隊（小隊有專案版的卡就用專案版，分組寫「小隊・組名」） */
export function memberCards(id: string): { ok: true; project: string; list: CardPick[] } | { ok: false; text: string } {
  const j = cardsRun(['roster', '--session', id])
  if (!j) return { ok: false, text: '讀不到角色卡（scripts/cards.py 沒有回應）' }
  if (!j.project_dir || !j.from_session) return { ok: false, text: '查不到他在哪個專案（電腦上的 sessions 紀錄找不到他）' }
  const proj = String(j.project_dir)
  const list = [...(j.project ?? []).map((c: any) => pick(c, '專案', proj))]
  for (const sq of j.squads ?? []) {
    if (sq.options?.length) for (const o of sq.options) list.push(...(o.roles ?? []).map((c: any) => pick(c, `${sq.name}${o.lead ? '・' + o.lead : ''}`, proj)))
    else list.push(...(sq.roles ?? []).map((c: any) => pick(c, String(sq.name), proj)))
  }
  return { ok: true, project: basename(proj), list: dedupe(list) }
}
/** 有主管卡的專案：每張主管卡一項，分組＝專案名；在線的主管寫在 managers */
export function projectCards(): { ok: true; list: CardPick[] } | { ok: false; text: string } {
  const j = cardsRun(['projects', '--people-stdin'], JSON.stringify(crew().people.map(p => ({ id: p.id, role: p.role, agent: p.agent, plate: shownName(p) }))))
  if (!j) return { ok: false, text: '讀不到專案（scripts/cards.py 沒有回應）' }
  return { ok: true, list: dedupe((j.projects ?? []).flatMap((p: any) => (p.roles ?? []).map((c: any) => pick(c, String(p.name), String(p.project_dir), p.managers?.length ? { managers: p.managers.map(String) } : {})))) }
}
const pubCards = (l: CardPick[]) => l.map(({ code, name, desc, group, managers }) => ({ code, name, desc, group, ...(managers ? { managers } : {}) }))
const bare = (agent?: string) => (agent ?? '').split(' [')[0]
/** 這個角色名已經有人在線（session 名稱、名牌、職稱）：回那人的名牌 */
export function onlineAs(name: string): string | undefined {
  const k = name.toLowerCase()
  const p = crew().people.find(c => [bare(c.agent), c.name, c.title, shownName(c)].some(x => (x ?? '').toLowerCase() === k))
  return p && shownName(p)
}
/** POST /summon：kind=member（id＝被點的人）或 project；code＝清單上的代號 */
export function summonAt(b: any): { ok: boolean; text: string; sid?: string; need?: string; online?: boolean } {
  const code = String(b?.code ?? '')
  const member = b?.kind === 'member'
  if (!member && b?.kind !== 'project') return { ok: false, text: 'kind 要是 member 或 project' }
  const who = member ? online(String(b?.id ?? '')) : undefined
  if (member && !who) return { ok: false, text: '這位已經不在線' }
  if (who?.kind) return { ok: false, text: '只有 Claude 的對話能叫他的團隊成員' }
  const all = member ? memberCards(who!.id) : projectCards()
  if (!all.ok) return all
  const c = all.list.find(x => x.code === code)
  if (!c) return { ok: false, text: '不在清單上的角色卡' }
  const on = onlineAs(c.name)
  if (on) return { ok: false, online: true, text: `${c.name} 已經在線（${on}）：改傳話給他` }
  const L = cardsRun(['launch', '--card', c.file, '--project', c.project]) ?? {}
  const ready = typeof L.ready === 'string' ? L.ready : undefined
  // 小隊成員：卡上有可用的啟動位置才照卡，否則開在叫的人的資料夾（同團隊視窗 summon_role）；開專案：啟動位置→卡上的退路→專案
  const cwd = member ? (L.has_start && ready) || (profileOf(who!.id) as { cwd?: string }).cwd || c.project : ready || (typeof L.fallback === 'string' ? L.fallback : undefined) || c.project
  if (!cwd) return { ok: false, text: '找不到要開在哪個資料夾' }
  return summonRole({ name: c.name, card: c.file, cwd, team: member ? bare(who!.agent) || shownName(who!) : undefined, manager: !member, b })
}

export function hirePerm(b: any, jwtOk: boolean): { ok: true; b: any } | { ok: false; text: string } {
  if (jwtOk) return { ok: true, b }
  const perm = b?.perm === undefined || b?.perm === null || b?.perm === '' ? 'default' : String(b.perm)
  if (!SAFE_PERMS.has(perm)) return { ok: false, text: '本機程式招聘只能用手動模式（default）；要自動（auto）等會略過允許的模式，請在手機上招' }
  return { ok: true, b: { ...b, perm } }
}
/** 測試埠放行示意 POST 的端點：每一個都確認過帶 demo 只改記憶體裡的示意資料或回一句話（/command、/hire、/fire、/approve 等沒有示意分支，不在裡面） */
const DEMO_POSTS = new Set(['/move', '/tables', '/table-say', '/table-reply', '/table-note', '/table-meet', '/table-meet-end', '/table-boss', '/table-team', '/helper', '/helper-keep', '/handover', '/stuck', '/effort', '/perm', '/codex-handoff'])
/** 測試用：蓋掉金鑰、PO_DEV、tailscale（正式不會設） */
let gatePatch: { key?: string; dev?: boolean; tailscale?: boolean; log?: string; publicHosts?: string[]; anyHost?: boolean } | undefined
export const _setGatePatch = (p: typeof gatePatch) => { gatePatch = p }
type PeerIP = { requestIP?: (r: Request) => { address: string; port: number } | null }
/** 紀錄裡不留金鑰：64 位以上的 hex 換成 … */
export const redactKey = (t: string) => t.replace(/[0-9a-fA-F]{64,}/g, '…')
/** 本機呼叫的來源程序：用 lsof 從 client 的埠找 pid（不是自己的那個），再用 ps 拿執行檔和上一層程序的執行檔。
 *  不記參數：指令列裡會有傳話內容、金鑰（8782 走一遍時發現）；1.5 秒內查不到就算了 */
async function peerProc(req: Request, srv?: PeerIP): Promise<{ pid?: number; exe?: string; parent?: string }> {
  const ip = srv?.requestIP?.(req)
  if (!ip || !ip.port) return {}
  const r = await spawnBounded(['/usr/sbin/lsof', '-nP', `-iTCP:${ip.port}`, '-sTCP:ESTABLISHED', '-Fp'], 1500)
  const pid = r.out.split('\n').filter(l => l.startsWith('p')).map(l => Number(l.slice(1))).find(p => p && p !== process.pid)
  if (!pid) return {}
  const ps = async (p: number) => { const c = await spawnBounded(['/bin/ps', '-o', 'ppid=,comm=', '-p', String(p)], 1500); const m = /^\s*(\d+)\s+(.+)$/.exec(c.out.trim()); return m ? { ppid: Number(m[1]), exe: redactKey(m[2]).slice(0, 200) } : undefined }
  const me = await ps(pid), up = me?.ppid ? await ps(me.ppid) : undefined
  return { pid, ...(me ? { exe: me.exe } : {}), ...(up ? { parent: up.exe } : {}) }
}
/** 存取紀錄（0.63.56 起；0.63.60 改照顧問裁示）：寫入一律記、讀同一組 (via, exe, parent, path) 10 分鐘記一筆（gate.ts accessShouldLog）；
 *  access-log.jsonl（0600），超過 5 MB 換新檔、最多留 3 份；不記內容 */
const accessSeen = new Map<string, number>()
function logAccess(e: Record<string, unknown>) {
  const f = gatePatch?.log ?? join(BASE, 'access-log.jsonl')
  try { rotateLog(f); appendFileSync(f, JSON.stringify(e) + '\n', { mode: 0o600 }); chmodSync(f, 0o600) } catch {}
}
/** /tables 的動作摘要（記進存取紀錄用）：op、桌號、桌名；不記其他內容 */
function tablesBrief(b: any): Record<string, unknown> {
  const op = typeof b?.op === 'string' ? b.op.slice(0, 20) : undefined
  const n = Number(b?.id), id = b?.id !== undefined && b?.id !== null && b?.id !== '' && Number.isInteger(n) ? n : undefined // 跟 editTables 一樣用 +b.id 找桌
  let name: string | undefined
  try { if (id !== undefined) name = office().tables.find(t => t.id === id)?.name } catch {}
  return { ...(op ? { op } : {}), ...(id !== undefined ? { table: id } : {}), ...(name ? { name } : {}) }
}

/**
 * /state.json 的名冊快取（0.63.60，主管派工）：0.64.0 起每個電腦面板 2 秒讀一次，N 個面板一起讀時 1 秒內共用同一份，不每次重算 roster()。
 * 寫入類請求（GET、HEAD 以外）處理前、處理後都讓快取失效，改了座位、桌子、人事之後下一次讀一定是新的。只有 /state.json 用；其他端點照舊直接 roster()
 */
let rosterTtl = 1000
let rosterCache: { at: number; out: ReturnType<typeof roster> } | undefined
export const _setRosterTtl = (ms: number) => { rosterTtl = ms; rosterCache = undefined }
function rosterForState(now = Date.now()) {
  if (rosterCache && now >= rosterCache.at && now - rosterCache.at < rosterTtl) return rosterCache.out
  const out = roster(now)
  rosterCache = { at: now, out }
  return out
}

export async function handle(req: Request, srv?: PeerIP): Promise<Response> {
  const write = req.method !== 'GET' && req.method !== 'HEAD'
  if (write) rosterCache = undefined
  try { return await handleReq(req, srv) } finally { if (write) rosterCache = undefined }
}

async function handleReq(req: Request, srv?: PeerIP): Promise<Response> {
  if (!allowedAny(req.headers, config().owners)) return new Response('forbidden', { status: 403 })
  const url = new URL(req.url)
  const nocache = { 'cache-control': 'no-store' }
  // Host 檢查（0.63.56，F-1）：本機名稱以外的只收 publicHosts 或帶了驗過的 JWT；擋 DNS rebinding（壞網站把自己的網域指到 127.0.0.1）
  const cfg0 = config()
  let jwt: Awaited<ReturnType<typeof phoneAuth>> | undefined
  const host = req.headers.get('host') ?? url.host // Bun 的 req.url 本來就是用 Host 組的；測試直接建的 Request 沒有 Host 標頭
  const local = !!host && [`127.0.0.1:${cfg0.port}`, `localhost:${cfg0.port}`].includes(host.trim().toLowerCase())
  if (!local) {
    jwt = await phoneAuth(req.headers)
    if (!gatePatch?.anyHost && !hostOk(host, cfg0.port, gatePatch?.publicHosts ?? cfg0.publicHosts ?? [], jwt.ok)) {
      const t = `這個網址（${String(host ?? '').slice(0, 80)}）不在允許的主機名單：本機用 127.0.0.1:${cfg0.port}，對外網址要寫進 remote.json 的 publicHosts${!jwt.ok && req.headers.get('cf-access-jwt-assertion') ? `（${jwt.why}）` : ''}`
      return Response.json({ ok: false, error: t, text: t }, { status: 403, headers: nocache })
    }
  }
  // 端點驗證（0.63.56，gate.ts）：只認 JWT／JWT 或本機金鑰／不用驗證
  if (gateClass(req.method, url.pathname) !== 'open') {
    const cfg = cfg0
    jwt ??= await phoneAuth(req.headers)
    const key = keyMatches(req.headers.get('x-po-key'), gatePatch && 'key' in gatePatch ? gatePatch.key : serverKey())
    const dev = gatePatch?.dev ?? devMode(process.env.PO_DEV, cfg.port).dev
    let g = gate(req.method, url.pathname, { jwt: jwt.ok, key }, { dev, tailscale: gatePatch?.tailscale ?? cfg.tailscale === true })
    // 測試埠的示意請求（body 帶 demo）：示意分支只改記憶體裡的示意資料或回一句話，讓 e2e 的示意模式跑得完；真的寫入照樣要金鑰（/approve 連示意都不放）
    if (!g.ok && dev && req.method === 'POST') {
      const peek = await req.clone().json().catch(() => null)
      if (peek && typeof peek === 'object' && peek.demo !== undefined && peek.demo !== null && DEMO_POSTS.has(url.pathname)) g = { ok: true, via: 'dev' }
    }
    // 帶了 JWT 卻驗不過：原因接在後面（簽章不對、過期、不在 owners…），沒帶的不接
    const why = !g.ok && !jwt.ok && req.headers.get('cf-access-jwt-assertion') ? `（${jwt.why}）` : ''
    if (!g.ok) return Response.json({ ok: false, error: g.text + why, text: g.text + why }, { status: g.status, headers: nocache })
    // 存取紀錄（0.63.60）：寫入一律記、讀 10 分鐘去重；測試埠的示意請求（via dev）不記：什麼都沒改，也不該寫進真資料夾的紀錄（安全審看到 e2e 留下的 3 筆）
    if (g.via !== 'dev') {
      const tb = req.method === 'POST' && url.pathname === '/tables' ? tablesBrief(await req.clone().json().catch(() => null)) : {}
      const peer = g.via === 'jwt' ? {} : await peerProc(req, srv)
      if (accessShouldLog(accessSeen, { method: req.method, path: url.pathname, via: g.via, ...peer })) logAccess({ at: Date.now(), method: req.method, path: url.pathname, via: g.via, ...(highRisk(req.method, url.pathname, tb.op) ? { risk: 'high' } : {}), ...tb, ...(jwt.ok && jwt.email ? { email: jwt.email } : {}), ...peer })
    }
  }
  const json = (j: unknown, status = 200) => Response.json(j, { status, headers: nocache })
  const body = async () => (await req.json().catch(() => ({}))) ?? {}
  const num = (k: string) => { const v = url.searchParams.get(k); return v !== null && /^\d+$/.test(v) ? Number(v) : undefined }
  // v2 預覽時期的網址（/v2/、/v2/?demo=12）：預覽已併進來，轉回首頁、參數照帶
  if (url.pathname === '/v2' || url.pathname === '/v2/') return new Response(null, { status: 302, headers: { location: '/' + url.search } })
  if (url.pathname === '/') return new Response(pageHtml(), { headers: { 'content-type': 'text/html; charset=utf-8', ...nocache } })
  if (url.pathname === '/scene.svg') {
    const w = Number(url.searchParams.get('w')) || 64
    const a = Number(url.searchParams.get('a')) || 1.6
    return new Response(sceneSvg(w, Math.max(0.5, Math.min(3, a))), { headers: { 'content-type': 'image/svg+xml', ...nocache } })
  }
  if (url.pathname === '/state.json') {
    const n = url.searchParams.get('demo')
    // 這個請求能不能在手機核准（JWT 驗過的手機頁、access 設好、沒被關）；不能的話每張允許卡寫清楚原因、不給按鈕（0.63.54）
    const auth = jwt ?? (await phoneAuth(req.headers)), offWhy = phoneOffWhy(auth, config())
    const offCards = <T extends { people: any[] }>(r: T, now = Date.now()): T => ({ ...r, people: r.people.map(p => { const info = phoneOffCard(p, offWhy, now); return info === p.approvalInfo ? p : { ...p, approvalInfo: info, caps: p.caps ? { ...p.caps, approve: !!info?.options.length } : p.caps } }) })
    if (n !== null) return json({ ...offCards(demoRoster(Math.max(0, Math.min(400, Math.floor(Number(n)) || 0)))), now: Date.now() })
    if (auth.ok) phoneSeenAt = Date.now() // 手機頁（JWT 驗過）在看：詢問送來手機（A-2）
    const r = rosterForState() // 1 秒快取（0.63.60）
    tickHandovers()
    tickMeetings()
    const ho = handoverView(), mv = meetingView()
    const inMeet = new Set(mv.on.flatMap(m => m.ids))
    return json({
      ...r,
      now: Date.now(), // 伺服器時間（0.63.56）：手機算允許卡倒數用（approvalInfo.deadline − now），不靠手機自己的時鐘
      people: offCards(r).people.map(p => (inMeet.has(p.id) ? { ...p, meeting: true } : p)),
      tables: r.tables.map(t => { const m = mv.on.find(x => x.table === t.id); return { ...t, ...(ho.tables.includes(t.id) ? { handover: true } : {}), ...(m ? { meeting: m.topic, meetingId: m.id } : {}) } }),
      helpers: helperView(Date.now(), r), handovers: ho, meetings: { done: mv.done }, stuck: stuckView(),
      codexHandoffs: codexHandoffs(), codexAway: withPinnedSeat(codexAway(new Set(r.people.map(p => p.id)))), // Codex 交給 App／接回後台（0.63.28）
      ...releaseReserved(r.people.map(p => p.id)),
    })
  }
  // Desktop 面板長什麼樣（hooks/v2panel.ts）：/panel.svg?w=900&h=700，帶 demo=N 用示意資料；只讀
  if (url.pathname === '/panel.svg') {
    const n = url.searchParams.get('demo')
    const j = n !== null ? demoRoster(Math.max(0, Math.min(400, Math.floor(Number(n)) || 0))) : roster()
    const px = Math.max(200, Math.min(3000, Number(url.searchParams.get('w')) || 900))
    const ph = Number(url.searchParams.get('h')) || undefined
    const { svg } = v2PanelSvg(j.people, j.tables, { frame: Math.floor(Date.now() / 250), pxWidth: px, pxHeight: ph })
    return new Response(svg, { headers: { 'content-type': 'image/svg+xml', 'x-svg-length': String(svg.length), ...nocache } })
  }
  const st = V2_FILES[url.pathname]
  if (st) return new Response(v2File(url.pathname), { headers: { 'content-type': `${st}; charset=utf-8`, ...nocache } })
  const asset = /^\/v2\/assets\/([a-z0-9_]+)\.(png|json|webp)$/.exec(url.pathname)
  if (asset) {
    const p = join(V2, 'assets', `${asset[1]}.${asset[2]}`)
    if (!existsSync(p)) return new Response('not found', { status: 404 })
    // 0.62.17：帶 ETag（大小＋修改時間），快取過期後瀏覽器問一聲「改了沒」，沒改回 304，不再整張重抓（7～26 MB）
    const fst = statSync(p), etag = `"${fst.size.toString(36)}-${Math.floor(fst.mtimeMs).toString(36)}"`
    // 網址帶的 v 等於現在內容的雜湊：內容不會再變，放一年；沒帶或對不上（舊頁面）照舊 5 分鐘＋ETag
    const v = url.searchParams.get('v'), cur = v ? assetVers()[asset[2] === 'png' ? asset[1] : `${asset[1]}.${asset[2]}`] : undefined
    const head = { 'cache-control': v && v === cur ? 'public, max-age=31536000, immutable' : 'max-age=300', etag }
    if (req.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: head })
    return new Response(Bun.file(p), { headers: { 'content-type': ({ png: 'image/png', webp: 'image/webp', json: 'application/json' } as Record<string, string>)[asset[2]], ...head } })
  }
  if (req.method === 'POST' && ['/command', '/upload', '/move', '/tables', '/table-say', '/table-reply', '/table-note', '/table-meet', '/table-meet-end', '/handover', '/table-boss', '/table-team', '/helper', '/helper-keep', '/stuck', '/effort', '/perm', '/codex-handoff', '/approve', '/hire', '/summon', '/model', '/key', '/fire', '/staffing', '/schedule'].includes(url.pathname)) {
    if (!sameOrigin(req)) return new Response('forbidden', { status: 403 })
    // 審查 photo ④：讀 body 時就限大小（照片的 base64 約 8 MB×4/3），不先整包解析 JSON 再查
    const photoPath = url.pathname === '/upload' || url.pathname === '/table-say'
    const rawBody = await readCapped(req, photoPath ? PHOTO_BODY_MAX : BODY_MAX)
    if (rawBody === undefined) return json({ ok: false, error: photoPath ? '照片太大（最多 8 MB）' : '送出的資料太大', text: photoPath ? '照片太大（最多 8 MB）' : '送出的資料太大' }, 413)
    let b: any = {}
    try { b = JSON.parse(rawBody) ?? {} } catch {}
    if (typeof b !== 'object') b = {}
    const id = typeof b.id === 'string' ? b.id : ''
    // S-1（0.63.51）：在 App 裡的 Codex 手機只能看：傳話、傳照片都擋（同事間的 codex_office send、整桌傳話不受影響）
    if ((url.pathname === '/command' || url.pathname === '/upload') && appCodex(id)) return json({ ok: false, error: APP_CODEX_TEXT, text: APP_CODEX_TEXT }, 400)
    if (url.pathname === '/command') {
      const d: Delivery = typeof b.text === 'string' && id ? await deliverAsync(id, b.text) : { state: 'failed', text: '送出的資料不對' }
      if (d.state === 'sent') ccBoss([id], b.text.trim())
      if (d.state === 'unsure') ccBoss([id], b.text.trim()) // 可能已經到了：副本照送（跟照片一樣）
      return d.state === 'sent' ? json({ ok: true, ...(d.note ? { text: `已送出（${d.note}）` } : {}) }) // agy 的「下一個動作才看得到」回到手機（複驗 ④）
        : json({ ok: false, ...(d.state === 'unsure' ? { unsure: true } : {}), error: d.text }, d.state === 'unsure' ? 202 : 400) // 逾時＝不確定（第三輪順手）
    }
    if (url.pathname === '/upload') {
      const img = id ? b64Photo(b.data) : undefined
      const d: Delivery = img ? await sendPhoto(id, typeof b.text === 'string' ? b.text : '', img) : { state: 'failed', text: '送出的資料不對' }
      if (d.state !== 'failed') ccBoss([id], `${typeof b.text === 'string' && b.text.trim() ? b.text.trim() + ' ' : ''}（附一張照片）`)
      return d.state === 'sent' ? json({ ok: true, text: photoSentText(crew().people.find(c => c.id === id), d) })
        : json({ ok: false, ...(d.state === 'unsure' ? { unsure: true } : {}), error: d.text }, d.state === 'unsure' ? 202 : 400)
    }
    // 換座位、改協作桌：示意模式（帶 demo）只改記憶體裡的示意座位表
    if (url.pathname === '/move' || url.pathname === '/tables') {
      const demo = b.demo !== undefined && b.demo !== null
      // 示意座位表回到預設（只有示意模式；e2e 每次開頭用，同一個伺服器連跑才不會越拖越少人）
      if (demo && url.pathname === '/tables' && b.op === 'reset') { demoStores.delete(Math.floor(Number(b.demo)) || 0); return json({ ok: true, text: '示意座位表回到預設' }) }
      const S = demo ? demoStore(Math.floor(Number(b.demo)) || 0) : office()
      const online = demo ? undefined : new Set(roster().people.map(p => p.id)) // 「有人坐」看現在誰在線（0.62.18）
      // 刪桌前先留一份（0.63.60，桌 2 消失調查）：刪成功才寫進 office-<port>.deleted.jsonl，誤刪可以照這份還原
      const gone = !demo && url.pathname === '/tables' && b.op === 'delete' ? tableSnapshot(S, +b.id) : undefined
      const r = url.pathname === '/move' ? moveSeat(S, id, String(b.seat ?? ''), online) : editTables(S, b, online)
      if (r.ok && gone) saveDeletedTable(gone)
      if (r.ok && !demo) saveStore(officeFile(), S)
      if (r.ok && !demo && b.op === 'delete') sweepChat(S, Date.now(), true) // 解散協作桌：這桌的聊天紀錄一起清掉（使用者特別交代）
      return json(r)
    }
    if (url.pathname === '/table-say') {
      const demo = b.demo !== undefined && b.demo !== null ? Math.floor(Number(b.demo)) || 0 : undefined
      const img = b.data === undefined ? undefined : b64Photo(b.data)
      if (b.data !== undefined && !img) return json({ ok: false, text: '送出的資料不對', sent: [] })
      return json(await sayToTable(Number(b.table), typeof b.text === 'string' ? b.text : '', demo, Date.now(), img))
    }
    if (url.pathname === '/table-reply') {
      const demo = b.demo !== undefined && b.demo !== null ? Math.floor(Number(b.demo)) || 0 : undefined
      const ids = Array.isArray(b.ids) ? b.ids.filter((x: unknown): x is string => typeof x === 'string').slice(0, 16) : []
      return json(replyAtTable(Number(b.table), ids, typeof b.text === 'string' ? b.text : '', demo))
    }
    if (url.pathname === '/table-team') {
      const demo = b.demo !== undefined && b.demo !== null ? Math.floor(Number(b.demo)) || 0 : undefined
      const table = b.table // 只收 JSON 數字（true、[1]、"1" 都不算；複驗第 1 列）
      if (typeof table !== 'number' || !Number.isInteger(table) || table <= 0) return json({ ok: false, text: '桌號不對' }, 400)
      if (b.op === 'preview') return json(tableTeamPreview(table, demo))
      if (b.op === 'go') return json(await tableTeamUp(table, typeof b.ver === 'string' ? b.ver : '', demo))
      return json({ ok: false, text: '不認得的動作（只收 preview、go）' }, 400)
    }
    if (url.pathname === '/table-boss') {
      const demo = b.demo !== undefined && b.demo !== null ? Math.floor(Number(b.demo)) || 0 : undefined
      return json(promoteAtTable(Number(b.table), id, demo))
    }
    // 自動多開幫手（第 13 項）：使用者答覆主管的請求、留著快被關的幫手；示意模式什麼都不做
    // 0.63.4 新員工卡在確認畫面：使用者在手機卡片上點選項（只接受正卡住的紀錄、卡片上列出的選項；hr.ts pressStuck）
    if (url.pathname === '/stuck') {
      if (b.demo !== undefined && b.demo !== null) return json({ ok: true, text: `（示意）會替他按「${String(b.label ?? b.opt ?? '')}」` })
      return json(await pressStuck(String(b.id ?? ''), String(b.opt ?? '')))
    }
    if (url.pathname === '/helper' || url.pathname === '/helper-keep') {
      if (b.demo !== undefined && b.demo !== null) return json({ ok: true, text: url.pathname === '/helper' ? `（示意）${b.op === 'yes' ? (b.ask === 'demo-ask-art' ? '會開一位 Codex 生圖幫手' : '會開一位幫手') : '不加幫手'}` : '（示意）留著' })
      return json(url.pathname === '/helper' ? answerAsk(String(b.ask ?? ''), b.op === 'yes') : keepHelper(String(b.sid ?? '')))
    }
    if (url.pathname === '/table-meet' || url.pathname === '/table-meet-end') {
      if (b.demo !== undefined && b.demo !== null) return json({ ok: true, text: url.pathname === '/table-meet' ? `（示意）會開會：${String(b.topic ?? '')}` : '（示意）結束會議' })
      if (url.pathname === '/table-meet-end') return json(endMeeting(String(b.id ?? '')))
      return json(meetAtTable(Number(b.table), String(b.topic ?? ''), Array.isArray(b.ids) ? b.ids.filter((x: unknown): x is string => typeof x === 'string') : []))
    }
    if (url.pathname === '/table-note') {
      const demo = b.demo !== undefined && b.demo !== null ? Math.floor(Number(b.demo)) || 0 : undefined
      return json(noteToTable(Number(b.table), typeof b.text === 'string' ? b.text : '', demo))
    }
    if (url.pathname === '/handover') {
      if (b.demo !== undefined && b.demo !== null) return json({ ok: true, text: `（示意）${b.op === 'wait' ? '再等 5 分鐘' : b.op === 'cancel' ? '不換' : '直接換'}` })
      return json(answerHandover(String(b.ask ?? ''), String(b.op ?? '')))
    }
    if (url.pathname === '/hire') {
      // 招 Codex（0.62.20）：先只能當員工（Codex 的 office_profile 改不了身分）
      if (b.agent === 'codex' && b.role === 'manager') return json({ ok: false, text: '主管只能是 Claude（使用者 2026-11-24 決定）；Codex 可以當員工或行政' })
      // F-5（0.63.56）：不是手機頁（JWT）招的，沒指定模式就用手動（default）；要 auto 得明講。手機頁照舊預設 auto
      const hp = hirePerm(b, !!jwt?.ok)
      if (!hp.ok) return json({ ok: false, error: hp.text, text: hp.text }, 403)
      b = hp.b
      if (b.agent !== 'codex') return json(hireAt(b, Date.now(), hire))
      if (process.platform === 'win32') return json({ ok: false, text: CODEX_WIN_TEXT })
      // Codex 一開就結束（設定檔壞了、沒登入…）要回失敗，附畫面最後幾行和結束碼（0.63.56）
      let cxp: string | undefined
      const r = hireAt(b, Date.now(), (bb, o) => { const x = hireCodex(bb, { ...o, hold: true }); cxp = x.sid; return x })
      if (!r.ok || !cxp) return json(r)
      const st = await codexStarted(`po-${cxp}`)
      return json(st.ok ? r : { ok: false, text: st.text })
    }
    // 手機叫角色、開專案（設計 windows-hire 4.）：門檻同招聘（手機預設 auto、本機程式預設手動）
    if (url.pathname === '/summon') {
      const hp = hirePerm(b, !!jwt?.ok)
      if (!hp.ok) return json({ ok: false, error: hp.text, text: hp.text }, 403)
      const r = summonAt(hp.b)
      return json(r, r.ok || r.need || r.online ? 200 : 400)
    }
    if (url.pathname === '/schedule' && (b.op !== 'add' || (b.table !== undefined && b.table !== null && b.table !== ''))) return json(editShift(b))
    // 辦公室裡按允許（0.63.51）：只有手機頁（Cloudflare Access 的使用者）能按
    if (url.pathname === '/approve') {
      if (b.demo !== undefined && b.demo !== null) return json({ ok: true, text: b.key === 'allow' ? '（示意）會允許這一次' : '（示意）會拒絕' })
      const auth = await phoneAuth(req.headers)
      if (!auth.ok) return json({ ok: false, text: `只能從手機頁按（${auth.why}）` }, 403) // A-1：只認 Access 的 JWT
      return json(await approveAt(b))
    }
    // Codex 交給 App／接回後台（0.63.28）：接回的人可能不在名冊上（已經在 App 關掉），所以放在「在不在線」之前
    if (url.pathname === '/codex-handoff') {
      if (b.to !== 'app' && b.to !== 'tmux') return json({ ok: false, text: 'to 要是 app 或 tmux' }) // 審查第 13 項：不認得的不預設成交給 App
      const to = b.to
      if (b.demo !== undefined && b.demo !== null) return json({ ok: true, text: to === 'app' ? '（示意）會讓他收尾、交給 App' : '（示意）會在電腦背景接回他' })
      if (!/^codex-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return json({ ok: false, text: '只有 Codex 能交給 App／接回後台' })
      const j = roster()
      const me2 = j.people.find(p => p.id === id)
      // 不在線（已經在 App 關掉）就用釘住的座位找桌（審查第 8 項）
      const seat0 = me2?.seat ?? office().pins[id]
      const t = seat0 ? /^t(\d+)\./.exec(seat0) : null
      const boss = t ? j.people.find(p => p.role === 'manager' && p.seat?.startsWith(`t${t[1]}.`)) : undefined
      const addDirs = t ? [notesDir(+t[1], boss?.id)] : undefined
      if (to === 'app') {
        const r = await withPane(id, () => codexToApp(id, { interrupt: b.interrupt === true, addDirs }))
        // 座位留著：釘住並保留（審查第 4 項：只在期間沒被使用者移過時才改釘選）
        if (r.ok && me2?.seat) {
          const S = office()
          if (!S.pins[id]) pinSeat(S, id, me2.seat, 'hire') // 系統替他保留：記 hire；本來就釘在這裡的照舊（0.63.58）
          S.reserved = { ...(S.reserved ?? {}), [id]: S.pins[id] }
          try { saveStore(officeFile(), S) } catch {}
        }
        return json(r)
      }
      const r = await withPane(id, () => codexToTmux(id, { addDirs }))
      if (r.ok) { const S = office(); if (S.reserved?.[id]) { delete S.reserved[id]; try { saveStore(officeFile(), S) } catch {} } }
      return json(r)
    }
    // 示意的人不在真名冊：示意回應放在「在不在線」之前（0.63.19，像素工程師與複驗回報）
    if ((url.pathname === '/effort' || url.pathname === '/perm') && b.demo !== undefined && b.demo !== null) return json({ ok: true, text: `（示意）會換成 ${String((url.pathname === '/effort' ? b.effort : b.perm) ?? '')}` })
    const who = online(id)
    if (!who) return json({ ok: false, text: '這位已經不在線' })
    if (url.pathname === '/staffing') return json(staffing(id, b))
    // 投入程度＋模式（0.63.9）：Claude 走 setEffort／setPerm；tmux 開的 Codex 走 codexEffort／codexPerm；agy 不能
    if (url.pathname === '/effort' || url.pathname === '/perm') {
      const v = String((url.pathname === '/effort' ? b.effort : b.perm) ?? '')
      if (b.demo !== undefined && b.demo !== null) return json({ ok: true, text: `（示意）會換成 ${v}` })
      const kind = crew().people.find(c => c.id === id)?.kind
      if (kind === 'agy') return json({ ok: false, text: 'agy 不能從手機換' })
      // 同一位一次只做一件事（複驗第 11 項）
      if (kind === 'codex') return json(await withPane(id, () => (url.pathname === '/effort' ? codexEffort(id, v) : codexPerm(id, v))))
      return json(await withPane(id, () => (url.pathname === '/effort' ? setEffort(id, v) : setPerm(id, v))))
    }
    if (url.pathname === '/schedule') return json(editShift(b))
    // 開在 tmux 的 Codex（手機招的）：換智力／打斷／解雇走 tmux（0.62.20）；開在 App 裡的照舊擋，回覆說明原因
    if (who.kind === 'codex') {
      if (url.pathname === '/model') return json(await withPane(id, () => codexModel(id, String(b.model ?? ''))))
      if (url.pathname === '/key') return json(await withPane(id, () => codexKey(id, String(b.key ?? ''))))
      // 解雇跟交接同一把鎖，交接中不能解雇（審查第 12 項）
      if (settlePending(id)?.state === 'pending') return json({ ok: false, text: '他正在交給 App，等交接完再處理' })
      const fr = await withPane(id, () => codexFire(id))
      if (fr.ok) unseat(id)
      return json(fr)
    }
    if (who.kind) return json({ ok: false, text: 'agy 不能從這裡換智力、打斷或解雇' })
    if (url.pathname === '/model') return json(await withPane(id, () => setModel(id, String(b.model ?? ''))))
    if (url.pathname === '/key') return json(await withPane(id, () => pressKey(id, String(b.key ?? ''))))
    const fr = b.keep === true ? await closeSession(id) : await fire(id) // keep＝關掉（可 --resume，設計 windows-hire 6.）
    if (fr.ok) unseat(id)
    return json(fr)
  }
  if (url.pathname === '/meeting.json') {
    if (url.searchParams.get('demo') !== null) return json({ ok: true, topic: '（示意）本週計畫', label: '示意桌', text: '# （示意）本週計畫：方案\n- 參與：主管、員工 A、員工 B\n\n## 整合\n（示意）先做報價，週五交。\n\n## 待你決定\n（示意）要不要含運費' })
    return json(meetingResult(url.searchParams.get('id') ?? ''))
  }
  if (url.pathname === '/table-notes.json') {
    const n = url.searchParams.get('demo'), t = Number(url.searchParams.get('table'))
    return json(n !== null ? demoNotes(Math.max(0, Math.min(400, Math.floor(Number(n)) || 0)), t) : tableNotes(t))
  }
  if (url.pathname === '/table-chat.json') {
    const n = url.searchParams.get('demo'), t = Number(url.searchParams.get('table'))
    return json(n !== null ? demoChatOf(Math.max(0, Math.min(400, Math.floor(Number(n)) || 0)), t) : tableChat(t))
  }
  if (url.pathname === '/cards.json') {
    const who = online(url.searchParams.get('id') ?? '')
    if (!who) return json({ ok: false, text: '這位已經不在線' })
    if (who.kind) return json({ ok: false, text: '只有 Claude 的對話能叫他的團隊成員' })
    const r = memberCards(who.id)
    return json(r.ok ? { ok: true, project: r.project, cards: pubCards(r.list) } : r)
  }
  if (url.pathname === '/projects.json') {
    const r = projectCards()
    return json(r.ok ? { ok: true, cards: pubCards(r.list) } : r)
  }
  if (url.pathname === '/profile.json') {
    const who = online(url.searchParams.get('id') ?? '')
    return json(!who ? { ok: false, text: '這位已經不在線' } : who.kind ? { ok: false, text: '只有 Claude 的對話有員工檔案' } : profileOf(who.id))
  }
  if (url.pathname === '/live.json') return json(await liveOf(url.searchParams.get('id') ?? ''))
  // 外掛問的（0.63.53）：手機（JWT 驗過）有沒有在看；手機按的決定（只回伺服器自己記下的）
  if (url.pathname === '/phone-live') return json(phoneLive())
  if (url.pathname === '/approve-result') return json(approveResult(url.searchParams))
  if (url.pathname === '/chat.json') {
    const id = url.searchParams.get('id') ?? ''
    const who = online(id)
    if (!who) return json(awayChat(id, num('before'), num('after'), num('limit')))
    if (who.kind) return json({ ...codexChat(who.id, num('before'), num('after'), num('limit')), ...(appCodex(who.id) ? { readOnly: true } : {}) }) // S-1
    return json(chatOf(who.id, num('before'), num('after'), num('limit')))
  }
  if (url.pathname === '/manifest.webmanifest') return new Response(MANIFEST, { headers: { 'content-type': 'application/manifest+json' } })
  const png = PNGS.get(url.pathname)
  if (png) return new Response(png, { headers: { 'content-type': 'image/png', 'cache-control': 'max-age=86400' } })
  const js = VENDOR.get(url.pathname)
  if (js) return new Response(js, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'max-age=86400' } })
  if (url.pathname === '/icon.svg') return new Response(ICON, { headers: { 'content-type': 'image/svg+xml' } })
  return new Response('not found', { status: 404 })
}

/** 幫手的正式接線（0.63.38，生圖幫手審查第 6 項：Codex 幫手不走 Claude 的 fire，走 closeCodexHelper；匯出給接線測試） */
export const helperDeps: HelperDeps = {
  base: BASE,
  port: () => config().port,
  office: () => roster(),
  hire,
  fire,
  hireCodex,
  launchOwner,
  launchState,
  closeCodex: closeCodexHelper,
  sendCommand: (id, text) => sendCommand(id, text),
  tableDir: (table, bossId) => notesDir(table, bossId),
}
initHelpers(helperDeps)

initMeetings({
  base: BASE,
  port: () => config().port,
  office: () => ({ people: crew().people }),
  sendCommand: (id, text) => sendCommand(id, text),
})

initHandover({
  base: BASE,
  port: () => config().port,
  office: () => ({ people: crew().people }),
  sendCommand: (id, text) => sendCommand(id, text),
  swap: h => swapBoss(h),
  chat: table => tableChat(table).items,
  lastReply,
})

initHr({
  base: BASE,
  hireConfigDir: () => config().configDirs?.[0],
  hireDirs: () => config().hireDirs,
  people: () => crew().people,
  sendCommand,
  port: () => config().port,
  tableName: table => { const t = office().tables.find(x => x.id === table); return t ? t.name : undefined },
  tableRun: (table, action, text, now) => runTableShift(table, action, text, now),
})

if (import.meta.main) {
  const cfg = config()
  startShiftClock()
  startHelperClock()
  sweepUploads(); setInterval(() => sweepUploads(), 3600e3) // 照片 7 天清：定時（審查 photo 次要；原本只在下一次傳照片時才掃）
  resetAppTabs(appTabsFile()) // 關分頁解雇：停機那段沒看著，累積從零算（0.63.27）
  setInterval(() => { try { tickHandovers(); tickMeetings() } catch {} }, 30e3)
  // 面板唯讀的共用筆記快照：每分鐘替每張協作桌更新一次
  setInterval(() => { try { for (const t of office().tables) tableNotes(t.id) } catch {} }, 60e3)
  // Codex 傳話的待記（0.63.12，審查第 4 項）：沒人開手機也每 5 秒記一次，座位照送出後幾秒內的；roster() 裡會 drain
  // 招聘 Codex 的令也一樣（複驗第 2 項：原本只在有人開手機時對到 codex-<thread>）
  setInterval(() => { try { if (readdirSync(OUTBOX).some(f => f.endsWith('.json') && !outboxSeen?.has(f))) roster() } catch {} }, 5e3)
  setInterval(() => { try { if (readdirSync(ORDERS).some(f => f.startsWith('cxp-'))) roster() } catch {} }, 15e3)
  // 關分頁解雇：有人正在等 10 分鐘時，沒人開手機也照樣算（0.63.24）
  setInterval(() => { try { if (Object.values(loadTabs(appTabsFile())).some(t => t.gone)) roster() } catch {} }, 60e3)
  const dm = devMode(process.env.PO_DEV, cfg.port)
  if (dm.ignored) console.error(`pixel-office: PO_DEV=1 只在測試埠 8781／8782 生效，${cfg.port} 不理`)
  serverKey()
  Bun.serve({ hostname: '127.0.0.1', port: cfg.port, fetch: (req, server) => handle(req, server) })
  console.log(`pixel-office remote (${process.env.PO_CONFIG || 'remote.json'}): http://127.0.0.1:${cfg.port}  owners=${cfg.owners.join(',') || '(not set: requests via Cloudflare all get 403)'}  configDirs=${cfg.configDirs?.join(',') ?? '(all)'}`)
}
