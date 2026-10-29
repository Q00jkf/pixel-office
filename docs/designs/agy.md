# Antigravity CLI（agy）接進像素辦公室

2026-10-29 jacky 與 office設計 討論＋實測。實作在 `agy/agy_office.py`，用法見 `README.md`「Antigravity CLI」。

## 結論

| 項目 | 狀態 |
|---|---|
| 辦公室看得到 agy | ✅ 0.27.0：hook 寫狀態檔，presence lock 續心跳 |
| agy → Claude | ✅ 0.28.0：`agy_office.py send`，寫 `commands/<session>.json`（手機下命令同一套），即時 |
| Claude → agy | ✅ 0.28.0（延遲）：寫收件夾，agy **下次動作**時由 `PreInvocation`／`Stop` hook 塞進對話 |
| 叫醒閒置的 agy 視窗 | ❌ 做不到（見「為什麼」） |

## 實測（2026-10-29，agy 用 gemini-3.8-flash-high）

- hook 設定在 `~/.gemini/config/hooks.json`（`~/.gemini/antigravity-cli/settings.json` 裡的 hooks CLI 不讀）。`command` 要絕對路徑；Windows 用 `.cmd` 帶參數可行。
- 收到的事件：`SessionStart`、`PreInvocation`、`PostInvocation`、`Stop`（`PostToolUse` 那次工具被擋沒跑到）。每個都帶 `conversationId`、`workspacePaths`、`modelName`、`transcriptPath`、`lastUserInput`（使用者打的字，**不存**）。`Stop` 多 `fullyIdle`、`terminationReason`、`error`。
- hook 掛著時 agy 照常工作（同時段的 momo 瀏覽任務正常完成）。
- `~/.gemini/antigravity-cli/presence/<conversationId>.lock`：agy 開著時被鎖、關掉就放（2 個 agy 行程 ↔ 2 個被鎖的 lock；結束的對話 lock 檔留著但沒鎖）。用來續心跳。
- 安裝 hook 被 Claude Code auto 模式擋（Unauthorized Persistence），由 jacky 自己 `! python … install`。

## 為什麼閒置的 agy 叫不醒（agy 自己查的，轉述／未親驗）

- 互動視窗等鍵盤時所有 hook 都已結束；agy 沒有本機 IPC／API 能把文字塞進開著的視窗。
- `--remote-control`／`agy remote-control` 走 Google 雲端中繼連網頁或手機，不是本機 API。
- `--conversation <id>` 只會另起一個行程，兩個行程搶同一份紀錄。
- `injectSteps`：`userMessage`（永久留在對話）、`systemMessage`（巢狀物件）、`ephemeralMessage`（只這一輪）。`Stop` 回 `{"decision":"continue","reason":…}` 會把 reason 當系統訊息繼續下一輪。

## Stop hook 長輪詢：不採用

構想：一輪結束時 Stop hook 先等收件夾最多 N 分鐘，有信就 `continue`、等滿就 `stop`，等的時候不呼叫模型。
agy 回覆（2026-10-29，經 `agy_office.py send` 來回，轉述／未親驗）：`timeout` 文件沒寫上限、超時被 kill 後當 stop；**hook 會擋住 agent 迴圈，等待中沒有輸入框、一直轉圈，使用者會以為當機**。
→ 跟「使用者看得到過程、隨時可打字」衝突，**不每輪都等**。
折衷（jacky 2026-10-29「至少把時間稍微拉長」，0.29.0）：只有 agy 這一輪跑過 `send`（PostToolUse 看 CommandLine）才在 Stop 等最多 90 秒回信；續跑最多 5 輪防兩個 AI 無限互回。凍結只發生在「正在跟 Claude 對話」的那幾十秒。外部模擬按 Enter 叫醒也不做（會撞上使用者正在打的字，且空的一輪也花 token）。要即時就走 B。

## A／B 兩條路（選 A）

| | A 互動視窗＋收件夾（採用） | B 橋接程式常駐 agy |
|---|---|---|
| 做法 | 照常開 agy 視窗；hook 收信 | 橋接程式用 `--input-format stream-json --output-format stream-json` 把 agy 當子行程，訊息寫 stdin |
| Claude → agy | 等 agy 下次動作 | 即時 |
| 使用者直接跟 agy 對話 | 照常 | 要另做輸入框 |
| 適合 | 使用者跟 agy 互動、Claude 偶爾交代一句 | 把 agy 當小隊成員派工 |

選 A 的理由：使用者要看得到過程、能打斷；零件大多已有。B 等於背景派工，Gemini 週額度當時只剩約 27%，背景跑更快見底。真的要 agy 當小隊成員再做 B。

## A 的設計

```
Claude ──python agy_office.py send <agy 名牌> "…"──▶ agy/inbox/<對話>.jsonl
                                                     │ agy 下次 PreInvocation：injectSteps userMessage
                                                     │ 或一輪結束 Stop：decision=continue＋reason
                                                     ▼
                                                    agy 對話裡出現「📨 來自 <寄件者>…」
agy ──python agy_office.py send <Claude 名稱> "…"──▶ commands/<session>.json ──外掛每秒拿──▶ Claude 對話「📨 <寄件者>（Antigravity，不是使用者）：…」
```

- 收件者解析：辦公室狀態檔的 `agent`（ListAgents 名稱）、名牌 `name`、`id` 都認；agy 認名牌或對話 id。
- 🔴 送進 Claude 的訊息走 `asUser`（跟手機命令同一條），所以內文 MUST 標明「來自 Antigravity，不是使用者本人」——不然 agy 的話會被當成使用者的指令。
- `commands/<session>.json` 一個 session 一格：一秒內連送兩則，後一則會蓋掉前一則（手機命令本來就這樣）。
- 送到 agy 的訊息附回信指令，agy 照著跑 `send` 回覆；agy 跑 shell 會照它自己的權限詢問。
