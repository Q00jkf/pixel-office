// bun test remote/winhire.spec.ts：Windows 招聘（設計 windows-hire 第 1 期）。open_role.py 換成假的，看傳了什麼參數；
// 資料夾信任的判斷、90 秒沒進辦公室的通知卡。任何平台都能跑（直接呼叫 hireWindows，不經 process.platform）
import { afterAll, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _setOpenRoleRun, _stuck, CODEX_WIN_TEXT, folderTrusted, hireWindows, initHr, openRoleArgv, runOpenRole, stuckView, watchWinHire, type Person } from './hr'

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

test('runOpenRole：輸出不是 JSON 時拿 stderr 最後一行', () => {
  const keep = reply
  reply = () => ({ code: 1, out: '', err: 'Traceback\nValueError: boom\n' })
  try { expect(runOpenRole(['--role', 'x'])).toEqual({ error: 'ValueError: boom', code: 1 }) } finally { reply = keep }
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
