// bun test remote：替 Codex 按允許（codexPress，0.63.51）在 tmux-iso 獨立伺服器上真的跑：假的 Codex 顯示 v0.171 的確認畫面、記下收到哪個鍵。
// 允許只送 y、拒絕只送 Esc；畫面換了或 socket 驗不過就一個鍵都不送
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { codexApproval, codexPress, codexPrompt, type PressDeps } from './approve'
import { isoTmux } from './tmux-iso'

const ISO = isoTmux()
const dir = mkdtempSync(join(tmpdir(), 'po-press-'))
afterAll(() => { ISO?.close(); rmSync(dir, { recursive: true, force: true }) })

function fakeCodex(name: string) {
  const out = join(dir, `${name}.out`), sh = join(dir, `${name}.sh`)
  writeFileSync(sh, `#!/bin/bash
clear
printf '%s\\n' "• Running echo hi > /tmp/x" "  Would you like to run the following command?" "  Environment: local" "  Reason: test" "  \\$ echo hi > /tmp/x" "› 1. Yes, proceed (y)" "  2. Yes, and don't ask again for commands that start with \\\`echo hi\\\` (p)" "  3. No, and tell Codex what to do differently (esc)" "  Press enter to confirm or esc to cancel"
IFS= read -rsn1 k
clear
printf '%q' "$k" > '${out}'
echo done
sleep 30
`)
  chmodSync(sh, 0o755)
  const r = ISO!.run('new-session', '-d', '-P', '-F', '#{pane_id}', '-x', '160', '-y', '40', '-s', name, sh)
  return { pane: r.stdout.toString().trim(), out }
}
const deps = (over: Partial<PressDeps> = {}): PressDeps => ({
  capture: p => { const r = ISO!.run('capture-pane', '-p', '-J', '-t', p); return r.exitCode === 0 ? r.stdout.toString() : undefined },
  socketOk: () => true,
  send: (p, k) => ({ ok: ISO!.run('send-keys', '-t', p, k).exitCode === 0 }),
  sleep: ms => Bun.sleep(ms),
  ...over,
})
async function ready(pane: string) { for (let i = 0; i < 50; i++) { const s = deps().capture(pane); if (s && codexPrompt(s)?.kind === 'run') return s; await Bun.sleep(100) } throw new Error('prompt not shown') }

test('allow sends exactly "y"; deny sends exactly Esc; the prompt is gone afterwards', async () => {
  if (!ISO) return
  for (const [key, want] of [['allow', 'y'], ['deny', "$'\\E'"]] as const) {
    const f = fakeCodex(`cx-${key}`)
    const s = await ready(f.pane)
    const nonce = codexApproval(codexPrompt(s)!, f.pane, 0).nonce
    const r = await codexPress(f.pane, nonce, key, deps())
    expect(r).toEqual({ ok: true, text: '', sent: true })
    expect(readFileSync(f.out, 'utf8')).toBe(want)
  }
}, 30000)

test('the screen changed (different nonce) or the socket check fails: no key is sent', async () => {
  if (!ISO) return
  const f = fakeCodex('cx-guard')
  const s = await ready(f.pane)
  const sent: string[] = []
  const spy = deps({ send: (p, k) => { sent.push(k); return { ok: true } } })
  expect(await codexPress(f.pane, 'not-this-card', 'allow', spy)).toEqual({ ok: false, text: '畫面已經變了，請重看' })
  const nonce = codexApproval(codexPrompt(s)!, f.pane, 0).nonce
  expect(await codexPress(f.pane, nonce, 'allow', { ...spy, socketOk: () => false })).toEqual({ ok: false, text: '連不上電腦上的 tmux，請到電腦上按' })
  expect(sent).toEqual([])
  expect(existsSync(f.out)).toBe(false)
}, 30000)
