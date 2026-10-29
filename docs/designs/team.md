# 一人多 session 協作（skill `team`）設計

2026-10-29 jacky 與 office設計（session）逐題定案。做法正本在 `skills/team/`；這份只記**定了什麼、為什麼**，給之後改設計的人對照。

## 定位

外掛是**輔助**：畫面（視覺化）＋讓每個 session 少讀東西（省 token）＋提供「從規則產生角色」的步驟。
**不內建方法**：AIMM、gstack、willy 開發流程都是使用者指定的規則來源；外掛讀完提案角色與邊界，使用者核可才建卡。gstack 等可並用（skill 寫進角色卡）。

| 外掛內建（跟方法無關） | 讀規則後產生 |
|---|---|
| 登記、主管／員工、`team` 隸屬、分層骨架 | 要哪些角色 |
| 角色卡格式、檢查點格式、`collab.md` 格式 | 每個角色的職責與邊界 |
| 派工、回報、開會流程 | 流程階段（gstack 想→計畫→做…、AIMM 8.2～8.7） |

## 定案

| # | 題目 | 結論 | 理由 |
|---|---|---|---|
| 1 | 放哪 | pixel-office 裡，skill `team` | jacky 選資料夾名 `.claude/office/` 時一併定 |
| 2 | 分層 0／1／2 | 留骨架；各層內容由規則產生 | 「要不要多開人」各方法都會遇到；跟建資料夾、部門主管畫法綁在一起 |
| 3 | 專案資料夾 | `<主 repo>/.claude/office/`：`collab.md`、`roles/`、`checkpoints/`、自帶 `.gitignore` | 在 Claude 設定區，Obsidian 不索引；不動專案的 `.gitignore` |
| 4 | 什麼時候建 | 有人登記成主管時 | 第 0 層用不到；開 session 就建會到處多資料夾 |
| 5 | worktree | 一律寫回主 repo（`git-common-dir`）；`collab.md` 不進 git、`roles/` 進 git | 一個專案一份狀態；狀態一直變不該進 commit |
| 6 | 寫入衝突 | 一個檔一個寫的人：`collab.md` 主管、`checkpoints/<角色>` 持有者 | 多 session 改同一檔沒有鎖 |
| 7 | 升層 | session 提議、使用者說好 | 多開人是使用者的 token 成本 |
| 8 | 降層 | 主管底下沒在線的人滿 **20 分鐘** → 提醒，不自動改；降層後 `collab.md` 保留，只清主管列與「在線」 | 沒人在線可能只是暫時關視窗；「外掛不主動」 |
| 9 | 角色卡 | 只放定義（role、source、layer、reports_to；職責、邊界、必讀≤5、可用 skill、交付） | 進度會一直變，放卡上會互相覆蓋 |
| 10 | 檢查點 | `checkpoints/<角色>.md` 只往後加、不進 git；接手只讀最後一筆 | 放 `collab.md` 會讓員工每存一次都要主管代寫 |
| 11 | 第 2 層 | 沿用 `team`：主管也能填＝部門主管，坐自己部門那一區第一個位子 | 語意一致；主管室最多 3 張桌，AIMM 6 個部門放不下 |
| 12 | 產生角色 | 提案表在對話裡；另開 session 要符合「獨立觀點／能平行／上下文互相干擾」之一；建卡跟開人分開 | 避免規則裡一個階段變一個人（gstack 是單 session 依序跑） |
| 12a | 決策者（「只有 PM 能發布」） | 不建卡，提案表下列「歸使用者／主管」 | session 自己核可、放行等於繞過使用者（2026-10-29 實測後 jacky 定） |
| 13 | 跟 `wiki-collabteam` | 逐步搬：通用的搬進 `team`，vault 專屬留；舊 vault 角色卡實作完就搬 | 正在跑的 ROLE session 不能斷 |

## 還沒做

- 舊 vault 的 `wiki/meta/roles/`、`coordination.md` 搬到 `<vault>/.claude/office/`：要動 `role_cards.py`、`tidy_check` T9、`wiki-day` end-manager、樣板；搬完 `wiki-collabteam` 再縮
- 降層提醒只在有新的使用者指令時送出；主管閒著沒人下指令就不會提醒（設計上可接受：提醒的對象是下一次動作）
