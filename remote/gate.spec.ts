// bun test remote：端點驗證（0.63.56）。分類、放行規則、PO_DEV 只限測試埠、本機金鑰檔的檢查；經 handle() 的端到端
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ACCESS_DEDUP_MS, accessShouldLog, devMode, gate, gateClass, highRisk, hostOk, keyMatches, loadLocalKey, rotateLog } from './gate'
import { _setGatePatch, handle, hirePerm, redactKey } from './server'
import { confirmScreen, typeLine } from './hr'

const dir = mkdtempSync(join(tmpdir(), 'po-gate-'))
afterAll(() => { _setGatePatch(undefined); rmSync(dir, { recursive: true, force: true }) })

test('classes: approve/stuck/perm JWT only; page, scripts, styles, art, icons open; data and every other write need JWT or key', () => {
  for (const p of ['/approve', '/stuck', '/perm']) expect(gateClass('POST', p)).toBe('jwt')
  for (const p of ['/', '/v2/scene.js', '/v2/scene.css', '/v2/assets/kv_splash_cat_sm.webp', '/v2/assets/desk.png', '/icon-192.png', '/icon.svg', '/manifest.webmanifest', '/vendor/marked.umd.js']) expect(gateClass('GET', p)).toBe('open')
  for (const p of ['/state.json', '/chat.json', '/live.json', '/profile.json', '/table-chat.json', '/table-notes.json', '/meeting.json', '/panel.svg', '/scene.svg', '/phone-live', '/approve-result', '/nope']) expect(gateClass('GET', p)).toBe('either')
  for (const p of ['/command', '/hire', '/fire', '/helper', '/upload', '/move', '/']) expect(gateClass('POST', p)).toBe('either')
  expect(gateClass('GET', '/v2/assets/../../remote.json')).toBe('either')
})

test('gate: JWT passes everything; key passes all but JWT-only; nothing → 401 telling to use the Cloudflare address; dev and tailscale', () => {
  const none = { jwt: false, key: false }, off = { dev: false, tailscale: false }
  expect(gate('POST', '/approve', { jwt: true, key: false }, off)).toEqual({ ok: true, via: 'jwt' })
  expect(gate('POST', '/approve', { jwt: false, key: true }, { dev: true, tailscale: true })).toMatchObject({ ok: false, status: 403 })
  expect(gate('POST', '/command', { jwt: false, key: true }, off)).toEqual({ ok: true, via: 'key' })
  const r = gate('GET', '/state.json', none, off) as any
  expect(r).toMatchObject({ ok: false, status: 401 })
  expect(r.text).toContain('請用 Cloudflare 網址開')
  expect(gate('GET', '/state.json', none, { dev: true, tailscale: false })).toEqual({ ok: true, via: 'dev' })
  expect(gate('POST', '/command', none, { dev: true, tailscale: false })).toMatchObject({ ok: false, status: 401 }) // PO_DEV 只放行讀
  expect(gate('GET', '/chat.json', none, { dev: false, tailscale: true })).toEqual({ ok: true, via: 'tailscale' })
  expect(gate('POST', '/command', none, { dev: false, tailscale: true })).toMatchObject({ ok: false, status: 403, text: 'Tailscale 連進來只能看，不能改' })
  expect(gate('GET', '/', none, off)).toEqual({ ok: true, via: 'open' })
})

test('PO_DEV=1 only on 8781/8782; elsewhere ignored (and reported)', () => {
  expect(devMode('1', 8782)).toEqual({ dev: true, ignored: false })
  expect(devMode('1', 8781)).toEqual({ dev: true, ignored: false })
  expect(devMode('1', 8767)).toEqual({ dev: false, ignored: true })
  expect(devMode(undefined, 8782)).toEqual({ dev: false, ignored: false })
  expect(devMode('true', 8782)).toEqual({ dev: false, ignored: false })
})

test('local key file on Windows: mode is not checked (lstat always says 666), format still is', () => {
  const f = join(dir, 'kw'); writeFileSync(f, 'd'.repeat(64) + '\n')
  try { chmodSync(f, 0o666) } catch {}
  expect((loadLocalKey(f, undefined, 'win32') as any).key).toBe('d'.repeat(64))
  const m = join(dir, 'kw2'); writeFileSync(m, 'short\n')
  expect((loadLocalKey(m, undefined, 'win32') as any).error).toContain('格式不對')
})

