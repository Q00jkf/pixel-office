# Codex CLI 接進像素辦公室

2026-11-08 jacky 要求、office設計 實作，方案經 willy-codex（在 Codex 裡跑的 session）實測建議後定案。實作在 `codex/`（本身就是一個 Codex 外掛，只有 hooks）。

## 結論

| 項目 | 狀態 |
|---|---|
| 辦公室看得到 Codex | 🟡 寫好、模擬過，**等實機**：hook 寫 `sessions/codex-<id>.json`（`kind: "codex"`，X 標記），看守程式續心跳 |
| 最後一則回覆 | 🟡 等實機：Stop 事件的 `last_assistant_message` 寫 `replies/codex-<id>.json`（手機版 lastReply 同格式） |
| Claude → Codex | 🟡 等實機：`codex_office.py send` 寫收件夾，Codex 使用者**下次送出訊息**時由 UserPromptSubmit 塞進那一輪；之後實測 `codex queue --thread <id> --message … --resume` 能不能更即時 |
| Codex → Claude | ⏸ 延後（之後做 MCP 工具，像 agy 的 `office_send`） |
| 叫醒閒置的 Codex | ❌ 跟 agy 一樣，等鍵盤時沒有 hook 在跑 |

## Codex 0.167 的事實（willy-codex 實測／官方說明，未全部親驗）

- hooks 正式版。放 `~/.codex/hooks.json` 或外掛的 `hooks/hooks.json`；外掛裡用 `${PLUGIN_ROOT}` 指外掛資料夾。
- 事件：SessionStart（`source`：startup／resume／clear／compact／fork）、UserPromptSubmit（`prompt`、`turn_id`）、PostToolUse（`tool_name`、`tool_input`、`tool_response`）、Stop（`last_assistant_message`、`stop_hook_active`）、SessionEnd。共通欄位 `session_id`、`cwd`、`transcript_path`、`model`。
- SessionStart／UserPromptSubmit 的純文字 stdout 會當成上下文；Stop 在 exit 0 時 stdout 必須是 JSON。
- 🔴 hook 要在 Codex 裡用 `/hooks` 信任，沒信任的**不跑也不報錯**。
- 外掛會複製到 `~/.codex/plugins/cache/`：改了 `codex/` 要重裝才生效。所以看守程式和 Claude 端寄信都跑 `~/.claude/pixel-office/codex/codex_office.py` 那份（hook 每次跑都同步過去）。
- 🔴 elevated sandbox 裡 AI 跑的指令讀不到 `~/.codex`；hook 本身在 sandbox 外跑，不受影響。
- 安裝與信任都會改使用者的 Codex 設定，由使用者自己做：
  ```
  codex plugin marketplace add "<pixel-office>/codex"
  codex plugin add pixel-office@pixel-office-codex
  ```
  然後開 Codex、`/hooks` 信任。`python codex_office.py install` 會印出這兩行。

## 設計

- 名牌：工作資料夾名的英數字（最多 12 字），跟在線的人撞名就接 session id 前 4 碼。
- 心跳：hook 找出祖先裡叫 `codex` 的程式記 pid，看守程式每 5 秒看它還在不在。找不到 pid 時，hook 停 20 秒就當離開。
- `/clear`、`/new`、fork 會換 session id、程式不變：SessionStart 把同 pid 的舊 session 標離開。
- 不存使用者打的字；`codex/payloads/<事件>.json` 只記各事件最近一次有哪些欄位（內容換成 `…`），實測用。
- hook 一律 exit 0、吞例外，不擋 Codex。

## 待實機確認

1. `${PLUGIN_ROOT}` 變數名、SessionEnd 的 matcher（目前寫 `other`）對不對——錯了 hook 不會跑。
2. 祖先程式找不找得到 `codex`（Windows 上可能叫 `codex.exe` 或經過 node）。
3. `codex queue` 能不能把訊息送進開著的視窗。
