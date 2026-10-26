import { test, expect } from 'claude-code/testing'
import { drawScene, encode } from './scene'
import { cases, fnv } from './scenarios'

// 0.13.2（9fe6804）的終端機畫面：D 期起 Desktop 改畫向量，Raster 這條路必須逐字不變
const RASTER_0132: Record<string, string> = {"empty-112-0":"d2edb397","one-112-0":"1b328711","max-112-0":"0f568f1b","night-112-0":"42bb6e67","bird-112-0":"7bad9be4","empty-112-7":"faf76ece","one-112-7":"394ca9a5","max-112-7":"bbccfdba","night-112-7":"1b9ffe75","bird-112-7":"74db4576","empty-80-0":"128f13e4","one-80-0":"8f2ca25f","max-80-0":"7f486806","night-80-0":"76f3e9f3","bird-80-0":"f4c885ff","empty-80-7":"15aa6d4d","one-80-7":"02d9adaf","max-80-7":"c8a5873e","night-80-7":"52c2efd8","bird-80-7":"7ec2b400","empty-60-0":"aa09cb46","one-60-0":"b4b6f88d","max-60-0":"58c0b785","night-60-0":"ecac569d","bird-60-0":"b8ff13ac","empty-60-7":"374ae2c3","one-60-7":"1ea839e9","max-60-7":"22668cd0","night-60-7":"8d76a9c9","bird-60-7":"e34076cf","empty-48-0":"cf7110e5","one-48-0":"5fc2d7b4","max-48-0":"eef57a0e","night-48-0":"96286f8f","bird-48-0":"b159ad9c","empty-48-7":"e6dfdfc6","one-48-7":"a2e76506","max-48-7":"f473d8e4","night-48-7":"6247b040","bird-48-7":"bbf7f94e"}

test('terminal (Raster) picture is byte-for-byte the same as 0.13.2 in every case', () => {
  const got: Record<string, string> = {}
  for (const c of cases()) got[c.name] = fnv(encode(drawScene(c.crew, c.frame, c.width, c.rows, c.walkers, c.seating, c.opts)))
  expect(got).toEqual(RASTER_0132)
})

import type { Coworker } from '../types'
import { SVG_MAX, assignSeats } from './scene'
import { drawVector, fitText, textWidth, vectorSvg, type Shape } from './vector'

const svgOf = (c: ReturnType<typeof cases>[number]) => vectorSvg(drawVector(c.crew, c.frame, c.width, c.rows, c.walkers, c.seating, c.opts))

test('every case, up to 30 people + cat + planes + meeting + queue at 112x80, stays under the Svg limit', () => {
  let biggest = 0
  for (const c of cases()) {
    const s = svgOf(c)
    expect(s.length).toBeLessThanOrEqual(SVG_MAX)
    biggest = Math.max(biggest, s.length)
  }
  expect(biggest).toBeLessThan(SVG_MAX / 2) // 2026-10-26 實測最大約 4.7 萬字元，留一倍以上餘裕
})

test('the SVG is well formed: only svg, defs, pattern and text have closing tags, all balanced', () => {
  for (const c of cases().filter(c => c.name.startsWith('max') || c.name.startsWith('night'))) {
    const s = svgOf(c)
    for (const tag of ['svg', 'defs', 'pattern', 'text']) expect((s.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length).toBe((s.match(new RegExp(`</${tag}>`, 'g')) ?? []).length)
    expect(s).not.toMatch(/NaN|undefined|Infinity/)
    expect(s.replace(/<(svg|defs|pattern|text)[ >][^]*?>|<\/(svg|defs|pattern|text)>|<(rect|circle|ellipse|path)\b[^<>]*\/>/g, '').replace(/[^<>]+/g, '')).toBe('')
  }
})

test('nameplates can be Chinese and are cut by width, not by character count', () => {
  const big = cases().find(c => c.name === 'max-112-0')!
  const s = svgOf(big)
  expect(s).toContain('實作4')
  expect(s).toContain('主管乙')
  expect(s).toContain('主管室')
  expect(textWidth('實作', 2)).toBe(4)
  expect(Math.round(textWidth('ab', 2) * 10)).toBe(24)
  expect(fitText('非常長的中文名牌名稱', 8, 2)).toBe('非常長的')
  expect(fitText('peer-12345678', 8, 2)).toBe('peer-1')
})

test('every seated or standing person gets exactly one nameplate', () => {
  const crew: Coworker[] = ['甲', 'b', 'c', 'd'].map((name, i) => ({ id: `p${i}`, name, mode: 'idle', tool: '', isMe: false, role: 'staff' }))
  const v = drawVector(crew, 0, 80, 50)
  const texts = v.shapes.filter((s): s is Extract<Shape, { k: 'text' }> => s.k === 'text').map(s => s.text)
  for (const c of crew) expect(texts.filter(t => t === c.name)).toHaveLength(1)
  expect(assignSeats(crew, 80, 50).size).toBe(4)
})

const one = (mode: Coworker['mode'], frame = 0) => drawVector([{ id: 'x', name: 'x', mode, tool: '', isMe: false, role: 'staff' }], frame, 60, 44).shapes
const heads = (shapes: Shape[]) => shapes.filter((s): s is Extract<Shape, { k: 'circle' }> => s.k === 'circle' && s.r === 2)

test('faces: waiting has a question mark, error sweats and shakes, thinking looks up with a bubble, done hops, idle blinks', () => {
  expect(one('waiting').some(s => s.k === 'text' && s.text === '?')).toBe(true)
  expect(one('error').some(s => s.k === 'path' && s.fill === 0x4fc3f7)).toBe(true)
  expect(heads(one('error', 0))[0].cx).not.toBe(heads(one('error', 1))[0].cx)
  expect(heads(one('done', 1))[0].cy).toBeLessThan(heads(one('done', 0))[0].cy)
  const eyes = (shapes: Shape[]) => shapes.filter((s): s is Extract<Shape, { k: 'circle' }> => s.k === 'circle' && s.r === 0.3)
  expect(eyes(one('thinking'))[0].cy).toBeLessThan(eyes(one('typing'))[0].cy)
  expect(one('thinking').filter(s => s.k === 'ellipse' && s.fill === 0xffffff).length).toBeGreaterThan(0)
  const blinks = Array.from({ length: 8 }, (_, f) => eyes(one('idle', f)).length === 0)
  expect(blinks.filter(Boolean)).toHaveLength(1) // 8 格眨一次
})

test('night puts a dark veil over the office and keeps screens and question marks above it', () => {
  const crew: Coworker[] = [{ id: 'w', name: 'w', mode: 'waiting', tool: '', isMe: false, role: 'staff' }]
  const day = drawVector(crew, 0, 60, 44)
  const night = drawVector(crew, 0, 60, 44, [], undefined, { night: true })
  expect(day.glow).toHaveLength(0)
  expect(night.glow.some(s => s.k === 'text' && s.text === '?')).toBe(true)
  const s = vectorSvg(night)
  expect(s.indexOf('opacity="0.66"')).toBeLessThan(s.lastIndexOf('>?</text>'))
})
