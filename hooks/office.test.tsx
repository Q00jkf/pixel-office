import { test, expect } from 'claude-code/testing'

import type { Coworker } from '../types'
import { catPose, catRange, catWalkRows, drawScene, encode, layout, plateName, sceneRows, sceneWidth } from './scene'

const P = (id: string, name: string, mode: Coworker['mode'] = 'idle', isMe = false, role: Coworker['role'] = 'staff'): Coworker => ({
  id,
  name,
  mode,
  tool: '',
  isMe,
  role,
})

// 把 Raster 的 cells 解回每格的字元，用來找名牌
function cellText(cells: string, width: number, rows: number): string[] {
  const words = new Uint32Array(Uint8Array.fromBase64(cells).buffer)
  const lines: string[] = []
  for (let r = 0; r < rows; r++) {
    let s = ''
    for (let c = 0; c < width; c++) {
      const cp = words[(r * width + c) * 3]
      s += cp === 0x2580 ? ' ' : String.fromCharCode(cp)
    }
    lines.push(s)
  }
  return lines
}

test('floor plan: the two desk rows of a cluster have an aisle between them', () => {
  const L = layout(60, 40)
  const ys = [...new Set(L.seats.map(s => s.y))].sort((a, b) => a - b)
  expect(ys[1] - ys[0]).toBe(12 + 2 + 8) // 桌高 12 ＋ 橫隔板 2 ＋ 走道 8
  expect(ys[0]).toBe(24 + 10) // 座位區離上方內牆 10 像素
})

test('floor plan: one cluster of 4 at the narrowest, two side by side from 56 columns, more rows when taller', () => {
  expect(layout(48, 32).seats).toHaveLength(4)
  expect(layout(60, 32).seats).toHaveLength(8)
  expect(layout(60, 47).seats).toHaveLength(8) // 47 列只排得下一排座位群
  expect(layout(60, 62).seats).toHaveLength(16) // 底部走廊 18 像素（貓走家具上方）後，兩排座位群要 62 列
  expect(sceneRows(undefined)).toBe(44)
  expect(sceneRows(20)).toBe(44)
  expect(sceneRows(60)).toBe(58) // 撐滿面板：60 列扣掉預留空白＋按鈕
  expect(sceneWidth(20)).toBe(48)
  // 名牌要對齊終端列：每個座位的 y 都是偶數
  for (const s of layout(112, 60).seats) expect(s.y % 2).toBe(0)
  // 座位都在牆內、主管室在右上
  const L = layout(60, 40)
  for (const s of L.seats) expect(s.x >= 2 && s.x + 11 <= 58 && s.y + 12 <= L.h - 2).toBe(true)
  expect(L.manager.x).toBeGreaterThan(L.officeX)
})

test('nameplates: me marked >, manager in the office with a gold *, staff on desks, overflow +N', () => {
  const crew = [P('m', 'boss58', 'typing', false, 'manager'), P('a', 'e2', 'idle', true), P('b', 'u79', 'reading')]
  const text = cellText(encode(drawScene(crew, 2, 48, 32)), 48, 32).join('\n')
  expect(text).toContain('*boss58')
  expect(text).toContain('>e2')
  expect(text).toContain('u79')

  const many = Array.from({ length: 6 }, (_, i) => P(`id${i}`, `s${i}`))
  expect(cellText(encode(drawScene(many, 0, 48, 32)), 48, 32)[0]).toContain('+2')
})

test('a second manager sits in the open area but keeps the *', () => {
  const crew = [P('m1', 'boss', 'idle', false, 'manager'), P('m2', 'vice', 'idle', false, 'manager')]
  const text = cellText(encode(drawScene(crew, 0, 48, 32)), 48, 32).join('\n')
  expect(text).toContain('*boss')
  expect(text).toContain('*vice')
})

test('scene encodes to width x rows cells for every size and mode', () => {
  for (const [w, r] of [[48, 32], [60, 40], [112, 60]]) {
    for (const mode of ['idle', 'thinking', 'typing', 'reading', 'error', 'done'] as const) {
      const scene = drawScene([P('a', 'x', mode, true), P('m', 'b', mode, false, 'manager')], 3, w, r)
      expect(Uint8Array.fromBase64(encode(scene)).length).toBe(w * r * 12)
    }
  }
})

test('nameplates are ASCII only', () => {
  expect(plateName('C:\\Users\\user\\.aaproject\\LLM-Wiki-AEGIVERSE', 'abcd1234')).toBe('LLM-Wiki-AEGIVERSE')
  expect(plateName('C:\\Users\\user\\互宇', 'abcd1234')).toBe('s-abcd')
  expect(plateName('C:\\Users\\user\\.claude\\dev-mods\\43186042-aa86-487c-bdd0-7f1faa67df28', '43186042-aa86')).toBe('s-4318')
})

test('side-view cat: 8 rows, two pointed ears, four distinct walk frames with a 1px bob, stays in the corridor', () => {
  const frames = [0, 1, 2, 3].map(catWalkRows)
  expect(new Set(frames.map(f => f.join('|'))).size).toBe(4)
  for (const f of frames) {
    expect(f).toHaveLength(8)
    for (const row of f) expect(row).toHaveLength(12)
  }
  // 抬起的格（0、2）耳朵在第 0 列，下沉的格（1、3）在第 1 列
  expect(frames[0][0]).toBe('........O..O')
  expect(frames[1][1]).toBe('........O..O')
  const range = catRange(48)
  for (let f = 0; f < 300; f++) {
    const { x } = catPose(f, range)
    expect(x >= 0 && x <= range).toBe(true)
  }
})

