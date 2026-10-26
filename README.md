# pixel-office（像素辦公室）

把同時開著的每個 Claude Code session 畫成辦公室裡的一位同事。

<img src="docs/office.png" alt="像素辦公室截圖" width="420">

llm-wiki marketplace 裡的**選裝** plugin，不裝不影響 llm-wiki。

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
| `/office who` | 列出在線每人的名牌、職稱、角色、ListAgents 名稱、目前狀態（見下方「名單」） |
| `/office agent <名稱>` | 登記 ListAgents 名稱，別人傳訊息給你時才畫得出紙飛機 |
| `/office buttons` | 重讀個人按鈕設定（`~/.claude/pixel-office/buttons.json`，見下方「個人按鈕」） |
| `/office team <主管名稱>｜off` | 登記你是哪位主管的 peer（填主管的 ListAgents 名稱）；peer 坐最右邊那一區，其他人坐左邊 |
| `/office auto on｜off` | 宣告這個 session 是 auto 權限模式；auto 的權限詢問交給分類器，不舉手 |
| `/office approve on｜off` | 這個視窗開著面板時，要不要替別的 session 按權限核准（見下方「點人核准」）；**預設關**，重開後記得 |
| `/office bite [名牌]` | 放貓咬人（小寶寶是爬過去抱大腿、山雀是飛過去唱歌）；不指定就隨機挑一位員工，主管在主管室不會被咬 |
| `/office pet [cat｜baby｜bird]` | 辦公室裡的貓、小寶寶、銀喉長尾山雀切換（不帶參數就依序換）；只影響自己看到的畫面，重開後仍記得 |
| `/office meeting [off]` | 看目前的會議（題目、參與者）；`off` 提早散會 |
| 面板按鈕「升為主管／設為員工」(`r`)、「餵貓／餵奶／餵小米」(`c`)、「放貓／放寶寶／放山雀」(`b`)、「換寶寶／換山雀／換貓」(`p`)、「夜間模式」(`n`) | 互動；快捷鍵要先點面板或 ctrl+x tab 讓面板取得焦點 |

模型也能自己設定：工具 `mcp__pixel-office__office_profile`，系統提示會提醒它「被指派或卸下主管時呼叫」。

## 名單（`/office who`、工具 `office_roster`）

- **目前**：「🟡 等核准 N 秒（工具）」與「等輸入（N 分）」分開；出錯時附錯誤第一行（最多 80 字），之後 10 分鐘內在狀態後面標「上次出錯 N 分前」
- **職稱**：沒設時，收到使用者指令就用 session 標題（有的話）或指令前 16 字自動帶，標「(自動)」；自動帶的放超過 30 分鐘再來新指令才換。模型或 `/office title` 手動設的永遠不自動蓋，但超過 30 分鐘沒更新又來新指令時標「（N 分前設）」，「目前」欄附最新指令，讓主管看出職稱跟實際工作對不上
- **ListAgents 名稱**：沒登記名稱的人，若這版 Claude Code 有 `CLAUDE_CODE_MESSAGING_SOCKET`，改顯示「SendMessage 用 to=uds:…」，照填就送得到

## 個人按鈕（不進 repo）

在自己電腦建 `~/.claude/pixel-office/buttons.json`，按鈕會出現在辦公室與下方按鈕列之間那一列（最多 6 顆）。
最快的做法是複製 plugin 附的範例檔再改：

```
cp "<plugin 目錄>/plugins/pixel-office/buttons.example.json" ~/.claude/pixel-office/buttons.json
```

內容長這樣：

```json
[
  { "label": "開工", "prompt": "/llm-wiki:wiki-day 開工" },
  { "label": "收工", "prompt": "/llm-wiki:wiki-day 收工" },
  { "label": "文件", "url": "https://example.com" }
]
```

- `prompt`：送給**按下按鈕的那個視窗**，等同你親自輸入；`/` 開頭當 slash 指令執行。照常受權限管控。
- `url`：用瀏覽器開，只收 `http`／`https`。
- `label` 1～12 字。改完檔案約 10 秒內自動生效（也可輸入 `/office buttons` 立刻重讀）。沒有這個檔就不顯示。

## 畫面

俯視平面圖：上排會議室＋主管室，下方員工區（四人一組、十字隔板），底部走廊有貓與影印機。

