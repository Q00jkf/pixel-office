// 辦公室裡按允許（0.63.51；使用者 11-26 定案，顧問核准 B 的 (a)(b)(c)）。這支只放純函式，檔案與 tmux 在 server.ts 接。
// Claude：外掛在 PermissionRequest 寫的單 approvals/<session>.json（跟電腦面板同一張）→ 手機卡；手機按了寫 decisions/<session>.json
//   （同一張單的 toolUseId、nonce、指令全文的 hash；via:'phone'；拒絕可附原因），外掛的等待程式看到就採用。電腦上先按：單變墓碑，卡消失。
// Codex（只限開在 tmux 的）：讀畫面。只認「Would you like to run the following command?」＋完全相同的「Yes, proceed (y)」與「(esc)」選項；
//   允許只送熱鍵 y、拒絕送 Esc（再把原因當下一句話送）；編輯檔案等其他確認畫面只給「到電腦上看」。不給「以後都允許」。
// 安全：允許鍵出現 1 秒後才收；只有手機頁（Cloudflare Access 的使用者）能按；每次記一筆
import { createHash } from 'node:crypto'

export const APPROVE_COOLDOWN_MS = 1000
export const APPROVE_TEXT_MAX = 1500 // 同外掛 APPROVAL_TEXT_MAX：全文超過就只給拒絕與「到電腦上看」
const APPROVE_LINES_MAX = 20
export const TOMBSTONE = JSON.stringify({ state: 'done' })

export type Slip = { state: 'waiting'; session: string; name: string; toolUseId: string; tool: string; text: string; nonce: string; at: number; deadline: number }
export type ApproveOpt = { key: 'allow' | 'deny'; label: string }
export type ApprovalInfo = {
  kind: 'claude' | 'codex'
  /** 工具（Bash、Edit…；Codex 是 exec 或 edit） */
  tool: string
  /** 完整指令（或工具參數的 JSON）；前端長的收合可展開 */
  desc: string
  /** Codex 自己寫的理由（只有 Codex 有） */
  reason?: string
  /** 這張卡的編號：POST /approve 要帶回來（不一樣＝已經換了一張） */
  nonce: string
  /** 卡出現的時間（允許鍵在這之後 1 秒才收） */
  at: number
  /** 等到幾點（Claude 才有；過了外掛就交回電腦） */
  deadline?: number
  /** 可以按的：允許這一次、拒絕；空的＝只能「到電腦上看」 */
  options: ApproveOpt[]
  where: 'tmux' | 'app' | 'other'
  /** 為什麼不能在手機按允許（只給拒絕或什麼都不給時） */
  why?: string
}
const ALLOW: ApproveOpt = { key: 'allow', label: '允許這一次' }
const DENY: ApproveOpt = { key: 'deny', label: '拒絕' }

/** 讀到的單：墓碑、壞檔、欄位不全、過了期限一律當沒有（同外掛 parseApproval） */
export function parseSlip(raw: string | undefined, now: number): Slip | undefined {
  try {
    const a = JSON.parse(raw ?? '')
    const ok = a && a.state === 'waiting' && ['session', 'name', 'toolUseId', 'tool', 'text', 'nonce'].every(k => typeof a[k] === 'string') && typeof a.at === 'number' && typeof a.deadline === 'number'
    return ok && now < a.deadline ? (a as Slip) : undefined
  } catch { return undefined }
}
const fits = (t: string) => t.length > 0 && t.length <= APPROVE_TEXT_MAX && t.split('\n').length <= APPROVE_LINES_MAX