test('/office reads the other sessions: fresh ones sit down, stale and left ones do not', async ($, on) => {
  const NOW = 1_000_000
  const files: Record<string, string> = {
    'b.json': JSON.stringify({ id: 'b', name: 'hub', role: 'staff', mode: 'typing', tool: 'Bash', updatedAt: NOW - 2000, left: false }),
    'c.json': JSON.stringify({ id: 'c', name: 'oldone', mode: 'idle', tool: '', updatedAt: NOW - 60000, left: false }),
    'd.json': JSON.stringify({ id: 'd', name: 'gone', mode: 'idle', tool: '', updatedAt: NOW - 1000, left: true }),
  }
  const writes: string[] = []
  on('env.get', () => ({ value: 'C:/Users/tester' }))
  on('clock.now', () => ({ value: NOW }))
  on('fs.list', () => ({ value: Object.keys(files).map(name => ({ name, kind: 'file', size: 1, mtimeMs: NOW, isLink: false })) }) as any)
  on('fs.read', (_$, e) => ({ value: files[e.path.split(/[\\/]/).pop() ?? ''] ?? '{}' }))
  on('fs.write', (_$, e) => {
    writes.push(e.path)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)

  await $.command.run({ command: 'office', args: '' } as any)
  const ui = await $.ui.mount({
    plugin: 'pixel-office',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'pixel-office',
    props: { title: '像素辦公室', isFocused: false, bodyColumns: 48, placement: 'dock', scroll: undefined, view: undefined },
    viewport: { columns: 120, rows: 44 },
  } as any)
  const raster = await ui.find({ type: 'Raster', key: 'scene' })
  const p = raster!.props as { cells: string; columns: number; rows: number }
  const text = cellText(p.cells, p.columns, p.rows).join('\n')
  expect(text).toContain('hub')
  expect(text).not.toContain('oldone')
  expect(text).not.toContain('gone')
  await ui.unmount()

  await $.tool.call({ tool: 'Read', file_path: 'a.md' } as any).catch(() => undefined)
  expect(writes.some(w => /tester[\\/]\.claude[\\/]pixel-office[\\/]sessions[\\/]/.test(w))).toBe(true)
})

test('desktop draws the office as an SVG under the size limit, with all buttons', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  const ui = await $.ui.mount({
    plugin: 'pixel-office',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'pixel-office',
    props: { title: '像素辦公室', isFocused: false, bodyColumns: 112, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: undefined },
  } as any)
  const svg = await ui.find({ type: 'Svg' })
  const src = String(svg!.props.source)
  expect(src.startsWith('<svg')).toBe(true)
  expect(src).toContain('<path')
  expect(src.length).toBeLessThanOrEqual(131072)
  expect(String(svg!.props.alt)).toContain('人在線')
  for (const key of ['role', 'cat', 'night']) expect(await ui.find({ key })).toBeDefined()
  await ui.unmount()
})

test('desktop keeps a text line for the head count (old behaviour)', async $ => {
  const ui = await $.ui.mount({
    plugin: 'pixel-office',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'pixel-office',
    props: { title: '像素辦公室', isFocused: false, bodyColumns: 48, placement: 'dock', scroll: undefined, view: undefined },
  } as any)
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toContain('人在線')
  await ui.unmount()
})

const MOCKS = (on: any, writes: string[]) => {
  on('env.get', () => ({ value: 'C:/Users/tester' }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('fs.list', () => ({ value: [] }))
  on('fs.write', (_$: any, e: any) => {
    writes.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
}

test('/office role 主管 and /office name set the profile and publish it', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  expect((await $.command.run({ command: 'office', args: 'role 主管' } as any)).text).toContain('角色＝主管')
  expect((await $.command.run({ command: 'office', args: 'name 58' } as any)).text).toContain('名牌＝58')
  expect((await $.command.run({ command: 'office', args: 'name 主管室' } as any)).text).toContain('不行')
  const last = JSON.parse(writes[writes.length - 1])
  expect(last.role).toBe('manager')
  expect(last.name).toBe('58')
})

test('the model can set its own role through the office_profile tool', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  const out: any = await $.tool.call({ tool: 'mcp__pixel-office__office_profile', role: '主管', name: 'e2' } as any)
  expect(typeof out.result).toBe('string')
  expect(out.result).toContain('主管')
  expect(JSON.parse(writes[writes.length - 1]).role).toBe('manager')
})

// ---------- 固定座位與升遷走路 ----------

import { assignSeats, route, walkerPos } from './scene'

test('seats are sticky: someone leaving does not shuffle everyone else', () => {
  const a = P('alpha', 'a'), b = P('bravo', 'b'), c = P('charlie', 'c')
  const before = assignSeats([a, b, c], 60, 40)
  const after = assignSeats([a, c], 60, 40, before)
  expect(after.get('alpha')!.seat).toEqual(before.get('alpha')!.seat)
  expect(after.get('charlie')!.seat).toEqual(before.get('charlie')!.seat)
})

test('a promotion walks from the desk, along the hall, through the office door, to the boss chair', () => {
  const staffMe = P('zed', 'z', 'idle', true, 'staff')
  const bossMe = { ...staffMe, role: 'manager' as const }
  const from = assignSeats([staffMe], 60, 40).get('zed')!
  const to = assignSeats([bossMe], 60, 40).get('zed')!
  expect(from.kind).toBe('staff')
  expect(to.kind).toBe('boss')
  const path = route(from, to, 60, 40)
  expect(path[0]).toEqual(from.stand)
  expect(path[path.length - 1]).toEqual(to.stand)
  for (let i = 0; i < path.length - 1; i++) expect(path[i].x === path[i + 1].x || path[i].y === path[i + 1].y).toBe(true)
  const w = { id: 'zed', path, start: 10 }
  expect(walkerPos(w, 10)).toMatchObject(from.stand)
  expect(walkerPos(w, 10_000)).toBeNull()
  const dirs = new Set<string>()
  for (let f = 10; f < 200; f++) {
    const at = walkerPos(w, f)
    if (!at) continue
    expect(at.x >= 2 && at.x < 58 && at.y >= 2 && at.y < 78).toBe(true)
    expect(Math.abs(at.dx) + Math.abs(at.dy)).toBeLessThanOrEqual(1) // 只走直線段
    dirs.add(`${at.dx},${at.dy}`)
  }
  // 途中真的有轉向：同時出現左右走與上下走
  expect([...dirs].some(d => d.endsWith(',0') && d !== '0,0')).toBe(true)
  expect([...dirs].some(d => d.startsWith('0,') && d !== '0,0')).toBe(true)
})

// ---------- 按鈕、夜間模式、餵貓、系統提示 ----------

import { catMoveFrame } from './scene'

const PANE_PROPS = {
  plugin: 'pixel-office',
  surface: 'terminal',
  component: 'Pane',
  requestId: 'pixel-office',
  props: { title: '像素辦公室', isFocused: true, bodyColumns: 60, placement: 'dock', scroll: undefined, view: undefined },
  viewport: { columns: 140, rows: 46 },
} as any

test('buttons: promote toggles my role, night toggles its label, feeding the cat works', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  const ui = await $.ui.mount(PANE_PROPS)
  expect((await ui.find({ key: 'role' }))?.text).toBe('升為主管')
  await ui.press({ key: 'role' })
  expect(JSON.parse(writes[writes.length - 1]).role).toBe('manager')
  expect((await ui.find({ key: 'role' }))?.text).toBe('設為員工')

  expect((await ui.find({ key: 'night' }))?.text).toBe('夜間模式')
  await ui.press({ key: 'night' })
  expect((await ui.find({ key: 'night' }))?.text).toBe('開燈')

  await ui.press({ key: 'cat' })
  await ui.unmount()
})

test('night mode darkens the room but keeps screens lit', () => {
  const crew = [P('a', 'x', 'typing', true)]
  const lum = (px: Uint32Array) => px.reduce((s, c) => s + ((c >> 16) & 255) + ((c >> 8) & 255) + (c & 255), 0) / px.length
  const day = drawScene(crew, 3, 60, 40)
  const nightScene = drawScene(crew, 3, 60, 40, [], undefined, { night: true })
  expect(lum(nightScene.px)).toBeLessThan(lum(day.px) * 0.6)
  expect([...nightScene.px].some(c => c === 0x69f0ae || c === 0x2e7d32)).toBe(true) // 打字的綠色螢幕還亮著
})

test('a fed cat sits with a heart, then walks on from where it ate (no teleport)', () => {
  const fed = drawScene([], 50, 60, 40, [], undefined, { treatFrame: 45 })
  expect([...fed.px].some(c => c === 0xff4081)).toBe(true)
  const after = drawScene([], 80, 60, 40, [], undefined, { treatFrame: 45 })
  expect([...after.px].some(c => c === 0xff4081)).toBe(false)
  // 吃完的那一格，位置和吃飯開始時一樣
  expect(catMoveFrame(45 + 20, 45, 0)).toBe(catMoveFrame(45, 45, 0))
  expect(catMoveFrame(45 + 21, 45, 0)).toBe(catMoveFrame(45, 45, 0) + 1)
})

test('the system prompt gets one short pixel-office section', async ($, on) => {
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'base', scope: 'shared' }] }) as any)
  const out: any = await ($ as any).prompt.compose({ model: 'm', promptModel: 'm', surfaces: [], tools: [], outputStyle: null, traits: [] })
  const ids = out.sections.map((s: any) => s.id)
  expect(ids).toEqual(['intro', 'pixel-office:role'])
  expect(out.sections[1].text).toContain('office_profile')
})

