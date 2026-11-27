// v2 辦公室的座位與協作桌（2026-11-22 從 v2 預覽伺服器搬進來）。純資料、不碰檔案：手機版伺服器（remote/server.ts）與面板（register.tsx）共用
// 版面：上方「協作區」（協作桌 2／4／6／8 人，圍著桌子坐）、下方「辦公區」（雙人辦公桌，大家面向下）
// 座位用字串代號：協作桌 `t<桌號>.<i>`（i 偶數＝遠側面向下、奇數＝近側面向上，每兩個一欄）、辦公區 `o<k>`
// 分配順序：①長按拖過的（pins）②同一個主管底下的人（主管＋掛他的員工）坐同一張協作桌，主管固定坐 0 號 ③其餘坐辦公區
// 協作桌由使用者新增／改人數／改名／刪除；團隊沒桌子時自動開一張剛好坐得下的（auto），團隊都下線就收掉自動開的那張
// 座位表存在 ~/.claude/pixel-office/office-<port>.json（手機版伺服器寫；面板只讀，排出來跟手機一樣）
import type { Coworker } from '../types'

/** collab：這桌的協作資料夾（放 collab.md、checkpoints/；0.62.9）。交接、接手一律讀它，沒設才退回解析主管的工作資料夾 */
/** 協作桌設成一組（0.63.45，remote/teamup.ts）：主管、team 值、已通知的人、三步是否都做完 */
export type TeamGroup = { boss: string; team: string; notified: string[]; bossKnows?: string[]; dir?: string; at: number; complete: boolean } // bossKnows：主管已收過通知、知道在組裡的成員
export type Table = { id: number; name: string; size: number; team?: string; auto?: boolean; collab?: string; admin?: string; bossLeft?: number; group?: TeamGroup } // admin：這桌行政的 session id（0.62.10）；bossLeft：主管關掉 App 分頁被解雇的時間（0.63.24，有新主管就清掉）
/** noAuto：使用者刪掉過桌子的團隊（主管 agent → true）：這隊先坐辦公區、不自動開新桌，等這隊都下線才清（0.62.18） */
export type Store = { tables: Table[]; seats: Record<string, { key: string; seen: number }>; pins: Record<string, string>; nextId: number; noAuto?: Record<string, true>; reserved?: Record<string, string>; pinBy?: Record<string, PinSrc>; joined?: Record<string, Joined>; bossAt?: Record<string, number>; handApplied?: Record<string, number> } // reserved：不在線也替他保留的座位（0.63.29，交給 App 的 Codex）
/**
 * 0.63.58（顧問裁示）：pins 格式不改（舊檔讀得懂），另外記
 * - pinBy：釘選的來源。hire＝招聘、交接、系統替人換位；drag＝使用者用 /move 拖的。沒有來源的是舊釘選
 * - joined：每個人上次處理過的 team（基準）；next／at＝看到 team 改了、但新團隊還沒成形（主管暫時離線）時，記下改成什麼、什麼時候
 * - bossAt：第一次看到這位主管（role＝manager、有 agent）的時間，同一個基本名稱有好幾位主管時給最新的
 * - handApplied：已經套用過的交接紀錄 id → 套用的時間；套用過就不再用（審查 H-1、顧問裁示）。
 *   紀錄還在 handovers 檔裡就不忘；不在檔裡、而且套用超過 7 天才刪（複審 H-1b）
 */
export type PinSrc = { by: 'hire' | 'drag'; at: number }
export type Joined = { team: string; next?: string; at?: number }
/** 分座位要用到的欄位（state.json 的每個人） */
export type Seatable = { id: string; role?: string; agent?: string; team?: string; plate?: string; name?: string }

export const SIZES = [2, 4, 6, 8]
const fitSize = (n: number) => SIZES.find(s => s >= n) ?? 8
const KEEP_MS = 30 * 24 * 3600e3

export const emptyStore = (): Store => ({ tables: [], seats: {}, pins: {}, nextId: 1 })

/** 座位表檔的文字 → Store；讀不懂就是空的 */
export function parseStore(text: string | undefined): Store {
  try {
    const j = JSON.parse(String(text))
    return { tables: Array.isArray(j.tables) ? j.tables : [], seats: j.seats ?? {}, pins: j.pins ?? {}, nextId: Number(j.nextId) || 1, ...(j.noAuto && typeof j.noAuto === 'object' ? { noAuto: j.noAuto } : {}), ...(j.reserved && typeof j.reserved === 'object' ? { reserved: j.reserved } : {}), ...(obj(j.pinBy) ? { pinBy: j.pinBy } : {}), ...(obj(j.joined) ? { joined: j.joined } : {}), ...(obj(j.bossAt) ? { bossAt: j.bossAt } : {}), ...(obj(j.handApplied) ? { handApplied: j.handApplied } : {}) }
  } catch {
    return emptyStore()
  }
}
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** 釘座位一律走這裡，記下來源（0.63.58） */
export function pinSeat(S: Store, id: string, key: string, by: PinSrc['by'], now = Date.now()): void {
  S.pins[id] = key
  ;(S.pinBy ??= {})[id] = { by, at: now }
}
export function unpin(S: Store, id: string): void {
  delete S.pins[id]
  if (S.pinBy) delete S.pinBy[id]
}

/**
 * 名牌顯示中文：外掛為了終端機把名牌的中文去掉，沒取名的對話只剩編號兩碼（7b、a2）。手機與 Desktop 面板畫得出中文：
 * 有中文的 ListAgents 名稱就用它，否則用職稱（沒設時是指令前 16 字自動帶的），最多 10 字；原本的名牌留在 code。
 * team 原本寫的是舊名牌，一併換成新名牌，分區才對得上
 */