/** Claude 的單 → 手機卡 */
export function claudeApproval(slip: Slip, where: ApprovalInfo['where']): ApprovalInfo {
  const ok = fits(slip.text)
  return { kind: 'claude', tool: slip.tool, desc: slip.text.slice(0, 20000), nonce: slip.nonce, at: slip.at, deadline: slip.deadline, options: ok ? [ALLOW, DENY] : [DENY], where, ...(ok ? {} : { why: '指令太長，手機上看不完整：只能拒絕，或到電腦上看' }) }
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/**
 * 手機按了 Claude 的卡：重讀單，同一張（nonce 對）、還沒過期才寫決定。回要寫進 decisions/<session>.json 的內容，或不寫的原因
 */
export function claudeDecision(slip: Slip | undefined, body: { key?: unknown; nonce?: unknown; reason?: unknown }, now: number): { write: Record<string, unknown>; text: string } | { error: string } {
  if (!slip) return { error: '已在電腦上處理了（或已經不等了）' }
  if (body.nonce !== slip.nonce) return { error: '這張已經換了，請重看' }
  const key = body.key
  if (key !== 'allow' && key !== 'deny') return { error: '不認得的按鈕' }
  if (key === 'allow') {
    if (!fits(slip.text)) return { error: '指令太長，不能在手機允許：請到電腦上看' }
    if (now - slip.at < APPROVE_COOLDOWN_MS) return { error: '剛出現，先看完再按（1 秒後才能允許）' }
  }
  const reason = typeof body.reason === 'string' ? body.reason.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 300) : ''
  return {
    write: { state: 'decided', session: slip.session, toolUseId: slip.toolUseId, nonce: slip.nonce, textHash: sha256(slip.text), behavior: key, via: 'phone', ...(key === 'deny' && reason ? { message: reason } : {}), at: now },
    text: key === 'allow' ? `✅ 允許了 ${slip.name} 的 ${slip.tool}，它會接著做` : `🚫 拒絕了 ${slip.name} 的 ${slip.tool}${reason ? `（原因：${reason}）` : ''}`,
  }
}

// ---------- Codex：讀畫面 ----------
const BOX = /[│┃║╭╮╰╯]/g
export type CodexPrompt = { kind: 'run'; command: string; reason?: string } | { kind: 'edit' } | { kind: 'other'; title: string }
/**
 * 從 capture-pane（-J，折行已接回）認出 Codex 的確認畫面（v0.171 實測格式）：
 *   Would you like to run the following command? / Environment: … / Reason: … / $ <指令> / › 1. Yes, proceed (y) / 2. Yes, and don't ask again … (p) / 3. No, … (esc)
 * 指令：「$ 」那行開始，接到選項 1 之前（多行指令的續行也算）。選項 1 的文字必須完全是「Yes, proceed (y)」、要有 (esc) 那一項，否則不給允許。
 * 只看最後一個確認畫面，而且它要在畫面最底下（C-1）
 */
