// 關掉 Claude app 分頁就自動解雇（0.63.23；像素顧問定案規格，使用者確認、主管 2026-11-25 核可做法）
// - 範圍：只管 Claude app 開的分頁（Claude Code 的 session 紀錄 entrypoint＝sdk-cli；Remote Control 接起來的對話也是）。
//   手機招聘的（tmux）、終端機開的都不算
// - 同一個 App＝同一個父程序（實測：App 的分頁都是某個 claude 主程序的子程序）；記父程序 pid＋啟動時間，免得 pid 被重用
// - 判定分頁關掉（四個都成立，而且連續取樣累積滿 10 分鐘；取樣中斷超過 3 分鐘從零算）：這位不在名冊、它自己的程序結束了（排除 /clear 換了 session id）、
//   同一個父程序還活著、同一個 App 至少還有一人在線。中途任一條不成立就重新算（App 整個重開／全部同時不見＝暫時離線，不處理）
// - 做的事：拿掉座位、釘選、行政；他是那桌主管的，那桌標「缺主管」（沿用桌牌的缺主管提示）；那桌聊天室記一行「某某已離開（關掉 App 分頁）」。
//   不刪紀錄、不封存。之後同一個 session 再回來＝新人，照一般規則入座
import { readFileSync, writeFileSync } from 'node:fs'

export const APP_TAB_GONE_MS = 10 * 60e3
/** 兩次取樣隔太久（電腦睡著、伺服器停過）：中間那段不算，寬限重新起算（0.63.26，審查 0.63.24 第 1 項） */
export const APP_TAB_MAX_GAP_MS = 3 * 60e3
export type Tab = { host: number; hostStart: string; pid: number; plate: string; table?: number; boss?: boolean; seen: number; gone?: number; goneMs?: number; checked?: number }
export type AppTabDeps = {
  file: string
  /** 在線的這位是不是 App 分頁：是就回它的程序與父程序（不是回 undefined） */
  tabOf: (id: string) => { pid: number; host: number; hostStart: string } | undefined
  /** 程序還在不在、啟動時間（父程序用：pid 被重用時啟動時間會不一樣） */
  alive: (pid: number) => boolean
  startOf: (pid: number) => string | undefined
  /** 解雇：拿掉座位、釘選、行政；boss＝他是那桌主管 */
  remove: (id: string, t: Tab) => void
}

export function loadTabs(file: string): Record<string, Tab> {
  try { const j = JSON.parse(readFileSync(file, 'utf8')); return j && typeof j.tabs === 'object' ? j.tabs : {} } catch { return {} }
}

/**
 * 每次名冊更新叫一次。online＝現在在名冊上的人（含座位）。回傳這次解雇的人（給測試與紀錄）
 */
export function tickAppTabs(online: { id: string; plate: string; role?: string; kind?: string; seat?: string }[], D: AppTabDeps, now = Date.now()): string[] {
  const tabs = loadTabs(D.file)
  let dirty = false
  const here = new Set(online.map(p => p.id))
  // 在線的：記下（或更新）它的 App 與座位
  for (const p of online) {
    if (p.kind) continue // 只管 Claude
    const info = D.tabOf(p.id)
    if (!info) { if (tabs[p.id]) { delete tabs[p.id]; dirty = true } continue }
    const m = /^t(\d+)\./.exec(p.seat ?? '')
    tabs[p.id] = { ...info, plate: p.plate, ...(m ? { table: +m[1] } : {}), boss: p.role === 'manager', seen: now }
    dirty = true
  }
  // 同一個 App 現在還有誰在線
  const liveHosts = new Set(Object.entries(tabs).filter(([id]) => here.has(id)).map(([, t]) => `${t.host}@${t.hostStart}`))
  const fired: string[] = []
  for (const [id, t] of Object.entries(tabs)) {
    if (here.has(id)) { if (t.gone) { delete t.gone; delete t.goneMs; delete t.checked; dirty = true } continue }
    const hostOk = D.alive(t.host) && D.startOf(t.host) === t.hostStart
    const closed = !D.alive(t.pid) && hostOk && liveHosts.has(`${t.host}@${t.hostStart}`)
    if (!closed) {
      if (t.gone) { delete t.gone; delete t.goneMs; delete t.checked; dirty = true } // 條件中斷（App 重開、全部不見、程序還在）：重新算
      if (!hostOk && now - t.seen > 24 * 3600e3) { delete tabs[id]; dirty = true } // App 早就不在了：一天後忘掉
      continue
    }
    // 只累積連續取樣的時間（審查 0.63.24 第 1 項）：原本只比牆上時間，電腦睡著、伺服器停機那段也算進 10 分鐘，
    // 醒來第一輪就可能解雇還在重連的分頁。兩次取樣隔超過 3 分鐘＝中間沒看著，從零重新算
    if (!t.gone) { t.gone = now; t.goneMs = 0; t.checked = now; dirty = true; continue }
    const gap = now - (t.checked ?? now)
    t.goneMs = gap < APP_TAB_MAX_GAP_MS ? (t.goneMs ?? 0) + gap : 0 // 正好 3 分鐘也不算（快驗第 2 項）
    t.checked = now
    dirty = true
    if (t.goneMs < APP_TAB_GONE_MS) continue
    try { D.remove(id, t) } catch {}
    delete tabs[id]
    fired.push(id)
    dirty = true
  }
  if (dirty) try { writeFileSync(D.file, JSON.stringify({ tabs })) } catch {}
  return fired
}

/** 伺服器啟動時把所有累積歸零（0.63.27，快驗第 2 項：停機那段沒看著，重開後從零算） */
export function resetAppTabs(file: string): void {
  const tabs = loadTabs(file)
  let dirty = false
  for (const t of Object.values(tabs)) if (t.gone !== undefined || t.goneMs !== undefined || t.checked !== undefined) { delete t.gone; delete t.goneMs; delete t.checked; dirty = true }
  if (dirty) try { writeFileSync(file, JSON.stringify({ tabs })) } catch {}
}
