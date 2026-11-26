"""Codex 生的像素風插圖（約 1254 px）→ 可用素材：對格、減色、照現有素材的密度放大（2026-11-25，第 5 件②）。

兩層：
  1. 來源格：Codex 的圖「看起來」是像素畫，一格約 9～27 px、格邊有柔化。自動偵測格寬與偏移，每格取中位色 → 真正的低解析像素圖。
     偵測不到明顯的格就停下來，請人用 --cell 指定（不猜）。
  2. 目標：大小照場景寬（--units 格）× 參考素材的密度（px／格，從 --like 那幾張推）；配色照參考素材抽的調色盤。
     預設最近鄰「整數倍」放大，格子銳利；--soft 改成平滑縮小（像現有那批 AI 圖縮小的素材）。

預設（顧問 2026-11-25 定）：平滑版、格寬＝「一格＝目標 1 像素」（原圖寬 ÷ 目標寬）。理由：跟現有素材質感一致、細的描邊不會被蓋掉。
要銳利版：加 --crisp；要對齊原圖的像素格：--cell auto（偵測）或 --cell N。

用法（要 pillow、imagequant、numpy；裝法見 assets/quantize.py 檔頭，多裝 numpy）：
    python assets/snap_pixel.py 輸入.png --name 素材名 --units 26 --like plant,copier [--colors 48]
                                [--out 資料夾] [--preview 預覽檔名] [--crisp] [--cell target|auto|N]
  --like    參考的現有素材名（remote/v2/assets/<名>.png，要在下面 UNITS 表裡）：抽調色盤、推 px／格
  --colors  調色盤幾色（預設 48）
  --out     輸出資料夾（預設 shots/art-post/；確認過才放進 remote/v2/assets/）
  --preview 對照圖的檔名（只收檔名，寫在 --out 底下）：原圖縮小／對格（銳利）／平滑，三欄並排，旁邊放參考素材同比例
  --name、--preview 只收英數字和 _ . -；兩個輸出都在 --out 底下、不跟隨符號連結、不跟輸入或彼此同檔（審查 ①）
  --units 0～200、--cell 0.5～256、--colors 2～256；輸出上限 4096×4096 像素
  --crisp   主要輸出改用銳利版（最近鄰整數倍放大）；預設是平滑版
  --cell    來源格寬：target＝一格等於目標 1 像素（預設）；auto＝偵測原圖的像素格（偵測不到就停下、給建議值，不猜）；N＝指定幾 px
  --soft    舊參數，現在就是預設，留著相容
輸出：<out>/<name>.png（256 色以內的調色盤 PNG），印出格寬、格數、輸出尺寸、用了幾色
"""
import argparse
import io
import os
import sys

sys.stdout.reconfigure(encoding='utf-8')

try:
    import imagequant
    import numpy as np
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit('要先裝 pillow、imagequant、numpy（見檔頭用法）')

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
ASSETS = os.path.join(ROOT, 'remote', 'v2', 'assets')

# 現有家具在場景裡的寬（格）：跟 remote/v2/scene.js decor()／lounge()、assets/build_sheet_v2.py 的家具表一致；用來推「px／格」
UNITS = {
    'meeting': 56, 'bookshelf': 26, 'window_day': 32, 'window_night': 32, 'clock': 8, 'calendar': 9,
    'copier': 20, 'mailbox': 11, 'vending': 20, 'plant': 26, 'hydrangea': 14, 'credenza': 44, 'runner': 80,
    'sofa_set': 44, 'water_cooler': 13, 'whiteboard': 32, 'floor_lamp': 11,
}
ALPHA_CUT = 128       # 透明度超過一半才算實心
CELL_MIN, CELL_MAX = 4, 64
MIN_GRID_SHARE = 0.45  # 格線（±1 px）上的顏色變化要占全部的這麼多，才算偵測到格
SEED = 1125            # 調色盤抽樣固定種子：同輸入同輸出
EDGE_MIN = 30          # RGB 三色差加總小於這個不算邊（雜訊、漸層）


# ---------------------------------------------------------------- 來源格

def clean_alpha(im: Image.Image) -> Image.Image:
    """半透明的毛邊切掉：透明度 > 一半的變全實心，其餘全透明（顏色保留）"""
    a = np.array(im.convert('RGBA'))
    a[..., 3] = np.where(a[..., 3] >= ALPHA_CUT, 255, 0)
    return Image.fromarray(a, 'RGBA')


