// bun test remote/winhire.spec.ts：Windows 招聘（設計 windows-hire 第 1 期）。open_role.py 換成假的，看傳了什麼參數；
// 資料夾信任的判斷、90 秒沒進辦公室的通知卡。任何平台都能跑（直接呼叫 hireWindows，不經 process.platform）
import { afterAll, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _setOpenRoleRun, _stuck, CODEX_WIN_TEXT, folderTrusted, hireWindows, initHr, openRoleArgv, runOpenRole, stuckView, watchWinHire, winLaunches, winLaunchSet, winWindowOf, type Person } from './hr'

const base = mkdtempSync(join(tmpdir(), 'po-winhire-'))
const cfg = join(base, 'cfg'), work = join(base, 'work'), fresh = join(base, 'fresh')
for (const d of [cfg, work, fresh]) mkdirSync(d, { recursive: true })
const fwd = (p: string) => p.replace(/\\/g, '/')
writeFileSync(join(cfg, '.claude.json'), JSON.stringify({ projects: { [fwd(work)]: { hasTrustDialogAccepted: true }, [fwd(fresh)]: { hasTrustDialogAccepted: false } } }))
let people: Person[] = []
initHr({ base, hireConfigDir: () => cfg, hireDirs: () => [{ name: '工作', path: work }, { name: '新的', path: fresh }], people: () => people, sendCommand: () => undefined, port: () => 8782 })
let calls: { args: string[]; env: Record<string, string | undefined>; task?: string }[] = []
let reply = (args: string[]) => ({ code: 0, out: JSON.stringify({ sid: args[args.indexOf('--session-id') + 1], pid: 4242 }) + '\n', err: '' })
const old = _setOpenRoleRun((args, env) => {
  const i = args.indexOf('--task-file')
  calls.push({ args, env, task: i >= 0 && existsSync(args[i + 1]) ? require('node:fs').readFileSync(args[i + 1], 'utf8') : undefined })
  return reply(args)
})
afterAll(() => { _setOpenRoleRun(old); rmSync(base, { recursive: true, force: true }) })
beforeEach(() => { calls = []; people = []; _stuck.clear() })
const arg = (a: string[], k: string) => a[a.indexOf(k) + 1]

test('招聘：組 open_role.py 的參數（名字、資料夾、sid、模型、模式、主管、工作檔），工作檔用完刪掉', () => {
  const r = hireWindows({ name: '小明', model: 'opus', effort: 'high', perm: 'default', role: 'manager', team: 'office設計', task: '整理報表', dir: work, title: '報表' }, { addDirs: [join(base, 'desk')] })
  expect(r.ok).toBe(true)
  const a = calls[0].args
  expect(arg(a, '--role')).toBe('小明')
  expect(a).toContain('--name-only')
  expect(a).toContain('--json')
  expect(a).toContain('--remote-control')
  expect(arg(a, '--dir')).toBe(work)
  expect(arg(a, '--session-id')).toBe(r.sid!)
  expect(arg(a, '--model')).toBe('opus')
  expect(arg(a, '--permission-mode')).toBe('manual')
  expect(arg(a, '--effort')).toBe('high')
  expect(arg(a, '--role-type')).toBe('manager')
  expect(arg(a, '--team')).toBe('office設計')
  expect(arg(a, '--title')).toBe('報表')
  expect(arg(a, '--add-dir')).toBe(join(base, 'desk'))
  expect(a).not.toContain('--chrome')
  expect(calls[0].task).toBe('整理報表') // 主管那句由 open_role.py 加，伺服器不重複加
  expect(existsSync(arg(a, '--task-file'))).toBe(false)
  expect(calls[0].env.CLAUDE_CONFIG_DIR).toBe(cfg)
  expect(r.text).toContain('小明')
})

test('沒交代工作就不帶 --task-file；沒選主管不帶 --team', () => {
  const r = hireWindows({ name: 'A', dir: work })
  expect(r.ok).toBe(true)
  expect(calls[0].args).not.toContain('--task-file')
  expect(calls[0].args).not.toContain('--team')
  expect(arg(calls[0].args, '--role-type')).toBe('staff')
})

test('資料夾沒信任過：先回 need=trust、不開；帶 trustOk 才開', () => {
  const r = hireWindows({ name: 'B', dir: fresh })
  expect(r).toMatchObject({ ok: false, need: 'trust' })
  expect(r.text).toContain('新的')
  expect(calls.length).toBe(0)
  expect(hireWindows({ name: 'B', dir: fresh, trustOk: true }).ok).toBe(true)
  expect(calls.length).toBe(1)
})

