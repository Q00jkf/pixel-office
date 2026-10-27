import { test, expect } from 'claude-code/testing'
import { PALETTE as C, drawScene, encode } from './scene'
import { cases, fnv } from './scenarios'

// 用 git show 9fe6804（0.13.2）的 scene.ts 對同一份 scenarios.ts 算出來的，不是拿現在的程式碼自己產生
const RASTER_0132: Record<string, string> = {"empty-112-0":"d2edb397","one-112-0":"1b328711","max-112-0":"d3d3d3f7","night-112-0":"42bb6e67","bird-112-0":"7bad9be4","empty-112-7":"faf76ece","one-112-7":"394ca9a5","max-112-7":"cdd695cd","night-112-7":"1b9ffe75","bird-112-7":"74db4576","empty-80-0":"128f13e4","one-80-0":"8f2ca25f","max-80-0":"66143962","night-80-0":"76f3e9f3","bird-80-0":"f4c885ff","empty-80-7":"15aa6d4d","one-80-7":"02d9adaf","max-80-7":"5a9c9a77","night-80-7":"52c2efd8","bird-80-7":"7ec2b400","empty-60-0":"aa09cb46","one-60-0":"b4b6f88d","max-60-0":"144c8216","night-60-0":"ecac569d","bird-60-0":"b8ff13ac","empty-60-7":"374ae2c3","one-60-7":"1ea839e9","max-60-7":"3de81287","night-60-7":"8d76a9c9","bird-60-7":"e34076cf","empty-48-0":"cf7110e5","one-48-0":"5fc2d7b4","max-48-0":"f297b96e","night-48-0":"96286f8f","bird-48-0":"b159ad9c","empty-48-7":"e6dfdfc6","one-48-7":"a2e76506","max-48-7":"46ef4be8","night-48-7":"6247b040","bird-48-7":"bbf7f94e"}

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
  expect(biggest).toBeLessThan(90000) // 2026-10-27 實測最大 65,971 字元（0.16.0：素材表含走路格 3.1 萬）；至少留 4 萬給上限 131072
})

