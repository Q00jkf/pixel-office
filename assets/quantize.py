"""手機版美術圖（remote/v2/assets/*.png）量化成 256 色調色盤 PNG：檔案小約 3 倍，肉眼看不出差別（0.62.17）。

規則（主管 2026-11-23 定）：assets 以量化後的版本為準；誰重產或新增圖，commit 前最後跑一次這支。

用法：
    python3 -m venv /tmp/q && /tmp/q/bin/pip install pillow imagequant
    /tmp/q/bin/python assets/quantize.py                 # 整個 remote/v2/assets
    /tmp/q/bin/python assets/quantize.py a.png b.png     # 只做指定的檔
    /tmp/q/bin/python assets/quantize.py --dry-run       # 只印會省多少，不寫檔

做法：libimagequant（pngquant 的核心），不抖色（像素畫抖色會出雜點），品質 0～100 讓它自己挑最好的 256 色；
已經是調色盤（P 模式）的跳過；量化後沒小 10% 以上的保留原檔。不改圖的尺寸。
不要用 Pillow 內建的 quantize（FASTOCTREE）：色偏看得出來（筆電蓋偏粉、木紋變平）。
"""
import glob
import io
import os
import sys

sys.stdout.reconfigure(encoding='utf-8')

try:
    import imagequant
    from PIL import Image
except ImportError:
    sys.exit('要先裝 pillow 與 imagequant（見檔頭用法）')

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'remote', 'v2', 'assets')


def quantize(path: str) -> tuple:
    raw = open(path, 'rb').read()
    im = Image.open(io.BytesIO(raw))
    if im.mode == 'P':
        return len(raw), len(raw)
    q = imagequant.quantize_pil_image(im.convert('RGBA'), dithering_level=0.0, max_colors=256, min_quality=0, max_quality=100)
    buf = io.BytesIO()
    q.save(buf, 'PNG', optimize=True)
    out = buf.getvalue()
    return len(raw), len(out) if len(out) < len(raw) * 0.9 else len(raw), out


def main() -> None:
    args = [a for a in sys.argv[1:] if a != '--dry-run']
    dry = '--dry-run' in sys.argv
    files = args or sorted(glob.glob(os.path.join(ROOT, '*.png')))
    before = after = changed = 0
    for f in files:
        r = quantize(f)
        n0, n1 = r[0], r[1]
        before += n0
        after += n1
        if n1 < n0:
            changed += 1
            if not dry:
                open(f, 'wb').write(r[2])
    print(f'{len(files)} 張，{"會" if dry else "已"}量化 {changed} 張：{before / 1e6:.1f} MB → {after / 1e6:.1f} MB')


if __name__ == '__main__':
    main()
