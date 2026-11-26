import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CURRENT_MARK, cell, collabText, markCurrent, writeAtomic, writeCollab, teamPlan, teamPreview, teamUp, teamVersion, type TeamDeps, type TeamGroup, type TeamPerson } from './teamup'
import { emptyStore, groupView, tablesOut } from '../hooks/officeV2'

const boss: TeamPerson = { id: 'b1', plate: '主管', agent: '協作主管', role: 'manager' }
const a: TeamPerson = { id: 'a1', plate: '甲', agent: '工程師甲', title: '前端', role: 'staff' }
const c: TeamPerson = { id: 'codex-x', plate: '驗證', agent: 'Codex驗證', kind: 'codex' }
const g: TeamPerson = { id: 'agy-1', plate: '小g', kind: 'agy' }

type Opt = { fail?: string[]; unsure?: string[]; dir?: string; slow?: boolean; saveFails?: boolean; orderThrows?: string; askFails?: string; other?: string }
function rig(people: TeamPerson[], o: Opt = {}) {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), 'teamup-'))
  const log = { orders: [] as [string, object][], asks: [] as string[], sent: [] as [string, string][], mails: [] as [string, string][], saved: [] as TeamGroup[] }
  let group: TeamGroup | undefined
  const D: TeamDeps = {
    table: id => (id === 3 ? { name: '三號桌', people, group } : undefined),
    elsewhere: () => o.other,
    dir: () => dir,
    order: (p, x) => { if (p.id === o.orderThrows) throw new Error('disk'); if (p.kind === 'agy') return false; log.orders.push([p.id, x]); return true },
    deliver: async (p, text) => {
      if (o.slow) await new Promise(r => setTimeout(r, 20))
      if (o.fail?.includes(p.id)) return { state: 'failed', text: '不在線' }
      if (o.unsure?.includes(p.id)) return { state: 'unsure' }
      log.sent.push([p.id, text]); return { state: 'sent' }
    },
    mail: (to, text) => { log.mails.push([to, text]); return true },
    save: (_id, x) => { if (o.saveFails) return false; group = x; log.saved.push(x); return true },
  }
  const ver = () => (teamPreview(3, D) as any).ver as string
  const go = () => teamUp(3, ver(), D, 1000)
  return { D, dir, log, ver, go, setPeople: (ps: TeamPerson[]) => people.splice(0, people.length, ...ps), group: () => group }
}

describe('teamPlan', () => {
  test('沒主管、兩位主管、主管不是 Claude、主管沒有 ListAgents 名稱都不做', () => {
    expect((teamPlan([a]) as any).text).toContain('先指定主管')
    expect((teamPlan([boss, { ...a, role: 'manager' }]) as any).text).toContain('2 位主管')
    expect((teamPlan([{ ...c, role: 'manager' }, a]) as any).text).toContain('只能是 Claude')
    expect((teamPlan([{ ...boss, agent: undefined }, a]) as any).text).toContain('還沒有 ListAgents 名稱')
    expect(teamPlan([]).ok).toBe(false)
  })
  test('一位主管：其他人是成員，team＝主管的 ListAgents 名稱', () => {
    const r = teamPlan([a, boss, c])
    expect(r.ok && r.team).toBe('協作主管')
    expect(r.ok && r.members.map(p => p.id)).toEqual(['a1', 'codex-x'])
  })
})

