// Desktop（Svg 元素）的畫法：跟 drawScene 吃同一份 crew、座位、SceneOptions，座標也是同一套「像素」單位，
// 只是輸出一份形狀清單而不是點陣。純資料、不依賴 $；終端機的 Raster 照舊走 drawScene。
// 0.15.0 起人、家具、寵物用 2dPig「Pixel Office」素材（CC0，assets/2dpig/）：素材表在 <defs> 只嵌一次，
// 每個圖素是一個巢狀 <svg viewBox> 用 <use> 裁切引用（2026-10-27 Edge 以 <img> 開實測可畫、可翻面）。
// 名牌、狀態泡泡、螢幕、團隊地毯、寶寶與鳥照舊用向量畫。
import type { Coworker, ErrandKind, OfficeMode, Pet } from '../types'
import {
  GEOM, OFFICE_DOOR_W, OFFICE_DOOR_X, PALETTE as C, TEAM_RUGS,
  assignSeats, bossSeating, catMoveFrame, catPose, catRange, counterSpot, counterX, hash, layout, mailboxX, meetTable,
  pathLength, planePos, queueSpot, raidPath, raidPose, teamZones, walkerPos,
  type Placement, type SceneOptions, type Seat, type Step, type Walker,
} from './scene'
import { CELL, PEOPLE, SHEET_H, SHEET_PNG, SHEET_W, SHIRTS, SPRITES, type SpriteId } from './sheet'

const { WALL, TOP_H, UNIT_W, UNIT_H, CLUSTER_W, ROW_SPLIT, CABINET_X, CAT_START, CAT_W, CAT_H, CAT_LIFT, DESK_W, COUNTER_W, MEET_DOOR_W, WALK_SPEED, TREAT_FRAMES } = GEOM

type Paint = number | string // 數字＝顏色，字串＝原樣（例如 url(#tile)）
type Box4 = readonly [number, number, number, number]
export type Shape =
  | { k: 'rect'; x: number; y: number; w: number; h: number; r?: number; fill: Paint; stroke?: Paint; sw?: number; op?: number }
  | { k: 'circle'; cx: number; cy: number; r: number; fill: Paint; stroke?: Paint; sw?: number; op?: number }
  | { k: 'ellipse'; cx: number; cy: number; rx: number; ry: number; fill: Paint; stroke?: Paint; sw?: number }
  | { k: 'path'; d: string; fill?: Paint; stroke?: Paint; sw?: number; op?: number }
  | { k: 'text'; x: number; y: number; text: string; size: number; fill: Paint; anchor?: 'start' | 'middle'; bold?: boolean; bg?: Paint; halo?: Paint; mono?: boolean }
  | { k: 'sprite'; id: SpriteId; src: Box4; x: number; y: number; w: number; h: number; flip?: boolean }

/** 點得到的東西（場景單位的框）：家具開選單、寵物與柯基點了有反應；畫面疊按鈕時照這裡放 */
export type Furniture = 'printer' | 'cabinet' | 'mailbox' | 'calendar' | 'vending' | 'clock' | 'meeting'
export type Rect = { x: number; y: number; w: number; h: number }
/** room＝這件東西所在的房間（選單不能跨出去，例如會議室的選單不壓主管室） */
export type Hit = Rect & { what: Furniture | 'pet' | 'corgi'; sitting?: boolean; room?: Rect }

/**
 * shapes → 夜間暗幕 → glow（夜裡發光的）→ labels（名牌、TEAM 牌：永遠最上層，什麼都蓋不到它）；
 * hits＝點得到的東西；avoid＝走動與排隊的人（選單盡量別蓋到）
 */
export type VectorScene = { width: number; h: number; night: boolean; shapes: Shape[]; glow: Shape[]; labels: Shape[]; hits: Hit[]; avoid: Rect[] }

/** 素材的 Sweetie 16 色盤：自己畫的牆、地板、螢幕框跟素材同色，才不會一眼看出是兩套 */
const SW = {
  ink: 0x1a1c2c, plum: 0x5d275d, red: 0xb13e53, orange: 0xef7d57, yellow: 0xffcd75, lime: 0xa7f070, green: 0x38b764, teal: 0x257179,
  navy: 0x29366f, blue: 0x3b5dc9, sky: 0x41a6f6, cyan: 0x73eff7, white: 0xf4f4f4, silver: 0x94b0c2, slate: 0x566c86, dark: 0x333c57,
}
const PX = 0.3 // 人物素材一個像素＝0.3 單位：20×25 的人物格畫成 6×7.5，跟原本的圓頭小人一樣大

const FONT = "'Microsoft JhengHei','PingFang TC','Noto Sans TC','Noto Sans CJK TC',sans-serif"
const NAME_SIZE = 1.9
const NAME_MIN = 1.5 // 放不下先縮到這麼小，還放不下才截字

/** 字的估計寬度：全形（中日韓）一個字＝字高，半形約 0.6 */
const wide = (ch: string) => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch)
export function textWidth(t: string, size: number): number {
  let w = 0
  for (const ch of t) w += wide(ch) ? size : size * 0.6
  return w
}
/** 截到放得進 maxW：名牌可以是中文，所以不能再用字元數截 */
export function fitText(t: string, maxW: number, size: number): string {
  let out = ''
  for (const ch of t) {
    if (textWidth(out + ch, size) > maxW) break
    out += ch
  }
  return out
}

/** 放進 maxW：先縮字（到 NAME_MIN），再截字 */
export function fitLabel(t: string, maxW: number, size = NAME_SIZE): { text: string; size: number } {
  const w = textWidth(t, size)
  if (w <= maxW) return { text: t, size }
  const shrunk = Math.max(NAME_MIN, Math.floor((size * maxW / w) * 20) / 20)
  return { text: fitText(t, maxW, shrunk), size: shrunk }
}

/** 描邊跟字反差：深字配白邊，淺字（金色主管名牌）配深棕邊 */
const haloFor = (fill: Paint): Paint => {
  if (typeof fill !== 'number') return C.white
  const l = 0.299 * ((fill >> 16) & 255) + 0.587 * ((fill >> 8) & 255) + 0.114 * (fill & 255)
  return l > 140 ? C.boss : C.white
}

