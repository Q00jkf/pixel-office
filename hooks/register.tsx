import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Coworker, CustomButton, ErrandKind, OfficeMode, Role } from '../types'
import { NOTICE_FRAMES, PLANE_FRAMES, SVG_MAX, TREAT_FRAMES, assignSeats, drawScene, encode, encodeSvg, errandRoute, plateName, route, sceneRows, sceneWidth, walkerPos } from './scene'
import type { Notice, Placement, Plane, SceneOptions, Walker } from './scene'

const PANE = 'pixel-office'
const STALE_MS = 20000 // 超過這麼久沒心跳 = 視窗已關
const DEAD_RECHECK_MS = 60000 // 已關的 session 檔，每分鐘才再讀一次
const dead = new Map<string, number>() // 檔名 → 上次確認已關的時間
const crew = atom({ plugin: 'pixel-office', key: 'crew' } as const, [] as Coworker[])
const night = atom({ plugin: 'pixel-office', key: 'night' } as const, false)
const buttons = atom({ plugin: 'pixel-office', key: 'buttons' } as const, [] as CustomButton[])
const instanceRef = atom({ plugin: 'pixel-office', key: 'instance' } as const, '')
const READING = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'ToolSearch', 'NotebookRead'])

// 模組變數只給動畫與心跳用；熱重載會重跑 session.start 補回
let frame = 0
let width = 0
let rows = 0
let seq = 0
let dir = ''
let lastCrew = ''
let me: Coworker = { id: 'me', name: 'me', mode: 'idle', tool: '', isMe: true, role: 'staff' }
let others: Coworker[] = []
let walkers: Walker[] = []
let nightMode = false
let svgOpen = false // Desktop 等用 Svg 畫的面板開著時，計時器要定期請它重畫
let rasterOpen = false // 終端 Raster 面板開著時才 blit；width／rows 是兩種介面共用的版面，不再拿來當開關
let treatFrame: number | undefined
let catOffset = 0
let planes: Plane[] = []
let permissionMode = ''
let instance = '' // 這個視窗（程序）的實例代碼：撞號偵測用
let lastWriteAt = 0
let collisionWarned = false
let defaultName = 'me' // 預設名牌（初始值同 me.name，session.start 改成資料夾推出的值）；名牌仍是它時才自動改
let notices: Notice[] = []
// 每位同事上一次看到的送信／收信時間與狀態；第一次看到只記錄、不觸發（避免開面板時重播舊事件）
const seenSent = new Map<string, number | undefined>()
const seenGot = new Map<string, number | undefined>()
const seenMode = new Map<string, OfficeMode>()
const seenBlocked = new Map<string, number | undefined>()
const seenErrand = new Map<string, number | undefined>()

const sceneOpts = (): SceneOptions => {
  planes = planes.filter(pl => frame - pl.start <= PLANE_FRAMES)
  notices = notices.filter(n => frame < n.end)
  return { night: nightMode, treatFrame, catOffset, planes, notices }
}

// 餵貓：把上一次吃飯停下的時間併進位移，再開始新的一次
function feedCat() {
  if (treatFrame !== undefined) catOffset += Math.min(TREAT_FRAMES, frame - treatFrame)
  treatFrame = frame
}
let lastPlaced: Map<string, Placement> | null = null

// 角色變了（員工↔主管）就排一段走路動畫：從舊座位沿走道走到新座位
function trackMoves(list: Coworker[]) {
  if (width === 0 || rows === 0) return
  const now = assignSeats(list, width, rows, lastPlaced ?? undefined)
  if (lastPlaced) {
    for (const [id, pl] of now) {
      const old = lastPlaced.get(id)
      if (old && (old.kind !== pl.kind || old.slot !== pl.slot)) {
        walkers = walkers.filter(w => w.id !== id)
        walkers.push({ id, path: route(old, pl, width, rows), start: frame })
      }
    }
  }
  lastPlaced = now
}

function liveWalkers(): Walker[] {
  walkers = walkers.filter(w => walkerPos(w, frame) !== null)
  return walkers
}

const everyone = (): Coworker[] => [me, ...others].sort((a, b) => a.id.localeCompare(b.id))

async function sharedDir($: EngineInterface): Promise<string> {
  if (dir === '') {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
    dir = `${home.replace(/\\/g, '/')}/.claude/pixel-office/sessions`
  }
  return dir
}

/** 這次成功的工具呼叫算不算對外動作：寄信、上傳文件、推 git */
export function detectErrand(tool: string, input: unknown): ErrandKind | undefined {
  const t = tool.toLowerCase()
  if (/gmail|mail/.test(t) && /(send|reply|forward|draft)/.test(t)) return 'mail'
  if (/(google_?drive|notion)/.test(t) && /(create|update|upload|copy|move|duplicate)/.test(t)) return 'file'
  if (t === 'bash' || t === 'powershell') {
    const cmd = String((input as { command?: unknown })?.command ?? '')
    if (/\bgit\b[^\n|;&]*\bpush\b/.test(cmd)) return 'push'
  }
  return undefined
}

/** 工具結果是不是被 auto 模式分類器擋下（訊息含「auto mode classifier」） */
export function classifierBlocked(ran: { deny?: string; isError?: boolean; text?: string }): boolean {
  const msg = ran.deny ?? (ran.isError ? ran.text ?? '' : '')
  return /auto mode classifier/i.test(msg)
}

