// bun test plugins/pixel-office/remote（叫 .spec.ts：claude plugin test 會載入所有 .test.ts，而這是本機伺服器、不是 mod）
import { expect, test } from 'bun:test'

import { allowed, sceneSvg } from './server'

test('requests through Cloudflare need the Access email of the owner; local requests pass', () => {
  const h = (o: Record<string, string>) => new Headers(o)
  expect(allowed(h({}), undefined)).toBe(true)
  expect(allowed(h({ 'cf-ray': 'x' }), 'me@x.com')).toBe(false)
  expect(allowed(h({ 'cf-ray': 'x', 'cf-access-authenticated-user-email': 'other@x.com' }), 'me@x.com')).toBe(false)
  expect(allowed(h({ 'cf-ray': 'x', 'cf-access-authenticated-user-email': 'Me@X.com' }), 'me@x.com')).toBe(true)
  expect(allowed(h({ 'cf-ray': 'x', 'cf-access-authenticated-user-email': 'me@x.com' }), undefined)).toBe(false)
})

test('portrait scene: width is clamped to 48..112 and fills the given aspect', () => {
  const svg = sceneSvg(64, 2)
  expect(svg).toContain('viewBox="0 0 64 128"')
  expect(sceneSvg(20, 2)).toContain('viewBox="0 0 48 ')
  expect(sceneSvg(500, 1)).toContain('viewBox="0 0 112 ')
})