class Pen {
  shapes: Shape[] = []
  glow: Shape[] = []
  labels: Shape[] = []
  hits: Hit[] = []
  avoid: Rect[] = []
  faces = new Map<string, number>() // 主管的人物造型（同場不重複），沒有就照名字雜湊
  lit = false // true 時畫到 glow（夜裡在暗幕之上：螢幕、問號、火花）
  constructor(readonly night: boolean) {}
  private put(s: Shape) {
    ;(this.lit && this.night ? this.glow : this.shapes).push(s)
  }
  rect(x: number, y: number, w: number, h: number, fill: Paint, r = 0, stroke?: Paint, sw?: number) {
    this.put({ k: 'rect', x, y, w, h, r, fill, stroke, sw })
  }
  circle(cx: number, cy: number, r: number, fill: Paint, stroke?: Paint, sw?: number) {
    this.put({ k: 'circle', cx, cy, r, fill, stroke, sw })
  }
  ellipse(cx: number, cy: number, rx: number, ry: number, fill: Paint, stroke?: Paint, sw?: number) {
    this.put({ k: 'ellipse', cx, cy, rx, ry, fill, stroke, sw })
  }
  path(d: string, fill?: Paint, stroke?: Paint, sw?: number) {
    this.put({ k: 'path', d, fill, stroke, sw })
  }
  text(x: number, y: number, text: string, size: number, fill: Paint, o: { anchor?: 'start' | 'middle'; bold?: boolean; bg?: Paint; mono?: boolean } = {}) {
    if (text) this.put({ k: 'text', x, y, text, size, fill, ...o })
  }
  /** 素材圖：寬 w；h 省略時照原比例。crop＝只取圖素裡的一塊（相對座標） */
  sprite(id: SpriteId, x: number, y: number, w: number, h?: number, flip = false, crop?: Box4): { w: number; h: number } {
    const [sx, sy, sw, sh] = SPRITES[id]
    const src: Box4 = crop ? [sx + crop[0], sy + crop[1], crop[2], crop[3]] : [sx, sy, sw, sh]
    const hh = h ?? (w * src[3]) / src[2]
    this.put({ k: 'sprite', id, src, x, y, w, h: hh, ...(flip ? { flip } : {}) })
    return { w, h: hh }
  }
  /** 依素材原比例、以一個素材像素＝k 單位畫 */
  spriteAt(id: SpriteId, x: number, y: number, k: number, flip = false) {
    return this.sprite(id, x, y, SPRITES[id][2] * k, SPRITES[id][3] * k, flip)
  }
  /** 名牌類：畫在最上層，字帶淺色描邊 */
  label(x: number, y: number, text: string, size: number, fill: Paint, o: { anchor?: 'start' | 'middle'; bold?: boolean; bg?: Paint } = {}) {
    if (text) this.labels.push({ k: 'text', x, y, text, size, fill, halo: o.bg === undefined || o.bg === 'none' ? haloFor(fill) : undefined, ...o })
  }
  labelRect(x: number, y: number, w: number, h: number, fill: Paint, r = 0) {
    this.labels.push({ k: 'rect', x, y, w, h, r, fill })
  }
  glowing(f: () => void) {
    const was = this.lit
    this.lit = true
    f()
    this.lit = was
  }
}

const n = (v: number) => String(Math.round(v * 100) / 100)

// ---------- 建築 ----------

const BACK_H = 5 // 會議室、主管室的白色後牆（窗戶、時鐘、月曆掛在這）

/** 白牆：橫向壁板線＋踢腳板 */
function backWall(p: Pen, x: number, w: number) {
  p.rect(x, WALL, w, BACK_H, SW.white)
  p.path(`M${x} ${WALL + 1.5}h${w}M${x} ${WALL + 3}h${w}`, undefined, 0xdde4ea, 0.3)
  p.rect(x, WALL + BACK_H - 0.6, w, 0.6, SW.silver)
}

