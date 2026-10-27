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

test('a manager who finds no desk is counted as +N on the boss plate, not seated among staff (0.12.0)', () => {
  const crew = [P('m1', 'boss', 'idle', false, 'manager'), P('m2', 'vice', 'idle', false, 'manager')]
  const lines = cellText(encode(drawScene(crew, 0, 48, 32)), 48, 32)
  const text = lines.join('\n')
  expect(text).toContain('+1*boss') // 48 寬主管室只放得下一張桌
  expect(text).not.toContain('vice')
  expect(lines[0]).not.toContain('+1') // 左上角的 +N 不重複算
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
  expect(src).toContain('Microsoft JhengHei') // 0.14.0 起 Desktop 畫向量（vector.ts），不是點陣
  expect(String(svg!.props.alt)).toContain('人在線')
  for (const key of ['night', 'hit-pet', 'hit-printer', 'hit-corgi']) expect(await ui.find({ key })).toBeDefined()
  expect(await ui.find({ key: 'role' })).toBeUndefined() // 0.16.0 拿掉升為主管按鈕
  await ui.unmount()
})

test('desktop keeps a text line for the head count (old behaviour)', async ($, on) => {
  on('clock.now', () => ({ value: 1_000_000 })) // 0.15.0 起 Desktop 畫牆上時鐘要讀時間
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

import { assignSeats, isAttendee, route, walkerPos } from './scene'

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


test('meeting: idle peers walk into the meeting room, busy ones stay until done, everyone returns after', () => {
  const boss = { ...P('boss', 'Jay', 'idle', false, 'manager'), agent: 'Office' }
  const idle = { ...P('alpha', 'a'), team: 'Office' }
  const busy = { ...P('bravo', 'b', 'typing'), team: 'Office' }
  const other = P('charlie', 'c') // 不屬於 Team，不進會議室
  const crew = [boss, idle, busy, other]
  const before = assignSeats(crew, 112, 50)
  const m1 = assignSeats(crew, 112, 50, before, true)
  expect(m1.get('alpha')!.kind).toBe('meet')
  expect(m1.get('bravo')!.kind).toBe('staff')
  expect(m1.get('charlie')!.kind).toBe('staff')
  expect(m1.get('boss')!.kind).toBe('boss')
  // bravo 做完進來；alpha 開會中被叫去回話（變忙）也不起身、不換位
  const m2 = assignSeats([boss, { ...idle, mode: 'thinking' as const }, { ...busy, mode: 'idle' as const }, other], 112, 50, m1, true)
  expect(m2.get('alpha')).toEqual(m1.get('alpha'))
  expect(m2.get('bravo')!.kind).toBe('meet')
  expect(m2.get('bravo')!.slot).not.toBe(m2.get('alpha')!.slot)
  // 散會：回到原本的位子，路線從會議室走出來
  const after = assignSeats(crew, 112, 50, m2)
  expect(after.get('alpha')!.seat).toEqual(before.get('alpha')!.seat)
  const path = route(m2.get('alpha')!, after.get('alpha')!, 112, 50)
  expect(path[0]).toEqual(m2.get('alpha')!.stand)
  for (let i = 0; i < path.length - 1; i++) expect(path[i].x === path[i + 1].x || path[i].y === path[i + 1].y).toBe(true)
  expect(encode(drawScene(crew, 1, 112, 50, [], m2, { meeting: true }))).toBeTruthy()
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

test('buttons: no promote or pet buttons below (role is /office role, pets are clicked), night toggles its label, feeding the cat works', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  const ui = await $.ui.mount(PANE_PROPS)
  for (const key of ['role', 'cat', 'bite', 'pet']) expect(await ui.find({ key })).toBeUndefined()

  expect((await ui.find({ key: 'night' }))?.text).toBe('夜間模式')
  await ui.press({ key: 'night' })
  expect((await ui.find({ key: 'night' }))?.text).toBe('開燈')

  await ui.press({ key: 'hit-pet' })
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
  expect(text).toContain('🟡 等核准（Bash）') // 0.11.0：等核准與等輸入分開；沒有 since 就不報秒數
  expect(text).toContain('未登記')
})

test('the roster carries each ref, so two sessions sharing a ListAgents name can still be addressed', () => {
  const crew: Coworker[] = [
    { ...P('a', 'IT', 'idle', true), agent: 'wiki-e4', ref: '180a9b' },
    { ...P('b', 'B'), agent: 'wiki-e4', ref: '019e4b' },
    { ...P('c', 'C'), agent: 'solo', ref: 'aa11bb' },
  ]
  const text = roster(crew, 0)
  expect(text).toContain('| ref |') // 表頭多一欄
  expect(text).toContain('180a9b')
  expect(text).toContain('aa11bb')
  // 撞名：直接給可貼的定址字串，不用再跑一次 ListAgents
  expect(text).toContain('🔴 撞名')
  expect(text).toContain('wiki-e4 [180a9b]')
  expect(text).toContain('wiki-e4 [019e4b]')
  expect(text).not.toContain('solo [aa11bb]') // 沒撞名的不唱名
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
  expect(tree.children.map((c: any) => c.type)).toEqual(['Box', 'Text', 'Box']) // 辦公室（Raster＋疊上去的按鈕）→ 沒有個人按鈕：顯示提示 → 按鈕列
  expect(tree.children[0].children[0].type).toBe('Raster')
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

test('the session name and its ref are read from ListAgents output', () => {
  const out = 'This session is llm-wiki-aegiverse-ff [957775] — the name other sessions use to message it.\n\nPeer sessions (3):'
  expect(selfFromListAgents(out)).toEqual({ name: 'llm-wiki-aegiverse-ff', ref: '957775' })
  expect(selfFromListAgents('MODS 規則與設定 [16e6c8]')).toBeUndefined()
  expect(selfFromListAgents('This session is MODS 規則與設定 [16e6c8] — x')).toEqual({ name: 'MODS 規則與設定', ref: '16e6c8' })
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
  expect(last.ref).toBe('957775') // 撞名時定址要用，自動抓不用模型配合
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
  expect(tree.children.map((c: any) => c.type)).toEqual(['Box', 'Box', 'Box'])
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
    return { value: undefined } as any
  })
  await ($ as any).session.start({ cwd: 'C:/work/hub', surface: 'terminal', isInteractive: true })
  await $.command.run({ command: 'office', args: 'approve on' } as any)
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
  // 鍵用「資料夾/檔名」：approvals/、decisions/ 與 sessions/ 同檔名
  const files: Record<string, string> = {
    'sessions/bbbb2222.json': JSON.stringify({ id: 'bbbb2222', name: 'boss', role: 'manager', title: 'lead', updatedAt: 0, left: true }),
  }
  on('env.get', () => ({ value: 'C:/Users/tester' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_$: any, e: any) => ({ value: files[e.path.split(/[\\/]/).slice(-2).join('/')] ?? '{}' }))
  on('fs.write', (_$: any, e: any) => {
    files[e.path.split(/[\\/]/).slice(-2).join('/')] = e.text
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined }) as any)
  on('tool.register', () => ({ value: undefined }) as any)
  on('session.start', (_$: any, e: any) => e)
  on('session.id', () => ({ value: sid }) as any)
  on('session.cwd', () => ({ value: 'C:/Users/user' }) as any)
  mock.store(on)
  await ($ as any).session.start({ cwd: 'C:/Users/user', surface: 'terminal', isInteractive: true })
  expect(JSON.parse(files['sessions/aaaa1111.json']).left).toBe(false)

  sid = 'bbbb2222' // /resume：同一個程序換到另一段對話
  await clock.advance(5000)
  expect(JSON.parse(files['sessions/aaaa1111.json']).left).toBe(true)
  const now = JSON.parse(files['sessions/bbbb2222.json'])
  expect(now.left).toBe(false)
  expect(now.name).toBe('boss')
  expect(now.role).toBe('manager')
})

// ---------- 放貓咬人 ----------

import { BITE_FRAMES, birdHopRows, raidFrames, raidPath, raidPose } from './scene'

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

test('/office bite needs the pane first, then sends the cat; a second one says it is still out', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  expect(String(((await $.command.run({ command: 'office', args: 'bite' } as any)) as any).text)).toContain('先輸入 /office')
  const ui = await $.ui.mount(PANE_PROPS)
  await $.command.run({ command: 'office', args: 'bite' } as any) // 只有自己（員工）：咬自己
  const again = await $.command.run({ command: 'office', args: 'bite' } as any)
  expect(String((again as any).text)).toContain('貓還在外面')
  await ui.unmount()
})

test('the released cat takes the nearest aisle: never above the target row, at most two turns before the last step', () => {
  const crew = [P('boss', 'K', 'idle', true, 'manager'), ...'abcdefgh'.split('').map(c => P(c, c + c))]
  const placed = assignSeats(crew, 112, 60)
  for (const [id, pl] of placed) {
    if (pl.kind !== 'staff') continue
    const path = raidPath(pl, 112, 60, 0)
    expect(path).toHaveLength(5)
    const highest = Math.min(...path.map(p => p.y))
    expect(highest).toBeGreaterThanOrEqual(pl.cluster.y - 4) // 不再爬到最上面的大走道
    expect(path[1].y).toBe(path[0].y) // 先沿走廊橫走，起點跟散步的貓同一列
    void id
  }
})

// ---------- 小寶寶 ----------

test('the baby replaces the cat in the drawing: baby colours instead of orange, hugs with hearts instead of red bites', () => {
  const crew = [P('boss', 'K', 'idle', true, 'manager'), P('a', 'aa', 'typing')]
  const w = 60
  const r = 46
  const placed = assignSeats(crew, w, r)
  const count = (px: Uint32Array, c: number) => [...px].filter(x => x === c).length
  const ORANGE = 0xffa726
  const SUIT = 0x81d4fa
  const cat = drawScene(crew, 1, w, r, [], placed).px
  const baby = drawScene(crew, 1, w, r, [], placed, { pet: 'baby' }).px
  expect(count(cat, ORANGE)).toBeGreaterThan(0)
  expect(count(baby, ORANGE)).toBe(0)
  expect(count(baby, SUIT)).toBeGreaterThan(count(cat, SUIT))
  // 抱大腿：沒有紅色咬痕，有愛心
  const path = raidPath(placed.get('a')!, w, r, 0)
  const run = (raidFrames(path) - BITE_FRAMES) / 2
  const f = run % 2 ? run : run + 1
  const hug = drawScene(crew, f, w, r, [], placed, { pet: 'baby', raid: { targetId: 'a', start: 0 } }).px
  const bite = drawScene(crew, f, w, r, [], placed, { raid: { targetId: 'a', start: 0 } }).px
  expect(count(hug, 0xe53935)).toBeLessThan(count(bite, 0xe53935))
  expect(count(hug, 0xff4081)).toBeGreaterThan(0)
})

test('/office pet switches cat, baby and bird in order and remembers the choice', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  const kept: Record<string, unknown> = {}
  on('store.get', (_$: any, e: any) => ({ value: kept[e.key] }) as any)
  on('store.set', (_$: any, e: any) => {
    kept[e.key] = e.value
    return { value: undefined } as any
  })
  const ui = await $.ui.mount(PANE_PROPS)
  const r1 = await $.command.run({ command: 'office', args: 'pet' } as any)
  expect(String((r1 as any).text)).toContain('小寶寶')
  expect(kept.pet).toBe('baby')
  const r2 = await $.command.run({ command: 'office', args: 'pet' } as any)
  expect(String((r2 as any).text)).toContain('山雀') // 依序：貓 → 寶寶 → 山雀 → 貓
  expect(kept.pet).toBe('bird')
  await $.command.run({ command: 'office', args: 'pet 銀喉長尾山雀' } as any)
  expect(kept.pet).toBe('bird')
  await $.command.run({ command: 'office', args: 'pet cat' } as any)
  expect(kept.pet).toBe('cat')
  const bad = await $.command.run({ command: 'office', args: 'pet dog' } as any)
  expect(String((bad as any).text)).toContain('用法')
  await ui.unmount()
})

// ---------- 會議：參與者名單（不限 team） ----------

test('with a participant list, exactly those people go in, team or not; refs and case are ignored', () => {
  const boss = { ...P('boss', 'Jay', 'idle', false, 'manager'), agent: 'Office' }
  const peer = { ...P('alpha', 'a'), team: 'Office', agent: 'llm-a' }
  const outsider = { ...P('charlie', 'c'), agent: 'finance-c' } // 不是 team
  const other = { ...P('delta', 'd'), team: 'Office', agent: 'llm-d' } // team 但沒被點名
  const crew = [boss, peer, outsider, other]
  const m = assignSeats(crew, 112, 50, undefined, true, ['LLM-A', 'finance-c [3fa9c1]'])
  expect(m.get('alpha')!.kind).toBe('meet')
  expect(m.get('charlie')!.kind).toBe('meet')
  expect(m.get('delta')!.kind).toBe('staff')
  expect(m.get('boss')!.kind).toBe('boss')
  // 沒給名單：維持原本的行為（主管的 peer）
  const old = assignSeats(crew, 112, 50, undefined, true)
  expect(old.get('delta')!.kind).toBe('meet')
  expect(old.get('charlie')!.kind).toBe('staff')
})

// 2026-10-08：實際狀態檔裡有兩個 session 的 agent 都是 llm-wiki-aegiverse-e4、兩個名牌都是 IT、
// 四個沒登記 agent 的名牌都是 user —— 點名時 agent/name 都不唯一，該進的沒進、不該進的進去。
test('a participant named with [ref] matches only that session, and stray spaces still match', () => {
  const a = { ...P('a', 'e4'), agent: 'wiki-e4', ref: '180a9b' }
  const b = { ...P('b', 'e4b'), agent: 'wiki-e4', ref: '019e4b' }
  const noRef = { ...P('c', 'c'), agent: 'wiki-e4' } // 還沒登記 ref 的舊 session
  expect(isAttendee(['wiki-e4 [180a9b]'])(a)).toBe(true)
  expect(isAttendee(['wiki-e4 [180a9b]'])(b)).toBe(false) // ← 撞名時不再誤抓
  expect(isAttendee(['wiki-e4 [180a9b]'])(noRef)).toBe(true) // 沒登記 ref 的人不能因此被排除
  expect(isAttendee(['wiki-e4'])(a) && isAttendee(['wiki-e4'])(b)).toBe(true) // 沒帶 ref：維持舊行為
  expect(isAttendee(['180a9b'])(a)).toBe(true) // 直接用 ref 點名
  expect(isAttendee(['  wiki-e4  ', ' E4B '])(a)).toBe(true) // 前後空白不該讓人進不去
  expect(isAttendee([' E4B '])(b)).toBe(true)
})

test('office_meeting writes meeting.json with topic and participants, and end clears it', async ($, on) => {
  const files: Record<string, string> = {}
  on('env.get', () => ({ value: 'C:/Users/tester' }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_$: any, e: any) => ({ value: files[e.path.split(/[\\/]/).pop() ?? ''] ?? '{}' }))
  on('fs.write', (_$: any, e: any) => {
    files[e.path.split(/[\\/]/).pop() ?? ''] = e.text
    return { value: undefined }
  })
  const started: any = await $.tool.call({ tool: 'mcp__pixel-office__office_meeting', action: 'start', topic: '請購流程', participants: ['llm-a', 'finance-c'], minutes: 30 } as any)
  const m = JSON.parse(files['meeting.json'])
  expect(m.participants).toEqual(['llm-a', 'finance-c'])
  expect(m.topic).toBe('請購流程')
  expect(m.until).toBe(1_000_000 + 30 * 60000)
  expect(JSON.stringify(started)).toContain('走進會議室')
  const none: any = await $.tool.call({ tool: 'mcp__pixel-office__office_meeting', action: 'start', participants: [] } as any)
  expect(JSON.stringify(none)).toContain('participants')
  // 不帶 minutes：不設期限
  await $.tool.call({ tool: 'mcp__pixel-office__office_meeting', action: 'start', participants: ['llm-a'] } as any)
  expect(JSON.parse(files['meeting.json']).until).toBe(Number.MAX_SAFE_INTEGER)
  await $.tool.call({ tool: 'mcp__pixel-office__office_meeting', action: 'end' } as any)
  expect(JSON.parse(files['meeting.json']).until).toBe(0)
})

test('an open-ended meeting ends by itself when none of the participants is online', async ($, on) => {
  const files: Record<string, string> = { 'meeting.json': JSON.stringify({ until: Number.MAX_SAFE_INTEGER, topic: 't', participants: ['ghost'] }) }
  on('env.get', () => ({ value: 'C:/Users/tester' }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_$: any, e: any) => ({ value: files[e.path.split(/[\\/]/).pop() ?? ''] ?? '{}' }))
  on('fs.write', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  await $.command.run({ command: 'office', args: '' } as any) // 開面板時會 refresh 一次，讀到 meeting.json
  const r: any = await $.command.run({ command: 'office', args: 'meeting' } as any)
  expect(String(r.text)).toContain('目前沒有開會')
  // 對照：參與者有人在線（自己，名牌預設 me）→ 開會中
  files['meeting.json'] = JSON.stringify({ until: Number.MAX_SAFE_INTEGER, topic: 't', participants: ['ghost', 'me'] })
  await $.command.run({ command: 'office', args: '' } as any)
  const on2: any = await $.command.run({ command: 'office', args: 'meeting' } as any)
  expect(String(on2.text)).toContain('開會中')
})

test('the silver-throated bushtit: its own colours, hops on the ground, flies straight to the person and sings with notes', () => {
  const crew = [P('boss', 'K', 'idle', true, 'manager'), P('a', 'aa', 'typing')]
  const w = 60
  const r = 46
  const placed = assignSeats(crew, w, r)
  const count = (px: Uint32Array, c: number) => [...px].filter(x => x === c).length
  const WHITE = 0xfdfdfd
  const NOTE = 0x3949ab
  const ORANGE = 0xffa726
  const bird = drawScene(crew, 1, w, r, [], placed, { pet: 'bird' }).px
  expect(count(bird, WHITE)).toBeGreaterThan(20) // 雪球般全白
  expect(count(bird, ORANGE)).toBe(0)
  // 🔴 畫出來的像素才算數：跳躍不該讓鳥少掉任何一個白點。
  // 2026-10-09 使用者截圖「跳起來頭還是被切掉」—— 結構測試全綠，所以要在渲染層再驗一次。
  const whiteByFrame = [0, 1, 2, 3, 4, 5, 6, 7].map(f =>
    count(drawScene(crew, f, w, r, [], placed, { pet: 'bird' }).px, WHITE),
  )
  expect(new Set(whiteByFrame).size).toBe(1) // 每一格的白色像素數都一樣＝整隻鳥都在，只是位置不同
  // 跳著走：四格裡有離地的格（最底下那一列是空的＝腳離地）
  const bottom = (step: number) => birdHopRows(step)[birdHopRows(step).length - 1]
  expect(bottom(0)).toContain('K')
  expect(bottom(2)).toBe('.'.repeat(12))
  // 跳起來時整隻鳥往上移，不是把頭裁掉：每一格的身體列數都一樣，頂端只是位置變了
  const ink = (rows: string[]) => rows.filter(r => r.replace(/\./g, '').length > 0)
  const base = ink(birdHopRows(0))
  for (const step of [1, 2, 3]) expect(ink(birdHopRows(step))).toEqual(base)
  const top = (step: number) => birdHopRows(step).findIndex(r => r.replace(/\./g, '').length > 0)
  expect(top(2)).toBe(top(0) - 2) // 跳最高那一格，整體上移 2 像素
  expect(top(1)).toBe(top(0) - 1)
  // 會飛：去程只有起點與終點兩點（直線），終點一樣在人的右手邊
  const pl = placed.get('a')!
  const path = raidPath(pl, w, r, 0, undefined, 0, 'bird')
  expect(path).toHaveLength(2)
  expect(path[1].x - pl.stand.x).toBe(6)
  // 停下來唱歌：有音符、沒有紅色咬痕，被找的人不會冒紅
  const run = (raidFrames(path) - BITE_FRAMES) / 2
  const f = run % 2 ? run : run + 1
  const sing = drawScene(crew, f, w, r, [], placed, { pet: 'bird', raid: { targetId: 'a', start: 0 } }).px
  const calm = drawScene(crew, f, w, r, [], placed, { pet: 'bird' }).px
  expect(count(sing, NOTE)).toBeGreaterThan(0)
  expect(count(calm, NOTE)).toBe(0)
  expect(count(sing, 0xe53935)).toBe(count(calm, 0xe53935)) // 沒有咬痕、被找的人不冒紅
})

// ---------- 0.11.0：狀態細分、title 自動帶、回信位址 ----------

import { autoTitleDue, isUserPrompt, promptHead, summarizeError, titleStale } from './register'

const MIN = 60000

test('the roster tells waiting-for-approval (with seconds) from waiting-for-input', () => {
  const NOW = 10 * MIN
  const crew: Coworker[] = [
    { ...P('a', 'w', 'waiting'), tool: 'Bash', since: NOW - 42000 },
    { ...P('b', 'i', 'idle'), since: NOW - 5 * MIN },
    { ...P('c', 'd', 'done'), since: NOW - 1000 },
    { ...P('e', 'fresh', 'idle'), since: NOW - 5000 },
  ]
  const text = roster(crew, NOW)
  expect(text).toContain('🟡 等核准 42 秒（Bash）')
  expect(text).toContain('| 等輸入（5 分） |')
  expect(text).toContain('剛完成，等輸入')
  expect(text).toContain('| 等輸入 |') // 不到 1 分鐘不報分鐘數
})

test('an error keeps a one-line summary of at most 80 characters, shown in the roster for 10 minutes', () => {
  expect(summarizeError('\n  Exit code 1\n  stack...')).toBe('Exit code 1')
  expect(summarizeError('a   b\tc')).toBe('a b c')
  expect([...summarizeError('錯'.repeat(100))]).toHaveLength(80)
  const NOW = 20 * MIN
  const err = { text: 'Exit code 1', at: NOW - 2 * MIN }
  expect(roster([{ ...P('a', 'x', 'error'), tool: 'Bash', lastError: err }], NOW)).toContain('出錯（Bash）：Exit code 1')
  expect(roster([{ ...P('a', 'x', 'thinking'), lastError: err }], NOW)).toContain('思考中・上次出錯 2 分前：Exit code 1')
  expect(roster([{ ...P('a', 'x', 'thinking'), lastError: { ...err, at: 0 } }], NOW)).not.toContain('上次出錯')
})

test('a failing tool writes its error summary and the mode start time to the status file', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  on('tool.call', (_$, e) => (String(e.tool) === 'Bash' ? ({ result: 'x', isError: true, text: 'Exit code 2\nfatal: not a git repository' } as any) : undefined))
  await $.tool.call({ tool: 'Bash', command: 'git status' } as any).catch(() => undefined)
  const last = JSON.parse(writes[writes.length - 1])
  expect(last.mode).toBe('error')
  expect(last.lastError.text).toBe('Exit code 2')
  expect(typeof last.since).toBe('number')
})

test('auto titles: only the user\'s own prompts count; slash commands and blanks give no title', () => {
  expect(isUserPrompt('composer')).toBe(true)
  expect(isUserPrompt('bridge')).toBe(true)
  expect(isUserPrompt('peer')).toBe(false)
  expect(isUserPrompt('task-notification')).toBe(false)
  expect(promptHead('  幫我把請購單\n整理成表格，然後寄給採購部門的同事')).toBe('幫我把請購單 整理成表格，然後寄')
  expect(promptHead('/office who')).toBeUndefined()
  expect(promptHead('   ')).toBeUndefined()
})

test('an empty or stale automatic title is replaced; a manual one never is', () => {
  const NOW = 100 * MIN
  expect(autoTitleDue({}, NOW)).toBe(true)
  expect(autoTitleDue({ title: '請購單', titleAuto: true, titleAt: NOW - 10 * MIN }, NOW)).toBe(false)
  expect(autoTitleDue({ title: '請購單', titleAuto: true, titleAt: NOW - 31 * MIN }, NOW)).toBe(true)
  expect(autoTitleDue({ title: '協作主管', titleAt: NOW - 90 * MIN }, NOW)).toBe(false) // 手動設的永遠不蓋
})

test('the roster marks automatic titles, and flags a stale manual title with the latest prompt', () => {
  const NOW = 100 * MIN
  const auto = { ...P('a', 'a'), title: '幫我把請購單', titleAuto: true, titleAt: NOW }
  const fresh = { ...P('b', 'b'), title: 'FOG 論文', titleAt: NOW - 40 * MIN, prompt: { text: '查一下陀螺儀', at: NOW - 35 * MIN } } // 設完 5 分鐘內的指令不算
  const stale = { ...P('c', 'c'), title: '請購單', titleAt: NOW - 40 * MIN, prompt: { text: '改辦公室的貓', at: NOW - MIN } }
  expect(titleStale(fresh)).toBe(false)
  expect(titleStale(stale)).toBe(true)
  const text = roster([auto, fresh, stale], NOW)
  expect(text).toContain('| 幫我把請購單 (自動) |')
  expect(text).toContain('| FOG 論文 |')
  expect(text).toContain('| 請購單（40 分前設） |')
  expect(text).toContain('・最新指令「改辦公室的貓」')
})

test('/office title is manual: it records when it was set and is not marked automatic', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  await $.command.run({ command: 'office', args: 'title 系統管理' } as any)
  const last = JSON.parse(writes[writes.length - 1])
  expect(last.titleAuto).toBeUndefined()
  expect(last.titleAt).toBe(1_000_000)
})

