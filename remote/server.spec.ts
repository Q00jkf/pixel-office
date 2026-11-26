// bun test remote（叫 .spec.ts：claude plugin test 會載入所有 .test.ts，而這是本機伺服器、不是 mod）
import { expect, test } from 'bun:test'

import { layout } from '../hooks/scene'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { _setGatePatch } from './server'
// 這支測的是各端點本身，不是身分：當成 PO_DEV 測試埠（端點驗證另在 gate.spec.ts）
const TK = 'a1'.repeat(32) // 測試用的本機金鑰（寫入要帶；PO_DEV 只放行讀）
_setGatePatch({ dev: true, key: TK, anyHost: true, log: join(tmpdir(), `po-spec-access-${process.pid}.jsonl`) }) // 網址用 127.0.0.1（沒埠號）等：Host 檢查另在 gate.spec.ts
import { VENDOR, allowed, b64Photo, mapLimit, shownName, deskRowsNeeded, isHeic, phoneRows, photoLine, photoSentText, readCapped, sameOrigin, savePhoto, sceneSvg, sendPhoto } from './server'

test('requests through Cloudflare need the Access email of the owner; local requests pass', () => {
  const h = (o: Record<string, string>) => new Headers(o)
  expect(allowed(h({}), undefined)).toBe(true)
  expect(allowed(h({ 'cf-ray': 'x' }), 'me@x.com')).toBe(false)
  expect(allowed(h({ 'cf-ray': 'x', 'cf-access-authenticated-user-email': 'other@x.com' }), 'me@x.com')).toBe(false)
  expect(allowed(h({ 'cf-ray': 'x', 'cf-access-authenticated-user-email': 'Me@X.com' }), 'me@x.com')).toBe(true)
  expect(allowed(h({ 'cf-ray': 'x', 'cf-access-authenticated-user-email': 'me@x.com' }), undefined)).toBe(false)
})

test('portrait scene: width is clamped to 48..112 and is at least as tall as the given aspect (taller when desks run out)', () => {
  const h = Number(/viewBox="0 0 64 (\d+)"/.exec(sceneSvg(64, 2))?.[1])
  expect(h).toBeGreaterThanOrEqual(128) // 讀的是本機真的在線名單，人多就更長
  expect(sceneSvg(20, 2)).toContain('viewBox="0 0 48 ')
  expect(sceneSvg(500, 1)).toContain('viewBox="0 0 112 ')
})

test('the phone page grows a desk row per team with peers, plus rows of 8 for everyone else', () => {
  const c = (id: string, extra: object = {}) => ({ id, name: id, mode: 'idle', tool: '', isMe: false, role: 'staff', ...extra }) as any
  const crew = [c('o', { role: 'manager', name: 'office' }), c('w', { role: 'manager', agent: 'willy' }), c('of', { team: 'office' }), c('r2', { team: 'willy' }), ...['a', 'b', 'd', 'e'].map(n => c(n))]
  expect(deskRowsNeeded(crew)).toBe(3)
  expect(deskRowsNeeded([...crew, ...Array.from({ length: 6 }, (_, i) => c(`x${i}`))])).toBe(4) // 沒 team 的 10 人 → 2 排
  const rows = phoneRows(64, 1.98, crew)
  expect(layout(64, rows).clusters.length / 2).toBeGreaterThanOrEqual(3)
})

test('commands are taken only as same-origin JSON', () => {
  const r = (h: Record<string, string>) => new Request('https://office.example.com/command', { method: 'POST', headers: h })
  expect(sameOrigin(r({ 'content-type': 'application/json', origin: 'https://office.example.com' }))).toBe(true)
  expect(sameOrigin(r({ 'content-type': 'application/json' }))).toBe(true)
  expect(sameOrigin(r({ 'content-type': 'application/json', origin: 'https://evil.example' }))).toBe(false)
  expect(sameOrigin(r({ 'content-type': 'text/plain', origin: 'https://office.example.com' }))).toBe(false)
})

