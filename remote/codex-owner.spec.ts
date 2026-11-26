// bun test remote：Codex hook 端驗世代（handoff 審查第 9 項；trust 審查 ④ 改三態＋條件寫入）。
// hr.ts 接回後台時在狀態檔寫 owner＝tmux:<session>@<marker>，marker 也存在那個 tmux session 的 @po_launch。
// codex/codex_office.py 的 hook：owner 還在、這個 hook 不是從那裡跑的 → 不寫；查不到（tmux 出錯、逾時）→ 也不寫、保留 owner；
// 確認失效才清 owner。寫前重讀，owner 換了就不寫。用暫時的 HOME 跑真的 codex_office.py；沒有 tmux 的機器跳過
import { afterAll, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isoTmux } from './tmux-iso'
import { join } from 'node:path'

const PY = join(import.meta.dir, '..', 'codex', 'codex_office.py')
const SID = '01a2feed-0000-7000-8000-0000000000aa'
// 獨立的 tmux 伺服器（共用 tmux-iso 的 TMUX_TMPDIR 模式：暫存夾先建好，codex_office.py 的 hook 只拿到 env 也連同一台；
// 關東西前驗證連到的是這台、不是主伺服器——11-25 21:56 事故：不存在的 TMUX_TMPDIR 會退回主伺服器）。跑完收掉、刪夾
const T = isoTmux({ mode: 'TMPDIR' })
const TMUX = T?.bin
const ISO: Record<string, string> = T?.env ?? (() => { const e: Record<string, string> = { ...process.env } as any; delete e.TMUX; delete e.TMUX_PANE; delete e.TMUX_TMPDIR; return e })()
const tm = (...a: string[]) => T!.run(...a)
afterAll(() => T?.close())

function hook(home: string, event: string, extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = { ...ISO, HOME: home, ...extraEnv }
  Bun.spawnSync(['python3', '-I', '-B', PY, 'hook', event], { env, stdin: Buffer.from(JSON.stringify({ session_id: SID, hook_event_name: event, cwd: home })), stdout: 'ignore', stderr: 'ignore', timeout: 20e3 })
}
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'po-owner-'))
  const dir = join(home, '.claude', 'pixel-office', 'sessions'); mkdirSync(dir, { recursive: true })
  const f = join(dir, `codex-${SID}.json`)
  const put = (owner?: string) => writeFileSync(f, JSON.stringify({ id: `codex-${SID}`, kind: 'codex', mode: 'idle', ended: false, left: false, ...(owner ? { owner } : {}) }))
  const read = () => JSON.parse(readFileSync(f, 'utf8'))
  return { home, f, put, read }
}

test('Codex hook generation: a stale process cannot overwrite a status owned by a live tmux; a confirmed-dead owner is dropped', () => {
  if (!TMUX) return
  const { home, put, read } = setup()
  const name = `po-owner-test-${process.pid}`
  try {
    expect(tm('new-session', '-d', '-s', name, 'sleep 60').exitCode).toBe(0)
    tm('set-option', '-t', `=${name}:`, '@po_launch', 'MARK1')
    put(`tmux:${name}@MARK1`); hook(home, 'SessionEnd')
    expect(read().ended).toBe(false) // 舊程序晚到的 SessionEnd：擋下
    put(`tmux:${name}@MARK1`); hook(home, 'Stop')
    expect(read().lastHook).toBeUndefined() // 其他事件也不寫
    put(`tmux:${name}@OTHER`); hook(home, 'SessionEnd')
    expect(read().ended).toBe(true) // 標記對不上：owner 失效，照常
    expect(read().owner).toBeUndefined()
    tm('kill-session', '-t', `=${name}:`)
    put(`tmux:${name}@MARK1`); hook(home, 'SessionEnd')
    expect(read().ended).toBe(true) // owner 的 tmux 不在了：照常
    put(); hook(home, 'SessionEnd')
    expect(read().ended).toBe(true) // 沒有 owner：照常
  } finally {
    tm('kill-session', '-t', `=${name}:`)
    rmSync(home, { recursive: true, force: true })
  }
})