test('open_role.py 回錯誤（例如資料夾不存在）：招聘失敗，訊息帶原因', () => {
  const keep = reply
  reply = () => ({ code: 1, out: JSON.stringify({ error: 'Not found: X', code: 1 }) + '\n', err: '' })
  try { expect(hireWindows({ name: 'C', dir: work })).toMatchObject({ ok: false, text: '開不起來：Not found: X' }) } finally { reply = keep }
})

test('runOpenRole：輸出不是 JSON 時拿 stderr 最後幾行', () => {
  const keep = reply
  reply = () => ({ code: 1, out: '', err: 'Traceback\nValueError: boom\n' })
  try { expect(runOpenRole(['--role', 'x'])).toEqual({ error: 'Traceback / ValueError: boom', code: 1 }) } finally { reply = keep }
})

test('參數檢查與 tmux 版一樣；Codex 在 Windows 不能招', () => {
  expect(hireWindows({ name: '' }).ok).toBe(false)
  expect(hireWindows({ name: 'D', model: 'gpt' }).text).toBe('不認得的智力等級')
  expect(hireWindows({ name: 'D', perm: 'yolo' }).text).toBe('不認得的模式')
  expect(hireWindows({ name: 'D', agent: 'codex' }).text).toBe(CODEX_WIN_TEXT)
  expect(calls.length).toBe(0)
})

test('python 要帶 -X utf8 -I', () => {
  const a = openRoleArgv(['--role', 'x'])
  expect(a.slice(1, 4)).toEqual(['-X', 'utf8', '-I'])
  expect(a[4]).toMatch(/scripts[\\/]open_role\.py$/)
})

// 名字、工作裡有智慧標點的單引號（’‘‚‛）：PowerShell 也當單引號，q() 沒重複就斷字串（office設計 2026-11-26）。
// 用 open_role 真的產出的開窗腳本，把 claude 換成印出每個參數的函式，比對拿到的值
test.skipIf(process.platform !== 'win32')('開窗腳本：名字、工作裡的各種單引號照原字傳給 claude', () => {
  const name = `小’明‘x'y‚z‛`, task = `don’t ‘stop’ it's ‚a‛ ; Write-Output PWNED; '`
  const py = `import sys, json\nsys.path.insert(0, ${JSON.stringify(join(import.meta.dir, '..', 'scripts'))})\nfrom open_role import ps_script, encoded\n` +
    `n, t, d = json.loads(sys.stdin.read())\n` +
    `s = "function claude { [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); foreach ($a in $args) { Write-Output ('<' + $a + '>') } }; " + ps_script(n, d, t, 'sid-1', None, ['--model', n])\n` +
    `print(encoded(s))`
  const enc = Bun.spawnSync(['python', '-X', 'utf8', '-I', '-c', py], { stdin: Buffer.from(JSON.stringify([name, task, work])), stdout: 'pipe', stderr: 'pipe' })
  expect(enc.stderr.toString()).toBe('')
  const r = Bun.spawnSync(['powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand', enc.stdout.toString().trim()], { stdout: 'pipe', stderr: 'pipe' })
  expect(r.stderr.toString()).not.toContain('S="Error"') // stderr 另有「Preparing modules」的進度 CLIXML，不算錯
  const got = [...r.stdout.toString().matchAll(/<([^>]*)>/g)].map(m => m[1])
  expect(got).toEqual(['--name', name, '--session-id', 'sid-1', '--model', name, task])
  expect(r.stdout.toString()).not.toMatch(/^PWNED/m)
}, 20000) // 開 PowerShell 在忙的電腦上要好幾秒

test('folderTrusted：往上找到信任過的就算；Windows 路徑不分大小寫、斜線方向；設定檔讀不到回 undefined', () => {
  const c = join(base, 'c2'); mkdirSync(c, { recursive: true })
  writeFileSync(join(c, '.claude.json'), JSON.stringify({ projects: { 'C:/Users/me': { hasTrustDialogAccepted: true }, 'C:/Users/me/x': { hasTrustDialogAccepted: false }, '/home/me/p': { hasTrustDialogAccepted: true } } }))
  expect(folderTrusted('c:\\users\\ME\\x\\y', c)).toBe(true)
  expect(folderTrusted('C:\\Users\\other', c)).toBe(false)
  expect(folderTrusted('/home/me/p/sub', c)).toBe(true)
  expect(folderTrusted('/home/me', c)).toBe(false)
  expect(folderTrusted('/x', join(base, 'nope'))).toBeUndefined()
  writeFileSync(join(c, '.claude.json'), JSON.stringify({ projects: { 'D:/': { hasTrustDialogAccepted: true } } }))
  expect(folderTrusted('D:\\a\\b', c)).toBe(true)
})

