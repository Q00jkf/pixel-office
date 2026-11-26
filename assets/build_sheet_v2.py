"""v2 美術縮小成 Desktop 面板用的一張素材表（2026-11-22）。

Desktop 面板的 Svg 元素原始碼上限 131072 字元（scene.ts SVG_MAX），手機版 remote/v2/assets/ 那 25 MB 的圖放不進去：
挑面板要用的幾張、照場景裡的大小（「格」，一張 4 人桌約 78 格寬）乘上 R 像素縮小、量化成 256 色，排成一張 PNG。
輸出：
  assets/office-v2-sheet.png    素材表（給人看、除錯用）
  hooks/sheetV2.ts              base64 素材表＋每張圖在表上的位置（像素）與在場景裡的大小（格）＋桌子幾何（格）

用法（要 Pillow）：python assets/build_sheet_v2.py [R] [repo 資料夾] [人物倍率]    R＝每格幾像素，預設 1.2；repo 預設是這支程式的上一層；
人物倍率＝角色坐姿／打字圖用 R 的幾倍（美術 A #7：面板上臉看不清，人物單獨提高；預設 CHAR_K）
"""
import base64
import io
import json
import sys
from pathlib import Path

from PIL import Image

ROOT = Path(sys.argv[2]).resolve() if len(sys.argv) > 2 else Path(__file__).resolve().parent.parent
SRC = ROOT / "remote" / "v2" / "assets"
# 美術 A #7（2026-11-25）：面板的人物（full_*）用 R 的幾倍。整張表受 SVG_MAX（131072 字元）限制提不高，只把人物提高，家具照舊；
# 面板照每張圖在表上的框（viewBox）和場景大小畫，錨點是格，所以倍率不同也對得上
CHAR_K = 1.45  # 人物 1.2×1.45≈1.74 px／格：臉看得清楚
TABLE_K = 0.7   # 桌子（tables_geom 裡的、含 _over）1.2×0.7≈0.84：面積最大、細節少，降一點換人物的空間；其他家具維持 1.2
# 整張 base64 不超過原本全部 1.2 時的 66,484 字元（審查 ②：60 人＋通知也不能比舊版更早超過 SVG_MAX；hooks/v2panel.test.ts 有預算測試）


