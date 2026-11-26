// bun test remote：手機身分只認 Cloudflare Access 的 JWT（0.63.53，安全審 A-1／A-2）。用自己產的 RSA 金鑰簽 JWT 驗每一種不通過；
// 再打真的 handle()：本機帶偽造的 cf-ray＋owner email 標頭按 /approve 一律 403，偽造標頭讀 state.json 也不會讓「手機在看」成立
import { expect, test } from 'bun:test'
import { teamDomain, verifyAccessJwt, type Jwk } from './access'
import { _setConfigPatch, _setGatePatch, _setKeySource, handle, phoneLive } from './server'
_setGatePatch({ key: undefined, dev: false, tailscale: false }) // 不讀真的金鑰檔（端點驗證在 gate.spec.ts）

const enc = (o: unknown) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url')
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Jwk
const other = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
const CFG = { team: 'myteam', aud: 'aud-123' }
const NOW = 1_800_000_000_000
const claims = (o: Record<string, unknown> = {}) => ({ iss: 'https://myteam.cloudflareaccess.com', aud: ['aud-123'], email: 'Owner@Example.test', exp: NOW / 1000 + 600, iat: NOW / 1000 - 10, ...o })
async function sign(body: unknown, head: Record<string, unknown> = { alg: 'RS256', kid: 'k1' }, key = pair.privateKey) {
  const data = `${enc(head)}.${enc(body)}`
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(data))
  return `${data}.${Buffer.from(sig).toString('base64url')}`
}
let fetched = 0
const keys = async (_team: string, force: boolean) => { fetched++; return force ? [{ ...pub, kid: 'k1' }] : [{ ...pub, kid: 'k1' }] }
const OWNERS = ['owner@example.test']

test('a JWT signed by the team key, for our AUD, not expired, for an owner → ok (email compared case-insensitively)', async () => {
  expect(await verifyAccessJwt(await sign(claims()), CFG, OWNERS, NOW, keys)).toEqual({ ok: true, email: 'owner@example.test' })
  expect(await verifyAccessJwt(await sign(claims({ aud: 'aud-123' })), { team: 'myteam.cloudflareaccess.com', aud: 'aud-123' }, OWNERS, NOW, keys)).toMatchObject({ ok: true })
})

test('every way it should fail: no config, no token, garbage, alg none, wrong key, wrong iss, wrong aud, expired, not yet valid, not an owner', async () => {
  const no = async (t: string | undefined, cfg: any = CFG, owners = OWNERS) => (await verifyAccessJwt(t, cfg, owners, NOW, keys)) as any
  expect((await no(await sign(claims()), {})).why).toContain('沒設 access')
  expect((await no(await sign(claims()), { team: 'evil.example.com', aud: 'aud-123' })).why).toContain('沒設 access') // team 不是 cloudflareaccess.com
  expect((await no(undefined)).why).toBe('沒有 Access 的 JWT')
  expect((await no('a.b')).why).toBe('JWT 格式不對')
  expect((await no('!!.??.**')).why).toBe('JWT 解不開')
  expect((await no(`${enc({ alg: 'none', kid: 'k1' })}.${enc(claims())}.`)).why).toBe('JWT 不是 RS256')
  expect((await no(await sign(claims(), { alg: 'RS256', kid: 'k1' }, other.privateKey))).why).toBe('JWT 簽章不對') // 別把鑰匙簽的
  const good = await sign(claims())
  const [h, , sg] = good.split('.')
  expect((await no(`${h}.${enc(claims({ email: 'owner@example.test', aud: ['aud-123'] , exp: NOW / 1000 + 99999 }))}.${sg}`)).why).toBe('JWT 簽章不對') // 改了內容
  expect((await no(await sign(claims({ iss: 'https://evil.cloudflareaccess.com' })))).why).toBe('JWT 不是這個 team 發的')
  expect((await no(await sign(claims({ aud: ['other'] })))).why).toBe('JWT 的 aud 不對')
  expect((await no(await sign(claims({ exp: NOW / 1000 - 1 })))).why).toBe('JWT 過期了')
  expect((await no(await sign(claims({ nbf: NOW / 1000 + 3600 })))).why).toBe('JWT 還沒生效')
  expect((await no(await sign(claims({ email: 'someone@else.test' })))).why).toBe('不是辦公室的擁有者')
  expect((await no(await sign(claims(), { alg: 'RS256', kid: 'unknown' }))).why).toBe('找不到簽這個 JWT 的金鑰')
})

