// Desktop 面板的 v2 辦公室（2026-11-22）：跟手機版 remote/v2/scene.js 同一套版面（上方協作區、下方辦公區）與圖層順序，
// 只是輸出一張 SVG 字串（面板的 Svg 元素），美術用 sheetV2.ts 的縮小素材表（原圖太大放不進面板的 131072 字元上限）。
// 純資料、不依賴 $：register.tsx 給名單、座位（officeV2.assign 排好的）、協作桌、畫面大小。
// 單位：「格」（一張 4 人桌約 78 格寬），跟手機版一樣；SVG 的 viewBox 就用格。
// 沒搬的（跟手機版一樣先不做）：走路動畫、開會走去會議室、寵物、家具選單
import { SVG_MAX } from './scene'
import { V2_ANCHOR, V2_INK_LEFT, V2_SHEET_H, V2_SHEET_PNG, V2_SHEET_W, V2_SPRITES, V2_TABLES } from './sheetV2'

export type V2Person = { id: string; plate: string; mode: string; role?: string; kind?: string; species?: string; seat?: string; approval?: string; meeting?: boolean }
export type V2Table = { id: number; name: string; size: number; teamName?: string; label?: string; status?: string; waiting?: number; blocked?: number; noBoss?: boolean; handover?: boolean; meeting?: string; grouped?: boolean }

const AISLE = 24, SIDE = 10, TOP = 70, BOTTOM = 52
// 協作桌：桌牌在近側名牌下面（跟 scene.js 一樣）；每排之間多留 4 格給桌牌
const SIGN_DY = 10, ROW_GAP = 48 // 美術 A #1：桌牌兩行，列距多一行
// 近側椅子：背面圖橫向放寬蓋住底圖的正面椅子黑邊、人剪到扶手上緣（跟 scene.js 一樣）
const BACK_K = 1.08, CLIP_K = 0.3
const SIT_H = 25.5
// 遠側獨立椅子（跟 scene.js 的 FAR_FIX 一樣，mg2 逐座量的補正：倍率、dx、dy（原圖 px））；主管坐高背椅時名牌、泡泡上移 BOSS_LIFT
const FAR_FIX: Record<string, [number, number, number][]> = {
  ctable2: [[1.105, 8, 2]], ctable4: [[1, 0, 0], [1.035, 8, 3]], ctable6: [[1.04, 1, 4], [1.06, 3, 5], [1.03, 4, 3]],
  ctable8: [[1.045, 2, 2], [1.04, 3, 2], [1.025, 2, 0], [1.035, 2, 2]], office2: [[1.04, 4, 0], [1.04, 8, 0]],
}
const BOSS_LIFT = 2
const SCREEN: Record<string, string> = { idle: '#6fb7e0', typing: '#8fe4ff', thinking: '#a9b6ff', reading: '#b5e8c8', waiting: '#ffb35c', blocked: '#ff7a7a', done: '#9be59b' }
const ICON: Record<string, string> = { waiting: 'icon_hand', thinking: 'icon_think', reading: 'icon_book', done: 'icon_done', blocked: 'icon_error' }
const FONT = "'Microsoft JhengHei','PingFang TC','Noto Sans TC','Noto Sans CJK TC',sans-serif"

const sp = (n: string) => V2_SPRITES[n]
const ar = (n: string) => (sp(n) ? sp(n)[5] / sp(n)[4] : 1)
const n2 = (v: number) => (Math.round(v * 100) / 100).toString()
const xml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

type Art = { name: string; u: number; w: number; h: number; cols: (typeof V2_TABLES)[string]['cols'] }
function art(name: string): Art | undefined {
  const g = V2_TABLES[name]
  if (!g || !sp(name) || !sp(name + '_over') || !g.cols.length) return undefined
  return { name, u: g.u, w: g.w, h: g.h, cols: g.cols }
}
const tableArt = (size: number) => art('ctable' + size) ?? art('ctable4')

type PT = V2Table & { cols: number; art: Art; w: number; h: number; x: number; y: number }
type Desk = { d: number; x: number; y: number; w: number; h: number; art?: Art }
type Plan = { w: number; h: number; tables: PT[]; desks: Desk[]; collabTop: number; collabEnd: number }

/** 跟 scene.js plan() 一樣；cw＝畫面寬（像素，決定一排放幾張辦公桌） */
export function plan(cw: number, tables: V2Table[], officeNeed: number): Plan {
  const oa = art('office2'), DW = oa ? oa.w : 80, DH = oa ? oa.h : 22.4
  const maxCols = Math.max(2, Math.min(8, Math.floor((cw / 2 - 2 * SIDE + AISLE) / (DW + AISLE))))
  const desksNeed = Math.ceil(officeNeed / 2)
  const cols = Math.max(2, Math.min(maxCols, desksNeed))
  const tts = [...tables].sort((a, b) => a.id - b.id).flatMap(t => { const a = tableArt(t.size); return a ? [{ ...t, cols: t.size / 2, art: a, w: a.w, h: a.h, x: 0, y: 0 }] : [] })
  const w4 = (tableArt(4) ?? { w: 80 }).w
  const w = Math.max(2 * SIDE + cols * DW + (cols - 1) * AISLE, ...tts.map(t => t.w + 2 * SIDE), 2 * SIDE + 2 * Math.max(80, w4) + AISLE)
  const rows: PT[][] = []
  let row: PT[] = []
  const rowW = (r: PT[]) => r.reduce((n, t) => n + t.w, 0) + (r.length - 1) * AISLE
  for (const tt of tts) {
    if (row.length && rowW([...row, tt]) > w - 2 * SIDE) { rows.push(row); row = [] }
    row.push(tt)
  }
  if (row.length) rows.push(row)
  const cy0 = TOP + 24
  let y = cy0
  const out: PT[] = []
  for (const r of rows) {
    let x = (w - rowW(r)) / 2
    for (const t of r) { t.x = x; t.y = y; x += t.w + AISLE; out.push(t) }
    // 這排有桌牌的桌名得拆兩行：多留一行（審查 ③）
    const wrap = r.some(t => plateLines(t.name, `（${t.size}人）`, PLATE_FS, Math.max(t.w, 70)).lines.length > 1)
    y += Math.max(...r.map(t => t.h)) + ROW_GAP + (wrap ? PLATE_FS * 1.25 : 0)
  }
  const collabEnd = rows.length ? y - 22 : cy0 + 26
  const oy0 = collabEnd + 34, orow = Math.ceil(DH + 30)
  const orows = Math.max(1, Math.ceil(desksNeed / cols))
  const x0 = (w - (cols * DW + (cols - 1) * AISLE)) / 2
  const desks: Desk[] = []
  for (let d = 0; d < orows * cols; d++) desks.push({ d, x: x0 + (d % cols) * (DW + AISLE), y: oy0 + Math.floor(d / cols) * orow, w: DW, h: DH, art: oa })
  const h = oy0 + (orows - 1) * orow + DH + 14 + BOTTOM
  return { w, h, tables: out, desks, collabTop: cy0, collabEnd }
}