const CJK = /[㐀-鿿]/
export function chinesePlates<C extends Coworker>(people: C[]): (C & { code: string })[] {
  const rename = new Map<string, string>()
  const out = people.map(c => {
    const agent = typeof c.agent === 'string' ? c.agent.trim() : ''
    let title = typeof c.title === 'string' ? c.title.replace(/\s+/g, ' ').trim() : ''
    // 自動帶的職稱是第一句話：「!cat ~/.claude/s」「/office who」這種指令不拿來當名牌，改用 ListAgents 名稱或短代號（2026-11-23）
    const cmd = !!c.titleAuto && /^[!/]/.test(title)
    if (cmd) title = ''
    const pick = agent && CJK.test(agent) ? agent : title || (cmd && agent) || c.name
    const name = [...pick].slice(0, 10).join('')
    rename.set(c.name, name)
    return { ...c, code: c.name, name }
  })
  for (const c of out) if (c.team && rename.has(c.team) && !out.some(m => m.agent === c.team)) c.team = rename.get(c.team)
  return out
}

export function seatExists(S: Store, key: string): boolean {
  if (/^o\d+$/.test(key)) return true
  const m = key.match(/^t(\d+)\.(\d+)$/)
  if (!m) return false
  const t = S.tables.find(t => t.id === +m[1])
  return !!t && +m[2] < t.size
}

/**
 * 主管（role＝manager、有 agent）＋掛在他底下的員工（team＝主管的 agent／名牌）＝一個團隊；只有主管一個人不算。
 * 部門主管（自己底下也有人）只算自己那一隊，不算上一層主管的組員（0.64.7：原本兩隊都算，② 先排到上一層那桌，
 * 部門主管坐進上一層的桌、自己那桌的 0 號空著、組員多的坐不下；跟 scene.ts 的 isDeptLead「底下有人才自成一隊」一致）
 */
export function teamsOf<P extends Seatable>(people: P[]): Map<string, P[]> {
  const under = (m: P) => people.filter(p => p.id !== m.id && p.team && (p.team === m.agent || p.team === m.plate || p.team === m.name))
  const leads = new Set(people.filter(m => m.role === 'manager' && m.agent && under(m).length).map(m => m.id))
  const out = new Map<string, P[]>()
  for (const m of people) if (leads.has(m.id)) {
    const members = under(m).filter(p => !leads.has(p.id))
    if (members.length) out.set(m.agent!, [m, ...members])
  }
  return out
}

/** 桌子改歸另一位主管（0.63.57）：team 真的換了才動；舊主管設的「成組」一起清掉，讓新主管重新設 */
export function retarget(t: Table, agent: string): boolean {
  if (t.team === agent) return false
  t.team = agent
  delete t.group
  return true
}

/** 名字去掉最後的括號後綴（「示範團隊主管（接手）」→「示範團隊主管」），全形半形都算，疊好幾層也一路去掉（0.63.58） */
export function baseName(s: string): string {
  let out = s.trim(), prev = ''
  while (out !== prev) { prev = out; out = out.replace(/\s*[（(][^（）()]*[）)]$/u, '').trim() }
  return out
}

/** 交接紀錄裡已經換好的（handovers-<port>.json，state＝done）：哪張桌從誰（oldHandle）換成哪個 session；at＝換好的時間 */
export type HandoverHint = { id: string; table: number; newSid: string; oldHandle: string; at?: number }
/** 交接紀錄的有效期：換好超過 7 天就不用（複審 H-1b） */
export const HAND_HINT_MS = 7 * 24 * 3600e3

/**
 * 換主管後桌子的 team 還是舊的：以桌子為主一次決定每張桌歸誰（0.63.57 起；0.63.58 照顧問裁示改成以桌為主，不再照主管名字排序輪流搶）。
 * a. 交接紀錄：這張桌最新一筆換好的紀錄，newSid 在線、是主管，而且桌子的 team 還是交接前的舊主管（oldHandle）、
 *    或對不到在線主管，桌子就歸他（跟 swapBoss 一樣，就算舊主管還在線）。
 *    桌子之後被升主管、設成一組、另聘主管改給別位在線主管時，紀錄就不算數（審查 H-1：舊紀錄會把桌子搶回去）。
 *    再加一道保險（顧問裁示）：套用過一次就記在 handApplied，之後不再用；換好超過 7 天的紀錄一律不用（複審 H-1b）
 * 下面幾條只看 team 對不到在線主管 agent 的桌（在線主管的桌一律不搶，就算那位沒有組員）：
 * b. 名字：別名（team 寫的是帶團隊的主管的名牌或 name），再來是基本名稱（去掉括號後綴）跟某位在線主管相同。
 *    同一個基本名稱有好幾位在線主管時，給最新登記（bossAt 最晚）的；同時登記的，帶著團隊的優先、名字有後綴的（接手的人）優先
 * c. 主管座：帶團隊的主管被釘在、或上次坐在這桌的 0 號（複驗 T-1：坐在別桌非 0 號的小隊長不算）
 * 一位主管只接一張；他已經有非自動開的桌就不再給（交接紀錄除外），只有自動開的桌就把那張收掉。
 * 主管椅讓位不在這裡做，見 assign 的「主管座讓位」。
 */
