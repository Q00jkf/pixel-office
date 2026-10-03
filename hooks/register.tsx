import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Coworker, OfficeMode, Role } from '../types'
import { TREAT_FRAMES, assignSeats, drawScene, encode, plateName, route, sceneRows, sceneWidth, walkerPos } from './scene'
import type { Placement, SceneOptions, Walker } from './scene'

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

const sceneOpts = (): SceneOptions => ({ night: nightMode, treatFrame, catOffset })

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

// 把自己的狀態寫到共用資料夾：一個 session 一個檔，不會互相覆蓋
async function publish($: EngineInterface, left: boolean) {
  const d = await sharedDir($)
  const updatedAt = await $.clock.now()
  await $.fs.write(`${d}/${me.id}.json`, JSON.stringify({ id: me.id, name: me.name, role: me.role, mode: me.mode, tool: me.tool, updatedAt, left }))
}

async function showCrew($: EngineInterface) {
  const list = everyone()
  const json = JSON.stringify(list)
  if (json === lastCrew) return
  lastCrew = json
  trackMoves(list)
  await update($, crew, () => list)
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
        found.push({ id: String(s.id), name: String(s.name), mode: s.mode as OfficeMode, tool: String(s.tool ?? ''), isMe: false, role: s.role === 'manager' ? 'manager' : 'staff' })
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
const ROLE_WORDS: Record<string, Role> = { 主管: 'manager', manager: 'manager', boss: 'manager', 員工: 'staff', staff: 'staff', employee: 'staff' }
const ROLE_LABEL: Record<Role, string> = { manager: '主管', staff: '員工' }

export function parseRole(word: string): Role | undefined {
  return ROLE_WORDS[word.trim().toLowerCase()] ?? ROLE_WORDS[word.trim()]
}

export function validName(name: string): boolean {
  return /^[\x21-\x7e]{1,12}$/.test(name)
}

// 角色與名牌：/office 指令和模型工具共用；依 session 編號記在 $.store
async function applyProfile($: EngineInterface, input: { role?: string; name?: string }): Promise<string> {
  const notes: string[] = []
  let role = me.role
  let name = me.name
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
  if (notes.length === 0) return '沒有要改的：請給 role（主管／員工）或 name（英數字）。'
  me = { ...me, role, name }
  await $.store.set(`profile:${me.id}`, { role, name }).catch(() => undefined) // 存不了只是重開後不記得
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
        '設定你在「像素辦公室」裡的角色與名牌。知道自己是主管（例如被指派為協作主管）就設 role="主管"，一般 session 設 "員工"；name 是桌上名牌，只能英數字 1～12 字，建議用你的短代號（例如 58、e2）。只影響辦公室畫面，不影響任何權限或檔案。',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', enum: ['主管', '員工'], description: '主管 或 員工' },
          name: { type: 'string', description: '名牌，英數字 1～12 字' },
        },
      },
    })
    const id = await $.session.id()
    me = { ...me, id, name: plateName(await $.session.cwd(), id) }
    const saved = (await $.store.get(`profile:${id}`).catch(() => undefined)) as { role?: Role; name?: string } | undefined
    if (saved?.role === 'manager' || saved?.role === 'staff') me = { ...me, role: saved.role }
    if (typeof saved?.name === 'string' && validName(saved.name)) me = { ...me, name: saved.name }
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
      text: '像素辦公室：使用者有開一個辦公室面板顯示每個 session。當你被指派或卸下主管等角色時，呼叫 mcp__pixel-office__office_profile 更新 role（主管／員工），名牌 name 可設成你的短代號。只影響畫面，不影響權限。',
      scope: 'session' as const,
    }
    return { sections: [...composed.sections, section] }
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
    if (sub !== '' && sub !== undefined) return { text: '用法：/office｜/office role 主管|員工｜/office name <英數字>' }

    await refresh($).catch(() => undefined)
    await $.ui.open({ id: PANE, title: '像素辦公室' })

    return { text: `像素辦公室已開啟。你是${ROLE_LABEL[me.role]}，名牌 ${me.name}。` }
  })

  // 模型自己設定角色／名牌
  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as { role?: string; name?: string }
    const text = await applyProfile($, { role: input.role, name: input.name })

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
    rows = sceneRows(e.viewport?.rows === undefined ? undefined : e.viewport.rows - 2) // 留一列給按鈕
    lastPlaced = assignSeats(shown, width, rows, lastPlaced ?? undefined)

    return (
      <Box flexDirection="column">
        <Raster key="scene" columns={width} rows={rows} cells={encode(drawScene(shown, frame, width, rows, liveWalkers(), lastPlaced, sceneOpts()))} />
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
