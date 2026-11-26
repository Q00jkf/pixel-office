import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Coworker, CustomButton, ErrandKind, OfficeMode, Pet, Role } from '../types'
import { GEOM, MIN_ROWS, isAttendee, isDeptLead, NOTICE_FRAMES, PLANE_FRAMES, SVG_MAX, TREAT_FRAMES, assignSeats, corridorRoute, queueSpot, raidFrames, raidPath, drawScene, encode, errandRoute, plateName, isCommandName, shortCode, shownName, route, desktopRows, sceneRows, sceneWidth, setSpread, rejoin, walkerPos } from './scene'
import type { CatRaid, Notice, Placement, Plane, SceneOptions, Seat, Walker } from './scene'
import { STALE_MS, parseStatus } from './status'
import { cellAt, drawVector, menuPlace, sameNameNumbers, vectorSvg, type Furniture, type Hit, type Rect } from './vector'
import { CHAT_KEEP_MS, CHAT_TEXT_MAX, PART_ZH, TASK_KEEP_MS, parseTask, type PartState, type TaskDef, type TaskPart, assign, atTable, chatDir, chatFile, chatTables, chinesePlates, firstLine, needsBoss, parseChat, parseStore, species, tablesOut, type ChatEntry } from './officeV2'
import { v2PanelSvg, type V2MenuHit, type V2Opts } from './v2panel'
import { hrSessionStart, hrTurnDone, registerHr, reloadIfIdle, setBusyOf } from './hr'
import { shouldReload, type ReloadTry } from './selfreload'
import { APPROVE_LOG_PY, PHONE_LIVE_PY, WAITER_PY } from './waiter'
export { WAITER_PY }

const PANE = 'pixel-office'
const DEAD_RECHECK_MS = 60000 // 已關的 session 檔，每分鐘才再讀一次
const dead = new Map<string, number>() // 檔名 → 上次確認已關的時間
const crew = atom({ plugin: 'pixel-office', key: 'crew' } as const, [] as Coworker[])
const night = atom({ plugin: 'pixel-office', key: 'night' } as const, false)
const buttons = atom({ plugin: 'pixel-office', key: 'buttons' } as const, [] as CustomButton[])
const instanceRef = atom({ plugin: 'pixel-office', key: 'instance' } as const, '')
const petRef = atom({ plugin: 'pixel-office', key: 'pet' } as const, 'cat' as Pet)
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
let oneshots: Coworker[] = [] // 別的 session 裡的一次性對話（claude -p）：不進 others，不畫成員工
let walkers: Walker[] = []
let nightMode = false
let pet: Pet = 'cat'
let approveOn = false // 審核端開關（/office approve on|off，存 $.store；預設關，jacky 2026-10-26 裁示）
let meeting = false // 開會中（~/.claude/pixel-office/meeting.json 的 until 之前）
let attendees: string[] = [] // 開會的參與者（meeting.json 的 participants）；空的就是主管的 peer
let meetingTopic = ''
let svgOpen = false // Desktop 等用 Svg 畫的面板開著時，計時器要定期請它重畫
let rasterOpen = false // 終端 Raster 面板開著時才 blit；width／rows 是兩種介面共用的版面，不再拿來當開關
let treatFrame: number | undefined
let catOffset = 0
let raid: CatRaid | undefined
let raidEnd = 0 // 放貓結束的那一格；結束後把這段時間併進 catOffset，貓從出發的地方接著走
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
const seenApproval = new Map<string, number | undefined>()

const sceneOpts = (): SceneOptions => {
  planes = planes.filter(pl => frame - pl.start <= PLANE_FRAMES)
  notices = notices.filter(n => frame < n.end)
  if (raid && frame >= raidEnd) {
    catOffset += raidEnd - raid.start
    raid = undefined
  }
  return { night: nightMode, treatFrame, catOffset, planes, notices, raid, pet, meeting, attendees, queue: queueOrder() }
}

// 餵貓（寶寶是餵奶）：把上一次吃飯停下的時間併進位移，再開始新的一次
function feedCat() {
  if (raid) return // 出去咬人／抱大腿了，不在碗旁邊
  if (treatFrame !== undefined) catOffset += Math.min(TREAT_FRAMES, frame - treatFrame)
  treatFrame = frame
}
let lastPlaced: Map<string, Placement> | null = null

const PET_WORDS: Record<Pet, { name: string; feed: string; release: string; go: string; act: string; back: string; now: string; aliases: string[] }> = {
  cat: { name: 'the cat', feed: 'Feed the cat', release: 'Release the cat', go: '🐈 Cat released, target: ', act: 'bite', back: 'The cat is still out; wait for it to come back.', now: '🐈 The office pet is now the cat.', aliases: ['cat', '貓'] },
  baby: { name: 'the baby', feed: 'Give milk', release: 'Let the baby go', go: '👶 The baby crawled off to hug a leg, target: ', act: 'hug', back: 'The baby is still out; wait for it to crawl back.', now: '👶 The office pet is now the baby.', aliases: ['baby', '寶寶', '小寶寶'] },
  bird: { name: 'the tit', feed: 'Feed millet', release: 'Let the tit fly', go: '🐦 The tit flew over to sing, target: ', act: 'sing to', back: 'The tit is still out; wait for it to fly back.', now: '🐦 The office pet is now the long-tailed tit.', aliases: ['bird', 'tit', '山雀', '長尾山雀', '銀喉長尾山雀'] },
}
const PET_ORDER: Pet[] = ['cat', 'baby', 'bird'] // 不帶參數的切換順序
const nextPet = (p: Pet) => PET_ORDER[(PET_ORDER.indexOf(p) + 1) % PET_ORDER.length]
const isPet = (v: unknown): v is Pet => typeof v === 'string' && (PET_ORDER as string[]).includes(v)

// 換寵物：貓 → 小寶寶 → 山雀 → 貓。存在 $.store（跨 session、跨重開都記得），只影響自己這台看到的畫面
async function setPet($: EngineInterface, value?: string): Promise<string> {
  const v = value?.trim().toLowerCase()
  const next: Pet | undefined = !v ? nextPet(pet) : PET_ORDER.find(k => PET_WORDS[k].aliases.includes(v))
  if (!next) return 'Usage: /office pet [cat|baby|bird] (no argument cycles cat → baby → tit)'
  if (raid) return PET_WORDS[pet].back
  pet = next
  await update($, petRef, () => next)
  await $.store.set('pet', next).catch(() => undefined) // 存不了只是重開後回到貓
  return PET_WORDS[next].now
}

// 放貓咬人：name 指定名牌，沒指定就隨機挑一位坐在員工座位的人（先挑別人，只剩自己才咬自己）；回傳給使用者看的一句話
function releaseCat(name?: string): string {
  const w = PET_WORDS[pet]
  if (raid) return w.back
  if (!lastPlaced || width === 0) return `Open the office panel with /office first, so ${w.name} knows where everyone sits.`
  const staff = everyone().filter(c => lastPlaced!.get(c.id)?.kind === 'staff')
  const want = name?.trim().toLowerCase()
  const pool = want ? staff.filter(c => c.name.toLowerCase() === want) : staff.filter(c => !c.isMe).length > 0 ? staff.filter(c => !c.isMe) : staff
  if (pool.length === 0) return want ? `Nobody named ${name!.trim()} at a staff desk (managers are in the manager's room, ${w.name} can't get in).` : `Nobody at a staff desk to ${w.act}.`
  const prey = pool[Math.floor(Math.random() * pool.length)]
  const start = frame + 1
  raid = { targetId: prey.id, start }
  raidEnd = start + raidFrames(raidPath(lastPlaced.get(prey.id)!, width, rows, start, treatFrame, catOffset, pet))
  return `${w.go}${prey.name}`
}

// 角色變了（員工↔主管）就排一段走路動畫：從舊座位沿走道走到新座位
function trackMoves(list: Coworker[]) {
  if (width === 0 || rows === 0) return
  const now = assignSeats(list, width, rows, lastPlaced ?? undefined, meeting, attendees)
  if (lastPlaced) {
    for (const [id, pl] of now) {
      const old = lastPlaced.get(id)
      if (old && (old.kind !== pl.kind || old.slot !== pl.slot)) {
        walkTo(id, route(old, pl, width, rows))
      }
    }
  }
  lastPlaced = now
}

// 換路線：還在走的人從現在的位置接上，不跳回起點或跳到終點
function walkTo(id: string, path: Seat[]) {
  const old = walkers.find(w => w.id === id)
  walkers = walkers.filter(w => w.id !== id)
  walkers.push({ id, path: rejoin(old, path, frame), start: frame })
}

function liveWalkers(): Walker[] {
  walkers = walkers.filter(w => walkerPos(w, frame) !== null)
  return walkers
}

