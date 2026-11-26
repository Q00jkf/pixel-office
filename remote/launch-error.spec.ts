// bun test remote：接回後台時 codex 啟動就結束（0.63.46，含審查修正）。
// 真的 tmux＋假的 codex 跑同一個包裝：啟動就結束、設標記後自己結束、一直在跑到逾時；另用假的探針驗 settleLaunch 的每條路（不回收已結束的、
// 還在才回收、期限內來不及回未確認、App 搶先、確認畫面）。紀錄檔 0600、獨占建立、只讀尾段、收尾刪或縮。沒有 tmux 的機器跳過真 tmux 那幾項
import { expect, test } from 'bun:test'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LAUNCH_LOG_MAX, REAP_RESERVE_MS, closeLaunchLog, dropOldLaunchLogs, goneSoon, launchDirOk, reapOwnAsync, launchArgv, launchError, launchIO, newLaunchLog, settleLaunch, tmuxSessionState, type LaunchIO } from './hr'
import { afterAll } from 'bun:test'
import { isoTmux, mainSockets } from './tmux-iso'

// 獨立的 tmux 伺服器（O-19／O-20；11-25 21:56 事故後改用共用的 tmux-iso）：-S 暫存 socket，關東西前驗證連到的是這台、不是主伺服器
const ISO = isoTmux()
const TMUX = ISO?.bin
const SOCK = ISO?.pre ?? []
const run = (...a: string[]) => ISO!.run(...a)
const tmps: string[] = [] // 每個測試的暫存夾，跑完刪（審查 N-3）
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'po-launch-')); tmps.push(d); return d }
let stopped = 0 // BUG-13 測試暫停的那台；測試中途被打斷也一定恢復，才收得掉
afterAll(() => { if (stopped) try { process.kill(stopped, 'SIGCONT') } catch {} ; ISO?.close(); for (const d of tmps) rmSync(d, { recursive: true, force: true }) })
const fake = (dir: string, body: string) => { const f = join(dir, 'codex'); writeFileSync(f, `#!/bin/sh\n${body}\n`); chmodSync(f, 0o755); return f }
async function until(ok: () => Promise<boolean> | boolean, ms = 5000) { const t = Date.now(); while (!(await ok()) && Date.now() - t < ms) await Bun.sleep(50); return ok() }
const ERR = `printf '\\033[31mError:\\033[0m thread 01a2 is open in another app\\nhint: close it first\\n' >&2`

test('codex that exits at once: the session is gone and its stderr comes back as one or two readable lines; stdout stays out', async () => {
  if (!TMUX) return
  const dir = tmp(), log = newLaunchLog(join(dir, 'launch'), 'codex-x')!
  const exe = fake(dir, `printf 'starting\\n'\n${ERR}\nexit 2`)
  const r = run('new-session', '-d', '-P', '-F', '#{session_id}', '-s', `po-test-launch-${process.pid}`, ...launchArgv(log, [exe, 'resume', '--no-daemon', '--', '01a2']))
  expect(r.exitCode).toBe(0)
  const sid = r.stdout.toString().trim()
  expect(await until(async () => (await tmuxSessionState(sid, 3000, TMUX, SOCK)) === 'gone')).toBe(true)
  expect(await until(() => launchError(log) !== undefined, 2000)).toBe(true) // 錯誤已經在檔裡
  expect(launchError(log)).toBe('Error: thread 01a2 is open in another app ／ hint: close it first')
  expect(readFileSync(log, 'utf8')).not.toContain('starting')
})

