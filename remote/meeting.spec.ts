// bun test remote：整桌開會（meeting.ts），暫存資料夾＋假的傳話
import { expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { endMeeting, initMeetings, meetingResult, meetingView, startMeeting, tickMeetings, topicSlug } from './meeting'

function setup(people: any[]) {
  const sent: [string, string][] = []
  initMeetings({ base: mkdtempSync(join(tmpdir(), 'po-meet-')), port: () => 9999, office: () => ({ people }), sendCommand: (id, t) => { sent.push([id, t]); return undefined } })
  return { sent, notes: mkdtempSync(join(tmpdir(), 'po-meetnotes-')) }
}
const who = [{ id: 'm', plate: '主管', agent: '主管A', role: 'manager' }, { id: 'a', plate: 'A', agent: 'A', title: '報價' }, { id: 'b', plate: 'B', agent: 'B' }]

test('table meeting: the manager hosts, 議題.md is written in the table\'s notes folder, everyone gets the meet.md notice', () => {
  const s = setup(who)
  expect(startMeeting({ table: 1, label: 'A 桌', topic: '本週計畫', ids: ['a'], who: who.filter(p => p.role !== 'manager'), notesDir: s.notes }).text).toContain('先挑一位主管')
  const r = startMeeting({ table: 1, label: 'A 桌', topic: '本週/計畫', ids: ['a'], who, notesDir: s.notes }, new Date(2026, 10, 23, 9, 0).getTime())
  expect(r.ok).toBe(true)
  const dir = join(s.notes, '會議', '2026-11-23-本週-計畫')
  expect(readFileSync(join(dir, '議題.md'), 'utf8')).toContain('主管（主持人）：主管A')
  expect(s.sent.map(x => x[0])).toEqual(['m', 'a']) // b 沒勾
  expect(s.sent[0][1]).toContain('你是主持人')
  expect(s.sent[1][1]).toContain('主持人：主管A')
  // 0.62.17：流程寫在議題裡，不叫人去讀外掛資料夾的 meet.md（工作資料夾外，會停下來問）
  expect(readFileSync(join(dir, '議題.md'), 'utf8')).toContain('## 流程（整桌開會版')
  for (const [, t] of s.sent) expect(t).not.toMatch(/讀 skill|meet\.md「/)
  expect(startMeeting({ table: 1, label: 'A 桌', topic: 'x', ids: ['a'], who, notesDir: s.notes }).text).toContain('正在開會')
  expect(meetingView().on[0]).toMatchObject({ table: 1, ids: ['m', 'a'] })
})

test('table meeting: 方案.md ends it and the phone gets the conclusion; the user can also end it', () => {
  const s = setup(who)
  const r = startMeeting({ table: 2, label: 'B 桌', topic: '週會', ids: ['a', 'b'], who, notesDir: s.notes })
  tickMeetings()
  expect(meetingView().on).toHaveLength(1)
  const mdir = join(s.notes, '會議', readdirSync(join(s.notes, '會議'))[0])
  writeFileSync(join(mdir, '方案.md'), '# 週會：方案\n結論')
  tickMeetings()
  expect(meetingView().on).toHaveLength(0)
  expect(meetingView().done[0]).toMatchObject({ label: 'B 桌', topic: '週會' })
  expect(meetingResult(r.id!).text).toContain('結論')
  const r2 = startMeeting({ table: 2, label: 'B 桌', topic: '再一次', ids: ['a'], who, notesDir: s.notes })
  expect(endMeeting(r2.id!).ok).toBe(true)
  expect(s.sent.at(-1)![0]).toBe('m')
  expect(endMeeting(r2.id!).ok).toBe(false)
  expect(existsSync(mdir)).toBe(true)
})

test('topic slug keeps folder names safe and short', () => {
  expect(topicSlug('a/b:c  d')).toBe('a-b-c-d')
  expect(topicSlug('   ')).toBe('會議')
  expect([...topicSlug('一'.repeat(30))].length).toBe(20)
})

import { topicSlug } from './meeting'
test('0.62.18: folder names drop full-width path symbols too', () => {
  expect(topicSlug('週會：下週要做什麼？')).toBe('週會-下週要做什麼')
  expect(topicSlug('a/b c')).toBe('a-b-c')
})