// ---------- 紙飛機、等待核准 ----------

import { PLANE_FRAMES, planePos } from './scene'
import { findRecipient, waitsForApproval } from './register'

test('waiting for permission: raised hand, yellow ? and a yellow screen', () => {
  const s = drawScene([P('a', 'x', 'waiting', true)], 2, 60, 40)
  expect([...s.px].some(c => c === 0xffca28)).toBe(true)
})

test('a paper plane flies from sender to recipient along an arc, then lands', () => {
  const pl = { from: { x: 10, y: 40 }, to: { x: 40, y: 30 }, start: 100 }
  expect(planePos(pl, 99)).toBeNull()
  expect(planePos(pl, 100)).toMatchObject({ x: 10, y: 40 })
  const mid = planePos(pl, 100 + PLANE_FRAMES / 2)!
  expect(mid.x).toBe(25)
  expect(mid.y).toBeLessThan(35) // 拋物線：中途比直線高
  expect(planePos(pl, 100 + PLANE_FRAMES)).toMatchObject({ x: 40, y: 30 })
  expect(planePos(pl, 101 + PLANE_FRAMES)).toBeNull()
  const s = drawScene([], 100 + PLANE_FRAMES / 2, 60, 40, [], undefined, { planes: [pl] })
  expect([...s.px].some(c => c === 0xf1f8ff)).toBe(true)
})

test('recipients are found by their registered ListAgents name, with or without a [ref]', () => {
  const crew = [{ ...P('b', 'u30'), agent: 'user-30' }, { ...P('c', 'e2'), agent: 'llm-wiki-aegiverse-6a' }]
  expect(findRecipient(crew, 'user-30')?.id).toBe('b')
  expect(findRecipient(crew, 'llm-wiki-aegiverse-6a [a38cb7]')?.id).toBe('c')
  expect(findRecipient(crew, 'nobody')).toBeUndefined()
})

test('sending a message records who it went to', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  on('session.send', () => ({ isDelivered: true }) as any)
  await ($ as any).session.send({ to: 'user-30', text: 'hi' })
  const last = JSON.parse(writes[writes.length - 1])
  expect(last.sentTo).toBe('user-30')
  expect(typeof last.sentAt).toBe('number')
})

test('office_profile registers the ListAgents name (agent)', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  const out: any = await $.tool.call({ tool: 'mcp__pixel-office__office_profile', agent: 'user-30 [b11cf3]' } as any)
  expect(out.result).toContain('agent＝user-30')
  expect(JSON.parse(writes[writes.length - 1]).agent).toBe('user-30')
})

// 測試環境的 $.tool.call 不經過 tool.check（實測：只有 $.tool.check 查詢會觸發，且查詢不帶 tool_use_id），
// 所以這裡驗判斷函式；真實呼叫的切換要在 session 裡實測
test('only a real call judged ask counts as waiting for approval', () => {
  expect(waitsForApproval('ask', 'toolu_1')).toBe(true)
  expect(waitsForApproval('ask', undefined)).toBe(false) // $.tool.check 查詢
  expect(waitsForApproval('allow', 'toolu_1')).toBe(false)
  expect(waitsForApproval('deny', 'toolu_1')).toBe(false)
  // auto／bypass／dontAsk 模式的 ask 不等人：交給分類器或直接決定
  expect(waitsForApproval('ask', 'toolu_1', 'auto')).toBe(false)
  expect(waitsForApproval('ask', 'toolu_1', 'bypassPermissions')).toBe(false)
  expect(waitsForApproval('ask', 'toolu_1', 'default')).toBe(true)
  expect(waitsForApproval('ask', 'toolu_1', 'acceptEdits')).toBe(true)
})

test('another session starting to wait pops a toast here', async ($, on) => {
  const NOW = 1_000_000
  let mode = 'typing'
  const toasts: string[] = []
  on('env.get', () => ({ value: 'C:/Users/tester' }))
  on('clock.now', () => ({ value: NOW }))
  on('fs.write', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [{ name: 'b.json', kind: 'file', size: 1, mtimeMs: NOW, isLink: false }] }) as any)
  on('fs.read', () => ({ value: JSON.stringify({ id: 'b', name: 'u30', role: 'staff', mode, tool: 'Bash', updatedAt: NOW, left: false }) }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('ui.toast', (_$, e: any) => {
    toasts.push(String(e.text ?? e))
    return { value: undefined } as any
  })
  await $.command.run({ command: 'office', args: '' } as any) // 第一次看到 b：只記錄
  mode = 'waiting'
  await $.command.run({ command: 'office', args: '' } as any) // b 進入等待 → toast
  expect(toasts.some(t => t.includes('u30') && t.includes('核准'))).toBe(true)
})

