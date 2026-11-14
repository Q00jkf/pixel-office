# CHANGELOG

> **「某一版出了什麼」的正本。** 一版一段、最新在上。每段四件事：**改了什麼／為什麼／commit／issue**；0.60.0 起加第五件 **升級要做的**：已裝的人更新後要自己動手的（舊角色卡要改的欄位、要重裝的 Codex／agy、抄出去的設定），沒有寫「無」。外掛升版後第一則指令會叫模型讀這一欄。
> 🔴 **bump `.claude-plugin/plugin.json` 的那個 commit 要同時寫這裡**，不要事後補。
> 「為什麼」只寫 commit 內文或使用者裁示裡有的；查不到寫「待補」，不推測。
> 0.1.0～0.30.4 在 [llm-wiki-plugin](https://github.com/Q00jkf/llm-wiki-plugin) 開發（當時路徑 `plugins/pixel-office/`），2026-10-29 連同歷史搬來；那段的 commit 欄寫的是舊 repo 的 hash。

---

## 0.61.0 — 2026-11-14

- **改了什麼**：
  - Codex、agy 能接手 Claude 的角色卡：兩邊的 MCP 各加 `office_takeover(role, cwd)`。工具說明寫明「使用者說『你是 X，接手』時先用」，不靠 skill 觸發。它跑 Claude 外掛的 `scripts/takeover.py`：repo 的 `scripts/` 優先，再找 Claude 外掛 cache 的最高版。回傳卡、上次檢查點、collab 摘要，以及「接手後要做的」：登記、向主管報到並帶上次檢查點的下一步、照卡做事、檢查點的格式與檔案路徑
  - `takeover.py` 加 `--kind codex|agy --as <名牌> --id <辦公室 id>`：不讀 Claude 的 session 紀錄、不叫 `/rename`、不查同一對話開兩個視窗；撞角色照查
  - 兩邊的 `office_profile` 加 `team`，掛到主管底下
  - agy 的 office skill：「你是 X，接手」是接手角色，先叫 `office_takeover`，不是只登記名牌
  - 檢查點提醒，照 Claude 的規則：接手成功後做過事（`office_*` 工具不算）、一小時沒存 → Codex 下一則指令、agy 下一次呼叫時提醒一次。沒接成或第 2 層卡不提醒。Codex、agy 沒有 `/compact` 前提醒，也沒有下線補寫
  - Codex 外掛版號從 0.59.0 對齊到 0.61.0
  - Codex：使用者那句話符合「你是 X，接手」或「you are X, take over」時，UserPromptSubmit hook 提示先叫 `office_takeover(role=X)`。原因：同一句話實測兩次，一次叫了工具，一次直接說「已接手」就等指示，只靠工具說明不穩。使用者打的字只拿來比對、不存
  - `takeover.py` 給 Codex／agy 的登記行：主管在線時直接印 `team=<主管的 ListAgents 名稱>`。原因：讓 Codex 自己去名單上找，它填了名牌 `office`，不是 `office設計`，掛不上去。第 5 步寫明存檢查點是接手流程的一部分，卡上寫「不改檔」也要存；原因：卡的邊界寫「不做：改任何檔」時，Codex 就不存檢查點
  - 系統提示那段 pixel-office 指引（找人、開角色 → `roles.md` §5）沒進系統提示時，第一則指令改塞進 context 一次。
    - 原因：2026-11-14 實測，Claude Desktop 代管的 session 裡，pixel-office 的 `prompt.compose` 被 `cc-plugin-sec-default` 跳過；這個 mod 來源不明，2026-11-11 起就有。同時被跳過的還有 `classic.*` 與 `session.compact`
    - 判斷依據是「這個 session 的 compose 沒跑」，不是寫死 Desktop。compose 在 submit 之前跑（D1 的通知時間：compose 04:31:22.045，UserPromptSubmit 22.419），有跑就不塞，不會重複
- **為什麼**：使用者要測「agy 或 codex 接手角色可不可以」。2026-11-14 實測結果（測試資料夾 `agy-codex接手實測.md`）：
  - Codex 只聽到一句「接手」：會讀卡、做事、回報，但不讀上一筆檢查點、也不存新的
  - agy 的 office skill 把「接手」當成登記名牌，卡都沒去找
  - 兩邊的 `office_profile` 都沒有 team；從 Claude 開出的 Codex 被 `takeover.py` 認成開它的 Claude
  - 提案 T1～T5，使用者裁示「照提案 T1 到 T5 都做」
- **升級要做的**：
  - Claude Code 外掛要更新到 0.61.0：`office_takeover` 跑的是它的 `takeover.py`，舊版沒有 `--kind`，會回「too old」
  - Codex 重裝：`codex plugin remove pixel-office@pixel-office-codex`、`codex plugin add pixel-office@pixel-office-codex`，開 Codex 跳「hooks are new or changed」選 **Trust all**
  - agy 重裝：關掉所有 agy 視窗，`python <plugin>/agy/agy_office.py install`
- **實測**：
  - JSON-RPC 直接打兩邊的 MCP 程序：`tools/list` 有 `office_takeover`；呼叫後回卡與「接手後要做的」，「你」那段是 codex／agy 的名牌與辦公室 id
  - 模擬 hook：接手後記下檢查點檔；做過事、撥回兩小時 → 下一則提醒一次，第二次不提醒；`office_send` 不算做事；別人已持有同一角色 → STOP，舊記錄清掉
  - `claude plugin test .` 211 過（TypeScript 只改了版號）
  - code review（`claude -p` Sonnet，0.36 美元）7 條修 5 條：office 工具不算做事、Codex 沒給 cwd 用 hook 記的工作夾、提醒出錯不吞信、沒接成清掉舊記錄、只在「接手後要做的」那段找檢查點路徑。不修的 2 條：還沒寫 CHANGELOG（就是這段）；舊版腳本的偵測只認 argparse 英文訊息（argparse 沒附翻譯）
  - 真的 Codex、agy 對話實測（測試資料夾，卡上不寫接手步驟，只說「你是 X，接手」）：
    - agy（互動視窗，使用者按允許）：叫了 `office_takeover`；職稱「接手測試」、team＝office設計；報到帶出上次檢查點的暗號 BLUE-42；收工時加了一筆檢查點
    - Codex（`codex exec`）第 1 次：hook 還沒信任，工具拒絕
    - 第 2 次：信任了，卻沒叫工具，只說「已接手」→ 加 hook 提示
    - 第 3 次：重裝 Codex 外掛把信任重置，hook 全失敗
    - 第 4 次：接手、登記、報到都做了，但 team 填成名牌，也以「不改檔」為由不存檢查點 → 改 `takeover.py`
    - 第 5 次：全過，登記到 office設計 底下、報到、加了檢查點（7,008 tokens）
    - 坑：重裝 Codex 外掛會重置 hook 信任，要重新到 `/hooks` 按 Trust all
  - 補塞指引：`claude plugin test .` 212 過。`claude -p --plugin-dir`（一般 session）問模型那段出現幾次：只在系統提示一次，沒有重複（0.18 美元）。Desktop 代管的 session 裡補上了沒，等新開 session 驗
- **commit**：e0606bb、3c74706、31f0b80、2dd080b、ca09de5、a674224

## 0.60.0 — 2026-11-14

- **改了什麼**：
  - 叫人流程寫成一段：skill `roles.md` §5（在線就傳話 → `roles.py` 找卡 → 有卡用卡上的角色名開 → 沒卡問使用者），`SKILL.md` 路由表加一列、description 加叫人、開、關、收到回報類觸發詞，`lead.md` §1 第 3 步指過去；§5 也寫了開場檔怎麼寫、開好之後提醒使用者什麼（不必另有本機範本）；系統提示補「roster 找不到人、或要開角色 → roles.md §5」
  - `open_role.py` 開之前檢查：同名或同職稱已在線 → STOP、exit 3（`--force` 照開）；名字沒卡但有相近的卡、`--dir` 跟卡的啟動位置不同、同名多張卡 → 印 Note；唯一一張卡的路徑寫進開場句（含 `--kickoff`）。團隊視窗 Relations 叫人撞到時，畫面說清楚撞到誰、改傳話或 `--force`
  - 升版提醒：`~/.claude/pixel-office/version.json` 記這台電腦見過的最新版；升版後第一則指令提醒一次、指到本檔「升級要做的」；開著的舊版視窗提醒重開。`/office version` 顯示這個視窗的版號
  - README 加「更新」段（Claude、Codex、agy 三種）
  - Claude Desktop 代管的 session 沒被點開也算員工：start_session 開的、App 重開後在背景恢復的 session 收不到 `session.attach`，原本一直被標成一次性對話，名單看不到。改成每 5 秒讀 CLI 自己的 `~/.claude/sessions/<pid>.json`，有 `hostSessionId` 就拿掉標記（不用環境變數 `CLAUDE_CODE_HOST_SESSION_ID`：子行程會繼承）
  - `open_role.py`（團隊視窗分頁也用）不再把上層的身分帶進新視窗：claude 替子行程設的傳訊權杖、session 編號等 9 個一律拿掉；上層是 Desktop 代管時，再拿掉 Desktop 塞的 `CLAUDE_CODE_*`、`CLAUDE_AGENT_SDK_*`、`ANTHROPIC_BASE_URL` 等（登錄檔有的照留）。原本從 Desktop 的主管開出的視窗帶著主管的 `CLAUDE_CODE_HOST_SESSION_ID`、`MESSAGING_SOCKET`／`TOKEN`，CLI 紀錄的 entrypoint 也被寫成 `claude-desktop`
  - skill `roles.md` §5 加 Claude Desktop 的開法：手上有 `start_session` 時，標題＝角色名、brief 帶卡路徑與主管，新 session 自己 `office_profile`
  - `lead.md` §7 主管可以關底下 peer 的 session（9a7db2e、5d551a8，使用者 2026-11-11 授權）
- **為什麼**：2026-11-14 主管被叫「開出 office 員工」時，沒載入 team skill，另開了一個沒職責的角色；其實已經有 office設計 的卡。調查發現流程分散在三份檔、平常的說法對不到觸發詞，維護者本機也停在 0.55.1 沒更新。使用者：「盡量不要把功能寫在 claude.md 的 ops 裡面，因為這樣其他人無法使用，所以去完善 pixel office 反而是更好的」。Desktop 這三項：主管用 start_session 開的評估 session 在名單上看不到，查的時候順便發現環境變數外洩；使用者裁示「全部完成一起發」
- **升級要做的**：
  - 自己抄過「開角色」流程到 CLAUDE.md 或其他設定的：改成「照 pixel-office team skill `roles.md` §5」，或補上「先 roster → `roles.py` 找卡」
  - 呼叫 `open_role.py` 的腳本：同名或同職稱已在線時會 exit 3，要開第二個就加 `--force`
  - Codex、agy 沒改，不用重裝
  - 在背景跑的 Desktop session 要重開才會載入新版，載入後 5 秒內出現在名單上
- **實測**：`claude plugin test .` 209 過。`open_role.py --dry-run` 用本機真實資料驗過：撞角色、相近的卡、`--dir` 不符、沒有卡四種情況。團隊視窗的撞名訊息只驗過程式能解析、`online_as` 有回值，沒開視窗點過。`claude -p` 觸發實測同樣 4 句平常說法（「幫我開出 office 員工」等）：改前 0/4 載入 team skill，改後 4/4 載入並先看 roster（各 1.10、1.14 美元，Opus）；測試的工作資料夾不在 repo 裡，讀 `roles.md` 被權限擋，§5 後半段沒驗到。code review（`claude -p` Sonnet，0.38 美元）確認 8 條都修：沒有 version.json（從 0.60 以前升上來）也提醒、版號含非數字也比得出來、版號檢查出錯不再跳過同一輪的收信與檢查點、撞名比對不分大小寫並加比名牌與卡上的 office_name、`--dry-run` 撞名時照印指令、用 office_name 叫的登記成卡名、團隊視窗訊息改成「到終端機加 --force」；另修開場句「。。」。
  Desktop 三項：測試 211 過（加 2 個模擬：Desktop 代管的 session 5 秒內變回員工；`claude -p` 繼承了 HOST_SESSION_ID 仍是一次性對話）。實測真的 `claude -p` 繼承那個變數時，CLI 紀錄沒有 `hostSessionId`（0.005 美元）。環境變數：從 Desktop 代管的 session 用 `open_role.py` 實開一個視窗，CLI 紀錄 entrypoint＝`cli`、ListAgents 列得到、SendMessage 送達、辦公室職稱與 team 正確，Bash 裡看不到 HOST_SESSION_ID、DESKTOP_APP_VERSION、ANTHROPIC_BASE_URL（看得到的 MESSAGING_SOCKET／TOKEN 是它自己的，跟來信位址一致）。code review（Sonnet，0.25 美元）指出原本的寫法會連使用者在 .bat 設的變數一起拿掉，改成兩層。
  **沒實測**：Desktop 代管的 session 實際載入新版後有沒有出現在名單上（要先更新本機外掛）；start_session 能不能指定工作資料夾；封存時外掛會不會補檢查點（後兩項寫在 `roles.md` §5）。每輪自動回摘要：主管量了 1 個 session、4 輪，每則約 400 字，ctx 9%→15% 大部分是對話本身，影響小
- **commit**：9a7db2e、5d551a8、812fa21、1f40bfb、d848a0e、3e6d913、72a32fd、012d9b5、160e4fe、74e02a5

## 0.59.0 — 2026-11-09

- **改了什麼**：Codex → Claude。Codex 外掛多一個 MCP server（`codex/.mcp.json`），給 Codex 三個工具：`office_roster`（誰在線、要寄給誰填什麼）、`office_profile`（改名牌、職稱）、`office_send`（傳話給 Claude、agy 或另一個 Codex；寄給 Claude 時附「用 session id 回信」的指令）。呼叫者從 MCP `_meta` 的 `sessionId` 取，不猜。收件人在 id、ListAgents 名稱、名牌、職稱任一欄對到兩人以上就拒絕並列出候選（含 id）；roster 撞名時直接給 id。在線判斷改看 Codex 自己的寫入鎖（`~/.codex/thread-writer-locks/<id>.lock`）：終端機 `codex` 和桌面 App 都經背景常駐程式，看行程會留下關掉的對話。撞名後綴改取 session id 尾 4 碼（id 照時間排，前幾碼都一樣）
- **為什麼**：0.58.0 只做到 Claude → Codex。jacky 2026-11-09「你跟他一起解決這些問題」（跟 Codex 一起試辦公室功能時，Codex 沒有工具能主動傳話）、「其他codex 我應該關閉了怎麼還在座位上面」、收件人比對核可「好，改」（Codex 寄「Office」送到另一個 ListAgents 叫 Office 的 session）
- **坑**：`.mcp.json` 裡 `${PLUGIN_ROOT}` 不會展開（hook 的會），改用 `python -c` 到 Codex 外掛 cache 找最新那份；MCP 的 stdin 在 Windows 預設 cp950，要用 UTF-8 讀，不然中文參數讓伺服器結束、Codex 只看到「工具連線中斷」
- **安裝**：已裝的要先 `codex plugin remove pixel-office@pixel-office-codex` 再 `codex plugin add pixel-office@pixel-office-codex`（`add` 不會更新已裝的）；開 Codex 跳「hooks are new or changed」選 **2. Trust all and continue**
- **實測**：2026-11-09 jacky 的 Codex（0.167.0，Windows）重裝 0.59.3：辦公室看得到、Claude ↔ Codex 雙向傳話、關窗後約 1 分鐘常駐程式放鎖並標離開（不會有 SessionEnd）。收件人比對的修改只用假資料測過。code review（`claude -p`，0.85 美元）10 條都修。TypeScript 沒動，沒跑 `claude plugin test .`
- **commit**：b581da2、3456be7、65f46f7、6c287d7

## 0.58.0 — 2026-11-09

- **改了什麼**：Codex CLI 接進辦公室。新資料夾 `codex/` 本身是一個 Codex 外掛（只有 hooks）：`codex_office.py` 在 SessionStart／UserPromptSubmit／PostToolUse／Stop／SessionEnd 寫狀態檔 `sessions/codex-<id>.json`（`kind: "codex"`）、Stop 的 `last_assistant_message` 寫 `replies/`，看守程式在 Codex 停著等鍵盤時續心跳。Claude 端 `codex_office.py send <名牌> "…" --from <自己>` 跑 `codex queue`，開著的 Codex 閒置時自己撿起來回；不能用時退回收件夾，下次使用者送出訊息時塞進那一輪。畫面：名牌後綠色 X 徽章（Desktop `vector.ts`、終端機 `scene.ts`），名單附 send 用法。Codex → Claude 還沒做
- **為什麼**：jacky 2026-11-08「這一個系統可以看到 agy，那是不是也可以看到 codex 呢」；做法跟 willy-codex 討論後 jacky「照計畫做」
- **安裝**：使用者自己跑 `codex plugin marketplace add "<pixel-office>/codex"`、`codex plugin add pixel-office@pixel-office-codex`，再在 Codex 打 `/hooks` 逐個事件點進去信任（沒信任不跑也不報錯）。信任綁 hook 內容的雜湊，升版重裝要重新信任
- **實測**：2026-11-09 jacky 的互動 Codex（0.167.0，Windows）：狀態、心跳、完成變閒置、最後一則回覆、關窗、收件夾、`codex queue`（含 `& % ^ "`）都過。`claude plugin test .` 207 過；code review（`claude -p`，0.96 美元）8 條都修。細節 `docs/designs/codex.md`
- **commit**：4061330、594951a、dc7fbce

## 0.57.0 — 2026-11-08

- **改了什麼**：session 名稱＝角色名。`takeover.py` 接手時，session 名稱跟角色名（卡上有 `office_name` 用它）不同就提醒使用者 `/rename`（原本只有卡上寫了 `office_name` 才提醒）；已有在線 session 叫這個名字時印 STOP；登記提示的 team 改寫「主管的 session 名稱（＝它的角色名）」。`skills/team/roles.md` §3 第 4 步、`lead.md` 跟著改。比對 team 的程式不變
- **為什麼**：team 記主管的 session 名稱，換一個 session 接手主管時下屬全掛在舊名字上，要一個個傳訊息重登。jacky 2026-11-08：「session 名稱就直接叫做角色名稱這樣統一比較好，一開始在帶入 role 時就應該要把 session 名稱與 team 名稱換好」。`open_role.py` 本來就用 `--name <角色>` 開，缺的只有在現有 session 接手這條
- **舊資料**：team 記舊 session 名字的下屬照樣認得（比對不變），換人接手後要重登一次；之後登記的都是角色名，不用再重登
- **主管角色名要帶範圍**：`<範圍>主管`（例 willy主管），不能只叫「主管」——session 名稱＝角色名、辦公室整台電腦共用，光叫「主管」會跟別的專案撞名（jacky 2026-11-08「名稱不能叫做主管，一定要是 XXX主管」）。`roles.md` §1／§2、`lead.md`、`squad.md` 寫進規則；`takeover.py`、`team_window.py` 判斷主管角色改看「以主管結尾」（舊卡的「主管」照樣認），角色名或 `reports_to` 只叫「主管」時 `takeover.py` 印提醒（不擋）
- **實測**：`takeover.py` 實跑印出 /rename 提示與新登記行；code review（`claude -p` Sonnet，0.13 美元）3 條都修；第二批實跑 willy主管：登記帶 role=主管、別人在線印 STOP；review 0.11 美元，沒有要修的

## 0.56.0 — 2026-11-08

- **改了什麼**：session 狀態檔多一欄 `configDir`：記下那個 session 行程的 `CLAUDE_CONFIG_DIR`（沒設就不寫）；`parseStatus` 讀進來，手機版伺服器的 `crew()` 會帶出這一欄。畫面不變
- **為什麼**：一台電腦用不同設定目錄（`CLAUDE_CONFIG_DIR`）跑幾套隔開的設定時，客製的手機伺服器要分辨 session 屬於哪一套；名牌、職稱、team 都是 AI 能自己改的，環境變數 AI 改不了。jacky 2026-11-08 核可
- **實測**：`claude plugin test .` 205 過（新增 2 項：有設會記下、沒設不寫）；`bun test remote` 6 過

## 0.55.1 — 2026-11-08

- **改了什麼**：文件補上手機版也可以用 Tailscale 連：`README.md`／`README.zh-TW.md` 標題與說明改成「Cloudflare 或 Tailscale」、加兩者怎麼選、補 0.55.0 的傳照片；`docs/使用說明.md` 手機版「對外」拆成 Cloudflare 與 Tailscale 兩種，Tailscale 附前置（MagicDNS、HTTPS Certificates）、停用指令、不要用 funnel、使用者實測遇到的三件事、「tailnet 裡的裝置都放行」的提醒（serve 會帶 `Tailscale-User-Login`，主管 2026-11-08 實測；伺服器還沒用它檢查）；`remote/server.ts` 只改開頭註解。程式行為不變
- **為什麼**：使用者照 Tailscale 試用說明實測可用（2026-11-08），但公開 repo 只寫 Cloudflare；jacky 問「有在上面提醒使用者要使用遠端可以用 tail 或者 cloud 嗎」，核可補上
- **實測**：只改文件與註解，`bun test remote` 6 過
- **commit**：（本版）

## 0.55.0 — 2026-11-08

- **改了什麼**：手機版傳照片：
  - `remote/page.html`：卡片輸入框旁加 📷；選照片後 `createImageBitmap` → canvas 縮到長邊 1600 → JPEG 0.85，連同輸入框的字送 `POST /upload { id, text, data }`（data＝base64）
  - `remote/server.ts`：新增 export `sendPhoto(id, text, jpeg: Uint8Array, now?)`，回傳錯誤訊息或 undefined（跟 `sendCommand` 一樣）。只收 JPEG 檔頭 `FF D8 FF`、≤ 8 MB、字 ≤ 3000、session 要在線；檔名由伺服器產生（時間＋隨機碼），存 `~/.claude/pixel-office/uploads/`，順便刪 7 天前的照片；再用 `sendCommand` 送「（手機傳來一張圖片：<路徑>，請用 Read 打開來看）」。`/upload` 只收同源 JSON（沿用 `sameOrigin`，不用 multipart：跨站表單送得出 multipart）
  - 已知限制（未處理）：命令一個 session 一格，照片未被收走時再送會蓋掉；一次一張；電腦端面板沒有 📷
- **為什麼**：使用者提案（2026-11-08，本機改過並以 Android＋Tailscale 實測兩張照片）；jacky 核可，保留期限 jacky 定 7 天。改成 export 函式是主管（Office 角色接手）的請求：客製伺服器要沿用同一套檢查；之後改 `sendPhoto` 參數要先跟主管說
- **實測**：`bun test remote` 6 過（新增 1 個：大小、類型、字數、離線都擋、page 用 `/upload`）；用暫存資料夾起 server（port 8799）實打：JPEG → ok、寫出 commands 與 uploads；PNG → `Not a JPEG photo`；multipart → 403；頁面 script 過 `node --check`。手機實機未測
- **commit**：（本版）

## 0.54.1 — 2026-11-08

- **改了什麼**：Remote Control（bridge）開的 session 不再被當成一次性對話：`session.start` 多看環境變數 `CLAUDE_CODE_ENVIRONMENT_KIND`，是 `bridge` 就不標 `oneshot`（`hooks/register.tsx`）
- **為什麼**：使用者回報（2026-11-08，Mac mini＋手機 Claude App 經 Remote Control 開 session）：這種 session 的 `isInteractive` 是 false、`$.session.surfaces()` 是空的、也收不到非 terminal 的 `session.attach`，於是全被標 `oneshot`：辦公室只算人數不畫員工、手機版顯示 0 online、手機送的命令被 `takeCommand()` 跳過、回覆不存。使用者本機改過並實測可用，jacky 核可併入
- **實測**：`claude plugin test .` 203 過（新增 1 個：bridge session 一開始就是員工）；「the cat walks…」第一次跑逾時（5 秒上限、機器忙），重跑 4.8 秒通過，未改它
- **commit**：（本版）

## 0.54.0 — 2026-11-08

- **改了什麼**：第 2 層（小隊卡，`layer: 2`）只放「怎麼做」、不留狀態：
  - `skills/team/roles.md`：卡格式第 2 層不寫 `reports_to`、不寫主管是誰（主管＝開你的人）、不寫上次做了什麼或待辦；接手不讀檢查點，報到寫「等派工單」；§4 加「第 2 層不存檢查點」
  - `skills/team/squad.md`：成員不寫檢查點、不讀 `collab.md`，紀錄只由部門主管寫；專案卡名用 `<組名><角色>`
  - 外掛：持有 `layer: 2` 卡的 session 不提醒存檢查點、`/compact` 不要求摘要、下線不補寫（`isLayer2`）
  - `takeover.py`：第 2 層不印上次檢查點與 collab 摘要，改印「照派工單做，做完交付、回報開你的人就收工」
  - 團隊視窗／Relations：叫小隊的分組改看卡名前綴（willy實作 → willy 組），不再看卡上的「部門主管是 <名>」；被右鍵的人名稱或職稱以組名開頭的，只列那一組
- **為什麼**：jacky 2026-11-08：「第二階層的 role 規則 他們不能紀錄主管 上一次的工作之類的 他們就是用於做好類似的事情……但他們不會有上一次做了什麼 或是還有什麼事情沒有做」；提案核可「照提案做」。studio 那 6 張第 2 層卡由主管清掉 reports_to 與「部門主管是」（jacky 交代）
- **實測**：`claude plugin test .` 202 過（新增 1 個：layer 2 只認 frontmatter）；`takeover.py willy測試` 印「# 第 2 層」、不印檢查點與 collab；真視窗（TW_EVAL，只看選單）：右鍵 Office 角色接手 → 開發小隊 · willy、· 客製兩組；模擬右鍵 willy設計 → 只列 willy 組
- **commit**：（本版）

## 0.53.4 — 2026-11-08

- **改了什麼**：員工桌上的 context 用量條不再蓋住電腦：螢幕往上移到名牌正下方（y+8.6 → y+8），用量條改放在螢幕下面（`nameTag` 多一個 `barAt` 參數，只有員工桌用；主管桌、走動中的名牌照舊）
- **為什麼**：jacky 2026-11-08 看部門主管畫面：「很好就是這樣 用量條擋住電腦了 你可以換一下嗎」
- **實測**：用 drawVector 畫 4 人（主管、部門主管、員工各一、92% 紅條）成 SVG，瀏覽器看：名牌 → 藍色螢幕 → 用量條，三者不重疊；`claude plugin test .` 201 過
- **commit**：（本版）

## 0.53.3 — 2026-11-08

- **改了什麼**：被人開出來的角色認得誰是主管：`open_role.py --team <X>` 與團隊視窗分頁（叫小隊帶 team 時）的開場句加「開你的是 <X>，它是你的主管，有事向它回報」；`skills/team/roles.md` §3 第 5 步改成名單上自己已有 `team` 就以那位為主管，卡上寫的主管不算，沒有 `team` 才照 `collab.md` 找
- **為什麼**：willy實作 2026-11-08 回報接手時把主管答成 willy設計（卡上「部門主管是 willy設計」），實際開它的是 Office 角色接手；根因：開場句沒寫誰開的、roles.md 規定照 collab.md 找主管。提案 A＋B（卡不改：在 studio repo，且有 A、B 後卡上那句當「沒人開你時」的預設），jacky「照 A＋B 做」
- **實測**：`open_role.py --team "Office 角色接手" --dry-run` 開場句帶上那句、preset 照舊；team_window.py 語法檢查過；`claude plugin test .` 201 過；沒真的開新 session
- **commit**：（本版）

## 0.53.2 — 2026-11-08

- **改了什麼**：只有 2 層——小隊成員再叫人，新的人掛部門主管、不掛成員：Relations／團隊視窗右鍵小隊成員（員工、上層是部門主管）時，Summon squad 改以那位部門主管為準（掛 team、開在他的資料夾、✓ 也照他算），選單多一行「Opens under <部門主管>」；`squad.md` §2 第 3 步加「成員要再開人也掛 `team=<部門主管>`」；升部門主管提醒不發給小隊成員（自己的上層已是部門主管就不提醒）
- **為什麼**：0.53.1 實測 willy實作 照 jacky 要求用 `open_role --team willy實作` 開了 willy測試，疊成第 3 層；jacky 2026-11-08：「小隊成員自己叫人時 應該就是你的底下 因為我們的系統只有2層不會出現更多的主管了」
- **實測**：`claude plugin test .` 201 過（升級提醒測試加 2 條：部門主管底下的成員不提醒、頂層主管底下的員工照提醒）；真視窗（TW_EVAL，只看選單、沒開人）右鍵 willy實作 → 「Opens under Office 角色接手」、「1 willy實作✓」
- **commit**：（本版）

## 0.53.1 — 2026-11-08

- **改了什麼**：叫小隊成員時叫的人自動升部門主管、不另外問：`skills/team/squad.md` §2 改成「要開小隊成員就直接升」（使用者叫小隊、從團隊視窗／Relations 叫出成員、或提議開人得到同意都直接升；第 1 步問的是開不開人，不是升不升）；外掛新增升部門主管提醒（`PROMOTE_NOTE`、`shouldRemindPromote`）：還是員工、名單上有人掛 `team=自己` → 下一則指令附一句照 squad.md §2 升，一次（升了或底下沒人就重算）；跟降層提醒對稱
- **為什麼**：0.53.0 實測從 Relations 叫出 willy實作 掛在 Office 底下，但 Office 還是員工，辦公室畫面把它畫在隊伍框外面；jacky 2026-11-08：「如果叫團隊你要自動升級不要我提醒 你改一下skills」
- **實測**：`claude plugin test .` 201 過（新增 1 個：員工底下有人才提醒、只一次、主管不提醒）；Office 角色接手照新規則 `office_profile(role=主管, team=程式碼整理能力評估)`，名單變 manager，willy實作 掛在它底下
- **commit**：（本版）

## 0.53.0 — 2026-11-08

- **改了什麼**：右鍵某人的「Summon squad」改成流水線：依序列出小隊角色（1 實作、2 測試、3 確認），點哪個只開哪個，已掛在這個人底下的標 ✓；成員掛 `team`＝被右鍵的人（Relations 視窗傳 `open_role --team`，團隊視窗分頁寫 `presets/<session id>.json`），開在那個人目前的資料夾，卡上的啟動位置要選（有 `<…>` 佔位）或沒寫就不看、不跳選單、不擋；卡上啟動位置可直接用的才照卡。沒點到人（或點到幽靈主管）就不列小隊。Relations 視窗與團隊視窗同一套（新 API `summon_role`）
- **為什麼**：jacky 2026-11-08 實測叫出客製組小隊後：「人呢我沒有看到他們兩位ㄟ」「而且relation 應該要掛在你下面阿 他們是二階腳色 在哪裡開都可以不會限制 它的是流水線」；提案核可「照提案做」
- **實測**（TW_EVAL，獨立啟動的 Relations 視窗）：右鍵 Office 角色接手 → 列出「開發小隊 · willy設計：1 willy實作、2 willy測試、3 willy確認」與客製設計一組；點 1 → willy實作開在 wiki-studio、辦公室登記 team＝Office 角色接手，再開選單變「1 willy實作✓」；`claude plugin test .` 200 過
- **commit**：（本版）

## 0.52.1 — 2026-11-08

- **改了什麼**：Relations 視窗（`--relations`）的圖照原本大小畫（不再放大撐滿視窗），方框跟著字變寬、名字與職稱全部顯示（團隊視窗照舊 112 寬、9 字截斷、縮放填滿）；視窗大小自動貼合內容（團隊人數變了就跟著變，用 pywebview 的 `resize`），最小 220×120（邊框拖拉與 `set_bounds` 的 640×400 下限只留給團隊視窗）
- **為什麼**：jacky 2026-11-08：「有一些問題字太大了 整體看起來太大很奇怪 然後字要全部顯示」「大小不對」「我拉了一下她就變 640*640 了然後我就動不了了」
- **踩坑**：直接 `SetWindowPos` 改大小會被 WinForms 記著的大小蓋回去（實測 323×231 過幾秒變回 640×400），改用 `window.resize`；`addGrips` 在 `relations` class 加上前就跑，最小值要在拖的當下才判斷
- **實測**（TW_EVAL）：SVG 242 寬、畫出來也是 242，文字沒有「…」；視窗 4 秒與 9 秒都是 258×185（CSS px，DPI 1.25），剛好包住圖、沒有捲軸；從 studio 主管叫客製組小隊：客製實作、客製測試各開一個 PowerShell 視窗在 wiki-studio，客製確認因 `客戶\C003-工程\演練\知識庫` 不存在而回錯誤、不開（跟團隊視窗同規則）
- **commit**：（本版）

## 0.52.0 — 2026-11-08

- **改了什麼**：
  - 新增只有 Relations 的視窗：`team-window/team_window.py --relations`（雙擊 `team-window/start-relations.bat`）。畫面只有團隊視窗的 Relations 圖，右鍵選單照舊（Open role、Summon squad、Close session、空白處開主管）；沒有分頁、不讀寫 `team.json`，叫出的角色各開一個 PowerShell 視窗（`open_role.py`，開在卡的啟動位置），同名同資料夾已在線就不重開
  - `open_role.py` 加 `--card`：沒給 `--kickoff` 時開場句帶角色卡路徑（「你是 X，接手。角色卡：…」，跟團隊視窗分頁同一句）
  - 拿掉 0.51.0／0.51.1 的外掛 Relations 面板（`/office relations`、session 啟動自動開）
- **為什麼**：jacky 2026-11-08 看了外掛面板：「用這一個方式是不是不能如 GUI 那樣叫出工作流程或是 session 呢 如果不行 我們就開一個 GUI 只有 relation 即可」——外掛不能開新的 Claude session（API 只能在本 session 開 subagent），面板做不到右鍵開角色、叫小隊；接著「把 desk 的介面刪除 這是多餘的功能」
- **限制**：跟團隊視窗一樣要手機面板伺服器（8767，`~/.claude/pixel-office/start-remote.bat`）在跑，沒跑時圖的位置寫「Office state unavailable」；點方框不會切到那人的視窗；外掛不能啟動外部程式，所以不會在 session 啟動時自動打開
- **實測**：`claude plugin test .` 200 pass（拿掉面板的 5 個測試）；真視窗（TW_EVAL）：只有 Relations 顯示、辦公室與分頁隱藏、iframe 不載；伺服器沒跑時顯示 unavailable，跑起來畫出在線的主管與員工；`add_tab('office設計')` 在 pixel-office 開出新 PowerShell 視窗，開場句帶卡路徑，新 session 接手時撞角色印 STOP
- **commit**：（本版）

## 0.51.1 — 2026-11-08

- **改了什麼**：Relations 面板在桌面 app 改畫跟團隊視窗 Relations 同一張圖（`relationsSvg`，照抄 `team-window/web/index.html` 的 `drawTrees`／`soloChip`：112×40 圓角框、左上狀態圓點、主管置中在員工上方的曲線連線、不在線主管虛線框、沒團隊的畫成膠囊、自己藍框、名稱用 ListAgents 名稱、超過 9 字截 8 字＋…、同一組配色）；終端機畫不了圖，仍是 0.51.0 的文字樹
- **為什麼**：jacky 2026-11-08 看了 0.51.0：「我要的不是這一種是跟 relation 相同的介面」
- **跟團隊視窗不同的地方**：卡住、出錯的點也畫紅（團隊視窗沒對應顏色，畫成藍）；`team` 也認名牌（團隊視窗只認 ListAgents 名稱）；沒有點分頁、右鍵選單（面板裡沒有分頁可切）
- **實測**：`claude plugin test .` 205 pass（新增 2 個：SVG 內容、桌面畫 Svg）；範例 SVG 在瀏覽器窗格目視
- **commit**：（本版）

## 0.51.0 — 2026-11-08

- **改了什麼**：新增獨立的 Relations 面板（pane id `pixel-office-relations`），只畫團隊樹：`team` 對到主管的 ListAgents 名稱或名牌就掛在底下（部門主管再往下縮排），主管不在線畫成「(offline)」空殼，沒團隊的列在「No team」下；每人一行「名牌 · 職稱 — 狀態」，卡住紅、等核准橘、在做事綠、等輸入淡。每個 session 啟動時自動打開（`claude -p` 不開）；`/office relations` 手動開，`/office relations off|on` 關掉／恢復自動開（存 `$.store`）
- **為什麼**：jacky 2026-11-08：「一般使用會想要看到 relation 的小格子」「我想要他獨立出來 這樣我才可以快速知道我目前的團隊狀況」；原本 Relations 只在團隊視窗左欄，要先叫出團隊視窗才看得到。選方案 A（Claude 裡的面板）而非獨立小視窗：外掛本身不能啟動外部程式，A 只改 `register.tsx`
- **限制**：依 `$.ui.open` 說明，沒人要求時開的面板，終端機要 144 欄以上才畫（不到就先留著不畫）；桌面 app 由畫面自己擺。狀態沒有「等了幾分鐘」，只在名單變動時重畫
- **實測**：`claude plugin test .` 203 pass（新增 3 個：團隊樹含空殼與沒團隊、部門主管縮排與 team 繞圈、`/office relations` 開面板與 on/off）
- **commit**：（本版）

## 0.50.0 — 2026-11-08

- **改了什麼**：接手時自動到角色卡的啟動位置。`takeover.py` 比對卡的啟動位置（卡上沒寫：別處的卡用它所在專案根目錄）與目前資料夾（同資料夾、在它底下、同一主 repo 的 worktree 都算在），不同就只印 `MOVE` 與一行到那裡開新視窗的 `open_role.py` 指令、exit 3；`<角色>` 也認卡上的 `office_name`（`roles.py` 的 `find` 同步）。`open_role.py` 的 `--dir` 省略用卡的啟動位置、`--kickoff` 省略開場句是「你是 <角色>，接手」。`roles.md` §3 加 MOVE 怎麼處理。順手修：啟動位置那行路徑後面接說明（例「`…`（公開 repo…）」）時讀不到、退回成卡所在專案
- **為什麼**：jacky 2026-11-08：「我就是想要自動讓他 在正確的位置啟用」。在別的資料夾說接手，session 搬不了家：讀不到那個 repo 的 `CLAUDE.md`，同名卡（例：兩個專案都有「主管」）會先接到本專案那張
- **實測**：6 種位置跑 `takeover.py`（studio 接 office設計 → MOVE 到 pixel-office；pixel-office 接 office設計 → 照常；studio 接 GUANGUAN → MOVE 到 AEGIVERSE、指令帶 `--role GUANGUAN --title 協作主管`；AEGIVERSE 接 GUANGUAN → 照常、角色換成 主管；studio 接 主管 → 本專案那張；pixel-office 接 主管 → 兩張同名 STOP）；`open_role.py --dry-run` 4 種；真視窗 `open_role.py --role office設計`（不給 `--dir`）開在 pixel-office、名稱 office設計
- **commit**：（本版）

## 0.49.0 — 2026-11-04

- **改了什麼**：名單加 `new tok` 欄＝這個 session 累計用掉的「新 token」（未快取輸入＋寫入快取＋輸出，不含快取讀取），從對話檔 `~/.claude/projects/<資料夾>/<session>.jsonl` 加總（同一則回應依訊息 id 去重、略過子代理的行）。`/office who` 改成依這欄由大到小排（人看的，最花的在最上面）；給模型的 `office_roster` 維持主管在前。每輪結束算一次、最多每分鐘一次、檔案沒變不算；resume 時先把之前的算進來，數字寫進狀態檔（`newTokens`）
- **為什麼**：jacky 2026-11-04：「我想要看的效果就是誰最花 tokens，這樣我就可以對她進行優化」；訂閱制，只看數量不看錢。2026-11-04 實測 12 個 session：快取讀取佔全部的 96～99%，若拿「全部」排名會變成誰回合多誰第一（主管 5,039 萬），「新 token」才反映該優化誰（某員工 88 萬 > 主管 56 萬）
- **限制**：子代理（subagent）自己的用量不在主對話檔裡，沒算進去；`$.fs.read` 不能讀一段，每次整份讀對話檔（數十 MB 約幾十毫秒），所以才限制每分鐘一次
- **實測**：`claude plugin test .` 200 pass（新增 3 個：加總與去重、資料夾名編碼、名單欄與排序）；真視窗（團隊視窗分頁）：新 session 第二輪名單顯示 17k，同一份對話檔用 python 另外加總為 18,966（名單取值後又回了一輪）；重開後的另一個 session resume 時顯示 328k，與先前試算的 32 萬相符。修了一個小錯：session.start 時檔案還不存在，卻已記下節流時間，使第一輪要等 60 秒才算——現在「還沒有值」時不節流
- **commit**：（本版）

## 0.48.1 — 2026-11-04

- **改了什麼**：0.48.0 的 context 條加粗（高 0.5→1.5、寬 6→8.4）、深色外框（跟後面桌上的藍色螢幕分開）、顏色改飽和（<80% 綠、≥80% 黃 `#ffb000`、≥90% 紅 `#e02f3f`），條裡寫百分比，壓縮過加「 ·N」（例「62% ·1」），沒壓縮不標；沒有值照舊不畫
- **為什麼**：jacky 2026-11-04「加粗加數字」。看 0.48.0 示意圖：條太細、顏色偏淡，12% 幾乎看不到，紅色跟名牌下原有藍塊容易混
- **實測**：`claude plugin test .` 通過（顏色門檻、標籤字、有／無壓縮、無值不畫）；Chrome 轉圖看過同一組 hot 93%·1／warn 84%／mid 55%·2／low 12%／none，主管桌 ★ 名牌下也有
- **commit**：（本版）

## 0.48.0 — 2026-11-04

- **改了什麼**：桌面辦公室畫面（`vector.ts`）名牌正下方加 context 細條：灰底、填到 `ctxPct`%；<80% 青、≥80% 黃、≥90% 紅；沒有值（還沒回應、舊版外掛）不畫。員工桌、站著的人、兩種主管桌都有。終端機版（Raster）不動
- **為什麼**：jacky 2026-11-04「桌面進度條ｏｋ」——他平常看的是辦公室畫面，0.47.0 的 ctx 只在 `office_roster`／`/office who`，找不到
- **實測**：`claude plugin test .` 通過（新增 1 個：顏色門檻、填滿比例、沒有值不畫、主管桌與員工桌）；用 Chrome 把 SVG 轉成圖看過：12% 青、55% 青、84% 黃、93% 紅、無值不畫，主管桌 ★ 名牌下也有
- **commit**：（本版）

## 0.47.1 — 2026-11-04

- **改了什麼**：自動檢查點新檔的標題改用角色名（檔名），不用 title（原本 title 是任務名時寫成「# 任務乙 檢查點」）
- **為什麼**：0.47.0 本機實測時發現。同次實測結果：title 改成任務名（≠ 角色卡名）時，下線（`/exit`）仍代寫出自動檢查點
- **實測**：`claude plugin test .` 見 commit；真視窗（團隊視窗分頁、`/exit`）寫出 `checkpoints/<角色>.md` 一筆「自動：下線前沒存」
- **commit**：（本版）

## 0.47.0 — 2026-11-04

- **改了什麼**
  - ① 檢查點的角色對照：`agent`（ListAgents 名稱）或 `title` 任一個對得到 `roles/<名>.md` 就算（agent 優先），找到的角色名快取，之後 title 怎麼改都不丟（`heldRole`、`checkpointFile`）。原本只看 `title`
  - ③ 團隊視窗擋重複分頁：除了比 session 編號，也比「同 `--name`＋同資料夾的在線程序」（`open_role.py` 新增 `sessions_named`）；分頁開著時每 5 秒看程序現在的 session 編號，變了（對話裡下 `/clear`）就寫回 team json 的 `id`，下次 `--resume` 接最新那段
  - ④ 名單加 `ctx` 欄：目前 context 佔比（`$.session.usage()`，每輪結束取）與壓縮次數（`session.compact` 計數，寫在狀態檔、resume 接著算）；`Coworker` 加 `ctxPct`、`compacts`，`parseStatus` 讀得到。不顯示累計 token
- **為什麼**：主管派工、jacky 2026-11-04「做這三件」。① 2026-11-04 讀 6 個角色 session 狀態檔：2 個 title 被改成任務名（例如「收工」「找原檔」），`checkpointFile` 回 undefined，提醒與下線代寫全跳過，agent 欄位卻對得到卡。③ 某分頁的 team json 記 `5b0e6c1e`，程序 `/clear` 後已是 `3d5446f6`，`live_sessions(id)` 比不到。④ 累計 token 多半是快取讀取（一次整理約 55 萬），佔比才決定要不要壓縮
- **不做**：每輪代寫檢查點、桌面進度條（jacky：等 ① 跑一陣子再看）
- **實測**：`claude plugin test .` 196 pass（新增 2 個：`heldRole`、`ctxText` 與名單）；`bun test remote` 5 pass；`sessions_named` 對在線的 office設計 session：同名同資料夾找得到（正反斜線、大小寫不同也行）、別的資料夾與 `since` 在未來都回空。團隊視窗分頁行為（擋第二份、寫回新編號）與真視窗的 ctx 欄沒有自動化測試，待本機安裝後實測
- **commit**：（本版）

## 0.46.0 — 2026-11-02

- **改了什麼**：新增 `scripts/roles.py`，列整台電腦建過的角色卡（`~/.claude.json` 的 projects 換算 `<office>`＋`projects.json`＋小隊；跳過系統暫存夾），`<關鍵字>` 篩、`--path <角色>` 只印路徑。`takeover.py` 本專案沒卡時自動用它（同名多張印 STOP），`office_dir` 拆出 `project_office` 共用。`skills/team/roles.md` §3 第 1 步「卡在別的專案」改指這支（原為手動 glob 上層資料夾，該句先前未 commit）
- **為什麼**：使用者 2026-11-02 要主管開 AS9100pro，卡已搬到 QA-QC，本專案找不到；「我們很有可能會需要搜索電腦中全部建立的腳色」
- **實測**：`roles.py` 列出 21 張（LLM-Wiki-AEGIVERSE 6、wiki-studio 11、QA-QC 1、開發小隊 3），約 3 秒；`takeover.py` 測別專案（AS9100pro）、小隊（實作）、整台都沒有（exit 1）、本專案優先（主管）四種。bun 測試不涵蓋 scripts/，未跑
- **commit**：（本版）

## 0.45.0 — 2026-11-02

- **改了什麼**：`scripts/takeover.py` 接手主管時多印「# 待處理」：collab 在線表、佔用表裡 `[ref]` 都不在線的列，佔用起始超過 7 天的列；非主管角色不印。抽出 `live()` 給 `holders()` 共用
- **為什麼**：使用者 2026-11-02 接手時，摘要照抄 6 個早已離線的「在線」列、兩任前主管 [a1fe38] 的佔用、38 擱 16 天的佔用，主管得自己逐列比對 ListAgents
- **實測**：舊 collab 抓出 6 離線列＋4 佔用（與手動清理一致）；清理後的 collab 無輸出；`GS-1A-AP` 角色不印。bun 測試不涵蓋本腳本，未跑
- **commit**：（本版）

## 0.44.1 — 2026-10-31

- **改了什麼**：牆上時鐘加大（6×1.8 → 8×2.8，字 1.6 → 2.4；放不下 8 寬時縮到「空間−1」、字 1.9），框改銀色加粗；字從紅（夜裡橘）改成招牌的青色（夜裡黃）。多出的高度往員工區掛下來，第一排桌子在牆下 4 以外
- **為什麼**：jacky 2026-10-31：「時鐘改一下 不要是紅色的然後要明顯一點」
- **實測**：`claude plugin test .` 194 pass（含 B1 時鐘不被蓋住）
- **commit**：（本版）

## 0.44.0 — 2026-10-31

- **改了什麼**：團隊視窗搬進 repo（`team-window/`）：`team_window.py`、`web/`（含 xterm 6.0.0 與授權檔）、`start.bat`、`team.example.json`、說明。改兩處：先找同 repo 的 `scripts/open_role.py`；不帶參數且沒有 `team.json` 時從範例建一份。缺 pywebview／pywinpty 時跳視窗說要裝什麼（pythonw 沒有主控台）。`team*.json` 不進 git（範例除外）
- **為什麼**：jacky 2026-10-31：「為什麼他們不能用我們設計的 GUI」——之前只在本機測試資料夾 `pixel-office-測試/團隊視窗/`（不是 git repo），從 GitHub 裝的人拿不到
- **實測**：repo 原位 `plugin_scripts()` 指到本 repo `scripts/`；複製到別處不帶參數會建出 `team.json`；`TW_EVAL` 空隊伍開窗：標題 Pixel Office、xterm 載入、`tabs()` 有回
- **commit**：（本版）

## 0.43.0 — 2026-10-31

- **改了什麼**：每輪固定成本瘦身
  - 系統提示那段從 899 字元縮到 345 字元（ListAgents 自動登記、title、auto、team、找人用 roster、多 session 走 skill；細節在 skill 與工具說明）
  - `office_profile`、`office_roster` 不再強制開場載入（拿掉 `tool.describe` 的 `isDeferred: false`），用到才經 ToolSearch 載入；系統提示寫出工具全名
  - `skills/team/SKILL.md` 的 description 從 450 字元縮到 204 字元
- **為什麼**：jacky 2026-10-31：看外掛哪裡能省 token。API 實測（Sonnet，只回 OK）：不載外掛 25,564 token；載 pixel-office 0.42.0 多 1,198，是所有外掛裡最多的
- **實測**：只回 OK：多 1,198 → 367 token（−69%）；接手 S1 花費中位 $0.0701（0.41.0 時 $0.0755）、升層 S3 $0.0692（多一次 ToolSearch，0.40.0 時 $0.0667），兩個情境都照樣呼叫 office_profile、office_roster，升層照樣建好 collab.md；`claude plugin test .` 194 pass
- **commit**：（本版）

## 0.42.2 — 2026-10-31

- **改了什麼**：信箱改由收件人自己的外掛投遞——每 5 秒看有沒有給自己（名稱或職稱）的信，認領、下一輪確認後用 `$.prompt.submit` 送進自己的對話（閒著也會開始一輪，畫面標明是 pixel-office 送的）；拿掉別的視窗 `$.session.send` 轉交
- **為什麼**：0.42.1 在信裡記下的失敗原因：「The server-side auto mode classifier gave no verdict for SendMessage: the request that produced this action did not ask for one」——auto 模式下，計時器發起的跨視窗送信沒有對應的使用者要求，分類器不放行。改成收件人自己投遞時，commit 被 auto 模式分類器判為繞過；jacky 2026-10-31 裁示採用這個做法
- **commit**：（本版）

## 0.42.1 — 2026-10-31

- **改了什麼**：信箱轉交送不到時，把原因寫進信（`note`），並清掉認領讓別的視窗也能試；`parseMail` 保留 `note`
- **為什麼**：0.42.0 真視窗實測：收件人只剩自己在線時，下一則指令附信可行，對方也回了「收到」；但收件人已經閒著時，寄件視窗每 5 秒認領、送、失敗，一直重複，看不到原因。用 `claude -p` 跑探測外掛：在 `session.start` 用 `$.session.send({ to: { sessionId } })` 和用名稱送都送得到；`-p` 裡 `$.clock.every` 不會觸發，計時器路徑只能在真視窗查
- **commit**：（本版）

## 0.42.0 — 2026-10-31

- **改了什麼**：離線信箱
  - 寄：模型的 `SendMessage` 送不到、原因不是「同名多人／拒收／hook 擋」→ 存 `~/.claude/pixel-office/mail/<時間>-<亂數>.json`（收件名：名稱去掉 [ref]；uds 位址查辦公室狀態檔換成那人的名稱或職稱），SendMessage 的結果後附一段 context 給模型「已存信箱、不用重送或寫 peer-reply」（名稱查無時引擎在 hook 之後才拒收、用自己的字，改 `reason` 模型看不到，API 實測過）；`claude -p` 寄的也存，轉交才排除 oneshot
  - 轉交：每 5 秒，任一個在線視窗看到收件人（`agent` 或 `title`＝收件名）在線 → 先寫認領、下一輪確認還是自己的才 `$.session.send({ to: { sessionId } })`，多視窗只送一次；收件人是自己（例如只剩自己在線）→ 下一則指令附在 context
  - 一天沒人收就作廢；`$.fs` 沒有刪除，送完只把狀態寫成 done
  - `skills/team/SKILL.md` 共通前提改寫
- **為什麼**：jacky 2026-10-31：對方 session 重開就收不到訊息、沒有離線留言（主管回 office設計 失敗：ENOINBOX）。根因：SendMessage 投遞到收件程序的 socket，不落地。API 量測（0.38.0 基準）：送給不在線的人 3 次都退回寫 `peer-reply-*.md`
- **API code review 後修正**（Sonnet，0.52 美元；0.39.0～0.42.0 都還沒發行，一起修在這版）：
  - 自動檢查點：檔案在卻讀不到（被鎖）就不寫，原本會退回只有標題、整檔覆寫洗掉歷史
  - 撞號 `dup`：對方 20 秒沒再寫就解除；`/resume`、`/clear` 換對話後重新偵測（原本設了就清不掉、換對話也不再設）
  - 信箱提示依 SendMessage 的 `to`（去掉 [ref]）對應，一輪平行送多封不會貼錯；收件名不是在線的人、也不是任何 session 的現名或舊名（多半打錯）→ 提示模型確認。🔴 對應要在 `session.send` hook 裡**同步**先記：SendMessage 的結果不等這個 hook 跑完，第一版先掃 458 個狀態檔再記，API 重跑 3 次提示都沒貼上、模型又寫 peer-reply；改成同步後 3 次都貼上（送給不在線花費中位 $0.0408，基準 $0.0454）
  - 信箱讀檔略過超過效期的檔（只增不減，原本每 5 秒全讀）
  - 團隊視窗：被擋時印出 `~/.claude/sessions/<pid>.json`，殘檔或 pid 重用可刪檔解除；log 不再印舊 pid
  - 沒修：`takeOwnMail` 先標 done 才送進指令（指令被取消信就沒了）、認領沒有 compare-and-swap（窄窗口可能重送一次）——前者機率低、後者重送比漏送好
- **待實測**：外掛 `$.session.send` 寄給另一個互動視窗、讓閒著的對方開始一輪——型別文件說會當成 peer 訊息，還沒在真視窗看過
- **實測**：`claude plugin test .` 194 pass（新：存不存信箱、名稱或職稱都收、認領→送→作廢、送不到時存檔）；API（Sonnet 各 3 次）送給不在線：花費中位 $0.0454 → $0.0399、輸入 token 117k → 87k，3 次都不再寫 peer-reply
- **commit**：（本版）

## 0.41.0 — 2026-10-31

- **改了什麼**：檢查點由外掛提醒與兜底（只對持有角色的 session：title 對得到 `<office>/roles/<title>.md`；`claude -p` 不算）
  - 用過工具、距開工或上次存檔滿 60 分鐘 → 下一則指令（使用者或 peer 訊息）附一次提醒（`cpNote`）；存了（檔案 mtime 變新）就重新起算
  - `/compact`（含自動）→ 摘要指示加一句：保留做完／卡在／下一步（`CP_COMPACT_NOTE`）
  - 正常結束（`session.end`）而這段做過事沒存 → 外掛往後加一筆 `## <時間> <名稱>（自動：下線前沒存）`：最後指令、`claude --resume <id>（在 <cwd>）`、下一步「先 resume 讀末段或問主管」；不猜做到哪
  - `scripts/takeover.py`：最後一筆是自動那筆 → 多印一行「先 resume 讀末段」
  - `skills/team/roles.md` §4 加一段說明
- **為什麼**：jacky 2026-10-31：角色常不寫檢查點，全員下線後接不上（studio `checkpoints/` 只有主管、需求維護）。根因：只靠 skill 叫模型寫，收工常是直接關視窗；API 量測另發現模型寫 `.claude/` 會被權限擋，外掛 `$.fs` 寫不經權限
- **限制**：強制結束（關視窗、kill、團隊視窗 terminate）`session.end` 不一定跑，補不到，靠 60 分鐘提醒
- **實測**：`claude plugin test .` 190 pass（新：提醒條件、自動那筆格式、做過事才補且只往後加）；takeover 對自動那筆印提示
- **commit**：（本版）

## 0.40.0 — 2026-10-31

- **改了什麼**：升層時外掛補 `collab.md`
  - `office_profile(role=manager)` 從員工升主管：算出 `<office>`（`officeFor()`，跟 `takeover.py office_dir()`、SKILL.md 同規則：`~/.claude/office/projects.json` 優先，值可相對或絕對，否則 `<主 repo>/.claude/office`）；目錄已在、`collab.md` 不在 → 寫 lead.md §2 六段骨架，主管列填自己（範圍「（待填）」）。目錄不在或 `collab.md` 已有 → 不寫，回覆照舊提示
  - `skills/team/lead.md` §1 第 2 步：外掛已建骨架就只填範圍
  - `scripts/takeover.py`：找不到卡時提示「卡放在別的 repo → projects.json 或 --office」
- **為什麼**：jacky 2026-10-31：studio 有 `.claude/office/` 卻沒有 `collab.md`，接手的人都當「沒有主管」不報到；卡放在別的 repo 時 takeover 要找得到。API 量測（0.38.0 基準）：模型自己寫 `.claude/office/collab.md` 被擋成敏感路徑，3 次全失敗、加 acceptEdits 也一樣；外掛用 `$.fs` 寫不經權限
- **實測**：`claude plugin test .` 187 pass（新：office 目錄規則、骨架六段、升層只在目錄在且沒有 collab.md 時寫）
- **commit**：（本版）

## 0.39.0 — 2026-10-31

- **改了什麼**：同一份對話開在兩個視窗（`--resume` 接到還開著的對話）抓得到了
  - 外掛：原本偵測到撞號只跳一次 toast；現在狀態檔寫 `dup`，名單最上面標 🔴「同一份對話開在兩個視窗」，該視窗下一則指令附提醒（`DUP_NOTE`：停下來請使用者關掉一個）
  - `scripts/open_role.py` 加 `live_sessions(session_id)`：讀 `~/.claude/sessions/*.json` 並確認 pid 還活著（強制結束會留下檔）
  - `scripts/takeover.py`：這份對話同時有兩個活著的程序 → 印 STOP
  - 團隊視窗（外掛外的原型）開分頁前用 `live_sessions` 檢查，已開著就不再 `--resume`，分頁顯示在哪裡開著
- **為什麼**：jacky 2026-10-31：團隊視窗 resume 同一份對話變成兩個分頁、撞角色檢查抓不到。實測兩個 ref 是同一個 session id 的兩個程序；狀態檔以 session id 命名，兩邊輪流覆蓋成一列，`takeover.py` 撞角色又以 session id 排除自己
- **實測**：假的 `~/.claude/sessions`（兩個活 pid＋一個已死 pid、同 session id）→ takeover 印 STOP，只列兩個活的；`claude plugin test .` 185 pass
- **commit**：（本版）

## 0.38.0 — 2026-10-31

- **改了什麼**：`scripts/takeover.py <角色>`（新）—— 接手前置一次印完，不寫檔
  - 角色卡（拿掉註解與 frontmatter）；你的名稱（`CLAUDE_CODE_SESSION_ID` 對 `~/.claude/sessions`），卡有 `office_name` 而不同 → 提醒請使用者 `/rename`
  - 撞角色：辦公室狀態檔裡別的在線 session 職稱＝角色（或卡的 `office_title`）→ 印 STOP
  - `office_profile` 那行（`office_name`／`office_title` 優先）；最後一筆檢查點
  - `collab.md` 只取「主管」「在線」「檔案佔用」三節（標題第一個詞完全相同才算，「主管裁定」不算），引言與分隔列拿掉、每格截 80 字
  - `skills/team/roles.md` §3 加捷徑一句
- **為什麼**：jacky 2026-10-31：主管角色每次載入都花很多 tokens，問能不能簡化或用 py 代替。量 GUANGUAN 10-30 接手（transcript）：開場 62.7k → 接手完 73.7k（+11k、輸出 3k），其中 collab.md 前 48 行 5.4k 字元、找 `role_cards.py` 在哪多跑 2 次 Bash（卡指向已凍結的 llm-wiki）
- **實測**：2026-10-31 在 AEGIVERSE 跑 `takeover.py 主管`：輸出 3,301 字元、一次呼叫（原本讀卡＋Grep＋讀 collab＋2 次找腳本＝5 次）；collab 只印三節，裁定與待辦沒印；卡不存在 → 報錯 exit 1。AEGIVERSE 主管卡接手步驟同日改成只跑這支（vault 那邊的 commit）
- **commit**：（本版）
- **issue**：無

## 0.37.0 — 2026-10-31

- **改了什麼**：`/rename` 之後辦公室跟上（`hooks/register.tsx`，每 5 秒跟 `followSession` 一起跑 `followRename`）
  - 讀 Claude Code 自己的 `~/.claude/sessions/*.json`（`parseCliSession`：現名、`formerNames` 舊名）
  - 自己的 agent 跟現名不同 → 改成現名（以前只有啟動、`/office`、`office_profile` 才更新）
  - 自己的 team 指的名字已沒有 session 在用、卻是某個 session 的舊名 → 改成它的現名（主管只是離線、名字沒換的不動；自己的舊名不算）
- **為什麼**：jacky 2026-10-31：「我改名後 Relations 裡面的 session 沒有改名，反而被納入新的 session」。實際資料：GUANGUAN（原 claim-supervisor-role-handover）改名後，AS9100pro 的 team 還是舊名 → 團隊視窗關係圖長出舊名的空殼節點、AS9100pro 掛在空殼下
- **實測**：2026-10-31 改版前用團隊視窗的「改名測試」團隊（主管＋組員兩個分頁）重現：`/rename` 15 秒後 CLI 名已換、辦公室 agent 還是舊名；再打 `/office` 後主管 agent 換了、組員 team 還指舊名 → 關係圖出現「改名主管測試 (offline)」空殼。`claude plugin test .` 183 過（新 3 個：讀 CLI 檔、改名規則 4 種情況、5 秒後 agent 與 team 都跟上）。改版後（本機裝 0.37.0）同一個測試重跑：`/rename 改名後主管` 15 秒內主管 agent＝改名後主管、組員 team 自動改成改名後主管；關係圖主管顯示新名、組員仍掛在它底下，沒有空殼
- **commit**：（本版）
- **issue**：無

## 0.36.0 — 2026-10-31

- **改了什麼**：外掛提供「開角色視窗」入口，開的時候順便登記辦公室
  - `scripts/open_role.py`（新）：`--role --dir --kickoff [--team --title --plate --plugin-dir --dry-run]`。子程序環境拿掉 `CLAUDE_CODE_CHILD_SESSION`、`ANTHROPIC_API_KEY`；指令用 `-EncodedCommand` 傳（不經 `-Command` 的引號剖析，不必 UTF-8 BOM）；路徑不存在報錯不開；`--dry-run` 只印指令與預設登記
  - 先產生 session id 帶 `--session-id`，寫 `~/.claude/pixel-office/presets/<id>.json`（title＝角色、role=staff、team、名牌）
  - `hooks/register.tsx`：`applyPreset` —— 這個 session 編號沒有任何存過的身分（全新）才讀預設登記檔、經 `applyProfile` 套用；resume 已有存檔，不蓋。agent／ref 本來就由 `selfRegister` 讀 ListAgents 自己填
  - `skills/team/lead.md` §1 第 3 步改叫 `open_role.py`；`roles.md` §3：預先登記的那列是自己、不算撞角色，已登記就跳過第 4 步
  - 團隊視窗（不在本 repo）的 pty 分頁改 import `open_role.child_env`，不再自己寫一份清單
- **為什麼**：jacky 2026-10-31 同意（willy主管辦公室派工）：健康檢查 14 天裡手組 `Start-Process powershell` 開角色 53 次，只有 wiki-studio 有一支臨時腳本（`ops/開角色.ps1`）；開場檔每次都要寫「開工先登記辦公室」一段
- **實測**：2026-10-31 `claude plugin test .` 180 過（新 3 個：預設檔欄位過濾、全新 session 套用、resume 不蓋）；`--dry-run` 跑含單雙引號與中文的角色名（引號照原樣進 `--name`）、不存在的路徑（報錯、exit 1）。本機裝 0.36.0 後開真視窗（父程序故意設 `CLAUDE_CODE_CHILD_SESSION=1`）：`~/.claude/sessions/<pid>.json` 照常寫出、ListAgents 列出「開角色測試 [aa09cb]」；辦公室狀態檔一啟動就是 名牌 rtest／職稱 開角色測試／team office設計／role staff，agent、ref 由 selfRegister 填上。用團隊視窗的 Close session 關掉：claude、`-EncodedCommand` 的 PowerShell 視窗、sessions 殘檔都清掉
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