/**
 * 撞號：自己的狀態檔最近被「另一個實例」寫過（兩個視窗共用同一個 session 編號，常見於 --resume 接到同一段對話）。
 * 不算撞號：檔案沒有 instance（舊版寫的）、已標記離開、太久沒更新、或就是自己寫的。
 */
function warnCollision($: EngineInterface) {
  if (collisionWarned) return
  collisionWarned = true
  $.ui.toast(`⚠ 另一個視窗和這個視窗共用同一個 session 編號（${me.id.slice(0, 8)}），辦公室資料會互相覆蓋：請關掉其中一個，用 claude --resume 選不同的對話重開`)
}

export function isCollision(own: { instance?: string; updatedAt?: number; left?: boolean } | undefined, mine: string, now: number, staleMs = 20000): boolean {
  if (!own || !own.instance || own.instance === mine || own.left) return false
  return typeof own.updatedAt === 'number' && now - own.updatedAt < staleMs
}

/** 從 ListAgents 名稱推名牌：取最後一段（llm-wiki-aegiverse-55 → 55），只留英數字；推不出來回 undefined */
export function plateFromAgent(agent: string): string | undefined {
  const ascii = agent.replace(/[^\x21-\x7e]/g, ' ').trim()
  const last = ascii.split(/[\s-]+/).filter(Boolean).pop() ?? ''
  return validName(last) ? last : undefined
}

/** 從 ListAgents 的輸出抓自己的名稱（「This session is X [ref]」） */
export function selfFromListAgents(text: string): string | undefined {
  const m = text.match(/This session is (.+?) \[[0-9a-f]+\]/)
  return m ? m[1].trim() : undefined
}

const MAX_BUTTONS = 6

/** 檢查設定檔的按鈕：label 1～12 字；url 只收 http(s)；prompt 1～2000 字；最多 6 顆 */
export function parseButtons(raw: unknown): CustomButton[] {
  if (!Array.isArray(raw)) return []
  const out: CustomButton[] = []
  for (const b of raw) {
    if (!b || typeof b !== 'object') continue
    const label = typeof b.label === 'string' ? b.label.trim() : ''
    if (label.length === 0 || label.length > 12) continue
    if (typeof b.url === 'string' && /^https?:\/\//i.test(b.url)) out.push({ label, url: b.url })
    else if (typeof b.prompt === 'string' && b.prompt.trim().length > 0 && b.prompt.length <= 2000) out.push({ label, prompt: b.prompt.trim() })
    if (out.length >= MAX_BUTTONS) break
  }
  return out
}

let lastButtons = ''
// 內容沒變就不寫 state（避免每次自動重讀都觸發重畫）
async function setButtons($: EngineInterface, list: CustomButton[]) {
  const json = JSON.stringify(list)
  if (json === lastButtons) return
  lastButtons = json
  await update($, buttons, () => list)
}

async function loadButtons($: EngineInterface): Promise<CustomButton[]> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
  const path = `${home.replace(/\\/g, '/')}/.claude/pixel-office/buttons.json`
  try {
    const raw = await $.fs.read(path)
    const list = parseButtons(JSON.parse(typeof raw === 'string' ? raw : '[]'))
    await setButtons($, list)
    return list
  } catch {
    await setButtons($, [])
    return []
  }
}

/** 按下個人按鈕：/ 開頭先當 slash 指令執行，不行再當使用者輸入送出；其他文字直接當使用者輸入 */
async function runButton($: EngineInterface, b: CustomButton) {
  if (!b.prompt) return
  const text = b.prompt
  if (text.startsWith('/')) {
    const [name, ...rest] = text.slice(1).split(/\s+/)
    try {
      await $.command.run({ command: name, args: rest.join(' ') } as never)
      return
    } catch {}
  }
  await $.prompt.submit({ text, asUser: true })
}

/** 讀自己上一次寫的狀態檔（重載後找回名牌、職稱、agent） */
/** 會跨熱重載保存的個人設定；新增欄位只要加在這裡和 PROFILE_KEYS */
export type Profile = { role?: Role; name?: string; agent?: string; title?: string; auto?: boolean; team?: string }
const PROFILE_KEYS = ['role', 'name', 'agent', 'title', 'auto', 'team'] as const

/** 合併兩份設定：$.store 有值就用它的，沒有才用狀態檔的。逐欄通用處理，新增欄位不會被漏掉 */
export function mergeProfile(saved: Profile | undefined, own: Profile | undefined): Profile | undefined {
  if (!saved && !own) return undefined
  const out: Record<string, unknown> = {}
  for (const k of PROFILE_KEYS) out[k] = saved?.[k] ?? own?.[k]
  return out as Profile
}

async function readOwnStatus($: EngineInterface, id: string): Promise<(Profile & { instance?: string; updatedAt?: number; left?: boolean }) | undefined> {
  try {
    const raw = await $.fs.read(`${await sharedDir($)}/${id}.json`)
    const s = JSON.parse(typeof raw === 'string' ? raw : '{}')
    const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined)
    return { role: s.role === 'manager' || s.role === 'staff' ? s.role : undefined, name: str(s.name), agent: str(s.agent), title: str(s.title), auto: s.auto === true ? true : undefined, team: str(s.team), instance: str(s.instance), updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : undefined, left: s.left === true }
  } catch {
    return undefined
  }
}