test('each session publishes its own reply address; the roster offers it when there is no ListAgents name', async ($, on) => {
  const writes: string[] = []
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'CLAUDE_CODE_MESSAGING_SOCKET' ? '/tmp/cc-msg-abc' : 'C:/Users/tester' }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('fs.list', () => ({ value: [] }))
  on('fs.write', (_$: any, e: any) => {
    writes.push(e.text)
    return { value: undefined }
  })
  await $.command.run({ command: 'office', args: 'title x' } as any)
  expect(JSON.parse(writes[writes.length - 1]).addr).toBe('uds:/tmp/cc-msg-abc')

  const crew: Coworker[] = [{ ...P('a', 'nameless'), addr: 'uds:/tmp/cc-msg-abc' }, { ...P('b', 'named'), agent: 'user-30', addr: 'uds:x' }, P('c', 'old')]
  const text = roster(crew, 0)
  expect(text).toContain('（沒有名稱）SendMessage 用 `to=uds:/tmp/cc-msg-abc`') // code 格式：模型照抄才不會吃掉反斜線
  expect(text).toContain('| user-30 |') // 有名稱就照舊顯示名稱
  expect(text).toContain('（未登記，傳訊息找不到）') // 舊版沒有位址
  expect(findRecipient(crew, 'uds:/tmp/cc-msg-abc')?.id).toBe('a') // 寄到位址也畫得出紙飛機
})