function building(p: Pen, L: ReturnType<typeof layout>, w: number, frame: number, plantInOffice: boolean, clock: string) {
  const { officeX, officeW, h } = L
  p.rect(0, 0, w, h, 'url(#tile)')
  // 會議室木地板、主管室紅地毯
  p.rect(WALL, WALL, officeX - 2 * WALL, TOP_H, SW.yellow)
  let planks = ''
  for (let y = WALL + 3; y < WALL + TOP_H; y += 3) planks += `M${WALL} ${y + 0.5}H${officeX - WALL}`
  p.path(planks, undefined, 0xe8b25f, 0.3)
  p.rect(officeX, WALL, w - WALL - officeX, TOP_H, SW.plum)
  p.rect(officeX + 1, WALL + 1, w - WALL - officeX - 2, TOP_H - 2, SW.red, 1)
  backWall(p, WALL, officeX - 2 * WALL)
  backWall(p, officeX, w - WALL - officeX)

  // 牆：深藍灰外框，上緣一條亮線
  for (const [x, y, rw, rh] of [[0, 0, w, WALL], [0, h - WALL, w, WALL], [0, 0, WALL, h], [w - WALL, 0, WALL, h], [0, WALL + TOP_H, w, WALL], [officeX - WALL, 0, WALL, WALL + TOP_H + WALL]]) p.rect(x, y, rw, rh, SW.dark)
  for (const [x, y, rw] of [[0, 0, w], [0, WALL + TOP_H, w]]) p.rect(x, y, rw, 0.5, SW.slate)

  // 外牆的小窗（夜裡換成夜空＋星星，畫在暗幕上面）
  p.glowing(() => {
    for (let y = WALL + TOP_H + WALL + 4; y + 6 < h - 4; y += 11) {
      p.rect(0.3, y, 1.4, 6, p.night ? C.nightSky : SW.sky, 0.3, SW.ink, 0.2)
      p.rect(w - 1.7, y, 1.4, 6, p.night ? C.nightSky : SW.sky, 0.3, SW.ink, 0.2)
    }
  })

  // 後牆：會議室＝月曆、窗；主管室＝窗、國旗、畫
  const meetW = officeX - 2 * WALL
  const cal = p.sprite('calendar', WALL + 1, WALL + 0.6, 4.2)
  p.hits.push({ what: 'calendar', x: WALL + 1, y: WALL + 0.6, ...cal })
  windows(p, WALL + 7, WALL + meetW - 1, frame)
  windows(p, officeX + (plantInOffice ? 6 : 1), w - WALL - 1, frame, ['flagUS', 'picSunset'])

  // 門洞（地板色）＋門框
  for (const [x, dw] of [[L.meetDoor, MEET_DOOR_W], [officeX + OFFICE_DOOR_X, OFFICE_DOOR_W]]) {
    p.rect(x, WALL + TOP_H, dw, WALL, SW.sky)
    p.rect(x - 0.4, WALL + TOP_H, 0.4, WALL, SW.ink)
    p.rect(x + dw, WALL + TOP_H, 0.4, WALL, SW.ink)
  }
  p.rect(Math.floor(w / 2) - 3, h - WALL, 6, WALL, SW.sky)

  // 門牌（向量版可以寫中文）
  const signY = WALL + TOP_H + 1.5
  p.text(officeX + OFFICE_DOOR_X + OFFICE_DOOR_W + 1, signY, '主管室', 1.7, C.gold, { bold: true })
  if (L.meetDoor - WALL - 1 >= 7) p.text(WALL + 1, signY, '會議室', 1.7, SW.cyan, { bold: true })

  // 會議室椅子（長桌在 drawVector 裡、上排的人之後才畫）
  for (const [i, s] of L.meet.entries()) p.sprite(CHAIRS[i % CHAIRS.length], s.x + 0.5 - 1.65, s.y + (i % 2 ? -0.6 : -1.2), 3.3, 6.6) // 下排椅腳收在房間下緣 WALL+TOP_H，不伸進牆與門洞

  if (plantInOffice) plant(p, officeX + 1, WALL + 1)
  plant(p, WALL + 1, h - WALL - 7)
  plant(p, w - WALL - 6, h - WALL - 7)

  // 走廊：檔案櫃（素材沒有，照色盤畫）、影印桌、販賣機（櫃台與影印桌之間放得下才畫）、紅色郵筒（垃圾桶素材）、櫃台
  const cpx = w - WALL - 16
  const cpy = h - WALL - 7
  p.rect(CABINET_X, cpy - 1, 6, 6.6, SW.silver, 0.4, SW.ink, 0.3)
  for (const dy of [0, 2.1, 4.2]) {
    p.rect(CABINET_X + 0.5, cpy - 0.5 + dy, 5, 1.7, SW.white, 0.2, SW.slate, 0.2)
    p.rect(CABINET_X + 2.4, cpy + 0.1 + dy, 1.2, 0.4, SW.dark, 0.15)
  }
  p.hits.push({ what: 'cabinet', x: CABINET_X, y: cpy - 1, w: 6, h: 6.6 })
  const vx = cpx - 7
  if (vx >= (counterSpot(w, h / 2) ? counterX(w) + COUNTER_W : Math.floor(w / 2) + 3) + 1) {
    const vm = p.sprite('vending', vx, cpy - 2.5, 5.4)
    p.hits.push({ what: 'vending', x: vx, y: cpy - 2.5, ...vm })
  }
  p.sprite('table', cpx, cpy + 0.2, 8)
  p.hits.push({ what: 'printer', x: cpx, y: cpy - 2.4, w: 8, h: 7.5 })
  p.spriteAt('printer', cpx + 1, cpy - 2.4, 0.4)
  p.spriteAt('paper', cpx + 5, cpy - 1.6, 0.3)
  p.glowing(() => p.circle(cpx + 3.8, cpy - 0.6, 0.35, frame % 4 < 2 ? C.led : SW.slate))
  const mx = mailboxX(w)
  const mb = p.spriteAt('binRed', mx, h - WALL - 6.5, 0.33)
  p.hits.push({ what: 'mailbox', x: mx, y: h - WALL - 6.5, ...mb })
  if (counterSpot(w, h / 2)) {
    const qx = counterX(w)
    const qy = h - WALL - 4
    p.sprite('table', qx, qy - 0.4, COUNTER_W)
    p.glowing(() => p.circle(qx + 1.5, qy + 0.8, 0.6, C.gold))
    p.spriteAt('paper2', qx + 4, qy - 0.4, 0.25)
    p.text(qx + COUNTER_W / 2, h - 0.4, 'YOU', 1.7, C.gold, { anchor: 'middle', bold: true })
  }

  // 時鐘掛在員工區看得到的那面牆（會議室門與隔牆之間，像範例圖掛在門上方）；最後畫，家具蓋不到；太窄放不下就不掛
  const room = officeX - WALL - (L.meetDoor + MEET_DOOR_W)
  if (room >= 7) {
    const kx = L.meetDoor + MEET_DOOR_W + (room - 6) / 2
    p.rect(kx, WALL + TOP_H + 0.1, 6, 1.8, SW.ink, 0.2, SW.slate, 0.2)
    p.hits.push({ what: 'clock', x: kx, y: WALL + TOP_H + 0.1, w: 6, h: 1.8 })
    p.glowing(() => p.text(kx + 3, WALL + TOP_H + 1.5, clock, 1.6, p.night ? SW.orange : SW.red, { anchor: 'middle', bold: true, mono: true }))
  }
}

const CHAIRS: SpriteId[] = ['chairBlue', 'chairGreen', 'chairRed', 'chairYellow', 'chairWhite']

/** 後牆上的窗戶（夜裡窗玻璃換夜空），中間穿插裝飾 */
function windows(p: Pen, x0: number, x1: number, frame: number, deco: SpriteId[] = ['picBlue']) {
  const ww = 6.2
  let i = 0
  for (let x = x0; x + ww <= x1; x += ww + 5, i++) {
    p.sprite(i % 2 ? 'windowNote' : 'window', x, WALL + 0.1, ww)
    if (p.night) p.glowing(() => {
      p.rect(x + 0.6, WALL + 0.7, ww - 1.2, 3.8, C.nightSky)
      if ((x + frame) % 7 !== 0) p.circle(x + 2, WALL + 1.6, 0.25, C.star)
    })
    const d = deco[i % deco.length]
    if (x + ww + 5 + ww <= x1 || x + ww + 4 <= x1) p.spriteAt(d, x + ww + 1.5, WALL + 1.2, 0.25)
  }
}

/** 長桌：素材兩端 6 像素照比例，中段拉長到要的寬度 */
function longTable(p: Pen, x: number, y: number, w: number, h: number) {
  const [, , sw, sh] = SPRITES.tableLong
  const k = h / sh
  const cap = 6 * k
  p.sprite('tableLong', x, y, cap, h, false, [0, 0, 6, sh])
  p.sprite('tableLong', x + cap, y, w - 2 * cap, h, false, [6, 0, sw - 12, sh])
  p.sprite('tableLong', x + w - cap, y, cap, h, false, [sw - 6, 0, 6, sh])
}

