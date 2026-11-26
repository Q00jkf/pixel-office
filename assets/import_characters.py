"""四位角色新圖（448×512）與遠側獨立椅子接進手機版 assets（2026-11-24）。

做的事：
  1. 每位角色照 SOURCES 的資料夾順序收圖（後面的同名檔蓋前面的），驗證：448×512、RGBA、四位各 62 張、一張不缺
  2. alpha < 8 的點清成全透明（RGB 也清掉）。主管 2026-11-24：GPT 去背殘留 alpha 1～2 的洋紅點，所有新圖都做，在量化前。
     其他 alpha 不動：現有桌子圖、各角色的實心部分本來就大多是 252～254（原畫出圖就這樣），補成 255 看不出差別、只會白改
  3. 刪掉 remote/v2/assets 裡舊的 full_<角色>_*（158×302 那批），寫入新圖
  4. 遠側椅子、無椅桌子底圖、去舊扶手的前景照 EXTRAS 複製（一樣做 alpha 清理）
  5. 更新 manifest.json：新圖登記 {w, h}、刪掉舊 full_* 的登記
  6. 角色圖縮成一半（224×256，6.4 px／格）再存：手機上人最高約 36 格 × 1.9 CSS px × 3 倍螢幕＝206 實際像素，
     原圖 448×512 用不到；縮一半檔案約剩四分之一（量化後 13.7 MB → 約 3.5 MB）。scene.js、面板照圖寬換算比例（新規格＝寬:高＝448:512）
  7. 新寫入的檔跑 quantize.py 的量化（要 imagequant；--no-quantize 跳過）

用法（要 pillow、imagequant，裝法見 assets/quantize.py 檔頭）：
    python assets/import_characters.py --dry-run     # 只驗證、印會做什麼
    python assets/import_characters.py               # 真的寫入
"""
import io
import json
import re
import sys
from pathlib import Path

sys.stdout.reconfigure(encoding='utf-8')
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
DST = ROOT / 'remote' / 'v2' / 'assets'
HAND = ROOT / 'art-inbox' / '2026-11-24-mg1-character-handoff'
CHAIRS = ROOT / 'art-inbox' / '2026-11-24-far-chairs'

# 角色 → 資料夾（照順序收，後面的同名檔蓋前面的）
SOURCES = {
    'claude': ['Claude-場景試播修正版', 'Claude-打字與坐下-待驗收', 'Claude-背面坐姿補腿'],
    # 2026-11-24 更正造型（睜眼、淺笑、赤腳，依 ~/.codex/generated_images 使用者指定底稿）：第 1 批用比例複驗版
    'chatgpt': ['GPT-更正造型-01靜止姿勢-比例複驗', 'GPT-更正造型-02正面動畫-送驗', 'GPT-更正造型-03其餘動畫-送驗',
                'GPT-自然裙襬-左走樣張', 'GPT-自然裙襬-三向'],  # 2026-11-24 走路重畫：手前後擺、裙襬自然、右走改成左走鏡像（翅膀不動，使用者裁示）
    'gemini': ['Gemini-全套62張-場景驗收-v2'],
    'deepseek': ['DeepSeek-全套-場景複驗', 'DeepSeek-右走步距補件'],
}
# 遠側椅子、無椅底圖、前景修正：放進 assets 的名字 → 來源
EXTRAS = {
    'far_chair': CHAIRS / 'far_chair.png',
    'boss_chair_front': CHAIRS / 'boss-high-v3' / 'boss_chair_front_high.png',
    **{n: CHAIRS / f'{n}.png' for n in ['ctable2', 'ctable4', 'ctable6', 'ctable8', 'office2']},
    'ctable2_over': CHAIRS / '工程端_over去舊扶手' / 'ctable2_over.png',
    'office2_over': CHAIRS / '工程端_over去舊扶手' / 'office2_over.png',
}
W, H = 448, 512
POSES = {'stand': ['down', 'up', 'left', 'right'], 'sit': ['down', 'up'], 'type': ['down', 'up'],
         'rise': ['down', 'up'], 'sitdown': ['down', 'up'], 'walk': ['down', 'up', 'left', 'right']}
