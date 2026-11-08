# Codex CLI 接進像素辦公室

2026-11-08 jacky 要求、office設計 實作，方案經 willy-codex（在 Codex 裡跑的 session）實測建議後定案。實作在 `codex/`（本身就是一個 Codex 外掛，只有 hooks）。

## 結論

| 項目 | 狀態 |
|---|---|
| 辦公室看得到 Codex | ✅ 2026-11-09 實機：hook 寫 `sessions/codex-<id>.json`（`kind: "codex"`，X 標記）；看守程式在 Codex 停著等鍵盤時續心跳，完成 5 秒後變回閒置；exec 結束、關窗都標離開 |
| 最後一則回覆 | ✅ 實機：Stop 事件的 `last_assistant_message` 寫 `replies/codex-<id>.json`（手機版 lastReply 同格式） |
| Claude → Codex | ✅ 實機：`codex_office.py send` 跑 `codex queue --thread <id> --message …`，**開著的 Codex 閒置時自己撿起來回**（不用 `--resume`；帶了反而警告 `already has an active writer`）。直接呼叫該 Codex 行程的 `codex.exe`，不經 npm 的 `codex.cmd`（`& % ^ "` 原樣送到）。queue 不能用才退回收件夾，下次使用者送出訊息時由 UserPromptSubmit 塞進去（也實測過） |
| Codex → Claude | ✅ 2026-11-09 實機：外掛的 MCP 工具 `office_roster`／`office_profile`／`office_send`（`.mcp.json`）。寄給 Claude 寫 `commands/<id>.json`（agy 同一套），附回信指令（用 Codex 的 session id）。Codex 不會照另一個 AI 的話做，要使用者在 Codex 說一聲（合理，不繞過） |

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
- 升版一定要重新信任（2026-11-09 實測 0.57.0→0.58.0，`hooks.json` 沒改也要；雜湊含展開後帶版號的路徑或版號本身）。不用進 `/hooks` 逐個點：升版後開 Codex 會跳「N hooks are new or changed」，選 **2. Trust all and continue** 一鍵就好。jacky：這樣就夠，不另外做「升版免信任」（試過固定指令字串，沒做完就停）。
- 本機市集的外掛：版號沒變時 `codex plugin add` 不會更新 cache；`codex plugin marketplace upgrade` 只管 Git 市集。
- 名牌：工作資料夾全是中文時預設 `codex`，跟名牌叫 codex 的 Claude session 撞名就變 `codex01a1`。

## MCP 與在線判斷（2026-11-09 實機）

- 🔴 `.mcp.json` 裡的 `${PLUGIN_ROOT}` **不會展開**（hook 的會）：`codex mcp list` 看得到參數原封不動，伺服器起不來，Codex 說沒有這些工具。改成 `python -c` 去 `~/.codex/plugins/cache/pixel-office-codex/pixel-office/*/` 找最新那份來跑。
- 🔴 MCP 的 stdin 要用 UTF-8 讀：Windows 預設 cp950，中文參數變亂碼或解碼失敗讓整支結束，Codex 只看到「工具連線中斷」。
- 呼叫者：tools/call 的 `_meta` 帶 `sessionId`／`threadId`（還有 `x-codex-turn-metadata.session_id`），直接用，不猜。
- 在線判斷：終端機的 `codex`（沒加 `--no-daemon`）和桌面 App 都經過背景常駐程式（app-server），很多對話共用一個行程、而且它不會結束，看行程活著會留下關掉的對話。改看 `~/.codex/thread-writer-locks/<session_id>.lock`：開著的對話鎖住，關掉的放掉或刪掉（實機比對 4 個都對）。經常駐程式的對話關掉後，常駐程式約過 1 分鐘才放鎖，這段時間名牌還在（2026-11-09 實測：關窗後不到 1 分鐘鎖放掉、標離開，沒有 SessionEnd）。看不到鎖（非 Windows）才退回看行程、共用的 30 分鐘沒事件當離開。
- 本機市集的外掛：`codex plugin add` 對已安裝的不會更新（就算版號較新），要先 `codex plugin remove` 再 `add`。
- 名牌撞名的後綴取 session id **尾** 4 碼：id 照時間排，前幾碼都一樣。