test('an error stays visible in the roster after the turn ends (error → done → idle)', () => {
  const NOW = 20 * MIN
  const lastError = { text: 'Exit code 1', at: NOW - 3 * MIN }
  const done = roster([{ ...P('a', 'x', 'done'), lastError }], NOW)
  const idle = roster([{ ...P('a', 'x', 'idle'), since: NOW - 2 * MIN, lastError }], NOW)
  expect(done).toContain('剛完成，等輸入・上次出錯 3 分前：Exit code 1')
  expect(idle).toContain('等輸入（2 分）・上次出錯 3 分前：Exit code 1')
  expect(roster([{ ...P('a', 'x', 'idle'), lastError: { ...lastError, at: 0 } }], NOW)).not.toContain('上次出錯') // 10 分鐘後收掉
})

// ---------- 0.12.0：多主管、各主管 peer 區、櫃台 ----------

import { bossSeating, counterSpot, teamZones } from './scene'

const boss = (id: string, name: string, agent: string): Coworker => ({ ...P(id, name, 'idle', false, 'manager'), agent })

test('the manager office holds up to 3 desks from 80 columns, 2 from 60 (the real pane is 50~80), 1 when narrower; the 4th manager is +1', () => {
  expect(layout(112, 60).bossDesks).toHaveLength(3)
  expect(layout(90, 60).bossDesks).toHaveLength(3)
  expect(layout(80, 44).bossDesks).toHaveLength(3)
  expect(layout(60, 44).bossDesks).toHaveLength(2)
  expect(layout(59, 44).bossDesks).toHaveLength(1)
  const four = [boss('a', 'aa', 'm-a'), boss('b', 'bb', 'm-b'), boss('c', 'cc', 'm-c'), boss('d', 'dd', 'm-d')]
  const L = layout(112, 60)
  const lines = cellText(encode(drawScene(four, 0, 112, 60)), 112, 60)
  const plates = lines[4]
  expect(plates.slice(L.officeX)).toContain('*aa')
  expect(plates).toContain('*bb')
  expect(plates).toContain('+1*') // 最後一張桌（最左）帶 +1
  expect(lines.join('\n')).not.toContain('dd')
  expect(bossSeating(four, 112, 60).extra).toBe(1)
  // 每張桌在主管室裡、彼此不重疊（桌寬 8＋椅子 9）
  for (const w of [60, 80, 112]) {
    const xs = layout(w, 60).bossDesks.map(d => d.x).sort((a, b) => a - b)
    expect(xs[0]).toBeGreaterThanOrEqual(layout(w, 60).officeX + 1)
    for (let i = 1; i < xs.length; i++) expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(9)
  }
})

test('a second manager arriving does not make the first one get up (same stand), and seats stay sticky', () => {
  const a = boss('a', 'aa', 'm-a')
  const one = assignSeats([a], 112, 60)
  const two = assignSeats([a, boss('b', 'bb', 'm-b')], 112, 60, one)
  expect(two.get('a')!.slot).toBe(one.get('a')!.slot)
  expect(two.get('a')!.stand).toEqual(one.get('a')!.stand)
  const again = assignSeats([boss('0', 'zz', 'm-0'), a, boss('b', 'bb', 'm-b')], 112, 60, two)
  expect(again.get('a')!.slot).toBe(two.get('a')!.slot) // 新來的人不搶舊位子
  expect(again.get('b')!.slot).toBe(two.get('b')!.slot)
})

test('each manager with peers online gets a column of their own, rightmost first, with its own rug and TEAM sign', () => {
  const a = boss('a', 'aa', 'm-a')
  const b = boss('b', 'bb', 'm-b')
  const crew = [a, b, { ...P('p1', 'p1'), team: 'm-a' }, { ...P('p2', 'p2'), team: 'm-b' }, { ...P('p3', 'p3'), team: 'bb' }, P('o', 'o')]
  const L = layout(112, 60)
  expect(L.cols).toBe(3)
  const colOf = (x: number) => L.clusters.findIndex((k, i) => i < L.cols && x >= k.x && x < k.x + 23)
  const seats = assignSeats(crew, 112, 60)
  expect(colOf(seats.get('p1')!.seat.x)).toBe(2) // 第一位主管：最右欄
  expect(colOf(seats.get('p2')!.seat.x)).toBe(1)
  expect(colOf(seats.get('p3')!.seat.x)).toBe(1) // team 填名牌也算
  expect(colOf(seats.get('o')!.seat.x)).toBe(0) // 沒有 team 的人坐一般區
  const scene = drawScene(crew, 0, 112, 60)
  const px = [...scene.px]
  expect(px.some(c => c === 0xeadfc8)).toBe(true) // 金邊（第一位）
  expect(px.some(c => c === 0xdbe7ef)).toBe(true) // 藍（第二位）
  const text = cellText(encode(scene), 112, 60).join('\n')
  expect(text).toContain('TEAM aa')
  expect(text).toContain('TEAM bb')
})