test('an unknown kid makes it refetch the keys once', async () => {
  fetched = 0
  await verifyAccessJwt(await sign(claims(), { alg: 'RS256', kid: 'nope' }), CFG, OWNERS, NOW, keys)
  expect(fetched).toBe(2)
})

test('teamDomain: only *.cloudflareaccess.com', () => {
  expect(teamDomain('MyTeam')).toBe('myteam.cloudflareaccess.com')
  expect(teamDomain('https://myteam.cloudflareaccess.com/')).toBe('myteam.cloudflareaccess.com')
  expect(teamDomain('evil.example.com')).toBeUndefined()
  expect(teamDomain(42)).toBeUndefined()
})

test('A-1 on the real handler: a local request with forged cf-ray + owner email (+ its own Origin) cannot press /approve (403)', async () => {
  const owner = 'owner@example.test' // 讀得到的 owner（測試員的攻擊情境）；有沒有在名單上都一樣被擋，因為只認 JWT
  const req = new Request('http://127.0.0.1:8767/approve', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://127.0.0.1:8767', 'cf-ray': 'fake', 'cf-access-authenticated-user-email': owner }, body: JSON.stringify({ id: 'x', key: 'allow', nonce: 'n' }) })
  const r = await handle(req)
  expect(r.status === 403).toBe(true)
  const plain = await handle(new Request('http://127.0.0.1:8767/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'x', key: 'allow', nonce: 'n' }) }))
  expect(plain.status).toBe(403)
  expect((await plain.json()).text).toContain('只能在經 Cloudflare 登入的手機頁按') // 0.63.56：端點驗證先擋（只認 JWT）
})

test('A-2 on the real handler: reading state.json with forged headers does not make the phone count as watching', async () => {
  await handle(new Request('http://127.0.0.1:8767/state.json', { headers: { 'cf-ray': 'fake', 'cf-access-authenticated-user-email': 'owner@example.test', 'cf-access-jwt-assertion': 'a.b.c' } }))
  expect(phoneLive().live).toBe(false)
})

test('F-1 end to end through handle(): with access set in the config, a JWT signed by the team key passes /approve and turns phone-watching on; another key is refused', async () => {
  const owner = 'owner@example.test'
  _setConfigPatch({ access: { team: 'myteam', aud: 'aud-123' }, owners: [owner] })
  _setKeySource(async () => [{ ...pub, kid: 'k1' }]) // 本機的假 JWKS（team 的 certs）
  try {
    const live = { iss: 'https://myteam.cloudflareaccess.com', aud: ['aud-123'], email: owner, exp: Date.now() / 1000 + 600 }
    const good = await sign(live)
    const bad = await sign(live, { alg: 'RS256', kid: 'k1' }, other.privateKey)
    const post = (jwt: string) => new Request('https://office.example/approve', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://office.example', host: 'office.example', 'cf-ray': 'r', 'cf-access-authenticated-user-email': owner, 'cf-access-jwt-assertion': jwt }, body: JSON.stringify({ id: 'nobody-here', key: 'allow', nonce: 'n' }) })
    const ok = await handle(post(good))
    expect(ok.status).toBe(200) // 過了身分這關：接著才看這位在不在線
    expect((await ok.json()).text).toBe('這位已經不在線')
    const no = await handle(post(bad))
    expect(no.status).toBe(403)
    expect((await no.json()).text).toContain('JWT 簽章不對')
    expect(phoneLive().live).toBe(false)
    await handle(new Request('https://office.example/state.json', { headers: { 'cf-ray': 'r', 'cf-access-authenticated-user-email': owner, 'cf-access-jwt-assertion': good } }))
    expect(phoneLive()).toEqual({ live: true, waitMs: 120000 })
    _setConfigPatch({ access: { team: 'myteam', aud: 'aud-123' }, owners: [owner], phoneApprove: false })
    expect(phoneLive().live).toBe(false) // remote.json 的 phoneApprove:false 強制關
  } finally { _setConfigPatch(undefined); _setKeySource(undefined) }
})
