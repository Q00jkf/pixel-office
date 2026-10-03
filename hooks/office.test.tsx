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
  expect(layout(60, 58).seats).toHaveLength(16)
  expect(sceneRows(undefined)).toBe(40)
  expect(sceneRows(20)).toBe(40)
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

test('top-down cat: four distinct walking frames, stays in the corridor', () => {
  const frames = [0, 1, 2, 3].map(catWalkRows)
  expect(new Set(frames.map(f => f.join('|'))).size).toBe(4)
  for (const f of frames) expect(f).toHaveLength(5)
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

test('desktop gets a text fallback with the head count', async $ => {
  const ui = await $.ui.mount({
    plugin: 'pixel-office',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'pixel-office',
    props: { title: '像素辦公室', isFocused: false, bodyColumns: 48, placement: 'dock', scroll: undefined, view: undefined },
  } as any)
  expect(await ui.find({ type: 'Text', text: /人在線/ })).toBeDefined()
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
  expect(tree.children.map((c: any) => c.type)).toEqual(['Raster', 'Text', 'Box']) // 沒有個人按鈕：空一列
  await ui.unmount()
})

test('at the minimum height the first cluster still clears the corridor (cat and copier)', () => {
  const L = layout(48, 40)
  const lowest = Math.max(...L.seats.map(s => s.y + 12))
  expect(lowest).toBeLessThanOrEqual(L.h - 10) // 底部走廊 10 像素
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
