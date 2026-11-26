// bun test remote：換主管交接（handover.ts），暫存資料夾＋假的傳話、聊天室、換主管
import { expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HAND_WAIT_MS, answerHandover, handoverView, handovers, initHandover, startHandover, tickHandovers } from './handover'

function setup(people: any[]) {
  const sent: [string, string][] = [], swapped: string[] = [], chat: any[] = []
  let reply: { text: string; at: number } | undefined
  initHandover({
    base: mkdtempSync(join(tmpdir(), 'po-hand-')), port: () => 9999,
    office: () => ({ people }),
    sendCommand: (id, text) => { sent.push([id, text]); return undefined },
    swap: h => { swapped.push(h.newSid); return 'ok' },
    chat: () => chat,
    lastReply: () => reply,
  })
  const h = startHandover({ table: 1, label: 'A 桌', newSid: 'new', newName: '新人', oldId: 'old', oldName: '舊主管', oldHandle: '舊主管', at: 0 })
  return { h, sent, swapped, chat, setReply: (r: any) => { reply = r } }
}
const P = (id: string) => ({ id, plate: id })

test('handover: briefs go out when the new person arrives; old→new message then 接好了 swaps and the phone is told', () => {
  const people = [P('old')]
  const s = setup(people)
  tickHandovers(1000)
  expect(handovers()[0].state).toBe('boot') // 新人還沒來
  expect(handoverView(1000).tables).toEqual([1])
  people.push(P('new'))
  tickHandovers(2000)
  expect(handovers()[0].state).toBe('handing')
  expect(s.sent.map(x => x[0]).sort()).toEqual(['new', 'old'])
  expect(s.sent.find(x => x[0] === 'old')![1]).toContain('①團隊')
  expect(s.sent.find(x => x[0] === 'new')![1]).toContain('接好了')
  s.chat.push({ at: 3000, from: { id: 'old' }, to: { id: 'new' }, text: '交接：…' })
  tickHandovers(3000)
  expect(s.swapped).toHaveLength(0)
  s.chat.push({ at: 4000, from: { id: 'new' }, to: { id: 'old' }, text: '接好了，謝謝' })
  tickHandovers(4000)
  expect(s.swapped).toEqual(['new'])
  const v = handoverView(4000)
  expect(v.done[0]).toMatchObject({ label: 'A 桌', newName: '新人' })
  expect(v.tables).toEqual([])
})

test('handover: the new person\'s last reply saying 接好了 after the handover also counts', () => {
  const s = setup([P('old'), P('new')])
  tickHandovers(1000)
  s.chat.push({ at: 2000, from: { id: 'old' }, to: { id: 'new' }, text: '交接' })
  s.setReply({ text: '已讀完交接，接好了', at: 2500 })
  tickHandovers(3000)
  expect(s.swapped).toEqual(['new'])
})

test('handover: no handover in 5 min asks the user; wait reminds the old manager, swap goes direct with collab.md', () => {
  const s = setup([P('old'), P('new')])
  tickHandovers(0)
  tickHandovers(HAND_WAIT_MS)
  expect(handoverView(HAND_WAIT_MS).asks[0]).toMatchObject({ kind: 'wait' })
  expect(answerHandover(s.h.id, 'wait', HAND_WAIT_MS).ok).toBe(true)
  expect(handovers()[0].state).toBe('handing')
  expect(s.sent.at(-1)![0]).toBe('old')
  tickHandovers(2 * HAND_WAIT_MS)
  expect(answerHandover(s.h.id, 'swap', 2 * HAND_WAIT_MS).ok).toBe(true)
  expect(s.swapped).toEqual(['new'])
  expect(s.sent.at(-1)).toEqual(['new', expect.stringContaining('collab.md')])
})

test('handover: old manager offline asks to swap directly; No keeps the new person as staff', () => {
  const s = setup([P('new')])
  tickHandovers(1000)
  expect(handoverView(1000).asks[0]).toMatchObject({ kind: 'offline' })
  expect(answerHandover(s.h.id, 'wait', 1000).ok).toBe(false) // 離線的不能「再等」
  expect(answerHandover(s.h.id, 'cancel', 1000).ok).toBe(true)
  expect(s.swapped).toHaveLength(0)
  expect(handovers()[0].state).toBe('cancelled')
  expect(s.sent.at(-1)![1]).toContain('不換主管')
})

test('handover briefs point at the table\'s own collab folder when it has one', () => {
  const people = [P('old'), P('new')]
  const sent: [string, string][] = []
  initHandover({ base: mkdtempSync(join(tmpdir(), 'po-hand-')), port: () => 9999, office: () => ({ people }), sendCommand: (id, t) => { sent.push([id, t]); return undefined }, swap: () => 'ok', chat: () => [], lastReply: () => undefined })
  startHandover({ table: 2, label: '像素辦公室 v2', collab: '/Users/me/.claude/pixel-office/team-v2', newSid: 'new', newName: '新人', oldId: 'old', oldName: '舊', oldHandle: '舊', at: 0 })
  tickHandovers(0)
  for (const [, t] of sent) expect(t).toContain('/Users/me/.claude/pixel-office/team-v2')
})
