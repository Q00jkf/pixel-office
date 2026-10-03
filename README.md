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
| 面板按鈕「升為主管／設為員工」(`r`)、「餵貓」(`c`)、「夜間模式」(`n`) | 互動；快捷鍵要先點面板或 ctrl+x tab 讓面板取得焦點 |

模型也能自己設定：工具 `mcp__pixel-office__office_profile`，系統提示會提醒它「被指派或卸下主管時呼叫」。

## 畫面

俯視平面圖：上排會議室＋主管室，下方員工區（四人一組、十字隔板），底部走廊有貓與影印機。

- 每個 session 的狀態即時反映在小人與螢幕：打字、讀檔、思考、出錯、完成
- 第一位主管坐主管室；其餘的人依編號有固定座位，別人進出不會讓他換位
- 坐不下時左上角顯示 `+N`
- 只有終端版畫像素；Desktop 顯示文字版

面板最少要 32 列高（上排房間＋一排座位群＋走廊），寬 56 欄以上員工區排兩欄。

## 運作方式

每個 session 每 5 秒把自己的狀態寫到 `~/.claude/pixel-office/sessions/<session-id>.json`（一個 session 一個檔，不互相覆蓋），每秒讀一次所有人的。超過 20 秒沒心跳或標記離開的不畫。只讀寫這個資料夾，不碰其他檔案、不連網。

## 開發

```
claude plugin validate plugins/pixel-office
claude plugin test plugins/pixel-office
```