// 把自己的狀態寫到共用資料夾：一個 session 一個檔，不會互相覆蓋
async function publish($: EngineInterface, left: boolean) {
  const d = await sharedDir($)
  const updatedAt = await $.clock.now()
  lastWriteAt = updatedAt
  await $.fs.write(`${d}/${me.id}.json`, JSON.stringify({ instance, id: me.id, name: me.name, role: me.role, mode: me.mode, tool: me.tool, agent: me.agent, title: me.title, auto: me.auto, team: me.team, blocked: me.blocked, errand: me.errand, sentTo: me.sentTo, sentAt: me.sentAt, gotAt: me.gotAt, updatedAt, left }))
}

async function showCrew($: EngineInterface) {
  const list = everyone()
  const json = JSON.stringify(list)
  if (json === lastCrew) return
  lastCrew = json
  trackMoves(list)
  trackEvents($, list)
  await update($, crew, () => list)
}

const MODE_LABEL: Record<OfficeMode, string> = {
  idle: '閒置',
  thinking: '思考中',
  typing: '打字中',
  reading: '讀檔中',
  error: '出錯',
  done: '剛完成',
  waiting: '等待核准權限',
  blocked: '被權限擋下',
}

/** 辦公室名單（/office who 與 office_roster 共用）：主管在前，其餘依名牌 */
export function roster(list: Coworker[], now: number): string {
  if (list.length === 0) return '辦公室目前沒有人。'
  const sorted = [...list].sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'manager' ? -1 : 1))
  const rows = sorted.map(c => {
    const doing = c.blocked
      ? `🔴 被擋（${c.blocked.tool}），已等 ${Math.max(0, Math.round((now - c.blocked.at) / 60000))} 分，要使用者在它的視窗說「放行」`
      : c.mode === 'typing' || c.mode === 'reading' || c.mode === 'waiting'
        ? `${MODE_LABEL[c.mode]}（${c.tool}）`
        : MODE_LABEL[c.mode] ?? c.mode
    const agent = c.agent ?? '（未登記，傳訊息找不到）'
    return `| ${c.isMe ? '▶ ' : ''}${c.name} | ${c.title ?? '—'} | ${c.role === 'manager' ? '主管' : '員工'}${c.auto ? '（auto）' : ''}${c.team ? `・屬 ${c.team}` : ''} | ${agent} | ${doing} |`
  })
  const blockedNames = sorted.filter(c => c.blocked).map(c => c.name)
  const head = [
    `像素辦公室名單（${list.length} 人在線，${new Date(now).toISOString().slice(11, 19)} UTC）`,
    ...(blockedNames.length > 0 ? [`🔴 待放行：${blockedNames.join('、')}（要使用者在各自的視窗說「放行」，別的 session 轉達無效）`] : []),
    '| 名牌 | 職稱 | 角色 | ListAgents 名稱（SendMessage 用） | 目前 |',
    '|---|---|---|---|---|',
  ]
  return [...head, ...rows].join('\n')
}

/** 只有真正的呼叫（有 tool_use_id）且判定為 ask 才算等待核准；$.tool.check 這類查詢不算 */
const NO_HUMAN_MODES = new Set(['auto', 'bypassPermissions', 'dontAsk']) // 這些模式下的 ask 不會等人按

export function waitsForApproval(decision: string, toolUseId: string | undefined, mode = ''): boolean {
  return decision === 'ask' && toolUseId !== undefined && !NO_HUMAN_MODES.has(mode)
}

/** 收件者名稱 → 辦公室裡的人：比對大家登記的 agent（ListAgents 名稱） */
export function findRecipient(list: Coworker[], to: string): Coworker | undefined {
  const want = to.trim().replace(/\s*\[[0-9a-f]+\]$/i, '') // 去掉可能附帶的 [ref]
  return list.find(c => c.agent !== undefined && c.agent === want)
}

// 送信 → 紙飛機＋收件者信封；只收到（寄件者不在辦公室）→ 只有信封；有人開始等核准 → toast
function trackEvents($: EngineInterface, list: Coworker[]) {
  for (const c of list) {
    if (seenSent.has(c.id) && c.sentAt !== undefined && c.sentAt !== seenSent.get(c.id) && c.sentTo) {
      const target = findRecipient(list, c.sentTo)
      const from = lastPlaced?.get(c.id)
      const to = target ? lastPlaced?.get(target.id) : undefined
      if (target && from && to) {
        planes.push({ from: from.stand, to: to.stand, start: frame })
        // 收件端的「收到」若先被讀到、已亮過信封，就收掉，等飛機到了再亮（避免亮兩次）
        notices = notices.filter(n => !(n.id === target.id && frame - n.start < NOTICE_FRAMES))
        notices.push({ id: target.id, start: frame + PLANE_FRAMES, end: frame + PLANE_FRAMES + NOTICE_FRAMES })
        seenGot.set(target.id, target.gotAt) // 這封信已用飛機表現，收件端不再另外亮信封
      }
    }
    seenSent.set(c.id, c.sentAt)

    if (seenGot.has(c.id) && c.gotAt !== undefined && c.gotAt !== seenGot.get(c.id)) {
      notices.push({ id: c.id, start: frame, end: frame + NOTICE_FRAMES })
    }
    seenGot.set(c.id, c.gotAt)

    // 對外動作：從座位走去影印機／檔案櫃／郵筒再走回來（正在走路的不疊加）
    const errandAt = c.errand?.at
    if (seenErrand.has(c.id) && errandAt !== undefined && errandAt !== seenErrand.get(c.id) && !walkers.some(w => w.id === c.id)) {
      const pl = lastPlaced?.get(c.id)
      if (pl && width > 0 && rows > 0) walkers.push({ id: c.id, path: errandRoute(pl, c.errand!.kind, width, rows), start: frame, kind: c.errand!.kind })
    }
    seenErrand.set(c.id, errandAt)

    const blockedAt = c.blocked?.at
    if (seenBlocked.has(c.id) && blockedAt !== undefined && blockedAt !== seenBlocked.get(c.id) && !c.isMe) {
      $.ui.toast(`${c.name} 被權限擋下（${c.blocked!.tool}），要你在它的視窗說「放行」`)
    }
    seenBlocked.set(c.id, blockedAt)

    if (seenMode.has(c.id) && c.mode === 'waiting' && seenMode.get(c.id) !== 'waiting' && !c.isMe) {
      $.ui.toast(`${c.name} 在等你核准權限`)
    }
    seenMode.set(c.id, c.mode)
  }
}