def edge_profile(a: np.ndarray, axis: int) -> np.ndarray:
    """沿某個方向，每條相鄰像素交界上的顏色變化總量（只算兩邊都實心的）；axis=1 → 長度 w（第 x 條＝x-1 與 x 之間）"""
    rgb = a[..., :3].astype(np.int32)
    solid = a[..., 3] >= ALPHA_CUT
    if axis == 1:
        d = np.abs(np.diff(rgb, axis=1)).sum(axis=2) * (solid[:, 1:] & solid[:, :-1])
    else:
        d = np.abs(np.diff(rgb, axis=0)).sum(axis=2) * (solid[1:, :] & solid[:-1, :])
    d = np.where(d >= EDGE_MIN, d, 0)  # 小色差（雜訊、漸層）不算：大格子裡的雜訊會把格線占比拉低
    return np.concatenate([[0], d.sum(axis=0 if axis == 1 else 1)]).astype(np.float64)


def grid_fit(e: np.ndarray, c: int):
    """格寬 c：最好的偏移，與「格線上（±1 px，c<6 只算格線本身）」的變化占比"""
    n = len(e)
    tot = e.sum() or 1.0
    best = (0.0, 0)
    for o in range(c):
        idx = np.arange(o, n, c)
        on = e[idx].sum()
        if c >= 6:
            on += e[np.clip(idx - 1, 0, n - 1)].sum() + e[np.clip(idx + 1, 0, n - 1)].sum()
        best = max(best, (on / tot, o))
    return best


def line_support(e: np.ndarray, c: int, o: int):
    """格寬 c、偏移 o 的格線裡，有多少條真的有色差支持：回 (有支持的條數, 圖案範圍內的格線總數, 有支持的格線跨度占圖案寬的比例)。
    圖案範圍＝第一個到最後一個有色差的位置；一條線（±1 px）上的變化量超過最強那條的 10% 才算有支持"""
    nz = np.nonzero(e)[0]
    if len(nz) < 2:
        return 0, 0, 0.0
    lo, hi = nz[0] - 1, nz[-1] + 1
    lines = [l for l in range(o, len(e), c) if lo <= l <= hi]
    if not lines:
        return 0, 0, 0.0
    n = len(e)
    en = np.array([e[max(0, l - 1):min(n, l + 2)].sum() for l in lines])
    ok = [l for l, v in zip(lines, en) if v >= en.max() * 0.1 and v > 0]
    span = (max(ok) - min(ok)) / max(1, hi - lo) if len(ok) >= 2 else 0.0
    return len(ok), len(lines), span


