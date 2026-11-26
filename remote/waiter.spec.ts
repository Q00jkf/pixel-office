// bun test remote：手機核准的等待程式（hooks/waiter.ts，0.63.54）用 python 真的跑：
// 先確認監聽那個埠的是 remote/server.ts（假冒的程式不算）；向伺服器問決定、看單有沒有結案、到期。
// 安全審 A-3：手寫在 decisions 檔的決定不會被採用（等待程式根本不讀那個檔）
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { APPROVE_LOG_PY, PHONE_LIVE_PY, WAITER_PY } from '../hooks/waiter'

const TOMBSTONE = JSON.stringify({ state: 'done' })
const PY = Bun.which('python3')
const dir = mkdtempSync(join(tmpdir(), 'po-waiter-')), appr = join(dir, 'approvals-s1.json'), dec = join(dir, 'decisions-s1.json'), ans = join(dir, 'answer.json')
// 假的辦公室伺服器：另一個程序，指令列含 remote/server.ts；回答 answer.json 的內容
mkdirSync(join(dir, 'remote'))
writeFileSync(join(dir, 'remote', 'server.ts'), `const f = ${JSON.stringify(ans)}
const s = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async req => new URL(req.url).pathname === '/echo-key' ? Response.json({ key: req.headers.get('x-po-key') }) : new Response(await Bun.file(f).text(), { headers: { 'content-type': 'application/json' } }) })
console.log(s.port)`)
const answer = (o: unknown) => writeFileSync(ans, JSON.stringify(o))
answer({ state: 'none' })
let srv: ReturnType<typeof Bun.spawn> | undefined, port = 0
beforeAll(async () => {
  srv = Bun.spawn([process.execPath, join(dir, 'remote', 'server.ts')], { stdout: 'pipe' })
  const rd = srv.stdout.getReader(); port = Number(new TextDecoder().decode((await rd.read()).value).trim()); rd.releaseLock()
})
afterAll(() => { srv?.kill(); rmSync(dir, { recursive: true, force: true }) })
const url = () => `http://127.0.0.1:${port}/approve-result?session=s1&toolUseId=toolu_1&nonce=n1`

async function run(deadlineIn: number, u = url()) {
  const p = Bun.spawn([PY!, '-I', '-c', WAITER_PY, u, appr, 'n1', String(Date.now() + deadlineIn)], { stdout: 'pipe' })
  const out = (await new Response(p.stdout).text()).trim()
  await p.exited
  return out
}

test('the waiter (real python): the server decision comes back whole; a tombstone or another slip ends it; a deadline ends it', async () => {
  if (!PY) return
  writeFileSync(appr, JSON.stringify({ state: 'waiting', nonce: 'n1' }))
  answer({ state: 'none' })
  setTimeout(() => answer({ state: 'decided', session: 's1', toolUseId: 'toolu_1', nonce: 'n1', textHash: 'h', behavior: 'deny', message: '不要', via: 'phone' }), 700)
  let t = Date.now()
  const out = await run(10000)
  expect(out.startsWith('decided ')).toBe(true)
  expect(JSON.parse(out.slice(8))).toMatchObject({ behavior: 'deny', message: '不要', via: 'phone', nonce: 'n1' })
  expect(Date.now() - t).toBeLessThan(4000)
  answer({ state: 'decided', nonce: 'old', behavior: 'allow' }) // 別張的：不採用
  setTimeout(() => writeFileSync(appr, TOMBSTONE), 700)
  t = Date.now()
  expect(await run(10000)).toBe('settled')
  expect(Date.now() - t).toBeLessThan(4000)
  writeFileSync(appr, JSON.stringify({ state: 'waiting', nonce: 'n2' }))
  expect(await run(5000)).toBe('settled') // 換成別張
  answer({ state: 'none' })
  writeFileSync(appr, JSON.stringify({ state: 'waiting', nonce: 'n1' }))
  expect(await run(1500)).toBe('timeout')
}, 40000)

test('A-3: a decision hand-written into the decisions file (copied from the slip) is not taken', async () => {
  if (!PY) return
  writeFileSync(appr, JSON.stringify({ state: 'waiting', session: 's1', toolUseId: 'toolu_1', nonce: 'n1' }))
  writeFileSync(dec, JSON.stringify({ state: 'decided', session: 's1', toolUseId: 'toolu_1', nonce: 'n1', textHash: 'h', behavior: 'allow' }))
  answer({ state: 'none' })
  expect(await run(1500)).toBe('timeout')
}, 15000)