FRAMES = {'stand': 1, 'sit': 1, 'type': 4, 'rise': 4, 'sitdown': 4, 'walk': 8}
NAME_RE = re.compile(r'^full_([a-z]+)_(up|down|left|right)_([a-z]+)_(\d+)$')
ALPHA_MIN = 8
HALF = (W // 2, H // 2)  # 角色圖存成這個大小


def expected(sp: str) -> set:
    return {f'full_{sp}_{d}_{p}_{i}' for p, ds in POSES.items() for d in ds for i in range(FRAMES[p])}


def clean_alpha(im: Image.Image) -> tuple:
    """alpha < ALPHA_MIN → (0,0,0,0)，其他不動。回傳 (新圖, 清掉幾點)"""
    im = im.convert('RGBA')
    a = im.getchannel('A')
    cleared = sum(1 for v in a.get_flattened_data() if 0 < v < ALPHA_MIN)
    mask = a.point(lambda v: 255 if v < ALPHA_MIN else 0)
    im.paste((0, 0, 0, 0), (0, 0) + im.size, mask)
    return im, cleared


def quantized(im: Image.Image) -> bytes:
    import imagequant
    q = imagequant.quantize_pil_image(im, dithering_level=0.0, max_colors=256, min_quality=0, max_quality=100)
    buf = io.BytesIO()
    q.save(buf, 'PNG', optimize=True)
    return buf.getvalue()


def main() -> None:
    dry = '--dry-run' in sys.argv
    noq = '--no-quantize' in sys.argv
    plan = {}  # assets 裡的名字 → 來源路徑
    bad = []
    for sp, folders in SOURCES.items():
        got = {}
        for d in folders:
            p = HAND / d
            if not p.is_dir():
                bad.append(f'{sp}：找不到資料夾 {d}')
                continue
            for f in sorted(p.glob(f'full_{sp}_*.png')):
                got[f.stem] = f
        want = expected(sp)
        miss, extra = sorted(want - set(got)), sorted(set(got) - want)
        if miss:
            bad.append(f'{sp}：缺 {len(miss)} 張，例如 {miss[:4]}')
        if extra:
            bad.append(f'{sp}：多出不認得的 {extra[:4]}')
        for n in sorted(want & set(got)):
            with Image.open(got[n]) as im:
                if im.size != (W, H):
                    bad.append(f'{n}：尺寸 {im.size}，要 {W}×{H}')
            plan[n] = got[n]
    for n, p in EXTRAS.items():
        if not p.exists():
            bad.append(f'{n}：找不到 {p}')
        plan[n] = p
    if bad:
        print('驗證沒過：')
        for b in bad:
            print('  -', b)
        sys.exit(1)

    man_path = DST / 'manifest.json'
    M = json.loads(man_path.read_text(encoding='utf-8'))
    old = sorted(f.stem for f in DST.glob('full_*.png'))
    old_m = sorted(k for k in M if k.startswith('full_'))
    print(f'新角色圖 {sum(1 for n in plan if n.startswith("full_"))} 張、椅子與桌子 {len(EXTRAS)} 張；'
          f'刪掉舊 full_* 檔 {len(old)} 張、manifest 登記 {len(old_m)} 筆')
    tot_cleared = 0
    sizes = {}
    for n, src in plan.items():
        with Image.open(src) as im0:
            im, c = clean_alpha(im0)
        if n.startswith('full_'):
            im = im.resize(HALF, Image.LANCZOS)
            im, _ = clean_alpha(im)  # 縮小後邊緣的極淡點再清一次
        tot_cleared += c
        data = None
        if not dry:
            data = im if noq else None
            if noq:
                buf = io.BytesIO()
                im.save(buf, 'PNG', optimize=True)
                data = buf.getvalue()
            else:
                data = quantized(im)
            sizes[n] = len(data)
        if c > 1000:
            print(f'  {n}：清掉 alpha<{ALPHA_MIN} {c} 點')
        if not dry:
            (DST / f'{n}.png').write_bytes(data)
    print(f'alpha 清理合計：清掉 {tot_cleared} 點（只列超過 1000 點的檔）')
    if dry:
        print('（--dry-run：沒有寫檔）')
        return
    for n in old:
        if n not in plan:
            (DST / f'{n}.png').unlink()
    for k in old_m:
        del M[k]
    for n in plan:
        with Image.open(DST / f'{n}.png') as im:
            M[n] = {'w': im.width, 'h': im.height}
    man_path.write_text(json.dumps(M, ensure_ascii=False, indent=1) + '\n', encoding='utf-8')
    full = sum(v for k, v in sizes.items() if k.startswith('full_'))
    print(f'寫入 {len(sizes)} 張：角色 {full / 1e6:.1f} MB、椅子與桌子 {(sum(sizes.values()) - full) / 1e6:.1f} MB；manifest 已更新')


if __name__ == '__main__':
    main()
