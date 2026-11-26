// 端點驗證（0.63.56，顧問的分類）：每個請求先分類，再看帶了什麼身分。
// - 只認 JWT（Cloudflare Access 簽的，手機頁）：/approve、/stuck、/perm
// - JWT 或本機金鑰（~/.claude/pixel-office/local-key，0600，標頭 X-PO-Key）：其他會寫的端點、會讀到對話與名單的 GET
// - 不用驗證：頁面本身、程式與樣式、素材圖、icon、manifest
// PO_DEV=1 只在測試埠 8781／8782 生效：沒帶驗證的本機請求可以讀「JWT 或金鑰」那一類（寫入照樣要金鑰；示意請求另外放行）。
// tailscale（remote.json "tailscale": true）：沒帶驗證的請求只能讀（GET 資料端點），寫一律 403
import { closeSync, existsSync, lstatSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from 'node:fs'
import { timingSafeEqual } from 'node:crypto'

export type GateClass = 'open' | 'jwt' | 'either'
export const JWT_ONLY = new Set(['/approve', '/stuck', '/perm'])
/** 高風險：每次都記一筆（不論身分）；0.63.60 起寫入本來就一律記，這張表另外標 risk:'high' */
export const HIGH_RISK = new Set(['/perm', '/stuck', '/hire', '/helper'])
/** 高風險的動作（0.63.60，顧問裁示）：同一個端點只有某幾個 op 算，例如 /tables 的刪桌、改桌 */
export const HIGH_RISK_OPS: Record<string, Set<string>> = { '/tables': new Set(['delete', 'edit']) }
export function highRisk(method: string, path: string, op?: unknown): boolean {
  if (method !== 'POST') return false
  return HIGH_RISK.has(path) || (typeof op === 'string' && !!HIGH_RISK_OPS[path]?.has(op))
}

/**
 * 存取紀錄要不要記（0.63.60，顧問裁示）：
 * - 寫入（GET、HEAD 以外）一律記，示意請求（via dev）除外：什麼都沒改
 * - 讀：同一組 (via, exe, parent, path) 10 分鐘內只記第一筆；測試埠沒帶驗證的讀（via dev）不記
 * seen 是記憶體裡的去重表，太大時順手清掉過期的
 */
export const ACCESS_DEDUP_MS = 10 * 60e3
export function accessShouldLog(seen: Map<string, number>, e: { method: string; path: string; via: string; exe?: string; parent?: string }, now = Date.now()): boolean {
  if (e.via === 'dev' || e.via === 'open') return false
  if (e.method !== 'GET' && e.method !== 'HEAD') return true
  const k = JSON.stringify([e.via, e.exe ?? '', e.parent ?? '', e.path])
  const at = seen.get(k)
  if (at !== undefined && now - at < ACCESS_DEDUP_MS) return false
  seen.set(k, now)
  if (seen.size > 2000) for (const [x, t] of seen) if (now - t >= ACCESS_DEDUP_MS) seen.delete(x)
  return true
}

/** 紀錄檔超過 max 就換新檔：f → f.1 → f.2，最多留 keep 份（含現在這份），最舊的刪掉 */
export const ACCESS_LOG_MAX = 5 * 1024 * 1024
export function rotateLog(f: string, max = ACCESS_LOG_MAX, keep = 3) {
  let size = 0
  try { size = statSync(f).size } catch { return }
  if (size <= max) return
  try { rmSync(`${f}.${keep - 1}`, { force: true }) } catch {}
  for (let i = keep - 2; i >= 1; i--) try { if (existsSync(`${f}.${i}`)) renameSync(`${f}.${i}`, `${f}.${i + 1}`) } catch {}
  try { renameSync(f, `${f}.1`) } catch {}
}
export const DEV_PORTS = new Set([8781, 8782])

/** 不用驗證的：頁面、程式、樣式、圖（內容是公開的美術與程式，不含對話與名單） */
export function gateClass(method: string, path: string): GateClass {
  if (JWT_ONLY.has(path)) return 'jwt'
  if (method === 'GET' || method === 'HEAD') {
    if (path === '/' || path === '/v2' || path === '/v2/' || path === '/manifest.webmanifest' || path === '/icon.svg' || path === '/favicon.ico') return 'open'
    if (/^\/icon-[a-z0-9-]+\.png$/.test(path)) return 'open'
    if (/^\/vendor\/[a-z0-9.-]+\.js$/.test(path)) return 'open'
    if (/^\/v2\/(scene\.js|scene\.css|assets\/[A-Za-z0-9_.-]+)$/.test(path)) return 'open'
  }
  return 'either'
}

export type Who = { jwt: boolean; key: boolean; email?: string }
export type GateOpts = { dev: boolean; tailscale: boolean }
export type GateResult = { ok: true; via: 'jwt' | 'key' | 'dev' | 'tailscale' | 'open' } | { ok: false; status: 401 | 403; text: string }

const NEED_JWT = '這個動作只能在經 Cloudflare 登入的手機頁按'
const NEED_ANY = '請用 Cloudflare 網址開（本機程式要帶本機金鑰：標頭 X-PO-Key，金鑰在 ~/.claude/pixel-office/local-key）'
const TS_READ_ONLY = 'Tailscale 連進來只能看，不能改'

/** 放不放行；寫入算 POST（或 GET、HEAD 以外的方法） */
export function gate(method: string, path: string, who: Who, o: GateOpts): GateResult {
  const cls = gateClass(method, path)
  if (cls === 'open') return { ok: true, via: 'open' }
  if (who.jwt) return { ok: true, via: 'jwt' }
  if (cls === 'jwt') return { ok: false, status: 403, text: NEED_JWT }
  if (who.key) return { ok: true, via: 'key' }
  const read = method === 'GET' || method === 'HEAD'
  // PO_DEV（測試埠）只放行讀；寫入照樣要金鑰（主管 11-26 裁示，安全審 F-1：測試埠開在真資料上時，本機程式改不了東西）。示意 POST 由 server.ts 另外放行
  if (o.dev && read) return { ok: true, via: 'dev' }
  if (o.tailscale) return read ? { ok: true, via: 'tailscale' } : { ok: false, status: 403, text: TS_READ_ONLY }
  return { ok: false, status: 401, text: NEED_ANY }
}

/** PO_DEV 只在測試埠生效；其他埠設了也不理（回 ignored 給啟動時寫一行） */
export function devMode(env: string | undefined, port: number): { dev: boolean; ignored: boolean } {
  const on = env === '1'
  return { dev: on && DEV_PORTS.has(port), ignored: on && !DEV_PORTS.has(port) }
}

const KEY_RE = /^[0-9a-f]{64}$/
/**
 * 本機金鑰：檔案不在就獨占建立（0600，32 bytes 亂數的 hex）；在的話要是自己的一般檔（不是連結）、群組與其他人沒有任何權限、內容格式對。
 * 驗不過回 error（伺服器照樣啟動，只是沒有金鑰：本機程式都過不了，手機頁照常）
 */
export function loadLocalKey(file: string, uid = process.getuid?.(), platform: string = process.platform): { key: string } | { error: string } {
  try {
    const fd = openSync(file, 'wx', 0o600)
    try { writeSync(fd, Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('hex') + '\n') } finally { closeSync(fd) }
  } catch (e: any) { if (e?.code !== 'EEXIST') return { error: `建不起本機金鑰檔：${e?.code ?? e}` } }
  let st
  try { st = lstatSync(file) } catch (e: any) { return { error: `讀不到本機金鑰檔：${e?.code ?? e}` } }
  if (st.isSymbolicLink() || !st.isFile()) return { error: '本機金鑰檔不是一般檔（連結或資料夾），不用' }
  if (uid !== undefined && st.uid !== uid) return { error: '本機金鑰檔不是自己的，不用' }
  // Windows 沒有 POSIX 權限：bun／node 的 lstat 一律回 666（唯讀檔 444），這項永遠不過，金鑰會被丟掉、本機呼叫全 401（0.63.61）。
  // 檔在使用者自己的設定夾，NTFS 預設只給本人與管理員；Mac／Linux 照舊要 600
  if (platform !== 'win32' && st.mode & 0o077) return { error: `本機金鑰檔權限太寬（${(st.mode & 0o777).toString(8)}），要 600；不用` }
  const key = readFileSync(file, 'utf8').trim()
  if (!KEY_RE.test(key)) return { error: '本機金鑰檔內容格式不對，不用' }
  return { key }
}

/** 定長比對（長度不同直接 false；格式不對的也 false） */
export function keyMatches(given: string | null | undefined, key: string | undefined): boolean {
  if (!key || !given || !KEY_RE.test(given)) return false
  return timingSafeEqual(Buffer.from(given), Buffer.from(key))
}

/**
 * Host 檢查（0.63.56，安全審 F-1：DNS rebinding）：本機只收 127.0.0.1:<埠>、localhost:<埠>；其他名稱只收 remote.json 的 publicHosts
 * （Cloudflare、Tailscale 的對外網址），或這個請求帶了驗過的 Access JWT（壞網站拿不到 JWT）。沒有 Host、格式怪的都不收
 */
export function hostOk(host: string | null, port: number, publicHosts: string[], jwtOk: boolean): boolean {
  if (!host) return false
  const h = host.trim().toLowerCase()
  if (h === `127.0.0.1:${port}` || h === `localhost:${port}`) return true
  const name = h.replace(/:443$/, '')
  if (!/^[a-z0-9.-]+$/.test(name)) return false
  return publicHosts.includes(name) || jwtOk
}
