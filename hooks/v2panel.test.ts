// Desktop 面板 v2 辦公室：座位排法跟手機版同一套、SVG 壓在面板上限內、名牌與主管標示畫得出來
import { expect, test } from 'claude-code/testing'

import { assign, demoPeople, emptyStore, tablesOut } from './officeV2'
import { SVG_MAX } from './scene'
import { plateLines, v2PanelSvg } from './v2panel'

const MODE = { idle: 'idle', thinking: 'thinking', typing: 'typing', reading: 'reading', waiting: 'waiting', done: 'done', blocked: 'blocked' }
function office(n: number) {
  const S = emptyStore()
  const people = demoPeople(n, MODE, 0)
  const { map } = assign(S, people, 0)
  return { people: people.map(p => ({ ...p, seat: map.get(p.id) })), tables: tablesOut(S, people) }
}

test('v2 panel: teams sit at collaboration tables, everyone else in the office area, SVG stays under the Desktop limit', () => {
  for (const n of [0, 3, 12, 30, 60]) {
    const { people, tables } = office(n)
    expect(people.filter(p => p.team).every(p => /^t\d+\./.test(p.seat!))).toBe(true)
    const { svg } = v2PanelSvg(people, tables, { frame: 0, pxWidth: 900, pxHeight: 700 })
    expect(svg.length).toBeLessThanOrEqual(SVG_MAX)
    for (const p of people.slice(0, 5)) expect(svg).toContain(p.plate.slice(0, 2))
  }
})

test('v2 panel: managers get a gold nameplate and waiting people a pulsing ring', () => {
  const { people, tables } = office(12)
  const { svg } = v2PanelSvg(people, tables, { frame: 0, pxWidth: 600 })
  expect(svg).toContain('★')
  expect(people.some(p => p.mode === 'waiting')).toBe(true)
  expect(svg).toContain('stroke="#ff9a3c"')
})

test('v2 panel budget (art A review ②): 60 people + 9 mail notices stays under the Desktop limit with everything drawn; a bit more drops extras instead of falling back', () => {
  const run = (n: number) => {
    const { people, tables } = office(n)
    const notices = people.slice(0, 9).map(p => ({ id: p.id, start: 0, end: 100 }))
    return v2PanelSvg(people, tables, { frame: 1, pxWidth: 900, pxHeight: 700, notices }).svg
  }
  const s60 = run(60)
  expect(s60.length).toBeLessThanOrEqual(SVG_MAX)
  expect(s60).toContain('stroke="#d84315"') // 信封還在
  const s65 = run(65) // 全畫會超過：先拿掉裝飾、紙飛機、信封，還是 v2 畫面
  expect(s65.length).toBeLessThanOrEqual(SVG_MAX)
  expect(s65).toContain('data:image/png;base64,')
  expect(s65).not.toContain('stroke="#d84315"')
})

test('v2 panel table plate (art A review ③): the head count always stays; a long name shrinks, then wraps to two lines, never cut before the count', () => {
  const short = plateLines('簡報團隊', '（4人）')
  expect(short.lines).toEqual(['簡報團隊（4人）'])
  const long = plateLines('資料整理主管團隊的超長協作桌名字一定要換行才放得下', '（6人）')
  expect(long.lines.length).toBe(2)
  expect(long.lines[1].endsWith('（6人）')).toBe(true)
  expect(long.lines.join('')).toBe('資料整理主管團隊的超長協作桌名字一定要換行才放得下（6人）') // 沒有被截
  const huge = plateLines('一'.repeat(80), '（8人）')
  expect(huge.lines[1].endsWith('…（8人）')).toBe(true) // 真的太長：只截桌名，人數留著
  const { people, tables } = office(12)
  tables[0] = { ...tables[0], name: '資料整理主管團隊的超長協作桌名字一定要換行才放得下' }
  const { svg } = v2PanelSvg(people, tables, { frame: 0, pxWidth: 900, pxHeight: 700 })
  expect(svg).toContain(`（${tables[0].size}人）`)
})
