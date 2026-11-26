// bun test remote：完整對話頁的伺服器介面（0.63.50）。① /live.json 的畫面整理、狀態、快取；④ /chat.json 的 limit 與檔尾快速路徑；⑤ caps
import { expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _liveSeen, capsOf, errBrief, liveOf, liveState, liveText } from './server'
import { pageChat } from './hr'

// 實際擷取到的畫面（11-25 試驗 session），稍作縮短
const CLAUDE_SCREEN = `❯ 試驗用：請用 Bash 工具執行這個指令
⏺ 我先看一下資料夾
  ⎿  Read 3 files
⏺ 好，接著要改 server.ts 的
  路由，再補測試
✻ Crunched for 3s · ↓ 120 tokens · esc to interrupt
────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  ⏸ manual mode on · ? for shortcuts`
const CODEX_SCREEN = `  >_ OpenAI Codex (v0.171.0-alpha.13.2)
     ~/.claude/pixel-office/v2-features
› 試驗用：請直接執行這個 shell 指令
• 我會照原樣執行這條指令。
• Ran echo PO_APPROVE_TEST
  └ (no output)
• Working (6s • esc to interrupt)
› Ask Codex to do anything
  GPT-6.2-Sol default · ~/.claude/pixel-office/v2-features
  ← for agents · ? for shortcuts`

test('liveText: only this turn (after the last user input) up to the input box; frame, status and spinner lines removed', () => {
  expect(liveText(CLAUDE_SCREEN)).toBe('⏺ 我先看一下資料夾\n  ⎿  Read 3 files\n⏺ 好，接著要改 server.ts 的\n  路由，再補測試')
  expect(liveText(CODEX_SCREEN, 'codex')).toBe('• 我會照原樣執行這條指令。\n• Ran echo PO_APPROVE_TEST\n  └ (no output)')
  expect(liveText('❯ hi\n────────────\n❯ \n────────────\n')).toBeNull() // 這一輪還沒寫東西
  const long = '❯ go\n' + 'x'.repeat(5000) + '\n────────────\n❯ \n────────────'
  expect(liveText(long)!.length).toBe(2000) // 最多 2000 字，留最後面的
})

test('liveText (Claude, current TUI): input box top rule carries the session name; glyph-less spinner, background hint and tip lines are dropped', () => {
  const screen = `❯ 前一句
⏺ 好的
 Chat-server ①③④⑤ built; running full suites · 3s
  ⎿  $ cd ~/.claude/pixel-office/v2-features; curl -s "http://127.0.0.1:8782/live.json"
     (ctrl+b ctrl+b (twice) to run in background)

  ⎿  Tip: Use /btw to ask a side question without interrupting Claude

────────────────────────────────────────────────────────────────── 像素工程師B ─
❯
────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ auto mode on (shift+tab to cycle)`
  expect(liveText(screen)).toBe('⏺ 好的\n  ⎿  $ cd ~/.claude/pixel-office/v2-features; curl -s "http://127.0.0.1:8782/live.json"')
})

test('liveState: approval > waiting > working (tool or writing) > idle', () => {
  expect(liveState({ mode: 'typing', approval: { tool: 'Bash' } })).toBe('approval')
  expect(liveState({ mode: 'waiting' })).toBe('waiting')
  expect(liveState({ mode: 'reading', tool: 'Read' })).toBe('tool')
  expect(liveState({ mode: 'thinking' })).toBe('writing')
  expect(liveState({ mode: 'done' })).toBe('idle')
  expect(liveState({ mode: 'idle' })).toBe('idle')
})

test('liveOf: one capture per id within 0.7 s (shared by viewers); no pane → writing null without capturing; idle → no capture', async () => {
  _liveSeen.clear()
  let caps = 0
  const deps = (who: any, pane?: string) => ({ who: () => who, pane: () => pane, capture: async () => { caps++; return CLAUDE_SCREEN } })
  const d = deps({ mode: 'typing' }, '%5')
  const [a, b] = await Promise.all([liveOf('x', 1000, d), liveOf('x', 1500, d)])
  expect(caps).toBe(1)
  expect(a).toEqual(b)
  expect(a).toMatchObject({ ok: true, state: 'writing', at: 1000 })
  expect(String(a.writing)).toContain('路由，再補測試')
  await liveOf('x', 1800, d) // 過了 0.7 秒：再擷取一次
  expect(caps).toBe(2)
  expect(await liveOf('app', 1000, deps({ mode: 'typing' }, undefined))).toEqual({ ok: true, state: 'writing', writing: null, at: 1000 }) // App 分頁等：不擷取
  expect(await liveOf('idle', 1000, deps({ mode: 'idle' }, '%6'))).toEqual({ ok: true, state: 'idle', writing: null, at: 1000 })
  expect(caps).toBe(2)
  expect(await liveOf('gone', 1000, deps(undefined))).toEqual({ ok: false, text: '這位已經不在線' })
})

