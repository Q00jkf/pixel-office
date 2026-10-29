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
2. 改了行為就 bump `.claude-plugin/plugin.json`，**同一個 commit** 寫 `CHANGELOG.md`
3. commit 用自己的 session 名當 author：`git -c user.name="<短代號>" commit ...`
4. 本機生效：`claude plugin marketplace update pixel-office`、`claude plugin update pixel-office@pixel-office`；agy 那一半要關掉所有 agy 視窗再跑 `agy_office.py install`

## 踩坑

- **2026-10-08 Python 印中文炸掉**：stdout 預設 cp950，腳本開頭加 `sys.stdout.reconfigure(encoding='utf-8')`
- **2026-10-29 `build_sheet.py` 沒有 `__main__` 守衛**：被 import 就會重產素材表
- **2026-10-29 agy 外掛裝不上**：任何 agy 視窗開著時，外掛資料夾被它的 MCP 程序佔住，`agy plugin install` 失敗
