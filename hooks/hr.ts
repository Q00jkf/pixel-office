// 人事（2026-11-22 從 po-hr 外掛 0.1.2 併進來）：手機版人事室（remote/hr.ts）寫 ~/.claude/pixel-office/hr/<sessionId>.json，
// 每個對話裡每秒看一次，有新的就照做，結果寫 <sessionId>.done.json。從 Claude app 開的對話沒有終端機，換模型、打斷只能靠這個。
//   model   → 之後主對話的請求改用這個模型（不跑 /model：會跳確認畫面、還會改掉新對話的預設）
//   effort  → 之後主對話的請求改用這個投入程度（0.63.9；不跑 /effort：會存成新對話的預設）；alive.json 回報實際送出的 effort
//   esc     → 打斷正在跑的那一輪          compact → 整理記憶          clear → /clear
//   reload  → /reload-plugins（0.63.25；只對這一個對話）
//   archive → 用遠端工作階段工具封存另一個對話（解雇時伺服器挑「別人」來做，不叫被解雇的那位自己封存）
// 每 10 秒寫 <sessionId>.alive.json：伺服器據此知道這個對話能接人事命令、能不能封存（有沒有 claude-code-remote）
// 🔴 裝了這版就不要再裝 po-hr：兩邊會搶同一個請求
import type { EngineInterface, Register } from 'claude-code'
import { canReloadNow } from './selfreload'

const REMOTE = 'claude-code-remote'
const TTL_MS = 2 * 60 * 1000

type Mem = { turnId?: string; dir: string; busy: boolean; canArchive?: boolean; lastAlive: number; model?: string; effort?: Effort; seenEffort?: string; lastActive: number }
type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max']
const mem: Mem = { dir: '', busy: false, lastAlive: 0, lastActive: Date.now() }

async function probe($: EngineInterface): Promise<boolean> {
  if (mem.canArchive !== undefined) return mem.canArchive
  try {
    // 問一個不存在的編號：工具連得上就算能用（回錯誤結果也沒關係，連不上才會丟例外）
    await $.mcp.call(REMOTE, 'get_session', { session_id: 'session_probe' })
    mem.canArchive = true
  } catch {
    mem.canArchive = false
  }
  return mem.canArchive
}

export async function runHr($: EngineInterface, req: { op?: unknown; model?: unknown; effort?: unknown; bridge?: unknown }): Promise<{ ok: boolean; msg: string }> {
  if (req.op === 'effort') {
    const v = String(req.effort ?? '') as Effort
    if (!EFFORTS.includes(v)) return { ok: false, msg: '投入程度不對' }
    mem.effort = v
    await $.store.set(`effort:${await $.session.id()}`, v)
    return { ok: true, msg: `下一次回覆起投入程度改成 ${v}` }
  }
  if (req.op === 'model') {
    const m = String(req.model ?? '').trim()
    if (!/^[a-z0-9.\-]{2,60}$/.test(m)) return { ok: false, msg: '模型名稱不對' }
    mem.model = m
    await $.store.set(`model:${await $.session.id()}`, m)
    return { ok: true, msg: `下一次回覆起改用 ${m}` }
  }
  if (req.op === 'reload') { // 只讓這一個對話重載外掛（0.63.25：驗證用）；跟自己換新版共用同一個「可以重載」判定（0.63.26）
    const r = await reloadIfIdle($)
    if (!r.ran) return { ok: false, msg: '對話正在忙，或 5 分鐘內有人用過，晚點再試' }
    return { ok: true, msg: '已叫 /reload-plugins' } // 不等它做完：重載會換掉這份程式碼
  }
  if (req.op === 'esc') {
    if (!mem.turnId) return { ok: true, msg: '沒有在跑的工作' }
    await $.turn.abort({ turnId: mem.turnId })
    return { ok: true, msg: '已打斷' }
  }
  if (req.op === 'compact') {
    const r: any = await $.session.compact()
    return { ok: true, msg: r?.skip ? `沒有整理：${r.skip}` : '記憶整理好了' }
  }
  if (req.op === 'clear') {
    const r: any = await $.command.run({ command: 'clear' } as any)
    return { ok: true, msg: r?.text ?? '已清空' }
  }
  if (req.op === 'archive') {
    const r: any = await $.mcp.call(REMOTE, 'archive_session', { session_id: String(req.bridge ?? '') })
    const text = (r.content ?? []).map((c: any) => (typeof c?.text === 'string' ? c.text : '')).join(' ').slice(0, 300)
    return { ok: !r.isError, msg: text || (r.isError ? '封存失敗' : '已封存') }
  }
  return { ok: false, msg: `不認得的動作 ${String(req.op)}` }
}