test('with several managers only those with peers get a zone; the left column is kept only when someone has no zone', () => {
  const a = boss('a', 'aa', 'm-a')
  const b = boss('b', 'bb', 'm-b')
  const c = boss('c', 'cc', 'm-c')
  expect(teamZones([a], [a], 2).map(m => m.id)).toEqual(['a']) // 一位主管：照舊，沒有 peer 也鋪
  expect(teamZones([a, b], [a, b, { ...P('p', 'p'), team: 'm-b' }], 3).map(m => m.id)).toEqual(['b'])
  const all = [a, b, c, ...['m-a', 'm-b', 'm-c'].map((t, i) => ({ ...P(`p${i}`, `p${i}`), team: t }))]
  expect(teamZones([a, b, c], all, 3).map(m => m.id)).toEqual(['a', 'b', 'c']) // 沒有閒雜人：3 欄都是分區
  expect(teamZones([a, b, c], [...all, P('o', 'o')], 3).map(m => m.id)).toEqual(['a', 'b']) // 有沒 team 的人：最左一欄留給他
  expect(teamZones([a, b, c], all, 2).map(m => m.id)).toEqual(['a']) // c 的 peer 排不進分區＝分不到區的人，照樣留一欄
  expect(teamZones([a, b], all, 1)).toEqual([])
})

test('walking from every manager desk to every seat never enters a wall (three managers)', () => {
  const w = 112, r = 60
  const L = layout(w, r)
  const crew = [boss('a', 'aa', 'm-a'), boss('b', 'bb', 'm-b'), boss('c', 'cc', 'm-c'), ...L.seats.slice(0, 6).map((_, i) => P(`s${i}`, `s${i}`))]
  const placed = [...assignSeats(crew, w, r).values()]
  for (const a of placed.filter(p => p.kind === 'boss')) {
    for (const b of placed) {
      if (a === b) continue
      for (const pt of route(a, b, w, r)) expect(pt.x >= 2 + 3 && pt.x <= w - 2 - 4).toBe(true)
    }
  }
})

test('the counter sits right of the front door when there is room, labelled YOU on the wall, never over the copier', () => {
  expect(counterSpot(48, 44)).toBeUndefined()
  for (const w of [60, 80, 112]) {
    const spot = counterSpot(w, 44)!
    expect(spot).toBeDefined()
    const qx = spot.x - 3
    const door = [Math.floor(w / 2) - 3, Math.floor(w / 2) + 2]
    const cp = [w - 2 - 16, w - 2 - 16 + 7]
    expect(qx).toBeGreaterThan(door[1])
    expect(qx + 7 - 1).toBeLessThan(cp[0])
    const text = cellText(encode(drawScene([], 0, w, 44)), w, 44)
    expect(text[43].slice(qx, qx + 3)).toBe('YOU')
  }
  expect(cellText(encode(drawScene([], 0, 48, 44)), 48, 44).join('\n')).not.toContain('YOU')
})

test('someone walking the bottom corridor past the counter never covers it (counter sits against the wall)', () => {
  for (const w of [60, 80, 112]) {
    const r = 44, h = r * 2
    const spot = counterSpot(w, r)!
    const qx = spot.x - 3
    const walker = P('w', 'w', 'working')
    const empty = drawScene([walker], 0, w, r).px
    const y = h - 2 - 10 // 底部走廊
    const path = [{ x: qx - 12, y }, { x: qx + 18, y }] // 從櫃台上方走過去
    for (let f = 0; f < 30; f++) {
      const busy = drawScene([walker], f, w, r, [{ id: 'w', path, start: 0 }]).px
      expect(busy.some((c, i) => c !== empty[i])).toBe(true) // 人真的畫在走廊上
      const counter = new Set([0x6d4c41, 0x8d6e63, 0x4e342e]) // 櫃台的木色：這些像素一個都不能被人蓋掉
      let wood = 0
      for (let y = h - 2 - 12; y < h - 2; y++)
        for (let x = qx; x < qx + 7; x++)
          if (counter.has(empty[y * w + x])) {
            wood += 1
            expect(busy[y * w + x]).toBe(empty[y * w + x])
          }
      expect(wood).toBeGreaterThan(10)
    }
  }
})

test('a manager without a desk still gets a peer zone and TEAM sign (59 columns: 1 desk, 2 columns)', () => {
  const w = 59, r = 44
  expect(layout(w, r).bossDesks).toHaveLength(1)
  const a = boss('a', 'aa', 'm-a')
  const b = boss('b', 'bb', 'm-b')
  const crew = [a, b, { ...P('p1', 'p1'), team: 'm-b' }, P('o', 'o')]
  expect(bossSeating(crew, w, r).extra).toBe(1)
  const L = layout(w, r)
  expect(L.cols).toBe(2)
  const colOf = (x: number) => L.clusters.findIndex((k, i) => i < L.cols && x >= k.x && x < k.x + 23)
  const seats = assignSeats(crew, w, r)
  expect(colOf(seats.get('p1')!.seat.x)).toBe(1) // bb 沒桌子，他的 peer 照樣坐他那區
  expect(colOf(seats.get('o')!.seat.x)).toBe(0)
  expect(cellText(encode(drawScene(crew, 0, w, r)), w, r).join('\n')).toContain('TEAM bb')
})

test('at 60~80 columns two managers each with peers get two zones when nobody is without a team', () => {
  for (const w of [60, 80]) {
    const r = 44
    const a = boss('a', 'aa', 'm-a')
    const b = boss('b', 'bb', 'm-b')
    const crew = [a, b, { ...P('p1', 'p1'), team: 'm-a' }, { ...P('p2', 'p2'), team: 'm-b' }]
    const L = layout(w, r)
    expect(L.cols).toBe(2)
    const colOf = (x: number) => L.clusters.findIndex((k, i) => i < L.cols && x >= k.x && x < k.x + 23)
    const seats = assignSeats(crew, w, r)
    expect(colOf(seats.get('p1')!.seat.x)).toBe(1)
    expect(colOf(seats.get('p2')!.seat.x)).toBe(0)
    const text = cellText(encode(drawScene(crew, 0, w, r)), w, r).join('\n')
    expect(text).toContain('TEAM aa')
    expect(text).toContain('TEAM bb')
    // 多一個沒 team 的人：退回一區，最左欄給他
    const more = [...crew, P('o', 'o')]
    expect(colOf(assignSeats(more, w, r).get('o')!.seat.x)).toBe(0)
    expect(cellText(encode(drawScene(more, 0, w, r)), w, r).join('\n')).not.toContain('TEAM bb')
  }
})

// ---------- 點人核准（控制塔第 1 期）----------

import { ALLOW_COOLDOWN_MS, APPROVAL_TEXT_MAX, APPROVAL_TIMEOUT_MS, ASK_WINDOW_MS, TOMBSTONE, approvalFits, approvalWindow, approvalText, canon, judgeDecision, textHash, matchAsk, officeApproves, parseApproval, waitForDecision } from './register'

const WANT = { session: 's1', toolUseId: 'toolu_1', nonce: 'n-1', textHash: 'h-1' }
const decided = (over: Record<string, unknown> = {}) => JSON.stringify({ state: 'decided', ...WANT, behavior: 'allow', at: 1, ...over })

test('approval text: Bash/PowerShell show the command, other tools the whole input; Allow only when it all fits', () => {
  expect(approvalText('Bash', { command: 'git push', description: 'x' })).toBe('git push')
  expect(approvalText('PowerShell', { command: 'ls' })).toBe('ls')
  expect(approvalText('Write', { file_path: 'a', content: 'b' })).toContain('"file_path"')
  expect(approvalFits('git push')).toBe(true)
  expect(approvalFits('')).toBe(false)
  expect(approvalFits('x'.repeat(APPROVAL_TEXT_MAX + 1))).toBe(false)
  expect(approvalFits(Array.from({ length: 21 }, () => 'a').join('\n'))).toBe(false)
})

test('PermissionRequest is matched to the tool.check ask only when exactly one same call was asked within 2 seconds', () => {
  const ask = (id: string, at: number, command = 'ls') => ({ toolUseId: id, tool: 'Bash', input: canon({ command }), at })
  expect(canon({ b: 1, a: { d: 2, c: [1, { f: 0, e: 1 }] } })).toBe(canon({ a: { c: [1, { e: 1, f: 0 }], d: 2 }, b: 1 }))
  expect(matchAsk([ask('t1', 1000)], 'Bash', canon({ command: 'ls' }), 1071)).toBe('t1')
  expect(matchAsk([ask('t1', 1000)], 'Bash', canon({ command: 'ls' }), 1000 + ASK_WINDOW_MS + 1)).toBeUndefined() // 太久以前
  expect(matchAsk([ask('t1', 1000)], 'Bash', canon({ command: 'rm -rf x' }), 1071)).toBeUndefined() // 不同指令
  expect(matchAsk([ask('t1', 1000)], 'PowerShell', canon({ command: 'ls' }), 1071)).toBeUndefined()
  expect(matchAsk([ask('t1', 1000), ask('t2', 1050)], 'Bash', canon({ command: 'ls' }), 1071)).toBeUndefined() // 兩筆一樣：不猜
})

test('a decision is taken only when session, toolUseId and nonce all match; tombstones and junk are not decisions', () => {
  expect(judgeDecision(undefined, WANT)).toEqual({ kind: 'none' })
  expect(judgeDecision(TOMBSTONE, WANT)).toEqual({ kind: 'none' })
  expect(judgeDecision('{oops', WANT)).toEqual({ kind: 'corrupt' })
  expect(judgeDecision(decided(), WANT)).toEqual({ kind: 'ok', behavior: 'allow' })
  expect(judgeDecision(decided({ behavior: 'deny' }), WANT)).toEqual({ kind: 'ok', behavior: 'deny' })
  expect(judgeDecision(decided({ nonce: 'n-2' }), WANT)).toEqual({ kind: 'mismatch', why: 'nonce' })
  expect(judgeDecision(decided({ toolUseId: 'toolu_0' }), WANT)).toEqual({ kind: 'mismatch', why: 'toolUseId' })
  expect(judgeDecision(decided({ session: 's2' }), WANT)).toEqual({ kind: 'mismatch', why: 'session' })
  expect(judgeDecision(decided({ textHash: 'h-other' }), WANT)).toEqual({ kind: 'mismatch', why: 'textHash' }) // 單上的指令被換過
  expect(judgeDecision(decided({ textHash: undefined }), WANT)).toEqual({ kind: 'mismatch', why: 'textHash' })
  expect(judgeDecision(decided({ behavior: 'always' }), WANT)).toEqual({ kind: 'corrupt' }) // 只有 allow／deny
})