type Rect = { x: number; y: number; w: number; h: number }
type Seat = { cx: number; top: number; bottom: number; feet: number; far: boolean; gy: number; H: number; lid: number[]; scr?: number[]; clipY?: number; boss?: Rect; chair?: Rect; back?: Rect & { lx: number; ly: number } }

/** 跟 scene.js geomArt() 一樣：座位位置來自桌子圖上量到的背蓋／螢幕框 */
function geomArt(a: Art, x: number, y: number, col: number, far: boolean): Seat | undefined {
  const c = a.cols[col]; if (!c) return undefined
  const S = (v: number) => v * a.u
  const lid = [x + S(c.lid[0]), y + S(c.lid[1]), x + S(c.lid[2]), y + S(c.lid[3])], cx = x + S(c.cx)
  const kb = (c.lid[2] - c.lid[0]) / 162
  const boss = { x: x + S(c.cx - 176 * kb), y: y + S(c.lid[1] - 255 * kb), w: S(352 * kb), h: S(352 * kb) }
  const fx = FAR_FIX[a.name]?.[col] ?? [1, 0, 0], fs = kb * fx[0]
  const chair = { x: x + S(c.cx - 176 * fs + fx[1]), y: y + S(c.lid[1] - 255 * fs + fx[2]), w: S(352 * fs), h: S(352 * fs) }
  // feet＝新規格坐姿的腳底線（跟 scene.js 一樣：遠側＝背蓋下緣＋7 格，近側＝椅背上緣＋21.2 格）
  if (far) { const bottom = lid[1] + SIT_H * 0.45; return { cx, top: bottom - SIT_H, bottom, feet: lid[3] + 7, far: true, gy: y, H: a.h, lid, boss, chair } }
  const scr = c.scr ? [x + S(c.scr[0]), y + S(c.scr[1]), x + S(c.scr[2]), y + S(c.scr[3])] : lid
  const chairTop = c.chair_top != null ? y + S(c.chair_top) : scr[3] + 2
  const top = chairTop - 7
  const clipY = c.chair_bottom != null && c.chair_top != null ? y + S(c.chair_top + (c.chair_bottom - c.chair_top) * CLIP_K) : undefined
  let back
  if (c.chair_bottom != null && c.chair_top != null) {
    const k = (c.chair_bottom - c.chair_top) / 239
    back = { x: x + S(c.cx - 104 * BACK_K * k), y: y + S(c.chair_top - 4 * k), w: S(208 * BACK_K * k), h: S(244 * k), lx: x + S(c.cx), ly: y + S(c.chair_top - 4 * k + 82 * k) }
  }
  return { cx, top, bottom: top + SIT_H, feet: chairTop + 21.2, far: false, gy: y, H: a.h, lid, scr, clipY, back }
}

export function seatXY(P: Plan, key: string): Seat | undefined {
  let m = /^t(\d+)\.(\d+)$/.exec(key)
  if (m) {
    const t = P.tables.find(t => t.id === +m![1]); if (!t) return undefined
    const i = +m[2]; if (i >= t.size) return undefined
    return geomArt(t.art, t.x, t.y, Math.floor(i / 2), i % 2 === 0)
  }
  m = /^o(\d+)$/.exec(key)
  if (m) {
    const k = +m[1], desk = P.desks[Math.floor(k / 2)]
    return desk?.art ? geomArt(desk.art, desk.x, desk.y, k % 2, true) : undefined
  }
  return undefined
}

/**
 * 頂端、底部的家具：跟 scene.js decor() 一樣（少了地毯與寵物）。what＝面板點得到的東西（原本面板的家具選單、點窗戶切夜間），
 * 影印機＝printer（信件）、書櫃＝cabinet（資料）、郵筒＝mailbox（git）、月曆、販賣機、時鐘、會議室
 */