// 讀其他 session 的檔，丟掉已離開或太久沒心跳的
async function refresh($: EngineInterface) {
  const d = await sharedDir($)
  const now = await $.clock.now()
  const entries = await $.fs.list(d).catch(() => [])
  if (!collisionWarned && me.id !== 'me' && instance) {
    const ownNow = await readOwnStatus($, me.id)
    // 別人在我上次寫入之後又寫了一次 → 有另一個視窗在用同一個編號
    if (ownNow && typeof ownNow.updatedAt === 'number' && ownNow.updatedAt > lastWriteAt && isCollision(ownNow, instance, now)) warnCollision($)
  }
  const found: Coworker[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json') || entry.name === `${me.id}.json`) continue
    // 已關的 session：舊檔不刪（MOD 的 $.fs 沒有刪除功能），但不每秒重讀 ——
    // 讀過確認已關的記在 dead，每分鐘才再確認一次（--resume 會讓同一個檔重新活過來）；
    // 檔案修改時間若拿得到且已超過心跳上限，也直接跳過
    if (typeof entry.mtimeMs === 'number' && entry.mtimeMs > 0 && now - entry.mtimeMs > STALE_MS) continue
    const lastDead = dead.get(entry.name)
    if (lastDead !== undefined && now - lastDead < DEAD_RECHECK_MS) continue
    try {
      const raw = await $.fs.read(`${d}/${entry.name}`)
      const s = JSON.parse(typeof raw === 'string' ? raw : '{}')
      const alive = !s.left && typeof s.updatedAt === 'number' && now - s.updatedAt < STALE_MS
      if (alive) dead.delete(entry.name)
      else dead.set(entry.name, now)
      if (alive) {
        found.push({
          id: String(s.id),
          name: String(s.name),
          mode: s.mode as OfficeMode,
          tool: String(s.tool ?? ''),
          isMe: false,
          role: s.role === 'manager' ? 'manager' : 'staff',
          agent: typeof s.agent === 'string' ? s.agent : undefined,
          title: typeof s.title === 'string' ? s.title : undefined,
          auto: s.auto === true ? true : undefined,
          team: typeof s.team === 'string' && s.team.length > 0 ? s.team : undefined,
          blocked: s.blocked && typeof s.blocked.tool === 'string' && typeof s.blocked.at === 'number' ? { tool: s.blocked.tool, at: s.blocked.at } : undefined,
          errand: s.errand && ['mail', 'file', 'push'].includes(s.errand.kind) && typeof s.errand.at === 'number' ? { kind: s.errand.kind, at: s.errand.at } : undefined,
          sentTo: typeof s.sentTo === 'string' ? s.sentTo : undefined,
          sentAt: typeof s.sentAt === 'number' ? s.sentAt : undefined,
          gotAt: typeof s.gotAt === 'number' ? s.gotAt : undefined,
        })
      }
    } catch {}
  }
  others = found
  await showCrew($)
}

async function setMode($: EngineInterface, next: OfficeMode, name?: string) {
  seq += 1
  me = { ...me, mode: next, tool: name ?? me.tool }
  await showCrew($)
  await publish($, false).catch(() => undefined)
}

// 熱路徑（送出訊息、每次工具呼叫）不等寫檔：只改記憶體，寫檔交給計時器在背景做，短時間內多次更新合併成一次
// 為什麼：每次 $.fs.write／state 更新都要跨程序一趟（實測 prompt.submit 原本多等約 0.4 秒、session.start 約 3 秒）
let flushPending = false
function flushSoon($: EngineInterface) {
  if (flushPending) return
  flushPending = true
  $.clock.after(0, () => {
    flushPending = false
    void (async () => {
      await showCrew($).catch(() => undefined)
      await publish($, false).catch(() => undefined)
    })()
  })
}

function setModeSoon($: EngineInterface, next: OfficeMode, name?: string) {
  seq += 1
  me = { ...me, mode: next, tool: name ?? me.tool }
  flushSoon($)
}

const TOOL = 'mcp__pixel-office__office_profile'
const ROSTER = 'mcp__pixel-office__office_roster'
const ROLE_WORDS: Record<string, Role> = { 主管: 'manager', manager: 'manager', boss: 'manager', 員工: 'staff', staff: 'staff', employee: 'staff' }
const ROLE_LABEL: Record<Role, string> = { manager: '主管', staff: '員工' }