async function poll($: EngineInterface) {
  const sid = await $.session.id()
  const now = await $.clock.now()
  if (now - mem.lastAlive > 10000) {
    mem.lastAlive = now
    const archive = await probe($)
    await $.fs.write(`${mem.dir}/${sid}.alive.json`, JSON.stringify({ at: now, archive, ...(mem.seenEffort ? { effort: mem.seenEffort } : {}) })).catch(() => undefined)
  }
  const f = `${mem.dir}/${sid}.json`
  if (!(await $.fs.exists(f).catch(() => false))) return
  let req: any
  try { req = JSON.parse(String(await $.fs.read(f))) } catch { return }
  if (typeof req?.nonce !== 'string' || !(now - Number(req.at) < TTL_MS)) return
  const doneFile = `${mem.dir}/${sid}.done.json`
  const done = await $.fs.read(doneFile).then(t => JSON.parse(String(t)).nonce).catch(() => undefined)
  if (done === req.nonce) return
  await $.fs.write(doneFile, JSON.stringify({ nonce: req.nonce, at: now, state: 'running' }))
  let out: { ok: boolean; msg: string }
  try {
    out = await runHr($, req)
  } catch (err) {
    out = { ok: false, msg: String((err as Error)?.message ?? err).slice(0, 300) }
  }
  await $.fs.write(doneFile, JSON.stringify({ nonce: req.nonce, at: await $.clock.now(), state: 'done', ...out }))
}

async function tick($: EngineInterface) {
  if (mem.busy || !mem.dir) return
  mem.busy = true
  try { await poll($) } catch {} finally { mem.busy = false }
}

/**
 * 在 register.tsx 的 register 一開頭叫：掛上 register.tsx 自己沒用到的 turn.start、turn.step。
 * 同一個事件只能掛一次：session.start、turn.complete 由 register.tsx 原本的 hook 叫 hrSessionStart、hrTurnDone
 */
export const registerHr: Register = on => {
  on('turn.start', ($, e, next) => {
    if (e.agentId === undefined) { mem.turnId = e.turnId; mem.lastActive = Date.now() }
    return next(e)
  })
  // 打字：輸入框有變動就算有活動（終端機看得到；App／SDK 代管的對話可能不會觸發）
  on('prompt.change', ($, e, next) => {
    mem.lastActive = Date.now()
    return next(e)
  })
  // 手機換的模型、投入程度：只換主對話的請求，子代理照它自己的
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)
    let step = mem.model && e.model !== mem.model ? { ...e, model: mem.model } : e
    if (mem.effort && step.effort !== undefined && step.effort !== mem.effort) step = { ...step, effort: mem.effort } // 模型不收 effort 時（undefined）不加
    if (typeof step.effort === 'string') mem.seenEffort = step.effort
    return yield* next(step)
  })
}
/** register.tsx 告訴這裡：有沒有待送的佇列訊息、有沒有等核准（不帶 $，只回值） */
let busyOf: () => { cmdPending: boolean; approval: boolean } = () => ({ cmdPending: false, approval: false })
export function setBusyOf(fn: typeof busyOf) { busyOf = fn }
/**
 * 可以重載就馬上叫（0.63.26，審查 0.63.25 第 2 項）：自己換新版（register.tsx selfReload）和人事通道的 reload 共用。
 * 讀完輸入框之後就是同步的判定與呼叫，中間沒有 await；同一時間只叫一次。回 undefined＝現在不行，回 Promise＝已經叫了
 */
let reloading = false
/**
 * 回 { ran: false }＝現在不行；{ ran: true, done }＝已經叫了（0.63.27，快驗第 1 項：原本直接回內層 Promise，
 * async 函式會把它展平，呼叫的人拿到的是 reload 的結果、以為沒叫）
 */
export async function reloadIfIdle($: EngineInterface): Promise<{ ran: false } | { ran: true; done: Promise<unknown> }> {
  if (reloading) return { ran: false }
  // 讀輸入框失敗＝看不出來，不重載（快驗第 3 項）；App／SDK 代管的對話本來就回空字串，照已知限制靠「5 分鐘沒動靜」
  let box: { text: string }
  try { box = await $.prompt.read() } catch { return { ran: false } }
  const b = busyOf()
  if (reloading || !canReloadNow({ turnRunning: !!mem.turnId, cmdPending: b.cmdPending, approval: b.approval, draft: box.text, lastActive: mem.lastActive, now: Date.now() })) return { ran: false }
  reloading = true
  const done = $.command.run({ command: 'reload-plugins' } as any).finally(() => { reloading = false })
  return { ran: true, done }
}
export function hrTurnDone(turnId: string | undefined) {
  mem.lastActive = Date.now()
  if (turnId === mem.turnId) mem.turnId = undefined
}
export async function hrSessionStart($: EngineInterface) {
  const saved = await $.store.get(`model:${await $.session.id()}`).catch(() => undefined)
  mem.model = typeof saved === 'string' ? saved : undefined
  const eff = await $.store.get(`effort:${await $.session.id()}`).catch(() => undefined)
  mem.effort = EFFORTS.includes(eff as Effort) ? (eff as Effort) : undefined
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME'))
  if (home) {
    mem.dir = `${home.replace(/\\/g, '/')}/.claude/pixel-office/hr`
    $.clock.every(1000, () => void tick($))
  }
}