test('the reply card renders Markdown only through DOMPurify, from vendored files that carry their licenses', () => {
  expect([...VENDOR.keys()]).toEqual(['/vendor/marked.umd.js', '/vendor/purify.min.js'])
  for (const n of ['LICENSE-marked', 'LICENSE-dompurify']) expect(existsSync(join(import.meta.dir, 'vendor', n))).toBe(true)
  const page = readFileSync(join(import.meta.dir, 'page.html'), 'utf8')
  expect(page).toContain('DOMPurify.sanitize(marked.parse(')
  expect(page.match(/marked\.parse\(/g)?.length).toBe(1) // 沒有繞過過濾的第二條路
})

test('photos: only JPEG/HEIC up to 8 MB, only to a session that is online; nothing is written otherwise', async () => {
  const jpg = (n: number) => { const b = new Uint8Array(n); b.set([0xff, 0xd8, 0xff]); return b }
  const err = async (...a: Parameters<typeof sendPhoto>) => (await sendPhoto(...a)).text
  expect(await err('x', '', new Uint8Array(0))).toBe('照片是空的或太大（最多 8 MB）')
  expect(await err('x', '', jpg(8 * 1024 * 1024 + 1))).toBe('照片是空的或太大（最多 8 MB）')
  expect(await err('x', '', new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe('只收 JPEG 或 HEIC 照片')
  expect(await err('x', 'a'.repeat(3001), jpg(10))).toContain('太長')
  expect(await err('no-such-session', 'hi', jpg(10))).toBe('這位已經不在線')
  const page = readFileSync(join(import.meta.dir, 'page.html'), 'utf8')
  expect(page).toContain("fetch('/upload'") // 客製伺服器把 / 開頭的路徑換成相對路徑
})

test('Codex photos (2026-11-25): HEIC is accepted; Codex is asked to use view_image and to say so if it cannot open it', async () => {
  const heic = (brand: string, compat = '') => { const b = new Uint8Array(32); b.set([0, 0, 0, 0x18 + compat.length]); b.set([...'ftyp' + brand + '\0\0\0\0' + compat].map(c => c.charCodeAt(0)), 4); return b }
  expect(isHeic(heic('heic'))).toBe(true)
  expect(isHeic(heic('mif1'))).toBe(true)
  expect(isHeic(heic('isom'))).toBe(false) // MP4 之類的不算
  expect(isHeic(heic('abcd', 'mif1heic'))).toBe(true) // 主品牌不認得、相容品牌有 HEIF 的也收（審查 photo 1）
  expect((await sendPhoto('no-such-session', '', heic('heic'))).text).toBe('這位已經不在線') // HEIC 過了格式檢查
  expect(photoLine('codex', '/u/a.jpg')).toContain('view_image')
  expect(photoLine('codex', '/u/a.jpg')).toContain('照片打不開')
  expect(photoLine(undefined, '/u/a.jpg')).toContain('Read')
  expect(photoSentText({ kind: 'codex', name: 'cx' })).toBe('照片已排進 cx 的對話，已請它打開來看；打不開會在回覆裡說') // 不說「已看到」
  expect(photoSentText({})).toBe('照片已送出，等它接收')
  const page = readFileSync(join(import.meta.dir, 'page.html'), 'utf8')
  expect(page).not.toContain('Codex 先不收照片')
})

import { demoRoster, recipientId, sayToTable } from './server'

test('state.json tables carry the at-a-glance status and the member list', () => {
  const j = demoRoster(12, 0)
  const t: any = j.tables[0]
  expect(typeof t.status).toBe('string')
  expect(t.members.length).toBe(t.count)
  for (const id of t.members) expect(j.people.find(p => p.id === id)?.seat?.startsWith(`t${t.id}.`)).toBe(true)
})

test('say to a whole table: demo mode only reports who would get it; bad table or empty text is refused', async () => {
  const j = demoRoster(12, 0), t: any = j.tables[0]
  const r = await sayToTable(t.id, '大家回報進度', 12, 0)
  expect(r.ok).toBe(true)
  expect(r.sent.sort()).toEqual([...t.members].sort())
  expect(r.text).toContain('示意')
  expect((await sayToTable(999, 'hi', 12, 0)).ok).toBe(false)
  expect((await sayToTable(t.id, '   ', 12, 0)).ok).toBe(false)
})

test('paper plane recipient: matched by ListAgents name (a trailing [ref] is fine) or socket address', () => {
  const c = (id: string, extra: object) => ({ id, name: id, mode: 'idle', tool: '', isMe: false, role: 'staff', ...extra }) as any
  const crew = [c('1', { agent: '像素工程師' }), c('2', { addr: 'uds:/tmp/x.sock' })]
  expect(recipientId(crew, '像素工程師 [ef5fc8]')).toBe('1')
  expect(recipientId(crew, 'uds:/tmp/x.sock')).toBe('2')
  expect(recipientId(crew, 'nobody')).toBeUndefined()
})

import { promoteAtTable } from './server'

test('promote at a table (demo): only someone sitting there and not already a manager', () => {
  const j = demoRoster(12, 0), t: any = j.tables[0]
  const staff = t.members.find((id: string) => j.people.find(p => p.id === id)!.role !== 'manager')
  const boss = t.members.find((id: string) => j.people.find(p => p.id === id)!.role === 'manager')
  expect(promoteAtTable(t.id, staff, 12, 0).ok).toBe(true)
  expect(promoteAtTable(t.id, boss, 12, 0).ok).toBe(false)
  expect(promoteAtTable(t.id, 'nobody', 12, 0).ok).toBe(false)
})

import { tableTeamPreview, tableTeamUp } from './server'

test('table team-up (demo): preview and go only answer, nothing is written; go needs the preview version', async () => {
  const v: any = tableTeamPreview(1, 12, 0)
  expect(v.ok).toBe(true)
  expect(v.ver).toBe('demo')
  expect(v.notify).toBeGreaterThan(0)
  expect((await tableTeamUp(1, 'demo', 12, 0)).text).toContain('（示意）')
  expect((await tableTeamUp(1, 'stale', 12, 0)).text).toContain('請重看確認卡')
})

test('table team-up route: same-origin JSON only, op is preview/go, table is a positive integer', async () => {
  const { handle } = await import('./server')
  const post = (b: object, h: Record<string, string> = {}) => handle(new Request('http://127.0.0.1/table-team', { method: 'POST', headers: { 'x-po-key': TK, 'content-type': 'application/json', ...h }, body: JSON.stringify(b) }))
  expect((await post({ table: 1, op: 'preview', demo: 12 }, { origin: 'https://evil.example' })).status).toBe(403)
  const bad = await post({ table: 1, op: 'delete', demo: 12 })
  expect(bad.status).toBe(400)
  expect((await bad.json()).text).toContain('只收 preview、go')
  expect((await post({ table: 1.5, op: 'preview', demo: 12 })).status).toBe(400)
  expect((await post({ table: '0', op: 'preview', demo: 12 })).status).toBe(400)
  for (const t of [true, [1], '1']) expect((await post({ table: t, op: 'preview', demo: 12 })).status).toBe(400)
  expect((await (await post({ table: 1, op: 'go', ver: 'demo', demo: 12, members: ['x'] })).json()).text).toContain('（示意）') // 多帶成員也不採用
})

test('table team-up wiring: the last check re-reads the live roster; a boss swap or seat change while delivering does not save the table', async () => {
  const { tableTeamUp, teamDeps } = await import('./server')
  const { teamPreview } = await import('./teamup')
  const os = require('node:os'), fs = require('node:fs')
  for (const change of ['swap', 'move'] as const) {
    let people: any[] = [{ id: 'b1', plate: '主', agent: '主管名', role: 'manager', seat: 't5.0' }, { id: 'a1', plate: '甲', agent: '甲名', role: 'staff', seat: 't5.1' }]
    const S: any = { tables: [{ id: 5, name: '五號桌', size: 4 }], seats: {}, pins: {}, nextId: 6 }
    let persisted = 0, release: () => void = () => {}, full = 0, peeks = 0
    const dir = fs.mkdtempSync(join(os.tmpdir(), 'po-team-'))
    const src = {
      roster: () => { full++; return { people: people.map(p => ({ ...p })) } },
      peek: () => { peeks++; return { people: people.map(p => ({ ...p })) } },
      store: () => S, persist: () => { persisted++ },
      order: () => true, mail: () => true, dir: () => dir,
      deliver: async (p: any) => { if (p.id === 'b1') await new Promise<void>(r => { release = r }); return { state: 'sent' as const } },
    }
    const v: any = teamPreview(5, teamDeps(src))
    full = 0
    const run = tableTeamUp(5, v.ver, undefined, 0, src)
    await new Promise(r => setTimeout(r, 20)) // 停在通知主管那一步
    people = change === 'swap'
      ? [{ ...people[0], role: 'staff' }, { ...people[1], role: 'manager' }]
      : [{ ...people[0], seat: 't9.0' }, people[1]]
    release()
    const r = await run
    expect(r.ok).toBe(false)
    expect(r.text).toContain('這桌的主管剛剛換了')
    expect(persisted).toBe(0)
    expect(S.tables[0].group).toBeUndefined()
    expect(full).toBe(1) // 完整名冊（會寫檔）一次成組只叫一次
    expect(peeks).toBe(1) // 最後一查用只讀名冊
  }
})

test('peekRoster is read-only: no office file is written', async () => {
  const { peekRoster } = await import('./server')
  const prev = process.env.PO_PORT
  process.env.PO_PORT = '8794'
  const f = join(homedir(), '.claude', 'pixel-office', 'office-8794.json')
  const before = existsSync(f) ? statSync(f).mtimeMs : undefined
  try {
    const r = peekRoster()
    expect(Array.isArray(r.people)).toBe(true)
    expect(existsSync(f) ? statSync(f).mtimeMs : undefined).toBe(before)
  } finally { if (prev === undefined) delete process.env.PO_PORT; else process.env.PO_PORT = prev }
})

test('roster and peekRoster seat people the same way (shared seatList): same-name manager, old-plate team, unpinned manager', async () => {
  const { seatList, seatPerson } = await import('./server')
  const { assign, parseStore } = await import('../hooks/officeV2')
  const cw = (id: string, x: object) => ({ id, name: '主管', code: id, mode: 'idle', tool: '', isMe: false, role: 'staff', ...x }) as any
  // 兩位都叫「主管」（名牌編號 ①②）；主管 agent=lead、沒釘選；員工 team 寫舊名牌「主管」；桌子掛 lead
  const people = [cw('b1', { role: 'manager', agent: 'lead' }), cw('b2', { name: '主管', agent: 'other' }), cw('s1', { name: '員工', team: '主管' }), cw('s2', { name: '員工乙', team: 'lead' })]
  const store = JSON.stringify({ tables: [{ id: 1, name: '一號桌', size: 4, team: 'lead' }], seats: {}, pins: {}, nextId: 2 })
  const list = seatList(people).map(x => x.p)
  const full = assign(parseStore(store), list as any, 0).map // roster() 的路徑（非 Codex：resolveCodexPins 不影響）
  const peek = assign(parseStore(JSON.stringify(parseStore(store))), list as any, 0).map // peekRoster() 的路徑：辦公室檔複本
  expect([...peek.entries()].sort()).toEqual([...full.entries()].sort())
  expect(full.get('b1')).toBe('t1.0')
  // 舊版 peek（沒有 name）會把主管算到別處：這個測試抓得到那個差異
  const noName = list.map(({ name: _n, ...p }) => p)
  const old = assign(parseStore(store), noName as any, 0).map
  expect([...old.entries()].sort()).not.toEqual([...full.entries()].sort())
  expect(seatPerson(people[0], new Map()).name).toBe('主管')
})

import { replyAtTable } from './server'

test('reply to the waiting people at a table (demo): only those waiting for a reply, not stuck on an approval', () => {
  const j = demoRoster(40, 0)
  const seat = new Map(j.people.map(p => [p.id, p.seat]))
  const t: any = j.tables.find((t: any) => j.people.some(p => seat.get(p.id)?.startsWith(`t${t.id}.`) && p.mode === 'waiting' && !p.approval))
  if (!t) return // 示意資料這個時段沒人在等：略過
  const at = j.people.filter(p => seat.get(p.id)?.startsWith(`t${t.id}.`))
  const ask = at.filter(p => p.mode === 'waiting' && !p.approval).map(p => p.id)
  const r = replyAtTable(t.id, at.map(p => p.id), '繼續', 40, 0)
  expect(r.ok).toBe(true)
  expect(r.sent.sort()).toEqual(ask.sort())
  expect(replyAtTable(t.id, ask, '  ', 40, 0).ok).toBe(false)
  expect(replyAtTable(t.id, ['nobody'], 'x', 40, 0).ok).toBe(false)
})

// ---------- 0.62.8 招聘選身分與座位（用測試 port 的座位表，假的招聘，不開任何對話） ----------
import { hireAt } from './server'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'

test('hire with role and seat: new table for a manager, staff into a table, guards for full tables and staff opening tables', () => {
  const port = '8797', prev = process.env.PO_PORT
  process.env.PO_PORT = port
  const file = join(homedir(), '.claude', 'pixel-office', `office-${port}.json`)
  try {
    let n = 0
    const fake = (b: any) => ({ ok: true, text: `招聘了 ${b.name}`, sid: `fake-${++n}`, role: b.role, team: b.team }) as any
    expect(hireAt({ name: 'X', role: 'staff', seat: 'new' }, 0, fake).ok).toBe(false)
    const m = hireAt({ name: '新主管', role: 'manager', seat: 'new' }, 0, fake)
    expect(m.ok).toBe(true)
    const S = JSON.parse(readFileSync(file, 'utf8'))
    const t = S.tables.find((x: any) => x.team === '新主管')
    expect(t.name).toBe('新主管桌')
    expect(S.pins['fake-1']).toBe(`t${t.id}.0`)
    // 員工坐這張（主管還沒上線＝這桌現在沒有在線的主管）：入座、佔下一個空位
    const st = hireAt({ name: '員工', role: 'staff', seat: String(t.id) }, 0, fake)
    expect(st.ok).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8')).pins['fake-2']).toBe(`t${t.id}.1`)
    hireAt({ name: 'a', role: 'staff', seat: String(t.id) }, 0, fake)
    hireAt({ name: 'b', role: 'staff', seat: String(t.id) }, 0, fake)
    expect(hireAt({ name: 'c', role: 'staff', seat: String(t.id) }, 0, fake).text).toContain('坐滿了')
    expect(hireAt({ name: 'd', role: 'staff', seat: '999' }, 0, fake).ok).toBe(false)
  } finally {
    if (prev === undefined) delete process.env.PO_PORT; else process.env.PO_PORT = prev
    rmSync(file, { force: true })
  }
}, 30000) // 讀真的名冊（hireAt → roster）：在線的人多時第一次要好幾秒（2026-11-24 53 人約 7 秒）

import { officeOfDir } from './server'

test('collab folder of a work folder follows projects.json like takeover.py (worktree mapped on this machine, else <repo>/.claude/office)', () => {
  const tmp = join(require('node:os').tmpdir(), 'po-no-repo')
  expect(officeOfDir(tmp)).toBe(`${tmp}/.claude/office`.replace(/\\/g, '/')) // Windows：程式回的路徑一律 /
})

// ---------- 0.62.10 共用筆記、交代、行政（測試 port、暫存協作資料夾、假的招聘） ----------
import { handle, noteToTable, tableNotes } from './server'
import { mkdtempSync as mkt, writeFileSync as wf, mkdirSync as md } from 'node:fs'

test('table notes read the table\'s collab folder; 交代 is written there with a time; admins sit next to the manager seat', async () => {
  const port = '8796', prev = process.env.PO_PORT
  process.env.PO_PORT = port
  const file = join(homedir(), '.claude', 'pixel-office', `office-${port}.json`)
  const dir = mkt(join(require('node:os').tmpdir(), 'po-notes-'))
  try {
    let n = 0
    const fake = (b: any) => ({ ok: true, text: 'ok', sid: `fk-${++n}` }) as any
    hireAt({ name: '主', role: 'manager', seat: 'new' }, 0, fake)
    const t = JSON.parse(readFileSync(file, 'utf8')).tables.at(-1)
    const r = await handle(new Request('http://127.0.0.1/tables', { method: 'POST', headers: { 'x-po-key': TK, 'content-type': 'application/json' }, body: JSON.stringify({ op: 'edit', id: t.id, collab: dir }) }))
    expect((await r.json()).ok).toBe(true)
    md(join(dir, 'checkpoints'))
    wf(join(dir, 'collab.md'), '# 待使用者裁示\n| # | 事項 | 在哪 | 日 |\n|---|---|---|---|\n| 1 | 要不要含運費 | | 11-23 |\n# 目標\n週五交\n')
    const v: any = tableNotes(t.id)
    expect(v.dir).toBe(dir)
    expect(v.decide.map((d: any) => d.text)).toEqual(['要不要含運費'])
    expect(v.hasBoss).toBe(false) // 假的主管沒上線
    expect(v.bossPart.parts[0]).toEqual({ title: '目標', text: '週五交' })
    expect(noteToTable(t.id, '先做報價', undefined, new Date(2026, 10, 23, 9, 30).getTime()).text).toContain('還沒有主管')
    expect(readFileSync(join(dir, '交代.md'), 'utf8')).toContain('- 2026-11-23 09:30 先做報價')
    expect((tableNotes(t.id) as any).asks).toEqual(['2026-11-23 09:30 先做報價'])
    expect(hireAt({ name: '行', role: 'admin', seat: 'none' }, 0, fake).ok).toBe(false)
    expect(hireAt({ name: '行', role: 'admin', seat: String(t.id), task: '先整理' }, 0, fake).ok).toBe(true)
    const S3 = JSON.parse(readFileSync(file, 'utf8'))
    expect(S3.pins[`fk-${n}`]).toBe(`t${t.id}.1`)
    expect(S3.tables.find((x: any) => x.id === t.id).admin).toBe(`fk-${n}`)
  } finally {
    if (prev === undefined) delete process.env.PO_PORT; else process.env.PO_PORT = prev
    rmSync(file, { force: true })
    for (const f of require('node:fs').readdirSync(join(homedir(), '.claude', 'pixel-office', 'notes'))) if (f.startsWith(`${port}-`)) rmSync(join(homedir(), '.claude', 'pixel-office', 'notes', f), { force: true })
  }
})

// ---------- 0.62.11 副本、任務卡片 ----------
import { ccTargets } from './server'
import { taskCard } from '../hooks/officeV2'

test('📎 copies go to the sender\'s manager once per manager, not for messages to the manager itself or staff without one', () => {
  const c = (id: string, extra: object) => ({ id, name: id, mode: 'idle', tool: '', isMe: false, role: 'staff', ...extra }) as any
  const ppl = [c('m', { role: 'manager', agent: '主管' }), c('a', { agent: 'A', team: '主管' }), c('b', { agent: 'B', team: '主管' }), c('x', { agent: 'X' })]
  expect([...ccTargets(ppl, ['a', 'b'])]).toEqual([['m', ['A', 'B']]])
  expect(ccTargets(ppl, ['m']).size).toBe(0)
  expect(ccTargets(ppl, ['x']).size).toBe(0)
  expect(ccTargets(ppl, ['a', 'm']).size).toBe(0) // 主管本人也在收件人裡：不另送副本
})

test('task card: parts wait for earlier ones, progress counts done, all done gets a finish time', () => {
  const def = { id: 'abcd1234', title: '報價', boss: 'm', parts: [{ who: 'A', what: '查價' }, { who: 'B', what: '寫報價', after: [0] }, { who: 'C', what: '校對', after: [1] }], at: 100 }
  let c = taskCard(def, new Map())
  expect(c.parts.map(p => p.stateZh)).toEqual(['進行中', '等前面', '等前面'])
  expect(c.progress).toBe('進行中 0/3')
  c = taskCard(def, new Map([[0, { state: 'done' as const, at: 200 }], [1, { state: 'stuck' as const, at: 210, note: '缺運費' }]]))
  expect(c.parts.map(p => p.stateZh)).toEqual(['完成', '卡住', '等前面'])
  expect(c.progress).toBe('有人卡住 1/3')
  c = taskCard(def, new Map([0, 1, 2].map(i => [i, { state: 'done' as const, at: 300 + i }])))
  expect(c.progress).toBe('完成 3/3')
  expect(c.doneAt).toBe(302)
})

// ---------- 0.62.13 整桌排班（測試 port，假的招聘開桌，不送任何話） ----------
import { dayMatch, daysText, shifts } from './hr'

test('shift days: every day, weekdays, and a weekday of the week', () => {
  const mon = new Date(2026, 10, 23), sun = new Date(2026, 10, 22)
  expect(dayMatch({ days: 'daily' }, sun)).toBe(true)
  expect(dayMatch({ days: 'weekdays' }, mon)).toBe(true)
  expect(dayMatch({ days: 'weekdays' }, sun)).toBe(false)
  expect(dayMatch({ days: 'weekly', dow: 1 }, mon)).toBe(true)
  expect(dayMatch({ days: 'weekly', dow: 1 }, sun)).toBe(false)
  expect(daysText({ days: 'weekly', dow: 1 })).toBe('每週一')
})

test('a whole-table shift is saved without a fixed member list and runs against whoever sits there now', async () => {
  const port = '8795', prev = process.env.PO_PORT
  process.env.PO_PORT = port
  const base = join(homedir(), '.claude', 'pixel-office')
  try {
    hireAt({ name: '排班主', role: 'manager', seat: 'new' }, 0, () => ({ ok: true, text: 'ok', sid: 'fk-shift' }) as any)
    const t = JSON.parse(readFileSync(join(base, `office-${port}.json`), 'utf8')).tables.at(-1)
    const post = async (b: object) => (await handle(new Request('http://127.0.0.1/schedule', { method: 'POST', headers: { 'x-po-key': TK, 'content-type': 'application/json' }, body: JSON.stringify(b) }))).json()
    expect((await post({ op: 'add', table: t.id, action: 'meet', time: '09:00', days: 'weekly', dow: 1, text: '' })).ok).toBe(false)
    const r = await post({ op: 'add', table: t.id, action: 'meet', time: '09:00', days: 'weekly', dow: 1, text: '本週計畫' })
    expect(r.text).toContain('每週一 09:00')
    const x = shifts().at(-1)!
    expect(x).toMatchObject({ table: t.id, action: 'meet', days: 'weekly', dow: 1, text: '本週計畫' })
    expect(x.who.id).toBe(`table:${t.id}`) // 不存成員名單
    const run = await post({ op: 'run', sid: x.sid })
    expect(run.text).toContain('這桌現在沒有人') // 假的主管沒上線：沒有人可送
    expect((await post({ op: 'add', table: 9999, action: 'report', time: '09:00', days: 'daily', text: 'x' })).ok).toBe(false)
  } finally {
    if (prev === undefined) delete process.env.PO_PORT; else process.env.PO_PORT = prev
    for (const f of [`office-${port}.json`, `remote-schedule-${port}.json`]) rmSync(join(base, f), { force: true })
  }
})

// ---------- 0.62.14 狀態中文 ----------
test('status words shown to people are Chinese (state.json modeText, shared-notes 分工與進度 incl. demo)', async () => {
  const j = demoRoster(12, 0)
  for (const p of j.people) expect(p.modeText).toMatch(/^(閒著|思考中|正在寫|正在讀|等你回覆|剛做完|卡住了)$/)
  const t: any = j.tables[0]
  const r = await handle(new Request(`http://127.0.0.1/table-notes.json?table=${t.id}&demo=12`))
  for (const a of (await r.json()).auto) expect(a.doing).not.toMatch(/[a-z]{4,}/)
})

import { addDirArgs } from './hr'
import { notesDir } from './server'
test('0.62.16: hires onto a table get --add-dir for the table collab folder (no read-outside prompts)', () => {
  const port = '8796', prev = process.env.PO_PORT
  process.env.PO_PORT = port
  const file = join(homedir(), '.claude', 'pixel-office', `office-${port}.json`)
  try {
    const seen: any[] = []
    let n = 0
    const fake = (b: any, opts?: any) => { seen.push(opts); return { ok: true, text: b.name, sid: `fake-${++n}` } }
    hireAt({ name: '桌主', role: 'manager', seat: 'new' }, 0, fake)
    const t = JSON.parse(readFileSync(file, 'utf8')).tables.find((x: any) => x.team === '桌主')
    expect(seen[0].addDirs).toEqual([t.collab])
    hireAt({ name: '員', role: 'staff', seat: String(t.id) }, 0, fake)
    expect(seen[1].addDirs).toEqual([notesDir(t.id)])
    hireAt({ name: '行', role: 'admin', seat: String(t.id) }, 0, fake)
    expect(seen[2].addDirs).toEqual([notesDir(t.id)])
  } finally {
    if (prev === undefined) delete process.env.PO_PORT; else process.env.PO_PORT = prev
    rmSync(file, { force: true })
    rmSync(join(homedir(), '.claude', 'pixel-office', 'notes', `${port}-t1`), { recursive: true, force: true })
  }
  const d = mkt(join(require('node:os').tmpdir(), 'po-add-'))
  expect(addDirArgs([d, undefined, d, '/x/cwd'], '/x/cwd')).toEqual(['--add-dir', d])
  expect(addDirArgs([join(d, 'new', 'sub')])).toEqual(['--add-dir', join(d, 'new', 'sub')])
  expect(existsSync(join(d, 'new', 'sub'))).toBe(true)
  rmSync(d, { recursive: true, force: true })
})

import { unseat } from './server'
test('0.62.17: new tables keep notes under pixel-office, staff hired before the boss arrives still report to him, firing frees the seat', () => {
  const port = '8795', prev = process.env.PO_PORT
  process.env.PO_PORT = port
  const file = join(homedir(), '.claude', 'pixel-office', `office-${port}.json`)
  try {
    const seen: any[] = []
    let n = 0
    const fake = (b: any, opts?: any) => { seen.push({ b, opts }); return { ok: true, text: b.name, sid: `fake-${++n}` } }
    const now = Date.now()
    hireAt({ name: '等等主管', role: 'manager', seat: 'new' }, now, fake)
    const t = JSON.parse(readFileSync(file, 'utf8')).tables.find((x: any) => x.team === '等等主管')
    expect(t.collab).toBe(join(homedir(), '.claude', 'pixel-office', 'notes', `${port}-t${t.id}`))
    const st = hireAt({ name: '早到員工', role: 'staff', seat: String(t.id) }, now, fake)
    expect(seen[1].b.team).toBe('等等主管')
    expect(st.text).toContain('還在路上')
    // 超過 10 分鐘主管還沒來：照舊當沒有主管
    hireAt({ name: '晚到員工', role: 'staff', seat: String(t.id) }, now + 11 * 60e3, fake)
    expect(seen[2].b.team).toBe('')
    unseat('fake-2')
    expect(JSON.parse(readFileSync(file, 'utf8')).pins['fake-2']).toBeUndefined()
    // 空出來的位子招得進人（4 人桌：主管＋早到被清＋晚到＝還剩兩位）
    expect(hireAt({ name: 'x', role: 'staff', seat: String(t.id) }, now, fake).ok).toBe(true)
    expect(hireAt({ name: 'y', role: 'staff', seat: String(t.id) }, now, fake).ok).toBe(true)
    expect(hireAt({ name: 'z', role: 'staff', seat: String(t.id) }, now, fake).ok).toBe(false)
  } finally {
    if (prev === undefined) delete process.env.PO_PORT; else process.env.PO_PORT = prev
    rmSync(file, { force: true })
    for (const f of require('node:fs').readdirSync(join(homedir(), '.claude', 'pixel-office', 'notes')).filter((f: string) => f.startsWith(`${port}-`)))
      rmSync(join(homedir(), '.claude', 'pixel-office', 'notes', f), { recursive: true, force: true })
  }
})

import { codexLineItems, codexTranscript, pageChat } from './hr'
import { mkdtempSync as mkt2, mkdirSync as md2, writeFileSync as wf2 } from 'node:fs'
test('0.62.19: Codex full chat — finds rollout-*-<thread>.jsonl, shows what you said, its replies, tool calls with results; skips env/AGENTS.md preambles', () => {
  const home = mkt2(join(require('node:os').tmpdir(), 'po-codex-'))
  const d = join(home, 'sessions', '2026', '11', '23'); md2(d, { recursive: true })
  const L = (o: any) => JSON.stringify({ timestamp: '2026-11-23T10:00:00Z', ...o })
  const lines = [
    L({ type: 'session_meta', payload: { id: 't1' } }),
    L({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'You are Codex' }] } }),
    L({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>x</environment_context>' }] } }),
    L({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /x' }] } }),
    L({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '幫我看一下' }, { type: 'input_image', image_url: 'x' }] } }),
    L({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '好，我看看' }] } }),
    L({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'text(await tools.exec_command({cmd:`ls -la`}))' } }),
    L({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'a b c' }] } }),
    L({ type: 'response_item', payload: { type: 'function_call', call_id: 'c2', name: 'wait', arguments: '{"cell_id":"1"}' } }),
    L({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c2', output: 'done' } }),
    L({ type: 'event_msg', payload: { type: 'turn_aborted' } }),
  ]
  wf2(join(d, 'rollout-2026-11-23T10-00-00-t1.jsonl'), lines.join('\n') + '\n')
  const f = codexTranscript('t1', home)!
  expect(f).toContain('-t1.jsonl')
  const r: any = pageChat(f, 'codex-t1', undefined, undefined, codexLineItems)
  expect(r.items.map((x: any) => x.k)).toEqual(['user', 'ai', 'tool', 'result', 'tool', 'result', 'note'])
  expect(r.items[0]).toMatchObject({ text: '幫我看一下', img: 1 })
  expect(r.items[2]).toMatchObject({ name: 'exec', desc: 'ls -la', id: 'c1' })
  expect(r.items[3]).toMatchObject({ id: 'c1', text: 'a b c' })
  expect(r.items[5]).toMatchObject({ id: 'c2', text: 'done' })
  // 開著時拿新的：after＝上次的 end
  const more: any = pageChat(f, 'codex-t1', undefined, r.end, codexLineItems)
  expect(more.items).toEqual([])
  expect(codexTranscript('nope', home)).toBeUndefined()
  require('node:fs').rmSync(home, { recursive: true, force: true })
})