test('(a): something else listening on the port (not remote/server.ts) or nothing at all → noserver, never asks it', async () => {
  if (!PY) return
  const impostor = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ state: 'decided', session: 's1', toolUseId: 'toolu_1', nonce: 'n1', textHash: 'h', behavior: 'allow' }) })
  try {
    writeFileSync(appr, JSON.stringify({ state: 'waiting', nonce: 'n1' }))
    expect(await run(3000, `http://127.0.0.1:${impostor.port}/approve-result`)).toBe('noserver') // 這個測試程序本身不是 remote/server.ts
    expect(await run(3000, 'http://127.0.0.1:9/approve-result')).toBe('noserver')
    const live = Bun.spawn([PY!, '-I', '-c', PHONE_LIVE_PY, `http://127.0.0.1:${impostor.port}/phone-live`], { stdout: 'pipe' })
    expect((await new Response(live.stdout).text()).trim()).toBe('') // phone-live 也不問假冒的
  } finally { impostor.stop(true) }
}, 20000)

test('phone-live asks the real office server', async () => {
  if (!PY) return
  answer({ live: true, waitMs: 60000 })
  const p = Bun.spawn([PY!, '-I', '-c', PHONE_LIVE_PY, `http://127.0.0.1:${port}/phone-live`], { stdout: 'pipe' })
  expect(JSON.parse((await new Response(p.stdout).text()).trim())).toEqual({ live: true, waitMs: 60000 })
}, 15000)

test('0.63.56: the helpers send the local key file as X-PO-Key; no key file → no header', async () => {
  if (!PY) return
  const kf = join(dir, 'local-key')
  writeFileSync(kf, 'k'.repeat(64) + '\n')
  const live = async (...extra: string[]) => { const p = Bun.spawn([PY!, '-I', '-c', PHONE_LIVE_PY, `http://127.0.0.1:${port}/echo-key`, ...extra], { stdout: 'pipe' }); const o = (await new Response(p.stdout).text()).trim(); await p.exited; return JSON.parse(o) }
  expect(await live(kf)).toEqual({ key: 'k'.repeat(64) })
  expect(await live(join(dir, 'missing'))).toEqual({ key: null })
  expect(await live()).toEqual({ key: null })
})

test('F-3: http_proxy in the environment is not used for the local server (the key would go to the proxy)', async () => {
  if (!PY) return
  const kf = join(dir, 'local-key2')
  writeFileSync(kf, 'p'.repeat(64) + '\n')
  const env = { ...process.env, http_proxy: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9', no_proxy: '', NO_PROXY: '' }
  const p = Bun.spawn([PY!, '-I', '-c', PHONE_LIVE_PY, `http://127.0.0.1:${port}/echo-key`, kf], { stdout: 'pipe', env })
  const o = (await new Response(p.stdout).text()).trim(); await p.exited
  expect(JSON.parse(o)).toEqual({ key: 'p'.repeat(64) }) // 直連到了（代理那個埠沒有人聽）
})

// R7 留證據（2026-11-26）：等待端採用決定時用 python 附加到 approve-log.jsonl；伺服器同時也在附加，不能整檔覆寫
test('approve-log append: O_APPEND keeps what is there (the server writes the same file), new file is 0600, one line per call', () => {
  const f = join(dir, 'approve-log.jsonl')
  const add = (line: string) => expect(Bun.spawnSync([PY!, '-I', '-c', APPROVE_LOG_PY, f, line]).exitCode).toBe(0)
  add(JSON.stringify({ n: 1 }))
  expect(statSync(f).mode & 0o777).toBe(0o600)
  writeFileSync(f, readFileSync(f, 'utf8') + JSON.stringify({ n: 'server' }) + '\n') // 伺服器那邊附加的一行
  add(JSON.stringify({ n: 2, text: '中文 "引號"' }))
  expect(readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l))).toEqual([{ n: 1 }, { n: 'server' }, { n: 2, text: '中文 "引號"' }])
})
