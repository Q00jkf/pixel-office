import type { Coworker, OfficeMode } from '../types'

// 俯視平面圖：上排會議室＋主管室，下方員工區（四人一組、隔板），底部走廊
const MIN_W = 48
const MAX_W = 112
const WALL = 2
const TOP_H = 20 // 會議室／主管室內部高度
const OPEN_Y = WALL + TOP_H + WALL // 員工區起點（24）
const UNIT_W = 11
const UNIT_H = 12
const CLUSTER_W = UNIT_W * 2 + 1 // 23：兩張桌＋直隔板
const ROW_SPLIT = 8 // 上下兩排桌子之間的走道（4 個終端列；偶數）
const CLUSTER_H = UNIT_H * 2 + 2 + ROW_SPLIT // 34：兩排桌＋橫隔板＋走道（偶數，名牌才對得齊終端列）
const AREA_TOP = 2 + 8 // 員工座位區離上方內牆的距離（原 2，往下移 4 個終端列）
const AISLE = 6
const CLUSTER_GAP = 4
const BOTTOM = 10 // 底部走廊＋牆
const BOSS_W = 17
const WALK_SPEED = 2 // 走路：每格動畫走幾個像素

const C = {
  tileA: 0xd5dde1, tileB: 0xccd5d9,
  wall: 0x37474f, wallHi: 0x607d8b, glass: 0x81d4fa, glassHi: 0xe1f5fe,
  meetFloor: 0xa1887f, meetPlank: 0x937a70, table: 0x6d4c41, tableHi: 0x8d6e63, tableEdge: 0x4e342e,
  board: 0xfafafa, marker: 0x1e88e5,
  rug: 0x7b5e57, rugTrim: 0xc9a227,
  partHi: 0x90a4ae, partLo: 0x607d8b,
  desk: 0xe0d6cf, deskFront: 0xb09a8a, chair: 0x607d8b, chairDark: 0x37474f,
  boss: 0x5d4037, bossHi: 0x795548, bossEdge: 0x3e2723, leather: 0x4e342e, leatherHi: 0x6d4c41,
  mon: 0x263238, off: 0x37474f, screen: 0x1e88e5, screenDim: 0x1565c0, code: 0x69f0ae, codeDim: 0x2e7d32,
  err: 0xe53935, errDark: 0xb71c1c, ok: 0x43a047, white: 0xffffff, ink: 0x90a4ae,
  key: 0xbdbdbd, keyDark: 0x9e9e9e, paper: 0xf5f5f5, mug: 0xfafafa, coffee: 0x6d4c41,
  skin: 0xf0c8a0, suit: 0x1a237e, spark: 0xffeb3b, shoe: 0x212121,
  potRim: 0xa1887f, soil: 0x5d4037, leaf: 0x66bb6a, leafMid: 0x4caf50, leafDark: 0x33691e, // 不可與螢幕／完成的綠撞色碼，否則夜裡會被當成發光
  copier: 0xbdbdbd, copierTop: 0x757575, led: 0x76ff03,
  text: 0x263238, me: 0x0d47a1, gold: 0xffd54f, goldDark: 0x8d6e00,
  cat: 0xffa726, catDark: 0xe65100, heart: 0xff4081, heartBowl: 0x90a4ae,
  nightSky: 0x0d1b3e, star: 0xfff9c4,
  wait: 0xffca28, waitDark: 0xff8f00, plane: 0xf1f8ff, planeFold: 0xb0bec5, envelope: 0xfff8e1, envelopeLine: 0xd84315,
}
const BOOKS = [0xef5350, 0x42a5f5, 0x66bb6a, 0xffca28, 0xab47bc, 0x26c6da, 0x8d6e63]
const SHIRTS = [0xd97757, 0x5c6bc0, 0x26a69a, 0xec407a, 0x7e57c2, 0x66bb6a, 0x8d6e63, 0x29b6f6]
const HAIR = [0x3e2723, 0x212121, 0xf9a825, 0xbf360c, 0x6d4c41]

export type Label = { row: number; col: number; text: string; fg: number; bg: number }
type Px = {
  w: number
  h: number
  px: Uint32Array
  labels: Label[]
  set: (x: number, y: number, c: number) => void
  rect: (x: number, y: number, w: number, h: number, c: number) => void
}

function canvas(w: number, h: number): Px {
  const px = new Uint32Array(w * h)
  const set = (x: number, y: number, c: number) => {
    if (x >= 0 && y >= 0 && x < w && y < h) px[y * w + x] = c
  }
  const rect = (x: number, y: number, rw: number, rh: number, c: number) => {
    for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) set(x + i, y + j, c)
  }
  return { w, h, px, labels: [], set, rect }
}