test('90 秒沒進辦公室：出現 Windows 通知卡（沒有選項）；進來了就拿掉', async () => {
  watchWinHire('s1', '小華', undefined, Date.now() - 91e3, () => true, 10)
  await Bun.sleep(40)
  const v = stuckView()
  expect(v.length).toBe(1)
  expect(v[0]).toMatchObject({ name: '小華', session: '小華', win: true, options: [] })
  people = [{ id: 's1', name: '小華' }]
  await Bun.sleep(40)
  expect(stuckView().length).toBe(0)
})

test('90 秒內進辦公室不出卡；視窗程序結束了也不出卡', async () => {
  people = [{ id: 's2', name: 'E' }]
  watchWinHire('s2', 'E', undefined, Date.now() - 91e3, () => true, 10)
  watchWinHire('s3', 'F', 99, Date.now() - 91e3, () => false, 10)
  await Bun.sleep(40)
  expect(stuckView().length).toBe(0)
})

test('招聘記下 sid → PowerShell pid；解雇時父程序對得上才一起關視窗', () => {
  const r = hireWindows({ name: 'G', dir: work })
  expect(winLaunches()[r.sid!].pid).toBe(4242)
  expect(winWindowOf(r.sid!, 777, () => 4242)).toBe(4242)
  expect(winWindowOf(r.sid!, 777, () => 5555)).toBeUndefined() // pid 被別的程序重用
  expect(winWindowOf(r.sid!, 777, () => undefined)).toBeUndefined()
  expect(winWindowOf('not-ours', 777, () => 4242)).toBeUndefined()
})

test('啟動紀錄超過 7 天的會清掉', () => {
  winLaunchSet('old', 1, Date.now() - 8 * 86400e3)
  winLaunchSet('new', 2)
  expect(winLaunches().old).toBeUndefined()
  expect(winLaunches().new.pid).toBe(2)
})

test.skipIf(process.platform !== 'win32')('叫角色（Windows）：帶 --card、主管、主管身分；在線（結束碼 3）回改傳話；沒信任過的資料夾先問', () => {
  const { summonRole } = require('./hr')
  const r = summonRole({ name: 'office測試', card: join(base, 'card.md'), cwd: work, team: 'office設計', b: { perm: 'auto' } })
  expect(r.ok).toBe(true)
  const a = calls[0].args
  expect(arg(a, '--role')).toBe('office測試')
  expect(arg(a, '--card')).toBe(join(base, 'card.md'))
  expect(arg(a, '--dir')).toBe(work)
  expect(arg(a, '--team')).toBe('office設計')
  expect(arg(a, '--role-type')).toBe('staff')
  expect(arg(a, '--model')).toBe('opus')
  expect(arg(a, '--permission-mode')).toBe('auto')
  expect(a).not.toContain('--name-only')
  expect(summonRole({ name: 'P', card: 'c', cwd: work, manager: true, b: {} }).ok).toBe(true)
  expect(arg(calls[1].args, '--role-type')).toBe('manager')
  expect(calls[1].args).not.toContain('--team')
  expect(summonRole({ name: 'P', card: 'c', cwd: fresh, b: {} })).toMatchObject({ ok: false, need: 'trust' })
  const keep = reply
  reply = () => ({ code: 3, out: JSON.stringify({ error: 'STOP: x already online', code: 3 }) + '\n', err: '' })
  try { expect(summonRole({ name: 'P', card: 'c', cwd: work, b: {} })).toMatchObject({ ok: false, online: true, text: 'P 已經在線：改傳話給他' }) } finally { reply = keep }
  expect(summonRole({ name: 'P', card: 'c', cwd: join(base, 'nope'), b: {} }).text).toContain('資料夾不存在')
})