type Decor = { name: string; x: number; y: number; w: number; what?: V2Hit['what'] }
/** 空地板的休息角：跟 scene.js lounge() 一樣（lane＝最後一排辦公桌下方的橫走道、b＝底部家具那排的上緣） */
const LOUNGE_H = 40, LOUNGE_GAP = 14
export function lounge(w: number, lane: number, b: number): Decor[] {
  const top = lane + 10, band = b - 4 - top, mid = Math.min(w / 2, w - 78 - 22)
  const out: Decor[] = []
  const n = Math.floor((band + LOUNGE_GAP) / (LOUNGE_H + LOUNGE_GAP))
  // 放不下一整組（手機常見）：沙發區整組等比縮小放進去；太矮（不到 26 格）就只鋪地毯和兩盆
  if (n < 1) {
    if (band < 20) return out
    if (band < 26) {
      const y = top + (band - 16) / 2
      out.push({ name: 'runner', x: mid - 36, y: y + 4, w: 72 }, { name: 'hydrangea', x: SIDE + 30, y, w: 12 }, { name: 'plant', x: w - 32, y: y - 2, w: 18 })
      return out
    }
  }
  const k = n < 1 ? band / LOUNGE_H : 1, m = Math.max(1, n)
  const y0 = top + (band - (m * LOUNGE_H * k + (m - 1) * LOUNGE_GAP)) / 2
  for (let i = 0; i < m; i++) {
    const y = y0 + i * (LOUNGE_H + LOUNGE_GAP)
    if (i % 2 === 0) { // 沙發區（Codex 2026-11-23 畫的沙發茶几、立燈、白板、飲水機）；第 2、4…組換書櫃邊櫃，不要整排一樣
      out.push({ name: 'runner', x: mid - 36 * k, y: y + 27 * k, w: 72 * k })
      out.push({ name: 'sofa_set', x: mid - 22 * k, y: y + k, w: 44 * k })
      out.push({ name: 'floor_lamp', x: mid - 34 * k, y: y + 2 * k, w: 11 * k })
      out.push({ name: 'whiteboard', x: SIDE + 22, y: y + 10 * k, w: 32 * k })
      out.push({ name: 'water_cooler', x: w - 18 - 12 * k, y: y + 9 * k, w: 13 * k })
      continue
    }
    out.push({ name: 'runner', x: mid - 36, y: y + 26, w: 72 })
    out.push({ name: 'credenza', x: mid - 20, y: y + 8, w: 40 })
    out.push({ name: 'bookshelf', x: SIDE + 26, y: y + 2, w: 20 })
    out.push({ name: 'hydrangea', x: SIDE + 47, y: y + 20, w: 11 })
    out.push({ name: 'plant', x: w - 32, y: y + 12, w: 20 })
  }
  return out.filter(d => sp(d.name))
}
function decor(w: number, h: number, lane: number): Decor[] {
  const it: Decor[] = []
  const add = (name: string, x: number, y: number, ww: number, what?: V2Hit['what']) => it.push({ name, x, y, w: ww, what })
  add('meeting', 5, 3, 56, 'meeting')
  const shelfX = w - 32
  add('bookshelf', shelfX, 3, 26, 'cabinet')
  const plantX = shelfX - 15
  add('hydrangea', plantX, 28, 14)
  const left = 66, right = plantX - 2, avail = right - left
  const WW = 32, n = Math.max(1, Math.min(6, Math.floor((avail + 10) / (WW + 14))))
  const gap = (avail - n * WW) / (n + 1)
  const wins: number[] = []
  for (let i = 0; i < n; i++) wins.push(left + gap + i * (WW + gap))
  for (const x of wins) add('window_day', x, 4, WW, 'window')
  const clockX = n > 1 ? (wins[0] + WW + wins[1]) / 2 - 4 : Math.min(right - 9, wins[0] + WW + 2)
  add('clock', clockX, 5, 8, 'clock')
  // 邊櫃（書、地球儀、玻璃罩花）放牆下正中間、月曆擺在邊櫃上：跟 scene.js 一樣（2026-11-23 補，原本面板沒有邊櫃、月曆飄在書櫃旁的牆上）
  const cw = Math.min(44, avail - 4)
  if (cw > 24 && sp('credenza')) {
    const cx = left + (avail - cw) / 2, ch = cw * ar('credenza')
    add('credenza', cx, 44 - ch, cw)
    add('calendar', cx + cw - 12, 44 - ch - 5, 9, 'calendar')
  } else add('calendar', clockX, 22, 8, 'calendar')
  const b = h - BOTTOM
  it.push(...lounge(w, lane, b))
  add('copier', SIDE + 1, b + 8, 20, 'printer')
  add('mailbox', w - 74, b + 10, 11, 'mailbox')
  add('vending', w - 60, b + 2, 20, 'vending')
  add('plant', w - 37, b + 6, 26)
  return it
}
export type V2Hit = { what: 'printer' | 'cabinet' | 'mailbox' | 'calendar' | 'vending' | 'clock' | 'meeting' | 'window' | 'table'; x: number; y: number; w: number; h: number; table?: number }

/** 一張素材：巢狀 <svg> 裁切素材表（跟 vector.ts 的做法一樣），extra＝多加的屬性（clip-path、opacity） */
function sprite(name: string, x: number, y: number, w: number, h?: number, extra = ''): string {
  const s = sp(name); if (!s) return ''
  const hh = h ?? w * s[5] / s[4]
  return `<svg x="${n2(x)}" y="${n2(y)}" width="${n2(w)}" height="${n2(hh)}" viewBox="${s[0]} ${s[1]} ${s[2]} ${s[3]}" preserveAspectRatio="none"${extra}><use href="#V"/></svg>`
}
/** 這位是不是新規格（448×512 畫布，素材表裡有腳底錨點） */
const isNew = (spc: string) => !!V2_ANCHOR[`full_${spc}_down_sit_0`]
/** 坐姿：新規格照腳底錨點放在座位的腳底線（s.feet）；舊規格腳底中心 (cx, bottom)、高 SIT_H。pose＝sit 或 type（新規格打字） */
function seated(spc: string, facing: 'down' | 'up', pose: 'sit' | 'type', frameNo: number, s: Seat, extra = ''): string {
  if (isNew(spc)) {
    const n = `full_${spc}_${facing}_${pose}_${frameNo}`, name = sp(n) ? n : `full_${spc}_${facing}_sit_0`
    const r = sp(name), a = V2_ANCHOR[name]; if (!r || !a) return ''
    return sprite(name, s.cx + a[0], s.feet + a[1], r[4], r[5], extra)
  }
  const n = `full_${spc}_${facing}_sit_${frameNo}`
  const name = sp(n) ? n : `full_claude_${facing}_sit_0`
  const r = sp(name); if (!r) return ''
  const w = SIT_H * r[4] / r[5]
  return sprite(name, s.cx - w / 2, s.bottom - SIT_H, w, SIT_H, extra)
}
/** 坐著的人：新規格正面打字輪流 type_0、type_2（面板字元上限放不下四格；背面打字被椅背擋住，面板不播）；舊規格正面打字輪流 sit_1、sit_2 */
function person(spc: string, facing: 'down' | 'up', typing: boolean, s: Seat, extra = ''): string[] {
  const swap = (svg: string, values: string, dur: string) => svg.replace(/>(<use)/, ` opacity="${values.split(';')[0]}"><animate attributeName="opacity" values="${values}" dur="${dur}" calcMode="discrete" repeatCount="indefinite"/>$1`)
  if (typing && isNew(spc) && sp(`full_${spc}_${facing}_type_0`) && sp(`full_${spc}_${facing}_type_2`)) {
    return [swap(seated(spc, facing, 'type', 0, s, extra), '1;0', '0.56s'), swap(seated(spc, facing, 'type', 2, s, extra), '0;1', '0.56s')]
  }
  if (typing && facing === 'down' && !isNew(spc) && sp(`full_${spc}_down_sit_2`)) {
    return [swap(seated(spc, 'down', 'sit', 1, s, extra), '1;0', '0.9s'), swap(seated(spc, 'down', 'sit', 2, s, extra), '0;1', '0.9s')]
  }
  return [seated(spc, facing, 'sit', 0, s, extra)]
}