function hash(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) n = (n * 31 + s.charCodeAt(i)) >>> 0
  return n
}

const shade = (c: number, k: number) =>
  (Math.min(255, ((c >> 16) & 0xff) * k) << 16) | (Math.min(255, ((c >> 8) & 0xff) * k) << 8) | Math.min(255, (c & 0xff) * k)

// ---------- 版面 ----------

export function sceneWidth(bodyColumns: number): number {
  return Math.max(MIN_W, Math.min(bodyColumns, MAX_W))
}

/** 面板內容區列數 → 場景列數：扣掉預留空白 1 列＋按鈕 1 列；至少 40 列才放得下上排房間＋一排座位群＋走廊 */
export const RESERVED_ROWS = 2
export const MIN_ROWS = 40 // 2*40=80 像素 ≥ 上排房間 24＋座位區上緣 10＋座位群 34＋走廊 10
export function sceneRows(bodyRows: number | undefined): number {
  return Math.max(MIN_ROWS, (bodyRows ?? MIN_ROWS + RESERVED_ROWS) - RESERVED_ROWS)
}

export type Seat = { x: number; y: number }

export function layout(width: number, rows: number) {
  const h = rows * 2
  const cols = Math.max(1, Math.floor((width - 2 * WALL - 2 + AISLE) / (CLUSTER_W + AISLE)))
  const total = cols * CLUSTER_W + (cols - 1) * AISLE
  const x0 = Math.floor((width - total) / 2)
  const clusterRows = Math.max(1, Math.floor((h - OPEN_Y - AREA_TOP - BOTTOM + CLUSTER_GAP) / (CLUSTER_H + CLUSTER_GAP)))
  const clusters: Seat[] = []
  for (let r = 0; r < clusterRows; r++) {
    for (let c = 0; c < cols; c++) clusters.push({ x: x0 + c * (CLUSTER_W + AISLE), y: OPEN_Y + AREA_TOP + r * (CLUSTER_H + CLUSTER_GAP) })
  }
  const seats: Seat[] = []
  for (const k of clusters) {
    seats.push({ x: k.x, y: k.y }, { x: k.x + UNIT_W + 1, y: k.y })
    seats.push({ x: k.x, y: k.y + UNIT_H + 2 + ROW_SPLIT }, { x: k.x + UNIT_W + 1, y: k.y + UNIT_H + 2 + ROW_SPLIT })
  }
  const officeW = Math.max(22, Math.floor((width - 2 * WALL) * 0.45))
  const officeX = width - WALL - officeW
  const manager: Seat = { x: officeX + officeW - BOSS_W - 1, y: WALL + 2 }
  return { seats, clusters, manager, officeX, officeW, h }
}

// ---------- 座位分配：先坐回上次的位子，新來的人才依編號挑預設座位 ----------

export type Placement = { kind: 'boss' | 'staff'; slot: number; seat: Seat; stand: Seat; cluster: Seat }

export function assignSeats(crew: Coworker[], width: number, rows: number, previous?: Map<string, Placement>): Map<string, Placement> {
  const L = layout(width, rows)
  const out = new Map<string, Placement>()
  const boss = crew.find(c => c.role === 'manager')
  if (boss) out.set(boss.id, { kind: 'boss', slot: -1, seat: L.manager, stand: { x: L.manager.x + 7, y: L.manager.y + 7 }, cluster: L.manager })
  const n = L.seats.length
  const taken: boolean[] = new Array(n).fill(false)
  const put = (c: Coworker, slot: number) => {
    taken[slot] = true
    const seat = L.seats[slot]
    out.set(c.id, { kind: 'staff', slot, seat, stand: { x: seat.x + 5, y: seat.y + 1 }, cluster: L.clusters[Math.floor(slot / 4)] })
  }
  const staff = crew.filter(c => c !== boss)
  const rest: Coworker[] = []
  for (const c of staff) {
    const prev = previous?.get(c.id)
    if (prev && prev.kind === 'staff' && prev.slot < n && !taken[prev.slot]) put(c, prev.slot)
    else rest.push(c)
  }
  for (const c of rest) {
    let slot = hash(c.id) % n
    let tries = 0
    while (taken[slot] && tries < n) {
      slot = (slot + 1) % n
      tries += 1
    }
    if (tries < n) put(c, slot) // 坐滿了 → 算在 +N
  }
  return out
}

// ---------- 走路：沿走道走到新座位 ----------

export type Walker = { id: string; path: Seat[]; start: number }

