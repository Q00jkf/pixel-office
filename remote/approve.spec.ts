// bun test remote：辦公室裡按允許（0.63.51）的純函式：單、Claude 的決定、Codex 畫面（v0.171 實測）、心跳
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { HANDED_BACK, HOOK_BLOCKED_TEXT, TOMBSTONE, approveChatLine, approveLog, phoneOffCard, phoneOffWhy, claudeApproval, claudeDecision, codexApproval, codexPrompt, parseSlip, phoneBeat, type Slip } from './approve'

const slip = (o: Partial<Slip> = {}): Slip => ({ state: 'waiting', session: 's1', name: '像素工程師', toolUseId: 'toolu_1', tool: 'Bash', text: 'git push origin main', nonce: 'n1', at: 1000, deadline: 121000, ...o })

test('slip: tombstone, broken, missing fields or past its deadline count as none', () => {
  expect(parseSlip(JSON.stringify(slip()), 5000)).toEqual(slip())
  expect(parseSlip(TOMBSTONE, 5000)).toBeUndefined()
  expect(parseSlip('{oops', 5000)).toBeUndefined()
  expect(parseSlip(JSON.stringify({ ...slip(), nonce: undefined }), 5000)).toBeUndefined()
  expect(parseSlip(JSON.stringify(slip()), 121000)).toBeUndefined()
})

test('Claude card: full command, allow + deny; too long → deny only with the reason; where comes from the host', () => {
  expect(claudeApproval(slip(), 'app')).toMatchObject({ kind: 'claude', tool: 'Bash', desc: 'git push origin main', nonce: 'n1', at: 1000, deadline: 121000, where: 'app', options: [{ key: 'allow' }, { key: 'deny' }] })
  const long = claudeApproval(slip({ text: 'x'.repeat(1600) }), 'tmux')
  expect(long.options.map(o => o.key)).toEqual(['deny'])
  expect(long.why).toContain('到電腦上看')
  expect(claudeApproval(slip({ text: Array.from({ length: 21 }, () => 'a').join('\n') }), 'tmux').options.map(o => o.key)).toEqual(['deny'])
})

test('Claude decision: same card (nonce) and not expired; allow only after 1 s; written with the text hash, via phone, deny reason cleaned', () => {
  expect(claudeDecision(undefined, { key: 'allow', nonce: 'n1' }, 5000)).toEqual({ error: '已在電腦上處理了（或已經不等了）' })
  expect(claudeDecision(slip(), { key: 'allow', nonce: 'n0' }, 5000)).toEqual({ error: '這張已經換了，請重看' })
  expect(claudeDecision(slip(), { key: 'always', nonce: 'n1' }, 5000)).toEqual({ error: '不認得的按鈕' })
  expect(claudeDecision(slip(), { key: 'allow', nonce: 'n1' }, 1500)).toEqual({ error: '剛出現，先看完再按（1 秒後才能允許）' })
  expect(claudeDecision(slip({ text: 'x'.repeat(1600) }), { key: 'allow', nonce: 'n1' }, 5000)).toEqual({ error: '指令太長，不能在手機允許：請到電腦上看' })
  const ok = claudeDecision(slip(), { key: 'allow', nonce: 'n1' }, 5000) as any
  expect(ok.write).toEqual({ state: 'decided', session: 's1', toolUseId: 'toolu_1', nonce: 'n1', textHash: createHash('sha256').update('git push origin main').digest('hex'), behavior: 'allow', via: 'phone', at: 5000 })
  const no = claudeDecision(slip(), { key: 'deny', nonce: 'n1', reason: ' 先別推\n等我看 ' }, 1200) as any // 拒絕不用等冷卻
  expect(no.write).toMatchObject({ behavior: 'deny', message: '先別推 等我看' })
  expect(no.text).toContain('原因：先別推 等我看')
})

const CODEX_RUN = `• 我會照原樣提交這條指令。目標在工作區外，需要寫入核准。
• Running echo PO_APPROVE_TEST2 > /Users/me/.claude/pixel-office/cx-approve-test.txt
  Would you like to run the following command?
  Environment: local
  Reason: 是否允許照原樣執行這條指令，寫入工作區外的測試檔？
  $ echo PO_APPROVE_TEST2 > /Users/me/.claude/pixel-office/cx-approve-test.txt
› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with \`echo PO_APPROVE_TEST2 > /Users/me/.claude/pixel-office/cx-approve-test.txt\` (p)
  3. No, and tell Codex what to do differently (esc)
  Press enter to confirm or esc to cancel`