// ---------- 0.3.0：職稱與名單 ----------

import { roster } from './register'

test('the roster lists manager first, with title, role, ListAgents name and what each is doing', () => {
  const crew: Coworker[] = [
    { ...P('a', 'IT', 'waiting', true), title: 'IT', agent: 'MODS 規則與設定', tool: 'Bash' },
    { ...P('b', '30', 'thinking', false, 'manager'), title: '協作主管', agent: 'user-30' },
    { ...P('c', 'LLM-Wiki-AEGIVERSE') },
  ]
  const text = roster(crew, 0)
  const lines = text.split('\n')
  expect(lines[0]).toContain('3 人在線')
  expect(lines[3]).toContain('30') // 主管排第一列
  expect(lines[3]).toContain('協作主管')
  expect(lines[3]).toContain('user-30')
  expect(text).toContain('▶ IT')
  expect(text).toContain('等待核准權限（Bash）')
  expect(text).toContain('未登記')
})

test('/office title sets a free-text title (Chinese ok) and /office who prints the roster', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  expect((await $.command.run({ command: 'office', args: 'title 系統管理' } as any)).text).toContain('職稱＝系統管理')
  expect(JSON.parse(writes[writes.length - 1]).title).toBe('系統管理')
  expect((await $.command.run({ command: 'office', args: 'title 這個職稱真的非常非常非常非常非常長喔' } as any)).text).toContain('太長')
  const who = (await $.command.run({ command: 'office', args: 'who' } as any)).text!
  expect(who).toContain('像素辦公室名單')
  expect(who).toContain('系統管理')
})

test('models can read the roster through office_roster', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  await $.tool.call({ tool: 'mcp__pixel-office__office_profile', title: 'IT', agent: 'MODS' } as any)
  const out: any = await $.tool.call({ tool: 'mcp__pixel-office__office_roster' } as any)
  expect(typeof out.result).toBe('string')
  expect(out.result).toContain('| IT |')
  expect(out.result).toContain('MODS')
})

test('the scene fills the pane height and leaves one reserved row above the buttons', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  const ui = await $.ui.mount({ ...PANE_PROPS, props: { ...PANE_PROPS.props, scroll: { offset: 0, bodyRows: 50 } } })
  const raster = await ui.find({ type: 'Raster', key: 'scene' })
  expect((raster!.props as any).rows).toBe(48)
  const tree: any = await ui.drawn()
  // Text 不保留 key，改看元素類型：辦公室 → 預留空白列 → 按鈕列
  expect(tree.children.map((c: any) => c.type)).toEqual(['Raster', 'Text', 'Box']) // 沒有個人按鈕：顯示提示
  expect((await ui.find({ type: 'Text', text: /buttons\.json/ }))?.text).toContain('個人按鈕')
  await ui.unmount()
})

test('at the minimum height the first cluster still clears the corridor (cat and copier)', () => {
  const L = layout(48, 44) // MIN_ROWS
  const lowest = Math.max(...L.seats.map(s => s.y + 12))
  expect(lowest).toBeLessThanOrEqual(L.h - 18) // 底部走廊 18 像素（家具＋貓走的道）
})

test('door signs: MANAGER beside the office door, MEETING beside the meeting room', () => {
  for (const w of [48, 60, 112]) {
    const text = cellText(encode(drawScene([], 0, w, 40)), w, 40)
    expect(text[11]).toContain('MANAGER')
    expect(text[11]).toContain('MEETING')
  }
})

test('/office auto on stops the raised hand; the roster marks auto sessions', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  expect((await $.command.run({ command: 'office', args: 'auto on' } as any)).text).toContain('auto')
  expect(JSON.parse(writes[writes.length - 1]).auto).toBe(true)
  expect((await $.command.run({ command: 'office', args: 'auto maybe' } as any)).text).toContain('用法')
  const who = (await $.command.run({ command: 'office', args: 'who' } as any)).text!
  expect(who).toContain('（auto）')
  expect((await $.command.run({ command: 'office', args: 'auto off' } as any)).text).toContain('會等人核准')
  expect(JSON.parse(writes[writes.length - 1]).auto).toBeUndefined()
})

test('the model can declare auto mode through office_profile', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  const out: any = await $.tool.call({ tool: 'mcp__pixel-office__office_profile', auto: true } as any)
  expect(out.result).toContain('模式＝auto')
  expect(JSON.parse(writes[writes.length - 1]).auto).toBe(true)
})

// ---------- 0.3.7：自動登記與名牌 ----------

import { plateFromAgent, selfFromListAgents } from './register'

test('plates are derived from the ListAgents name', () => {
  expect(plateFromAgent('llm-wiki-aegiverse-55')).toBe('55')
  expect(plateFromAgent('user-30')).toBe('30')
  expect(plateFromAgent('MODS 規則與設定')).toBe('MODS')
  expect(plateFromAgent('規則')).toBeUndefined()
})

test('the session name is read from ListAgents output', () => {
  const out = 'This session is llm-wiki-aegiverse-ff [957775] — the name other sessions use to message it.\n\nPeer sessions (3):'
  expect(selfFromListAgents(out)).toBe('llm-wiki-aegiverse-ff')
  expect(selfFromListAgents('MODS 規則與設定 [16e6c8]')).toBeUndefined()
  expect(selfFromListAgents('This session is MODS 規則與設定 [16e6c8] — x')).toBe('MODS 規則與設定')
})

test('registering an agent also sets a short plate when the plate is still the default', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  const out: any = await $.tool.call({ tool: 'mcp__pixel-office__office_profile', agent: 'llm-wiki-aegiverse-55' } as any)
  expect(out.result).toContain('名牌自動設為 55')
  expect(JSON.parse(writes[writes.length - 1]).name).toBe('55')
  // 自己設過名牌之後，再登記 agent 不會蓋掉
  await $.tool.call({ tool: 'mcp__pixel-office__office_profile', name: 'mine' } as any)
  await $.tool.call({ tool: 'mcp__pixel-office__office_profile', agent: 'llm-wiki-aegiverse-ff' } as any)
  expect(JSON.parse(writes[writes.length - 1]).name).toBe('mine')
})

test('running ListAgents registers the session automatically', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  on('tool.call', (_$, e) =>
    String(e.tool) === 'ListAgents'
      ? ({ result: 'ok', text: 'This session is llm-wiki-aegiverse-ff [957775] — the name other sessions use.' } as any)
      : undefined,
  )
  await $.tool.call({ tool: 'ListAgents' } as any)
  const last = JSON.parse(writes[writes.length - 1])
  expect(last.agent).toBe('llm-wiki-aegiverse-ff')
  expect(last.name).toBe('ff')
})

