# pixel-office（像素辦公室）

> **English** — A Claude Code plugin that turns every running Claude Code session into a pixel-art coworker in a shared office: see who is typing, thinking, stuck, or waiting for your approval at a glance.
> - **Claude × Google Antigravity in one office** — Antigravity CLI conversations join the same office (blue-violet **G** badge) and exchange messages with Claude sessions; agy waits for the reply and continues on its own.
> - **Multi-session teamwork** — one skill (`team`): managers, two-layer org (department leads with their own squads), role cards, meetings.
> - **Remote from your phone** — a local server + Cloudflare Tunnel/Access lets you watch the office and send a command to any session.
>
> Install: `/plugin marketplace add Q00jkf/pixel-office` → `/plugin install pixel-office@pixel-office` → restart → `/office`. Docs below are in Traditional Chinese.

把同時開著的每個 Claude Code session 畫成辦公室裡的一位同事，加上多 session 協作的做法。
**Claude 和 Google Antigravity 也能坐進同一間辦公室、互相寄信分工。**

<img src="docs/office.png" alt="像素辦公室（Desktop）：主管室兩位主管、三個團隊區、部門主管 dev 帶自己的小隊、agy 名牌帶 G 徽章" width="720">

<sub>Claude Desktop 畫面。★ 是主管：★willy、★jacky 是頂層主管，坐主管室；★dev 是**第 2 層的部門主管**，不進主管室，坐在自己的「TEAM dev」區第一個位子帶小隊。research、wengpun 是 Antigravity（G）。</sub>

- **看得到大家在做什麼**：打字、讀檔、思考、出錯、等你核准，一眼看出
- **多 session 協作**：一個 skill `team`，負責分主管和員工、派工、開會
- **跨家 AI 協作**：Antigravity CLI（agy）的對話也會出現在辦公室，名牌帶藍紫色 **G** 徽章，跟 Claude 互相寄信
- **人在外面也能管**：接上 Cloudflare，手機隨時看辦公室、對任一個 session 下指令

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

## 📱 人在外面也能管（Cloudflare 遠端）

本機跑一個小伺服器畫同一間辦公室，用 Cloudflare Tunnel 接到外面，手機瀏覽器打開（可以加到主畫面）：

- **看**：誰在做什麼、誰卡住、誰在等你
- **點人**：看職稱、狀態、最近的錯誤，還有它最後回了什麼
- **下指令**：在卡片打字送出，那個 session 會當成你打的字照做（前面標 📱）
- **只有你進得來**：前面掛 Cloudflare Access，只放行你登入的帳號；伺服器本身只聽本機
- 不用開著任何 session 的面板，電腦開著就好。權限核准還是要回電腦按

設定方式：[docs/使用說明.md](docs/使用說明.md) 的「手機版」

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

一個人開很多 session 時怎麼分工。只有一個 skill，不用記指令，直接跟 Claude 說就好。

### 兩層架構

| 層 | 什麼時候用 | 辦公室裡 |
|---|---|---|
| 0 | 一個 session 自己做完 | 員工座位 |
| 1 | 一位主管帶幾個員工 | 主管坐主管室，員工坐「TEAM <主管>」區 |
| 2 | 專案大到要分部門 | **部門主管**（上圖的 ★dev）坐自己部門那一區的第一個位子，帶自己的小隊；上一層主管照常坐主管室 |

- 升層：說「你來當主管」，或員工自己提議，**你說好才升**
- 降層：主管底下沒人在線滿 20 分鐘會提醒，問你要不要降，不會自動降

### 多位主管

同時跑好幾個專案，每個專案各有一位主管：主管室最多擺 3 張桌，每位主管的員工各坐一區、地毯顏色不同，一眼分得出誰是哪一隊。

### 角色設計

- **不內建任何方法**：說「照 <規則> 設角色」（AIMM、gstack、你自己的流程），它列出角色和邊界，你核可才建
- **角色卡**放在專案的 `.claude/office/roles/`（進 git）：寫職責、邊界、交付；做到哪記在檢查點，換一個 session 也接得上
- **小隊**：常用的一組角色（例如「研發＋測試」、「PM＋採購」）存在 `~/.claude/office/squads/`，整台電腦共用；開第二層時直接挑一組

### 開會

說「開會」，讓幾個 session 討論出一個方案；被點名的人會走進會議室坐下，散會再走回座位。

<img src="docs/meeting.png" alt="開會：dev、impl、test、pm 與 agy 的 research 坐進會議室，TEAM dev 的座位空出來" width="720">

<sub>被點名的 5 位（含部門主管 ★dev 和 Antigravity 的 research）坐進會議室，TEAM dev 的座位空著；沒被點名的照常在座位上工作。</sub>

## 更多

- 全部指令、個人按鈕、點人核准、手機版、畫面細節：[docs/使用說明.md](docs/使用說明.md)
- Antigravity CLI：[docs/agy-寄件協作.md](docs/agy-寄件協作.md)
- 改程式：[CLAUDE.md](CLAUDE.md)
