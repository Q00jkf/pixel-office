import { test, expect } from 'claude-code/testing'

import type { Coworker } from '../types'
import { parseStatus } from './status'
import { reloadIfIdle, runHr } from './hr'
import { doneNonces, nextCommand } from './register'
import { RELOAD_QUIET_MS, canReloadNow, newerVersion, reloadRefused, shouldReload } from './selfreload'
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
  expect(src).toContain('<use href="#V"') // v2（0.62.0）起 Desktop 畫 v2 素材表（hooks/sheetV2.ts）
  expect(src.length).toBeLessThanOrEqual(131072)
  expect(src).toContain('Microsoft JhengHei') // 0.14.0 起 Desktop 畫向量（vector.ts），不是點陣
  expect(String(svg!.props.alt)).toContain('online')
  // v2 沒有寵物、柯基（使用者 2026-11-22 決定）；家具選單、點窗戶切夜間照舊
  for (const key of ['night', 'hit-printer', 'hit-cabinet', 'hit-mailbox', 'hit-vending', 'hit-meeting']) expect(await ui.find({ key })).toBeDefined()
  for (const key of ['hit-pet', 'hit-corgi']) expect(await ui.find({ key })).toBeUndefined()
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
  expect((await ui.find({ type: 'Svg' }))?.props.alt).toContain('online')
  await ui.unmount()
})

const MOCKS = (on: any, writes: string[], o: { clock?: false } = {}) => {
  on('env.get', () => ({ value: 'C:/Users/tester' }))
  if (o.clock !== false) on('clock.now', () => ({ value: 1_000_000 })) // { clock: false }：測試自己用 mock.clock（要推進時間）
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
  expect((await $.command.run({ command: 'office', args: 'role 主管' } as any)).text).toContain('role=manager')
  expect((await $.command.run({ command: 'office', args: 'name 58' } as any)).text).toContain('name=58')
  expect((await $.command.run({ command: 'office', args: 'name 主管室' } as any)).text).toContain('invalid')
  const last = JSON.parse(writes[writes.length - 1])
  expect(last.role).toBe('manager')
  expect(last.name).toBe('58')
})

test('the model can set its own role through the office_profile tool', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  const out: any = await $.tool.call({ tool: 'mcp__pixel-office__office_profile', role: '主管', name: 'e2' } as any)
  expect(typeof out.result).toBe('string')
  expect(out.result).toContain('manager')
  expect(JSON.parse(writes[writes.length - 1]).role).toBe('manager')
})

// ---------- 固定座位與升遷走路 ----------

import { GEOM, assignSeats, corridorRoute, isAttendee, pathLength, rejoin, route, walkerPos } from './scene'

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

test('changing route mid-walk never teleports: turn back to the counter queue, or back to the seat then on to the new one', () => {
  const staff = P('zed', 'z', 'idle', false, 'staff')
  const pl = assignSeats([staff], 112, 50).get('zed')!
  const go = corridorRoute(pl, queueSpot(112, 50, 0), 112, 50)
  const boss = assignSeats([{ ...staff, role: 'manager' as const }], 112, 50).get('zed')!
  // 走去排隊 6 格後：核准了（回程）／升主管（新路線從座位出發）／從櫃台再去別處（新路線從舊終點出發）
  const fromCounter = [go[go.length - 1], { x: go[go.length - 1].x + 10, y: go[go.length - 1].y }]
  for (const next of [[...go].reverse(), route(pl, boss, 112, 50), fromCounter]) {
    const old = { id: 'zed', path: go, start: 0 }
    const here = walkerPos(old, 6)!
    const w = { id: 'zed', path: rejoin(old, next, 6), start: 6 }
    expect(w.path[w.path.length - 1]).toEqual(next[next.length - 1])
    let prev = here
    for (let f = 6; f < 400; f++) {
      const at = walkerPos(w, f)
      if (!at) break
      expect(Math.abs(at.x - prev.x) + Math.abs(at.y - prev.y)).toBeLessThanOrEqual(GEOM.WALK_SPEED)
      prev = at
    }
  }
  // 核准時直接掉頭：路程只有已走的 12 像素
  const old = { id: 'zed', path: go, start: 0 }
  expect(pathLength(rejoin(old, [...go].reverse(), 6))).toBe(12)
  // 沒在走路就照新路線
  expect(rejoin(undefined, go, 6)).toEqual(go)
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

  expect((await ui.find({ key: 'night' }))?.text).toBe('Night mode')
  await ui.press({ key: 'night' })
  expect((await ui.find({ key: 'night' }))?.text).toBe('Lights on')

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
  expect(out.sections[1].text).toBe(ROLE_SECTION)
  expect(ROLE_SECTION).toContain('roles.md §5')
})

import { MENU_PRESS_MS, ROLE_SECTION, roleNoteDue } from './register'
test('compose skipped by another mod (Desktop-hosted, 2026-11-14): the first prompt carries the section once; never when compose ran', () => {
  expect(roleNoteDue(false, false)).toBe(true)
  expect(roleNoteDue(false, true)).toBe(false) // 已塞過
  expect(roleNoteDue(true, false)).toBe(false) // 系統提示已有，不重複
})

// ---------- 紙飛機、等待核准 ----------

import { PLANE_FRAMES, planePos } from './scene'
import { commandText, findRecipient, waitsForApproval } from './register'

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
  expect(out.result).toContain('agent=user-30')
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
  expect(toasts.some(t => t.includes('u30') && t.includes('approval'))).toBe(true)
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
  expect(lines[0]).toContain('3 online')
  expect(lines[3]).toContain('30') // 主管排第一列
  expect(lines[3]).toContain('協作主管')
  expect(lines[3]).toContain('user-30')
  expect(text).toContain('▶ IT')
  expect(text).toContain('🟡 awaiting approval (Bash)') // 0.11.0：等核准與等輸入分開；沒有 since 就不報秒數
  expect(text).toContain('not registered')
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
  expect(text).toContain('🔴 Name clash')
  expect(text).toContain('wiki-e4 [180a9b]')
  expect(text).toContain('wiki-e4 [019e4b]')
  expect(text).not.toContain('solo [aa11bb]') // 沒撞名的不唱名
})

test('/office title sets a free-text title (Chinese ok) and /office who prints the roster', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  expect((await $.command.run({ command: 'office', args: 'title 系統管理' } as any)).text).toContain('title=系統管理')
  expect(JSON.parse(writes[writes.length - 1]).title).toBe('系統管理')
  expect((await $.command.run({ command: 'office', args: 'title 這個職稱真的非常非常非常非常非常長喔' } as any)).text).toContain('too long')
  const who = (await $.command.run({ command: 'office', args: 'who' } as any)).text!
  expect(who).toContain('Pixel office roster')
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
  expect((await ui.find({ type: 'Text', text: /buttons\.json/ }))?.text).toContain('Personal buttons')
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
  expect((await $.command.run({ command: 'office', args: 'auto maybe' } as any)).text).toContain('Usage')
  const who = (await $.command.run({ command: 'office', args: 'who' } as any)).text!
  expect(who).toContain(' (auto)')
  expect((await $.command.run({ command: 'office', args: 'auto off' } as any)).text).toContain('waits for approval')
  expect(JSON.parse(writes[writes.length - 1]).auto).toBeUndefined()
})

test('the model can declare auto mode through office_profile', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  const out: any = await $.tool.call({ tool: 'mcp__pixel-office__office_profile', auto: true } as any)
  expect(out.result).toContain('mode=auto')
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
  expect(out.result).toContain('nameplate set automatically to 55')
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
  expect(text).toContain('🔴 Blocked: ff')
  expect(text).toContain('blocked (Write) for 5 min')
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
  expect((await $.command.run({ command: 'office', args: 'buttons' } as any)).text).toContain('Loaded 3 personal buttons')
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
  expect((await $.command.run({ command: 'office', args: 'team user-30 [b0fe80]' } as any)).text).toContain('team=user-30')
  expect(JSON.parse(writes[writes.length - 1]).team).toBe('user-30')
  expect((await $.command.run({ command: 'office', args: 'who' } as any)).text).toContain('under user-30')
  expect((await $.command.run({ command: 'office', args: 'team off' } as any)).text).toContain('team cleared')
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

test('after /clear the new session id has no saved identity: name, role, team and title carry over (0.63.62)', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  let sid = 'aaaa1111'
  const files: Record<string, string> = {
    'sessions/aaaa1111.json': JSON.stringify({ id: 'aaaa1111', name: 'worker', role: 'staff', team: 'boss1', title: 'tester', updatedAt: 0, left: true }),
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
  expect(JSON.parse(files['sessions/aaaa1111.json']).team).toBe('boss1')

  sid = 'cccc3333' // /clear：同一個程序換到全新的編號
  await clock.advance(5000)
  const now = JSON.parse(files['sessions/cccc3333.json'])
  expect(now.left).toBe(false)
  expect(now.name).toBe('worker')
  expect(now.team).toBe('boss1')
  expect(now.title).toBe('tester')
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
  expect(String(((await $.command.run({ command: 'office', args: 'bite' } as any)) as any).text)).toContain('Open the office panel with /office first')
  const ui = await $.ui.mount(PANE_PROPS)
  await $.command.run({ command: 'office', args: 'bite' } as any) // 只有自己（員工）：咬自己
  const again = await $.command.run({ command: 'office', args: 'bite' } as any)
  expect(String((again as any).text)).toContain('The cat is still out')
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
  expect(String((r1 as any).text)).toContain('baby')
  expect(kept.pet).toBe('baby')
  const r2 = await $.command.run({ command: 'office', args: 'pet' } as any)
  expect(String((r2 as any).text)).toContain('tit') // 依序：貓 → 寶寶 → 山雀 → 貓
  expect(kept.pet).toBe('bird')
  await $.command.run({ command: 'office', args: 'pet 銀喉長尾山雀' } as any)
  expect(kept.pet).toBe('bird')
  await $.command.run({ command: 'office', args: 'pet cat' } as any)
  expect(kept.pet).toBe('cat')
  const bad = await $.command.run({ command: 'office', args: 'pet dog' } as any)
  expect(String((bad as any).text)).toContain('Usage')
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
  expect(JSON.stringify(started)).toContain('walk into the meeting room')
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
  expect(String(r.text)).toContain('No meeting right now')
  // 對照：參與者有人在線（自己，名牌預設 me）→ 開會中
  files['meeting.json'] = JSON.stringify({ until: Number.MAX_SAFE_INTEGER, topic: 't', participants: ['ghost', 'me'] })
  await $.command.run({ command: 'office', args: '' } as any)
  const on2: any = await $.command.run({ command: 'office', args: 'meeting' } as any)
  expect(String(on2.text)).toContain('In a meeting')
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
  expect(text).toContain('🟡 awaiting approval 42s (Bash)')
  expect(text).toContain('| waiting for input (5 min) |')
  expect(text).toContain('just finished, waiting for input')
  expect(text).toContain('| waiting for input |') // 不到 1 分鐘不報分鐘數
})

test('an error keeps a one-line summary of at most 80 characters, shown in the roster for 10 minutes', () => {
  expect(summarizeError('\n  Exit code 1\n  stack...')).toBe('Exit code 1')
  expect(summarizeError('a   b\tc')).toBe('a b c')
  expect([...summarizeError('錯'.repeat(100))]).toHaveLength(80)
  const NOW = 20 * MIN
  const err = { text: 'Exit code 1', at: NOW - 2 * MIN }
  expect(roster([{ ...P('a', 'x', 'error'), tool: 'Bash', lastError: err }], NOW)).toContain('error (Bash): Exit code 1')
  expect(roster([{ ...P('a', 'x', 'thinking'), lastError: err }], NOW)).toContain('thinking · last error 2 min ago: Exit code 1')
  expect(roster([{ ...P('a', 'x', 'thinking'), lastError: { ...err, at: 0 } }], NOW)).not.toContain('last error')
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
  expect(text).toContain('| 幫我把請購單 (auto) |')
  expect(text).toContain('| FOG 論文 |')
  expect(text).toContain('| 請購單 (set 40 min ago) |')
  expect(text).toContain(' · latest prompt "改辦公室的貓"')
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
  expect(text).toContain('(no name) SendMessage with `to=uds:/tmp/cc-msg-abc`') // code 格式：模型照抄才不會吃掉反斜線
  expect(text).toContain('| user-30 |') // 有名稱就照舊顯示名稱
  expect(text).toContain('(not registered, messages cannot reach it)') // 舊版沒有位址
  expect(findRecipient(crew, 'uds:/tmp/cc-msg-abc')?.id).toBe('a') // 寄到位址也畫得出紙飛機
})

test('an error stays visible in the roster after the turn ends (error → done → idle)', () => {
  const NOW = 20 * MIN
  const lastError = { text: 'Exit code 1', at: NOW - 3 * MIN }
  const done = roster([{ ...P('a', 'x', 'done'), lastError }], NOW)
  const idle = roster([{ ...P('a', 'x', 'idle'), since: NOW - 2 * MIN, lastError }], NOW)
  expect(done).toContain('just finished, waiting for input · last error 3 min ago: Exit code 1')
  expect(idle).toContain('waiting for input (2 min) · last error 3 min ago: Exit code 1')
  expect(roster([{ ...P('a', 'x', 'idle'), lastError: { ...lastError, at: 0 } }], NOW)).not.toContain('last error') // 10 分鐘後收掉
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
  expect(broken.logs[0]).toContain('corrupt')
  const terminal = fakeIO([undefined, undefined, decided()], { settledAt: 300 }) // 終端機先按了：之後才到的決定也不採用
  expect(await waitForDecision(terminal.io, WANT, 8500)).toBeUndefined()
})

// 使用者 2026-11-26 接受的已知行為（顧問改版裁示：不用在場驗證，防線改成留證據）：照 approvals 檔抄出四項、
// 寫進 decisions 檔的 allow 會被採用。這條是回歸測試：哪天改了這個行為，要先回頭問使用者，不是悄悄修掉
test('known, accepted by the user 2026-11-26: a fully matching "allow" written into the decision file is taken (evidence goes to approve-log instead)', async () => {
  const h = await textHash('rm -rf ~')
  const files: Record<string, string> = {}
  const f = slipIO(files)
  f.onTick(() => { if (files.decision === TOMBSTONE) files.decision = decided({ session: 's1', toolUseId: 'toolu_9', nonce: 'fresh-nonce', textHash: h }) })
  expect(await runSlip(f.io as any, { session: 's1', name: 'impl' }, 'toolu_9', 'Bash', 'rm -rf ~', 8500)).toBe('allow')
})

test('approve-log entry for an adopted decision: time, own session, tool, first 200 chars, allow/deny, source (panel-file or phone)', () => {
  const long = 'x'.repeat(250)
  const a = JSON.parse(adoptedEntry({ at: 5, session: 's1', name: 'impl', tool: 'Bash', text: long, decided: { behavior: 'allow' }, phone: false }))
  expect(a).toEqual({ at: 5, kind: 'adopted', id: 's1', name: 'impl', tool: 'Bash', text: 'x'.repeat(200), behavior: 'allow', via: 'panel-file' })
  const b = JSON.parse(adoptedEntry({ at: 6, session: 's1', name: 'impl', tool: 'Edit', text: 'a\nb', decided: { behavior: 'deny', message: 'no', via: 'phone' }, phone: true }))
  expect(b).toMatchObject({ behavior: 'deny', via: 'phone', text: 'a\nb' })
  expect(adoptedEntry({ at: 7, session: 's', name: 'n', tool: 't', text: 'x', decided: { behavior: 'allow' }, phone: false })).not.toContain('\n') // 一筆一行
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

import { adoptedEntry, runSlip } from './register'

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
  expect(roster([c], 5000)).toContain('reviewable in office panel')
  expect(roster([P('a', 'a'), c], 5000).split('\n')[0]).toBe('🟡🟡 Waiting for your approval (open the office panel, press "Review <name>"): w (Bash, 5s left)') // 第一行最醒目
  expect(roster([c], 9500)).not.toContain('Waiting for your approval')
  expect(roster([{ ...c, approval: undefined }], 5000)).not.toContain('reviewable in office panel')
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
  expect((await ui.findAll({ type: 'Text' } as any)).map((t: any) => t.text).join(' ')).toContain('3s left')
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
  expect((await ui.findAll({ type: 'Text' } as any)).map((t: any) => t.text).join(' ')).not.toContain('Approvals on')
  // 打開：狀態檔帶 approve、面板頂端常駐提示、看得到單
  const text: any = await $.command.run({ command: 'office', args: 'approve on' } as any)
  expect(String(text?.text ?? text)).toContain('approvals on')
  await $.command.run({ command: 'office', args: '' } as any)
  const after = JSON.parse(files[Object.keys(files).find(k => k.startsWith('sessions/') && k !== 'sessions/bbbb.json')!])
  expect(after.approve).toBe(true)
  expect((await ui.findAll({ type: 'Text' } as any)).map((t: any) => t.text)).toContain('Approvals on (/office approve off to turn off)')
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
  expect(MENUS.printer.map(i => i.label)).toEqual(['Recent mail', 'Write mail', 'Drafts'])
  expect(MENUS.cabinet.map(i => i.prompt)).toEqual(['/llm-wiki:wiki-repo list', '/llm-wiki:wiki-query', 'Search Google Drive for files: ask me for keywords first'])
  expect(MENUS.mailbox.map(i => i.label)).toEqual(['Status', 'pull', 'push', 'Recent commits'])
  expect(MENUS.calendar.map(i => i.prompt)).toEqual(['/llm-wiki:wiki-agenda', '/llm-wiki:wiki-agenda add'])
  expect(MENUS.vending.map(i => i.prompt)).toEqual(['/llm-wiki:wiki-doctor', '/llm-wiki:wiki'])
  expect(MENUS.clock.map(i => i.prompt)).toEqual(['/llm-wiki:wiki-day 開工', '/llm-wiki:wiki-day 收工'])
  expect(MENUS.meeting).toEqual([{ label: 'Meeting', prompt: '/pixel-office:team start a meeting' }])
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
  MOCKS(on, writes, { clock: false })
  const clock = mock.clock(on, { now: 1_000_000 })
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
  // 選單美術第三批 P1：選單外觀畫在 v2 的 SVG 裡（字也在 SVG），上面疊看不見的按鈕
  const scene = async () => String(((await ui.find({ type: 'Svg' })) as any)?.props?.source ?? '')
  await ui.press({ key: 'hit-printer' })
  expect(await ui.find({ key: 'menu-0' })).toBeDefined()
  expect(await ui.find({ key: 'menu-cancel' })).toBeDefined()
  expect(await scene()).toContain('Recent mail')
  expect(await scene()).toContain('影印機')
  await ui.press({ key: 'hit-mailbox' }) // 換一件：同時只開一個
  expect(await scene()).toContain('Status')
  expect(await scene()).not.toContain('Recent mail')
  expect(await ui.find({ key: 'menu-4' })).toBeUndefined()
  await ui.press({ key: 'menu-0' }); await clock.advance(MENU_PRESS_MS + 50)
  expect(submitted.some(e => e.text === 'git status, and summarize it in a sentence or two')).toBe(true)
  expect(await ui.find({ key: 'menu' })).toBeUndefined()
  await ui.press({ key: 'hit-calendar' })
  await ui.press({ key: 'menu-0' }); await clock.advance(MENU_PRESS_MS + 50) // 斜線開頭：當指令跑
  expect(ran.some(e => e.command === 'llm-wiki:wiki-agenda')).toBe(true)
  await ui.press({ key: 'hit-clock' })
  await ui.press({ key: 'menu-cancel' }); await clock.advance(MENU_PRESS_MS + 50)
  expect(await ui.find({ key: 'menu' })).toBeUndefined()
  await ui.press({ key: 'hit-meeting' })
  await ui.press({ key: 'hit-meeting' }) // 再點同一件：收起來
  expect(await ui.find({ key: 'menu' })).toBeUndefined()
  await ui.unmount()
})

test('desktop: a user menu from buttons.json replaces the default; old-format entries still draw in the row', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes, { clock: false })
  const clock = mock.clock(on, { now: 1_000_000 })
  on('fs.read', () => ({ value: JSON.stringify([{ object: 'printer', label: '查信', prompt: '查信件' }, { label: '說嗨', prompt: 'hi there' }]) }))
  const submitted: any[] = []
  on('prompt.submit', (_$, e: any) => {
    submitted.push(e)
    return { text: e.text } as any
  })
  expect((await $.command.run({ command: 'office', args: 'buttons' } as any)).text).toContain('Custom furniture menus: printer')
  const ui = await $.ui.mount(DESKTOP())
  expect((await ui.find({ key: 'mine-0' }))?.text).toBe('說嗨')
  expect(await ui.find({ key: 'mine-1' })).toBeUndefined() // 家具項目不在底下那排
  await ui.press({ key: 'hit-printer' })
  expect(await ui.find({ key: 'menu-0' })).toBeDefined()
  expect(String(((await ui.find({ type: 'Svg' })) as any)?.props?.source ?? '')).toContain('查信')
  expect(await ui.find({ key: 'menu-1' })).toBeUndefined()
  await ui.press({ key: 'menu-0' }); await clock.advance(MENU_PRESS_MS + 50)
  expect(submitted.some(e => e.text === '查信件')).toBe(true)
  await ui.unmount()
})