export function claimTables(S: Store, people: Seatable[], teams: Map<string, Seatable[]>, handovers: HandoverHint[] = [], now = Date.now()): boolean {
  const managers = people.filter(p => p.role === 'manager' && p.agent)
  const live = new Set(managers.map(m => m.agent!))
  const leads = managers.filter(m => teams.has(m.agent!))
  const newest = (list: Seatable[]) => [...list].sort((a, b) =>
    (S.bossAt?.[b.id] ?? 0) - (S.bossAt?.[a.id] ?? 0)
    || Number(teams.has(b.agent!)) - Number(teams.has(a.agent!))
    || Number(baseName(b.agent!) !== b.agent) - Number(baseName(a.agent!) !== a.agent)
    || b.agent!.localeCompare(a.agent!))[0]
  const picks: [Table, Seatable, HandoverHint | undefined][] = []
  for (const t of S.tables) {
    // 這張桌最新的一筆；它套用過，比它舊的更不算。超過 7 天的紀錄不管有沒有套用過都不用：交接是當下的事（複審 H-1b）
    const h = handovers.filter(h => h.table === t.id).reduce<HandoverHint | undefined>((a, h) => (!a || (h.at ?? 0) >= (a.at ?? 0) ? h : a), undefined)
    const heir = h && !S.handApplied?.[h.id] && now - (h.at ?? 0) <= HAND_HINT_MS ? managers.find(m => m.id === h.newSid) : undefined
    // 桌子已經是 heir 的（swapBoss 改好了）也算一次，記成用過
    if (h && heir && (t.team === heir.agent || t.team === h.oldHandle || !t.team || !live.has(t.team))) { picks.push([t, heir, h]); continue }
    if (!t.team || live.has(t.team)) continue
    const b = baseName(t.team)
    const m = leads.find(m => t.team === m.plate || t.team === m.name)
      ?? (b ? newest(managers.filter(m => baseName(m.agent!) === b)) : undefined)
      ?? leads.find(m => [S.pins[m.id], S.seats[m.id]?.key].includes(`t${t.id}.0`))
    if (m) picks.push([t, m, undefined])
  }
  let dirty = false
  const got = new Set<string>()
  const applied = (h?: HandoverHint) => { if (h) { (S.handApplied ??= {})[h.id] = now; dirty = true } }
  for (const [t, m, h] of picks) {
    const agent = m.agent!
    if (!S.tables.includes(t) || got.has(agent)) continue
    if (t.team === agent) { applied(h); continue } // swapBoss 已經改好：紀錄記成用過
    const mine = S.tables.filter(x => x !== t && x.team === agent)
    if (!h && mine.some(x => !x.auto)) continue
    got.add(agent)
    retarget(t, agent)
    applied(h)
    dirty = true
    for (const x of mine) if (x.auto) {
      S.tables = S.tables.filter(y => y !== x)
      for (const [id, k] of Object.entries(S.pins)) if (k.startsWith(`t${x.id}.`)) unpin(S, id)
    }
  }
  return dirty
}

