"""按鈕、清單列、標籤的像素木頭風邊框圖（0.64.4，jacky 11-27「按鈕照像素木頭風改」）。

畫 remote/v2/assets/ 的 ui_btn_*.png、ui_card*.png、ui_chip*.png：尺寸、九宮格切法不變（CSS 一律 `border-image: url(...) 12 fill / 6px`），
所以 CSS 不用跟著改，每顆用到它們的按鈕一起換。畫法：2 倍像素（一格＝2px，縮成 6px 邊框時一格＝1 個 CSS px）、
深木色粗外框、切角、上緣亮線、下緣厚陰影（按下＝陰影跑到上緣、整顆往下沉）。要改顏色改 STYLES，重跑：

  python remote/build_ui_buttons.py
"""
import os
import sys

from PIL import Image

sys.stdout.reconfigure(encoding='utf-8')
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'v2', 'assets')
P = 2  # 一格像素＝2px

WOOD = (74, 44, 23)  # 外框：深木色
STYLES = {
    # 名稱: (外框, 底色, 上緣亮線, 下緣陰影)
    'primary': (WOOD, (47, 138, 125), (110, 190, 176), (30, 96, 87)),
    'secondary': (WOOD, (253, 243, 225), (255, 252, 244), (226, 205, 166)),
    'danger': ((122, 34, 48), (253, 243, 225), (255, 252, 244), (238, 196, 196)),
    'danger_solid': ((92, 24, 20), (192, 57, 43), (226, 112, 98), (140, 40, 30)),
    'card': ((107, 68, 38), (255, 250, 240), (255, 255, 255), (234, 217, 184)),
    'card_amber': ((150, 105, 20), (255, 241, 204), (255, 250, 228), (240, 212, 140)),
    'card_warn': ((122, 34, 48), (255, 238, 236), (255, 250, 249), (240, 196, 196)),
    'card_dim': ((140, 128, 112), (240, 236, 228), (250, 248, 244), (214, 206, 192)),
    'chip': (WOOD, (253, 243, 225), (255, 252, 244), (226, 205, 166)),
    'chip_on': (WOOD, (246, 224, 160), (252, 240, 200), (214, 178, 96)),
}


def draw(w, h, edge, fill, hi, shade, down=False):
    """w、h 是格數。切角 2 格；外框 2 格厚；沒按＝上緣亮線 1 格、下緣陰影 2 格；按下＝上緣陰影 2 格、沒有亮線"""
    img = Image.new('RGBA', (w * P, h * P), (0, 0, 0, 0))
    px = img.load()

    def put(x, y, c):
        for dx in range(P):
            for dy in range(P):
                px[x * P + dx, y * P + dy] = c + (255,)

    cut = 2
    for y in range(h):
        for x in range(w):
            # 切角：離角落的曼哈頓距離不到 cut 就挖空
            corner = min(x, w - 1 - x) + min(y, h - 1 - y)
            if min(x, w - 1 - x) < cut and min(y, h - 1 - y) < cut and corner < cut:
                continue
            edge_d = min(x, w - 1 - x, y, h - 1 - y)
            on_diag = min(x, w - 1 - x) < cut + 2 and min(y, h - 1 - y) < cut + 2 and corner < cut + 2
            if edge_d < 2 or on_diag:
                put(x, y, edge)
            elif not down and y == 2:
                put(x, y, hi)
            elif not down and y >= h - 4:
                put(x, y, shade)
            elif down and y <= 3:
                put(x, y, shade)
            else:
                put(x, y, fill)
    return img


def main():
    out = []
    for name in ('primary', 'secondary', 'danger', 'danger_solid'):
        for down in (False, True):
            f = f'ui_btn_{name}{"_down" if down else ""}.png'
            draw(48, 28, *STYLES[name], down=down).save(os.path.join(OUT, f))
            out.append(f)
    for name in ('card', 'card_amber', 'card_warn', 'card_dim'):
        f = f'ui_{name}.png'
        draw(48, 48, *STYLES[name]).save(os.path.join(OUT, f))
        out.append(f)
    for name in ('chip', 'chip_on'):
        f = f'ui_{name}.png'
        src = os.path.join(OUT, f)
        w, h = Image.open(src).size if os.path.exists(src) else (96, 56)
        draw(w // P, h // P, *STYLES[name]).save(src)
        out.append(f)
    print('畫好：' + '、'.join(out))


if __name__ == '__main__':
    main()
