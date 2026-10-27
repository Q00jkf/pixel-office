// 手機版辦公室（第 3 期）：本機 HTTP 伺服器，讀 ~/.claude/pixel-office/ 共用資料夾，畫跟 Desktop 同一張向量辦公室。
// 對外靠 Cloudflare Tunnel＋Cloudflare Access（只放行 owner）；只聽 127.0.0.1。
// 啟動：bun <這個檔>；設定在 ~/.claude/pixel-office/remote.json：{ "port": 8767, "owner": "<Access 登入的 email>" }
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Coworker } from '../types'
import { MIN_ROWS, assignSeats, layout, setSpread } from '../hooks/scene'
import { STALE_MS, parseStatus } from '../hooks/status'
import { drawVector, sameNameNumbers, vectorSvg } from '../hooks/vector'

const BASE = join(homedir(), '.claude', 'pixel-office')
const SESSIONS = join(BASE, 'sessions')
const COMMANDS = join(BASE, 'commands')
const REPLIES = join(BASE, 'replies')
const COMMAND_TTL_MS = 10 * 60 * 1000 // 跟 hooks/register.tsx 的 COMMAND_TTL_MS 一樣

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
let box = { w: 64, h: 128 } // 上一張圖的 viewBox，給點人換算座標

/** 手機要幾排桌：有 peer 在線的主管一隊一排（只有一位主管時照舊有一排），沒 team 的人每 8 個一排、至少一排 */
export function deskRowsNeeded(people: Coworker[]): number {
  const bosses = people.filter(c => c.role === 'manager')
  const ofBoss = (c: Coworker, m: Coworker) => c.team !== undefined && (c.team === m.agent || c.team === m.name)
  const staff = people.filter(c => c.role !== 'manager')
  const teams = bosses.length === 1 ? 1 : bosses.filter(m => staff.some(c => ofBoss(c, m))).length
  const loose = staff.filter(c => !bosses.some(m => ofBoss(c, m))).length
  return teams + Math.max(1, Math.ceil(loose / 8))
}

/** 排數：至少撐滿螢幕，桌子排不下就往下長（手機頁可以上下滑） */
export function phoneRows(width: number, aspect: number, people: Coworker[]): number {
  let rows = Math.max(MIN_ROWS, Math.round((width * aspect) / 2))
  const need = deskRowsNeeded(people)
  while (layout(width, rows).clusters.length / layout(width, rows).cols < need && rows < 400) rows += 1
  return rows
}