function plant(p: Pen, x: number, y: number) {
  p.spriteAt('plant', x + 0.3, y, 0.32)
}

/** 一排兩格的隔間：素材的灰色隔板（中間有立柱），掛點國旗或畫 */
function partitionRow(p: Pen, x: number, y: number) {
  p.sprite('partition', x, y - 2, CLUSTER_W)
  const deco: SpriteId[] = ['flagUS', 'flagUK', 'flagIndia', 'picBlue', 'picOrange', 'calendar']
  const h = hash(`${x},${y}`)
  if (h % 3 === 0) p.spriteAt(deco[(h >> 3) % deco.length], x + (h % 2 ? 1 : CLUSTER_W - 4.5), y - 1.2, 0.3)
}

// ---------- 人 ----------

const screenColor = (mode: OfficeMode | null, frame: number): number => {
  if (mode === null) return SW.dark
  if (mode === 'typing') return C.codeDim
  if (mode === 'reading') return C.white
  if (mode === 'error') return frame % 2 ? C.err : C.errDark
  if (mode === 'waiting') return frame % 2 ? C.wait : C.waitDark
  if (mode === 'blocked') return frame % 4 < 2 ? C.errDark : C.mon
  if (mode === 'done') return C.ok
  if (mode === 'thinking') return C.screenDim
  return C.screen
}

/** 螢幕（顏色＝狀態）：素材沒有能換色的螢幕，這塊照舊向量畫 */
function screen(p: Pen, x: number, y: number, w: number, mode: OfficeMode | null, frame: number) {
  p.rect(x - 0.3, y - 0.3, w + 0.6, 1.9, SW.ink, 0.3)
  p.glowing(() => {
    p.rect(x, y, w, 1.3, screenColor(mode, frame), 0.2)
    if (mode === 'typing') for (let i = 0; i < 3; i++) p.rect(x + 0.4, y + 0.2 + i * 0.35, ((i * 3 + frame) % 4) + 1, 0.2, C.code)
  })
}

/** 造型：名字雜湊決定 5 個人物之一，再決定上衣顏色（主管一律深藍西裝） */
export function lookOf(who: Pick<Coworker, 'name' | 'role'>): { person: number; shirt: number } {
  const hh = hash(who.name)
  return { person: hh % PEOPLE, shirt: who.role === 'manager' ? SHIRTS - 1 : Math.floor(hh / PEOPLE) % (SHIRTS - 1) }
}

/**
 * 人物：(x, y) 是頭的中心。走路用 build_sheet.py 產生的走路格：每格換腳（walkStep ±1）＋1 素材像素起伏，
 * 左右走（dir）換側走格、往右翻面，上下走維持正面；打字上下輕跳；
 * done 跳高一點、error 左右抖＋冷汗、thinking 想法泡泡、waiting 問號、blocked 紅牌、reading 拿紙、idle 打瞌睡 z
 */
function figure(p: Pen, x: number, y: number, who: Coworker, frame: number, walkStep?: number, side = false, dir = 0) {
  const look = lookOf(who)
  const person = p.faces.get(who.id) ?? look.person
  const shirt = look.shirt
  const mode = who.mode
  const shake = mode === 'error' ? (frame % 2 ? 0.4 : -0.4) : 0
  const bob = (mode === 'typing' || (walkStep !== undefined && walkStep !== 0)) && frame % 2 ? -PX : 0
  const hop = mode === 'done' && frame % 2 ? -0.9 : bob
  const hx = x + shake
  const hy = y + hop
  const walking = walkStep !== undefined && walkStep !== 0
  const pose = walking ? `${dir !== 0 ? 'l' : ''}${walkStep > 0 ? 'a' : 'b'}` : ''
  p.sprite(`p${person}s${shirt}${pose}` as SpriteId, hx - CELL.headX * PX, hy - CELL.headY * PX, CELL.w * PX, CELL.h * PX, walking && dir > 0)
  if (who.isMe) p.circle(hx, hy - 0.3, 2.9, 'none', C.me, 0.35)
  if (mode === 'reading') p.spriteAt('paper', x + 1.4, hy + 2.2, 0.3)

  // side：頭上方是名牌（主管桌）→ 泡泡、問號、紅牌改畫在頭的右側
  const ax = side ? hx + 4.2 : hx
  const ay = side ? hy + 1.6 : hy
  p.glowing(() => {
    if (mode === 'thinking' && side) {
      p.circle(hx + 2.3, hy - 0.4, 0.35, C.white)
      p.circle(hx + 3.1, hy - 0.9, 0.5, C.white)
      p.ellipse(hx + 4.4, hy - 1.2, 1.4, 0.9, C.white)
      for (let i = 0; i < 3; i++) if (i <= frame % 3) p.circle(hx + 3.7 + i * 0.7, hy - 1.2, 0.2, C.ink)
    } else if (mode === 'thinking') {
      p.circle(hx - 2.4, hy - 2.2, 0.35, C.white)
      p.circle(hx - 3.1, hy - 3.2, 0.55, C.white)
      p.ellipse(hx - 4.4, hy - 4.6, 1.5, 0.9, C.white)
      for (let i = 0; i < 3; i++) if (i <= frame % 3) p.circle(hx - 5.1 + i * 0.7, hy - 4.6, 0.2, C.ink)
    } else if (mode === 'error') {
      p.path(`M${n(hx + 2.3)} ${n(hy - 1.6)}q0.7 1 0 1.5q-0.7 -0.5 0 -1.5Z`, 0x4fc3f7) // 冷汗
    } else if (mode === 'done') {
      for (const [dx, dy] of [[-3.5, -2], [3.5, -2.2], [-4, 1], [4, 0.8]].filter((_, k) => (frame + k) % 2)) p.path(`M${n(hx + dx)} ${n(hy + dy - 0.6)}l0.25 0.45 0.5 0.15 -0.5 0.15 -0.25 0.45 -0.25 -0.45 -0.5 -0.15 0.5 -0.15Z`, C.spark)
    } else if (mode === 'waiting') {
      p.text(ax, ay - 2.6, '?', 3, frame % 2 ? C.wait : C.waitDark, { anchor: 'middle', bold: true })
    } else if (mode === 'blocked') {
      p.rect(ax + 1.4, ay - 5.2, 3.6, 2.6, C.white, 0.3)
      p.rect(ax + 1.8, ay - 4.8, 2.8, 1.8, C.err, 0.2)
    }
  })
  if (mode === 'idle') {
    const up = (frame + hash(who.name)) % 4 < 2 ? 0 : 0.5
    p.text(ax + (side ? 0 : 2.6), ay - 2 - up, 'z', 1.5, SW.slate, { bold: true })
  }
}

