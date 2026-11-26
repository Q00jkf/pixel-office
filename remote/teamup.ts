// 協作桌「一鍵設成一組」（0.63.45；使用者提、主管 2026-11-25 裁示介面，Codex 審查 codex-review-2026-11-25-teamup.md 修正）：
// 桌上的主管登記 role=manager、其餘在線的人登記 team=<主管的 ListAgents 名稱>，建這桌的協作紀錄（collab.md＋.gitignore；已有就只補列），通知每個人。
// - 確認卡與執行綁定：preview 回 ver（桌號＋主管＋成員＋協作資料夾的雜湊），go 帶回來，伺服器重算不符就不做
// - 順序：先寫協作紀錄（失敗就什麼都不做）→ 登記（人事令；agy 送一句話）→ 只通知登記成功的人
// - 部分失敗照實回報：登記、協作紀錄、通知分開記；任何一步沒完成，group.complete=false，桌牌不標「已成組」
// - 冪等：group 記已通知的人。重按只通知還沒通知到的；「不確定有沒有送到」不算通知過（回報待確認，下次再送）；換主管＝新的一組
// - 主管一定要有 ListAgents 名稱（team 掛它、自動分桌也認它）；同名主管已掛在別桌就不做，提示衝突
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export type TeamPerson = { id: string; plate: string; agent?: string; code?: string; title?: string; role?: string; kind?: string; team?: string }
export type { TeamGroup } from '../hooks/officeV2'
import type { TeamGroup } from '../hooks/officeV2'
export type Delivered = { state: 'sent' | 'failed' | 'unsure'; text?: string }
export type TeamDeps = {
  /** 這桌的名字與現在坐著的人（在線的）；找不到桌回 undefined。live＝最後一查：重取當下名冊、只讀 */
  table: (id: number, live?: boolean) => { name: string; people: TeamPerson[]; group?: TeamGroup } | undefined
  /** 別張桌已經掛這個主管名稱：回那張桌的名字 */
  elsewhere: (team: string, id: number) => string | undefined
  /** 這桌的協作資料夾（notesDir：桌子設的 → 主管工作資料夾的協作目錄 → 辦公室 notes/） */
  dir: (id: number, bossId: string) => string
  /** 人事令（Claude、Codex）：寫了回 true；不收人事令的（agy）回 false：改由通知請他自己設；寫不進去丟例外 */
  order: (p: TeamPerson, o: { role?: 'manager'; team?: string }) => boolean
  deliver: (p: TeamPerson, text: string) => Promise<Delivered>
  /** 存辦公室信箱（只准用 ListAgents 名稱領）；存不進去回 false */
  mail: (to: string, text: string) => boolean
  /** 記下這桌的 group 與桌子掛的主管；存不進去回 false */
  save: (id: number, g: TeamGroup, team: string) => boolean
}