/** 手機直立：寬 w 單位（48～112），高照螢幕比例撐滿，桌子不夠就加長 */
export function sceneSvg(w: number, aspect: number, now = Date.now()): string {
  const width = Math.max(48, Math.min(112, Math.round(w)))
  const { people, oneshots } = crew(now)
  const rows = phoneRows(width, aspect, people)
  const m = meeting(now, people)
  box = { w: width, h: rows * 2 }
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

const MODE_TEXT: Record<string, string> = { idle: '閒著', thinking: '思考中', typing: '打字中', reading: '讀檔中', waiting: '等你核准', done: '剛做完', blocked: '被擋下' }

/** 手機點人用：每個人在上一張圖的位置（viewBox 座標）與詳細資料 */
export function roster(now = Date.now()) {
  const { people, oneshots } = crew(now)
  const no = sameNameNumbers(people)
  return {
    box,
    oneshots: oneshots.length,
    people: people.map(c => {
      const at = seats?.get(c.id)?.stand
      return {
        id: c.id,
        cmd: commandState(c.id, now),
        reply: lastReply(c.id),
        name: c.name,
        plate: c.name + (no.get(c.id) ?? ''),
        role: c.role,
        mode: c.mode,
        modeText: MODE_TEXT[c.mode] ?? c.mode,
        tool: c.tool || undefined,
        title: c.title,
        team: c.team,
        agent: c.agent,
        since: c.since,
        approval: c.approval?.tool,
        lastError: c.lastError,
        x: at?.x,
        y: at?.y,
      }
    }),
  }
}

function readJson(p: string): any {
  try {
    return JSON.parse(readFileSync(p, 'utf8'))
  } catch {
    return undefined
  }
}

/** 最近一道命令：送出未收（pending）、已收（delivered）、沒被收就過期（expired） */
export function commandState(id: string, now = Date.now()): { text: string; at: number; state: 'pending' | 'delivered' | 'expired' } | undefined {
  const c = readJson(join(COMMANDS, `${id}.json`))
  if (!c || typeof c.text !== 'string' || typeof c.nonce !== 'string') return undefined
  const done = readJson(join(COMMANDS, `${id}.done.json`))
  const state = done?.nonce === c.nonce ? 'delivered' : now - Number(c.at) < COMMAND_TTL_MS ? 'pending' : 'expired'
  return { text: c.text, at: Number(c.at), state }
}

/** 那個 session 最後一輪的回覆（hooks/register.tsx saveReply 寫的） */
export function lastReply(id: string): { text: string; at: number; ask?: string } | undefined {
  const r = readJson(join(REPLIES, `${id}.json`))
  if (!r || typeof r.text !== 'string' || typeof r.at !== 'number') return undefined
  return { text: r.text, at: r.at, ask: typeof r.ask === 'string' ? r.ask : undefined }
}

/** 手機下命令：寫 commands/<session>.json，那個 session 的外掛每秒來拿（hooks/register.tsx takeCommand） */
export function sendCommand(id: string, text: string, now = Date.now()): string | undefined {
  const t = text.trim()
  if (t === '' || t.length > 4000) return '命令是空的或太長（上限 4000 字）'
  if (!crew(now).people.some(c => c.id === id)) return '這個 session 已經不在線'
  mkdirSync(COMMANDS, { recursive: true })
  writeFileSync(join(COMMANDS, `${id}.json`), JSON.stringify({ nonce: crypto.randomUUID(), text: t, at: now }))
  return undefined
}

/** 送命令只收同源的 JSON：跨站表單送不了 application/json，跨站 fetch 會卡在 CORS 預檢 */
export function sameOrigin(req: Request): boolean {
  if (!(req.headers.get('content-type') ?? '').startsWith('application/json')) return false
  const origin = req.headers.get('origin')
  return !origin || origin === new URL(req.url).origin || origin === `https://${req.headers.get('host')}`
}

/** 經 Cloudflare 進來的要求必須帶 Access 驗過的 owner email；本機直連（沒有 cf-ray）放行，方便測試 */
export function allowed(h: Headers, owner: string | undefined): boolean {
  if (!h.get('cf-ray')) return true
  const who = h.get('cf-access-authenticated-user-email')?.toLowerCase()
  return !!owner && who === owner
}

const PAGE = readFileSync(join(import.meta.dir, 'page.html'), 'utf8')
const MANIFEST = JSON.stringify({ name: '像素辦公室', short_name: '辦公室', start_url: '/', display: 'standalone', background_color: '#e4eef6', theme_color: '#29366f', icons: [
  { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
  { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
  { src: '/icon-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
] })
// 主畫面圖示：Android 不吃 SVG（會退成網址字首），用 build_icon.py 產的 PNG
const PNGS = new Map(['icon-192.png', 'icon-512.png', 'icon-maskable.png'].map(n => [`/${n}`, readFileSync(join(import.meta.dir, n))]))
const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#29366f"/><rect x="3" y="8" width="10" height="4" fill="#f4f7fa"/><circle cx="8" cy="5.5" r="2.2" fill="#ffcd75"/></svg>'

if (import.meta.main) {
  const cfg = config()
  Bun.serve({
    hostname: '127.0.0.1',
    port: cfg.port,
    async fetch(req) {
      if (!allowed(req.headers, config().owner)) return new Response('forbidden', { status: 403 })
      const url = new URL(req.url)
      const nocache = { 'cache-control': 'no-store' }
      if (url.pathname === '/') return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', ...nocache } })
      if (url.pathname === '/scene.svg') {
        const w = Number(url.searchParams.get('w')) || 64
        const a = Number(url.searchParams.get('a')) || 1.6
        return new Response(sceneSvg(w, Math.max(0.5, Math.min(3, a))), { headers: { 'content-type': 'image/svg+xml', ...nocache } })
      }
      if (url.pathname === '/command' && req.method === 'POST') {
        if (!sameOrigin(req)) return new Response('forbidden', { status: 403 })
        const b = await req.json().catch(() => ({}))
        const err = typeof b.id === 'string' && typeof b.text === 'string' ? sendCommand(b.id, b.text) : '格式不對'
        return Response.json(err ? { ok: false, error: err } : { ok: true }, { status: err ? 400 : 200, headers: nocache })
      }
      if (url.pathname === '/state.json') {
        return Response.json(roster(), { headers: nocache })
      }
      if (url.pathname === '/manifest.webmanifest') return new Response(MANIFEST, { headers: { 'content-type': 'application/manifest+json' } })
      const png = PNGS.get(url.pathname)
      if (png) return new Response(png, { headers: { 'content-type': 'image/png', 'cache-control': 'max-age=86400' } })
      if (url.pathname === '/icon.svg') return new Response(ICON, { headers: { 'content-type': 'image/svg+xml' } })
      return new Response('not found', { status: 404 })
    },
  })
  console.log(`pixel-office remote: http://127.0.0.1:${cfg.port}  owner=${cfg.owner ?? '（未設定：經 Cloudflare 的要求一律 403）'}`)
}