import { codexBrief, codexModels } from './hr'
test('0.62.20／0.63.6: hiring Codex — first message says title/team are already set by the office (HR order), then the task; models come from models_cache (visible, by priority)', () => {
  const t = codexBrief({ name: '報價小幫手', team: '主管A', task: '整理報價單' })
  expect(t).not.toContain('office_profile')
  expect(t).toContain('職稱「報價小幫手」')
  expect(t).toContain('主管 主管A')
  expect(t).toContain('任務：整理報價單')
  expect(codexBrief({ name: 'x' })).toContain('回一句「到了」')
  const home = mkt2(join(require('node:os').tmpdir(), 'po-cxm-'))
  wf2(join(home, 'models_cache.json'), JSON.stringify({ models: [
    { slug: 'b', display_name: 'B', visibility: 'list', priority: 2 }, { slug: 'hidden', visibility: 'hide', priority: 0 },
    { slug: 'a', display_name: 'A', visibility: 'list', priority: 1 }] }))
  expect(codexModels(home)).toEqual([{ slug: 'a', name: 'A' }, { slug: 'b', name: 'B' }])
  expect(codexModels(join(home, 'nope'))).toEqual([])
  require('node:fs').rmSync(home, { recursive: true, force: true })
})

test('0.63.3 新員工卡在確認畫面：認得常見畫面，平常的畫面不誤報', async () => {
  const { stuckTitle } = await import('./hr')
  expect(stuckTitle('  Hooks need review\n  1. Review\n› 2. Trust all and continue\n  3. Continue without trusting')).toContain('Hooks need review')
  expect(stuckTitle('Do you trust the files in this folder?\n❯ 1. Yes, proceed')).toBe('要不要信任這個資料夾')
  expect(stuckTitle('Do you trust the contents of this directory?')).toBe('要不要信任這個資料夾')
  expect(stuckTitle('Allow this read outside the working directories?')).toContain('Allow this read')
  expect(stuckTitle('Do you want to proceed?\n❯ 1. Yes')).toBe('權限確認')
  expect(stuckTitle('╭───╮\n│ ✻ Welcome to Claude Code │\n> 到了\n  ⏵⏵ auto mode on')).toBeUndefined()
  expect(stuckTitle('› 設好之後回一句「到了」\n  gpt-5.5 default · ~/work')).toBeUndefined()
})

test('0.63.3 招聘可以帶 --chrome（只有勾了才帶）', () => {
  const src = readFileSync(join(import.meta.dir, 'hr.ts'), 'utf8')
  expect(src).toContain("...(b.chrome === true ? ['--chrome'] : [])")
  const scene = readFileSync(join(import.meta.dir, 'v2', 'scene.js'), 'utf8')
  expect(scene).toContain("chrome: agent() === 'claude' && $('hchrome').checked")
})

const CODEX_HOOKS = '\n  Hooks need review\n  The hooks for this plugin changed.\n\n› 1. Review\n  2. Trust all and continue\n  3. Continue without trusting\n\n  Press enter to confirm or esc to go back\n'
const CLAUDE_TRUST = '╭──────────────╮\n│ Do you trust the files in this folder? │\n│                                        │\n│ ❯ 1. Yes, proceed                      │\n│   2. No, exit                          │\n╰──────────────╯\n   Enter to confirm · Esc to exit\n'

test('0.63.4 確認畫面的選項：編號清單＋游標位置、Esc；平常的編號文字不算', async () => {
  const { stuckOptions } = await import('./hr')
  const cx = stuckOptions(CODEX_HOOKS)
  expect(cx.map(o => o.id)).toEqual(['n1', 'n2', 'n3', 'esc'])
  expect(cx[1]).toMatchObject({ label: '2. Trust all and continue', keys: ['Down', 'Enter'] })
  expect(cx[0].keys).toEqual(['Enter'])
  expect(cx[3].keys).toEqual(['Escape'])
  const cl = stuckOptions(CLAUDE_TRUST)
  expect(cl.map(o => o.label)).toEqual(['1. Yes, proceed', '2. No, exit', '取消（Esc）'])
  // 游標在第 3 項：選第 1 項要往上兩格
  expect(stuckOptions('Do you want to proceed?\n  1. Yes\n  2. Yes, and don\'t ask again\n❯ 3. No\n')[0].keys).toEqual(['Up', 'Up', 'Enter'])
  expect(stuckOptions('Overwrite? (y/n)').map(o => o.id)).toEqual(['y', 'n'])
  expect(stuckOptions('只有一行 1. 這不是選單')).toEqual([])
})

test('0.63.4 替他按：只送卡片上的選項；畫面換了不送；送完確認離開', async () => {
  const { _stuck, pressStuck, stuckOptions } = await import('./hr')
  let screen = CODEX_HOOKS
  const sent: string[] = []
  const io = { capture: () => screen, send: (_: string, k: string) => { sent.push(k); if (k === 'Enter') screen = '› 到了\n  gpt-5.5 default'; return true }, sleep: async () => {} }
  const put = () => _stuck.set('po-cxp-t1', { id: 'st1', name: '甲', session: 'po-cxp-t1', title: 'Hooks need review（Codex 要你確認外掛的 hook）', at: 0, options: stuckOptions(CODEX_HOOKS).map(o => ({ id: o.id, label: o.label })) })
  put()
  expect((await pressStuck('nope', 'n2', io)).ok).toBe(false)
  expect((await pressStuck('st1', 'rm -rf', io)).text).toContain('沒有這個選項')
  expect(sent).toEqual([])
  // 畫面換成別的確認：不送
  screen = CLAUDE_TRUST
  const r0 = await pressStuck('st1', 'n2', io)
  expect(r0.ok).toBe(false); expect(r0.text).toContain('畫面換了'); expect(sent).toEqual([])
  // 正常：往下一格＋Enter，畫面離開，紀錄拿掉
  screen = CODEX_HOOKS; put()
  const r = await pressStuck('st1', 'n2', io)
  expect(r.ok).toBe(true); expect(r.text).toContain('Trust all and continue')
  expect(sent).toEqual(['Down', 'Enter'])
  expect(_stuck.has('po-cxp-t1')).toBe(false)
  // 已經在電腦上處理掉：不送
  screen = '› 到了'; put(); sent.length = 0
  expect((await pressStuck('st1', 'n1', io)).text).toContain('已經離開'); expect(sent).toEqual([])
  _stuck.clear()
})

test('0.63.6 Codex 人事令：Codex 收人事令（agy 照舊送話）；主管只能是 Claude', async () => {
  const { takesOrders, staffing, stuckOptions } = await import('./hr')
  expect(takesOrders({ id: 'abc' })).toBe(true)
  expect(takesOrders({ id: 'codex-1', kind: 'codex' })).toBe(true)
  expect(takesOrders({ id: 'cxp-12345678' })).toBe(true)
  expect(takesOrders({ id: 'agy-1', kind: 'agy' })).toBe(false)
  expect(staffing('codex-0000-test', { op: 'promote' })).toEqual({ ok: false, text: '主管只能是 Claude（使用者 2026-11-24 決定）' })
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  expect(src).toContain("if (boss.kind) return { ok: false, text: '主管只能是 Claude")
  // 0.63.4 補：Codex 實際的確認畫面（2026-11-24 8782 招聘時抓的）提示是「esc skip」
  const real = '  Hooks need review\n  5 hooks are new or changed.\n  Hooks can run outside the sandbox after you trust them.\n› 1. Review hooks\n  2. Trust all and continue\n  3. Continue without trusting (hooks won\'t run)\n  enter confirm · esc skip'
  expect(stuckOptions(real).map(o => o.id)).toEqual(['n1', 'n2', 'n3', 'esc'])
})

test('0.63.6 Codex 檢查點：坐協作桌的帶這桌 checkpoints/ 的檔；第一句話交代存檢查點、壓縮後重讀', () => {
  const port = '8796', prev = process.env.PO_PORT
  process.env.PO_PORT = port
  const file = join(homedir(), '.claude', 'pixel-office', `office-${port}.json`)
  try {
    const got: any[] = []
    const fake = (b: any, opts: any) => { got.push({ b, opts }); return { ok: true, text: 'ok', sid: `fake-${got.length}` } as any }
    const m = hireAt({ name: '桌主', role: 'manager', seat: 'new' }, 0, fake)
    expect(m.ok).toBe(true)
    const t = JSON.parse(readFileSync(file, 'utf8')).tables.find((x: any) => x.team === '桌主')
    hireAt({ name: '小乙', role: 'staff', seat: String(t.id) }, 0, fake)
    const o = got[1].opts
    expect(o.cpFile).toBe(join(o.addDirs[0], 'checkpoints', '小乙.md'))
    expect(got[1].b.task).toContain(o.cpFile)
    // 0.63.22 最後複驗第 4 項：Codex 的檔名加短碼，同名兩位不共用
    hireAt({ name: '小丙', role: 'staff', seat: String(t.id), agent: 'codex' }, 0, fake)
    hireAt({ name: '小丙', role: 'staff', seat: String(t.id), agent: 'codex' }, 0, fake)
    const [c1, c2] = [got[2].opts.cpFile, got[3].opts.cpFile]
    expect(c1).toMatch(/checkpoints[\\/]小丙-[0-9a-f]{6}\.md$/) // Windows 的分隔是 \
    expect(c1).not.toBe(c2)
    expect(got[2].b.task).toContain(c1)
  } finally {
    if (prev === undefined) delete process.env.PO_PORT; else process.env.PO_PORT = prev
    rmSync(file, { force: true })
  }
  const { codexBrief } = require('./hr')
  const brief = codexBrief({ name: '甲', cpFile: '/x/checkpoints/甲.md' })
  expect(brief).toContain('/x/checkpoints/甲.md')
  expect(brief).toContain('壓縮後')
  // 任務裡已經有同一個檢查點（坐協作桌時 hireAt 加的）就不重複
  const b2 = codexBrief({ name: '甲', cpFile: '/x/c.md', task: '在 /x/c.md 存一筆檢查點' })
  expect(b2.split('/x/c.md').length).toBe(3) // 任務裡一次＋「壓縮後重讀」一次，不再重複整句交代
  expect(b2).toContain('壓縮後')
})

test('0.63.8 Codex 傳的話記進協作桌聊天室：照座位記到寄件人、收件人的桌，處理過的不重記', async () => {
  const { drainChatOutbox } = await import('./server')
  const port = '8794', prev = process.env.PO_PORT
  process.env.PO_PORT = port
  const base = join(homedir(), '.claude', 'pixel-office'), box = join(base, 'chat', 'outbox'), chat = join(base, 'chat', port)
  const f = `${Date.now()}-spec0001.json`
  try {
    require('node:fs').mkdirSync(box, { recursive: true })
    wf2(join(box, f), JSON.stringify({ at: Date.now(), from: { id: 'codex-a', name: 'cxA' }, to: { name: '主管A' }, text: '提案好了' }))
    const list = [{ id: 'codex-a', plate: '小甲' }, { id: 'c-boss', plate: '主管', agent: '主管A' }, { id: 'c-x', plate: '路人' }]
    const map = new Map([['codex-a', 't3.1'], ['c-boss', 't5.0']])
    drainChatOutbox(list, map)
    drainChatOutbox(list, map) // 第二次不重記
    // 只有名字、對到兩位以上：不猜（審查第 4 項）
    const f2 = `${Date.now()}-spec0002.json`
    wf2(join(box, f2), JSON.stringify({ at: Date.now(), from: { id: 'codex-a' }, to: { name: '同名' }, text: '給誰？' }))
    drainChatOutbox([...list, { id: 'd1', plate: '同名' }, { id: 'd2', plate: '同名' }], new Map([...map, ['d1', 't5.1'], ['d2', 't5.2']]))
    const t3 = require('node:fs').readdirSync(join(chat, 't3')).map((n: string) => JSON.parse(readFileSync(join(chat, 't3', n), 'utf8')))
    expect(t3.find((e: any) => e.text === '給誰？').to).toEqual({ name: '同名' })
    expect(require('node:fs').readdirSync(join(chat, 't5')).length).toBe(1) // 沒有因為同名第一位記到 t5
    rmSync(join(box, f2), { force: true })
    for (const [t, n] of [['t3', 2], ['t5', 1]] as const) {
      const fs = require('node:fs').readdirSync(join(chat, t)); expect(fs.length).toBe(n)
      const e = JSON.parse(readFileSync(join(chat, t, f), 'utf8'))
      expect(e).toMatchObject({ from: { id: 'codex-a', name: '小甲' }, to: { id: 'c-boss', name: '主管' }, text: '提案好了' })
    }
  } finally {
    if (prev === undefined) delete process.env.PO_PORT; else process.env.PO_PORT = prev
    rmSync(join(box, f), { force: true }); rmSync(chat, { recursive: true, force: true }); rmSync(join(base, 'chat', `outbox-seen-${port}.json`), { force: true })
  }
})

test('0.63.9 投入程度＋模式：畫面認模式、招聘參數、Codex 選單按鍵、模型支援的投入程度', async () => {
  const { permOfScreen, claudeModeArgs, codexModeArgs, codexEffortsOf } = await import('./hr')
  // 2026-11-24 實測 Claude Code 2.1.331 的 Shift+Tab 循環
  expect(permOfScreen('❯ \n───\n  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents')).toBe('auto')
  expect(permOfScreen('❯ \n  ⏸ manual mode on · ? for shortcuts')).toBe('default')
  expect(permOfScreen('  ⏵⏵ accept edits on (shift+tab to cycle)')).toBe('acceptEdits')
  expect(permOfScreen('  ⏸ plan mode on (shift+tab to cycle)')).toBe('plan')
  expect(permOfScreen('auto mode on\n1\n2\n3\n4')).toBeUndefined() // 只看最底下幾行
  expect(claudeModeArgs({})).toEqual({ args: ['--permission-mode', 'auto', '--effort', 'medium'], effort: 'medium', perm: 'auto' })
  expect((claudeModeArgs({ perm: 'default', effort: 'max' }) as any).args).toEqual(['--permission-mode', 'manual', '--effort', 'max'])
  expect(claudeModeArgs({ perm: 'bypassPermissions' })).toBe('不認得的模式')
  expect(claudeModeArgs({ effort: 'ultra' })).toBe('不認得的投入程度')
  expect(codexModeArgs({})).toEqual({ args: ['--approve-for-me'], effort: undefined, perm: 'auto' })
  expect((codexModeArgs({ perm: 'read-only', effort: 'ultra' }) as any).args).toEqual(['-s', 'read-only', '-a', 'on-request', '-c', 'approvals_reviewer="user"', '-c', 'model_reasoning_effort="ultra"'])
  expect(codexModeArgs({ perm: 'full-access' })).toBe('不認得的權限') // 全繞過、danger-full-access 都不給
  expect(codexModeArgs({ perm: 'constructor' })).toBe('不認得的權限') // 0.63.21 複驗第 12 項：只認自己的鍵
  expect(claudeModeArgs({ perm: 'toString' })).toBe('不認得的模式')
  expect((codexModeArgs({ perm: 'default' }) as any).args).toContain('approvals_reviewer="user"')
  const home = mkt2(join(require('node:os').tmpdir(), 'po-cxe-'))
  wf2(join(home, 'models_cache.json'), JSON.stringify({ models: [{ slug: 'luna', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'max' }] }] }))
  expect(codexEffortsOf('luna', home)).toEqual(['low', 'max'])
  expect(codexEffortsOf('nope', home)).toBeUndefined()
})

