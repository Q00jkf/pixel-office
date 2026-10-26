# Design: 像素辦公室變控制塔（點人核准、向量高清、手機版）

照 gstack 的 office-hours（Builder 模式）流程手動跑，2026-10-26；gstack 沒安裝，讀 `~/.aaproject/gstack/office-hours/` 的 SKILL.md 照做
Repo: Q00jkf/llm-wiki-plugin（`plugins/pixel-office/`，基準 0.10.5）
Status: DRAFT
Mode: Builder（jacky 選「自己用得爽」）

## Problem Statement

起因是 jacky 在 IG 看到 [Coucou](https://github.com/Louis-CFM/coucou)（MacBook 瀏海裡的 Mochi，盯 Claude Code、鎖定畫面核准），覺得我們的辦公室「有點模糊」，也只能看不能操作。

- **模糊的根因**（2026-10-26 讀 0.10.5 原始碼）：不是放大時被平滑化（SVG 已設 `crispEdges`），是解析度本身太小。整間辦公室最寬 112 × 約 88 像素（`scene.ts:3-4`），一個人 7 × 5 像素（`scene.ts:500` `person()`）；終端機每格用「▀」只能畫 1 × 2 像素（`encode()`），Desktop 把同一張點陣圖放大 8 倍（`encodeSvg()`）。
- **只能看**：有人 `waiting` 時，辦公室只會舉手＋跳 toast（`register.tsx:755` `tool.check`），還是要切回那個視窗才能按允許。

## What Makes This Cool

- 有人卡在等核准時，**他拿著一張紙走到主管室門口**，頭上冒「？」；你點他就看到要跑的指令和 Allow／Deny，按完他走回座位繼續打字。Coucou 最紅的功能，換成辦公室劇情來演。
- Desktop 上的人有臉、有表情（思考時眼睛往上飄、出錯冒汗、完成跳起來），不再是 7 × 5 的色塊。
- 離開電腦時，手機上看得到**同一間辦公室**，有人等你就推播。

## Constraints

- **Windows Terminal 畫不了圖**：mod 的 `Image` 元素只在支援圖片協定的終端機（kitty、Ghostty）畫得出來，其他只顯示 `alt`（`.claude-plugin/types/claude-code/index.d.ts` `ImageProps`）。jacky 用的是 Windows Terminal（`WT_SESSION` 有值）。
- **Windows 終端機不會出聲**：`$.audio` 在 Linux／Windows 終端機「沒有播放器，什麼都不播」（同檔 `audio` 節）。Desktop 能不能出聲沒寫，要實測。
- **Desktop Svg 上限 131072 字元**（`scene.ts` `SVG_MAX`）；向量圖形比點陣路徑小，應該更容易壓進上限。
- 各 session 彼此不相通，只靠共用資料夾 `~/.claude/pixel-office/sessions/*.json` 交換狀態（`register.tsx:320` `publish`）。
- repo 規則：改 `plugins/pixel-office/`，不改 cache；`register.tsx` 放全部邏輯，`scene.ts` 放畫圖，型別在 `types/index.d.ts`。

## Premises（jacky 2026-10-26 都同意）

1. **點人核准最優先，畫質第二**。核准等於「一個視窗替另一個 session 按允許」，所以要有限制：只給 Allow／Deny（**不給 Always**）、指令全文顯示才能按、原視窗的詢問照常保留。
2. **一份向量場景、兩種輸出**：Desktop 用 SVG 高清；支援圖片的終端機用 PNG；Windows Terminal 退回現在的像素風。
3. **推播自己設計**：選方案 A（手機版辦公室 PWA），不用現成的 Telegram／ntfy。
4. **手機先不能核准**：遠端放行電腦上的指令要另外設計驗證，第 3 期只做「看＋通知」。
5. **多主管**（jacky 2026-10-26 加進這次改版）：辦公室和協作流程都要改；每位主管帶一區；核准一律走到 **jacky 的櫃台**，不走到 AI 主管那裡，因為按核准的永遠是人。

## Approaches Considered

推播管道三選一（其他部分沒有分歧）：

- **A. 手機版辦公室 PWA ＋ Web Push**（選這個）：手機網頁顯示同一間辦公室（沿用第 2 期的向量 SVG），有人等你時經 Cloudflare Worker 送 Web Push；Coucou 的 `relay/` 也是無狀態 Worker。
- B. 借用小秘書的 email 提醒：最快做完，但 email 慢，而且會把開發工具和要交付給客戶的產品混在一起。不選。
- C. 自建 LINE 官方帳號推訊息：哇感中等，免費額度有月上限（確切數字沒查）。不選。

## Recommended Approach

分四期，每期都能單獨用。多主管排在核准前面，因為兩者都要改平面圖（櫃台、多張主管桌），一起改才不會改兩次。

### 第 0 期：多主管＋櫃台（已實作：pixel-office 0.12.0／llm-wiki 1.14.0，2026-10-26）

現況：單一主管寫死在 `scene.ts:118`（主管室一張桌）、`:171`（`crew.find` 只取第一個主管，第二個被排去員工座位）、`:989`（TEAM 地毯只掛第一個主管）；`isPeer`（`:181`）已經用 Set，但所有 peer 擠同一欄。協作流程 `skills/wiki-collabteam/collab.md:45` 只有一格「目前主管」。

- **辦公室**：主管室放 2～3 張主管桌（超過就在名牌前面加 `+N`）；每位主管的 peer 坐一個座位群，地毯掛「TEAM <主管名牌>」，各主管換一種地毯顏色；沒有 team 的人坐一般區。
- **櫃台**：大門旁新增 jacky 的櫃台，第 1 期核准時大家拿紙來這裡排隊。
- **協作流程**：coordination 的「目前主管」改成「主管名單」（主管、負責範圍、peer）；派工與撞檔仲裁照「檔案歸哪位主管的範圍」決定，跨範圍的交給 jacky。細節在 eng review 讀完 `collab.md` 與 `01-`～`07-` 再定。
- 樣板要跟著改（`templates/vault/` 的 coordination 表頭），不然舊 vault 偵測不到（repo `CLAUDE.md`「skill 要求 vault 做某件事時，要讓樣板看得見」）。

### 第 1 期：點人核准（已實作：pixel-office 0.13.0，2026-10-26；Open Q2 待實機）

```
session X（要跑指令）                    共用資料夾                     任何一個開著辦公室的視窗
classic.PermissionRequest 觸發 ──寫──> approvals/<X>.json            辦公室畫出「X 拿紙走到櫃台」
  { toolUseId, tool, input, nonce }      （tool、完整 input、nonce）  點 X → 顯示指令全文＋Allow／Deny
  每 300ms 讀一次 decisions/<X>.json <──寫── { toolUseId, nonce, allow|deny }
  比對 toolUseId＋nonce 才採用 → 回 { behavior }，清掉兩個檔
  逾時／辦公室沒開 → 不回答，交回原本的終端機詢問
```

- 只採用跟「正在等的那一筆」一模一樣的決定（`toolUseId`＋隨機 `nonce`），Coucou 也這樣做（「your Mac only applies a decision meant for the exact request it is waiting on」）。
- 不給 Always：`updatedPermissions` 永遠不送。
- 指令太長，面板放不下全文 → 只給 Deny 和「回終端機按」。
- 走路動畫沿用現有 `errand`／`walkerPos`（紙飛機、送信已經有走路路徑）。

### 第 2 期：向量場景（已實作 Desktop：pixel-office 0.14.0，2026-10-26）

- 新增 `vector.ts`：輸入同一份 `crew`＋座位（`assignSeats`），輸出「形狀清單」（圓、圓角矩形、路徑、文字）。
- Desktop：形狀清單 → SVG，取代 `encodeSvg` 的點陣路徑；名牌可以用中文。
- 支援圖片的終端機：同一份形狀清單 → 點陣化成 PNG，交給 `Image`。**之後再做**（0.14.0 沒做）。
- Windows Terminal：維持 `drawScene`＋`encode`，不動。
- 人物：圓頭、兩顆眼睛（看向游標或螢幕）、依 `mode` 換表情；`done` 跳一下。0.14.0 做的：thinking 眼睛往上、error 冒汗發抖、done 跳一下、waiting 頭上問號、idle 眨眼；「看向游標」沒做。

### 第 3 期：手機版辦公室

- 一個 Cloudflare Worker：收「有人等你」事件、存訂閱、送 Web Push（VAPID）；只看得到名牌、mode、tool 名稱，不送指令內容。
- 手機頁：PWA，畫第 2 期的 SVG；iPhone 要先「加到主畫面」才收得到推播。
- 誰送事件：辦公室偵測到 `waiting` 超過 N 秒（現有 `trackEvents` 那段）就 POST 給 Worker。
- 音效放這一期，做在 Desktop／手機頁。

## Open Questions

1. ~~`classic.PermissionRequest` 在 mod 裡會不會觸發？~~ **會**（2026-10-26 spike：`tool.check` 判定 ask 後 71ms 觸發，拿得到完整 `tool_input` 與 2 筆 `permission_suggestions`；log 在 scratchpad `perm-spike/spike.log`）。
2. ~~hook 掛著時原詢問會不會先出現？~~ **會，兩邊同時進行**（2026-10-26 spike 第二輪：hook 拖 8 秒，jacky 在第 7.2 秒按終端機 Yes，`PostToolUse` 比 hook 交回早 0.8 秒）。所以終端機先按時，辦公室要靠 `PostToolUse`／`PermissionDenied` 清掉那張單。**還沒測：hook 先回答時，終端機的詢問框會不會自己消失**（第三輪）。
7. 用 `--plugin-dir` 開的 spike session 跟本 session 在 ListAgents **互相看不到**，SendMessage 也送不到（2026-10-26 試 4 次；工作資料夾從 Temp 改到 hub 也一樣）。嫌疑：`--plugin-dir` 或權限模式不同（spike 是 default、本 session 是 auto）。第 1 期走共用檔案，不受影響。
3. 同時好幾個人在等時，櫃台前怎麼排隊？
4. Desktop App 的 `$.audio` 能不能出聲？
5. WezTerm（Windows 版）能不能畫 `Image`？能的話，jacky 換終端機 CLI 也有高清。
6. Worker 要放 jacky 自己的 Cloudflare 帳號；VAPID 私鑰放哪（不能進 repo）。

## Success Criteria

- 第 1 期：在 A 視窗開辦公室，B 視窗要跑 Bash 時，A 看得到 B 走到門口；點 B 看得到完整指令，按 Allow 後 B 繼續、按 Deny 後 B 收到拒絕；A 沒開時 B 照常在終端機問，不會卡住。有測試涵蓋 nonce 不符、逾時、檔案殘留。
- 第 2 期：Desktop 上人有眼睛和表情，放大不糊；SVG 在 `SVG_MAX` 內；Windows Terminal 畫面跟 0.10.5 一樣。
- 第 3 期：電腦鎖住後，有人等超過 N 秒，手機在 1 分鐘內收到推播，點開看到辦公室。

## Distribution Plan

沿用現有管道：改 `plugins/pixel-office/`，升版號（`.claude-plugin/plugin.json`），`/plugin update` 拿到。第 3 期的 Worker 另外部署，手機頁放 Worker 或 GitHub Pages。

## Next Steps

1. ~~spike~~：已做，事件會觸發；剩「原詢問何時出現」待確認
2. gstack 的 plan-eng-review 審第 0＋1 期 → 實作＋測試（`office.test.tsx`）
3. 第 2 期：`vector.ts`＋人物設計 → Desktop 換上
4. 第 3 期：Worker＋PWA

## What I noticed about how you think

- 看到 Coucou 你第一句問的是「他是怎麼做到的」，不是「我要裝」：先拆機制，再決定要不要學。
- 給四個選項你全選，還追問「CLI 無法有高清嗎」：不接受「這裡做不到」，要先知道限制真的在哪。
- 推播不選現成的 Telegram，問「我們可以自己設計嗎」：寧願多做一點，也要整套體驗是自己的。
