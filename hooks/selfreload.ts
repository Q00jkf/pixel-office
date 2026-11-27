// 外掛自己換新版（0.63.25；主管 2026-11-25 核可方案 A）：外掛每分鐘讀它來源資料夾（$.plugin.root）的 plugin.json，
// 版號比自己載入的新、而且對話閒著（沒有在跑的回合、沒有待送的佇列訊息、沒有等核准），就自己叫 /reload-plugins。
// 讓開在 Claude App 的分頁、Remote Control 接起來的對話也會換：那些從外面送不到 /reload-plugins
// （Claude Code 2.1.331 的 reload-plugins 標成非互動也能跑）。
// 同一個版號只試 1 次（0.64.3；原本 3 次、隔 10 分鐘）：送完不看結果就算一次，遠端連線的對話每次都回「isn't available」，使用者看到好幾次。
// 回的是「遠端連線不能用」：這個對話記成不能重載，之後的新版也不再自己送（reloadRefused），要重開對話或自己打 /reload-plugins

/** '0.63.25' > '0.63.9'：逐段比數字 */
export function newerVersion(a: string, b: string): boolean {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0), pb = b.split('.').map(n => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  }
  return false
}

export const RELOAD_RETRY_MS = 10 * 60e3, RELOAD_TRIES = 1
export type ReloadTry = { version: string; tries: number; at: number }

/** 要不要現在重載：disk＝來源資料夾的版號，loaded＝自己的 VERSION，idle＝對話閒著，last＝上次為了哪個版號試過，blocked＝這個對話記成不能重載 */
export function shouldReload(o: { disk?: string; loaded: string; idle: boolean; last?: ReloadTry; now: number; blocked?: boolean }): boolean {
  if (o.blocked || !o.disk || !newerVersion(o.disk, o.loaded) || !o.idle) return false
  const l = o.last
  if (!l || l.version !== o.disk) return true
  return l.tries < RELOAD_TRIES && o.now - l.at >= RELOAD_RETRY_MS
}

/**
 * 現在可不可以重載（0.63.26，審查 0.63.25 第 2 項；自己換新版和人事通道的 reload 共用這一個判定）：
 * 沒有在跑的回合、沒有待送的佇列訊息、沒有等核准、輸入框是空的（引擎看得到的話）、最後一次活動（回合開始／結束、打字）超過 5 分鐘。
 * 限制：Claude App／SDK 代管的對話引擎讀不到輸入框（$.prompt.read 回空字串），只能靠「5 分鐘沒動靜」降低打字中被重載的機會
 */
export const RELOAD_QUIET_MS = 5 * 60e3
export function canReloadNow(o: { turnRunning: boolean; cmdPending: boolean; approval: boolean; draft: string; lastActive: number; now: number }): boolean {
  return !o.turnRunning && !o.cmdPending && !o.approval && o.draft.trim() === '' && o.now - o.lastActive >= RELOAD_QUIET_MS
}

/** /reload-plugins 回的字（或丟出的錯）是不是「這個對話不能重載」：Remote Control 遠端連線時 Claude Code 回 "/reload-plugins isn't available over a remote connection in this session."（2026-11-27 GUANGUAN 主管實際收到） */
export function reloadRefused(text: unknown): boolean {
  return typeof text === 'string' && /(isn't|is not|not) available over a remote connection/i.test(text)
}
