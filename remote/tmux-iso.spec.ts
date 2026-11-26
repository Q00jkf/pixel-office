// bun test remote：測試用 tmux 隔離（tmux-iso）。11-25 21:56 事故：TMUX_TMPDIR 指到不存在的資料夾時 tmux 3.8 退回主伺服器、kill-server 關掉了它。
// 用假的 tmux（記下收到的指令、display 回指定的 socket）驗：連到主伺服器或別台就丟錯、絕不送出 kill；問不到就不執行。
// 真 tmux 只用這支自己建的暫存 socket
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isoTmux, mainSockets, socketCheck } from './tmux-iso'

const uid = process.getuid?.() ?? 0
const dirs: string[] = [] // 跑完刪（審查 N-3）
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }) })
/** 假的 tmux：每次呼叫記一行參數；display 回 $FAKE_SOCK（空＝失敗） */
function fakeTmux() {
  const dir = mkdtempSync(join(tmpdir(), 'po-faketmux-')); dirs.push(dir)
  const log = join(dir, 'calls'), bin = join(dir, 'tmux')
  writeFileSync(bin, `#!/bin/sh\necho "$*" >> '${log}'\ncase "$*" in *display*) [ -n "$FAKE_SOCK" ] && { echo "$FAKE_SOCK"; exit 0; }; echo "no server running on /x" >&2; exit 1;; esac\nexit 0\n`)
  chmodSync(bin, 0o755)
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [])
  const raw = (sock: string, extraEnv: Record<string, string> = {}) => (...a: string[]) => {
    const r = Bun.spawnSync([bin, ...a], { env: { ...process.env, FAKE_SOCK: sock, ...extraEnv } as any, stdout: 'pipe', stderr: 'pipe' })
    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
  }
  return { bin, calls, raw }
}

test('a TMUX_TMPDIR that does not exist makes tmux fall back to the main server: the check refuses and no kill is sent', () => {
  const f = fakeTmux()
  const main = `/private/tmp/tmux-${uid}/default`
  const raw = f.raw(main, { TMUX_TMPDIR: '/nonexistent-po-test' }) // tmux 3.8 對不存在的 TMUX_TMPDIR 不報錯、連主伺服器
  expect(() => socketCheck(raw, `/nonexistent-po-test/tmux-${uid}/default`)).toThrow(/不執行/)
  expect(f.calls().some(c => c.startsWith('kill'))).toBe(false)
})

test('isoTmux.run: kill-server / kill-session / kill-pane / respawn-pane are checked first; main or another server → throw, never sent; not running → not sent', () => {
  const f = fakeTmux()
  const iso = isoTmux({ bin: f.bin })!
  const say = (sock: string) => { iso.env.FAKE_SOCK = sock } // 假 tmux 從 iso 的環境讀
  try {
    say(`/private/tmp/tmux-${uid}/default`)
    for (const cmd of [['kill-server'], ['kill-session', '-t', 'x'], ['kill-pane', '-t', '%1'], ['respawn-pane', '-k', '-t', 'x']]) expect(() => iso.run(...cmd)).toThrow(/不執行/)
    say('/tmp/some-other-test-server')
    expect(() => iso.run('kill-server')).toThrow(/不執行/)
    say('')
    expect(iso.run('kill-server').exitCode).toBe(1) // 問不到：不送
    expect(f.calls().some(c => /kill-|respawn-/.test(c))).toBe(false)
    say(iso.socket)
    expect(iso.run('kill-session', '-t', 'x').exitCode).toBe(0) // 是這台：照送
    expect(f.calls().filter(c => c.includes('kill-session'))).toEqual([`-S ${iso.socket} kill-session -t x`])
    iso.run('list-sessions') // 不會關東西的指令不用問
    expect(f.calls().at(-1)).toBe(`-S ${iso.socket} list-sessions`)
    // 審查 N-1：關東西藏在後面的參數、用 ; 串、包在 run-shell／if-shell 裡，一樣先驗；第一個參數是選項直接拒絕
    say(`/private/tmp/tmux-${uid}/default`)
    const before = f.calls().length
    for (const cmd of [['new-session', ';', 'kill-server'], ['set-option', '-g', 'x', 'y', ';', 'list-sessions'], ['run-shell', 'tmux kill-server'], ['if-shell', 'true', 'kill-server'], ['source-file', '/tmp/x']]) expect(() => iso.run(...cmd)).toThrow(/不執行/)
    expect(() => iso.run('-f', '/dev/null', 'kill-server')).toThrow(/第一個參數/)
    expect(f.calls().slice(before).every(c => c.includes('display'))).toBe(true) // 只問過 socket，沒送出別的
  } finally { iso.env.FAKE_SOCK = ''; iso.close() }
})

test('the folder disappearing mid-test (N-2): nothing is sent at all', () => {
  const f = fakeTmux()
  const iso = isoTmux({ bin: f.bin, mode: 'TMPDIR' })!
  rmSync(iso.env.TMUX_TMPDIR, { recursive: true, force: true })
  expect(() => iso.run('new-session', '-d', '-s', 'x')).toThrow(/不見了/)
  expect(f.calls()).toEqual([])
  iso.close()
})

test('mainSockets covers /tmp, /private/tmp, the current TMUX_TMPDIR and the socket in $TMUX', () => {
  const m = mainSockets({ TMUX: '/private/tmp/tmux-501/weird,123,4', TMUX_TMPDIR: '/var/x' })
  expect(m).toContain(`/private/tmp/tmux-${uid}/default`)
  expect(m.some(x => x.endsWith(`/var/x/tmux-${uid}/default`))).toBe(true)
  expect(m).toContain('/private/tmp/tmux-501/weird')
})

test('real tmux: both modes run on their own socket (reported socket_path is ours), kill works there, close removes the folder', () => {
  if (!Bun.which('tmux')) return
  for (const mode of ['S', 'TMPDIR'] as const) {
    const iso = isoTmux({ mode })!
    expect(mainSockets()).not.toContain(iso.socket)
    expect(iso.run('new-session', '-d', '-s', `po-iso-${mode}`, 'sleep', '30').exitCode).toBe(0)
    expect(iso.run('display', '-p', '#{socket_path}').stdout.toString().trim()).toBe(iso.socket)
    expect(iso.run('kill-session', '-t', `=po-iso-${mode}`).exitCode).toBe(0)
    expect(iso.run('list-sessions').exitCode).not.toBe(0) // 最後一個 session 關了，伺服器跟著結束
    iso.close()
    expect(existsSync(iso.socket)).toBe(false)
  }
})
