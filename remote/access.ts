// Cloudflare Access 的 JWT 驗證（0.63.53；測試員安全審 A-1）：手機頁的身分只認 Access 簽的 JWT（Cf-Access-Jwt-Assertion 標頭），
// 不信 cf-ray、cf-access-authenticated-user-email 這些本機程序也能自己帶的標頭。
// 驗：RS256、kid 對得到 team 公開的金鑰（https://<team>.cloudflareaccess.com/cdn-cgi/access/certs，快取 1 小時，碰到不認得的 kid 最多 1 分鐘重抓一次）、
// iss＝那個 team、aud 含 remote.json 設的 AUD、還沒過期、email 在 owners 名單裡。remote.json 沒設 access（team、aud）就一律不通過：
// 手機核准不開（tailscale 等沒有 Access 的開法也是）

export type AccessCfg = { team?: unknown; aud?: unknown }
export type Jwk = { kid?: string; kty?: string; n?: string; e?: string; alg?: string }
export type KeySource = (team: string, force: boolean) => Promise<Jwk[]>

const b64url = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)), c => c.charCodeAt(0))
const json64 = (s: string): any => JSON.parse(new TextDecoder().decode(b64url(s)))

/** team 可以寫 "myteam" 或 "myteam.cloudflareaccess.com"：回完整網域；不合法回 undefined */
export function teamDomain(team: unknown): string | undefined {
  if (typeof team !== 'string') return
  const t = team.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
  const d = t.includes('.') ? t : `${t}.cloudflareaccess.com`
  return /^[a-z0-9-]+\.cloudflareaccess\.com$/.test(d) ? d : undefined
}

/** 驗一個 JWT：通過回 { ok: true, email }，不通過回原因（不丟錯） */
export async function verifyAccessJwt(token: string | null | undefined, cfg: AccessCfg | undefined, owners: string[], now: number, keys: KeySource): Promise<{ ok: true; email: string } | { ok: false; why: string }> {
  const domain = teamDomain(cfg?.team), aud = typeof cfg?.aud === 'string' ? cfg.aud.trim() : ''
  if (!domain || !aud) return { ok: false, why: 'remote.json 沒設 access（team、aud）' }
  if (!token) return { ok: false, why: '沒有 Access 的 JWT' }
  const parts = token.split('.')
  if (parts.length !== 3) return { ok: false, why: 'JWT 格式不對' }
  let head: any, body: any
  try { head = json64(parts[0]); body = json64(parts[1]) } catch { return { ok: false, why: 'JWT 解不開' } }
  if (head?.alg !== 'RS256' || typeof head.kid !== 'string') return { ok: false, why: 'JWT 不是 RS256' }
  let set = await keys(domain, false).catch(() => [] as Jwk[])
  let jwk = set.find(k => k.kid === head.kid)
  if (!jwk) { set = await keys(domain, true).catch(() => [] as Jwk[]); jwk = set.find(k => k.kid === head.kid) }
  if (!jwk || jwk.kty !== 'RSA' || !jwk.n || !jwk.e) return { ok: false, why: '找不到簽這個 JWT 的金鑰' }
  let good = false
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
    good = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))
  } catch { good = false }
  if (!good) return { ok: false, why: 'JWT 簽章不對' }
  if (body?.iss !== `https://${domain}`) return { ok: false, why: 'JWT 不是這個 team 發的' }
  const auds: unknown[] = Array.isArray(body?.aud) ? body.aud : [body?.aud]
  if (!auds.includes(aud)) return { ok: false, why: 'JWT 的 aud 不對' }
  const t = now / 1000
  if (typeof body?.exp !== 'number' || body.exp <= t) return { ok: false, why: 'JWT 過期了' }
  if (typeof body?.nbf === 'number' && body.nbf > t + 60) return { ok: false, why: 'JWT 還沒生效' }
  const email = typeof body?.email === 'string' ? body.email.toLowerCase() : ''
  if (!email || !owners.map(o => o.toLowerCase()).includes(email)) return { ok: false, why: '不是辦公室的擁有者' }
  return { ok: true, email }
}

/** 正式的金鑰來源：抓 team 的 certs，快取 1 小時；force（不認得的 kid）時 1 分鐘內最多重抓一次 */
const keyCache = new Map<string, { at: number; keys: Jwk[] }>()
export const accessKeys: KeySource = async (team, force) => {
  const c = keyCache.get(team), now = Date.now()
  if (c && (now - c.at < 3600e3) && !(force && now - c.at > 60e3)) return c.keys
  const r = await fetch(`https://${team}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(5000) })
  if (!r.ok) throw new Error(`certs ${r.status}`)
  const j: any = await r.json()
  const keys: Jwk[] = Array.isArray(j?.keys) ? j.keys : []
  keyCache.set(team, { at: now, keys })
  return keys
}