/** 每個人坐哪（session id → 座位代號）；S 有變動且 persist 時回傳 dirty＝true，呼叫端決定要不要存檔 */
/** handovers：伺服器讀到的交接紀錄；沒給（外掛面板、只看的預覽、讀檔失敗）就不用紀錄認桌，也不清 handApplied */
export function assign(S: Store, people: Seatable[], now = Date.now(), handovers?: HandoverHint[]): { map: Map<string, string>; dirty: boolean } {
  const out = new Map<string, string>(), used = new Set<string>()
  let dirty = false
  const take = (id: string, key: string) => { out.set(id, key); used.add(key) }
  // ⓪ 保留的座位：本人不在線時別人不能坐（0.63.29，交給 App 的 Codex；審查第 4 項）
  const here = new Set(people.map(p => p.id))
  for (const [id, k] of Object.entries(S.reserved ?? {})) if (!here.has(id) && seatExists(S, k)) used.add(k)
  const teams = teamsOf(people)
  const inTeam = new Set<string>()
  for (const members of teams.values()) for (const p of members.slice(1)) inTeam.add(p.id)
  // team 改了才把人拉回團隊桌（0.63.58，顧問裁示）：
  // - 第一次看到這個人（joined 沒有他）只記下目前的 team 當基準，不清任何釘選（升級後第一次跑不會把辦公區的人全拉回桌）
  // - team 真的改了（沒有→某主管，或 A→B），而且新團隊在線成形，才清他在辦公區（o 開頭）的釘選；釘在協作桌上的不動
  //   招聘／系統寫的（hire）和沒有來源的舊釘選清掉；使用者拖的（drag）只有拖的時間早於這次 team 改變才清
  // - 新團隊還沒成形（主管暫時離線）：不清，記下改成什麼、什麼時候（next、at），等主管回來再處理
  for (const p of people) {
    const cur = p.team ?? ''
    const j = S.joined?.[p.id]
    if (!j) { (S.joined ??= {})[p.id] = { team: cur }; dirty = true; continue }
    if (j.team === cur) { if (j.next !== undefined) { delete j.next; delete j.at; dirty = true }; continue }
    if (cur && !inTeam.has(p.id)) { if (j.next !== cur) { j.next = cur; j.at = now; dirty = true }; continue }
    const changedAt = j.next === cur ? j.at ?? now : now
    const k = S.pins[p.id], src = S.pinBy?.[p.id]
    if (cur && k && /^o\d+$/.test(k) && (!src || src.by === 'hire' || src.at < changedAt)) unpin(S, p.id)
    S.joined![p.id] = { team: cur }
    dirty = true
  }
  // 桌子歸屬先修（0.63.58）：放在 ① 前面、以桌子為主一次決定，整組都被釘住時桌子也會改成現在的主管
  for (const m of people) if (m.role === 'manager' && m.agent && S.bossAt?.[m.id] === undefined) { (S.bossAt ??= {})[m.id] = now; dirty = true }
  if (claimTables(S, people, teams, handovers ?? [], now)) dirty = true
  // 主管座讓位（0.63.58 審查 M-1，顧問裁示）：桌子的主人（team＝他 agent 的在線主管，帶著團隊）在線、而且沒被釘到別處時，
  // 0 號上釘著的別人一律讓位，不看釘選來源。讓位的人 team 是這位主人的，② 會讓他坐同一桌最近的空位；不是的，③ 讓他坐辦公區。
  // 讓位後的新座位記成 hire 釘選（moved，最後統一釘）。主人不在線就不搬人
  const moved = new Set<string>()
  for (const t of S.tables) {
    const owner = people.find(p => p.role === 'manager' && !!p.agent && p.agent === t.team)
    const head = `t${t.id}.0`
    if (!owner || !teams.has(owner.agent!) || (S.pins[owner.id] && S.pins[owner.id] !== head)) continue
    for (const p of people) if (p.id !== owner.id && S.pins[p.id] === head) { unpin(S, p.id); moved.add(p.id); dirty = true }
  }
  // ① 拖過的
  for (const p of people) { const k = S.pins[p.id]; if (k && seatExists(S, k) && !used.has(k)) take(p.id, k) }
  // ② 團隊同桌
  for (const [agent, members] of [...teams].sort((a, b) => a[0].localeCompare(b[0]))) {
    let t = S.tables.find(t => t.team === agent)
    const rest = members.filter(p => !out.has(p.id))
    if (!rest.length) continue
    if (!t && S.noAuto?.[agent]) continue // 使用者剛刪掉這隊的桌：不馬上再開一張（閃一下），先坐辦公區
    if (!t) {
      t = S.tables.find(t => !t.team && t.size >= members.length)
      if (t) t.team = agent
      else { t = { id: S.nextId++, name: `${members[0].plate || members[0].name}團隊`, size: fitSize(members.length), team: agent, auto: true }; S.tables.push(t) }
      dirty = true
    }
    // 自動開的桌照人數加大（0.64.7，jacky 11-27）：開桌後組員變多就跟著長，最多 8 人；使用者建的桌不動、不縮小
    if (t.auto && t.size < fitSize(members.length)) { t.size = fitSize(members.length); dirty = true }
    // 主管固定坐 0 號（遠側最左、臉朝畫面）；組員從 1 號起，原本的位置還空著就坐回去
    const boss = members[0], head = `t${t.id}.0`
    if (!out.has(boss.id) && !used.has(head)) take(boss.id, head)
    for (const p of rest) {
      if (out.has(p.id)) continue
      const prev = S.seats[p.id]?.key
      let key = prev && prev !== head && prev.startsWith(`t${t.id}.`) && seatExists(S, prev) && !used.has(prev) ? prev : undefined
      for (let i = 1; !key && i < t.size; i++) if (!used.has(`t${t.id}.${i}`)) key = `t${t.id}.${i}`
      if (key) take(p.id, key) // 桌子坐滿：留給 ③ 坐辦公區
    }
    // 桌子滿了（0.63.58，顧問裁示；使用者建的桌不自動加大，自動開的桌已在上面照人數加大，8 人是上限）：主人的組員還有人沒位子，桌上 team 不是這位主人、
    // 釘選也不是使用者拖的（drag）的人讓位回辦公區，空出來的位子給組員；drag 的不動。從號碼大的先讓
    const left = rest.filter(p => !out.has(p.id))
    if (left.length) {
      const pre = `t${t.id}.`
      const off = people.filter(p => p.id !== boss.id && p.team !== agent && out.get(p.id)?.startsWith(pre) && out.get(p.id) !== head && S.pinBy?.[p.id]?.by !== 'drag')
        .sort((a, b) => Number(out.get(b.id)!.slice(pre.length)) - Number(out.get(a.id)!.slice(pre.length)))
      for (const p of left) {
        const v = off.shift()
        if (!v) break
        const key = out.get(v.id)!
        out.delete(v.id)
        unpin(S, v.id)
        moved.add(v.id)
        out.set(p.id, key)
        dirty = true
      }
    }
  }
  // ③ 辦公區
  for (const p of people) {
    if (out.has(p.id)) continue
    const prev = S.seats[p.id]?.key
    if (prev && /^o\d+$/.test(prev) && !used.has(prev)) { take(p.id, prev); continue }
    let k = 0
    while (used.has(`o${k}`)) k++
    take(p.id, `o${k}`)
  }
  // 讓位的人：新座位記成 hire 釘選（顧問裁示）
  for (const id of moved) { const k = out.get(id); if (k) pinSeat(S, id, k, 'hire', now) }
  // 記下座位（一小時刷新一次「最近看到」）；30 天沒看到的忘掉；自動開的桌子：團隊都不在線就收掉
  for (const [id, key] of out) {
    const s = S.seats[id]
    if (!s || s.key !== key || now - s.seen > 3600e3) { S.seats[id] = { key, seen: now }; dirty = true }
  }
  for (const [id, s] of Object.entries(S.seats)) if (now - s.seen > KEEP_MS) {
    delete S.seats[id]
    if (S.joined) delete S.joined[id]
    if (S.bossAt) delete S.bossAt[id]
    dirty = true
  }
  // 死掉的釘選（0.63.58）：id 已經不在 seats（30 天沒看到、或從來沒進過辦公室），而且不是一小時內才招聘／拖的、不是替人保留的座位，就刪掉。
  // 招聘的人還在路上時 seats 還沒有他，靠 pinBy 的時間留一小時；沒有來源的舊釘選不等
  for (const id of Object.keys(S.pins)) if (!S.seats[id] && !S.reserved?.[id] && now - (S.pinBy?.[id]?.at ?? 0) > 3600e3) { unpin(S, id); dirty = true }
  if (S.pinBy) for (const id of Object.keys(S.pinBy)) if (!(id in S.pins)) { delete S.pinBy[id]; dirty = true }
  // handApplied 只在紀錄已經不在 handovers 檔裡時才刪；讀檔失敗也會讀成空的，所以再加上套用超過 7 天（那時紀錄本身也過期不用了）才刪，不會因為一次沒讀到就讓紀錄復活
  if (S.handApplied && handovers) for (const [id, at] of Object.entries(S.handApplied)) if (!handovers.some(h => h.id === id) && now - at > HAND_HINT_MS) { delete S.handApplied[id]; dirty = true }
  if (S.noAuto) for (const a of Object.keys(S.noAuto)) if (!teams.has(a)) { delete S.noAuto[a]; dirty = true }
  const before = S.tables.length
  // 保留的座位也算有人（0.63.30，複驗第 4 項：交給 App 的人回來時那張自動桌還在）
  S.tables = S.tables.filter(t => !t.auto || teams.has(t.team!) || [...out.values(), ...Object.values(S.reserved ?? {})].some(k => k.startsWith(`t${t.id}.`)))
  if (S.tables.length !== before) { dirty = true; for (const [id, k] of Object.entries(S.pins)) if (!seatExists(S, k)) unpin(S, id) }
  return { map: out, dirty }
}