const everyone = (): Coworker[] => [me, ...others].filter(c => !c.oneshot).sort((a, b) => a.id.localeCompare(b.id))

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
let foreignAt = 0 // 最近一次看到別的實例寫我的狀態檔
function warnCollision($: EngineInterface) {
  foreignAt = Date.now()
  if (!me.dup) me = { ...me, dup: true }
  if (collisionWarned) return
  collisionWarned = true // toast 只跳一次；dup 名單標紅、下一則指令提醒模型（jacky 2026-10-31：團隊視窗 resume 同一份對話，撞角色檢查抓不到）
  $.ui.toast(`⚠ Another window shares this session id (${me.id.slice(0, 8)}), so their office data overwrite each other: close one and reopen a different conversation with claude --resume`)
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

/** 從 ListAgents 的輸出抓自己的名稱與 ref（「This session is X [ref]」） */
export function selfFromListAgents(text: string): { name: string; ref: string } | undefined {
  const m = text.match(/This session is (.+?) \[([0-9a-f]+)\]/)
  return m ? { name: m[1].trim(), ref: m[2] } : undefined
}

const MAX_BUTTONS = 6

/** 檢查設定檔的按鈕：label 1～12 字；url 只收 http(s)；prompt 1～2000 字；底下那排最多 6 顆；有 object 的是家具選單項目 */
export function parseButtons(raw: unknown): CustomButton[] {
  if (!Array.isArray(raw)) return []
  const out: CustomButton[] = []
  let row = 0
  for (const b of raw) {
    if (!b || typeof b !== 'object') continue
    const label = typeof b.label === 'string' ? b.label.trim() : ''
    if (label.length === 0 || label.length > 12) continue
    // 家具選單項目（有 object）：只收 prompt，每件家具最多 MAX_MENU 項；底下那排（沒有 object）照舊最多 MAX_BUTTONS 顆
    if (typeof b.object === 'string') {
      const object = b.object.trim()
      if (!(FURNITURE as readonly string[]).includes(object)) continue
      if (typeof b.prompt !== 'string' || b.prompt.trim().length === 0 || b.prompt.length > 2000) continue
      if (out.filter(x => x.object === object).length >= MAX_MENU) continue
      out.push({ label, prompt: b.prompt.trim(), object })
      continue
    }
    if (row >= MAX_BUTTONS) continue
    if (typeof b.url === 'string' && /^https?:\/\//i.test(b.url)) out.push({ label, url: b.url })
    else if (typeof b.prompt === 'string' && b.prompt.trim().length > 0 && b.prompt.length <= 2000) out.push({ label, prompt: b.prompt.trim() })
    else continue
    row++
  }
  return out
}

// ---------- 點家具：小選單，選一項就把 prompt 送進按的這個 session（跟個人按鈕同一套 runButton） ----------

export const FURNITURE = ['printer', 'cabinet', 'mailbox', 'calendar', 'vending', 'clock', 'meeting'] as const satisfies readonly Furniture[]
const MAX_MENU = 6
/** Desktop 選單標題用的家具名 */
export const FURNITURE_NAMES: Record<Furniture, string> = { printer: 'Printer', cabinet: 'Cabinet', mailbox: 'Mailbox', calendar: 'Calendar', vending: 'Vending', clock: 'Clock', meeting: 'Meeting table' }
// 素材色盤（vector.ts 的 SW）：white 底、金框、ink 字。Desktop 按鈕字一律用原生深色、不吃 Text color（jacky 2026-10-27 實機：深底上看不見），所以底只能用淺色
const MENU_BG = '#f4f4f4'
const MENU_EDGE = '#c9a227'
const MENU_TEXT = '#1a1c2c'
const MENU_DIM = '#566c86'
/** 預設選單（主管 office 2026-10-27 轉 jacky 裁示）；buttons.json 有同 object 的項目就整份換成使用者的 */
export const MENUS: Record<Furniture, { label: string; prompt: string }[]> = {
  printer: [
    { label: 'Recent mail', prompt: 'Check my recent unread Gmail and summarize it' },
    { label: 'Write mail', prompt: 'Help me write an email: ask me for the recipient and content first, and confirm with me before sending' },
    { label: 'Drafts', prompt: 'List my Gmail drafts' },
  ],
  cabinet: [
    { label: 'Mounted sources', prompt: '/llm-wiki:wiki-repo list' },
    { label: 'Query wiki', prompt: '/llm-wiki:wiki-query' },
    { label: 'Search Drive', prompt: 'Search Google Drive for files: ask me for keywords first' },
  ],
  mailbox: [
    { label: 'Status', prompt: 'git status, and summarize it in a sentence or two' },
    { label: 'pull', prompt: 'git pull the current branch; if there is a conflict, stop and tell me' },
    { label: 'push', prompt: 'Push the current branch: list the commits to push and confirm with me first' },
    { label: 'Recent commits', prompt: 'git log --oneline -10' },
  ],
  calendar: [
    { label: 'Agenda', prompt: '/llm-wiki:wiki-agenda' },
    { label: 'Add event', prompt: '/llm-wiki:wiki-agenda add' },
  ],
  vending: [
    { label: 'Health check', prompt: '/llm-wiki:wiki-doctor' },
    { label: 'Wiki status', prompt: '/llm-wiki:wiki' },
  ],
  clock: [
    { label: 'Start day', prompt: '/llm-wiki:wiki-day 開工' },
    { label: 'End day', prompt: '/llm-wiki:wiki-day 收工' },
  ],
  meeting: [{ label: 'Meeting', prompt: '/pixel-office:team start a meeting' }],
}

/** 某件家具的選單：使用者在 buttons.json 有寫這件家具就整份用他的，沒有就用預設 */
export function menuFor(object: Furniture, mine: CustomButton[]): { label: string; prompt: string }[] {
  const own = mine.filter(b => b.object === object && b.prompt)
  return own.length > 0 ? own.map(b => ({ label: b.label, prompt: b.prompt! })) : MENUS[object]
}

export { CELL_UNITS, cellAt, menuPlace } from './vector'
/** 終端機的按鈕放在東西的中心，往左挪 1 格讓 1～2 格寬的符號置中 */
export const hitCell = (h: Hit, surface: 'terminal' | 'desktop', k = 1) => cellAt(h.x + h.w / 2 - 1, h.y + h.h / 2, surface, k)
/** 終端機的 Raster 沒畫柯基、販賣機，月曆與時鐘也不在同一個位置 → 這幾樣只在 Desktop 點得到 */
export const terminalHits = (hits: Hit[]) => hits.filter(h => !['corgi', 'vending', 'calendar', 'clock', 'window'].includes(h.what))
const terminalScene = (v: { hits: Hit[]; fixed: Rect[] }) => {
  lastFixed = v.fixed
  return (lastHits = terminalHits(v.hits))
}
/** 選單要避開的：其他固定的可點東西＋櫃台；寵物會走、走動與排隊的人會換，都不算，選單位置才固定 */
export const menuOthers = (open: Hit, hits: Hit[], fixed: Rect[]): Rect[] => [...hits.filter(h => h !== open && h.what !== 'pet'), ...fixed]

let openMenu: Furniture | null = null // 同時只開一個選單
let menuOpenedAt = 0 // 剛打開的那次重畫放滑入動畫（0.62.17）
let menuPressed: number | undefined // 剛按下的選單按鈕：先畫按下去的樣子，0.15 秒後才關選單、執行
export const MENU_PRESS_MS = 150
// 看不見的按鈕字：Desktop 會把只有空白的標籤壓掉（jacky 2026-10-27：/office hits 點得到、平常點不到），改用盲文空白 U+2800（不算空白字元、畫出來是空的）
export const BLANK = '⠀'
let showHits = false // /office hits：Desktop 校準用，Svg 畫紅框＝東西真正的位置，按鈕填 ▒＝點得到的地方
let corgiFed: number | undefined
let lastHits: Hit[] = []
/** 選單美術第三批 P1：v2 面板的家具選單畫在 SVG 裡，這裡記每顆按鈕的位置（SVG 單位；最後一顆是取消），overlay 疊透明按鈕 */
let lastMenuHits: V2MenuHit[] = []
const FURNITURE_ZH: Record<Furniture, string> = { printer: '影印機', cabinet: '書櫃', mailbox: '郵筒', calendar: '月曆', vending: '販賣機', clock: '時鐘', meeting: '會議桌' }
let lastFixed: Rect[] = []
let petNote: { text: string; until: number } | undefined // 終端機看不到 toast：點寵物的結果在按鈕列留一行，約 5 秒
let petCell = '' // 終端機：寵物按鈕上次畫在哪一格；換格才重畫整個面板（Raster 平時只 blit）

/** 點寵物：停著（正在吃、坐著）→ 換下一隻；走動中 → 貓與寶寶餵、山雀放飛 */
async function pressPet($: EngineInterface): Promise<string> {
  if (raid) return PET_WORDS[pet].back
  if (lastHits.find(h => h.what === 'pet')?.sitting) return setPet($)
  if (pet === 'bird') return releaseCat()
  feedCat()
  return `${PET_WORDS[pet].feed}!`
}

// Desktop 點擊範圍往外放（jacky 2026-10-27：比較好點到）：左右各 2 單位、上下各 2.5 單位（≈1 列）
export const REACH_X = 2
export const REACH_Y = 2.5
/** 放大後的點擊範圍：往外長 REACH，碰到鄰居的原本範圍就停在兩者中間，不搶別人的地盤 */
export function reach(hit: Rect, hits: Rect[]): Rect {
  let l = hit.x - REACH_X, r = hit.x + hit.w + REACH_X, t = hit.y - REACH_Y, b = hit.y + hit.h + REACH_Y
  for (const o of hits) {
    if (o === hit) continue
    const rows = o.y < hit.y + hit.h + REACH_Y && hit.y - REACH_Y < o.y + o.h
    const cols = o.x < hit.x + hit.w + REACH_X && hit.x - REACH_X < o.x + o.w
    if (rows && o.x + o.w <= hit.x) l = Math.max(l, (o.x + o.w + hit.x) / 2)
    if (rows && o.x >= hit.x + hit.w) r = Math.min(r, (hit.x + hit.w + o.x) / 2)
    if (cols && o.y + o.h <= hit.y) t = Math.max(t, (o.y + o.h + hit.y) / 2)
    if (cols && o.y >= hit.y + hit.h) b = Math.min(b, (hit.y + hit.h + o.y) / 2)
  }
  return { x: Math.max(0, l), y: Math.max(0, t), w: r - Math.max(0, l), h: b - Math.max(0, t) }
}

/**
 * 疊在場景上的按鈕：寵物、柯基、每件畫出來的家具；選單開著就在那件家具旁邊展開（同時只開一個）。
 * Desktop：一列一顆 plain、標籤全是空白的按鈕，鋪滿整塊（plain 在 Desktop 只畫字、沒有底框 → 看不見但點得到）；
 * 終端機：中心一個淡色符號 —— Raster 上的按鈕字會蓋掉底下的格子，鋪滿就把寵物和家具擦掉了
 */
function overlay($: EngineInterface, els: Record<string, any>, hits: Hit[], surface: 'terminal' | 'desktop', mine: CustomButton[], sceneW: number, k: number) {
  const { Box, Button, Text } = els
  const toggle = (what: Furniture) => () => {
    openMenu = openMenu === what ? null : what
    menuOpenedAt = openMenu ? Date.now() : 0
    menuPressed = undefined
    $.ui.invalidate('ui.render')
  }
  let win = 0
  const out = hits.map(hit => { // 不能叫 h：JSX 編譯成 h(...)
    if (hit.what === 'table') {
      // 桌牌：點了開這桌的聊天室（第 12 項），再點一次關
      const id = `table-${hit.table}`
      const z = reach(hit, hits)
      const a = cellAt(z.x, z.y, surface, k)
      const b = cellAt(z.x + z.w, z.y + z.h, surface, k)
      const cols = Math.max(1, b.left - a.left)
      const press = () => {
        openMenu = null
        if (tableChat?.id === hit.table) tableChat = null
        else void loadTableChat($, hit.table!).then(() => $.ui.invalidate('ui.render'))
        $.ui.invalidate('ui.render')
      }
      return (
        <Box key={`at-${id}`} position="absolute" top={a.top} left={a.left} flexDirection="column">
          {Array.from({ length: Math.max(1, b.top - a.top + 1) }, (_, r) => (
            <Button key={r === 0 ? id : `${id}-r${r}`} plain label={(showHits ? '▒' : BLANK).repeat(cols)} onPress={press} />
          ))}
        </Box>
      )
    }
    if (hit.what === 'window') {
      // Desktop 的夜間模式：點牆上任何一扇窗切換（第一扇的 key 沿用舊的 night 按鈕）
      const id = win++ === 0 ? 'night' : `night-${win - 1}`
      const z = reach(hit, hits)
      const a = cellAt(z.x, z.y, surface, k)
      const b = cellAt(z.x + z.w, z.y + z.h, surface, k)
      const cols = Math.max(1, b.left - a.left)
      return (
        <Box key={`at-${id}`} position="absolute" top={a.top} left={a.left} flexDirection="column">
          {Array.from({ length: Math.max(1, b.top - a.top + 1) }, (_, r) => (
            <Button key={r === 0 ? id : `${id}-r${r}`} plain label={(showHits ? '▒' : BLANK).repeat(cols)} onPress={() => void update($, night, v => !v)} />
          ))}
        </Box>
      )
    }
    const press =
      hit.what === 'pet'
        ? () =>
            void pressPet($).then(t => {
              $.ui.toast(t)
              petNote = { text: t, until: frame + 20 }
              $.ui.invalidate('ui.render')
            })
        : hit.what === 'corgi'
          ? () => {
              corgiFed = frame
              $.ui.toast('🐕 Fed the corgi!')
            }
          : toggle(hit.what)
    if (surface === 'terminal') {
      const at = hitCell(hit, surface)
      return (
        <Box key={`at-${hit.what}`} position="absolute" top={at.top} left={at.left}>
          <Button key={`hit-${hit.what}`} plain dimColor label={hit.what === 'pet' || hit.what === 'corgi' ? '♥' : '▾'} onPress={press} />
        </Box>
      )
    }
    const z = reach(hit, hits)
    const a = cellAt(z.x, z.y, surface, k)
    const b = cellAt(z.x + z.w, z.y + z.h, surface, k)
    const cols = Math.max(1, b.left - a.left)
    return (
      <Box key={`at-${hit.what}`} position="absolute" top={a.top} left={a.left} flexDirection="column">
        {Array.from({ length: Math.max(1, b.top - a.top + 1) }, (_, r) => (
          <Button key={r === 0 ? `hit-${hit.what}` : `hit-${hit.what}-${r}`} plain label={(showHits ? '▒' : BLANK).repeat(cols)} onPress={press} />
        ))}
      </Box>
    )
  })
  if (tableChat && surface === 'desktop') {
    const tc = tableChat
    const hit = hits.find(h => h.what === 'table' && h.table === tc.id)
    if (hit) {
      const close = () => { tableChat = null; $.ui.invalidate('ui.render') }
      const at = cellAt(Math.max(4, hit.x - 20), hit.y + hit.h + 1, surface, k)
      const hhmm = (t: number) => { const d = new Date(t); return `${String(d.getMonth() + 1)}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }
      out.push(
        <Box key="tchat" position="absolute" top={at.top} left={Math.max(0, at.left)} flexDirection="column" backgroundColor={MENU_BG} borderStyle="round" borderColor={MENU_EDGE} paddingX={1}>
          {(tc.notes ?? []).map((l, i) => <Text key={`tnote-${i}`} color={l.startsWith('🔴') ? 'red' : MENU_TEXT} bold={i === 0}>{l}</Text>)}
          <Text key="tchat-title" bold color={MENU_TEXT}>{`💬 聊天室（${tc.items.length} 則，最近 30 天）`}</Text>
          {tc.items.length === 0 ? <Text key="tchat-none" color={MENU_DIM}>還沒有同桌互傳的話</Text> : null}
          {tc.items.map((c, i) => {
            const f = firstLine(c.text), open = tc.open.has(i)
            const head = `${hhmm(c.at)} ${c.from.name} → ${c.to.name}：`
            return (
              <Button key={`tchat-${i}`} label={`${head}${f.head}`} onPress={() => { if (!f.more) return; open ? tc.open.delete(i) : tc.open.add(i); $.ui.invalidate('ui.render') }}>
                <Text color={MENU_TEXT}>{open ? `${head}\n${c.text}` : `${head}${f.head}${f.more ? ' ▸' : ''}`}</Text>
              </Button>
            )
          })}
          <Button key="tchat-close" label="Close" onPress={close}>
            <Text color={MENU_DIM}>關閉</Text>
          </Button>
        </Box>,
      )
    }
  }
  const open = openMenu ? hits.find(h => h.what === openMenu) : undefined
  if (open && openMenu) {
    const items = menuFor(openMenu, mine)
    const at = menuPlace(open, [...items.map(i => i.label), 'Cancel'], menuOthers(open, hits, lastFixed), surface, k, sceneW)
    const close = () => {
      openMenu = null
      $.ui.invalidate('ui.render')
    }
    // 按下立刻重畫成「按下去」，0.15 秒後才做事（不然選單當場消失，看不到有按到）；連按只算一次
    const pressThen = (i: number, act: () => void) => {
      if (menuPressed !== undefined) return
      menuPressed = i
      $.ui.invalidate('ui.render')
      $.clock.after(MENU_PRESS_MS, () => { menuPressed = undefined; act() })
    }
    if (surface === 'desktop' && lastMenuHits.length === items.length + 1) {
      // 選單美術第三批 P1：外觀畫在 v2 的 SVG 裡（v2panel.ts menuSvg），這裡每顆按鈕疊一塊看不見的按鈕（照格子對齊）
      const cell = (r: V2MenuHit, key: string, onPress: () => void) => {
        const a = cellAt(r.x, r.y, surface, k), b = cellAt(r.x + r.w, r.y + r.h, surface, k)
        const cols = Math.max(1, b.left - a.left), rowsN = Math.max(1, b.top - a.top)
        return (
          <Box key={`at-${key}`} position="absolute" top={a.top} left={a.left} flexDirection="column">
            {Array.from({ length: rowsN }, (_, r2) => (
              <Button key={r2 === 0 ? key : `${key}-r${r2}`} plain label={(showHits ? '▒' : BLANK).repeat(cols)} onPress={onPress} />
            ))}
          </Box>
        )
      }
      out.push(
        <Box key="menu" position="absolute" top={0} left={0}>
          {items.map((it, i) => cell(lastMenuHits[i], `menu-${i}`, () => pressThen(i, () => { close(); void runButton($, { label: it.label, prompt: it.prompt }) })))}
          {cell(lastMenuHits[items.length], 'menu-cancel', () => pressThen(items.length, close))}
        </Box>,
      )
      return out
    }
    if (surface === 'desktop') {
      // 淺色不透明底＋金色圓角框＋標題列：一眼看得出是選單、跟場景分開
      out.push(
        <Box key="menu" position="absolute" top={at.top} left={at.left} flexDirection="column" backgroundColor={MENU_BG} borderStyle="round" borderColor={MENU_EDGE} paddingX={1}>
          <Text key="menu-title" bold color={MENU_TEXT}>{`▾ ${FURNITURE_NAMES[openMenu]}`}</Text>
          {items.map((it, i) => (
            <Button
              key={`menu-${i}`}
              label={it.label}
              onPress={() => {
                close()
                void runButton($, { label: it.label, prompt: it.prompt })
              }}
            >
              <Text color={MENU_TEXT} bold>{it.label}</Text>
            </Button>
          ))}
          <Button key="menu-cancel" label="Cancel" onPress={close}>
            <Text color={MENU_DIM}>Cancel</Text>
          </Button>
        </Box>,
      )
      return out
    }
    out.push(
      <Box key="menu" position="absolute" top={at.top} left={at.left} flexDirection="column">
        {items.map((it, i) => (
          <Button
            key={`menu-${i}`}
            label={it.label}
            onPress={() => {
              close()
              void runButton($, { label: it.label, prompt: it.prompt })
            }}
          />
        ))}
        <Button key="menu-cancel" label="Cancel" onPress={close} />
      </Box>,
    )
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
export type Profile = { role?: Role; name?: string; agent?: string; ref?: string; title?: string; titleAuto?: boolean; titleAt?: number; auto?: boolean; team?: string }
const PROFILE_KEYS = ['role', 'name', 'agent', 'ref', 'title', 'titleAuto', 'titleAt', 'auto', 'team'] as const

/** 合併兩份設定：$.store 有值就用它的，沒有才用狀態檔的。逐欄通用處理，新增欄位不會被漏掉 */
export function mergeProfile(saved: Profile | undefined, own: Profile | undefined): Profile | undefined {
  if (!saved && !own) return undefined
  const out: Record<string, unknown> = {}
  for (const k of PROFILE_KEYS) out[k] = saved?.[k] ?? own?.[k]
  return out as Profile
}

async function readOwnStatus($: EngineInterface, id: string): Promise<(Profile & { instance?: string; updatedAt?: number; left?: boolean; compacts?: number; newTokens?: number }) | undefined> {
  try {
    const raw = await $.fs.read(`${await sharedDir($)}/${id}.json`)
    const s = JSON.parse(typeof raw === 'string' ? raw : '{}')
    const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined)
    return { role: s.role === 'manager' || s.role === 'staff' ? s.role : undefined, name: str(s.name), agent: str(s.agent), ref: str(s.ref), title: str(s.title), titleAuto: s.titleAuto === true ? true : undefined, titleAt: typeof s.titleAt === 'number' ? s.titleAt : undefined, auto: s.auto === true ? true : undefined, team: str(s.team), compacts: typeof s.compacts === 'number' && s.compacts > 0 ? s.compacts : undefined, newTokens: typeof s.newTokens === 'number' && s.newTokens > 0 ? s.newTokens : undefined, instance: str(s.instance), updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : undefined, left: s.left === true }
  } catch {
    return undefined
  }
}

let fresh = false // 這個 session 編號沒有任何存過的身分（全新開的），預設登記檔只在這時套用

/** scripts/open_role.py 開角色時寫的 presets/<session>.json → office_profile 的參數；欄位錯的丟掉，由 applyProfile 驗 */
export function presetInput(raw: unknown): { role?: string; name?: string; title?: string; team?: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  const out: { role?: string; name?: string; title?: string; team?: string } = {}
  for (const k of ['role', 'name', 'title', 'team'] as const) if (typeof r[k] === 'string' && (r[k] as string).trim() !== '') out[k] = r[k] as string
  return Object.keys(out).length > 0 ? out : undefined
}

/** 全新 session 有預設登記檔就套用（resume 已有存檔，不蓋掉使用者後來改的） */
async function applyPreset($: EngineInterface) {
  if (!fresh || me.oneshot || me.id === 'me') return
  const f = `${officeRoot(await sharedDir($))}/presets/${me.id}.json`
  if (!(await $.fs.exists(f).catch(() => false))) return
  const raw = await $.fs.read(f).catch(() => undefined)
  const input = presetInput(typeof raw === 'string' ? (() => { try { return JSON.parse(raw) } catch { return undefined } })() : undefined)
  if (input) await applyProfile($, input)
}

/** Claude Code 自己的 ~/.claude/sessions/<pid>.json：在線 session 的現名與 /rename 前的舊名；hosted＝有 hostSessionId（Claude Desktop 代管的 session） */
export type CliSession = { sessionId: string; name?: string; formerNames: string[]; hosted?: true }
export function parseCliSession(raw: unknown): CliSession | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.sessionId !== 'string') return undefined
  const former = Array.isArray(r.formerNames) ? r.formerNames.map(f => (f && typeof f === 'object' ? (f as { name?: unknown }).name : undefined)).filter((n): n is string => typeof n === 'string' && n !== '') : []
  return { sessionId: r.sessionId, name: typeof r.name === 'string' && r.name !== '' ? r.name : undefined, formerNames: former, ...(typeof r.hostSessionId === 'string' && r.hostSessionId !== '' ? { hosted: true as const } : {}) }
}

/** /rename 之後要改的：自己的 agent 換成現名；team 指的名字已沒人用、卻是某個 session 的舊名 → 換成它的現名 */
export function renameFixes(me: { id: string; agent?: string; team?: string }, cli: CliSession[]): { agent?: string; team?: string } {
  const out: { agent?: string; team?: string } = {}
  const mine = cli.find(c => c.sessionId === me.id)
  if (mine?.name && mine.name !== me.agent) out.agent = mine.name
  if (me.team && !cli.some(c => c.name === me.team)) {
    const moved = cli.find(c => c.name && c.sessionId !== me.id && c.formerNames.includes(me.team as string))
    if (moved?.name) out.team = moved.name
  }
  return out
}

/**
 * Claude Code 自己的 sessions 資料夾：在這個 session 的設定資料夾（CLAUDE_CONFIG_DIR）裡，沒設才是 ~/.claude。
 * 2026-11-23 修：原本固定讀 ~/.claude/sessions，設了 CLAUDE_CONFIG_DIR 的對話（例：~/.claude-work）讀不到自己，
 * 跟不上改名；Remote Control 重開時開場登記到的暫時名稱（某個對話-d7）就一直留著，組員的 team 對不上
 */
export function cliSessionsDir(shared: string, configDir?: string): string {
  return configDir ? `${configDir.replace(/\\/g, '/').replace(/\/+$/, '')}/sessions` : `${officeRoot(shared).replace(/\/pixel-office$/, '')}/sessions`
}

async function cliSessions($: EngineInterface): Promise<CliSession[]> {
  const d = cliSessionsDir(await sharedDir($), configDir)
  const out: CliSession[] = []
  for (const entry of await $.fs.list(d).catch(() => [])) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    try {
      const raw = await $.fs.read(`${d}/${entry.name}`)
      const c = parseCliSession(JSON.parse(typeof raw === 'string' ? raw : '{}'))
      if (c) out.push(c)
    } catch {}
  }
  return out
}

/** 每 5 秒：跟上自己的 /rename，主管改名後把 team 接回去（jacky 2026-10-31：改名後關係圖長出舊名的空殼、人掛在空殼下） */
let lastCli: CliSession[] = [] // 最近一次讀到的 ~/.claude/sessions：信箱判斷收件名認不認得
async function followRename($: EngineInterface) {
  lastCli = await cliSessions($)
  // Desktop 代管的 session（start_session 開的、App 重開後在背景恢復的）沒被點開就收不到 session.attach，會一直被當成一次性對話、名單看不到。
  // CLI 自己的紀錄有 hostSessionId 才算：環境變數 CLAUDE_CODE_HOST_SESSION_ID 會被子行程（claude -p、open_role.py 舊版開的視窗）繼承，不能用（2026-11-14 實測）
  if (me.oneshot && me.id !== 'me' && lastCli.some(c => c.sessionId === me.id && c.hosted)) await attend($)
  if (me.id === 'me' || me.oneshot) return
  const fix = renameFixes(me, lastCli)
  if (fix.agent !== undefined || fix.team !== undefined) await applyProfile($, fix)
}

export { officeFor } from './officeV2' // 2026-11-23 搬到 officeV2.ts（手機版伺服器也要用：協作桌的協作資料夾）
import { officeFor } from './officeV2'

/** collab.md 骨架（skills/team/lead.md §2 的六段），主管列先填自己 */
export function collabSkeleton(manager: string, upper: string | undefined, at: string): string {
  return [
    '# 主管',
    '| 主管（ListAgents 名稱） | 範圍（使用者原話） | 上層 | 上線 |',
    '|---|---|---|---|',
    `| ${manager} | （待填） | ${upper ?? '—'} | ${at} |`,
    '# 在線',
    '| session | 角色 | 任務 | 上次回報 |',
    '|---|---|---|---|',
    '# 檔案佔用',
    '| 檔案（反引號路徑） | 佔用者 | 起始 YYYY-MM-DD |',
    '|---|---|---|',
    '# 待使用者裁示',
    '| # | 事項（一句） | 細節在哪 | 登記日 |',
    '|---|---|---|---|',
    '# 等外部回覆',
    '| # | 事項 | 等誰（不知道寫「未指明」） | 登記日 |',
    '|---|---|---|---|',
    '# 衝突紀錄',
    '| 時間 | 雙方 | 以誰為準、對方怎麼收尾 |',
    '|---|---|---|',
    '',
  ].join('\n')
}

// ---------- v2 辦公室（2026-11-22）：Desktop 面板跟手機版同一套版面與座位 ----------
// 座位表 office-<port>.json 由手機版伺服器（remote/server.ts）寫，這裡只讀（3 秒讀一次）：手機上拖人、改協作桌，面板跟著變。
// 沒開手機版伺服器時沒有這個檔：在記憶體裡照同一套規則排（團隊同桌、其餘坐辦公區），不寫檔
let v2Cache: { at: number; text?: string; port: number; base: string; handing?: number[]; meets?: { table: number; topic: string; ids: string[] }[] } = { at: -1e9, port: 8767, base: '' }
async function v2Seating($: EngineInterface, shown: Coworker[]) {
  const now = await $.clock.now()
  if (now - v2Cache.at > 3000) {
    const base = (await sharedDir($)).replace(/\/sessions$/, '')
    let port = 8767
    try { port = Number(JSON.parse(String(await $.fs.read(`${base}/remote.json`))).port) || 8767 } catch {}
    v2Cache = { at: now, text: await $.fs.read(`${base}/office-${port}.json`).then(String).catch(() => undefined), port, base, handing: handingTables(await $.fs.read(`${base}/handovers-${port}.json`).then(String).catch(() => undefined)), meets: tableMeetings(await $.fs.read(`${base}/meetings-${port}.json`).then(String).catch(() => undefined)) }
  }
  const S = parseStore(v2Cache.text)
  const list = v2List(shown)
  const { map } = assign(S, list, now)
  return { S, list, map, port: v2Cache.port, base: v2Cache.base }
}

/** 整桌開會中的桌（手機版伺服器 remote/meeting.ts 寫的 meetings-<port>.json）：面板桌牌「開會中」、參與的人頭上泡泡 */
export function tableMeetings(text: string | undefined): { table: number; topic: string; ids: string[] }[] {
  try {
    const j = JSON.parse(String(text))
    return (Array.isArray(j.meetings) ? j.meetings : []).filter((m: any) => m && m.state === 'on' && typeof m.table === 'number' && typeof m.topic === 'string').map((m: any) => ({ table: m.table, topic: m.topic, ids: Array.isArray(m.ids) ? m.ids.filter((x: unknown) => typeof x === 'string') : [] }))
  } catch {
    return []
  }
}

/** 換主管交接中的桌（手機版伺服器 remote/handover.ts 寫的 handovers-<port>.json）：面板桌牌寫「交接中」 */
export function handingTables(text: string | undefined): number[] {
  try {
    const j = JSON.parse(String(text))
    return (Array.isArray(j.handovers) ? j.handovers : []).filter((h: any) => h && typeof h.table === 'number' && h.state !== 'done' && h.state !== 'cancelled').map((h: any) => h.table)
  } catch {
    return []
  }
}

/** 桌子聊天室（第 12 項）：送達的傳話記到寄件人、收件人坐的協作桌（chat/<port>/t<桌號>/，一則一檔） */
async function logTableChat($: EngineInterface, to: string, text: string, now: number) {
  if (me.id === 'me' || me.oneshot || !text) return
  const all = everyone()
  const { list, map, port, base } = await v2Seating($, all)
  const target = findRecipient(all, to)
  const tables = chatTables(map, me.id, target?.id)
  if (!tables.length) return
  const plate = (id?: string) => list.find(p => p.id === id)?.plate
  const entry: ChatEntry = { at: now, from: { id: me.id, name: plate(me.id) ?? me.agent ?? me.name }, to: { ...(target ? { id: target.id } : {}), name: (target && plate(target.id)) ?? to.replace(/\s*\[[0-9a-f]+\]$/i, '') }, text: text.slice(0, CHAT_TEXT_MAX) }
  const name = chatFile(now, crypto.randomUUID().slice(0, 8))
  for (const t of tables) await $.fs.write(`${chatDir(base, port, t)}/${name}`, JSON.stringify(entry)).catch(() => undefined)
}

/** 共用筆記快照 → 面板的幾行字（唯讀）：待你決定在最上面，其次分工與進度、各人做到哪、交代、主管寫的、行政 */
export function notesLines(raw: unknown): string[] {
  let j: any
  try { j = JSON.parse(String(raw)) } catch { return [] }
  if (!j || !j.ok) return []
  const cut = (t: unknown, n = 60) => { const l = String(t ?? '').split('\n').find(x => x.trim())?.trim() ?? ''; return [...l].length > n ? [...l].slice(0, n).join('') + '…' : l }
  const out: string[] = [`📒 共用筆記${j.decide?.length ? `（🔴 待你決定 ${j.decide.length}）` : ''}`]
  for (const d of j.decide ?? []) out.push(`🔴 ${cut(d.text)}`)
  for (const t of j.tasks?.active ?? []) out.push(`📋 ${t.title}（${t.progress}）：${(t.parts ?? []).map((p: any) => `${p.who} ${p.stateZh}`).join('、')}`)
  for (const p of j.auto ?? []) out.push(`・${p.plate}：${p.doing}`)
  for (const p of j.progress ?? []) if (p.head) out.push(`✎ ${p.plate}：${cut(p.text)}`)
  for (const a of (j.asks ?? []).slice(-3)) out.push(`📝 ${cut(a)}`)
  if (!j.hasBoss) out.push('主管：這桌還沒有主管')
  else for (const p of j.bossPart?.parts ?? []) out.push(`${p.title}：${cut(p.text)}`)
  if (j.admin?.text) out.push(`行政：${cut(j.admin.text)}`)
  return out
}

/** 面板點桌牌看聊天室：讀那桌的紀錄（過期的跳過；外掛不能刪檔，清檔由手機版伺服器做） */
let tableChat: { id: number; at: number; items: ChatEntry[]; open: Set<number>; notes?: string[] } | null = null
async function loadTableChat($: EngineInterface, id: number) {
  const now = await $.clock.now()
  const { port, base, S } = await v2Seating($, everyone())
  if (!S.tables.some(t => t.id === id)) { tableChat = null; return }
  const d = chatDir(base, port, id), items: ChatEntry[] = []
  for (const entry of await $.fs.list(d).catch(() => [])) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    if (typeof entry.mtimeMs === 'number' && entry.mtimeMs > 0 && now - entry.mtimeMs > CHAT_KEEP_MS) continue
    const c = parseChat(await $.fs.read(`${d}/${entry.name}`).catch(() => undefined), now)
    if (c) items.push(c)
  }
  items.sort((a, b) => a.at - b.at)
  // 共用筆記（第 11 項，唯讀）：手機版伺服器寫的快照 notes/<port>-t<id>.view.json；沒開伺服器就沒有
  const notes = notesLines(await $.fs.read(`${base}/notes/${port}-t${id}.view.json`).catch(() => undefined))
  tableChat = { id, at: now, items: items.slice(-30), open: tableChat?.id === id ? tableChat.open : new Set(), notes }
}

/** Desktop v2 面板的名冊：座位、團隊照原名（name、agent、team）；名牌（plate）才套指令名→短代號（美術 A #14 複驗） */
export function v2List(shown: Coworker[]) {
  const people = chinesePlates(shown)
  const no = sameNameNumbers(people)
  return people.map(c => ({ id: c.id, plate: shownName(c) + (no.get(c.id) ?? ''), name: c.name, mode: c.mode, role: c.role, kind: c.kind, agent: c.agent, team: c.team, approval: c.approval?.tool, species: species(c) }))
}

async function v2Svg($: EngineInterface, shown: Coworker[], pxWidth: number, pxHeight: number, oneshots: { label: string; n: number }[], menu?: V2Opts['menu']) {
  const { S, list, map } = await v2Seating($, shown)
  const handing = v2Cache.handing ?? [], meets = v2Cache.meets ?? []
  const inMeet = new Set(meets.flatMap(m => m.ids))
  return v2PanelSvg(list.map(p => ({ ...p, seat: map.get(p.id), ...(inMeet.has(p.id) ? { meeting: true } : {}) })), tablesOut(S, list, map).map(t => { const m = meets.find(x => x.table === t.id); return { ...t, ...(handing.includes(t.id) ? { handover: true } : {}), ...(m ? { meeting: m.topic } : {}) } }), { frame, night: nightMode, pxWidth, pxHeight, planes, planeFrames: PLANE_FRAMES, notices, oneshots, menu })
}

/** 同桌（roadmap 第 1 項）：session id → 坐的協作桌（桌牌字），名單的「同桌」欄用；讀不到座位表就照同一套規則在記憶體排 */
async function tableSeating($: EngineInterface, list: Coworker[]): Promise<Map<string, string>> {
  const { S, list: seated, map } = await v2Seating($, list)
  const out = new Map<string, string>()
  // 缺主管的桌（第 5 項）：桌名後面標出來，名單上一眼看得到
  for (const t of tablesOut(S, seated)) {
    const sit = atTable(t.id, seated, map)
    for (const p of sit) out.set(p.id, needsBoss(sit) ? `${t.label} ⚠ no manager (缺主管)` : t.label)
  }
  return out
}

async function officeDir($: EngineInterface): Promise<string> {
  const main = (await $.session.repo().catch(() => null))?.root ?? (await $.session.cwd())
  const raw = await $.fs.read(`${officeRoot(await sharedDir($)).replace(/\/pixel-office$/, '')}/office/projects.json`).catch(() => undefined)
  let projects: unknown
  try {
    projects = typeof raw === 'string' ? JSON.parse(raw) : undefined
  } catch {}
  return officeFor(main, projects)
}

const localStamp = (ms: number) => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 升層時補 collab.md：目錄已在、collab.md 不在才寫（jacky 2026-10-31：模型寫 .claude/ 會被權限擋，3 次全失敗）；回給模型看的一句 */
async function ensureCollab($: EngineInterface, manager: string, upper: string | undefined): Promise<string> {
  const office = await officeDir($)
  if (!(await $.fs.exists(office).catch(() => false))) return `collab dir ${office} does not exist yet: create it per skill pixel-office:team, or map this repo in ~/.claude/office/projects.json`
  const file = `${office}/collab.md`
  if (await $.fs.exists(file).catch(() => false)) return `${file} exists: read its 主管 section per skill pixel-office:team`
  await $.fs.write(file, collabSkeleton(manager, upper, localStamp(await $.clock.now())))
  return `created ${file} (skeleton, you are in 主管; fill your scope there)`
}

// ---------- 檢查點（jacky 2026-10-31：全員下線後接不上；只靠 skill 叫模型寫，常忘、寫 .claude/ 又會被權限擋） ----------
export const CP_REMIND_MS = 60 * 60000 // 持有角色、做了事、這麼久沒存 → 下一則指令提醒一次
export const cpNote = (file: string) =>
  `Pixel office: you hold a role and have not saved a checkpoint for an hour. At a good stopping point append one entry to ${file} (skill pixel-office:team roles.md §4: done / blocked / next step).`
export const CP_COMPACT_NOTE = 'Keep in the summary, for the role this session holds: what is done (commits or files), what is blocked, and the next step.'

/** 該不該提醒存檢查點：上次存（或開工）後做過事、滿一小時、這段還沒提醒過 */
export const checkpointDue = (worked: boolean, base: number, now: number, noted: boolean) => worked && !noted && now - base >= CP_REMIND_MS

/** 下線時外掛代寫的那筆：只寫看得到的事實（最後指令、怎麼接回對話），不猜做到哪 */
export function autoCheckpoint(at: string, who: string, prompt: string | undefined, sessionId: string, cwd: string): string {
  return [
    `## ${at} ${who}（自動：下線前沒存）`,
    `- 最後指令：${prompt ?? '（沒有記錄）'}`,
    `- 對話：claude --resume ${sessionId}（在 ${cwd}）`,
    '- 下一步：先 resume 讀對話末段，或問主管',
    '',
  ].join('\n')
}

let cpCache: { key: string; file?: string } | undefined
let cpBase = 0 // 開工或上次存檢查點的時間
let cpWorked = false // cpBase 之後有沒有用過工具
let cpNoted = false

/** 這個 session 持有哪張角色卡：agent（ListAgents 名稱）或 title 任一個對得到 roles/<名>.md；agent 優先（title 常被改成任務名） */
export async function heldRole(names: (string | undefined)[], exists: (name: string) => Promise<boolean>): Promise<string | undefined> {
  for (const n of names) if (n && (await exists(n).catch(() => false))) return n
  return undefined
}

/** 角色卡 frontmatter 寫 layer: 2（小隊卡：只放怎麼做、不留狀態） */
export const isLayer2 = (card: string) => /^---\r?\n[\s\S]*?^layer:\s*2\s*$[\s\S]*?^---/m.test(card)

/** 自己持有的角色的檢查點檔；找到過就記住，之後 title 怎麼改都不丟（只有 agent／title 換了又找不到時才沿用舊的） */
async function checkpointFile($: EngineInterface): Promise<string | undefined> {
  if (me.oneshot || me.id === 'me' || (!me.title && !me.agent)) return undefined
  const key = `${me.agent ?? ''}|${me.title ?? ''}`
  if (cpCache?.key !== key) {
    const office = await officeDir($).catch(() => undefined)
    const role = office ? await heldRole([me.agent, me.title], n => $.fs.exists(`${office}/roles/${n}.md`)) : undefined
    // 第 2 層（小隊卡）不存檢查點：不提醒、/compact 不要求摘要、下線不補寫（jacky 2026-11-08）
    const card = role ? await $.fs.read(`${office}/roles/${role}.md`).then(t => (typeof t === 'string' ? t : ''), () => '') : ''
    cpCache = { key, file: role && isLayer2(card) ? undefined : role ? `${office}/checkpoints/${role}.md` : cpCache?.file }
  }
  return cpCache.file
}

/** 檔案比 cpBase 新＝剛存過：重新起算 */
async function syncCheckpoint($: EngineInterface): Promise<string | undefined> {
  const file = await checkpointFile($)
  if (!file) return undefined
  const st = await $.fs.stat(file).catch(() => undefined)
  if (st && st.mtimeMs > cpBase) {
    cpBase = st.mtimeMs
    cpWorked = false
    cpNoted = false
  }
  return file
}

async function writeAutoCheckpoint($: EngineInterface) {
  const file = await syncCheckpoint($)
  if (!file || !cpWorked) return
  // 整檔覆寫（$.fs 沒有 append）：讀失敗（被鎖、讀一半）時寫下去會洗掉歷史，所以只有檔案不存在才從標題起，其他讀不到就不寫
  const body = (await $.fs.exists(file).catch(() => true)) ? await $.fs.read(file).then(t => (typeof t === 'string' ? t : undefined)).catch(() => undefined) : `# ${file.split('/').pop()!.replace(/\.md$/, '')} 檢查點\n`
  if (body === undefined) return
  const entry = autoCheckpoint(localStamp(await $.clock.now()), me.agent ?? me.name, me.prompt?.text, me.id, await $.session.cwd())
  await $.fs.write(file, `${body}${body.endsWith('\n') ? '' : '\n'}\n${entry}`)
}

// ---------- 離線信箱（jacky 2026-10-31：對方重開就收不到，SendMessage 不落地，ENOINBOX） ----------
// ~/.claude/pixel-office/mail/<時間>-<亂數>.json，一封一檔。$.fs 沒有搬移／刪除，狀態寫在檔裡：pending → claimed（誰、何時）→ done
export type Mail = { from: string; to: string; text: string; at: number; state: 'pending' | 'claimed' | 'done'; by?: string; claimedAt?: number; note?: string; match?: 'agent' } // match＝agent：只能用 ListAgents 名稱領（0.63.45 成組通知；職稱可能跟別人的名稱同字）
export const MAIL_TTL_MS = 24 * 3600000 // 超過一天沒人收就作廢
export const MAIL_CLAIM_MS = 30000 // 別人認領後這麼久沒送完，可以接手

/** 送不到的原因裡，這些不存信箱：同名多人（要帶 ref）、對方拒收、hook 擋下 */
export const shouldMail = (reason: string) => !/several|multiple|ambiguous|\[ref\]|refus|declin|denied|hook|not allowed/i.test(reason)

/** 收件名對得到這個人：ListAgents 名稱或職稱（角色名：換人接手也收得到） */
export const mailMatches = (to: string, c: { agent?: string; title?: string }, match?: 'agent') => to === c.agent || (match !== 'agent' && to === c.title)

/** 這一輪對這封信做什麼：claim 先寫認領、下一輪確認還是自己的才 send（多個視窗同時看到時只送一次） */
export function mailStep(m: Mail, mine: string, now: number): 'claim' | 'send' | 'skip' | 'expire' {
  if (m.state === 'done') return 'skip'
  if (now - m.at > MAIL_TTL_MS) return 'expire'
  if (m.state === 'claimed' && m.by === mine) return 'send'
  if (m.state === 'claimed' && typeof m.claimedAt === 'number' && now - m.claimedAt < MAIL_CLAIM_MS) return 'skip'
  return 'claim'
}

export function parseMail(raw: unknown): Mail | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.from !== 'string' || typeof r.to !== 'string' || typeof r.text !== 'string' || typeof r.at !== 'number') return undefined
  const state = r.state === 'claimed' || r.state === 'done' ? r.state : 'pending'
  return { from: r.from, to: r.to, text: r.text, at: r.at, state, by: typeof r.by === 'string' ? r.by : undefined, claimedAt: typeof r.claimedAt === 'number' ? r.claimedAt : undefined, note: typeof r.note === 'string' ? r.note : undefined, ...(r.match === 'agent' ? { match: 'agent' as const } : {}) }
}

export const mailText = (m: Mail, at: string) => `[Pixel office mailbox] ${m.from} sent this at ${at} while you were offline; reply with SendMessage to ${m.from}.\n\n${m.text}`

const mailDir = async ($: EngineInterface) => `${officeRoot(await sharedDir($))}/mail`

async function readMail($: EngineInterface): Promise<{ file: string; m: Mail }[]> {
  const d = await mailDir($)
  const now = await $.clock.now()
  const out: { file: string; m: Mail }[] = []
  for (const entry of await $.fs.list(d).catch(() => [])) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    if (typeof entry.mtimeMs === 'number' && entry.mtimeMs > 0 && now - entry.mtimeMs > MAIL_TTL_MS + MAIL_CLAIM_MS) continue // 信箱只增不減（$.fs 不能刪）：過期的連讀都不讀
    try {
      const raw = await $.fs.read(`${d}/${entry.name}`)
      const m = parseMail(JSON.parse(typeof raw === 'string' ? raw : '{}'))
      if (m && m.state !== 'done') out.push({ file: `${d}/${entry.name}`, m })
    } catch {}
  }
  return out
}

async function statusFiles($: EngineInterface): Promise<Record<string, unknown>[]> {
  const d = await sharedDir($)
  const out: Record<string, unknown>[] = []
  for (const entry of await $.fs.list(d).catch(() => [])) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json')) continue
    try {
      out.push(JSON.parse(String(await $.fs.read(`${d}/${entry.name}`))))
    } catch {}
  }
  return out
}

