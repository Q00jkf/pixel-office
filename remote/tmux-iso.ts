// 測試用的獨立 tmux 伺服器（spec 共用）。
// 2026-11-25 21:56 事故：`TMUX_TMPDIR=<不存在的資料夾> tmux kill-server` 時 tmux 3.8 不報錯、退回使用者的主伺服器
// （/private/tmp/tmux-<uid>/default），把整台電腦的 tmux 對話全關了。所以：
// - socket 只用先 mkdtemp 建好的短路徑 `-S`（或先建好的 TMUX_TMPDIR，給要讓子程序連同一台的 codex-owner）；
// - 會關東西的指令（kill-*、respawn-*）執行前，用同一組參數問 tmux 連到的 socket（display -p '#{socket_path}'），
//   必須等於這次建的、而且不是主伺服器；不是就丟錯、不執行。問不到（這台沒在跑）就不執行，回失敗。
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export type TmuxResult = { exitCode: number | null; stdout: Buffer; stderr: Buffer }
type Raw = (...a: string[]) => TmuxResult

const DESTRUCTIVE = /^(kill-(server|session|pane|window)|respawn-(pane|window)|unlink-window|run-shell|run|if-shell|if|source-file|source)$/
/** 會不會關東西（審查 N-1）：掃所有參數，不只第一個；有 `;`（串指令）、run-shell、if-shell、source-file 也當成會 */
const destructive = (a: string[]) => a.some(x => DESTRUCTIVE.test(x) || x === ';' || x.endsWith('\\;') || x.endsWith(' ;'))
const real = (p: string) => { try { return realpathSync(p) } catch { return p } }
const uid = () => process.getuid?.() ?? 0

/** 使用者主伺服器可能的 socket：/tmp、/private/tmp、目前環境的 TMUX_TMPDIR 底下的 tmux-<uid>/default，加上 $TMUX 指的那個 */
export function mainSockets(env: Record<string, string | undefined> = process.env): string[] {
  const dirs = ['/tmp', '/private/tmp', ...(env.TMUX_TMPDIR ? [env.TMUX_TMPDIR] : [])]
  const out = dirs.map(d => real(join(d, `tmux-${uid()}`, 'default')))
  const t = env.TMUX?.split(',')[0]
  if (t) out.push(real(t))
  return [...new Set(out)]
}

/**
 * 會關東西的指令前的檢查：問連到的 socket，等於 expected、而且不在主伺服器清單才放行（回 true）；
 * 這台伺服器沒在跑（問不到）回 false（不執行，也沒東西可關）；連到別台（含主伺服器）丟錯
 */
export function socketCheck(raw: Raw, expected: string, main = mainSockets()): boolean {
  const r = raw('display', '-p', '#{socket_path}')
  const got = r.stdout.toString().trim()
  if (r.exitCode !== 0 || !got) return false
  const g = real(got)
  if (main.includes(g) || g !== real(expected)) throw new Error(`tmux 測試隔離：連到的是 ${got}，不是這次建的 ${expected}，不執行`)
  return true
}

export type Iso = {
  bin: string
  env: Record<string, string>
  /** 接在 tmux 後面的參數（-S 模式是 ['-S', socket]；TMUX_TMPDIR 模式是 []，要搭配 env） */
  pre: string[]
  /** 這次的 socket 實際路徑 */
  socket: string
  run: Raw
  close: () => void
}

/**
 * 開一台測試用的 tmux（還沒有 session，第一個 new-session 才起伺服器）。mode：
 * 'S'＝`-S <暫存夾>/s`（預設）；'TMPDIR'＝TMUX_TMPDIR 指到先建好的暫存夾（子程序只拿到 env 也連得到同一台）。
 * 沒有 tmux 回 undefined
 */
export function isoTmux(opts: { mode?: 'S' | 'TMPDIR'; bin?: string } = {}): Iso | undefined {
  const bin = opts.bin ?? Bun.which('tmux')
  if (!bin) return
  const main = mainSockets()
  const dir = real(mkdtempSync(join(tmpdir(), 'pot-'))) // 先建好（不存在的話 tmux 會退回主伺服器）
  if (!statSync(dir).isDirectory()) throw new Error(`tmux 測試隔離：${dir} 建不起來`)
  const env: Record<string, string> = { ...process.env } as any
  delete env.TMUX; delete env.TMUX_PANE; delete env.TMUX_TMPDIR
  let pre: string[], socket: string
  if (opts.mode === 'TMPDIR') { env.TMUX_TMPDIR = dir; pre = []; socket = join(dir, `tmux-${uid()}`, 'default') }
  else { socket = join(dir, 's'); pre = ['-S', socket] }
  if (main.includes(socket)) throw new Error(`tmux 測試隔離：${socket} 是主伺服器`)
  const raw: Raw = (...a) => {
    // 暫存夾在測試途中不見了（系統清理、平行的 close）：TMPDIR 模式會退回主伺服器，-S 模式會在別處重建，一律不送（審查 N-2）
    if (!existsSync(dir)) throw new Error(`tmux 測試隔離：${dir} 不見了，不執行`)
    const r = Bun.spawnSync([bin, ...pre, ...a], { env, stdout: 'pipe', stderr: 'pipe', timeout: 5000 }); return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr } }
  const run: Raw = (...a) => {
    if ((a[0] ?? '').startsWith('-')) throw new Error('tmux 測試隔離：第一個參數要是指令（全域選項由 isoTmux 決定），不執行') // 審查 N-1
    if (destructive(a) && !socketCheck(raw, socket, main)) return { exitCode: 1, stdout: Buffer.from(''), stderr: Buffer.from('tmux 測試隔離：這台沒在跑，不執行') }
    return raw(...a)
  }
  return { bin, env, pre, socket, run, close: () => { try { if (existsSync(dir)) run('kill-server') } finally { rmSync(dir, { recursive: true, force: true }) } } }
}