describe('collabText', () => {
  const o = (members: TeamPerson[]) => ({ team: '協作主管', members, table: '三號桌', now: new Date(2026, 10, 25).getTime() })
  test('沒有 collab.md：六段骨架，主管列＋成員列', () => {
    const r = collabText(undefined, o([a, c]))
    expect(r.created).toBe(true)
    for (const h of ['# 主管', '# 在線', '# 檔案佔用', '# 待使用者裁示', '# 等外部回覆', '# 衝突紀錄']) expect(r.text).toContain(h)
    expect(r.text).toContain('| 協作主管 | 協作桌「三號桌」 |  | 2026-11-25 |') // 現任標記等主管令寫好才標
    expect(r.text).toContain('| 工程師甲 | 前端 |  |  |')
    expect(r.text.indexOf('工程師甲')).toBeGreaterThan(r.text.indexOf('# 在線'))
    expect(r.text.indexOf('工程師甲')).toBeLessThan(r.text.indexOf('# 檔案佔用'))
  })
  test('已有：不覆蓋，只補沒有的列；全都有就不改', () => {
    const old = '# 主管\n| 主管 | 範圍 | 上層 | 上線 |\n|---|---|---|---|\n| 協作主管 | 使用者寫的範圍 |  | 2026-11-01 |\n# 在線\n| session | 角色 | 任務 | 上次回報 |\n|---|---|---|---|\n| 工程師甲 | 前端 | 修 bug | 11/24 |\n\n# 待使用者裁示\n| # | 事項 | 細節在哪 | 登記日 |\n|---|---|---|---|\n| 1 | 要不要發布 | x.md | 11/25 |\n'
    const r = collabText(old, o([a, c]))
    expect(r.added).toEqual(['Codex驗證'])
    expect(r.text).toContain('| 協作主管 | 使用者寫的範圍 |')
    expect(r.text).toContain('| 工程師甲 | 前端 | 修 bug | 11/24 |')
    expect(r.text.indexOf('Codex驗證')).toBeLessThan(r.text.indexOf('# 待使用者裁示'))
    expect(collabText(r.text, o([a, c])).added).toEqual([])
  })
  test('段在但沒表頭：先補表頭；段不在：補在檔尾含表頭', () => {
    const r = collabText('# 主管\n# 在線\n說明文字\n# 檔案佔用\n', o([a]))
    expect(r.text).toContain('# 主管\n| 主管（ListAgents 名稱） |')
    expect(r.text).toContain('# 在線\n| session | 角色 | 任務 | 上次回報 |\n|---|---|---|---|\n| 工程師甲 | 前端 |  |  |\n說明文字\n# 檔案佔用')
    const r2 = collabText('# 主管\n|---|\n', o([a]))
    expect(r2.text).toContain('# 在線\n| session | 角色 | 任務 | 上次回報 |\n|---|---|---|---|\n| 工程師甲 |')
  })
  test('同一批同名只加一列；| ` < > & 可逆跳脫，重做不會多列', () => {
    const r = collabText(undefined, o([a, { ...a, id: 'a2' }, { ...a, id: 'x', agent: 'x|`<b>&' }]))
    expect(r.text.match(/工程師甲/g)!.length).toBe(1)
    expect(r.text).toContain('| x&#124;&#96;&lt;b&gt;&amp; |')
    expect(collabText(r.text, o([{ ...a, id: 'x', agent: 'x|`<b>&' }])).added).toEqual([])
    expect(cell('a  b')).toBe('a b')
  })
})

