// Desktop（Svg 元素）的向量畫法：跟 drawScene 吃同一份 crew、座位、SceneOptions，座標也是同一套「像素」單位，
// 只是輸出一份形狀清單（圓、圓角矩形、路徑、文字）而不是點陣。純資料、不依賴 $；終端機的 Raster 照舊走 drawScene。
import type { Coworker, ErrandKind, OfficeMode, Pet } from '../types'
import {
  BOOKS, GEOM, HAIR, OFFICE_DOOR_W, OFFICE_DOOR_X, PALETTE as C, SHIRTS, TEAM_RUGS,
  assignSeats, bossSeating, catMoveFrame, catPose, catRange, counterSpot, counterX, hash, layout, mailboxX, meetTable,
  pathLength, planePos, queueSpot, raidPath, raidPose, shade, teamZones, walkerPos,
  type Placement, type SceneOptions, type Seat, type Step, type Walker,
} from './scene'

const { WALL, TOP_H, OPEN_Y, UNIT_W, UNIT_H, CLUSTER_W, CLUSTER_H, BOSS_W, CABINET_X, CAT_START, CAT_W, CAT_H, CAT_LIFT, DESK_W, COUNTER_W, MEET_DOOR_W, WALK_SPEED, TREAT_FRAMES } = GEOM
void BOSS_W

type Paint = number | string // 數字＝顏色，字串＝原樣（例如 url(#tile)）
export type Shape =
  | { k: 'rect'; x: number; y: number; w: number; h: number; r?: number; fill: Paint; stroke?: Paint; sw?: number; op?: number }
  | { k: 'circle'; cx: number; cy: number; r: number; fill: Paint; stroke?: Paint; sw?: number; op?: number }
  | { k: 'ellipse'; cx: number; cy: number; rx: number; ry: number; fill: Paint; stroke?: Paint; sw?: number }
  | { k: 'path'; d: string; fill?: Paint; stroke?: Paint; sw?: number; op?: number }
  | { k: 'text'; x: number; y: number; text: string; size: number; fill: Paint; anchor?: 'start' | 'middle'; bold?: boolean; bg?: Paint; halo?: Paint }

/** shapes → 夜間暗幕 → glow（夜裡發光的）→ labels（名牌、TEAM 牌：永遠最上層，什麼都蓋不到它） */
export type VectorScene = { width: number; h: number; night: boolean; shapes: Shape[]; glow: Shape[]; labels: Shape[] }

const FONT = "'Microsoft JhengHei','PingFang TC','Noto Sans TC','Noto Sans CJK TC',sans-serif"
const NAME_SIZE = 1.9
const NAME_MIN = 1.5 // 放不下先縮到這麼小，還放不下才截字