/** 坐在第 id 張協作桌的人（照座位號排，主管 0 號在前） */
export function atTable<P extends { id: string }>(id: number, people: P[], map: Map<string, string>): P[] {
  const pre = `t${id}.`
  return people.filter(p => map.get(p.id)?.startsWith(pre)).sort((a, b) => Number(map.get(a.id)!.slice(pre.length)) - Number(map.get(b.id)!.slice(pre.length)))
}

const WORKING = new Set(['typing', 'thinking', 'reading'])
/** 桌牌一眼看的狀態（roadmap 第 4 項）：「3 人工作中・1 位等你」；都閒著寫「2 人閒著」，沒人寫「空桌」 */
export function tableStatus(people: { mode?: string }[]): { text: string; waiting: number; working: number; blocked: number } {
  const working = people.filter(p => WORKING.has(String(p.mode))).length
  const waiting = people.filter(p => p.mode === 'waiting').length
  const blocked = people.filter(p => p.mode === 'blocked').length
  const parts = [working && `${working} 人工作中`, waiting && `${waiting} 位等你`, blocked && `${blocked} 位卡住`].filter(Boolean) as string[]
  const text = !people.length ? '空桌' : parts.length ? parts.join('・') : `${people.length} 人閒著`
  return { text, waiting, working, blocked }
}

/** 缺主管（roadmap 第 5 項，2026-11-23 使用者選 A）：同一張協作桌坐了 4 人以上、沒有一位 role＝manager。只標示，不自動升、不擋建桌 */
export const BOSS_MIN = 4
export const needsBoss = (sit: { role?: string }[]) => sit.length >= BOSS_MIN && !sit.some(p => p.role === 'manager')

/** 給畫面：這桌成組的狀態。grouped＝做完、記的主管還坐著而且是桌上唯一的主管；unreg／unnotified 分開數 */
export function groupView(g: TeamGroup | undefined, sit: { id: string; role?: string; team?: string }[]): { grouped?: true; groupPartial?: true; groupUnreg?: number; groupUnnotified?: number } {
  if (!g || !Array.isArray(g.notified)) return {}
  const bosses = sit.filter(p => p.role === 'manager')
  if (bosses.length !== 1 || bosses[0].id !== g.boss) return {}
  const others = sit.filter(p => p.id !== g.boss)
  const unreg = others.filter(p => p.team !== g.team).length
  const unnotified = sit.filter(p => !g.notified.includes(p.id)).length
  return { ...(g.complete ? { grouped: true as const } : { groupPartial: true as const }), groupUnreg: unreg, groupUnnotified: unnotified }
}

/** 給畫面的協作桌：桌牌字、主管；有座位表（map）時加同桌名單與狀態（count、status、waiting） */
export const tablesOut = (S: Store, people: (Seatable & { mode?: string })[], map?: Map<string, string>) => S.tables.map(t => {
  const mgr = t.team ? people.find(p => p.agent === t.team) : undefined
  const teamName = mgr ? mgr.plate : undefined
  const base = { id: t.id, name: t.name, size: t.size, team: t.team, teamName, label: tableLabel(t.name, teamName), auto: !!t.auto, ...(t.collab ? { collab: t.collab } : {}) }
  if (!map) return base
  const sit = atTable(t.id, people, map), s = tableStatus(sit)
  return { ...base, count: sit.length, status: s.text, waiting: s.waiting, blocked: s.blocked, members: sit.map(p => p.id), noBoss: needsBoss(sit), ...groupView(t.group, sit as { id: string; role?: string; team?: string }[]) }
})

/** 桌牌的字：桌名＋主管名牌；一方包含另一方（去掉空白再比）就只寫桌名（主管名牌常被截斷，例：「像素辦公室 v2 整」，2026-11-23 主管裁示寫桌名） */
export function tableLabel(name: string, teamName?: string): string {
  if (!teamName) return name
  const a = name.replace(/\s+/g, ''), b = teamName.replace(/\s+/g, '')
  if (!a) return teamName
  if (a.includes(b) || b.includes(a)) return name
  return `${name}・${teamName}`
}