/** 從 from 走到 to 的路線（只走水平／垂直線段）：出座位 → 上方走道 → 主管室門 → 目的地 */
export function route(from: Placement, to: Placement, width: number, rows: number): Seat[] {
  const L = layout(width, rows)
  const hall = OPEN_Y
  const door = L.officeX + 3
  const inside = WALL + TOP_H - 4
  const exit = (pl: Placement): Seat[] => {
    if (pl.kind === 'boss') return [pl.stand, { x: pl.stand.x, y: inside }, { x: door, y: inside }, { x: door, y: hall }]
    const side = pl.seat.x === pl.cluster.x ? pl.cluster.x - 3 : pl.cluster.x + CLUSTER_W + 2
    return [pl.stand, { x: side, y: pl.stand.y }, { x: side, y: hall }]
  }
  return [...exit(from), ...exit(to).reverse()]
}

export type Step = Seat & { dx: number; dy: number } // 位置＋這一段的行進方向（-1／0／1）

export function walkerPos(w: Walker, frame: number): Step | null {
  let d = (frame - w.start) * WALK_SPEED
  if (d < 0) d = 0
  for (let i = 0; i < w.path.length - 1; i++) {
    const a = w.path[i]
    const b = w.path[i + 1]
    const len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y)
    if (d <= len) {
      const t = len === 0 ? 1 : d / len
      return { x: Math.round(a.x + (b.x - a.x) * t), y: Math.round(a.y + (b.y - a.y) * t), dx: Math.sign(b.x - a.x), dy: Math.sign(b.y - a.y) }
    }
    d -= len
  }
  return null // 到了
}

// ---------- 小物件 ----------

function screenPixel(mode: OfficeMode | null, frame: number, i: number): number {
  if (mode === null) return C.off
  if (mode === 'typing') return (i + frame) % 3 === 0 ? C.code : C.codeDim
  if (mode === 'reading') return i % 2 ? C.white : C.ink
  if (mode === 'error') return frame % 2 ? C.err : C.errDark
  if (mode === 'waiting') return frame % 2 ? C.wait : C.waitDark
  if (mode === 'blocked') return frame % 4 < 2 ? C.errDark : C.mon
  if (mode === 'done') return C.ok
  if (mode === 'thinking') return C.screenDim
  return i === frame % 6 ? C.white : C.screen
}

function plant(p: Px, x: number, y: number) {
  p.rect(x, y, 5, 5, C.potRim)
  p.rect(x + 1, y + 1, 3, 3, C.soil)
  const leaves = ['.L.M.', 'LMDLM', '.DLD.', 'MLDML', '.M.L.']
  const col: Record<string, number> = { L: C.leaf, M: C.leafMid, D: C.leafDark }
  leaves.forEach((row, j) => {
    for (let i = 0; i < 5; i++) if (row[i] !== '.') p.set(x + i, y + j, col[row[i]])
  })
}

function bubble(p: Px, x: number, y: number, frame: number) {
  for (let i = 0; i < 3; i++) p.set(x + i * 2, y, i <= frame % 3 ? C.white : C.ink)
}

// ---------- 房間 ----------

