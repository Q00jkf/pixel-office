# Codex CLI 接進像素辦公室

2026-11-08 jacky 要求、office設計 實作，方案經 willy-codex（在 Codex 裡跑的 session）實測建議後定案。實作在 `codex/`（本身就是一個 Codex 外掛，只有 hooks）。

## 結論

| 項目 | 狀態 |
|---|---|
| 辦公室看得到 Codex | ✅ 2026-11-09 實機：hook 寫 `sessions/codex-<id>.json`（`kind: "codex"`，X 標記）；看守程式在 Codex 停著等鍵盤時續心跳，完成 5 秒後變回閒置；exec 結束、關窗都標離開 |
| 最後一則回覆 | ✅ 實機：Stop 事件的 `last_assistant_message` 寫 `replies/codex-<id>.json`（手機版 lastReply 同格式） |
| Claude → Codex | ✅ 實機：`codex_office.py send` 跑 `codex queue --thread <id> --message …`，**開著的 Codex 閒置時自己撿起來回**（不用 `--resume`；帶了反而警告 `already has an active writer`）。直接呼叫該 Codex 行程的 `codex.exe`，不經 npm 的 `codex.cmd`（`& % ^ "` 原樣送到）。queue 不能用才退回收件夾，下次使用者送出訊息時由 UserPromptSubmit 塞進去（也實測過） |
| Codex → Claude | ⏸ 延後（之後做 MCP 工具，像 agy 的 `office_send`） |

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

## 實機紀錄（2026-11-08～09，Codex CLI 0.167.0，Windows）

- `${PLUGIN_ROOT}` 對；SessionEnd 的 `reason` 是 `other`；祖先找得到 `codex.exe`（互動視窗是 `codex.exe --no-daemon`）。
- 🔴 信任：`/hooks` 畫面寫「N hooks need review before they can run」，要逐個事件點進去、看 Source 是 `pixel-office@pixel-office-codex` 再信任（5 個：PostToolUse、SessionStart、SessionEnd、UserPromptSubmit、Stop）。只安裝不信任：hook 不跑也不報錯，`codex exec` 也不警告。帶 `--dangerously-bypass-hook-trust` 的執行會跑（payload 的 `permission_mode` 是 `bypassPermissions`），別拿它當「已信任」的證據。
- 信任存在 `~/.codex/config.toml` 的 `[hooks.state."<外掛>@<市集>:hooks/hooks.json:<事件>:0:0"]`，內容是 `trusted_hash = "sha256:…"`（信任前那裡什麼都沒有）。綁的是 hook 定義的雜湊：外掛重裝、`hooks.json` 或指令改了就要重新 review。
- 名牌：工作資料夾全是中文時預設 `codex`，跟名牌叫 codex 的 Claude session 撞名就變 `codex01a1`。