test('codex with a lot of warnings before the error: stderr goes straight to the log, the error at the end is what we read, the log path is not passed on to codex, the pane process is codex itself', async () => {
  if (!TMUX) return
  const dir = tmp(), log = newLaunchLog(join(dir, 'launch'), 'codex-y')!
  const exe = fake(dir, `i=0; while [ $i -lt 400 ]; do echo 'noise line 0123456789 0123456789 0123456789' >&2; i=$((i+1)); done\necho "env=[$PO_LAUNCH_LOG]" >&2\necho 'Error: the real one' >&2\nsleep 1.5\nexit 1`)
  const r = run('new-session', '-d', '-P', '-F', '#{session_id} #{pane_pid}', '-s', `po-test-run-${process.pid}`, ...launchArgv(log, [exe]))
  const [sid, pid] = r.stdout.toString().trim().split(/\s+/)
  try {
    await Bun.sleep(500)
    const cmd = Bun.spawnSync(['ps', '-o', 'command=', '-p', pid], { stdout: 'pipe' }).stdout.toString()
    expect(cmd).toContain(exe) // exec 之後 pane 的程序就是 codex
    expect(cmd).not.toContain('PO_LAUNCH_LOG')
    expect(await until(() => readFileSync(log, 'utf8').endsWith('Error: the real one\n'), 5000)).toBe(true) // 直寫：邊跑邊寫進去
    expect(statSync(log).size).toBeGreaterThan(LAUNCH_LOG_MAX) // 約 18 KB 全在檔裡（不經讀取者，不會阻塞或截掉）
    expect(statSync(log).mode & 0o777).toBe(0o600)
    // 先大量警告、最後才印錯誤（複驗 resume2、BUG-11）：只讀最後 4 KB，拿到的是最後的錯誤，不是前面的警告
    expect(launchError(log)).toBe('env=[] ／ Error: the real one') // O-16：codex 看不到紀錄路徑
  } finally { run('kill-session', '-t', sid) }
})

test('whole flow on real tmux: codex exits after the marker is set → not reaped, its error is shown; still running → reaped at the timeout', async () => {
  if (!TMUX) return
  const dir = tmp()
  const io: LaunchIO = { ...launchIO(join(dir, 'no.lock'), SOCK), sleep: ms => Bun.sleep(ms) }
  for (const kind of ['exits', 'runs'] as const) {
    const log = newLaunchLog(join(dir, 'launch'), `codex-${kind}`)!
    const exe = fake(dir + (kind === 'exits' ? '' : ''), kind === 'exits' ? `sleep 0.8\n${ERR}\nexit 3` : 'echo running; sleep 60')
    const name = `po-test-flow-${kind}-${process.pid}`
    const r = run('new-session', '-d', '-P', '-F', '#{session_id} #{pane_id}', '-s', name, ...launchArgv(log, [exe]))
    const [sid, pane] = r.stdout.toString().trim().split(/\s+/)
    expect(run('set-option', '-t', sid, '@po_launch', 'M1').exitCode).toBe(0) // 標記設好了（之後才結束）
    const deadline = Date.now() + REAP_RESERVE_MS + (kind === 'exits' ? 6000 : 1500)
    const st = await settleLaunch({ sid, pane, marker: 'M1', name: 'mg', session: name, deadline, log }, io)
    try {
      if (kind === 'exits') {
        expect(st).toEqual({ took: false, exited: true, cleared: true, text: 'codex 啟動就結束：Error: thread 01a2 is open in another app ／ hint: close it first' })
      } else {
        expect(st).toEqual({ took: false, cleared: true, text: 'mg 沒有接成（可能還在啟動），晚點再按一次' })
        expect(await tmuxSessionState(sid, 3000, TMUX, SOCK)).toBe('gone') // 逾時後回收掉了
      }
      expect(Date.now()).toBeLessThanOrEqual(deadline + 500) // 期限內做完
    } finally { run('kill-session', '-t', sid) }
  }
})