/** 協作桌：新增／改人數／改名／刪除（有人坐的桌子要再按一次才刪；改小時坐不下的人下次自動改坐別處） */
/** online：現在在線的 session id（給了就照它判斷「有人坐」；seats 的 seen 一小時才刷新一次，不能拿來判斷，0.62.18） */
export function editTables(S: Store, b: any, online?: Set<string>): { ok: boolean; text: string } {
  const op = String(b?.op ?? '')
  if (op === 'add') {
    const size = SIZES.includes(+b.size) ? +b.size : 4
    const t: Table = { id: S.nextId++, name: String(b.name ?? '').trim().slice(0, 12) || `協作桌 ${S.nextId - 1}`, size }
    S.tables.push(t)
    return { ok: true, text: `加了一張 ${size} 人協作桌「${t.name}」` }
  }
  const t = S.tables.find(t => t.id === +b?.id)
  if (!t) return { ok: false, text: '找不到這張桌子' }
  if (op === 'edit') {
    if (b.size !== undefined) { if (!SIZES.includes(+b.size)) return { ok: false, text: '人數只能是 2、4、6、8' }; t.size = +b.size }
    if (b.name !== undefined) t.name = String(b.name).trim().slice(0, 12) || t.name
    if (b.collab !== undefined) {
      const c = String(b.collab).trim().replace(/[\\/]+$/, '')
      if (c && !/^([a-zA-Z]:)?[\\/~]/.test(c)) return { ok: false, text: '協作資料夾要寫完整路徑（/ 或 ~ 開頭）' }
      if (c.length > 300) return { ok: false, text: '路徑太長' }
      if (c) t.collab = c; else delete t.collab
    }
    t.auto = false // 改過的桌子就是固定的，不會自動收掉
    for (const [id, k] of Object.entries(S.pins)) if (!seatExists(S, k)) unpin(S, id)
    return { ok: true, text: `改好了：${t.name}（${t.size} 人）` }
  }
  if (op === 'delete') {
    if (sittersAt(S, t.id, online).length && !b.force) return { ok: false, text: '這張桌子還有人坐，先把人搬走，或再按一次確定刪除' }
    S.tables = S.tables.filter(x => x !== t)
    if (t.team) (S.noAuto ??= {})[t.team] = true
    for (const [id, k] of Object.entries(S.pins)) if (k.startsWith(`t${t.id}.`)) unpin(S, id)
    return { ok: true, text: `刪掉了「${t.name}」` }
  }
  return { ok: false, text: '不認得的動作' }
}

/** 換座位：拖到別的座位；那裡有人就對調。拖過的人之後固定坐那裡（不再照團隊規則） */
/** 坐在這桌的人：有 online 就是「在線、座位在這桌」；沒有就退回 seen 兩分鐘內的舊判斷 */
export function sittersAt(S: Store, tableId: number, online?: Set<string>): string[] {
  return Object.entries(S.seats).filter(([id, s]) => s.key.startsWith(`t${tableId}.`) && (online ? online.has(id) : Date.now() - s.seen < 120e3)).map(([id]) => id)
}

export function moveSeat(S: Store, id: string, to: string, online?: Set<string>): { ok: boolean; text: string } {
  if (!seatExists(S, to)) return { ok: false, text: '沒有這個座位' }
  // 替不在線的人保留的座位不能搬進去（0.63.30，複驗第 4 項）
  const holder = Object.entries(S.reserved ?? {}).find(([who, k]) => k === to && who !== id && !online?.has(who))
  if (holder) return { ok: false, text: '這個座位替交給 App 的人保留著' }
  const from = S.seats[id]?.key
  if (!from) return { ok: false, text: '找不到這位' }
  for (const [other, s] of Object.entries(S.seats)) if (other !== id && s.key === to && (online ? online.has(other) : Date.now() - s.seen < 120e3)) { pinSeat(S, other, from, 'hire'); s.key = from } // 被換走的人是系統替他換的：記 hire（0.63.58）
  pinSeat(S, id, to, 'drag')
  S.seats[id] = { key: to, seen: Date.now() }
  return { ok: true, text: '換好座位了' }
}

/** 角色外型：看來源欄位（kind），不看名字（Claude 的對話取名「Codex 協作準備」不會被畫成 ChatGPT） */
export function species(p: { kind?: string }): 'claude' | 'chatgpt' | 'gemini' | 'deepseek' {
  const s = String(p.kind ?? '').toLowerCase()
  if (/codex|chatgpt|openai/.test(s)) return 'chatgpt'
  if (/gemini|agy|antigravity/.test(s)) return 'gemini'
  if (/deepseek/.test(s)) return 'deepseek'
  return 'claude'
}