function building(p: Px, L: ReturnType<typeof layout>, frame: number) {
  const { officeX, officeW, h } = L
  const w = p.w
  // 員工區：棋盤格磁磚
  for (let y = 0; y < h; y += 6) {
    for (let x = 0; x < w; x += 6) p.rect(x, y, 6, 6, ((x + y) / 6) % 2 ? C.tileA : C.tileB)
  }

  // 會議室木地板、主管室地毯
  p.rect(WALL, WALL, officeX - 2 * WALL, TOP_H, C.meetFloor)
  for (let y = WALL + 3; y < WALL + TOP_H; y += 4) {
    p.rect(WALL, y, officeX - 2 * WALL, 1, C.meetPlank)
    for (let x = WALL + ((y * 3) % 9); x < officeX - WALL; x += 9) p.set(x, y + 1, C.meetPlank)
  }
  p.rect(officeX, WALL, w - WALL - officeX, TOP_H, C.rugTrim)
  p.rect(officeX + 1, WALL + 1, w - WALL - officeX - 2, TOP_H - 2, C.rug)

  // 牆（外牆＋內牆），朝室內那側一條亮線做出厚度
  p.rect(0, 0, w, WALL, C.wall)
  p.rect(0, h - WALL, w, WALL, C.wall)
  p.rect(0, 0, WALL, h, C.wall)
  p.rect(w - WALL, 0, WALL, h, C.wall)
  p.rect(0, WALL + TOP_H, w, WALL, C.wall)
  p.rect(officeX - WALL, 0, WALL, OPEN_Y, C.wall)
  p.rect(WALL, WALL + TOP_H + WALL - 1, w - 2 * WALL, 1, C.wallHi)
  p.rect(WALL, h - WALL, w - 2 * WALL, 1, C.wallHi)

  // 窗戶（帶反光點）
  for (let x = 5; x + 6 < w - 3; x += 11) {
    p.rect(x, 0, 6, 1, C.glass)
    p.set(x + 1, 0, C.glassHi)
  }
  for (let y = OPEN_Y + 4; y + 6 < h - 4; y += 11) {
    p.rect(0, y, 1, 6, C.glass)
    p.rect(w - 1, y, 1, 6, C.glass)
    p.set(0, y + 1, C.glassHi)
    p.set(w - 1, y + 1, C.glassHi)
  }

  // 門：會議室、主管室（含開門弧線）、大門
  const meetDoor = Math.floor(officeX / 2) - 2
  p.rect(meetDoor, WALL + TOP_H, 4, WALL, C.tileA)
  p.rect(officeX + 1, WALL + TOP_H, 4, WALL, C.tileA)
  for (const [dx, dy] of [[0, -1], [1, -1], [2, -2], [3, -3]]) p.set(officeX + 1 + dx, WALL + TOP_H + dy, C.ink)
  const front = Math.floor(w / 2) - 3
  p.rect(front, h - WALL, 6, WALL, C.tileA)

  // 門牌：掛在上排房間與員工區之間那道牆（剛好一整個終端列），中文寬兩格放不下，用英文
  const signRow = (WALL + TOP_H) / 2
  p.labels.push({ row: signRow, col: officeX + 6, text: 'MANAGER', fg: C.gold, bg: C.wall })
  if (meetDoor - WALL - 1 >= 7) p.labels.push({ row: signRow, col: WALL + 1, text: 'MEETING', fg: C.glassHi, bg: C.wall })

  // 會議室：白板、橢圓長桌（亮面）、一圈椅子
  p.rect(WALL, WALL + 6, 1, 8, C.board)
  p.set(WALL, WALL + 8, C.marker)
  p.set(WALL, WALL + 10, C.err)
  const mx0 = WALL + 2
  const mx1 = officeX - WALL - 1
  const cx = (mx0 + mx1) / 2
  const cy = WALL + TOP_H / 2
  const a = Math.max(4, (mx1 - mx0) / 2 - 5)
  const b = 3.2
  for (let y = Math.floor(cy - b); y <= Math.ceil(cy + b); y++) {
    for (let x = Math.floor(cx - a); x <= Math.ceil(cx + a); x++) {
      const d = ((x - cx) / a) ** 2 + ((y - cy) / b) ** 2
      if (d <= 1) p.set(x, y, d > 0.65 ? C.tableEdge : y < cy - 1 ? C.tableHi : C.table)
    }
  }
  for (let x = Math.ceil(cx - a) + 1; x < cx + a - 1; x += 3) {
    p.rect(x, Math.floor(cy - b) - 2, 2, 1, C.chair)
    p.rect(x, Math.ceil(cy + b) + 2, 2, 1, C.chair)
    p.set(x, Math.floor(cy - b) - 3, C.chairDark)
    p.set(x + 1, Math.ceil(cy + b) + 3, C.chairDark)
  }
  p.rect(Math.floor(cx - a) - 2, Math.floor(cy) - 1, 1, 2, C.chair)
  p.rect(Math.ceil(cx + a) + 2, Math.floor(cy) - 1, 1, 2, C.chair)

  // 時鐘（會議室牆上）
  const hands = [[0, -1], [1, 0], [0, 1], [-1, 0]]
  const [hx, hy] = hands[Math.floor(frame / 4) % 4]
  p.rect(WALL + 2, WALL + 1, 3, 3, C.white)
  p.set(WALL + 3, WALL + 2, C.text)
  p.set(WALL + 3 + hx, WALL + 2 + hy, C.text)

  // 主管室書架（上牆）
  for (let x = officeX + 7; x < officeX + officeW - 2; x++) {
    p.set(x, WALL, C.bossEdge)
    p.set(x, WALL + 1, BOOKS[(x * 7) % BOOKS.length])
  }

  // 盆栽、影印機
  plant(p, officeX + 1, WALL + 1)
  plant(p, WALL + 1, h - WALL - 7)
  plant(p, w - WALL - 6, h - WALL - 7)
  const cpx = w - WALL - 16
  const cpy = h - WALL - 7
  p.rect(cpx, cpy, 8, 5, C.copier)
  p.rect(cpx, cpy, 8, 1, C.copierTop)
  p.rect(cpx + 1, cpy + 2, 4, 2, C.paper)
  p.set(cpx + 6, cpy + 2, frame % 4 < 2 ? C.led : C.copierTop)
}

// ---------- 隔板（亮面＋暗面，看起來有高度） ----------

