---
name: team
description: "Multi-session collaboration: layers (solo / manager / department leads), stepping up or down as manager, role cards generated from a rule set the user names (AIMM, gstack, a project flow), squads (machine-wide reusable layer-2 crews: 研發+測試, PM+採購…), takeover, checkpoints, dispatch, reports, meetings. Also for peer reports, 📋 meeting notices, 請裁示, demotion reminders. Triggers: 當主管, 升層, 降層, 部門主管, 小隊, 設角色, 角色卡, 接手, 派工, 誰在動, 開會, 請裁示, 存檢查點, collab.md."
---

# team：一人多 session 協作

外掛的角色是**輔助**：把現況畫出來、讓每個 session 少讀東西。**不內建任何方法**——要照 AIMM、gstack 或專案自己的流程，由使用者指定規則來源，讀完提案、使用者核可才建角色。
**按需讀一份，不要全部載入。**

| 你現在的情境 | 讀 |
|---|---|
| 「照 <規則> 設角色」、建角色卡、「你是 <角色>，接手」、存檢查點 | `roles.md` |
| 要不要多開人（升層）、當主管、收到 peer 回報／佔用申請／BLOCKED、派工、降層提醒、「大家在幹嘛」 | `lead.md` |
| 開會、收到 `📋 開會`、主持人送來「請裁示：」 | `meet.md` |
| 升部門主管、開小隊成員、建小隊（第 2 層） | `squad.md` |

## 分層（外掛只管骨架，各層內容由規則產生）

| 層 | 長相 | 辦公室登記 |
|---|---|---|
| 0 | 一個 session 自己做完 | 員工 |
| 1 | 主管開 session，一件事一條線（審查、測試另開） | 主管＋peer 掛 `team=<主管>` |
| 2 | 第 1 層的員工升成**部門主管**，自己商討，從整台電腦共用的**小隊**挑人用到才開（`squad.md`） | 部門主管＝`role=主管`＋`team=<上層主管>`；小隊成員掛 `team=<部門主管>` |

- **升層**：session 判斷要多開人時**提議**，使用者說好才登記成主管（`lead.md` §1）。
- **降層**：主管（含部門主管）底下沒有在線的人滿 20 分鐘，外掛會在下一則指令附提醒；**問使用者**，只是暫時關視窗就照舊。外掛不自動改。

## 專案資料夾 `<主 repo>/.claude/office/`

**有人登記成主管時才建**（第 0 層用不到）。`<主 repo>`：git repo 取 `git rev-parse --path-format=absolute --git-common-dir` 的上一層（所有 worktree 寫回同一處）；不是 git repo 就是目前資料夾。

```
.claude/office/
├─ .gitignore            ← 兩行：collab.md、checkpoints/
├─ collab.md             ← 狀態：誰在線、負責什麼、佔用、待裁示。只有主管寫
├─ roles/<角色>.md        ← 角色定義，進 git。使用者核可才建、才改
└─ checkpoints/<角色>.md  ← 檢查點，只往後加；持有該角色的 session 自己寫
```

🔴 **一個檔只有一個寫的人**：多 session 改同一檔沒有鎖，後存檔無聲覆蓋先存檔。`collab.md` 只有主管寫（多位主管各寫自己那列）；別人用 `SendMessage` 回報，由主管登記。

## 在知識庫（llm-wiki vault）裡

照常用本 skill；vault 才有的規則（受控紀錄的禁止事項、`_README.md` 歸屬、`hot.md`／`log.md`）在 llm-wiki 的 `wiki-collabteam`，**那份是補充，不取代這份**。vault 的卡多「用到才查」「守門腳本」兩段，`collab.md` 多幾段擴充；舊 vault 的 `wiki/meta/coordination.md`、`wiki/meta/roles/` 用 `role_cards.py migrate` 搬過來。

## 共通前提

- `SendMessage` 是 deferred tool，先 `ToolSearch("select:SendMessage")`；收件者＝`ListAgents` 上的名稱。沒有離線留言，對方要在線。
- 送不出去 → 寫 `peer-reply-<自己的名稱>.md` 到專案根目錄，請使用者轉交。
- 開新 session 由使用者決定（多花 token 是他的成本）；未經允許不開 subagent。
- `office_roster` 一次給每個人的名牌、職稱、主管／員工、ListAgents 名稱、正在做什麼——**先看它，不要逐張讀角色卡**。名單是即時畫面，權責以 `collab.md` 為準。