export function codexPrompt(screen: string): CodexPrompt | undefined {
  const lines = screen.replace(/\r/g, '').split('\n').map(l => l.replace(BOX, '').replace(/\s+$/, ''))
  let q = -1
  for (let i = lines.length - 1; i >= 0; i--) if (/Would you like to (run the following command|make the following edits)\?|Allow command\?/.test(lines[i])) { q = i; break }
  if (q < 0) return
  // C-1：畫面最後一行非空的必須是確認畫面的提示或選項（不管哪一種確認畫面）
  const tail = [...lines].reverse().find(l => l.trim())
  if (!tail || !/^\s*Press enter to confirm or esc to cancel\s*$|^\s*[›>❯]?\s*\d\.\s/.test(tail)) return
  if (/make the following edits/.test(lines[q])) return { kind: 'edit' }
  if (!/run the following command/.test(lines[q])) return { kind: 'other', title: lines[q].trim() }
  const rest = lines.slice(q + 1)
  const o1 = rest.findIndex(l => /^\s*[›>❯]?\s*1\.\s/.test(l))
  if (o1 < 0) return { kind: 'other', title: lines[q].trim() }
  const opts = rest.slice(o1)
  // C-1（0.63.53）：確認畫面要在畫面最底下（呼叫端只抓可視範圍）：選項之後只能是「Press enter to confirm or esc to cancel」或空行；
  // 捲動紀錄裡留下的舊畫面、指令輸出裡印出來的假畫面，底下還有別的（輸入框、其他輸出），一律不算
  let last = 0
  while (last + 1 < opts.length && /^\s*[›>❯]?\s*\d\.\s/.test(opts[last + 1])) last++
  if (opts.slice(last + 1).some(l => l.trim() && !/^\s*Press enter to confirm or esc to cancel\s*$/.test(l))) return
  const yes = /^\s*[›>❯]?\s*1\.\s+Yes, proceed \(y\)\s*$/.test(opts[0])
  const esc = opts.slice(0, 6).some(l => /^\s*[›>❯]?\s*\d\.\s+No\b.*\(esc\)\s*$/.test(l))
  const head = rest.slice(0, o1)
  const d = head.findIndex(l => /^\s*\$ /.test(l))
  const reason = head.find(l => /^\s*Reason:/.test(l))?.replace(/^\s*Reason:\s*/, '')
  if (d < 0 || !yes || !esc) return { kind: 'other', title: lines[q].trim() }
  const cmd = [head[d].replace(/^\s*\$ /, ''), ...head.slice(d + 1).map(l => l.replace(/^\s{2}/, ''))].join('\n').replace(/\n+$/, '')
  return { kind: 'run', command: cmd, ...(reason ? { reason } : {}) }
}
/** Codex 的確認畫面 → 手機卡；firstSeen＝第一次看到這張的時間（冷卻從這裡算） */
export function codexApproval(p: CodexPrompt, pane: string, firstSeen: number): ApprovalInfo {
  if (p.kind === 'run') return { kind: 'codex', tool: 'exec', desc: p.command, ...(p.reason ? { reason: p.reason } : {}), nonce: sha256(`${pane}\n${p.command}`).slice(0, 16), at: firstSeen, options: [ALLOW, DENY], where: 'tmux' }
  const title = p.kind === 'edit' ? 'Codex 要改檔案' : p.title
  return { kind: 'codex', tool: p.kind === 'edit' ? 'edit' : 'other', desc: title, nonce: sha256(`${pane}\n${title}`).slice(0, 16), at: firstSeen, options: [], where: 'tmux', why: '這種確認手機上看不完整（例如一大段修改）：請到電腦上看' }
}

/** 手機心跳檔的內容（伺服器在手機頁輪詢時寫，外掛讀）：off＝remote.json 的 phoneApprove:false 強制關 */
export function phoneBeat(now: number, cfg: { phoneApprove?: unknown; approveWaitMs?: unknown }): Record<string, unknown> {
  if (cfg.phoneApprove === false) return { off: true, at: now }
  const w = typeof cfg.approveWaitMs === 'number' && cfg.approveWaitMs >= 10000 ? Math.min(cfg.approveWaitMs, 540000) : 120000
  return { at: now, waitMs: w }
}
/** 一行紀錄的文字 */
export const approveLog = (who: string, info: { tool: string; desc: string }, key: 'allow' | 'deny', reason?: string) =>
  `📱 手機${key === 'allow' ? '允許' : '拒絕'}了 ${who} 的 ${info.tool}：${info.desc.replace(/\s+/g, ' ').slice(0, 80)}${key === 'deny' && reason ? `（原因：${reason.slice(0, 80)}）` : ''}`

