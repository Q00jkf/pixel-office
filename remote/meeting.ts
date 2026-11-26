// 整桌開會（roadmap 第 9 項，0.62.12；使用者 2026-11-23 定案）：同一桌的人在原本的桌子開，不進會議室、不走路
// （跨桌開會照舊：skill meet.md＋office_meeting 會議室走路動畫，這裡不管）
// - 手機桌牌選單「🗣 開會」：題目、參與者（預設全桌、可取消；送出前提示「N 位參與，會花 N 份用量」）；沒主管的桌不能開
// - 主持人＝這桌主管；流程照 meet.md（各寫提案、主持人整合、寫 方案.md）；主管整理結論回報使用者；要使用者決定的事寫進 collab.md「待使用者裁示」
// - 會議資料夾：這桌協作資料夾/會議/<YYYY-MM-DD>-<題目>/（議題.md 由這裡寫）；主持人寫好 方案.md＝散會
// - 畫面：桌牌「🗣 開會中：題目」、參與的人頭上冒對話泡泡；散會後手機通知「A 桌開完會了」，點開看結論
// 狀態存 meetings-<port>.json（給面板讀「開會中」）
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 流程直接寫進 議題.md（0.62.17）：原本叫大家去讀 skill 的 meet.md，那個檔在外掛資料夾、不在員工的工作資料夾，
 * 會停下來問「Allow this read outside the working directories?」。內容照 meet.md 的參與者／主持人／檔案格式，改成整桌開會版
 */
export const MEET_FLOW = [
  '## 流程（整桌開會版；不用另外讀 meet.md，也不用 office_meeting）',
  '規則：只寫自己的檔（提案-<名牌>.md）；只寫自己職責的部分；訊息只傳路徑＋一句話；參與者不讀別人的提案；被權限擋住就在自己視窗回報使用者、告訴主持人「我缺席」，不代做。',
  '',
  '### 參與者',
  '1. 只讀這份議題，在這個資料夾寫 `提案-<你的名牌>.md`（15 行內：建議 3～5 點／需要誰配合（沒有寫「無」）／風險 1～2 點）。',
  '2. SendMessage 給主持人：`提案好了：<路徑>`。',
  '3. 主持人來 `請確認：<方案草稿 路徑>#<你那段>` → 只讀你那段，同意回 `同意`，不同意回一行「要改什麼＋理由」。',
  '',
  '### 主持人（這桌主管）',
  '1. 先寫自己的提案；等所有人 `提案好了`（有人不在線就標「缺席」照已交的整合）。',
  '2. 讀所有提案寫 `方案草稿.md`：每人一段（照職責）＋「整合」＋「需要配合」＋「決定紀錄」（沒有寫「無」）；衝突自己能取捨就直接決定並寫理由。',
  '3. 對每位送 `請確認：<路徑>#<他那段>`，收齊照意見改。',
  '4. 定稿寫 `方案.md`（＝散會，辦公室會通知使用者）；對每位參與者送 `散會`。',
  '5. 結論整理一段回報使用者；要使用者決定的事寫進這桌 collab.md 的「# 待使用者裁示」。',
].join('\n')

export const MEET_DONE_SHOW_MS = 60 * 60e3 // 「開完會了」通知留一小時
export type Meeting = {
  id: string; table: number; label: string; topic: string; dir: string
  boss: string; bossName: string; ids: string[]; names: string[]
  at: number; state: 'on' | 'done' | 'ended'; doneAt?: number; by?: string
}
type Person = { id: string; plate: string; agent?: string; title?: string; role?: string; seat?: string }
export type MeetDeps = {
  base: string
  port: () => number
  office: () => { people: Person[] }
  sendCommand: (id: string, text: string) => string | undefined
}
let D: MeetDeps
export function initMeetings(deps: MeetDeps) { D = deps }