test('desktop: the hit area covers the whole thing with blank plain buttons; at 48 columns the v2 office is scaled down, clock and all, and still clickable', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  const ui = await $.ui.mount(DESKTOP())
  const pr: any = await ui.find({ key: 'hit-printer' })
  expect(pr.props.plain).toBe(true)
  expect(String(pr.props.label)).toMatch(/^⠀+$/) // 盲文空白：看不見，但不像空白會被 Desktop 壓掉
  expect(String(pr.props.label).length).toBeGreaterThanOrEqual(6)
  expect(await ui.find({ key: 'hit-printer-1' })).toBeDefined() // 不只一列
  await ui.unmount()
  // v2（0.62.0）：窄面板是整張等比例縮小，不像原本的向量版拿掉時鐘；也沒有寵物
  const narrow = await $.ui.mount(DESKTOP(48, 80))
  expect(await narrow.find({ key: 'hit-clock' })).toBeDefined()
  expect(await narrow.find({ key: 'hit-printer' })).toBeDefined()
  expect(await narrow.find({ key: 'hit-pet' })).toBeUndefined()
  await narrow.unmount()
})

test('terminal: the pet, printer, cabinet, mailbox and meeting table get a one-cell button; desktop-only things do not', async ($, on) => {
  const writes: string[] = []
  MOCKS(on, writes)
  const ui = await $.ui.mount(PANE_PROPS)
  for (const k of ['hit-pet', 'hit-printer', 'hit-cabinet', 'hit-mailbox']) expect(await ui.find({ key: k })).toBeDefined()
  for (const k of ['hit-corgi', 'hit-vending', 'hit-clock', 'hit-calendar']) expect(await ui.find({ key: k })).toBeUndefined()
  await ui.press({ key: 'hit-mailbox' })
  expect((await ui.find({ key: 'menu-0' }))?.text).toBe('Status')
  await ui.unmount()
})

// ---------- 0.16.1：選單挑放得下、不蓋別的東西的那一側；終端機點寵物留一行 ----------

import { cases } from './scenarios'
import { cellWidth, drawVector, menuSize, type Rect } from './vector'

const MENU_LABELS = (f: keyof typeof MENUS) => [...MENUS[f].map(i => i.label), 'Cancel']
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
  const note = await ui.find({ type: 'Text', text: /feed|cat|baby|tit/i })
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
  // v2（0.62.0）：SVG 寬 112 欄 × 8 px、高照面板 100 列 × 20 px 撐滿（viewBox 是「格」，比例一樣）
  const src = String((await ui.find({ type: 'Svg' }))!.props.source)
  const [, pw, ph] = src.match(/width="(\d+)" height="(\d+)"/)!.map(Number)
  expect(pw).toBe(112 * 8)
  expect(ph).toBeGreaterThanOrEqual(100 * 20 - 1)
  expect(viewH(src)).toBeGreaterThan(250)
  expect(await ui.find({ type: 'Text', text: /buttons\.json/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: /Night mode|Lights on/ })).toBeUndefined()
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