const today = (now: number) => { const d = new Date(now); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
/** 表格一格：可逆的跳脫（& < > ` | 換成 HTML 字元參照），空白收成一個 */
export const cell = (s: string) => s.replace(/\s+/g, ' ').trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/`/g, '&#96;').replace(/\|/g, '&#124;')

/** 這桌能不能設成一組：回主管與成員，或不能的原因 */
export function teamPlan(people: TeamPerson[]): { ok: true; boss: TeamPerson; members: TeamPerson[]; team: string } | { ok: false; text: string } {
  if (!people.length) return { ok: false, text: '這桌現在沒有人' }
  const bosses = people.filter(p => p.role === 'manager')
  if (!bosses.length) return { ok: false, text: '先指定主管：在同桌名單挑一位升主管' }
  if (bosses.length > 1) return { ok: false, text: `這桌有 ${bosses.length} 位主管，先降一位` }
  const boss = bosses[0]
  if (boss.kind) return { ok: false, text: '主管只能是 Claude（使用者 2026-11-24 決定）' }
  const team = boss.agent?.trim()
  if (!team) return { ok: false, text: `主管 ${boss.plate} 還沒有 ListAgents 名稱，成員沒辦法掛到他底下：請他先用 office_profile 登記 agent` }
  return { ok: true, boss, members: people.filter(p => p !== boss), team }
}

/** 確認卡的版本：桌號、主管（id、ListAgents 名稱、要寫的上層）、成員（排序）、協作資料夾。go 時重算，不符＝桌上有變動 */
export const teamVersion = (id: number, bossId: string, team: string, up: string, memberIds: string[], dir: string) =>
  createHash('sha256').update(JSON.stringify([id, bossId, team, up, [...memberIds].sort(), dir])).digest('hex').slice(0, 16)

const SKELETON = ['# 主管', '| 主管（ListAgents 名稱） | 範圍（使用者原話） | 上層 | 上線 |', '|---|---|---|---|', '# 在線', '| session | 角色 | 任務 | 上次回報 |', '|---|---|---|---|', '# 檔案佔用', '| 檔案（反引號路徑） | 佔用者 | 起始 YYYY-MM-DD |', '|---|---|---|', '# 待使用者裁示', '| # | 事項（一句） | 細節在哪 | 登記日 |', '|---|---|---|---|', '# 等外部回覆', '| # | 事項 | 等誰（不知道寫「未指明」） | 登記日 |', '|---|---|---|---|', '# 衝突紀錄', '| 時間 | 雙方 | 以誰為準、對方怎麼收尾 |', '|---|---|---|']

/** 在某段最後一列表格後面插入列：段不在就加在檔尾（含表頭）；段在、沒有表頭就先補表頭；第一欄已有的（含這批前面加的）跳過 */
function addRows(lines: string[], head: string, header: string[], rows: { key: string; line: string }[]): string[] {
  let start = lines.findIndex(l => l.trim() === head)
  if (start < 0) { lines.push(head, ...header); start = lines.length - header.length - 1 }
  let end = lines.findIndex((l, i) => i > start && /^# /.test(l.trim()))
  if (end < 0) end = lines.length
  if (!lines.slice(start + 1, end).some(l => l.trim().startsWith('|'))) { lines.splice(start + 1, 0, ...header); end += header.length }
  const have = new Set<string>()
  for (let i = start + 1; i < end; i++) {
    const m = /^\|([^|]*)\|/.exec(lines[i].trim())
    if (m && !/^-+$/.test(m[1].trim())) have.add(m[1].trim())
  }
  const add: { key: string; line: string }[] = []
  for (const r of rows) { const k = cell(r.key); if (!have.has(k)) { have.add(k); add.push(r) } }
  if (!add.length) return []
  let at = start + 1
  for (let i = start + 1; i < end; i++) if (lines[i].trim().startsWith('|')) at = i + 1
  lines.splice(at, 0, ...add.map(r => r.line))
  return add.map(r => cell(r.key))
}

/**
 * collab.md：沒有就照 skills/team/lead.md §2 的六段骨架建；有就不覆蓋，只補「主管」段的主管列、「在線」段的成員列。
 * 換了主管也不改舊主管列（手填的範圍、上層、日期要留著；複驗第 4 列），只補新主管一列。「現任」標記等主管人事令寫好才由 markCurrent 標（複驗第三輪 O-10）
 */
export function collabText(old: string | undefined, o: { team: string; members: TeamPerson[]; table: string; now: number }): { text: string; added: string[]; created: boolean } {
  const lines = old === undefined ? [...SKELETON] : old.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n')
  const added = [
    ...addRows(lines, '# 主管', SKELETON.slice(1, 3), [{ key: o.team, line: `| ${cell(o.team)} | 協作桌「${cell(o.table)}」 |  | ${today(o.now)} |` }]),
    ...addRows(lines, '# 在線', SKELETON.slice(4, 6), o.members.map(p => { const k = p.agent || p.code || p.plate; return { key: k, line: `| ${cell(k)} | ${cell(p.title ?? '')} |  |  |` } })),
  ]
  return { text: lines.join('\n') + '\n', added, created: old === undefined }
}

/** 我們加在主管列範圍欄的標記（只有這幾個字會被加、被拿掉）；OLD_MARK 是 d54cc5e 那版建列時直接寫進去的 */
export const CURRENT_MARK = '（現任，像素辦公室設成一組時標）'
const OLD_MARK = '（現任，像素辦公室設成一組時加）'
/** 表格一列拆成格：Markdown 跳脫的直線（\|）不算分隔；回 [行首到第一個 |, 各格…, 最後一個 | 到行尾] */
function splitRow(line: string): string[] | undefined {
  const parts = line.split(/(?<!\\)\|/)
  return parts.length >= 4 ? parts : undefined // 至少「前綴、第一欄、第二欄、…」
}
/** 「主管」段：只在範圍欄（第二欄）拿掉新舊兩種標記，再標到 team 那列的範圍欄結尾；其他字一字不動。沒有那列回 undefined */
export function markCurrent(text: string, team: string): string | undefined {
  const lines = text.split('\n')
  const start = lines.findIndex(l => l.trim() === '# 主管')
  if (start < 0) return undefined
  let end = lines.findIndex((l, i) => i > start && /^# /.test(l.trim()))
  if (end < 0) end = lines.length
  let hit = -1
  for (let i = start + 1; i < end; i++) {
    const c = splitRow(lines[i])
    if (!c) continue
    const scope = c[2].split(CURRENT_MARK).join('').split(OLD_MARK).join('')
    if (scope !== c[2]) { c[2] = scope; lines[i] = c.join('|') }
    if (c[1].trim() === cell(team)) hit = i
  }
  if (hit < 0) return undefined
  const c = splitRow(lines[hit])!
  const m = /^(.*?)(\s*)$/.exec(c[2])!
  c[2] = `${m[1]}${CURRENT_MARK}${m[2]}`
  lines[hit] = c.join('|')
  return lines.join('\n')
}

/** 目的檔要嘛不存在、要嘛是一般檔（不是連結、資料夾）：回內容或 undefined；其他丟例外 */
function readPlain(f: string): string | undefined {
  let st
  try { st = lstatSync(f) } catch { return undefined }
  if (!st.isFile()) throw new Error(`${f} 不是一般檔案（可能是連結），不寫`)
  return readFileSync(f, 'utf8')
}
/**
 * 原子寫入：暫存檔（隨機名、獨占建立）＋寫完驗大小＋rename；我們建的暫存檔失敗時清掉，檔名已存在（不是我們的）就不碰。
 * put 是寫入那一步（測試注入短寫）；寫完 fstat 大小要等於位元組數，不符就不換上去（第五輪複驗第 1 項：短寫會把截斷的內容當正式檔）
 */
export function writeAtomic(f: string, text: string, put: (fd: number, t: string) => void = (fd, t) => writeFileSync(fd, t)) {
  const tmp = `${f}.${randomUUID()}.tmp`
  let mine = false
  try {
    const fd = openSync(tmp, 'wx') // 獨占建立：拿到 fd 才算是我們的檔
    mine = true
    try {
      put(fd, text)
      const want = Buffer.byteLength(text), got = fstatSync(fd).size
      if (got !== want) throw new Error(`寫入不完整（${got}／${want} 位元組），沒換上去`)
    } finally { closeSync(fd) }
    renameSync(tmp, f)
  } catch (e) { if (mine) try { rmSync(tmp, { force: true }) } catch {} throw e }
}
/** 主管令寫好之後標「現任」：只換標記字樣；回有沒有改、失敗的原因 */
export function writeCurrent(file: string, team: string, write = writeAtomic): { changed: boolean; err?: string } {
  try {
    const old = readPlain(file)
    if (old === undefined) return { changed: false, err: 'collab.md 不見了' }
    const t = markCurrent(old, team)
    if (t === undefined) return { changed: false, err: '找不到主管列' }
    if (t !== old) write(file, t)
    return { changed: t !== old }
  } catch (e) { return { changed: false, err: String((e as Error)?.message ?? e).slice(0, 600) } }
}

/**
 * 寫協作紀錄：資料夾不在就建；.gitignore 沒有才寫（collab.md、checkpoints/ 兩行）；collab.md 只補不蓋。
 * collab.md 寫失敗：清掉這次新建的 .gitignore 與空資料夾，丟出的錯誤附上清了什麼／留下什麼（複驗第 6 列）
 */
export function writeCollab(dir: string, o: { team: string; members: TeamPerson[]; table: string; now: number }, write = writeAtomic): { file: string; added: string[]; created: boolean; changed: boolean } {
  const made = mkdirSync(dir, { recursive: true }) // 這次新建的最上層資料夾（原本就在回 undefined）
  const gi = join(dir, '.gitignore'), file = join(dir, 'collab.md')
  let giNew = false
  try {
    const giOld = readPlain(gi)
    const old = readPlain(file)
    if (giOld === undefined) { write(gi, 'collab.md\ncheckpoints/\n'); giNew = true }
    const r = collabText(old, o)
    const changed = r.text !== old
    if (changed) write(file, r.text)
    return { file, added: r.added, created: r.created, changed }
  } catch (e) {
    const left: string[] = [], gone: string[] = []
    if (giNew) { try { rmSync(gi, { force: true }); gone.push('.gitignore') } catch { left.push(gi) } }
    if (made) {
      // 由內往外刪空資料夾，刪到這次新建的那層為止；不是空的（別人放了東西）就留著
      for (let d = dir; ; d = dirname(d)) {
        try { rmdirSync(d); gone.push(d) } catch { left.push(d); break }
        if (d === made || dirname(d) === d) break
      }
    }
    const msg = String((e as Error)?.message ?? e).slice(0, 600)
    throw new Error(`${msg}${gone.length ? `；已清掉這次新建的：${gone.join('、')}` : ''}${left.length ? `；留下了：${left.join('、')}` : ''}`)
  }
}

const nameOf = (p: TeamPerson) => (p.agent && p.agent !== p.plate ? `${p.agent}（${p.plate}）` : p.plate)
const names = (ps: TeamPerson[]) => ps.map(nameOf).join('、')
export function staffNote(o: { table: string; team: string; members: TeamPerson[]; me: TeamPerson; file: string; self?: boolean }): string {
  const mates = o.members.filter(p => p !== o.me)
  return `（像素辦公室：使用者把協作桌「${o.table}」設成一組）你的主管是 ${o.team}，` +
    (o.self ? `請你自己用 office_profile 工具把 team 設成「${o.team}」。` : `辦公室已替你登記 team=${o.team}。`) +
    `同桌${mates.length ? `：${names(mates)}` : '只有你和主管'}。有事用 SendMessage 回報主管 ${o.team}。這組的協作紀錄在 ${o.file}（主管寫，你不用改）。回一句收到就好`
}
/** 成員登記結果：order＝人事令寫好了；self＝請他自己設（agy）；其他＝沒登記成的原因 */
export type RegState = { kind: 'order' } | { kind: 'self' } | { kind: 'bad'; why: string }
/** 給主管的通知：照實分三類列（複驗第 6 列：不能說全員已登記） */
export function bossNote(o: { table: string; members: TeamPerson[]; fresh?: TeamPerson[]; file: string; reg: Map<string, RegState> }): string {
  const by = (k: RegState['kind']) => o.members.filter(p => o.reg.get(p.id)?.kind === k)
  const ok = by('order'), self = by('self'), bad = by('bad')
  const parts = [
    ok.length ? `辦公室已登記 team=你：${names(ok)}` : '',
    self.length ? `請他自己設定 team（agy，辦公室改不了）：${names(self)}` : '',
    bad.length ? `沒登記成：${bad.map(p => `${nameOf(p)}（${(o.reg.get(p.id) as { why: string }).why}）`).join('、')}` : '',
  ].filter(Boolean)
  return `（像素辦公室：使用者把協作桌「${o.table}」設成一組）你是這組主管，辦公室已替你登記 role=manager。` +
    (o.fresh ? `新加入：${names(o.fresh)}。` : '') +
    (o.members.length ? `成員登記：${parts.join('；')}。` : '目前沒有其他成員。') +
    `協作紀錄：${o.file}（成員已補進「在線」段；範圍、任務照 pixel-office:team skill 由你填）。回一句收到就好`
}

type Checked = { ok: true; name: string; boss: TeamPerson; members: TeamPerson[]; team: string; up: string; dir: string; ver: string; group?: TeamGroup }
function check(id: number, D: Pick<TeamDeps, 'table' | 'dir' | 'elsewhere'>): Checked | { ok: false; text: string } {
  if (!Number.isInteger(id) || id <= 0) return { ok: false, text: '桌號不對' }
  const t = D.table(id)
  if (!t) return { ok: false, text: '找不到這張桌子' }
  const plan = teamPlan(t.people)
  if (!plan.ok) return plan
  const other = D.elsewhere(plan.team, id)
  if (other) return { ok: false, text: `主管 ${plan.team} 已經掛在桌子「${other}」：一組只能有一張桌，先把那張桌的主管換掉或刪掉那張桌` }
  const dir = D.dir(id, plan.boss.id)
  // 主管自己的上層：還指向這桌的人或上一任主管才清成 off；指向別處（部門主管的上層）照寫回去（明確寫，不被 10 分鐘內的舊令併回；測試員 BUG-4）
  const b = plan.boss
  const up = b.team && b.team !== t.group?.team && !plan.members.some(m => m.agent === b.team) ? b.team : 'off'
  return { ok: true, name: t.name, boss: b, members: plan.members, team: plan.team, up, dir, ver: teamVersion(id, b.id, plan.team, up, plan.members.map(p => p.id), dir), group: t.group }
}
/** 上次成組是同一位主管、同一個 team 名稱、同一個協作資料夾才沿用通知紀錄（主管改了名、資料夾換了＝大家要知道新聯絡名稱／新位置，重新通知；複驗第 3 列、測試員 O-9） */
const sameGroup = (c: Checked) => c.group?.boss === c.boss.id && c.group?.team === c.team && (c.group?.dir === undefined || c.group.dir === c.dir)
const doneOf = (c: Checked) => new Set(sameGroup(c) ? c.group!.notified : [])
const knowsOf = (c: Checked) => new Set(sameGroup(c) ? c.group!.bossKnows ?? [] : [])

/** 按「確定」前的確認卡：會登記誰、寫在哪、大約通知幾位；ver 給 go 帶回來 */
export function teamPreview(id: number, D: Pick<TeamDeps, 'table' | 'dir' | 'elsewhere'>) {
  const c = check(id, D)
  if (!c.ok) return c
  const done = doneOf(c), knows = knowsOf(c)
  const fresh = c.members.filter(p => !done.has(p.id))
  // 主管：第一次、有新成員要通知、或有已通知但主管還不知道的成員（跟 go 同一組條件；複驗第 7 列）
  const tellBoss = !done.has(c.boss.id) || fresh.length > 0 || c.members.some(p => done.has(p.id) && !knows.has(p.id))
  return { ok: true as const, text: '', ver: c.ver, boss: c.boss.plate, team: c.team, members: c.members.map(p => p.plate), dir: c.dir, notify: fresh.length + (tellBoss ? 1 : 0), again: done.has(c.boss.id) }
}

/** 同一張桌、同一個主管名稱正在設定中（中間有多次 await）：同時又按一次直接回，不重複登記、通知，也不會兩張桌同時掛同一位主管 */
const busy = new Set<number>(), busyTeam = new Map<string, number>()
/** 設成一組：協作紀錄、登記、通知；回給手機的一句（只說做成的，沒做成的另外列） */
export async function teamUp(id: number, ver: string, D: TeamDeps, now = Date.now()): Promise<{ ok: boolean; text: string }> {
  if (busy.has(id)) return { ok: false, text: '這桌正在設成一組，等它做完再看結果' }
  const c = check(id, D)
  if (c.ok && busyTeam.has(c.team) && busyTeam.get(c.team) !== id) return { ok: false, text: `主管 ${c.team} 正在另一張桌設成一組，等那邊做完再看` }
  busy.add(id)
  if (c.ok) busyTeam.set(c.team, id)
  try { return await teamUpNow(id, ver, D, now) } finally { busy.delete(id); if (c.ok && busyTeam.get(c.team) === id) busyTeam.delete(c.team) }
}
async function teamUpNow(id: number, ver: string, D: TeamDeps, now: number): Promise<{ ok: boolean; text: string }> {
  const c = check(id, D)
  if (!c.ok) return c
  if (ver !== c.ver) return { ok: false, text: '桌上有變動（人、主管或協作資料夾），請重看確認卡' }
  const { boss, members, team, name } = c
  // 1. 協作紀錄：寫不進去就什麼都不做
  let col: ReturnType<typeof writeCollab>
  try { col = writeCollab(c.dir, { team, members, table: name, now }) } catch (e) {
    return { ok: false, text: `協作紀錄寫不進去，沒有送出人事令或通知。資料夾：${c.dir}；原因：${String((e as Error)?.message ?? e).slice(0, 900)}` }
  }
  // 2. 登記：主管 role=manager＋上層；成員 team=主管。不收人事令的（agy）改在通知裡請他自己設（BUG-3）
  const reg = new Map<string, RegState>()
  const doReg = (p: TeamPerson, o: { role?: 'manager'; team?: string }) => {
    try { reg.set(p.id, D.order(p, o) ? { kind: 'order' } : { kind: 'self' }) } catch (e) { reg.set(p.id, { kind: 'bad', why: `人事令寫不進去：${String((e as Error)?.message ?? e).slice(0, 600)}` }) }
  }
  const colText = () => `協作紀錄：${col.created ? `建了 ${col.file}` : col.added.length ? `${col.file} 補上 ${col.added.join('、')}` : `${col.file} 已有，沒改`}`
  doReg(boss, { role: 'manager', team: c.up })
  if (reg.get(boss.id)?.kind === 'self') reg.set(boss.id, { kind: 'bad', why: '主管收不到人事令' })
  // 主管沒登記成：成員掛在他底下沒意義，這次不登記成員、不送通知、不記成組（測試員 O-13）
  if (reg.get(boss.id)!.kind === 'bad') return { ok: false, text: `主管 ${boss.plate} 沒登記成（${(reg.get(boss.id) as { why: string }).why}），這次沒有登記成員或送通知；${colText()}（沒標現任）` }
  for (const p of members) doReg(p, { team })
  // 主管令寫好了才把「現任」標到新主管列（並拿掉我們先前標在別列的）；主管令沒寫成就不標（複驗第三輪 O-10）
  const mark = writeCurrent(col.file, team), markErr = mark.err
  // 3. 通知：只送登記成功（或要自己設）的；送到或存進信箱才算通知過
  const done = doneOf(c), knows = knowsOf(c)
  const sent: TeamPerson[] = [], mailed: TeamPerson[] = [], unsure: TeamPerson[] = [], failed: TeamPerson[] = []
  const tell = async (p: TeamPerson, text: string) => {
    const d = await D.deliver(p, text).catch(() => ({ state: 'failed' as const }))
    if (d.state === 'sent') { sent.push(p); done.add(p.id); return true }
    if (d.state === 'unsure') { unsure.push(p); return false }
    if (!p.kind && p.agent && D.mail(p.agent, text)) { mailed.push(p); done.add(p.id); return true } // 信箱只有 Claude 的外掛會收，只用 ListAgents 名稱
    failed.push(p)
    return false
  }
  for (const p of members) {
    const k = reg.get(p.id)!.kind
    if (k !== 'bad' && !done.has(p.id)) await tell(p, staffNote({ table: name, team, members, me: p, file: col.file, self: k === 'self' }))
    if (k === 'self' && failed.includes(p)) reg.set(p.id, { kind: 'bad', why: '請他自己設定的通知沒送到' }) // 不確定有沒有送到的歸「待確認」，不算沒登記成
  }
  // 主管：第一次收全部名單；之後只在有「已通知到、但主管還不知道」的成員時才送（BUG-2）
  const okMembers = members.filter(p => done.has(p.id))
  if (reg.get(boss.id)!.kind === 'order') {
    if (!done.has(boss.id)) { if (await tell(boss, bossNote({ table: name, members, file: col.file, reg }))) okMembers.forEach(p => knows.add(p.id)) }
    else {
      const news = okMembers.filter(p => !knows.has(p.id))
      if (news.length && await tell(boss, bossNote({ table: name, members, fresh: news, file: col.file, reg }))) news.forEach(p => knows.add(p.id))
    }
  }
  const bad = [boss, ...members].filter(p => reg.get(p.id)!.kind === 'bad')
  const complete = !bad.length && !markErr && [boss, ...members].every(p => done.has(p.id)) && members.every(p => knows.has(p.id))
  // 4. 記下來：最後一刻再查一次別張桌有沒有掛同名主管（複驗第 2 列）
  // 執行中有人換了主管、換座（或刪桌）：不記成這組，照實說。先重取當下名冊，再查同名主管別桌（第五輪複驗第 2 項）
  const now2 = D.table(id, true), plan2 = now2 ? teamPlan(now2.people) : undefined
  const moved = !now2 ? '這張桌已經不在' : !plan2?.ok || plan2.boss.id !== boss.id ? '這桌的主管剛剛換了' : ''
  const other = D.elsewhere(team, id)
  let saved = false
  if (!other && !moved) try { saved = D.save(id, { boss: boss.id, team, notified: [...done], bossKnows: [...knows], dir: c.dir, at: now, complete }, team) } catch {}
  const plates = (ps: TeamPerson[]) => ps.map(p => p.plate).join('、')
  const ordered = members.filter(p => reg.get(p.id)!.kind === 'order'), selfSet = members.filter(p => reg.get(p.id)!.kind === 'self')
  const parts = [
    !col.changed && mark.changed ? `協作紀錄：${col.file} 已標現任 ${team}` : `${colText()}${mark.changed ? '，已標現任' : ''}`, // 測試員 O-14：只補標現任也照實寫
    reg.get(boss.id)!.kind === 'order' ? `主管 ${boss.plate} 已登記${markErr ? `（collab.md 現任標記沒寫上：${markErr}）` : ''}` : '',
    ordered.length ? `已登記成員：${plates(ordered)}` : '',
    selfSet.length ? `已請他自己設定（agy）：${plates(selfSet)}` : '',
    bad.length ? `沒登記成：${bad.map(p => `${p.plate}（${(reg.get(p.id) as { why: string }).why}）`).join('、')}（再按會重試）` : '',
    sent.length ? `通知到：${plates(sent)}` : '',
    mailed.length ? `存進信箱（上線時收到）：${plates(mailed)}` : '',
    unsure.length ? `待確認有沒有收到：${plates(unsure)}（再按會再送）` : '',
    failed.length ? `沒送到：${plates(failed)}（再按會再送）` : '',
    !sent.length && !mailed.length && !unsure.length && !failed.length ? '這次沒有要通知的人' : '',
    moved ? `⚠ ${moved}，這張桌沒記成這組（上面的登記與通知已經做了），請重看確認卡` :
    other ? `⚠ 別張桌「${other}」剛剛也掛了主管 ${team}，這張桌沒記成這組（上面的登記與通知已經做了），請先處理那張桌` :
      !saved ? '⚠ 這次的結果沒記下來（辦公室檔案寫不進去），桌牌不會標「已成組」，再按會重複通知' :
      complete ? `🤝「${name}」已成組` : '還沒全部完成，桌牌先不標「已成組」',
  ].filter(Boolean)
  return { ok: complete && saved, text: parts.join('；') }
}