// ---------- 0.3.8：被分類器擋下、等使用者說放行 ----------

import { classifierBlocked } from './register'

const CLASSIFIER_MSG = 'Permission for this action was denied by the Claude Code auto mode classifier. Reason: [Unauthorized Persistence].'

test('a classifier denial is told apart from other errors', () => {
  expect(classifierBlocked({ deny: CLASSIFIER_MSG })).toBe(true)
  expect(classifierBlocked({ isError: true, text: CLASSIFIER_MSG })).toBe(true)
  expect(classifierBlocked({ isError: true, text: 'Exit code 1' })).toBe(false)
  expect(classifierBlocked({ deny: 'blocked by a deny rule Bash(git push --force*)' })).toBe(false)
  expect(classifierBlocked({ text: CLASSIFIER_MSG })).toBe(false) // 不是錯誤就不算
})

test('a blocked coworker raises a red card that stays while they keep working', () => {
  const crew = [{ ...P('a', 'ff', 'typing'), blocked: { tool: 'Write', at: 0 } }]
  const s = drawScene(crew, 2, 60, 40)
  const px = [...s.px]
  expect(px.some(c => c === 0xe53935)).toBe(true) // 紅牌
  expect(px.some(c => c === 0x69f0ae)).toBe(false) // 不畫成打字中的綠螢幕
})

test('the roster flags who needs a release and for how long', () => {
  const crew = [{ ...P('a', 'ff'), blocked: { tool: 'Write', at: 0 } }, P('b', '55')]
  const text = roster(crew, 5 * 60000)
  expect(text).toContain('🔴 待放行：ff')
  expect(text).toContain('被擋（Write），已等 5 分')
})

test('a classifier denial marks me blocked in the status file', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  on('tool.call', (_$, e) => (String(e.tool) === 'Write' ? ({ deny: CLASSIFIER_MSG } as any) : undefined))
  await $.tool.call({ tool: 'Write', file_path: 'x', content: 'y' } as any).catch(() => undefined)
  const last = JSON.parse(writes[writes.length - 1])
  expect(last.blocked.tool).toBe('Write')
})

// ---------- 0.4.0：個人按鈕 ----------

import { parseButtons } from './register'

test('personal buttons: only valid ones are kept (label 1-12, http(s) url or a prompt), at most 6', () => {
  const list = parseButtons([
    { label: '開工', prompt: '/llm-wiki:wiki-collab status' },
    { label: 'Superset', url: 'http://localhost:8088' },
    { label: '壞網址', url: 'file:///C:/secret' },
    { label: '', prompt: 'x' },
    { label: '這個標籤真的太長了超過十二', prompt: 'x' },
    { label: '空指令', prompt: '   ' },
    'nope',
  ])
  expect(list).toEqual([
    { label: '開工', prompt: '/llm-wiki:wiki-collab status' },
    { label: 'Superset', url: 'http://localhost:8088' },
  ])
  expect(parseButtons(Array.from({ length: 9 }, (_, i) => ({ label: `b${i}`, prompt: 'x' })))).toHaveLength(6)
  expect(parseButtons({ not: 'an array' })).toEqual([])
})

const BUTTONS_FILE = JSON.stringify([
  { label: '開工', prompt: '/llm-wiki:wiki-collab status' },
  { label: '說嗨', prompt: 'hi there' },
  { label: 'Superset', url: 'http://localhost:8088' },
])

test('the reserved row shows personal buttons; a slash prompt runs as a command, plain text is sent as my words', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  on('fs.read', () => ({ value: BUTTONS_FILE }))
  const ran: any[] = []
  const submitted: any[] = []
  on('command.run', (_$, e: any) => {
    if (e.command === 'office') return undefined as any
    ran.push(e)
    return { text: 'ok' } as any
  })
  on('prompt.submit', (_$, e: any) => {
    submitted.push(e)
    return { text: e.text } as any // prompt.submit 的回傳是 { text }
  })
  expect((await $.command.run({ command: 'office', args: 'buttons' } as any)).text).toContain('3 顆')
  const ui = await $.ui.mount({ ...PANE_PROPS, props: { ...PANE_PROPS.props, scroll: { offset: 0, bodyRows: 50 } } })
  const tree: any = await ui.drawn()
  expect(tree.children.map((c: any) => c.type)).toEqual(['Raster', 'Box', 'Box'])
  expect((await ui.find({ type: 'Link' }))?.props.href).toBe('http://localhost:8088')
  await ui.press({ key: 'mine-0' })
  expect(ran.some(e => e.command === 'llm-wiki:wiki-collab' && e.args === 'status')).toBe(true)
  await ui.press({ key: 'mine-1' })
  expect(submitted.some(e => e.text === 'hi there')).toBe(true)
  await ui.unmount()
})


// ---------- 0.5.0：peer 區 ----------

test('the manager\'s peers sit in the rightmost cluster; everyone else sits left', () => {
  const crew: Coworker[] = [
    { ...P('m', '30', 'idle', false, 'manager'), agent: 'user-30' },
    { ...P('p1', '55'), team: 'user-30' },
    { ...P('p2', 'ff'), team: 'user-30' },
    { ...P('o1', 'IT') },
    { ...P('o2', 'desk') },
  ]
  const L = layout(60, 40)
  expect(L.cols).toBe(2)
  const seats = assignSeats(crew, 60, 40)
  const rightX = L.clusters[1].x
  for (const id of ['p1', 'p2']) expect(seats.get(id)!.seat.x).toBeGreaterThanOrEqual(rightX)
  for (const id of ['o1', 'o2']) expect(seats.get(id)!.seat.x).toBeLessThan(rightX)
})

test('a team that matches no online manager does not count; more than 4 peers spill into the other area', () => {
  const ghost = [{ ...P('x', 'x'), team: 'nobody' }]
  const L = layout(60, 40)
  expect(assignSeats(ghost, 60, 40).get('x')!.seat.x).toBeLessThan(L.clusters[1].x)
  const boss: Coworker = { ...P('m', '30', 'idle', false, 'manager'), agent: 'user-30' }
  const peers = Array.from({ length: 6 }, (_, i) => ({ ...P(`p${i}`, `p${i}`), team: 'user-30' }))
  const seats = assignSeats([boss, ...peers], 60, 40)
  expect(peers.every(p => seats.has(p.id))).toBe(true) // 6 人都有位子
  expect(peers.filter(p => seats.get(p.id)!.seat.x >= L.clusters[1].x)).toHaveLength(4)
})