describe_settle()
function describe_settle() {
  const base = { sid: '$9', pane: '%9', marker: 'M', name: 'mg', session: 'po-cxr-x', log: undefined as string | undefined }
  const mk = (o: Partial<LaunchIO> & { reaped?: string[] } = {}): LaunchIO & { reaped: string[] } => {
    const reaped: string[] = []
    return { state: async () => 'alive', panePid: async () => 123, screen: async () => '', holds: async () => false, reap: async (sid: string) => { reaped.push(sid); return true }, sleep: async () => {}, ...o, reaped }
  }
  let t = 0
  const clock = () => t
  test('settleLaunch: exited before the deadline → never reaped; error read from the log', async () => {
    const dir = tmp(), log = newLaunchLog(dir, 'c')!
    writeFileSync(log, 'boom: bad flag\n')
    let n = 0
    const io = mk({ panePid: async () => (++n > 2 ? 0 : 123), state: async () => (n > 2 ? 'gone' : 'alive'), sleep: async ms => { t += ms } })
    t = 0
    const st = await settleLaunch({ ...base, log, deadline: 15000 }, io, clock)
    expect(st).toEqual({ took: false, exited: true, cleared: true, text: 'codex 啟動就結束：boom: bad flag' })
    expect(io.reaped).toEqual([])
  })
  test('settleLaunch: still running at the timeout → reaped with the remaining time; reason stays "not taken"', async () => {
    let reapMs = 0
    const io = mk({ sleep: async ms => { t += ms }, reap: async (_s, _p, _m, until) => { reapMs = until - t; return true } })
    t = 0
    const st = await settleLaunch({ ...base, deadline: 15000 }, io, clock)
    expect(st).toEqual({ took: false, cleared: true, text: 'mg 沒有接成（可能還在啟動），晚點再按一次' })
    expect(reapMs).toBeGreaterThan(0)
    expect(reapMs).toBeLessThanOrEqual(REAP_RESERVE_MS)
  })
  test('settleLaunch: a tmux probe that cannot tell is not read as "exited"; App took it first; confirm screen kept; out of time → unconfirmed', async () => {
    t = 0
    const unknown = mk({ panePid: async () => 0, state: async () => 'unknown', sleep: async ms => { t += ms } })
    expect((await settleLaunch({ ...base, deadline: 15000 }, unknown, clock)).text).toBe('mg 沒有接成（可能還在啟動），晚點再按一次')
    t = 0
    const app = mk({ screen: async () => 'thread is open in another app', sleep: async ms => { t += ms } })
    expect(await settleLaunch({ ...base, deadline: 15000 }, app, clock)).toEqual({ took: false, cleared: true, text: '這段對話被 App 搶先打開了：先在 App 關掉它，再按一次' })
    t = 0
    const late = mk({ sleep: async ms => { t += ms }, state: async () => { t = 20000; return 'alive' } })
    const lt = await settleLaunch({ ...base, deadline: 15000 }, late, clock)
    expect(lt.took).toBe(false)
    expect((lt as any).text).toContain('期限內沒能確認')
    expect(late.reaped).toEqual([])
    t = 0
    const ok = mk({ holds: async () => true, sleep: async ms => { t += ms } })
    expect(await settleLaunch({ ...base, deadline: 15000 }, ok, clock)).toEqual({ took: true, pid: 123 })
  })
}

test('launch log: private folder and 0600 file created exclusively (an existing link is not followed); only the tail is read; closing drops it', () => {
  const dir = tmp(), ld = join(dir, 'launch')
  const log = newLaunchLog(ld, 'codex-x')!
  expect(statSync(ld).mode & 0o777).toBe(0o700)
  expect(statSync(log).mode & 0o777).toBe(0o600)
  expect(lstatSync(log).isFile()).toBe(true)
  // 一次一個新檔：同一位連按兩次各拿一個
  expect(newLaunchLog(ld, 'codex-x')).not.toBe(log)
  writeFileSync(log, 'x'.repeat(10000) + '\nolder line\nreal error ' + 'y'.repeat(400) + '\n')
  const e = launchError(log)!
  expect(e.startsWith('real error')).toBe(true) // 最後一行就超過 300：只放它（O-18）
  expect(e.length).toBeLessThanOrEqual(300) // 含省略號
  closeLaunchLog(log) // 每條結束路徑都刪
  expect(existsSync(log)).toBe(false)
  expect(launchError(log)).toBeUndefined()
  writeFileSync(log, '\n\n')
  expect(launchError(log)).toBeUndefined()
  // 資料夾放了指向別處的連結當資料夾：建不起來就回 undefined（照舊接，只是沒有錯誤可看）
  const target = join(dir, 'elsewhere'); writeFileSync(target, 'x')
  const bad = join(dir, 'badlaunch'); symlinkSync(target, bad)
  expect(newLaunchLog(bad, 'codex-x')).toBeUndefined()
  expect(readFileSync(target, 'utf8')).toBe('x')
  // 指向另一個資料夾的連結當 launch 資料夾（複驗 resume2）：也不用，不在那邊建檔、不改它的權限
  const otherDir = join(dir, 'otherdir'); mkdirSync(otherDir, { mode: 0o755 })
  const linked = join(dir, 'linkeddir'); symlinkSync(otherDir, linked)
  expect(newLaunchLog(linked, 'codex-x')).toBeUndefined()
  expect(readdirSync(otherDir)).toEqual([])
  expect(statSync(otherDir).mode & 0o777).toBe(0o755)
})