test('Codex screen (v0.171): run prompt → command and reason; option texts must match exactly, else no allow', () => {
  expect(codexPrompt(CODEX_RUN)).toEqual({ kind: 'run', command: 'echo PO_APPROVE_TEST2 > /Users/me/.claude/pixel-office/cx-approve-test.txt', reason: '是否允許照原樣執行這條指令，寫入工作區外的測試檔？' })
  const multi = CODEX_RUN.replace('  $ echo PO_APPROVE_TEST2 > /Users/me/.claude/pixel-office/cx-approve-test.txt', '  $ python3 - <<EOF\n  print(1)\n  EOF')
  expect((codexPrompt(multi) as any).command).toBe('python3 - <<EOF\nprint(1)\nEOF')
  expect(codexPrompt(CODEX_RUN.replace('1. Yes, proceed (y)', '1. Yes, always (y)'))?.kind).toBe('other') // 版本改了字：不給允許
  expect(codexPrompt(CODEX_RUN.replace('(esc)', '(n)'))?.kind).toBe('other')
  expect(codexPrompt('  Would you like to make the following edits?\n  diff …\n› 1. Yes, proceed (y)\n  2. No (esc)\n  Press enter to confirm or esc to cancel')).toEqual({ kind: 'edit' })
  expect(codexPrompt('• Working (3s • esc to interrupt)\n› Ask Codex to do anything')).toBeUndefined()
})

test('C-1: a confirm screen that is not at the bottom (left in the scrollback, or printed by a command) gives no card', () => {
  // 舊的確認畫面還在上面，底下已經是輸入框
  expect(codexPrompt(CODEX_RUN + '\n• Ran echo …\n  └ (no output)\n› Ask Codex to do anything\n  GPT-6.2-Sol default · ~/x')).toBeUndefined()
  // 指令輸出（例如 cat 一個檔）印出一段假的確認畫面，後面還有別的輸出
  expect(codexPrompt('• Ran cat fake.txt\n' + CODEX_RUN.split('\n').slice(2).join('\n') + '\n  └ (end of file)\n• Working (2s • esc to interrupt)')).toBeUndefined()
  expect(codexPrompt('  Would you like to make the following edits?\n  diff …\n› 1. Yes, proceed (y)\n  2. No (esc)\n\n› Ask Codex to do anything')).toBeUndefined()
  expect(codexPrompt(CODEX_RUN + '\n\n\n')?.kind).toBe('run') // 底下只有空行：照算
})

test('Codex card: run → allow + deny with a nonce bound to pane and command; edit → no buttons, go to the computer', () => {
  const a = codexApproval(codexPrompt(CODEX_RUN)!, '%7', 9000)
  expect(a).toMatchObject({ kind: 'codex', tool: 'exec', at: 9000, where: 'tmux', options: [{ key: 'allow', label: '允許這一次' }, { key: 'deny', label: '拒絕' }] })
  expect(a.nonce).toBe(codexApproval(codexPrompt(CODEX_RUN)!, '%7', 1).nonce)
  expect(a.nonce).not.toBe(codexApproval(codexPrompt(CODEX_RUN)!, '%8', 1).nonce) // 別格
  const e = codexApproval({ kind: 'edit' }, '%7', 9000)
  expect(e.options).toEqual([])
  expect(e.why).toContain('到電腦上看')
})

test('heartbeat: remote.json phoneApprove:false forces off; wait defaults to 2 min, adjustable 10 s–9 min', () => {
  expect(phoneBeat(5, {})).toEqual({ at: 5, waitMs: 120000 })
  expect(phoneBeat(5, { approveWaitMs: 60000 })).toEqual({ at: 5, waitMs: 60000 })
  expect(phoneBeat(5, { approveWaitMs: 9e9 })).toEqual({ at: 5, waitMs: 540000 })
  expect(phoneBeat(5, { approveWaitMs: 5 })).toEqual({ at: 5, waitMs: 120000 })
  expect(phoneBeat(5, { phoneApprove: false })).toEqual({ off: true, at: 5 })
})

test('log line: who, allow or deny, the tool, the first 80 characters, the reason', () => {
  expect(approveLog('像素工程師', { tool: 'Bash', desc: 'git   push\norigin main' }, 'allow')).toBe('📱 手機允許了 像素工程師 的 Bash：git push origin main')
  expect(approveLog('mg1', { tool: 'exec', desc: 'rm x' }, 'deny', '不要刪')).toBe('📱 手機拒絕了 mg1 的 exec：rm x（原因：不要刪）')
})