test('pageChat: limit gives exactly that many items, start lands on the first returned line; earlier page continues from it; after at end of file → fstat only', () => {
  const dir = mkdtempSync(join(tmpdir(), 'po-chat-')), f = join(dir, 'c.jsonl')
  try {
    writeFileSync(f, Array.from({ length: 50 }, (_, i) => JSON.stringify({ n: i })).join('\n') + '\n')
    const parse = (l: string) => (l.trim() ? [{ k: 'ai', text: String(JSON.parse(l).n) } as any] : [])
    const p1 = pageChat(f, 's', undefined, undefined, parse, 20) as any
    expect(p1.items.map((x: any) => x.text)).toEqual(Array.from({ length: 20 }, (_, i) => String(30 + i)))
    const p2 = pageChat(f, 's', p1.start, undefined, parse, 20) as any
    expect(p2.items.map((x: any) => x.text)).toEqual(Array.from({ length: 20 }, (_, i) => String(10 + i)))
    const p3 = pageChat(f, 's', p2.start, undefined, parse, 20) as any
    expect(p3.items.map((x: any) => x.text)).toEqual(Array.from({ length: 10 }, (_, i) => String(i)))
    expect(p3.start).toBe(0)
    const size = statSync(f).size
    expect(p1.end).toBe(size)
    expect(pageChat(f, 's', undefined, size, parse)).toEqual({ ok: true, sid: 's', items: [], end: size }) // 檔尾：快速路徑
    appendFileSync(f, JSON.stringify({ n: 50 }) + '\n')
    const p4 = pageChat(f, 's', undefined, size, parse) as any
    expect(p4.items.map((x: any) => x.text)).toEqual(['50'])
    expect((pageChat(f, 's', undefined, undefined, parse) as any).items.length).toBe(51) // 沒給 limit：照舊（60）
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('caps: derived from src/can; approve stays false until in-office approval ships; handoff only for Codex', () => {
  expect(capsOf({ src: 'tmux', can: { model: true, effort: true, perm: true, key: true, fire: true } })).toEqual({ send: true, photo: true, interrupt: true, cfg: true, keys: true, approve: false, handoff: null })
  expect(capsOf({ src: 'app', can: { model: false, effort: false, perm: false, key: false, fire: true } })).toMatchObject({ interrupt: false, cfg: false, keys: false })
  expect(capsOf({ kind: 'codex', src: 'tmux', can: { key: true, handoffApp: true, handoffTmux: false } }).handoff).toBe('toApp')
  expect(capsOf({ kind: 'codex', src: 'app', can: { key: false, handoffApp: false, handoffTmux: true } }).handoff).toBe('toBg')
  expect(capsOf({ kind: 'codex', src: 'app', can: { handoffApp: false, handoffTmux: false } }).handoff).toBeNull()
})

test('S-1: a Codex open in the Codex App is view-only (no send, no photo); the background Codex and Claude can send', () => {
  expect(capsOf({ kind: 'codex', src: 'app', can: { handoffTmux: true } })).toMatchObject({ send: false, photo: false, handoff: 'toBg' })
  expect(capsOf({ kind: 'codex', src: 'tmux', can: { key: true, handoffApp: true } })).toMatchObject({ send: true, photo: true })
  expect(capsOf({ src: 'app', can: {} })).toMatchObject({ send: true, photo: true }) // Claude 的 App 分頁照常能傳話
})

test('S-4: a Codex error keeps its last line, paths shortened to the file name, at most 200 characters', () => {
  expect(errBrief('warning: x\nError: failed to read /Users/me/.codex/sessions/2026/11/26/rollout-1.jsonl: denied\n')).toBe('Error: failed to read …/rollout-1.jsonl: denied')
  expect(errBrief('Error: CODEX_HOME=~/.codex-alt/config.toml missing')).toBe('Error: CODEX_HOME=…/config.toml missing')
  expect(errBrief('')).toBe('')
  expect(errBrief('e'.repeat(500)).length).toBe(200)
})