function partitions(p: Px, k: Seat) {
  p.rect(k.x + UNIT_W, k.y, 1, CLUSTER_H, C.partLo)
  p.rect(k.x, k.y + UNIT_H, CLUSTER_W, 1, C.partHi)
  p.rect(k.x, k.y + UNIT_H + 1, CLUSTER_W, 1, C.partLo)
  p.set(k.x + UNIT_W, k.y, C.partHi)
}

// ---------- 員工座位（人坐在桌子上方、面向下方的螢幕） ----------

function unit(p: Px, x: number, y: number, who: Coworker | null, frame: number) {
  const mode = who ? who.mode : null
  // 圓角椅子
  p.rect(x + 3, y, 5, 1, C.chairDark)
  p.rect(x + 3, y + 1, 5, 4, C.chair)
  p.set(x + 3, y + 4, C.chairDark)
  p.set(x + 7, y + 4, C.chairDark)
  // 桌面＋正面邊緣、鍵盤、文件、咖啡杯、螢幕
  p.rect(x + 1, y + 5, 9, 6, C.desk)
  p.rect(x + 1, y + 11, 9, 1, C.deskFront)
  p.rect(x + 4, y + 5, 3, 1, C.key)
  p.set(x + 5, y + 5, C.keyDark)
  p.rect(x + 1, y + 8, 2, 2, C.paper)
  p.set(x + 2, y + 9, C.ink)
  p.set(x + 8, y + 8, C.mug)
  p.set(x + 9, y + 8, C.coffee)
  for (let i = 0; i < 5; i++) p.set(x + 3 + i, y + 9, screenPixel(mode, frame, i))
  p.rect(x + 3, y + 10, 5, 1, C.mon)

  if (who) {
    person(p, x + 5, y + 1, who, frame, 1)
    const tag = `${who.isMe ? '>' : ''}${who.role === 'manager' ? '*' : ''}${who.name}`
    const fg = who.isMe ? C.me : who.role === 'manager' ? C.goldDark : C.text
    p.labels.push({ row: (y + 6) / 2, col: x + 1, text: tag.slice(0, 9), fg, bg: C.desk })
  }
}

/**
 * 俯視角的人（從頭頂往下看）：3×3 頭髮（一點反光）疊在 7 寬、兩側有陰影的肩膀上
 * (cx, cy) 是頭頂那一列的中心；dir=1 面向下方、dir=-1 面向上方
 */
function person(p: Px, cx: number, cy: number, who: Coworker, frame: number, dir: 1 | -1) {
  const mode = who.mode
  const hh = hash(who.id)
  const shirt = who.role === 'manager' ? C.suit : SHIRTS[hh % SHIRTS.length]
  const hair = HAIR[(hh >> 4) % HAIR.length]
  const shake = mode === 'error' ? (frame % 2 ? 1 : -1) : 0
  const sy = dir === 1 ? cy + 1 : cy
  p.rect(cx - 3, sy, 7, 2, shirt)
  p.set(cx - 3, sy + 1, shade(shirt, 0.7))
  p.set(cx + 3, sy + 1, shade(shirt, 0.7))
  p.rect(cx - 1 + shake, cy, 3, 3, hair)
  p.set(cx + shake, cy + 1, shade(hair, 1.6))

  const handY = dir === 1 ? cy + 3 : cy - 1
  if (mode === 'typing') {
    const up = frame % 2
    p.set(cx - 2, handY + (up ? 0 : dir), C.skin)
    p.set(cx + 2, handY + (up ? dir : 0), C.skin)
  } else if (mode === 'done') {
    p.set(cx - 4, sy - 1, C.skin)
    p.set(cx + 4, sy - 1, C.skin)
    ;[[-4, -2], [4, -2], [-5, 1], [5, 1]].forEach(([dx, dy], k) => {
      if ((frame + k) % 2) p.set(cx + dx, cy + dy, C.spark)
    })
  } else if (mode === 'reading') {
    p.rect(cx + 2, handY, 2, 2, C.white)
    p.set(cx - 2, handY, C.skin)
  } else if (mode === 'error') {
    p.set(cx - 2, cy, C.skin)
    p.set(cx + 2, cy, C.skin)
    p.rect(cx + 4, cy - 1, 1, 2, C.err)
    p.set(cx + 4, cy + 2, C.err)
  } else if (mode === 'blocked') {
    // 舉紅牌：右手舉高、頭上一塊紅牌（白邊）
    p.set(cx + 3, sy - 1, C.skin)
    p.set(cx + 3, sy - 2, C.skin)
    p.rect(cx + 2, cy - 5, 4, 3, C.white)
    p.rect(cx + 3, cy - 4, 2, 1, C.err)
    p.set(cx - 2, handY, C.skin)
  } else if (mode === 'waiting') {
    // 舉右手
    p.set(cx + 3, sy - 1, C.skin)
    p.set(cx + 3, sy - 2, C.skin)
    p.set(cx - 2, handY, C.skin)
    // 頭上閃黃色問號
    if (frame % 2 === 0) for (const [dx, dy] of [[-1, -4], [0, -5], [1, -4], [0, -3], [0, -1]]) p.set(cx + dx, cy + dy, C.wait)
  } else {
    p.set(cx - 2, handY, C.skin)
    p.set(cx + 2, handY, C.skin)
  }
  if (mode === 'thinking') bubble(p, cx - 2, cy - 1, frame)
}

