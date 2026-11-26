// 換主管交接（roadmap 第 6 項，0.62.8；使用者 2026-11-23 定案）：招聘「主管＋已有主管的桌」時走這條
// 1. 新人先以員工身分入座（team＝原主管），桌牌顯示「交接中」
// 2. 新人上線後：原主管收到交接指示，用 SendMessage 把交接（團隊、工作、待裁示、檔案位置）傳給新人；新人收到指示，讀完回原主管「接好了」
// 3. 偵測：這桌聊天室（第 12 項，外掛記的）有原主管→新人的話＝交了；新人的話（或最後回覆）有「接好了」＝接好 → 正式換：
//    新人 role＝manager（team＝原主管原本的 team），同桌其他人和原主管 team＝新人，原主管 role＝staff 留在這桌；新人坐 0 號主管椅
// 4. 換好手機通知「某某桌主管換成某某了」
// 5. 例外：原主管 5 分鐘內沒交接 → 手機問「要等，還是直接換？」；原主管離線 → 直接問要不要換，新人改讀協作資料夾的 collab.md、檢查點接手
// 狀態存 handovers-<port>.json
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const HAND_WAIT_MS = 5 * 60e3
export const HAND_BOOT_MS = 10 * 60e3 // 新人開了 10 分鐘還沒進辦公室：作罷
export const HAND_DONE_SHOW_MS = 60 * 60e3 // 「換好了」通知留一小時

export type Handover = {
  id: string; table: number; label: string; collab?: string
  newSid: string; newName: string
  oldId: string; oldName: string; oldHandle: string; oldTeam?: string
  at: number
  state: 'boot' | 'handing' | 'ask-wait' | 'ask-offline' | 'done' | 'cancelled'
  noticeAt?: number; handedAt?: number; doneAt?: number; note?: string
}
type Person = { id: string; plate: string; agent?: string; code?: string; kind?: string; role?: string; team?: string; mode?: string; seat?: string }
export type HandDeps = {
  base: string
  port: () => number
  office: () => { people: Person[] }
  sendCommand: (id: string, text: string) => string | undefined
  /** 正式換主管：改身分、座位、桌子歸屬（server.ts 做，沿用人事令） */
  swap: (h: Handover) => string
  /** 這桌聊天室的紀錄（server.ts tableChat） */
  chat: (table: number) => { at: number; from: { id?: string }; to: { id?: string }; text: string }[]
  lastReply: (id: string) => { text: string; at: number } | undefined
}
let D: HandDeps
export function initHandover(deps: HandDeps) { D = deps }

const file = () => join(D.base, `handovers-${D.port()}.json`)
export function handovers(): Handover[] {
  try { const j = JSON.parse(readFileSync(file(), 'utf8')); return Array.isArray(j.handovers) ? j.handovers : [] } catch { return [] }
}
const save = (list: Handover[]) => writeFileSync(file(), JSON.stringify({ handovers: list }, null, 1))
const NOTE = '（手機像素辦公室，換主管交接）'
export const active = (h: Handover) => h.state !== 'done' && h.state !== 'cancelled'

export function startHandover(h: Omit<Handover, 'id' | 'state'>): Handover {
  const list = handovers().filter(x => !(x.table === h.table && active(x)))
  const x: Handover = { ...h, id: crypto.randomUUID().slice(0, 8), state: 'boot' }
  list.push(x)
  save(list)
  return x
}

const collabText = (h: Handover) => (h.collab ? `這桌的協作資料夾 ${h.collab}（collab.md、checkpoints/）` : '協作資料夾的 collab.md、檢查點（照 pixel-office:team skill 找）')

/** 交接指示：原主管要寫的四件事 */
export const oldBrief = (h: Handover) =>
  `${NOTE}使用者請「${h.newName}」接任協作桌「${h.label}」的主管，你先交接再改當員工（留在這桌）。請用 SendMessage 傳給 ${h.newName} 一份交接，內容：` +
  `①團隊：同桌有誰、各自在做什麼 ②工作：進行中的任務、做到哪、下一步 ③待使用者裁示的事 ④相關檔案、文件的位置（含${collabText(h)}）。同一份交接也寫進協作資料夾 collab.md 的「# 交接紀錄」段（這桌的共用筆記會顯示）。` +
  `傳完就好，等 ${h.newName} 回「接好了」辦公室會自動換；你沒做完的事由新主管決定要不要派回給你。`
export const newBrief = (h: Handover) =>
  `${NOTE}你要接任協作桌「${h.label}」的主管（原主管 ${h.oldHandle}）。等他用 SendMessage 傳交接給你，讀完後用 SendMessage 回 ${h.oldHandle} 一句「接好了」，辦公室就會把你換成主管。` +
  `接任後照 pixel-office:team skill 當主管，協作資料夾用${collabText(h)}；原主管沒做完的事由你決定要不要派回給他。`
