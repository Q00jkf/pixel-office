# Claude Code ↔ Antigravity CLI 寄件協作

讓 Claude Code 的 session 和 Antigravity CLI（agy）的對話互相寄信：Claude 可以交代 agy 一件事，agy 做完回報；agy 也可以問 Claude。兩邊都出現在像素辦公室，看得到誰在做什麼。

> 2026-10-29 在 Windows 11 實測（pixel-office 0.29.0、agy 用 gemini-3.8-flash-high）。macOS／Linux 沒測過。

## 先講清楚：兩邊都用一般互動視窗

- Claude Code：照常開 `claude`。
- agy：照常在終端機打 `agy` 開互動視窗。**不要用 `agy -p`**——`-p` 每次都是全新對話（光開場就約 7k token）、不記得前面在做什麼，而且沒人能按權限詢問，agy 要回信時會被自動拒絕。
- 這套是「信箱」模式：信放著，等對方下次動起來時拿。你一直看得到兩邊的視窗、隨時可以插話。

## 需要什麼

| 項目 | 說明 |
|---|---|
| Claude Code | 裝 pixel-office 外掛 0.29.0 以上 |
| Antigravity CLI | 能在終端機打 `agy` |
| Python 3 | 終端機打 `python` 叫得到 |

## 安裝（一次）

**1. Claude Code 裝外掛**（在 Claude Code 裡打）：

```
/plugin marketplace add Q00jkf/llm-wiki-plugin
/plugin install pixel-office@llm-wiki
```

重開 Claude Code，打 `/office` 看得到辦公室就成功。

**2. 接上 agy**（在 PowerShell 跑；`<版本>` 換成你裝的版本，例如 `0.29.0`）：

```powershell
python "$HOME\.claude\plugins\cache\llm-wiki\pixel-office\<版本>\agy\agy_office.py" install
```

它會：
- 把腳本複製到 `~/.claude/pixel-office/agy/`（以後都用這份，外掛升版不影響路徑）
- 在 `~/.gemini/config/hooks.json` 加一組名為 `pixel-office` 的 hook（你原本的設定不動）

> 🔁 外掛升版後重跑一次 `install`，才會換成新腳本。
> 為什麼要自己跑：這一步改的是 agy 的設定，Claude Code 的 auto 模式會擋下「在外掛外面留常駐設定」的動作，所以由你本人跑。

**3. 確認**：開一個 agy 視窗問它任何一句話，再到 Claude Code 打 `/office who`——名單上會多一個人，名牌是 agy 工作資料夾名的英數字部分（例如在 `C:\Users\amy` 開的就是 `amy`），標著「Antigravity」。

## 怎麼用

所有寄信都是同一個指令（Claude 和 agy 都會用，信裡會附給對方；以下是 PowerShell 寫法）：

```powershell
python "$HOME\.claude\pixel-office\agy\agy_office.py" send <收件者> "<訊息>" --from <自己的名稱>
```

收件者可以寫：Claude session 的 ListAgents 名稱、辦公室名牌、或 agy 的名牌。

### Claude 交代 agy

在 Claude Code 說：「寄信給 agy 的 `<名牌>`，請它 …」。Claude 會照辦公室名單上寫的指令寄出。

然後**到 agy 視窗打任何一句話**（例如「看信」）——agy 閒著時叫不醒，它下次動起來才會收到。信上標明「來自另一個 AI session，不是使用者本人」，附回信指令。

### agy 問 Claude（會自己等回覆）

在 agy 說：「寄信問 `<Claude 的名稱>` …，等它回覆」。

1. agy 跑寄信指令 → **agy 會跳權限詢問，按允許**
2. Claude 那邊幾秒內收到（顯示「📨 <名牌>（Antigravity，不是使用者本人）：…」），處理後回信
3. agy 這一輪結束時會**轉圈最多 90 秒等回信**，等到就自己接著處理，不用你再打字

等待中 agy 不能打字；不想等就按 Esc。沒等到也沒關係，信留在信箱，你下次在 agy 打字時一起收到。

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

只拿掉 hooks.json 裡的 `pixel-office` 那組；`~/.claude/pixel-office/agy/` 留著，要刪自己刪。

## 出問題時

| 症狀 | 看哪裡 |
|---|---|
| 辦公室看不到 agy | agy 有沒有問過至少一句話（剛開、還沒問的看不到）；`~/.gemini/config/hooks.json` 裡有沒有 `pixel-office` |
| 寄信說「找不到唯一的收件者」 | 同一個資料夾開了兩個 agy、名牌一樣 → 改用完整 id（`agy-<對話 id>`，在 `~/.claude/pixel-office/sessions/` 的檔名） |
| agy 回信被拒 | 你用了 `agy -p`（沒人能按允許）→ 改用互動視窗 |
| 外掛升版後 agy 收不到信 | 重跑 `install` |

設計與實測紀錄：`docs/designs/agy.md`。