/**
 * 走路中的人：身體跟著行進方向轉。上下走肩膀橫、左右走肩膀直；
 * 頭前緣一個膚色點代表臉朝哪；雙腳沿行進方向一前一後交替
 */
function walking(p: Px, at: Step, who: Coworker, frame: number) {
  const hh = hash(who.id)
  const shirt = who.role === 'manager' ? C.suit : SHIRTS[hh % SHIRTS.length]
  const hair = HAIR[(hh >> 4) % HAIR.length]
  const cx = at.x
  const cy = at.y + 1
  const across = at.dx !== 0 // 左右走
  const fx = across ? at.dx : 0
  const fy = across ? 0 : at.dy || 1
  const step = frame % 2 ? 1 : -1
  // 腳：沿行進方向，一隻在前、一隻在後，每格交換
  if (across) {
    p.set(cx + 3 * step, cy - 1, C.shoe)
    p.set(cx - 3 * step, cy + 1, C.shoe)
    p.rect(cx - 1, cy - 3, 2, 7, shirt)
    p.set(cx - 1, cy - 3, shade(shirt, 0.7))
    p.set(cx - 1, cy + 3, shade(shirt, 0.7))
  } else {
    p.set(cx - 1, cy + 3 * step, C.shoe)
    p.set(cx + 1, cy - 3 * step, C.shoe)
    p.rect(cx - 3, cy, 7, 2, shirt)
    p.set(cx - 3, cy + 1, shade(shirt, 0.7))
    p.set(cx + 3, cy + 1, shade(shirt, 0.7))
  }
  p.rect(cx - 1, cy - 1, 3, 3, hair)
  p.set(cx, cy, shade(hair, 1.6))
  p.set(cx + fx, cy + fy, C.skin) // 臉朝行進方向
}

// ---------- 主管室（L 型大桌，主管坐在桌子下方、面向上方的螢幕） ----------

function bossDesk(p: Px, x: number, y: number, who: Coworker | null, frame: number) {
  const mode = who ? who.mode : null
  // L 型桌：橫桌＋右側回桌（亮面、暗邊、地毯上的影子）
  p.rect(x + 1, y + 6, 14, 1, shade(C.rug, 0.75))
  p.rect(x, y, 14, 6, C.boss)
  p.rect(x, y, 14, 1, C.bossHi)
  p.rect(x, y + 5, 14, 1, C.bossEdge)
  p.rect(x + 14, y, 3, 11, C.boss)
  p.rect(x + 16, y, 1, 11, C.bossEdge)
  // 螢幕、鍵盤、檯燈、文件
  p.rect(x + 4, y + 1, 6, 1, C.mon)
  for (let i = 0; i < 6; i++) p.set(x + 4 + i, y + 2, screenPixel(mode, frame, i))
  p.rect(x + 5, y + 3, 4, 1, C.key)
  p.set(x + 1, y + 1, C.gold)
  p.rect(x + 14, y + 6, 2, 2, C.paper)
  // 高背皮椅
  p.rect(x + 3, y + 10, 9, 1, C.leather)
  p.rect(x + 3, y + 7, 1, 4, C.leather)
  p.rect(x + 11, y + 7, 1, 4, C.leather)
  p.set(x + 3, y + 7, C.leatherHi)
  p.set(x + 11, y + 7, C.leatherHi)
  // 訪客椅（桌子左邊）
  p.rect(x - 4, y + 1, 2, 2, C.chair)
  p.rect(x - 4, y + 4, 2, 2, C.chair)

  if (who) {
    person(p, x + 7, y + 7, who, frame, -1)
    p.labels.push({ row: (y + 4) / 2, col: x + 1, text: `*${who.name}`.slice(0, 13), fg: C.gold, bg: C.boss })
  }
}

// ---------- 貓（俯視角，四格走路） ----------

const CAT_BODY = [
  ['.........', 'TT.GGGGDG', '..GDGDGGG', '...GGGGDG', '.........'],
  ['.........', '...GGGGDG', '..GDGDGGG', 'TT.GGGGDG', '.........'],
]
// 四隻腳：[列, 欄]；左後、左前、右後、右前（也是抬腳順序）
const CAT_LEGS: [number, number][] = [[0, 4], [0, 7], [4, 4], [4, 7]]
const CAT_SIT = [
  ['.........', '...GGGDG.', '...GDGGGG', '...GGGDG.', '..TTTT...'],
  ['.........', '...GGGDG.', '...GDGGGG', '...GGGDG.', '.TTTT....'],
]
const CAT_W = 9
const CAT_REST = 12