test('D-1: the table chat line names who, the tool and the answer, never the command', () => {
  expect(approveChatLine('像素工程師', 'Bash', 'allow')).toBe('📱 手機允許了 像素工程師 的 Bash')
  expect(approveChatLine('mg1', 'exec', 'deny')).toBe('📱 手機拒絕了 mg1 的 exec')
})

test('phone approval off: every card loses its buttons and says why; a Claude waiting on a tool without a slip still gets a card; on → unchanged', () => {
  const info = claudeApproval(slip(), 'tmux')
  expect(phoneOffWhy({ ok: false, why: 'remote.json 沒設 access（team、aud）' }, {})).toBe('remote.json 還沒設 access')
  expect(phoneOffWhy({ ok: false, why: '沒有 Access 的 JWT' }, {})).toBe('只有經 Cloudflare Access 登入的手機頁能按')
  expect(phoneOffWhy({ ok: true }, { phoneApprove: false })).toBe('remote.json 的 phoneApprove 是 false')
  expect(phoneOffWhy({ ok: true }, {})).toBeUndefined()
  const off = phoneOffCard({ approvalInfo: info }, 'remote.json 還沒設 access', 9)!
  expect(off.options).toEqual([])
  expect(off.why).toBe('手機核准還沒開，請到電腦按（remote.json 還沒設 access）')
  expect(off.desc).toBe(info.desc)
  const noSlip = phoneOffCard({ mode: 'waiting', tool: 'Bash', src: 'app' }, '只有經 Cloudflare Access 登入的手機頁能按', 9)!
  expect(noSlip).toMatchObject({ kind: 'claude', tool: 'Bash', options: [], where: 'app', why: '手機核准還沒開，請到電腦按（只有經 Cloudflare Access 登入的手機頁能按）' })
  expect(phoneOffCard({ mode: 'waiting' }, 'x', 9)).toBeUndefined() // 等你回覆（沒有 tool）：不是允許
  expect(phoneOffCard({ kind: 'codex', mode: 'waiting', tool: 'exec' }, 'x', 9)).toBeUndefined()
  expect(phoneOffCard({ approvalInfo: info }, undefined, 9)).toBe(info) // 手機核准開著：原樣
  // 0.63.56：手機核准開著、但外掛已經交回電腦（等候時間過了／當時手機沒在看）→ 不能按的「已交回電腦」卡
  const back = phoneOffCard({ mode: 'waiting', tool: 'Bash', src: 'tmux' }, undefined, 9)!
  expect(back).toMatchObject({ kind: 'claude', tool: 'Bash', options: [], where: 'tmux', why: HANDED_BACK, at: 9 })
  expect(back.deadline).toBeUndefined()
  expect(phoneOffCard({ mode: 'waiting' }, undefined, 9)).toBeUndefined()
  expect(phoneOffCard({ mode: 'typing', tool: 'Bash' }, undefined, 9)).toBeUndefined()
  expect(phoneOffCard({ kind: 'codex', mode: 'waiting', tool: 'exec' }, undefined, 9)).toBeUndefined() // Codex 的卡另外讀畫面
})

test('測試 #8：名冊 hookBlocked 的人，允許卡不給按鈕、寫安全設定；有 JWT（手機核准開著）也一樣', () => {
  const info = claudeApproval(slip(), 'tmux')
  const b = 'cc-plugin-sec-default'
  for (const why of [undefined, '只有經 Cloudflare Access 登入的手機頁能按']) { // undefined＝JWT 驗過、手機核准開著
    const noSlip = phoneOffCard({ mode: 'waiting', tool: 'Bash', src: 'tmux', hookBlocked: b }, why, 9)!
    expect(noSlip).toMatchObject({ kind: 'claude', tool: 'Bash', options: [], where: 'tmux', why: HOOK_BLOCKED_TEXT(b) })
    expect(noSlip.why).toContain('安全設定')
    const slipped = phoneOffCard({ approvalInfo: info, hookBlocked: b }, why, 9)!
    expect(slipped.options).toEqual([]) // 有單也不給按鈕（掛點被擋，按了沒用）
    expect(slipped.why).toBe(HOOK_BLOCKED_TEXT(b))
  }
})