- 每個 session 的狀態即時反映在小人與螢幕：打字、讀檔、思考、出錯、完成
- 主管坐主管室：一位坐 L 型大桌；兩位以上換小桌，面板夠寬最多 3 張（80 欄以上 3 張、60 欄以上 2 張、更窄 1 張），坐不下的主管不畫，最後一張桌的名牌前面加 `+N`
- 登記為某位主管 peer 的人（`/office team`）坐那位主管的區：第一位主管最右一欄、第二位往左一欄…，各鋪一種地毯（金、藍、綠）、上方掛「TEAM <主管名牌>」；有人分不到區（沒有 team，或他的主管排不進分區）時，最左一欄留給他們，沒有就每欄都能當分區。一位主管時有沒有 peer 都鋪；兩位以上只給有 peer 在線的主管，坐不下桌子的主管也有分區。排得出兩欄才分區；換區時會起身走過去
- 大門右邊是使用者的櫃台（下方外牆標 `YOU`），等核准的人拿紙來這裡排隊（見「點人核准」）；面板太窄（約 58 欄以下）放不下就不畫，改排大門口
- 每人有固定座位，別人進出不會讓他換位
- **開會**：llm-wiki 開會（說「開會」，skill `wiki-collabteam`）時呼叫工具 `office_meeting`，被點名的參與者（不限 team）閒著就走進會議室坐下，忙的做完再進，散會才走回原座位；不設期限，主持人散會（`action=end`）或參與者全都離線就清空；只是畫面，討論本身由 `wiki-collabteam` 的 `meet.md` 跑。`/office meeting` 看狀態、`/office meeting off` 提早散會。底層是 `~/.claude/pixel-office/meeting.json` = `{"until": <epoch ms>, "topic": "…", "participants": ["<ListAgents 名稱或名牌>"]}`；沒有 `participants` 時改由主管的 peer 進場
- **對外動作會跑腿**：寄信（Gmail 寄送／回覆／轉寄／草稿）拿著紙走去影印機；上傳文件（Google Drive、Notion 建立／更新）拿資料夾走去檔案櫃；`git push` 拿包裹走去大門口的郵筒；成功才算，走完回座位
- 員工座位坐不下時左上角顯示 `+N`
- 終端版用色塊（`▀`）即時畫、每秒 4 格；Claude Desktop 用 SVG 畫，每 0.5 秒更新一次（約每秒 2 格），按鈕相同

面板最少要 46 列高（場景 44 列＋預留 1 列＋按鈕 1 列）（上排房間＋一排座位群＋走廊），寬 56 欄以上員工區排兩欄。

## 點人核准

**預設關閉。** 在要負責審核的那個視窗打 `/office approve on` 才會啟用（存起來，重開後仍記得）；開啟時面板頂端常駐一行「核准已開啟（/office approve off 關閉）」。關著時面板不顯示「審」與 Allow／Deny，等核准的人照樣走去櫃台排隊、名單照樣標「等核准」—— 那是看 waiting 狀態，不靠單。

- 某個 session 要問「可以跑這個嗎」時，只要**有任何視窗開著辦公室面板且核准開啟**，就把單寫到 `~/.claude/pixel-office/approvals/<session>.json`；名單標「辦公室面板可審」。終端機原本的詢問照常出現，誰先按算誰的
- 🔴 **只有約 8 秒能按**：引擎給權限 hook 的預算固定 10 秒，超過就改由終端機問；所以單上帶截止時間（預算剩下的減 1.5 秒），過了就收單、交回終端機。面板與 `/office who` 第一行都顯示「剩 N 秒」
- 面板最上方出現「🟡 等你核准：審 <名牌>」→ 按下去看完整指令 → Allow／Deny／收起。Allow 展開後 1 秒才按得下去，單換成新的一筆就重新計算；指令超過 1500 字或 20 行只給 Deny，Allow 請回它的終端機按。沒有「永遠允許」，Allow／Deny 也沒有快捷鍵
- 決定寫到 `decisions/<session>.json`，等的那方比對 session、這次呼叫的 id、單上的隨機 nonce、**自己手上指令全文的 SHA-256** 四項全對才採用；不符就丟棄並記一行 log
- 不接手、直接交給終端機的情況：auto 等不問人的模式、subagent、沒有人開著面板且核准開啟、對不上是哪一次呼叫、檔案壞掉、截止前沒人按、預算剩不到約 3.5 秒、使用者中斷或終端機先按了。處理完兩個檔覆寫成 `{"state":"done"}`（不留指令內容）
- 🔴 **限制**：這兩個檔是本機共用檔，同一個使用者帳號下的其他程式（包括別的 Claude session 跑的 Bash）理論上讀得到 nonce、也寫得出決定。這個機制防的是**誤按與配錯**（看錯單、按到別人的、按到舊的、單被換字），**不防本機惡意程式**

## 運作方式

每個 session 每 5 秒把自己的狀態寫到 `~/.claude/pixel-office/sessions/<session-id>.json`（一個 session 一個檔，不互相覆蓋），每秒讀一次所有人的。超過 20 秒沒心跳或標記離開的不畫。只讀寫 `~/.claude/pixel-office/` 底下（sessions、approvals、decisions、meeting.json、buttons.json），不碰其他檔案、不連網。

## 開發

```
claude plugin validate plugins/pixel-office
claude plugin test plugins/pixel-office
```