/** 字的估計寬度：全形（中日韓）一個字＝字高，半形約 0.6 */
const wide = (ch: string) => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch)
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
  text(x: number, y: number, text: string, size: number, fill: Paint, o: { anchor?: 'start' | 'middle'; bold?: boolean; bg?: Paint } = {}) {
    if (text) this.put({ k: 'text', x, y, text, size, fill, ...o })
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

function building(p: Pen, L: ReturnType<typeof layout>, w: number, frame: number, plantInOffice: boolean) {
  const { officeX, officeW, h } = L
  p.rect(0, 0, w, h, 'url(#tile)')
  // 會議室木地板（木紋一條 path）、主管室地毯
  p.rect(WALL, WALL, officeX - 2 * WALL, TOP_H, C.meetFloor)
  let planks = ''
  for (let y = WALL + 3; y < WALL + TOP_H; y += 4) planks += `M${WALL} ${y + 0.5}H${officeX - WALL}`
  p.path(planks, undefined, C.meetPlank, 0.35)
  p.rect(officeX, WALL, w - WALL - officeX, TOP_H, C.rugTrim)
  p.rect(officeX + 1, WALL + 1, w - WALL - officeX - 2, TOP_H - 2, C.rug, 1.5)

  // 牆
  for (const [x, y, rw, rh] of [[0, 0, w, WALL], [0, h - WALL, w, WALL], [0, 0, WALL, h], [w - WALL, 0, WALL, h], [0, WALL + TOP_H, w, WALL], [officeX - WALL, 0, WALL, OPEN_Y]]) p.rect(x, y, rw, rh, C.wall)
  p.rect(WALL, OPEN_Y - 1, w - 2 * WALL, 0.5, C.wallHi)

  // 窗戶（夜裡換成夜空＋星星，畫在暗幕上面）
  p.glowing(() => {
    for (let x = 5; x + 6 < w - 3; x += 11) {
      p.rect(x, 0.2, 6, 1.2, p.night ? C.nightSky : C.glass, 0.4)
      if (p.night && (x + frame) % 7 !== 0) p.circle(x + 2.5, 0.8, 0.3, C.star)
    }
    for (let y = OPEN_Y + 4; y + 6 < h - 4; y += 11) {
      p.rect(0.2, y, 1.2, 6, p.night ? C.nightSky : C.glass, 0.4)
      p.rect(w - 1.4, y, 1.2, 6, p.night ? C.nightSky : C.glass, 0.4)
    }
  })

  // 門洞
  p.rect(L.meetDoor, WALL + TOP_H, MEET_DOOR_W, WALL, C.tileA)
  p.rect(officeX + OFFICE_DOOR_X, WALL + TOP_H, OFFICE_DOOR_W, WALL, C.tileA)
  p.path(`M${officeX + OFFICE_DOOR_X} ${WALL + TOP_H}A${OFFICE_DOOR_W} ${OFFICE_DOOR_W - 3} 0 0 1 ${officeX + OFFICE_DOOR_X + OFFICE_DOOR_W} ${WALL + TOP_H - 4}`, 'none', C.ink, 0.3)
  p.rect(Math.floor(w / 2) - 3, h - WALL, 6, WALL, C.tileA)

  // 門牌（向量版可以寫中文）
  const signY = WALL + TOP_H + 1.5
  p.text(officeX + OFFICE_DOOR_X + OFFICE_DOOR_W + 1, signY, '主管室', 1.7, C.gold, { bold: true })
  if (L.meetDoor - WALL - 1 >= 7) p.text(WALL + 1, signY, '會議室', 1.7, C.glassHi, { bold: true })

  // 會議室：白板、橢圓長桌、椅子、時鐘
  p.rect(WALL, WALL + 6, 1, 8, C.board, 0.3)
  p.rect(WALL + 0.2, WALL + 8, 0.6, 0.6, C.marker)
  const { cx, cy, a, b } = meetTable(officeX)
  p.ellipse(cx + 0.5, cy + 0.5, a + 0.5, b + 0.5, C.table, C.tableEdge, 0.6)
  p.ellipse(cx + 0.5, cy - 0.5, a - 1.5, b - 1.8, C.tableHi)
  for (let x = Math.ceil(cx - a) + 1; x < cx + a - 1; x += 3) {
    p.rect(x, Math.floor(cy - b) - 3, 2, 2, C.chair, 0.6)
    p.rect(x, Math.ceil(cy + b) + 2, 2, 2, C.chair, 0.6)
  }
  p.circle(WALL + 3.5, WALL + 2.5, 1.6, C.white, C.text, 0.2)
  const ang = (Math.floor(frame / 4) % 4) * (Math.PI / 2)
  p.path(`M${WALL + 3.5} ${WALL + 2.5}l${n(Math.sin(ang) * 1.1)} ${n(-Math.cos(ang) * 1.1)}`, undefined, C.text, 0.25)

  // 書架
  p.rect(officeX + 7, WALL, officeW - 9, 2, C.bossEdge)
  for (let x = officeX + 7; x < officeX + officeW - 2; x++) p.rect(x + 0.1, WALL + 0.6, 0.8, 1.3, BOOKS[(x * 7) % BOOKS.length], 0.15)

  if (plantInOffice) plant(p, officeX + 1, WALL + 1)
  plant(p, WALL + 1, h - WALL - 7)
  plant(p, w - WALL - 6, h - WALL - 7)

  // 影印機、檔案櫃、郵筒、櫃台
  const cpx = w - WALL - 16
  const cpy = h - WALL - 7
  p.rect(cpx, cpy, 8, 5, C.copier, 0.8)
  p.rect(cpx, cpy, 8, 1.2, C.copierTop, 0.5)
  p.rect(cpx + 1, cpy + 2, 4, 2, C.paper, 0.3)
  p.glowing(() => p.circle(cpx + 6.5, cpy + 2.5, 0.5, frame % 4 < 2 ? C.led : C.copierTop))
  p.rect(CABINET_X, cpy - 1, 6, 6, C.cabinet, 0.5)
  for (const dy of [0, 2, 4]) {
    p.rect(CABINET_X, cpy - 1 + dy, 6, 0.4, C.cabinetDark)
    p.rect(CABINET_X + 2.5, cpy + dy + 0.2, 1, 0.5, C.handle, 0.2)
  }
  const mx = mailboxX(w)
  p.rect(mx, h - WALL - 6, 3, 4, C.mailbox, 1)
  p.rect(mx + 0.5, h - WALL - 4.5, 2, 0.5, C.mailboxDark)
  if (counterSpot(w, h / 2)) {
    const qx = counterX(w)
    const qy = h - WALL - 4
    p.rect(qx, qy, COUNTER_W, 4, C.table, 0.8)
    p.rect(qx, qy, COUNTER_W, 1, C.tableHi, 0.5)
    p.glowing(() => p.circle(qx + 1.5, qy + 1.6, 0.6, C.gold))
    p.rect(qx + 4, qy + 1.2, 2, 1.2, C.paper, 0.2)
    p.text(qx + COUNTER_W / 2, h - 0.4, 'YOU', 1.7, C.gold, { anchor: 'middle', bold: true })
  }
}

function plant(p: Pen, x: number, y: number) {
  p.rect(x + 1, y + 3.5, 3, 2.5, C.potRim, 0.6)
  p.circle(x + 2.5, y + 2.4, 1.8, C.leafMid)
  p.circle(x + 1.4, y + 1.6, 1.2, C.leaf)
  p.circle(x + 3.6, y + 1.8, 1.1, C.leafDark)
}

function partitions(p: Pen, k: Seat) {
  p.rect(k.x + UNIT_W, k.y, 1, CLUSTER_H, C.partLo, 0.4)
  p.rect(k.x, k.y + UNIT_H, CLUSTER_W, 2, C.partHi, 0.5)
}

// ---------- 人 ----------

const screenColor = (mode: OfficeMode | null, frame: number): number => {
  if (mode === null) return C.off
  if (mode === 'typing') return C.codeDim
  if (mode === 'reading') return C.white
  if (mode === 'error') return frame % 2 ? C.err : C.errDark
  if (mode === 'waiting') return frame % 2 ? C.wait : C.waitDark
  if (mode === 'blocked') return frame % 4 < 2 ? C.errDark : C.mon
  if (mode === 'done') return C.ok
  if (mode === 'thinking') return C.screenDim
  return C.screen
}

function screen(p: Pen, x: number, y: number, w: number, mode: OfficeMode | null, frame: number) {
  p.rect(x - 0.3, y - 0.3, w + 0.6, 1.9, C.mon, 0.4)
  p.glowing(() => {
    p.rect(x, y, w, 1.3, screenColor(mode, frame), 0.25)
    if (mode === 'typing') for (let i = 0; i < 3; i++) p.rect(x + 0.4, y + 0.2 + i * 0.35, ((i * 3 + frame) % 4) + 1, 0.2, C.code)
  })
}

const looks = (who: Coworker) => {
  const hh = hash(who.id)
  return { shirt: who.role === 'manager' ? C.suit : SHIRTS[hh % SHIRTS.length], hair: HAIR[(hh >> 4) % HAIR.length], hh }
}

/** 圓頭小人：(x, y) 是頭的圓心。表情依 mode：thinking 眼睛往上、error 冒汗發抖、done 跳一下、waiting 頭上問號、idle 會眨眼 */
function figure(p: Pen, x: number, y: number, who: Coworker, frame: number, walkStep?: number, side = false) {
  const { shirt, hair, hh } = looks(who)
  const mode = who.mode
  const shake = mode === 'error' ? (frame % 2 ? 0.4 : -0.4) : 0
  const hop = mode === 'done' && frame % 2 ? -0.9 : 0
  const hx = x + shake
  const hy = y + hop
  if (walkStep !== undefined) {
    p.circle(x - 1 + walkStep * 0.6, y + 3.6, 0.6, C.shoe)
    p.circle(x + 1 - walkStep * 0.6, y + 3.6, 0.6, C.shoe)
  }
  // 身體在頭後面
  p.rect(x - 3, hy + 1.1, 6, 2.6, shirt, 1.2)
  if (who.isMe) p.circle(hx, hy, 2.55, 'none', C.me, 0.35)
  p.circle(hx, hy, 2, C.skin)
  p.path(`M${n(hx - 2)} ${n(hy - 0.25)}A2 2 0 0 1 ${n(hx + 2)} ${n(hy - 0.25)}Z`, hair)

  // 眼睛
  const blink = mode === 'idle' && (frame + hh) % 8 === 0
  const ey = hy + (mode === 'thinking' ? -0.05 : mode === 'typing' ? 0.55 : 0.3)
  const ex = mode === 'reading' ? 0.35 : 0
  if (blink) p.path(`M${n(hx - 1.1)} ${n(ey)}h0.6M${n(hx + 0.5)} ${n(ey)}h0.6`, undefined, C.text, 0.22)
  else {
    p.circle(hx - 0.75 + ex, ey, 0.3, C.text)
    p.circle(hx + 0.75 + ex, ey, 0.3, C.text)
  }
  if (mode === 'done') p.path(`M${n(hx - 0.7)} ${n(hy + 0.95)}q0.7 0.6 1.4 0`, 'none', C.text, 0.2)
  if (mode === 'error') p.path(`M${n(hx - 0.6)} ${n(hy + 1.25)}q0.6 -0.45 1.2 0`, 'none', C.text, 0.2)

  // 手與道具
  if (mode === 'typing') {
    const up = frame % 2
    p.circle(x - 1.6, hy + 3.4 - up * 0.4, 0.55, C.skin)
    p.circle(x + 1.6, hy + 3.0 + up * 0.4, 0.55, C.skin)
  } else if (mode === 'reading') p.rect(x + 1.2, hy + 2.2, 2, 2.2, C.white, 0.2, C.ink, 0.15)
  else if (mode === 'waiting' || mode === 'blocked') p.circle(x + 3.2, hy - 0.4, 0.6, C.skin)

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
}

function nameTag(p: Pen, x: number, y: number, who: Coworker, maxW: number, bg: Paint, align: 'start' | 'middle' = 'middle') {
  const t = fitLabel(`${who.role === 'manager' ? '★' : ''}${who.name}`, maxW)
  p.label(x, y, t.text, t.size, who.isMe ? C.me : who.role === 'manager' ? C.goldDark : C.text, { anchor: align, bold: who.isMe, bg })
}

function carry(p: Pen, at: Step, kind: ErrandKind) {
  const x = at.x + 0.5 + (at.dx !== 0 ? at.dx * 3 : 3)
  const y = at.y + 2.5
  if (kind === 'mail') p.rect(x - 0.9, y - 1, 1.8, 2.2, C.paper, 0.2, C.ink, 0.15)
  else if (kind === 'file') p.rect(x - 1, y - 0.9, 2.2, 1.8, C.folder, 0.3)
  else p.rect(x - 1, y - 1, 2.2, 2.2, C.parcel, 0.3, C.cabinetDark, 0.2)
}

// ---------- 座位 ----------

function unit(p: Pen, x: number, y: number, who: Coworker | null, frame: number) {
  p.rect(x + 3, y, 5, 5, C.chair, 1.6)
  p.rect(x + 1, y + 5, 9, 7, C.desk, 0.8)
  p.rect(x + 1, y + 11, 9, 1, C.deskFront, 0.4)
  p.rect(x + 1.2, y + 8, 1.8, 2.2, C.paper, 0.2)
  p.circle(x + 9, y + 9, 0.6, C.mug, C.coffee, 0.25)
  screen(p, x + 3, y + 9.2, 5, who ? who.mode : null, frame)
  if (who) {
    figure(p, x + 5.5, y + 2.2, who, frame)
    p.rect(x + 4, y + 5.2, 3, 0.8, C.key, 0.2)
    nameTag(p, x + 5.5, y + 7.7, who, 8.6, 'none')
  } else p.rect(x + 4, y + 5.2, 3, 0.8, C.key, 0.2)
}

function bossDesk(p: Pen, x: number, y: number, who: Coworker | null, frame: number, extra: number) {
  p.rect(x, y, 14, 6, C.boss, 0.8)
  p.rect(x + 14, y, 3, 11, C.boss, 0.8)
  p.rect(x, y, 17, 1, C.bossHi, 0.5)
  screen(p, x + 4, y + 1.3, 6, who ? who.mode : null, frame)
  p.glowing(() => p.circle(x + 1.5, y + 1.5, 0.6, C.gold))
  p.rect(x + 14.2, y + 6, 2, 2, C.paper, 0.2)
  p.rect(x + 3, y + 7, 9, 4.5, C.leather, 1.5)
  p.rect(x - 4, y + 1, 2, 2, C.chair, 0.6)
  p.rect(x - 4, y + 4, 2, 2, C.chair, 0.6)
  if (who) {
    figure(p, x + 7.5, y + 8.6, who, frame, undefined, true)
    const t = fitLabel(`★${who.name}`, 13)
    p.label(x + 7, y + 4.6, t.text, t.size, C.gold, { anchor: 'middle', bold: true })
  }
  if (extra > 0) plusBadge(p, x + 15.5, y + 3.2, extra)
}

function smallBossDesk(p: Pen, x: number, y: number, who: Coworker | null, frame: number, extra: number) {
  p.rect(x, y, DESK_W, 6, C.boss, 0.8)
  p.rect(x, y, DESK_W, 1, C.bossHi, 0.5)
  screen(p, x + 1, y + 1.3, 6, who ? who.mode : null, frame)
  p.rect(x, y + 7, 9, 4.5, C.leather, 1.5)
  if (who) {
    figure(p, x + 4.5, y + 8.6, who, frame, undefined, true)
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

/** (x0, y0)＝跟點陣版同一個 12×8 框的左上角 */
function pet(p: Pen, kind: Pet, x0: number, y0: number, right: boolean, sitting: boolean, frame: number) {
  const s = right ? 1 : -1
  const mid = x0 + CAT_W / 2
  const step = frame % 2 ? 0.5 : -0.5
  if (kind === 'bird') {
    p.ellipse(mid, y0 + 5, 2.6, 2.2, C.birdWhite, C.birdShade, 0.2)
    p.ellipse(mid - s * 0.8, y0 + 5.3, 1.6, 1.1, C.birdWing)
    p.path(`M${n(mid - s * 2.4)} ${y0 + 5}l${-s * 2.2} 0.8 ${s * 0.4} -1.4Z`, C.birdTail)
    p.circle(mid + s * 1.6, y0 + 3.3, 1.5, C.birdWhite)
    p.path(`M${n(mid + s * 0.2)} ${n(y0 + 3)}A1.5 1.5 0 0 1 ${n(mid + s * 3)} ${n(y0 + 3)}Z`, C.birdWing)
    p.circle(mid + s * 2.1, y0 + 3.4, 0.25, C.catEye)
    p.circle(mid + s * 1.3, y0 + 4, 0.35, C.birdBlush)
    if (!sitting) p.path(`M${mid - 1.5} ${y0 + 4}q1.5 ${-2 - step * 2} 3 0`, 'none', C.birdWing, 0.5)
    return
  }
  if (kind === 'baby') {
    p.ellipse(mid - s * 0.5, y0 + 5.2, sitting ? 2.6 : 3.4, sitting ? 2.4 : 1.8, C.babySuit)
    p.ellipse(mid - s * 1.2, y0 + 6, 1.3, 1, C.babyDiaper)
    if (!sitting) {
      p.circle(mid - 2.5 + step, y0 + 7, 0.6, C.babySkin)
      p.circle(mid + 2.5 - step, y0 + 7, 0.6, C.babySkin)
    }
    p.circle(mid + s * 2, y0 + 3, 2, C.babySkin)
    p.path(`M${n(mid + s * 2 - 0.8)} ${n(y0 + 1.2)}q0.8 -0.9 1.6 0`, 'none', C.babyHair, 0.4)
    p.circle(mid + s * 2.6, y0 + 3, 0.25, C.catEye)
    p.circle(mid + s * 1.4, y0 + 3, 0.25, C.catEye)
    return
  }
  // 貓：身體、頭朝前進方向、三角耳、翹尾巴
  if (sitting) p.ellipse(mid - s * 0.5, y0 + 5, 2.6, 2.7, C.cat)
  else {
    p.ellipse(mid - s * 0.5, y0 + 5.2, 3.8, 2, C.cat)
    for (const [dx, ph] of [[-2.6, 1], [-1.2, -1], [0.8, 1], [2.2, -1]]) p.rect(mid + dx + ph * step * 0.6, y0 + 6.4, 0.8, 1.6, C.catDark, 0.3)
  }
  p.path(`M${n(mid - s * 3.8)} ${n(y0 + 5)}q${-s * 2} -1 ${-s * 1.2} -3.6`, 'none', C.catDark, 0.7)
  const hx = mid + s * 2.6
  const hy = y0 + 2.8
  p.path(`M${n(hx - 1.6)} ${n(hy - 0.6)}l0.4 -1.8 1.1 1.2ZM${n(hx + 1.6)} ${n(hy - 0.6)}l-0.4 -1.8 -1.1 1.2Z`, C.catDark)
  p.circle(hx, hy, 1.8, C.cat)
  p.ellipse(hx + s * 0.3, hy + 0.7, 0.9, 0.6, C.catCream)
  p.circle(hx - 0.6 + s * 0.3, hy - 0.2, 0.25, C.catEye)
  p.circle(hx + 0.6 + s * 0.3, hy - 0.2, 0.25, C.catEye)
  p.circle(hx + s * 0.4, hy + 0.5, 0.2, C.catNose)
}

function hearts(p: Pen, x: number, y: number) {
  p.glowing(() => p.text(x, y, '♥', 2.2, C.heart, { anchor: 'middle' }))
}

// ---------- 組合（跟 drawScene 同一套判斷） ----------

export function drawVector(crew: Coworker[], frame: number, width: number, rows: number, walkers: Walker[] = [], seating?: Map<string, Placement>, opts: SceneOptions = {}): VectorScene {
  crew = crew.map(c => (c.blocked ? { ...c, mode: 'blocked' as const } : c))
  const L = layout(width, rows)
  const p = new Pen(opts.night === true)
  const bosses = bossSeating(crew, width, rows, seating)
  const seatedCount = bosses.order.filter(b => b !== undefined).length
  building(p, L, width, frame, seatedCount < 2 || L.bossDesks[seatedCount - 1].x >= L.officeX + 6)

  teamZones(bosses.leads, crew, L.cols).forEach((lead, z) => {
    const col = L.cols - 1 - z
    const look = TEAM_RUGS[z % TEAM_RUGS.length]
    L.clusters.forEach((k, i) => {
      if (i % L.cols !== col) return
      const rw = CLUSTER_W + 4
      p.rect(k.x - 2, k.y - 4, rw, CLUSTER_H + 6, look.rug, 1.5, look.edge, 0.7)
      if (i === col) {
        const t = fitText(`TEAM ${lead.name}`, rw - 3, 1.7)
        const tw = textWidth(t, 1.7) + 1.2
        p.labelRect(k.x - 2 + (rw - tw) / 2, k.y - 4.6, tw, 2.2, look.edge, 1)
        p.labels.push({ k: 'text', x: k.x - 2 + rw / 2, y: k.y - 3, text: t, size: 1.7, fill: look.text, anchor: 'middle', bold: true })
      }
    })
  })
  for (const k of L.clusters) partitions(p, k)

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

  const desks = [...placed].filter(([, pl]) => pl.kind === 'boss').sort((a, b) => a[1].slot - b[1].slot)
  const at = (id: string) => (!moving.has(id) ? byId.get(id) ?? null : null)
  if (desks.length <= 1) bossDesk(p, L.manager.x, L.manager.y, desks[0] ? at(desks[0][0]) : null, frame, bosses.extra)
  else desks.forEach(([id, pl], i) => smallBossDesk(p, pl.seat.x, pl.seat.y, at(id), frame, i === desks.length - 1 ? bosses.extra : 0))

  const sitting = new Map<string, Coworker>()
  for (const [id, pl] of placed) if (pl.kind === 'staff' && !moving.has(id)) sitting.set(`${pl.seat.x},${pl.seat.y}`, byId.get(id)!)
  for (const s of L.seats) unit(p, s.x, s.y, sitting.get(`${s.x},${s.y}`) ?? null, frame)

  for (const [id, pl] of placed) {
    const who = byId.get(id)
    if (pl.kind !== 'meet' || moving.has(id) || !who) continue
    const top = pl.slot % 2 === 0
    figure(p, pl.seat.x + 0.5, pl.seat.y + 1.5, who, frame)
    const above = pl.seat.y - 1.2
    nameTag(p, pl.seat.x + 0.5, top && above - NAME_SIZE >= WALL + 0.3 ? above : pl.seat.y + 6.4, who, 8, 'none') // 上排貼牆放不下就放到人下面
  }

  for (const [id, step] of moving) {
    const who = byId.get(id)
    if (!who) continue
    const standing = queued.has(id) && !walkers.some(w => w.id === id)
    figure(p, step.x + 0.5, step.y + 1.5, who, frame, standing ? 0 : frame % 2 ? 1 : -1)
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

  const kind = opts.pet ?? 'cat'
  if (raid) {
    const lunge = raid.biting && frame % 2 ? (kind === 'baby' ? -1 : kind === 'bird' ? 0 : -2) : 0
    const x0 = raid.at.x - CAT_W / 2 + lunge
    const y0 = raid.at.y - CAT_H + 1 - (kind === 'bird' ? 2 : 0)
    pet(p, kind, x0, y0, raid.dx > 0, raid.biting, frame)
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
    if (fed) {
      const bx = pose.facingRight ? x0 + CAT_W : x0 - 3
      if (kind === 'baby') p.rect(pose.facingRight ? x0 + CAT_W - 2 : x0 + 1, y0 + 2, 1.6, 3, C.bottle, 0.5, C.catNose, 0.2)
      else if (kind === 'bird') for (const [dx, dy] of [[0, 1], [1, 0], [2, 1]]) p.circle(bx + dx + 0.5, y0 + CAT_H - 1.5 + dy, 0.35, C.seed)
      else p.path(`M${bx} ${y0 + CAT_H - 2}h3l-0.5 1.6h-2Z`, C.heartBowl)
      hearts(p, x0 + CAT_W / 2, y0 - 1 - (Math.floor((frame - opts.treatFrame!) / 2) % 3))
    }
  }

  const extra = crew.length - placed.size - bosses.extra
  if (extra > 0) p.text(WALL + 0.5, 1.6, `+${extra}`, 1.8, C.white, { bold: true })
  return { width, h: L.h, night: p.night, shapes: p.shapes, glow: p.glow, labels: p.labels }
}

// ---------- SVG ----------

const hex = (c: Paint) => (typeof c === 'number' ? '#' + (c & 0xffffff).toString(16).padStart(6, '0') : c)
const xml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function shapeSvg(s: Shape): string {
  const paint = (x: { fill?: Paint; stroke?: Paint; sw?: number; op?: number }) =>
    `${x.fill !== undefined ? ` fill="${hex(x.fill)}"` : ' fill="none"'}${x.stroke !== undefined ? ` stroke="${hex(x.stroke)}" stroke-width="${n(x.sw ?? 0.3)}" stroke-linecap="round"` : ''}${x.op !== undefined ? ` opacity="${x.op}"` : ''}`
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
  return `${bg}<text x="${n(s.x)}" y="${n(s.y)}" font-size="${s.size}" fill="${hex(s.fill)}"${halo}${s.anchor === 'middle' ? ' text-anchor="middle"' : ''}${s.bold ? ' font-weight="bold"' : ''}>${xml(s.text)}</text>`
}

/** 形狀清單 → SVG（跟 encodeSvg 同樣一單位一像素、寬高放大 pxSize 倍）；夜裡在中間蓋一層暗幕，發光的畫在暗幕之上 */
export function vectorSvg(v: VectorScene, pxSize = 8): string {
  const defs = `<defs><pattern id="tile" width="12" height="12" patternUnits="userSpaceOnUse"><rect width="12" height="12" fill="${hex(C.tileB)}"/><rect width="6" height="6" fill="${hex(C.tileA)}"/><rect x="6" y="6" width="6" height="6" fill="${hex(C.tileA)}"/></pattern></defs>`
  const body = v.shapes.map(shapeSvg).join('')
  const dark = v.night ? `<rect width="${v.width}" height="${v.h}" fill="#050a1e" opacity="0.66"/>${v.glow.map(shapeSvg).join('')}` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${v.width} ${v.h}" width="${v.width * pxSize}" height="${v.h * pxSize}" font-family="${FONT}">${defs}${body}${dark}${v.labels.map(shapeSvg).join('')}</svg>`
}