export function parseRole(word: string): Role | undefined {
  return ROLE_WORDS[word.trim().toLowerCase()] ?? ROLE_WORDS[word.trim()]
}

export function validName(name: string): boolean {
  return /^[\x21-\x7e]{1,12}$/.test(name)
}

// 角色與名牌：/office 指令和模型工具共用；依 session 編號記在 $.store
async function applyProfile(
  $: EngineInterface,
  input: { role?: string; name?: string; agent?: string; title?: string; auto?: boolean; team?: string },
): Promise<string> {
  const notes: string[] = []
  let team = me.team
  if (input.team !== undefined) {
    const t = input.team.trim().replace(/\s*\[[0-9a-f]+\]$/i, '')
    if (t.length > 64) return `歸屬「${input.team}」太長：用主管在 ListAgents 上的名稱。`
    team = t.length > 0 && t !== 'off' ? t : undefined
    notes.push(team ? `歸屬＝${team}（坐 peer 區）` : '歸屬已清除')
  }
  let auto = me.auto
  if (input.auto !== undefined) {
    auto = input.auto ? true : undefined
    notes.push(input.auto ? '模式＝auto（不舉手等核准）' : '模式＝會等人核准')
  }
  let role = me.role
  let name = me.name
  let agent = me.agent
  let title = me.title
  if (input.title !== undefined) {
    const t = input.title.trim()
    if (t.length > 16) return `職稱「${input.title}」太長：最多 16 字。`
    title = t.length > 0 ? t : undefined
    notes.push(title ? `職稱＝${title}` : '職稱已清除')
  }
  if (input.agent !== undefined) {
    const a = input.agent.trim().replace(/\s*\[[0-9a-f]+\]$/i, '')
    if (a.length === 0 || a.length > 64) return `agent 名稱「${input.agent}」不行：要 1～64 字（用 ListAgents 顯示的 This session is 後面那個名稱）。`
    agent = a
    notes.push(`agent＝${agent}`)
    if (input.name === undefined && name === defaultName) {
      const derived = plateFromAgent(a)
      if (derived) {
        name = derived
        notes.push(`名牌自動設為 ${derived}`)
      }
    }
  }
  if (input.role !== undefined) {
    const parsed = parseRole(input.role)
    if (parsed === undefined) return `看不懂角色「${input.role}」，請用 主管 或 員工。`
    role = parsed
    notes.push(`角色＝${ROLE_LABEL[role]}`)
  }
  if (input.name !== undefined) {
    if (!validName(input.name)) return `名牌「${input.name}」不行：只能用英數字與符號、1～12 字、不含空白（中文在像素畫裡寬兩格放不下）。`
    name = input.name
    notes.push(`名牌＝${name}`)
  }
  if (notes.length === 0) return '沒有要改的：請給 role（主管／員工）、name（英數字）、title（職稱）、agent（ListAgents 名稱）、auto（true／false）或 team（主管名稱）。'
  me = { ...me, role, name, agent, title, auto, team }
  await $.store.set(`profile:${me.id}`, { role, name, agent, title, auto, team }).catch(() => undefined) // 存不了只是重開後不記得
  await showCrew($)
  await publish($, false).catch(() => undefined)
  return `已設定：${notes.join('、')}。`
}