/** 這個名稱認不認得：在線的人、Claude Code 記的現名與舊名（followRename 每 5 秒讀的那份）；都不是 → 多半打錯字，提示模型確認。
 *  不掃辦公室全部狀態檔（2026-10-31 有 458 個，掃完 SendMessage 的結果早就回了，提示貼不上） */
const knownName = (name: string) =>
  name.startsWith('uds:') || [me, ...others].some(c => mailMatches(name, c)) || lastCli.some(c => c.name === name || c.formerNames.includes(name))

/** SendMessage 的收件者 → 信箱收件名：uds 位址查辦公室狀態檔換成名稱（程序重開位址就變），名稱去掉 [ref] */
async function mailName($: EngineInterface, to: string): Promise<string | undefined> {
  const t = to.trim().replace(/\s*\[[0-9a-f]+\]$/i, '')
  if (!t.startsWith('uds:')) return t || undefined
  const s = (await statusFiles($)).find(f => f.addr === t)
  return typeof s?.agent === 'string' ? s.agent : typeof s?.title === 'string' ? s.title : undefined
}

const mailSaved = new Map<string, boolean>() // 這一輪存進信箱的收件者（mailKey）→ 認不認得這個名稱；一輪可能平行送好幾封
const mailKey = (to: string) => to.trim().replace(/\s*\[[0-9a-f]+\]$/i, '')
export const mailSavedNote = (to: string, known = true) =>
  `Pixel office saved this message to its mailbox for ${to}: it is delivered when a session named or titled ${to} is next online (within 24 h). No need to resend or write a peer-reply file.` +
  (known ? '' : ` Note: no session in the office has ever used the name or title ${to}; if it may be misspelled, check office_roster and resend to the right name.`)

/** 每 5 秒：給自己的信由自己的外掛送進自己的對話（$.prompt.submit，閒著也會開始一輪）。
 *  不由別的視窗 $.session.send 轉交：auto 模式下計時器發起的送信會被分類器拒（「the request that produced this action did not ask for one」，0.42.0 真視窗實測） */
async function deliverMail($: EngineInterface) {
  if (me.oneshot || me.id === 'me') return
  const now = await $.clock.now()
  for (const { file, m } of await readMail($)) {
    const step = mailStep(m, instance, now)
    if (step === 'expire') await $.fs.write(file, JSON.stringify({ ...m, state: 'done', note: 'expired' }))
    if (!mailMatches(m.to, me, m.match) || step === 'skip' || step === 'expire') continue
    if (step === 'claim') {
      // 先認領、下一輪還是自己的才送：同一個名稱或職稱有兩個視窗時只送一次
      await $.fs.write(file, JSON.stringify({ ...m, state: 'claimed', by: instance, claimedAt: now }))
      continue
    }
    await $.fs.write(file, JSON.stringify({ ...m, state: 'done', note: `submitted to ${me.agent ?? me.id}` }))
    await $.prompt.submit({ text: mailText(m, localStamp(m.at)) }).catch(err => $.fs.write(file, JSON.stringify({ ...m, state: 'pending', by: undefined, claimedAt: undefined, note: `submit failed: ${String(err)}` })))
  }
}

/** 給自己的信，有指令進來時（使用者或 peer 先開口）直接附在 context，不等 5 秒那一輪 */
async function takeOwnMail($: EngineInterface): Promise<string[]> {
  if (me.oneshot || me.id === 'me') return []
  const now = await $.clock.now()
  const texts: string[] = []
  for (const { file, m } of await readMail($)) {
    if (!mailMatches(m.to, me, m.match)) continue
    const step = mailStep(m, instance, now)
    if (step === 'skip' || step === 'expire') continue
    await $.fs.write(file, JSON.stringify({ ...m, state: 'done', note: `read by ${me.agent ?? me.id}` }))
    texts.push(mailText(m, localStamp(m.at)))
  }
  return texts
}

/** 依 session 編號載入身分（名牌、角色、職稱…）：session.start 一次，/resume、/clear 換了編號再一次 */
async function adopt($: EngineInterface, id: string) {
  await clearApproval($, id).catch(() => undefined) // 上次當掉留下的殘檔
  collisionWarned = false // 換了對話：撞號重新偵測
  dupNoted = false
  defaultName = launchPlate(launchName) ?? (isCommandName(launchName) ? shortCode(id) : plateName(await $.session.cwd(), id)) // 啟動名是指令：用短代號（審查 ④，跟伺服器、面板同一條）
  me = { id, name: defaultName, mode: 'idle', tool: '', isMe: true, role: 'staff', ...(oneshotRun ? { oneshot: true, label: launchName } : {}) }
  // 先讀 $.store；讀不到（例如同一 session 載了兩份 MOD、各自的儲存區不同）就用自己的狀態檔當備援
  const stored = (await $.store.get(`profile:${id}`).catch(() => undefined)) as Profile | undefined
  const ownRaw = await readOwnStatus($, id)
  const clash = isCollision(ownRaw, instance, await $.clock.now())
  if (clash) warnCollision($)
  const own = clash ? undefined : ownRaw // 撞號時不繼承另一個視窗的設定（例：拿到別人的「協作主管」職稱）
  const saved = mergeProfile(stored, own)
  if (own?.compacts) me = { ...me, compacts: own.compacts } // 壓縮次數接著算（resume 不歸零）
  if (own?.newTokens) me = { ...me, newTokens: own.newTokens } // 換檔（/clear）前先沿用，下一次加總會換成新檔的
  fresh = !saved
  if (saved?.role === 'manager' || saved?.role === 'staff') me = { ...me, role: saved.role }
  if (typeof saved?.name === 'string' && validName(saved.name)) me = { ...me, name: saved.name }
  const savedAgent = (saved as { agent?: unknown } | undefined)?.agent
  if (typeof savedAgent === 'string' && savedAgent.length > 0) me = { ...me, agent: savedAgent }
  const savedRef = (saved as { ref?: unknown } | undefined)?.ref
  if (typeof savedRef === 'string' && savedRef.length > 0) me = { ...me, ref: savedRef }
  if (saved?.auto === true) me = { ...me, auto: true }
  const savedTeam = (saved as { team?: unknown } | undefined)?.team
  if (typeof savedTeam === 'string' && savedTeam.length > 0) me = { ...me, team: savedTeam }
  const savedTitle = (saved as { title?: unknown } | undefined)?.title
  if (typeof savedTitle === 'string' && savedTitle.length > 0) {
    // 舊版沒記設定時間：從現在起算，30 分鐘後才算過期
    me = { ...me, title: savedTitle, titleAuto: saved?.titleAuto === true ? true : undefined, titleAt: typeof saved?.titleAt === 'number' ? saved.titleAt : await $.clock.now() }
  }
}

/** /resume、/clear 後 process 換到新的 session 編號，但不會再跑 session.start：舊檔標離開，改用新編號的身分 */
async function followSession($: EngineInterface) {
  if (me.id === 'me') return
  const id = await $.session.id()
  if (id === me.id) return
  await publish($, true).catch(() => undefined)
  await adopt($, id)
}

const meetingFile = (sessionsDir: string) => `${sessionsDir.replace(/\/sessions$/, '')}/meeting.json`

/** 開會／散會：寫 meeting.json，各視窗每秒讀一次，參與者走進會議室、散會走回座位（只是畫面） */
async function setMeeting($: EngineInterface, input: { action?: unknown; topic?: unknown; participants?: unknown; minutes?: unknown }): Promise<string> {
  const file = meetingFile(await sharedDir($))
  if (input.action === 'end') {
    await $.fs.write(file, JSON.stringify({ until: 0 }))
    return 'Meeting ended: participants walk back to their desks.'
  }
  const people = Array.isArray(input.participants) ? input.participants.filter((x): x is string => typeof x === 'string').map(x => x.trim()).filter(x => x.length > 0) : []
  if (people.length === 0) return 'List participants (their ListAgents names or nameplates).'
  // 預設不設期限：散會靠 action=end，或參與者全都離線
  const minutes = typeof input.minutes === 'number' && input.minutes > 0 ? input.minutes : undefined
  const topic = typeof input.topic === 'string' ? input.topic.slice(0, 60) : ''
  await $.fs.write(file, JSON.stringify({ until: minutes ? (await $.clock.now()) + minutes * 60000 : Number.MAX_SAFE_INTEGER, topic, participants: people }))
  return `Meeting: ${people.join(', ')} walk into the meeting room; ${minutes ? `ends automatically in ${minutes} min, ` : ''}end it with action=end (it also ends when all participants go offline).`
}

// 把自己的狀態寫到共用資料夾：一個 session 一個檔，不會互相覆蓋
let ownAddr = ''
async function publish($: EngineInterface, left: boolean) {
  const d = await sharedDir($)
  // 自己的回信位址：舊版 Claude Code 沒有這個變數，名單照舊顯示「未登記」；讀到才快取
  if (!ownAddr) {
    const sock = await $.env.get('CLAUDE_CODE_MESSAGING_SOCKET')
    if (sock) ownAddr = `uds:${sock}`
  }
  if (ownAddr) me = { ...me, addr: ownAddr }
  const updatedAt = await $.clock.now()
  lastWriteAt = updatedAt
  await $.fs.write(`${d}/${me.id}.json`, JSON.stringify({ instance, id: me.id, name: me.name, role: me.role, mode: me.mode, tool: me.tool, agent: me.agent, ref: me.ref, title: me.title, titleAuto: me.titleAuto, titleAt: me.titleAt, addr: me.addr, since: me.since, lastError: me.lastError, prompt: me.prompt, office: me.office, approve: me.office && approveOn ? true : undefined, approval: me.approval, auto: me.auto, team: me.team, blocked: me.blocked, errand: me.errand, sentTo: me.sentTo, sentAt: me.sentAt, gotAt: me.gotAt, oneshot: me.oneshot, configDir, dup: me.dup, label: me.label, ctxPct: me.ctxPct, compacts: me.compacts, newTokens: me.newTokens, ver: VERSION, loadedAt: LOADED_AT, updatedAt, left }))
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
  idle: 'idle',
  thinking: 'thinking',
  typing: 'typing',
  reading: 'reading',
  error: 'error',
  done: 'just finished',
  waiting: 'waiting for permission',
  blocked: 'blocked by permission',
}