/** 名牌寬度估計（全形字＝字高，半形約 0.6） */
const textW = (t: string, size: number) => [...t].reduce((n, ch) => n + (/[ -~]/.test(ch) ? size * 0.6 : size), 0)
function plateLabel(t: string, cx: number, y: number, size: number, bg: string, fg: string, edge: string, maxW: number): string {
  let s = t
  while (textW(s, size) + 2 > maxW && [...s].length > 2) s = [...s].slice(0, -2).join('') + '…'
  const w = Math.min(maxW, textW(s, size) + 2), h = size * 1.45
  return `<rect x="${n2(cx - w / 2)}" y="${n2(y)}" width="${n2(w)}" height="${n2(h)}" rx="${n2(size * 0.3)}" fill="${bg}" stroke="${edge}" stroke-width="0.35"/>` +
    `<text x="${n2(cx)}" y="${n2(y + size * 1.08)}" font-size="${n2(size)}" text-anchor="middle" font-weight="700" fill="${fg}">${xml(s)}</text>`
}

const TPLATE: Record<string, [string, string, string]> = { ok: ['#fff6e6', '#d5b895', 'ui_icon_pencil'], wait: ['#ffe0b8', '#c9783e', 'ui_icon_alarm'], warn: ['#fff0ec', '#b13e53', 'ui_icon_warn'], ho: ['#f5e4b4', '#8a6410', 'ui_icon_hourglass'] }
/**
 * 美術 A #1（2026-11-25）：兩行桌牌——第一行「桌名（N人）」、第二行狀態（缺主管、交接中、開會中、幾人工作中）；
 * 放不下先縮字（最小 70%），還不行才用省略號。回 { svg, w, h }
 */
const PLATE_FS = 4.2 * 0.9 // 桌牌字（格）：名牌 FS 的 0.9
/**
 * 桌牌第一部分（桌名（N人））怎麼排（審查 ③，比照手機）：人數一定保留；先整行縮字（最小 72%），
 * 還放不下就把桌名拆兩行（第二行接人數），第二行的桌名太長才用省略號。回每一行的字和字級
 */
export function plateLines(name: string, count: string, size = PLATE_FS, maxW = 70): { lines: string[]; z: number } {
  const ic = size * 1.05, pad = size * 0.35, room = maxW - ic - pad * 3, room2 = maxW - pad * 2
  let z = size
  while (textW(name + count, z) > room && z > size * 0.72) z *= 0.95
  if (textW(name + count, z) <= room) return { lines: [name + count], z }
  const ch = [...name]
  let k = ch.length
  while (k > 1 && textW(ch.slice(0, k).join(''), z) > room) k--
  let rest = ch.slice(k).join('')
  while (rest && textW(rest + count, z) > room2 && [...rest].length > 1) rest = [...rest].slice(0, -2).join('') + '…'
  return { lines: [ch.slice(0, k).join(''), rest + count], z }
}
/**
 * 美術 A #1（2026-11-25）：桌牌——上面「桌名（N人）」（必要時兩行）、下面一行狀態（缺主管、交接中、開會中、幾人工作中）；
 * 狀態放不下先縮字（最小 72%），最後才用省略號。回 { svg, w, h }
 */
function tablePlate2(name: string, count: string, line2: string, kind: string, cx: number, y: number, size: number, maxW: number): { svg: string; w: number; h: number } {
  const [bg, edge, icon] = TPLATE[kind] ?? TPLATE.ok, ic = size * 1.05, pad = size * 0.35
  const head = plateLines(name, count, size, maxW)
  let bz = size * 0.9, bs = line2
  while (bs && textW(bs, bz) > maxW - pad * 2 && bz > size * 0.9 * 0.72) bz *= 0.95
  while (bs && textW(bs, bz) > maxW - pad * 2 && [...bs].length > 2) bs = [...bs].slice(0, -2).join('') + '…'
  const lh = size * 1.25, top = size * 1.5 - lh // 第一行跟原本一樣高；多的桌名行每行 lh
  const headH = top + lh * head.lines.length
  const w = Math.min(maxW, Math.max(...head.lines.map((t, i) => textW(t, head.z) + (i === 0 ? ic + pad * 3 : pad * 2)), bs ? textW(bs, bz) + pad * 2 : 0))
  const h = headH + (bs ? size * 1.15 : 0), x = cx - w / 2, c = size * 0.28
  const poly = [[x + c, y], [x + w - c, y], [x + w, y + c], [x + w, y + h - c], [x + w - c, y + h], [x + c, y + h], [x, y + h - c], [x, y + c]].map(([p, q]) => `${n2(p)},${n2(q)}`).join(' ')
  const l1w = textW(head.lines[0], head.z) + ic + pad, l1x = cx - l1w / 2
  let svg = `<polygon points="${poly}" fill="${bg}" stroke="${edge}" stroke-width="0.45"/>` + sprite(icon, l1x, y + (size * 1.5 - ic) / 2, ic, ic) +
    `<text x="${n2(l1x + ic + pad)}" y="${n2(y + size * 1.1)}" font-size="${n2(head.z)}" font-weight="700" fill="#3b2412">${xml(head.lines[0])}</text>`
  for (let i = 1; i < head.lines.length; i++) svg += `<text x="${n2(cx)}" y="${n2(y + size * 1.1 + lh * i)}" font-size="${n2(head.z)}" text-anchor="middle" font-weight="700" fill="#3b2412">${xml(head.lines[i])}</text>`
  if (bs) svg += `<text x="${n2(cx)}" y="${n2(y + headH + size * 0.85)}" font-size="${n2(bz)}" text-anchor="middle" font-weight="500" fill="#3b2412">${xml(bs)}</text>`
  return { svg, w, h }
}

