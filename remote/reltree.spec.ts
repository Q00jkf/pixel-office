// bun test remote/reltree.spec.ts：手機「關係」分頁的樹（v2/scene.js relTree，設計 windows-hire 5.）。從 scene.js 原始碼抽出那段來跑
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = readFileSync(join(import.meta.dir, 'v2', 'scene.js'), 'utf8')
const body = src.slice(src.indexOf('  const bareAgent = '), src.indexOf('  const REL_DOT = '))
const relTree: (people: any[]) => { roots: any[]; kids: Map<string, any[]> } = new Function(`${body}; return relTree`)()
const P = (id: string, o: object = {}) => ({ id, plate: id, ...o })
const ids = (l: any[]) => l.map(p => p.id)

test('主管 → 部門主管 → 員工；team 帶 [ref] 也認得；找不到主管的當根', () => {
  const t = relTree([P('w', { role: 'manager', agent: 'willy主管' }), P('d', { role: 'manager', agent: 'office設計 [26d674]', team: 'willy主管' }), P('s', { team: 'office設計' }), P('x', { team: '不在線的人' }), P('y')])
  expect(ids(t.roots)).toEqual(['w', 'x', 'y'])
  expect(ids(t.kids.get('w')!)).toEqual(['d'])
  expect(ids(t.kids.get('d')!)).toEqual(['s'])
})

test('同名主管：挑坐同一張協作桌的；沒有同桌的掛第一位', () => {
  const t = relTree([P('g1', { role: 'manager', agent: 'GUANGUAN' }), P('g2', { role: 'manager', agent: 'GUANGUAN', seat: 't3.0' }), P('a', { team: 'GUANGUAN', seat: 't3.1' }), P('b', { team: 'GUANGUAN' })])
  expect(ids(t.kids.get('g2')!)).toEqual(['a'])
  expect(ids(t.kids.get('g1')!)).toEqual(['b'])
})

test('互相掛（成環）不會無限迴圈：當根；主管排在前面', () => {
  const t = relTree([P('b', { role: 'manager', agent: 'B', team: 'A' }), P('a', { role: 'manager', agent: 'A', team: 'B' }), P('z')])
  expect(ids(t.roots).sort()).toEqual(['a', 'b', 'z'])
  expect(t.roots.at(-1).id).toBe('z')
})