const offlineBrief = (h: Handover) =>
  `${NOTE}原主管 ${h.oldHandle} 沒交接（${h.note ?? '離線或沒回應'}），使用者決定直接由你接任協作桌「${h.label}」的主管。請讀${collabText(h)}接手（照 pixel-office:team skill），讀完向使用者回報接手狀況。`

/** 換：交給 server.ts 改身分，再通知 */
function finish(h: Handover, now: number, direct: boolean) {
  if (direct) D.sendCommand(h.newSid, offlineBrief(h))
  h.note = D.swap(h)
  h.state = 'done'
  h.doneAt = now
}

/** 每次輪詢（每分鐘＋每次讀狀態時）推進一步 */
export function tickHandovers(now = Date.now()): void {
  const list = handovers()
  if (!list.some(active)) return
  const { people } = D.office()
  const online = (id: string) => people.some(p => p.id === id)
  for (const h of list) {
    if (h.state === 'boot') {
      if (!online(h.newSid)) { if (now - h.at > HAND_BOOT_MS) { h.state = 'cancelled'; h.note = '新人一直沒進辦公室' } continue }
      if (!online(h.oldId)) { h.state = 'ask-offline'; h.note = '原主管離線'; continue }
      D.sendCommand(h.newSid, newBrief(h))
      D.sendCommand(h.oldId, oldBrief(h))
      h.state = 'handing'
      h.noticeAt = now
      continue
    }
    if (h.state !== 'handing') continue
    if (!online(h.newSid)) { h.state = 'cancelled'; h.note = '新人離線了'; continue }
    const since = h.noticeAt ?? h.at
    const log = D.chat(h.table).filter(c => c.at >= since)
    if (!h.handedAt && log.some(c => c.from.id === h.oldId && c.to.id === h.newSid)) h.handedAt = log.find(c => c.from.id === h.oldId && c.to.id === h.newSid)!.at
    const r = D.lastReply(h.newSid)
    const ready = log.some(c => c.from.id === h.newSid && c.text.includes('接好了')) || (!!h.handedAt && !!r && r.at >= h.handedAt && r.text.includes('接好了'))
    if (ready) { finish(h, now, false); continue }
    if (!h.handedAt && !online(h.oldId)) { h.state = 'ask-offline'; h.note = '原主管離線'; continue }
    if (!h.handedAt && now - since >= HAND_WAIT_MS) { h.state = 'ask-wait'; h.note = '原主管 5 分鐘內沒交接' }
  }
  save(list.filter(h => active(h) || now - (h.doneAt ?? h.at) < HAND_DONE_SHOW_MS))
}

/** 使用者答覆：ask-wait → wait（再等 5 分鐘）或 swap（直接換）；ask-offline → swap 或 cancel */
export function answerHandover(id: string, op: string, now = Date.now()): { ok: boolean; text: string } {
  const list = handovers(), h = list.find(x => x.id === id)
  if (!h || (h.state !== 'ask-wait' && h.state !== 'ask-offline')) return { ok: false, text: '這個交接已經不用回了' }
  if (op === 'wait' && h.state === 'ask-wait') {
    h.state = 'handing'; h.noticeAt = now; h.note = undefined
    D.sendCommand(h.oldId, `${NOTE}提醒：${h.newName} 還在等你的交接。${oldBrief(h)}`)
    save(list)
    return { ok: true, text: `再等 ${h.oldName} 5 分鐘` }
  }
  if (op === 'swap') {
    finish(h, now, true)
    save(list)
    return { ok: true, text: `「${h.label}」主管換成 ${h.newName}（${h.newName} 會讀 collab.md、檢查點接手）` }
  }
  if (op === 'cancel') {
    h.state = 'cancelled'; h.doneAt = now; h.note = '使用者決定不換'
    D.sendCommand(h.newSid, `${NOTE}使用者決定不換主管，你以員工身分留在「${h.label}」，主管照舊是 ${h.oldHandle}`)
    save(list)
    return { ok: true, text: `不換，${h.newName} 留在這桌當員工` }
  }
  return { ok: false, text: '不認得的答覆' }
}

/** 給手機：要問使用者的、換好的通知、哪幾張桌交接中 */
export function handoverView(now = Date.now()) {
  const list = handovers()
  return {
    asks: list.filter(h => h.state === 'ask-wait' || h.state === 'ask-offline').map(h => ({ id: h.id, kind: h.state === 'ask-wait' ? 'wait' : 'offline', label: h.label, oldName: h.oldName, newName: h.newName })),
    done: list.filter(h => h.state === 'done' && now - (h.doneAt ?? 0) < HAND_DONE_SHOW_MS).map(h => ({ id: h.id, label: h.label, newName: h.newName, oldName: h.oldName, at: h.doneAt })),
    tables: [...new Set(list.filter(active).map(h => h.table))],
  }
}