function nameTag(p: Pen, x: number, y: number, who: Coworker, maxW: number, bg: Paint, align: 'start' | 'middle' = 'middle') {
  const t = fitLabel(`${who.role === 'manager' ? '★' : ''}${who.name}`, maxW)
  p.label(x, y, t.text, t.size, who.isMe ? C.me : who.role === 'manager' ? C.goldDark : C.text, { anchor: align, bold: who.isMe, bg })
}

function carry(p: Pen, at: Step, kind: ErrandKind) {
  const x = at.x + 0.5 + (at.dx !== 0 ? at.dx * 3 : 3)
  const y = at.y + 2.5
  if (kind === 'mail') p.spriteAt('paper', x - 0.9, y - 1.2, 0.3)
  else if (kind === 'file') p.spriteAt('boxBlue', x - 1.4, y - 0.9, 0.25)
  else p.spriteAt('boxRed', x - 1.4, y - 1, 0.25)
}

// ---------- 座位 ----------

/** 員工座位：隔板（partitionRow 畫）→ 人 → 桌子擋住下半身，桌上有螢幕、杯子 */
function unit(p: Pen, x: number, y: number, who: Coworker | null, frame: number) {
  if (who) figure(p, x + 5.5, y + 2.2, who, frame)
  else p.sprite('chairGray', x + 3.9, y - 0.2, 3.3, 6.6)
  p.sprite('table', x + 0.5, y + 5, 10)
  screen(p, x + 3, y + 8.6, 5, who ? who.mode : null, frame)
  const hh = hash(`${x},${y}`)
  const prop: SpriteId = hh % 2 ? 'mug' : 'coffee'
  p.spriteAt(prop, x + 8.4, y + 5.95 - SPRITES[prop][3] * 0.25, 0.25) // 杯底在名牌框（y+6.1 起）上方，不壓名牌
  if (who) nameTag(p, x + 5.5, y + 7.7, who, 8.6, 'none')
}

function bossDesk(p: Pen, x: number, y: number, who: Coworker | null, frame: number, extra: number) {
  p.sprite('chairWhite', x - 4.2, y + 0.4, 2.6, 5.2, true)
  if (who) {
    p.sprite('chairBlue', x + 5.8, y + 5.5, 3.4, 6.8)
    figure(p, x + 7.5, y + 8.6, who, frame, undefined, true)
  }
  p.sprite('tableLong', x, y, 17, 6.8)
  screen(p, x + 4, y + 1.3, 6, who ? who.mode : null, frame)
  p.glowing(() => p.circle(x + 1.5, y + 1.5, 0.6, C.gold))
  p.spriteAt('paper', x + 14.2, y + 0.6, 0.3)
  if (who) {
    const t = fitLabel(`★${who.name}`, 13)
    p.label(x + 7, y + 4.6, t.text, t.size, C.gold, { anchor: 'middle', bold: true })
  }
  if (extra > 0) plusBadge(p, x + 15.5, y + 3.2, extra)
}

function smallBossDesk(p: Pen, x: number, y: number, who: Coworker | null, frame: number, extra: number) {
  if (who) {
    p.sprite('chairBlue', x + 2.8, y + 5.5, 3.4, 6.8)
    figure(p, x + 4.5, y + 8.6, who, frame, undefined, true)
  }
  p.sprite('table', x, y, DESK_W, 6)
  screen(p, x + 1, y + 1.3, 6, who ? who.mode : null, frame)
  if (who) {
    const t = fitLabel(`★${who.name}`, DESK_W + 0.6)
    p.label(x + DESK_W / 2, y + 4.6, t.text, t.size, C.gold, { anchor: 'middle', bold: true })
  }
  if (extra > 0) plusBadge(p, x + DESK_W - 1, y + 0.2, extra)
}

/** 坐不下的主管數：桌角一顆小徽章，不擠進名牌 */
function plusBadge(p: Pen, cx: number, cy: number, extra: number) {
  const t = `+${extra}`
  const w = textWidth(t, 1.5) + 0.8
  p.labelRect(cx - w / 2, cy - 1, w, 2, C.goldDark, 1)
  p.labels.push({ k: 'text', x: cx, y: cy + 0.55, text: t, size: 1.5, fill: C.white, anchor: 'middle', bold: true })
}

// ---------- 寵物 ----------

/**
 * (x0, y0)＝跟點陣版同一個 12×8 框的左上角。全部是素材畫風的圖、朝左（往右就翻面），貼框底置中；
 * 貓與柯基來自 2dPig，寶寶與山雀是 build_sheet.py 照同樣畫法自己畫的。素材沒有動畫格：走動時上下輕跳，山雀走動時翅膀一上一下
 */
function pet(p: Pen, kind: Pet, x0: number, y0: number, right: boolean, sitting: boolean, frame: number) {
  const k = 0.45
  const id: SpriteId = kind === 'baby' ? (sitting ? 'babySit' : 'babyCrawl') : kind === 'bird' ? (sitting || frame % 2 ? 'birdSit' : 'birdFly') : 'cat'
  const [, , sw, sh] = SPRITES[id]
  const bob = !sitting && kind !== 'bird' && frame % 2 ? -k : 0
  p.sprite(id, x0 + CAT_W / 2 - (sw * k) / 2, y0 + CAT_H - sh * k + bob, sw * k, sh * k, right)
}

function hearts(p: Pen, x: number, y: number) {
  p.glowing(() => p.text(x, y, '♥', 2.2, C.heart, { anchor: 'middle' }))
}

// ---------- 組合（跟 drawScene 同一套判斷） ----------

