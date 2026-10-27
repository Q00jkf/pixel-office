# 手機主畫面圖示（jacky 2026-10-27 選 A：打電腦的人）：從 assets/office-sheet.png 拼 40 格，放大成 PNG。
# Android 主畫面不吃 SVG 圖示（會退成網址字首「J」），要 PNG；maskable 版內容縮在中間 80%（安全區）。
# 重跑：python plugins/pixel-office/remote/build_icon.py
from pathlib import Path
from PIL import Image, ImageDraw

HERE = Path(__file__).parent
sheet = Image.open(HERE.parent / 'assets' / 'office-sheet.png').convert('RGBA')
NAVY = (41, 54, 111, 255)


def crop(x, y, w, h):
    return sheet.crop((x, y, x + w, y + h))


def figure() -> Image.Image:
    """40x40 透明底：人（p0s0）、螢幕（pc）、桌（table）"""
    im = Image.new('RGBA', (40, 40), (0, 0, 0, 0))
    im.alpha_composite(crop(233, 66, 15, 19), (22, 8))
    im.alpha_composite(crop(0, 120, 20, 25), (5, 6))
    im.alpha_composite(crop(85, 7, 26, 16), (7, 24))
    return im


def rounded() -> Image.Image:
    im = Image.new('RGBA', (40, 40), (0, 0, 0, 0))
    ImageDraw.Draw(im).rounded_rectangle((0, 0, 39, 39), 8, fill=NAVY)
    im.alpha_composite(figure())
    return im


def maskable() -> Image.Image:
    im = Image.new('RGBA', (50, 50), NAVY)  # 40/50 = 80%，系統怎麼裁都不切到人
    im.alpha_composite(figure(), (5, 5))
    return im


for name, im, size in [('icon-192.png', rounded(), 192), ('icon-512.png', rounded(), 512), ('icon-maskable.png', maskable(), 512)]:
    im.resize((size, size), Image.NEAREST).save(HERE / name, optimize=True)
    print(name)
