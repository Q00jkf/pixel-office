# CHANGELOG

> **「某一版出了什麼」的正本。** 一版一段、最新在上。每段四件事：**改了什麼／為什麼／commit／issue**。
> 🔴 **bump `.claude-plugin/plugin.json` 的那個 commit 要同時寫這裡**，不要事後補。
> 「為什麼」只寫 commit 內文或使用者裁示裡有的；查不到寫「待補」，不推測。
> 0.1.0～0.30.4 在 [llm-wiki-plugin](https://github.com/Q00jkf/llm-wiki-plugin) 開發（當時路徑 `plugins/pixel-office/`），2026-10-29 連同歷史搬來；那段的 commit 欄寫的是舊 repo 的 hash。

---

## 0.36.0 — 2026-10-31

- **改了什麼**：外掛提供「開角色視窗」入口，開的時候順便登記辦公室
  - `scripts/open_role.py`（新）：`--role --dir --kickoff [--team --title --plate --plugin-dir --dry-run]`。子程序環境拿掉 `CLAUDE_CODE_CHILD_SESSION`、`ANTHROPIC_API_KEY`；指令用 `-EncodedCommand` 傳（不經 `-Command` 的引號剖析，不必 UTF-8 BOM）；路徑不存在報錯不開；`--dry-run` 只印指令與預設登記
  - 先產生 session id 帶 `--session-id`，寫 `~/.claude/pixel-office/presets/<id>.json`（title＝角色、role=staff、team、名牌）
  - `hooks/register.tsx`：`applyPreset` —— 這個 session 編號沒有任何存過的身分（全新）才讀預設登記檔、經 `applyProfile` 套用；resume 已有存檔，不蓋。agent／ref 本來就由 `selfRegister` 讀 ListAgents 自己填
  - `skills/team/lead.md` §1 第 3 步改叫 `open_role.py`；`roles.md` §3：預先登記的那列是自己、不算撞角色，已登記就跳過第 4 步
  - 團隊視窗（不在本 repo）的 pty 分頁改 import `open_role.child_env`，不再自己寫一份清單
- **為什麼**：jacky 2026-10-31 同意（willy主管辦公室派工）：健康檢查 14 天裡手組 `Start-Process powershell` 開角色 53 次，只有 wiki-studio 有一支臨時腳本（`ops/開角色.ps1`）；開場檔每次都要寫「開工先登記辦公室」一段
- **實測**：2026-10-31 `claude plugin test .` 180 過（新 3 個：預設檔欄位過濾、全新 session 套用、resume 不蓋）；`--dry-run` 跑含單雙引號與中文的角色名（引號照原樣進 `--name`）、不存在的路徑（報錯、exit 1）。開真視窗的實測裝到本機後補在下一個 commit
- **commit**：（本版）
- **issue**：無

## 0.35.0 — 2026-10-30

- **改了什麼**：手機面板（`remote/`）卡片的「Latest reply」用 Markdown 畫：表格、清單、粗體、行內 code、程式碼區塊；表格太寬橫向捲動
  - `page.html`：`marked.parse` 轉出的 HTML 一律過 `DOMPurify.sanitize` 才放進頁面；兩個檔沒載到退回純文字
  - `server.ts`：`/vendor/marked.umd.js`、`/vendor/purify.min.js` 兩個路由（只放行這兩個檔）
  - `remote/vendor/`：marked 18.1.2（MIT）、DOMPurify 3.4.17（Apache-2.0 或 MPL-2.0），附 `LICENSE-*`；不從 CDN 載
- **為什麼**：jacky 2026-10-30 同意（willy主管辦公室轉達）：原本 `esc()` 原文放進 `<pre>`，表格變成一堆 `|`；團隊視窗第二階段直接嵌這一頁。回覆是 AI 寫的、頁面能從手機遠端開，所以不准跳過過濾
- **實測**：2026-10-30 無頭 Edge 跑頁面裡的同一個 `md()`：測試A 含表格的回覆畫成 1 張表 3 列（格內 `<br>` 保留）；`<script>`、`<img onerror>`、`javascript:` 連結、`onclick` 都被拿掉，4 個旗標都沒被設
- **commit**：（本版）
- **issue**：無

## 0.34.0 — 2026-10-30

- **改了什麼**：team skill 接上「協作目錄放在專案平常不讀的區」（只改 skill 文字）
  - `SKILL.md`：projects.json 有設定＝使用者同意讀寫該目錄，只碰 `<office>` 底下；建資料夾與寫檔一律用檔案工具（有些專案只放行檔案工具寫入）；寫不進去時的建議補一句「建置、要交付的專案指到團隊自己的地方，那一區可能交付前要清空，office 不替你清」
  - `roles.md`：卡片可多加節（`啟動位置`、`踩過的坑`），接手照讀、先到啟動位置；報到對象＝`collab.md` 登記的主管，沒有就當無主管，不找名單上別專案的主管
  - `lead.md`：目錄在、`collab.md` 不在 → 補建 `collab.md`，roles／checkpoints 照用
- **為什麼**：jacky 2026-10-30「執行」（willy主管辦公室轉達）：willy #21 的 `_extras` 規則是「平常不讀、檔案工具寫放行、指令寫擋、交貨前要空」；團隊卡（wiki-studio a46ee33）多了啟動位置、踩過的坑兩節；2026-10-29 在 obsidion-book 實測接手，回報「目錄在但沒 collab.md 算不算已建」「reports_to 是角色名，會報錯主管」
- **實測**：2026-10-30 在 willy #21 確認複本（`總資料夾-第2輪`，載 willy-wt-彈性區）把協作目錄指到 `_extras/office`：Write 建 `.gitignore`、`collab.md` 放行；Bash `echo >` 被擋（「用指令改的退不回來，請用檔案工具改。」，ledger `Z12 shell_write`）。複本停用了 pixel-office、本機裝的是 0.33.0，skill 是照原始碼手動走，名單升降層沒測。依此在「寫不進去」補「shell 被擋先改用檔案工具」
- **實測 2**：同日第 2 輪，複本啟用 pixel-office、`--plugin-dir` 載 0.34.0（跟使用者層 0.33.0 沒有重複，skill／MCP 各一套）：升主管、建角色卡、降層、接手（無主管→跳過報到）、存檢查點全走通，hook 沒擋；庫裡 `_extras/office` 以外只有 willy 自己的日誌與備份變動。依回報補三句：`rev-parse` 失敗＝不是 git repo、沒主管時 `team` 怎麼設、檢查點用當地時間
- **commit**：（本版）
- **issue**：無

## 0.33.0 — 2026-10-29

- **改了什麼**：team skill 的協作目錄（collab.md、roles/、checkpoints/）可以指定位置
  - 新設定 `~/.claude/office/projects.json` = `{"<主 repo 絕對路徑>": "<目錄>"}`，目錄可相對專案或絕對；有設定就用，沒有照舊 `<主 repo>/.claude/office/`（`skills/team/SKILL.md`「協作目錄」段；`lead.md`／`roles.md`／`squad.md` 改引用它）
  - 寫不進去（權限或守門腳本擋下）→ 問使用者放哪、記進 projects.json 再寫；提示文字可建議 `_extras/office`，程式不寫死。換位置時舊 roles／checkpoints 問過才搬
  - 升主管的提示（`register.tsx`）提到 projects.json；README、使用說明補一句
  - 邊界：llm-wiki（已凍結）的 `role_cards.py migrate` 仍只搬到 `.claude/office/`
- **為什麼**：jacky 2026-10-29 定（willy主管辦公室轉達）：willy 知識庫的 `.claude/` 擋 AI 寫入，設定要放專案外、協作檔要能改放知識庫內 AI 可寫的區（willy #21 的 `_extras`）
- **commit**：（本版）
- **issue**：無

## 0.32.0 — 2026-10-29

- **改了什麼**：看得到的介面全改英文
  - 面板、按鈕（Night mode／Lights on、Review <名牌>、Allow (in 1s)／Allow (ready)、Cancel）、家具名與選單（Recent mail、Add event…）、狀態字、toast、`/office` 的回覆與用法、`office_profile` 回覆、名單表頭（Name／Title／Role／Now）與角色（manager／staff／dept lead）
  - 門牌：主管室→`MANAGERS`、會議室→`MEETING`（`vector.ts`；112、60 欄實測放得下）
  - 手機面板 `remote/page.html`、`remote/server.ts` 的狀態字與錯誤、manifest 名稱
  - agy：`agy_office.py` 的訊息、寄信抬頭改 `📨 Pixel office message from …`、名單表頭；`agy/skills/office/SKILL.md` 跟著改
  - 英文比中文寬，兩處重調：Allow 冷卻中的字改 `Allow (in 1s)`，跟 `Allow (ready)` 同寬（Deny 不跳位）；月曆選單 `Add event`（48 欄才放得進房間）
  - **沒改**：skill `team` 內容（llm-wiki 相容：collab.md 的「主管／在線」標題）；中文參數照收（`/office role 主管`、`/office pet 貓`…）；選單裡 `/llm-wiki:wiki-day 開工／收工` 的參數
  - README／使用說明的畫面字樣、`docs/office.png`、`meeting.png`、`social-preview.png` 重拍（門牌英文）
- **為什麼**：jacky 2026-10-29「辦公室內部的也改成英文好了 盡量不要讓我們的介面有中文」，範圍選「只改看得到的介面」
- **commit**：（本版）
- **issue**：無

## 0.31.0 — 2026-10-29

- **改了什麼**：搬到獨立 repo `Q00jkf/pixel-office`（`git subtree split` 帶 105 筆歷史），自帶 marketplace `pixel-office`；README／agy 指南的安裝指令、cache 路徑、`plugin.json` 的 repository、各檔裡的 `plugins/pixel-office/` 路徑改成新 repo；補 `LICENSE`、`CHANGELOG.md`、`CLAUDE.md`。行為不變
- **為什麼**：jacky 2026-10-29 定：llm-wiki 停止更新，office 開新 repo 只放 office、歷史一起帶過去，舊 repo 凍結後 archive
- **commit**：（本版）
- **issue**：無

## 0.30.4 — 2026-10-29

- **改了什麼**：agy 在辦公室跟 Claude session 分得出來
  - Desktop：名牌右邊加藍紫底白字的 **G** 徽章（`vector.ts` `nameTag`，徽章佔名牌寬度，名字少一字的空間）；上衣固定白衣藍紫邊（`build_sheet.py` 的 `SHIRTS` 在主管西裝前插一種，重產素材表；員工輪替數不變，現有的人不換色）
  - 終端機：名字後加「 G」、上衣藍紫
- **為什麼**：jacky 2026-10-29：agy 跟 Claude 長得一樣分不出來；先看預覽，只換上衣不夠清楚，加 G 徽章＋上衣選 C
- **commit**：（本版）
- **issue**：無

## 0.30.3 — 2026-10-29

- **改了什麼**：agy 看守程序（`agy_office.py watch`）續心跳時，把停在「完成」超過 5 秒的 agy 改回「閒置」（`DONE_MS = 5000`，同 `register.tsx` 的 `revertLater`）
- **為什麼**：jacky 2026-10-29 發現 agy 停下來後在辦公室一直顯示完成（綠條＋星星）；Claude 端 Stop 後 5 秒會回閒置，agy 端只有 hook 會改 mode，停下來就沒有 hook 了
- **commit**：（本版）
- **issue**：無

## 0.30.2 — 2026-10-29

- **改了什麼**：agy skill `office` 加一條：`call_mcp_tool` 回「unknown tool」時等約 10 秒重試一次，不要自己從 shell 啟動 `agy_office.py mcp`
- **為什麼**：jacky 2026-10-29 實測（agy 換成 Claude Opus 4.6）：視窗剛開就下指令，第一次 `call_mcp_tool` 回 unknown tool，稍後列工具時它已在清單上——推測外掛 MCP server 在登入後才載入（log 同秒有「Not reloading plugin MCP servers」再登入成功；未能直接證明）。agy 自己用 shell 手動跑 MCP server 繞過，經 PowerShell 管線把中文職稱寫成「???」
- **commit**：（本版）
- **issue**：無

## 0.30.1 — 2026-10-29

- **改了什麼**：agy 的 skill `office` 與送進 agy 的信，寫明確切的 `call_mcp_tool(ServerName="pixel-office_office", ToolName=…, Arguments=…)` 格式，並講明「清單裡看不到也照叫」
- **為什麼**：jacky 2026-10-29 實測：agy 讀了 skill 卻回「沒有 call_mcp_tool」不去試（lazy MCP 工具與 `call_mcp_tool` 都不在它列的工具清單）；指定確切呼叫後 `office_profile` 成功（名牌 research、職稱 查規格）
- **commit**：（本版）
- **issue**：無

## 0.30.0 — 2026-10-29

- **改了什麼**：`agy/` 改成一個 agy 外掛（`plugin.json`、`hooks.json`、`mcp_config.json`、`skills/office/SKILL.md`）
  - agy 有自己的 MCP 工具：`office_profile`（名牌、職稱）、`office_roster`（誰在線）、`office_send`（寄信，寄完照樣等回信 90 秒）；呼叫者的對話 id 取自 `_meta`
  - 預設名牌跟在線 agy 撞名時接對話 id 前 4 碼
  - `install` 改成移除舊版全域 hook＋`agy plugin install`；hook 每次把腳本同步到 `~/.claude/pixel-office/agy/`（Claude 端寄信用固定路徑）；看守改在那裡跑，不佔外掛資料夾
  - 送進 agy 的信改成指示用 `office_send` 回覆；使用者筆記 `docs/agy-寄件協作.md` 改寫安裝與用法
- **為什麼**：jacky 2026-10-29「同名稱的問題」→「給 agy 一個外掛件讓 agy 也可以用 office 的功能」；探測外掛實測見 `docs/designs/agy.md`
- **commit**：（本版）
- **issue**：無

## 0.29.0 — 2026-10-29

- **改了什麼**：agy 寄完信等回信。PostToolUse 看到 agy 跑了 `agy_office.py … send` 就標記；這一輪結束時 Stop hook 每秒看收件夾、最多 90 秒，等到就 `continue` 帶著信，沒等到就停。沒有使用者介入最多自動續跑 5 輪。Stop 的 hook timeout 改 110 秒（要重跑 `install`）
- **為什麼**：jacky 2026-10-29「至少把時間稍微拉長」。agy 回覆 Stop hook 等待中會凍結輸入，所以只在寄過信的輪等，不每輪都等；「需要時由 Claude 啟動 py 點視窗」（模擬按鍵）先不做：要搶前景、Windows Terminal 分頁難定位、會撞上使用者打字
- **commit**：（本版）
- **issue**：無

## 0.28.0 — 2026-10-29

- **改了什麼**：agy 跟 Claude session 互傳訊息（A 案：互動視窗＋收件夾）
  - `agy_office.py send <收件者> <訊息> --from <寄件者>`：收件者是 agy → `agy/inbox/<對話>.jsonl`，hook 在 `PreInvocation`（`injectSteps` userMessage）或 `Stop`（`decision: continue`＋reason）塞進對話；是 Claude → 寫 `commands/<session>.json` 並帶 `from`
  - `takeCommand` 帶 `from` 的命令顯示「📨 <寄件者>：…」而不是 📱（`commandText`），標明不是使用者本人
  - 名單上 agy 那列改寫成怎麼寄給它；新增設計筆記 `docs/designs/agy.md`
- **為什麼**：jacky 2026-10-29「看得到了但為什麼不能跟它說話」；agy 自查確認閒置的互動視窗從外部叫不醒，jacky 選 A（不改用 stream-json 橋接常駐，那是 B 案）
- **commit**：（本版）
- **issue**：無

## 0.27.0 — 2026-10-29

- **改了什麼**：Antigravity CLI（agy）的對話也畫進辦公室（只顯示，不能傳訊）
  - 新增 `agy/agy_office.py`：`install`／`uninstall` 管 `~/.gemini/config/hooks.json` 裡的「pixel-office」一組；`hook` 把 agy 事件轉成 `sessions/agy-<對話>.json`（`kind: "agy"`）；`watch` 背景看守用 presence lock 續心跳
  - `Coworker.kind`、`parseStatus` 帶出 `kind`；名單 ListAgents 欄顯示「Antigravity（不能傳訊）」
- **為什麼**：jacky 2026-10-29 測 Antigravity CLI，問能不能在辦公室看到；探測 hook 實測 Windows 可跑、各事件帶 `conversationId`／`workspacePaths`，presence lock 開著時被鎖
- **commit**：（本版）
- **issue**：無

## 0.26.1 — 2026-10-29

- **改了什麼**：小隊的內容集中到 skill `team` 的新檔 `squad.md`（原本散在 `SKILL.md`「小隊」段、`lead.md` §8、`roles.md` §5）；`SKILL.md` 路由表加一列指過去
- **為什麼**：jacky 2026-10-29 問要不要把小隊拆成另一個 skill、用到才啟用；改用同 skill 內按需讀的檔——效果相同，又不多一份每個 session 都付的 skill 描述（約 100–150 token，估計）
- **commit**：（本版）
- **issue**：無

## 0.26.0 — 2026-10-29

- **改了什麼**：skill `team` 的第 2 層改成「部門主管＋小隊」
  - 第 1 層的員工要另開人時升成部門主管：自己跟使用者商討，研發、測試等從小隊挑、用到才開；登記 `role=主管`＋`team=<上層主管>`，降回時改回員工（`lead.md` §8；§1 第 4 步改指過去）
  - 小隊＝整台電腦共用的角色卡組 `~/.claude/office/squads/<小隊>/`（`squad.md`＋`roles/`），不進 git、複製資料夾就能帶走；外掛不內建，照使用者指定的規則建（`roles.md` §5）
  - 找卡順序：專案 `roles/` 先、小隊後（專案同名卡蓋過小隊）；小隊卡 `reports_to: 部門主管`，專案背景由部門主管派工時帶
- **為什麼**：jacky 2026-10-29：第二層像把 gstack 的員工抓出來（商討、研發、測試），部門主管自己商討；它應該是「這台電腦都使用、可以複製」的系統，可選開研發測試或 PM 採購。名稱「小隊」與三個傾向（專案卡優先、不內建、不進 git）由 jacky 核可
- **commit**：（本版）
- **issue**：無

## 0.25.1 — 2026-10-29

- **改了什麼**：skill `team` 的 `SKILL.md`「在知識庫裡」補一句：vault 卡多「用到才查」「守門腳本」、`collab.md` 有 vault 擴充段、舊 vault 用 `role_cards.py migrate` 搬
- **為什麼**：llm-wiki 1.16.0 把 vault 協作檔搬到 `.claude/office/`（jacky 2026-10-29）
- **commit**：（本版）
- **issue**：無

## 0.25.0 — 2026-10-29

- **改了什麼**：一人多 session 協作搬進 pixel-office
  - 新 skill `team`（`skills/team/`：`SKILL.md`、`roles.md`、`lead.md`、`meet.md`）：分層 0／1／2 骨架、升層（session 提議、使用者說好）與降層、專案資料夾 `<主 repo>/.claude/office/`（`collab.md` 狀態只有主管寫、`roles/` 進 git、`checkpoints/` 只往後加；登記主管時才建）、從規則產生角色（提案表＋「為什麼另開 session」三判準、使用者核可才建卡、建卡跟開人分開）、派工單、回報、開會（自 `wiki-collabteam/meet.md` 搬入）
  - 部門主管（第 2 層）：主管也可以填 `team`，`team` 對到另一位在線主管就是部門主管 —— 不進主管室、坐自己部門那一區第一個位子、那一區的地毯和 TEAM 是他的；底下沒人時坐上一層主管那一區；互相掛不算。`scene.ts` `isDeptLead`、`teamZones`、`seatBosses`、`assignSeats`，手機 `deskRowsNeeded` 同步；名單標「部門主管」
  - 降層提醒：主管底下沒有在線的人滿 20 分鐘，下一則使用者指令附一段 context 給模型（一段沒人的期間只一次），只提醒不自動改
  - 升層時 `office_profile` 的回覆提示照 skill 建資料夾；系統提示加 (6) 指向 skill；家具選單「開會」改 `/pixel-office:team 開會`；README「選裝」改成「要多 session 協作就要裝」
  - 每個 session 都會載入的模型文字（系統提示段、3 個工具說明、降層提醒、skill `team` 描述）改成精簡英文；`主管`／`員工` 值與觸發詞保留中文。估計每 session 約 1,640 → 1,040 tokens（字元數推估；`claude -p` 實量量不出差異）
  - 實測（office測試 session，用完即丟的 repo＋worktree）後補 skill 文字：新建 `collab.md` 也加自己主管列、骨架帶表格分隔列、降層只清「在線」列、主線角色免填理由、`reports_to`／`source` 寫法、規則指名的決策者不建卡
- **為什麼**：jacky 2026-10-29 與 office設計 討論定的：外掛只當輔助（畫面、省 token），不寫死 AIMM／gstack，角色由規則產生；資料夾、升降層、部門主管、檢查點、跟 `wiki-collabteam` 逐步搬的做法逐題定案，降層門檻 20 分鐘。設計稿 `plugins/pixel-office/docs/designs/team.md`
- **commit**：（本版）
- **issue**：無

## 0.24.0 — 2026-10-27

- **改了什麼**：外掛自己跑 ListAgents 登記 ListAgents 名稱（`selfRegister`：`$.tool.check` 是 allow 才 `$.tool.call`，不經模型、不花 tokens）：session 開始 3 秒後一次、每次 `/office` 一次。`/office` 回報結果：登記到的名稱；沒名字的 session（ListAgents 不印「This session is」）提示用 `/rename` 取名；要權限則提示手動登記
- **為什麼**：jacky 2026-10-27：finance（Claude Desktop）沒登記，別的 session 傳訊息找不到它；問 `/office` 能不能自動登記
- **commit**：（本版）
- **issue**：無

## 0.23.2 — 2026-10-27

- **改了什麼**：manifest 的 `<link>` 加 `crossorigin="use-credentials"`，Chrome 抓 manifest 與圖示時帶 Cloudflare Access 的登入 cookie
- **為什麼**：jacky 2026-10-27：換成 PNG 後主畫面還是「J」。Chrome 預設不帶 cookie 抓 manifest，被 Access 302 到登入頁，拿不到圖示；照 finance 看盤台（dash.example.com）已用的做法
- **commit**：（本版）
- **issue**：無

## 0.23.1 — 2026-10-27

- **改了什麼**：手機主畫面圖示改成 PNG（192／512／maskable），圖案是辦公室素材拼的「打電腦的人」，`remote/build_icon.py` 產生；manifest 與頁面改指這些 PNG
- **為什麼**：jacky 2026-10-27：加到主畫面後圖示只有「J」（Android 不吃 SVG 圖示，退成網址字首），選 A 打電腦的人
- **commit**：（本版）
- **issue**：無

## 0.23.0 — 2026-10-27

- **改了什麼**：每輪結束（`turn.complete`，只算主對話）把最後的回覆寫到 `replies/<session>.json`（上限 8000 字，超過截掉）；那一輪是手機命令觸發的就帶上那道命令。手機卡片顯示「最新回覆（幾分鐘前）・回你：📱 …」，保留換行、可捲動，同一則回覆不重畫
- **為什麼**：jacky 2026-10-27：手機下命令後看不到回應，不知道要跟他說什麼；選所有 session 的最新回覆都顯示
- **commit**：（本版）
- **issue**：無

## 0.22.0 — 2026-10-27

- **改了什麼**：手機（只有 2 欄）改成一隊一整排（2 組桌、8 個位子），伺服器依「有 peer 的主管數＋沒 team 的人每 8 人一排」加長畫面，頁面可上下滑；team 框不疊到下一排。手機卡片可以下命令：`POST /command` 寫 `commands/<session>.json`（只收同源 JSON），那個 session 的外掛每秒來拿（`takeCommand`），以使用者自己打的字送出（`$.prompt.submit` `asUser`，前面加 📱），先寫 `<session>.done.json` 再送，重載不重送；10 分鐘沒被收作廢。卡片顯示上一道命令「已送出／已收到／作廢」
- **為什麼**：jacky 2026-10-27：0.21.0 一隊只佔一組桌（我上一輪說「一隊一整排」卻做成一組，做錯）、要能滑動看更多 session；要從手機對 session 下命令，選「當成我打的」
- **commit**：（本版）
- **issue**：無

## 0.21.0 — 2026-10-27

- **改了什麼**：只有 2 欄、又不只一排時（手機直立、窄面板）團隊分區改成一隊一組桌（`zoneUnits`，由上往下、每排從右往左），3 欄以上照舊一隊一欄；同名的人名牌後加 ①②，截字時保住編號（`sameNameNumbers`，Desktop 與手機都有）；手機頁點人跳出卡片（職稱、狀態、工具、等核准的工具、隊伍、ListAgents 名稱、最近錯誤），`/state.json` 多回每個人在圖上的位置
- **為什麼**：jacky 2026-10-27 手機截圖：兩隊只畫出「TEAM office」一框，willy 隊的 r2、test 被擠進去（2 欄扣掉沒 team 的人那欄只剩 1 欄可分）；兩個 `LLM-Wiki-` 分不出來；點不到人
- **commit**：（本版）
- **issue**：無

## 0.20.0 — 2026-10-27

- **改了什麼**：第 3 期手機版第一步（只看）。新增 `remote/server.ts`＋`remote/page.html`：本機 bun 伺服器讀共用資料夾、用同一套 `scene.ts`／`vector.ts` 畫直立辦公室（寬 64 單位、高照螢幕比例），手機頁每秒更新、可加到主畫面（manifest）。經 Cloudflare 的要求要帶 Access 驗過的 owner email，否則 403。session 狀態解析抽成 `hooks/status.ts`（面板與伺服器共用）。伺服器測試 `remote/server.spec.ts` 2 個
- **為什麼**：jacky 2026-10-27 選方案 A（自建 App）。手機 Claude App 實測不會以 `mobile` 畫面接上外掛（`debug-open.json` 只有 terminal／desktop），所以 B 走不通。對外改用 finance 已有的 Cloudflare Tunnel＋Access，不另做 Worker 與密碼
- **commit**：（本版）
- **issue**：無

## 0.19.3 — 2026-10-27

- **改了什麼**：`/office` 回報面板有沒有畫出來（`$.ui.open` 的 `isPlaced`／`reason`）與接著哪些畫面（`$.session.surfaces()`），並寫一份 `~/.claude/pixel-office/debug-open.json`
- **為什麼**：jacky 2026-10-27 在手機（Claude App＋Remote Control）打 `/office`，回「已開啟」卻沒有畫面；原本不看 `$.ui.open` 的結果，查不出原因
- **commit**：（本版）
- **issue**：無

## 0.19.2 — 2026-10-27

- **改了什麼**：Claude Desktop 的 session 不再被當成一次性對話。`session.attach`（非 terminal）或面板在 Desktop／手機畫出來時清掉 `oneshot`／`label` 並重寫狀態檔；`session.start` 當下已有非 terminal 的 surface 也不標。測試 166 → 167
- **為什麼**：jacky 2026-10-27 回報 0.19.0 後 Desktop 的員工都消失。根因：0.19.0 只看 `isInteractive`＝false，但 Desktop 的 session 也走 SDK，一樣是 false（實測三個 Desktop session 的狀態檔都是 `oneshot: true`）；G4 只用 `claude -p` 驗過
- **commit**：（本版）
- **issue**：無

## 0.19.1 — 2026-10-27

- **改了什麼**：走路走到一半換路線不再瞬移。新增 `rejoin`：新路線回到舊起點就原地掉頭；從舊起點出發就先掉頭回座位再走；從舊終點出發就先走完舊路線。`trackMoves`、等核准排隊兩處都改用 `walkTo`。測試 165 → 166（換路線時每格位移不超過 `WALK_SPEED`、核准時掉頭只走回已走的路）
- **為什麼**：jacky 2026-10-27 回報「人物的走動看起來怪怪的有時候會瞬移」。根因：走去櫃台排隊途中就核准（或角色改變），舊的走路被丟掉，新路線從目的地起算，人跳到櫃台再走回來
- **commit**：（本版）
- **issue**：無

## 0.19.0 — 2026-10-27

- **改了什麼**：G4 —— `claude -p` 一次性對話不畫成員工
  - 認得出非互動：`session.start` 的 `isInteractive`＝false → 狀態檔加 `oneshot: true`，`label`＝啟動時的 `--name`（classic `SessionStart`、`source`＝startup 的 `session_title`；2026-10-27 實測 `claude -p --name API-probe-01-1` 拿到原字串）
  - 讀名單時一次性對話不進 `others`：不排座位、不畫、不列入 `/office who`／`office_roster`（最後一行計數）；Desktop 在櫃台右邊（窄面板在檔案櫃右上）畫「⚙ <前綴> ×N」徽章，終端機在按鈕列右邊留一行（Raster 不變）
  - 分組 `oneshotGroups`：`--name` 第一個 `-` 之前；沒帶的歸「一次性」
  - 互動 session 帶 `--name` 的，預設名牌改用它（`launchPlate`：去掉非 ASCII、截 12 字、至少 2 字）；手動設過的不動
  - **修 `sessions/me.json` 垃圾檔**：classic `SessionStart` 比 `session.start` 先跑，那時 session 編號還是預設的 `me`，`session_title` 觸發的 publish 寫出 `me.json`（left:false，會被當成在線的人），真正的狀態檔反而拿不到標題。改成編號還沒拿到時只記下、session.start 拿到編號後再套用
  - 測試 159 → 165：分組與徽章文字、`launchPlate`、名單排除與計數、別的視窗的一次性對話不進 Raster／Svg 員工區且畫出徽章、`-p` 啟動不留 `me.json` 且寫 `oneshot`＋`label`、互動 `--name` 當名牌
- **為什麼**：willy主管辦公室 2026-10-27 需求（`.team/to-office/impl-fwd-willy-105826.md`），jacky 核准；主管 office 信件 office-G4、裁示名牌照 (A)
- **commit**：待補
- **issue**：無

## 0.17.0 — 2026-10-27

- **改了什麼**：G2 —— Desktop 整個面板都是辦公室、家具選單看得清楚且位置固定；終端機 Raster 不變（40 個雜湊照過）
  - 場景高度撐滿面板：`scene.ts` `desktopRows`＝bodyRows×1.25／k（Desktop 一列＝2.5／k 單位），拿掉 80 列上限，只扣核准列；`setSpread` 只在畫 Desktop 時開，多出來的高度平均分到座位群之間與上方，不全堆在走廊（終端機版面照舊）
  - Desktop 拿掉「個人按鈕：…」提示與「夜間模式」按鈕：點牆上任何一扇窗切換（`Hit` 新增 `window`，第一扇 key 沿用 `night`）；舊格式個人按鈕疊在員工區上緣左邊
  - 家具選單：Desktop 改深色不透明底（`#1a1c2c`）＋金色圓角框＋標題列（家具名），選項字指定白色；`menuSize` 把框與標題算進大小
  - 選單位置固定：`menuPlace` 的 others 改成 `menuOthers`（其他可點的家具／窗／柯基＋`VectorScene.fixed` 櫃台與 YOU 牌），不再看走動、排隊的人與寵物
  - 30 人 SVG：面板 ~900px 高（77 列）63,761 字元；112×200 列 112,638 字元，仍在 131072 內
  - 測試 148 → 155：desktopRows 換算、Desktop 只剩場景（無提示、無按鈕列）、點窗切夜間、拉高時座位群分散且終端機版面不變、選單深色有框、選單在任何走動／排隊／寵物位置下都不動、選單不蓋櫃台、112×200 SVG 上限
- **為什麼**：jacky 2026-10-27 Desktop 截圖（`.team/reports/G2-jacky-desktop.png`）；主管 office 信件 office-G2、office-G2b（名牌不改；選單要明顯、位置固定）
- **commit**：待補
- **issue**：無

## 0.16.1 — 2026-10-27

- **改了什麼**：oftest F 期驗收（`.team/reports/F-test.md`）小修；終端機 Raster 不變
  - 選單位置（`vector.ts` `menuPlace`）：依序試家具的右、左、上、下，選單要整個留在家具所在的房間（`Hit.room`：會議室／主管室／員工區），先挑不蓋到其他可點的東西與走動、排隊的人（`VectorScene.avoid`）的那一側；選單寬照字寬算（全形 2 格＋4）。修 G1：48 欄影印機選單原本固定往左退 18 欄，蓋到排隊的人、黑貓、郵筒，現在改開在影印機上方；終端機會議選單不再壓主管室金框
  - 終端機點寵物：toast 照送，另在按鈕列右邊留一行結果約 5 秒（oftest 實機截圖看不到 toast）
  - `CELL_UNITS`、`cellAt`、`menuPlace` 搬到 `vector.ts`（純函式，預覽腳本也能用），`register.tsx` 轉出
  - 測試 144 → 148：40 個情境 × 兩種面板，每件家具的選單都在房間內；48 欄影印機選單不蓋東西；會議選單不跨進主管室；終端機點寵物留一行
- **為什麼**：主管 office 2026-10-27 信件 office-015055
- **commit**：待補
- **issue**：無

## 0.16.0 — 2026-10-27

- **改了什麼**：F 期 —— 點寵物、點家具開選單、寶寶與山雀換像素圖、走路格；終端機 Raster 像素不變（`vector.test.tsx` 40 個雜湊照過）
  - **點寵物**（`register.tsx` `overlay`／`pressPet`）：走動中點 → 貓餵飯、寶寶餵奶、山雀放飛；停著再點 → 換下一隻。底下的「餵／放／換寵物」按鈕（`c`／`b`／`p`）拿掉，`/office pet`、`/office bite` 照舊。點柯基冒愛心（只在 Desktop）
  - **家具選單**：影印機、檔案櫃、郵筒、月曆、販賣機、時鐘、會議桌 7 件，各有預設選單（`MENUS`），選一項走個人按鈕同一套 `runButton` 送 prompt；同時只開一個、有「取消」、沒有快捷鍵；畫面上沒畫的家具沒有選單
  - `buttons.json` 新格式 `{ "object": "printer", "label": "查信", "prompt": "…" }`：同 `object` 整份取代那件家具的預設選單；沒有 `object` 的舊格式照舊畫在底下那排（家具項目不佔那 6 顆名額）；`/office buttons` 分開列兩種；`buttons.example.json` 改示範新格式
  - 疊按鈕：absolute `Box`，場景單位 → 字元格 `CELL_UNITS`（終端機 1×2；Desktop 1×2.5，2026-10-27 Desktop 實測，`office-calib` 0.0.2）；Svg 被縮小時乘「面板欄數／場景寬」。Desktop 用空白 plain 按鈕鋪滿整塊；終端機中心一格 `▾`／`♥`（會蓋掉 Raster 那一格的顯示，Raster 本身的 cells 不變）；終端機寵物換格才重畫面板
  - `vector.ts`：`drawVector` 多回傳 `hits`（每件點得到的東西的框）；走廊多畫一個檔案櫃（素材沒有，照色盤畫），販賣機移到影印桌與櫃台之間、擠不下就不畫
  - 升為主管／設為員工按鈕拿掉（jacky：用不到），改角色用 `/office role`
  - **寶寶、山雀**：`build_sheet.py` 依 Sweetie 16 手繪像素圖（寶寶坐／爬、山雀停／飛）
  - **走路**：5 個人物 × 8 種上衣各多 4 格（正面左右腳、側面左右腳），抬起那隻腳短 1 像素＋1 像素起伏；往左走翻面、上下走維持正面。素材表 256×220 → 256×545，base64 約 3.1 萬字元；最大情境 SVG 65,971 字元（上限 131072）
  - 測試 136 → 144
- **為什麼**：主管 office 2026-10-27 轉 jacky 裁示（信件 office-010229、010741、010853、012052）；點擊位置先用獨立 mod `office-calib` 在 Desktop 實測定案
- **commit**：96612d9
- **issue**：無

## 0.15.1 — 2026-10-27

- **改了什麼**：oftest E 期驗收（`.team/reports/E-test.md`）B1～B4，只動 `vector.ts`，終端機不變
  - B1 會議室下排椅子底端收在房間下緣（原本伸出 1.4 單位：112 欄蓋住時鐘、48 欄伸進門洞）；時鐘改成建築最後畫
  - B2 桌上杯子的杯底移到名牌框上方，不再壓到名牌右端
  - B3 主管都穿西裝但造型不重複：依桌號從名字雜湊那個造型起找沒人用的（max 情境 cc 與主管乙原本撞同一個）
  - B4 寵物改在走動、排隊的人之前畫，窄面板排隊的人在貓前面；貓不改路線 —— 位置是跟 Raster 共用的計算，改了終端機畫面就會變
  - 測試 132 → 136
- **為什麼**：主管 office 轉 oftest 驗收報告，2026-10-27 裁示一起修
- **commit**：7ae7c8c
- **issue**：無

## 0.15.0 — 2026-10-27

- **改了什麼**：Desktop 畫面換成 2dPig「Pixel Office」素材（CC0）；終端機 Raster 一個像素都沒變（`vector.test.tsx` 40 個雜湊照過）
  - 新 `assets/build_sheet.py` → `assets/office-sheet.png`（256×220，原素材表去天空＋5 人物 × 8 種上衣色）與 `hooks/sheet.ts`（base64 約 1.4 萬字元＋裁切框）
  - `vector.ts`：新形狀 `sprite`；SVG 的 `<defs>` 只嵌一次素材表，每個圖素是巢狀 `<svg viewBox>`＋`<use href="#S">`（2026-10-27 用 Edge 以 `<img>` 開實測：`<use>` 引用 `<image>`、翻面、`image-rendering:pixelated` 都有效）
  - 長相：會議室與主管室白色後牆＋窗戶、月曆、國旗；藍磚地板；隔間＝素材灰隔板＋橘桌（人在桌後，桌子擋下半身）；會議長桌兩端照比例、中段拉長；走廊販賣機、影印桌、紅色垃圾桶當郵筒、櫃台橘桌
  - 人物：5 個造型依名字雜湊固定分配，再依名字換上衣顏色（不用橘、黃，會跟膚色糊在一起）；主管一律深藍西裝。素材沒有動畫格 → 走路、打字上下輕跳 1 個素材像素
  - 狀態泡泡、問號、紅牌、冷汗、閃光、名牌照舊向量畫；圓頭小人的眼睛表情（思考眼睛往上、眨眼）沒了，閒著改成頭旁打瞌睡的 z
  - 寵物：橘貓換素材黑貓（往右走翻面、走路輕跳）；主管室右下角趴一隻柯基（只在 Desktop，不是可切換的寵物）；寶寶、鳥照舊向量
  - 時鐘：員工區看得到的那面牆（會議室門與隔牆之間）掛數字鐘，`register.tsx` 傳現在時間（本機時區）；放不下（48 欄）就不掛
  - 團隊地毯、TEAM 牌、櫃台 YOU、核准按鈕不變
  - SVG 最大 48,278 字元（2026-10-27 實測 max-112-7，含素材表；上限 131072），測試加 < 80000 斷言
- **為什麼**：jacky 嫌 Desktop 向量畫面醜；主管 office 2026-10-27 指派 E 期換皮
- **commit**：ea50ee4
- **issue**：無

## 0.14.1 — 2026-10-26

- **改了什麼**：Desktop 向量畫面的重疊瑕疵（oftest D 期驗收第 4 節，7 類）
  - 名牌、TEAM 牌、+N 改畫在最上層（夜間也在暗幕之上），字帶描邊（深字白邊、金字深棕邊）—— 修好文件圖示壓字尾、通知紅牌蓋 TEAM 牌、貓蓋排隊名牌、被咬的人蓋自己名牌
  - 主管思考泡泡、問號、紅牌改畫在頭的右側，不再蓋到主管名牌
  - 坐不下的主管 +N 從名牌拆出來，變成桌角一顆小徽章；名牌放不下先縮字（最小 1.5）再截字，窄面板「★主管乙」完整
  - 會議室上排名牌貼牆放不下就放到人下面
  - `scenarios.ts` 的 max 情境改帶開會座位（參加者改成閒著的人，會議室真的有人）；Raster 鎖的 8 個 max hash 用 0.13.2（9fe6804）的 scene.ts 重算，終端機畫法沒動
  - SVG 最大約 4.9 萬字元（2026-10-26 實測，上限 131072）
- **為什麼**：主管 office 轉 oftest 驗收報告
- **commit**：de022bd
- **issue**：無

## 0.14.0 — 2026-10-26

- **改了什麼**：Desktop 辦公室改畫向量（設計稿第 2 期）
  - 新 `hooks/vector.ts`：吃跟 `drawScene` 同一份 crew、座位、SceneOptions，輸出形狀清單（圓角矩形、圓、橢圓、路徑、文字），純資料不依賴 `$`；`vectorSvg` 轉成 SVG（磁磚用 `<pattern>`，夜間蓋暗幕、螢幕與問號畫在暗幕上）
  - 人物：圓頭＋兩眼，依 mode 換表情 —— thinking 眼睛往上＋泡泡、error 冒汗發抖、done 跳一下＋閃光、waiting 頭上問號、idle 8 格眨一次眼、typing 手動、reading 拿紙、blocked 紅牌
  - 名牌、門牌（會議室／主管室）、TEAM 牌可中文，依顯示寬度截字（全形算 2）
  - Desktop（Svg）改用向量；終端機（Raster）的 `drawScene`＋`encode` 不動，新測試用 40 個情境的 hash 鎖住跟 0.13.2 逐位元相同
  - SVG 大小（2026-10-26 實測）：最大情境 112×80、30 人＋貓＋紙飛機＋開會＋排隊約 4.6 萬字元（點陣版 8.0 萬），上限 131072
  - 新 `hooks/scenarios.ts`（測試與截圖共用的情境）；`scene.ts` 只多 export 常數與配色
  - 沒做：支援圖片的終端機（`Image` 元素）、眼睛看向游標 —— 設計稿列為之後
- **為什麼**：設計稿第 2 期；點陣在 Desktop 放大後糊、名牌不能寫中文
- **commit**：6ee166f
- **issue**：無

## 0.13.3 — 2026-10-26

- **改了什麼**：辦公室核准保留、預設關閉
  - 審核端開關 `/office approve on｜off`（存 `$.store`，重開記得；預設 off）；狀態檔多一欄 `approve`（開著面板且核准開啟才為 true）。請求端只在有人 `office && approve` 時送單，否則 PermissionRequest 直接 `next(e)`
  - 關著時面板不顯示「審」與 Allow／Deny；開著時面板頂端常駐「核准已開啟（/office approve off 關閉）」
  - 排隊走去櫃台改看 `mode === 'waiting'`（依 since 排序），不再靠核准單 —— 核准關著也照常排隊
  - Allow 按鈕冷卻中「Allow（等一秒）」、可按「Allow（可以按）」同寬，Deny 不再左移（oftest 回報）
  - README 指令表與「點人核准」節更新；`/office` 說明加 `approve on|off`
- **為什麼**：jacky 2026-10-26 最終裁示 B（保留辦公室核准、預設關閉），細節是主管 office 轉達
- **commit**：c1ec1ca
- **issue**：無

## 0.13.2 — 2026-10-26

- **改了什麼**：點人核准的等待放進 hook 的 10 秒預算內
  - 等待上限改成 `next.budget.remainingMs − 1500 ms`（`approvalWindow`；剩不到 2 秒就不送單，沒有計時時上限 120 秒），單與狀態檔都帶 `deadline`（絕對時間），到期自己清成墓碑、回 `next(e)`
  - 聽 `next.signal`：中止時睡眠立刻醒、清單、結束迴圈
  - 面板：核准區移到最上方，展開時顯示「剩 N 秒」、每秒重畫；過了 deadline 就收起、不給按（到點自動重畫，不等下一輪 refresh）；`decide()` 寫決定前再檢查 deadline；`parseApproval` 以 deadline 判斷過期（沒有 deadline 的舊單當不存在）
  - `/office who` 第一行：「🟡🟡 等你核准…：<名牌>（工具，剩 N 秒）」
- **為什麼**：oftest 2026-10-26 實測 `classic.PermissionRequest` 的 hook 預算固定 10 秒（`HookBudget.ms`），超過就改由終端機問但 hook 還在背景跑 → 單一直顯示 waiting，使用者按 Allow 寫得出決定卻不會被採用（以為放行了其實沒有）。修法是主管 office 裁示
- **commit**：9fe6804
- **issue**：無

## 0.13.1 — 2026-10-26

- **改了什麼**：核准決定綁指令內容
  - 決定檔多帶 `textHash`（面板展開時看到的全文的 SHA-256）；等的那方用自己手上的指令算 hash，四項（session、toolUseId、nonce、textHash）全對才採用，不符丟棄＋log
  - 面板按下時重讀單，全文跟展開時不同就不送；單上的 text 變了也重新展開
  - README 新增「點人核准」節，寫明限制：決定檔是本機共用檔，防誤按與配錯，不防本機惡意程式；同時更新桌數門檻與分區規則的舊說明
- **為什麼**：主管 office 2026-10-26 審 dbc5c81：approvals 檔任何本機程式都能改，同一張單（toolUseId＋nonce 不變）的 text 被換成無害字樣時，使用者看到的跟實際放行的會不同
- **commit**：77933aa
- **issue**：無

## 0.13.0 — 2026-10-26

- **改了什麼**：控制塔第 1 期「點人核准」—— 開著辦公室面板的視窗可以替別的 session 按 Allow／Deny
  - 請求端：`tool.check` 判 ask 時記下 toolUseId；`classic.PermissionRequest`（沒有 tool_use_id）用 2 秒內 tool＋input 完全相同、剛好一筆的 ask 配對，配不上就不接手。auto、bypass 類模式、subagent、host 代答、沒有人開辦公室 → 直接交回終端機
  - 送單 `~/.claude/pixel-office/approvals/<session>.json`（含隨機 nonce），每 300 ms 讀 `decisions/<session>.json`；session＋toolUseId＋nonce 全對才採用，不符丟棄並記一行 log；壞檔、逾時 120 秒、終端機先按（PostToolUse／PostToolUseFailure／PermissionDenied／tool.call 結束）→ 不回答。只回 allow／deny，從不送 updatedPermissions
  - 處理完兩個檔都覆寫成墓碑 `{"state":"done"}`（`$.fs` 不能刪檔）；開機先清自己的殘檔；逾時的一律當不存在
  - 面板：「🟡 等你核准：審 <名牌>」按鈕 → 展開全文＋Allow／Deny／收起。Allow 展開後 1 秒才按得下去，單被換成新的一筆就重新展開、冷卻重算；全文超過 1500 字或 20 行只給 Deny 與「回終端機按」；Allow／Deny 不給 hotkey。決定檔只有面板按鈕會寫，沒有任何模型工具能寫
  - 畫面：等核准的人拿著紙走到櫃台排隊（窄面板排大門口），結案後走回座位；名單標「辦公室面板可審」
  - 分區：最左一欄只在有人分不到區時才保留（主管 office 裁示），60～80 欄兩位主管各帶 peer 時有兩區
- **為什麼**：控制塔設計稿第 1 期；安全底線 8 條與冷卻、2 秒、不給 hotkey 是主管 office 2026-10-26 裁示
- **commit**：dbc5c81
- **issue**：無

## 0.12.1 — 2026-10-26

- **改了什麼**：多主管畫面在實機寬度（50～80 欄）看得到
  - 小主管桌 10→8 寬、間距 12→9，往左排到主管室牆邊（盆栽在最後一張桌壓到時讓位）：≥60 欄就有 2 張、≥80 欄 3 張（原本 84／112）
  - peer 分區不再依賴有沒有桌子：坐不下的主管排在有桌的後面，他的 peer 照樣有一區與 TEAM 牌（分區數仍受欄數限制：最左一欄留給沒有 team 的人）
  - 櫃台貼下牆、矮一格（4 列）：走底部走廊去影印機／檔案櫃／郵筒的人不再壓到櫃台
- **為什麼**：oftest B 期驗收（實機面板 50～80 欄看不到第 2 張桌；跑腿的人壓到櫃台上緣），修法是主管 office 2026-10-26 裁示
- **commit**：e8c47be
- **issue**：無

## 0.12.0 — 2026-10-26

- **改了什麼**：控制塔第 0 期畫面 —— 多主管、各主管 peer 區、櫃台
  - 主管室：一位主管照舊坐 L 型大桌；兩位以上換 10 寬小桌，依寬度最多 3 張（第 0 張站位與大桌相同，人數變了不起身）；坐不下的不畫，最後一張桌名牌加 `+N`（不再被排去員工座位）
  - peer 區：`teamZones` 每位有 peer 在線的主管一欄（最右起），地毯金／藍／綠、各掛「TEAM <名牌>」，最左一欄留給沒有 team 的人；一位主管時行為不變
  - 櫃台：大門右邊、下方外牆標 `YOU`，`counterSpot()` 給第 1 期排隊用；窄面板放不下不畫
  - 設計稿 `docs/designs/control-tower.md` 進 repo，第 0 期標已實作
- **為什麼**：控制塔設計稿第 0 期（jacky 2026-10-26 加入多主管；核准一律走到使用者的櫃台）
- **commit**：d1f4ce3
- **issue**：無

## 0.11.1 — 2026-10-26

- **改了什麼**：名單「等輸入／剛完成」也附「上次出錯 N 分前」；沒名稱者的位址改用 code 格式 `to=uds:…`，系統提示 (3) 提醒照抄（兩個反斜線）；`plugins/*/tsconfig.json`（引擎載入 inline mod 時產生）加進 .gitignore
- **為什麼**：oftest A 期驗收（`.team/reports/A-test.md`）：idle／done 提早 return，出錯後停下來等人時看不到錯誤；模型抄位址掉一個反斜線 → ENOINBOX no-key
- **commit**：待補
- **issue**：無

## 0.11.0 — 2026-10-26

- **改了什麼**：控制塔 A 期 —— 名單（`office_roster`、`/office who`）資訊細分
  - 「目前」欄：「🟡 等核准 N 秒」與「等輸入（N 分）」分開（狀態檔新增 `since`）；出錯時存錯誤第一行（最多 80 字，`lastError`），名單顯示，之後 10 分鐘內標「上次出錯 N 分前」
  - 職稱自動帶：沒職稱時，使用者自己打的指令（composer／bridge，不含 slash 指令與 peer 訊息）以 classic hook 的 `session_title`（有的話）或指令前 16 字帶入，名單標「(自動)」；自動帶的放超過 30 分鐘再來新指令才換。手動設的永遠不蓋，但超過 30 分鐘沒更新又來新指令時標「（N 分前設）」並在「目前」欄附最新指令
  - 回信位址：每個 session 發布自己的 `uds:<CLAUDE_CODE_MESSAGING_SOCKET>`（`addr`）；沒有 ListAgents 名稱時名單顯示「SendMessage 用 to=uds:…」；寄到位址也畫得出紙飛機
  - 系統提示 (2) 加一句「名單顯示你的職稱過期時，請更新 title」
- **為什麼**：控制塔設計稿（`plugins/pixel-office/docs/designs/control-tower.md`）A 期；手動 title 不蓋、改為過期標示是主管 office 2026-10-26 裁示
- **commit**：待補
- **issue**：無

## 未發版（0.10.5 之後，併入 0.11.0）

- **改了什麼**：山雀加一支渲染層測試（連續 8 格白色像素數必須相同）
- **為什麼**：使用者截圖回報跳起來頭還是被切掉。實測程式正確，使用者看到的是 1–2 天前開的 session 載入的舊版 —— plugin 在 session 啟動時載入記憶體，在跑的視窗不會重讀
- **commit**：`ae18a60`
- **issue**：無

## 0.10.5 — 2026-10-08

- **改了什麼**：開會點名改用 ref 比對；山雀跳躍改成整隻位移
- **為什麼**：agent 名稱與名牌都不唯一（實測兩個 session 同名、四個名牌同為 `user`），點名會抓錯人；跳躍原本是裁掉頂端列來假裝上移，切掉的正是頭
- **commit**：`722f986`
- **issue**：無

## 0.10.4 — 2026-10-08

- **改了什麼**：`office_roster` 加 ref 欄，撞名時直接給可貼的定址字串
- **為什麼**：同名 session 時 `SendMessage` 必須帶 `[ref]`，原本得再跑一次 `ListAgents`
- **commit**：`99fb0d0`
- **issue**：無

## 0.10.3 — 2026-10-07

- **改了什麼**：銀喉長尾山雀改回側面，羽色照圖鑑
- **為什麼**：使用者覺得斜前方看起來奇怪，要求先查北海道シマエナガ照片再上色
- **commit**：`cf8406d`
- **issue**：無

## 0.10.2 — 2026-10-07

- **改了什麼**：山雀照使用者給的照片重畫（斜前方視角）
- **為什麼**：使用者貼照片要求
- **commit**：`dc68a45`
- **issue**：無

## 0.10.1 — 2026-10-07

- **改了什麼**：山雀改成全白
- **為什麼**：使用者：「山雀是全白的」
- **commit**：`1baceaf`
- **issue**：無

## 0.10.0 — 2026-10-07

- **改了什麼**：新增可切換的寵物銀喉長尾山雀（貓 → 寶寶 → 山雀）
- **為什麼**：使用者要求「多加一個可以切換的寵物」
- **commit**：`714e53c`
- **issue**：無

> 0.10.0 之前尚未補記。要查就看 `git log -p -- plugins/pixel-office/.claude-plugin/plugin.json`。