test('desktop: the furniture menu is drawn into the office picture (framed card, Chinese title, gold buttons) with invisible buttons on top (選單美術第三批 P1)', async ($, on) => {
  MOCKS(on, [])
  const ui = await $.ui.mount(DESK_PANE(64))
  await ui.press({ key: 'hit-vending' })
  expect(await ui.find({ key: 'menu' })).toBeDefined()
  const src = String(((await ui.find({ type: 'Svg' })) as any)?.props?.source ?? '')
  expect(src).toMatch(/<g class="menu( menu-in)?">/) // 剛打開那次有滑入（0.62.17）
  expect(src).toContain('販賣機')
  expect(src).toContain('取消')
  const b: any = await ui.find({ key: 'menu-0' })
  expect(b).toBeDefined()
  expect(b.props.plain).toBe(true)
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

// ---------- 0.19.0（G4）：claude -p 一次性對話不畫成員工、--name 當名牌、me.json 垃圾檔 ----------

import { launchPlate, oneshotGroups, oneshotText, v2List } from './register'
import { assign as assignV2, emptyStore as emptyV2 } from './officeV2'
import { isCommandName, shortCode, shownName } from './scene'

test('one-shot groups: --name prefix before the first dash, no --name is 一次性, biggest first', () => {
  const o = (id: string, label?: string) => ({ ...P(id, id), oneshot: true, label })
  const g = oneshotGroups([o('a', 'API-標籤正本-02-3'), o('b', 'API-標籤正本-02-4'), o('c'), o('d', 'nightly')])
  expect(g).toEqual([{ label: 'API', n: 2 }, { label: 'nightly', n: 1 }, { label: 'one-shot', n: 1 }])
  expect(oneshotText(g)).toBe('⚙ API ×2　⚙ nightly ×1　⚙ one-shot ×1')
})

test('--name as the default plate: ASCII only, cut to 12, at least 2 characters', () => {
  expect(launchPlate('API-probe-01-1')).toBe('API-probe-01')
  expect(launchPlate('ofimpl')).toBe('ofimpl')
  expect(launchPlate('!cat ~/.claude/x')).toBeUndefined() // 美術 A #14：指令當名字不採用
  expect(launchPlate('/compact')).toBeUndefined()
  // 審查 ④：伺服器名冊、Desktop 面板、啟動名同一條短代號規則
  expect(shownName({ name: '!cat ~/.cl', id: 'abcd1234-5678' })).toBe('s-abcd')
  expect(shownName({ name: '  /compact', id: 'codex-9f8e7d6c' })).toBe('s-9f8e')
  expect(shownName({ name: 'ofimpl', id: 'abcd1234' })).toBe('ofimpl')
  expect(isCommandName('!x')).toBe(true)
  expect(isCommandName('像素工程師')).toBe(false)
  expect(shortCode('agy-12345678')).toBe('s-1234')
  expect(launchPlate('辦公室實作')).toBeUndefined()
  expect(launchPlate('6a主管')).toBe('6a')
  expect(launchPlate(undefined)).toBeUndefined()
})

test('the roster leaves one-shot runs out and counts them on one line', () => {
  const out = roster([P('a', 'alpha')], 1_000_000, [{ label: 'API', n: 3 }])
  expect(out).toContain('alpha')
  expect(out).toContain('One-shot conversations (claude -p, not listed): ⚙ API ×3')
  expect(roster([], 1_000_000, [{ label: 'API', n: 1 }])).toContain('⚙ API ×1')
})

const G4_FILES = (NOW: number): Record<string, string> => ({
  'sessions/g4b.json': JSON.stringify({ id: 'g4b', name: 'hub', role: 'staff', mode: 'typing', tool: 'Bash', updatedAt: NOW - 1000, left: false }),
  'sessions/g4k1.json': JSON.stringify({ id: 'g4k1', name: 'kb', role: 'staff', mode: 'typing', tool: 'Bash', oneshot: true, label: 'API-標籤正本-02-3', updatedAt: NOW - 1000, left: false }),
  'sessions/g4k2.json': JSON.stringify({ id: 'g4k2', name: 'kb', role: 'staff', mode: 'thinking', tool: '', oneshot: true, label: 'API-標籤正本-02-4', updatedAt: NOW - 1000, left: false }),
  'sessions/g4k3.json': JSON.stringify({ id: 'g4k3', name: 'kb', role: 'staff', mode: 'idle', tool: '', oneshot: true, updatedAt: NOW - 1000, left: false }),
})
const G4_MOCKS = (on: any, files: Record<string, string>, NOW: number, env: Record<string, string> = {}) => {
  on('env.get', (_$: any, e: any) => ({ value: env[e.name] ?? 'C:/Users/tester' }))
  on('clock.now', () => ({ value: NOW }))
  on('fs.list', () => ({ value: Object.keys(files).filter(k => k.startsWith('sessions/')).map(k => ({ name: k.slice(9), kind: 'file', size: 1, mtimeMs: NOW, isLink: false })) }) as any)
  on('fs.read', (_$: any, e: any) => ({ value: files[e.path.split(/[\\/]/).slice(-2).join('/')] ?? '{}' }))
  on('fs.write', (_$: any, e: any) => {
    files[e.path.split(/[\\/]/).slice(-2).join('/')] = e.text
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('classic.SessionStart', () => ({}) as any)
}

test('one-shot runs never sit at a desk: the terminal shows a badge line, the desktop a badge, the roster a count', async ($, on) => {
  const NOW = 1_000_000
  const files = G4_FILES(NOW)
  G4_MOCKS(on, files, NOW)
  await $.command.run({ command: 'office', args: '' } as any)
  const ui = await $.ui.mount({ ...PANE_PROPS, viewport: { columns: 140, rows: 46 } })
  const raster = await ui.find({ type: 'Raster', key: 'scene' })
  const p = raster!.props as { cells: string; columns: number; rows: number }
  const text = cellText(p.cells, p.columns, p.rows).join('\n')
  expect(text).toContain('hub')
  expect(text).not.toContain('kb')
  expect((await ui.find({ type: 'Text', text: /⚙/ }))?.text).toContain('⚙ API ×2　⚙ one-shot ×1')
  await ui.unmount()

  const desk = await $.ui.mount({ ...PANE_PROPS, surface: 'desktop', props: { ...PANE_PROPS.props, bodyColumns: 112, scroll: { offset: 0, bodyRows: 64 } } } as any)
  const svg = String((await desk.find({ type: 'Svg' }))!.props.source)
  expect(svg).toContain('⚙ API ×2')
  expect(svg).toContain('⚙ one-shot ×1')
  expect(svg).not.toContain('>kb<')
  await desk.unmount()

  const who = (await $.command.run({ command: 'office', args: 'who' } as any)).text as string
  expect(who).toContain('hub')
  expect(who).not.toMatch(/\| kb \|/)
  expect(who).toContain('⚙ API ×2')
})

const G4_START = (on: any, files: Record<string, string>, sid: string) => {
  on('command.register', () => ({ value: undefined }) as any)
  on('tool.register', () => ({ value: undefined }) as any)
  on('session.start', (_$: any, e: any) => e)
  on('session.id', () => ({ value: sid }) as any)
  on('session.cwd', () => ({ value: 'C:/work/kb' }) as any)
  mock.store(on)
}

test('claude -p with --name: classic SessionStart first leaves no me.json, then the run publishes oneshot + label under its own id', async ($, on) => {
  const NOW = 1_000_000
  const files: Record<string, string> = {}
  G4_MOCKS(on, files, NOW)
  G4_START(on, files, 'p1')
  await ($ as any).classic.SessionStart({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'p1', transcript_path: '', cwd: 'C:/work/kb', session_title: 'API-標籤正本-02-3' })
  expect(files['sessions/me.json']).toBeUndefined()
  await ($ as any).session.start({ cwd: 'C:/work/kb', surface: null, isInteractive: false })
  const mine = JSON.parse(files['sessions/p1.json'])
  expect(mine.oneshot).toBe(true)
  expect(mine.label).toBe('API-標籤正本-02-3')
  expect(files['sessions/me.json']).toBeUndefined()
})

test('a Claude Desktop session (SDK, isInteractive false) is an employee again once the desktop app attaches', async ($, on) => {
  const NOW = 1_000_000
  const files: Record<string, string> = {}
  G4_MOCKS(on, files, NOW)
  G4_START(on, files, 'd1')
  on('session.attach', (_$: any, e: any) => ({ clientId: e.clientId }) as any)
  await ($ as any).session.start({ cwd: 'C:/work/kb', surface: null, isInteractive: false })
  expect(JSON.parse(files['sessions/d1.json']).oneshot).toBe(true)
  await ($ as any).session.attach({ surface: 'desktop', clientId: 'desktop:default' })
  const mine = JSON.parse(files['sessions/d1.json'])
  expect(mine.oneshot).toBeUndefined()
  expect(mine.left).toBe(false)
})

test('a Remote Control (bridge) session is an employee from the start, not a one-shot', async ($, on) => {
  const NOW = 1_000_000
  const files: Record<string, string> = {}
  G4_MOCKS(on, files, NOW, { CLAUDE_CODE_ENVIRONMENT_KIND: 'bridge' })
  G4_START(on, files, 'r1')
  await ($ as any).session.start({ cwd: 'C:/work/kb', surface: null, isInteractive: false })
  const mine = JSON.parse(files['sessions/r1.json'])
  expect(mine.oneshot).toBeUndefined()
  expect(mine.left).toBe(false)
})

test('the session records its own CLAUDE_CONFIG_DIR in its status file; unset, nothing is written', async ($, on) => {
  const NOW = 1_000_000
  const files: Record<string, string> = {}
  G4_MOCKS(on, files, NOW, { CLAUDE_CONFIG_DIR: 'C:/Users/u/.claude-a' })
  G4_START(on, files, 'c1')
  await ($ as any).session.start({ cwd: 'C:/work/kb', surface: 'terminal', isInteractive: true })
  expect(JSON.parse(files['sessions/c1.json']).configDir).toBe('C:/Users/u/.claude-a')
})

test('no CLAUDE_CONFIG_DIR, no configDir field', async ($, on) => {
  const NOW = 1_000_000
  const files: Record<string, string> = {}
  G4_MOCKS(on, files, NOW, { CLAUDE_CONFIG_DIR: '' })
  G4_START(on, files, 'c2')
  await ($ as any).session.start({ cwd: 'C:/work/kb', surface: 'terminal', isInteractive: true })
  expect(JSON.parse(files['sessions/c2.json']).configDir).toBeUndefined()
})

test('an interactive session started with --name gets it as its plate instead of the folder name; not marked one-shot', async ($, on) => {
  const NOW = 1_000_000
  const files: Record<string, string> = {}
  G4_MOCKS(on, files, NOW)
  G4_START(on, files, 'i1')
  await ($ as any).session.start({ cwd: 'C:/work/kb', surface: 'terminal', isInteractive: true })
  expect(JSON.parse(files['sessions/i1.json']).name).toBe('kb')
  await ($ as any).classic.SessionStart({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'i1', transcript_path: '', cwd: 'C:/work/kb', session_title: 'drill2' })
  const mine = JSON.parse(files['sessions/i1.json'])
  expect(mine.name).toBe('drill2')
  expect(mine.oneshot).toBeUndefined()
})

// ---------- 0.21.0：手機直立（只有 2 欄）一隊一組桌、同名編號 ----------

import { zoneUnits } from './scene'
import { fitLabel, sameNameNumbers, vectorSvg } from './vector'

test('with only 2 columns but several rows (phone portrait) each team gets a whole row of desks, so two teams never share a frame', () => {
  expect(zoneUnits(layout(64, 63))).toEqual([[0, 1], [2, 3]]) // 一隊一整排、由上往下
  zoneUnits(layout(112, 60)).forEach((u, z) => expect(u.every(i => i % 3 === 2 - z)).toBe(true)) // 3 欄：照舊一隊一欄、最右先
  // jacky 2026-10-27 手機截圖的組合：兩位主管、各自的 peer、四個沒 team 的人 → 要 3 排（伺服器會把畫面加長）
  const a = boss('a', 'office', 'office-agent')
  const b = boss('b', '6a', 'willy')
  const crew = [a, b, { ...P('of', 'ofimpl'), team: 'office' }, ...['impl', 'r2', 'test'].map(n => ({ ...P(n, n), team: 'willy' })), ...['drill', 'w1', 'w2', 'fin'].map(n => P(n, n))]
  let rows = 63
  while (layout(64, rows).clusters.length < 6) rows += 1
  const seats = assignSeats(crew, 64, rows)
  const row = (id: string) => Math.floor(seats.get(id)!.slot / 8)
  expect(row('of')).toBe(0) // 第一位主管：第一排
  for (const n of ['impl', 'r2', 'test']) expect(row(n)).toBe(1) // 第二位主管：第二排，三個人都在
  for (const n of ['drill', 'w1', 'w2', 'fin']) expect(row(n)).toBe(2) // 沒 team 的坐最下面那排
  const svg = vectorSvg(drawVector(crew, 0, 64, rows, [], seats))
  expect(svg).toContain('TEAM office')
  expect(svg).toContain('TEAM 6a')
})

test('people with the same name get ① ② on their plate, and truncation keeps the number', () => {
  const crew = [P('b', 'LLM-Wiki-AEGIVERSE'), P('a', 'LLM-Wiki-AEGIVERSE'), P('c', 'drill')]
  const no = sameNameNumbers(crew)
  expect(no.get('a')).toBe('①')
  expect(no.get('b')).toBe('②')
  expect(no.has('c')).toBe(false)
  const t = fitLabel('LLM-Wiki-AEGIVERSE', 8, 1.9, '②').text
  expect(t.endsWith('②')).toBe(true)
  expect(t.startsWith('LLM')).toBe(true)
})

// ---------- 0.22.0：手機下命令 ----------

test('a command from the phone is submitted once as the user\'s own words with 📱, and never twice after a reload', async ($, on) => {
  const NOW = 1_000_000
  const clock = mock.clock(on, { now: NOW })
  const files: Record<string, string> = {
    'commands/aaaa1111.json': JSON.stringify({ nonce: 'n1', text: '整理一下今天的進度', at: NOW - 1000 }),
    'commands/cccc.json': JSON.stringify({ nonce: 'n9', text: '別人的', at: NOW }),
  }
  const submitted: any[] = []
  on('env.get', () => ({ value: 'C:/Users/tester' }))
  on('fs.list', () => ({ value: [] }))
  const key = (path: string) => path.split(/[\\/]/).slice(-2).join('/')
  on('fs.exists', (_$: any, e: any) => ({ value: key(e.path) in files }) as any)
  on('fs.read', (_$: any, e: any) => ({ value: files[key(e.path)] ?? '{}' }))
  on('fs.write', (_$: any, e: any) => {
    files[key(e.path)] = e.text
    return { value: undefined }
  })
  on('prompt.submit', (_$, e: any) => {
    submitted.push(e)
    return { text: e.text } as any
  })
  on('turn.complete', () => ({ text: '' }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('tool.register', () => ({ value: undefined }) as any)
  on('session.start', (_$: any, e: any) => e)
  on('session.id', () => ({ value: 'aaaa1111' }) as any)
  on('session.cwd', () => ({ value: 'C:/Users/user' }) as any)
  mock.store(on)
  await ($ as any).session.start({ cwd: 'C:/Users/user', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(submitted.map(e => [e.text, e.origin?.asUser ?? e.asUser])).toEqual([['📱 整理一下今天的進度', true]])
  expect(JSON.parse(files['commands/aaaa1111.done.json']).nonce).toBe('n1')
  expect(JSON.parse(files['sessions/aaaa1111.json']).mode).toBe('thinking') // 0.63.62：送進去就算工作中（自己的 prompt.submit 掛點聽不到）
  // 那一輪講完：回覆寫到 replies/，帶上手機那道命令；子代理的不寫、下一輪不再帶命令
  await ($ as any).turn.complete({ answer: '進度：A 完成、B 進行中', durationMs: 5, isAborted: false, turnId: 't1' })
  await clock.advance(1)
  expect(JSON.parse(files['replies/aaaa1111.json'])).toMatchObject({ text: '進度：A 完成、B 進行中', ask: '整理一下今天的進度' })
  await ($ as any).turn.complete({ answer: '子代理的報告', durationMs: 5, isAborted: false, turnId: 't2', agentId: 'ag1' })
  await clock.advance(1)
  expect(JSON.parse(files['replies/aaaa1111.json']).text).toBe('進度：A 完成、B 進行中')
  await ($ as any).turn.complete({ answer: 'x'.repeat(9000), durationMs: 5, isAborted: false, turnId: 't3' })
  await clock.advance(1)
  const long = JSON.parse(files['replies/aaaa1111.json'])
  expect(long.ask).toBeUndefined()
  expect(long.text.endsWith('(truncated)')).toBe(true)
  // 重載外掛（模組變數歸零）也靠 done 檔不再送
  await ($ as any).session.start({ cwd: 'C:/Users/user', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  expect(submitted).toHaveLength(1)
  // 超過 10 分鐘沒被收的命令作廢
  files['commands/aaaa1111.json'] = JSON.stringify({ nonce: 'n2', text: '太舊了', at: NOW - 11 * 60 * 1000 })
  await clock.advance(3000)
  expect(submitted).toHaveLength(1)
})

// ---------- 0.24.0：/office 自己跑 ListAgents 登記 ----------

test('/office runs ListAgents itself (no model) to register the ListAgents name; unnamed sessions and permission prompts are reported', async ($, on) => {
  mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const files: Record<string, string> = {}
  const key = (path: string) => path.split(/[\/]/).slice(-2).join('/')
  on('env.get', () => ({ value: 'C:/Users/tester' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.read', (_$: any, e: any) => ({ value: files[key(e.path)] ?? '{}' }))
  on('fs.write', (_$: any, e: any) => {
    files[key(e.path)] = e.text
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'ffff0001' }) as any)
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('session.surfaces', () => ({ value: ['desktop'] }) as any)
  let decision = 'allow'
  let listing = 'Peer sessions (1):\n  x [111111]\n\nThis session is Daily check [2b3c4d]'
  on('tool.check', () => ({ decision }) as any)
  on('tool.call', { tool: 'ListAgents' }, () => ({ result: listing }) as any)
  const out = await $.command.run({ command: 'office', args: '' } as any)
  expect(out.text).toContain('ListAgents name Daily check [2b3c4d]')
  expect((await $.command.run({ command: 'office', args: 'who' } as any)).text).toContain('Daily check') // 名單上有了
  listing = 'Peer sessions (1):\n  x [111111]'
  expect((await $.command.run({ command: 'office', args: '' } as any)).text).toContain('/rename')
  decision = 'ask'
  expect((await $.command.run({ command: 'office', args: '' } as any)).text).toContain('Could not register')
})

// ---------- 0.25.0：部門主管（第 2 層）、降層提醒（jacky 2026-10-29） ----------

import { isDeptLead } from './scene'
import { DEMOTE_MS, hasReports, isLayer2, shouldRemindDemote, shouldRemindPromote } from './register'

test('a manager with team on another online manager is a department lead: sits first in their own zone, not in the manager office', () => {
  const top = boss('t', 'tt', 'm-t')
  const dept = { ...boss('d', 'dd', 'm-d'), team: 'm-t' }
  const crew = [top, dept, { ...P('s1', 's1'), team: 'm-d' }, { ...P('s2', 's2'), team: 'm-t' }]
  expect(isDeptLead(dept, crew)).toBe(true)
  expect(isDeptLead(top, crew)).toBe(false)
  expect(isDeptLead(dept, [dept])).toBe(false) // 上一層主管不在線：照舊當主管
  // 互相掛不算，免得主管室沒人
  expect(isDeptLead({ ...top, team: 'm-d' }, [{ ...top, team: 'm-d' }, dept])).toBe(false)
  const L = layout(112, 60)
  const colOf = (x: number) => L.clusters.findIndex((k, i) => i < L.cols && x >= k.x && x < k.x + 23)
  const seats = assignSeats(crew, 112, 60)
  expect(seats.get('t')!.kind).toBe('boss')
  expect(seats.get('d')!.kind).toBe('staff')
  expect(colOf(seats.get('s2')!.seat.x)).toBe(2) // 頂層主管：最右欄
  expect(colOf(seats.get('d')!.seat.x)).toBe(1) // 部門主管：自己那一區
  expect(colOf(seats.get('s1')!.seat.x)).toBe(1)
  const zoneSlots = [...seats.values()].filter(p => p.kind === 'staff' && colOf(p.seat.x) === 1).map(p => p.slot)
  expect(seats.get('d')!.slot).toBe(Math.min(...zoneSlots)) // 那一區第一個位子
  expect(bossSeating(crew, 112, 60).order.filter(Boolean).map(b => b!.id)).toEqual(['t'])
  const text = cellText(encode(drawScene(crew, 0, 112, 60)), 112, 60).join('\n')
  expect(text).toContain('TEAM dd')
  expect(roster(crew, 0)).toContain('dept lead')
})

test('a department lead with nobody under them sits in their manager zone like a peer', () => {
  const top = boss('t', 'tt', 'm-t')
  const dept = { ...boss('d', 'dd', 'm-d'), team: 'm-t' }
  const L = layout(112, 60)
  const colOf = (x: number) => L.clusters.findIndex((k, i) => i < L.cols && x >= k.x && x < k.x + 23)
  const seats = assignSeats([top, dept], 112, 60)
  expect(seats.get('d')!.kind).toBe('staff')
  expect(colOf(seats.get('d')!.seat.x)).toBe(2)
})

test('demotion reminder: only a manager, only after 20 minutes with nobody under them, only once', () => {
  const me = boss('m', 'mm', 'm-m')
  expect(hasReports(me, [{ ...P('s', 's'), team: 'm-m' }])).toBe(true)
  expect(hasReports(me, [{ ...P('s', 's'), team: 'mm' }])).toBe(true)
  expect(hasReports(me, [P('s', 's')])).toBe(false)
  expect(shouldRemindDemote('manager', 0, DEMOTE_MS - 1, false)).toBe(false)
  expect(shouldRemindDemote('manager', 0, DEMOTE_MS, false)).toBe(true)
  expect(shouldRemindDemote('manager', 0, DEMOTE_MS, true)).toBe(false)
  expect(shouldRemindDemote('staff', 0, DEMOTE_MS, false)).toBe(false)
  expect(shouldRemindDemote('manager', undefined, DEMOTE_MS, false)).toBe(false)
})

test('layer 2 cards (squad) keep no checkpoint: detected from frontmatter only', () => {
  expect(isLayer2('---\nrole: 測試\nlayer: 2\n---\n## 職責\n')).toBe(true)
  expect(isLayer2('---\r\nrole: x\r\nlayer: 2\r\n---\r\n')).toBe(true)
  expect(isLayer2('---\nrole: 主管\nlayer: 1\nreports_to: 主管\n---\n')).toBe(false)
  expect(isLayer2('---\nrole: x\n---\nlayer: 2\n')).toBe(false) // 內文不算
  expect(isLayer2('')).toBe(false)
})

test('promotion reminder: staff with someone online under them, once; not for a manager', () => {
  const me = { ...P('o', 'oo'), agent: 'o-o' }
  const kid = { ...P('s', 's'), team: 'o-o' }
  expect(shouldRemindPromote(me, [kid], false)).toBe(true)
  expect(shouldRemindPromote(me, [kid], true)).toBe(false)
  expect(shouldRemindPromote(me, [P('s', 's')], false)).toBe(false)
  expect(shouldRemindPromote({ ...me, role: 'manager' }, [kid], false)).toBe(false)
  // a squad member (under a department lead) is not promoted: only 2 layers
  const top = { ...P('t', 'tt', 'idle', false, 'manager'), agent: 't-t' }
  const dept = { ...P('d', 'dd', 'idle', false, 'manager'), agent: 'd-d', team: 't-t' }
  const member = { ...me, team: 'd-d' }
  expect(shouldRemindPromote(member, [top, dept, kid], false)).toBe(false)
  expect(shouldRemindPromote({ ...me, team: 't-t' }, [top, dept, kid], false)).toBe(true)
})

test('an Antigravity (agy) status file shows up as a coworker that cannot be messaged', () => {
  const now = 50_000
  const s = { id: 'agy-c1', kind: 'agy', name: 'wtoffice', mode: 'typing', tool: 'run_command', updatedAt: now - 1000, left: false, addr: 'x' }
  const c = parseStatus(s, now)!
  expect(c.kind).toBe('agy')
  expect(roster([c], now)).toContain('| wtoffice | — | staff | Antigravity: `python ~/.claude/pixel-office/agy/agy_office.py send wtoffice "…" --from <your name>` (delivered on its next action) |')
  expect(parseStatus({ ...s, left: true }, now)).toBeUndefined()
  expect(parseStatus({ ...s, kind: 'other' }, now)!.kind).toBeUndefined()
})

test('a Codex status file shows up as a coworker reached through codex_office.py send', () => {
  const now = 50_000
  const c = parseStatus({ id: 'codex-t1', kind: 'codex', name: 'kb', mode: 'idle', tool: '', updatedAt: now - 1000, left: false }, now)!
  expect(c.kind).toBe('codex')
  expect(roster([c], now)).toContain('| kb | — | staff | Codex: `python ~/.claude/pixel-office/codex/codex_office.py send kb "…" --from <your name>` (answers right away when idle) |')
})

test('a command written by another AI is labeled with its sender, never as the user', () => {
  expect(commandText({ text: 'hi' })).toBe('📱 hi')
  expect(commandText({ text: 'hi', from: 'wtoffice (Antigravity, not the user)' })).toBe('📨 wtoffice (Antigravity, not the user): hi')
  expect(commandText({ text: 'hi', from: 3 })).toBe('📱 hi')
})

// ---------- 0.36.0：open_role.py 開角色時寫 presets/<session>.json，全新 session 自動登記 ----------

import { presetInput } from './register'

test('preset file → office_profile input: strings only, empty fields dropped, nothing usable is undefined', () => {
  expect(presetInput({ title: '實作', role: 'staff', team: 'willy主管辦公室', name: 'impl', junk: 1 })).toEqual({ title: '實作', role: 'staff', team: 'willy主管辦公室', name: 'impl' })
  expect(presetInput({ title: ' ', team: 3 })).toBeUndefined()
  expect(presetInput('x')).toBeUndefined()
  expect(presetInput(null)).toBeUndefined()
})

async function startWithPreset($: any, on: any, files: Record<string, string>, sid: string) {
  mock.clock(on, { now: 1_000_000 })
  const key = (p: string) => p.split(/[\\/]/).slice(-2).join('/')
  on('env.get', () => ({ value: 'C:/Users/tester' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', (_$: any, e: any) => ({ value: key(e.path) in files }))
  on('fs.read', (_$: any, e: any) => {
    if (!(key(e.path) in files)) throw new Error('ENOENT') // 跟真的一樣：沒有檔就丟錯
    return { value: files[key(e.path)] }
  })
  on('fs.write', (_$: any, e: any) => {
    files[key(e.path)] = e.text
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined }) as any)
  on('tool.register', () => ({ value: undefined }) as any)
  on('session.start', (_$: any, e: any) => e)
  on('session.id', () => ({ value: sid }) as any)
  on('session.cwd', () => ({ value: 'C:/Users/user' }) as any)
  mock.store(on)
  await $.session.start({ cwd: 'C:/Users/user', surface: 'terminal', isInteractive: true })
}

test('a brand-new session with a preset file starts with its title, team and nameplate', async ($, on) => {
  const files: Record<string, string> = { 'presets/cccc3333.json': JSON.stringify({ title: '試做員', role: 'staff', team: 'office設計', name: 'tryer' }) }
  await startWithPreset($, on, files, 'cccc3333')
  const s = JSON.parse(files['sessions/cccc3333.json'])
  expect(s.title).toBe('試做員')
  expect(s.team).toBe('office設計')
  expect(s.name).toBe('tryer')
  expect(s.role).toBe('staff')
})

test('a resumed session keeps what it saved: the preset does not overwrite it', async ($, on) => {
  const files: Record<string, string> = {
    'presets/dddd4444.json': JSON.stringify({ title: '試做員', team: 'office設計' }),
    'sessions/dddd4444.json': JSON.stringify({ id: 'dddd4444', name: 'later', role: 'staff', title: '改過的', updatedAt: 0, left: true }),
  }
  await startWithPreset($, on, files, 'dddd4444')
  const s = JSON.parse(files['sessions/dddd4444.json'])
  expect(s.title).toBe('改過的')
  expect(s.team).toBeUndefined()
})

// ---------- 0.37.0：/rename 之後辦公室跟上（自己的 agent、team 指到主管舊名） ----------

import { parseCliSession, renameFixes } from './register'

test('Claude session file → current name and former names; junk is dropped', () => {
  expect(parseCliSession({ sessionId: 's1', name: 'GUANGUAN', formerNames: [{ name: 'claim-supervisor', until: 1, sessionId: 's1' }, { until: 2 }, 'x'] })).toEqual({ sessionId: 's1', name: 'GUANGUAN', formerNames: ['claim-supervisor'] })
  expect(parseCliSession({ sessionId: 's2' })).toEqual({ sessionId: 's2', name: undefined, formerNames: [] })
  expect(parseCliSession({ name: 'no id' })).toBeUndefined()
  expect(parseCliSession({ sessionId: 's3', hostSessionId: 'local_abc' })?.hosted).toBe(true) // Desktop 代管：不當一次性對話
  expect(parseCliSession({ sessionId: 's4', hostSessionId: '' })?.hosted).toBeUndefined()
})

test('rename fixes: own agent follows /rename; a team pointing at a renamed manager follows to the new name', () => {
  const cli = [
    { sessionId: 'me', name: '改名後組員', formerNames: ['改名組員'] },
    { sessionId: 'boss', name: '改名後主管', formerNames: ['改名主管'] },
  ]
  expect(renameFixes({ id: 'me', agent: '改名組員', team: '改名主管' }, cli)).toEqual({ agent: '改名後組員', team: '改名後主管' })
  expect(renameFixes({ id: 'me', agent: '改名後組員', team: '改名後主管' }, cli)).toEqual({}) // 已一致：不動
  expect(renameFixes({ id: 'me', agent: '改名後組員', team: '離線主管' }, cli)).toEqual({}) // 主管只是離線、不是改名：不動
  expect(renameFixes({ id: 'me', agent: 'x', team: '改名後組員' }, [{ sessionId: 'me', name: 'x', formerNames: ['改名後組員'] }])).toEqual({}) // 自己的舊名不算
})

test('every 5 seconds the office follows /rename: own agent and the team of a renamed manager', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const key = (p: string) => p.split(/[\\/]/).slice(-3).join('/') // 兩個 sessions 資料夾，多留一層分開
  const files: Record<string, string> = {
    'pixel-office/sessions/eeee5555.json': JSON.stringify({ id: 'eeee5555', name: 'mem', role: 'staff', agent: '改名組員', team: '改名主管', updatedAt: 0, left: true }),
    '.claude/sessions/101.json': JSON.stringify({ sessionId: 'eeee5555', name: '改名後組員', formerNames: [{ name: '改名組員' }] }),
    '.claude/sessions/102.json': JSON.stringify({ sessionId: 'ffff6666', name: '改名後主管', formerNames: [{ name: '改名主管' }] }),
  }
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'CLAUDE_CONFIG_DIR' ? undefined : 'C:/Users/tester' })) // 沒設 CLAUDE_CONFIG_DIR：讀 ~/.claude/sessions
  on('fs.list', (_$: any, e: any) => {
    const dir = e.path.split(/[\\/]/).slice(-2).join('/') + '/'
    return { value: Object.keys(files).filter(k => k.startsWith(dir)).map(k => ({ kind: 'file', name: k.split('/').pop() })) }
  })
  on('fs.exists', (_$: any, e: any) => ({ value: key(e.path) in files }))
  on('fs.read', (_$: any, e: any) => {
    if (!(key(e.path) in files)) throw new Error('ENOENT')
    return { value: files[key(e.path)] }
  })
  on('fs.write', (_$: any, e: any) => {
    files[key(e.path)] = e.text
    return { value: undefined }
  })
  on('command.register', () => ({ value: undefined }) as any)
  on('tool.register', () => ({ value: undefined }) as any)
  on('session.start', (_$: any, e: any) => e)
  on('session.id', () => ({ value: 'eeee5555' }) as any)
  on('session.cwd', () => ({ value: 'C:/Users/user' }) as any)
  mock.store(on)
  await ($ as any).session.start({ cwd: 'C:/Users/user', surface: 'terminal', isInteractive: true })
  expect(JSON.parse(files['pixel-office/sessions/eeee5555.json']).agent).toBe('改名組員')
  await clock.advance(5000)
  const s = JSON.parse(files['pixel-office/sessions/eeee5555.json'])
  expect(s.agent).toBe('改名後組員')
  expect(s.team).toBe('改名後主管')
})

// ---------- 0.39.0：同一份對話開兩個視窗 ----------

test('a session marked dup is called out on the roster and parsed from its status file', () => {
  const crew: Coworker[] = [{ ...P('a', 'A'), agent: '客製實作', dup: true }, { ...P('b', 'B'), agent: 'other' }]
  const text = roster(crew, 0)
  expect(text).toContain('🔴 客製實作: the same conversation is open in two windows')
  expect(text).not.toContain('🔴 other')
  expect(parseStatus({ id: 'a', name: 'A', mode: 'idle', updatedAt: 0, dup: true }, 0)!.dup).toBe(true)
  expect(parseStatus({ id: 'a', name: 'A', mode: 'idle', updatedAt: 0 }, 0)!.dup).toBeUndefined()
})

// ---------- 0.40.0：升層時外掛補 collab.md ----------

import { collabSkeleton, officeFor } from './register'

test('office dir: projects.json maps a repo to a relative or absolute dir, otherwise <repo>/.claude/office', () => {
  expect(officeFor('C:/p/pixel-office', undefined)).toBe('C:/p/pixel-office/.claude/office')
  expect(officeFor('C:\\p\\pixel-office', { 'c:/P/pixel-office/': 'C:\\p\\studio\\.claude\\office' })).toBe('C:/p/studio/.claude/office')
  expect(officeFor('C:/p/vault', { 'C:\\p\\vault': '_extras/office' })).toBe('C:/p/vault/_extras/office')
  expect(officeFor('C:/p/a', { 'C:/p/b': 'x' })).toBe('C:/p/a/.claude/office')
})

test('collab skeleton has the six lead.md sections and the manager row', () => {
  const s = collabSkeleton('willy主管', undefined, '2026-10-31 12:00')
  for (const h of ['# 主管', '# 在線', '# 檔案佔用', '# 待使用者裁示', '# 等外部回覆', '# 衝突紀錄']) expect(s).toContain(`\n${h}\n`.slice(s.startsWith(h) ? 1 : 0))
  expect(s).toContain('| willy主管 | （待填） | — | 2026-10-31 12:00 |')
  expect(collabSkeleton('d', 'top', 'x')).toContain('| d | （待填） | top | x |')
})

test('stepping up writes collab.md only when the office dir exists and collab.md does not', async ($, on) => {
  const writes: Record<string, string> = {}
  const exists = new Set(['C:/r/.claude/office'])
  on('clock.now', () => ({ value: 0 }) as any)
  on('env.get', () => ({ value: 'C:/Users/tester' }))
  on('session.repo', () => ({ value: { root: 'C:/r', remote: null, internal: false } }) as any)
  on('fs.exists', (_$, e: any) => ({ value: exists.has(e.path.replace(/\\/g, '/')) }) as any)
  on('fs.read', () => { throw new Error('missing') })
  on('fs.write', (_$, e: any) => { writes[e.path.replace(/\\/g, '/')] = e.text; return { value: undefined } as any })
  const out = await $.tool.call({ tool: 'mcp__pixel-office__office_profile', role: 'manager', agent: 'boss' } as any)
  expect(JSON.stringify(out)).toContain('created C:/r/.claude/office/collab.md')
  expect(writes['C:/r/.claude/office/collab.md']).toContain('| boss | （待填） |')
})

// ---------- 0.41.0：檢查點提醒與下線自動補一筆 ----------

import { CP_REMIND_MS, autoCheckpoint, checkpointDue } from './register'

test('checkpoint reminder: only after work, an hour since the last save, once', () => {
  expect(checkpointDue(true, 0, CP_REMIND_MS, false)).toBe(true)
  expect(checkpointDue(false, 0, CP_REMIND_MS, false)).toBe(false) // 沒做事
  expect(checkpointDue(true, 0, CP_REMIND_MS - 1, false)).toBe(false) // 還不到一小時
  expect(checkpointDue(true, 0, CP_REMIND_MS, true)).toBe(false) // 這段已提醒
})

test('the auto checkpoint states only facts: last prompt and how to resume', () => {
  const s = autoCheckpoint('2026-10-31 12:00', '客製實作', '把長按例外補進', 'sid-1', 'C:/r')
  expect(s.split('\n')[0]).toBe('## 2026-10-31 12:00 客製實作（自動：下線前沒存）')
  expect(s).toContain('- 最後指令：把長按例外補進')
  expect(s).toContain('claude --resume sid-1（在 C:/r）')
  expect(autoCheckpoint('t', 'x', undefined, 's', 'c')).toContain('（沒有記錄）')
})

test('session end appends an auto checkpoint for a held role after work, and not when nothing was done', async ($, on) => {
  const files: Record<string, string> = { 'C:/r/.claude/office/checkpoints/R.md': '# R 檢查點\n\n## 2026-10-30 10:00 x\n- 下一步：a\n' }
  const exists = new Set(['C:/r/.claude/office', 'C:/r/.claude/office/roles/R.md', 'C:/r/.claude/office/checkpoints/R.md'])
  const norm = (p: string) => p.replace(/\\/g, '/')
  on('clock.now', () => ({ value: 1_000_000 }) as any)
  on('env.get', () => ({ value: 'C:/Users/tester' }))
  on('session.id', () => ({ value: 'sid-1' }) as any)
  on('session.cwd', () => ({ value: 'C:/r' }) as any)
  on('session.repo', () => ({ value: { root: 'C:/r', remote: null, internal: false } }) as any)
  on('fs.list', () => ({ value: [] }))
  on('fs.exists', (_$, e: any) => ({ value: exists.has(norm(e.path)) }) as any)
  on('fs.stat', () => ({ value: { kind: 'file', size: 1, mtimeMs: 0 } }) as any)
  on('fs.read', (_$, e: any) => {
    const f = files[norm(e.path)]
    if (f === undefined) throw new Error('missing')
    return { value: f }
  })
  on('fs.write', (_$, e: any) => {
    files[norm(e.path)] = e.text
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('tool.register', () => ({ value: undefined }) as any)
  on('session.start', (_$: any, e: any) => e)
  on('session.end', () => ({ sessionId: 'sid-1' }) as any)
  on('tool.call', { tool: 'Read' }, () => ({ result: 'x' }) as any)
  await ($ as any).session.start({ cwd: 'C:/r', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__pixel-office__office_profile', title: 'R' } as any)
  await ($ as any).session.end({})
  expect(files['C:/r/.claude/office/checkpoints/R.md']).not.toContain('（自動') // 只登記、沒做事：不補
  await $.tool.call({ tool: 'Read', file_path: 'a.md' } as any).catch(() => undefined)
  await ($ as any).session.end({})
  const cp = files['C:/r/.claude/office/checkpoints/R.md']
  expect(cp).toContain('（自動：下線前沒存）')
  expect(cp).toContain('claude --resume sid-1')
  expect(cp.startsWith('# R 檢查點\n\n## 2026-10-30 10:00 x')).toBe(true) // 只往後加
  // 檔案在卻讀不到（被鎖）：不寫，免得整檔覆寫洗掉歷史
  files['C:/r/.claude/office/checkpoints/R.md'] = undefined as any
  await $.tool.call({ tool: 'Read', file_path: 'b.md' } as any).catch(() => undefined)
  await ($ as any).session.end({})
  expect(files['C:/r/.claude/office/checkpoints/R.md']).toBeUndefined()
})

// ---------- 0.42.0：離線信箱 ----------

import { MAIL_CLAIM_MS, MAIL_TTL_MS, mailMatches, mailSavedNote, mailStep, parseMail, shouldMail } from './register'

test('mailbox: store only when the recipient is gone, not when the name is ambiguous or refused', () => {
  expect(shouldMail('No agent or session named "office設計" is running')).toBe(true)
  expect(shouldMail('ENOINBOX: the session has no inbox')).toBe(true)
  expect(shouldMail('Several sessions are named x; add the [ref]')).toBe(false)
  expect(shouldMail('The session refused the message')).toBe(false)
})

test('mailbox: a name or a role title receives; claim first, send on the next tick, expire after a day', () => {
  expect(mailMatches('客製實作', { agent: 'x', title: '客製實作' })).toBe(true)
  expect(mailMatches('office設計', { agent: 'office設計' })).toBe(true)
  expect(mailMatches('a', { agent: 'b', title: 'c' })).toBe(false)
  // 0.63.45 成組通知（match=agent）：只認 ListAgents 名稱。A 的職稱剛好是 B 的名稱，A 不能領走給 B 的信
  expect(mailMatches('工程師B', { agent: '員工A', title: '工程師B' }, 'agent')).toBe(false)
  expect(mailMatches('工程師B', { agent: '工程師B', title: 'x' }, 'agent')).toBe(true)
  expect(parseMail({ from: 'a', to: 'b', text: 't', at: 1, match: 'agent' })?.match).toBe('agent')
  expect(parseMail({ from: 'a', to: 'b', text: 't', at: 1, match: 'title' })?.match).toBeUndefined()
  const m = parseMail({ from: 'boss', to: 'r', text: 'hi', at: 0 })!
  expect(m.state).toBe('pending')
  expect(mailStep(m, 'A', 1000)).toBe('claim')
  const mine = { ...m, state: 'claimed' as const, by: 'A', claimedAt: 1000 }
  expect(mailStep(mine, 'A', 6000)).toBe('send')
  expect(mailStep(mine, 'B', 6000)).toBe('skip') // 別人剛認領
  expect(mailStep(mine, 'B', 1000 + MAIL_CLAIM_MS)).toBe('claim') // 認領太久沒送完：接手
  expect(mailStep({ ...m, state: 'done' }, 'A', 1000)).toBe('skip')
  expect(mailStep(m, 'A', MAIL_TTL_MS + 1)).toBe('expire')
  expect(parseMail({ from: 'a', to: 'b' })).toBeUndefined()
})

test('a SendMessage to someone offline is saved to the mailbox and the model is told so', async ($, on) => {
  const files: Record<string, string> = {}
  on('clock.now', () => ({ value: 5000 }) as any)
  on('env.get', () => ({ value: 'C:/Users/tester' }))
  on('fs.list', () => ({ value: [] }))
  on('fs.write', (_$: any, e: any) => {
    files[e.path.replace(/\\/g, '/')] = e.text
    return { value: undefined }
  })
  on('session.send', () => ({ isDelivered: false, reason: 'No session named "r" is running.' }) as any)
  const out: any = await ($ as any).session.send({ to: 'r', text: 'spec 改好了', origin: { kind: 'model' } })
  expect(out.isDelivered).toBe(false)
  const saved = Object.entries(files).find(([k]) => k.includes('/pixel-office/mail/'))
  expect(saved).toBeDefined()
  expect(JSON.parse(saved![1])).toMatchObject({ to: 'r', text: 'spec 改好了', state: 'pending', at: 5000 })
})

test('the mailbox note tells the model not to resend or write a peer-reply file', () => {
  expect(mailSavedNote('r')).toContain('mailbox for r')
  expect(mailSavedNote('r')).toContain('No need to resend or write a peer-reply file')
  expect(mailSavedNote('r')).not.toContain('misspelled')
  expect(mailSavedNote('后端', false)).toContain('misspelled') // 沒人用過的名稱：提示可能打錯
})

// ---- 0.47.0：檢查點角色對照、名單 ctx 欄 ----
import { ctxText, heldRole } from './register'

test('heldRole：agent 優先，title 被改成任務名也找得到卡', async () => {
  const cards = new Set(['willy設計', '主管'])
  const has = async (n: string) => cards.has(n)
  expect(await heldRole(['willy設計', '找原檔'], has)).toBe('willy設計')
  expect(await heldRole(['程式碼整理能力評估', '主管'], has)).toBe('主管') // agent 不是卡名、title 是
  expect(await heldRole(['x', 'y'], has)).toBeUndefined()
  expect(await heldRole([undefined, undefined], has)).toBeUndefined()
  expect(await heldRole(['a'], async () => { throw new Error('io') })).toBeUndefined() // 讀失敗當沒有
})

test('ctxText 與名單 ctx 欄', () => {
  expect(ctxText({})).toBe('—')
  expect(ctxText({ ctxPct: 62 })).toBe('62%')
  expect(ctxText({ ctxPct: 8, compacts: 2 })).toBe('8% ·compacted 2')
  expect(ctxText({ compacts: 1 })).toBe('? ·compacted 1') // 剛壓縮完、還沒有新回應
  const out = roster([{ ...P('a', 'A'), ctxPct: 71, compacts: 1 }, P('b', 'B')], 0)
  expect(out).toContain('| ctx |')
  expect(out).toContain('71% ·compacted 1')
  expect(out.split('\n').find(l => l.startsWith('| B '))).toContain('| — |')
})

// ---- 0.49.0：累計新 token ----
import { fmtTokens, projectDirName, sumNewTokens, roster as roster2 } from './register'

test('sumNewTokens: input + cache write + output, no cache read; one response counted once; sidechain and junk lines skipped', () => {
  const a = (id: string, u: Record<string, number>, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'assistant', message: { id, usage: u }, ...extra })
  const text = [
    a('m1', { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 9000, output_tokens: 5 }),
    a('m1', { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 9000, output_tokens: 50 }), // 同一則回應後面的行蓋前面
    a('m2', { input_tokens: 1, output_tokens: 10 }),
    a('m3', { input_tokens: 999, output_tokens: 999 }, { isSidechain: true }),
    JSON.stringify({ type: 'user', message: { usage: { input_tokens: 5 } } }),
    '{"usage": broken',
    '',
  ].join('\n')
  expect(sumNewTokens(text)).toBe(2 + 100 + 50 + 1 + 10)
  expect(sumNewTokens('')).toBe(0)
})

test('projectDirName: every non-alphanumeric character becomes a dash (Chinese one per character)', () => {
  expect(projectDirName('C:\\Users\\me\\proj-測試\\#7')).toBe('C--Users-me-proj-----7')
})

test('fmtTokens and the roster: new tok column, /office who style sort puts the biggest first', () => {
  expect(fmtTokens(undefined)).toBe('—')
  expect(fmtTokens(999)).toBe('999')
  expect(fmtTokens(882184)).toBe('882k')
  expect(fmtTokens(1_234_567)).toBe('1.2M')
  const crew = [{ ...P('m', 'M', 'idle', false, 'manager'), newTokens: 559114 }, { ...P('a', 'A'), newTokens: 882184 }, P('c', 'C')]
  const rows = (t: string) => t.split('\n').filter(l => l.startsWith('| ') && !l.startsWith('| Name') && !l.startsWith('|---')).map(l => l.split('|')[1].trim())
  const plain = roster(crew, 0)
  expect(plain).toContain('| new tok |')
  expect(rows(plain)).toEqual(['M', 'A', 'C']) // 給模型看的：主管在前
  expect(rows(roster2(crew, 0, [], 'tokens'))).toEqual(['A', 'M', 'C']) // 沒有值的排最後
  expect(plain).toContain('882k')
})

// ---------- 0.60.0：升版後提醒一次、舊視窗提醒重開 ----------
import { cmpVersion, versionNote } from './register'

test('version compare is numeric per part', () => {
  expect(cmpVersion('0.60.0', '0.59.9') > 0).toBe(true)
  expect(cmpVersion('0.9.0', '0.10.0') < 0).toBe(true)
  expect(cmpVersion('1.2.3', '1.2.3')).toBe(0)
  expect(cmpVersion('abc', '0.0.0')).toBe(0)
})

test('version note: no file or upgrade notes once and records, older window asks for restart without writing', () => {
  const none = versionNote(undefined, '0.60.0') // 沒有 version.json：0.60.0 以前升上來的也要提醒
  expect(none.write).toBe(true)
  expect(none.note).toContain('before 0.60.0')
  expect(versionNote('0.61.0-beta', '0.61.1').note).toContain('0.61.0-beta -> 0.61.1')
  const up = versionNote('0.55.1', '0.60.0')
  expect(up.write).toBe(true)
  expect(up.note).toContain('0.55.1 -> 0.60.0')
  expect(up.note).toContain('升級要做的')
  expect(versionNote('0.60.0', '0.60.0')).toEqual({ write: false })
  const old = versionNote('0.61.0', '0.60.0')
  expect(old.write).toBe(false)
  expect(old.note).toContain('restarted')
})

// ---------- 0.60.0：Desktop 代管的 session 沒被點開也是員工（CLI 紀錄有 hostSessionId） ----------
const HOSTED_MOCKS = (on: any, files: Record<string, string>, env: Record<string, string> = {}) => {
  on('env.get', (_$: any, e: any) => ({ value: env[e.name] ?? 'C:/Users/tester' }))
  on('fs.list', () => ({ value: Object.keys(files).filter(k => k.startsWith('sessions/')).map(k => ({ name: k.slice(9), kind: 'file', size: 1, mtimeMs: 1_000_000, isLink: false })) }) as any)
  on('fs.read', (_$: any, e: any) => ({ value: files[e.path.split(/[\\/]/).slice(-2).join('/')] ?? '{}' }))
  on('fs.write', (_$: any, e: any) => {
    files[e.path.split(/[\\/]/).slice(-2).join('/')] = e.text
    return { value: undefined }
  })
  on('classic.SessionStart', () => ({}) as any)
}

test('a Desktop-hosted session nobody opened (no attach) becomes an employee once its CLI record shows hostSessionId', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { 'sessions/4242.json': JSON.stringify({ pid: 4242, sessionId: 'h1', name: '評估', hostSessionId: 'local_abc' }) }
  HOSTED_MOCKS(on, files)
  G4_START(on, files, 'h1')
  await ($ as any).session.start({ cwd: 'C:/work/kb', surface: null, isInteractive: false })
  expect(JSON.parse(files['sessions/h1.json']).oneshot).toBe(true)
  await clock.advance(5000)
  const mine = JSON.parse(files['sessions/h1.json'])
  expect(mine.oneshot).toBeUndefined()
  expect(mine.left).toBe(false)
})

test('claude -p (no hostSessionId in its CLI record) stays a one-shot, even with an inherited CLAUDE_CODE_HOST_SESSION_ID', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  const files: Record<string, string> = { 'sessions/4343.json': JSON.stringify({ pid: 4343, sessionId: 'p9', name: 'api' }) }
  HOSTED_MOCKS(on, files, { CLAUDE_CODE_HOST_SESSION_ID: 'local_inherited' })
  G4_START(on, files, 'p9')
  await ($ as any).session.start({ cwd: 'C:/work/kb', surface: null, isInteractive: false })
  await clock.advance(5000)
  expect(JSON.parse(files['sessions/p9.json']).oneshot).toBe(true)
})

// ---------- 0.62.2 同桌第一批：同桌名單、桌牌狀態 ----------
import { assign as v2assign, atTable, emptyStore as v2empty, tableStatus, tablesOut as v2tablesOut } from './officeV2'
import { roster as roster3 } from './register'

test('table status: working / waiting / blocked counts read at a glance; idle tables say how many, empty says 空桌', () => {
  expect(tableStatus([{ mode: 'typing' }, { mode: 'thinking' }, { mode: 'reading' }, { mode: 'waiting' }]).text).toBe('3 人工作中・1 位等你')
  expect(tableStatus([{ mode: 'idle' }, { mode: 'done' }]).text).toBe('2 人閒著')
  expect(tableStatus([{ mode: 'blocked' }, { mode: 'idle' }]).text).toBe('1 位卡住')
  expect(tableStatus([]).text).toBe('空桌')
  expect(tableStatus([{ mode: 'waiting' }]).waiting).toBe(1)
})

test('tablesOut with the seat map lists who sits at each table (manager first) and its status', () => {
  const S = v2empty()
  const people = [
    { id: 'b', role: 'manager', agent: 'boss', plate: 'boss', mode: 'typing' },
    { id: 'c', team: 'boss', plate: 'c', mode: 'waiting' },
    { id: 'a', team: 'boss', plate: 'a', mode: 'idle' },
    { id: 'z', plate: 'z', mode: 'typing' },
  ]
  const { map } = v2assign(S, people, 0)
  const [t] = v2tablesOut(S, people, map) as any[]
  expect(t.members[0]).toBe('b')
  expect([...t.members].sort()).toEqual(['a', 'b', 'c'])
  expect(t.status).toBe('1 人工作中・1 位等你')
  expect(t.count).toBe(3)
  expect(atTable(t.id, people, map).map(p => p.id)).not.toContain('z')
  expect((v2tablesOut(S, people) as any[])[0].status).toBeUndefined() // 沒給座位表＝舊格式
})

test('roster: Table column and a Tablemates list with ListAgents names only when someone sits at a table', () => {
  const P = (id: string, extra: object = {}) => ({ id, name: id, mode: 'idle', tool: '', isMe: false, role: 'staff', ...extra }) as Coworker
  const crew = [P('m', { role: 'manager', agent: '主管 A', isMe: true }), P('s', { agent: '員工 B', team: '主管 A' }), P('x', { agent: 'X' })]
  const text = roster3(crew, 0, [], undefined, new Map([['m', 'A 桌'], ['s', 'A 桌']]))
  expect(text).toContain('| Name | Title | Table | Role |')
  expect(text).toMatch(/\| ▶ m \| — \| A 桌 \|/)
  expect(text).toMatch(/\| x \| — \| — \|/)
  expect(text).toContain('Tablemates')
  expect(text).toContain('- ▶ A 桌: m (`主管 A`), s (`員工 B`)')
  const plain = roster3(crew, 0, [], undefined, new Map())
  expect(plain).not.toContain('Table |')
  expect(plain).not.toContain('Tablemates')
})

// ---------- 0.62.3 缺主管 ----------
import { needsBoss } from './officeV2'
import { orderInput } from './register'

test('a table needs a manager from 4 people up when nobody sitting there is one', () => {
  const s = (n: number, boss = false) => Array.from({ length: n }, (_, i) => ({ role: boss && i === 0 ? 'manager' : 'staff' }))
  expect(needsBoss(s(3))).toBe(false)
  expect(needsBoss(s(4))).toBe(true)
  expect(needsBoss(s(6, true))).toBe(false)
})

test('tablesOut marks noBoss; staff dragged together at 4 are flagged, a manager clears it', () => {
  const S = v2empty()
  S.tables.push({ id: 1, name: 'X', size: 6 }); S.nextId = 2
  const people = ['a', 'b', 'c', 'd'].map(id => ({ id, plate: id, mode: 'idle' }))
  for (const [i, p] of people.entries()) S.pins[p.id] = `t1.${i}`
  const { map } = v2assign(S, people, 0)
  expect((v2tablesOut(S, people, map) as any[])[0].noBoss).toBe(true)
  const withBoss = people.map((p, i) => (i === 2 ? { ...p, role: 'manager', agent: 'C' } : p))
  expect((v2tablesOut(S, withBoss, v2assign(S, withBoss, 0).map) as any[])[0].noBoss).toBe(false)
})

test('personnel orders: role/team applied once per nonce, expired or empty orders ignored', () => {
  expect(orderInput({ nonce: 'n1', at: 0, role: 'manager' }, 1000)).toEqual({ nonce: 'n1', role: 'manager' })
  expect(orderInput({ nonce: 'n1', at: 0, team: ' 主管 A ' }, 1000)).toEqual({ nonce: 'n1', team: '主管 A' })
  expect(orderInput({ nonce: 'n1', at: 0, role: 'manager' }, 1000, 'n1')).toBeUndefined()
  expect(orderInput({ nonce: 'n1', at: 0, role: 'manager' }, 11 * 60000)).toBeUndefined()
  expect(orderInput({ nonce: 'n1', at: 0, role: 'boss' }, 1000)).toBeUndefined()
  expect(orderInput('x', 1000)).toBeUndefined()
})

test('a personnel order from the phone changes role and team directly (no model turn), once per nonce', async ($, on) => {
  const NOW = 1_000_000
  const clock = mock.clock(on, { now: NOW })
  const files: Record<string, string> = { 'orders/aaaa1111.json': JSON.stringify({ nonce: 'o1', at: NOW - 1000, role: 'manager', team: '大主管' }) }
  const submitted: any[] = []
  on('env.get', () => ({ value: 'C:/Users/tester' }))
  on('fs.list', () => ({ value: [] }))
  const key = (path: string) => path.split(/[\\/]/).slice(-2).join('/')
  on('fs.exists', (_$: any, e: any) => ({ value: key(e.path) in files }) as any)
  on('fs.read', (_$: any, e: any) => ({ value: files[key(e.path)] ?? '{}' }))
  on('fs.write', (_$: any, e: any) => { files[key(e.path)] = e.text; return { value: undefined } })
  on('prompt.submit', (_$, e: any) => { submitted.push(e); return { text: e.text } as any })
  on('command.register', () => ({ value: undefined }) as any)
  on('tool.register', () => ({ value: undefined }) as any)
  on('session.start', (_$: any, e: any) => e)
  on('session.id', () => ({ value: 'aaaa1111' }) as any)
  on('session.cwd', () => ({ value: 'C:/Users/user' }) as any)
  mock.store(on)
  await ($ as any).session.start({ cwd: 'C:/Users/user', surface: 'terminal', isInteractive: true })
  await clock.advance(3000)
  const st = JSON.parse(files['sessions/aaaa1111.json'])
  expect(st.role).toBe('manager')
  expect(st.team).toBe('大主管')
  expect(JSON.parse(files['orders/aaaa1111.done.json']).nonce).toBe('o1')
  expect(submitted).toHaveLength(0)
  files['sessions/aaaa1111.json'] = JSON.stringify({ ...st, role: 'staff' })
  await clock.advance(3000)
  expect(JSON.parse(files['orders/aaaa1111.done.json']).nonce).toBe('o1') // 同一道令不再套一次
})

// ---------- 0.62.4 桌子聊天室 ----------
import { CHAT_KEEP_MS, chatTables, firstLine, parseChat } from './officeV2'

test('chat: logged to the tables of sender and recipient, first line shown, expired entries dropped', () => {
  const map = new Map([['a', 't1.0'], ['b', 't1.3'], ['c', 't2.1'], ['d', 'o0']])
  expect(chatTables(map, 'a', 'b')).toEqual([1])
  expect(chatTables(map, 'a', 'c')).toEqual([1, 2])
  expect(chatTables(map, 'd', 'c')).toEqual([2])
  expect(chatTables(map, 'd')).toEqual([])
  expect(firstLine('\n第一行\n第二行')).toEqual({ head: '第一行', more: true })
  expect(firstLine('短的')).toEqual({ head: '短的', more: false })
  expect(firstLine('x'.repeat(80)).head.endsWith('…')).toBe(true)
  const e = { at: 1000, from: { id: 'a', name: 'A' }, to: { name: 'B' }, text: 'hi' }
  expect(parseChat(JSON.stringify(e), 2000)).toEqual(e)
  expect(parseChat(JSON.stringify(e), 1000 + CHAT_KEEP_MS + 1)).toBeUndefined()
  expect(parseChat('{bad', 0)).toBeUndefined()
})

test('a delivered message to a tablemate is written to that table\'s chat folder', async ($, on) => {
  const NOW = 1_000_000
  const clock = mock.clock(on, { now: NOW })
  const files: Record<string, string> = {
    'sessions/bbbb2222.json': JSON.stringify({ instance: 'x', id: 'bbbb2222', name: 'boss', role: 'manager', mode: 'idle', agent: '主管', updatedAt: NOW }),
  }
  on('env.get', () => ({ value: 'C:/Users/tester' }))
  const key = (path: string) => path.split(/[\\/]/).slice(-2).join('/')
  on('fs.list', (_$: any, e: any) => ({ value: /sessions$/.test(e.path) ? Object.keys(files).filter(k => k.startsWith('sessions/')).map(k => ({ kind: 'file', name: k.slice(9), mtimeMs: NOW })) : [] }) as any)
  on('fs.exists', (_$: any, e: any) => ({ value: key(e.path) in files }) as any)
  on('fs.read', (_$: any, e: any) => ({ value: files[key(e.path)] ?? '{}' }))
  on('session.send', () => ({ isDelivered: true }) as any)
  on('fs.write', (_$: any, e: any) => { files[key(e.path)] = e.text; return { value: undefined } })
  on('command.register', () => ({ value: undefined }) as any)
  on('tool.register', () => ({ value: undefined }) as any)
  on('session.start', (_$: any, e: any) => e)
  on('session.id', () => ({ value: 'aaaa1111' }) as any)
  on('session.cwd', () => ({ value: 'C:/Users/user' }) as any)
  mock.store(on)
  await ($ as any).session.start({ cwd: 'C:/Users/user', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__pixel-office__office_profile', agent: '員工', team: '主管' } as any)
  await clock.advance(3000)
  await ($ as any).session.send({ to: '主管 [abc123]', text: '報價單好了\n細節在共用資料夾' })
  await clock.advance(1)
  const logged = Object.keys(files).filter(k => /^t\d+\//.test(k))
  expect(logged).toHaveLength(1)
  const c = JSON.parse(files[logged[0]])
  expect(c.to).toMatchObject({ id: 'bbbb2222' })
  expect(c.from.id).toBe('aaaa1111')
  expect(c.text).toBe('報價單好了\n細節在共用資料夾')
})

// ---------- 0.62.5 自動多開幫手 ----------
import { helperAsk } from './register'

test('office_helper: managers only, reason and task required; staff are told to ask their manager', () => {
  const boss = { id: 's1', role: 'manager' as const, agent: '主管', name: 'boss' }
  expect(helperAsk({ reason: '改很久', task: '跑測試' }, { ...boss, role: 'staff' })).toContain('Only managers')
  expect(helperAsk({ reason: '', task: 'x' }, boss)).toContain('reason')
  expect(helperAsk({ reason: 'x'.repeat(61), task: 'x' }, boss)).toContain('reason')
  expect(helperAsk({ reason: '改很久', task: '' }, boss)).toContain('task')
  const r = helperAsk({ reason: '改很久', task: '跑測試', name: 'H' }, boss) as any
  expect(r).toMatchObject({ from: 's1', agent: '主管', plate: 'boss', reason: '改很久', task: '跑測試', name: 'H' })
  expect(r.id).toMatch(/^[0-9a-f-]{36}$/)
  expect(r.kind).toBeUndefined()
  // 0.63.37：kind=codex-art 開 Codex 生圖幫手；其他值擋下
  expect((helperAsk({ reason: '要參考圖', task: '畫杯子', kind: 'codex-art' }, boss) as any).kind).toBe('codex-art')
  expect(helperAsk({ reason: '要參考圖', task: '畫杯子', kind: 'gemini' }, boss)).toContain('codex-art')
})

// ---------- 0.62.6 重開後主管名稱跑掉、桌牌字 ----------
import { cliSessionsDir } from './register'
import { tableLabel } from './officeV2'

test('Claude Code session records are read from the session\'s own CLAUDE_CONFIG_DIR (else ~/.claude)', () => {
  expect(cliSessionsDir('/Users/me/.claude/pixel-office/sessions')).toBe('/Users/me/.claude/sessions')
  expect(cliSessionsDir('/Users/me/.claude/pixel-office/sessions', '/Users/me/.claude-work/')).toBe('/Users/me/.claude-work/sessions')
  expect(cliSessionsDir('C:/Users/me/.claude/pixel-office/sessions', 'C:\\Users\\me\\.claude-x')).toBe('C:/Users/me/.claude-x/sessions')
})

test('table plate: when table name and manager plate contain each other, show the table name', () => {
  expect(tableLabel('像素辦公室 v2', '像素辦公室 v2 整')).toBe('像素辦公室 v2')
  expect(tableLabel('像素辦公室 v2 整合團隊', '像素辦公室 v2 整')).toBe('像素辦公室 v2 整合團隊')
  expect(tableLabel('讀書會', '組長')).toBe('讀書會・組長')
  expect(tableLabel('X', undefined)).toBe('X')
})

// ---------- 0.62.8 換主管交接：面板桌牌「交接中」 ----------
import { handingTables } from './register'

test('panel reads which tables are mid-handover from handovers-<port>.json (done/cancelled ones are not)', () => {
  expect(handingTables(JSON.stringify({ handovers: [{ table: 1, state: 'handing' }, { table: 2, state: 'done' }, { table: 3, state: 'ask-wait' }, { table: 4, state: 'cancelled' }] }))).toEqual([1, 3])
  expect(handingTables(undefined)).toEqual([])
  expect(handingTables('{bad')).toEqual([])
})

// ---------- 0.62.9 協作桌記協作資料夾 ----------
import { editTables as v2edit } from './officeV2'

test('a table remembers its collab folder: full paths only, blank clears it, tablesOut passes it on', () => {
  const S = v2empty()
  S.tables.push({ id: 2, name: '像素辦公室 v2', size: 6 }); S.nextId = 3
  expect(v2edit(S, { op: 'edit', id: 2, collab: 'team-v2' }).ok).toBe(false)
  expect(v2edit(S, { op: 'edit', id: 2, collab: '~/.claude/pixel-office/team-v2/' }).ok).toBe(true)
  expect(S.tables[0].collab).toBe('~/.claude/pixel-office/team-v2')
  expect((v2tablesOut(S, []) as any[])[0].collab).toBe('~/.claude/pixel-office/team-v2')
  expect(v2edit(S, { op: 'edit', id: 2, collab: '' }).ok).toBe(true)
  expect(S.tables[0].collab).toBeUndefined()
})

// ---------- 0.62.10 同桌共用筆記、行政 ----------
import { latestCheckpoints, mdSections, suggestAdmin, tableRows } from './officeV2'
import { notesLines } from './register'

test('notes: collab.md sections, table rows, latest checkpoint per name, admin suggestion from 6 people', () => {
  const md = '# 主管\n| a | b |\n|---|---|\n| 主管 A | 報價 |\n# 待使用者裁示\n| # | 事項 | 在哪 | 日 |\n|---|---|---|---|\n| 1 | 含運費嗎 | collab | 11-23 |\n| 2 | 週五交 | | 11-23 |\n# 目標\n週五前交報價\n'
  const sec = mdSections(md)
  expect(tableRows(sec.get('待使用者裁示')!).map(r => r[1])).toEqual(['含運費嗎', '週五交'])
  expect(tableRows(sec.get('主管')!)[0][1]).toBe('報價')
  expect(sec.get('目標')).toBe('週五前交報價')
  const cp = latestCheckpoints([{ name: '員工B.md', text: '## 2026-11-22 09:00 員工B\n- 做完：舊\n\n## 2026-11-23 10:00 員工B\n- 做完：新\n' }, { name: '報價.md', text: '## 2026-11-23 08:00 文書助理\n- 做完：x\n' }])
  expect(cp.get('員工B')!.text).toContain('新')
  expect(cp.get('文書助理')!.head).toBe('2026-11-23 08:00 文書助理')
  expect(cp.get('報價')!.file).toBe('報價.md')
  expect(suggestAdmin(5, false)).toBe(false)
  expect(suggestAdmin(6, false)).toBe(true)
  expect(suggestAdmin(6, true)).toBe(false)
})

test('panel notes (read-only): decisions first and in red, no manager says so, nothing without a snapshot', () => {
  const l = notesLines(JSON.stringify({ ok: true, decide: [{ text: '含運費嗎' }], auto: [{ plate: 'A', doing: '正在寫' }], progress: [{ plate: 'A', head: 'h', text: '- 做完：初稿' }], asks: ['2026-11-23 09:00 先做報價'], hasBoss: false }))
  expect(l[0]).toContain('待你決定 1')
  expect(l[1]).toBe('🔴 含運費嗎')
  expect(l).toContain('・A：正在寫')
  expect(l).toContain('主管：這桌還沒有主管')
  expect(notesLines(undefined)).toEqual([])
  const t = notesLines(JSON.stringify({ ok: true, hasBoss: true, tasks: { active: [{ title: '報價', progress: '進行中 1/2', parts: [{ who: 'A', stateZh: '完成' }, { who: 'B', stateZh: '進行中' }] }] } }))
  expect(t).toContain('📋 報價（進行中 1/2）：A 完成、B 進行中')
})

// ---------- 0.62.11 office_task ----------
import { taskOp } from './register'

test('office_task: only managers create; parts need who and what; only the owner or the manager updates a part', () => {
  const boss = { id: 'm1', role: 'manager' as const, agent: '主管', name: 'boss' }
  const staff = { id: 's1', role: 'staff' as const, agent: 'A', name: 'a' }
  expect(taskOp({ action: 'create', title: 'x', parts: [{ who: 'A', what: 'y' }] }, staff, 0)).toContain('Only managers')
  expect(taskOp({ action: 'create', title: 'x', parts: [{ who: 'A' }] }, boss, 0)).toContain('part 1')
  const c = taskOp({ action: 'create', title: '報價', parts: [{ who: 'A [abc123]', what: '查價' }, { who: 'B', what: '寫', after: [1, 2, 9] }] }, boss, 5) as any
  expect(c.data.parts).toEqual([{ who: 'A', what: '查價' }, { who: 'B', what: '寫', after: [0] }])
  const def = c.data
  expect(taskOp({ action: 'update', id: def.id, part: 1, state: 'done' }, staff, 6, def)).toMatchObject({ file: `${def.id}.0.json`, data: { state: 'done' } })
  expect(taskOp({ action: 'update', id: def.id, part: 2, state: 'done' }, staff, 6, def)).toContain('belongs to B')
  expect(taskOp({ action: 'update', id: def.id, part: 2, state: 'stuck', note: '缺資料' }, boss, 6, def)).toMatchObject({ data: { state: 'stuck', note: '缺資料' } })
  expect(taskOp({ action: 'update', id: def.id, part: 3, state: 'done' }, boss, 6, def)).toContain('part must be')
  expect(taskOp({ action: 'update', id: 'zz', part: 1, state: 'done' }, boss, 6, undefined)).toContain('No such task')
})

// ---------- 0.62.12 整桌開會 ----------
import { tableMeetings } from './register'

test('panel reads which tables are in a table meeting and who joins', () => {
  expect(tableMeetings(JSON.stringify({ meetings: [{ table: 2, topic: '週會', ids: ['a', 'b'], state: 'on' }, { table: 3, topic: 'x', ids: [], state: 'done' }] }))).toEqual([{ table: 2, topic: '週會', ids: ['a', 'b'] }])
  expect(tableMeetings(undefined)).toEqual([])
})

import { menuSvg } from './v2panel'
test('0.62.17 panel menu: the pressed button is drawn pushed down and darker; slide-in only on the render right after opening, off for reduced motion', () => {
  const menu = { title: '書櫃', items: ['讀', '寫'], cancel: '取消', at: { x: 10, y: 10, w: 10, h: 10 } }
  const plain = menuSvg(menu, 4, 200, 120).svg
  expect(plain).not.toContain('menu-in')
  const opened = menuSvg({ ...menu, enter: true }, 4, 200, 120).svg
  expect(opened).toContain('class="menu menu-in"')
  expect(opened).toContain('prefers-reduced-motion:reduce')
  const pressed = menuSvg({ ...menu, pressed: 1 }, 4, 200, 120).svg
  expect(pressed).not.toBe(plain)
  expect(pressed).toContain('#c9a227"') // 第二顆（米白）按下去變金色
  expect(menuSvg({ ...menu, pressed: 1 }, 4, 200, 120).hits).toEqual(menuSvg(menu, 4, 200, 120).hits) // 點擊區不跟著動
})

test('0.62.18: deleting a table asks first when someone online sits there (by who is online, not the hourly seen stamp); the team then sits in the office area instead of getting a new auto table, until the team is offline', () => {
  const S = v2empty()
  const boss = { id: 'b', plate: 'B', name: 'B', role: 'manager', agent: '隊長' }, mate = { id: 'm', plate: 'M', name: 'M', role: 'staff', team: '隊長' }
  let r = v2assign(S, [boss, mate] as any, 1_000_000)
  const t = S.tables.find(x => x.team === '隊長')!
  expect(r.map.get('b')).toBe(`t${t.id}.0`)
  // 兩小時後 seen 還是舊的（一小時才刷新），但人在線：要先問
  const later = 1_000_000 + 2 * 3600e3
  expect(v2edit(S, { op: 'delete', id: t.id }, new Set(['b', 'm'])).ok).toBe(false)
  expect(v2edit(S, { op: 'delete', id: t.id }, new Set()).ok).toBe(true) // 都不在線：直接刪
  r = v2assign(S, [boss, mate] as any, later)
  expect(S.tables.length).toBe(0) // 不馬上再開一張
  expect(r.map.get('b')).toMatch(/^o\d+$/)
  v2assign(S, [] as any, later + 1) // 這隊都下線：記號清掉
  expect(S.noAuto?.['隊長']).toBeUndefined()
  v2assign(S, [boss, mate] as any, later + 2)
  expect(S.tables.some(x => x.team === '隊長' && x.auto)).toBe(true) // 下次上線照常自動開桌
})

import { CMD_CONFIRM_MS, CMD_TRIES } from './register'
function cmdRig(on: any, files: Record<string, string>) {
  on('env.get', () => ({ value: 'C:/Users/tester' }))
  on('fs.list', () => ({ value: [] }))
  const key = (path: string) => path.split(/[\\/]/).slice(-2).join('/')
  on('fs.exists', (_$: any, e: any) => ({ value: key(e.path) in files }) as any)
  on('fs.read', (_$: any, e: any) => ({ value: files[key(e.path)] ?? '{}' }))
  on('fs.write', (_$: any, e: any) => { files[key(e.path)] = e.text; return { value: undefined } })
  on('tool.call', () => ({ result: 'ok', text: 'done' }) as any)
  on('turn.complete', () => ({ text: '' }) as any)
  on('command.register', () => ({ value: undefined }) as any)
  on('tool.register', () => ({ value: undefined }) as any)
  on('session.start', (_$: any, e: any) => e)
  on('session.id', () => ({ value: 'aaaa1111' }) as any)
  on('session.cwd', () => ({ value: 'C:/Users/user' }) as any)
  mock.store(on)
}
const startCmd = ($: any) => $.session.start({ cwd: 'C:/Users/user', surface: 'terminal', isInteractive: true })

test('0.63.56: a refused submit is retried 15 s apart at most 3 times, the error recorded, never marked done and never attached to a tool result', async ($, on) => {
  const NOW = 1_000_000
  const clock = mock.clock(on, { now: NOW })
  const files: Record<string, string> = { 'commands/aaaa1111.json': JSON.stringify({ nonce: 'n1', text: '請回覆收件', at: NOW - 1000 }) }
  let tries = 0
  cmdRig(on, files)
  on('prompt.submit', () => { tries++; throw new Error('session not accepting input') })
  await startCmd($)
  await clock.advance(3000)
  expect(tries).toBe(1)
  expect(files['commands/aaaa1111.done.json']).toBeUndefined()
  expect(JSON.parse(files['commands/aaaa1111.err.json'])).toMatchObject({ nonce: 'n1', tries: 1 })
  for (let i = 1; i < CMD_TRIES; i++) await clock.advance(CMD_CONFIRM_MS + 1000)
  expect(tries).toBe(CMD_TRIES)
  await clock.advance(CMD_CONFIRM_MS * 3)
  expect(tries).toBe(CMD_TRIES) // 不無限重送
  const out: any = await $.tool.call({ tool: 'Read', file_path: 'a.md' } as any)
  expect((out.context ?? []).join('\n')).not.toContain('請回覆收件') // 不再附進 context 重送
  expect(files['commands/aaaa1111.done.json']).toBeUndefined()
})

test('0.63.56: two messages to an idle Claude both go in, in order, within seconds; each marked done (via submit) once its submit resolves', async ($, on) => {
  const NOW = 1_000_000
  const clock = mock.clock(on, { now: NOW })
  const files: Record<string, string> = { 'commands/aaaa1111.json': JSON.stringify({ nonce: 'n2', text: '第二句', at: NOW - 500, items: [{ nonce: 'n1', text: '第一句', at: NOW - 1000 }, { nonce: 'n2', text: '第二句', at: NOW - 500 }] }) }
  const sent: string[] = []
  cmdRig(on, files)
  on('prompt.submit', (_$: any, e: any) => { sent.push(e.text); return { text: e.text } as any })
  await startCmd($)
  await clock.advance(4000)
  expect(sent).toEqual(['📱 第一句', '📱 第二句'])
  expect(JSON.parse(files['commands/aaaa1111.done.json'])).toMatchObject({ nonce: 'n2', nonces: ['n1', 'n2'], via: 'submit' })
  await clock.advance(CMD_CONFIRM_MS * 2)
  expect(sent.length).toBe(2) // 不重送
})

test('0.63.56: while a submit is still in flight (queued behind a long turn) it is not resent and the next message waits; done once it resolves', async ($, on) => {
  const NOW = 1_000_000
  const clock = mock.clock(on, { now: NOW })
  const files: Record<string, string> = { 'commands/aaaa1111.json': JSON.stringify({ nonce: 'n2', text: 'b', at: NOW, items: [{ nonce: 'n1', text: 'a', at: NOW }, { nonce: 'n2', text: 'b', at: NOW }] }) }
  const sent: string[] = []
  let release: (() => void) | undefined
  cmdRig(on, files)
  on('prompt.submit', (_$: any, e: any) => { sent.push(e.text); return sent.length === 1 ? new Promise(r => { release = () => r({ text: e.text } as any) }) : ({ text: e.text } as any) })
  await startCmd($)
  await clock.advance(CMD_CONFIRM_MS * 3)
  expect(sent).toEqual(['📱 a'])
  expect(files['commands/aaaa1111.done.json']).toBeUndefined()
  release!()
  await clock.advance(3000)
  expect(sent).toEqual(['📱 a', '📱 b'])
  expect(JSON.parse(files['commands/aaaa1111.done.json']).nonces).toEqual(['n1', 'n2'])
})

test('hr effort op (0.63.9): valid levels are stored per session, others refused', async () => {
  const saved: Record<string, unknown> = {}
  const $: any = { store: { set: async (k: string, v: unknown) => { saved[k] = v } }, session: { id: async () => 's1' } }
  expect(await runHr($, { op: 'effort', effort: 'xhigh' })).toEqual({ ok: true, msg: '下一次回覆起投入程度改成 xhigh' })
  expect(saved['effort:s1']).toBe('xhigh')
  expect((await runHr($, { op: 'effort', effort: 'ultra' })).ok).toBe(false)
})

test('command queue (0.63.17): delivers items in order, skips delivered and expired, reads the old single format', () => {
  const now = 1_000_000_000
  const c = { nonce: 'c', text: '三', at: now, items: [{ nonce: 'a', text: '一', at: now }, { nonce: 'b', text: '二', at: now - 11 * 60000 }, { nonce: 'c', text: '三', at: now }] }
  expect(nextCommand(c, new Set(), now)?.nonce).toBe('a')
  expect(nextCommand(c, doneNonces({ nonce: 'a', nonces: ['a'] }), now)?.nonce).toBe('c') // b 過期
  expect(nextCommand(c, doneNonces({ nonce: 'c', nonces: ['a', 'c'] }), now)).toBeUndefined()
  expect(nextCommand({ nonce: 'x', text: '舊格式', at: now }, doneNonces({ nonce: 'y' }), now)?.text).toBe('舊格式')
  expect(nextCommand({ nonce: 'x', text: '舊格式', at: now }, doneNonces({ nonce: 'x' }), now)).toBeUndefined()
})

test('self reload (0.63.25; 0.64.3 one try per version, never in a session marked blocked): only for a newer version on disk while idle', () => {
  expect(newerVersion('0.63.25', '0.63.9')).toBe(true)
  expect(newerVersion('0.63.9', '0.63.25')).toBe(false)
  expect(newerVersion('0.63.25', '0.63.25')).toBe(false)
  expect(newerVersion('1.0.0', '0.99.99')).toBe(true)
  const base = { disk: '0.63.26', loaded: '0.63.25', idle: true, now: 1_000_000 }
  expect(shouldReload(base)).toBe(true)
  expect(shouldReload({ ...base, idle: false })).toBe(false)
  expect(shouldReload({ ...base, disk: '0.63.25' })).toBe(false)
  expect(shouldReload({ ...base, disk: undefined })).toBe(false)
  expect(shouldReload({ ...base, last: { version: '0.63.26', tries: 1, at: base.now - 60e3 } })).toBe(false) // 剛試過
  expect(shouldReload({ ...base, last: { version: '0.63.26', tries: 1, at: 0 } })).toBe(false) // 同一版只試一次，隔多久都不再試
  expect(shouldReload({ ...base, last: { version: '0.63.24', tries: 1, at: base.now } })).toBe(true) // 新的版號重新算
  expect(shouldReload({ ...base, blocked: true })).toBe(false) // 記成不能重載（遠端連線）：新版也不送
  expect(reloadRefused("/reload-plugins isn't available over a remote connection in this session.")).toBe(true)
  expect(reloadRefused('Error: /reload-plugins is not available over a remote connection')).toBe(true)
  expect(reloadRefused('Reloaded: 2 plugins · 8 skills')).toBe(false)
  expect(reloadRefused(undefined)).toBe(false)
})

test('reload gate (0.63.26): no turn, no queued message, no approval, empty draft, 5 quiet minutes', () => {
  const ok = { turnRunning: false, cmdPending: false, approval: false, draft: '', lastActive: 0, now: RELOAD_QUIET_MS }
  expect(canReloadNow(ok)).toBe(true)
  expect(canReloadNow({ ...ok, turnRunning: true })).toBe(false)
  expect(canReloadNow({ ...ok, cmdPending: true })).toBe(false)
  expect(canReloadNow({ ...ok, approval: true })).toBe(false)
  expect(canReloadNow({ ...ok, draft: '打到一半' })).toBe(false)
  expect(canReloadNow({ ...ok, draft: '   ' })).toBe(true)
  expect(canReloadNow({ ...ok, lastActive: 1 })).toBe(false) // 不到 5 分鐘
})

test('reloadIfIdle (0.63.27): a failed draft read means no reload, and the answer is an object, never a bare promise', async () => {
  let ran = 0
  const $: any = { prompt: { read: async () => { throw new Error('no box') } }, command: { run: async () => { ran++ } } }
  const r = await reloadIfIdle($)
  expect(r).toEqual({ ran: false })
  expect(ran).toBe(0)
  const $2: any = { prompt: { read: async () => ({ text: '', cursor: 0 }) }, command: { run: async () => { ran++ } } }
  const r2 = await reloadIfIdle($2) // 剛載入：5 分鐘內有活動，不重載
  expect(r2).toEqual({ ran: false })
  expect(ran).toBe(0)
})

test('art A #14 review: a manager whose name is a command still keeps his team at his table; only the nameplate becomes the short code', () => {
  const P = (id: string, extra: object = {}) => ({ id, name: id, mode: 'idle', tool: '', isMe: false, role: 'staff', ...extra }) as Coworker
  const crew = [P('b0ss1234', { name: '/boss', role: 'manager', agent: 'lead' }), P('s1', { name: 'staffA', team: '/boss' }), P('s2', { name: 'staffB', team: '/boss' })]
  const list = v2List(crew)
  expect(list.find(p => p.id === 'b0ss1234')!.plate).toBe('s-b0ss') // 名牌：短代號
  expect(list.find(p => p.id === 'b0ss1234')!.name).toBe('/boss') // 名字照原樣（團隊靠它對）
  const { map } = assignV2(emptyV2(), list, 0)
  const table = (id: string) => /^t(\d+)\./.exec(map.get(id) ?? '')?.[1]
  expect(table('b0ss1234')).toBeDefined()
  expect(table('s1')).toBe(table('b0ss1234'))
  expect(table('s2')).toBe(table('b0ss1234'))
})

import { baseName, claimTables, moveSeat, parseStore, pinSeat, retarget, teamsOf } from './officeV2'
const v2table = (id: number, team: string | undefined, extra: Record<string, unknown> = {}) => ({ id, name: `桌${id}`, size: 4, ...(team ? { team } : {}), ...extra }) as any

test('0.64.7: a department lead (manager with own members, team=upper manager) sits at the head of its own table, not at the upper manager table', () => {
  const top = { id: 'top', plate: 'T', name: 'T', role: 'manager', agent: 'willy主管' }
  const mate = { id: 'mate', plate: 'O', role: 'staff', team: 'willy主管' }
  const lead = { id: 'lead', plate: 'D', name: 'D', role: 'manager', agent: 'willy設計', team: 'willy主管' }
  const a = { id: 'a', plate: 'A', role: 'staff', team: 'willy設計' }
  const b = { id: 'b', plate: 'B', role: 'staff', team: 'willy設計' }
  const people = [top, mate, lead, a, b] as any
  expect(teamsOf(people).get('willy主管')!.map(p => p.id)).toEqual(['top', 'mate'])
  expect(teamsOf(people).get('willy設計')!.map(p => p.id)).toEqual(['lead', 'a', 'b'])
  const S = v2empty()
  const { map } = v2assign(S, people, 0)
  const own = S.tables.find(t => t.team === 'willy設計')!
  expect(map.get('lead')).toBe(`t${own.id}.0`)
  expect([map.get('a'), map.get('b')].every(k => k?.startsWith(`t${own.id}.`))).toBe(true)
  // 自動開的桌照人數加大（最多 8）；使用者建的桌不動
  const S2 = v2empty()
  v2assign(S2, [lead, a] as any, 0)
  expect(S2.tables[0]).toMatchObject({ auto: true, size: 2 })
  const { map: m2 } = v2assign(S2, [lead, a, b] as any, 1)
  expect(S2.tables[0].size).toBe(4)
  expect([m2.get('lead'), m2.get('a'), m2.get('b')].every(k => k?.startsWith(`t${S2.tables[0].id}.`))).toBe(true)
  S2.tables[0].auto = false
  S2.tables[0].size = 2
  v2assign(S2, [lead, a, b] as any, 2)
  expect(S2.tables[0].size).toBe(2)
  // 部門主管底下沒人：照舊是上一層的組員
  expect(teamsOf([top, mate, lead] as any).get('willy主管')!.map(p => p.id)).toEqual(['top', 'mate', 'lead'])
})

test('0.63.57: a table still named after the old manager goes to the new manager pinned at its head seat; old group cleared; Codex member sits there too', () => {
  const S = v2empty()
  S.tables = [v2table(2, '主管（接續）', { group: { boss: 'old', team: '主管（接續）', notified: [], at: 0, complete: true } })]
  S.nextId = 3
  S.pins = { b: 't2.0', x: 't2.1' }
  const boss = { id: 'b', plate: 'B', name: 'B', role: 'manager', agent: '主管' }
  const pinned = { id: 'x', plate: 'X', role: 'staff', team: '主管' }
  const cx = { id: 'c', plate: 'C', role: 'staff', team: '主管', kind: 'codex' }
  const r = v2assign(S, [boss, pinned, cx] as any, 0)
  expect(S.tables).toHaveLength(1) // 沒有另開一張
  expect(S.tables[0].team).toBe('主管')
  expect(S.tables[0].group).toBeUndefined()
  expect(r.dirty).toBe(true)
  expect(r.map.get('b')).toBe('t2.0')
  expect(r.map.get('c')).toMatch(/^t2\.[1-3]$/) // Codex 組員（kind=codex）也排進桌
})

test('0.63.57: the old table is found by where the manager sat last time; a table whose team names his plate is an alias', () => {
  const S = v2empty()
  S.tables = [v2table(5, '走掉的主管')]
  S.nextId = 6
  S.seats = { b: { key: 't5.0', seen: 0 } }
  const boss = { id: 'b', plate: 'B', name: 'B', role: 'manager', agent: '主管' }, mate = { id: 'm', plate: 'M', role: 'staff', team: '主管' }
  const r = v2assign(S, [boss, mate] as any, 0)
  expect(S.tables.map(t => t.team)).toEqual(['主管'])
  expect(r.map.get('b')).toBe('t5.0')
  const A = v2empty()
  A.tables = [v2table(1, 'B')] // team 寫成名牌
  A.nextId = 2
  v2assign(A, [boss, mate] as any, 0)
  expect(A.tables.map(t => t.team)).toEqual(['主管'])
})

test('0.63.57: a table whose team is an online manager (even with no members) is never taken; unrelated stale tables are left alone', () => {
  const S = v2empty()
  S.tables = [v2table(1, '別的主管'), v2table(2, '沒人的舊隊', { group: { boss: 'z', team: '沒人的舊隊', notified: [], at: 0, complete: true } })]
  S.nextId = 3
  S.pins = { b: 't1.0' }
  const boss = { id: 'b', plate: 'B', name: 'B', role: 'manager', agent: '主管' }, mate = { id: 'm', plate: 'M', role: 'staff', team: '主管' }
  const other = { id: 'o', plate: 'O', name: 'O', role: 'manager', agent: '別的主管' }
  v2assign(S, [boss, mate, other] as any, 0)
  expect(S.tables.find(t => t.id === 1)!.team).toBe('別的主管')
  expect(S.tables.find(t => t.id === 2)!.team).toBe('沒人的舊隊') // 他沒坐過這桌：不動
  expect(S.tables.find(t => t.id === 2)!.group).toBeDefined() // team 沒被改，group 不碰
  expect(S.tables.some(t => t.team === '主管' && t.auto)).toBe(true) // 照舊另開
  expect(claimTables(S, [boss, mate, other] as any, teamsOf([boss, mate, other] as any))).toBe(false) // 0.63.58：認桌改以桌為主，再跑一次也不動
})

test('0.63.57: retarget clears the group only when the team really changes', () => {
  const g = { boss: 'b', team: '主管', notified: [], at: 0, complete: true }
  const t = v2table(1, '主管', { group: g })
  expect(retarget(t, '主管')).toBe(false)
  expect(t.group).toBe(g)
  expect(retarget(t, '新主管')).toBe(true)
  expect(t.team).toBe('新主管')
  expect(t.group).toBeUndefined()
})

test('0.63.57 T-1: a sub-lead dragged to a non-head seat of the big manager table does not take it while the big manager is briefly offline', () => {
  const S = v2empty()
  const g = { boss: 'big', team: '大主管', notified: [], at: 0, complete: true }
  S.tables = [v2table(2, '大主管', { group: g })]
  S.nextId = 3
  S.pins = { sub: 't2.3' }
  const sub = { id: 'sub', plate: 'S', name: 'S', role: 'manager', agent: '小隊長', team: '大主管' }, mine = { id: 'm', plate: 'M', role: 'staff', team: '小隊長' }
  v2assign(S, [sub, mine] as any, 0) // 大主管不在名冊
  const t2 = S.tables.find(t => t.id === 2)!
  expect(t2.team).toBe('大主管')
  expect(t2.group).toBe(g)
})

test('0.63.57 T-2: an alias never takes the table of an online manager', () => {
  const S = v2empty()
  S.tables = [v2table(1, '小明')]
  S.nextId = 2
  const a = { id: 'a', plate: 'A', name: 'A', role: 'manager', agent: '小明' }
  const b = { id: 'b', plate: '小明', name: '小明', role: 'manager', agent: 'B隊' }
  v2assign(S, [a, b, { id: 'x', role: 'staff', team: 'B隊' }] as any, 0)
  expect(S.tables.find(t => t.id === 1)!.team).toBe('小明')
})

// ── 0.63.58（顧問裁示）：釘選記來源、team 改了才拉回桌、以桌為主認主管、死掉的釘選清掉 ──
const mgr = (id: string, agent: string, extra: Record<string, unknown> = {}) => ({ id, plate: id.toUpperCase(), name: id.toUpperCase(), role: 'manager', agent, ...extra })
const staff = (id: string, team: string, extra: Record<string, unknown> = {}) => ({ id, plate: id.toUpperCase(), role: 'staff', team, ...extra })

test('0.63.58: the whole team pinned to the old table (nobody left to place) still moves the table to the current manager', () => {
  const S = v2empty()
  S.tables = [v2table(2, '走掉的主管', { group: { boss: 'z', team: '走掉的主管', notified: [], at: 0, complete: true } })]
  S.nextId = 3
  S.pins = { b: 't2.0', m: 't2.1' }
  const r = v2assign(S, [mgr('b', '主管'), staff('m', '主管')] as any, 0)
  expect(S.tables.map(t => t.team)).toEqual(['主管']) // 沒另開一張
  expect(S.tables[0].group).toBeUndefined()
  expect(r.dirty).toBe(true)
  expect(r.map.get('b')).toBe('t2.0')
  expect(r.map.get('m')).toBe('t2.1')
})

test('0.63.58: the first run only records everyone\'s team as the baseline and clears nothing; a real team change (off → boss, A → B) then pulls the office-area pin back to the team table', () => {
  const S = v2empty()
  S.pins = { x: 'o0', y: 'o1', c: 'o2' } // 升級前的舊釘選，沒有來源
  const boss = mgr('b', '主管'), boss2 = mgr('b2', '乙')
  let r = v2assign(S, [boss, staff('x', '主管'), { id: 'y', role: 'staff' }, staff('c', '主管', { kind: 'codex' })] as any, 0)
  expect([r.map.get('x'), r.map.get('y'), r.map.get('c')]).toEqual(['o0', 'o1', 'o2']) // 第一次跑：都不動
  expect(S.joined).toEqual({ b: { team: '' }, x: { team: '主管' }, y: { team: '' }, c: { team: '主管' } })
  r = v2assign(S, [boss, staff('x', '主管'), { id: 'y', role: 'staff' }, staff('c', '主管', { kind: 'codex' })] as any, 1)
  expect(r.map.get('x')).toBe('o0') // team 沒變：照舊
  // y：沒有 → 主管；c（Codex）：主管 → 乙（換主管）
  r = v2assign(S, [boss, boss2, staff('x', '主管'), staff('y', '主管'), staff('c', '乙', { kind: 'codex' })] as any, 2)
  const t1 = S.tables.find(t => t.team === '主管')!, t2 = S.tables.find(t => t.team === '乙')!
  expect(r.map.get('x')).toBe('o0')
  expect(r.map.get('y')).toMatch(new RegExp(`^t${t1.id}\\.[1-3]$`))
  expect(r.map.get('c')).toMatch(new RegExp(`^t${t2.id}\\.[1-3]$`))
  expect(S.pins).toEqual({ x: 'o0' })
  expect(S.joined!.c).toEqual({ team: '乙' })
  // team 改成沒有：只記基準，不動釘選
  S.pins.x = 'o5'
  v2assign(S, [boss, staff('y', '主管'), { id: 'x', role: 'staff' }] as any, 3)
  expect(S.pins.x).toBe('o5')
  expect(S.joined!.x).toEqual({ team: '' })
})

test('0.63.58: pins carry their source; on a team change hire pins and legacy pins go, a drag goes only if it was made before the change; a briefly-offline manager clears nothing', () => {
  const S = v2empty()
  S.pins = { old: 'o0' }
  pinSeat(S, 'h', 'o1', 'hire', 100)
  pinSeat(S, 'd1', 'o2', 'drag', 100)
  pinSeat(S, 'd2', 'o3', 'drag', 100)
  pinSeat(S, 'tb', 't9.1', 'hire', 100) // 協作桌上的不動（桌子這次不存在也不算 o 開頭）
  const ids = ['old', 'h', 'd1', 'd2']
  v2assign(S, ids.map(id => staff(id, '舊隊')) as any, 120) // 基準：舊隊（舊隊主管不在線）
  // 150：team 改成「主管」，但主管不在線 → 先不清，記下改變時間
  v2assign(S, ids.map(id => staff(id, '主管')) as any, 150)
  expect(S.joined!.h).toEqual({ team: '舊隊', next: '主管', at: 150 })
  expect(Object.keys(S.pins).sort()).toEqual(['d1', 'd2', 'h', 'old', 'tb'])
  // 180：使用者在 team 改了以後又拖了 d2 一次
  pinSeat(S, 'd2', 'o3', 'drag', 180)
  // 200：主管上線、團隊成形 → hire、舊釘選、改變前拖的 d1 清掉；改變後拖的 d2 留著
  const r = v2assign(S, [mgr('b', '主管'), ...ids.map(id => staff(id, '主管'))] as any, 200)
  expect(S.pins.h).toBeUndefined()
  expect(S.pins.old).toBeUndefined()
  expect(S.pins.d1).toBeUndefined()
  expect(S.pins.d2).toBe('o3')
  expect(r.map.get('d2')).toBe('o3')
  expect(S.pinBy!.d2).toEqual({ by: 'drag', at: 180 })
  expect(S.joined!.h).toEqual({ team: '主管' })
})

test('0.63.58: moveSeat records a drag for the person dragged and hire for whoever got swapped out; the new fields survive parseStore', () => {
  const S = v2empty()
  S.seats = { a: { key: 'o0', seen: Date.now() }, b: { key: 'o1', seen: Date.now() } }
  expect(moveSeat(S, 'a', 'o1', new Set(['a', 'b'])).ok).toBe(true)
  expect(S.pins).toEqual({ a: 'o1', b: 'o0' })
  expect(S.pinBy!.a.by).toBe('drag')
  expect(S.pinBy!.b.by).toBe('hire')
  S.joined = { a: { team: '主管' } }
  S.bossAt = { m: 5 }
  const back = parseStore(JSON.stringify(S))
  expect(back.pinBy).toEqual(S.pinBy)
  expect(back.joined).toEqual(S.joined)
  expect(back.bossAt).toEqual(S.bossAt)
  expect(parseStore(JSON.stringify({ tables: [], seats: {}, pins: {}, nextId: 1 })).pinBy).toBeUndefined() // 舊檔照讀
})

test('0.63.58: old and new manager online together, names differing only by the bracket suffix: the table goes to the new one, who takes the head seat; no second table', () => {
  expect(baseName('示範團隊主管（接手）')).toBe('示範團隊主管')
  expect(baseName('主管 (2)（接續）')).toBe('主管')
  expect(baseName('（只有括號）')).toBe('')
  const S = v2empty()
  S.tables = [v2table(2, '示範團隊主管（接續）'), v2table(3, '示範團隊主管（接手）', { auto: true })] // 0.63.57 已經替新主管另開了一張
  S.nextId = 4
  S.pins = { old: 't2.0', cx: 'o0', m3: 't3.1' }
  S.seats = { old: { key: 't2.0', seen: 0 }, cx: { key: 'o0', seen: 0 }, m3: { key: 't3.1', seen: 0 } }
  S.joined = { cx: { team: '示範團隊主管' } } // Codex 本來掛舊主管
  const oldBoss = mgr('old', '示範團隊主管'), newBoss = mgr('new', '示範團隊主管（接手）')
  const people = [oldBoss, newBoss, staff('m', '示範團隊主管（接手）'), staff('m3', '示範團隊主管（接手）'), staff('cx', '示範團隊主管（接手）', { kind: 'codex' })]
  const r = v2assign(S, people as any, 0) // 舊主管先登記？同一次看到：帶團隊的、有後綴的優先
  expect(S.tables.map(t => [t.id, t.team])).toEqual([[2, '示範團隊主管（接手）']]) // 自動桌收掉
  expect(r.map.get('new')).toBe('t2.0')
  expect(r.map.get('old')).toMatch(/^o\d+$/)
  expect(S.pins.old).toBe(r.map.get('old')) // 讓位後的新座位記成 hire（顧問裁示 M-1）
  expect(S.pinBy!.old.by).toBe('hire')
  expect(r.map.get('m')).toMatch(/^t2\.[1-3]$/)
  expect(r.map.get('m3')).toMatch(/^t2\.[1-3]$/)
  expect(r.map.get('cx')).toMatch(/^t2\.[1-3]$/) // team 換到新主管：Codex 的 o0 清掉、坐進桌 2
  // 舊主管比較晚登記也一樣：最新登記的才接
  const A = v2empty()
  A.tables = [v2table(2, '隊（接續）')]
  A.nextId = 3
  A.bossAt = { a: 100, b: 200 }
  v2assign(A, [mgr('a', '隊（甲）'), mgr('b', '隊（乙）'), staff('x', '隊（甲）')] as any, 300)
  expect(A.tables.find(t => t.id === 2)!.team).toBe('隊（乙）')
})

test('0.63.58: a finished handover record wins over names and head seats, even while the old manager is still online', () => {
  const S = v2empty()
  S.tables = [v2table(1, '老大')]
  S.nextId = 2
  S.pins = { a: 't1.0' }
  const a = mgr('a', '老大'), n = mgr('n', '新來的'), m = staff('m', '新來的')
  v2assign(S, [a, n, m] as any, 0)
  expect(S.tables.find(t => t.id === 1)!.team).toBe('老大') // 沒紀錄：在線主管的桌不搶
  const H = v2empty()
  H.tables = [v2table(1, '老大')]
  H.nextId = 2
  H.pins = { a: 't1.0' }
  const r = v2assign(H, [a, n, m] as any, 0, [{ id: 'h1', table: 1, newSid: 'n', oldHandle: '老大', at: 10 }])
  expect(H.tables.map(t => t.team)).toEqual(['新來的'])
  expect(r.map.get('n')).toBe('t1.0')
  expect(r.map.get('m')).toMatch(/^t1\.[1-3]$/)
})

test('0.63.58 H-1: an old handover record never takes a table back after it was given to another online manager (hire with no boss, promote, team-up)', () => {
  // 桌 2 交接給 C（done）→ C 暫離 → 桌 2 另聘 D（team 改成 D，D 釘在主管椅）→ C 回來（還是主管、沒有組員）
  const S = v2empty()
  S.tables = [v2table(2, 'D隊')]
  S.nextId = 3
  pinSeat(S, 'd', 't2.0', 'hire', 0)
  const rec = [{ id: 'hc', table: 2, newSid: 'c', oldHandle: '老主管', at: 5 }]
  const c = mgr('c', 'C隊'), d = mgr('d', 'D隊'), m = staff('m', 'D隊')
  for (const now of [10, 20]) { // 每次輪詢都一樣
    const r = v2assign(S, [c, d, m] as any, now, rec)
    expect(S.tables.map(t => [t.id, t.team])).toEqual([[2, 'D隊']])
    expect(S.pins.d).toBe('t2.0')
    expect(r.map.get('d')).toBe('t2.0')
    expect(r.map.get('m')).toMatch(/^t2\.[1-3]$/)
  }
  expect(v2assign(S, [c, d, m] as any, 30, rec).dirty).toBe(false) // 不會一直存檔
  // D 也下線了、桌子對不到在線主管：紀錄才又算數
  v2assign(S, [c, staff('x', 'C隊')] as any, 40, rec)
  expect(S.tables.find(t => t.id === 2)!.team).toBe('C隊')
  // 同一張桌有好幾筆：只看最新的
  const T = v2empty()
  T.tables = [v2table(2, '老主管')]
  T.nextId = 3
  v2assign(T, [mgr('e', 'E隊'), mgr('c', 'C隊'), staff('y', 'C隊')] as any, 0, [{ id: 'he', table: 2, newSid: 'e', oldHandle: '老主管', at: 9 }, { id: 'hc2', table: 2, newSid: 'c', oldHandle: '更早的', at: 1 }])
  expect(T.tables.find(t => t.id === 2)!.team).toBe('E隊')
})

test('0.63.58 H-1: table 7 real case: the done record points at the current boss; nothing changes, and after the table goes to a big manager of a layered team it stays his', () => {
  const S = v2empty()
  S.tables = [v2table(7, '資料整理主管')]
  S.nextId = 8
  S.pins = { f7: 't7.0' }
  const rec = [{ id: 'h7', table: 7, newSid: 'f7', oldHandle: '資料庫主管（舊）', at: 1 }]
  const boss = mgr('f7', '資料整理主管'), mate = staff('w', '資料整理主管')
  let r = v2assign(S, [boss, mate] as any, 0, rec)
  expect(S.tables.map(t => t.team)).toEqual(['資料整理主管'])
  expect(r.map.get('f7')).toBe('t7.0')
  // 之後用「設成一組」把桌 7 交給大主管，原主管還是 manager（分層團隊的小主管，team 掛大主管）
  S.tables[0].team = '大主管'
  pinSeat(S, 'big', 't7.0', 'hire', 2)
  pinSeat(S, 'f7', 't7.1', 'hire', 2)
  const big = mgr('big', '大主管'), sub = mgr('f7', '資料整理主管', { team: '大主管' })
  r = v2assign(S, [big, sub, mate] as any, 3, rec)
  expect(S.tables.find(t => t.id === 7)!.team).toBe('大主管')
  expect(r.map.get('big')).toBe('t7.0')
})

test('0.63.58: a manager of another team with the same base name only takes a table whose team matches no online manager', () => {
  const S = v2empty()
  S.tables = [v2table(1, '主管'), v2table(2, '主管（舊）')]
  S.nextId = 3
  const live = mgr('a', '主管'), other = mgr('b', '主管(B組)')
  v2assign(S, [live, other, staff('x', '主管(B組)')] as any, 0)
  expect(S.tables.find(t => t.id === 1)!.team).toBe('主管') // 在線主管的桌（他沒有組員）不搶
  expect(S.tables.find(t => t.id === 2)!.team).toBe('主管(B組)') // 對不到在線主管的舊桌才接
  expect(S.tables).toHaveLength(2)
})

test('0.63.58: dead pins (id no longer in seats) are dropped; a hire still on the way (under an hour) and a reserved seat stay', () => {
  const S = v2empty()
  S.tables = [v2table(2, '主管')]
  S.nextId = 3
  const now = 10 * 3600e3
  S.pins = { d1: 't2.0', d2: 't2.1', d3: 'o4', res: 't2.3' }
  pinSeat(S, 'fresh', 't2.2', 'hire', now - 60e3)
  S.reserved = { res: 't2.3' }
  S.seats = { live: { key: 'o0', seen: now } }
  const r = v2assign(S, [{ id: 'live', role: 'staff' }] as any, now)
  expect(Object.keys(S.pins).sort()).toEqual(['fresh', 'res'])
  expect(Object.keys(S.pinBy!)).toEqual(['fresh'])
  expect(r.dirty).toBe(true)
})

test('0.63.58 H-1: a handover record is used once (handApplied); after that C coming back never takes the table, even if its team no longer matches anyone online', () => {
  const S = v2empty()
  S.tables = [v2table(2, '老主管')]
  S.nextId = 3
  const rec = [{ id: 'hc', table: 2, newSid: 'c', oldHandle: '老主管', at: 5 }]
  const c = mgr('c', 'C隊'), m = staff('m', 'C隊')
  v2assign(S, [c, m] as any, 10, rec)
  expect(S.tables.find(t => t.id === 2)!.team).toBe('C隊')
  expect(S.handApplied).toEqual({ hc: 10 })
  // C 暫離；桌 2 後來給了別人（X），X 也不在線；C 的座位紀錄也沒了
  S.tables.find(t => t.id === 2)!.team = 'X隊'
  delete S.seats.c; delete S.seats.m
  const r = v2assign(S, [c, m] as any, 20, rec)
  expect(S.tables.find(t => t.id === 2)!.team).toBe('X隊') // 紀錄用過了：不搶回去
  expect(r.map.get('c')).not.toMatch(/^t2\./)
  // swapBoss 已經改好的桌：紀錄直接記成用過
  const T = v2empty()
  T.tables = [v2table(4, 'C隊')]
  T.nextId = 5
  v2assign(T, [c, m] as any, 30, [{ id: 'h4', table: 4, newSid: 'c', oldHandle: '老主管', at: 1 }])
  expect(T.handApplied).toEqual({ h4: 30 })
  // 複審 H-1b：紀錄還在檔裡就不忘；沒給紀錄（外掛面板）也不清
  const day = 24 * 3600e3
  const h4 = [{ id: 'h4', table: 4, newSid: 'c', oldHandle: '老主管', at: 1 }]
  v2assign(T, [c, m] as any, 30 + 8 * day, h4)
  expect(T.handApplied).toEqual({ h4: 30 })
  v2assign(T, [c, m] as any, 30 + 8 * day)
  expect(T.handApplied).toEqual({ h4: 30 })
  // 檔裡一時讀不到（讀成空的）但套用還不到 7 天：不忘
  v2assign(T, [c, m] as any, 30 + 3 * day, [])
  expect(T.handApplied).toEqual({ h4: 30 })
  // 紀錄已經不在檔裡、而且套用超過 7 天：才忘
  v2assign(T, [c, m] as any, 30 + 8 * day, [])
  expect(T.handApplied).toEqual({})
  expect(parseStore(JSON.stringify({ ...T, handApplied: { z: 1 } })).handApplied).toEqual({ z: 1 })
})

test('0.63.58 H-1b: an applied record 8 days later, owner D offline, C online: the table does not move and nothing is saved', () => {
  const day = 24 * 3600e3
  const S = v2empty()
  S.tables = [v2table(2, '老主管')]
  S.nextId = 3
  const rec = [{ id: 'hc', table: 2, newSid: 'c', oldHandle: '老主管', at: 5 }]
  const c = mgr('c', 'C隊'), cm = staff('cm', 'C隊')
  v2assign(S, [c, cm] as any, 10, rec) // 套用
  expect(S.handApplied).toEqual({ hc: 10 })
  // 之後桌 2 另聘 D，D 帶著組員坐桌
  S.tables[0].team = 'D隊'
  delete S.seats.c; delete S.seats.cm
  pinSeat(S, 'd', 't2.0', 'hire', 20)
  const d = mgr('d', 'D隊'), dm = staff('dm', 'D隊')
  v2assign(S, [c, cm, d, dm] as any, 20, rec)
  // 8 天後：D 和組員都不在線，C 和組員在線；紀錄還在檔裡
  const later = 10 + 8 * day
  v2assign(S, [c, cm] as any, later, rec)
  const r = v2assign(S, [c, cm] as any, later + 1, rec)
  expect(S.tables.find(t => t.id === 2)!.team).toBe('D隊')
  expect(S.handApplied).toEqual({ hc: 10 })
  expect(r.dirty).toBe(false)
  expect(r.map.get('c')).not.toMatch(/^t2\./)
})

test('0.63.58 H-1b: a record done more than 7 days ago is never used, even if it was never applied', () => {
  const day = 24 * 3600e3
  const S = v2empty()
  S.tables = [v2table(2, '老主管')]
  S.nextId = 3
  v2assign(S, [mgr('c', 'C隊'), staff('cm', 'C隊')] as any, 8 * day, [{ id: 'old', table: 2, newSid: 'c', oldHandle: '老主管', at: 0 }])
  expect(S.tables.find(t => t.id === 2)!.team).toBe('老主管')
  expect(S.handApplied).toBeUndefined()
  // 7 天內的一樣照用
  const T = v2empty()
  T.tables = [v2table(2, '老主管')]
  T.nextId = 3
  v2assign(T, [mgr('c', 'C隊'), staff('cm', 'C隊')] as any, 6 * day, [{ id: 'new', table: 2, newSid: 'c', oldHandle: '老主管', at: 0 }])
  expect(T.tables.find(t => t.id === 2)!.team).toBe('C隊')
})

test('0.63.58 M-1: anyone but the owner on seat 0 gives it up, whatever the pin source: own members move to the nearest free seat at the table, others to the office area; new seats are hire pins', () => {
  const S = v2empty()
  S.tables = [v2table(2, '新主管', { size: 4 })]
  S.nextId = 3
  S.pins = { old: 't2.0' } // 舊主管已經降成員工，沒有來源地釘在主管椅
  const boss = mgr('b', '新主管'), mate = staff('m', '新主管'), old = { id: 'old', plate: 'OLD', role: 'staff' }
  let r = v2assign(S, [boss, mate, old] as any, 0)
  expect(r.map.get('b')).toBe('t2.0')
  expect(r.map.get('old')).toMatch(/^o\d+$/)
  expect(S.pinBy!.old).toEqual({ by: 'hire', at: 0 })
  // 組員被拖到主管椅：讓位到同一桌最近的空位
  const A = v2empty()
  A.tables = [v2table(5, '新主管', { size: 4 })]
  A.nextId = 6
  pinSeat(A, 'm', 't5.0', 'drag', 0)
  r = v2assign(A, [boss, mate] as any, 1)
  expect(r.map.get('b')).toBe('t5.0')
  expect(r.map.get('m')).toBe('t5.1')
  expect(A.pins.m).toBe('t5.1')
  expect(A.pinBy!.m.by).toBe('hire')
})

test('0.63.58 M-1: while the owner is offline (or pinned somewhere else) nobody on seat 0 is moved', () => {
  const S = v2empty()
  S.tables = [v2table(2, '新主管')]
  S.nextId = 3
  S.pins = { old: 't2.0' }
  const old = { id: 'old', plate: 'OLD', role: 'staff' }
  let r = v2assign(S, [old, staff('m', '新主管')] as any, 0) // 主人不在線
  expect(r.map.get('old')).toBe('t2.0')
  expect(S.pins.old).toBe('t2.0')
  pinSeat(S, 'b', 'o7', 'drag', 0) // 主人在線，但使用者把他拖到辦公區
  r = v2assign(S, [mgr('b', '新主管'), old, staff('m', '新主管')] as any, 1)
  expect(r.map.get('old')).toBe('t2.0')
  expect(r.map.get('b')).toBe('o7')
})

test('0.63.58: a full table (no growing past its size): non-members not dragged there give their seats to the owner\'s members; dragged ones stay', () => {
  const S = v2empty()
  S.tables = [v2table(2, '新主管', { size: 4 })]
  S.nextId = 3
  S.pins = { o1: 't2.1', o2: 't2.2' } // 舊團隊的人，沒有來源
  pinSeat(S, 'o3', 't2.3', 'drag', 0) // 使用者特意放的
  const oldTeam = (id: string) => staff(id, '舊主管')
  const boss = mgr('b', '新主管'), m1 = staff('m1', '新主管'), m2 = staff('m2', '新主管'), m3 = staff('m3', '新主管')
  const r = v2assign(S, [boss, m1, m2, m3, oldTeam('o1'), oldTeam('o2'), oldTeam('o3')] as any, 0)
  expect(S.tables).toHaveLength(1)
  expect(S.tables[0].size).toBe(4) // 不自動加大
  expect(r.map.get('b')).toBe('t2.0')
  expect(r.map.get('o3')).toBe('t2.3')
  expect([r.map.get('m1'), r.map.get('m2')].sort()).toEqual(['t2.1', 't2.2'])
  expect(r.map.get('m3')).toMatch(/^o\d+$/) // 沒位子了、也沒人能讓
  expect(r.map.get('o1')).toMatch(/^o\d+$/)
  expect(r.map.get('o2')).toMatch(/^o\d+$/)
  expect(S.pinBy!.o1.by).toBe('hire')
  expect(S.pinBy!.o3).toEqual({ by: 'drag', at: 0 })
  // 再跑一次不變、不存檔
  expect(v2assign(S, [boss, m1, m2, m3, oldTeam('o1'), oldTeam('o2'), oldTeam('o3')] as any, 1).dirty).toBe(false)
})
