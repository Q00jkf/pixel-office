export type OfficeMode = 'idle' | 'thinking' | 'typing' | 'reading' | 'error' | 'done' | 'waiting' | 'blocked'

export type Role = 'manager' | 'staff'

/** 對外動作的種類：mail＝寄信（影印機）、file＝上傳文件（檔案櫃）、push＝推 git（郵筒） */
export type ErrandKind = 'mail' | 'file' | 'push'

/** 辦公室裡走來走去的那一隻：貓、小寶寶或銀喉長尾山雀（/office pet 切換，存在 $.store） */
export type Pet = 'cat' | 'baby' | 'bird'

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
  /** 最近一次對外動作（寄信／上傳文件／推 git）：各視窗據此播放走去影印機／檔案櫃／郵筒的動畫 */
  errand?: { kind: ErrandKind; at: number }
  /** ListAgents 上的名稱（SendMessage 的收件者就是它），不顯示，只用來找人 */
  agent?: string
  /** ListAgents 名稱後面那組 [ref]（例如 180a9b）：兩個 session 同名時，SendMessage 要靠它分辨 */
  ref?: string
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
    'pixel-office': { crew: Coworker[]; night: boolean; buttons: CustomButton[]; instance: string; pet: Pet }
  }
}