test('0.63.10 審查第 1 項：App 常駐程式看參數（app-server／exec-server），ChatGPT.app 路徑底下的 tmux CLI 不算', async () => {
  const { isSharedCmd } = await import('./hr')
  expect(isSharedCmd('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex -c features.code_mode_host=true app-server --analytics-default-enabled')).toBe(true)
  expect(isSharedCmd('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex -c forced_login_method="chatgpt" exec-server --concurrency 4')).toBe(true)
  expect(isSharedCmd('/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/../CodexCLI.app/Contents/MacOS/codex --no-daemon --approve-for-me -C /Users/x')).toBe(false)
  expect(isSharedCmd('codex --no-daemon -C /tmp/app-server')).toBe(false)
  // 複驗第 1 項：第一句話（位置參數）裡出現 app-server 不算；子指令前的 -c 值要跳過
  expect(isSharedCmd('/x/codex --no-daemon --approve-for-me -C /Users/x 你是報價員，查一下 app-server 的設定')).toBe(false)
  expect(isSharedCmd('/x/codex --no-daemon -m gpt-6 -c model_reasoning_effort="low" exec-server --concurrency 4')).toBe(true)
  expect(isSharedCmd('/x/codex resume --no-daemon abc app-server')).toBe(false)
})

test('0.63.10 審查第 2 項：還沒套用的人事令不被下一道蓋掉，併在一起、換新 nonce', async () => {
  const { writeOrder, pendingOrder } = await import('./hr')
  const d = join(homedir(), '.claude', 'pixel-office', 'orders'), id = 'spec-order-merge'
  try {
    writeOrder(id, { role: 'manager' })
    const n1 = JSON.parse(readFileSync(join(d, `${id}.json`), 'utf8')).nonce
    writeOrder(id, { team: '主管A' })
    const o = JSON.parse(readFileSync(join(d, `${id}.json`), 'utf8'))
    expect(o).toMatchObject({ role: 'manager', team: '主管A' })
    expect(o.nonce).not.toBe(n1)
    // 收過了也照樣併（0.63.18 複驗第 3 項：看守可能要重套；欄位都是「設成」，重套沒有副作用）
    wf2(join(d, `${id}.done.json`), JSON.stringify({ nonce: o.nonce }))
    expect(pendingOrder(id)).toMatchObject({ role: 'manager', team: '主管A' })
    writeOrder(id, { title: '新職稱' })
    expect(JSON.parse(readFileSync(join(d, `${id}.json`), 'utf8'))).toMatchObject({ role: 'manager', title: '新職稱' })
    // 過期的不併
    wf2(join(d, `${id}.json`), JSON.stringify({ nonce: 'old', at: Date.now() - 11 * 60e3, role: 'staff' }))
    expect(pendingOrder(id)).toBeUndefined()
  } finally { rmSync(join(d, `${id}.json`), { force: true }); rmSync(join(d, `${id}.done.json`), { force: true }) }
})

test('0.63.12 審查第 11、12 項：Codex 輸入框有字、開著選單時不送；/status 讀回實際設定', async () => {
  const { codexReady, parseCodexStatus } = await import('./hr')
  // 2026-11-24 實測 codex 0.171（capture-pane -e）：空的輸入框是灰色提示字（ESC[2m），打了字是一般字
  const empty = 'x\n\x1b[1m›\x1b[0m \x1b[2mAsk Codex to do anything\x1b[0m\n  GPT-6.2-Sol low · ~/x'
  const draft = 'x\n\x1b[1m›\x1b[0m draft text here\n  GPT-6.2-Sol low · ~/x'
  expect(codexReady(empty)).toBeUndefined()
  expect(codexReady(draft)).toContain('還沒送出的字')
  expect(codexReady('\x1b[1m›\x1b[0m \n')).toBeUndefined()
  expect(codexReady('Update Model Permissions\n› 1. Ask for approval\n  2. Approve for me\n  enter select · esc back')).toContain('選單')
  expect(codexReady('  Hooks need review\n› 1. Review hooks\n  2. Trust all and continue')).toContain('確認畫面')
  expect(parseCodexStatus('  Model:               GPT-6.2-Sol (reasoning high, summaries auto)\n  Permissions:         Workspace (Approve for me)')).toEqual({ model: 'GPT-6.2-Sol', effort: 'high', perm: 'auto' })
  expect(parseCodexStatus('Model: X (reasoning low, s)\nPermissions:         Read Only (Ask for approval)').perm).toBe('read-only')
  expect(parseCodexStatus('Permissions:         Workspace (Ask for approval)').perm).toBe('default')
  expect(parseCodexStatus('Permissions:         Full Access').perm).toBe('other')
})

test('0.63.12 tmux 唯讀 client 的退路：只轉一般文字與 Enter（貼上的控制字元會變成字面）', async () => {
  const { keysAsBytes } = await import('./hr')
  expect(keysAsBytes(['send-keys', '-t', '%1', '-l', '/status'])).toEqual({ target: '%1', bytes: '/status' })
  expect(keysAsBytes(['send-keys', '-t', '%1', 'Enter'])).toEqual({ target: '%1', bytes: '\r' })
  expect(keysAsBytes(['send-keys', '-t', '%1', 'Escape'])).toBeUndefined()
  expect(keysAsBytes(['send-keys', '-t', '%1', 'BTab'])).toBeUndefined()
  expect(keysAsBytes(['send-keys', '-t', '%1', '-l', 'a\x1bb'])).toBeUndefined()
  expect(keysAsBytes(['capture-pane', '-t', '%1'])).toBeUndefined()
})

test('0.63.14 審查第 5 項：只有 Claude 能當主管（agy 也擋；降職照舊；狀態檔寫了 manager 也當員工）', async () => {
  const { staffing } = await import('./hr')
  const { parseStatus } = await import('../hooks/status')
  expect(staffing('agy-1234', { op: 'promote' }).ok).toBe(false)
  expect(staffing('codex-0000-x', { op: 'promote' }).ok).toBe(false)
  const now = Date.now()
  expect(parseStatus({ id: 'codex-1', name: 'x', kind: 'codex', role: 'manager', updatedAt: now, mode: 'idle' }, now)?.role).toBe('staff')
  expect(parseStatus({ id: 'agy-1', name: 'x', kind: 'agy', role: 'manager', updatedAt: now, mode: 'idle' }, now)?.role).toBe('staff')
  expect(parseStatus({ id: 'c1', name: 'x', role: 'manager', updatedAt: now, mode: 'idle' }, now)?.role).toBe('manager')
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  expect(src).toContain("if (boss.kind) return { ok: false, text: '主管只能是 Claude")
})

test('0.63.15 審查第 9 項：fork 出來的 Codex 紀錄（…_<thread>.jsonl）也找得到', async () => {
  const { codexTranscript } = await import('./hr')
  const home = mkt2(join(require('node:os').tmpdir(), 'po-cxf-'))
  md2(join(home, 'sessions', '2026', '11', '24'), { recursive: true })
  wf2(join(home, 'sessions', '2026', '11', '24', 'rollout-2026-11-24T00-19-20-01a2aaaa-0000_t9fork.jsonl'), '{}\n')
  expect(codexTranscript('t9fork', home)).toContain('_t9fork.jsonl')
})

test('0.63.16 審查第 14 項：agy 一律不能操作、有理由；Codex 不在線＝unknown', async () => {
  const { agyCap, codexCap } = await import('./hr')
  expect(agyCap.src).toBe('other')
  expect(Object.values(agyCap.can).every(v => v === false)).toBe(true)
  expect(agyCap.why?.all).toBeTruthy()
  expect(codexCap('codex-00000000-nope').src).toBe('unknown')
})

test('0.63.17 複驗 D：commands 是佇列，短時間連傳三則三則都在；收過的拿掉；狀態看最新那則', async () => {
  const { enqueueCommand, commandState } = await import('./server')
  const d = join(homedir(), '.claude', 'pixel-office', 'commands'), id = 'spec-cmd-queue'
  try {
    const now = Date.now()
    for (const [n, t] of [['a', '一'], ['b', '二'], ['c', '三']]) enqueueCommand(id, { nonce: n, text: t, at: now }, now)
    let c = JSON.parse(readFileSync(join(d, `${id}.json`), 'utf8'))
    expect(c.items.map((i: any) => i.text)).toEqual(['一', '二', '三'])
    expect(c.nonce).toBe('c') // 舊外掛只看最上層：最新那則
    wf2(join(d, `${id}.done.json`), JSON.stringify({ nonce: 'b', nonces: ['a', 'b'] }))
    enqueueCommand(id, { nonce: 'd', text: '四', at: now }, now)
    c = JSON.parse(readFileSync(join(d, `${id}.json`), 'utf8'))
    expect(c.items.map((i: any) => i.nonce)).toEqual(['c', 'd'])
    expect(commandState(id, now)?.state).toBe('pending')
    wf2(join(d, `${id}.done.json`), JSON.stringify({ nonce: 'd', nonces: ['c', 'd'] }))
    expect(commandState(id, now)?.state).toBe('delivered')
  } finally { for (const x of ['.json', '.done.json']) rmSync(join(d, `${id}${x}`), { force: true }) }
})

test('0.63.19 複驗第 11 項＋前端回報：同一位串行、turn_context 讀設定（兩種格式）、/status 只讀這次那段、示意先回', async () => {
  const { withPane, permOfContext, parseCodexStatus } = await import('./hr')
  const order: string[] = []
  const slow = (tag: string) => () => new Promise<string>(r => setTimeout(() => { order.push(tag); r(tag) }, tag === 'a' ? 30 : 1))
  await Promise.all([withPane('p1', slow('a')), withPane('p1', slow('b'))])
  expect(order).toEqual(['a', 'b']) // 第二個等第一個做完
  expect(permOfContext({ active_permission_profile: { id: ':workspace' }, approvals_reviewer: 'auto_review' })).toBe('auto')
  expect(permOfContext({ active_permission_profile: { id: ':workspace' }, approvals_reviewer: 'user' })).toBe('default')
  expect(permOfContext({ sandbox_policy: { type: 'read-only' }, approvals_reviewer: 'user' })).toBe('read-only')
  expect(permOfContext({ sandbox_policy: { type: 'workspace-write' }, approvals_reviewer: 'auto_review' })).toBe('auto')
  expect(permOfContext({ sandbox_policy: { type: 'danger-full-access' } })).toBe('other')
  expect(parseCodexStatus('Model: GPT-6.1 Terra (reasoning max, x)\nPermissions: Read Only (Ask for approval)')).toEqual({ model: 'GPT-6.1 Terra', effort: 'max', perm: 'read-only' })
  const src = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')
  expect(src.indexOf("示意的人不在真名冊")).toBeLessThan(src.indexOf("const who = online(id)"))
})

test('0.63.20 複驗 C、4：給 Claude 的等收過才記聊天室、過期記「沒送到」；有 id 找不到不退回同名', async () => {
  const { drainChatOutbox } = await import('./server')
  const port = '8792', prev = process.env.PO_PORT
  process.env.PO_PORT = port
  const base = join(homedir(), '.claude', 'pixel-office'), box = join(base, 'chat', 'outbox'), chat = join(base, 'chat', port), cmd = join(base, 'commands')
  const f1 = `${Date.now()}-specack1.json`, f2 = `${Date.now() - 11 * 60e3}-specack2.json`, f3 = `${Date.now()}-specack3.json`
  try {
    require('node:fs').mkdirSync(box, { recursive: true }); require('node:fs').mkdirSync(cmd, { recursive: true })
    const list = [{ id: 'codex-a', plate: '小甲' }, { id: 'c-boss', plate: '主管', agent: '主管A' }]
    const map = new Map([['codex-a', 't3.1'], ['c-boss', 't3.0']])
    wf2(join(box, f1), JSON.stringify({ at: Date.now(), from: { id: 'codex-a' }, to: { id: 'c-boss' }, text: '等收', ack: { kind: 'claude', id: 'spec-ack-boss', nonce: 'n1' } }))
    wf2(join(box, f2), JSON.stringify({ at: Date.now() - 11 * 60e3, from: { id: 'codex-a' }, to: { id: 'c-boss' }, text: '過期', ack: { kind: 'claude', id: 'spec-ack-boss', nonce: 'n2' } }))
    wf2(join(box, f3), JSON.stringify({ at: Date.now(), from: { id: 'codex-gone', name: '主管A' }, to: { id: 'c-boss' }, text: '寄件人不在了' }))
    drainChatOutbox(list, map)
    const read = () => { try { return require('node:fs').readdirSync(join(chat, 't3')).map((n: string) => JSON.parse(readFileSync(join(chat, 't3', n), 'utf8'))) } catch { return [] } }
    expect(read().map((e: any) => e.text).sort()).toEqual(['寄件人不在了', '等收\n（送出中…）', '過期\n（沒送到）'])
    expect(read().find((e: any) => e.text === '寄件人不在了').from).toEqual({ name: '主管A' }) // 有 id 找不到：只顯示它帶的名字，不綁到同名的那位（沒有 id）
    // 0.63.22 最後複驗第 3 項：等收的期間換了桌，還是記在第一次看到時的桌；收過只改同一則的狀態
    const moved = new Map([['codex-a', 't9.1'], ['c-boss', 't9.0']])
    drainChatOutbox(list, moved)
    wf2(join(cmd, 'spec-ack-boss.done.json'), JSON.stringify({ nonce: 'n1', nonces: ['n1'] }))
    drainChatOutbox(list, moved)
    expect(read().map((e: any) => e.text).sort()).toEqual(['寄件人不在了', '等收', '過期\n（沒送到）'])
    expect(require('node:fs').existsSync(join(chat, 't9'))).toBe(false)
  } finally {
    if (prev === undefined) delete process.env.PO_PORT; else process.env.PO_PORT = prev
    for (const f of [f1, f2, f3]) rmSync(join(box, f), { force: true })
    rmSync(chat, { recursive: true, force: true }); rmSync(join(base, 'chat', `outbox-seen-${port}.json`), { force: true }); rmSync(join(cmd, 'spec-ack-boss.done.json'), { force: true })
  }
})

test('0.63.22 最後複驗第 1、2 項：佇列滿了回報不丟、鎖被佔著回忙、舊鎖清掉；ctl 每欄各記時間', async () => {
  const { enqueueCommand, COMMAND_QUEUE_MAX } = await import('./server')
  const { ctlSet, ctlGet } = await import('./hr')
  const d = join(homedir(), '.claude', 'pixel-office', 'commands'), id = 'spec-cmd-full'
  try {
    const now = Date.now()
    for (let i = 0; i < COMMAND_QUEUE_MAX; i++) expect(enqueueCommand(id, { nonce: `n${i}`, text: `${i}`, at: now }, now)).toBeUndefined()
    expect(enqueueCommand(id, { nonce: 'over', text: 'x', at: now }, now)).toContain('沒收')
    expect(JSON.parse(readFileSync(join(d, `${id}.json`), 'utf8')).items.length).toBe(COMMAND_QUEUE_MAX) // 沒丟舊的
    rmSync(join(d, `${id}.json`), { force: true })
    md2(join(d, `${id}.lock`)) // 別人正拿著鎖（時間設在未來：機器很忙時等候超過 5 秒也不會被當成留下來的舊鎖）
    require('node:fs').utimesSync(join(d, `${id}.lock`), new Date(now + 60e3), new Date(now + 60e3))
    expect(enqueueCommand(id, { nonce: 'a', text: 'a', at: now }, now)).toContain('正忙')
    require('node:fs').utimesSync(join(d, `${id}.lock`), new Date(now - 10e3), new Date(now - 10e3)) // 留下來的舊鎖
    expect(enqueueCommand(id, { nonce: 'b', text: 'b', at: now }, now)).toBeUndefined()
  } finally { for (const x of ['.json', '.done.json']) rmSync(join(d, `${id}${x}`), { force: true }); rmSync(join(d, `${id}.lock`), { recursive: true, force: true }) }
  const cid = 'spec-ctl-fields'
  try {
    ctlSet(cid, { model: 'old-model', effort: 'low' })
    const a = ctlGet(cid)
    await Bun.sleep(5)
    ctlSet(cid, { perm: 'auto' })
    const b = ctlGet(cid)
    expect(b.modelAt).toBe(a.modelAt) // 只換權限，模型的時間不動
    expect(b.permAt! > a.modelAt!).toBe(true)
    expect(b.model).toBe('old-model')
  } finally { rmSync(join(homedir(), '.claude', 'pixel-office', 'hr', `${cid}.ctl.json`), { force: true }) }
}, 20000) // 「鎖被佔著」那段會等 2 秒