test('an approval slip past its deadline, a tombstone or a broken file counts as not there', () => {
  const rec = { state: 'waiting', session: 's1', name: 'e2', toolUseId: 't', tool: 'Bash', text: 'ls', nonce: 'n', at: 1000, deadline: 9500 }
  expect(parseApproval(JSON.stringify(rec), 1000 + 5000)?.text).toBe('ls')
  expect(parseApproval(JSON.stringify(rec), 9500)).toBeUndefined() // 過了 deadline
  expect(parseApproval(JSON.stringify({ ...rec, deadline: undefined }), 2000)).toBeUndefined() // 舊版沒 deadline 的單
  expect(parseApproval(JSON.stringify({ ...rec, deadline: 1e15 }), 1000 + APPROVAL_TIMEOUT_MS)).toBeUndefined() // 上限
  expect(parseApproval(TOMBSTONE, 1000)).toBeUndefined()
  expect(parseApproval('{', 1000)).toBeUndefined()
  expect(parseApproval(JSON.stringify({ ...rec, nonce: 3 }), 1000)).toBeUndefined()
  expect(officeApproves([P('a', 'a'), { ...P('b', 'b'), office: true, approve: true }])).toBe(true)
  expect(officeApproves([P('a', 'a'), { ...P('b', 'b'), office: true }])).toBe(false) // 開著面板但核准關著（預設）：不送單
  expect(officeApproves([P('a', 'a')])).toBe(false) // 辦公室沒開：不送單
})

const fakeIO = (reads: (string | undefined)[], opts: { settledAt?: number; step?: number } = {}) => {
  let t = 0
  let i = 0
  const logs: string[] = []
  let discards = 0
  return {
    io: {
      read: async () => reads[Math.min(i++, reads.length - 1)],
      discard: async () => void (discards += 1),
      now: async () => t,
      sleep: async (ms: number) => void (t += opts.step ?? ms),
      settled: () => opts.settledAt !== undefined && t >= opts.settledAt,
      log: (x: string) => void logs.push(x),
    },
    logs,
    discards: () => discards,
    elapsed: () => t,
  }
}

test('waiting: a nonce or toolUseId mismatch is discarded with one log line and waiting goes on', async () => {
  const f = fakeIO([undefined, decided({ nonce: 'old' }), decided({ toolUseId: 'toolu_0' }), decided()])
  expect(await waitForDecision(f.io, WANT, 8500)).toBe('allow')
  expect(f.discards()).toBe(2)
  expect(f.logs).toHaveLength(2)
  expect(f.logs[0]).toContain('nonce')
  expect(f.logs[1]).toContain('toolUseId')
})

test('waiting: the deadline, a broken file or the terminal answering first all give no answer (back to the terminal)', async () => {
  const slow = fakeIO([undefined])
  expect(await waitForDecision(slow.io, WANT, 8500)).toBeUndefined()
  expect(slow.elapsed()).toBe(8500) // 剛好停在 deadline，不多睡一輪
  const broken = fakeIO([undefined, '{not json'])
  expect(await waitForDecision(broken.io, WANT, 8500)).toBeUndefined()
  expect(broken.logs[0]).toContain('壞掉')
  const terminal = fakeIO([undefined, undefined, decided()], { settledAt: 300 }) // 終端機先按了：之後才到的決定也不採用
  expect(await waitForDecision(terminal.io, WANT, 8500)).toBeUndefined()
})

test('PermissionRequest with no matching ask (or from a subagent) is left to the terminal untouched', async ($, on) => {
  MOCKS(on, [])
  let reached = 0
  on('classic.PermissionRequest', () => {
    reached += 1
    return {} as any
  })
  const base = { tool_name: 'Bash', tool_input: { command: 'git push' }, permission_suggestions: [] } as any
  expect(await ($ as any).classic.PermissionRequest(base)).toEqual({})
  expect(await ($ as any).classic.PermissionRequest({ ...base, agent_id: 'a1' })).toEqual({})
  expect(await ($ as any).classic.PermissionRequest({ ...base, permission_mode: 'bypassPermissions' })).toEqual({})
  expect(reached).toBe(3)
})