test('Codex hook generation: the owner itself (hook run inside that tmux pane) writes normally and keeps the owner', async () => {
  if (!TMUX) return
  const { home, f, put, read } = setup()
  const name = `po-owner-self-${process.pid}`
  try {
    expect(tm('new-session', '-d', '-s', name, 'sleep 60').exitCode).toBe(0)
    tm('set-option', '-t', `=${name}:`, '@po_launch', 'MARK1')
    put(`tmux:${name}@MARK1`)
    const payload = JSON.stringify({ session_id: SID, hook_event_name: 'SessionEnd' }).replace(/'/g, "'\\''")
    tm('respawn-pane', '-k', '-t', `=${name}:`, `echo '${payload}' | HOME='${home}' python3 -I -B '${PY}' hook SessionEnd; sleep 60`)
    for (let i = 0; i < 40 && !read().ended; i++) await Bun.sleep(100)
    expect(read().ended).toBe(true)
    expect(read().owner).toBe(`tmux:${name}@MARK1`)
    expect(existsSync(f)).toBe(true)
  } finally {
    tm('kill-session', '-t', `=${name}:`)
    rmSync(home, { recursive: true, force: true })
  }
})

test('Codex hook generation: when tmux cannot be asked (error or timeout) the owner is kept and nothing is written', () => {
  const { home, put, read } = setup()
  const bin = join(home, 'fakebin'); mkdirSync(bin)
  try {
    for (const [what, script] of [['error', 'echo "server exited unexpectedly" >&2; exit 1'], ['timeout', 'sleep 5']]) {
      writeFileSync(join(bin, 'tmux'), `#!/bin/sh\n${script}\n`); chmodSync(join(bin, 'tmux'), 0o755)
      put('tmux:po-whatever@MARK1'); hook(home, 'SessionEnd', { PATH: `${bin}:${process.env.PATH}` })
      expect(`${what} ended=${read().ended} owner=${read().owner}`).toBe(`${what} ended=false owner=tmux:po-whatever@MARK1`)
    }
  } finally { rmSync(home, { recursive: true, force: true }) }
})

/** 載入 codex_office.py 當模組（HOME 指到暫存）跑一段 python */
function withOffice(home: string, code: string) {
  const r = Bun.spawnSync(['python3', '-I', '-B', '-c', [
    'import importlib.util,json,os,sys,threading,time,shutil',
    `spec=importlib.util.spec_from_file_location('co', ${JSON.stringify(PY)}); co=importlib.util.module_from_spec(spec); spec.loader.exec_module(co)`,
    'from pathlib import Path',
    code,
  ].join('\n')], { env: { ...ISO, HOME: home }, stdout: 'pipe', stderr: 'pipe', timeout: 20e3 })
  return r.stdout.toString().trim() + (r.exitCode ? ` [exit ${r.exitCode}] ${r.stderr.toString().slice(-300)}` : '')
}

/** 另開一個 python 程序拿住狀態檔的 flock 一段時間（模擬 hr.ts／別的 hook），可選在鎖裡改寫、最後不放鎖直接結束 */
function holder(f: string, secs: number, write?: object) {
  return Bun.spawn(['python3', '-I', '-B', '-c', [
    'import fcntl,json,os,sys,time',
    `fd=os.open(${JSON.stringify(f + '.flock')}, os.O_RDWR|os.O_CREAT, 0o600); fcntl.flock(fd, fcntl.LOCK_EX); print('HELD', flush=True)`,
    `time.sleep(${secs})`,
    write ? `open(${JSON.stringify(f)},'w').write(${JSON.stringify(JSON.stringify(write))})` : 'pass',
    'os._exit(0)  # 不放鎖直接結束：核心會放',
  ].join('\n')], { env: ISO, stdout: 'pipe' })
}
async function held(h: ReturnType<typeof holder>) { const rd = h.stdout.getReader(); await rd.read(); rd.releaseLock() }

test('status lock (flock): another process holds it, publishes a new owner after our read and exits without unlocking; our conditional write waits, re-reads and is refused', async () => {
  const { home, f } = setup()
  try {
    writeFileSync(f, JSON.stringify({ id: 'x', mode: 'idle' }))
    const h = holder(f, 0.6, { id: 'x', mode: 'idle', owner: 'tmux:new@M2' }); await held(h)
    const out = withOffice(home, [
      `p=Path(${JSON.stringify(f)})`,
      "s={'id':'x','mode':'done'}; t=time.time(); ok=co.save_if(p, s, None)",
      "print('WROTE' if ok else 'SKIPPED', json.loads(p.read_text()).get('owner'), json.loads(p.read_text()).get('mode'), time.time()-t>0.3)",
    ].join('\n'))
    expect(out).toBe('SKIPPED tmux:new@M2 idle True')
  } finally { rmSync(home, { recursive: true, force: true }) }
}, 20000)

test('status lock (flock): many writers at once over a leftover lock file all get in one at a time (no lost update), and an old holder cannot release a newer lock', async () => {
  const { home, f } = setup()
  try {
    writeFileSync(f, JSON.stringify({ id: 'x', n: 0 })); writeFileSync(`${f}.flock`, '') // 地上留著一個鎖檔：不用清
    const procs = Array.from({ length: 8 }, () => Bun.spawn(['python3', '-I', '-B', '-c', [
      'import importlib.util,time',
      `spec=importlib.util.spec_from_file_location('co', ${JSON.stringify(PY)}); co=importlib.util.module_from_spec(spec); spec.loader.exec_module(co)`,
      'from pathlib import Path',
      `p=Path(${JSON.stringify(f)})`,
      "def inc(s):\n    v=s.get('n',0); time.sleep(0.05); s['n']=v+1",
      "print(co.update_status(p, inc))",
    ].join('\n')], { env: { ...ISO, HOME: home }, stdout: 'pipe' }))
    const outs = await Promise.all(procs.map(pr => pr.exited))
    expect(outs.every(c => c === 0)).toBe(true)
    expect(JSON.parse(readFileSync(f, 'utf8')).n).toBe(8) // 8 個都進去、一次一個，沒有互蓋
    const out = withOffice(home, [
      `p=Path(${JSON.stringify(f)})`,
      'a=co.status_lock(p); co.status_unlock(a)  # 舊持有者拿了又放',
      'b=co.status_lock(p)  # 新持有者拿到',
      'co.status_unlock(a)  # 舊持有者「恢復」後又放一次（它的 fd 早就關了）',
      "co.STATUS_LOCK_WAIT=0.3; c=co.status_lock(p)  # 第三者：新鎖應該還在，拿不到",
      "print(a is not None, b is not None, c is None)",
    ].join('\n'))
    expect(out).toBe('True True True')
  } finally { rmSync(home, { recursive: true, force: true }) }
}, 30000)

test('Codex watcher: a personnel order is marked done only when the status was really written', async () => {
  const { home, f } = setup()
  try {
    writeFileSync(f, JSON.stringify({ id: `codex-${SID}`, mode: 'idle' }))
    const h = holder(f, 3); await held(h) // 鎖被拿著超過 2 秒
    const out = withOffice(home, [
      `p=Path(${JSON.stringify(f)})`,
      "order=('n1', {'title':'新職稱'})",
      'done=co.ORDERS / "codex-' + SID + '.done.json"',
      "r1=co.apply_order_now(p, co.load(p), order); a=done.exists()",
      'time.sleep(1.5)  # 等拿鎖的程序結束',
      "r2=co.apply_order_now(p, co.load(p), order); b=done.exists()",
      "print(r1, a, r2, b, json.loads(p.read_text()).get('title'))",
    ].join('\n'))
    expect(out).toBe('False False True True 新職稱')
  } finally { rmSync(home, { recursive: true, force: true }) }
}, 20000)

test('MCP tools: when the status file stays busy, office_profile says nothing was saved and office_takeover says the reminder was not recorded (no rerun)', async () => {
  const { home, f } = setup()
  try {
    writeFileSync(f, JSON.stringify({ id: `codex-${SID}`, name: 'old', mode: 'idle' }))
    const h = holder(f, 8); await held(h)
    const out = withOffice(home, [
      'try:',
      `    print('PROFILE', co.tool_profile(${JSON.stringify(SID)}, {'title':'新職稱'}))`,
      'except ValueError as e:',
      "    print('PROFILE-ERR', e)",
      `print('HOLD', co.hold_role(co.status_file(${JSON.stringify(SID)}), '# 接手後要做的\\n5. 收工前在 /x/cp.md 檔尾存一筆'))`,
      `print('TITLE', json.loads(Path(${JSON.stringify(f)}).read_text()).get('title'))`,
    ].join('\n'))
    expect(out).toContain('PROFILE-ERR The office status file is busy, nothing was saved')
    expect(out).toContain('HOLD False')
    expect(out).toContain('TITLE None')
    const src = readFileSync(PY, 'utf8')
    expect(src).toContain('do NOT call office_takeover again')
  } finally { rmSync(home, { recursive: true, force: true }) }
}, 30000)

test('hr.ts writeStatusLocked: waits for the same flock, merges onto the current file, gives up after waitMs', async () => {
  const { writeStatusLocked } = await import('./hr')
  const { home, f } = setup()
  try {
    writeFileSync(f, JSON.stringify({ id: 'x', name: 'keep', mode: 'busy' }))
    let h = holder(f, 1.0); await held(h)
    let ticks = 0; const t = setInterval(() => ticks++, 20)
    expect(await writeStatusLocked(f, {}, { owner: 'tmux:a@M1', mode: 'idle' }, 300)).toBe(false) // 等不到就放棄、不寫
    clearInterval(t); expect(ticks).toBeGreaterThan(3) // 等鎖的時候伺服器（事件迴圈）照常轉
    expect(JSON.parse(readFileSync(f, 'utf8')).owner).toBeUndefined()
    expect(await writeStatusLocked(f, {}, { owner: 'tmux:a@M1', mode: 'idle' }, 3000)).toBe(true) // 等到了：合併寫入
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ id: 'x', name: 'keep', mode: 'idle', owner: 'tmux:a@M1' })
    rmSync(f); expect(await writeStatusLocked(f, { id: 'base' }, { owner: 'o' })).toBe(true) // 檔不在：用 base
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ id: 'base', owner: 'o' })
  } finally { rmSync(home, { recursive: true, force: true }) }
}, 20000)

