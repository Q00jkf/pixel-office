// 手機版辦公室（第 3 期）：本機 HTTP 伺服器，讀 ~/.claude/pixel-office/ 共用資料夾，畫跟 Desktop 同一張向量辦公室。
// 對外靠 Cloudflare Tunnel＋Cloudflare Access（只放行 owner）；只聽 127.0.0.1。
// 啟動：bun <這個檔>；設定在 ~/.claude/pixel-office/remote.json：{ "port": 8767, "owner": "<Access 登入的 email>" }
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Coworker } from '../types'
import { MIN_ROWS, assignSeats, setSpread } from '../hooks/scene'
import { STALE_MS, parseStatus } from '../hooks/status'
import { drawVector, vectorSvg } from '../hooks/vector'

const BASE = join(homedir(), '.claude', 'pixel-office')
const SESSIONS = join(BASE, 'sessions')

type Config = { port: number; owner?: string }
function config(): Config {
  try {
    const j = JSON.parse(readFileSync(join(BASE, 'remote.json'), 'utf8'))
    return { port: Number(j.port) || 8767, owner: typeof j.owner === 'string' ? j.owner.toLowerCase() : undefined }
  } catch {
    return { port: 8767 }
  }
}

/** 在線的人（跟面板同一套判斷）＋一次性對話數 */
export function crew(now = Date.now()): { people: Coworker[]; oneshots: Coworker[] } {
  const found: Coworker[] = []
  let names: string[] = []
  try {
    names = readdirSync(SESSIONS).filter(n => n.endsWith('.json') && n !== 'me.json')
  } catch {}
  for (const n of names) {
    const p = join(SESSIONS, n)
    try {
      if (now - statSync(p).mtimeMs > STALE_MS) continue
      const c = parseStatus(JSON.parse(readFileSync(p, 'utf8')), now)
      if (c) found.push(c)
    } catch {}
  }
  const people = found.filter(c => !c.oneshot).sort((a, b) => a.id.localeCompare(b.id))
  return { people, oneshots: found.filter(c => c.oneshot) }
}

function meeting(now: number, people: Coworker[]): { meeting: boolean; attendees: string[] } {
  try {
    const j = JSON.parse(readFileSync(join(BASE, 'meeting.json'), 'utf8'))
    const who: string[] = Array.isArray(j.participants) ? j.participants.filter((x: unknown) => typeof x === 'string') : []
    const on = now < (Number(j.until) || 0) && (who.length === 0 || people.some(c => who.includes(c.agent ?? '') || who.includes(c.name)))
    return { meeting: on, attendees: who }
  } catch {
    return { meeting: false, attendees: [] }
  }
}

let seats: ReturnType<typeof assignSeats> | undefined
let seatKey = ''

/** 手機直立：寬 w 單位（48～112），高照螢幕比例撐滿 */
export function sceneSvg(w: number, aspect: number, now = Date.now()): string {
  const width = Math.max(48, Math.min(112, Math.round(w)))
  const rows = Math.max(MIN_ROWS, Math.round((width * aspect) / 2))
  const { people, oneshots } = crew(now)
  const m = meeting(now, people)
  const key = `${width}x${rows}`
  if (key !== seatKey) seats = undefined // 版面變了座位重排
  seatKey = key
  setSpread(true)
  seats = assignSeats(people, width, rows, seats, m.meeting, m.attendees)
  const by = new Map<string, number>()
  for (const c of oneshots) {
    const k = c.label ? c.label.split('-')[0] || c.label : '一次性'
    by.set(k, (by.get(k) ?? 0) + 1)
  }
  const t = new Date(now)
  const clock = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
  const queue = people.filter(c => c.mode === 'waiting').sort((a, b) => (a.since ?? 0) - (b.since ?? 0)).map(c => c.id)
  const v = drawVector(people, Math.floor(now / 250), width, rows, [], seats, { ...m, queue, clock, oneshots: [...by].map(([label, n]) => ({ label, n })) })
  return vectorSvg(v)
}

/** 經 Cloudflare 進來的要求必須帶 Access 驗過的 owner email；本機直連（沒有 cf-ray）放行，方便測試 */
export function allowed(h: Headers, owner: string | undefined): boolean {
  if (!h.get('cf-ray')) return true
  const who = h.get('cf-access-authenticated-user-email')?.toLowerCase()
  return !!owner && who === owner
}

const PAGE = readFileSync(join(import.meta.dir, 'page.html'), 'utf8')
const MANIFEST = JSON.stringify({ name: '像素辦公室', short_name: '辦公室', start_url: '/', display: 'standalone', background_color: '#e4eef6', theme_color: '#29366f', icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml' }] })
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#29366f"/><rect x="3" y="8" width="10" height="4" fill="#f4f7fa"/><circle cx="8" cy="5.5" r="2.2" fill="#ffcd75"/></svg>'

if (import.meta.main) {
  const cfg = config()
  Bun.serve({
    hostname: '127.0.0.1',
    port: cfg.port,
    fetch(req) {
      if (!allowed(req.headers, config().owner)) return new Response('forbidden', { status: 403 })
      const url = new URL(req.url)
      const nocache = { 'cache-control': 'no-store' }
      if (url.pathname === '/') return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', ...nocache } })
      if (url.pathname === '/scene.svg') {
        const w = Number(url.searchParams.get('w')) || 64
        const a = Number(url.searchParams.get('a')) || 1.6
        return new Response(sceneSvg(w, Math.max(0.5, Math.min(3, a))), { headers: { 'content-type': 'image/svg+xml', ...nocache } })
      }
      if (url.pathname === '/state.json') {
        const { people, oneshots } = crew()
        return Response.json({ people: people.map(c => ({ name: c.name, mode: c.mode, tool: c.tool, title: c.title, role: c.role })), oneshots: oneshots.length }, { headers: nocache })
      }
      if (url.pathname === '/manifest.webmanifest') return new Response(MANIFEST, { headers: { 'content-type': 'application/manifest+json' } })
      if (url.pathname === '/icon.svg') return new Response(ICON, { headers: { 'content-type': 'image/svg+xml' } })
      return new Response('not found', { status: 404 })
    },
  })
  console.log(`pixel-office remote: http://127.0.0.1:${cfg.port}  owner=${cfg.owner ?? '（未設定：經 Cloudflare 的要求一律 403）'}`)
}