/** opts.clock：牆上時鐘顯示的字（例如現在時間 "14:05"）；沒給就照素材原圖 12:00。opts.corgiFed：餵柯基的那一格 */
export function drawVector(crew: Coworker[], frame: number, width: number, rows: number, walkers: Walker[] = [], seating?: Map<string, Placement>, opts: SceneOptions & { clock?: string; corgiFed?: number } = {}): VectorScene {
  crew = crew.map(c => (c.blocked ? { ...c, mode: 'blocked' as const } : c))
  const L = layout(width, rows)
  const p = new Pen(opts.night === true)
  const bosses = bossSeating(crew, width, rows, seating)
  const seatedCount = bosses.order.filter(b => b !== undefined).length
  building(p, L, width, frame, seatedCount < 2 || L.bossDesks[seatedCount - 1].x >= L.officeX + 6, opts.clock ?? '12:00')

  teamZones(bosses.leads, crew, L.cols).forEach((lead, z) => {
    const col = L.cols - 1 - z
    const look = TEAM_RUGS[z % TEAM_RUGS.length]
    L.clusters.forEach((k, i) => {
      if (i % L.cols !== col) return
      const rw = CLUSTER_W + 4
      p.rect(k.x - 2, k.y - 4, rw, GEOM.CLUSTER_H + 6, look.rug, 1.5, look.edge, 0.7)
      if (i === col) {
        const t = fitText(`TEAM ${lead.name}`, rw - 3, 1.7)
        const tw = textWidth(t, 1.7) + 1.2
        p.labelRect(k.x - 2 + (rw - tw) / 2, k.y - 4.6, tw, 2.2, look.edge, 1)
        p.labels.push({ k: 'text', x: k.x - 2 + rw / 2, y: k.y - 3, text: t, size: 1.7, fill: look.text, anchor: 'middle', bold: true })
      }
    })
  })
  for (const k of L.clusters) for (const dy of [0, UNIT_H + 2 + ROW_SPLIT]) partitionRow(p, k.x, k.y + dy)

  const moving = new Map<string, Step>()
  const errandOut = new Map<string, ErrandKind>()
  for (const w of walkers) {
    const at = walkerPos(w, frame)
    if (!at) continue
    moving.set(w.id, at)
    if (w.kind && (frame - w.start) * WALK_SPEED < pathLength(w.path) / 2) errandOut.set(w.id, w.kind)
  }
  const placed = assignSeats(crew, width, rows, seating, opts.meeting, opts.attendees)
  const prey = opts.raid ? placed.get(opts.raid.targetId) : undefined
  const raid = opts.raid && prey?.kind === 'staff' && !moving.has(opts.raid.targetId)
    ? raidPose(raidPath(prey, width, rows, opts.raid.start, opts.treatFrame, opts.catOffset, opts.pet), opts.raid.start, frame)
    : null
  const hugged: OfficeMode = opts.pet === 'baby' || opts.pet === 'bird' ? 'idle' : 'error'
  if (raid?.biting) crew = crew.map(c => (c.id === opts.raid!.targetId ? { ...c, mode: hugged } : c))
  const byId = new Map(crew.map(c => [c.id, c]))
  const queued = new Map((opts.queue ?? []).map((id, i) => [id, i]))
  for (const id of queued.keys()) if (!moving.has(id)) moving.set(id, { ...queueSpot(width, rows, queued.get(id)!), dx: 0, dy: 1 })

  // 主管的柯基：趴在主管室右下角；點了（opts.corgiFed＝那一格）冒愛心
  const corgi = p.spriteAt('corgi', width - WALL - 9.5, WALL + TOP_H - 4.2, 0.32)
  p.hits.push({ what: 'corgi', x: width - WALL - 9.5, y: WALL + TOP_H - 4.2, ...corgi })
  if (opts.corgiFed !== undefined && frame >= opts.corgiFed && frame - opts.corgiFed < TREAT_FRAMES) hearts(p, width - WALL - 5.5, WALL + TOP_H - 5 - (Math.floor((frame - opts.corgiFed) / 2) % 3))

  // 主管都穿西裝，造型再撞就認不出誰是誰：依桌號從名字雜湊那個造型起找沒人用的
  const used = new Set<number>()
  for (const b of bosses.leads) {
    let f = lookOf(b).person
    for (let i = 0; i < PEOPLE && used.has(f); i++) f = (f + 1) % PEOPLE
    used.add(f)
    p.faces.set(b.id, f)
  }

  const desks = [...placed].filter(([, pl]) => pl.kind === 'boss').sort((a, b) => a[1].slot - b[1].slot)
  const at = (id: string) => (!moving.has(id) ? byId.get(id) ?? null : null)
  if (desks.length <= 1) bossDesk(p, L.manager.x, L.manager.y, desks[0] ? at(desks[0][0]) : null, frame, bosses.extra)
  else desks.forEach(([id, pl], i) => smallBossDesk(p, pl.seat.x, pl.seat.y, at(id), frame, i === desks.length - 1 ? bosses.extra : 0))

  const sitting = new Map<string, Coworker>()
  for (const [id, pl] of placed) if (pl.kind === 'staff' && !moving.has(id)) sitting.set(`${pl.seat.x},${pl.seat.y}`, byId.get(id)!)
  for (const s of L.seats) unit(p, s.x, s.y, sitting.get(`${s.x},${s.y}`) ?? null, frame)

  // 會議室：上排坐在桌子後面（先畫人再補畫桌面蓋住下半身），下排坐在桌前
  const meet = [...placed].filter(([id, pl]) => pl.kind === 'meet' && !moving.has(id) && byId.has(id))
  const { cx: tx, cy: ty, a } = meetTable(L.officeX)
  for (const top of [true, false]) {
    for (const [id, pl] of meet) {
      if ((pl.slot % 2 === 0) !== top) continue
      const who = byId.get(id)!
      figure(p, pl.seat.x + 0.5, pl.seat.y + 1.5, who, frame)
      const above = pl.seat.y - 1.2
      nameTag(p, pl.seat.x + 0.5, top && above - NAME_SIZE >= WALL + 0.3 ? above : pl.seat.y + 6.4, who, 8, 'none') // 上排貼牆放不下就放到人下面
    }
    if (top) {
      longTable(p, tx - a, ty - 4, 2 * a + 1, 8) // 長桌：素材左右兩端照比例、中段拉長
      p.hits.push({ what: 'meeting', x: tx - a, y: ty - 4, w: 2 * a + 1, h: 8 })
    }
  }

  // 寵物先畫、走動與排隊的人後畫：窄面板排隊位置跟貓的路線重疊時人在前面（位置是跟 Raster 共用的計算，不改）
  const kind = opts.pet ?? 'cat'
  if (raid) {
    const lunge = raid.biting && frame % 2 ? (kind === 'baby' ? -1 : kind === 'bird' ? 0 : -2) : 0
    const x0 = raid.at.x - CAT_W / 2 + lunge
    const y0 = raid.at.y - CAT_H + 1 - (kind === 'bird' ? 2 : 0)
    pet(p, kind, x0, y0, raid.dx > 0, raid.biting, frame)
    p.hits.push({ what: 'pet', x: x0, y: y0, w: CAT_W, h: CAT_H, sitting: raid.biting })
    if (raid.biting) {
      if (kind === 'baby') hearts(p, x0 + 5, y0 - 1 - (Math.floor(frame / 2) % 3))
      else if (kind === 'bird') p.glowing(() => p.text(x0 + (raid.dx > 0 ? 9 : 1), y0 - (Math.floor(frame / 2) % 3), '♪', 2.4, C.note, { anchor: 'middle' }))
      else if (frame % 2) p.glowing(() => p.path(`M${x0 - 1} ${y0 + 1}l-2 1M${x0 - 1} ${y0 + 3}l-2.5 0M${x0 - 1} ${y0 + 5}l-2 -1`, 'none', C.err, 0.45))
    }
  } else {
    const fed = opts.treatFrame !== undefined && frame >= opts.treatFrame && frame - opts.treatFrame < TREAT_FRAMES
    const pose = catPose(catMoveFrame(frame, opts.treatFrame, opts.catOffset ?? 0), catRange(width))
    const startled = crew.some(c => c.mode === 'error') && !fed && frame % 2
    const x0 = WALL + CAT_START + pose.x
    const y0 = L.h - WALL - CAT_H - CAT_LIFT - (startled ? 2 : 0) - (kind === 'bird' ? 2 : 0)
    pet(p, kind, x0, y0, pose.facingRight, fed || pose.sitting, frame)
    p.hits.push({ what: 'pet', x: x0, y: y0, w: CAT_W, h: CAT_H, sitting: fed || pose.sitting })
    if (fed) {
      const bx = pose.facingRight ? x0 + CAT_W : x0 - 3
      if (kind === 'baby') p.rect(pose.facingRight ? x0 + CAT_W - 2 : x0 + 1, y0 + 2, 1.6, 3, C.bottle, 0.5, C.catNose, 0.2)
      else if (kind === 'bird') for (const [dx, dy] of [[0, 1], [1, 0], [2, 1]]) p.circle(bx + dx + 0.5, y0 + CAT_H - 1.5 + dy, 0.35, C.seed)
      else p.path(`M${bx} ${y0 + CAT_H - 2}h3l-0.5 1.6h-2Z`, C.heartBowl)
      hearts(p, x0 + CAT_W / 2, y0 - 1 - (Math.floor((frame - opts.treatFrame!) / 2) % 3))
    }
  }

  for (const [id, step] of moving) {
    const who = byId.get(id)
    if (!who) continue
    const standing = queued.has(id) && !walkers.some(w => w.id === id)
    figure(p, step.x + 0.5, step.y + 1.5, who, frame, standing ? 0 : frame % 2 ? 1 : -1, false, step.dx)
    p.avoid.push({ x: step.x - 3.5, y: step.y - 4.5, w: 9, h: 11 }) // 人＋頭上名牌
    const kind = errandOut.get(id) ?? (queued.has(id) ? 'mail' : undefined)
    if (kind) carry(p, step, kind)
    if (standing) nameTag(p, step.x + 0.5, step.y - 2.4, who, 8, C.white)
  }

  for (const nt of opts.notices ?? []) {
    const pl = placed.get(nt.id)
    if (pl && frame >= nt.start && frame < nt.end && frame % 2 === 0) {
      p.rect(pl.stand.x + 3, pl.stand.y - 3, 3, 2, C.envelope, 0.2, C.envelopeLine, 0.15)
      p.path(`M${pl.stand.x + 3} ${pl.stand.y - 3}l1.5 1 1.5 -1`, 'none', C.envelopeLine, 0.2)
    }
  }
  for (const pl of opts.planes ?? []) {
    const a = planePos(pl, frame)
    if (a) p.path(`M${a.x + 0.5} ${a.y + 0.5}l${-a.dx * 2.6} -1.3 ${a.dx * 0.6} 1.3 ${-a.dx * 0.6} 1.3Z`, C.plane, C.planeFold, 0.2)
  }

  const extra = crew.length - placed.size - bosses.extra
  if (extra > 0) p.text(WALL + 0.5, 1.6, `+${extra}`, 1.8, C.white, { bold: true })
  // 每件東西所在的房間：上排會議室／主管室，其餘是員工區＋走廊
  const top = WALL + TOP_H
  const meetRoom = { x: WALL, y: WALL, w: L.officeX - 2 * WALL, h: TOP_H }
  const bossRoom = { x: L.officeX, y: WALL, w: width - WALL - L.officeX, h: TOP_H }
  const floor = { x: WALL, y: top + WALL, w: width - 2 * WALL, h: L.h - top - 2 * WALL }
  for (const hit of p.hits) hit.room = hit.y + hit.h / 2 < top ? (hit.x < L.officeX ? meetRoom : bossRoom) : floor
  return { width, h: L.h, night: p.night, shapes: p.shapes, glow: p.glow, labels: p.labels, hits: p.hits, avoid: p.avoid }
}