test('0.63.22 最後複驗第 3 項追加：第一次只寫成一桌，換桌後重試還是補原本那桌', async () => {
  const { drainChatOutbox } = await import('./server')
  const port = '8791', prev = process.env.PO_PORT
  process.env.PO_PORT = port
  const base = join(homedir(), '.claude', 'pixel-office'), box = join(base, 'chat', 'outbox'), chat = join(base, 'chat', port), f = `${Date.now()}-specfix1.json`
  const fs = require('node:fs')
  try {
    fs.mkdirSync(box, { recursive: true }); fs.mkdirSync(chat, { recursive: true })
    wf2(join(chat, 't5'), 'not a dir') // t5 寫不進去
    wf2(join(box, f), JSON.stringify({ at: Date.now(), from: { id: 'codex-a' }, to: { id: 'c-boss' }, text: '固定桌' }))
    const list = [{ id: 'codex-a', plate: '小甲' }, { id: 'c-boss', plate: '主管' }]
    drainChatOutbox(list, new Map([['codex-a', 't3.1'], ['c-boss', 't5.0']]))
    expect(fs.existsSync(join(chat, 't3', f))).toBe(true)
    rmSync(join(chat, 't5'), { force: true })
    drainChatOutbox(list, new Map([['codex-a', 't8.1'], ['c-boss', 't9.0']])) // 換桌了
    expect(fs.existsSync(join(chat, 't5', f))).toBe(true)
    expect(fs.existsSync(join(chat, 't8'))).toBe(false)
    expect(fs.existsSync(join(chat, 't9'))).toBe(false)
  } finally {
    if (prev === undefined) delete process.env.PO_PORT; else process.env.PO_PORT = prev
    rmSync(join(box, f), { force: true }); rmSync(chat, { recursive: true, force: true }); rmSync(join(base, 'chat', `outbox-seen-${port}.json`), { force: true })
  }
})

test('0.63.24／0.63.26 關掉 App 分頁就解雇：同一個 App 還有人在線、自己程序結束、連續取樣累積 10 分鐘才解雇；App 整個不見／/clear／回來／睡眠空檔都不算', async () => {
  const { tickAppTabs, APP_TAB_GONE_MS } = await import('./apptabs')
  const file = join(mkt2(join(require('node:os').tmpdir(), 'po-tabs-')), 'tabs.json')
  const alive = new Set([100, 1, 2, 3, 200, 9])
  const starts: Record<number, string> = { 100: 'host-A', 200: 'host-B' }
  const tab: Record<string, { pid: number; host: number; hostStart: string }> = { a: { pid: 1, host: 100, hostStart: 'host-A' }, b: { pid: 2, host: 100, hostStart: 'host-A' }, c: { pid: 3, host: 100, hostStart: 'host-A' }, x: { pid: 9, host: 200, hostStart: 'host-B' } }
  const removed: [string, any][] = []
  const D = { file, tabOf: (id: string) => tab[id], alive: (p: number) => alive.has(p), startOf: (p: number) => starts[p], remove: (id: string, t: any) => removed.push([id, t]) }
  const P = (id: string, extra: any = {}) => ({ id, plate: id.toUpperCase(), ...extra })
  let now = 1_000_000
  // 照伺服器的節奏：每分鐘取樣一次
  const run = (online: any[], ms: number) => { for (let t = 0; t < ms; t += 60e3) tickAppTabs(online, D, now += 60e3) }
  tickAppTabs([P('a', { seat: 't3.0', role: 'manager' }), P('b'), P('c'), P('x')], D, now)
  alive.delete(1); alive.delete(3) // a、c 關掉分頁，b 還在線
  run([P('b'), P('x')], APP_TAB_GONE_MS - 60e3)
  expect(removed).toEqual([]) // 還不到 10 分鐘
  run([P('b'), P('x')], 120e3)
  expect(removed.map(r => r[0]).sort()).toEqual(['a', 'c'])
  expect(removed.find(r => r[0] === 'a')![1]).toMatchObject({ table: 3, boss: true, plate: 'A' })
  removed.length = 0
  // /clear：程序還在、換了 session id → 不算
  tickAppTabs([P('b'), P('x')], D, now += 60e3)
  run([P('x')], APP_TAB_GONE_MS + 120e3) // b 不見了但程序 2 還活著
  expect(removed).toEqual([])
  // App 整個重開：父程序不在了 → 不算
  alive.delete(2); alive.delete(100)
  run([P('x')], APP_TAB_GONE_MS + 120e3)
  expect(removed).toEqual([])
  // 另一個 App：同時全部不見（x 是 host-B 唯一的一位）→ 不算
  alive.delete(9)
  run([], APP_TAB_GONE_MS + 120e3)
  expect(removed).toEqual([])
})

test('0.63.26 睡眠／停機空檔不算：取樣隔超過 3 分鐘就從零重新累積', async () => {
  const { tickAppTabs, APP_TAB_GONE_MS } = await import('./apptabs')
  const file = join(mkt2(join(require('node:os').tmpdir(), 'po-tabs-')), 'tabs.json')
  const alive = new Set([100, 2]), removed: string[] = []
  const tab: Record<string, any> = { a: { pid: 1, host: 100, hostStart: 'H' }, b: { pid: 2, host: 100, hostStart: 'H' } }
  const D = { file, tabOf: (id: string) => tab[id], alive: (p: number) => alive.has(p), startOf: () => 'H', remove: (id: string) => removed.push(id) }
  let now = 9_000_000
  tickAppTabs([{ id: 'a', plate: 'A' }, { id: 'b', plate: 'B' }], D, now)
  for (let i = 0; i < 5; i++) tickAppTabs([{ id: 'b', plate: 'B' }], D, now += 60e3) // a 不見 5 分鐘
  tickAppTabs([{ id: 'b', plate: 'B' }], D, now += 3600e3) // 電腦睡了一小時：醒來第一輪不能解雇
  expect(removed).toEqual([])
  for (let i = 0; i < 9; i++) tickAppTabs([{ id: 'b', plate: 'B' }], D, now += 60e3)
  expect(removed).toEqual([]) // 從零重新算，9 分鐘還不夠
  tickAppTabs([{ id: 'b', plate: 'B' }], D, now += 60e3)
  expect(removed).toEqual(['a'])
  void APP_TAB_GONE_MS
})

test('0.63.24 回來了就不算：10 分鐘內回到名冊，計時歸零', async () => {
  const { tickAppTabs, APP_TAB_GONE_MS } = await import('./apptabs')
  const file = join(mkt2(join(require('node:os').tmpdir(), 'po-tabs-')), 'tabs.json')
  const alive = new Set([100, 2]), removed: string[] = []
  const tab: Record<string, any> = { a: { pid: 1, host: 100, hostStart: 'H' }, b: { pid: 2, host: 100, hostStart: 'H' } }
  const D = { file, tabOf: (id: string) => tab[id], alive: (p: number) => alive.has(p), startOf: () => 'H', remove: (id: string) => removed.push(id) }
  let now = 5_000_000
  tickAppTabs([{ id: 'a', plate: 'A' }, { id: 'b', plate: 'B' }], D, now)
  for (let t = 0; t < APP_TAB_GONE_MS - 60e3; t += 60e3) tickAppTabs([{ id: 'b', plate: 'B' }], D, now += 60e3)
  alive.add(1); tickAppTabs([{ id: 'a', plate: 'A' }, { id: 'b', plate: 'B' }], D, now += 60e3) // 回來了
  alive.delete(1)
  for (let t = 0; t < 180e3; t += 60e3) tickAppTabs([{ id: 'b', plate: 'B' }], D, now += 60e3)
  expect(removed).toEqual([]) // 重新算，還沒滿 10 分鐘
})

test('0.63.27 快驗第 2 項：取樣正好隔 3 分鐘也從零算；伺服器啟動把累積歸零', async () => {
  const { tickAppTabs, resetAppTabs, loadTabs, APP_TAB_MAX_GAP_MS } = await import('./apptabs')
  const file = join(mkt2(join(require('node:os').tmpdir(), 'po-tabs-')), 'tabs.json')
  const alive = new Set([100, 2])
  const tab: Record<string, any> = { a: { pid: 1, host: 100, hostStart: 'H' }, b: { pid: 2, host: 100, hostStart: 'H' } }
  const D = { file, tabOf: (id: string) => tab[id], alive: (p: number) => alive.has(p), startOf: () => 'H', remove: () => {} }
  let now = 7_000_000
  tickAppTabs([{ id: 'a', plate: 'A' }, { id: 'b', plate: 'B' }], D, now)
  tickAppTabs([{ id: 'b', plate: 'B' }], D, now += 60e3)
  tickAppTabs([{ id: 'b', plate: 'B' }], D, now += 60e3)
  expect(loadTabs(file).a.goneMs).toBe(60e3)
  tickAppTabs([{ id: 'b', plate: 'B' }], D, now += APP_TAB_MAX_GAP_MS)
  expect(loadTabs(file).a.goneMs).toBe(0)
  tickAppTabs([{ id: 'b', plate: 'B' }], D, now += 60e3)
  resetAppTabs(file)
  const a = loadTabs(file).a
  expect(a.gone).toBeUndefined(); expect(a.goneMs).toBeUndefined(); expect(a.checked).toBeUndefined()
})

test('0.63.28 /status 折行與額外資料夾：Workspace [資料夾] (Approve for me) 跨行也認得', async () => {
  const { parseCodexStatus } = await import('./hr')
  const real = '  Model:               GPT-6-Luna (reasoning medium, summaries auto)\n  Directory:           ~/Documents/projects/我的知\n                       識庫\n  Permissions:         Workspace [/Users/me/.claude/pixel-office/\n                       checkpoints] (Approve for me)\n  Agents.md:           AGENTS.md'
  expect(parseCodexStatus(real)).toEqual({ model: 'GPT-6-Luna', effort: 'medium', perm: 'auto' })
  expect(parseCodexStatus('Permissions:         Workspace [/a, /b] (Ask for approval)').perm).toBe('default')
})

test('0.63.28 在 App 裡的 Codex 不會被「關分頁自動解雇」誤殺（那條只管 Claude 的 App 分頁）', async () => {
  const { tickAppTabs, APP_TAB_GONE_MS } = await import('./apptabs')
  const file = join(mkt2(join(require('node:os').tmpdir(), 'po-tabs-')), 'tabs.json')
  let asked = 0
  const removed: string[] = []
  const D = { file, tabOf: () => { asked++; return { pid: 1, host: 100, hostStart: 'H' } }, alive: (p: number) => p === 100, startOf: () => 'H', remove: (id: string) => removed.push(id) }
  let now = 1_000_000
  tickAppTabs([{ id: 'codex-x', plate: 'cx', kind: 'codex' }, { id: 'c1', plate: 'C' }], D, now)
  for (let t = 0; t < APP_TAB_GONE_MS + 120e3; t += 60e3) tickAppTabs([{ id: 'c1', plate: 'C' }], D, now += 60e3)
  expect(removed).toEqual([])
  expect(asked).toBeGreaterThan(0) // 只問了 Claude 那位
})

test('0.63.29 審查交接：輸入框整欄比對、帶框線的 /status、保留座位', async () => {
  const { composerText, parseCodexStatus } = await import('./hr')
  const { assign, emptyStore } = await import('../hooks/officeV2')
  // 第 10 項：截短的不算
  expect(composerText('x\n› /permissions :workspace --reviewer=user --approval-policy=on-req\n  footer')).toBe('/permissions :workspace --reviewer=user --approval-policy=on-req')
  expect(composerText('› /status   │')).toBe('/status')
  // 第 11 項：左右框線
  expect(parseCodexStatus('│ Model:        GPT-6.2-Sol (reasoning high, summaries auto) │\n│ Permissions:  Workspace (Approve for me)                  │').perm).toBe('auto')
  // 第 4 項：保留的座位，本人不在時別人坐不到，本人回來坐得到
  const S: any = emptyStore()
  S.reserved = { 'codex-a': 'o1' }; S.pins = { 'codex-a': 'o1' }
  const others = [{ id: 'x', name: 'x', role: 'staff' }] as any
  expect(assign(S, others).map.get('x')).not.toBe('o1')
  expect(assign(S, [...others, { id: 'codex-a', name: 'a', role: 'staff' }] as any).map.get('codex-a')).toBe('o1')
})

test('0.63.30 複驗第 4 項：保留的座位，移位 API 不能搬進去、自動桌不會因為本人不在被收掉', async () => {
  const { moveSeat, emptyStore } = await import('../hooks/officeV2')
  const S: any = emptyStore()
  S.reserved = { 'codex-a': 'o1' }
  S.seats = { x: { key: 'o2', seen: Date.now() } }
  expect(moveSeat(S, 'x', 'o1', new Set(['x'])).ok).toBe(false)
  expect(moveSeat(S, 'x', 'o3', new Set(['x'])).ok).toBe(true)
  const src = readFileSync(join(import.meta.dir, '..', 'hooks', 'officeV2.ts'), 'utf8')
  expect(src).toContain('...Object.values(S.reserved ?? {})')
})

test('0.63.33 回收只關這次建立的 pane，列舉成功而且清單裡沒有它才算；逾時、標記不對、不在這次的 session 都不算', async () => {
  const { reapOwn } = await import('./hr')
  const calls: string[] = []
  // owner：pane 所屬 session；after：kill 之後查 pane 的結果
  const fake = (o: { marker?: string; owner?: string; after?: 'gone' | 'still' | 'timeout' }) => (...a: string[]) => {
    calls.push(a[0])
    if (a[0] === 'show-options') return { exitCode: 0, stdout: Buffer.from(o.marker ?? 'm1') }
    if (a[0] === 'display' && a[4] === '#{session_id}') return { exitCode: 0, stdout: Buffer.from(o.owner ?? '$5') }
    if (a[0] === 'list-panes') return o.after === 'timeout' ? { exitCode: null, stdout: Buffer.from('') } : o.after === 'still' ? { exitCode: 0, stdout: Buffer.from('%1\n%9') } : { exitCode: 0, stdout: Buffer.from('%1\n%2') }
    return { exitCode: 0, stdout: Buffer.from('') }
  }
  expect(reapOwn('$5', '%9', 'm1', fake({}))).toBe(true)
  expect(calls).toContain('kill-pane'); expect(calls).not.toContain('kill-session') // 只關自己那格，同 session 別的 pane 不動
  calls.length = 0; expect(reapOwn('$5', '%9', 'm1', fake({ owner: '$6' }))).toBe(false); expect(calls).not.toContain('kill-pane') // pane 不在這次的 session
  calls.length = 0; expect(reapOwn('$5', '%9', 'm1', fake({ marker: 'x' }))).toBe(false); expect(calls).not.toContain('kill-pane') // 標記不對
  expect(reapOwn('$5', '%9', 'm1', fake({ after: 'timeout' }))).toBe(false) // 查詢逾時：不算收掉
  expect(reapOwn('$5', '%9', 'm1', fake({ after: 'still' }))).toBe(false) // 關了還在
  calls.length = 0; expect(reapOwn('bad', '%9', 'm1', fake({}))).toBe(false); expect(calls).toEqual([])
})