describe('teamUp', () => {
  test('寫 collab.md 與 .gitignore、登記、通知每個人；做完標 complete', async () => {
    const { log, dir, go, group } = rig([boss, a, c, g])
    const r = await go()
    expect(r.ok).toBe(true)
    expect(r.text).toContain('已成組')
    expect(log.orders).toEqual([['b1', { role: 'manager', team: 'off' }], ['a1', { team: '協作主管' }], ['codex-x', { team: '協作主管' }]])
    expect(log.sent[2][1]).toContain('請你自己用 office_profile 工具把 team 設成「協作主管」') // agy：不另送指令、不說已替你登記（BUG-3）
    expect(log.sent[2][1]).not.toContain('已替你登記')
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('collab.md\ncheckpoints/\n')
    expect(log.sent.map(x => x[0])).toEqual(['a1', 'codex-x', 'agy-1', 'b1'])
    expect(log.sent[0][1]).toContain('你的主管是 協作主管')
    expect(log.sent[0][1]).toContain(join(dir, 'collab.md'))
    expect(log.sent[3][1]).toContain('辦公室已登記 team=你：工程師甲（甲）、Codex驗證（驗證）')
    expect(log.sent[3][1]).toContain('請他自己設定 team（agy，辦公室改不了）：小g')
    expect(log.sent[3][1]).not.toContain('他們的 team 已登記成你')
    expect(group()).toEqual({ boss: 'b1', team: '協作主管', notified: ['a1', 'codex-x', 'agy-1', 'b1'], bossKnows: ['a1', 'codex-x', 'agy-1'], dir, at: 1000, complete: true })
    log.sent.length = 0
    await go()
    expect(log.sent).toEqual([]) // agy 通知到就記入去重，重按不再收（BUG-3）
  })
  test('確認卡版本不符（有人換桌、換主管）：什麼都不做', async () => {
    const people = [boss, a]
    const { D, dir, log, ver, setPeople } = rig(people)
    const v = ver()
    setPeople([boss, a, c])
    const r = await teamUp(3, v, D)
    expect(r).toEqual({ ok: false, text: '桌上有變動（人、主管或協作資料夾），請重看確認卡' })
    expect(log.orders).toEqual([])
    expect(existsSync(join(dir, 'collab.md'))).toBe(false)
    expect(teamVersion(3, 'b1', 'B', 'off', ['a1', 'x'], '/d')).toBe(teamVersion(3, 'b1', 'B', 'off', ['x', 'a1'], '/d'))
    expect(teamVersion(3, 'b1', 'B', 'off', ['a1'], '/d')).not.toBe(teamVersion(3, 'b1', 'B', 'off', ['a1'], '/e'))
    // 主管同一個 id 改了 ListAgents 名稱、或要寫的上層變了：版本也不同（複驗第 3 列）
    expect(teamVersion(3, 'b1', 'B', 'off', ['a1'], '/d')).not.toBe(teamVersion(3, 'b1', 'B2', 'off', ['a1'], '/d'))
    expect(teamVersion(3, 'b1', 'B', 'off', ['a1'], '/d')).not.toBe(teamVersion(3, 'b1', 'B', '總主管', ['a1'], '/d'))
  })
  test('重按冪等：不重複通知；新成員只通知他＋主管（新加入）', async () => {
    const people = [boss, a]
    const { log, go, setPeople, D } = rig(people)
    await go()
    log.sent.length = 0
    expect((await go()).text).toContain('這次沒有要通知的人')
    expect(log.sent).toEqual([])
    setPeople([boss, a, c])
    expect(teamPreview(3, D)).toMatchObject({ ok: true, notify: 2, again: true })
    await go()
    expect(log.sent.map(x => x[0])).toEqual(['codex-x', 'b1'])
    expect(log.sent[1][1]).toContain('新加入：Codex驗證（驗證）')
  })
  test('新成員一直送不到：主管不會每按一次就收「新加入」（BUG-2）；之後送到了才告訴主管一次', async () => {
    const people = [boss, a]
    const fail = ['codex-x']
    const { log, go, setPeople, group } = rig(people, { fail })
    await go()
    setPeople([boss, a, c])
    log.sent.length = 0
    await go(); await go()
    expect(log.sent).toEqual([])
    fail.length = 0
    await go()
    expect(log.sent.map(x => x[0])).toEqual(['codex-x', 'b1'])
    expect(log.sent[1][1]).toContain('新加入：Codex驗證（驗證）')
    expect(group()!.complete).toBe(true)
    log.sent.length = 0
    await go()
    expect(log.sent).toEqual([])
  })
  test('成員通知到了、主管這次沒收到：下次只補告訴主管', async () => {
    const people = [boss, a]
    const unsure: string[] = []
    const { log, go, setPeople, group } = rig(people, { unsure })
    await go()
    setPeople([boss, a, c])
    unsure.push('b1') // 主管這次「不確定有沒有收到」（送不到的 Claude 會進信箱、算收到）
    await go()
    expect(group()!.complete).toBe(false)
    unsure.length = 0; log.sent.length = 0
    await go()
    expect(log.sent.map(x => x[0])).toEqual(['b1'])
    expect(group()!.complete).toBe(true)
  })
  test('換了主管＝新的一組，全部重新通知；新主管 team 清成 off；collab.md 舊主管列（手填範圍、上層、日期）不動，只補新主管一列（複驗第 4 列）', async () => {
    const people = [boss, a]
    const { log, go, setPeople, dir } = rig(people)
    await go()
    const f = join(dir, 'collab.md')
    writeFileSync(f, readFileSync(f, 'utf8').replace(/\| 協作主管 \|[^\n]*/, '| 協作主管 | 使用者說：管前端與發布 | 總主管 | 2026-11-01 |'))
    log.sent.length = 0; log.orders.length = 0
    setPeople([{ ...boss, role: 'staff', team: '工程師甲' }, { ...a, role: 'manager', team: '協作主管' }])
    const r = await go()
    expect(log.sent.map(x => x[0]).sort()).toEqual(['a1', 'b1'])
    expect(log.orders[0]).toEqual(['a1', { role: 'manager', team: 'off' }])
    const md = readFileSync(join(dir, 'collab.md'), 'utf8')
    const bossSec = md.slice(md.indexOf('# 主管'), md.indexOf('# 在線'))
    expect(bossSec).toContain('| 協作主管 | 使用者說：管前端與發布 | 總主管 | 2026-11-01 |')
    expect(bossSec).toContain('| 工程師甲 | 協作桌「三號桌」（現任，像素辦公室設成一組時標） |')
    expect(r.text).toContain('協作紀錄：')
  })
  test('主管的上層在別處（部門主管）：照寫回去，不清掉', async () => {
    const { log, go } = rig([{ ...boss, team: '總主管' }, a])
    await go()
    expect(log.orders[0]).toEqual(['b1', { role: 'manager', team: '總主管' }])
  })
  test('送不到：Claude 存信箱（只用 ListAgents 名稱，算通知過）；Codex 回報沒送到；沒做完不標已成組', async () => {
    const { log, go, group } = rig([boss, a, c], { fail: ['a1', 'codex-x'] })
    const r = await go()
    expect(log.mails.map(m => m[0])).toEqual(['工程師甲'])
    expect(r.ok).toBe(false)
    expect(r.text).toContain('存進信箱（上線時收到）：甲')
    expect(r.text).toContain('沒送到：驗證')
    expect(r.text).toContain('桌牌先不標「已成組」')
    expect(group()!.complete).toBe(false)
    expect(group()!.notified.sort()).toEqual(['a1', 'b1'])
  })
  test('沒有 ListAgents 名稱的 Claude 送不到：不存信箱', async () => {
    const t: TeamPerson = { id: 't1', plate: '無名', title: '工程師甲' }
    const { log, go } = rig([boss, t], { fail: ['t1'] })
    expect((await go()).text).toContain('沒送到：無名')
    expect(log.mails).toEqual([])
  })
  test('不確定有沒有送到：不算通知過，回報待確認，下次再送', async () => {
    const { log, go, group } = rig([boss, a], { unsure: ['a1'] })
    const r = await go()
    expect(r.text).toContain('待確認有沒有收到：甲')
    expect(group()!.notified).toEqual(['b1'])
    expect(group()!.complete).toBe(false)
    log.sent.length = 0
    await go()
    expect(log.sent).toEqual([]) // 還是 unsure：主管不會因為「新加入」再收一次
  })
  test('登記失敗的人不通知（不說已替你登記）、回報；只說做成的步驟', async () => {
    const { log, go, group } = rig([boss, a, g], { orderThrows: 'a1', fail: ['agy-1'] })
    const r = await go()
    expect(log.sent.map(x => x[0])).toEqual(['b1'])
    expect(r.text).toContain('沒登記成：甲（人事令寫不進去：disk）、小g（請他自己設定的通知沒送到）（再按會重試）')
    expect(r.text).toContain('主管 主管 已登記')
    expect(r.text).not.toContain('已登記成員')
    // 主管收到的通知照實分類（複驗第 6 列）
    expect(log.sent[0][1]).toContain('沒登記成：工程師甲（甲）（人事令寫不進去：disk）、小g（請他自己設定的通知沒送到）')
    expect(log.sent[0][1]).not.toContain('辦公室已登記 team=你')
    expect(group()!.complete).toBe(false)
  })
  test('協作紀錄寫不進去（collab.md 是連結）：什麼都不做', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamup-'))
    writeFileSync(join(dir, 'real.md'), 'x')
    symlinkSync(join(dir, 'real.md'), join(dir, 'collab.md'))
    const { log, go } = rig([boss, a], { dir })
    const r = await go()
    expect(r.ok).toBe(false)
    expect(r.text).toContain('沒有送出人事令或通知')
    expect(r.text).toContain(`資料夾：${dir}`) // 路徑、原因不截掉（BUG-6）
    expect(r.text).toContain('不是一般檔案')
    expect(log.orders).toEqual([])
    expect(log.sent).toEqual([])
    expect(readFileSync(join(dir, 'real.md'), 'utf8')).toBe('x')
  })
  test('同名主管已掛在別桌：不做，提示衝突', async () => {
    const { log, D } = rig([boss, a], { other: '舊桌' })
    expect((teamPreview(3, D) as any).text).toContain('已經掛在桌子「舊桌」')
    expect((await teamUp(3, 'x', D)).ok).toBe(false)
    expect(log.orders).toEqual([])
  })
  test('同桌同時按兩次：第二次直接回；狀態存不進去回報', async () => {
    const { log, D, ver } = rig([boss, a], { slow: true, saveFails: true })
    const v = ver()
    const [r1, r2] = await Promise.all([teamUp(3, v, D), teamUp(3, v, D)])
    expect(r2).toEqual({ ok: false, text: '這桌正在設成一組，等它做完再看結果' })
    expect(log.sent.map(x => x[0])).toEqual(['a1', 'b1'])
    expect(r1.ok).toBe(false)
    expect(r1.text).toContain('再按會重複通知')
  })
  test('已有 .gitignore 不蓋；桌號不對、找不到桌子', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamup-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.gitignore'), 'mine\n')
    const { D, go } = rig([boss], { dir })
    await go()
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('mine\n')
    expect((await teamUp(9, 'x', D)).text).toBe('找不到這張桌子')
    expect((await teamUp(1.5, 'x', D)).text).toBe('桌號不對')
  })
})