export function catWalkRows(step: number): string[] {
  const rows = CAT_BODY[step % 2].map(r => [...r])
  CAT_LEGS.forEach(([r, x], leg) => {
    rows[r][leg === step % 4 ? x + 1 : x] = 'G'
  })
  return rows.map(r => r.join(''))
}

export function catPose(frame: number, range: number) {
  const span = Math.max(1, range)
  const total = span * 2 + CAT_REST * 2
  const t = frame % total
  if (t < span) return { x: t, facingRight: true, sitting: false }
  if (t < span + CAT_REST) return { x: span, facingRight: false, sitting: true }
  if (t < span * 2 + CAT_REST) return { x: span - (t - span - CAT_REST), facingRight: false, sitting: false }
  return { x: 0, facingRight: true, sitting: true }
}

export function catRange(width: number): number {
  return width - 2 * WALL - 6 - 17 - CAT_W // 避開左下盆栽與右下影印機
}

export const TREAT_FRAMES = 20 // 餵貓後坐著吃約 5 秒

/** catOffset＝之前每次餵食停下來的總格數；扣掉後貓會從吃完的地方接著走，不會瞬移 */
export function catMoveFrame(frame: number, treatFrame: number | undefined, catOffset: number): number {
  if (treatFrame === undefined || frame < treatFrame) return frame - catOffset
  const paused = Math.min(TREAT_FRAMES, frame - treatFrame)
  return frame - catOffset - paused
}

function cat(p: Px, startled: boolean, frame: number, treatFrame?: number, catOffset = 0) {
  const fed = treatFrame !== undefined && frame >= treatFrame && frame - treatFrame < TREAT_FRAMES
  const pose = catPose(catMoveFrame(frame, treatFrame, catOffset), catRange(p.w))
  const { x, facingRight } = pose
  const sitting = fed || pose.sitting
  const rows = sitting ? CAT_SIT[frame % 2] : catWalkRows(frame)
  const x0 = WALL + 7 + x
  const y0 = p.h - WALL - 7 - (startled && !fed && frame % 2 ? 1 : 0)
  const color: Record<string, number> = { G: C.cat, D: C.catDark, T: C.catDark }
  rows.forEach((row, j) => {
    const line = facingRight ? row : [...row].reverse().join('')
    for (let i = 0; i < CAT_W; i++) if (line[i] !== '.') p.set(x0 + i, y0 + j, color[line[i]])
  })
  if (fed) {
    // 飼料碗＋往上飄的愛心
    p.rect(x0 + (facingRight ? 9 : -2), y0 + 2, 2, 2, C.heartBowl)
    const hy = y0 - 2 - (Math.floor((frame - treatFrame!) / 2) % 3)
    const hx = x0 + 4
    for (const [dx, dy] of [[-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1], [0, 2]]) p.set(hx + dx, hy + dy, C.heart)
  }
}

// ---------- 夜間模式：整體變暗，只留螢幕、指示燈、檯燈；窗外是夜空 ----------

function nightify(p: Px, frame: number) {
  const glow = new Set([C.screen, C.screenDim, C.code, C.codeDim, C.err, C.errDark, C.ok, C.led, C.gold, C.spark, C.heart, C.wait, C.waitDark])
  for (let i = 0; i < p.px.length; i++) {
    const c = p.px[i]
    if (c === C.glass || c === C.glassHi) p.px[i] = C.nightSky
    else if (!glow.has(c)) p.px[i] = shade(c, 0.32) | 0x000010
  }
  // 窗外星星（偶爾閃一下）
  for (let x = 6; x < p.w - 4; x += 11) if ((x + frame) % 7 !== 0) p.set(x + 2, 0, C.star)
}

// ---------- 組合 ----------

export type Scene = { px: Uint32Array; labels: Label[]; width: number; rows: number }

/** 紙飛機：從寄件者座位飛到收件者座位 */
export type Plane = { from: Seat; to: Seat; start: number }
/** 收件者頭上的信封：在 [start, end) 期間顯示 */
export type Notice = { id: string; start: number; end: number }

export const PLANE_FRAMES = 10 // 約 2.5 秒飛到
export const NOTICE_FRAMES = 10

