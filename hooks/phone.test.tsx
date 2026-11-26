// 手機核准（0.63.51；0.63.53 安全審改）：伺服器的 phone-live、拒絕原因、送單收單、手機的等法只認伺服器給的決定（等待程式本身在 remote/waiter.spec.ts 真的跑）
import { test, expect } from 'claude-code/testing'
import { PHONE_WAIT_MAX_MS, PHONE_WAIT_MS, judgeDecision, phoneWait, runSlipWith, waitPhone } from './register'

const WANT = { session: 's1', toolUseId: 'toolu_1', nonce: 'n1', textHash: 'h1' }
const decided = (o: Record<string, unknown> = {}) => JSON.stringify({ state: 'decided', ...WANT, behavior: 'allow', ...o })

test('phone-live from the server: live → wait (default 2 min, at most 9 min); not live, broken or missing → undefined', () => {
  expect(phoneWait(JSON.stringify({ live: true }))).toBe(PHONE_WAIT_MS)
  expect(phoneWait(JSON.stringify({ live: true, waitMs: 60000 }))).toBe(60000)
  expect(phoneWait(JSON.stringify({ live: true, waitMs: 9e9 }))).toBe(PHONE_WAIT_MAX_MS)
  expect(phoneWait(JSON.stringify({ live: false, waitMs: 60000 }))).toBeUndefined()
  expect(phoneWait(JSON.stringify({ at: Date.now(), waitMs: 60000 }))).toBeUndefined() // 舊的心跳檔格式不算（A-2）
  expect(phoneWait('{oops')).toBeUndefined()
  expect(phoneWait(undefined)).toBeUndefined()
})

test('decision: a phone deny carries its reason (cleaned, ≤300) and via; allow carries no message', () => {
  expect(judgeDecision(decided({ behavior: 'deny', message: '先別\n推', via: 'phone' }), WANT)).toEqual({ kind: 'ok', behavior: 'deny', message: '先別 推', via: 'phone' })
  expect(judgeDecision(decided({ message: 'x', via: 'phone' }), WANT)).toEqual({ kind: 'ok', behavior: 'allow', via: 'phone' })
  expect((judgeDecision(decided({ behavior: 'deny', message: 'y'.repeat(500) }), WANT) as any).message.length).toBe(300)
})

function fakeIO() {
  const writes: string[] = []
  let t = 0
  return {
    writes,
    io: {
      read: async () => undefined,
      discard: async () => { writes.push('discard') },
      writeSlip: async (s: string) => { writes.push('slip:' + JSON.parse(s).nonce) },
      clearAll: async () => { writes.push('clear') },
      nonce: () => 'n1',
      shown: async (a: unknown) => { writes.push(a ? 'shown' : 'hidden') },
      now: async () => t,
      sleep: async (ms: number) => { t += ms },
      settled: () => false,
      log: () => {},
    },
  }
}

test('runSlipWith: slip written, onSlip gets the nonce then undefined, both files cleared whatever happens', async () => {
  const f = fakeIO()
  const seen: (string | undefined)[] = []
  const r = await runSlipWith(f.io as any, { session: 's1', name: 'impl' }, 'toolu_1', 'Bash', 'ls', 120000, async () => ({ behavior: 'deny', message: 'no', via: 'phone' }), n => seen.push(n))
  expect(r).toEqual({ behavior: 'deny', message: 'no', via: 'phone' })
  expect(seen).toEqual(['n1', undefined])
  expect(f.writes).toEqual(['discard', 'slip:n1', 'shown', 'clear', 'hidden'])
})

test('waitPhone (A-3): only the decision the waiter got from the server, all four fields matching; settled, timeout, a mismatch or a failed waiter → no answer', async () => {
  const io = (out: string | undefined | Error) => ({ runWaiter: async () => { if (out instanceof Error) throw out; return out }, log: () => {} })
  expect(await waitPhone(io('decided ' + decided({ behavior: 'deny', message: '不要', via: 'phone' })), WANT, 120000)).toEqual({ behavior: 'deny', message: '不要', via: 'phone' })
  expect(await waitPhone(io('decided ' + decided({ textHash: 'other' })), WANT, 120000)).toBeUndefined() // 指令被換過
  expect(await waitPhone(io('decided ' + decided({ toolUseId: 'toolu_0' })), WANT, 120000)).toBeUndefined()
  expect(await waitPhone(io('settled'), WANT, 120000)).toBeUndefined() // 電腦上先按了
  expect(await waitPhone(io('timeout'), WANT, 120000)).toBeUndefined()
  expect(await waitPhone(io('noserver'), WANT, 120000)).toBeUndefined() // 監聽 8767 的不是辦公室伺服器
  expect(await waitPhone(io(new Error('no python')), WANT, 120000)).toBeUndefined() // 跑不起來：交回電腦，不讀 decisions 檔
})
