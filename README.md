# pixel-office（像素辦公室）

把同時開著的每個 Claude Code session 畫成辦公室裡的一位同事，加上多 session 協作的做法。
**Claude 和 Google Antigravity 也能坐進同一間辦公室、互相寄信分工。**

<img src="docs/office.png" alt="像素辦公室截圖" width="420">

- **看得到大家在做什麼**：打字、讀檔、思考、出錯、等你核准，一眼看出
- **多 session 協作**：一個 skill `team`，負責分主管和員工、派工、開會
- **跨家 AI 協作**：Antigravity CLI（agy）的對話也會出現在辦公室，名牌帶藍紫色 **G** 徽章，跟 Claude 互相寄信
- **手機也能看**：本機開一個小伺服器，手機瀏覽器打開

## ✨ Claude × Antigravity 一起工作

兩家的 AI 各開在自己的視窗，在同一間辦公室裡互相交辦：

```
Claude（主管）── 寄信：「查一下這三顆料的規格」──▶ agy（research）
Claude（主管）◀── 回信：整理好的規格表 ─────────── agy
```

- **各用所長、額度分開算**：Claude 的額度快用完時，查資料、整理之類的雜事交給 agy 的 Gemini
- **agy 寄完信會自己等回信**（最多 90 秒），收到就接著做，不用你在兩個視窗之間轉貼
- **agy 有自己的辦公室工具**：取名牌、看誰在線、寄信，跟 Claude 用的是同一套
- **兩邊都用一般互動視窗**，不用 `-p`，你隨時看得到、插得進話
- 防呆：信上標明「來自另一個 AI，不是使用者本人」；兩個 AI 自動來回最多 5 輪就停

設定一次就好：[docs/agy-寄件協作.md](docs/agy-寄件協作.md)

> 2026-10-29 起從 [llm-wiki-plugin](https://github.com/Q00jkf/llm-wiki-plugin) 搬出來獨立（歷史一起帶過來）。
> ⚠️ 用的是 Claude Code 的 function hooks（early access，版本間可能變動）。

## 安裝

```
/plugin marketplace add Q00jkf/pixel-office
/plugin install pixel-office@pixel-office
```

重開 Claude Code，輸入 `/office`。

原本裝的是 `pixel-office@llm-wiki`：先 `/plugin uninstall pixel-office@llm-wiki` 再照上面裝。名牌、按鈕設定都保留。

## 常用

| 指令 | 作用 |
|---|---|
| `/office` | 開辦公室面板 |
| `/office who` | 誰在線、在做什麼 |
| `/office name <英數字>` | 改桌上名牌 |
| `/office title <職稱>` | 改職稱 |
| `/office role 主管`／`員工` | 換角色（主管坐主管室） |

點家具會跳出選單（查信、git、開工收工…），點寵物可以餵牠。

## 協作（skill `team`）

不用記指令，直接跟 Claude 說：

- 「你來當主管」：這個 session 升成主管，開始派工
- 「照 <規則> 設角色」：照你的流程（AIMM、gstack…）列出角色，你核可才建
- 「開會」：讓幾個 session 討論出一個方案

## 更多

- 全部指令、個人按鈕、點人核准、手機版、畫面細節：[docs/使用說明.md](docs/使用說明.md)
- Antigravity CLI：[docs/agy-寄件協作.md](docs/agy-寄件協作.md)
- 改程式：[CLAUDE.md](CLAUDE.md)