test('the SVG is well formed: only svg, defs, pattern and text have closing tags, all balanced', () => {
  for (const c of cases().filter(c => c.name.startsWith('max') || c.name.startsWith('night'))) {
    const s = svgOf(c)
    for (const tag of ['svg', 'defs', 'pattern', 'text']) expect((s.match(new RegExp(`<${tag}[ >]`, 'g')) ?? []).length).toBe((s.match(new RegExp(`</${tag}>`, 'g')) ?? []).length)
    expect(s.replace(/base64,[^"]*/, '')).not.toMatch(/NaN|undefined|Infinity/) // 素材表的 base64 可能剛好含這幾個字
    expect(s.replace(/<(svg|defs|pattern|text)[ >][^]*?>|<\/(svg|defs|pattern|text)>|<(rect|circle|ellipse|path|image|use)\b[^<>]*\/>/g, '').replace(/[^<>]+/g, '')).toBe('')
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
  const texts = v.labels.filter((s): s is Extract<Shape, { k: 'text' }> => s.k === 'text').map(s => s.text)
  for (const c of crew) expect(texts.filter(t => t === c.name)).toHaveLength(1)
  expect(assignSeats(crew, 80, 50).size).toBe(4)
})

const one = (mode: Coworker['mode'], frame = 0) => drawVector([{ id: 'x', name: 'x', mode, tool: '', isMe: false, role: 'staff' }], frame, 60, 44).shapes
type Sprite = Extract<Shape, { k: 'sprite' }>
const people = (shapes: Shape[]) => shapes.filter((s): s is Sprite => s.k === 'sprite' && /^p\ds\d(l?[ab]|k)?$/.test(s.id))

test('faces: waiting has a question mark, error sweats and shakes, thinking has a bubble, done hops, typing bobs, idle dozes', () => {
  expect(one('waiting').some(s => s.k === 'text' && s.text === '?')).toBe(true)
  expect(one('error').some(s => s.k === 'path' && s.fill === 0x4fc3f7)).toBe(true)
  expect(people(one('error', 0))[0].x).not.toBe(people(one('error', 1))[0].x)
  expect(people(one('done', 1))[0].y).toBeLessThan(people(one('done', 0))[0].y)
  expect(people(one('typing', 1))[0].y).toBeLessThan(people(one('typing', 0))[0].y) // 素材沒有動畫格：打字上下輕跳
  expect(one('thinking').filter(s => s.k === 'ellipse' && s.fill === 0xffffff).length).toBeGreaterThan(0)
  expect(one('idle').some(s => s.k === 'text' && s.text === 'z')).toBe(true)
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

// ---- 0.14.1：名牌永遠最上層、裝飾避開名牌框（oftest D 期驗收第 4 節的 7 類重疊） ----
import { fitLabel } from './vector'

type T = Extract<Shape, { k: 'text' }>
const box = (t: T) => {
  const w = textWidth(t.text, t.size)
  const x = t.anchor === 'middle' ? t.x - w / 2 : t.x
  return { x, y: t.y - t.size * 0.85, w, h: t.size * 1.05 }
}
const hit = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
const nameTexts = (v: ReturnType<typeof drawVector>) => v.labels.filter((s): s is T => s.k === 'text' && !s.text.startsWith('+') && !s.text.startsWith('TEAM'))

test('labels (nameplates, TEAM signs, +N) are drawn last, above every other shape, at night too', () => {
  for (const c of cases().filter(c => c.name.startsWith('max') || c.name.startsWith('night'))) {
    const v = drawVector(c.crew, c.frame, c.width, c.rows, c.walkers, c.seating, c.opts)
    expect(v.shapes.concat(v.glow).some(s => s.k === 'text' && nameTexts(v).some(t => t.text === s.text))).toBe(false)
    const s = vectorSvg(v)
    const firstLabel = s.indexOf(vectorSvg({ ...v, shapes: [], glow: [], night: false }).split('</pattern></defs>')[1].slice(0, 40))
    expect(firstLabel).toBeGreaterThan(s.lastIndexOf('opacity="0.66"'))
  }
})

test('nameplates never overlap each other in any case', () => {
  for (const c of cases()) {
    const ts = nameTexts(drawVector(c.crew, c.frame, c.width, c.rows, c.walkers, c.seating, c.opts))
    for (let i = 0; i < ts.length; i++) for (let j = i + 1; j < ts.length; j++) if (hit(box(ts[i]), box(ts[j]))) throw new Error(`${c.name}: ${ts[i].text} × ${ts[j].text}`)
  }
})

test('a thinking manager puts the bubble beside the head, clear of the nameplate', () => {
  for (const c of cases().filter(c => c.name.startsWith('max'))) {
    const v = drawVector(c.crew, c.frame, c.width, c.rows, c.walkers, c.seating, c.opts)
    const plate = v.labels.find((s): s is T => s.k === 'text' && s.text === '★office')
    if (!plate) continue
    const bubbles = v.shapes.concat(v.glow).filter((s): s is Extract<Shape, { k: 'ellipse' }> => s.k === 'ellipse' && s.fill === 0xffffff)
    expect(bubbles.length).toBeGreaterThan(0)
    for (const b of bubbles) expect(hit(box(plate), { x: b.cx - b.rx, y: b.cy - b.ry, w: 2 * b.rx, h: 2 * b.ry })).toBe(false)
  }
})

test('narrow panes keep at least three full-width characters of a manager name; +N is its own badge', () => {
  for (const c of cases().filter(c => c.name.startsWith('max-60') || c.name.startsWith('max-48'))) {
    const v = drawVector(c.crew, c.frame, c.width, c.rows, c.walkers, c.seating, c.opts)
    const texts = v.labels.filter((s): s is T => s.k === 'text').map(s => s.text)
    expect(texts.some(t => t.startsWith('★') && t.includes('+'))).toBe(false)
    expect(texts.some(t => /^\+\d+$/.test(t))).toBe(true)
  }
  expect(fitLabel('★主管乙', 8.6).text).toBe('★主管乙')
  expect(fitLabel('★非常長的主管名字', 8.6).text.length).toBeGreaterThanOrEqual(4)
})

test('meeting-room nameplates stay inside the room, below the wall', () => {
  for (const c of cases().filter(c => c.name.startsWith('max'))) {
    const v = drawVector(c.crew, c.frame, c.width, c.rows, c.walkers, c.seating, c.opts)
    for (const t of nameTexts(v)) expect(box(t).y).toBeGreaterThanOrEqual(2)
  }
  const big = cases().find(c => c.name === 'max-112-0')!
  expect(svgOf(big)).toContain('實作16') // 開會的人真的在會議室（情境帶了開會座位）
})

// ---- 0.15.0：2dPig 素材 ----
import { SHEET_PNG, SPRITES } from './sheet'
import { lookOf } from './vector'

const sprites = (v: ReturnType<typeof drawVector>) => v.shapes.concat(v.glow).filter((s): s is Sprite => s.k === 'sprite')

test('the sprite sheet is embedded exactly once and every sprite is a cropped <use> of it', () => {
  for (const c of cases().filter(c => c.name.startsWith('max') || c.name.startsWith('empty'))) {
    const v = drawVector(c.crew, c.frame, c.width, c.rows, c.walkers, c.seating, c.opts)
    const s = vectorSvg(v)
    expect(s.split(SHEET_PNG).length).toBe(2)
    expect((s.match(/<use href="#S"/g) ?? []).length).toBe(sprites(v).length)
    for (const sp of sprites(v)) {
      const [x, y, w, h] = SPRITES[sp.id]
      expect(sp.src[0] >= x && sp.src[1] >= y && sp.src[0] + sp.src[2] <= x + w && sp.src[1] + sp.src[3] <= y + h).toBe(true)
    }
  }
})

test('the largest case stays under the Svg limit (2026-10-27: 65,971 characters incl. the 3.1 萬 sheet)', () => {
  for (const name of ['max-112-0', 'max-112-7']) {
    const len = svgOf(cases().find(c => c.name === name)!).length
    expect(len).toBeLessThan(SVG_MAX)
    expect(len).toBeLessThan(90000)
  }
})

test('looks: one of 5 people by name hash, shirt colour varies beyond 5, managers wear the suit, stable across frames', () => {
  const crew = Array.from({ length: 30 }, (_, i) => ({ name: `peer-${i}`, role: 'staff' as const }))
  const looks = crew.map(lookOf)
  expect(new Set(looks.map(l => l.person)).size).toBe(5)
  expect(new Set(looks.map(l => `${l.person}/${l.shirt}`)).size).toBeGreaterThan(10)
  expect(looks.every(l => l.shirt < 7)).toBe(true)
  expect(lookOf({ name: 'office', role: 'manager' }).shirt).toBe(7)
  expect(lookOf({ name: '實作4', role: 'staff' })).toEqual(lookOf({ name: '實作4', role: 'staff' }))
  const who: Coworker = { id: 'a', name: 'peer-3', mode: 'idle', tool: '', isMe: false, role: 'staff' }
  const id = (f: number) => people(drawVector([who], f, 60, 44).shapes)[0].id
  expect(id(0)).toBe(id(5))
})

test('pets: the cat is the black-cat sprite (flipped when walking right), a corgi naps in the office', () => {
  const cat = (f: number) => sprites(drawVector([], f, 80, 50)).filter(s => s.id === 'cat')
  expect(cat(0)).toHaveLength(1)
  expect(new Set(Array.from({ length: 40 }, (_, f) => cat(f)[0].flip === true)).size).toBe(2)
  expect(sprites(drawVector([], 0, 80, 50)).some(s => s.id === 'corgi')).toBe(true)
})

test('the wall clock shows the time it is given', () => {
  const texts = (v: ReturnType<typeof drawVector>) => v.shapes.filter((s): s is T => s.k === 'text').map(s => s.text)
  expect(texts(drawVector([], 0, 112, 80, [], undefined, { clock: '09:41' }))).toContain('09:41')
  expect(texts(drawVector([], 0, 112, 80))).toContain('12:00')
})

// ---- 0.15.1：oftest E 期驗收 B1～B4 ----
type Rect4 = { x: number; y: number; w: number; h: number }
const spriteBox = (s: Sprite): Rect4 => ({ x: s.x, y: s.y, w: s.w, h: s.h })

test('B1: meeting chairs stay inside the room and nothing covers the wall clock', () => {
  for (const c of cases()) {
    const v = drawVector(c.crew, c.frame, c.width, c.rows, c.walkers, c.seating, c.opts)
    for (const ch of sprites(v).filter(s => s.id.startsWith('chair') && s.y < 22)) expect(ch.y + ch.h).toBeLessThanOrEqual(22 + 1e-9)
    const all = v.shapes.concat(v.glow)
    const i = all.findIndex(s => s.k === 'text' && s.text === '12:00')
    if (i < 0) continue
    const face = all[i - 1] as Extract<Shape, { k: 'rect' }> // 時鐘框就在數字前一筆
    for (const s of all.slice(i + 1)) if (s.k === 'sprite' && hit(spriteBox(s), face)) throw new Error(`${c.name}: ${s.id} 蓋到時鐘`)
    expect(all.slice(0, i - 1).filter((s): s is Sprite => s.k === 'sprite' && s.id.startsWith('chair')).some(s => hit(spriteBox(s), face))).toBe(false)
  }
})

test('B2: cups on the desks stay clear of the nameplates', () => {
  for (const c of cases()) {
    const v = drawVector(c.crew, c.frame, c.width, c.rows, c.walkers, c.seating, c.opts)
    const cups = sprites(v).filter(s => s.id === 'mug' || s.id === 'coffee')
    for (const t of nameTexts(v)) for (const m of cups) if (hit(box(t), spriteBox(m))) throw new Error(`${c.name}: ${m.id} × ${t.text}`)
  }
})

test('B3: managers wear the suit but each has a different face', () => {
  for (const c of cases().filter(c => c.name.startsWith('max') || c.name.startsWith('night'))) {
    const ids = people(drawVector(c.crew, c.frame, c.width, c.rows, c.walkers, c.seating, c.opts).shapes).map(s => s.id.replace(/(l?[ab]|k)$/, '')).filter(id => id.endsWith('s7'))
    expect(ids.length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
  }
})

test('B4: people queuing at the counter are drawn in front of the pet', () => {
  for (const c of cases().filter(c => c.name.startsWith('max'))) {
    const v = drawVector(c.crew, c.frame, c.width, c.rows, c.walkers, c.seating, c.opts)
    const order = v.shapes.map(s => (s.k === 'sprite' ? s.id : ''))
    const queueIds = new Set(['s6', 's14'].map(id => lookOf(c.crew.find(x => x.id === id)!)).map(l => `p${l.person}s${l.shirt}`))
    expect(order.indexOf('cat')).toBeGreaterThanOrEqual(0)
    expect(order.findLastIndex(id => queueIds.has(id))).toBeGreaterThan(order.indexOf('cat'))
  }
})

// ---- 0.16.0：寶寶與山雀也是素材畫風、人物走路格 ----
test('baby and bird are pixel sprites in the same style: crawl/sit, hop/flap, flipped by direction, no vector drawing left', () => {
  for (const pet of ['baby', 'bird'] as const) {
    const ids = new Set<string>()
    const flips = new Set<boolean>()
    for (let f = 0; f < 60; f++) {
      const v = drawVector([], f, 80, 50, [], undefined, { pet })
      const mine = sprites(v).filter(s => s.id.startsWith(pet))
      expect(mine).toHaveLength(1)
      ids.add(mine[0].id)
      flips.add(mine[0].flip === true)
      expect(sprites(v).some(s => s.id === 'cat')).toBe(false)
      expect(v.shapes.some(s => (s.k === 'ellipse' || s.k === 'circle') && [C.babySuit, C.birdWhite].includes(s.fill as number))).toBe(false)
    }
    expect(ids.size).toBe(2) // 寶寶爬／坐、山雀拍翅／停
    expect(flips.size).toBe(2)
  }
  const fed = drawVector([], 12, 80, 50, [], undefined, { pet: 'baby', treatFrame: 10 })
  expect(sprites(fed).some(s => s.id === 'babySit')).toBe(true) // 餵奶時坐著
})

test('walking: legs alternate every frame, side frames and a flip when going left or right, front frames going up or down', () => {
  const who: Coworker = { id: 'w', name: 'peer-3', mode: 'idle', tool: '', isMe: false, role: 'staff' }
  const walk = (path: { x: number; y: number }[], f: number) => people(drawVector([who], f, 80, 50, [{ id: 'w', path, start: 0 }]).shapes)[0]
  const across = [{ x: 10, y: 70 }, { x: 70, y: 70 }]
  const back = [{ x: 70, y: 70 }, { x: 10, y: 70 }]
  const down = [{ x: 30, y: 30 }, { x: 30, y: 90 }]
  expect(walk(across, 1).id).toMatch(/la$/)
  expect(walk(across, 2).id).toMatch(/lb$/)
  expect(walk(across, 1).flip).toBe(true) // 往右走：側走格翻面
  expect(walk(back, 1).flip).toBeUndefined() // 往左走：素材側走格本來就朝左
  expect(walk(down, 1).id).toMatch(/\d[ab]$/) // 上下走：正面
  expect(walk(down, 1).id).not.toBe(walk(down, 2).id)
  expect(walk(down, 1).y).not.toBe(walk(down, 2).y) // 1 素材像素起伏
  const seated = people(drawVector([{ ...who, mode: 'typing' }], 1, 80, 50).shapes)[0]
  expect(seated.id).toMatch(/s\d$/) // 坐著打字不用走路格
})

import { bigCrew } from './scenarios'
import { setSpread } from './scene'

test('desktop fills tall panes: 30 people at 112 x 200 rows (about a 2300 px tall pane) still fit the Svg limit', () => {
  setSpread(true)
  const crew = bigCrew()
  const s = vectorSvg(drawVector(crew, 0, 112, 200, [], assignSeats(crew, 112, 200), {}))
  setSpread(false)
  expect(s.length).toBeLessThanOrEqual(SVG_MAX) // 2026-10-27 實測 112,638 字元
})

test('chairs face their desks: front chairs behind desks and the top meeting row, back chairs over people at the bottom row and the boss desks', () => {
  for (const c of cases().filter(c => c.name.startsWith('max'))) {
    const v = drawVector(c.crew, c.frame, c.width, c.rows, c.walkers, c.seating, c.opts)
    const shapes = v.shapes
    const ids = sprites(v).map(s => s.id)
    expect(ids.filter(id => /^chair(Red|Yellow|Green|Blue|White|Gray)$/.test(id)).every(id => id === 'chairWhite')).toBe(true) // 側面椅只剩主管桌旁的訪客椅
    expect(ids.filter(id => id === 'chairFrontGray').length).toBeGreaterThan(0)
    const backs = people(shapes).filter(s => s.id.endsWith('k'))
    expect(backs.length).toBeGreaterThan(0)
    for (const b of backs) {
      const i = shapes.indexOf(b)
      expect(shapes.slice(i + 1).some(s => s.k === 'sprite' && s.id.startsWith('chairBack'))).toBe(true) // 背對的人之後一定畫背面椅
    }
  }
})

test('G3: glass floors, navy boss rug, white desks, one F1 frame per team with clear inside', () => {
  const svg = vectorSvg(drawVector(cases()[0].crew, 0, 112, 80))
  for (const id of ['tile', 'glassRoom', 'navyRug']) expect(svg).toContain(`<pattern id="${id}"`)
  for (const c of cases().filter(c => c.name.startsWith('max'))) {
    const v = drawVector(c.crew, c.frame, c.width, c.rows, c.walkers, c.seating, c.opts)
    const tags = v.labels.filter(s => s.k === 'text' && s.text.startsWith('TEAM '))
    const frames = v.shapes.filter(s => s.k === 'rect' && s.fill === 'none' && s.sw === 0.3 && s.h > 20)
    expect(frames.length).toBe(tags.length) // 同一隊上下相連的座位群只畫一個框
    expect(v.shapes.some(s => s.k === 'rect' && [0xeadfc8, 0xdbe7ef, 0xe2ecd8].includes(s.fill as number))).toBe(false) // 地毯底色拿掉了
  }
})