def detect_cell(im: Image.Image):
    """回 (格寬, x 偏移, y 偏移, 占比)；偵測不到或說不準回 None（不猜）。
    分數＝格線（±1 px）上的變化占比 − 隨機時的期望占比（3/c，c<6 為 1/c），x、y 兩向取較低的。還要（審查 ②）：
      ・兩個方向各自有夠多條獨立格線真的有色差（至少 4 條、占圖案範圍內格線的四成以上），而且分布橫跨圖案至少一半
        （一個矩形只有兩條邊，不能算格）；
      ・沒有另一個「不是倍數也不是因數」的格寬分數接近（85% 以上）：多個格寬都說得通＝歧義"""
    a = np.array(im)
    ex, ey = edge_profile(a, 1), edge_profile(a, 0)
    rows = []
    for c in range(CELL_MIN, min(CELL_MAX, max(a.shape[:2]) // 4) + 1):  # 至少要有 4 格才算
        sx, ox = grid_fit(ex, c)
        sy, oy = grid_fit(ey, c)
        share = min(sx, sy)  # 兩個方向都要對得上（邊界少的那一向碰巧對到時，平均會虛高）
        expect = min(1.0, (3 if c >= 6 else 1) / c)
        rows.append((share - expect, c, ox, oy, share, share / expect))
    if not rows:
        return None
    rows.sort(reverse=True)
    excess, c, ox, oy, share, lift = rows[0]
    if share < MIN_GRID_SHARE or lift < 1.5 or excess <= 0:
        return None
    for e, o in ((ex, ox), (ey, oy)):
        ok, total, span = line_support(e, c, o)
        if ok < 4 or ok < 0.4 * total or span < 0.5:
            return None
    for r in rows[1:]:
        c2 = r[1]
        if r[0] >= excess * 0.85 and c2 % c and c % c2:
            return None  # 歧義：另一個不相干的格寬也說得通
    return c, ox, oy, share


def sample_cells(im: Image.Image, c: float, ox: float, oy: float) -> Image.Image:
    """每格取中央那一半的中位色（避開柔化的格邊）；實心像素過半才算這格有東西。格寬可以是小數（照目標密度取樣時）。
    回低解析 RGBA，裁掉透明邊"""
    a = np.array(im)
    h, w = a.shape[:2]
    x0 = ox - c * np.ceil(ox / c) if ox else 0.0
    y0 = oy - c * np.ceil(oy / c) if oy else 0.0
    xs, ys = np.arange(x0, w, c), np.arange(y0, h, c)
    out = np.zeros((len(ys), len(xs), 4), np.uint8)
    m = c / 4
    for j, yy in enumerate(ys):
        for i, xx in enumerate(xs):
            ya, yb = int(round(max(0, yy + m))), int(round(min(h, yy + c - m)))
            xa, xb = int(round(max(0, xx + m))), int(round(min(w, xx + c - m)))
            if yb <= ya:
                yb = min(h, ya + 1)
            if xb <= xa:
                xb = min(w, xa + 1)
            cell = a[ya:yb, xa:xb]
            if cell.size == 0:
                continue
            solid = cell[..., 3] >= ALPHA_CUT
            if solid.mean() <= 0.5:
                continue
            out[j, i, :3] = np.median(cell[solid][:, :3], axis=0)
            out[j, i, 3] = 255
    img = Image.fromarray(out, 'RGBA')
    box = img.getbbox()
    return img.crop(box) if box else img


def typical_block(im: Image.Image) -> int:
    """同色色塊（≥4 px，排除柔化邊的 1～3 px）沿列的長度中位數：偵測不到整齊的格時，給人參考的「一格大概幾 px」"""
    a = np.array(im)
    runs = []
    for y in range(0, a.shape[0], 3):
        row, run, last = a[y], 0, None
        for x in range(a.shape[1]):
            r = row[x]
            if r[3] < ALPHA_CUT:
                if run >= 4:
                    runs.append(run)
                run, last = 0, None
                continue
            if last is not None and int(abs(int(r[0]) - int(last[0])) + abs(int(r[1]) - int(last[1])) + abs(int(r[2]) - int(last[2]))) > 40:
                if run >= 4:
                    runs.append(run)
                run = 0
            run += 1
            last = r
    return int(np.median(runs)) if runs else 0


# ---------------------------------------------------------------- 配色

def srgb_to_lab(rgb: np.ndarray) -> np.ndarray:
    c = rgb.astype(np.float64) / 255
    c = np.where(c > 0.04045, ((c + 0.055) / 1.055) ** 2.4, c / 12.92)
    m = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    xyz = c @ m.T / np.array([0.95047, 1.0, 1.08883])
    f = np.where(xyz > 0.008856, np.cbrt(xyz), 7.787 * xyz + 16 / 116)
    return np.stack([116 * f[..., 1] - 16, 500 * (f[..., 0] - f[..., 1]), 200 * (f[..., 1] - f[..., 2])], axis=-1)


def reference_palette(names, colors: int) -> np.ndarray:
    """參考素材的實心像素合在一起（固定種子抽樣，最多 20 萬點），用 libimagequant 抽 colors 色；回 (n,3)"""
    px = []
    for n in names:
        with Image.open(os.path.join(ASSETS, f'{n}.png')) as im:
            a = np.array(im.convert('RGBA'))
        px.append(a[a[..., 3] >= ALPHA_CUT][:, :3])
    allpx = np.concatenate(px)
    rng = np.random.default_rng(SEED)
    if len(allpx) > 200_000:
        allpx = allpx[rng.choice(len(allpx), 200_000, replace=False)]
    side = int(np.ceil(np.sqrt(len(allpx))))
    pad = np.zeros((side * side, 3), np.uint8)
    pad[:len(allpx)] = allpx
    pad[len(allpx):] = allpx[0]
    sheet = Image.fromarray(pad.reshape(side, side, 3), 'RGB').convert('RGBA')
    q = imagequant.quantize_pil_image(sheet, dithering_level=0.0, max_colors=colors, min_quality=0, max_quality=100)
    pal = np.array(q.getpalette()[:colors * 3], np.uint8).reshape(-1, 3)
    return pal[np.unique(np.array(q))]


def map_palette(img: Image.Image, pal: np.ndarray) -> Image.Image:
    """每個實心像素換成調色盤裡 Lab 色差最小的顏色（不抖色）"""
    a = np.array(img)
    solid = a[..., 3] > 0
    rgb = a[..., :3][solid]
    plab = srgb_to_lab(pal)
    idx = np.empty(len(rgb), np.int64)
    step = max(1024, LAB_BUDGET // max(1, len(pal)))  # 分批：點數 × 調色盤色數不超過 LAB_BUDGET（複驗 ②、最後複驗）
    for i in range(0, len(rgb), step):
        lab = srgb_to_lab(rgb[i:i + step])
        idx[i:i + step] = ((lab[:, None, :] - plab[None, :, :]) ** 2).sum(axis=2).argmin(axis=1)
    a[..., :3][solid] = pal[idx]
    return Image.fromarray(a, 'RGBA')


def self_palette(img: Image.Image, colors: int) -> np.ndarray:
    q = imagequant.quantize_pil_image(img, dithering_level=0.0, max_colors=colors, min_quality=0, max_quality=100)
    pal = np.array(q.getpalette()[:colors * 3], np.uint8).reshape(-1, 3)
    return pal[np.unique(np.array(q))]


# ---------------------------------------------------------------- 尺寸

def px_per_unit(names) -> float:
    """參考素材的密度：圖寬 ÷ 場景寬，取中位數"""
    v = []
    for n in names:
        with Image.open(os.path.join(ASSETS, f'{n}.png')) as im:
            v.append(im.width / UNITS[n])
    return float(np.median(v))


def to_png(img: Image.Image) -> bytes:
    q = imagequant.quantize_pil_image(img.convert('RGBA'), dithering_level=0.0, max_colors=256, min_quality=0, max_quality=100)
    buf = io.BytesIO()
    q.save(buf, 'PNG', optimize=True)
    return buf.getvalue()


def suggest_cells(one: float, blk: int):
    """偵測不到格時的建議：只列 0.5～256、四捨五入到兩位後仍可用的（複驗順手）"""
    out = []
    v = round(one, 2)
    if 0.5 <= v <= MAX_CELL:
        out.append(f'--cell {v:.2f}（一格＝目標上的 1 個像素）')
    if 0.5 <= blk <= MAX_CELL:
        out.append(f'--cell {blk}（原圖色塊大多這麼寬，格子會比較粗）')
    return out


PREVIEW_Z = 2  # 預覽放大倍數


def preview_layout(crisp_wh, soft_wh, body_wh, ref_whs) -> tuple:
    """預覽的尺寸：回 (總寬, 總高, 第一欄「原圖縮小」的寬高)。預算檢查和實際拼圖（preview()）共用這一支（最後複驗）。
    第一欄＝原圖案照原比例縮到銳利版的寬（不是銳利版的高：孤立像素撐高原圖案時兩者不同）"""
    tw = crisp_wh[0]
    orig = (tw, max(1, round(tw * body_wh[1] / body_wh[0])))
    cols = [orig, crisp_wh, soft_wh, *ref_whs]
    return sum(w * PREVIEW_Z + 24 for w, _ in cols) + 24, max(h for _, h in cols) * PREVIEW_Z + 40, orig


def preview_size(crisp_wh, soft_wh, body_wh, like) -> tuple:
    """預覽會多大（總寬, 總高）：參考素材只讀標頭拿尺寸"""
    refs = []
    for n in like or []:
        with Image.open(os.path.join(ASSETS, f'{n}.png')) as im:
            refs.append(im.size)
    return preview_layout(crisp_wh, soft_wh, body_wh, refs)[:2]


def process(src: Image.Image, units: float, like, cell='target', colors=48, need_crisp=True, need_preview=False):
    """回 dict：soft（平滑版）、crisp／cells（銳利版與低解析，要的時候才算）、格寬等；做不了回 {'error': ...}。
    尺寸預算（複驗 ②）：開圖、去背、找出圖案範圍之後，在切格、配色之前，先算出平滑版、銳利版、預覽會多大並擋"""
    clean = clean_alpha(src)
    ppu = px_per_unit(like) if like else 10.0
    target_w = units * ppu
    box = clean.getbbox()
    if not box:
        return {'error': '整張圖都是透明的'}
    body_w, body_h = box[2] - box[0], box[3] - box[1]
    sw = max(1, round(target_w))
    sh = max(1, round(sw * body_h / body_w))
    if sw * sh > MAX_OUT_PX:
        return {'error': f'平滑版會是 {sw}×{sh}，超過像素預算（{MAX_OUT_PX}）：調小 --units'}
    need_crisp = need_crisp or need_preview  # 預覽要用銳利版的寬
    c = ox = oy = share = None
    if need_crisp or cell == 'auto':
        if cell == 'target':  # 預設：一格＝目標 1 像素（顧問 2026-11-25）
            c, ox, oy = body_w / target_w, 0.0, 0.0
        elif cell == 'auto':
            d = detect_cell(clean)
            if not d:
                # 不猜（主管 11-25）：Codex 的「像素」常常大小不一、不在同一張格上。給建議值讓人挑
                tips = suggest_cells(body_w / target_w, typical_block(clean))
                return {'error': '偵測不到整齊的像素格（或幾種格寬都說得通，不猜）。請用 --cell 指定' + ('，例如：' + '、或 '.join(tips) if tips else '')}
            c, ox, oy, share = d
        else:
            c = float(cell)
            if c <= 0:
                return {'error': '--cell 要大於 0'}
            ic = max(2, int(round(c)))
            ox, oy = grid_fit(edge_profile(np.array(clean), 1), ic)[1] % c, grid_fit(edge_profile(np.array(clean), 0), ic)[1] % c
        cw, ch = int(np.ceil(clean.width / c)) + 1, int(np.ceil(clean.height / c)) + 1
        if max(cw, ch) > 2048 or cw * ch > MAX_CELLS:
            return {'error': f'格寬 {c:g} px 會切出太多格（上限每邊 2048、總共 {MAX_CELLS} 格）：--cell 給大一點'}
        bw, bh = int(np.ceil(body_w / c)) + 1, int(np.ceil(body_h / c)) + 1  # 裁掉透明邊後的格數上限
        k = max(1, round(target_w / max(1, bw - 1)))
        if bw * k * bh * k > MAX_OUT_PX:
            return {'error': f'銳利版會到約 {bw * k}×{bh * k}，超過像素預算（{MAX_OUT_PX}）'}
        if need_preview:
            pw, ph = preview_size((bw * k, bh * k), (sw, sh), (body_w, body_h), like)
            if pw * ph > MAX_PREVIEW_PX:
                return {'error': f'預覽會是 {pw}×{ph}，超過像素預算（{MAX_PREVIEW_PX}）：不要 --preview 或調小 --units'}
    pal = None  # 調色盤在尺寸都驗過之後才抽（最後複驗順手）
    r = {'cell': c, 'offset': (ox, oy), 'share': share, 'ppu': ppu, 'clean': clean.crop(box)}
    if need_crisp:
        cells = sample_cells(clean, c, ox, oy)
        # 最後複驗 ②：圖案範圍可能被幾個孤立像素撐大（切格時那幾格不到一半實心、被丟掉），實際格數變窄、倍率暴增：
        # 用切格後的實際格數重驗銳利版與預覽的尺寸，過了才配色、放大
        k = max(1, round(target_w / max(1, cells.width)))
        if cells.width * k * cells.height * k > MAX_OUT_PX:
            return {'error': f'銳利版實際會是 {cells.width * k}×{cells.height * k}（{cells.width}×{cells.height} 格 ×{k}），超過像素預算（{MAX_OUT_PX}）：圖裡可能有零星的雜點撐大範圍，或調大 --cell'}
        if need_preview:
            pw, ph = preview_size((cells.width * k, cells.height * k), (sw, sh), (body_w, body_h), like)
            if pw * ph > MAX_PREVIEW_PX:
                return {'error': f'預覽會是 {pw}×{ph}，超過像素預算（{MAX_PREVIEW_PX}）：不要 --preview 或調小 --units'}
        pal = reference_palette(like, colors) if like else self_palette(cells, colors)
        cells = map_palette(cells, pal)
        r.update(cells=cells, k=k, crisp=cells.resize((cells.width * k, cells.height * k), Image.NEAREST))
    soft = clean_alpha(r['clean'].resize((sw, sh), Image.LANCZOS))
    if pal is None:
        pal = reference_palette(like, colors) if like else self_palette(soft, colors)
    r.update(soft=map_palette(soft, pal), palette=len(pal))  # 平滑版也用同一組調色盤（配色一致）
    return r


# ---------------------------------------------------------------- 預覽

def preview(r: dict, like, units: float) -> Image.Image:
    """三欄：原圖縮小（同尺寸）／對格銳利／平滑；最右邊放參考素材，全部照 px／格同比例，放大 2 倍看"""
    z = PREVIEW_Z
    refs = []
    for n in like or []:
        with Image.open(os.path.join(ASSETS, f'{n}.png')) as im:
            refs.append((f'參考：{n}', im.convert('RGBA')))
    W, H, orig_wh = preview_layout(r['crisp'].size, r['soft'].size, r['clean'].size, [im.size for _, im in refs])
    orig = r['clean'].resize(orig_wh, Image.LANCZOS)
    cols = [('原圖縮小', orig), ('對格（銳利）', r['crisp']), ('平滑（--soft）', r['soft'])] + refs
    sheet = Image.new('RGBA', (W, H), (201, 138, 75, 255))  # 地板色
    d = ImageDraw.Draw(sheet)
    font = None
    for fp in ['/System/Library/Fonts/Hiragino Sans GB.ttc', '/System/Library/Fonts/STHeiti Medium.ttc', 'C:/Windows/Fonts/msjh.ttc']:
        if os.path.exists(fp):
            from PIL import ImageFont
            font = ImageFont.truetype(fp, 18)
            break
    x = 24
    for label, im in cols:
        big = im.resize((im.width * z, im.height * z), Image.NEAREST)
        sheet.alpha_composite(big, (x, H - big.height - 8))
        d.text((x, 6), label, fill=(59, 36, 18, 255), font=font)
        x += big.width + 24
    return sheet.convert('RGB')


# ---------------------------------------------------------------- 參數與輸出路徑（審查 ①）

NAME_OK = __import__('re').compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$')
MAX_UNITS, MAX_CELL, MAX_OUT_PX = 200.0, 256.0, 4096 * 4096  # 場景寬上限（格）、來源格寬上限（px）、輸出像素預算
MAX_PREVIEW_PX, MAX_IN_PX = 8192 * 4096, 64_000_000  # 預覽像素預算、輸入圖像素上限（開檔只讀標頭就擋，不解碼）
MAX_CELLS, LAB_BUDGET = 1_000_000, 4_000_000  # 切格的總格數上限；Lab 配色一批「點數 × 色數」上限


def check_args(units: float, cell: str, colors: int):
    """回錯誤訊息或 None：units 正數、有限、≤ 200；cell 是 target、auto 或 0.5～256 的數；colors 2～256"""
    import math
    if not (isinstance(units, (int, float)) and math.isfinite(units) and 0 < units <= MAX_UNITS):
        return f'--units 要是 0～{MAX_UNITS:g} 之間的數'
    if cell not in ('target', 'auto'):
        try:
            c = float(cell)
        except ValueError:
            return '--cell 要是 target、auto 或數字'
        if not (math.isfinite(c) and 0.5 <= c <= MAX_CELL):
            return f'--cell 要在 0.5～{MAX_CELL:g} 之間'
    if not (isinstance(colors, int) and 2 <= colors <= 256):
        return '--colors 要在 2～256 之間'
    return None


def same_file(a: str, b: str) -> bool:
    """兩個路徑是不是同一個檔：規範化後同路徑，或（都存在時）同一個 inode（硬連結）"""
    if os.path.realpath(a).casefold() == os.path.realpath(b).casefold():  # macOS／Windows 檔名不分大小寫：只差大小寫也算同一個（最後複驗 ①）
        return True
    try:
        x, y = os.stat(a), os.stat(b)
        return (x.st_dev, x.st_ino) == (y.st_dev, y.st_ino)
    except OSError:
        return False


def safe_output(out_dir: str, filename: str, avoid) -> str:
    """--out 底下的安全檔案路徑：檔名只收英數與 _ . -（不能有路徑）；--out 建好後取 realpath，
    最後的路徑要在它裡面、不能是已存在的符號連結、不能跟 avoid（輸入檔、另一個輸出）是同一個檔（同路徑或同 inode）。
    不合就丟 ValueError"""
    base = filename[:-4] if filename.lower().endswith('.png') else filename
    if not NAME_OK.match(base) or '..' in base:
        raise ValueError(f'檔名只能用英數字和 _ . -（1～64 字、不能有路徑）：{filename}')
    os.makedirs(out_dir, exist_ok=True)
    root = os.path.realpath(out_dir)
    p = os.path.join(root, base + '.png')
    if os.path.islink(p):
        raise ValueError(f'{p} 是符號連結，不寫')
    if os.path.commonpath([root, os.path.realpath(p)]) != root:
        raise ValueError(f'{p} 不在 --out 底下')
    for x in avoid:
        if x and same_file(x, p):  # 未建立的同名輸出也擋（比路徑）；已存在的另比 inode（複驗 ①）
            raise ValueError(f'{p} 跟輸入或另一個輸出是同一個檔')
    return p


def write_atomic(p: str, data: bytes):
    """在同一個資料夾建獨占的暫存檔（O_CREAT|O_EXCL|O_NOFOLLOW），寫完 rename 成目標（複驗 ①）。
    不改寫既有檔案的內容：目標是硬連結時只換掉這個目錄項目，連到同一份資料的原圖或外部檔不會被截斷；
    目標是後來才放的符號連結時，rename 換掉的是連結本身，不會寫到它指的地方"""
    d = os.path.dirname(p)
    tmp = os.path.join(d, f'.{os.path.basename(p)}.{os.getpid()}.{os.urandom(4).hex()}.tmp')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o644)
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, p)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def open_input(path: str) -> Image.Image:
    """開輸入圖：只讀標頭先看尺寸，超過 MAX_IN_PX 就不解碼（複驗 ②）；回已載入的圖。不合丟 ValueError"""
    im = Image.open(path)
    w, h = im.size
    if w * h > MAX_IN_PX:
        im.close()
        raise ValueError(f'輸入圖 {w}×{h} 太大（上限 {MAX_IN_PX} 像素）')
    im.load()
    return im


def main():
    ap = argparse.ArgumentParser(description='Codex 像素風插圖 → 可用素材（對格、減色、照現有素材密度放大）')
    ap.add_argument('src')
    ap.add_argument('--name', required=True)
    ap.add_argument('--units', type=float, required=True, help='場景寬（格）')
    ap.add_argument('--like', default='', help='參考素材名，逗號分隔')
    ap.add_argument('--cell', default='target')
    ap.add_argument('--colors', type=int, default=48)
    ap.add_argument('--out', default=os.path.join(ROOT, 'shots', 'art-post'))
    ap.add_argument('--preview', help='預覽檔名（寫在 --out 底下，只收檔名）')
    ap.add_argument('--crisp', action='store_true')
    ap.add_argument('--soft', action='store_true', help='舊參數，現在就是預設')
    a = ap.parse_args()
    err = check_args(a.units, a.cell, a.colors)
    if err:
        sys.exit(err)
    like = [x for x in a.like.split(',') if x]
    bad = [x for x in like if x not in UNITS]
    if bad:
        sys.exit(f'--like 不認得：{bad}（要在 UNITS 表裡：{", ".join(sorted(UNITS))}）')
    try:  # 開始運算前就把兩個輸出路徑驗好；兩個輸出無條件比路徑（都還沒建立時也擋）
        out = safe_output(a.out, a.name, [a.src])
        pv = safe_output(a.out, a.preview, [a.src, out]) if a.preview else None
        src = open_input(a.src)
    except ValueError as e:
        sys.exit(str(e))
    with src:
        r = process(src, a.units, like, a.cell, a.colors, need_crisp=a.crisp, need_preview=bool(pv))
    if 'error' in r:
        sys.exit(r['error'])
    main_img = r['crisp'] if a.crisp else r['soft']
    write_atomic(out, to_png(main_img))
    share = f"、格線占比 {r['share']:.0%}" if r['share'] is not None else ('（一格＝目標 1 像素）' if a.cell == 'target' else '（手動指定）')
    grid = f"來源格 {r['cell']:g} px（偏移 {r['offset'][0]:g},{r['offset'][1]:g}{share}）→ {r['cells'].width}×{r['cells'].height} 格，放大 ×{r['k']}；" if 'cells' in r else ''
    print(f"{grid}調色盤 {r['palette']} 色；密度 {r['ppu']:.1f} px／格；"
          f"輸出 {main_img.width}×{main_img.height}（{'銳利' if a.crisp else '平滑'}）→ {out}")
    if pv:
        buf = io.BytesIO()
        preview(r, like, a.units).save(buf, 'PNG')
        write_atomic(pv, buf.getvalue())
        print('預覽 →', pv)


if __name__ == '__main__':
    main()