test('old launch logs (BUG-12): a new attempt clears the same person\'s leftovers; other people\'s are kept unless older than a day; a successful resume clears them too', () => {
  const ld = join(tmp(), 'launch')
  const mine = newLaunchLog(ld, 'codex-a')!, theirs = newLaunchLog(ld, 'codex-b')!, stale = newLaunchLog(ld, 'codex-c')!
  const old = (Date.now() - 25 * 3600e3) / 1000; utimesSync(stale, old, old)
  const next = newLaunchLog(ld, 'codex-a')!
  expect(existsSync(mine)).toBe(false) // 停在確認畫面、沒能確定收掉的那次：下次嘗試清掉
  expect(existsSync(next)).toBe(true)
  expect(existsSync(theirs)).toBe(true) // 別人的不動
  expect(existsSync(stale)).toBe(false) // 超過一天的清
  dropOldLaunchLogs(ld, 'codex-a') // 續接成功（ours，沒有新檔）時
  expect(existsSync(next)).toBe(false)
  expect(existsSync(theirs)).toBe(true)
  // 只刪 <id>-<uuid>.log 格式的一般檔：其他名字的 .log、連結都不碰（複驗 resume3）
  for (const n of ['notes.txt', 'server.log', 'codex-a-notauuid.log']) { writeFileSync(join(ld, n), 'x'); utimesSync(join(ld, n), old, old) }
  const lk = join(ld, `codex-a-${crypto.randomUUID()}.log`); symlinkSync(theirs, lk)
  dropOldLaunchLogs(ld, 'codex-a')
  for (const n of ['notes.txt', 'server.log', 'codex-a-notauuid.log']) expect(existsSync(join(ld, n))).toBe(true)
  expect(lstatSync(lk).isSymbolicLink()).toBe(true)
  expect(existsSync(theirs)).toBe(true)
})

test('old launch logs when hr/launch is a link to another folder (resume3): creating is refused, and the later cleanup on success / failed re-attach leaves the target folder alone', () => {
  const dir = tmp(), target = join(dir, 'elsewhere'), ld = join(dir, 'launch')
  mkdirSync(target)
  const old = (Date.now() - 25 * 3600e3) / 1000
  const names = [`codex-a-${crypto.randomUUID()}.log`, `codex-b-${crypto.randomUUID()}.log`, 'app.log']
  for (const n of names) { writeFileSync(join(target, n), 'keep'); utimesSync(join(target, n), old, old) }
  symlinkSync(target, ld)
  expect(launchDirOk(ld)).toBe(false)
  expect(newLaunchLog(ld, 'codex-a')).toBeUndefined() // 建立被拒（照舊接，只是沒有錯誤可看）
  dropOldLaunchLogs(ld, 'codex-a') // 接成功時
  dropOldLaunchLogs(ld, 'codex-a', Date.now() + 1) // 續接失敗時
  expect(readdirSync(target).sort()).toEqual([...names].sort()) // 連結目標裡的舊檔全部留著
  expect(launchDirOk(join(dir, 'nope'))).toBe(false)
  expect(launchDirOk(target)).toBe(true)
})