/** 同一個 ListAgents 名稱有兩個以上 session 時，SendMessage 必須帶 [ref]：直接給可貼的字串，省一次 ListAgents */
function clashNotes(list: Coworker[]): string[] {
  const byAgent = new Map<string, Coworker[]>()
  for (const c of list) if (c.agent !== undefined) byAgent.set(c.agent, [...(byAgent.get(c.agent) ?? []), c])
  const out: string[] = []
  for (const [agent, group] of byAgent) {
    if (group.length < 2) continue
    const addrs = group.map(c => (c.ref ? `${agent} [${c.ref}] (${c.name})` : `${c.name}: ref not registered, ask it to run ListAgents once`))
    out.push(`🔴 Name clash: ${group.length} sessions are all called ${agent}; SendMessage needs the ref → ${addrs.join(', ')}`)
  }
  return out
}

const TITLE_STALE_MS = 30 * 60000 // title 超過這麼久沒更新、又來新指令 = 可能換了工作
const ERROR_SHOWN_MS = 10 * 60000 // 錯誤摘要在名單上留這麼久
/** 本外掛版號，＝ .claude-plugin/plugin.json 的 version（升版兩處一起改；測試讀不到 json，沒有自動比對） */
export const VERSION = '0.63.61'

// 系統提示那段（英文較省 token；2026-10-31 jacky 裁示從 900 縮到約 340 字元：細節在 skill 與工具說明）
export const ROLE_SECTION =
  'Pixel office (a pane drawing every session): ListAgents registers you. Keep your title (max 16 chars) = current task with mcp__pixel-office__office_profile; auto mode -> auto=true; dispatched by a manager -> team=<its ListAgents name>, done -> team=off. Find people: mcp__pixel-office__office_roster; not online, or asked to open/call a role -> skill pixel-office:team roles.md §5 (find the role card first). Multi-session work: skill pixel-office:team.'
// prompt.compose 被別的 mod 跳過時（2026-11-14 實測：Desktop 代管的 session 被 cc-plugin-sec-default 跳過，系統提示沒有這段），
// 第一則指令改塞進 context 一次。compose 在 submit 之前跑（D1 的通知時間 compose 04:31:22.045、UserPromptSubmit 22.419），有跑過就不塞，不會重複
let composeSeen = false
let roleNoted = false
export const roleNoteDue = (composeSeen: boolean, noted: boolean) => !composeSeen && !noted
const CHANGELOG_URL = 'https://github.com/Q00jkf/pixel-office/blob/main/CHANGELOG.md'
export const cmpVersion = (a: string, b: string) => {
  const x = a.split('.').map(n => parseInt(n, 10) || 0), y = b.split('.').map(n => parseInt(n, 10) || 0) // 0.61.0-beta、壞字串也比得出來
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0)
  return 0
}
/** ~/.claude/pixel-office/version.json 記整台電腦見過的最新版。沒有這個檔＝從 0.60.0 以前的版本升上來（或第一次裝），也提醒；升版後第一則指令提醒一次（寫回新版號，別的視窗就不再提）；
 *  這個視窗跑的版本比記的舊＝開著的舊視窗，提醒重開（不改檔） */
export function versionNote(seen: string | undefined, mine = VERSION): { note?: string; write: boolean } {
  const from = seen ?? 'a version before 0.60.0 (or a fresh install)'
  const d = seen ? cmpVersion(mine, seen) : 1
  if (d > 0) return { write: true, note: `Pixel office was updated ${from} -> ${mine}. Tell the user in one line, and read the 升級要做的 lines of the versions after ${seen ?? 'theirs'} in CHANGELOG.md (in this plugin's folder, or ${CHANGELOG_URL}); if a step applies to this computer, ask the user before doing it. Other open windows still run the old version until restarted.` }
  if (d < 0) return { write: false, note: `Pixel office: this window runs ${mine} but ${seen} is installed. Tell the user once that this window should be restarted to use it.` }
  return { write: false }
}

export const DEMOTE_MS = 20 * 60000 // 主管底下沒有在線員工滿這麼久 → 下一則使用者指令附降層提醒（jacky 2026-10-29）
export const DUP_NOTE =
  'Pixel office: another window is running this same conversation (same session id, usually a second claude --resume). Stop and tell the user to close one window; both copies write the same checkpoint and office record, and messages reach either one.'
export const DEMOTE_NOTE =
  "Pixel office: you are registered as manager but nobody online has had team=you for 20 minutes. If multiple sessions are no longer needed, ask the user whether to step down (office_profile role=staff, then clear collab.md's 在線 rows per skill pixel-office:team). If windows are only closed for now, keep as is. Don't change it yourself."
export const PROMOTE_NOTE =
  "Pixel office: someone online now has team=you (opened as your squad member), but you are registered as staff, so the office draws them outside any team. Step up to department lead now without asking: office_profile role=manager with team=<your current manager>, add your row to collab.md and tell your manager, per skill pixel-office:team squad.md §2."
let promoteNoted = false // 這次有人掛到我底下已經提醒過升部門主管
let reportsSeenAt: number | undefined // 最後一次看到有人掛在我底下（或我還不是主管）的時間
let demoteNoted = false // 這段沒人的期間已經提醒過
let versionChecked = false // 這個視窗已比對過版號（versionNote）
let dupNoted = false // 撞號只提醒模型一次

/** 有沒有在線的人掛在 self 底下（team 對到 ListAgents 名稱或名牌） */
export const hasReports = (self: Coworker, others: Coworker[]) => others.some(c => c.team !== undefined && (c.team === self.agent || c.team === self.name))

/** 該不該附降層提醒：主管、底下沒人滿 DEMOTE_MS（只提醒，不自動改；外掛不主動） */
export const shouldRemindDemote = (role: Coworker['role'], seenAt: number | undefined, now: number, noted: boolean) =>
  role === 'manager' && !noted && seenAt !== undefined && now - seenAt >= DEMOTE_MS

/** 該不該附升部門主管提醒：還是員工、有人掛在我底下（從團隊視窗叫出小隊成員時會這樣）、自己不是小隊成員；升了或底下沒人就重新算 */
export const shouldRemindPromote = (self: Coworker, others: Coworker[], noted: boolean) =>
  self.role !== 'manager' && !noted && hasReports(self, others) &&
  // 只有 2 層：自己已是部門主管底下的小隊成員就不升（底下的人該改掛部門主管，squad.md §2）
  !others.some(m => self.team !== undefined && (self.team === m.agent || self.team === m.name) && isDeptLead(m, [self, ...others]))

/** 錯誤訊息 → 名單用的一行摘要：第一個非空行、空白壓成一格、最多 80 字 */
export function summarizeError(text: string): string {
  const line = text.split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).find(l => l.length > 0) ?? ''
  return [...line].slice(0, 80).join('')
}

/** 使用者指令 → 前 16 字（換行壓成空白）；slash 指令與空白不算，回 undefined */
export function promptHead(text: string): string | undefined {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length === 0 || t.startsWith('/')) return undefined
  return [...t].slice(0, 16).join('')
}

/** 只有使用者自己打的（終端機 Enter、Remote Control）算指令；peer 訊息、排程、通知不算 */
export const isUserPrompt = (kind: string) => kind === 'composer' || kind === 'bridge'

/** 收到新指令時 title 要不要自動換：沒有 title，或自動帶的已放超過 30 分鐘；手動設的永遠不換（主管 2026-10-26 裁示） */
export function autoTitleDue(c: Pick<Coworker, 'title' | 'titleAuto' | 'titleAt'>, now: number): boolean {
  if (!c.title) return true
  return c.titleAuto === true && now - (c.titleAt ?? 0) > TITLE_STALE_MS
}

/** 手動 title 過期：超過 30 分鐘沒更新，之後又收到新指令（名單標「N 分前設」並附最新指令） */
export function titleStale(c: Pick<Coworker, 'title' | 'titleAuto' | 'titleAt' | 'prompt'>): boolean {
  return !!c.title && !c.titleAuto && c.titleAt !== undefined && c.prompt !== undefined && c.prompt.at - c.titleAt > TITLE_STALE_MS
}

/** 名單「目前」欄：等核准幾秒、等輸入、出錯附摘要 */
function doingText(c: Coworker, now: number): string {
  if (c.blocked) return `🔴 blocked (${c.blocked.tool}) for ${Math.max(0, Math.round((now - c.blocked.at) / 60000))} min; the user must say "allow" in its window`
  const secs = c.since !== undefined ? Math.max(0, Math.round((now - c.since) / 1000)) : undefined
  if (c.mode === 'waiting') return `🟡 awaiting approval${secs !== undefined ? ` ${secs}s` : ''} (${c.tool})${c.approval ? ' · reviewable in office panel' : ''}`
  if (c.mode === 'error') return `error (${c.tool})${c.lastError ? `: ${c.lastError.text}` : ''}`
  // 出錯後停下來等人（done → idle）最需要看到錯誤：等輸入也附上次出錯
  const base =
    c.mode === 'idle' || c.mode === 'done'
      ? `${c.mode === 'done' ? 'just finished, ' : ''}waiting for input${c.mode === 'idle' && secs !== undefined && secs >= 60 ? ` (${Math.round(secs / 60)} min)` : ''}`
      : c.mode === 'typing' || c.mode === 'reading'
        ? `${MODE_LABEL[c.mode]} (${c.tool})`
        : MODE_LABEL[c.mode] ?? c.mode
  return c.lastError && now - c.lastError.at < ERROR_SHOWN_MS ? `${base} · last error ${Math.round((now - c.lastError.at) / 60000)} min ago: ${c.lastError.text}` : base
}

/** 名單的 ctx 欄：「62%」或「62% ·壓縮 2」；都沒有 — */
export const ctxText = (c: Pick<Coworker, 'ctxPct' | 'compacts'>): string =>
  c.ctxPct === undefined && !c.compacts ? '—' : `${c.ctxPct === undefined ? '?' : `${c.ctxPct}%`}${c.compacts ? ` ·compacted ${c.compacts}` : ''}`

/** 辦公室名單（/office who 與 office_roster 共用）：主管在前，其餘依名牌 */
export function roster(list: Coworker[], now: number, oneshot: { label: string; n: number }[] = [], sortBy?: 'tokens', seated?: Map<string, string>): string {
  const tableOf = seated?.size ? seated : undefined // 沒有人坐協作桌就不多這一欄
  const extra = oneshot.length > 0 ? `\nOne-shot conversations (claude -p, not listed): ${oneshotText(oneshot)}` : ''
  if (list.length === 0) return `Nobody in the office right now.${extra}`
  const sorted = [...list].sort(sortBy === 'tokens' ? (a, b) => (b.newTokens ?? -1) - (a.newTokens ?? -1) || a.name.localeCompare(b.name) : (a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'manager' ? -1 : 1))
  const rows = sorted.map(c => {
    const stale = titleStale(c)
    const doing = doingText(c, now) + (stale ? ` · latest prompt "${c.prompt!.text}"` : '')
    const title = !c.title ? '—' : c.titleAuto ? `${c.title} (auto)` : stale ? `${c.title} (set ${Math.round((now - c.titleAt!) / 60000)} min ago)` : c.title
    const agent = c.kind === 'codex' ? `Codex: \`python ~/.claude/pixel-office/codex/codex_office.py send ${c.name} "…" --from <your name>\` (answers right away when idle)` : c.kind === 'agy' ? `Antigravity: \`python ~/.claude/pixel-office/agy/agy_office.py send ${c.name} "…" --from <your name>\` (delivered on its next action)` : c.agent ?? (c.addr ? `(no name) SendMessage with \`to=${c.addr}\`` : '(not registered, messages cannot reach it)')
    return `| ${c.isMe ? '▶ ' : ''}${c.name} | ${title} |${tableOf ? ` ${tableOf.get(c.id) ?? '—'} |` : ''} ${c.role !== 'manager' ? 'staff' : isDeptLead(c, list) ? 'dept lead' : 'manager'}${c.auto ? ' (auto)' : ''}${c.team ? ` · under ${c.team}` : ''} | ${agent} | ${c.ref ?? '—'} | ${ctxText(c)} | ${fmtTokens(c.newTokens)} | ${doing} |`
  })
  const blockedNames = sorted.filter(c => c.blocked).map(c => c.name)
  const asking = sorted.filter(c => c.approval && now < c.approval.deadline)
  const head = [
    // 等核准的單最醒目：放第一行，只剩幾秒能按
    ...(asking.length > 0 ? [`🟡🟡 Waiting for your approval (open the office panel, press "Review <name>"): ${asking.map(c => `${c.name} (${c.approval!.tool}, ${Math.max(0, Math.ceil((c.approval!.deadline - now) / 1000))}s left)`).join(', ')}`] : []),
    `Pixel office roster (${list.length} online, ${new Date(now).toISOString().slice(11, 19)} UTC)`,
    ...(blockedNames.length > 0 ? [`🔴 Blocked: ${blockedNames.join(', ')} (the user must say "allow" in each window; relaying from another session does not work)`] : []),
    ...clashNotes(sorted),
    ...sorted.filter(c => c.dup).map(c => `🔴 ${c.agent ?? c.name}: the same conversation is open in two windows (claude --resume of one session); they overwrite each other and look like one person here. Ask the user to close one.`),
    `| Name | Title |${tableOf ? ' Table |' : ''} Role | ListAgents name (for SendMessage) | ref | ctx | new tok | Now |`,
    `|---|---|${tableOf ? '---|' : ''}---|---|---|---|---|---|`,
  ]
  return [...head, ...rows].join('\n') + tablemates(sorted, tableOf) + extra
}

/** 名單下面的「同桌」段：每張協作桌坐了誰（ListAgents 名稱），使用者叫你找同桌時從這裡找人傳話 */
export function tablemates(list: Coworker[], tableOf?: Map<string, string>): string {
  if (!tableOf || tableOf.size === 0) return ''
  const by = new Map<string, Coworker[]>()
  for (const c of list) { const t = tableOf.get(c.id); if (t !== undefined) by.set(t, [...(by.get(t) ?? []), c]) }
  const who = (c: Coworker) => `${c.name}${c.agent ? ` (\`${c.agent}\`)` : c.addr ? ` (to=${c.addr})` : ''}`
  const lines = [...by].map(([t, cs]) => `- ${cs.some(c => c.isMe) ? '▶ ' : ''}${t}: ${cs.map(who).join(', ')}`)
  return `\nTablemates (same collaboration table in the office; when the user asks you to message your tablemates / 同桌, send to these ListAgents names, ▶ = your table):\n${lines.join('\n')}`
}

/** 只有真正的呼叫（有 tool_use_id）且判定為 ask 才算等待核准；$.tool.check 這類查詢不算 */
const NO_HUMAN_MODES = new Set(['auto', 'bypassPermissions', 'dontAsk']) // 這些模式下的 ask 不會等人按

export function waitsForApproval(decision: string, toolUseId: string | undefined, mode = ''): boolean {
  return decision === 'ask' && toolUseId !== undefined && !NO_HUMAN_MODES.has(mode)
}

/** 收件者名稱 → 辦公室裡的人：比對大家登記的 agent（ListAgents 名稱） */
export function findRecipient(list: Coworker[], to: string): Coworker | undefined {
  const want = to.trim().replace(/\s*\[[0-9a-f]+\]$/i, '') // 去掉可能附帶的 [ref]
  return list.find(c => (c.agent !== undefined && c.agent === want) || (c.addr !== undefined && c.addr === want))
}

// 送信 → 紙飛機＋收件者信封；只收到（寄件者不在辦公室）→ 只有信封；有人開始等核准 → toast
function trackEvents($: EngineInterface, list: Coworker[]) {
  for (const c of list) {
    if (seenSent.has(c.id) && c.sentAt !== undefined && c.sentAt !== seenSent.get(c.id) && c.sentTo) {
      const target = findRecipient(list, c.sentTo)
      const from = lastPlaced?.get(c.id)
      const to = target ? lastPlaced?.get(target.id) : undefined
      if (target && from && to) {
        planes.push({ from: from.stand, to: to.stand, start: frame, fromId: c.id, toId: target.id })
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

    // 等核准（waiting）：拿著紙走去櫃台排隊；結束後走回座位
    const approvalAt = c.mode === 'waiting' ? c.since ?? -1 : undefined
    if (seenApproval.has(c.id) && approvalAt !== seenApproval.get(c.id)) {
      const pl = lastPlaced?.get(c.id)
      if (pl && width > 0 && rows > 0) {
        const spot = queueSpot(width, rows, Math.max(0, queueOrder(list).indexOf(c.id)))
        const go = corridorRoute(pl, spot, width, rows)
        walkTo(c.id, approvalAt !== undefined ? go : [...go].reverse())
      }
    }
    seenApproval.set(c.id, approvalAt)

    const blockedAt = c.blocked?.at
    if (seenBlocked.has(c.id) && blockedAt !== undefined && blockedAt !== seenBlocked.get(c.id) && !c.isMe) {
      $.ui.toast(`${c.name} is blocked by permission (${c.blocked!.tool}); say "allow" in its window`)
    }
    seenBlocked.set(c.id, blockedAt)

    if (seenMode.has(c.id) && c.mode === 'waiting' && seenMode.get(c.id) !== 'waiting' && !c.isMe) {
      $.ui.toast(`${c.name} is waiting for your permission approval`)
    }
    seenMode.set(c.id, c.mode)
  }
}

// 讀其他 session 的檔，丟掉已離開或太久沒心跳的
async function refresh($: EngineInterface) {
  const d = await sharedDir($)
  const now = await $.clock.now()
  const entries = await $.fs.list(d).catch(() => [])
  if ((!collisionWarned || me.dup) && me.id !== 'me' && instance) {
    const ownNow = await readOwnStatus($, me.id)
    // 別人在我上次寫入之後又寫了一次 → 有另一個視窗在用同一個編號
    if (ownNow && typeof ownNow.updatedAt === 'number' && ownNow.updatedAt > lastWriteAt && isCollision(ownNow, instance, now)) warnCollision($)
    else if (me.dup && Date.now() - foreignAt > 20000) {
      me = { ...me, dup: undefined } // 對方關了
      dupNoted = false
    }
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
      const c = parseStatus(s, now)
      if (c) dead.delete(entry.name)
      else dead.set(entry.name, now)
      if (c) found.push(c)
    } catch {}
  }
  others = found.filter(c => !c.oneshot)
  oneshots = found.filter(c => c.oneshot)
  if (me.role === 'manager' || !hasReports(me, others)) promoteNoted = false
  if (me.role !== 'manager' || hasReports(me, others) || reportsSeenAt === undefined) {
    reportsSeenAt = now
    demoteNoted = false
  }
  // 進入／離開開會：名單沒變也要排走路（閒著的人沒有狀態變化，不會觸發 showCrew）
  // 臨時會議：~/.claude/pixel-office/meeting.json 的 {"until": <ms>} 在期限前算開會（主管寫檔，各視窗都看得到）
  let until = 0
  let who: string[] = []
  try {
    const raw = await $.fs.read(meetingFile(d))
    const j = JSON.parse(typeof raw === 'string' ? raw : '{}')
    until = Number(j.until) || 0
    who = Array.isArray(j.participants) ? j.participants.filter((x: unknown): x is string => typeof x === 'string') : []
    meetingTopic = typeof j.topic === 'string' ? j.topic : ''
  } catch {}
  // 不設期限的會議：參與者全都離線（主持人沒散會就關了視窗）也算散會，會議室不會一直掛著
  const m = now < until && (who.length === 0 || everyone().some(isAttendee(who)))
  if (m !== meeting || who.join('|') !== attendees.join('|')) {
    meeting = m
    attendees = who
    trackMoves(everyone())
  }
  if (me.office && approveOn) await readApprovals($, d, now)
  await takeCommand($, d, now)
  await takeOrder($, d, now)
  await showCrew($)
}

// ---------- 累計 token（jacky 2026-11-04：要看誰最花 tokens 好優化；訂閱制，只看數量不看錢） ----------
/** 對話檔（jsonl）裡每則回應的 usage 加總「新 token」＝未快取輸入＋寫入快取＋輸出；快取讀取不算（佔 96% 以上、很便宜，算進去只會變成誰回合多誰第一）。同一則回應可能記好幾行，依訊息 id 去重、後面的蓋前面的 */
export function sumNewTokens(jsonl: string): number {
  const byId = new Map<string, number>()
  for (const line of jsonl.split('\n')) {
    if (!line.includes('"usage"')) continue
    try {
      const j = JSON.parse(line)
      const u = j?.message?.usage
      if (j?.type !== 'assistant' || !u || j.isSidechain === true) continue
      byId.set(String(j.message.id ?? j.uuid), (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0))
    } catch {}
  }
  let n = 0
  for (const v of byId.values()) n += v
  return n
}

/** 專案資料夾名＝資料夾路徑的每個非英數字元換成 -（中文一字一個） */
export const projectDirName = (cwd: string) => cwd.replace(/[^A-Za-z0-9]/g, '-')

/** 名單用的短寫：882k、1.2M；沒有值 — */
export const fmtTokens = (n: number | undefined): string => (n === undefined ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))

const TOK_EVERY_MS = 60000 // 對話檔動輒數十 MB，$.fs.read 又不能讀一段：最多每分鐘整份算一次，檔案沒變就不算
let tokAt = 0
let tokStamp = ''

async function updateTokens($: EngineInterface) {
  if (me.oneshot || me.id === 'me') return
  const now = await $.clock.now()
  if (me.newTokens !== undefined && now - tokAt < TOK_EVERY_MS) return // 還沒有值（剛開、檔還沒出現）時不節流
  tokAt = now
  const home = (await sharedDir($)).replace(/\/pixel-office\/sessions$/, '')
  const file = `${home}/projects/${projectDirName(await $.session.cwd())}/${me.id}.jsonl`
  const st = await $.fs.stat(file).catch(() => undefined)
  if (!st) return
  const stamp = `${me.id}:${st.mtimeMs}`
  if (stamp === tokStamp) return
  const text = await $.fs.read(file).catch(() => undefined)
  if (typeof text !== 'string') return
  tokStamp = stamp
  me = { ...me, newTokens: sumNewTokens(text) }
}

/** 目前 context 佔比（整數 0-100）；還沒有回應或讀不到回 undefined */
async function contextPct($: EngineInterface): Promise<number | undefined> {
  const p = (await $.session.usage().catch(() => undefined))?.context.percent
  return typeof p === 'number' ? Math.round(p) : undefined
}

async function setMode($: EngineInterface, next: OfficeMode, name?: string) {
  seq += 1
  const since = next === me.mode && me.since !== undefined ? me.since : await $.clock.now()
  me = { ...me, mode: next, tool: name ?? me.tool, since }
  await showCrew($)
  await publish($, false).catch(() => undefined)
}

/** /office approve on|off：這個視窗要不要替別人按核准；存 $.store，重開記得 */
async function setApprove($: EngineInterface, on: boolean): Promise<string> {
  approveOn = on
  if (!on) reviewing = undefined
  await $.store.set('approve', on).catch(() => undefined)
  await publish($, false).catch(() => undefined)
  $.ui.invalidate('ui.render')
  return on
    ? 'Office approvals on: while the panel is open, other sessions\' permission prompts come here (about 8 seconds to answer). Turn off: /office approve off'
    : 'Office approvals off: answer permission prompts in each terminal.'
}

/** 這個視窗的辦公室面板開／關：寫進狀態檔，等核准的 session 據此決定要不要送單 */
async function setOffice($: EngineInterface, open: boolean) {
  if (!open) {
    rasterOpen = false
    svgOpen = false
    reviewing = undefined
  }
  if ((me.office === true) === open) return
  me = { ...me, office: open ? true : undefined }
  await publish($, false)
}

const TOOL = 'mcp__pixel-office__office_profile'
const ROSTER = 'mcp__pixel-office__office_roster'
const ROLE_WORDS: Record<string, Role> = { 主管: 'manager', manager: 'manager', boss: 'manager', 員工: 'staff', staff: 'staff', employee: 'staff' }
const ROLE_LABEL: Record<Role, string> = { manager: 'manager', staff: 'staff' }

export function parseRole(word: string): Role | undefined {
  return ROLE_WORDS[word.trim().toLowerCase()] ?? ROLE_WORDS[word.trim()]
}

export function validName(name: string): boolean {
  return /^[\x21-\x7e]{1,12}$/.test(name)
}

// 角色與名牌：/office 指令和模型工具共用；依 session 編號記在 $.store
async function applyProfile(
  $: EngineInterface,
  input: { role?: string; name?: string; agent?: string; ref?: string; title?: string; auto?: boolean; team?: string },
): Promise<string> {
  const notes: string[] = []
  let team = me.team
  if (input.team !== undefined) {
    const t = input.team.trim().replace(/\s*\[[0-9a-f]+\]$/i, '')
    if (t.length > 64) return `team "${input.team}" is too long: use the manager's ListAgents name.`
    team = t.length > 0 && t !== 'off' ? t : undefined
    notes.push(team ? `team=${team} (${(input.role !== undefined ? parseRole(input.role) : me.role) === 'manager' ? 'department lead, sits in its own area' : 'sits in the team area'})` : 'team cleared')
  }
  let auto = me.auto
  if (input.auto !== undefined) {
    auto = input.auto ? true : undefined
    notes.push(input.auto ? 'mode=auto (no hand-raising for approval)' : 'mode=waits for approval')
  }
  let role = me.role
  let name = me.name
  let agent = me.agent
  let ref = me.ref
  let title = me.title
  let titleAuto = me.titleAuto
  let titleAt = me.titleAt
  if (input.title !== undefined) {
    const t = input.title.trim()
    if (t.length > 16) return `title "${input.title}" is too long: max 16 characters.`
    title = t.length > 0 ? t : undefined
    titleAuto = undefined // 手動設的：以後不自動蓋
    titleAt = title ? await $.clock.now() : undefined
    notes.push(title ? `title=${title}` : 'title cleared')
  }
  if (input.ref !== undefined) {
    const r = input.ref.trim().replace(/^\[|\]$/g, '').toLowerCase()
    if (!/^[0-9a-f]{0,32}$/.test(r)) return `ref "${input.ref}" is invalid: the hex code after the ListAgents name (e.g. 180a9b).`
    ref = r.length > 0 ? r : undefined
    notes.push(ref ? `ref=${ref}` : 'ref cleared')
  }
  if (input.agent !== undefined) {
    const withRef = input.agent.trim().match(/^(.*?)\s*\[([0-9a-f]+)\]$/i)
    if (withRef && withRef[2].toLowerCase() !== ref) {
      ref = withRef[2].toLowerCase() // 整串 `名稱 [ref]` 貼進來：ref 留著，撞名時才定得了址
      notes.push(`ref=${ref}`)
    }
    const a = input.agent.trim().replace(/\s*\[[0-9a-f]+\]$/i, '')
    if (a.length === 0 || a.length > 64) return `agent name "${input.agent}" is invalid: 1–64 characters (the name after "This session is" in ListAgents).`
    agent = a
    notes.push(`agent=${agent}`)
    if (input.name === undefined && name === defaultName) {
      const derived = plateFromAgent(a)
      if (derived) {
        name = derived
        notes.push(`nameplate set automatically to ${derived}`)
      }
    }
  }
  if (input.role !== undefined) {
    const parsed = parseRole(input.role)
    if (parsed === undefined) return `Unknown role "${input.role}": use manager or staff.`
    // 升層＝員工改主管：協作目錄已在就由外掛補 collab.md 骨架（目錄本身仍由 skill 建）
    if (parsed === 'manager' && me.role !== 'manager') notes.push(`role=${ROLE_LABEL[parsed]} (stepping up: ${await ensureCollab($, agent ?? name, team).catch(e => `could not write collab.md: ${String(e)}`)})`)
    else notes.push(`role=${ROLE_LABEL[parsed]}`)
    role = parsed
  }
  if (input.name !== undefined) {
    if (!validName(input.name)) return `nameplate "${input.name}" is invalid: letters, digits and symbols only, 1–12 characters, no spaces.`
    name = input.name
    notes.push(`name=${name}`)
  }
  if (notes.length === 0) return 'Nothing to change: give role (manager/staff), name (letters/digits), title, agent (ListAgents name), auto (true/false) or team (manager name).'
  me = { ...me, role, name, agent, ref, title, titleAuto, titleAt, auto, team }
  await saveProfile($)
  await showCrew($)
  await publish($, false).catch(() => undefined)
  return `Set: ${notes.join(', ')}.`
}