const file = () => join(D.base, `meetings-${D.port()}.json`)
export function meetings(): Meeting[] {
  try { const j = JSON.parse(readFileSync(file(), 'utf8')); return Array.isArray(j.meetings) ? j.meetings : [] } catch { return [] }
}
const save = (list: Meeting[]) => writeFileSync(file(), JSON.stringify({ meetings: list }, null, 1))
const pad = (n: number) => String(n).padStart(2, '0')
const day = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }
const hm = (t: number) => { const d = new Date(t); return `${day(t)} ${pad(d.getHours())}:${pad(d.getMinutes())}` }
/** 題目 → 資料夾短名：去掉路徑字元（半形、全形都濾，0.62.18），最多 20 字 */
export const topicSlug = (topic: string) => [...topic.replace(/[\\/:*?"<>|\s：／＼？＊＂＜＞｜]+/g, '-').replace(/^-+|-+$/g, '')].slice(0, 20).join('') || '會議'

/**
 * 開會：寫 議題.md、通知主持人（主管）與參與者。who＝這桌的人（含座位）；ids＝勾選的人（主管一定在）。
 * notesDir＝這桌的協作資料夾（server.ts notesDir）
 */
export function startMeeting(o: { table: number; label: string; topic: string; ids: string[]; who: Person[]; notesDir: string; by?: string }, now = Date.now()): { ok: boolean; text: string; id?: string } {
  const topic = o.topic.replace(/\s+/g, ' ').trim()
  if (!topic || [...topic].length > 40) return { ok: false, text: '題目要 1～40 字' }
  const boss = o.who.find(p => p.role === 'manager')
  if (!boss) return { ok: false, text: '這桌沒有主管：先挑一位主管才能開會' }
  if (meetings().some(m => m.table === o.table && m.state === 'on')) return { ok: false, text: '這桌正在開會，先等它開完' }
  const ids = [...new Set([boss.id, ...o.ids])].filter(id => o.who.some(p => p.id === id))
  if (ids.length < 2) return { ok: false, text: '至少要兩位參與（主管＋一位）' }
  const ppl = ids.map(id => o.who.find(p => p.id === id)!)
  const handle = (p: Person) => p.agent || p.plate
  let dir = join(o.notesDir, '會議', `${day(now)}-${topicSlug(topic)}`)
  for (let n = 2; existsSync(dir); n++) dir = join(o.notesDir, '會議', `${day(now)}-${topicSlug(topic)}-${n}`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '議題.md'), [
      `# ${topic}`,
      `- 主管（主持人）：${handle(boss)} ｜ 開會：${hm(now)} ｜ 協作桌：${o.label}（整桌開會，在原本的桌子開，不進會議室）`,
      `- 輸出：${join(dir, '方案.md')}`,
      '',
      '## 背景與限制',
      `使用者從手機開的整桌開會，題目：「${topic}」。各自只從自己的職責提案；要使用者決定的事，主持人寫進這桌 collab.md 的「待使用者裁示」。`,
      '',
      '## 參與者',
      '| 名牌 | ListAgents | 職責 |',
      '|---|---|---|',
      ...ppl.map(p => `| ${p.plate} | ${p.agent ?? '—'} | ${p === boss ? '主持人（這桌主管）' : p.title || '（照你的職稱）'} |`),
      '',
      MEET_FLOW,
      '',
    ].join('\n'))
  } catch (e) {
    return { ok: false, text: `會議資料夾建不起來：${String(e).slice(0, 120)}` }
  }
  const topicLine = `🗣 整桌開會：${topic}（協作桌「${o.label}」，在原本的桌子開，不用 office_meeting）`
  D.sendCommand(boss.id, `${topicLine}\n你是主持人（這桌主管）。議題：${join(dir, '議題.md')}，流程寫在議題的「主持人」段（不用另外讀 meet.md）：先寫自己的提案、收齊 ${ppl.length - 1} 位的提案、整合、確認，最後寫 ${join(dir, '方案.md')}（寫好就算散會，辦公室會通知使用者）。` +
    `結論整理一段回報使用者；要使用者決定的事寫進這桌 collab.md 的「# 待使用者裁示」。參與者：${ppl.filter(p => p !== boss).map(handle).join('、')}`)
  for (const p of ppl) if (p !== boss) D.sendCommand(p.id, `📋 ${topicLine}｜你的職責：${p.title || '照你的職稱'}｜主持人：${handle(boss)}\n議題：${join(dir, '議題.md')}（流程寫在議題的「參與者」段，不用另外讀 meet.md；提案寫在同一個資料夾）`)
  const m: Meeting = { id: crypto.randomUUID().slice(0, 8), table: o.table, label: o.label, topic, dir, boss: boss.id, bossName: handle(boss), ids, names: ppl.map(p => p.plate), at: now, state: 'on', by: o.by }
  save([...meetings().filter(x => x.state === 'on' || now - (x.doneAt ?? x.at) < MEET_DONE_SHOW_MS), m])
  return { ok: true, text: `🗣 開會了：${topic}（${ppl.length} 位，主持人 ${boss.plate}）`, id: m.id }
}

/** 每次輪詢：主持人寫好 方案.md＝散會；參與的人都不在線了也算結束 */
export function tickMeetings(now = Date.now()): void {
  const list = meetings()
  if (!list.some(m => m.state === 'on')) return
  const { people } = D.office()
  for (const m of list) {
    if (m.state !== 'on') continue
    if (existsSync(join(m.dir, '方案.md'))) { m.state = 'done'; m.doneAt = now; continue }
    if (!m.ids.some(id => people.some(p => p.id === id))) { m.state = 'ended'; m.doneAt = now }
  }
  save(list.filter(m => m.state === 'on' || now - (m.doneAt ?? m.at) < MEET_DONE_SHOW_MS))
}

/** 使用者手動結束（不等結論）：通知主持人 */
export function endMeeting(id: string, now = Date.now()): { ok: boolean; text: string } {
  const list = meetings(), m = list.find(x => x.id === id && x.state === 'on')
  if (!m) return { ok: false, text: '這場會已經結束了' }
  m.state = 'ended'; m.doneAt = now
  save(list)
  D.sendCommand(m.boss, `🗣 使用者結束了整桌開會「${m.topic}」。已經有的提案整理一段結論回報使用者就好（不用再寫 方案.md）`)
  return { ok: true, text: `結束了「${m.topic}」` }
}

/** 給手機：開會中的桌（桌牌、頭上泡泡）、剛開完的通知 */
export function meetingView(now = Date.now()) {
  const list = meetings()
  return {
    on: list.filter(m => m.state === 'on').map(m => ({ id: m.id, table: m.table, topic: m.topic, ids: m.ids })),
    done: list.filter(m => m.state === 'done' && now - (m.doneAt ?? 0) < MEET_DONE_SHOW_MS).map(m => ({ id: m.id, table: m.table, label: m.label, topic: m.topic, at: m.doneAt })),
  }
}

/** 一場會的結論（方案.md，最多 8000 字） */
export function meetingResult(id: string): { ok: boolean; text: string; topic?: string; label?: string; dir?: string } {
  const m = meetings().find(x => x.id === id)
  if (!m) return { ok: false, text: '找不到這場會（通知只留一小時；會議紀錄在共用筆記）' }
  let t = ''
  try { t = readFileSync(join(m.dir, '方案.md'), 'utf8') } catch { return { ok: false, text: '還沒有結論（方案.md）', topic: m.topic, label: m.label, dir: m.dir } }
  return { ok: true, text: t.length > 8000 ? t.slice(0, 8000) + '\n…（太長，完整的在資料夾裡）' : t, topic: m.topic, label: m.label, dir: m.dir }
}