test('becoming a peer moves you to the peer area (and keeps your seat after that)', () => {
  const boss: Coworker = { ...P('m', '30', 'idle', false, 'manager'), agent: 'user-30' }
  const me = P('zz', 'IT')
  const before = assignSeats([boss, me], 60, 40)
  const after = assignSeats([boss, { ...me, team: 'user-30' }], 60, 40, before)
  expect(after.get('zz')!.slot).not.toBe(before.get('zz')!.slot)
  const again = assignSeats([boss, { ...me, team: 'user-30' }], 60, 40, after)
  expect(again.get('zz')!.slot).toBe(after.get('zz')!.slot)
})

test('/office team sets and clears the team; the roster shows it', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  expect((await $.command.run({ command: 'office', args: 'team user-30 [b0fe80]' } as any)).text).toContain('歸屬＝user-30')
  expect(JSON.parse(writes[writes.length - 1]).team).toBe('user-30')
  expect((await $.command.run({ command: 'office', args: 'who' } as any)).text).toContain('屬 user-30')
  expect((await $.command.run({ command: 'office', args: 'team off' } as any)).text).toContain('歸屬已清除')
  expect(JSON.parse(writes[writes.length - 1]).team).toBeUndefined()
})

test('walking between any two seats never enters a wall', () => {
  for (const [w, r] of [[48, 40], [60, 40], [112, 60]] as const) {
    const L = layout(w, r)
    const boss: Coworker = { ...P('m', '30', 'idle', false, 'manager'), agent: 'user-30' }
    const crew = [boss, ...L.seats.map((_, i) => P(`s${i}`, `s${i}`))]
    const placed = [...assignSeats(crew, w, r).values()]
    for (const a of placed) {
      for (const b of placed) {
        if (a === b) continue
        const path = route(a, b, w, r)
        for (let i = 0; i < path.length - 1; i++) {
          const p0 = path[i], p1 = path[i + 1]
          expect(p0.x === p1.x || p0.y === p1.y).toBe(true)
          for (const p of [p0, p1]) expect(p.x >= 2 + 3 && p.x <= w - 2 - 4).toBe(true) // 人寬 7，不碰左右外牆
        }
      }
    }
  }
})

// ---------- 0.5.1：peer 區地毯與門牌 ----------

test('the peer area gets a gold-edged rug and a TEAM sign only when a manager is online and there are two columns', () => {
  const boss: Coworker = { ...P('m', '30', 'idle', false, 'manager'), agent: 'user-30' }
  const has = (s: { px: Uint32Array }) => [...s.px].some(c => c === 0xeadfc8)
  const withBoss = drawScene([boss], 0, 60, 40)
  expect(has(withBoss)).toBe(true)
  expect(cellText(encode(withBoss), 60, 40).join('\n')).toContain('TEAM 30')
  expect(has(drawScene([P('a', 'x')], 0, 60, 40))).toBe(false) // 沒有主管
  expect(has(drawScene([boss], 0, 48, 40))).toBe(false) // 只排得下一欄
  // 地毯在右邊那一組
  const L = layout(60, 40)
  const rugXs = [...withBoss.px].map((c, i) => (c === 0xeadfc8 ? i % 60 : -1)).filter(x => x >= 0)
  expect(Math.min(...rugXs)).toBeGreaterThanOrEqual(L.clusters[1].x - 2)
})

// ---------- 0.5.4：熱重載後設定不遺失 ----------

import { mergeProfile } from './register'

test('reload keeps every profile field, team included (store wins, status file fills gaps)', () => {
  const own = { role: 'staff' as const, name: 'ff', agent: 'llm-wiki-aegiverse-ff', title: '待命', auto: true, team: 'user-30' }
  expect(mergeProfile(undefined, own)).toEqual(own)
  expect(mergeProfile({ name: 'mine' }, own)).toEqual({ ...own, name: 'mine' })
  expect(mergeProfile({ role: 'staff', name: 'ff', agent: 'a', title: 't', auto: true }, { team: 'user-30' })!.team).toBe('user-30')
  expect(mergeProfile(undefined, undefined)).toBeUndefined()
})