test('folderTrusted：在 git repo 裡只找到 git 根目錄（上層信任過不算）；不在 repo 裡照舊往上找', () => {
  const g = join(base, 'g'), repo = join(g, 'repo'), sub = join(repo, 'sub'), plain = join(g, 'plain', 'x'), c = join(base, 'c3')
  for (const d of [join(repo, '.git'), sub, plain, c]) mkdirSync(d, { recursive: true })
  writeFileSync(join(c, '.claude.json'), JSON.stringify({ projects: { [fwd(g)]: { hasTrustDialogAccepted: true } } }))
  expect(folderTrusted(sub, c)).toBe(false)
  expect(folderTrusted(repo, c)).toBe(false)
  expect(folderTrusted(plain, c)).toBe(true)
  writeFileSync(join(c, '.claude.json'), JSON.stringify({ projects: { [fwd(repo)]: { hasTrustDialogAccepted: true } } }))
  expect(folderTrusted(sub, c)).toBe(true)
  rmSync(join(repo, '.git'), { recursive: true }); writeFileSync(join(repo, '.git'), 'gitdir: x') // worktree 的 .git 是檔案：也算 git 根目錄
  writeFileSync(join(c, '.claude.json'), JSON.stringify({ projects: { [fwd(g)]: { hasTrustDialogAccepted: true } } }))
  expect(folderTrusted(sub, c)).toBe(false)
})

test('open_role 逾時（結束碼 null）：說開窗程式沒回應，不寫結束碼', () => {
  const keep = reply
  reply = () => ({ code: null as any, out: '', err: '', ms: 20003 })
  try { expect(hireWindows({ name: 'T', dir: work }).text).toBe('開不起來：開窗程式 20 秒沒有回應，電腦上可能沒開出視窗') } finally { reply = keep }
})

test('結束碼 null 但沒到 20 秒：帶訊號、毫秒、stderr 最後幾行', () => {
  const keep = reply
  reply = () => ({ code: null as any, out: '', err: 'a\nb\nc\nTraceback: boom\n', sig: 'SIGKILL', ms: 3012 })
  try { expect(hireWindows({ name: 'T', dir: work }).text).toBe('開不起來：開窗程式被中斷（訊號 SIGKILL、3012 毫秒）：b / c / Traceback: boom；電腦上可能沒開出視窗') } finally { reply = keep }
})

test('結束碼 null 但已印出 sid（視窗開了才被中斷）：算開成，不重開', () => {
  const keep = reply
  reply = () => ({ code: null as any, out: JSON.stringify({ sid: '11111111-2222-3333-4444-555555555555', pid: 1 }) + '\n', err: '', ms: 3000 })
  try { const r = hireWindows({ name: 'T', dir: work }); expect(r.ok).toBe(true); expect(r.sid).toBe('11111111-2222-3333-4444-555555555555') } finally { reply = keep }
})

test('沒信任過的提示附實際路徑；90 秒提醒卡帶資料夾', async () => {
  expect(hireWindows({ name: 'B', dir: fresh }).text).toContain(fresh)
  watchWinHire('s9', '小李', undefined, Date.now() - 91e3, () => true, 10, join(base, 'somewhere'))
  await Bun.sleep(40)
  expect(stuckView()[0]).toMatchObject({ name: '小李', dir: join(base, 'somewhere') })
  people = [{ id: 's9', name: '小李' }]
  await Bun.sleep(40)
})

test('關掉（可 --resume）：不在線的回原因、不動任何東西', async () => {
  const { closeSession } = require('./hr')
  expect(await closeSession('not-here')).toEqual({ ok: false, text: '這位已經不在線' })
})

test('核准被擋：對話紀錄有「pixel-office 的 classic.PermissionRequest 被跳過」就回擋住的 plugin；其他 hook 被跳過不算', () => {
  const { hookSkipOf } = require('./hr')
  const c = join(base, 'cfgs'), id = 'sess-hook-1'
  mkdirSync(join(c, 'sessions'), { recursive: true }); mkdirSync(join(c, 'projects', 'p'), { recursive: true }); mkdirSync(join(base, 'sessions'), { recursive: true })
  writeFileSync(join(base, 'sessions', `${id}.json`), JSON.stringify({ addr: `/tmp/cc-socks/${process.pid}.sock`, configDir: c }))
  writeFileSync(join(c, 'sessions', `${process.pid}.json`), JSON.stringify({ sessionId: id, cwd: work, entrypoint: 'cli' }))
  const info = (hook: string) => JSON.stringify({ type: 'system', subtype: 'informational', content: `pixel-office: its classic.${hook} hook was skipped. "sec-plugin" runs first and sent the event on past it.`, timestamp: '2026-11-26T15:49:19.976Z' })
  const f = join(c, 'projects', 'p', `${id}.jsonl`)
  writeFileSync(f, info('PreToolUse') + '\n')
  expect(hookSkipOf(id)).toBeUndefined()
  writeFileSync(f, info('PreToolUse') + '\n' + info('PermissionRequest') + '\n')
  expect(hookSkipOf(id)).toBe('sec-plugin')
  expect(hookSkipOf('nobody')).toBeUndefined()
})