// 暫時狀態：ms 後若沒被別的狀態蓋掉，就切回 to
function revertLater($: EngineInterface, ms: number, to: OfficeMode) {
  const mine = seq
  $.clock.after(ms, () => {
    if (seq === mine) void setMode($, to).catch(() => undefined)
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'office', description: 'pixel-office: open the shared pixel office pane' })
    await $.tool.register({
      name: 'office_profile',
      description:
        '設定你在「像素辦公室」裡的角色、名牌與 ListAgents 名稱。知道自己是主管（例如被指派為協作主管）就設 role="主管"，一般 session 設 "員工"；name 是桌上名牌，只能英數字 1～12 字，建議用你的短代號（例如 58、e2）；agent 是 ListAgents 顯示的「This session is X」裡的 X，登記後別人傳訊息給你時辦公室會畫紙飛機。只影響辦公室畫面，不影響任何權限或檔案。',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['主管', '員工'], description: '主管 或 員工' },
          name: { type: 'string', description: '名牌，英數字 1～12 字' },
          agent: { type: 'string', description: 'ListAgents 上你自己的名稱（This session is 後面那個）' },
          title: { type: 'string', description: '職稱，自由填寫最多 16 字（例如 IT、查證、ArduPilot），可用中文' },
          team: { type: 'string', description: '你是哪位主管的 peer：填主管的 ListAgents 名稱（例如 user-30）；不再是 peer 時填 off' },
          auto: { type: 'boolean', description: '你的 session 是 auto 權限模式（系統提示寫 auto mode is active）就設 true；否則 false' },
        },
      },
    })
    await $.tool.register({
      name: 'office_roster',
      description:
        '查「像素辦公室」名單：目前在線的每個 Claude Code session 的名牌、職稱、角色（主管／員工）、ListAgents 名稱（傳 SendMessage 用）與正在做什麼。要找主管、找負責某件事的人、或確認對方身分時用。只讀，不改任何東西。',
      inputSchema: { type: 'object', properties: {} },
    })
    // 讀設定、寫心跳、讀名單、讀按鈕都放到計時器裡做，不擋第一輪（原本 session.start 要等約 3 秒）
    $.clock.after(0, () => {
      void (async () => {
          const id = await $.session.id()
          defaultName = plateName(await $.session.cwd(), id)
          me = { ...me, id, name: defaultName }
          // 先讀 $.store；讀不到（例如同一 session 載了兩份 MOD、各自的儲存區不同）就用自己的狀態檔當備援
          const stored = (await $.store.get(`profile:${id}`).catch(() => undefined)) as Profile | undefined
          instance = await read($, instanceRef)
          if (!instance) {
            instance = crypto.randomUUID()
            await update($, instanceRef, () => instance)
          }
          const ownRaw = await readOwnStatus($, id)
          const clash = isCollision(ownRaw, instance, await $.clock.now())
          if (clash) warnCollision($)
          const own = clash ? undefined : ownRaw // 撞號時不繼承另一個視窗的設定（例：拿到別人的「協作主管」職稱）
          const saved = mergeProfile(stored, own)
          if (saved?.role === 'manager' || saved?.role === 'staff') me = { ...me, role: saved.role }
          if (typeof saved?.name === 'string' && validName(saved.name)) me = { ...me, name: saved.name }
          const savedAgent = (saved as { agent?: unknown } | undefined)?.agent
          if (typeof savedAgent === 'string' && savedAgent.length > 0) me = { ...me, agent: savedAgent }
          if (saved?.auto === true) me = { ...me, auto: true }
          const savedTeam = (saved as { team?: unknown } | undefined)?.team
          if (typeof savedTeam === 'string' && savedTeam.length > 0) me = { ...me, team: savedTeam }
          const savedTitle = (saved as { title?: unknown } | undefined)?.title
          if (typeof savedTitle === 'string' && savedTitle.length > 0) me = { ...me, title: savedTitle }
          await publish($, false).catch(() => undefined)
          await refresh($).catch(() => undefined)
          await loadButtons($).catch(() => undefined)
      })().catch(() => undefined)
    })

    // 動畫每秒 2 格（原 4 格；使用者回報整個畫面更新變慢，實測本 session 的 claude 程序約 50% CPU）
    $.clock.every(500, () => {
      frame += 1
      if (rasterOpen && width > 0) {
        void $.ui
          .blit({ requestId: PANE, key: 'scene', cells: encode(drawScene(everyone(), frame, width, rows, liveWalkers(), lastPlaced ?? undefined, sceneOpts())) })
          .then(r => {
            if (r?.deny) rasterOpen = false // 面板沒在畫（關掉了）→ 停止重畫，下次打開面板時 render 會再打開
          })
          .catch(() => undefined)
      }
    })
    $.clock.every(1000, () => void refresh($).catch(() => undefined))
    // Svg 不能像 Raster 那樣 blit，只能整張重畫：每 1 秒一次（原 0.5 秒；實測 Desktop 畫面程序約 17% CPU）
    $.clock.every(1000, () => {
      if (svgOpen) $.ui.invalidate('ui.render')
    })
    $.clock.every(5000, () => void publish($, false).catch(() => undefined))
    // 每 10 秒重讀個人按鈕：某次讀取失敗（例如重載當下）會自己恢復；改了 buttons.json 也不必再打 /office buttons
    $.clock.every(10000, () => void loadButtons($).catch(() => undefined))

    return next(e)
  })

  // 系統提示加一句：角色變了要更新辦公室（每輪多讀約 60 字）
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const section = {
      id: 'pixel-office:role',
      text:
        '像素辦公室：使用者有開一個辦公室面板顯示每個 session，靠名牌分辨你和同資料夾的其他 session。(1) 你用 ListAgents 時辦公室會自動登記你的名稱並把名牌設成短代號；若沒有，請用 mcp__pixel-office__office_profile(agent=X, name=<X 的最後一段>) 登記一次。(2) 接到新工作或換工作時，用同一個工具更新 title（你正在負責的事，16 字內，例如 請購單、FOG 論文）；被指派或卸下主管時更新 role（主管／員工）。(3) 要找主管、找負責某件事的人或確認對方身分時，呼叫 mcp__pixel-office__office_roster 看名單。(4) 若你的系統提示寫明 auto mode is active，登記時一併設 auto=true（auto 模式的權限詢問交給分類器，辦公室才不會誤報你在等使用者核准）；之後切換模式時再更新。(5) 被主管派工、成為某位主管的 peer 時，設 team=<主管的 ListAgents 名稱>，辦公室會把你排到 peer 區；不再是 peer 時設 team=off。只影響畫面，不影響權限。',
      scope: 'session' as const,
    }
    return { sections: [...composed.sections, section] }
  })

  // 用到 ListAgents 時，從輸出抓「This session is X」自動登記（不用模型配合）
  on('tool.call', { tool: 'ListAgents' }, async ($, e, next) => {
    const ran = await next(e)
    try {
      const self = ran.deny === undefined ? selfFromListAgents(ran.text ?? '') : undefined
      if (self && self !== me.agent) await applyProfile($, { agent: self })
    } catch {}
    return ran
  })

  // office_profile 不要延後載入：開場就讓模型看到完整說明（user-30 2026-10-03 指出 deferred 時說明不會觸發）
  on('tool.describe', { tool: ROSTER }, async ($, e, next) => {
    const described = await next(e)
    return { ...described, isDeferred: false }
  })

  on('tool.call', { tool: ROSTER }, async $ => {
    await refresh($).catch(() => undefined)
    return { result: roster(everyone(), await $.clock.now()) }
  })

  on('tool.describe', { tool: TOOL }, async ($, e, next) => {
    const described = await next(e)
    return { ...described, isDeferred: false }
  })

  // 送出訊息（SendMessage）：記下收件者與時間，各視窗據此畫紙飛機
  on('session.send', async ($, e, next) => {
    const sent = await next(e)
    try {
      if (sent.isDelivered) {
        me = { ...me, sentTo: e.to, sentAt: Date.now() }
        flushSoon($)
      }
    } catch {}
    return sent
  })

  // 收到別的 session 的訊息：記下時間，頭上亮信封
  on('session.receive', async ($, e, next) => {
    try {
      if (e.origin.kind === 'peer' || e.origin.kind === 'peer-send-message') {
        me = { ...me, gotAt: Date.now() }
        flushSoon($)
      }
    } catch {}
    return next(e)
  })

  // 記下目前的權限模式（PreToolUse 在 tool.check 之前；auto 模式的 ask 由分類器決定，不算等人核准）
  on('classic.PreToolUse', ($, e, next) => {
    const mode = (e as { permission_mode?: unknown }).permission_mode
    if (typeof mode === 'string') permissionMode = mode
    return next(e)
  })

  // 引擎判定這次工具呼叫要「問」→ 等待核准（舉手＋黃色問號，其他視窗跳 toast）
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    try {
      // 自己宣告 auto 的 session 不舉手；classic.PreToolUse 在這版沒有觸發，permissionMode 只當備用
      if (waitsForApproval(verdict.decision, e.tool_use_id, me.auto ? 'auto' : permissionMode)) setModeSoon($, 'waiting', String(e.tool))
    } catch {}
    return verdict
  })

  on('session.end', async ($, e, next) => {
    // session.start 沒跑完就結束時還沒有 session 編號（仍是預設的 'me'）：不寫，免得留下 me.json 垃圾檔
    if (me.id !== 'me') await publish($, true).catch(() => undefined)

    return next(e)
  })

  // /office → 開面板；/office role 主管；/office name 58
  on('command.run', { command: 'office' }, async ($, e) => {
    const [sub, ...rest] = e.args.trim().split(/\s+/)
    const value = rest.join(' ')
    if (sub === 'role') return { text: await applyProfile($, { role: value }) }
    if (sub === 'name') return { text: await applyProfile($, { name: value }) }
    if (sub === 'agent') return { text: await applyProfile($, { agent: value }) }
    if (sub === 'title') return { text: await applyProfile($, { title: value }) }
    if (sub === 'team') {
      if (value.trim() === '') return { text: '用法：/office team <主管的 ListAgents 名稱>（坐 peer 區）｜/office team off（取消）' }
      return { text: await applyProfile($, { team: value }) }
    }
    if (sub === 'auto') {
      const v = value.trim().toLowerCase()
      if (v !== 'on' && v !== 'off') return { text: '用法：/office auto on（auto 模式，不舉手）｜/office auto off（會等人核准）' }
      return { text: await applyProfile($, { auto: v === 'on' }) }
    }
    if (sub === 'buttons') {
      const list = await loadButtons($)
      return { text: list.length > 0 ? `已載入 ${list.length} 顆個人按鈕：${list.map(b => b.label).join('、')}` : '沒有個人按鈕：~/.claude/pixel-office/buttons.json 不存在或格式不對。' }
    }
    if (sub === 'who') {
      await refresh($).catch(() => undefined)
      return { text: roster(everyone(), await $.clock.now()) }
    }
    if (sub !== '' && sub !== undefined) return { text: '用法：/office｜/office who｜/office role 主管|員工｜/office title <職稱>｜/office name <英數字>｜/office agent <ListAgents 名稱>｜/office team <主管>|off｜/office auto on|off｜/office buttons（重讀個人按鈕）' }

    await refresh($).catch(() => undefined)
    await loadButtons($).catch(() => undefined)
    await $.ui.open({ id: PANE, title: '像素辦公室' })

    return { text: `像素辦公室已開啟。你是${ROLE_LABEL[me.role]}，名牌 ${me.name}。` }
  })

  // 模型自己設定角色／名牌
  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as { role?: string; name?: string; agent?: string; title?: string; auto?: unknown; team?: string }
    const auto = input.auto === true || input.auto === 'true' ? true : input.auto === false || input.auto === 'false' ? false : undefined
    const text = await applyProfile($, { role: input.role, name: input.name, agent: input.agent, title: input.title, auto, team: input.team })

    // 自訂工具的 result 只能是字串或內容區塊陣列，不能是物件（實測：物件會被引擎判為格式錯誤）
    return { result: `${text}（目前：${ROLE_LABEL[me.role]}，名牌 ${me.name}，session ${me.id.slice(0, 8)}）` }
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      me = { ...me, blocked: undefined } // 使用者在這個視窗輸入了（例如說放行），紅牌放下
      setModeSoon($, 'thinking')
    } catch {}

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const name = String(e.tool)
    try {
      setModeSoon($, READING.has(name) ? 'reading' : 'typing', name)
    } catch {}
    const ran = await next(e)
    try {
      if (classifierBlocked(ran as { deny?: string; isError?: boolean; text?: string })) {
        me = { ...me, blocked: { tool: name, at: Date.now() } }
        setModeSoon($, 'error', name)
        revertLater($, 2500, 'thinking')
      } else if (ran.deny !== undefined || ran.isError === true) {
        setModeSoon($, 'error', name)
        revertLater($, 2500, 'thinking')
      } else {
        const kind = detectErrand(name, e)
        if (kind) me = { ...me, errand: { kind, at: Date.now() } }
        setModeSoon($, 'thinking')
      }
    } catch {}

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    try {
      setModeSoon($, 'done')
      revertLater($, 5000, 'idle')
    } catch {}

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, crew)
    const shown = list.length > 0 ? list : everyone()
    nightMode = await read($, night)
    const isBoss = me.role === 'manager'
    const toggleRole = () => applyProfile($, { role: isBoss ? '員工' : '主管' })
    const toggleNight = () => update($, night, v => !v)

    if (e.surface !== 'terminal') {
      const els = $.ui.resolve(e) as Record<string, unknown>
      const { Box, Text, Button, Link } = $.ui.resolve(e)
      const Svg = els.Svg as typeof Box | undefined
      rasterOpen = false // 終端的 blit 只給 Raster 用（版面 width／rows 照常更新，走路與紙飛機才算得出位置）
      const mine = await read($, buttons)
      if (!Svg) {
        svgOpen = false
    rasterOpen = true
        return (
          <Box flexDirection="column">
            <Text bold>像素辦公室：{shown.length} 人在線</Text>
            <Text dimColor>這個介面沒有可以畫圖的元素，只顯示文字。</Text>
            <Button key="role" label={isBoss ? '設為員工' : '升為主管'} onPress={toggleRole} />
          </Box>
        )
      }
      svgOpen = true
      // 同色合併成 path 後，最大 112×80 約 7.4 萬字元（2026-10-05 實測），仍在 Svg 上限 131072 內；超過就縮小再畫
      let sw = sceneWidth(e.props.bodyColumns)
      let sr = Math.min(80, sceneRows(e.props.scroll?.bodyRows))
      let svg = ''
      for (let tries = 0; tries < 4; tries++) {
        if (width !== sw || rows !== sr) {
          width = sw
          rows = sr
        }
        lastPlaced = assignSeats(shown, width, rows, lastPlaced ?? undefined)
        svg = encodeSvg(drawScene(shown, frame, width, rows, liveWalkers(), lastPlaced, sceneOpts()))
        if (svg.length <= SVG_MAX) break
        sw = Math.max(48, sw - 12)
        sr = Math.max(40, sr - 8)
      }
      return (
        <Box flexDirection="column">
          <Svg key="scene" source={svg} alt={`像素辦公室：${shown.length} 人在線`} />
          {mine.length > 0 ? (
            <Box flexDirection="row">
              {mine.map((b, i) =>
                b.url ? (
                  <Link key={`mine-${i}`} href={b.url} label={b.label} />
                ) : (
                  <Button key={`mine-${i}`} label={b.label} onPress={() => runButton($, b)} />
                ),
              )}
            </Box>
          ) : (
            <Text key="reserved" dimColor>
              個人按鈕：~/.claude/pixel-office/buttons.json
            </Text>
          )}
          <Box flexDirection="row">
            <Button key="role" label={isBoss ? '設為員工' : '升為主管'} onPress={toggleRole} />
            <Button key="cat" label="餵貓" onPress={() => feedCat()} />
            <Button key="night" label={nightMode ? '開燈' : '夜間模式'} onPress={toggleNight} />
          </Box>
        </Box>
      )
    }
    svgOpen = false

    const { Box, Raster, Button, Text, Link } = $.ui.resolve(e)
    const mine = await read($, buttons)
    width = sceneWidth(e.props.bodyColumns)
    rows = sceneRows(e.props.scroll?.bodyRows) // 撐滿面板，扣掉預留空白與按鈕列
    lastPlaced = assignSeats(shown, width, rows, lastPlaced ?? undefined)

    return (
      <Box flexDirection="column">
        <Raster key="scene" columns={width} rows={rows} cells={encode(drawScene(shown, frame, width, rows, liveWalkers(), lastPlaced, sceneOpts()))} />
        {/* 預留列：放個人按鈕（~/.claude/pixel-office/buttons.json），沒有就空一列 */}
        {mine.length > 0 ? (
          <Box flexDirection="row">
            {mine.map((b, i) =>
              b.url ? (
                <Link key={`mine-${i}`} href={b.url} label={`[${b.label}]`} />
              ) : (
                <Button key={`mine-${i}`} label={b.label} onPress={() => runButton($, b)} />
              ),
            )}
          </Box>
        ) : (
          <Text key="reserved" dimColor>
            個人按鈕：~/.claude/pixel-office/buttons.json
          </Text>
        )}
        <Box flexDirection="row">
          <Button key="role" label={isBoss ? '設為員工' : '升為主管'} hotkey="r" onPress={toggleRole} />
          <Text> </Text>
          <Button key="cat" label="餵貓" hotkey="c" onPress={() => feedCat()} />
          <Text> </Text>
          <Button key="night" label={nightMode ? '開燈' : '夜間模式'} hotkey="n" onPress={toggleNight} />
        </Box>
      </Box>
    )
  })
}