test('closed sessions are read once, then skipped until the one-minute recheck', async ($, on) => {
  let now = 10_000_000
  const reads: string[] = []
  on('env.get', () => ({ value: 'C:/Users/tester' }))
  on('clock.now', () => ({ value: now }))
  on('fs.write', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('fs.list', () => ({
    value: [
      { name: 'fresh.json', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
      { name: 'gone.json', kind: 'file', size: 1, mtimeMs: 0, isLink: false },
    ],
  }) as any)
  on('fs.read', (_$, e) => {
    reads.push(e.path)
    const gone = e.path.endsWith('gone.json')
    return { value: JSON.stringify({ id: gone ? 'g' : 'f', name: gone ? 'gone' : 'fresh', mode: 'idle', tool: '', updatedAt: now, left: gone }) }
  })
  const goneReads = () => reads.filter(p => p.endsWith('gone.json')).length
  for (let i = 0; i < 5; i++) {
    await $.command.run({ command: 'office', args: 'who' } as any)
    now += 1000
  }
  expect(goneReads()).toBe(1) // 5 次刷新只讀 1 次
  expect(reads.filter(p => p.endsWith('fresh.json')).length).toBe(5) // 活著的每次都讀
  now += 60_000
  await $.command.run({ command: 'office', args: 'who' } as any)
  expect(goneReads()).toBe(2) // 一分鐘後重新確認
})

import { OFFICE_DOOR_W, OFFICE_DOOR_X } from './scene'

test('walking into the manager office goes through the middle of the door, body fully inside the doorway', () => {
  for (const [w, r] of [[48, 40], [60, 44], [112, 60]] as const) {
    const me = P('zz', 'IT')
    const before = assignSeats([me], w, r)
    const after = assignSeats([{ ...me, role: 'manager' as const }], w, r, before)
    const path = route(before.get('zz')!, after.get('zz')!, w, r)
    const L = layout(w, r)
    const wallY = 2 + 20 // 上排房間與員工區之間的牆（WALL + TOP_H）
    const crossing = path.findIndex((p, i) => i > 0 && path[i - 1].x === p.x && (path[i - 1].y - wallY) * (p.y - wallY) < 0)
    expect(crossing).toBeGreaterThan(0)
    const x = path[crossing].x
    expect(x - 3).toBeGreaterThanOrEqual(L.officeX + OFFICE_DOOR_X)
    expect(x + 3).toBeLessThan(L.officeX + OFFICE_DOOR_X + OFFICE_DOOR_W)
  }
})

test('desktop: a promotion walks and a message flies a paper plane (layout is shared, not switched off)', async ($, on) => {
  const NOW = 2_000_000
  let other = { id: 'b', name: 'u79', role: 'staff', mode: 'idle', tool: '', agent: 'user-79', updatedAt: NOW, left: false } as any
  on('env.get', () => ({ value: 'C:/Users/tester' }))
  on('clock.now', () => ({ value: NOW }))
  on('fs.write', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('fs.list', () => ({ value: [{ name: 'b.json', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }) as any)
  on('fs.read', (_$, e) => ({ value: e.path.endsWith('b.json') ? JSON.stringify(other) : '[]' }))
  const DESK = {
    plugin: 'pixel-office', surface: 'desktop', component: 'Pane', requestId: 'pixel-office',
    props: { title: '像素辦公室', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 46 }, view: undefined },
  } as any
  const ui = await $.ui.mount(DESK)
  await $.command.run({ command: 'office', args: 'who' } as any) // 第一次看到 b：只記錄，不觸發
  await $.tool.call({ tool: 'mcp__pixel-office__office_profile', agent: 'me-agent' } as any) // 我登記 agent，b 才找得到我
  other = { ...other, sentTo: 'me-agent', sentAt: NOW } // b 傳訊息給我
  await $.command.run({ command: 'office', args: 'who' } as any)
  await ui.unmount()
  const ui2 = await $.ui.mount(DESK) // 重畫一次 Desktop
  const src = String((await ui2.find({ type: 'Svg' }))!.props.source)
  expect(src).toContain('#f1f8ff') // 紙飛機的顏色出現在 Desktop 的 SVG 裡
  await ui2.unmount()
})

// ---------- 0.7.0：對外動作的跑腿動畫 ----------

import { detectErrand } from './register'
import { errandRoute, errandSpot } from './scene'

test('outgoing actions are recognised: mail, file upload, git push', () => {
  expect(detectErrand('mcp__claude_ai_Gmail__send_message', {})).toBe('mail')
  expect(detectErrand('mcp__claude_ai_Gmail__create_draft', {})).toBe('mail')
  expect(detectErrand('mcp__claude_ai_Gmail__search_threads', {})).toBeUndefined()
  expect(detectErrand('mcp__claude_ai_Google_Drive__create_file', {})).toBe('file')
  expect(detectErrand('mcp__claude_ai_Notion__notion-update-page', {})).toBe('file')
  expect(detectErrand('mcp__claude_ai_Notion__notion-fetch', {})).toBeUndefined()
  expect(detectErrand('Bash', { command: 'cd repo && git push origin main' })).toBe('push')
  expect(detectErrand('PowerShell', { command: 'git -C x push' })).toBe('push')
  expect(detectErrand('Bash', { command: 'git status' })).toBeUndefined()
  expect(detectErrand('Read', { file_path: 'push.md' })).toBeUndefined()
})

test('errand routes go seat → furniture → seat along aisles, never into a wall', () => {
  for (const [w, r] of [[48, 40], [60, 44], [112, 60]] as const) {
    const crew = [{ ...P('m', '30', 'idle', false, 'manager'), agent: 'user-30' }, ...layout(w, r).seats.slice(0, 6).map((_, i) => P(`s${i}`, `s${i}`))]
    for (const pl of assignSeats(crew, w, r).values()) {
      for (const kind of ['mail', 'file', 'push'] as const) {
        const path = errandRoute(pl, kind, w, r)
        expect(path[0]).toEqual(pl.stand)
        expect(path[path.length - 1]).toEqual(pl.stand)
        expect(path).toContainEqual(errandSpot(kind, w, r))
        for (let i = 0; i < path.length - 1; i++) {
          expect(path[i].x === path[i + 1].x || path[i].y === path[i + 1].y).toBe(true)
          for (const p of [path[i], path[i + 1]]) expect(p.x >= 5 && p.x <= w - 6 && p.y >= 2 && p.y < r * 2 - 2).toBe(true)
        }
      }
    }
  }
})

test('a successful Gmail send records a mail errand; a failed one does not', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  on('tool.call', (_$, e) => {
    if (String(e.tool) === 'mcp__claude_ai_Gmail__send_message') return { result: 'sent' } as any
    if (String(e.tool) === 'mcp__claude_ai_Gmail__reply') return { result: 'boom', isError: true } as any
    return undefined
  })
  await $.tool.call({ tool: 'mcp__claude_ai_Gmail__reply' } as any).catch(() => undefined)
  expect(JSON.parse(writes[writes.length - 1]).errand).toBeUndefined()
  await $.tool.call({ tool: 'mcp__claude_ai_Gmail__send_message' } as any).catch(() => undefined)
  expect(JSON.parse(writes[writes.length - 1]).errand.kind).toBe('mail')
})

test('the office now has a filing cabinet and a mailbox', () => {
  const s = drawScene([], 0, 60, 44)
  expect([...s.px].some(c => c === 0x8d6e63)).toBe(true) // 檔案櫃
  expect([...s.px].some(c => c === 0xc62828)).toBe(true) // 郵筒
})

test('bottom-corridor furniture never overlaps (cabinet, mailbox, copier) at any width', () => {
  for (const w of [48, 60, 80, 112]) {
    const cab = [2 + 5, 2 + 5 + 5] // CABINET_X..+5
    const mb = [Math.floor(w / 2) - 7, Math.floor(w / 2) - 5]
    const cp = [w - 2 - 16, w - 2 - 16 + 7]
    const door = [Math.floor(w / 2) - 3, Math.floor(w / 2) + 2]
    const overlap = (a: number[], b: number[]) => a[0] <= b[1] && b[0] <= a[1]
    expect(overlap(cab, mb) || overlap(mb, cp) || overlap(cab, cp) || overlap(cab, door) || overlap(cp, door)).toBe(false)
  }
})

test('the cat walks above the furniture row, not over the cabinet, mailbox or copier', () => {
  for (const [w, r] of [[48, 44], [60, 44], [112, 60]] as const) {
    const h = r * 2
    const cat = new Set([0xffa726, 0xe65100, 0xffcc80, 0xfff3e0, 0xf48fb1])
    for (let f = 0; f < 120; f += 7) {
      const s = drawScene([], f, w, r)
      for (let x = 0; x < w; x++) for (let y = h - 2 - 8; y < h - 2; y++) expect(cat.has(s.px[y * w + x]) && s.px[y * w + x] !== 0xfff3e0).toBe(false)
    }
  }
})

// ---------- 0.7.3：撞號偵測 ----------

import { isCollision } from './register'

test('a status file freshly written by another instance of the same session id is a collision', () => {
  const now = 1_000_000
  expect(isCollision({ instance: 'B', updatedAt: now - 2000 }, 'A', now)).toBe(true)
  expect(isCollision({ instance: 'A', updatedAt: now - 2000 }, 'A', now)).toBe(false) // 自己寫的（含熱重載後）
  expect(isCollision({ instance: 'B', updatedAt: now - 60000 }, 'A', now)).toBe(false) // 舊檔
  expect(isCollision({ instance: 'B', updatedAt: now - 2000, left: true }, 'A', now)).toBe(false) // 已離開
  expect(isCollision({ updatedAt: now - 2000 }, 'A', now)).toBe(false) // 舊版沒有 instance
  expect(isCollision(undefined, 'A', now)).toBe(false)
})

test('every status file now carries this window\'s instance id', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  await $.command.run({ command: 'office', args: 'title x' } as any)
  expect(typeof JSON.parse(writes[writes.length - 1]).instance).toBe('string')
})

import { mock } from 'claude-code/testing'

test('the terminal pane animates: the 250 ms timer blits new frames while it is open', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('env.get', () => ({ value: 'C:/Users/tester' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.write', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('tool.register', () => ({ value: undefined }) as any)
  on('session.start', (_$: any, e: any) => e)
  on('session.id', () => ({ value: 'me' }) as any)
  on('session.cwd', () => ({ value: 'C:/work/hub' }) as any)
  mock.store(on)
  const blits: string[] = []
  on('ui.blit', (_$: any, e: any) => {
    blits.push(e.cells)
    return {} as any
  })
  await ($ as any).session.start({ cwd: 'C:/work/hub', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'office', args: '' } as any)
  const ui = await $.ui.mount(PANE_PROPS)
  await clock.advance(1000)
  expect(blits.length).toBeGreaterThanOrEqual(3)
  expect(new Set(blits).size).toBeGreaterThan(1) // 畫格真的在變（貓在走、時鐘在轉）
  await ui.unmount()
})

test('after /resume the window follows the new session id: old file marked left, new identity loaded', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  let sid = 'aaaa1111'
  const files: Record<string, string> = {
    'bbbb2222.json': JSON.stringify({ id: 'bbbb2222', name: 'boss', role: 'manager', title: 'lead', updatedAt: 0, left: true }),
  }
  on('env.get', () => ({ value: 'C:/Users/tester' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_$: any, e: any) => ({ value: files[e.path.split(/[\\/]/).pop() ?? ''] ?? '{}' }))
  on('fs.write', (_$: any, e: any) => {
    files[e.path.split(/[\\/]/).pop() ?? ''] = e.text
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined }) as any)
  on('tool.register', () => ({ value: undefined }) as any)
  on('session.start', (_$: any, e: any) => e)
  on('session.id', () => ({ value: sid }) as any)
  on('session.cwd', () => ({ value: 'C:/Users/user' }) as any)
  mock.store(on)
  await ($ as any).session.start({ cwd: 'C:/Users/user', surface: 'terminal', isInteractive: true })
  expect(JSON.parse(files['aaaa1111.json']).left).toBe(false)

  sid = 'bbbb2222' // /resume：同一個程序換到另一段對話
  await clock.advance(5000)
  expect(JSON.parse(files['aaaa1111.json']).left).toBe(true)
  const now = JSON.parse(files['bbbb2222.json'])
  expect(now.left).toBe(false)
  expect(now.name).toBe('boss')
  expect(now.role).toBe('manager')
})

// ---------- 放貓咬人 ----------

import { BITE_FRAMES, raidFrames, raidPath, raidPose } from './scene'

test('a released cat runs along the aisles to the prey, bites, then runs back home', () => {
  const crew = [P('boss', 'K', 'idle', true, 'manager'), P('a', 'aa'), P('b', 'bb')]
  for (const [w, r] of [[60, 46], [112, 80]] as const) {
    const placed = assignSeats(crew, w, r)
    for (const id of ['a', 'b']) {
      const pl = placed.get(id)!
      const path = raidPath(pl, w, r, 10)
      // 只走水平／垂直線段，終點在被咬的人右手邊
      for (let i = 0; i < path.length - 1; i++) expect(path[i].x === path[i + 1].x || path[i].y === path[i + 1].y).toBe(true)
      const end = path[path.length - 1]
      expect(end.x - pl.stand.x).toBe(6)
      expect(Math.abs(end.y - pl.stand.y)).toBeLessThan(8)
      const total = raidFrames(path)
      const run = (total - BITE_FRAMES) / 2
      expect(raidPose(path, 10, 9)).toBe(null)
      expect(raidPose(path, 10, 10 + run)?.biting).toBe(true)
      expect(raidPose(path, 10, 10 + run + BITE_FRAMES - 1)?.biting).toBe(true)
      const home = raidPose(path, 10, 10 + total - 1)!
      expect(home.biting).toBe(false)
      expect(Math.abs(home.at.x - path[0].x) + Math.abs(home.at.y - path[0].y)).toBeLessThanOrEqual(6)
      expect(raidPose(path, 10, 10 + total)).toBe(null)
    }
  }
})

test('while biting, the prey shakes with a red mark and the boss cannot be the prey', () => {
  const crew = [P('boss', 'K', 'idle', true, 'manager'), P('a', 'aa')]
  const w = 60
  const r = 46
  const placed = assignSeats(crew, w, r)
  const path = raidPath(placed.get('a')!, w, r, 0)
  const run = (raidFrames(path) - BITE_FRAMES) / 2
  const f = run % 2 ? run : run + 1 // 咬的那幾格裡的奇數格（咬痕一格有、一格沒有）
  const red = (px: Uint32Array) => [...px].filter(c => c === 0xe53935).length
  const bitten = drawScene(crew, f, w, r, [], placed, { raid: { targetId: 'a', start: 0 } })
  const calm = drawScene(crew, f, w, r, [], placed)
  expect(red(bitten.px)).toBeGreaterThan(red(calm.px))
  // 指到主管：不放貓，畫面跟平常一樣
  const boss = drawScene(crew, f, w, r, [], placed, { raid: { targetId: 'boss', start: 0 } })
  expect([...boss.px]).toEqual([...calm.px])
})

test('the release button and /office bite: needs the pane first, then sends the cat', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  const ui = await $.ui.mount(PANE_PROPS)
  expect((await ui.find({ key: 'bite' }))?.text).toBe('放貓')
  await ui.press({ key: 'bite' }) // 只有自己（員工）：咬自己
  const again = await $.command.run({ command: 'office', args: 'bite' } as any)
  expect(String((again as any).text)).toContain('貓還在外面')
  await ui.unmount()
})