async function saveProfile($: EngineInterface) {
  const { role, name, agent, ref, title, titleAuto, titleAt, auto, team } = me
  await $.store.set(`profile:${me.id}`, { role, name, agent, ref, title, titleAuto, titleAt, auto, team }).catch(() => undefined) // 存不了只是重開後不記得
}

let sessionTitle: string | undefined // classic SessionStart／UserPromptSubmit 帶的 session_title（--name 或自動標題）
let launchName: string | undefined // 啟動時的 --name（classic SessionStart、source＝startup 的 session_title）
let oneshotRun = false // session.start 的 isInteractive＝false：claude -p 或 SDK
let configDir: string | undefined // 這個 session 行程的 CLAUDE_CONFIG_DIR，寫進狀態檔給手機版分辨用哪套設定
let attached = false // Desktop／手機／VS Code 接上過

/**
 * 有 Desktop／手機／VS Code 接上＝有人在用，不是一次性對話：Desktop 的 session 也走 SDK，isInteractive 一樣是 false
 * （jacky 2026-10-27：0.19.0 後 Desktop 的員工都消失）
 */
async function attend($: EngineInterface) {
  attached = true
  oneshotRun = false
  if (!me.oneshot) return
  const { oneshot: _o, label: _l, ...rest } = me
  me = rest
  if (me.id !== 'me') await publish($, false)
}

/** --name → 預設名牌：去掉非 ASCII、截到 12 字，至少 2 字才用（名牌只能 ASCII，Raster 畫不出中文） */
export function launchPlate(name: string | undefined): string | undefined {
  const ascii = (name ?? '').replace(/[^\x21-\x7e]/g, '').slice(0, 12)
  return ascii.length >= 2 && !isCommandName(ascii) ? ascii : undefined // 美術 A #14：! 或 / 開頭（指令當名字）不採用
}

/** 記下 --name：一次性對話拿它分組；互動 session 名牌還是預設的（沒手動設過）就換成它 */
async function noteLaunchName($: EngineInterface, t: string) {
  launchName = t
  if (me.id === 'me') return // adopt 會套用
  const plate = launchPlate(t) ?? (isCommandName(t) ? shortCode(me.id) : undefined) // 晚到的啟動名是指令：同一條短代號規則（美術 A #14）
  if (me.oneshot) me = { ...me, label: t }
  if (plate && me.name === defaultName) {
    defaultName = plate
    me = { ...me, name: plate }
  }
  await publish($, false)
}

/** 一次性對話依 --name 前綴分組（第一個 - 之前；沒帶 --name 的歸「一次性」），人數多的在前 */
export function oneshotGroups(list: Coworker[]): { label: string; n: number }[] {
  const by = new Map<string, number>()
  for (const c of list) {
    const k = c.label ? c.label.split('-')[0] || c.label : 'one-shot'
    by.set(k, (by.get(k) ?? 0) + 1)
  }
  return [...by].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n || Number(a.label === 'one-shot') - Number(b.label === 'one-shot') || a.label.localeCompare(b.label))
}
export const oneshotText = (g: { label: string; n: number }[]) => g.map(x => `⚙ ${x.label} ×${x.n}`).join('　')

/** 自動帶 title：有 session_title 就用，沒有用指令前 16 字；手動設過的不動 */
async function autoTitle($: EngineInterface, head: string | undefined, now: number) {
  const t = sessionTitle ? [...sessionTitle.trim()].slice(0, 16).join('') : head
  if (!t || !autoTitleDue(me, now) || t === me.title) return
  me = { ...me, title: t, titleAuto: true, titleAt: now }
  await saveProfile($)
}

// classic hook 帶的 session_title：記下來，title 是自動帶的就換成它
async function noteSessionTitle($: EngineInterface, e: unknown) {
  const t = (e as { session_title?: unknown }).session_title
  if (typeof t !== 'string' || t.trim().length === 0 || t === sessionTitle) return
  sessionTitle = t
  if (me.id === 'me') return // 還沒拿到編號：先記著，adopt 之後由 session.start 套用
  if (!me.title || me.titleAuto) {
    me = { ...me, title: undefined }
    await autoTitle($, undefined, await $.clock.now())
    await publish($, false)
  }
}

// ---------- 點人核准（控制塔第 1 期）----------
// 等核准的 session 把單寫到 approvals/<session>.json；開著辦公室面板的視窗顯示「審 <名牌>」，
// 使用者點 Allow／Deny 才寫 decisions/<session>.json；等的那方比對 session＋toolUseId＋nonce＋自己手上指令的 hash 全對才採用。
// 終端機原本的詢問照常同時出現，誰先按算誰的；逾時、沒人開辦公室、檔案壞掉 → 不回答，交回終端機。
// $.fs 沒有刪檔：處理完覆寫成不含指令內容的墓碑，逾時的一律當不存在（主管 office 2026-10-26 裁示）。

export const APPROVAL_TIMEOUT_MS = 120000 // 上限：只在 hook 沒有預算計時（測試、未來版本）時用得到
export const BUDGET_MARGIN_MS = 1500 // classic.PermissionRequest 的 hook 預算 10 秒（HookBudget.ms），留這麼多給清檔與回答
export const MIN_WINDOW_MS = 2000 // 剩不到這麼久就不送單：使用者來不及看
const APPROVAL_POLL_MS = 300
export const ASK_WINDOW_MS = 2000 // tool.check 到 PermissionRequest 超過這麼久就不接手（免得配到很久以前的同指令）
export const ALLOW_COOLDOWN_MS = 1000 // 展開後 Allow 要等這麼久才按得下去（防連點誤放行）
export const APPROVAL_TEXT_MAX = 1500 // 指令全文超過就只給 Deny 與「回終端機按」
const APPROVAL_LINES_MAX = 20
export const TOMBSTONE = JSON.stringify({ state: 'done' })

export type ApprovalRecord = { state: 'waiting'; session: string; name: string; toolUseId: string; tool: string; text: string; nonce: string; at: number; deadline: number }
export type Ask = { toolUseId: string; tool: string; input: string; at: number }
type Want = { session: string; toolUseId: string; nonce: string; textHash: string }

/** 指令全文的 SHA-256：決定綁在使用者看到的那段文字上，單上的 text 被換掉就對不上（主管 office 2026-10-26 裁示） */
export async function textHash(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
}

const officeRoot = (sessionsDir: string) => sessionsDir.replace(/\/sessions$/, '')
const approvalFile = (sessionsDir: string, sid: string) => `${officeRoot(sessionsDir)}/approvals/${sid}.json`
const decisionFile = (sessionsDir: string, sid: string) => `${officeRoot(sessionsDir)}/decisions/${sid}.json`

// ---------- 手機核准（0.63.51；0.63.53 安全審 A-1～A-3 改）：與電腦面板共用 approvals 的單 ----------
// 外掛向本機伺服器問 GET /phone-live：伺服器只在 Cloudflare Access 的 JWT 驗過的手機頁請求記下「手機在看」（記憶體，不寫檔）。
// 在看就送單、等手機最多 waitMs（預設 2 分鐘，上限 9 分鐘）。等待用 $.process.run 跑等待程式（hooks/waiter.ts，不吃 hook 的 10 秒預算），
// 它向伺服器問 GET /approve-result（伺服器只回自己從 JWT 驗過的請求記下的決定），不讀 decisions 檔；電腦上先按（單變墓碑）或時間到就結束。
// 電腦面板那條（decisions 檔）照舊、預設關；手機這條只認伺服器的決定
export const PHONE_WAIT_MS = 120000
export const PHONE_WAIT_MAX_MS = 540000
/** 伺服器 /phone-live 的回覆 → 這次可以等手機多久（毫秒）；不在看、讀不到、壞掉回 undefined（照原本只看電腦面板） */
export function phoneWait(raw: string | undefined): number | undefined {
  try {
    const j = JSON.parse(raw ?? '')
    if (!j || j.live !== true) return
    return typeof j.waitMs === 'number' && j.waitMs >= 10000 ? Math.min(j.waitMs, PHONE_WAIT_MAX_MS) : PHONE_WAIT_MS
  } catch { return }
}
/** 手機核准只問正式的辦公室伺服器：127.0.0.1:8767（寫死，不從誰都能改的 remote.json 讀；安全審 (a)，0.63.54）；等待程式另外確認監聽的是 remote/server.ts */
const OFFICE_URL = 'http://127.0.0.1:8767'
/** 本機金鑰檔（0.63.56）：伺服器產的，等待程式讀它帶 X-PO-Key；外掛自己不讀內容 */
const localKeyFile = (sessionsDir: string) => `${officeRoot(sessionsDir)}/local-key`
async function officeUrl(_$: EngineInterface): Promise<string> { return OFFICE_URL }
const pyOf = async ($: EngineInterface) => ((await $.env.get('USERPROFILE')) ? 'python' : '/usr/bin/python3') // Windows 是 python
/** 問伺服器手機有沒有在看（1.5 秒內沒回就當沒有） */
async function phoneLiveWait($: EngineInterface): Promise<number | undefined> {
  try {
    const url = `${await officeUrl($)}/phone-live`
    const r = await $.process.run([await pyOf($), '-I', '-c', PHONE_LIVE_PY, url, localKeyFile(await sharedDir($))], { timeoutMs: 6000 })
    return phoneWait(r.stdout.trim())
  } catch { return }
}

// 手機下的命令（remote/server.ts 寫 commands/<session>.json）：nonce 跟 <session>.done.json 不同才送，
// 先寫 done 再送，重載外掛也不會送兩次（MOD 的 $.fs 不能刪檔）。當成使用者自己打的字（jacky 2026-10-27 選），前面加 📱
const commandFile = (sessionsDir: string, sid: string) => `${officeRoot(sessionsDir)}/commands/${sid}.json`
/** 命令 → 送進對話的字：手機的前面加 📱；別的 AI 寄的（agy_office.py send，帶 from）標寄件者，不能被當成使用者的話 */
export const commandText = (c: { text: string; from?: unknown }) => (typeof c.from === 'string' && c.from !== '' ? `📨 ${c.from}: ${c.text}` : `📱 ${c.text}`)
export const COMMAND_TTL_MS = 10 * 60 * 1000 // 送出超過 10 分鐘還沒被收的命令作廢（例如對方關了視窗）
/**
 * commands/<id>.json 是一個佇列（0.63.17，複驗 D）：items 依序排，寫的人（手機版伺服器、Codex、agy）把收過的、過期的拿掉再接在後面，
 * 外掛一次送一則、送達才記收過（done 檔的 nonces 留最近 30 個）。原本只有一則：短時間連傳三則只剩第三則。
 * 舊格式（沒有 items，只有 nonce／text）當成一則的佇列
 */
export type CommandItem = { nonce: string; text: string; at: number; from?: string }
export function nextCommand(c: any, done: Set<string>, now: number): CommandItem | undefined {
  const items: any[] = Array.isArray(c?.items) ? c.items : c && typeof c.nonce === 'string' ? [c] : []
  return items.find(i => i && typeof i.nonce === 'string' && typeof i.text === 'string' && i.text.trim() !== '' && !done.has(i.nonce) && now - Number(i.at) < COMMAND_TTL_MS)
}
export const doneNonces = (d: any): Set<string> => new Set([...(Array.isArray(d?.nonces) ? d.nonces : []), d?.nonce].filter((x): x is string => typeof x === 'string'))
async function takeCommand($: EngineInterface, d: string, now: number) {
  if (me.id === 'me' || me.oneshot) return
  const f = commandFile(d, me.id)
  if (!(await $.fs.exists(f).catch(() => false))) return
  try {
    const raw = await $.fs.read(f)
    const doneFile = f.replace(/\.json$/, '.done.json')
    const done = doneNonces(await $.fs.read(doneFile).then(r => JSON.parse(typeof r === 'string' ? r : '{}')).catch(() => undefined))
    if (cmdPending && done.has(cmdPending.nonce)) cmdPending = undefined
    const c = nextCommand(JSON.parse(typeof raw === 'string' ? raw : '{}'), done, now)
    if (!c) return
    // 0.63.56：送達＝$.prompt.submit 的 promise resolve（引擎文件：那句進了對話、它的回合開始；排在別的回合後面就等輪到它）。
    // 原本等自己的 prompt.submit 掛點看到那句才記 done，但外掛自己送的話自己的掛點聽不到（11-26 在隔離 tmux 實測），
    // 所以從來沒成功過：連送兩句給閒著的 Claude，第二句卡到第一句 10 分鐘過期；補救路徑還把同一句附進 context 再送一次（已拿掉）。
    // 送出後還沒 resolve＝在路上，不重送；被拒才隔 15 秒重送，最多 3 次，錯誤記在 <session>.err.json，之後放著等它過期
    if (cmdPending?.nonce !== c.nonce) cmdPending = { nonce: c.nonce, text: commandText(c), ask: c.text, doneFile, sentAt: 0, tries: 0 }
    const pend = cmdPending
    if (pend.inFlight) return
    if (pend.tries > 0 && now - pend.sentAt < CMD_CONFIRM_MS) return
    if (pend.tries >= CMD_TRIES) return
    pend.tries++
    pend.sentAt = now
    pend.inFlight = true
    phoneAsk = c.text
    // 不 await：排在長回合後面時要等那個回合結束才 resolve，不能卡住每秒的 refresh
    void $.prompt.submit({ text: pend.text, asUser: true }).then(
      async () => { pend.inFlight = false; await markCmdDone($, pend, await $.clock.now()) },
      async err => {
        pend.inFlight = false
        await $.fs.write(f.replace(/\.json$/, '.err.json'), JSON.stringify({ nonce: c.nonce, at: now, tries: pend.tries, err: String(err).slice(0, 300) })).catch(() => undefined)
      },
    ).catch(() => undefined)
  } catch {}
}

/** 手機／同事傳來、送出中或被拒待重送的那一則（takeCommand） */
type CmdPending = { nonce: string; text: string; ask: string; doneFile: string; sentAt: number; tries: number; inFlight?: boolean }
let cmdPending: CmdPending | undefined
export const CMD_CONFIRM_MS = 15000, CMD_TRIES = 3
async function markCmdDone($: EngineInterface, p: CmdPending, now: number) {
  if (cmdPending === p) cmdPending = undefined
  const before = doneNonces(await $.fs.read(p.doneFile).then(r => JSON.parse(typeof r === 'string' ? r : '{}')).catch(() => undefined))
  const nonces = [...before, p.nonce].filter((x, i, a) => a.indexOf(x) === i).slice(-30)
  await $.fs.write(p.doneFile, JSON.stringify({ nonce: p.nonce, nonces, at: now, via: 'submit' })).catch(() => undefined)
}

/**
 * 人事令（roadmap 第 5 項，0.62.3）：手機版伺服器寫 orders/<session>.json { nonce, at, role?, team? }，外掛直接改身分（等同 office_profile），
 * 不經模型；收過的 nonce 記在 orders/<session>.done.json。缺主管的桌子挑一位升主管、同桌其他人 team 指向他，都走這條
 */
export function orderInput(raw: unknown, now: number, doneNonce?: unknown): { nonce: string; role?: string; team?: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.nonce !== 'string' || r.nonce === '' || r.nonce === doneNonce || !(now - Number(r.at) < COMMAND_TTL_MS)) return undefined
  const out: { nonce: string; role?: string; team?: string } = { nonce: r.nonce }
  if (r.role === 'manager' || r.role === 'staff') out.role = r.role
  if (typeof r.team === 'string' && r.team.trim() !== '') out.team = r.team.trim().slice(0, 64)
  return out.role || out.team ? out : undefined
}
/**
 * office_task（roadmap 第 10 項，0.62.11）：create（只有主管）寫 tasks/<id>.json；update 寫 tasks/<id>.<第幾份>.json，
 * 只有那份的負責人（ListAgents 名稱對得上）或開任務的主管能改。回傳要寫的檔，或錯誤訊息（給模型看）
 */
