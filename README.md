# pixel-office（像素辦公室）

把同時開著的每個 Claude Code session 畫成辦公室裡的一位同事，加上多 session 協作的做法。

<img src="docs/office.png" alt="像素辦公室截圖" width="420">

- **看得到大家在做什麼**：打字、讀檔、思考、出錯、等你核准，一眼看出
- **多 session 協作**：一個 skill `team`，負責分主管和員工、派工、開會
- **手機也能看**：本機開一個小伺服器，手機瀏覽器打開
- **Antigravity CLI（agy）也能進辦公室**，可以跟 Claude 互相寄信

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
