// bun test remote/agyhire.spec.ts：手機招聘、叫角色用 agy（0.64.5，只有 Windows）。open_role.py 換成假的，看傳了什麼參數；
// 暫代座位（agp-）照狀態檔的 launch 換到 agy-<對話 id>
import { afterAll, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _setOpenRoleRun, agyByLaunch, agyInstalled, agyModeArgs, hireWindows, initHr, summonRole, type Person } from './hr'
import { resolveAgyPins } from './server'
import { parseStore } from '../hooks/officeV2'

const base = mkdtempSync(join(tmpdir(), 'po-agyhire-'))
const work = join(base, 'work'), sess = join(base, 'sessions')
for (const d of [work, sess]) mkdirSync(d, { recursive: true })
initHr({ base, hireConfigDir: () => join(base, 'cfg'), hireDirs: () => [{ name: '工作', path: work }], people: () => [] as Person[], sendCommand: () => undefined, port: () => 8782 })
let calls: string[][] = []
const old = _setOpenRoleRun(args => { calls.push(args); return { code: 0, out: JSON.stringify({ sid: 'agp-1234abcd', pid: 4242 }) + '\n', err: '' } })
afterAll(() => { _setOpenRoleRun(old); rmSync(base, { recursive: true, force: true }) })
beforeEach(() => { calls = [] })
const arg = (a: string[], k: string) => a[a.indexOf(k) + 1]
const win = agyInstalled()

test('agyModeArgs：模型照帶（default 不帶）、投入程度可省、模式只收 agy 有的', () => {
  expect(agyModeArgs({})).toEqual({ args: ['--permission-mode', 'auto'] })
  expect(agyModeArgs({ model: 'gemini-3.8-flash-low', effort: 'low', perm: 'plan' })).toEqual({ args: ['--model', 'gemini-3.8-flash-low', '--effort', 'low', '--permission-mode', 'plan'] })
  expect(agyModeArgs({ model: 'default', perm: 'default' })).toEqual({ args: ['--permission-mode', 'default'] })
  expect(agyModeArgs({ perm: 'bypassPermissions' })).toBe('不認得的模式')
  expect(agyModeArgs({ model: '--evil' })).toBe('不認得的模型')
  expect(agyModeArgs({ effort: 'huge' })).toBe('不認得的投入程度')
})

test.skipIf(!win)('招聘 agy：帶 --agent agy、不帶 --session-id／--remote-control；英數字名字當名牌；不能當主管', () => {
  const r = hireWindows({ agent: 'agy', name: 'QA1', model: 'gemini-3.8-flash-low', perm: 'auto', team: 'willy主管', task: '看一下' })
  expect(r.ok).toBe(true)
  expect(r.sid).toBe('agp-1234abcd')
  const a = calls[0]
  expect(arg(a, '--agent')).toBe('agy')
  expect(arg(a, '--role')).toBe('QA1')
  expect(arg(a, '--plate')).toBe('QA1')
  expect(arg(a, '--team')).toBe('willy主管')
  expect(arg(a, '--model')).toBe('gemini-3.8-flash-low')
  expect(a).toContain('--task-file')
  expect(a).not.toContain('--session-id')
  expect(a).not.toContain('--remote-control')
  hireWindows({ agent: 'agy', name: '小明' })
  expect(calls[1]).not.toContain('--plate')
  expect(hireWindows({ agent: 'agy', name: 'X', role: 'manager' }).ok).toBe(false)
})

test.skipIf(!win)('叫角色用 agy：帶 --agent agy、--card；主管不行；在線（結束碼 3）回改傳話', () => {
  const r = summonRole({ name: '測試員', card: join(work, '測試員.md'), cwd: work, team: '主管A', b: { agent: 'agy' } })
  expect(r.ok).toBe(true)
  expect(arg(calls[0], '--agent')).toBe('agy')
  expect(arg(calls[0], '--card')).toBe(join(work, '測試員.md'))
  expect(summonRole({ name: '主管', card: 'x', cwd: work, manager: true, b: { agent: 'agy' } }).ok).toBe(false)
  _setOpenRoleRun(() => ({ code: 3, out: JSON.stringify({ error: 'STOP', code: 3 }) + '\n', err: '' }))
  expect(summonRole({ name: '測試員', card: 'x', cwd: work, b: { agent: 'agy' } }).online).toBe(true)
  _setOpenRoleRun(args => { calls.push(args); return { code: 0, out: JSON.stringify({ sid: 'agp-1234abcd', pid: 4242 }) + '\n', err: '' } })
})

test('agyByLaunch：照狀態檔的 launch 找 agy；離開的不算', () => {
  writeFileSync(join(sess, 'agy-c1.json'), JSON.stringify({ id: 'agy-c1', kind: 'agy', launch: 'agp-aaaaaaaa' }))
  writeFileSync(join(sess, 'agy-c2.json'), JSON.stringify({ id: 'agy-c2', kind: 'agy', launch: 'agp-bbbbbbbb', left: true }))
  expect(agyByLaunch('agp-aaaaaaaa', sess)).toBe('agy-c1')
  expect(agyByLaunch('agp-bbbbbbbb', sess)).toBeUndefined()
  expect(agyByLaunch('agp-cccccccc', sess)).toBeUndefined()
})

test('resolveAgyPins：上線了就把座位換過去；30 分鐘沒來放掉', () => {
  const S = parseStore(JSON.stringify({ tables: [{ id: 1, name: 'A', size: 4 }], pins: { 'agp-aaaaaaaa': 't1.2', 'agp-dddddddd': 't1.3' } }))
  const look = (k: string) => (k === 'agp-aaaaaaaa' ? 'agy-c1' : undefined)
  resolveAgyPins(S, [{ id: 'agy-c1' }], 1_000_000, look, false)
  expect(S.pins['agy-c1']).toBe('t1.2')
  expect(S.pins['agp-aaaaaaaa']).toBeUndefined()
  expect(S.pins['agp-dddddddd']).toBe('t1.3')
  resolveAgyPins(S, [], 1_000_000 + 31 * 60e3, look, false)
  expect(S.pins['agp-dddddddd']).toBeUndefined()
})