describe('teamUp 複驗第二輪', () => {
  test('協作檔寫失敗：清掉這次新建的 .gitignore 與空資料夾，並說清了什麼；原本就有的資料夾留著', () => {
    const root = mkdtempSync(join(tmpdir(), 'teamup-'))
    const dir = join(root, 'new1', 'new2')
    const failCollab = (f: string, t: string) => { if (f.endsWith('collab.md')) throw new Error('磁碟滿了'); writeFileSync(f, t) }
    let err = ''
    try { writeCollab(dir, { team: 'B', members: [a], table: 't', now: 0 }, failCollab) } catch (e) { err = String((e as Error).message) }
    expect(err).toContain('磁碟滿了')
    expect(err).toContain('已清掉這次新建的：.gitignore')
    expect(err).toContain(join(root, 'new1'))
    expect(existsSync(join(root, 'new1'))).toBe(false)
    expect(existsSync(root)).toBe(true)
    // 原本就有 .gitignore：不刪
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, '.gitignore'), 'mine\n')
    try { writeCollab(dir, { team: 'B', members: [a], table: 't', now: 0 }, failCollab) } catch (e) { err = String((e as Error).message) }
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe('mine\n')
    expect(err).not.toContain('已清掉')
  })
  test('寫到最後才發現別張桌也掛了同名主管：不記成這組，照實說', async () => {
    let calls = 0
    const { D, log } = rig([boss, a])
    const v = (teamPreview(3, D) as any).ver
    D.elsewhere = () => (++calls > 2 ? '別桌' : undefined) // 開頭兩次檢查都沒有，最後存之前才出現
    const r = await teamUp(3, v, D)
    expect(r.ok).toBe(false)
    expect(r.text).toContain('別張桌「別桌」剛剛也掛了主管 協作主管')
    expect(log.saved).toEqual([])
  })
  test('兩張桌同時用同一位主管名稱：第二張直接回', async () => {
    const r1 = rig([boss, a], { slow: true })
    const D2 = { ...r1.D, table: (id: number) => (id === 4 ? { name: '四號桌', people: [boss, c] } : undefined) }
    const v1 = r1.ver(), v2 = (teamPreview(4, D2) as any).ver
    const [x, y] = await Promise.all([teamUp(3, v1, r1.D), teamUp(4, v2, D2)])
    expect(x.ok).toBe(true)
    expect(y.text).toContain('正在另一張桌設成一組')
  })
  test('主管改了 ListAgents 名稱：大家重新通知（新聯絡名稱）', async () => {
    const people = [boss, a]
    const { log, go, setPeople } = rig(people)
    await go()
    log.sent.length = 0
    setPeople([{ ...boss, agent: '新主管名' }, a])
    await go()
    expect(log.sent.map(x => x[0])).toEqual(['a1', 'b1'])
    expect(log.sent[0][1]).toContain('你的主管是 新主管名')
  })
  test('協作資料夾換了：已通知過的人全部再收一則（新位置）', async () => {
    const people = [boss, a]
    const { D, log, go } = rig(people)
    await go()
    log.sent.length = 0
    const nd = mkdtempSync(join(tmpdir(), 'teamup-'))
    D.dir = () => nd
    await go()
    expect(log.sent.map(x => x[0])).toEqual(['a1', 'b1'])
    expect(log.sent[0][1]).toContain(join(nd, 'collab.md'))
  })
  test('preview 與 go 同一組條件：成員都通知過、只剩主管要補告知，預覽也算 1 位', async () => {
    const people = [boss, a]
    const unsure: string[] = []
    const { D, go, setPeople } = rig(people, { unsure })
    await go()
    setPeople([boss, a, c])
    unsure.push('b1')
    await go()
    expect(teamPreview(3, D)).toMatchObject({ notify: 1 })
  })
})