export function planePos(pl: Plane, frame: number): (Seat & { dx: number }) | null {
  const t = (frame - pl.start) / PLANE_FRAMES
  if (t < 0 || t > 1) return null
  // 中途往上拱一點，像拋物線
  const arc = Math.round(Math.sin(Math.PI * t) * 4)
  return { x: Math.round(pl.from.x + (pl.to.x - pl.from.x) * t), y: Math.round(pl.from.y + (pl.to.y - pl.from.y) * t) - arc, dx: Math.sign(pl.to.x - pl.from.x) || 1 }
}

function plane(p: Px, at: Seat & { dx: number }) {
  const s = at.dx
  p.set(at.x, at.y, C.plane)
  p.set(at.x - s, at.y - 1, C.plane)
  p.set(at.x - s, at.y + 1, C.planeFold)
  p.set(at.x - 2 * s, at.y, C.plane)
  p.set(at.x - 2 * s, at.y - 1, C.planeFold)
}

function envelope(p: Px, x: number, y: number) {
  p.rect(x, y, 3, 2, C.envelope)
  p.set(x + 1, y, C.envelopeLine)
}

export type SceneOptions = { night?: boolean; treatFrame?: number; catOffset?: number; planes?: Plane[]; notices?: Notice[] }

export function drawScene(
  crew: Coworker[],
  frame: number,
  width: number,
  rows: number,
  walkers: Walker[] = [],
  seating?: Map<string, Placement>,
  opts: SceneOptions = {},
): Scene {
  crew = crew.map(c => (c.blocked ? { ...c, mode: 'blocked' as const } : c))
  const L = layout(width, rows)
  const p = canvas(width, L.h)
  building(p, L, frame)
  for (const k of L.clusters) partitions(p, k)

  const moving = new Map<string, Step>()
  for (const w of walkers) {
    const at = walkerPos(w, frame)
    if (at) moving.set(w.id, at)
  }
  const placed = assignSeats(crew, width, rows, seating)
  const byId = new Map(crew.map(c => [c.id, c]))

  // 主管室：有主管且沒在走路才坐在位子上
  const boss = [...placed].find(([, pl]) => pl.kind === 'boss')
  bossDesk(p, L.manager.x, L.manager.y, boss && !moving.has(boss[0]) ? byId.get(boss[0]) ?? null : null, frame)

  const sitting = new Map<string, Coworker>()
  for (const [id, pl] of placed) if (pl.kind === 'staff' && !moving.has(id)) sitting.set(`${pl.seat.x},${pl.seat.y}`, byId.get(id)!)
  for (const s of L.seats) unit(p, s.x, s.y, sitting.get(`${s.x},${s.y}`) ?? null, frame)

  for (const [id, at] of moving) {
    const who = byId.get(id)
    if (who) walking(p, at, who, frame)
  }

  for (const n of opts.notices ?? []) {
    const pl = placed.get(n.id)
    if (pl && frame >= n.start && frame < n.end && frame % 2 === 0) envelope(p, pl.stand.x + 3, pl.stand.y - 3)
  }
  for (const pl of opts.planes ?? []) {
    const at = planePos(pl, frame)
    if (at) plane(p, at)
  }

  cat(p, crew.some(c => c.mode === 'error'), frame, opts.treatFrame, opts.catOffset)

  const extra = crew.length - placed.size
  if (extra > 0) p.labels.push({ row: 0, col: WALL, text: `+${extra}`, fg: C.white, bg: C.wall })
  if (opts.night) {
    nightify(p, frame)
    for (const l of p.labels) l.bg = shade(l.bg, 0.32) | 0x000010
  }
  return { px: p.px, labels: p.labels, width, rows }
}

// 每格用「▀」：前景 = 上像素、背景 = 下像素；名牌那幾格改放 ASCII 字元
export function encode(scene: Scene): string {
  const { px, labels, width, rows } = scene
  const words = new Uint32Array(width * rows * 3)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < width; c++) {
      const i = (r * width + c) * 3
      words[i] = 0x2580
      words[i + 1] = px[r * 2 * width + c]
      words[i + 2] = px[(r * 2 + 1) * width + c]
    }
  }
  for (const { row, col, text, fg, bg } of labels) {
    if (row < 0 || row >= rows) continue
    for (let k = 0; k < text.length && col + k < width; k++) {
      const i = (row * width + col + k) * 3
      words[i] = text.charCodeAt(k)
      words[i + 1] = fg
      words[i + 2] = bg
    }
  }
  return new Uint8Array(words.buffer).toBase64()
}

/** 名牌只放得下 ASCII（中文寬 2 格，Raster 不收） */
export function plateName(cwd: string, id: string): string {
  const base = cwd.split(/[\\/]/).filter(Boolean).pop() ?? ''
  const ascii = base.replace(/[^\x20-\x7e]/g, '')
  const isSessionId = /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(ascii)
  return ascii.length >= 2 && !isSessionId ? ascii : `s-${id.slice(0, 4)}`
}
