// bun test remote：接回後台設啟動標記（0.63.49）。使用者 0.63.48 實機「標記設不上」：
// 只用 session ID 設與讀回、期限內最多試 3 次，失敗寫出哪一步、tmux 的 stderr、花多久。
// 壓力：tmux-iso 建的獨立伺服器開幾十個 session（一半不停輸出），連續設標記都要成功；不碰主伺服器
import { afterAll, expect, test } from 'bun:test'
import { markLaunch, spawnBounded, type MarkRun } from './hr'
import { isoTmux } from './tmux-iso'

const fake = (steps: { code: number | null; out?: string; err?: string }[]) => {
  const calls: string[][] = []
  const run: MarkRun = async a => { calls.push(a); const s = steps.shift() ?? { code: 0, out: 'M' }; return { code: s.code, out: s.out ?? '', err: s.err ?? '' } }
  return { run, calls }
}
const noSleep = async () => {}

test('markLaunch: set then read back by the session ID only; first try ok', async () => {
  const f = fake([{ code: 0 }, { code: 0, out: 'M\n' }])
  const r = await markLaunch('$12', 'M', Date.now() + 10000, f.run, noSleep)
  expect(r.ok).toBe(true)
  expect(f.calls).toEqual([['set-option', '-t', '$12', '@po_launch', 'M'], ['show-options', '-v', '-t', '$12', '@po_launch']]) // 不用名稱繞
})

test('markLaunch: a failed set or read is retried within the deadline (up to 3 tries)', async () => {
  const f = fake([{ code: 1, err: 'server exited unexpectedly' }, { code: 0 }, { code: null }, { code: 0 }, { code: 0, out: 'M' }])
  const r = await markLaunch('$3', 'M', Date.now() + 10000, f.run, noSleep)
  expect(r).toMatchObject({ ok: true, tries: 3 })
})

test('markLaunch: when all tries fail, says which step, what tmux said and how long it took', async () => {
  const set = await markLaunch('$3', 'M', Date.now() + 10000, fake([{ code: 1, err: "can't find session: $3" }, { code: 1, err: "can't find session: $3" }, { code: 1, err: "can't find session: $3" }]).run, noSleep)
  expect(set).toMatchObject({ ok: false, tries: 3 })
  expect((set as any).why).toBe("設定失敗（exit 1：can't find session: $3）")
  expect(typeof set.ms).toBe('number')
  const read = await markLaunch('$3', 'M', Date.now() + 10000, fake([{ code: 0 }, { code: null }, { code: 0 }, { code: null }, { code: 0 }, { code: null }]).run, noSleep)
  expect((read as any).why).toBe('讀回失敗（逾時）')
  const odd = await markLaunch('$3', 'M', Date.now() + 10000, fake([{ code: 0 }, { code: 0, out: 'OTHER' }, { code: 0 }, { code: 0, out: 'OTHER' }, { code: 0 }, { code: 0, out: 'OTHER' }]).run, noSleep)
  expect((odd as any).why).toBe('讀回不符（讀到「OTHER」）')
  expect(await markLaunch('po-cxr-x', 'M', Date.now() + 10000, fake([]).run, noSleep)).toMatchObject({ ok: false, tries: 0, why: 'session ID 不對（"po-cxr-x"）' })
  // 期限已過：一次都不送
  const late = fake([])
  expect(await markLaunch('$3', 'M', Date.now() - 1, late.run, noSleep)).toMatchObject({ ok: false, tries: 0, why: '期限內沒時間設' })
  expect(late.calls).toEqual([])
})

const ISO = isoTmux()
afterAll(() => ISO?.close())

test('stress (isolated tmux): with 40 sessions, half of them printing nonstop, 20 fresh sessions all get their marker', async () => {
  if (!ISO) return
  for (let i = 0; i < 40; i++) {
    const cmd = i % 2 ? 'sleep 120' : 'while :; do date; done'
    expect(ISO.run('new-session', '-d', '-x', '200', '-y', '50', '-s', `load-${i}`, cmd).exitCode).toBe(0)
  }
  const run: MarkRun = (a, ms) => spawnBounded([ISO.bin, ...ISO.pre, ...a], ms)
  const times: number[] = []
  for (let i = 0; i < 20; i++) {
    const r = ISO.run('new-session', '-d', '-P', '-F', '#{session_id} #{pane_id}', '-x', '220', '-y', '50', '-s', `po-cxr-stress-${i}`, 'sleep', '60')
    const sid = r.stdout.toString().trim().split(/\s+/)[0]
    const m = await markLaunch(sid, `MK${i}`, Date.now() + 12500, run)
    expect(m.ok).toBe(true)
    times.push(m.ms)
  }
  console.log(`tmux 壓力：40 個 session（20 個不停輸出），設標記 20 次，最慢 ${Math.max(...times)} 毫秒、平均 ${Math.round(times.reduce((a, b) => a + b, 0) / times.length)} 毫秒`)
}, 60000)