export function taskOp(input: Record<string, unknown>, who: Pick<Coworker, 'id' | 'role' | 'agent' | 'name'>, now: number, def?: TaskDef): { file: string; data: unknown; reply: string } | string {
  if (input.action === 'create') {
    if (who.role !== 'manager') return 'Only managers create tasks; update your own part with action=update.'
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    if (!title || [...title].length > 40) return 'title is required (max 40 chars).'
    const raw = Array.isArray(input.parts) ? input.parts : []
    if (raw.length < 1 || raw.length > 12) return 'parts: 1–12 items of {who, what, after?}.'
    const parts: TaskPart[] = []
    for (const [i, p] of raw.entries()) {
      const w = typeof (p as any)?.who === 'string' ? (p as any).who.trim().replace(/\s*\[[0-9a-f]+\]$/i, '') : ''
      const what = typeof (p as any)?.what === 'string' ? (p as any).what.trim() : ''
      if (!w || !what || what.length > 200) return `part ${i + 1}: who (ListAgents name) and what (max 200 chars) are required.`
      const after = Array.isArray((p as any).after) ? (p as any).after.filter((n: unknown) => typeof n === 'number' && n >= 1 && n <= raw.length && n !== i + 1).map((n: number) => n - 1) : []
      parts.push({ who: w, what, ...(after.length ? { after } : {}) })
    }
    const id = crypto.randomUUID().slice(0, 8)
    const data: TaskDef = { id, title, boss: who.id, ...(who.agent ? { bossAgent: who.agent } : {}), parts, at: now }
    return { file: `${id}.json`, data, reply: `Task ${id} 「${title}」 created with ${parts.length} parts. Tell each person: "task ${id} part N: <what>; update it with office_task action=update id=${id} part=N state=doing|done|stuck".` }
  }
  if (input.action === 'update') {
    if (!def) return 'No such task id (office_task action=list shows yours).'
    const n = Number(input.part)
    if (!Number.isInteger(n) || n < 1 || n > def.parts.length) return `part must be 1–${def.parts.length}.`
    const state = String(input.state ?? '')
    if (!(state in PART_ZH)) return 'state must be waiting, doing, done or stuck.'
    const owner = def.parts[n - 1].who === who.agent
    if (!owner && def.boss !== who.id) return `Part ${n} belongs to ${def.parts[n - 1].who}; only they or the manager can update it.`
    const note = typeof input.note === 'string' && input.note.trim() ? input.note.trim().slice(0, 120) : undefined
    return { file: `${def.id}.${n - 1}.json`, data: { state, at: now, ...(note ? { note } : {}), by: who.agent ?? who.name }, reply: `Task ${def.id} part ${n}: ${PART_ZH[state as PartState]}.` }
  }
  return 'action must be create, update or list.'
}

/**
 * 自動多開幫手（roadmap 第 13 項）：主管不能自己開，只能請使用者決定 → helpers/<id>.json，手機版伺服器（remote/helpers.ts）跳通知、使用者按「加」才開。
 * 回傳要寫的請求，或錯誤訊息（給模型看）
 */
export function helperAsk(input: Record<string, unknown>, who: Pick<Coworker, 'id' | 'role' | 'agent' | 'name'>): { id: string; from: string; agent?: string; plate: string; reason: string; task: string; name?: string; kind?: 'codex-art' } | string {
  if (who.role !== 'manager') return 'Only managers can ask for helpers (office_profile role=manager first, or ask your manager).'
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  const task = typeof input.task === 'string' ? input.task.trim() : ''
  if (!reason || [...reason].length > 60) return 'reason is required: one short line, max 60 characters.'
  if (!task || task.length > 2000) return 'task is required: max 2000 characters.'
  const name = typeof input.name === 'string' && input.name.trim() ? [...input.name.replace(/[\x00-\x1f\x7f]/g, '').trim()].slice(0, 20).join('') : undefined
  if (input.kind !== undefined && input.kind !== 'codex-art') return "kind must be 'codex-art' (a Codex image helper) or left out (a Claude helper)."
  return { id: crypto.randomUUID(), from: who.id, agent: who.agent, plate: who.name, reason, task, ...(name ? { name } : {}), ...(input.kind === 'codex-art' ? { kind: 'codex-art' as const } : {}) }
}

const orderFile = (sessionsDir: string, sid: string) => `${officeRoot(sessionsDir)}/orders/${sid}.json`
async function takeOrder($: EngineInterface, d: string, now: number) {
  if (me.id === 'me' || me.oneshot) return
  const f = orderFile(d, me.id)
  if (!(await $.fs.exists(f).catch(() => false))) return
  try {
    const raw = await $.fs.read(f)
    const doneFile = f.replace(/\.json$/, '.done.json')
    const done = await $.fs.read(doneFile).then(r => JSON.parse(typeof r === 'string' ? r : '{}').nonce).catch(() => undefined)
    const o = orderInput(JSON.parse(typeof raw === 'string' ? raw : '{}'), now, done)
    if (!o) return
    const result = await applyProfile($, { role: o.role, team: o.team })
    await $.fs.write(doneFile, JSON.stringify({ nonce: o.nonce, at: now, result }))
  } catch {}
}

/** 這份外掛程式碼載入（或重載）的時間：每次重載模組會重新算，狀態檔帶著，看得出重載有沒有真的發生（0.63.25） */
const LOADED_AT = Date.now()

