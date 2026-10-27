import type { Coworker, OfficeMode } from '../types'

export const STALE_MS = 20000 // 超過這麼久沒心跳 = 視窗已關

/** sessions/<id>.json 的內容 → 同事；已關（left）或超過心跳上限的回 undefined。辦公室面板與手機版伺服器共用 */
export function parseStatus(s: any, now: number): Coworker | undefined {
  if (!s || s.left || typeof s.updatedAt !== 'number' || now - s.updatedAt >= STALE_MS) return undefined
  return {
    id: String(s.id),
    name: String(s.name),
    mode: s.mode as OfficeMode,
    tool: String(s.tool ?? ''),
    isMe: false,
    role: s.role === 'manager' ? 'manager' : 'staff',
    agent: typeof s.agent === 'string' ? s.agent : undefined,
    ref: typeof s.ref === 'string' ? s.ref : undefined,
    title: typeof s.title === 'string' ? s.title : undefined,
    titleAuto: s.titleAuto === true ? true : undefined,
    titleAt: typeof s.titleAt === 'number' ? s.titleAt : undefined,
    addr: typeof s.addr === 'string' && s.addr.startsWith('uds:') ? s.addr : undefined,
    since: typeof s.since === 'number' ? s.since : undefined,
    lastError: s.lastError && typeof s.lastError.text === 'string' && typeof s.lastError.at === 'number' ? { text: s.lastError.text, at: s.lastError.at } : undefined,
    prompt: s.prompt && typeof s.prompt.text === 'string' && typeof s.prompt.at === 'number' ? { text: s.prompt.text, at: s.prompt.at } : undefined,
    office: s.office === true ? true : undefined,
    approve: s.office === true && s.approve === true ? true : undefined,
    approval: s.approval && typeof s.approval.tool === 'string' && typeof s.approval.at === 'number' && typeof s.approval.deadline === 'number' && now < s.approval.deadline ? { tool: s.approval.tool, at: s.approval.at, deadline: s.approval.deadline } : undefined,
    auto: s.auto === true ? true : undefined,
    team: typeof s.team === 'string' && s.team.length > 0 ? s.team : undefined,
    blocked: s.blocked && typeof s.blocked.tool === 'string' && typeof s.blocked.at === 'number' ? { tool: s.blocked.tool, at: s.blocked.at } : undefined,
    errand: s.errand && ['mail', 'file', 'push'].includes(s.errand.kind) && typeof s.errand.at === 'number' ? { kind: s.errand.kind, at: s.errand.at } : undefined,
    sentTo: typeof s.sentTo === 'string' ? s.sentTo : undefined,
    sentAt: typeof s.sentAt === 'number' ? s.sentAt : undefined,
    gotAt: typeof s.gotAt === 'number' ? s.gotAt : undefined,
    oneshot: s.oneshot === true ? true : undefined,
    label: typeof s.label === 'string' && s.label.length > 0 ? s.label : undefined,
  }
}