// ---------- 點擊：場景單位 → 面板字元格（register.tsx 疊按鈕與選單用） ----------

/**
 * 場景單位 → 面板字元格（疊按鈕用）。終端機 Raster 一格＝1 單位寬、2 單位高（精確）；
 * Desktop 的 Svg 撐滿面板寬：一欄＝1 單位、一列＝2.5 單位（2026-10-27 Desktop 實測，office-calib 0.0.2，四個十字都對準）。
 * k＝面板欄數／場景寬：場景比面板寬（Svg 被縮小）或窄（被放大）時，一單位就不是一欄，乘上 k 換算
 */
export const CELL_UNITS = { terminal: { col: 1, row: 2 }, desktop: { col: 1, row: 2.5 } }
export function cellAt(x: number, y: number, surface: 'terminal' | 'desktop', k = 1): { top: number; left: number } {
  const u = CELL_UNITS[surface]
  return { top: Math.max(0, Math.floor((y * k) / u.row)), left: Math.max(0, Math.floor((x * k) / u.col)) }
}
/** 字元格寬：中日韓全形字 2 格 */
export const cellWidth = (t: string) => [...t].reduce((n, ch) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1), 0)

/**
 * 選單放哪（字元格）：依序試家具的右、左、上、下，選單要整個留在家具所在的房間（會議室的選單不壓主管室），
 * 先挑不蓋到其他點得到的東西與走動、排隊的人的那一側；每一側都會蓋到就挑蓋最少的。按鈕寬＝字寬＋4（含框）
 */