// ---------- 示意資料（?demo=N）：示範團隊同桌、協作桌編輯；示意模式的修改只放記憶體，不碰真的座位表 ----------
const NAMES = ['檔案管理員', '文書助理', '報價助理', '行程規劃', '客戶整理', '課程筆記', '增員追蹤', '理賠進度', '日報', '簡報製作', '名單清洗', '會議紀錄']
const DEMO_MODES = ['typing', 'thinking', 'reading', 'idle', 'idle', 'typing', 'done', 'waiting', 'thinking', 'blocked', 'idle', 'reading']
const DEMO_SP = ['claude', 'deepseek', 'chatgpt', 'gemini'] as const
const SP_NAME = { claude: 'Claude', deepseek: 'DeepSeek', chatgpt: 'ChatGPT', gemini: 'Gemini' }
export function demoPeople(n: number, modeText: Record<string, string>, now = Date.now()): any[] {
  const out: any[] = []
  for (let i = 0; i < n; i++) {

    const sp = DEMO_SP[((i * 2654435761) >>> 0) % 7 % 4]
    const plate = `${NAMES[i % NAMES.length]}${i >= NAMES.length ? Math.floor(i / NAMES.length) + 1 : ''}`
    // 每 9 人一位主管；主管後面 3 人掛在他底下（同桌示意），其他人沒有主管（辦公區）
    const boss = i % 9 === 0, lead = Math.floor(i / 9) * 9, inTeam = !boss && i - lead <= 3 && i - lead > 0
    // 每 15 秒換一次狀態，只換辦公區的人（坐協作桌的主管與組員固定，測試中途不會換掉在等的人；2026-11-23 e2e 偶發失敗）
    let mode = DEMO_MODES[(i * 7 + Math.floor(now / 15000) * (i % 3 === 0 && !boss && !inTeam ? 1 : 0)) % DEMO_MODES.length]
    // 示意傳話：每隊 1 號每 20 秒傳一封給主管（手機看得到紙飛機）
    // 示意整桌等你回覆（第 7 項）：每隊 2、3 號在等你回覆（不是等按允許）
    const askReply = inTeam && (i - lead === 2 || i - lead === 3)
    if (askReply) mode = 'waiting'
    const mail = inTeam && i - lead === 1 ? { sentTo: `demo-agent-${lead}`, sentAt: Math.floor(now / 20000) * 20000 + i } : {}
    out.push({
      id: `demo-${String(i).padStart(3, '0')}`, species: sp, demo: true, name: plate, plate, agent: `demo-agent-${i}`,
      role: boss ? 'manager' : 'staff', team: inTeam ? `demo-agent-${lead}` : undefined, mode, modeText: modeText[mode], since: now - (i % 20) * 60000,
      title: `示意：${SP_NAME[sp]} 的 session`,
      tool: mode === 'typing' ? 'Edit' : mode === 'reading' ? 'Read' : undefined, approval: mode === 'waiting' && i % 2 && !askReply ? 'Bash' : undefined,
      lastError: mode === 'blocked' ? { text: '示意錯誤訊息', at: now - 60000 } : undefined,
      ...mail,
      reply: { text: '（示意資料：這不是真的 session，送出的內容不會傳到任何地方）', at: now - 120000 }, model: 'Opus 5.5', staff: true,
    })
  }
  return out
}

// ---------- 桌子聊天室（roadmap 第 12 項，0.62.4）：同桌互傳的話，一則一個檔 ----------
// 位置：~/.claude/pixel-office/chat/<port>/t<桌號>/<時間>-<亂碼>.json（一則一檔，多個對話同時寫不會互蓋）
// 寫：各對話的外掛（SendMessage 送達時，寄件人或收件人坐協作桌就記到那桌）、手機版伺服器（📣 傳給整桌）
// 清：手機版伺服器（30 天前的刪掉；桌子不在了就整個資料夾刪掉）；外掛不能刪檔，讀的時候跳過過期的
export const CHAT_KEEP_MS = 30 * 24 * 3600e3
export const CHAT_TEXT_MAX = 20000
export type ChatEntry = { at: number; from: { id?: string; name: string }; to: { id?: string; name: string }; text: string }
export const chatDir = (base: string, port: number, table: number) => `${base}/chat/${port}/t${table}`
export const chatFile = (at: number, rand: string) => `${at}-${rand}.json`

export function parseChat(raw: unknown, now = Date.now()): ChatEntry | undefined {
  try {
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!j || typeof j.at !== 'number' || typeof j.text !== 'string' || !j.from || typeof j.from.name !== 'string') return undefined
    if (now - j.at > CHAT_KEEP_MS) return undefined
    const side = (x: any) => ({ ...(typeof x?.id === 'string' ? { id: x.id } : {}), name: typeof x?.name === 'string' ? x.name : '?' })
    return { at: j.at, from: side(j.from), to: side(j.to), text: j.text.slice(0, CHAT_TEXT_MAX) }
  } catch {
    return undefined
  }
}

/** 一則傳話要記到哪幾張桌：寄件人、收件人坐的協作桌（同桌就一張） */
export function chatTables(map: Map<string, string>, fromId: string, toId?: string): number[] {
  const t = (id?: string) => { const m = id ? /^t(\d+)\./.exec(map.get(id) ?? '') : null; return m ? +m[1] : undefined }
  return [...new Set([t(fromId), t(toId)].filter((x): x is number => x !== undefined))]
}

/** 長訊息先顯示第一行（最多 n 字），點了展開 */
export function firstLine(text: string, n = 60): { head: string; more: boolean } {
  const line = text.split('\n').find(l => l.trim() !== '')?.trim() ?? ''
  const head = [...line].length > n ? [...line].slice(0, n).join('') + '…' : line
  return { head, more: head !== text.trim() }
}

/** <office> 位置，跟 takeover.py office_dir() 與 skill SKILL.md 同規則：projects.json 有這個主 repo 用它（可相對或絕對），否則 <主 repo>/.claude/office */
export function officeFor(main: string, projects: unknown): string {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  const key = norm(main).toLowerCase()
  if (projects && typeof projects === 'object') {
    for (const [k, v] of Object.entries(projects as Record<string, unknown>)) {
      if (typeof v !== 'string' || norm(k).toLowerCase() !== key) continue
      return /^([a-zA-Z]:)?[\\/]/.test(v) ? norm(v) : `${norm(main)}/${norm(v)}`
    }
  }
  return `${norm(main)}/.claude/office`
}

// ---------- 同桌共用筆記（roadmap 第 11 項，0.62.10）：手機上看是一份，後面由多個檔合起來，一個檔只有一個人寫 ----------
// 這桌的筆記資料夾＝協作資料夾（table.collab，0.62.9）：collab.md（主管）、checkpoints/<名字>.md（各人）、交代.md（伺服器記使用者交代）、行政.md（行政）