/** 替 Codex 按（POST /approve 用；外部動作可換，測試用 tmux-iso）：按前重抓畫面還是同一張、tmux socket 驗過才送一個鍵（y 或 Esc），送完再抓確認畫面離開 */
export type PressDeps = {
  capture: (pane: string) => string | undefined
  socketOk: (pane: string) => boolean
  send: (pane: string, key: string) => { ok: boolean; readOnly?: boolean }
  sleep: (ms: number) => Promise<unknown>
}
export async function codexPress(pane: string, nonce: string, key: 'allow' | 'deny', deps: PressDeps): Promise<{ ok: boolean; text: string; sent?: boolean }> {
  const nonceOf = (screen: string | undefined) => { const p = screen ? codexPrompt(screen) : undefined; return p ? codexApproval(p, pane, 0).nonce : undefined }
  const before = deps.capture(pane)
  if (nonceOf(before) !== nonce) return { ok: false, text: '畫面已經變了，請重看' }
  const p = codexPrompt(before!)
  if (!p || p.kind !== 'run') return { ok: false, text: '這種確認請到電腦上看' }
  if (!deps.socketOk(pane)) return { ok: false, text: '連不上電腦上的 tmux，請到電腦上按' }
  const r = deps.send(pane, key === 'allow' ? 'y' : 'Escape')
  if (!r.ok) return { ok: false, text: r.readOnly ? 'READONLY' : '按鍵送不過去，請到電腦上按' }
  await deps.sleep(1200)
  if (nonceOf(deps.capture(pane)) === nonce) return { ok: false, text: '按了，但畫面沒變：請到電腦上看', sent: true }
  return { ok: true, text: '', sent: true }
}
/** 桌聊那一行（D-1，0.63.53）：只寫誰、工具、允許／拒絕，不帶指令（同桌的 AI 都讀得到；完整內容只進 approve-log.jsonl） */
export const approveChatLine = (who: string, tool: string, key: 'allow' | 'deny') => `📱 手機${key === 'allow' ? '允許' : '拒絕'}了 ${who} 的 ${tool}`

/**
 * 手機核准沒開時的卡（0.63.54，主管上線條件）：這個請求不是 JWT 驗過的手機頁、remote.json 沒設 access、或 phoneApprove:false 時，
 * 每張卡都不給按鈕、寫清楚「手機核准還沒開，請到電腦按」和原因；外掛沒送單但正在等允許的 Claude（mode waiting＋tool）也給一張這樣的卡，
 * 不會只是灰掉、也不會什麼都沒有。手機核准開著：有單的原樣回傳；沒單卻在等允許的給「已交回電腦」卡（0.63.56）
 */
export function phoneOffCard(p: { kind?: string; mode?: string; tool?: string; src?: string; host?: string; approvalInfo?: ApprovalInfo }, why: string | undefined, now: number): ApprovalInfo | undefined {
  if (why && p.approvalInfo) return { ...p.approvalInfo, options: [], why: `手機核准還沒開，請到電腦按（${why}）` }
  if (p.approvalInfo || p.kind || p.mode !== 'waiting' || !p.tool) return p.approvalInfo
  const where = p.src === 'app' || p.host === 'app' ? 'app' : p.src === 'tmux' || p.host === 'tmux' ? 'tmux' : 'other'
  // 外掛沒送單（或手機等候時間過了、已收單）卻還在等允許的 Claude：手機核准沒開 → 寫原因；開著 → 寫「已交回電腦」（0.63.56）
  return why
    ? { kind: 'claude', tool: p.tool, desc: '（指令全文要手機核准開了才看得到）', nonce: '', at: now, options: [], where, why: `手機核准還沒開，請到電腦按（${why}）` }
    : { kind: 'claude', tool: p.tool, desc: '（這個詢問已交回電腦，手機上看不到指令全文）', nonce: '', at: now, options: [], where, why: HANDED_BACK }
}
/** 交回電腦的說明（0.63.56）：手機等候時間（預設 2 分鐘）過了，或詢問出現時手機沒開著辦公室頁，外掛就只等電腦；同一個詢問不會再回到手機 */
export const HANDED_BACK = '這個詢問已交回電腦，請到電腦按（手機等候時間已過，或詢問出現時手機沒開著辦公室頁）'
/** 這個請求為什麼不能在手機核准（開著回 undefined） */
export const phoneOffWhy = (auth: { ok: boolean; why?: string }, cfg: { phoneApprove?: unknown }): string | undefined =>
  cfg.phoneApprove === false ? 'remote.json 的 phoneApprove 是 false' : auth.ok ? undefined : /沒設 access/.test(auth.why ?? '') ? 'remote.json 還沒設 access' : '只有經 Cloudflare Access 登入的手機頁能按'