// ---------- 照片審查（codex-review-2026-11-25-photo）補的測試 ----------
const TINY_JPG = '/9j/4AAQSkZJRgABAQAASABIAAD/4QBARXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAAqACAAQAAAABAAAAGKADAAQAAAABAAAADwAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/+IB2ElDQ19QUk9GSUxFAAEBAAAByAAAAAAEMAAAbW50clJHQiBYWVogB+AAAQABAAAAAAAAYWNzcAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAPbWAAEAAAAA0y0AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJZGVzYwAAAPAAAAAkclhZWgAAARQAAAAUZ1hZWgAAASgAAAAUYlhZWgAAATwAAAAUd3RwdAAAAVAAAAAUclRSQwAAAWQAAAAoZ1RSQwAAAWQAAAAoYlRSQwAAAWQAAAAoY3BydAAAAYwAAAA8bWx1YwAAAAAAAAABAAAADGVuVVMAAAAIAAAAHABzAFIARwBCWFlaIAAAAAAAAG+iAAA49QAAA5BYWVogAAAAAAAAYpkAALeFAAAY2lhZWiAAAAAAAAAkoAAAD4QAALbPWFlaIAAAAAAAAPbWAAEAAAAA0y1wYXJhAAAAAAAEAAAAAmZmAADypwAADVkAABPQAAAKWwAAAAAAAAAAbWx1YwAAAAAAAAABAAAADGVuVVMAAAAgAAAAHABHAG8AbwBnAGwAZQAgAEkAbgBjAC4AIAAyADAAMQA2/8AAEQgADwAYAwEiAAIRAQMRAf/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMRBAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMABgYGBgYGCgYGCg4KCgoOEg4ODg4SFxISEhISFxwXFxcXFxccHBwcHBwcHCIiIiIiIicnJycnLCwsLCwsLCwsLP/bAEMBBwcHCwoLEwoKEy4fGh8uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLi4uLv/dAAQAAv/aAAwDAQACEQMRAD8A+nbzULLT0WS9mWFWJALHAyBn+QqrHr2jTMFju4mLMFA3d2IAH4kj861HjSQYkUMPcZqP7Nb/APPNOMfwjt0oAjtb20vlZ7SVZVRtpKnIBq1UccUUWfKRU3HJ2gDJ9TipKAP/2Q=='
test('photo review ⑤: table photo to mixed recipients — one saved file, per-person tool, sent / failed / unsure reported apart, one chat line', async () => {
  const people = [
    { id: 'cl', plate: 'Claude 甲', agent: 'cla', seat: 't3.0' },
    { id: 'codex-0000aaaa-1111', plate: 'Codex 乙', agent: 'cxb', kind: 'codex', seat: 't3.1' },
    { id: 'codex-0000bbbb-2222', plate: 'Codex 丙', kind: 'codex', seat: 't3.2' },
    { id: 'agy-x1', plate: 'agy 丁', kind: 'agy', seat: 't3.3' },
  ]
  const msgs: Record<string, string> = {}, logs: any[] = []
  let saves = 0
  const dep = {
    roster: () => ({ tables: [{ id: 3, name: '測試桌', size: 4 }], people } as any),
    deliver: (id: string, text: string) => { msgs[id] = text; return id === 'codex-0000bbbb-2222' ? { state: 'unsure' as const, text: 'Codex 沒及時回應' } : id === 'agy-x1' ? { state: 'failed' as const, text: '收件夾寫不進去' } : { state: 'sent' as const } },
    save: async (_img: Uint8Array, _h: boolean, forCodex: boolean, base: string) => { saves++; expect(forCodex).toBe(true); return { path: `${base}.jpg` } },
    base: () => '/u/p1',
    log: (t: number, e: any) => { logs.push([t, e]); return true },
  }
  const jpg = new Uint8Array(Buffer.from(TINY_JPG, 'base64'))
  const r = await sayToTable(3, '看這張', undefined, 0, jpg, dep as any)
  expect(saves).toBe(1) // 只存一份
  expect(msgs['cl']).toContain('/u/p1.jpg，請用 Read')
  expect(msgs['codex-0000aaaa-1111']).toContain('/u/p1.jpg，請用 view_image')
  expect(msgs['cl']).not.toContain('同桌 4 位') // 照片訊息不附全員名單
  expect(r.ok).toBe(true)
  expect(r.sent.sort()).toEqual(['cl', 'codex-0000aaaa-1111'])
  expect(r.unsure?.map(x => x.id)).toEqual(['codex-0000bbbb-2222'])
  expect(r.failed?.map(x => x.id)).toEqual(['agy-x1'])
  expect(r.text).toContain('不確定有沒有收到')
  expect(r.text).toContain('沒送出：agy 丁（收件夾寫不進去）')
  expect(logs.length).toBe(1)
  expect(logs[0][1].text).toBe('📷 傳了一張照片：看這張')
  // 長度照實際訊息在存檔前驗：桌名超長時不存檔就回錯
  saves = 0
  const long = await sayToTable(3, 'x'.repeat(2999), undefined, 0, jpg, { ...dep, roster: () => ({ tables: [{ id: 3, name: 'n', teamName: '長'.repeat(1200), size: 4 }], people }) } as any)
  expect(long.ok).toBe(false)
  expect(saves).toBe(0)
})

test('photo review ④: request bodies are capped while reading; base64 must be clean', async () => {
  const big = new Request('http://x/upload', { method: 'POST', body: 'a'.repeat(2000) })
  expect(await readCapped(big, 1000)).toBeUndefined()
  const lied = new Request('http://x/upload', { method: 'POST', body: 'a'.repeat(10), headers: { 'content-length': '99999' } })
  expect(await readCapped(lied, 1000)).toBeUndefined()
  expect(await readCapped(new Request('http://x/upload', { method: 'POST', body: '{"a":1}' }), 1000)).toBe('{"a":1}')
  expect(b64Photo('/9j/')).toBeDefined()
  expect(b64Photo('/9j/ <x>')).toBeUndefined()
  expect(b64Photo('abc')).toBeUndefined()
  expect(b64Photo(42)).toBeUndefined()
})

test('photo review ③: a real HEIC is converted once with sips (async), no half files left; a broken one is refused, never sent as-is', async () => {
  if (!existsSync('/usr/bin/sips')) return // 不是 Mac：跳過
  const dir = mkdtempSync(join(tmpdir(), 'po-photo-'))
  try {
    writeFileSync(join(dir, 'a.jpg'), Buffer.from(TINY_JPG, 'base64'))
    expect(Bun.spawnSync(['/usr/bin/sips', '-s', 'format', 'heic', join(dir, 'a.jpg'), '--out', join(dir, 'a.heic')]).exitCode).toBe(0)
    const heic = new Uint8Array(readFileSync(join(dir, 'a.heic')))
    expect(isHeic(heic)).toBe(true)
    const r = await savePhoto(heic, true, true, join(dir, 'p1'))
    expect(r.path).toBe(join(dir, 'p1.jpg'))
    const out = readFileSync(r.path!)
    expect([out[0], out[1], out[2]]).toEqual([0xff, 0xd8, 0xff])
    expect(readdirSync(dir).sort()).toEqual(['a.heic', 'a.jpg', 'p1.jpg']) // 沒留下 .orig、.part
    const broken = new Uint8Array(heic.length); broken.set(heic.subarray(0, 40)) // 檔頭對、內容壞
    const b = await savePhoto(broken, true, true, join(dir, 'p2'))
    expect(b.path).toBeUndefined()
    expect(b.err).toBeTruthy()
    expect(readdirSync(dir).some(n => n.startsWith('p2'))).toBe(false) // 失敗不留檔、不回退原檔
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------- 照片複驗（複驗 3be4130）補的測試 ----------
test('photo re-review ①: someone moved to another table while the photo was being saved — not sent, marked 已離桌; all-unsure chat line says so', async () => {
  const people = [
    { id: 'a', plate: '甲', seat: 't1.0' },
    { id: 'b', plate: '乙', seat: 't1.1' },
  ]
  const got: string[] = [], logs: any[] = []
  const dep = {
    roster: () => ({ tables: [{ id: 1, name: '一號桌', size: 2 }, { id: 2, name: '二號桌', size: 2 }], people: people.map(p => ({ ...p })) } as any),
    deliver: async (id: string) => { got.push(id); return { state: 'unsure' as const, text: '逾時' } },
    save: async (_i: Uint8Array, _h: boolean, _c: boolean, base: string) => { people[0].seat = 't2.0'; await Bun.sleep(5); return { path: `${base}.jpg` } }, // 存檔等候中，甲換到二號桌
    base: () => '/u/p', log: (t: number, e: any) => { logs.push(e); return true },
  }
  const r = await sayToTable(1, '看', undefined, 0, new Uint8Array(Buffer.from(TINY_JPG, 'base64')), dep as any)
  expect(got).toEqual(['b']) // 甲沒收到
  expect(r.failed).toEqual([{ id: 'a', why: '已離桌' }])
  expect(r.text).toContain('沒送出：甲（已離桌）')
  expect(logs[0].text).toBe('（不確定有沒有收到）📷 傳了一張照片：看')
  // 桌子在等候中被刪：全部標「桌子已經不在」
  const dep2 = { ...dep, roster: (() => { let n = 0; return () => ({ tables: n++ ? [] : [{ id: 1, name: '一號桌', size: 2 }], people: [{ id: 'b', plate: '乙', seat: 't1.1' }] } as any) })() }
  got.length = 0
  const r2 = await sayToTable(1, '看', undefined, 0, new Uint8Array(Buffer.from(TINY_JPG, 'base64')), dep2 as any)
  expect(got).toEqual([])
  expect(r2.ok).toBe(false)
  expect(r2.failed?.[0].why).toBe('桌子已經不在')
})

test('photo re-review ③: table delivery runs at most 4 at a time', async () => {
  let now = 0, peak = 0
  const r = await mapLimit([1, 2, 3, 4, 5, 6, 7, 8, 9], 4, async x => { now++; peak = Math.max(peak, now); await Bun.sleep(5); now--; return x * 2 })
  expect(r).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18])
  expect(peak).toBe(4)
})

test('photo re-review ⑤: the sips queue is bounded — beyond 2 running + 6 waiting, refused before writing anything', async () => {
  if (!existsSync('/usr/bin/sips')) return
  const dir = mkdtempSync(join(tmpdir(), 'po-q-'))
  try {
    writeFileSync(join(dir, 'a.jpg'), Buffer.from(TINY_JPG, 'base64'))
    Bun.spawnSync(['/usr/bin/sips', '-s', 'format', 'heic', join(dir, 'a.jpg'), '--out', join(dir, 'a.heic')])
    const heic = new Uint8Array(readFileSync(join(dir, 'a.heic')))
    const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => savePhoto(heic, true, true, join(dir, `q${i}`))))
    expect(rs.filter(r => r.path).length).toBe(8)
    expect(rs.filter(r => r.err === '照片處理排隊太多，等一下再送').length).toBe(2)
    expect(readdirSync(dir).filter(n => /\.(orig|part)\./.test(n))).toEqual([])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// ---------- 照片第三輪複驗（複驗 4113f3f） ----------
test('photo re-review 3 ①: the 5th person moves while waiting for a delivery slot — re-checked right before sending, not sent', async () => {
  const people = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, plate: `人${i}`, seat: `t1.${i}` }))
  const got: string[] = []
  const dep = {
    roster: () => ({ tables: [{ id: 1, name: '一號桌', size: 6 }, { id: 2, name: '二號桌', size: 6 }], people: people.map(p => ({ ...p })) } as any),
    deliver: async (id: string) => { got.push(id); if (id === 'p0') people[4].seat = 't2.0'; await Bun.sleep(10); return { state: 'sent' as const } }, // 前 4 位送的時候，第 5 位換到二號桌
    save: async (_i: Uint8Array, _h: boolean, _c: boolean, base: string) => ({ path: `${base}.jpg` }),
    base: () => '/u/p', log: () => true,
  }
  const r = await sayToTable(1, '看', undefined, 0, new Uint8Array(Buffer.from(TINY_JPG, 'base64')), dep as any)
  expect(got.sort()).toEqual(['p0', 'p1', 'p2', 'p3', 'p5'])
  expect(r.failed).toEqual([{ id: 'p4', why: '已離桌' }])
})

test('photo re-review 3 ②: one delivery throwing only fails that person; the others are still reported as sent', async () => {
  const people = [{ id: 'a', plate: '甲', seat: 't1.0' }, { id: 'b', plate: '乙', seat: 't1.1' }, { id: 'c', plate: '丙', seat: 't1.2' }]
  const logs: any[] = []
  const dep = {
    roster: () => ({ tables: [{ id: 1, name: '一號桌', size: 4 }], people } as any),
    deliver: async (id: string) => { if (id === 'b') throw new Error('磁碟滿了'); return { state: 'sent' as const } },
    save: async (_i: Uint8Array, _h: boolean, _c: boolean, base: string) => ({ path: `${base}.jpg` }),
    base: () => '/u/p', log: (_t: number, e: any) => { logs.push(e); return true },
  }
  const r = await sayToTable(1, '大家好', undefined, 0, undefined, dep as any)
  expect(r.ok).toBe(true)
  expect(r.sent.sort()).toEqual(['a', 'c'])
  expect(r.failed?.[0].id).toBe('b')
  expect(r.failed?.[0].why).toContain('磁碟滿了')
  expect(r.text).toContain('沒送出：乙（送的時候出錯：磁碟滿了）')
  expect(logs.length).toBe(1)
})

test('art A #14: a name that is really a command (starts with ! or /) is shown as the short code', () => {
  expect(shownName({ name: '!cat ~/.cl', id: 'abcd1234-ef' })).toBe('s-abcd')
  expect(shownName({ name: '/compact', id: 'codex-9f8e7d' })).toBe('s-9f8e')
  expect(shownName({ name: '文書助理', id: 'x1' })).toBe('文書助理')
})

// ---------- 0.63.38 Codex 生圖幫手：關閉與身分（審查 codex-review-2026-11-25-art.md 第 4、6 項） ----------
import { helperDeps } from './server'
import { closeCodexHelper, fire as claudeFire, hireCodex, launchGen, launchOwner, launchState } from './hr'

test('the real helper wiring closes Codex helpers through closeCodexHelper (not Claude fire) and binds by launch identity', () => {
  expect(helperDeps.closeCodex).toBe(closeCodexHelper)
  expect(helperDeps.launchOwner).toBe(launchOwner)
  expect(helperDeps.launchState).toBe(launchState)
  expect(helperDeps.hireCodex).toBe(hireCodex)
  expect(helperDeps.fire).toBe(claudeFire)
  expect(helperDeps.closeCodex).not.toBe(helperDeps.fire as any)
})