describe('teamUp 複驗第三輪（現任標記）', () => {
  const marks = (dir: string) => readFileSync(join(dir, 'collab.md'), 'utf8').split('\n').filter(l => l.includes(CURRENT_MARK))
  test('主管令寫好才標現任；主管令失敗就不標，回應照實說', async () => {
    const { go, dir, log } = rig([boss, a], { orderThrows: 'b1' })
    const r = await go()
    expect(marks(dir)).toEqual([])
    // 測試員 O-13：主管沒登記成就不登記成員、不通知、不記成組
    expect(r.text).toContain('主管 主管 沒登記成（人事令寫不進去：disk），這次沒有登記成員或送通知')
    expect(log.orders).toEqual([])
    expect(log.sent).toEqual([])
    expect(log.saved).toEqual([])
    const ok = rig([boss, a])
    await ok.go()
    expect(marks(ok.dir)).toEqual(['| 協作主管 | 協作桌「三號桌」（現任，像素辦公室設成一組時標） |  | ' + readFileSync(join(ok.dir, 'collab.md'), 'utf8').match(/\d{4}-\d{2}-\d{2}/)![0] + ' |'])
  })
  test('連續兩次換主管：只有一個現任，其他列只拿掉標記、其餘一字不動', async () => {
    const people = [boss, a, { ...c, kind: undefined, id: 'c1', role: 'staff' } as TeamPerson]
    const { go, setPeople, dir } = rig(people)
    await go()
    const f = join(dir, 'collab.md')
    writeFileSync(f, readFileSync(f, 'utf8').replace('| 協作主管 | 協作桌「三號桌」', '| 協作主管 | 使用者說：管前端 協作桌「三號桌」'))
    setPeople([{ ...boss, role: 'staff' }, { ...a, role: 'manager' }, people[2]])
    await go()
    setPeople([{ ...boss, role: 'staff' }, { ...a, role: 'staff' }, { ...people[2], role: 'manager' }])
    await go()
    const m = marks(dir)
    expect(m.length).toBe(1)
    expect(m[0].startsWith('| Codex驗證 |')).toBe(true)
    expect(readFileSync(f, 'utf8')).toContain('| 協作主管 | 使用者說：管前端 協作桌「三號桌」 |')
  })
  test('只補標現任時照實寫（O-14）', async () => {
    const { go, dir } = rig([boss, a])
    await go()
    const f = join(dir, 'collab.md')
    writeFileSync(f, readFileSync(f, 'utf8').split(CURRENT_MARK).join(''))
    const r = await go()
    expect(r.text).toContain(`協作紀錄：${f} 已標現任 協作主管`)
    expect(marks(dir).length).toBe(1)
  })
  test('markCurrent：沒有那列回 undefined；已標在別列的搬過來', () => {
    const t = `# 主管\n| 名 | 範圍 | 上層 | 上線 |\n|---|---|---|---|\n| A | 管 A${CURRENT_MARK} | X | d |\n| B | 管 B |  | d |\n# 在線\n`
    expect(markCurrent(t, 'Z')).toBeUndefined()
    expect(markCurrent(t, 'B')).toBe(`# 主管\n| 名 | 範圍 | 上層 | 上線 |\n|---|---|---|---|\n| A | 管 A | X | d |\n| B | 管 B${CURRENT_MARK} |  | d |\n# 在線\n`)
  })
  test('人事令錯誤原因不截掉路徑（O-11）', async () => {
    const long = '/Users/x/' + 'very-long-folder/'.repeat(12) + 'orders/b1.json'
    const { D, ver } = rig([boss, a])
    const v = ver()
    D.order = () => { throw new Error(`EACCES: permission denied, open '${long}'`) }
    const r = await teamUp(3, v, D)
    expect(r.text).toContain(long)
  })
  test('markCurrent：只動範圍欄；舊版（設成一組時加）的標記也拿掉；跳脫的直線不當分隔', () => {
    const t = `# 主管\n|---|---|---|---|\n| A | 管 A（現任，像素辦公室設成一組時加） | X | d |\n| B | 管 a\\|b | 上層（現任，像素辦公室設成一組時標） | d |\n# 在線\n`
    const r = markCurrent(t, 'B')!
    expect(r).toContain('| A | 管 A | X | d |')
    expect(r).toContain(`| B | 管 a\\|b${CURRENT_MARK} | 上層（現任，像素辦公室設成一組時標） | d |`) // 上層欄的同字樣不動
  })
  test('agy 不確定有沒有送到：歸待確認，不歸沒登記成', async () => {
    const { go } = rig([boss, g], { unsure: ['agy-1'] })
    const r = await go()
    expect(r.text).toContain('待確認有沒有收到：小g')
    expect(r.text).not.toContain('沒登記成')
    expect(r.ok).toBe(false)
  })
  test('執行中主管換了：不記成這組，照實說', async () => {
    const people = [boss, a]
    const { D, log, setPeople } = rig(people)
    const v = (teamPreview(3, D) as any).ver
    const deliver = D.deliver
    D.deliver = async (p, t) => { const r = await deliver(p, t); if (p.id === 'b1') setPeople([{ ...boss, role: 'staff' }, { ...a, role: 'manager' }]); return r }
    const r = await teamUp(3, v, D)
    expect(r.ok).toBe(false)
    expect(r.text).toContain('這桌的主管剛剛換了')
    expect(log.saved).toEqual([])
  })
})