const officeFs = (on: any, files: Record<string, string>, writes: { path: string; text: string }[] = []) => {
  const key = (p: string) => p.split(/[\\/]/).slice(-2).join('/')
  on('env.get', () => ({ value: 'C:/Users/tester' }))
  on('fs.list', (_$: any, e: any) => ({
    value: Object.keys(files)
      .filter(k => k.startsWith(`${String(e.path).split(/[\\/]/).pop()}/`))
      .map(k => ({ name: k.split('/')[1], kind: 'file', size: 1, mtimeMs: 0, isLink: false })),
  }) as any)
  on('fs.read', (_$: any, e: any) => ({ value: files[key(e.path)] ?? '{}' }))
  on('fs.write', (_$: any, e: any) => {
    files[key(e.path)] = e.text
    writes.push({ path: key(e.path), text: e.text })
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
}

import { runSlip } from './register'

const slipIO = (files: Record<string, string>, opts: { settledAt?: number } = {}) => {
  let t = 1_000_000
  const order: string[] = []
  const shown: unknown[] = []
  return {
    io: {
      read: async () => files.decision,
      discard: async () => void ((files.decision = TOMBSTONE), order.push('decision')),
      writeSlip: async (x: string) => void ((files.slip = x), order.push('slip')),
      clearAll: async () => void ((files.slip = TOMBSTONE), (files.decision = TOMBSTONE)),
      nonce: () => 'fresh-nonce',
      shown: async (on: unknown) => void shown.push(on),
      now: async () => t,
      sleep: async (ms: number) => {
        t += ms
        tick?.(t)
      },
      settled: () => opts.settledAt !== undefined && t >= opts.settledAt,
      log: () => undefined,
    },
    order,
    shown,
    onTick: (f: (t: number) => void) => void (tick = f),
  }
  var tick: ((t: number) => void) | undefined
}

test('a slip: old decision cleared before sending, guessed nonce discarded, the real one taken; afterwards both files are tombstones', async () => {
  const h = await textHash('git push --force')
  const files: Record<string, string> = { decision: decided({ session: 's1', toolUseId: 'toolu_9', nonce: 'fresh-nonce', textHash: h }) } // 上一輪殘檔，剛好長得一樣也不能被採用
  const f = slipIO(files)
  let step = 0
  f.onTick(() => {
    step += 1
    if (step === 1) files.decision = decided({ toolUseId: 'toolu_9', nonce: 'guess', textHash: h })
    if (step === 3) files.decision = decided({ toolUseId: 'toolu_9', nonce: 'fresh-nonce', textHash: h, behavior: 'deny' })
  })
  const got = await runSlip(f.io as any, { session: 's1', name: 'impl' }, 'toolu_9', 'Bash', 'git push --force', 8500)
  expect(got).toBe('deny')
  expect(f.order.slice(0, 2)).toEqual(['decision', 'slip']) // 先清舊決定，再送單
  expect(f.order.filter(x => x === 'decision').length).toBe(2) // 送單前一次＋丟棄猜錯的一次
  expect(files.slip).toBe(TOMBSTONE)
  expect(files.decision).toBe(TOMBSTONE)
  expect(f.shown[0]).toMatchObject({ tool: 'Bash' })
  expect(f.shown[f.shown.length - 1]).toBeUndefined() // 畫面上的單收掉
})

test('a slip ends at its deadline with no answer, or as soon as the terminal answers; tombstones either way', async () => {
  const h = await textHash('ls')
  const quiet: Record<string, string> = {}
  expect(await runSlip(slipIO(quiet).io as any, { session: 's1', name: 'impl' }, 'toolu_9', 'Bash', 'ls', 8500)).toBeUndefined()
  expect(quiet.slip).toBe(TOMBSTONE)
  const files: Record<string, string> = {}
  const f = slipIO(files, { settledAt: 1_000_000 + 600 })
  f.onTick(t => {
    if (t > 1_000_000 + 900) files.decision = decided({ toolUseId: 'toolu_9', nonce: 'fresh-nonce', textHash: h })
  })
  expect(await runSlip(f.io as any, { session: 's1', name: 'impl' }, 'toolu_9', 'Bash', 'ls', 8500)).toBeUndefined()
  expect(files.decision).toBe(TOMBSTONE)
})

test('office pane: lists the slip, Allow is held for 1 s after opening, then writes the exact decision', async ($, on) => {
  const NOW = 1_000_000
  const clock = mock.clock(on, { now: NOW })
  const slip = { state: 'waiting', session: 'bbbb', name: 'impl', toolUseId: 'toolu_5', tool: 'Bash', text: 'git push', nonce: 'nn', at: NOW - 1000, deadline: NOW + 8000 }
  const files: Record<string, string> = {
    'sessions/bbbb.json': JSON.stringify({ id: 'bbbb', name: 'impl', role: 'staff', mode: 'waiting', tool: 'Bash', updatedAt: NOW, left: false, approval: { tool: 'Bash', at: NOW - 1000, deadline: NOW + 8000 } }),
    'approvals/bbbb.json': JSON.stringify(slip),
  }
  const writes: { path: string; text: string }[] = []
  officeFs(on, files, writes)
  on('ui.toast', () => ({ value: undefined }) as any)
  await $.command.run({ command: 'office', args: 'approve on' } as any)
  await $.command.run({ command: 'office', args: '' } as any)
  const ui = await $.ui.mount(PANE_PROPS)
  await $.command.run({ command: 'office', args: '' } as any) // 面板開著 → 下一輪 refresh 讀到核准單（測試裡沒有 session.start 的定時器，用 /office 觸發）
  expect(await ui.find({ key: 'review-bbbb' })).toBeDefined()
  expect(JSON.parse(files[Object.keys(files).find(k => k.startsWith('sessions/') && k !== 'sessions/bbbb.json')!]).office).toBe(true)
  await ui.press({ key: 'review-bbbb' })
  expect((await ui.findAll({ type: 'Text' } as any)).map((t: any) => t.text)).toContain('git push')
  await ui.press({ key: 'approval-allow' }) // 剛展開：擋下
  expect(writes.some(w => w.path === 'decisions/bbbb.json')).toBe(false)
  await clock.advance(ALLOW_COOLDOWN_MS)
  await ui.press({ key: 'approval-allow' })
  expect(JSON.parse(files['decisions/bbbb.json'])).toMatchObject({ state: 'decided', session: 'bbbb', toolUseId: 'toolu_5', nonce: 'nn', textHash: await textHash('git push'), behavior: 'allow' })
  await ui.unmount()
})

test('office pane: a slip replaced by a new request reopens with a fresh cooldown; a too-long command offers only Deny (no cooldown on Deny)', async ($, on) => {
  const NOW = 1_000_000
  const clock = mock.clock(on, { now: NOW })
  const slip = { state: 'waiting', session: 'bbbb', name: 'impl', toolUseId: 'toolu_5', tool: 'Bash', text: 'ls', nonce: 'n1', at: NOW, deadline: NOW + 8000 }
  const files: Record<string, string> = {
    'sessions/bbbb.json': JSON.stringify({ id: 'bbbb', name: 'impl', role: 'staff', mode: 'waiting', tool: 'Bash', updatedAt: NOW, left: false }),
    'approvals/bbbb.json': JSON.stringify(slip),
  }
  officeFs(on, files)
  on('ui.toast', () => ({ value: undefined }) as any)
  await $.command.run({ command: 'office', args: 'approve on' } as any)
  await $.command.run({ command: 'office', args: '' } as any)
  const ui = await $.ui.mount(PANE_PROPS)
  await $.command.run({ command: 'office', args: '' } as any)
  await ui.press({ key: 'review-bbbb' })
  await clock.advance(ALLOW_COOLDOWN_MS)
  // 對方換了一筆（新 toolUseId、新 nonce，指令很長）：重新展開、冷卻重算
  const long = 'x'.repeat(APPROVAL_TEXT_MAX + 10)
  files['approvals/bbbb.json'] = JSON.stringify({ ...slip, toolUseId: 'toolu_6', nonce: 'n2', text: long, at: NOW + 3000 })
  files['sessions/bbbb.json'] = JSON.stringify({ ...JSON.parse(files['sessions/bbbb.json']), updatedAt: NOW + 3000 })
  await $.command.run({ command: 'office', args: '' } as any)
  expect(await ui.find({ key: 'approval-allow' })).toBeUndefined()
  expect(await ui.find({ key: 'approval-deny' })).toBeDefined()
  await ui.press({ key: 'approval-deny' })
  expect(JSON.parse(files['decisions/bbbb.json'])).toMatchObject({ toolUseId: 'toolu_6', nonce: 'n2', behavior: 'deny' })
  // 再換一筆短的：展開中的那張被換掉 → 冷卻從頭算，馬上按 Allow 擋下
  await ui.press({ key: 'review-bbbb' })
  await clock.advance(ALLOW_COOLDOWN_MS)
  files['approvals/bbbb.json'] = JSON.stringify({ ...slip, toolUseId: 'toolu_7', nonce: 'n3', text: 'ls', at: NOW + 6000 })
  await $.command.run({ command: 'office', args: '' } as any)
  await ui.press({ key: 'approval-allow' })
  expect(JSON.parse(files['decisions/bbbb.json']).toolUseId).toBe('toolu_6')
  await clock.advance(ALLOW_COOLDOWN_MS)
  await ui.press({ key: 'approval-allow' })
  expect(JSON.parse(files['decisions/bbbb.json'])).toMatchObject({ toolUseId: 'toolu_7', nonce: 'n3', behavior: 'allow' })
  await ui.unmount()
})

import { queueSpot } from './scene'

test('waiting for the office: people queue at the counter (front door when narrow) holding a slip, not at their desk', () => {
  expect(queueSpot(112, 44, 0)).toEqual(counterSpot(112, 44))
  expect(queueSpot(112, 44, 1).x).toBe(counterSpot(112, 44)!.x - 8)
  expect(queueSpot(48, 44, 0)).toEqual({ x: 24, y: 88 - 2 - 10 }) // 沒有櫃台：大門口
  const w = P('w', 'w', 'waiting')
  const seat = assignSeats([w], 112, 44).get('w')!
  const plain = drawScene([w], 0, 112, 44).px
  const queued = drawScene([w], 0, 112, 44, [], undefined, { queue: ['w'] }).px
  const at = queueSpot(112, 44, 0)
  const changed = (x0: number, y0: number) => {
    let n = 0
    for (let y = y0 - 3; y < y0 + 6; y++) for (let x = x0 - 3; x < x0 + 4; x++) if (plain[y * 112 + x] !== queued[y * 112 + x]) n += 1
    return n
  }
  expect(changed(at.x, at.y)).toBeGreaterThan(10) // 櫃台前多了一個人
  expect(changed(seat.stand.x, seat.stand.y)).toBeGreaterThan(0) // 座位上的人起身了
})

test('the roster says the office pane can answer a waiting session', () => {
  const c = { ...P('w', 'w', 'waiting'), tool: 'Bash', since: 1000, approval: { tool: 'Bash', at: 1000, deadline: 9500 } }
  expect(roster([c], 5000)).toContain('辦公室面板可審')
  expect(roster([P('a', 'a'), c], 5000).split('\n')[0]).toBe('🟡🟡 等你核准（開辦公室面板按「審 <名牌>」）：w（Bash，剩 5 秒）') // 第一行最醒目
  expect(roster([c], 9500)).not.toContain('等你核准')
  expect(roster([{ ...c, approval: undefined }], 5000)).not.toContain('辦公室面板可審')
})

test('a decision for swapped command text is not taken: same toolUseId and nonce, but the hash is of what the viewer saw', async () => {
  expect(await textHash('ls')).toMatch(/^[0-9a-f]{64}$/)
  expect(await textHash('ls')).not.toBe(await textHash('rm -rf ~'))
  // 等的人要跑 rm -rf ~；有人把單上的 text 換成 ls，使用者看到 ls 按了 Allow → 決定帶的是 ls 的 hash
  const files: Record<string, string> = {}
  const f = slipIO(files)
  const seen = await textHash('ls')
  let step = 0
  const logs: string[] = []
  f.io.log = (x: string) => void logs.push(x)
  f.onTick(() => {
    step += 1
    if (step === 1) files.decision = decided({ session: 's1', toolUseId: 'toolu_9', nonce: 'fresh-nonce', textHash: seen })
  })
  expect(await runSlip({ ...f.io, now: f.io.now } as any, { session: 's1', name: 'impl' }, 'toolu_9', 'Bash', 'rm -rf ~', 8500)).toBeUndefined() // 丟棄後等到逾時
  expect(logs.some(l => l.includes('textHash'))).toBe(true)
})

test('office pane: if the slip text changes after opening (same toolUseId and nonce), Allow sends nothing', async ($, on) => {
  const NOW = 1_000_000
  const clock = mock.clock(on, { now: NOW })
  const slip = { state: 'waiting', session: 'bbbb', name: 'impl', toolUseId: 'toolu_5', tool: 'Bash', text: 'rm -rf ~', nonce: 'nn', at: NOW, deadline: NOW + 8000 }
  const files: Record<string, string> = {
    'sessions/bbbb.json': JSON.stringify({ id: 'bbbb', name: 'impl', role: 'staff', mode: 'waiting', tool: 'Bash', updatedAt: NOW, left: false }),
    'approvals/bbbb.json': JSON.stringify(slip),
  }
  officeFs(on, files)
  on('ui.toast', () => ({ value: undefined }) as any)
  await $.command.run({ command: 'office', args: 'approve on' } as any)
  await $.command.run({ command: 'office', args: '' } as any)
  const ui = await $.ui.mount(PANE_PROPS)
  await $.command.run({ command: 'office', args: '' } as any)
  await ui.press({ key: 'review-bbbb' })
  await clock.advance(ALLOW_COOLDOWN_MS)
  files['approvals/bbbb.json'] = JSON.stringify({ ...slip, text: 'ls' }) // 展開後被換字
  await ui.press({ key: 'approval-allow' }) // 按下時重讀：跟展開時看到的不同 → 不送
  expect(files['decisions/bbbb.json']).toBeUndefined()
  await ui.unmount()
})

test('the wait fits inside the 10 s hook budget: remaining minus 1.5 s, capped, and no slip when too little is left', () => {
  expect(approvalWindow(10_000)).toBe(8500)
  expect(approvalWindow(Infinity)).toBe(APPROVAL_TIMEOUT_MS) // 沒有計時（測試）時才用上限
  expect(approvalWindow(3000)).toBeUndefined() // 剩 1.5 秒不夠看
})

test('budget running out clears the slip by itself; an abort (interrupt, terminal settled) clears it within one poll', async () => {
  const files: Record<string, string> = {}
  const f = slipIO(files)
  expect(await runSlip(f.io as any, { session: 's1', name: 'impl' }, 'toolu_9', 'Bash', 'ls', approvalWindow(10_000)!)).toBeUndefined()
  expect(files.slip).toBe(TOMBSTONE)
  expect(f.shown[f.shown.length - 1]).toBeUndefined()
  const g = slipIO(files)
  const ac = new AbortController()
  g.io.settled = () => ac.signal.aborted
  let woke = 0
  g.onTick(t => {
    if (!ac.signal.aborted) ac.abort()
    woke = t
  })
  const start = await g.io.now()
  files.slip = 'x'
  expect(await runSlip(g.io as any, { session: 's1', name: 'impl' }, 'toolu_9', 'Bash', 'ls', 8500)).toBeUndefined()
  expect(woke - start).toBeLessThanOrEqual(300)
  expect(files.slip).toBe(TOMBSTONE)
})

test('office pane: past the deadline the slip folds away and nothing can be pressed; the countdown shows the seconds left', async ($, on) => {
  const NOW = 1_000_000
  const clock = mock.clock(on, { now: NOW })
  const slip = { state: 'waiting', session: 'bbbb', name: 'impl', toolUseId: 'toolu_5', tool: 'Bash', text: 'ls', nonce: 'nn', at: NOW, deadline: NOW + 3000 }
  const files: Record<string, string> = {
    'sessions/bbbb.json': JSON.stringify({ id: 'bbbb', name: 'impl', role: 'staff', mode: 'waiting', tool: 'Bash', updatedAt: NOW, left: false }),
    'approvals/bbbb.json': JSON.stringify(slip),
  }
  officeFs(on, files)
  on('ui.toast', () => ({ value: undefined }) as any)
  await $.command.run({ command: 'office', args: 'approve on' } as any)
  await $.command.run({ command: 'office', args: '' } as any)
  const ui = await $.ui.mount(PANE_PROPS)
  await $.command.run({ command: 'office', args: '' } as any)
  await ui.press({ key: 'review-bbbb' })
  expect((await ui.findAll({ type: 'Text' } as any)).map((t: any) => t.text).join(' ')).toContain('剩 3 秒')
  await clock.advance(1500) // 冷卻過了、還沒到 deadline
  await clock.advance(1600) // 過了 deadline（這段時間 refresh 還沒跑也一樣）
  expect(await ui.find({ key: 'approval-allow' })).toBeUndefined()
  expect(await ui.find({ key: 'review-bbbb' })).toBeUndefined()
  expect(files['decisions/bbbb.json']).toBeUndefined()
  await ui.unmount()
})

import { ALLOW_READY, ALLOW_WAIT, queueOrder } from './register'

test('approval is off by default: an open pane alone publishes no approve flag and shows no review buttons', async ($, on) => {
  const NOW = 1_000_000
  mock.clock(on, { now: NOW })
  const slip = { state: 'waiting', session: 'bbbb', name: 'impl', toolUseId: 'toolu_5', tool: 'Bash', text: 'ls', nonce: 'nn', at: NOW, deadline: NOW + 8000 }
  const files: Record<string, string> = {
    'sessions/bbbb.json': JSON.stringify({ id: 'bbbb', name: 'impl', role: 'staff', mode: 'waiting', tool: 'Bash', updatedAt: NOW, left: false }),
    'approvals/bbbb.json': JSON.stringify(slip),
  }
  officeFs(on, files)
  await $.command.run({ command: 'office', args: '' } as any)
  const ui = await $.ui.mount(PANE_PROPS)
  await $.command.run({ command: 'office', args: '' } as any)
  const mine = JSON.parse(files[Object.keys(files).find(k => k.startsWith('sessions/') && k !== 'sessions/bbbb.json')!])
  expect(mine.office).toBe(true)
  expect(mine.approve).toBeUndefined() // 請求端看到這個就不送單
  expect(await ui.find({ key: 'review-bbbb' })).toBeUndefined()
  expect((await ui.findAll({ type: 'Text' } as any)).map((t: any) => t.text).join(' ')).not.toContain('核准已開啟')
  // 打開：狀態檔帶 approve、面板頂端常駐提示、看得到單
  const text: any = await $.command.run({ command: 'office', args: 'approve on' } as any)
  expect(String(text?.text ?? text)).toContain('已開啟')
  await $.command.run({ command: 'office', args: '' } as any)
  const after = JSON.parse(files[Object.keys(files).find(k => k.startsWith('sessions/') && k !== 'sessions/bbbb.json')!])
  expect(after.approve).toBe(true)
  expect((await ui.findAll({ type: 'Text' } as any)).map((t: any) => t.text)).toContain('核准已開啟（/office approve off 關閉）')
  expect(await ui.find({ key: 'review-bbbb' })).toBeDefined()
  await $.command.run({ command: 'office', args: 'approve off' } as any)
  await $.command.run({ command: 'office', args: '' } as any)
  expect(await ui.find({ key: 'review-bbbb' })).toBeUndefined()
  await ui.unmount()
})

test('the queue at the counter follows the waiting state, not the slip: it works with approval off', () => {
  const a = { ...P('a', 'a', 'waiting'), since: 2000 }
  const b = { ...P('b', 'b', 'waiting'), since: 1000 }
  expect(queueOrder([a, P('c', 'c', 'typing'), b])).toEqual(['b', 'a']) // 先等的排前面；沒有任何 approval 單
})

test('the Allow label is as wide while cooling down as when ready, so Deny never moves', () => {
  const w = (t: string) => [...t].reduce((n, ch) => n + (/[⺀-￯]/.test(ch) ? 2 : 1), 0)
  expect(w(ALLOW_WAIT)).toBe(w(ALLOW_READY))
  expect(ALLOW_WAIT.length).toBe(ALLOW_READY.length)
})

// ---------- 0.16.0：點寵物、點家具開選單 ----------

import { FURNITURE, MENUS, cellAt, menuFor, menuOthers, menuPlace } from './register'

const DESKTOP = (bodyColumns = 112, bodyRows = 80) =>
  ({
    plugin: 'pixel-office',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'pixel-office',
    props: { title: '像素辦公室', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows }, view: undefined },
  }) as any

test('furniture menus: every object has its default menu; buttons.json with the same object replaces it; old entries stay in the row', () => {
  expect(MENUS.printer.map(i => i.label)).toEqual(['查最近信件', '寫信', '看草稿'])
  expect(MENUS.cabinet.map(i => i.prompt)).toEqual(['/llm-wiki:wiki-repo list', '/llm-wiki:wiki-query', '在 Google Drive 搜尋檔案：先問我關鍵字'])
  expect(MENUS.mailbox.map(i => i.label)).toEqual(['狀態', 'pull', 'push', '最近 commit'])
  expect(MENUS.calendar.map(i => i.prompt)).toEqual(['/llm-wiki:wiki-agenda', '/llm-wiki:wiki-agenda add'])
  expect(MENUS.vending.map(i => i.prompt)).toEqual(['/llm-wiki:wiki-doctor', '/llm-wiki:wiki'])
  expect(MENUS.clock.map(i => i.prompt)).toEqual(['/llm-wiki:wiki-day 開工', '/llm-wiki:wiki-day 收工'])
  expect(MENUS.meeting).toEqual([{ label: '開會', prompt: '/llm-wiki:wiki-collabteam 開會' }])
  for (const f of FURNITURE) expect(MENUS[f].length).toBeGreaterThan(0)

  const mine = parseButtons([
    { object: 'printer', label: '查信', prompt: '查信' },
    { object: 'printer', label: '網址不收', url: 'https://x.com' },
    { object: 'sofa', label: '沒這件', prompt: 'x' },
    { label: '開工', prompt: '/llm-wiki:wiki-collab status' },
    ...Array.from({ length: 8 }, (_, i) => ({ object: 'clock', label: `c${i}`, prompt: 'x' })),
  ])
  expect(menuFor('printer', mine)).toEqual([{ label: '查信', prompt: '查信' }]) // 整份取代
  expect(menuFor('mailbox', mine)).toEqual(MENUS.mailbox) // 沒寫的家具照預設
  expect(menuFor('clock', mine)).toHaveLength(6) // 每件最多 6 項
  expect(mine.filter(b => !b.object)).toEqual([{ label: '開工', prompt: '/llm-wiki:wiki-collab status' }])
  // 家具項目不佔底下那排的 6 顆名額
  const both = parseButtons([...Array.from({ length: 6 }, (_, i) => ({ object: 'printer', label: `p${i}`, prompt: 'x' })), ...Array.from({ length: 6 }, (_, i) => ({ label: `b${i}`, prompt: 'x' }))])
  expect(both.filter(b => !b.object)).toHaveLength(6)
})

test('scene units to cells: terminal 1×2, desktop 1×2.5 (2026-10-27 measured); k scales a shrunk Svg', () => {
  expect(cellAt(40, 30, 'terminal')).toEqual({ top: 15, left: 40 })
  expect(cellAt(40, 30, 'desktop')).toEqual({ top: 12, left: 40 })
  expect(cellAt(112, 50, 'desktop', 0.5)).toEqual({ top: 10, left: 56 })
})

test('desktop: clicking furniture opens its menu beside it, one at a time; choosing sends the prompt and closes; 取消 closes', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  const ran: any[] = []
  const submitted: any[] = []
  on('command.run', (_$, e: any) => {
    if (e.command === 'office') return undefined as any
    ran.push(e)
    return { text: 'ok' } as any
  })
  on('prompt.submit', (_$, e: any) => {
    submitted.push(e)
    return { text: e.text } as any
  })
  const ui = await $.ui.mount(DESKTOP())
  for (const f of ['printer', 'cabinet', 'mailbox', 'calendar', 'clock', 'meeting']) expect(await ui.find({ key: `hit-${f}` })).toBeDefined()
  expect(await ui.find({ key: 'menu' })).toBeUndefined()
  await ui.press({ key: 'hit-printer' })
  expect((await ui.find({ key: 'menu-0' }))?.text).toBe('查最近信件')
  expect((await ui.find({ key: 'menu-cancel' }))?.text).toBe('取消')
  await ui.press({ key: 'hit-mailbox' }) // 換一件：同時只開一個
  expect((await ui.find({ key: 'menu-0' }))?.text).toBe('狀態')
  expect(await ui.find({ key: 'menu-4' })).toBeUndefined()
  await ui.press({ key: 'menu-0' })
  expect(submitted.some(e => e.text === 'git status 並用一兩句摘要')).toBe(true)
  expect(await ui.find({ key: 'menu' })).toBeUndefined()
  await ui.press({ key: 'hit-calendar' })
  await ui.press({ key: 'menu-0' }) // 斜線開頭：當指令跑
  expect(ran.some(e => e.command === 'llm-wiki:wiki-agenda')).toBe(true)
  await ui.press({ key: 'hit-clock' })
  await ui.press({ key: 'menu-cancel' })
  expect(await ui.find({ key: 'menu' })).toBeUndefined()
  await ui.press({ key: 'hit-meeting' })
  await ui.press({ key: 'hit-meeting' }) // 再點同一件：收起來
  expect(await ui.find({ key: 'menu' })).toBeUndefined()
  await ui.unmount()
})