/** 外掛自己換新版（0.63.25）：App 分頁、Remote Control 的對話從外面送不到 /reload-plugins，由外掛自己叫 */
async function selfReload($: EngineInterface) {
  if (me.id === 'me' || me.oneshot) return
  const disk = await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`).then(t => String(JSON.parse(String(t)).version ?? '')).catch(() => undefined)
  const now = await $.clock.now()
  const key = `reload:${await $.session.id()}`
  const last = (await $.store.get(key).catch(() => undefined)) as ReloadTry | undefined
  // 版號與重試次數先過（閒不閒交給 reloadIfIdle 在呼叫前一刻判定）
  if (!shouldReload({ disk, loaded: VERSION, idle: true, last, now })) return
  // 先記下這次嘗試再叫（快驗第 1 項）：重載會換掉這份程式碼，叫完之後的程式不一定跑得到；沒叫成再改回去
  const tried: ReloadTry = { version: disk!, tries: (last?.version === disk ? last!.tries : 0) + 1, at: now }
  await $.store.set(key, tried).catch(() => undefined)
  const r = await reloadIfIdle($)
  if (!r.ran) { await $.store.set(key, last ?? null).catch(() => undefined); return }
  await r.done.catch(() => undefined)
}

// 每輪結束把最後的回覆寫到 replies/<session>.json，手機卡片顯示（jacky 2026-10-27：看不到回應就不知道要跟他說什麼）
// 只存主對話；那一輪若是手機命令觸發的，帶上那道命令
export const REPLY_MAX = 8000
let phoneAsk: string | undefined
async function saveReply($: EngineInterface, answer: string) {
  if (me.id === 'me' || me.oneshot) return
  const ask = phoneAsk
  phoneAsk = undefined
  const d = await sharedDir($)
  const text = answer.length > REPLY_MAX ? `${answer.slice(0, REPLY_MAX)}\n… (truncated)` : answer
  await $.fs.write(`${officeRoot(d)}/replies/${me.id}.json`, JSON.stringify({ text, at: await $.clock.now(), ask }))
}

/** tool_input → 給人看的全文：Bash／PowerShell 取 command，其他整份 JSON */
export function approvalText(tool: string, input: unknown): string {
  const cmd = (input as { command?: unknown } | undefined)?.command
  if (/^(bash|powershell)$/i.test(tool) && typeof cmd === 'string') return cmd
  try {
    return JSON.stringify(input, null, 1) ?? ''
  } catch {
    return ''
  }
}

/** 全文放得下（字數與行數）才給 Allow */
export const approvalFits = (text: string) => text.length > 0 && text.length <= APPROVAL_TEXT_MAX && text.split('\n').length <= APPROVAL_LINES_MAX

/** 鍵排序後的 JSON：tool.check 的 input 與 PermissionRequest 的 tool_input 鍵順序可能不同 */
export function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (v && typeof v === 'object') return `{${Object.keys(v as object).sort().map(k => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`
  return JSON.stringify(v) ?? 'null'
}

/** PermissionRequest 沒有 tool_use_id：從 2 秒內的 tool.check（ask）找 tool 與 input 完全相同的那筆；不是剛好一筆就不接手 */
export function matchAsk(list: Ask[], tool: string, input: string, now: number): string | undefined {
  const hits = list.filter(a => a.tool === tool && a.input === input && now - a.at >= 0 && now - a.at <= ASK_WINDOW_MS)
  return hits.length === 1 ? hits[0].toolUseId : undefined
}

/** 讀到的決定檔：沒有／墓碑＝none；四項（session、toolUseId、nonce、指令 hash）有一項不符＝mismatch（丟棄）；壞檔＝corrupt（不回答） */
export function judgeDecision(raw: string | undefined, want: Want): { kind: 'none' } | { kind: 'corrupt' } | { kind: 'mismatch'; why: string } | { kind: 'ok'; behavior: 'allow' | 'deny'; message?: string; via?: string } {
  if (raw === undefined || raw.trim() === '') return { kind: 'none' }
  let d: Record<string, unknown>
  try {
    d = JSON.parse(raw)
  } catch {
    return { kind: 'corrupt' }
  }
  if (!d || typeof d !== 'object') return { kind: 'corrupt' }
  if (d.state !== 'decided') return { kind: 'none' }
  for (const k of ['session', 'toolUseId', 'nonce', 'textHash'] as const) if (d[k] !== want[k]) return { kind: 'mismatch', why: k }
  if (d.behavior !== 'allow' && d.behavior !== 'deny') return { kind: 'corrupt' }
  // 拒絕的原因（手機可附，0.63.51）：去控制字元、最多 300 字；via＝誰按的（phone／panel）
  const msg = typeof d.message === 'string' ? d.message.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 300) : ''
  return { kind: 'ok', behavior: d.behavior, ...(d.behavior === 'deny' && msg ? { message: msg } : {}), ...(typeof d.via === 'string' ? { via: d.via.slice(0, 10) } : {}) }
}

/** 讀到的核准單：墓碑、壞檔、欄位不全、過了 deadline（等的那方已不再等）一律當不存在 */
export function parseApproval(raw: string | undefined, now: number): ApprovalRecord | undefined {
  try {
    const a = JSON.parse(raw ?? '')
    const ok = a && a.state === 'waiting' && ['session', 'name', 'toolUseId', 'tool', 'text', 'nonce'].every(k => typeof a[k] === 'string') && typeof a.at === 'number' && typeof a.deadline === 'number'
    return ok && now < a.deadline && now - a.at < APPROVAL_TIMEOUT_MS ? (a as ApprovalRecord) : undefined
  } catch {
    return undefined
  }
}

export type WaitIO = { read: () => Promise<string | undefined>; discard: () => Promise<void>; now: () => Promise<number>; sleep: (ms: number) => Promise<void>; settled: () => boolean; log: (text: string) => void }

/** 等決定到 deadline（絕對時間）：採用四項全對的；不符的丟棄並記一行；壞檔、到期、終端機先結案、被中止 → undefined（不回答） */
export async function waitForDecision(io: WaitIO, want: Want, deadline: number): Promise<'allow' | 'deny' | undefined> {
  while (!io.settled()) {
    if ((await io.now()) >= deadline) return undefined
    const j = judgeDecision(await io.read(), want)
    if (j.kind === 'ok') return j.behavior
    if (j.kind === 'corrupt') {
      io.log('pixel-office: decision file is corrupt, handing back to the terminal')
      return undefined
    }
    if (j.kind === 'mismatch') {
      io.log(`pixel-office: discarded a mismatched approval decision (${j.why} differs)`)
      await io.discard()
    }
    await io.sleep(Math.min(APPROVAL_POLL_MS, Math.max(0, deadline - (await io.now()))))
  }
  return undefined
}

/** 這一輪能等多久：hook 預算剩下的減安全邊際，上限 APPROVAL_TIMEOUT_MS；太短回 undefined（不送單） */
export function approvalWindow(remainingMs: number): number | undefined {
  const w = Math.min(APPROVAL_TIMEOUT_MS, remainingMs - BUDGET_MARGIN_MS)
  return w >= MIN_WINDOW_MS ? w : undefined
}

/** 有沒有人開著辦公室面板「且核准開啟」（含自己）：沒有就不送單，直接交回終端機（預設關，跟沒開辦公室一樣） */
export const officeApproves = (list: Coworker[]) => list.some(c => c.office === true && c.approve === true)

const asks: Ask[] = [] // 最近判定 ask 的工具呼叫（tool.check 記，PermissionRequest 對）
const settled = new Set<string>() // 已在別處結案的 toolUseId：終端機先按、指令跑完、被拒
let pending: ApprovalRecord[] = [] // 辦公室裡等人審的單（開著面板的視窗才讀）
let reviewing: { session: string; toolUseId: string; nonce: string; text: string; openedAt: number } | undefined // 面板上展開的那一張（text＝使用者看到的全文）

function settle(e: unknown) {
  const id = (e as { tool_use_id?: unknown }).tool_use_id
  if (typeof id !== 'string') return
  settled.add(id)
  if (settled.size > 200) settled.delete(settled.values().next().value as string) // 只記最近的：等單最多 120 秒，舊的用不到
}

/** 睡 ms；signal 中止就立刻醒 */
const sleep = ($: EngineInterface, ms: number, signal?: AbortSignal) =>
  new Promise<void>(r => {
    if (signal?.aborted) return r()
    signal?.addEventListener('abort', () => r(), { once: true })
    $.clock.after(ms, () => r())
  })

async function clearApproval($: EngineInterface, sid: string) {
  const d = await sharedDir($)
  await $.fs.write(approvalFile(d, sid), TOMBSTONE)
  await $.fs.write(decisionFile(d, sid), TOMBSTONE)
}

export type SlipIO = WaitIO & { writeSlip: (text: string) => Promise<void>; clearAll: () => Promise<void>; nonce: () => string; shown: (on: { tool: string; at: number; deadline: number } | undefined) => Promise<void> }

export type Decided = { behavior: 'allow' | 'deny'; message?: string; via?: string }
/** 送單一輪：先把舊決定清成墓碑再送單（上一輪的決定不會被誤採用）→ 等 → 不論結果兩個檔都清成墓碑 */
export async function runSlip(io: SlipIO, who: { session: string; name: string }, toolUseId: string, tool: string, text: string, window: number): Promise<'allow' | 'deny' | undefined> {
  return (await runSlipWith(io, who, toolUseId, tool, text, window, async (want, deadline) => { const b = await waitForDecision(io, want, deadline); return b ? { behavior: b } : undefined }))?.behavior
}
/** 送單、等（wait 決定怎麼等：電腦面板＝原本的輪詢；手機＝外部等待程式，0.63.51）、收單；onSlip 拿到這張單的 nonce（結案寫墓碑用） */
export async function runSlipWith(io: SlipIO, who: { session: string; name: string }, toolUseId: string, tool: string, text: string, window: number, wait: (want: Want, deadline: number) => Promise<Decided | undefined>, onSlip?: (nonce: string | undefined) => void): Promise<Decided | undefined> {
  const start = await io.now()
  const deadline = start + window
  const want = { session: who.session, toolUseId, nonce: io.nonce(), textHash: await textHash(text) }
  await io.discard()
  const rec: ApprovalRecord = { state: 'waiting', session: want.session, toolUseId, nonce: want.nonce, name: who.name, tool, text, at: start, deadline }
  await io.writeSlip(JSON.stringify(rec))
  onSlip?.(want.nonce)
  await io.shown({ tool, at: start, deadline })
  try {
    return await wait(want, deadline)
  } finally {
    onSlip?.(undefined)
    await io.clearAll().catch(() => undefined)
    await io.shown(undefined).catch(() => undefined)
  }
}
/**
 * 手機的等法（0.63.53）：跑等待程式到伺服器有決定／單結案／到期（不吃 hook 預算）。決定只認等待程式從伺服器拿到的那份，
 * 而且 session、toolUseId、nonce、指令全文的 hash 四項都要跟這張單一樣；不讀 decisions 檔，等待程式跑不起來就交回電腦（A-3）
 */
export async function waitPhone(io: { runWaiter: (want: Want, deadline: number) => Promise<string | undefined>; log: (t: string) => void }, want: Want, deadline: number): Promise<Decided | undefined> {
  const out = await io.runWaiter(want, deadline).catch(() => undefined)
  if (!out || !out.startsWith('decided ')) return
  const j = judgeDecision(out.slice('decided '.length), want)
  if (j.kind === 'ok') return { behavior: j.behavior, ...(j.message ? { message: j.message } : {}), ...(j.via ? { via: j.via } : {}) }
  if (j.kind === 'mismatch') io.log(`pixel-office: discarded a mismatched phone decision (${j.why} differs)`)
  return undefined
}

/**
 * 等待端採用的每個決定都記一筆到 approve-log.jsonl（R7 留證據，顧問 2026-11-26 改版裁示）。
 * 使用者 2026-11-26 接受「decisions 檔寫得出正確 allow 就會被採用」（不用在場驗證），防線改成事後查得到：
 * 時間、自己的 session、工具、指令前 200 字、allow／deny、來源（panel-file＝decisions 檔，phone＝手機經伺服器）。
 * $.fs 只能整檔覆寫，伺服器也在同一檔附加 → 用 O_APPEND 附加（之後設了 chflags uappnd 也寫得進去），0600
 */
export { APPROVE_LOG_PY }
export function adoptedEntry(o: { at: number; session: string; name: string; tool: string; text: string; decided: Decided; phone: boolean }): string {
  return JSON.stringify({ at: o.at, kind: 'adopted', id: o.session, name: o.name, tool: o.tool, text: o.text.slice(0, 200), behavior: o.decided.behavior, via: o.phone ? 'phone' : 'panel-file' })
}
async function logAdopted($: EngineInterface, entry: string) {
  const d = await sharedDir($)
  await $.process.run([await pyOf($), '-I', '-c', APPROVE_LOG_PY, `${officeRoot(d)}/approve-log.jsonl`, entry], { timeoutMs: 3000 }).catch(() => undefined)
}

let openSlip: { sid: string; nonce: string; toolUseId: string } | undefined // 這個視窗正在等的那張單（結案時寫墓碑，讓等待程式停下；0.63.51）
/** 送單到辦公室並等決定；回 undefined＝不回答（交回終端機）。phone＝手機核准開著：用等待程式等（最多 window） */
async function askOffice($: EngineInterface, toolUseId: string, tool: string, text: string, window: number, signal: AbortSignal, phone = false): Promise<Decided | undefined> {
  const d = await sharedDir($)
  const sid = me.id
  const io = {
      read: () => $.fs.read(decisionFile(d, sid)).then(r => (typeof r === 'string' ? r : undefined)).catch(() => undefined),
      discard: () => $.fs.write(decisionFile(d, sid), TOMBSTONE).catch(() => undefined),
      writeSlip: t => $.fs.write(approvalFile(d, sid), t),
      clearAll: () => clearApproval($, sid),
      nonce: () => crypto.randomUUID(),
      shown: async approval => {
        me = { ...me, approval }
        await showCrew($)
        await publish($, false)
      },
      now: () => $.clock.now(),
      sleep: ms => sleep($, ms, signal),
      settled: () => settled.has(toolUseId) || signal.aborted, // 引擎放棄這次詢問（使用者中斷、預算用完）→ 立刻清單
      log: (t: string) => $.ui.log(t),
      runWaiter: async (want: Want, deadline: number) => {
        const q = `session=${encodeURIComponent(want.session)}&toolUseId=${encodeURIComponent(want.toolUseId)}&nonce=${encodeURIComponent(want.nonce)}`
        const r = await $.process.run([await pyOf($), '-I', '-c', WAITER_PY, `${await officeUrl($)}/approve-result?${q}`, approvalFile(d, sid), want.nonce, String(deadline), localKeyFile(d)], { timeoutMs: Math.max(1000, deadline - (await $.clock.now()) + 5000) })
        return r.stdout.trim() || 'timeout'
      },
    } satisfies SlipIO & { runWaiter: unknown }
    const r = await runSlipWith(io, { session: sid, name: me.name }, toolUseId, tool, text, window,
      (want, deadline) => (phone ? waitPhone(io, want, deadline) : waitForDecision(io, want, deadline).then(b => (b ? { behavior: b } : undefined))),
      nonce => { openSlip = nonce ? { sid, nonce, toolUseId } : undefined })
    if (r) await logAdopted($, adoptedEntry({ at: await $.clock.now(), session: sid, name: me.name, tool, text, decided: r, phone })).catch(() => undefined)
    return r
}
/** 工具結束（成功、失敗、被拒）：記成已結案，同時把這張單改成墓碑（0.63.51）；只認同一個 tool_use_id */
async function settleAndClose($: EngineInterface, e: unknown) {
  settle(e)
  const id = (e as { tool_use_id?: unknown }).tool_use_id
  if (typeof id === 'string') await closeOpenSlip($, id).catch(() => undefined)
}
/** 詢問在別處結案了（電腦上按了、工具跑完、使用者中斷、送了新的話）：這個視窗正在等的單改成墓碑，等待程式看到就停，手機卡跟著消失 */
async function closeOpenSlip($: EngineInterface, toolUseId?: string) {
  const o = openSlip
  if (!o || (toolUseId !== undefined && toolUseId !== o.toolUseId)) return // 別的工具呼叫結束：不是這張
  const d = await sharedDir($)
  const raw = await $.fs.read(approvalFile(d, o.sid)).then(r => (typeof r === 'string' ? r : undefined)).catch(() => undefined)
  try { if (JSON.parse(raw ?? '{}').nonce !== o.nonce) return } catch { return } // 已經換成別張了：不動
  await $.fs.write(approvalFile(d, o.sid), TOMBSTONE).catch(() => undefined)
}

/** 隊伍順序：等核准（waiting）早的排前面。靠狀態不靠單 —— 核准關著時一樣排隊 */
export function queueOrder(list: Coworker[] = everyone()): string[] {
  return list.filter(c => c.mode === 'waiting').sort((a, b) => (a.since ?? 0) - (b.since ?? 0)).map(c => c.id)
}

/** 開著面板的視窗：讀所有在線 session 的核准單；展開中的那張被換成新的一筆 → 重新展開、冷卻重算 */
async function readApprovals($: EngineInterface, d: string, now: number) {
  const alive = new Set(everyone().map(c => c.id))
  const found: ApprovalRecord[] = []
  for (const id of alive) {
    const raw = await $.fs.read(approvalFile(d, id)).then(r => (typeof r === 'string' ? r : undefined)).catch(() => undefined)
    const a = parseApproval(raw, now)
    if (a && a.session === id) found.push(a)
  }
  found.sort((a, b) => a.at - b.at)
  if (reviewing) {
    const cur = found.find(a => a.session === reviewing!.session)
    if (!cur) reviewing = undefined
    else if (cur.toolUseId !== reviewing.toolUseId || cur.nonce !== reviewing.nonce || cur.text !== reviewing.text) openReview($, cur, now) // 指令被改了也重看
  }
  const changed = JSON.stringify(found) !== JSON.stringify(pending)
  pending = found
  if (changed || found.length > 0) $.ui.invalidate('ui.render') // 有單就每秒重畫，倒數才會動
}

function openReview($: EngineInterface, a: ApprovalRecord, now: number) {
  reviewing = { session: a.session, toolUseId: a.toolUseId, nonce: a.nonce, text: a.text, openedAt: now }
  $.ui.invalidate('ui.render')
  $.clock.after(ALLOW_COOLDOWN_MS + 50, () => $.ui.invalidate('ui.render')) // 冷卻結束，Allow 換回可按的字
  $.clock.after(Math.max(0, a.deadline - now) + 50, () => $.ui.invalidate('ui.render')) // 到 deadline 收起，不必等下一輪 refresh
}

/** 使用者在面板上按 Allow／Deny：重讀那張單，toolUseId、nonce、全文都跟展開時相同才寫決定（只有這裡會寫 decisions/）；決定帶全文的 hash */
async function decide($: EngineInterface, behavior: 'allow' | 'deny') {
  const want = reviewing
  if (!want) return
  const now = await $.clock.now()
  if (behavior === 'allow' && now - want.openedAt < ALLOW_COOLDOWN_MS) {
    $.ui.toast('Just opened: read it all before pressing Allow (enabled after 1 second)')
    return
  }
  const d = await sharedDir($)
  const a = parseApproval(await $.fs.read(approvalFile(d, want.session)).then(r => (typeof r === 'string' ? r : undefined)).catch(() => undefined), now)
  if (!a || a.toolUseId !== want.toolUseId || a.nonce !== want.nonce || a.text !== want.text) {
    reviewing = undefined
    $.ui.toast('This request was already closed or replaced; nothing sent.')
    $.ui.invalidate('ui.render')
    return
  }
  if (now >= a.deadline) return // 過了 deadline：等的那方已交回終端機，寫了也不會被採用
  if (behavior === 'allow' && !approvalFits(a.text)) return
  await $.fs.write(decisionFile(d, want.session), JSON.stringify({ state: 'decided', session: want.session, toolUseId: want.toolUseId, nonce: want.nonce, textHash: await textHash(want.text), behavior, at: now }))
  reviewing = undefined
  $.ui.toast(`${behavior === 'allow' ? 'Allowed' : 'Denied'}: ${a.name}'s ${a.tool}`)
  $.ui.invalidate('ui.render')
}

// 冷卻中與可按同寬（同樣 3 個全形字）：換字時 Deny 不會左右跳（oftest 2026-10-26）
export const ALLOW_WAIT = 'Allow (in 1s)'
export const ALLOW_READY = 'Allow (ready)'

/** 面板上的核准區：等人審的名單（審 <名牌>），展開的那張顯示全文與 Allow／Deny；Allow／Deny 不給 hotkey */
function approvalRows($: EngineInterface, els: Record<string, any>, now: number): unknown[] {
  const { Box, Text, Button } = els
  if (!approveOn) return []
  const banner = <Text key="approval-on" dimColor>Approvals on (/office approve off to turn off)</Text>
  if (pending.every(a => now >= a.deadline)) return [banner]
  const rows: unknown[] = [
    banner,
    <Box key="approval-queue" flexDirection="row">
      <Text color="yellow">🟡 Awaiting your approval: </Text>
      {pending.filter(a => now < a.deadline).map(a => (
        <Button key={`review-${a.session}`} label={`Review ${a.name}`} onPress={async () => openReview($, a, await $.clock.now())} />
      ))}
    </Box>,
  ]
  const live = (a: ApprovalRecord) => now < a.deadline
  const cur = reviewing && pending.filter(live).find(a => a.session === reviewing!.session && a.toolUseId === reviewing!.toolUseId && a.nonce === reviewing!.nonce && a.text === reviewing!.text)
  if (!cur || !reviewing) return rows
  const fits = approvalFits(cur.text)
  const ready = now - reviewing.openedAt >= ALLOW_COOLDOWN_MS
  rows.push(
    <Text key="approval-head" bold>
      {cur.name} wants to use {cur.tool} ({Math.max(0, Math.ceil((cur.deadline - now) / 1000))}s left){fits ? ':' : ' (too long for the panel; read it in its terminal before answering):'}
    </Text>,
    <Text key="approval-body">{fits ? cur.text : `${cur.text.slice(0, 300)}…`}</Text>,
    <Box key="approval-act" flexDirection="row">
      {fits ? <Button key="approval-allow" label={ready ? ALLOW_READY : ALLOW_WAIT} onPress={() => decide($, 'allow')} /> : null}
      <Button key="approval-deny" label="Deny" onPress={() => decide($, 'deny')} />
      <Button key="approval-close" label={fits ? 'Close' : 'Answer in terminal'} onPress={() => { reviewing = undefined; $.ui.invalidate('ui.render') }} />
    </Box>,
  )
  return rows
}

// 暫時狀態：ms 後若沒被別的狀態蓋掉，就切回 to
/**
 * 自己跑一次 ListAgents，從「This session is X [ref]」登記 ListAgents 名稱：外掛直接叫工具、不經模型，不花 tokens。
 * 會跳權限詢問（tool.check 不是 allow）就不跑。沒名字的 session，ListAgents 不印自己那行 → 'unnamed'
 * （jacky 2026-10-27：finance 沒登記，別的 session 傳訊息找不到它）
 */
async function selfRegister($: EngineInterface): Promise<'ok' | 'unnamed' | 'skipped'> {
  if (me.oneshot) return 'skipped'
  try {
    const verdict = await $.tool.check({ tool: 'ListAgents', input: {} })
    if (verdict.decision !== 'allow') return 'skipped'
    const ran: any = await $.tool.call({ tool: 'ListAgents' } as any)
    const out = ran?.text ?? (typeof ran?.result === 'string' ? ran.result : '') // core 給 text；別的外掛自己回答時只有 result
    const self = ran?.deny === undefined ? selfFromListAgents(out) : undefined
    if (!self) return 'unnamed'
    if (self.name !== me.agent || self.ref !== me.ref) await applyProfile($, { agent: self.name, ref: self.ref })
    return 'ok'
  } catch {
    return 'skipped'
  }
}

function revertLater($: EngineInterface, ms: number, to: OfficeMode) {
  const mine = seq
  $.clock.after(ms, () => {
    if (seq === mine) void setMode($, to)
  })
}

export const register: Register = on => {
  registerHr(on) // 手機版人事室的換模型、打斷、整理記憶、清空、封存（舊 po-hr 外掛）
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'office', description: 'pixel-office: open the shared pixel office pane' })
    await $.tool.register({
      name: 'office_profile',
      description: "Set your pixel-office identity (role, nameplate, ListAgents name). Display only; no effect on permissions or files.",
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['manager', 'staff', '主管', '員工'], description: 'manager or staff (主管/員工 also accepted)' },
          name: { type: 'string', description: 'Nameplate, 1-12 alphanumerics; use your short code (e.g. 58, e2)' },
          agent: { type: 'string', description: 'Your ListAgents name (X in "This session is X"); the full string with [ref] is fine' },
          ref: { type: 'string', description: 'Code after your ListAgents name (e.g. 180a9b); tells same-named sessions apart' },
          title: { type: 'string', description: 'Your current job, max 16 chars, Chinese OK' },
          team: { type: 'string', description: "Your manager's ListAgents name (a manager who sets it becomes a department lead); off to leave" },
          auto: { type: 'boolean', description: 'true if your system prompt says auto mode is active' },
        },
      },
    })
    await $.tool.register({
      name: 'office_roster',
      description:
        'List online sessions: nameplate, title, collaboration table (Table column + Tablemates list), role, ListAgents name and ref (for SendMessage), current activity. Use to find a manager or owner, your tablemates (同桌), or confirm who someone is. Read-only.',
      inputSchema: { type: 'object', properties: {} },
    })
    await $.tool.register({
      name: 'office_task',
      description:
        'Task cards on your collaboration table (shared notes on the phone). Managers: when dispatching (lead.md §4), action=create with title and parts [{who: ListAgents name, what, after?: [part numbers to wait for]}], then tell each person their task id and part number. Anyone: action=update id, part (1-based), state doing|done|stuck|waiting, optional note — update your own part when you start, finish or get stuck (the manager may update any part). action=list shows your tasks.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['create', 'update', 'list'] },
          title: { type: 'string', description: 'create: task name (max 40 chars)' },
          parts: { type: 'array', items: { type: 'object', properties: { who: { type: 'string' }, what: { type: 'string' }, after: { type: 'array', items: { type: 'number' } } }, required: ['who', 'what'] }, description: 'create: 1–12 parts; who = ListAgents name; after = 1-based part numbers that must finish first' },
          id: { type: 'string', description: 'update: task id' },
          part: { type: 'number', description: 'update: 1-based part number' },
          state: { type: 'string', enum: ['waiting', 'doing', 'done', 'stuck'] },
          note: { type: 'string', description: 'update: optional one line (max 120 chars), e.g. what you are stuck on' },
        },
        required: ['action'],
      },
    })
    await $.tool.register({
      name: 'office_helper',
      description:
        'Managers only: ask the user (phone notification) to open a helper session for your table, e.g. a long code change or a slow job. You may not open helpers yourself; the user taps Add or No and you get a message back. Max 2 helpers per table; helpers idle 30 min are closed automatically (the user is warned first). kind=codex-art opens a Codex image helper (draws with image_gen, delivers into art-inbox with a delivery note, max 8 images per batch, reports back with office_send; you check the images).',
      inputSchema: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why, one short line the user reads (max 60 chars), e.g. 改程式改很久了' },
          task: { type: 'string', description: 'What the helper should do (its first instruction, max 2000 chars)' },
          name: { type: 'string', description: 'Optional helper name (max 20 chars)' },
          kind: { type: 'string', enum: ['codex-art'], description: 'Optional: codex-art = a Codex image helper. In task list the parts to draw and the reference image paths' },
        },
        required: ['reason', 'task'],
      },
    })
    await $.tool.register({
      name: 'office_meeting',
      description:
        'Meeting-room display: action=start walks participants in, end dismisses (also automatic when all are offline). Display only; sends nothing. Called by skill pixel-office:team meet.md.',
      inputSchema: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['start', 'end'] },
          topic: { type: 'string', description: 'Max 60 chars' },
          participants: { type: 'array', items: { type: 'string' }, description: 'ListAgents names, nameplates or refs; `name [ref]` for same-named sessions' },
          minutes: { type: 'number', description: 'Optional: auto-end after N minutes' },
        },
        required: ['action'],
      },
    })
    instance = await read($, instanceRef)
    if (!instance) {
      instance = crypto.randomUUID()
      await update($, instanceRef, () => instance)
    }
    // Remote Control（bridge）開的對話有人在用：isInteractive 是 false、也沒有 surface，只能看環境變數
    const viaBridge = (await $.env.get('CLAUDE_CODE_ENVIRONMENT_KIND').catch(() => undefined)) === 'bridge'
    oneshotRun = e.isInteractive === false && !attached && !viaBridge && !(await $.session.surfaces().catch(() => [] as const)).some(s => s !== 'terminal')
    configDir = (await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)) || undefined
    await adopt($, await $.session.id())
    await applyPreset($).catch(() => undefined)
    await updateTokens($).catch(() => undefined) // resume：先把之前的算進來
    cpBase = await $.clock.now()
    if (sessionTitle && (!me.title || me.titleAuto)) await autoTitle($, undefined, await $.clock.now()) // classic SessionStart 比這裡先跑時記下的標題
    approveOn = (await $.store.get('approve').catch(() => undefined)) === true
    const savedPet = await $.store.get('pet').catch(() => undefined)
    if (isPet(savedPet)) {
      pet = savedPet
      await update($, petRef, () => savedPet)
    }
    await publish($, false).catch(() => undefined)
    await refresh($).catch(() => undefined)
    await loadButtons($).catch(() => undefined)

    $.clock.every(250, () => {
      frame += 1
      if (rasterOpen && width > 0) {
        void $.ui.blit({ requestId: PANE, key: 'scene', cells: encode(drawScene(everyone(), frame, width, rows, liveWalkers(), lastPlaced ?? undefined, sceneOpts())) }).catch(() => undefined)
        // 寵物按鈕要跟著寵物：Raster 只 blit 不重畫，寵物換格才請面板重畫一次
        const hit = drawVector(everyone(), frame, width, rows, liveWalkers(), lastPlaced ?? undefined, sceneOpts()).hits.find(h => h.what === 'pet')
        const cell = hit ? JSON.stringify(hitCell(hit, 'terminal')) : ''
        if (cell !== petCell || frame === petNote?.until) {
          petCell = cell
          $.ui.invalidate('ui.render')
        }
      }
    })
    $.clock.every(1000, () => void refresh($).catch(() => undefined))
    // Svg 不能像 Raster 那樣 blit，只能整張重畫：每 0.5 秒一次（約每秒 2 格動畫）
    $.clock.every(500, () => {
      if (svgOpen) $.ui.invalidate('ui.render')
    })
    $.clock.every(5000, () => void followSession($).then(() => followRename($)).then(() => publish($, false)).then(() => deliverMail($)).catch(() => undefined))
    // 每 10 秒重讀個人按鈕：某次讀取失敗（例如重載當下）會自己恢復；改了 buttons.json 也不必再打 /office buttons
    $.clock.every(10000, () => void loadButtons($).catch(() => undefined))
    // 等工具就緒再登記；Remote Control 重開的對話開場幾秒還是暫時名稱（例：某個對話-d7），之後才換回對話名稱 → 30 秒、2 分鐘再登記一次（不花 tokens）
    for (const ms of [3000, 30000, 120000]) $.clock.after(ms, () => void selfRegister($))
    await hrSessionStart($).catch(() => undefined) // 手機版人事室的請求（hr.ts）
    setBusyOf(() => ({ cmdPending: !!cmdPending, approval: !!me.approval }))
    // 外掛自己換新版（0.63.25，selfreload.ts）：來源資料夾的版號比自己新、對話閒著，就自己 /reload-plugins
    $.clock.every(60000, () => void selfReload($).catch(() => undefined))

    return next(e)
  })

  // 系統提示加一段（ROLE_SECTION）
  on('prompt.compose', async ($, e, next) => {
    composeSeen = true
    const composed = await next(e)
    return { sections: [...composed.sections, { id: 'pixel-office:role', text: ROLE_SECTION, scope: 'session' as const }] }
  })

  // 用到 ListAgents 時，從輸出抓「This session is X」自動登記（不用模型配合）
  on('tool.call', { tool: 'ListAgents' }, async ($, e, next) => {
    const ran = await next(e)
    try {
      const self = ran.deny === undefined ? selfFromListAgents(ran.text ?? '') : undefined
      if (self && (self.name !== me.agent || self.ref !== me.ref)) await applyProfile($, { agent: self.name, ref: self.ref })
    } catch {}
    return ran
  })

  // office_profile／office_roster 原本強制開場載入（user-30 2026-10-03）；2026-10-31 jacky 裁示改回用到才載入，系統提示那段已寫出工具全名
  on('tool.call', { tool: 'mcp__pixel-office__office_task' }, async ($, e) => {
    const d = `${officeRoot(await sharedDir($))}/tasks`
    const input = e as unknown as Record<string, unknown>
    const now = await $.clock.now()
    const readDef = async (id: string) => parseTask(await $.fs.read(`${d}/${id}.json`).catch(() => undefined))
    if (input.action === 'list') {
      const out: string[] = []
      for (const entry of await $.fs.list(d).catch(() => [])) {
        if (entry.kind !== 'file' || !/^[0-9a-f]{8}\.json$/.test(entry.name)) continue
        const def = await readDef(entry.name.slice(0, 8))
        if (!def || now - def.at > TASK_KEEP_MS * 4) continue
        const mine = def.boss === me.id || def.parts.some(p => p.who === me.agent)
        if (mine) out.push(`${def.id} 「${def.title}」: ${def.parts.map((p, i) => `${i + 1}. ${p.who} — ${p.what}`).join('; ')}`)
      }
      return { result: out.length ? out.join('\n') : 'No tasks for you.' }
    }
    const r = taskOp(input, me, now, input.action === 'update' && typeof input.id === 'string' ? await readDef(input.id) : undefined)
    if (typeof r === 'string') return { result: r }
    await $.fs.write(`${d}/${r.file}`, JSON.stringify(r.data))
    return { result: r.reply }
  })

  on('tool.call', { tool: 'mcp__pixel-office__office_helper' }, async ($, e) => {
    const r = helperAsk(e as unknown as Record<string, unknown>, me)
    if (typeof r === 'string') return { result: r }
    const now = await $.clock.now()
    const ask = { ...r, at: now, cwd: await $.session.cwd().catch(() => undefined) }
    await $.fs.write(`${officeRoot(await sharedDir($))}/helpers/${ask.id}.json`, JSON.stringify(ask))
    return { result: `Asked the user on the phone: "${ask.reason}". Wait for their answer (a message comes back); do not open helper sessions yourself.` }
  })

  on('tool.call', { tool: 'mcp__pixel-office__office_meeting' }, async ($, e) => {
    const text = await setMeeting($, e as unknown as Record<string, unknown>).catch(() => 'Could not write meeting.json; the meeting room was not updated.')
    await refresh($).catch(() => undefined)
    return { result: text }
  })

  on('tool.call', { tool: ROSTER }, async $ => {
    await refresh($).catch(() => undefined)
    const all = everyone()
    return { result: roster(all, await $.clock.now(), oneshotGroups(oneshots), undefined, await tableSeating($, all).catch(() => undefined)) }
  })

  // 送出訊息（SendMessage）：記下收件者與時間，各視窗據此畫紙飛機
  on('tool.call', { tool: 'SendMessage' }, async ($, e, next) => {
    const ran = await next(e)
    const key = mailKey(String((e as { to?: unknown }).to ?? ''))
    const known = mailSaved.get(key)
    if (known === undefined) return ran
    mailSaved.delete(key)
    return ran.deny === undefined ? { ...ran, context: [...(ran.context ?? []), mailSavedNote(key.startsWith('uds:') ? 'that recipient' : key, known)] } : ran
  })

  // 送不到（對方不在線、程序重開位址變了）→ 存辦公室信箱，對方以同名或同職稱上線時轉交
  on('session.send', async ($, e, next) => {
    const sent = await next(e)
    try {
      if (sent.isDelivered) {
        me = { ...me, sentTo: e.to, sentAt: await $.clock.now() }
        await logTableChat($, e.to, String(e.text ?? ''), me.sentAt!).catch(() => undefined)
        await showCrew($)
        await publish($, false)
      } else if (e.origin.kind === 'model' && !e.agentId && shouldMail(sent.reason)) { // claude -p 也能留言；轉交才排除 oneshot
        // 名稱查無時引擎在 hook 之後用自己的字拒收，改 reason 模型看不到：記下來由 SendMessage 的 tool.call 附在 context。
        // 同步先記，不能等 await：SendMessage 的結果不等這個 hook 跑完（API 實測 2026-10-31：先掃 458 個狀態檔再記，提示就貼不上）
        const key = mailKey(e.to)
        mailSaved.set(key, knownName(key))
        const to = await mailName($, e.to)
        if (!to) mailSaved.delete(key)
        else {
          const now = await $.clock.now()
          const mail: Mail = { from: me.agent ?? me.name, to, text: e.text, at: now, state: 'pending' }
          await $.fs.write(`${await mailDir($)}/${now}-${crypto.randomUUID().slice(0, 8)}.json`, JSON.stringify(mail))
        }
      }
    } catch {}
    return sent
  })

  // 收到別的 session 的訊息：記下時間，頭上亮信封
  on('session.receive', async ($, e, next) => {
    try {
      if (e.origin.kind === 'peer' || e.origin.kind === 'peer-send-message') {
        me = { ...me, gotAt: await $.clock.now() }
        await showCrew($)
        await publish($, false)
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
      if (waitsForApproval(verdict.decision, e.tool_use_id, me.auto ? 'auto' : permissionMode)) {
        // 只記主迴圈、由人回答的詢問：subagent 的、host 程式代答的都不送辦公室
        if (e.agentId === undefined && e.approver !== 'host') {
          const now = await $.clock.now()
          asks.splice(0, asks.length, ...asks.filter(a => now - a.at <= ASK_WINDOW_MS), { toolUseId: String(e.tool_use_id), tool: String(e.tool), input: canon(e.input), at: now })
        }
        await setMode($, 'waiting', String(e.tool))
      }
    } catch {}
    return verdict
  })

  // 點人核准：辦公室有人開著才送單；只回 allow／deny，從不送 updatedPermissions（沒有 Always）
  on('classic.PermissionRequest', async ($, e, next) => {
    try {
      const ev = e as unknown as { tool_name: string; tool_input: unknown; agent_id?: string; permission_mode?: string }
      if (ev.agent_id !== undefined || me.auto || NO_HUMAN_MODES.has(ev.permission_mode ?? permissionMode)) return next(e) // auto 交給分類器；subagent 不接
      const toolUseId = matchAsk(asks, ev.tool_name, canon(ev.tool_input), await $.clock.now())
      if (!toolUseId) return next(e)
      await refresh($).catch(() => undefined)
      // 手機核准（0.63.51）：心跳在就等手機（預設 2 分鐘，不吃預算）；不然照原本只在電腦面板核准開著時送單
      const pw = await phoneLiveWait($) // 伺服器說手機（JWT 驗過）在看才等手機（A-2）
      if (pw === undefined && !officeApproves(everyone())) return next(e)
      // 只有電腦面板時：這個 hook 只有 10 秒預算（$.clock 的等待吃預算）：等到預算快用完就自己收單（oftest 2026-10-26 實測）
      const window = pw ?? approvalWindow(next.budget.remainingMs)
      if (window === undefined) return next(e)
      const r = await askOffice($, toolUseId, ev.tool_name, approvalText(ev.tool_name, ev.tool_input), window, next.signal, pw !== undefined)
      if (r?.behavior === 'allow') return { decision: { behavior: 'allow' } }
      if (r?.behavior === 'deny') return { decision: { behavior: 'deny', message: r.via === 'phone' ? `The user denied this on their phone (pixel office)${r.message ? `. Their reason: ${r.message}` : ''}` : 'The user pressed Deny in the pixel office' } }
    } catch {}
    return next(e)
  })

  // 終端機先按了（指令跑完／失敗／被拒）：那張單結案，等的迴圈停下、清檔
  // 0.63.51：同時把這張單改成墓碑（手機的等待程式看到就停、手機卡消失）；只認同一個 tool_use_id
  on('classic.PostToolUse', async ($, e, next) => (await settleAndClose($, e), next(e)))
  on('classic.PostToolUseFailure', async ($, e, next) => (await settleAndClose($, e), next(e)))
  on('classic.PermissionDenied', async ($, e, next) => (await settleAndClose($, e), next(e)))
  // 使用者在電腦上按 Esc／Ctrl+C（含在詢問畫面按 No 之後中斷）、或送了新的一句：這一輪的詢問都不在了
  on('session.stop', ($, e, next) => { void closeOpenSlip($).catch(() => undefined); return next(e) })

  on('ui.close', async ($, e, next) => {
    if ((e as { id?: unknown }).id === PANE) await setOffice($, false).catch(() => undefined)
    return next(e)
  })

  on('session.attach', async ($, e, next) => {
    if (e.surface !== 'terminal') await attend($).catch(() => undefined)
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    // session.start 沒跑完就結束時還沒有 session 編號（仍是預設的 'me'）：不寫，免得留下 me.json 垃圾檔
    if (me.id !== 'me') await publish($, true).catch(() => undefined)
    await writeAutoCheckpoint($).catch(() => undefined)

    return next(e)
  })

  // /office → 開面板；/office role 主管；/office name 58
  on('command.run', { command: 'office' }, async ($, e) => {
    const [sub, ...rest] = e.args.trim().split(/\s+/)
    const value = rest.join(' ')
    if (sub === 'role') return { text: await applyProfile($, { role: value }) }
    if (sub === 'meeting') {
      if (value === 'off') return { text: await setMeeting($, { action: 'end' }) }
      return { text: meeting ? `In a meeting: ${meetingTopic || '(no topic)'}; participants ${attendees.length > 0 ? attendees.join(', ') : 'the manager\'s team'}. End it with /office meeting off` : 'No meeting right now. Meetings are started by skill pixel-office:team (say "start a meeting", or the model calls office_meeting).' }
    }
    if (sub === 'pet') {
      const text = await setPet($, value)
      $.ui.invalidate('ui.render')
      return { text }
    }
    if (sub === 'bite') {
      const text = releaseCat(value)
      $.ui.invalidate('ui.render')
      return { text }
    }
    if (sub === 'name') return { text: await applyProfile($, { name: value }) }
    if (sub === 'agent') return { text: await applyProfile($, { agent: value }) }
    if (sub === 'title') return { text: await applyProfile($, { title: value }) }
    if (sub === 'team') {
      if (value.trim() === '') return { text: 'Usage: /office team <manager\'s ListAgents name> (sit in its team area) | /office team off (clear)' }
      return { text: await applyProfile($, { team: value }) }
    }
    if (sub === 'auto') {
      const v = value.trim().toLowerCase()
      if (v !== 'on' && v !== 'off') return { text: 'Usage: /office auto on (auto mode, no hand-raising) | /office auto off (waits for approval)' }
      return { text: await applyProfile($, { auto: v === 'on' }) }
    }
    if (sub === 'approve') {
      const v = value.trim().toLowerCase()
      if (v !== 'on' && v !== 'off') return { text: `Usage: /office approve on (answer others' approvals while the panel is open) | /office approve off (default). Now: ${approveOn ? 'on' : 'off'}` }
      return { text: await setApprove($, v === 'on') }
    }
    if (sub === 'buttons') {
      const list = await loadButtons($)
      if (list.length === 0) return { text: 'No personal buttons: ~/.claude/pixel-office/buttons.json is missing or malformed.' }
      const row = list.filter(b => !b.object)
      const objs = [...new Set(list.filter(b => b.object).map(b => b.object))]
      return { text: [row.length > 0 ? `Loaded ${row.length} personal buttons: ${row.map(b => b.label).join(', ')}` : '', objs.length > 0 ? `Custom furniture menus: ${objs.join(', ')}` : ''].filter(Boolean).join('; ') }
    }
    if (sub === 'hits') {
      showHits = !showHits
      $.ui.invalidate('ui.render')
      return { text: showHits ? 'Calibration on: red box = real position, ▒ = clickable area, yellow line every 10 units. /office hits again to turn off' : 'Calibration off' }
    }
    if (sub === 'version') return { text: `pixel-office ${VERSION}` }
    if (sub === 'who') {
      await refresh($).catch(() => undefined)
      const all = everyone()
      return { text: roster(all, await $.clock.now(), oneshotGroups(oneshots), 'tokens', await tableSeating($, all).catch(() => undefined)) } // 人看的：最花的排最上面；給模型的 office_roster 維持主管在前
    }
    if (sub !== '' && sub !== undefined) return { text: 'Usage: /office | /office who | /office role manager|staff | /office title <title> | /office name <letters/digits> | /office agent <ListAgents name> | /office team <manager>|off | /office auto on|off | /office approve on|off (answer others\' approvals, off by default) | /office buttons (reload personal buttons) | /office bite [name] (send the pet at someone) | /office pet [cat|baby|bird] (switch pet) | /office meeting [off] (meeting status / end) | /office hits (Desktop click calibration) | /office version' }

    await refresh($).catch(() => undefined)
    await loadButtons($).catch(() => undefined)
    const opened = await $.ui.open({ id: PANE, title: 'Pixel Office' })
    // 手機實測用（jacky 2026-10-27：手機打 /office 說已開啟卻沒畫面）：回報有沒有畫出來、接著哪些畫面，也留一份檔給主管讀
    const surfaces = await $.session.surfaces().catch(() => [] as readonly string[])
    const where = surfaces.length > 0 ? surfaces.join(', ') : 'none'
    const at = new Date(await $.clock.now()).toISOString()
    void sharedDir($)
      .then(d => $.fs.write(`${d.replace(/\/sessions$/, '')}/debug-open.json`, JSON.stringify({ at, session: me.id, opened, surfaces })))
      .catch(() => undefined)
    if (!opened.isPlaced) return { text: `The pixel office was not drawn: ${opened.reason} (attached surfaces: ${where})` }
    const reg = await selfRegister($)
    const tag =
      reg === 'ok' ? `ListAgents name ${me.agent}${me.ref ? ` [${me.ref}]` : ''}; others can message you.`
      : reg === 'unnamed' ? 'This session has no name, so others cannot reach you with SendMessage: name it with /rename <name>, then run /office again.'
      : 'Could not register the ListAgents name automatically (needs permission): run ListAgents once or /office agent <name>.'
    return { text: `Pixel office open. You are ${ROLE_LABEL[me.role]}, nameplate ${me.name}. ${tag} (attached surfaces: ${where})` }
  })

  // 模型自己設定角色／名牌
  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as { role?: string; name?: string; agent?: string; title?: string; auto?: unknown; team?: string }
    const auto = input.auto === true || input.auto === 'true' ? true : input.auto === false || input.auto === 'false' ? false : undefined
    const text = await applyProfile($, { role: input.role, name: input.name, agent: input.agent, ref: input.ref, title: input.title, auto, team: input.team })

    // 自訂工具的 result 只能是字串或內容區塊陣列，不能是物件（實測：物件會被引擎判為格式錯誤）
    return { result: `${text} (now: ${ROLE_LABEL[me.role]}, nameplate ${me.name}, session ${me.id.slice(0, 8)})` }
  })

  on('classic.SessionStart', async ($, e, next) => {
    // startup 時的 session_title 就是 --name（實測 claude -p --name API-probe-01-1）；resume 帶的可能是自動標題，不當 --name
    const t = (e as { session_title?: unknown; source?: unknown }).session_title
    if ((e as { source?: unknown }).source === 'startup' && typeof t === 'string' && t.trim().length > 0) await noteLaunchName($, t.trim()).catch(() => undefined)
    await noteSessionTitle($, e).catch(() => undefined)
    return next(e)
  })

  on('classic.UserPromptSubmit', async ($, e, next) => {
    await closeOpenSlip($).catch(() => undefined)
    await noteSessionTitle($, e).catch(() => undefined)
    return next(e)
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      me = { ...me, blocked: undefined } // 使用者在這個視窗輸入了（例如說放行），紅牌放下
      if (isUserPrompt(e.origin.kind)) {
        const now = await $.clock.now()
        const head = promptHead(e.text)
        if (head) me = { ...me, prompt: { text: head, at: now } }
        await autoTitle($, head, now)
        if (roleNoteDue(composeSeen, roleNoted)) {
          roleNoted = true
          e = { ...e, context: [...(e.context ?? []), ROLE_SECTION] }
        }
        if (me.dup && !dupNoted) {
          dupNoted = true
          e = { ...e, context: [...(e.context ?? []), DUP_NOTE] }
        }
        if (shouldRemindPromote(me, others, promoteNoted)) {
          promoteNoted = true
          e = { ...e, context: [...(e.context ?? []), PROMOTE_NOTE] }
        }
        if (!versionChecked) {
          versionChecked = true // 出錯也不重試：這個提醒不值得每則指令重讀
          try {
            const f = `${officeRoot(await sharedDir($))}/version.json`
            const raw = await $.fs.read(f).catch(() => undefined)
            let seen: string | undefined
            try { seen = raw ? JSON.parse(raw).seen : undefined } catch {}
            const v = versionNote(typeof seen === 'string' ? seen : undefined)
            if (v.write) await $.fs.write(f, JSON.stringify({ seen: VERSION })).catch(() => undefined)
            if (v.note) e = { ...e, context: [...(e.context ?? []), v.note] }
          } catch {} // 不能讓它吞掉後面的收信、檢查點
        }
        if (shouldRemindDemote(me.role, reportsSeenAt, now, demoteNoted)) {
          demoteNoted = true
          e = { ...e, context: [...(e.context ?? []), DEMOTE_NOTE] }
        }
      }
      await setMode($, 'thinking')
      const mail = await takeOwnMail($).catch(() => [] as string[])
      if (mail.length > 0) e = { ...e, context: [...(e.context ?? []), ...mail] }
      if (await syncCheckpoint($) && checkpointDue(cpWorked, cpBase, await $.clock.now(), cpNoted)) {
        cpNoted = true
        e = { ...e, context: [...(e.context ?? []), cpNote(cpCache!.file!)] }
      }
    } catch {}

    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    try {
      if (!e.agentId) me = { ...me, compacts: (me.compacts ?? 0) + 1, ctxPct: undefined } // 壓縮完要等下一次回應才有新的佔比
      if (!e.agentId && cpWorked && (await checkpointFile($))) e = { ...e, instructions: [e.instructions, CP_COMPACT_NOTE].filter(Boolean).join('\n') }
    } catch {}
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const name = String(e.tool)
    try {
      await setMode($, READING.has(name) ? 'reading' : 'typing', name)
    } catch {}
    let ran = await next(e)
    settle(e)
    if (!e.agentId) cpWorked = true
    try {
      const r = ran as { deny?: string; isError?: boolean; text?: string }
      if (classifierBlocked(r)) {
        me = { ...me, blocked: { tool: name, at: await $.clock.now() } }
        await setMode($, 'error', name)
        revertLater($, 2500, 'thinking')
      } else if (ran.deny !== undefined || ran.isError === true) {
        const text = summarizeError(r.deny ?? r.text ?? '')
        me = { ...me, lastError: { text: text || '(no error message)', at: await $.clock.now() } }
        await setMode($, 'error', name)
        revertLater($, 2500, 'thinking')
      } else {
        const kind = detectErrand(name, e)
        if (kind) me = { ...me, errand: { kind, at: await $.clock.now() } }
        await setMode($, 'thinking')
      }
    } catch {}

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    hrTurnDone(e.turnId)
    if (!e.agentId && e.answer) void saveReply($, e.answer).catch(() => undefined)
    try {
      if (!e.agentId) {
        me = { ...me, ctxPct: await contextPct($) }
        await updateTokens($).catch(() => undefined)
      }
      await setMode($, 'done')
      revertLater($, 5000, 'idle')
    } catch {}

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const list = await read($, crew)
    const shown = list.length > 0 ? list : everyone() // 名字照原樣（座位、團隊都靠它）；指令名換短代號只在畫名牌時做（美術 A #14、複驗）
    nightMode = await read($, night)
    pet = await read($, petRef)
    // 餵／放／換寵物按鈕 0.16.0 拿掉：改成點寵物（overlay）；/office pet、/office bite 照舊
    // 升為主管／設為員工按鈕 0.16.0 拿掉（jacky：用不到）；改角色用 /office role
    const toggleNight = () => update($, night, v => !v)
    if (!me.office) void setOffice($, true).catch(() => undefined) // 面板畫得出來＝有人看得到辦公室，等核准的單才會送來
    const now = pending.length > 0 ? await $.clock.now() : 0 // 有單才要算冷卻

    if (e.surface !== 'terminal') {
      if (me.oneshot) await attend($).catch(() => undefined)
      const els = $.ui.resolve(e) as Record<string, unknown>
      const { Box, Text, Button, Link } = $.ui.resolve(e)
      const Svg = els.Svg as typeof Box | undefined
      rasterOpen = false // 終端的 blit 只給 Raster 用（版面 width／rows 照常更新，走路與紙飛機才算得出位置）
      const mine = await read($, buttons)
      const row = mine.filter(b => !b.object) // 有 object 的是家具選單，不畫在底下那排
      if (!Svg) {
        svgOpen = false
        return (
          <Box flexDirection="column">
            <Text bold>Pixel office: {shown.length} online</Text>
            <Text dimColor>This surface cannot draw graphics; showing text only.</Text>
          </Box>
        )
      }
      svgOpen = true
      setSpread(true)
      // 場景撐滿面板高（jacky 2026-10-27：下面不要留白）：上面只有核准列另外佔高，夜間模式在窗戶上、個人按鈕畫在場景裡
      // 向量版最大情境（112×80、30 人＋貓＋紙飛機＋開會＋排隊）約 6.6 萬字元（2026-10-27 實測，含素材表與走路格 3.1 萬），在 Svg 上限 131072 內；超過就縮小再畫
      const approvals = approvalRows($, els, now)
      let sw = sceneWidth(e.props.bodyColumns)
      let sr = desktopRows(e.props.scroll?.bodyRows, e.props.bodyColumns / sw, approvals.length)
      let svg = ''
      const t = new Date(await $.clock.now())
      const clock = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}` // 牆上時鐘：本機時區
      // v2 辦公室（2026-11-22）：跟手機版同一套版面與座位表（上方協作區、下方辦公區，office-<port>.json）；
      // 畫不出來（素材表壞了、人多到超過 Svg 上限）才退回下面原本的 2dPig 向量辦公室
      // 面板一欄＝8 px、一列＝20 px（2.5 單位，見 vector.ts CELL_UNITS）：v2 的 SVG 照這個比例撐滿面板
      if (tableChat && (await $.clock.now()) - tableChat.at > 5000) await loadTableChat($, tableChat.id).catch(() => undefined) // 開著的聊天室 5 秒更新一次
      const openHit = openMenu ? lastHits.find(h => h.what === openMenu) : undefined
      const v2menu = openMenu && openHit ? { title: FURNITURE_ZH[openMenu], items: menuFor(openMenu, mine).map(i => i.label), cancel: '取消', at: openHit, pressed: menuPressed, enter: Date.now() - menuOpenedAt < 300 } : undefined
      const v2 = await v2Svg($, shown, e.props.bodyColumns * 8, Math.max(20, (e.props.scroll?.bodyRows ?? MIN_ROWS) - approvals.length) * 20, oneshotGroups(oneshots), v2menu).catch(() => undefined)
      lastMenuHits = []
      let sceneW = 0 // 點擊區的座標單位：v2 是「格」，整張寬 v2.w 格
      if (v2 && v2.svg.length <= SVG_MAX) {
        width = sw
        rows = sr
        lastPlaced = assignSeats(shown, width, rows, lastPlaced ?? undefined, meeting, attendees) // 走路、開會、排隊的計算照舊用得到
        lastHits = v2.hits // 家具選單、點窗戶切夜間跟原本一樣；v2 沒有寵物、柯基
        lastMenuHits = v2.menuHits ?? []
        lastFixed = []
        sceneW = v2.w
        svg = v2.svg
      }
      for (let tries = 0; tries < 4 && !svg; tries++) {
        if (width !== sw || rows !== sr) {
          width = sw
          rows = sr
        }
        lastPlaced = assignSeats(shown, width, rows, lastPlaced ?? undefined, meeting, attendees)
        const v = drawVector(shown, frame, width, rows, liveWalkers(), lastPlaced, { ...sceneOpts(), clock, corgiFed, oneshots: oneshotGroups(oneshots) }) // Desktop 畫 2dPig 素材＋向量名牌；終端機照舊點陣
        svg = vectorSvg(v)
        lastHits = v.hits
        lastFixed = v.fixed
        if (showHits) {
          const marks = v.hits.map(h => `<rect x="${h.x}" y="${h.y}" width="${h.w}" height="${h.h}" fill="none" stroke="#ff0000" stroke-width="0.4"/>`).join('')
          const grid = Array.from({ length: Math.floor(v.h / 10) + 1 }, (_, i) => `<line x1="0" y1="${i * 10}" x2="${v.width}" y2="${i * 10}" stroke="#ffff00" stroke-width="0.2"/><text x="0.5" y="${i * 10 + 2}" font-size="2" fill="#ffff00">${i * 10}</text>`).join('')
          svg = svg.replace(/<\/svg>$/, `${grid}${marks}</svg>`)
        }
        if (svg.length <= SVG_MAX) break
        if (tries < 3) svg = '' // 太長：縮小再畫一次（最後一次就照原本，畫多少算多少）
        sw = Math.max(48, sw - 12)
        sr = Math.max(40, sr - 8)
      }
      const k = e.props.bodyColumns / (sceneW || width)
      // 舊格式的個人按鈕（沒有 object）：疊在員工區上緣左邊的空地，不另外佔一塊白底（v2：會議室下方、協作區標示上方）
      const at = sceneW ? cellAt(12, 62, 'desktop', k) : cellAt(GEOM.WALL + 1, GEOM.OPEN_Y + 1, 'desktop', k)
      return (
        <Box flexDirection="column">
          {approvals}
          <Box key="stage">
            <Svg key="scene" source={svg} alt={`Pixel office: ${shown.length} online`} />
            {overlay($, els, lastHits, 'desktop', mine, sceneW || width, k)}
            {row.length > 0 ? (
              <Box key="mine" position="absolute" top={at.top} left={at.left} flexDirection="row">
                {row.map((b, i) =>
                  b.url ? (
                    <Link key={`mine-${i}`} href={b.url} label={b.label} />
                  ) : (
                    <Button key={`mine-${i}`} label={b.label} onPress={() => runButton($, b)} />
                  ),
                )}
              </Box>
            ) : null}
          </Box>
        </Box>
      )
    }
    svgOpen = false
    rasterOpen = true
    setSpread(false)

    const { Box, Raster, Button, Text, Link } = $.ui.resolve(e)
    const mine = await read($, buttons)
    const row = mine.filter(b => !b.object)
    width = sceneWidth(e.props.bodyColumns)
    rows = sceneRows(e.props.scroll?.bodyRows) // 撐滿面板，扣掉預留空白與按鈕列
    lastPlaced = assignSeats(shown, width, rows, lastPlaced ?? undefined, meeting, attendees)

    return (
      <Box flexDirection="column">
        {approvalRows($, $.ui.resolve(e) as Record<string, any>, now)}
        <Box key="stage">
          <Raster key="scene" columns={width} rows={rows} cells={encode(drawScene(shown, frame, width, rows, liveWalkers(), lastPlaced, sceneOpts()))} />
          {overlay($, $.ui.resolve(e) as Record<string, any>, terminalScene(drawVector(shown, frame, width, rows, liveWalkers(), lastPlaced, sceneOpts())), 'terminal', mine, width, 1)}
        </Box>
        {/* 預留列：放個人按鈕（~/.claude/pixel-office/buttons.json），沒有就空一列 */}
        {row.length > 0 ? (
          <Box flexDirection="row">
            {row.map((b, i) =>
              b.url ? (
                <Link key={`mine-${i}`} href={b.url} label={`[${b.label}]`} />
              ) : (
                <Button key={`mine-${i}`} label={b.label} onPress={() => runButton($, b)} />
              ),
            )}
          </Box>
        ) : (
          <Text key="reserved" dimColor>
            Personal buttons: ~/.claude/pixel-office/buttons.json
          </Text>
        )}
        <Box flexDirection="row">
          <Button key="night" label={nightMode ? 'Lights on' : 'Night mode'} hotkey="n" onPress={toggleNight} />
          {petNote && frame < petNote.until ? <Text dimColor>{`  ${petNote.text}`}</Text> : null}
          {oneshots.length > 0 ? <Text key="oneshot" dimColor>{`  ${oneshotText(oneshotGroups(oneshots))}`}</Text> : null}
        </Box>
      </Box>
    )
  })
}
