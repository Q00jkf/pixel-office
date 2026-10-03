import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Coworker, OfficeMode, Role } from '../types'
import { NOTICE_FRAMES, PLANE_FRAMES, TREAT_FRAMES, assignSeats, drawScene, encode, plateName, route, sceneRows, sceneWidth, walkerPos } from './scene'
import type { Notice, Placement, Plane, SceneOptions, Walker } from './scene'

const PANE = 'pixel-office'
const STALE_MS = 20000 // 超過這麼久沒心跳 = 視窗已關
const crew = atom({ plugin: 'pixel-office', key: 'crew' } as const, [] as Coworker[])
const night = atom({ plugin: 'pixel-office', key: 'night' } as const, false)
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
let treatFrame: number | undefined
let catOffset = 0
let planes: Plane[] = []
let permissionMode = ''
let notices: Notice[] = []
// 每位同事上一次看到的送信／收信時間與狀態；第一次看到只記錄、不觸發（避免開面板時重播舊事件）
const seenSent = new Map<string, number | undefined>()
const seenGot = new Map<string, number | undefined>()
const seenMode = new Map<string, OfficeMode>()

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
      if (old && old.kind !== pl.kind) {
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

/** 讀自己上一次寫的狀態檔（重載後找回名牌、職稱、agent） */
async function readOwnStatus($: EngineInterface, id: string): Promise<{ role?: Role; name?: string; agent?: string; title?: string } | undefined> {
  try {
    const raw = await $.fs.read(`${await sharedDir($)}/${id}.json`)
    const s = JSON.parse(typeof raw === 'string' ? raw : '{}')
    const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined)
    return { role: s.role === 'manager' || s.role === 'staff' ? s.role : undefined, name: str(s.name), agent: str(s.agent), title: str(s.title) }
  } catch {
    return undefined
  }
}

// 把自己的狀態寫到共用資料夾：一個 session 一個檔，不會互相覆蓋
async function publish($: EngineInterface, left: boolean) {
  const d = await sharedDir($)
  const updatedAt = await $.clock.now()
  await $.fs.write(`${d}/${me.id}.json`, JSON.stringify({ id: me.id, name: me.name, role: me.role, mode: me.mode, tool: me.tool, agent: me.agent, title: me.title, sentTo: me.sentTo, sentAt: me.sentAt, gotAt: me.gotAt, updatedAt, left }))
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
}