test('desktop: a user menu from buttons.json replaces the default; old-format entries still draw in the row', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  on('fs.read', () => ({ value: JSON.stringify([{ object: 'printer', label: '查信', prompt: '查信件' }, { label: '說嗨', prompt: 'hi there' }]) }))
  const submitted: any[] = []
  on('prompt.submit', (_$, e: any) => {
    submitted.push(e)
    return { text: e.text } as any
  })
  expect((await $.command.run({ command: 'office', args: 'buttons' } as any)).text).toContain('自訂家具選單：printer')
  const ui = await $.ui.mount(DESKTOP())
  expect((await ui.find({ key: 'mine-0' }))?.text).toBe('說嗨')
  expect(await ui.find({ key: 'mine-1' })).toBeUndefined() // 家具項目不在底下那排
  await ui.press({ key: 'hit-printer' })
  expect((await ui.find({ key: 'menu-0' }))?.text).toBe('查信')
  expect(await ui.find({ key: 'menu-1' })).toBeUndefined()
  await ui.press({ key: 'menu-0' })
  expect(submitted.some(e => e.text === '查信件')).toBe(true)
  await ui.unmount()
})

test('desktop: the hit area covers the whole thing with blank plain buttons; at 48 columns the clock is not drawn and has no menu', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  const ui = await $.ui.mount(DESKTOP())
  const pr: any = await ui.find({ key: 'hit-printer' })
  expect(pr.props.plain).toBe(true)
  expect(String(pr.props.label)).toMatch(/^⠀+$/) // 盲文空白：看不見，但不像空白會被 Desktop 壓掉
  expect(String(pr.props.label).length).toBeGreaterThanOrEqual(6)
  expect(await ui.find({ key: 'hit-printer-1' })).toBeDefined() // 不只一列
  await ui.unmount()
  const narrow = await $.ui.mount(DESKTOP(48, 80))
  expect(await narrow.find({ key: 'hit-clock' })).toBeUndefined()
  expect(await narrow.find({ key: 'hit-pet' })).toBeDefined()
  await narrow.unmount()
})

