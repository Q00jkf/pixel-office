// bun test remote：招聘的 Codex 一開就結束要回失敗（0.63.56）。在隔離的 tmux（tmux-iso）上真的開視窗
import { afterAll, expect, test } from 'bun:test'
import { codexStarted, deadScreen, spawnBounded } from './hr'
import { isoTmux } from './tmux-iso'

const ISO = isoTmux()
afterAll(() => ISO?.close())
const run = (a: string[], ms: number) => spawnBounded([ISO!.bin, ...ISO!.pre, ...a], ms)
// 跟 hireCodex({ hold }) 一樣：同一次 tmux 呼叫裡開 remain-on-exit
// （ISO.run 對帶「;」的指令會先查 socket，伺服器還沒起來時不放行；這裡直接用隔離的 -S socket）
const open = (name: string, cmd: string) => Bun.spawnSync([ISO!.bin, ...ISO!.pre, 'new-session', '-d', '-x', '120', '-y', '30', '-s', name, 'sh', '-c', cmd, ';', 'set-option', '-w', '-t', `=${name}:`, 'remain-on-exit', 'on'], { env: ISO!.env, stdout: 'pipe', stderr: 'pipe', timeout: 5000 }).exitCode

test('deadScreen: last lines without blanks or the tmux "Pane is dead" line, paths shortened', () => {
  expect(deadScreen('a\n\nError: duplicate key `x` in /Users/me/.codex/config.toml\n\nPane is dead (status 1, Thu Nov 26 08:00:00 2026)\n')).toBe('a ／ Error: duplicate key `x` in …/config.toml')
  expect(deadScreen('\n\n')).toBe('')
})

test('codexStarted (isolated tmux): exits at once → failure with exit code and the last lines, the session is cleaned up', async () => {
  if (!ISO) return
  expect(open('po-cxp-dead0001', 'echo "Error: loading config: duplicate key in /Users/x/.codex/config.toml" >&2; exit 3')).toBe(0)
  const r = await codexStarted('po-cxp-dead0001', run, ms => Bun.sleep(ms), 3000)
  expect(r.ok).toBe(false)
  expect((r as any).text).toContain('結束碼 3')
  expect((r as any).text).toContain('duplicate key in …/config.toml')
  expect(ISO.run('has-session', '-t', '=po-cxp-dead0001').exitCode).not.toBe(0) // 收掉了
})

test('codexStarted (isolated tmux): still running after the window → ok, remain-on-exit switched off', async () => {
  if (!ISO) return
  expect(open('po-cxp-live0001', 'sleep 30')).toBe(0)
  const t0 = Date.now()
  expect(await codexStarted('po-cxp-live0001', run, ms => Bun.sleep(ms), 1200)).toEqual({ ok: true })
  expect(Date.now() - t0).toBeGreaterThanOrEqual(1200)
  expect(ISO.run('show-options', '-w', '-v', '-t', '=po-cxp-live0001:', 'remain-on-exit').stdout.toString().trim()).toBe('off')
})

test('codexStarted: session already gone (no screen kept) → failure saying so', async () => {
  if (!ISO) return
  const r = await codexStarted('po-cxp-none0001', run, ms => Bun.sleep(ms), 500)
  expect(r).toMatchObject({ ok: false })
  expect((r as any).text).toContain('一開就關了')
})
