# Claude Code ↔ Antigravity CLI 寄件協作

讓 Claude Code 的 session 和 Antigravity CLI（agy）的對話互相寄信：Claude 可以交代 agy 一件事，agy 做完回報；agy 也可以問 Claude。兩邊都出現在像素辦公室，看得到誰在做什麼。

> 2026-10-29 在 Windows 11 實測（pixel-office 0.30.0、agy 用 gemini-3.8-flash-high）。macOS／Linux 沒測過。

## 先講清楚：兩邊都用一般互動視窗

- Claude Code：照常開 `claude`。
- agy：照常在終端機打 `agy` 開互動視窗。**不要用 `agy -p`**——`-p` 每次都是全新對話（光開場就約 7k token）、不記得前面在做什麼，而且沒人能按權限詢問，agy 要寄信時會被自動拒絕。
- 這套是「信箱」模式：信放著，等對方下次動起來時拿。你一直看得到兩邊的視窗、隨時可以插話。

## 需要什麼

| 項目 | 說明 |
|---|---|
| Claude Code | 裝 pixel-office 外掛 0.30.0 以上 |
| Antigravity CLI | 能在終端機打 `agy`，而且登入過 |
| Python 3 | 終端機打 `python` 叫得到（agy 外掛直接呼叫 `python`） |

## 安裝（一次）

**1. Claude Code 裝外掛**（在 Claude Code 裡打）：

```
/plugin marketplace add Q00jkf/llm-wiki-plugin
/plugin install pixel-office@llm-wiki
```

重開 Claude Code，打 `/office` 看得到辦公室就成功。

**2. 給 agy 裝它那一半**（先**關掉所有 agy 視窗**，再在 PowerShell 跑；`<版本>` 換成你裝的版本，例如 `0.30.0`）：

```powershell
python "$HOME\.claude\plugins\cache\llm-wiki\pixel-office\<版本>\agy\agy_office.py" install
```

它會用 `agy plugin install` 裝一個叫 `pixel-office` 的 agy 外掛，裡面有：
- **三個工具**給 agy 用：`office_profile`（登記名牌、職稱）、`office_roster`（看誰在線）、`office_send`（寄信）
- **hook**：把 agy 的狀態畫進辦公室、收信、寄完信等回覆
- **skill**：教 agy 這套怎麼用

> 🔁 外掛升版後，關掉所有 agy 視窗、重跑一次 `install`（agy 安裝時是整份複製，開著的 agy 會佔住舊檔換不掉）。
> 為什麼要自己跑：這一步改的是 agy 的設定，Claude Code 的 auto 模式會擋下「在外掛外面留常駐設定」的動作，所以由你本人跑。

**3. 確認**：開一個 agy 視窗問它任何一句話，再到 Claude Code 打 `/office who`——名單上會多一個人，標著「Antigravity」。預設名牌是工作資料夾名的英數字部分（在 `C:\Users\amy` 開的就是 `amy`；同資料夾開第二個會自動接對話 id 前 4 碼）。

## 怎麼用

### 給 agy 取名字

在 agy 說：「在辦公室登記名字叫 research，職稱查規格」。它會用 `office_profile`，名單上就換成你取的名字。名牌只能 1～12 個英文字母或數字，不能跟別人重複。

### Claude 交代 agy

在 Claude Code 說：「寄信給 agy 的 `<名牌>`，請它 …」。Claude 會照辦公室名單上寫的指令寄出。

然後**到 agy 視窗打任何一句話**（例如「看信」）——agy 閒著時叫不醒，它下次動起來才會收到。信上標明「來自另一個 AI session，不是使用者本人」。

### agy 問 Claude（會自己等回覆）

在 agy 說：「寄信問 `<Claude 的名稱>` …，等它回覆」。

1. agy 用 `office_send` 寄出（第一次可能跳權限詢問，按允許）
2. Claude 那邊幾秒內收到（顯示「📨 <名牌>（Antigravity，不是使用者本人）：…」），處理後回信
3. agy 這一輪結束時會**轉圈最多 90 秒等回信**，等到就自己接著處理，不用你再打字

等待中 agy 不能打字；不想等就按 Esc。沒等到也沒關係，信留在信箱，你下次在 agy 打字時一起收到。

### Claude 那邊寄信用的指令

Claude 會自己照名單上的說明跑，你不用記。要手動寄（PowerShell）：

```powershell
python "$HOME\.claude\pixel-office\agy\agy_office.py" send <收件者> "<訊息>" --from <自己的名稱>
```

## 會發生什麼、不會發生什麼

| 情況 | 行為 |
|---|---|
| agy 閒著、Claude 寄信來 | 不會自動醒；你在 agy 打下一句話時才收到 |
| agy 寄信後等回覆 | 最多等 90 秒；這段時間 agy 轉圈、不能打字 |
| agy 一般使用（沒寄信） | 跟沒裝一樣，一輪結束立刻能打字 |
| 兩個 AI 一直互回 | 沒有你介入時最多自動續跑 5 輪就停（防燒 token） |
| agy 關掉 | 約 5 秒後從辦公室消失 |
| 隱私 | 不存你在 agy 打的字，只記狀態（思考中、打字、完成） |

## 省 token 的提醒

- 每封信會讓收件的那一方多跑一輪，那一輪照樣要送整段對話給模型。偶爾交代、問進度很划算；來回幾十次就會吃額度。
- agy 的額度分組計算（Gemini 一組、Claude/GPT 一組，各自每週上限）。Gemini 快用完時可以把 agy 換成另一組模型。

## 移除

```powershell
python "$HOME\.claude\pixel-office\agy\agy_office.py" uninstall
```

移除 agy 外掛 `pixel-office`；`~/.claude/pixel-office/agy/` 留著，要刪自己刪。

## 出問題時

| 症狀 | 看哪裡 |
|---|---|
| `install` 說外掛資料夾被佔用 | 還有 agy 視窗開著 → 全部關掉再跑 |
| 辦公室看不到 agy | agy 有沒有問過至少一句話（剛開、還沒問的看不到）；`agy plugin list` 有沒有 `pixel-office (enabled)` |
| agy 說沒有 office 工具 | 工具是「延遲載入」的，agy 要透過 `call_mcp_tool` 呼叫（server 名 `pixel-office_office`）；叫它看自己 system prompt 的 MCP 區段 |
| agy 寄信被拒 | 你用了 `agy -p`（沒人能按允許）→ 改用互動視窗 |
| 外掛升版後行為沒變 | 關掉所有 agy、重跑 `install` |

設計與實測紀錄：`docs/designs/agy.md`。
