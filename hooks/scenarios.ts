// 測試與 SVG 大小報告共用的情境：最大情境＝30 人＋3 位主管＋貓＋紙飛機＋開會＋排隊
import type { Coworker } from '../types'
import { assignSeats, type SceneOptions, type Walker, type Placement } from './scene'

const MODES: Coworker['mode'][] = ['idle', 'typing', 'thinking', 'reading', 'done', 'error', 'waiting', 'blocked']

export function bigCrew(n = 30): Coworker[] {
  const out: Coworker[] = [
    { id: 'boss-a', name: 'office', mode: 'thinking', tool: '', isMe: false, role: 'manager', agent: 'office' },
    { id: 'boss-b', name: '主管乙', mode: 'typing', tool: '', isMe: false, role: 'manager', agent: 'boss-b' },
    { id: 'boss-c', name: 'cc', mode: 'idle', tool: '', isMe: false, role: 'manager', agent: 'boss-c' },
  ]
  for (let i = 0; i < n - 3; i++) {
    const team = i % 3 === 0 ? 'office' : i % 3 === 1 ? 'boss-b' : undefined
    out.push({ id: `s${i}`, name: i % 4 === 0 ? `實作${i}` : `peer-${i}`, mode: MODES[i % MODES.length], tool: 'Bash', isMe: i === 2, role: 'staff', ...(team ? { team } : {}) })
  }
  return out
}

export type Case = { name: string; crew: Coworker[]; width: number; rows: number; frame: number; walkers: Walker[]; seating?: Map<string, Placement>; opts: SceneOptions }

export function cases(): Case[] {
  const list: Case[] = []
  for (const [width, rows] of [[112, 80], [80, 50], [60, 44], [48, 44]]) {
    const crew = bigCrew()
    const seating = assignSeats(crew, width, rows)
    const attendees = ['實作8', '實作16', '實作24', 'peer-9'] // 前三位閒著（idle）會進會議室；peer-9 在忙，留在座位
    const meetSeating = assignSeats(crew, width, rows, seating, true, attendees) // 開會時的座位：參加者坐進會議室
    const s3 = seating.get('s3')!
    for (const frame of [0, 7]) {
      list.push({ name: `empty-${width}-${frame}`, crew: [], width, rows, frame, walkers: [], opts: {} })
      list.push({ name: `one-${width}-${frame}`, crew: crew.slice(0, 1).concat(crew.slice(3, 5)), width, rows, frame, walkers: [], opts: {} })
      list.push({
        name: `max-${width}-${frame}`,
        crew,
        width,
        rows,
        frame,
        walkers: [{ id: 's5', path: [s3.stand, { x: s3.stand.x, y: 26 }, { x: width - 20, y: 26 }], start: 0, kind: 'mail' }],
        seating: meetSeating,
        opts: {
          meeting: true,
          attendees,
          queue: ['s6', 's14'],
          planes: [{ from: s3.stand, to: { x: width - 10, y: 6 }, start: frame - 3 }],
          notices: [{ id: 's7', start: 0, end: 20 }],
          raid: { targetId: 's10', start: 0 },
          treatFrame: frame - 2,
        },
      })
      list.push({ name: `night-${width}-${frame}`, crew, width, rows, frame, walkers: [], seating, opts: { night: true, pet: 'baby' } })
      list.push({ name: `bird-${width}-${frame}`, crew: crew.slice(0, 8), width, rows, frame, walkers: [], opts: { pet: 'bird', raid: { targetId: 's1', start: 0 } } })
    }
  }
  return list
}

/** FNV-1a：鎖住終端機畫面（encode 的輸出）逐字相同 */
export function fnv(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0
  return h.toString(16).padStart(8, '0')
}