test('terminal: the pet, printer, cabinet, mailbox and meeting table get a one-cell button; desktop-only things do not', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  const ui = await $.ui.mount(PANE_PROPS)
  for (const k of ['hit-pet', 'hit-printer', 'hit-cabinet', 'hit-mailbox']) expect(await ui.find({ key: k })).toBeDefined()
  for (const k of ['hit-corgi', 'hit-vending', 'hit-clock', 'hit-calendar']) expect(await ui.find({ key: k })).toBeUndefined()
  await ui.press({ key: 'hit-mailbox' })
  expect((await ui.find({ key: 'menu-0' }))?.text).toBe('狀態')
  await ui.unmount()
})

// ---------- 0.16.1：選單挑放得下、不蓋別的東西的那一側；終端機點寵物留一行 ----------

import { cases } from './scenarios'
import { cellWidth, drawVector, menuSize, type Rect } from './vector'

const MENU_LABELS = (f: keyof typeof MENUS) => [...MENUS[f].map(i => i.label), '取消']
const cellBox = (r: Rect, row: number) => ({ t: Math.floor(r.y / row), l: Math.floor(r.x), b: Math.ceil((r.y + r.h) / row), r: Math.ceil(r.x + r.w) })

const isFurniture = (h: { what: string }): h is { what: keyof typeof MENUS } & Rect => h.what in MENUS

test('menus open inside the room of the furniture (desktop size includes the frame and title), on every case and both surfaces', () => {
  for (const c of cases()) {
    const v = drawVector(c.crew, c.frame, c.width, c.rows, c.walkers, c.seating, c.opts)
    for (const surface of ['desktop', 'terminal'] as const) {
      const row = surface === 'desktop' ? 2.5 : 2
      for (const it of v.hits) {
        if (!isFurniture(it)) continue
        const labels = MENU_LABELS(it.what)
        const at = menuPlace(it, labels, menuOthers(it, v.hits, v.fixed), surface, 1, c.width)
        const { cw, ch } = menuSize(labels, surface)
        const R = cellBox(it.room!, row)
        const where = `${c.name} ${surface} ${it.what}`
        expect({ where, ok: at.left >= R.l && at.left + cw <= R.r && at.top >= R.t && at.top + ch <= R.b }).toEqual({ where, ok: true })
      }
    }
  }
})

test('menus stay put: same layout, same place, whoever walks or queues or wherever the pet is (jacky G2b)', () => {
  for (const c of cases()) {
    const busy = drawVector(c.crew, c.frame, c.width, c.rows, c.walkers, c.seating, c.opts)
    const calm = drawVector(c.crew, c.frame + 3, c.width, c.rows, [], c.seating, { ...c.opts, queue: [], raid: undefined })
    for (const surface of ['desktop', 'terminal'] as const) {
      for (const it of busy.hits.filter(isFurniture)) {
        const same = calm.hits.find(h => h.what === it.what)!
        const labels = MENU_LABELS(it.what)
        const where = `${c.name} ${surface} ${it.what}`
        expect({ where, at: menuPlace(it, labels, menuOthers(it, busy.hits, busy.fixed), surface, 1, c.width) }).toEqual({ where, at: menuPlace(same, labels, menuOthers(same, calm.hits, calm.fixed), surface, 1, c.width) })
      }
    }
  }
})

test('desktop menus avoid the counter and its YOU sign', () => {
  for (const c of cases()) {
    const v = drawVector(c.crew, c.frame, c.width, c.rows, c.walkers, c.seating, c.opts)
    if (v.fixed.length === 0) continue
    for (const it of v.hits.filter(isFurniture)) {
      if (it.room!.y < 20) continue // 上排房間的選單碰不到走廊的櫃台
      const labels = MENU_LABELS(it.what)
      const at = menuPlace(it, labels, menuOthers(it, v.hits, v.fixed), 'desktop', 1, c.width)
      const { cw, ch } = menuSize(labels, 'desktop')
      const over = v.fixed.map(o => cellBox(o, 2.5)).filter(o => o.l < at.left + cw && at.left < o.r && o.t < at.top + ch && at.top < o.b)
      expect({ where: `${c.name} ${it.what}`, over: over.length }).toEqual({ where: `${c.name} ${it.what}`, over: 0 })
    }
  }
})

test('the meeting menu stays in the meeting room (no longer over the manager room frame)', () => {
  for (const c of cases()) {
    const v = drawVector(c.crew, c.frame, c.width, c.rows, c.walkers, c.seating, c.opts)
    const m = v.hits.find(h => h.what === 'meeting')
    if (!m) continue
    const boss = v.hits.find(h => h.what === 'corgi')!.room!
    const at = menuPlace(m, MENU_LABELS('meeting'), [], 'terminal', 1, c.width)
    expect(at.left + Math.max(...MENU_LABELS('meeting').map(cellWidth)) + 4).toBeLessThanOrEqual(Math.floor(boss.x))
  }
})

test('terminal: clicking the pet leaves a line in the button row for about 5 s (the terminal may not show toasts)', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  const ui = await $.ui.mount(PANE_PROPS)
  await ui.press({ key: 'hit-pet' })
  await new Promise(r => setTimeout(r, 20))
  const note = await ui.find({ type: 'Text', text: /餵|換|小寶寶|山雀|貓/ })
  expect(note).toBeDefined()
  await ui.unmount()
})

// ---------- 0.17.0（G2）：Desktop 撐滿面板、夜間模式在窗戶上、選單深色有框且位置固定 ----------

import { desktopRows, setSpread } from './scene'

const DESK_PANE = (bodyRows: number, bodyColumns = 112) => ({
  plugin: 'pixel-office',
  surface: 'desktop',
  component: 'Pane',
  requestId: 'pixel-office',
  props: { title: '像素辦公室', isFocused: false, bodyColumns, placement: 'dock', scroll: { offset: 0, bodyRows }, view: undefined },
}) as any
const viewH = (src: string) => +src.match(/viewBox="0 0 \d+ (\d+)"/)![1]

test('desktop rows: one desktop row is 2.5/k scene units, so the scene is bodyRows x 1.25 / k rows (at least 44)', () => {
  expect(desktopRows(64, 1)).toBe(80)
  expect(desktopRows(64, 1, 2)).toBe(77)
  expect(desktopRows(100, 1.5)).toBe(83)
  expect(desktopRows(20, 1)).toBe(44)
})

test('desktop: the picture fills the pane height, no hint line, no night button below it', async ($, on) => {
  MOCKS(on, [])
  const ui = await $.ui.mount(DESK_PANE(100))
  const tree: any = await ui.drawn()
  expect(tree.children.map((c: any) => c.type)).toEqual(['Box']) // 只剩場景（Svg＋疊上去的按鈕）
  expect(viewH(String((await ui.find({ type: 'Svg' }))!.props.source))).toBe(250) // 100 列 × 2.5 單位
  expect(await ui.find({ type: 'Text', text: /buttons\.json/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: /夜間模式|開燈/ })).toBeUndefined()
  await ui.unmount()
})

test('desktop: clicking any window toggles night mode', async ($, on) => {
  MOCKS(on, [])
  const ui = await $.ui.mount(DESK_PANE(64))
  const src = async () => String((await ui.find({ type: 'Svg' }))!.props.source)
  expect(await src()).not.toContain('#050a1e')
  expect(await ui.find({ key: 'night-1' })).toBeDefined() // 不只一扇窗
  await ui.press({ key: 'night' })
  expect(await src()).toContain('#050a1e')
  await ui.press({ key: 'night-1' })
  expect(await src()).not.toContain('#050a1e')
  await ui.unmount()
})

test('desktop: a tall pane spreads the extra height between desk clusters, the terminal layout stays as before', async ($, on) => {
  const plain = layout(112, 90).clusters.map(k => k.y)
  setSpread(true)
  const wide = layout(112, 90)
  setSpread(false)
  const ys = [...new Set(wide.clusters.map(k => k.y))]
  const last = ys[ys.length - 1] + 34
  expect(ys[0]).toBeGreaterThan(plain[0])
  expect(180 - last - 18).toBeLessThan(2 * (ys[0] - 34)) // 走廊只多出除不盡的零頭，不是全部堆在那
  expect(layout(112, 90).clusters.map(k => k.y)).toEqual(plain)
  MOCKS(on, [])
  const ui = await $.ui.mount(DESK_PANE(72))
  await ui.unmount()
  expect(layout(112, 90).clusters.map(k => k.y)).toEqual(plain) // 畫過 Desktop，測試這邊的版面照舊
})

test('desktop: the furniture menu is an opaque framed box with a title and dark labels on a light card (Desktop buttons ignore Text color)', async ($, on) => {
  MOCKS(on, [])
  const ui = await $.ui.mount(DESK_PANE(64))
  await ui.press({ key: 'hit-vending' })
  const menu: any = await ui.find({ key: 'menu' })
  expect(menu.props.backgroundColor).toBe('#f4f4f4')
  expect(menu.props.borderStyle).toBe('round')
  expect((await ui.find({ type: 'Text', text: /販賣機/ }))).toBeDefined()
  expect((await ui.find({ key: 'menu-0' }))).toBeDefined()
  await ui.unmount()
})

import { reach, REACH_X, REACH_Y } from './register'
import { drawVector as drawV } from './vector'
import { cases as allCases } from './scenarios'

test('desktop hit areas reach further out but never into a neighbour’s own area', () => {
  const lone = { x: 20, y: 20, w: 4, h: 4 }
  expect(reach(lone, [lone])).toEqual({ x: 20 - REACH_X, y: 20 - REACH_Y, w: 4 + 2 * REACH_X, h: 4 + 2 * REACH_Y })
  for (const c of allCases().filter(c => c.name.startsWith('max'))) {
    const hits = drawV(c.crew, c.frame, c.width, c.rows, c.walkers, c.seating, c.opts).hits
    for (const hit of hits) {
      const z = reach(hit, hits)
      expect(z.x <= hit.x && z.y <= hit.y && z.x + z.w >= hit.x + hit.w && z.y + z.h >= hit.y + hit.h).toBe(true)
      for (const o of hits) if (o !== hit) expect(z.x < o.x + o.w && o.x < z.x + z.w && z.y < o.y + o.h && o.y < z.y + z.h && !(hit.x < o.x + o.w && o.x < hit.x + hit.w && hit.y < o.y + o.h && o.y < hit.y + hit.h)).toBe(false)
    }
  }
})
