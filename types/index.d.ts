export type OfficeMode = 'idle' | 'thinking' | 'typing' | 'reading' | 'error' | 'done' | 'waiting' | 'blocked'

export type Role = 'manager' | 'staff'

/** 辦公室裡的一位同事 = 一個 Claude Code session */
export type Coworker = {
  id: string
  name: string
  mode: OfficeMode
  tool: string
  isMe: boolean
  role: Role
  /** 職稱（自由填寫，例如 IT、查證）；不畫在像素圖上，可用中文 */
  title?: string
  /** 自己宣告的權限模式：true＝auto（ask 交給分類器，不等人），不會舉手等核准 */
  auto?: boolean
  /** 被 auto 模式分類器擋下、等使用者在這個視窗說「放行」：工具名與時間（ms）；使用者下一次輸入時清除 */
  blocked?: { tool: string; at: number }
  /** 歸屬：主管的 ListAgents 名稱（例如 user-30）；符合在線主管的就是他的 peer，坐右邊那一區 */
  team?: string
  /** ListAgents 上的名稱（SendMessage 的收件者就是它），不顯示，只用來找人 */
  agent?: string
  /** 最近一次送出訊息：收件者名稱與時間（ms） */
  sentTo?: string
  sentAt?: number
  /** 最近一次收到別的 session 的訊息（ms） */
  gotAt?: number
}

/** 個人按鈕（~/.claude/pixel-office/buttons.json）：prompt 送給這個視窗，url 用瀏覽器開 */
export type CustomButton = { label: string; prompt?: string; url?: string }

declare module 'claude-code' {
  interface PluginState {
    'pixel-office': { crew: Coworker[]; night: boolean; buttons: CustomButton[]; instance: string }
  }
}