/** collab.md 照「# 標題」切段（標題 → 內文，去頭尾空行） */
export function mdSections(md: string): Map<string, string> {
  const out = new Map<string, string>()
  let head: string | undefined, buf: string[] = []
  const flush = () => { if (head !== undefined) out.set(head, buf.join('\n').trim()) }
  for (const line of md.split(/\r?\n/)) {
    const m = /^#\s+(.+?)\s*$/.exec(line)
    if (m) { flush(); head = m[1]; buf = [] } else buf.push(line)
  }
  flush()
  return out
}

/** Markdown 表格的資料列（去掉表頭與 |---|），每列切成格 */
export function tableRows(body: string): string[][] {
  const rows = body.split(/\r?\n/).filter(l => l.trim().startsWith('|'))
  return rows.slice(2).map(l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())).filter(r => r.some(c => c))
}

/** 檢查點（roles.md §4：「## YYYY-MM-DD HH:mm <ListAgents 名稱>」一段一筆、只往後加）：每個名字最新的一筆；檔名（角色）也算名字 */
export function latestCheckpoints(files: { name: string; text: string }[]): Map<string, { head: string; text: string; file: string }> {
  const out = new Map<string, { head: string; text: string; file: string }>()
  for (const f of files) {
    const parts = f.text.split(/^## /m).slice(1)
    for (const part of parts) {
      const [head, ...rest] = part.split(/\r?\n/)
      const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})\s+(.+?)\s*$/.exec(head.trim())
      const entry = { head: head.trim(), text: rest.join('\n').trim(), file: f.name }
      const base = f.name.replace(/\.md$/, '')
      for (const k of [m?.[2], base]) if (k) { const prev = out.get(k); if (!prev || prev.head.slice(0, 16) <= entry.head.slice(0, 16)) out.set(k, entry) }
    }
  }
  return out
}

/** 建議加行政：6 人以上的桌、沒有在線的行政（只提示，不變紅、不擋） */
export const ADMIN_SUGGEST = 6
export const suggestAdmin = (count: number, adminOnline: boolean) => count >= ADMIN_SUGGEST && !adminOnline

/** 行政的第一句交代（招聘時加在使用者寫的工作前面） */
export const adminBrief = (table: string, boss: string | undefined, dir: string | undefined) =>
  `你是協作桌「${table}」的行政${boss ? `，掛在主管 ${boss} 底下` : ''}。工作：整理這桌的共用筆記、把同桌的傳話整理成進度摘要、追蹤卡住的人、提醒期限、幫主管寫報告給使用者。` +
  `不派工、不做決定（要派工或決定的事轉給主管）。你的整理檔：${dir ? `${dir}/行政.md` : '這桌協作資料夾的 行政.md'}，分三段「# 今日進度摘要」「# 期限提醒」「# 卡住追蹤」，只有你寫，有變化就更新。`

// ---------- 任務卡片（roadmap 第 10 項，0.62.11）：主管派工時登記，一個任務一張卡 ----------
// 檔案（~/.claude/pixel-office/tasks/）：<任務 id>.json＝主管寫的任務（名字、拆成哪幾份、各給誰、要等哪幾份）；
// <任務 id>.<第幾份>.json＝那一份的狀態，只有做那份的人（或主管）寫。一個檔只有一個人寫
export type TaskPart = { who: string; what: string; after?: number[] }
export type TaskDef = { id: string; title: string; boss: string; bossAgent?: string; parts: TaskPart[]; at: number }
export type PartState = 'waiting' | 'doing' | 'done' | 'stuck'
export const PART_ZH: Record<PartState, string> = { waiting: '等前面', doing: '進行中', done: '完成', stuck: '卡住' }
export const TASK_KEEP_MS = 7 * 24 * 3600e3 // 全部完成的任務留 7 天

export function parseTask(raw: unknown): TaskDef | undefined {
  try {
    const j = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (!j || typeof j.id !== 'string' || typeof j.title !== 'string' || typeof j.boss !== 'string' || !Array.isArray(j.parts) || typeof j.at !== 'number') return undefined
    const parts = j.parts.filter((p: any) => p && typeof p.who === 'string' && typeof p.what === 'string').map((p: any) => ({ who: p.who, what: p.what, ...(Array.isArray(p.after) ? { after: p.after.filter((n: unknown) => typeof n === 'number') } : {}) }))
    return parts.length ? { id: j.id, title: j.title, boss: j.boss, bossAgent: typeof j.bossAgent === 'string' ? j.bossAgent : undefined, parts, at: j.at } : undefined
  } catch {
    return undefined
  }
}

/** 一張任務卡：每份的狀態（沒回報過：前面的還沒完成＝等前面，否則進行中）、進度「進行中 2/3」、全部完成的時間 */
export function taskCard(def: TaskDef, status: Map<number, { state: PartState; at: number; note?: string }>) {
  const st = (i: number): PartState => status.get(i)?.state ?? ((def.parts[i].after ?? []).some(n => n !== i && status.get(n)?.state !== 'done') ? 'waiting' : 'doing')
  const parts = def.parts.map((p, i) => ({ n: i + 1, who: p.who, what: p.what, state: st(i), stateZh: PART_ZH[st(i)], note: status.get(i)?.note, at: status.get(i)?.at }))
  const done = parts.filter(p => p.state === 'done').length
  const allDone = done === parts.length
  const doneAt = allDone ? Math.max(def.at, ...[...status.values()].map(s => s.at)) : undefined
  const stuck = parts.some(p => p.state === 'stuck')
  return { id: def.id, title: def.title, boss: def.boss, at: def.at, parts, done, total: parts.length, progress: `${allDone ? '完成' : stuck ? '有人卡住' : '進行中'} ${done}/${parts.length}`, doneAt }
}
