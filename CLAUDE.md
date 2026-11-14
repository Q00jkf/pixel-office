# pixel-office — 原始碼地圖

使用說明：`README.md`（英文簡介）、`README.zh-TW.md`（中文簡介）、`docs/使用說明.md`（完整）；這份只回答：**要改的東西在哪個檔**。
2026-10-29 從 llm-wiki-plugin 搬出來（那邊凍結、archive）。

🔴 **不要改 cache**：`~/.claude/plugins/cache/pixel-office/pixel-office/<版本>/` 是安裝後的產物，改了會被下次 `/plugin update` 蓋掉。一律改這個 repo。

| 我要改… | 檔 |
|---|---|
| hook、MCP 工具（`office_profile`／`office_roster`／`office_meeting`）、`/office` 指令、名單輸出 | `hooks/register.tsx` —— **全部邏輯都在這一支** |
| 像素畫、座位配置、走路路徑、貓（終端機版） | `hooks/scene.ts` |
| Desktop 畫面長相（素材圖、名牌、泡泡） | `hooks/vector.ts`；素材表由 `assets/build_sheet.py` 產生 `assets/office-sheet.png`＋`hooks/sheet.ts`（不要手改 sheet.ts） |
| `Coworker` 等型別 | `types/index.d.ts` ← **不在 `hooks/` 裡** |
| 多 session 協作（分層、派工、開會、小隊） | `skills/team/`（`SKILL.md` 路由，其餘按需讀） |
| 接手角色一次印完要讀的（卡、身分、撞角色、檢查點、collab 三節） | `scripts/takeover.py`（`--help`） |
| 找整台電腦建過的角色卡 | `scripts/roles.py`（`--help`） |
| 開角色視窗（一個角色一個 PowerShell 視窗）、團隊視窗共用的環境變數清單 | `scripts/open_role.py`（`--help`）；預先登記由 `register.tsx` 的 `applyPreset` 套用 |
| 團隊視窗（一個團隊一個視窗、每個角色一個分頁，pywebview＋pywinpty，只有 Windows） | `team-window/team_window.py`（後端）、`team-window/web/index.html`（畫面）；設定 `team.json` 不進 git，範例 `team.example.json`；`--relations`（`start-relations.bat`）＝只有 Relations 的視窗，同一支程式 |
| 手機面板（本機 8767） | `remote/server.ts`（獨立 bun 程序，不經 plugin 安裝） |
| Antigravity CLI（agy）那一半 | `agy/`（本身是 agy 外掛；`agy_office.py` 一支包 hook、MCP、安裝） |
| 版本號、marketplace | `.claude-plugin/plugin.json`、`.claude-plugin/marketplace.json` |
| 測試 | `hooks/office.test.tsx`、`hooks/vector.test.tsx`；`remote/*.spec.ts` |

## 🔴 不能動的對外名稱

- **plugin 名 `pixel-office`**：MCP 工具名 `mcp__pixel-office__*`、skill `pixel-office:team` 都靠它
- **`skills/team/lead.md` 的 §1～§5 不要重編號**：凍結的 llm-wiki（`wiki-collabteam`）用「`lead.md` §N」指進來，還在用 llm-wiki 的 vault 會指到錯段。要加段往後加
- 辦公室資料夾 `~/.claude/pixel-office/` 的檔案格式：新舊版本、agy 那一半、手機面板都讀同一份

## 改完要做的

1. 只跑相關測試：`claude plugin test .`（bun；不是 python）；動到 `remote/` 加 `bun test remote`
2. 改了行為就 bump：`.claude-plugin/plugin.json` 的 `version` 與 `hooks/register.tsx` 的 `VERSION` **兩處一起改**（升版提醒、`/office version` 靠後者；測試讀不到 json，沒有自動比對），**同一個 commit** 寫 `CHANGELOG.md`，含「升級要做的」（沒有寫「無」）
3. commit 用自己的 session 名當 author：`git -c user.name="<短代號>" commit ...`
4. 發行（push 前先請示）：`git push`，再 `claude plugin tag . --push`（打 `pixel-office--v<版號>` 並推上去，順便驗 plugin.json 與 marketplace 一致；先 `--dry-run`）
5. **push 完立刻**讓本機生效，不要留到下次：`claude plugin marketplace update pixel-office`、`claude plugin update pixel-office@pixel-office --scope user`（不帶 `--scope` 可能只更新到某個資料夾的 local 安裝），再看 `~/.claude/plugins/installed_plugins.json` 裡 user scope 的 `version`＝plugin.json。🔴 不要用 `claude plugin list` 確認：來源是本機資料夾時它顯示 repo 的版號，不是裝上的（2026-11-14：它顯示 0.61.0，實際 user scope 還是 0.55.1）。動到 `codex/`、`agy/` 的照 CHANGELOG 重裝。請使用者重開在用 team skill 的視窗（開著的照舊是舊版）。2026-11-14 查到本機停在 0.55.1、repo 已到 0.59.0：這步漏了四版

## 踩坑

- **2026-10-08 Python 印中文炸掉**：stdout 預設 cp950，腳本開頭加 `sys.stdout.reconfigure(encoding='utf-8')`
- **2026-10-29 `build_sheet.py` 沒有 `__main__` 守衛**：被 import 就會重產素材表
- **2026-10-29 agy 外掛裝不上**：任何 agy 視窗開著時，外掛資料夾被它的 MCP 程序佔住，`agy plugin install` 失敗
- **2026-11-14 同版號 `claude plugin update` 不會重新複製**：還沒發行、版號沒動又改了程式，要 `claude plugin uninstall pixel-office@pixel-office --scope user` 再 `install`，cache 才會是新的
