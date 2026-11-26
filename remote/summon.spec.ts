// bun test remote/summon.spec.ts：手機叫角色、開專案（設計 windows-hire 4.）。cards.py、open_role.py 換成假的；
// 只收清單裡有的代號、手機拿不到卡的路徑、已在線不開
import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { _setOpenRoleRun } from './hr'
import { _setCardsRun, cardCode, projectCards, summonAt } from './server'

const dir = mkdtempSync(join(tmpdir(), 'po-summon-'))
const CARD = join(dir, 'roles', '小隊長.md')
const calls: string[][] = []
const oldCards = _setCardsRun(args => {
  calls.push(args)
  if (args[0] === 'projects') return { projects: [{ project_dir: dir, name: 'demo', managers: ['老闆'], roles: [{ name: 'po-summon-測試主管', file: CARD, desc: '管一切', top: true }] }] }
  if (args[0] === 'launch') return { ready: null, fallback: null, choices: [], has_start: true }
})
const opened: string[][] = []
let code = 0
const oldOpen = _setOpenRoleRun(args => { opened.push(args); return code ? { code, out: JSON.stringify({ error: 'STOP', code }) + '\n', err: '' } : { code: 0, out: JSON.stringify({ error: 'fake: not opened', code: 1 }) + '\n', err: '' } })
afterAll(() => { _setCardsRun(oldCards); _setOpenRoleRun(oldOpen); rmSync(dir, { recursive: true, force: true }) })

test('開專案清單：手機那份只有代號、名字、說明、分組、在線主管，沒有卡的路徑', () => {
  const r = projectCards()
  expect(r.ok).toBe(true)
  const c = (r as any).list[0]
  expect(c).toMatchObject({ code: cardCode(CARD), name: 'po-summon-測試主管', desc: '管一切', group: 'demo', managers: ['老闆'] })
})

test('/summon：kind 錯、代號不在清單、被點的人不在線，都不開', () => {
  expect(summonAt({ kind: 'x', code: 'a' }).text).toBe('kind 要是 member 或 project')
  expect(summonAt({ kind: 'project', code: 'deadbeef0000' }).text).toBe('不在清單上的角色卡')
  expect(summonAt({ kind: 'project', code: CARD }).text).toBe('不在清單上的角色卡') // 送路徑也不收
  expect(summonAt({ kind: 'member', id: 'nobody-here', code: cardCode(CARD) }).text).toBe('這位已經不在線')
  expect(opened).toHaveLength(0)
})

test('/summon 開專案：沒有啟動位置就開在專案資料夾、主管身分；open_role 說已在線（3）回改傳話', () => {
  code = 3
  const r = summonAt({ kind: 'project', code: cardCode(CARD), trustOk: true })
  if (process.platform === 'win32') {
    expect(r).toMatchObject({ ok: false, online: true })
    const a = opened.at(-1)!
    expect(a[a.indexOf('--dir') + 1]).toBe(dir)
    expect(a[a.indexOf('--card') + 1]).toBe(CARD)
    expect(a[a.indexOf('--role-type') + 1]).toBe('manager')
  }
  code = 0
})