/** 辦公室名單（/office who 與 office_roster 共用）：主管在前，其餘依名牌 */
export function roster(list: Coworker[], now: number): string {
  if (list.length === 0) return '辦公室目前沒有人。'
  const sorted = [...list].sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'manager' ? -1 : 1))
  const rows = sorted.map(c => {
    const doing = c.mode === 'typing' || c.mode === 'reading' || c.mode === 'waiting' ? `${MODE_LABEL[c.mode]}（${c.tool}）` : MODE_LABEL[c.mode] ?? c.mode
    const agent = c.agent ?? '（未登記，傳訊息找不到）'
    return `| ${c.isMe ? '▶ ' : ''}${c.name} | ${c.title ?? '—'} | ${c.role === 'manager' ? '主管' : '員工'} | ${agent} | ${doing} |`
  })
  const head = [
    `像素辦公室名單（${list.length} 人在線，${new Date(now).toISOString().slice(11, 19)} UTC）`,
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
  const found: Coworker[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.json') || entry.name === `${me.id}.json`) continue
    try {
      const raw = await $.fs.read(`${d}/${entry.name}`)
      const s = JSON.parse(typeof raw === 'string' ? raw : '{}')
      if (!s.left && typeof s.updatedAt === 'number' && now - s.updatedAt < STALE_MS) {
        found.push({
          id: String(s.id),
          name: String(s.name),
          mode: s.mode as OfficeMode,
          tool: String(s.tool ?? ''),
          isMe: false,
          role: s.role === 'manager' ? 'manager' : 'staff',
          agent: typeof s.agent === 'string' ? s.agent : undefined,
          title: typeof s.title === 'string' ? s.title : undefined,
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
async function applyProfile($: EngineInterface, input: { role?: string; name?: string; agent?: string; title?: string }): Promise<string> {
  const notes: string[] = []
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
  if (notes.length === 0) return '沒有要改的：請給 role（主管／員工）、name（英數字）、title（職稱）或 agent（ListAgents 名稱）。'
  me = { ...me, role, name, agent, title }
  await $.store.set(`profile:${me.id}`, { role, name, agent, title }).catch(() => undefined) // 存不了只是重開後不記得
  await showCrew($)
  await publish($, false).catch(() => undefined)
  return `已設定：${notes.join('、')}。`
}

// 暫時狀態：ms 後若沒被別的狀態蓋掉，就切回 to
function revertLater($: EngineInterface, ms: number, to: OfficeMode) {
  const mine = seq
  $.clock.after(ms, () => {
    if (seq === mine) void setMode($, to)
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
        },
      },
    })
    await $.tool.register({
      name: 'office_roster',
      description:
        '查「像素辦公室」名單：目前在線的每個 Claude Code session 的名牌、職稱、角色（主管／員工）、ListAgents 名稱（傳 SendMessage 用）與正在做什麼。要找主管、找負責某件事的人、或確認對方身分時用。只讀，不改任何東西。',
      inputSchema: { type: 'object', properties: {} },
    })
    const id = await $.session.id()
    me = { ...me, id, name: plateName(await $.session.cwd(), id) }
    // 先讀 $.store；讀不到（例如同一 session 載了兩份 MOD、各自的儲存區不同）就用自己的狀態檔當備援
    let saved = (await $.store.get(`profile:${id}`).catch(() => undefined)) as { role?: Role; name?: string; agent?: string; title?: string } | undefined
    const own = await readOwnStatus($, id)
    if (own) saved = { role: saved?.role ?? own.role, name: saved?.name ?? own.name, agent: saved?.agent ?? own.agent, title: saved?.title ?? own.title }
    if (saved?.role === 'manager' || saved?.role === 'staff') me = { ...me, role: saved.role }
    if (typeof saved?.name === 'string' && validName(saved.name)) me = { ...me, name: saved.name }
    const savedAgent = (saved as { agent?: unknown } | undefined)?.agent
    if (typeof savedAgent === 'string' && savedAgent.length > 0) me = { ...me, agent: savedAgent }
    const savedTitle = (saved as { title?: unknown } | undefined)?.title
    if (typeof savedTitle === 'string' && savedTitle.length > 0) me = { ...me, title: savedTitle }
    await publish($, false).catch(() => undefined)
    await refresh($).catch(() => undefined)

    $.clock.every(250, () => {
      frame += 1
      if (width > 0) void $.ui.blit({ requestId: PANE, key: 'scene', cells: encode(drawScene(everyone(), frame, width, rows, liveWalkers(), lastPlaced ?? undefined, sceneOpts())) })
    })
    $.clock.every(1000, () => void refresh($).catch(() => undefined))
    $.clock.every(5000, () => void publish($, false).catch(() => undefined))

    return next(e)
  })

  // 系統提示加一句：角色變了要更新辦公室（每輪多讀約 60 字）
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const section = {
      id: 'pixel-office:role',
      text:
        '像素辦公室：使用者有開一個辦公室面板顯示每個 session。(1) 若你還沒登記，第一次用到 ListAgents 時，把「This session is X」的 X 用 mcp__pixel-office__office_profile(agent=X) 登記一次，別人傳訊息給你時辦公室才找得到你。(2) 被指派或卸下主管等角色時，呼叫同一個工具更新 role（主管／員工）；職稱 title（例如 IT、查證）與名牌 name（短代號）也可順便設。(3) 要找主管、找負責某件事的人或確認對方身分時，呼叫 mcp__pixel-office__office_roster 看名單。只影響畫面，不影響權限。',
      scope: 'session' as const,
    }
    return { sections: [...composed.sections, section] }
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
        me = { ...me, sentTo: e.to, sentAt: await $.clock.now() }
        await showCrew($)
        await publish($, false)
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
      if (waitsForApproval(verdict.decision, e.tool_use_id, permissionMode)) await setMode($, 'waiting', String(e.tool))
    } catch {}
    return verdict
  })

  on('session.end', async ($, e, next) => {
    await publish($, true).catch(() => undefined)

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
    if (sub === 'who') {
      await refresh($).catch(() => undefined)
      return { text: roster(everyone(), await $.clock.now()) }
    }
    if (sub !== '' && sub !== undefined) return { text: '用法：/office｜/office who｜/office role 主管|員工｜/office title <職稱>｜/office name <英數字>｜/office agent <ListAgents 名稱>' }

    await refresh($).catch(() => undefined)
    await $.ui.open({ id: PANE, title: '像素辦公室' })

    return { text: `像素辦公室已開啟。你是${ROLE_LABEL[me.role]}，名牌 ${me.name}。` }
  })

  // 模型自己設定角色／名牌
  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as { role?: string; name?: string; agent?: string; title?: string }
    const text = await applyProfile($, { role: input.role, name: input.name, agent: input.agent, title: input.title })

    // 自訂工具的 result 只能是字串或內容區塊陣列，不能是物件（實測：物件會被引擎判為格式錯誤）
    return { result: `${text}（目前：${ROLE_LABEL[me.role]}，名牌 ${me.name}）` }
  })

  on('prompt.submit', async ($, e, next) => {
    try {
      await setMode($, 'thinking')
    } catch {}

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const name = String(e.tool)
    try {
      await setMode($, READING.has(name) ? 'reading' : 'typing', name)
    } catch {}
    const ran = await next(e)
    try {
      if (ran.deny !== undefined || ran.isError === true) {
        await setMode($, 'error', name)
        revertLater($, 2500, 'thinking')
      } else {
        await setMode($, 'thinking')
      }
    } catch {}

    return ran
  })

  on('turn.complete', async ($, e, next) => {
    try {
      await setMode($, 'done')
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
      const { Box, Text, Button } = $.ui.resolve(e)
      width = 0
      return (
        <Box flexDirection="column">
          <Text bold>像素辦公室：{shown.length} 人在線</Text>
          <Text dimColor>像素畫只在終端版顯示。</Text>
          <Button key="role" label={isBoss ? '設為員工' : '升為主管'} onPress={toggleRole} />
        </Box>
      )
    }

    const { Box, Raster, Button, Text } = $.ui.resolve(e)
    width = sceneWidth(e.props.bodyColumns)
    rows = sceneRows(e.props.scroll?.bodyRows) // 撐滿面板，扣掉預留空白與按鈕列
    lastPlaced = assignSeats(shown, width, rows, lastPlaced ?? undefined)

    return (
      <Box flexDirection="column">
        <Raster key="scene" columns={width} rows={rows} cells={encode(drawScene(shown, frame, width, rows, liveWalkers(), lastPlaced, sceneOpts()))} />
        {/* 預留一列：之後放小對話框或更多按鈕 */}
        <Text key="reserved"> </Text>
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