test('launchState / launchOwner / closeCodexHelper with a fake tmux: only the recorded pane, only when identity matches', () => {
  const L = { tmux: '$5', pane: '%9', marker: 'm1' }
  const calls: string[] = []
  const fake = (o: { panes?: string; lsFail?: boolean; lsErr?: string; marker?: string; showErr?: string; owner?: string; gone?: boolean }) => (...a: string[]) => {
    calls.push(a[0])
    const ok = (s: string) => ({ exitCode: 0, stdout: Buffer.from(s) })
    const err = (e: string) => ({ exitCode: 1, stdout: Buffer.from(''), stderr: Buffer.from(e) })
    if (a[0] === 'list-panes') {
      if (o.lsFail) return { exitCode: null, stdout: Buffer.from(''), stderr: Buffer.from('') }
      if (o.lsErr) return err(o.lsErr)
      const rows = calls.includes('kill-pane') && o.gone !== false ? '%1 $5 11\n' : (o.panes ?? '%9 $5 4242\n%1 $5 11\n')
      return ok(a.includes('#{pane_id} #{session_id} #{pane_pid}') ? rows : rows.split('\n').map(l => l.split(' ')[0]).join('\n'))
    }
    if (a[0] === 'show-options') return o.showErr ? err(o.showErr) : ok(`${o.marker ?? 'm1'}\n`)
    if (a[0] === 'display') return ok(`${o.owner ?? '$5'}\n`)
    return ok('')
  }
  expect(launchState(L, fake({}))).toBe('alive')
  expect(launchState(L, fake({ panes: '%1 $5 11\n' }))).toBe('gone')
  expect(launchState(L, fake({ panes: '%9 $6 4242\n' }))).toBe('gone') // pane 換到別的 session
  // 0.63.39：確定不存在才算 gone；連不上等暫時錯誤是 unknown
  expect(launchState(L, fake({ lsErr: 'no server running on /tmp/tmux-501/default' }))).toBe('gone')
  expect(launchState(L, fake({ lsErr: 'error connecting to /tmp/tmux-501/default (Resource temporarily unavailable)' }))).toBe('unknown')
  expect(launchState(L, fake({ showErr: "can't find session: $5" }))).toBe('gone')
  expect(launchState(L, fake({ showErr: 'error connecting to /tmp/tmux-501/default' }))).toBe('unknown')
  expect(launchState(L, fake({ marker: 'other' }))).toBe('gone')
  expect(launchState(L, fake({ lsFail: true }))).toBe('unknown')
  expect(launchState({ tmux: 'po-x', pane: '%9', marker: 'm1' }, fake({}))).toBe('gone') // 身分格式不對
  // owner：程序對到的 pane 要是 L.pane
  expect(launchOwner('codex-a', L, () => ({ pane: '%9' }), fake({}))).toBe('yes')
  expect(launchOwner('codex-a', L, () => ({ pane: '%3' }), fake({}))).toBe('no')
  expect(launchOwner('codex-a', L, () => undefined, fake({}))).toBe('no')
  expect(launchOwner('codex-a', L, () => ({ pane: '%9' }), fake({ lsFail: true }))).toBe('unknown')
  // 關：身分不對、查不到都不關；對了只 kill-pane 這一格，不 kill-session、不搬對話
  calls.length = 0
  expect(closeCodexHelper('codex-a', L, () => 'no', fake({})).ok).toBe(false)
  expect(closeCodexHelper('codex-a', L, () => 'unknown', fake({})).ok).toBe(false)
  expect(calls).toEqual([])
  expect(closeCodexHelper('codex-a', L, () => 'yes', fake({}))).toMatchObject({ ok: true, text: expect.stringContaining('對話紀錄保留') })
  expect(calls).toContain('kill-pane')
  expect(calls).not.toContain('kill-session')
  calls.length = 0
  expect(closeCodexHelper(undefined, L, () => 'no', fake({ marker: 'other' })).ok).toBe(false) // 不帶 id：仍要標記對
  expect(calls).not.toContain('kill-pane')
  // 0.63.39 不帶 id：格裡要證實還是招聘時那一支程序（pane_pid＋啟動時間）
  const G = { ...L, pid: 4242, start: 'Tue Nov 25 08:00:00 2026' }
  const startOf = (s?: string) => () => s
  calls.length = 0
  expect(closeCodexHelper(undefined, L, () => 'yes', fake({}), startOf(G.start)).ok).toBe(false) // 沒有世代紀錄
  expect(closeCodexHelper(undefined, { ...G, pid: 999 }, () => 'yes', fake({}), startOf(G.start)).ok).toBe(false) // 換了程序
  expect(closeCodexHelper(undefined, G, () => 'yes', fake({}), startOf('Tue Nov 25 09:00:00 2026')).ok).toBe(false) // pid 被重用
  expect(closeCodexHelper(undefined, G, () => 'yes', fake({}), startOf(undefined)).ok).toBe(false) // 查不到啟動時間
  expect(closeCodexHelper(undefined, G, () => 'yes', fake({ lsErr: 'error connecting' }), startOf(G.start)).ok).toBe(false)
  expect(calls).not.toContain('kill-pane')
  expect(launchGen(G, fake({}), startOf(G.start))).toBe('same')
  expect(closeCodexHelper(undefined, G, () => 'no', fake({}), startOf(G.start)).ok).toBe(true)
  expect(calls).toContain('kill-pane')
  calls.length = 0
  expect(closeCodexHelper('codex-a', L, () => 'yes', fake({ gone: false })).ok).toBe(false) // 關了還在：不算關掉
})

test('closeCodexHelper on real tmux closes only the recorded pane; a pane the user split off stays', async () => {
  // 獨立的 tmux 伺服器（共用 tmux-iso：-S 暫存 socket，關東西前驗證不是主伺服器）；跑完收掉、刪夾
  const { isoTmux } = await import('./tmux-iso')
  const iso = isoTmux()
  if (!iso) return
  const run = iso.run
  const name = `po-artspec-${crypto.randomUUID().slice(0, 6)}`
  const r = run('new-session', '-d', '-P', '-F', '#{session_id} #{pane_id}', '-s', name, 'sleep', '60')
  expect(r.exitCode).toBe(0)
  const [sid, pane] = r.stdout.toString().trim().split(/\s+/)
  try {
    run('set-option', '-t', sid, '@po_launch', 'mk')
    const other = run('split-window', '-d', '-P', '-F', '#{pane_id}', '-t', pane, 'sleep', '60').stdout.toString().trim()
    const ppid = Number(run('display', '-p', '-t', pane, '#{pane_pid}').stdout.toString().trim())
    const { pidStart } = await import('./hr')
    const L = { tmux: sid, pane, marker: 'mk', pid: ppid, start: pidStart(ppid) }
    expect(launchState(L, run)).toBe('alive')
    expect(launchGen(L, run)).toBe('same')
    expect(launchGen({ ...L, start: 'Thu Jan  1 00:00:00 1970' }, run)).toBe('changed')
    expect(closeCodexHelper(undefined, L, () => 'no', run).ok).toBe(true) // 不帶 id：世代對才收
    expect(launchState(L, run)).toBe('gone')
    expect(run('list-panes', '-a', '-F', '#{pane_id}').stdout.toString().split('\n')).toContain(other)
  } finally { iso.close() }
})

import { CXP_ORDER_MAX_KEEP_MS, CXP_ORDER_MIN_KEEP_MS, cxpOrderFate, planCxpOrders, sessionListCache, sessionState, tmuxSessionList } from './hr'
test('hire orders (orders/cxp-*.json): live for 24 hours without asking tmux; then alive=live, gone=drop, unknown=wait; dropped after 7 days even if alive', () => {
  const H = 3600e3
  let asked = 0
  const s = (v: 'alive' | 'gone' | 'unknown') => () => (asked++, v)
  expect([CXP_ORDER_MIN_KEEP_MS, CXP_ORDER_MAX_KEEP_MS]).toEqual([24 * H, 7 * 24 * H])
  expect(cxpOrderFate(16 * H, s('gone'))).toBe('live') // 卡在信任畫面一整晚：照留，tmux 重開的空檔也不掉
  expect(asked).toBe(0) // 24 小時內不問 tmux
  expect(cxpOrderFate(25 * H, s('alive'))).toBe('live')
  expect(cxpOrderFate(25 * H, s('gone'))).toBe('drop')
  expect(cxpOrderFate(25 * H, s('unknown'))).toBe('wait') // 查不到：不刪，下一輪再查
  expect(cxpOrderFate(7 * 24 * H + 1, s('alive'))).toBe('drop') // 同名的舊令不會一直留
})

