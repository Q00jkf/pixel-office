# pixel-office（像素辦公室）

把同時開著的每個 Claude Code session 畫成辦公室裡的一位同事。llm-wiki marketplace 裡的**選裝** plugin，不裝不影響 llm-wiki。

> ⚠️ 使用 Claude Code 的 function hooks（early access，版本間可能變動）。2026-10-03 於 Claude Code 2.1.288 開發與測試。

## 安裝

```
/plugin marketplace add Q00jkf/llm-wiki-plugin
/plugin install pixel-office@llm-wiki
```

重開 Claude Code 後輸入 `/office` 開面板。

## 用法

| 指令／按鈕 | 作用 |
|---|---|
| `/office` | 開辦公室面板 |
| `/office role 主管` ／ `/office role 員工` | 設定這個 session 的角色；角色變了人會走進／走出主管室 |
| `/office name <英數字>` | 桌上名牌（1～12 字，中文在像素畫寬兩格放不下） |
| `/office title <職稱>` | 職稱（最多 16 字，可中文；不畫在圖上，名單裡看得到） |
| `/office who` | 列出在線每人的名牌、職稱、角色、ListAgents 名稱、目前狀態 |
| `/office agent <名稱>` | 登記 ListAgents 名稱，別人傳訊息給你時才畫得出紙飛機 |
| `/office buttons` | 重讀個人按鈕設定（`~/.claude/pixel-office/buttons.json`，見下方「個人按鈕」） |
| `/office team <主管名稱>｜off` | 登記你是哪位主管的 peer（填主管的 ListAgents 名稱）；peer 坐最右邊那一區，其他人坐左邊 |
| `/office auto on｜off` | 宣告這個 session 是 auto 權限模式；auto 的權限詢問交給分類器，不舉手 |
| 面板按鈕「升為主管／設為員工」(`r`)、「餵貓」(`c`)、「夜間模式」(`n`) | 互動；快捷鍵要先點面板或 ctrl+x tab 讓面板取得焦點 |

模型也能自己設定：工具 `mcp__pixel-office__office_profile`，系統提示會提醒它「被指派或卸下主管時呼叫」。

## 個人按鈕（不進 repo）

在自己電腦建 `~/.claude/pixel-office/buttons.json`，按鈕會出現在辦公室與下方按鈕列之間那一列（最多 6 顆）。
最快的做法是複製 plugin 附的範例檔再改：

```
cp "<plugin 目錄>/plugins/pixel-office/buttons.example.json" ~/.claude/pixel-office/buttons.json
```

內容長這樣：

```json
[
  { "label": "開工", "prompt": "/llm-wiki:wiki-start" },
  { "label": "收工", "prompt": "/llm-wiki:wiki-end" },
  { "label": "文件", "url": "https://example.com" }
]
```

- `prompt`：送給**按下按鈕的那個視窗**，等同你親自輸入；`/` 開頭當 slash 指令執行。照常受權限管控。
- `url`：用瀏覽器開，只收 `http`／`https`。
- `label` 1～12 字。改完檔案輸入 `/office buttons` 重讀。沒有這個檔就不顯示。

## 畫面

俯視平面圖：上排會議室＋主管室，下方員工區（四人一組、十字隔板），底部走廊有貓與影印機。

- 每個 session 的狀態即時反映在小人與螢幕：打字、讀檔、思考、出錯、完成
- 第一位主管坐主管室；登記為他 peer 的人（`/office team`）坐最右邊那一區，其他人坐左邊；換區時會起身走過去。peer 區鋪金邊地毯、上方掛「TEAM <主管名牌>」（有主管在線且排得出兩欄才顯示）
- 每人有固定座位，別人進出不會讓他換位
- 坐不下時左上角顯示 `+N`
- 只有終端版畫像素；Desktop 顯示文字版

面板最少要 42 列高（場景 40 列＋預留 1 列＋按鈕 1 列）（上排房間＋一排座位群＋走廊），寬 56 欄以上員工區排兩欄。

## 運作方式

每個 session 每 5 秒把自己的狀態寫到 `~/.claude/pixel-office/sessions/<session-id>.json`（一個 session 一個檔，不互相覆蓋），每秒讀一次所有人的。超過 20 秒沒心跳或標記離開的不畫。只讀寫這個資料夾，不碰其他檔案、不連網。

## 開發

```
claude plugin validate plugins/pixel-office
claude plugin test plugins/pixel-office
```