// POSIX 權限只在 Mac／Linux 驗得到（Windows 的 lstat 沒有 600 可言）
test.skipIf(process.platform === 'win32')('local key file: created 0600 with 64 hex; reused; refused when too open, a symlink, or malformed', () => {
  const f = join(dir, 'k1')
  const a = loadLocalKey(f) as any
  expect(a.key).toMatch(/^[0-9a-f]{64}$/)
  expect(statSync(f).mode & 0o777).toBe(0o600)
  expect((loadLocalKey(f) as any).key).toBe(a.key)
  chmodSync(f, 0o644)
  expect((loadLocalKey(f) as any).error).toContain('權限太寬')
  chmodSync(f, 0o600)
  const l = join(dir, 'k2'); symlinkSync(f, l)
  expect((loadLocalKey(l) as any).error).toContain('不是一般檔')
  const m = join(dir, 'k3'); writeFileSync(m, 'short\n', { mode: 0o600 })
  expect((loadLocalKey(m) as any).error).toContain('格式不對')
  expect(readFileSync(f, 'utf8').trim()).toBe(a.key) // 沒被蓋掉
})

test('keyMatches: exact 64-hex only', () => {
  const k = 'a'.repeat(64)
  expect(keyMatches(k, k)).toBe(true)
  expect(keyMatches('b'.repeat(64), k)).toBe(false)
  expect(keyMatches(k.slice(1), k)).toBe(false)
  expect(keyMatches(null, k)).toBe(false)
  expect(keyMatches(k, undefined)).toBe(false)
})