test('tmux session list: one list-sessions for everyone; only an answering server (exit 0) is a list; cannot-connect (socket removed, no server), timeout, other errors or a spawn that throws = unknown', () => {
  const calls: string[][] = []
  const run = (code: number | null, out = '', err = '') => (...a: string[]) => (calls.push(a), { exitCode: code, stdout: Buffer.from(out), stderr: Buffer.from(err) })
  const ok = tmuxSessionList(run(0, 'po-cxp-11111111\nrc-main\n'))
  expect(calls[0]).toEqual(['list-sessions', '-F', '#{session_name}'])
  expect([sessionState(ok, 'po-cxp-11111111'), sessionState(ok, 'po-cxp-22222222'), sessionState(ok, 'po-cxp-1111111')]).toEqual(['alive', 'gone', 'gone']) // 名稱完全比對
  expect(sessionState(tmuxSessionList(run(1, '', 'no server running on /tmp/tmux-501/default')), 'po-cxp-11111111')).toBe('unknown')
  // BUG-1：socket 檔被 macOS 清掉、tmux 伺服器還活著
  expect(sessionState(tmuxSessionList(run(1, '', 'error connecting to /private/tmp/tmux-501/default (No such file or directory)')), 'po-cxp-11111111')).toBe('unknown')
  expect(sessionState(tmuxSessionList(run(0, '')), 'po-cxp-11111111')).toBe('gone') // 伺服器有回應、名單裡沒有：才是 gone
  expect(sessionState(tmuxSessionList(run(1, '', 'lost server')), 'po-cxp-11111111')).toBe('unknown')
  expect(sessionState(tmuxSessionList(run(null)), 'po-cxp-11111111')).toBe('unknown') // 逾時
  const boom = () => { throw Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' }) }
  expect(sessionState(tmuxSessionList(boom), 'po-cxp-11111111')).toBe('unknown') // spawn 拋錯：不傳出去
  // 快取的名單上沒有：不能當「不在」（可能是查完才重開的）
  const cached = { ok: true as const, names: new Set(['x']), fresh: false }
  expect([sessionState(cached, 'x'), sessionState(cached, 'po-cxp-11111111')]).toEqual(['alive', 'unknown'])
})

test('tmux session list is rate-limited: within 60 s every caller shares the last result, marked not fresh; a throwing probe is cached as unknown too', () => {
  let n = 0
  const c = sessionListCache(() => (n++, { ok: true, names: new Set([`s${n}`]), fresh: true }))
  const a = c(1000), b = c(1000 + 59_999), d = c(1000 + 60_000)
  expect(n).toBe(2)
  expect([a.fresh, b.fresh, d.fresh]).toEqual([true, false, true])
  expect(a.ok && b.ok && [...a.names, ...b.names]).toEqual(['s1', 's1'])
  expect(d.ok && [...d.names]).toEqual(['s2'])
  let m = 0
  const e = sessionListCache(() => { m++; throw new Error('ENOENT') })
  expect(e(0).ok).toBe(false)
  expect(e(30_000).ok).toBe(false)
  expect(m).toBe(1) // 失敗也快取，60 秒內不再試
})

test('hire order plan: merge only live hits; orders past 7 days are dropped before merging; only a freshly listed absence drops; unknown waits; tmux listed once and only when needed', () => {
  const H = 3600e3
  let lists = 0
  const L = (names: string[] | null, fresh = true) => () => (lists++, names ? { ok: true as const, names: new Set(names), fresh } : { ok: false as const, fresh })
  const young = { k: 'cxp-00000001', ageMs: H, hit: true }
  expect(planCxpOrders([young, { ...young, k: 'cxp-00000002', hit: false }], L([]))).toEqual([{ k: 'cxp-00000001', act: 'merge' }, { k: 'cxp-00000002', act: 'keep' }])
  expect(lists).toBe(0) // 都還沒滿 24 小時：不查 tmux
  const files = [
    { k: 'cxp-0000000a', ageMs: 30 * H, hit: true }, // 對到（tmux 在）：併
    { k: 'cxp-0000000b', ageMs: 30 * H, hit: false }, // 沒對到、剛查的名單沒有它：刪
    { k: 'cxp-0000000c', ageMs: 8 * 24 * H, hit: true }, // 過了 7 天：刪、不併（就算對到）
    { k: 'cxp-0000000d', ageMs: 30 * H, hit: false }, // 沒對到、tmux 在：留
  ]
  const alive = ['po-cxp-0000000a', 'po-cxp-0000000c', 'po-cxp-0000000d']
  expect(planCxpOrders(files, L(alive)).map(x => x.act)).toEqual(['merge', 'drop', 'drop', 'keep'])
  expect(lists).toBe(1) // 整輪只列一次
  expect(planCxpOrders(files, L(alive, false)).map(x => x.act)).toEqual(['merge', 'keep', 'drop', 'keep']) // 快取名單上沒有：先不刪
  expect(planCxpOrders(files, L(null)).map(x => x.act)).toEqual(['merge', 'keep', 'drop', 'keep']) // 查不到：沒對到的不刪；7 天的照刪
  expect(planCxpOrders(files, () => { throw new Error('ENOENT') }).map(x => x.act)).toEqual(['merge', 'keep', 'drop', 'keep']) // 拿名單拋錯：當查不到
  lists = 0
  expect(planCxpOrders([{ k: 'cxp-0000000e', ageMs: 30 * H, hit: true }], L([])).map(x => x.act)).toEqual(['merge']) // 對到就是 tmux 在的證據，不被舊名單蓋掉
  expect(lists).toBe(0)
})

import { utimesSync } from 'node:fs'
import { cxpOrderAt, resolveCodexOrders } from './server'
import { statSync } from 'node:fs'
test('resolveCodexOrders wiring: a throwing probe never escapes (roster keeps answering), a cached absence never deletes, only a fresh one does, and 7-day orders are dropped without looking anyone up', () => {
  const H = 3600e3, T0 = Date.now()
  const dir = mkdtempSync(join(tmpdir(), 'po-cxp-'))
  const put = (k: string, ageMs: number, now: number) => { const f = join(dir, `${k}.json`); writeFileSync(f, JSON.stringify({ title: k, nonce: 'n', at: now - ageMs })); utimesSync(f, (now - ageMs) / 1000, (now - ageMs) / 1000) }
  const has = (k: string) => existsSync(join(dir, `${k}.json`))
  let looked = 0
  const people = [{ id: 'codex-x', kind: 'codex' }]
  const procOf = () => (looked++, { tmuxSession: 'po-cxp-ffffffff' })
  try {
    let now = T0
    put('cxp-00000001', 30 * H, now)
    expect(() => resolveCodexOrders(people, now, { dir, hrDir: dir, procOf, list: () => { throw Object.assign(new Error('spawn tmux ENOENT'), { code: 'ENOENT' }) } })).not.toThrow()
    expect(has('cxp-00000001')).toBe(true)
    now += 10e3 // 快取名單（不是這一輪查的）上沒有它：不刪
    resolveCodexOrders(people, now, { dir, hrDir: dir, procOf, list: () => ({ ok: true, names: new Set(), fresh: false }) })
    expect(has('cxp-00000001')).toBe(true)
    now += 10e3 // 剛查的名單上沒有：刪
    resolveCodexOrders(people, now, { dir, hrDir: dir, procOf, list: () => ({ ok: true, names: new Set(), fresh: true }) })
    expect(has('cxp-00000001')).toBe(false)
    now += 10e3
    put('cxp-00000002', 8 * 24 * H, now)
    looked = 0
    resolveCodexOrders(people, now, { dir, hrDir: dir, procOf, list: () => ({ ok: true, names: new Set(['po-cxp-00000002']), fresh: true }) })
    expect([has('cxp-00000002'), looked]).toEqual([false, 0]) // 7 天：不找人、直接刪
    // 年齡看令裡的 at，不看 mtime（O-1）：檔案剛被搬過（mtime 新）但令是 25 小時前發的 → 照 25 小時判
    now += 10e3
    const f3 = join(dir, 'cxp-00000003.json')
    writeFileSync(f3, JSON.stringify({ title: 't', nonce: 'n', at: now - 25 * H }))
    resolveCodexOrders(people, now, { dir, hrDir: dir, procOf, list: () => ({ ok: true, names: new Set(), fresh: true }) })
    expect(has('cxp-00000003')).toBe(false)
    // 沒有 at：退回 mtime（剛寫的 → 24 小時內，留）
    now += 10e3
    const f4 = join(dir, 'cxp-00000004.json')
    writeFileSync(f4, JSON.stringify({ title: 't', nonce: 'n' }))
    resolveCodexOrders(people, now, { dir, hrDir: dir, procOf, list: () => ({ ok: true, names: new Set(), fresh: true }) })
    expect(has('cxp-00000004')).toBe(true)
    expect(cxpOrderAt(f4)).toBe(statSync(f4).mtimeMs)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

import { assetVer, pageHtml, handle as handleKv } from './server'
test('key visual splash: page links get ?v= only for delivered webp files (looked up one by one, no full asset scan); webp assets are served as image/webp', async () => {
  const page = '<img data-a="/v2/assets/kv_splash_claude_sm.webp"><img data-b="/v2/assets/kv_splash_gemini_sm.webp">'
  const asked: string[] = []
  expect(pageHtml(page, f => (asked.push(f), f === 'kv_splash_claude_sm.webp' ? 'abc123' : undefined))).toBe('<img data-a="/v2/assets/kv_splash_claude_sm.webp?v=abc123"><img data-b="/v2/assets/kv_splash_gemini_sm.webp">')
  expect(asked).toEqual(['kv_splash_claude_sm.webp', 'kv_splash_gemini_sm.webp'])
  expect(pageHtml(page, () => undefined)).toBe(page)
  expect(assetVer('kv_nope_missing.webp')).toBeUndefined()
  // 首頁實際送出的 HTML 有載入畫面（讀屏可讀的狀態）與員工卡小人的位置；四位角色的小圖都在清單裡
  const html = pageHtml()
  expect(html).toContain('id="kvsplash"')
  expect(html).toContain('role="status"')
  expect(html).toContain('id="cchibi"')
  for (const sp of ['claude', 'chatgpt', 'gemini', 'deepseek']) expect(html).toContain(`kv_splash_${sp}_sm.webp`)
  expect(html).not.toMatch(/kv_splash_[a-z]+\.webp/) // 大圖不在首頁載
  const miss = await handleKv(new Request('http://127.0.0.1:8781/v2/assets/kv_splash_nope.webp'))
  expect([403, 404]).toContain(miss.status)
  const real = await handleKv(new Request('http://127.0.0.1:8781/v2/assets/kv_splash_claude_sm.webp', { headers: { host: '127.0.0.1:8781' } }))
  expect(real.status).toBe(200)
  expect(real.headers.get('content-type')).toBe('image/webp')
})

import { newBossHandle } from './server'
test('0.63.57: after a handover the table records the new manager by his roster agent (ListAgents name), the hire name only as fallback', () => {
  const h = { newSid: 'n', newName: '招聘名' }
  expect(newBossHandle([{ id: 'n', agent: '示範團隊主管' }], h)).toBe('示範團隊主管')
  expect(newBossHandle([{ id: 'n' }], h)).toBe('招聘名')
  expect(newBossHandle([], h)).toBe('招聘名')
})

test('0.63.59: a Claude session without configDir counts as the default ~/.claude when configDirs filters', async () => {
  const { visibleKind } = await import('./server')
  const home = join(homedir(), '.claude')
  const other = '/x/.claude-work'
  const plain = { id: 'a' } as any // 桌面 app／沒設 CLAUDE_CONFIG_DIR：狀態檔沒有 configDir
  const work = { id: 'b', configDir: other + '/' } as any
  const codex = { id: 'c', kind: 'codex' } as any
  // configDirs 有 ~/.claude：沒有 configDir 的顯示
  expect(visibleKind(plain, [home])).toBe(true)
  expect(visibleKind(plain, [other, home])).toBe(true)
  expect(visibleKind(work, [home])).toBe(false)
  // configDirs 沒有 ~/.claude：照舊不顯示
  expect(visibleKind(plain, [other])).toBe(false)
  expect(visibleKind(work, [other])).toBe(true)
  // 沒設 configDirs＝全部；Codex 不受限
  expect(visibleKind(plain, undefined)).toBe(true)
  expect(visibleKind(codex, [other])).toBe(true)
})

test('0.63.59: crew() shows a configDir-less Claude session only when remote.json configDirs lists ~/.claude', async () => {
  const { crew, _setConfigPatch } = await import('./server')
  const dir = join(homedir(), '.claude', 'pixel-office', 'sessions') // 跑測試一律用假 HOME
  mkdirSync(dir, { recursive: true })
  const id = `cfgless-${process.pid}`
  const p = join(dir, `${id}.json`)
  const now = Date.now()
  writeFileSync(p, JSON.stringify({ instance: 'i', id, name: '桌面', role: '員工', updatedAt: now, since: now, ver: 'x' }))
  try {
    _setConfigPatch({ configDirs: [join(homedir(), '.claude')] })
    expect(crew(now).people.some(c => c.id === id)).toBe(true)
    _setConfigPatch({ configDirs: ['/x/.claude-work'] })
    expect(crew(now).people.some(c => c.id === id)).toBe(false)
  } finally {
    _setConfigPatch({})
    rmSync(p, { force: true })
  }
})

test('0.63.59: HR finds a configDir-less Claude session through the default ~/.claude/sessions/<pid>.json', async () => {
  const { profileOf } = await import('./hr')
  const office = join(homedir(), '.claude', 'pixel-office', 'sessions') // 跑測試一律用假 HOME
  const cli = join(homedir(), '.claude', 'sessions')
  mkdirSync(office, { recursive: true })
  mkdirSync(cli, { recursive: true })
  const id = `hrcfgless-${process.pid}`
  const pid = process.pid // 活著的程序：procOf 會用 kill(pid, 0) 確認
  const st = join(office, `${id}.json`)
  const ps = join(cli, `${pid}.json`)
  writeFileSync(st, JSON.stringify({ id, name: '桌面', addr: `/tmp/cc-socks/${pid}.sock`, updatedAt: Date.now() }))
  writeFileSync(ps, JSON.stringify({ sessionId: 'sid-cfgless', cwd: '/x/行程助理', entrypoint: 'sdk-cli' }))
  try {
    const r = profileOf(id) as any
    expect(r.ok).toBe(true)
    expect(r.cwd).toBe('/x/行程助理')
    expect(r.host).toBe('app')
    // 寫了別的 configDir、那裡沒有這個 pid：照舊找不到
    writeFileSync(st, JSON.stringify({ id, name: '桌面', addr: `/tmp/cc-socks/${pid}.sock`, configDir: '/x/.claude-work', updatedAt: Date.now() }))
    expect((profileOf(id) as any).ok).toBe(false)
  } finally {
    rmSync(st, { force: true })
    rmSync(ps, { force: true })
  }
})

// ── 0.63.60 伺服器準備（顧問裁示）：刪桌留一份、刪改桌記存取紀錄、configDirs 的 ~ 展開、端點層的 configDirs 測試 ──
// 會寫 office-<port>.json 的測試只在假 HOME 跑，免得蓋到真檔（bun 的 userInfo().homedir 跟著 HOME 走，所以用帳號名比）。
// Windows：homedir() 跟著 USERPROFILE（不看 HOME），真家目錄是 C:\Users\<帳號>，不分大小寫
const fakeHome = () => {
  const u = userInfo().username, h = homedir(), win = process.platform === 'win32'
  const real = [join('/Users', u), join('/home', u), ...(win ? [`${process.env.SystemDrive ?? 'C:'}\\Users\\${u}`] : [])]
  return !real.some(r => win ? r.toLowerCase() === h.toLowerCase() : r === h)
}
const HOME_SKIP = '（略過：會寫 office-<port>.json，要用假家目錄跑；Windows 設 USERPROFILE，Mac／Linux 設 HOME）'
/** 真家目錄上不跑（skip、標題附原因），不算失敗 */
const homeTest = (name: string, fn: () => Promise<void>) => fakeHome() ? test(name, fn) : test.skip(name + HOME_SKIP, fn)

test('0.63.60 N-1: configDirs in remote.json may start with ~; it is expanded to the home folder (trailing slash trimmed)', async () => {
  const { config, configDirOf, _setConfigPatch } = await import('./server')
  expect(configDirOf('~/.claude')).toBe(join(homedir(), '.claude'))
  expect(configDirOf('~/.claude/')).toBe(join(homedir(), '.claude'))
  expect(configDirOf('~')).toBe(homedir())
  expect(configDirOf('/x/.claude-work/')).toBe('/x/.claude-work')
  expect(configDirOf('~other/.claude')).toBe('~other/.claude') // 別人的家目錄不猜
  const base = join(homedir(), '.claude', 'pixel-office')
  mkdirSync(base, { recursive: true })
  const name = `remote-spec-${process.pid}.json`
  writeFileSync(join(base, name), JSON.stringify({ configDirs: ['~/.claude', '/x/.claude-work/'] }))
  const was = process.env.PO_CONFIG
  _setConfigPatch(undefined)
  process.env.PO_CONFIG = name
  try {
    expect(config().configDirs).toEqual([join(homedir(), '.claude'), '/x/.claude-work'])
  } finally {
    if (was === undefined) delete process.env.PO_CONFIG; else process.env.PO_CONFIG = was
    rmSync(join(base, name), { force: true })
  }
})

test('0.63.60 N-2: a configDir-less session cannot be seen or commanded through the endpoints unless configDirs lists ~/.claude', async () => {
  const { handle, crew, _setConfigPatch } = await import('./server')
  const H = join(homedir(), '.claude')
  const office = join(H, 'pixel-office', 'sessions'), cli = join(H, 'sessions'), cmds = join(H, 'pixel-office', 'commands')
  mkdirSync(office, { recursive: true }); mkdirSync(cli, { recursive: true })
  const pid = process.pid, id = `n2-${pid}`, now = Date.now()
  const st = join(office, `${id}.json`), ps = join(cli, `${pid}.json`), cmd = join(cmds, `${id}.json`)
  writeFileSync(st, JSON.stringify({ instance: 'i', id, name: '桌面', role: '員工', addr: `/tmp/cc-socks/${pid}.sock`, updatedAt: now, since: now, ver: 'x' }))
  writeFileSync(ps, JSON.stringify({ sessionId: 'sid-n2', cwd: '/x/w', entrypoint: 'sdk-cli' }))
  const post = (p: string, b: object) => handle(new Request(`http://127.0.0.1${p}`, { method: 'POST', headers: { 'x-po-key': TK, 'content-type': 'application/json' }, body: JSON.stringify(b) })).then(r => r.json() as any)
  const get = (p: string) => handle(new Request(`http://127.0.0.1${p}`)).then(r => r.json() as any)
  try {
    _setConfigPatch({ configDirs: ['/x/.claude-work'] })
    rmSync(cmd, { force: true })
    expect(crew().people.some(c => c.id === id)).toBe(false)
    expect((await get(`/profile.json?id=${id}`)).ok).toBe(false)
    expect((await post('/command', { id, text: '測試' })).ok).toBe(false)
    expect(existsSync(cmd)).toBe(false) // 沒寫命令檔
    expect((await post('/model', { id, model: 'haiku' })).ok).toBe(false)
    expect((await post('/key', { id, key: 'esc' })).ok).toBe(false)
    _setConfigPatch({ configDirs: ['/x/.claude-work', H] })
    expect(crew().people.some(c => c.id === id)).toBe(true)
    expect((await get(`/profile.json?id=${id}`)).ok).toBe(true)
  } finally {
    _setConfigPatch({})
    for (const f of [st, ps, cmd]) rmSync(f, { force: true })
  }
})

homeTest('0.63.60: deleting a table first appends it (with its pins and seats) to office-<port>.deleted.jsonl; the access log records op, table and name as high risk', async () => {
  const { handle, deletedFile, _setGatePatch: gp } = await import('./server')
  const log = join(tmpdir(), `po-spec-tables-${process.pid}.jsonl`)
  gp({ dev: true, key: TK, anyHost: true, log })
  const post = (b: object) => handle(new Request('http://127.0.0.1/tables', { method: 'POST', headers: { 'x-po-key': TK, 'content-type': 'application/json' }, body: JSON.stringify(b) })).then(r => r.json() as any)
  const state = await handle(new Request('http://127.0.0.1/state.json')).then(r => r.json() as any)
  const before = new Set((state.tables ?? []).map((t: any) => t.id))
  rmSync(deletedFile(), { force: true })
  try {
    expect((await post({ op: 'add', name: '要刪的桌', size: 4 })).ok).toBe(true)
    const after = await handle(new Request('http://127.0.0.1/state.json')).then(r => r.json() as any)
    const t = after.tables.find((x: any) => !before.has(x.id) && x.name === '要刪的桌')
    expect(t).toBeTruthy()
    expect((await post({ op: 'edit', id: t.id, size: 6 })).ok).toBe(true)
    expect((await post({ op: 'delete', id: 99999 })).ok).toBe(false) // 找不到：不留檔
    expect(existsSync(deletedFile())).toBe(false)
    expect((await post({ op: 'delete', id: t.id, force: true })).ok).toBe(true)
    const rows = readFileSync(deletedFile(), 'utf8').trim().split('\n').map(l => JSON.parse(l))
    expect(rows.length).toBe(1)
    expect(rows[0].table).toMatchObject({ id: t.id, name: '要刪的桌', size: 6 })
    expect(typeof rows[0].at).toBe('number')
    expect(rows[0].pins).toEqual({})
    if (process.platform !== 'win32') expect(statSync(deletedFile()).mode & 0o777).toBe(0o600) // Windows 沒有 600 可言
    // 示意模式的刪除不留檔
    await handle(new Request('http://127.0.0.1/tables', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ op: 'delete', id: 1, force: true, demo: 3 }) })) // 測試埠的示意請求（不帶金鑰）
    expect(readFileSync(deletedFile(), 'utf8').trim().split('\n').length).toBe(1)
    const acc = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.path === '/tables')
    expect(acc.map(l => [l.op, l.risk ?? '', l.name ?? ''])).toEqual([['add', '', ''], ['edit', 'high', '要刪的桌'], ['delete', 'high', ''], ['delete', 'high', '要刪的桌']])
    expect(acc.every(l => l.via === 'key')).toBe(true)
  } finally {
    gp({ dev: true, key: TK, anyHost: true, log: join(tmpdir(), `po-spec-access-${process.pid}.jsonl`) })
    rmSync(log, { force: true })
  }
})

test('0.63.60: tableSnapshot keeps the pins, pin sources and seats that point at the table, nothing else', async () => {
  const { tableSnapshot } = await import('./server')
  const S = { tables: [{ id: 2, name: '桌二', size: 8, team: 'boss' }, { id: 3, name: '桌三', size: 4 }], seats: { a: { key: 't2.0', seen: 1 }, b: { key: 't3.1', seen: 1 }, c: { key: 't2.3', seen: 1 } }, pins: { a: 't2.0', b: 't3.1', d: 'o4' }, pinBy: { a: { by: 'hire', at: 5 }, b: { by: 'drag', at: 6 } }, nextId: 4 } as any
  expect(tableSnapshot(S, 2)).toEqual({ table: { id: 2, name: '桌二', size: 8, team: 'boss' }, pins: { a: 't2.0' }, pinBy: { a: { by: 'hire', at: 5 } }, seats: { a: 't2.0', c: 't2.3' } })
  expect(tableSnapshot(S, 9)).toBeUndefined()
  const snap = tableSnapshot(S, 2)!
  S.tables[0].name = '改了'
  expect(snap.table.name).toBe('桌二') // 是複本
})

test('0.63.60: the phone delete confirmation names the table', () => {
  const js = readFileSync(join(import.meta.dir, 'v2', 'scene.js'), 'utf8')
  expect(js).toContain('再按一次確定刪除「${t.name}」')
})

homeTest('0.63.60: /state.json shares one roster within the cache window; any write (here /tables) drops the cache so the next read is fresh', async () => {
  const { handle, _setRosterTtl } = await import('./server')
  const dir = join(homedir(), '.claude', 'pixel-office', 'sessions')
  mkdirSync(dir, { recursive: true })
  const id = `cache-${process.pid}`, p = join(dir, `${id}.json`)
  const state = () => handle(new Request('http://127.0.0.1/state.json')).then(r => r.json() as any)
  const has = (j: any) => j.people.some((x: any) => x.id === id)
  _setRosterTtl(60e3) // 測試裡放長，免得機器慢時剛好過期
  let added: number | undefined
  try {
    rmSync(p, { force: true })
    const a = await state()
    expect(has(a)).toBe(false)
    const now = Date.now()
    writeFileSync(p, JSON.stringify({ instance: 'i', id, name: '快取', role: '員工', updatedAt: now, since: now, ver: 'x' }))
    expect(has(await state())).toBe(false) // 快取期間：還是舊的那份
    const r = await handle(new Request('http://127.0.0.1/tables', { method: 'POST', headers: { 'x-po-key': TK, 'content-type': 'application/json' }, body: JSON.stringify({ op: 'add', name: '快取測試', size: 2 }) })).then(r => r.json() as any)
    expect(r.ok).toBe(true)
    const b = await state()
    expect(has(b)).toBe(true) // 寫入後快取失效：新上線的人、新桌都看得到
    added = b.tables.find((t: any) => t.name === '快取測試')?.id
    expect(added).toBeDefined()
    // 讀的請求（包括帶金鑰的）不會讓快取失效
    rmSync(p, { force: true })
    await handle(new Request('http://127.0.0.1/chat.json?id=nobody', { headers: { 'x-po-key': TK } }))
    expect(has(await state())).toBe(true)
    _setRosterTtl(0) // 不快取：每次重算
    expect(has(await state())).toBe(false)
  } finally {
    _setRosterTtl(1000)
    rmSync(p, { force: true })
    if (added !== undefined) await handle(new Request('http://127.0.0.1/tables', { method: 'POST', headers: { 'x-po-key': TK, 'content-type': 'application/json' }, body: JSON.stringify({ op: 'delete', id: added, force: true }) }))
  }
})
