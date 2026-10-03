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

test('floor plan: one cluster of 4 at the narrowest, two side by side from 56 columns, more rows when taller', () => {
  expect(layout(48, 32).seats).toHaveLength(4)
  expect(layout(60, 32).seats).toHaveLength(8)
  expect(layout(60, 47).seats).toHaveLength(16)
  expect(sceneRows(undefined)).toBe(32)
  expect(sceneRows(20)).toBe(32)
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