export function menuPlace(it: Hit, labels: string[], others: Rect[], surface: 'terminal' | 'desktop', k: number, sceneW: number): { top: number; left: number } {
  const u = CELL_UNITS[surface]
  const box = (r: Rect) => ({ t: Math.floor((r.y * k) / u.row), l: Math.floor((r.x * k) / u.col), b: Math.ceil(((r.y + r.h) * k) / u.row), r: Math.ceil(((r.x + r.w) * k) / u.col) })
  const I = box(it)
  const R = box(it.room ?? { x: 0, y: 0, w: sceneW, h: it.y + it.h })
  const cw = Math.max(...labels.map(cellWidth)) + 4
  const ch = labels.length
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi))
  const sideTop = clamp(I.b - ch, R.t, R.b - ch)
  const midLeft = clamp(I.l, R.l, R.r - cw)
  const tries = [
    { top: sideTop, left: I.r + 1 },
    { top: sideTop, left: I.l - 1 - cw },
    { top: I.t - ch, left: midLeft },
    { top: I.b, left: midLeft },
  ]
  const fits = tries.filter(m => m.left >= R.l && m.left + cw <= R.r && m.top >= R.t && m.top + ch <= R.b)
  const hits = (m: { top: number; left: number }) => others.map(box).filter(o => o.l < m.left + cw && m.left < o.r && o.t < m.top + ch && m.top < o.b).length
  const best = fits.reduce<{ top: number; left: number } | undefined>((a, m) => (a === undefined || hits(m) < hits(a) ? m : a), undefined)
  return best ?? { top: Math.max(0, I.t - ch), left: clamp(I.l, 0, Math.max(0, R.r - cw)) }
}


// ---------- SVG ----------

const hex = (c: Paint) => (typeof c === 'number' ? '#' + (c & 0xffffff).toString(16).padStart(6, '0') : c)
const xml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function shapeSvg(s: Shape): string {
  const paint = (x: { fill?: Paint; stroke?: Paint; sw?: number; op?: number }) =>
    `${x.fill !== undefined ? ` fill="${hex(x.fill)}"` : ' fill="none"'}${x.stroke !== undefined ? ` stroke="${hex(x.stroke)}" stroke-width="${n(x.sw ?? 0.3)}" stroke-linecap="round"` : ''}${x.op !== undefined ? ` opacity="${x.op}"` : ''}`
  if (s.k === 'sprite') {
    const [sx, sy, sw, sh] = s.src
    const fit = Math.abs(s.w / s.h - sw / sh) > 0.01 ? ' preserveAspectRatio="none"' : ''
    const flip = s.flip ? ` transform="matrix(-1 0 0 1 ${2 * sx + sw} 0)"` : ''
    return `<svg x="${n(s.x)}" y="${n(s.y)}" width="${n(s.w)}" height="${n(s.h)}" viewBox="${sx} ${sy} ${sw} ${sh}"${fit}><use href="#S"${flip}/></svg>`
  }
  if (s.k === 'rect') return `<rect x="${n(s.x)}" y="${n(s.y)}" width="${n(s.w)}" height="${n(s.h)}"${s.r ? ` rx="${n(s.r)}"` : ''}${paint(s)}/>`
  if (s.k === 'circle') return `<circle cx="${n(s.cx)}" cy="${n(s.cy)}" r="${n(s.r)}"${paint(s)}/>`
  if (s.k === 'ellipse') return `<ellipse cx="${n(s.cx)}" cy="${n(s.cy)}" rx="${n(s.rx)}" ry="${n(s.ry)}"${paint(s)}/>`
  if (s.k === 'path') return `<path d="${s.d}"${paint(s)}/>`
  const bg = s.bg !== undefined && s.bg !== 'none' ? (() => {
    const w = textWidth(s.text, s.size) + 0.6
    const x = s.anchor === 'middle' ? s.x - w / 2 : s.x - 0.3
    return `<rect x="${n(x)}" y="${n(s.y - s.size * 0.85)}" width="${n(w)}" height="${n(s.size * 1.1)}" rx="0.4" fill="${hex(s.bg)}"/>`
  })() : ''
  const halo = s.halo !== undefined ? ` stroke="${hex(s.halo)}" stroke-width="0.5" stroke-linejoin="round" paint-order="stroke"` : ''
  const mono = s.mono ? ' font-family="Consolas,Menlo,monospace"' : ''
  return `${bg}<text x="${n(s.x)}" y="${n(s.y)}" font-size="${s.size}" fill="${hex(s.fill)}"${halo}${mono}${s.anchor === 'middle' ? ' text-anchor="middle"' : ''}${s.bold ? ' font-weight="bold"' : ''}>${xml(s.text)}</text>`
}

/** 地板：素材的藍色長磚（一列錯半塊） */
const FLOOR = `<pattern id="tile" width="12" height="5" patternUnits="userSpaceOnUse"><rect width="12" height="5" fill="${hex(SW.sky)}"/><path d="M0 0.2H12M0 2.7H12" stroke="${hex(SW.cyan)}" stroke-width="0.3"/><path d="M0 2.35H12M0 4.85H12M0.15 0V2.5M6.15 2.5V5" stroke="${hex(SW.blue)}" stroke-width="0.3"/></pattern>`

/** 形狀清單 → SVG（一單位一像素、寬高放大 pxSize 倍）；素材表只嵌一次。夜裡在中間蓋一層暗幕，發光的畫在暗幕之上 */
export function vectorSvg(v: VectorScene, pxSize = 8): string {
  const defs = `<defs><image id="S" width="${SHEET_W}" height="${SHEET_H}" href="data:image/png;base64,${SHEET_PNG}" style="image-rendering:pixelated"/>${FLOOR}</defs>`
  const body = v.shapes.map(shapeSvg).join('')
  const dark = v.night ? `<rect width="${v.width}" height="${v.h}" fill="#050a1e" opacity="0.66"/>${v.glow.map(shapeSvg).join('')}` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${v.width} ${v.h}" width="${v.width * pxSize}" height="${v.h * pxSize}" font-family="${FONT}">${defs}${body}${dark}${v.labels.map(shapeSvg).join('')}</svg>`
}