/** planes：傳訊息時從寄件者飛到收件者的紙飛機（frame 計，PLANE_FRAMES 格飛到）；notices：收件者頭上的信封 [start, end) */
export type V2Opts = {
  frame: number; night?: boolean; pxWidth: number; pxHeight?: number
  planes?: { fromId?: string; toId?: string; start: number }[]; planeFrames?: number
  notices?: { id: string; start: number; end: number }[]
  /** 一次性對話（claude -p 這類）不坐位子，只在牆下掛一塊「⚙ 標籤 ×數量」 */
  oneshots?: { label: string; n: number }[]
  /** 選單美術第三批 P1：家具選單畫進 SVG（at＝點的那件家具，hits 的座標）；按鈕位置回傳在 menuHits，register.tsx 疊透明按鈕 */
  /** pressed＝剛按下的那顆（立刻畫按下去的樣子）；enter＝剛打開（只在這一次重畫放 0.2 秒滑入，0.62.17） */
  menu?: { title: string; items: string[]; cancel: string; at: { x: number; y: number; w: number; h: number }; pressed?: number; enter?: boolean }
}
export type V2MenuHit = { x: number; y: number; w: number; h: number }

/** 整張 v2 辦公室的 SVG；people 要先排好座位（seat）、名牌（plate） */
export function v2PanelSvg(people: V2Person[], tables: V2Table[], o: V2Opts): { svg: string; w: number; h: number; hits: V2Hit[]; menuHits?: V2MenuHit[] } {
  // 美術 A 審查 ②：超過 Desktop 的 Svg 上限（SVG_MAX）時，register.tsx 會整個退回舊的 2dPig 畫面。先分級省略非必要的東西、維持 v2：
  // 1＝不畫不能點的裝飾（休息角、盆栽、邊櫃這類）；2＝再拿掉紙飛機、頭上信封。都超過才照舊回最後一版（交給 register.tsx 退回）
  let r = v2PanelSvgAt(people, tables, o, 0)
  for (let lite = 1; lite <= 2 && r.svg.length > SVG_MAX; lite++) r = v2PanelSvgAt(people, tables, o, lite)
  return r
}
function v2PanelSvgAt(people: V2Person[], tables: V2Table[], o: V2Opts, lite: number): { svg: string; w: number; h: number; hits: V2Hit[]; menuHits?: V2MenuHit[] } {
  const offIdx = people.map(p => /^o(\d+)$/.exec(p.seat ?? '')).filter((m): m is RegExpExecArray => !!m).map(m => +m[1])
  const officeNeed = Math.max(offIdx.length ? Math.max(...offIdx) + 1 : 0, offIdx.length + 1, 2)
  const P = plan(o.pxWidth, tables, officeNeed)
  // 撐滿面板高：不夠高就把地板拉長（家具在最底下）
  if (o.pxHeight) { const minH = o.pxHeight * P.w / o.pxWidth; if (P.h < minH) P.h = Math.ceil(minH) }
  const W = P.w, H = P.h
  const bySeat = new Map<string, V2Person>()
  for (const p of people) if (p.seat) bySeat.set(p.seat, p)
  const geo = new Map<string, Seat>()
  for (const k of bySeat.keys()) { const s = seatXY(P, k); if (s) geo.set(k, s) }
  const f = o.frame
  const spc = (p: V2Person) => p.species ?? (p.kind === 'codex' ? 'chatgpt' : p.kind === 'agy' ? 'gemini' : 'claude')
  const out: string[] = []
  const defs: string[] = []

  // 地板、牆
  const ft = sp('floor_tile'), wt = sp('wall_tile')
  if (ft) defs.push(`<pattern id="F" patternUnits="userSpaceOnUse" width="${n2(ft[4])}" height="${n2(ft[5])}">${sprite('floor_tile', 0, 0, ft[4], ft[5])}</pattern>`)
  if (wt) defs.push(`<pattern id="WL" patternUnits="userSpaceOnUse" width="${n2(wt[4] * 40 / wt[5])}" height="40">${sprite('wall_tile', 0, 0, wt[4] * 40 / wt[5], 40)}</pattern>`)
  out.push(`<rect width="${n2(W)}" height="${n2(H)}" fill="${ft ? 'url(#F)' : '#c98a4b'}"/>`)
  out.push(`<rect width="${n2(W)}" height="40" fill="${wt ? 'url(#WL)' : '#e8d9bf'}"/><rect y="40" width="${n2(W)}" height="3" fill="#0000001f"/>`)
  // 分區只靠「💻 辦公區」標籤（分隔線像地板裂縫，2026-11-23 拿掉）；沒有協作桌時畫一個虛線框
  if (!P.tables.length) out.push(`<rect x="${SIDE + 6}" y="${P.collabTop - 8}" width="${n2(W - 2 * SIDE - 12)}" height="28" fill="none" stroke="#6e432688" stroke-width="0.6" stroke-dasharray="2 1.5"/>`)
  const hits: V2Hit[] = []
  const lane = Math.max(...P.desks.map(d => d.y + d.h)) + 9
  for (const it of decor(W, H, lane)) {
    if (lite >= 1 && !it.what) continue
    out.push(sprite(it.name === 'window_day' && o.night ? 'window_night' : it.name, it.x, it.y, it.w))
    if (it.what) hits.push({ what: it.what, x: it.x, y: it.y, w: it.w, h: it.w * ar(it.name) })
  }
  out.push(`<rect width="4" height="${n2(H)}" fill="#6e4326"/><rect x="${n2(W - 4)}" width="4" height="${n2(H)}" fill="#6e4326"/><rect y="${n2(H - 4)}" width="${n2(W)}" height="4" fill="#6e4326"/>`)
  // 桌子底圖
  for (const t of P.tables) out.push(sprite(t.art.name, t.x, t.y, t.w, t.h))
  for (const d of P.desks) if (d.art) out.push(sprite(d.art.name, d.x, d.y, d.w, d.h))
  // 遠側椅子：有獨立椅子圖（桌子底圖已拿掉遠側椅子）就每個遠側座位都畫，主管坐的換正面高背椅；沒有就照舊只在主管背後疊主管椅
  const bossFront = !!sp('far_chair') && !!sp('boss_chair_front')
  if (sp('far_chair')) {
    const farKeys = [...P.tables.flatMap(t => Array.from({ length: t.size / 2 }, (_, c) => `t${t.id}.${c * 2}`)), ...P.desks.flatMap(d => [`o${d.d * 2}`, `o${d.d * 2 + 1}`])]
    for (const k of farKeys) {
      const s = seatXY(P, k); if (!s?.chair) continue
      const boss = bySeat.get(k)?.role === 'manager' && sp('boss_chair_front')
      out.push(sprite(boss ? 'boss_chair_front' : 'far_chair', s.chair.x, s.chair.y, s.chair.w, s.chair.h))
    }
  } else for (const [k, p] of bySeat) { const s = geo.get(k); if (s?.far && s.boss && p.role === 'manager') out.push(sprite('boss_chair', s.boss.x, s.boss.y, s.boss.w, s.boss.h)) }
  const lift = (s: Seat, p: V2Person) => (bossFront && s.far && s.chair && p.role === 'manager' ? BOSS_LIFT : 0)
  // 遠側坐著的人（面向下）
  for (const [k, p] of bySeat) {
    const s = geo.get(k); if (!s?.far) continue
    out.push(...person(spc(p), 'down', p.mode === 'typing', s))
  }
  // 桌面前景（桌面＋遠側筆電）
  for (const t of P.tables) out.push(sprite(t.art.name + '_over', t.x, t.y, t.w, t.h))
  for (const d of P.desks) if (d.art) out.push(sprite(d.art.name + '_over', d.x, d.y, d.w, d.h))
  // 遠側背蓋上的小燈、近側螢幕依狀態上色
  for (const [k, p] of bySeat) {
    const s = geo.get(k); if (!s) continue
    if (s.far) { out.push(`<circle cx="${n2(s.lid[2] - 1.6)}" cy="${n2(s.lid[1] + 1.6)}" r="0.55" fill="${p.mode === 'idle' ? '#e8b840' : '#4ade80'}"/>`); continue }
    const r = s.scr!
    out.push(`<rect x="${n2(r[0] + 0.3)}" y="${n2(r[1] + 0.3)}" width="${n2(r[2] - r[0] - 0.6)}" height="${n2(r[3] - r[1] - 0.6)}" fill="${SCREEN[p.mode] ?? SCREEN.idle}" opacity="0.85"/>`)
  }
  // 近側坐著的人（背影）：舊規格畫到椅座就剪掉；新規格不剪，椅腳之間的裙擺、鞋交給椅背圖層遮
  let clip = 0
  for (const [k, p] of bySeat) {
    const s = geo.get(k); if (!s || s.far) continue
    let extra = ''
    if (s.clipY != null && !isNew(spc(p))) { const id = `c${clip++}`; defs.push(`<clipPath id="${id}"><rect x="0" y="0" width="${n2(W)}" height="${n2(s.clipY)}"/></clipPath>`); extra = ` clip-path="url(#${id})"` }
    // 巢狀 svg 的 clip-path 用的是它自己的座標，包一層 <g> 才是場景座標
    const body = person(spc(p), 'up', p.mode === 'typing', s).join('')
    out.push(extra ? `<g${extra}>${body}</g>` : body)
  }
  // 近側椅子背面（每個近側座位都有，空位也畫）＋有人坐就貼他那家 AI 的標誌
  for (const t of P.tables) for (let i = 1; i < t.size; i += 2) {
    const s = seatXY(P, `t${t.id}.${i}`); if (!s?.back) continue
    out.push(sprite('chair_back', s.back.x, s.back.y, s.back.w, s.back.h))
    const p = bySeat.get(`t${t.id}.${i}`)
    if (p) { const z = s.back.w * 0.3; out.push(sprite('logo_' + (p.kind === 'codex' ? 'chatgpt' : spc(p)), s.back.lx - z / 2, s.back.ly - z / 2, z, z)) }
  }
  // 狀態圖示（等你回覆的舉手比較大，閃一下）
  for (const [k, p] of bySeat) {
    const ic = ICON[p.mode], s = geo.get(k); if (!ic || !s) continue
    const z = p.mode === 'waiting' ? 10 : 7.5
    out.push(sprite(ic, s.cx + 5, s.far ? s.top : s.top - 4, z, z))
  }
  // 夜間：跟原本的面板同一個暗幕顏色（#050a1e），淡一點，v2 的圖比較細
  if (o.night) out.push(`<rect width="${n2(W)}" height="${n2(H)}" fill="#050a1e" opacity="0.4"/>`)
  // 紙飛機（跟原本的面板同一個顏色 #f1f8ff）與收件者頭上的信封
  const seatOf = (id?: string) => { const p = people.find(x => x.id === id); return p?.seat ? geo.get(p.seat) : undefined }
  const PF = o.planeFrames ?? 10
  for (const pl of lite >= 2 ? [] : o.planes ?? []) {
    const a = seatOf(pl.fromId), b = seatOf(pl.toId), t = (f - pl.start) / PF
    if (!a || !b || t < 0 || t > 1) continue
    const x = a.cx + (b.cx - a.cx) * t, y = a.top + (b.top - a.top) * t - Math.sin(Math.PI * t) * 14, s = Math.sign(b.cx - a.cx) || 1
    out.push(`<g transform="translate(${n2(x)} ${n2(y)}) scale(${s} 1)"><path d="M3 0 L-4 -2.6 L-1.6 0 L-4 2.6 Z" fill="#f1f8ff" stroke="#566c86" stroke-width="0.3"/><path d="M-1.6 0 L-4 2.6 L-2.4 0.4 Z" fill="#b0bec5"/></g>`)
  }
  for (const nt of lite >= 2 ? [] : o.notices ?? []) {
    const s = seatOf(nt.id)
    if (!s || f < nt.start || f >= nt.end) continue
    const pp = people.find(x => x.id === nt.id)
    const x = s.cx - 3.5, y = (s.far ? s.top : s.top - 4) - 6 - (pp ? lift(s, pp) : 0)
    out.push(`<rect x="${n2(x)}" y="${n2(y)}" width="7" height="4.6" rx="0.4" fill="#fff8e1" stroke="#d84315" stroke-width="0.35"/><path d="M${n2(x)} ${n2(y)} L${n2(x + 3.5)} ${n2(y + 2.4)} L${n2(x + 7)} ${n2(y)}" fill="none" stroke="#d84315" stroke-width="0.35"/>`)
  }
  // 名牌、分區標示、桌牌、等你回覆的閃圈（最上層）
  const FS = 4.2
  if (o.oneshots?.length) out.push(plateLabel(o.oneshots.map(x => `⚙ ${x.label} ×${x.n}`).join('　'), W / 2, 46, FS * 0.9, '#29366fe6', '#ffffff', '#1a1c2c', W - 40))
  out.push(plateLabel('🤝 協作區', W / 2, P.collabTop - 22, FS, '#6e4326d9', '#fff6e6', '#3b2412', 60))
  out.push(plateLabel('💻 辦公區', W / 2, P.collabEnd + 1, FS, '#6e4326d9', '#fff6e6', '#3b2412', 60))
  if (!P.tables.length) out.push(plateLabel('協作區（同主管底下的人會自動同桌）', W / 2, P.collabTop + 2, FS * 0.9, '#fff6e6e6', '#6e4326', '#6e4326', W - 40))
  // 桌牌一眼看（roadmap 第 4 項）：「桌名・3 人工作中・1 位等你」；放不下先縮桌名、狀態留著；有人等你＝橘、卡住＝紅
  for (const t of P.tables) {
    const maxW = Math.max(t.w, 70), fs = FS * 0.9
    // 選單美術第二批（ref2-F7）：四種底色（一般／有人等你／卡住或缺主管／交接中）、切角、左邊小圖示；顏色取自零件 ui_tplate*.png
    // 字：「桌名・狀態」，放不下先縮桌名、狀態留著；跟手機 scene.js 的桌牌同一套
    const kind = t.noBoss ? 'warn' : t.handover ? 'ho' : t.waiting ? 'wait' : t.blocked ? 'warn' : 'ok'
    // 美術 A #1：第一行「桌名（N人）」（不再拼主管名），第二行狀態；跟手機 scene.js 的桌牌同一套
    const st2 = t.noBoss ? '缺主管' : t.handover ? '主管交接中' : t.meeting ? `開會中：${t.meeting}` : t.grouped ? `已成組・${t.status ?? ''}` : t.status ?? ''
    const tp = tablePlate2(t.name, `（${t.size}人）`, st2, kind, t.x + t.w / 2, t.y + t.h + SIGN_DY, fs, maxW)
    out.push(tp.svg)
    // 點桌牌＝看這桌的聊天室（第 12 項）
    hits.push({ what: 'table', table: t.id, x: t.x + t.w / 2 - tp.w / 2, y: t.y + t.h + SIGN_DY, w: tp.w, h: tp.h })
  }
  // 整桌開會（第 9 項）：參與的人頭上冒對話泡泡
  for (const [k, p] of bySeat) {
    if (!p.meeting) continue
    const s = geo.get(k); if (!s) continue
    // 主管高背椅比較寬：泡泡往左移到椅背外面（跟 scene.js 一樣）
    const bl = lift(s, p) && s.chair ? s.chair.x + s.chair.w * (V2_INK_LEFT.boss_chair_front ?? 27) / 352 - 10.5 : Infinity
    const x = Math.min(s.cx - 14, bl), y = (s.far ? s.top : s.top - 4) - 1 - lift(s, p), w = 10, h = 6.5
    out.push(`<rect x="${n2(x)}" y="${n2(y)}" width="${w}" height="${h}" rx="1.6" fill="#ffffff" stroke="#566c86" stroke-width="0.4"/><path d="M${n2(x + w - 3)} ${n2(y + h)} L${n2(x + w - 0.5)} ${n2(y + h + 2)} L${n2(x + w - 1.2)} ${n2(y + h)} Z" fill="#ffffff" stroke="#566c86" stroke-width="0.4"/>` +
      [0, 1, 2].map(i => `<circle cx="${n2(x + 2.5 + i * 2.5)}" cy="${n2(y + h / 2)}" r="0.7" fill="${(f + i) % 3 === 0 ? '#29366f' : '#9aa8bd'}"/>`).join(''))
  }
  for (const [k, p] of bySeat) {
    const s = geo.get(k); if (!s) continue
    const boss = p.role === 'manager', wait = p.mode === 'waiting', err = p.mode === 'blocked'
    const bg = wait ? '#ff9a3c' : err ? '#b13e53' : boss ? '#e8bb3a' : '#fff6e6e6'
    const fg = wait || err ? '#ffffff' : '#3b2412'
    const ty = s.far ? s.top - 6.5 - lift(s, p) : s.gy + s.H + 0.5
    out.push(plateLabel((boss ? '★' : '') + p.plate, s.cx, ty, FS, bg, fg, boss ? '#8a6410' : wait ? '#b85a10' : err ? '#7a1f30' : '#b98250', 36))
    if (wait) {
      const cy = (s.far ? s.top : s.top - 4) + 5
      out.push(`<circle cx="${n2(s.cx + 10)}" cy="${n2(cy)}" r="5" fill="none" stroke="#ff9a3c" stroke-width="1.2"><animate attributeName="r" values="4;8" dur="1.2s" repeatCount="indefinite"/><animate attributeName="opacity" values="0.95;0" dur="1.2s" repeatCount="indefinite"/></circle>`)
    }
  }
  const head = `<defs><image id="V" width="${V2_SHEET_W}" height="${V2_SHEET_H}" href="data:image/png;base64,${V2_SHEET_PNG}" style="image-rendering:pixelated"/>${defs.join('')}</defs>`
  // 比面板高（人多、面板矮）：整張縮小到放得進面板高，左右補牆色邊（2026-11-23，原本辦公區會被切掉）；點擊區跟著往右移
  const VW = o.pxHeight && H * o.pxWidth / o.pxHeight > W + 0.5 ? H * o.pxWidth / o.pxHeight : W
  const ox = VW > W ? (VW - W) / 2 : 0
  if (ox) for (const h of hits) h.x += ox
  const m = o.menu ? menuSvg(o.menu, o.pxWidth / VW, VW, H) : undefined
  if (ox) {
    return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n2(VW)} ${n2(H)}" width="${Math.round(o.pxWidth)}" height="${Math.round(o.pxHeight!)}" font-family="${FONT}">${head}<rect width="${n2(VW)}" height="${n2(H)}" fill="#6e4326"/><g transform="translate(${n2(ox)} 0)">${out.join('')}</g>${m?.svg ?? ''}</svg>`, w: VW, h: H, hits, menuHits: m?.hits }
  }
  const ph = Math.round(o.pxWidth * H / W)
  return { svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n2(W)} ${n2(H)}" width="${Math.round(o.pxWidth)}" height="${ph}" font-family="${FONT}">${head}${out.join('')}${m?.svg ?? ''}</svg>`, w: W, h: H, hits, menuHits: m?.hits }
}

