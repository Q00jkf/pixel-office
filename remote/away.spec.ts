// bun test remote：在 App 裡關掉的 Codex（0.63.48 乙案）。名字用在線時卡片上的名牌（含同名編號）、對話紀錄不在的不列、
// 同名都列（主管裁示，用關掉時間區分）；名牌記憶：有變才記、一小時更新最後在線、7 天沒在線就刪。外部查詢（紀錄檔、寫入鎖）用假的
import { expect, test } from 'bun:test'
import { awayView, nextPlates, type AwayDeps } from './hr'

const T = (n: number) => `codex-01a2135b-0000-7000-8000-00000000000${n}`
const deps = (o: Partial<AwayDeps> & { files?: number[]; plates?: Record<string, string> } = {}): AwayDeps => ({
  transcript: t => ((o.files ?? [1, 2, 3, 4]).some(n => T(n).endsWith(t)) ? `/x/${t}.jsonl` : undefined),
  locked: () => false,
  plate: id => o.plates?.[id],
  ...o,
})

test('the away list uses the plate the card had while online (name + same-name number), else the card naming rule', () => {
  const v = awayView([
    { id: T(1), s: { name: 'codexa1b2', title: '行程助理' }, handedOff: false, at: 2000 },
    { id: T(2), s: { name: 'codexabcd', title: '報價小幫手', agent: 'quote-helper' }, handedOff: true, at: 1000 },
  ], deps({ plates: { [T(1)]: '行程助理②' } }))
  expect(v.map(x => [x.plate, x.at, x.handedOff, x.resumable])).toEqual([['行程助理②', 2000, false, true], ['報價小幫手', 1000, true, true]])
  // 中文的 ListAgents 名優先於職稱（同 chinesePlates）；最多 10 字
  expect(awayView([{ id: T(3), s: { name: 'x', title: 'title', agent: '整理客戶名單的助手一二' }, handedOff: false, at: 1 }], deps())[0].plate).toBe('整理客戶名單的助手一')
})

test('threads whose record is gone (trashed, moved by firing) are not listed; same names are all listed, newest first', () => {
  const v = awayView([
    { id: T(1), s: { title: '行程助理' }, handedOff: false, at: 1000 },
    { id: T(2), s: { title: '行程助理' }, handedOff: false, at: 3000 },
    { id: T(3), s: { title: 'cxapp' }, handedOff: false, at: 5000 }, // 紀錄已丟垃圾桶
    { id: T(4), s: { title: '行程助理' }, handedOff: true, at: 2000 },
  ], deps({ files: [1, 2, 4], plates: { [T(1)]: '行程助理①', [T(2)]: '行程助理②' } }))
  expect(v.map(x => x.id)).toEqual([T(2), T(4), T(1)]) // 同名的都還接得回：都列，用關掉時間分
  expect(v.map(x => x.plate)).toEqual(['行程助理②', '行程助理', '行程助理①'])
})

test('lock still held by the App or unknown: listed with the reason, not resumable', () => {
  const v = awayView([
    { id: T(1), s: { title: 'a' }, handedOff: false, at: 2 },
    { id: T(2), s: { title: 'b' }, handedOff: false, at: 1 },
  ], deps({ locked: t => (T(1).endsWith(t) ? true : undefined) }))
  expect(v.map(x => [x.resumable, x.why])).toEqual([[false, '這段對話還開在 App 裡，先在 App 關掉'], [false, '看不出這段對話有沒有開在別的地方']])
})

test('plate memory: only Codex, changes recorded, last-online refreshed hourly, dropped after 7 days', () => {
  const m: Record<string, { plate: string; at: number }> = {}
  const H = 3600e3
  expect(nextPlates(m, [{ id: 'codex-a', kind: 'codex', plate: '行程助理②' }, { id: 'claude-x', plate: '主管' }], 0)).toBe(true)
  expect(m).toEqual({ 'codex-a': { plate: '行程助理②', at: 0 } })
  expect(nextPlates(m, [{ id: 'codex-a', kind: 'codex', plate: '行程助理②' }], 10 * 60e3)).toBe(false) // 沒變、不到一小時：不寫檔
  expect(nextPlates(m, [{ id: 'codex-a', kind: 'codex', plate: '行程助理②' }], 2 * H)).toBe(true)
  expect(m['codex-a'].at).toBe(2 * H)
  expect(nextPlates(m, [{ id: 'codex-a', kind: 'codex', plate: '行程助理' }], 3 * H)).toBe(true) // 同名的另一位走了，編號沒了：照新的
  expect(m['codex-a'].plate).toBe('行程助理')
  expect(nextPlates(m, [], 3 * H + 7 * 24 * H)).toBe(true)
  expect(m).toEqual({})
})