test('office_takeover with a busy status file: "do not take over again" only when the takeover really succeeded; a STOP result keeps its own instructions', async () => {
  const { home, f } = setup()
  try {
    writeFileSync(f, JSON.stringify({ id: `codex-${SID}`, name: 'cx', mode: 'idle' }))
    const h = holder(f, 10); await held(h)
    const out = withOffice(home, [
      "ok_out='# 接手後要做的\\n5. 收工前在 /x/cp.md 檔尾存一筆'",
      "stop_out='STOP：這個角色已經有人在線上，不要接\\n# 接手後要做的\\n5. 收工前在 /x/cp.md 檔尾存一筆'",
      "co.run_takeover=lambda *a, **k: ok_out",
      `r1=co.tool_takeover(${JSON.stringify(SID)}, {'role':'r'})`,
      "co.run_takeover=lambda *a, **k: stop_out",
      `r2=co.tool_takeover(${JSON.stringify(SID)}, {'role':'r'})`,
      "print('OK-DONE' if 'do NOT call office_takeover again' in r1 else 'OK-MISSING')",
      "print('STOP-DONE' if 'do NOT call office_takeover again' in r2 else 'STOP-CLEAN', 'STOP-KEPT' if r2.startswith('STOP：') else 'STOP-LOST', 'BUSY-NOTED' if 'reminder state was not updated' in r2 else 'BUSY-MISSING')",
    ].join('\n'))
    expect(out).toBe('OK-DONE\nSTOP-CLEAN STOP-KEPT BUSY-NOTED')
  } finally { rmSync(home, { recursive: true, force: true }) }
}, 30000)
