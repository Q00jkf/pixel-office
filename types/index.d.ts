export type OfficeMode = 'idle' | 'thinking' | 'typing' | 'reading' | 'error' | 'done'

/** 辦公室裡的一位同事 = 一個 Claude Code session */
export type Role = 'manager' | 'staff'

export type Coworker = { id: string; name: string; mode: OfficeMode; tool: string; isMe: boolean; role: Role }

declare module 'claude-code' {
  interface PluginState {
    'pixel-office': { crew: Coworker[]; night: boolean }
  }
}