describe('writeAtomic 短寫（第五輪複驗第 1 項）', () => {
  test('只寫進一部分：不換上去、清掉暫存檔、保留原檔、丟錯', () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamup-'))
    const f = join(dir, 'collab.md')
    writeFileSync(f, '原本的內容\n')
    const short = (fd: number, t: string) => { writeSync(fd, Buffer.from(t).subarray(0, 5)) }
    expect(() => writeAtomic(f, '新的內容很長很長\n', short)).toThrow('寫入不完整')
    expect(readFileSync(f, 'utf8')).toBe('原本的內容\n')
    expect(readdirSync(dir)).toEqual(['collab.md'])
    writeAtomic(f, '新的內容\n')
    expect(readFileSync(f, 'utf8')).toBe('新的內容\n')
  })
})

describe('groupView／tablesOut', () => {
  const G: TeamGroup = { boss: 'b1', team: 'B', notified: ['b1', 'a1'], at: 0, complete: true }
  test('做完、記的主管還坐著而且是唯一主管才算已成組；未登記、未通知分開數', () => {
    const sit = [{ id: 'b1', role: 'manager' }, { id: 'a1', team: 'B' }, { id: 'n1' }]
    expect(groupView(G, sit)).toEqual({ grouped: true, groupUnreg: 1, groupUnnotified: 1 })
    expect(groupView({ ...G, complete: false }, sit)).toEqual({ groupPartial: true, groupUnreg: 1, groupUnnotified: 1 })
    expect(groupView(G, [...sit, { id: 'm2', role: 'manager' }])).toEqual({}) // 多了一位主管
    expect(groupView(G, sit.slice(1))).toEqual({}) // 主管不在
  })
  test('tablesOut 帶出 grouped', () => {
    const S = emptyStore()
    S.tables.push({ id: 1, name: 'x', size: 4, group: G })
    const ppl = [{ id: 'b1', plate: 'B', role: 'manager' }, { id: 'a1', plate: 'A', team: 'B' }] as any
    const map = new Map([['b1', 't1.0'], ['a1', 't1.1']])
    expect(tablesOut(S, ppl, map)[0]).toMatchObject({ grouped: true, groupUnreg: 0, groupUnnotified: 0 })
  })
})