def main():
    R = float(sys.argv[1]) if len(sys.argv) > 1 else 1.2
    CK = float(sys.argv[3]) if len(sys.argv) > 3 else CHAR_K
    M = json.loads((SRC / "manifest.json").read_text(encoding="utf-8"))
    G = M["tables_geom"]

    # 跟 remote/v2/scene.js 同一套換算：4 人桌（舊拼接版）一欄 395 px、整張 1038 px＝80 格 → 座位間距 30.44 格
    U = 80 / 1038
    STD = 395 * U

    def table_u(name):
        g = G[name]
        if len(g["cols"]) >= 2:
            c = g["cols"]
            return STD / ((c[-1]["cx"] - c[0]["cx"]) / (len(c) - 1))
        # 只有一欄（2 人桌）：筆電背蓋跟 4 人桌一樣寬
        lw = lambda c: c["lid"][2] - c["lid"][0]
        return lw(G["ctable4"]["cols"][0]) * table_u("ctable4") / lw(g["cols"][0])

    SIT_H = 25.5
    want = {}  # 名字 → 場景裡的寬（格）；高照原圖比例
    crop = {}  # 新規格角色：名字 → (裁掉透明邊的框, 每格幾 px)；面板照腳底錨點放（V2_ANCHOR）

    # 新規格（畫布 448×512、1 格＝12.8 px、腳底 (224,500)；assets 存一半 224×256）：坐、打字，正背兩面；裁掉透明邊省素材表空間
    # 舊規格（158×302 那批）：照坐高 SIT_H 縮，打字用 sit_1、sit_2
    is_new = lambda n: n in M and M[n]["w"] * 512 == M[n]["h"] * 448
    for sp in ["claude", "chatgpt", "gemini", "deepseek"]:
        if is_new(f"full_{sp}_down_sit_0"):
            # 面板字元上限（SVG_MAX 131072）放不下四格×正背：只放正面打字 0、2 兩格（背面打字在面板上被椅背擋住）
            for f in ["down_sit_0", "up_sit_0", "down_type_0", "down_type_2"]:
                n = f"full_{sp}_{f}"
                if n not in M:
                    continue
                ppu = 12.8 * M[n]["w"] / 448
                with Image.open(SRC / f"{n}.png") as im:
                    box = im.convert("RGBA").getbbox()
                crop[n] = (box, ppu)
                want[n] = (box[2] - box[0]) / ppu
            continue
        for f in ["down_sit_0", "down_sit_1", "down_sit_2", "up_sit_0"]:
            n = f"full_{sp}_{f}"
            if n in M:
                want[n] = SIT_H * M[n]["w"] / M[n]["h"]
    geom = {}
    for name in G:
        u = table_u(name)
        geom[name] = {"u": u, "w": G[name]["w"] * u, "h": G[name]["h"] * u, "desk_top": G[name].get("desk_top"), "cols": G[name]["cols"]}
        want[name] = G[name]["w"] * u
        want[name + "_over"] = G[name]["w"] * u
    u4 = table_u("ctable4")
    want["chair_back"] = 208 * u4
    if "far_chair" not in M:  # 有遠側獨立椅子就用不到舊主管椅
        want["boss_chair"] = 352 * u4
    # 遠側獨立椅子（2026-11-24）：352×352 畫布照 4 人桌原圖比例；ink＝圖最左邊不透明那一欄（主管進出、泡泡避開用）
    ink = {}
    for n in ["far_chair", "boss_chair_front"]:
        if n in M:
            want[n] = 352 * u4
            with Image.open(SRC / f"{n}.png") as im:
                ink[n] = im.convert("RGBA").getbbox()[0] * 352 / im.width
    for sp in ["claude", "chatgpt", "gemini", "deepseek"]:
        want[f"logo_{sp}"] = 208 * u4 * 0.3
    for n in ["icon_hand", "icon_think", "icon_book", "icon_done", "icon_error"]:
        want[n] = 10
    # 家具（擺設）：跟手機版 decor() 一樣大
    for n, w in [("meeting", 56), ("bookshelf", 26), ("window_day", 32), ("window_night", 32), ("clock", 8), ("calendar", 9),
                 ("copier", 20), ("mailbox", 11), ("vending", 20), ("plant", 26), ("hydrangea", 14),
                 ("credenza", 44), ("runner", 80),
                 ("sofa_set", 44), ("water_cooler", 13), ("whiteboard", 32), ("floor_lamp", 11),
                 ("ui_icon_pencil", 10), ("ui_icon_alarm", 10), ("ui_icon_warn", 10), ("ui_icon_hourglass", 10)]:
        want[n] = w
    want["floor_tile"] = 72
    want["wall_tile"] = 40 * 435 / 160

    tiles = []
    for name, wg in want.items():
        p = SRC / f"{name}.png"
        if not p.exists():
            print("缺", name)
            continue
        im = Image.open(p).convert("RGBA")
        if name in crop:
            im = im.crop(crop[name][0])
        hg = wg * im.height / im.width
        r = R * (CK if name.startswith("full_") else TABLE_K if name in G or name.removesuffix("_over") in G else 1)
        pw, ph = max(1, round(wg * r)), max(1, round(hg * r))
        tiles.append((name, im.resize((pw, ph), Image.LANCZOS), wg, hg))

    # 排版：照高度排，一列一列放（寬 512）
    tiles.sort(key=lambda t: -t[1].height)
    W, x, y, rowh, pos = 512, 0, 0, 0, {}
    for name, im, wg, hg in tiles:
        if x + im.width > W:
            x, y, rowh = 0, y + rowh + 1, 0
        pos[name] = (x, y, im.width, im.height, round(wg, 3), round(hg, 3))
        x += im.width + 1
        rowh = max(rowh, im.height)
    H = y + rowh
    sheet = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    for name, im, *_ in tiles:
        sheet.paste(im, pos[name][:2])
    q = sheet.quantize(colors=255, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    buf = io.BytesIO()
    q.save(buf, "PNG", optimize=True)
    data = buf.getvalue()
    (ROOT / "assets" / "office-v2-sheet.png").write_bytes(data)
    b64 = base64.b64encode(data).decode()

    rects = {k: list(v) for k, v in sorted(pos.items())}
    # 腳底錨點在存檔圖上是 (224, 500) × 存檔縮放（ppu ÷ 12.8）
    anchor = {n: [round((b[0] - 224 * ppu / 12.8) / ppu, 3), round((b[1] - 500 * ppu / 12.8) / ppu, 3)] for n, (b, ppu) in sorted(crop.items())}
    out = [
        "// 自動產生（assets/build_sheet_v2.py），不要手改：v2 美術縮小成 Desktop 面板用的一張素材表",
        f"// R＝{R} 像素／格（人物 ×{CK}、桌子 ×{TABLE_K}）；{W}×{H}，{len(data)} bytes",
        f"export const V2_SHEET_W = {W}",
        f"export const V2_SHEET_H = {H}",
        f"export const V2_SHEET_PNG = '{b64}'",
        "/** 名字 → [表上 x, y, w, h（像素）, 場景寬, 場景高（格）] */",
        f"export const V2_SPRITES: Record<string, [number, number, number, number, number, number]> = {json.dumps(rects, ensure_ascii=False)}",
        "/** 專用桌子圖：u＝原圖 1 像素幾格；w、h（格）；cols＝原圖上每一欄的背蓋（lid）、螢幕（scr）、中心（cx）、近側椅子上下緣（原圖像素） */",
        "/** 新規格角色：名字 → [裁切框左上角相對腳底的位置 dx, dy（格）]；坐姿的腳底＝座位的腳底線 */",
        f"export const V2_ANCHOR: Record<string, [number, number]> = {json.dumps(anchor, ensure_ascii=False)}",
        "/** 遠側椅子圖最左邊不透明的位置（352 畫布 px） */",
        f"export const V2_INK_LEFT: Record<string, number> = {json.dumps({k: round(v, 2) for k, v in ink.items()})}",
        f"export const V2_TABLES: Record<string, {{ u: number; w: number; h: number; desk_top?: number; cols: {{ lid: number[]; cx: number; scr?: number[]; chair_top?: number; chair_bottom?: number }}[] }}> = {json.dumps(geom, ensure_ascii=False)}",
        "",
    ]
    (ROOT / "hooks" / "sheetV2.ts").write_text("\n".join(out), encoding="utf-8")
    print(f"R={R}: {W}x{H}, {len(data)} bytes, base64 {len(b64)} chars, {len(tiles)} sprites")


if __name__ == "__main__":
    main()