test('launch wrapper: when the log was already removed (or is a link) codex still starts and nothing is recreated', async () => {
  if (!TMUX) return
  const dir = tmp()
  const exe = fake(dir, `echo started > ${JSON.stringify(join(dir, 'ran'))}; echo oops >&2; sleep 0.3`)
  const gone = join(dir, 'gone.log')
  const r = run('new-session', '-d', '-P', '-F', '#{session_id}', '-s', `po-test-gone-${process.pid}`, ...launchArgv(gone, [exe]))
  expect(r.exitCode).toBe(0)
  expect(await until(() => existsSync(join(dir, 'ran')), 3000)).toBe(true) // codex 照常開
  expect(existsSync(gone)).toBe(false) // 不會被重建成一般檔
  const target = join(dir, 'target'); writeFileSync(target, ''); const link = join(dir, 'link.log'); symlinkSync(target, link)
  rmSync(join(dir, 'ran'))
  run('new-session', '-d', '-s', `po-test-link-${process.pid}`, ...launchArgv(link, [exe]))
  expect(await until(() => existsSync(join(dir, 'ran')), 3000)).toBe(true)
  await Bun.sleep(500)
  expect(readFileSync(target, 'utf8')).toBe('') // 連結不跟隨
})

test('reapOwnAsync: every step gets only the time left; out of time after kill-pane = unconfirmed; "no server running" after the kill = gone', async () => {
  let t = 0
  const asked: number[] = []
  const mkRun = (cost: number, list: { code: number | null; out: string; err: string }) => async (a: string[], ms: number) => {
    asked.push(ms); t += cost
    if (ms <= 0) return { code: null, out: '', err: '' } // 跟 spawnAsync 一樣：沒時間就不跑
    if (a[0] === 'show-options') return { code: 0, out: 'M\n', err: '' }
    if (a[0] === 'display') return { code: 0, out: '$9\n', err: '' }
    if (a[0] === 'kill-pane') return { code: 0, out: '', err: '' }
    return list
  }
  expect(await reapOwnAsync('$9', '%9', 'M', mkRun(100, { code: 0, out: '%1\n', err: '' }), 1000, () => t)).toBe(true)
  expect(asked).toEqual([1000, 900, 800, 700]) // 每一步重算剩下的時間
  t = 0; asked.length = 0
  expect(await reapOwnAsync('$9', '%9', 'M', mkRun(400, { code: 0, out: '', err: '' }), 1000, () => t)).toBe(false) // 關了之後已經沒時間確認：未確認
  t = 0
  expect(await reapOwnAsync('$9', '%9', 'M', mkRun(600, { code: 0, out: '', err: '' }), 1000, () => t)).toBe(false) // 輪到 kill-pane 時已經沒時間：不關
  t = 0
  expect(await reapOwnAsync('$9', '%9', 'M', mkRun(10, { code: 1, out: '', err: 'no server running on /x' }), 1000, () => t)).toBe(true)
  t = 0
  expect(await reapOwnAsync('$9', '%9', 'M', mkRun(10, { code: 1, out: '', err: 'lost server' }), 1000, () => t)).toBe(false)
  expect(await reapOwnAsync('9', '%9', 'M', mkRun(10, { code: 0, out: '', err: '' }), 1000, () => t)).toBe(false) // 身分格式不對
})

test('BUG-13: tmux server paused (SIGSTOP): probes and the reap come back at their deadline instead of waiting for the pipe to close', async () => {
  if (!TMUX) return
  const r = run('new-session', '-d', '-P', '-F', '#{session_id} #{pane_id}', '-s', `po-test-stop-${process.pid}`, 'sleep', '60')
  const [sid, pane] = r.stdout.toString().trim().split(/\s+/)
  // 暫停前確認：這個 pid 是 tmux-iso 建的那台（socket 對、不是主伺服器）；暫停的只會是它
  const info = run('display', '-p', '-t', sid, '#{pid} #{socket_path}').stdout.toString().trim().split(' ')
  const spid = Number(info[0])
  expect(spid).toBeGreaterThan(0)
  expect(info.slice(1).join(' ')).toBe(ISO!.socket)
  expect(mainSockets()).not.toContain(info.slice(1).join(' '))
  const mainPid = Number(Bun.spawnSync(['tmux', '-S', `/private/tmp/tmux-${process.getuid?.()}/default`, 'display', '-p', '#{pid}'], { stdout: 'pipe', stderr: 'pipe' }).stdout.toString().trim()) || -1
  expect(spid).not.toBe(mainPid)
  stopped = spid
  const io = launchIO(join(tmp(), 'no.lock'), SOCK)
  process.kill(spid, 'SIGSTOP')
  try {
    const timed = async <T>(f: () => Promise<T>) => { const t = Date.now(); const v = await f(); return { v, ms: Date.now() - t } }
    const st = await timed(() => tmuxSessionState(sid, 400, TMUX, SOCK))
    expect(st.v).toBe('unknown') // 讀不到不當成不在
    expect(st.ms).toBeLessThan(1500)
    const pp = await timed(() => io.panePid(sid, 400))
    expect(pp.v).toBe(0)
    expect(pp.ms).toBeLessThan(1500)
    const sc = await timed(() => io.screen(sid, 400))
    expect(sc.v).toBe('')
    expect(sc.ms).toBeLessThan(1500)
    const rp = await timed(() => io.reap(sid, pane, undefined, Date.now() + 600))
    expect(rp.v).toBe(false) // 沒能確定收掉
    expect(rp.ms).toBeLessThan(2000)
  } finally { process.kill(spid, 'SIGCONT'); stopped = 0 }
  expect(await tmuxSessionState(sid, 3000, TMUX, SOCK)).toBe('alive') // 伺服器恢復後照常
  run('kill-session', '-t', sid)
}, 20000)

