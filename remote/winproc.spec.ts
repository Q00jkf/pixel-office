// bun test remote：Windows 的 session 找 pid（0.63.61）。addr 是 named pipe 沒有 pid，改從 <configDir>/sessions/<pid>.json 用 sessionId 找
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pidBySession } from './hr'

const dir = mkdtempSync(join(tmpdir(), 'po-winproc-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

test('pidBySession: finds the live pid for a session id; skips dead pids, other sessions and odd files', () => {
  const me = process.pid
  writeFileSync(join(dir, `${me}.json`), JSON.stringify({ sessionId: 'aaa', cwd: dir }))
  writeFileSync(join(dir, '999999.json'), JSON.stringify({ sessionId: 'aaa' })) // 已結束的 pid（強制結束留下的）
  writeFileSync(join(dir, '12.json.bak'), JSON.stringify({ sessionId: 'aaa' }))
  utimesSync(join(dir, '999999.json'), new Date(), new Date(Date.now() + 60e3))
  expect(pidBySession(dir, 'aaa')).toBe(me)
  expect(pidBySession(dir, 'bbb')).toBeUndefined()
  expect(pidBySession(join(dir, 'missing'), 'aaa')).toBeUndefined()
})