/**
 * 家具選單（選單美術第三批 ref3-P1）：深棕框米白底的彈出框、標題名牌、按鈕（第一顆深藍主按鈕、其他金框、最後「取消」）。
 * 面板上看不見的按鈕只能對齊格子（一欄 8 px、一列 20 px），所以版面用 px 排、對齊 20 px 列，再換成 SVG 單位（ppu＝每單位幾 px）。
 * 位置：家具右邊放得下就放右邊，不然放左邊；上下夾在畫面內
 */
const MENU_PRESS_NAVY = '#1a2350', MENU_INK = '#3b2412', MENU_FRAME = '#6e4326', MENU_BG = '#fff6e6', MENU_GOLD = '#c9a227', MENU_NAVY = '#29366f', MENU_CREAM = '#fffaf0'
function chamfer(x: number, y: number, w: number, h: number, c: number): string {
  return [[x + c, y], [x + w - c, y], [x + w, y + c], [x + w, y + h - c], [x + w - c, y + h], [x + c, y + h], [x, y + h - c], [x, y + c]].map(([a, b]) => `${n2(a)},${n2(b)}`).join(' ')
}
export function menuSvg(menu: NonNullable<V2Opts['menu']>, ppu: number, VW: number, VH: number): { svg: string; hits: V2MenuHit[] } {
  const ROW = 20, BW = 280, BH = 40, PAD = 20
  const labels = [...menu.items, menu.cancel]
  const pw = BW + PAD * 2, ph = 80 + labels.length * (BH + ROW)
  const snap = (v: number, g: number) => Math.round(v / g) * g
  const fx = menu.at.x * ppu, fy = menu.at.y * ppu, fw = menu.at.w * ppu, fh = menu.at.h * ppu
  const maxX = VW * ppu, maxY = VH * ppu
  let left = fx + fw + 16 + pw <= maxX ? fx + fw + 16 : fx - 16 - pw
  left = snap(Math.max(8, Math.min(left, maxX - pw - 8)), 8)
  let top = snap(Math.max(ROW, Math.min(fy + fh / 2 - ph / 2, maxY - ph - ROW)), ROW)
  const u = (v: number) => v / ppu // px → SVG 單位
  const parts: string[] = []
  const lw = u(3), c = u(10)
  parts.push(`<polygon points="${chamfer(u(left), u(top), u(pw), u(ph), c)}" fill="${MENU_BG}" stroke="${MENU_FRAME}" stroke-width="${n2(lw)}"/>`)
  // 標題名牌：深棕條上一塊米白切角名牌
  parts.push(`<rect x="${n2(u(left + 3))}" y="${n2(u(top + 3))}" width="${n2(u(pw - 6))}" height="${n2(u(60))}" fill="${MENU_FRAME}"/>`)
  parts.push(`<polygon points="${chamfer(u(left + 12), u(top + 10), u(pw - 24), u(46), u(8))}" fill="${MENU_CREAM}" stroke="#b98250" stroke-width="${n2(u(2))}"/>`)
  parts.push(`<text x="${n2(u(left + pw / 2))}" y="${n2(u(top + 41))}" font-size="${n2(u(20))}" text-anchor="middle" fill="${MENU_INK}">${xml(menu.title)}</text>`)
  const hits: V2MenuHit[] = []
  labels.forEach((t, i) => {
    const bx = left + PAD, by = top + 80 + i * (BH + ROW)
    const prim = i === 0 && labels.length > 1
    // 按下去：整顆往下 2 px、底色變深（像素風的「壓下」），放開由 register 關選單
    const down = menu.pressed === i, dy = down ? 2 : 0
    const fill = down ? (prim ? MENU_PRESS_NAVY : MENU_GOLD) : prim ? MENU_NAVY : MENU_CREAM
    parts.push(`<polygon points="${chamfer(u(bx), u(by + dy), u(BW), u(BH), u(6))}" fill="${fill}" stroke="${prim ? MENU_NAVY : MENU_GOLD}" stroke-width="${n2(u(2))}"/>`)
    parts.push(`<text x="${n2(u(bx + BW / 2))}" y="${n2(u(by + 26 + dy))}" font-size="${n2(u(15))}" text-anchor="middle" fill="${prim ? '#ffffff' : MENU_INK}">${xml(t)}</text>`)
    hits.push({ x: u(bx), y: u(by), w: u(BW), h: u(BH) })
  })
  // 剛打開：0.2 秒從下方 8 px 滑上來、淡入（四格 steps，維持像素感）；系統設「減少動態效果」時不播
  const enter = menu.enter ? `<style>.menu-in{animation:po-menu-in .2s steps(4,end)}@keyframes po-menu-in{from{opacity:0;transform:translateY(${n2(u(8))}px)}}@media (prefers-reduced-motion:reduce){.menu-in{animation:none}}</style>` : ''
  return { svg: `${enter}<g class="menu${menu.enter ? ' menu-in' : ''}">${parts.join('')}</g>`, hits }
}