test('tmuxSessionState: no tmux binary or no time → unknown; "no server running" → gone', async () => {
  expect(await tmuxSessionState('$1', 0)).toBe('unknown')
  expect(await tmuxSessionState('$1', 1000, '')).toBe('unknown')
  const dir = tmp()
  const noServer = fake(dir, `echo 'no server running on /tmp/x' >&2; exit 1`)
  expect(await tmuxSessionState('$1', 3000, noServer)).toBe('gone')
  const broken = fake(dir + '', `echo 'lost server' >&2; exit 1`)
  expect(await tmuxSessionState('$1', 3000, broken)).toBe('unknown')
  const list = fake(dir, `echo '$1'; echo '$2'`)
  expect(await tmuxSessionState('$2', 3000, list)).toBe('alive')
  expect(await tmuxSessionState('$3', 3000, list)).toBe('gone')
})

test('goneSoon: a session that disappears a moment later counts as gone (first press after the server starts); one that stays does not', async () => {
  let n = 0
  const sleep = (ms: number) => Bun.sleep(ms)
  expect(await goneSoon('$1', { state: async () => (++n >= 3 ? 'gone' : 'alive'), sleep }, 15000)).toBe(true)
  const t = Date.now()
  expect(await goneSoon('$1', { state: async () => 'alive', sleep }, 15000)).toBe(false)
  expect(Date.now() - t).toBeLessThan(2500)
  expect(await goneSoon('$1', { state: async () => 'unknown', sleep }, 300)).toBe(false)
})

test('launchError: a cut in the middle of a UTF-8 character is skipped; charset switches removed; the last line gets the 300-character budget first', () => {
  const dir = tmp(), log = join(dir, 'x.log')
  // 讓 4 KB 的起點落在「錯」（3 位元組）的中間
  writeFileSync(log, Buffer.concat([Buffer.from('錯'.repeat(2000)), Buffer.from('\n\x1b(B最後的錯誤\x1b(0\n')]))
  const e = launchError(log)!
  expect(e).not.toContain('\ufffd')
  expect(e.endsWith('最後的錯誤')).toBe(true)
  // 檔案開頭就是接續位元組（不到 4 KB 也一樣）：跳過，不出現替代字元
  writeFileSync(log, Buffer.concat([Buffer.from('錯').subarray(1), Buffer.from('誤訊息\n')]))
  expect(launchError(log)).toBe('誤訊息')
  expect(e.length).toBeLessThanOrEqual(300)
  writeFileSync(log, 'first line that is long ' + 'a'.repeat(400) + '\nlast short line\n')
  const f = launchError(log)!
  expect(f.endsWith(' ／ last short line')).toBe(true)
  expect(f.startsWith('…')).toBe(true)
  expect(f.length).toBe(300)
  writeFileSync(log, 'ok\n' + 'z'.repeat(500) + '\n')
  const g = launchError(log)!
  expect(g).toBe('z'.repeat(299) + '…')
})