test('through handle(): no auth → 401 on data and writes, page still served; right key passes; wrong key does not; key never opens /approve', async () => {
  const key = 'c'.repeat(64)
  const log = join(dir, 'access-log.jsonl')
  _setGatePatch({ key, dev: false, tailscale: false, log })
  const get = (p: string, h: Record<string, string> = {}) => handle(new Request(`http://127.0.0.1:8767${p}`, { headers: h }))
  const post = (p: string, b: unknown, h: Record<string, string> = {}) => handle(new Request(`http://127.0.0.1:8767${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...h }, body: JSON.stringify(b) }))
  expect((await get('/')).status).toBe(200)
  const s = await get('/state.json')
  expect(s.status).toBe(401)
  expect((await s.json()).text).toContain('請用 Cloudflare 網址開')
  expect((await get('/chat.json?id=x')).status).toBe(401)
  expect((await get('/phone-live')).status).toBe(401)
  expect((await post('/command', { id: 'nobody', text: 'hi' })).status).toBe(401)
  expect((await post('/hire', { name: 'x' })).status).toBe(401)
  expect((await get('/state.json', { 'x-po-key': 'd'.repeat(64) })).status).toBe(401)
  expect((await get('/phone-live', { 'x-po-key': key })).status).toBe(200)
  expect((await post('/command', { id: 'nobody', text: 'hi' }, { 'x-po-key': key })).status).toBe(400) // 過了身分這關：這位不在線
  expect((await post('/approve', { id: 'x', key: 'allow', nonce: 'n' }, { 'x-po-key': key })).status).toBe(403)
  expect((await post('/perm', { id: 'x', perm: 'auto' }, { 'x-po-key': key })).status).toBe(403)
  expect((await post('/stuck', { id: 'x', opt: '1' }, { 'x-po-key': key })).status).toBe(403)
  // 用金鑰的、高風險的都記一筆（0600），不記內容
  const lines = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  expect(lines.map(l => `${l.method} ${l.path} ${l.via}`)).toEqual(['GET /phone-live key', 'POST /command key'])
  if (process.platform !== 'win32') expect(statSync(log).mode & 0o777).toBe(0o600) // Windows 沒有 600 可言
  expect(JSON.stringify(lines)).not.toContain('hi')
  _setGatePatch({ key, dev: false, tailscale: true, log })
  expect((await get('/phone-live')).status).toBe(200)
  expect((await post('/command', { id: 'nobody', text: 'hi' })).status).toBe(403)
  // 測試埠（dev）：只認 JWT 的端點只放示意請求（body 帶 demo），真的照樣 403；/approve 連示意都不放
  _setGatePatch({ key, dev: true, tailscale: false, log })
  expect((await get('/state.json')).status).toBe(200) // PO_DEV：讀可以
  expect((await post('/command', { id: 'nobody', text: 'hi' })).status).toBe(401) // 寫不行
  expect((await post('/command', { id: 'nobody', text: 'hi', demo: 1 })).status).toBe(401) // 沒有示意分支的，帶 demo 也不行
  expect((await post('/hire', { name: 'x', demo: 1 })).status).toBe(401)
  expect((await post('/move', { id: 'x', seat: 'o1', demo: 1 })).status).toBe(200) // 示意的換座位可以
  expect((await post('/stuck', { id: 'x', opt: '1', demo: 1 })).status).toBe(200)
  expect((await post('/stuck', { id: 'x', opt: '1' })).status).toBe(403)
  expect((await post('/perm', { id: 'x', perm: 'auto', demo: 1 })).status).toBe(200)
  expect((await post('/approve', { id: 'x', key: 'allow', nonce: 'n', demo: 1 })).status).toBe(403)
  _setGatePatch({ key: undefined, dev: false, tailscale: false, log }) // 金鑰檔驗不過：本機程式都過不了
  expect((await get('/phone-live', { 'x-po-key': key })).status).toBe(401)
})

test('access log never keeps the key: 64+ hex in a command line is masked', () => {
  const k = 'ab'.repeat(32)
  expect(redactKey(`curl -H X-PO-Key: ${k} http://127.0.0.1:8767/state.json`)).toBe('curl -H X-PO-Key: … http://127.0.0.1:8767/state.json')
  expect(redactKey('bun remote/server.ts')).toBe('bun remote/server.ts')
})

test('F-1 Host: only 127.0.0.1/localhost with this port, publicHosts, or a request with a verified JWT', () => {
  expect(hostOk('127.0.0.1:8767', 8767, [], false)).toBe(true)
  expect(hostOk('LOCALHOST:8767', 8767, [], false)).toBe(true)
  expect(hostOk('127.0.0.1:8782', 8767, [], false)).toBe(false) // 別的埠
  expect(hostOk('evil.example:8767', 8767, [], false)).toBe(false) // DNS rebinding
  expect(hostOk('office.example.com', 8767, ['office.example.com'], false)).toBe(true)
  expect(hostOk('office.example.com:443', 8767, ['office.example.com'], false)).toBe(true)
  expect(hostOk('evil.example', 8767, ['office.example.com'], false)).toBe(false)
  expect(hostOk('anything.example', 8767, [], true)).toBe(true) // 帶了驗過的 Access JWT（壞網站拿不到）
  expect(hostOk(null, 8767, [], false)).toBe(false)
  expect(hostOk('a b', 8767, ['a b'], false)).toBe(false)
})

test('F-1 through handle(): an evil Host gets 403 even for the page, with a key, in dev or tailscale mode; publicHosts passes', async () => {
  const key = 'e'.repeat(64)
  const req = (host: string, path = '/state.json', h: Record<string, string> = {}) => handle(new Request(`http://127.0.0.1:8767${path}`, { headers: { host, ...h } }))
  for (const p of [{ key, dev: true, tailscale: true }, { key, dev: false, tailscale: false }]) {
    _setGatePatch({ ...p, log: join(dir, 'l2.jsonl') })
    expect((await req('evil.example:8767')).status).toBe(403)
    expect((await req('evil.example:8767', '/')).status).toBe(403)
    expect((await req('evil.example:8767', '/state.json', { 'x-po-key': key })).status).toBe(403)
  }
  _setGatePatch({ key, dev: false, tailscale: true, log: join(dir, 'l2.jsonl'), publicHosts: ['office.example.com'] })
  expect((await req('office.example.com')).status).toBe(200) // tailscale 的對外網址：只能讀
  _setGatePatch(undefined)
})

test('F-5: hires not from the phone page only in modes that never skip approval (default, plan, read-only); auto/acceptEdits refused; the phone page is unchanged', () => {
  expect(hirePerm({ name: 'a' }, false)).toEqual({ ok: true, b: { name: 'a', perm: 'default' } })
  expect(hirePerm({ name: 'a', perm: '' }, false)).toEqual({ ok: true, b: { name: 'a', perm: 'default' } })
  expect(hirePerm({ name: 'a', perm: 'plan' }, false)).toMatchObject({ ok: true })
  expect(hirePerm({ agent: 'codex', perm: 'read-only' }, false)).toMatchObject({ ok: true })
  for (const perm of ['auto', 'acceptEdits', 'bypassPermissions', 'constructor']) expect(hirePerm({ name: 'a', perm }, false)).toMatchObject({ ok: false })
  expect(hirePerm({ name: 'a', perm: 'auto' }, true)).toEqual({ ok: true, b: { name: 'a', perm: 'auto' } })
})

test('F-5 through handle(): /hire with the key and perm auto → 403 before anything is opened', async () => {
  const key = 'f'.repeat(64)
  _setGatePatch({ key, dev: false, tailscale: false, log: join(dir, 'l3.jsonl') })
  const r = await handle(new Request('http://127.0.0.1:8767/hire', { method: 'POST', headers: { 'x-po-key': key, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x', perm: 'auto' }) }))
  expect(r.status).toBe(403)
  expect((await r.json()).text).toContain('請在手機上招')
  _setGatePatch(undefined)
})

test('F-2: confirmation screens are recognised (permission prompt, numbered options, Esc to cancel); a plain idle box is not', () => {
  const ask = ` Bash command\n   touch ~/x\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and allow access\n   3. No\n Esc to cancel · Tab to amend`
  expect(confirmScreen(ask)).toBe(true)
  expect(confirmScreen('Trust this folder?\n ❯ 1. Yes, proceed\n   2. No, exit\n Enter to confirm · Esc to cancel')).toBe(true)
  const idle = `⏺ 好了\n✻ Cooked for 1s\n────────────\n❯ \n────────────\n  ⏵⏵ auto mode on (shift+tab to cycle)`
  expect(confirmScreen(idle)).toBe(false)
  expect(confirmScreen('⏺ 步驟：\n  1. 先讀檔\n  2. 再改\n────\n❯ \n────')).toBe(false) // 回覆裡的編號清單（沒有游標）不算
  expect(confirmScreen('  Would you like to run the following command?\n  $ rm x\n› 1. Yes, proceed (y)\n  2. No (esc)\n  Press enter to confirm or esc to cancel')).toBe(true) // Codex
})

test('typeLine: refuses on a confirmation screen (nothing typed), types and presses Enter on an idle box, refuses when the screen cannot be read', async () => {
  const sent: string[][] = []
  const run = (screen: string | null) => (...a: string[]) => { if (a[0] === 'capture-pane') return { exitCode: screen === null ? 1 : 0, stdout: { toString: () => screen ?? '' } }; sent.push(a); return { exitCode: 0, stdout: { toString: () => '' } } }
  const ask = ' Do you want to proceed?\n ❯ 1. Yes\n   2. No\n Esc to cancel'
  expect(await typeLine('%1', '/model sonnet', 'A', 0, run(ask))).toContain('確認畫面')
  expect(sent).toEqual([])
  expect(await typeLine('%1', '/effort medium', 'A', 0, run(null))).toContain('看不到')
  expect(sent).toEqual([])
  expect(await typeLine('%1', '/compact', 'A', 0, run('❯ \n  ⏵⏵ auto mode on'))).toBeUndefined()
  expect(sent).toEqual([['send-keys', '-t', '%1', '-l', '/compact'], ['send-keys', '-t', '%1', 'Enter']])
})

test('0.63.60 access log: every write is logged; reads once per (via, exe, parent, path) per 10 minutes; demo (dev) never', () => {
  const seen = new Map<string, number>(), t = 1_000_000
  const w = { method: 'POST', path: '/command', via: 'jwt' }
  expect(accessShouldLog(seen, w, t)).toBe(true)
  expect(accessShouldLog(seen, w, t + 1)).toBe(true) // 寫入每次都記
  expect(accessShouldLog(seen, { method: 'DELETE', path: '/x', via: 'key' }, t)).toBe(true)
  const r = { method: 'GET', path: '/chat.json', via: 'key', exe: 'curl', parent: 'zsh' }
  expect(accessShouldLog(seen, r, t)).toBe(true)
  expect(accessShouldLog(seen, r, t + ACCESS_DEDUP_MS - 1)).toBe(false) // 10 分鐘內同一組只記第一筆
  expect(accessShouldLog(seen, { ...r, path: '/state.json' }, t + 5)).toBe(true) // 換路徑
  expect(accessShouldLog(seen, { ...r, exe: 'python3' }, t + 5)).toBe(true) // 換程式
  expect(accessShouldLog(seen, { ...r, parent: 'claude' }, t + 5)).toBe(true) // 換父程序
  expect(accessShouldLog(seen, { ...r, via: 'tailscale' }, t + 5)).toBe(true) // 換身分
  expect(accessShouldLog(seen, { method: 'HEAD', path: '/chat.json', via: 'key', exe: 'curl', parent: 'zsh' }, t + 5)).toBe(false) // HEAD 跟 GET 同一組（顧問裁示的四個欄位沒有 method）
  expect(accessShouldLog(seen, r, t + ACCESS_DEDUP_MS)).toBe(true) // 過了 10 分鐘再記一筆
  expect(accessShouldLog(seen, { method: 'GET', path: '/state.json', via: 'dev' }, t)).toBe(false) // 測試埠沒帶驗證的讀
  expect(accessShouldLog(seen, { method: 'POST', path: '/move', via: 'dev' }, t)).toBe(false) // 示意請求
  // 去重表太大時清掉過期的
  const big = new Map<string, number>()
  for (let i = 0; i < 2001; i++) big.set(`old${i}`, 0)
  accessShouldLog(big, { method: 'GET', path: '/p', via: 'key' }, ACCESS_DEDUP_MS + 1)
  expect(big.size).toBe(1)
})

test('0.63.60 high risk: /perm, /stuck, /hire, /helper always; /tables only for delete and edit; never for GET', () => {
  for (const p of ['/perm', '/stuck', '/hire', '/summon', '/helper']) expect(highRisk('POST', p)).toBe(true)
  expect(highRisk('POST', '/tables', 'delete')).toBe(true)
  expect(highRisk('POST', '/tables', 'edit')).toBe(true)
  expect(highRisk('POST', '/tables', 'add')).toBe(false)
  expect(highRisk('POST', '/tables')).toBe(false)
  expect(highRisk('GET', '/tables', 'delete')).toBe(false)
  expect(highRisk('POST', '/command', 'delete')).toBe(false)
})

test('0.63.60 access log rotation: over the limit the file moves to .1, .1 to .2, the oldest is dropped; at most 3 files', () => {
  const f = join(dir, 'rot.jsonl')
  rotateLog(f, 10) // 檔案不在：什麼都不做
  expect(existsSync(f)).toBe(false)
  writeFileSync(f, 'a'.repeat(10))
  rotateLog(f, 10) // 剛好 10：不換
  expect(readFileSync(f, 'utf8')).toBe('a'.repeat(10))
  for (const c of ['b', 'c', 'd']) { writeFileSync(f, c.repeat(11)); rotateLog(f, 10) }
  expect(existsSync(f)).toBe(false)
  expect(readFileSync(`${f}.1`, 'utf8')).toBe('d'.repeat(11))
  expect(readFileSync(`${f}.2`, 'utf8')).toBe('c'.repeat(11))
  expect(existsSync(`${f}.3`)).toBe(false) // b 那份已經刪掉
})

test('0.63.60 through handle(): a second identical key read within 10 minutes is not logged again; writes always are', async () => {
  const key = 'f'.repeat(64)
  const log = join(dir, 'l60.jsonl')
  _setGatePatch({ key, dev: false, tailscale: false, log })
  const get = (p: string) => handle(new Request(`http://127.0.0.1:8767${p}`, { headers: { 'x-po-key': key } }))
  const post = (p: string, b: unknown) => handle(new Request(`http://127.0.0.1:8767${p}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-po-key': key }, body: JSON.stringify(b) }))
  expect((await get('/approve-result?n=1')).status).not.toBe(401)
  await get('/approve-result?n=2') // 同一組 (key, 程式, 父程序, 路徑)：不再記
  await post('/command', { id: 'nobody', text: 'hi' })
  await post('/command', { id: 'nobody', text: 'hi' })
  const lines = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  expect(lines.map(l => `${l.method} ${l.path}`)).toEqual(['GET /approve-result', 'POST /command', 'POST /command'])
  expect(JSON.stringify(lines)).not.toContain('n=1') // 不記查詢字串
})
