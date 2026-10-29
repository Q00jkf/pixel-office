// bun test remote（叫 .spec.ts：claude plugin test 會載入所有 .test.ts，而這是本機伺服器、不是 mod）
import { expect, test } from 'bun:test'

import { layout } from '../hooks/scene'
import { allowed, deskRowsNeeded, phoneRows, sameOrigin, sceneSvg } from './server'

test('requests through Cloudflare need the Access email of the owner; local requests pass', () => {
  const h = (o: Record<string, string>) => new Headers(o)
  expect(allowed(h({}), undefined)).toBe(true)
  expect(allowed(h({ 'cf-ray': 'x' }), 'me@x.com')).toBe(false)
  expect(allowed(h({ 'cf-ray': 'x', 'cf-access-authenticated-user-email': 'other@x.com' }), 'me@x.com')).toBe(false)
  expect(allowed(h({ 'cf-ray': 'x', 'cf-access-authenticated-user-email': 'Me@X.com' }), 'me@x.com')).toBe(true)
  expect(allowed(h({ 'cf-ray': 'x', 'cf-access-authenticated-user-email': 'me@x.com' }), undefined)).toBe(false)
})

test('portrait scene: width is clamped to 48..112 and is at least as tall as the given aspect (taller when desks run out)', () => {
  const h = Number(/viewBox="0 0 64 (\d+)"/.exec(sceneSvg(64, 2))?.[1])
  expect(h).toBeGreaterThanOrEqual(128) // 讀的是本機真的在線名單，人多就更長
  expect(sceneSvg(20, 2)).toContain('viewBox="0 0 48 ')
  expect(sceneSvg(500, 1)).toContain('viewBox="0 0 112 ')
})

test('the phone page grows a desk row per team with peers, plus rows of 8 for everyone else', () => {
  const c = (id: string, extra: object = {}) => ({ id, name: id, mode: 'idle', tool: '', isMe: false, role: 'staff', ...extra }) as any
  const crew = [c('o', { role: 'manager', name: 'office' }), c('w', { role: 'manager', agent: 'willy' }), c('of', { team: 'office' }), c('r2', { team: 'willy' }), ...['a', 'b', 'd', 'e'].map(n => c(n))]
  expect(deskRowsNeeded(crew)).toBe(3)
  expect(deskRowsNeeded([...crew, ...Array.from({ length: 6 }, (_, i) => c(`x${i}`))])).toBe(4) // 沒 team 的 10 人 → 2 排
  const rows = phoneRows(64, 1.98, crew)
  expect(layout(64, rows).clusters.length / 2).toBeGreaterThanOrEqual(3)
})

test('commands are taken only as same-origin JSON', () => {
  const r = (h: Record<string, string>) => new Request('https://office.example.com/command', { method: 'POST', headers: h })
  expect(sameOrigin(r({ 'content-type': 'application/json', origin: 'https://office.example.com' }))).toBe(true)
  expect(sameOrigin(r({ 'content-type': 'application/json' }))).toBe(true)
  expect(sameOrigin(r({ 'content-type': 'application/json', origin: 'https://evil.example' }))).toBe(false)
  expect(sameOrigin(r({ 'content-type': 'text/plain', origin: 'https://office.example.com' }))).toBe(false)
})
