# 由 2dpig/PixelOfficeAssets.png 產生 Desktop 向量畫面用的素材表：
#   assets/office-sheet.png —— 原素材表去掉天空（上 40 列）＋ 5 個人物 × 8 種上衣顏色
#   hooks/sheet.ts          —— 上面那張的 base64 與每個圖素的裁切框（vector.ts 用）
# 用法：python plugins/pixel-office/assets/build_sheet.py（改了這支或素材就重跑，兩個產物都進 repo）
import base64, io, sys
from pathlib import Path
from PIL import Image

sys.stdout.reconfigure(encoding='utf-8')
HERE = Path(__file__).resolve().parent
SRC = HERE / '2dpig' / 'PixelOfficeAssets.png'
TOP = 40  # 天空不用
CELL_W, CELL_H = 20, 25  # 人物格：腳底貼格底、腿的中線在 x=10，頭的中心約在 (10, 8.5)

# 原素材表上的圖素（x, y, w, h，原座標；輸出時 y 減 TOP）
SPRITES = {
    'cat': (65, 129, 16, 13), 'corgi': (59, 146, 24, 11),
    'chairRed': (6, 41, 11, 22), 'chairYellow': (19, 41, 11, 22), 'chairGreen': (32, 41, 11, 22),
    'chairBlue': (45, 41, 11, 22), 'chairWhite': (58, 41, 11, 22), 'chairGray': (71, 41, 11, 22),
    'table': (85, 47, 26, 16), 'tableLong': (115, 47, 40, 16),
    'partition': (171, 44, 79, 17), 'panel': (188, 63, 17, 19), 'post': (207, 63, 4, 27),
    'plant': (170, 65, 14, 19), 'wall': (84, 70, 26, 20),
    'window': (59, 96, 26, 21), 'windowNote': (88, 96, 26, 21), 'door': (98, 120, 16, 31),
    'sofaGray': (119, 66, 33, 15), 'sofaBlue': (120, 83, 33, 16), 'sofaGreen': (120, 102, 33, 16), 'sofaOrange': (120, 121, 33, 16),
    'coffee': (159, 91, 7, 11), 'mug': (169, 95, 8, 7), 'calendar': (234, 81, 17, 11),
    'flagIndia': (179, 94, 12, 9), 'flagUK': (193, 94, 12, 9), 'flagUS': (207, 94, 12, 9),
    'picBlue': (222, 94, 6, 8), 'picOrange': (230, 94, 6, 8), 'picSunset': (239, 94, 11, 8),
    'clock': (159, 108, 19, 6), 'paper': (183, 107, 6, 8), 'paper2': (192, 107, 6, 9), 'printer': (200, 107, 9, 9),
    'pc': (233, 106, 15, 19), 'monitorSide': (240, 128, 6, 19), 'keyboard': (233, 135, 5, 12),
    'boxRed': (211, 119, 11, 8), 'boxBlue': (211, 129, 11, 8), 'boxGreen': (211, 140, 11, 8), 'outlet': (211, 151, 10, 6),
    'binGreen': (116, 143, 9, 14), 'binRed': (126, 143, 9, 14), 'binBlue': (136, 143, 9, 14), 'cooler': (147, 140, 9, 17),
    'vending': (159, 123, 24, 34), 'fridge': (184, 126, 24, 31),
}

# 人物：裁切框、腿的中線（框內 x）、上衣所在列（框內，含頭尾）、上衣的 主色／暗色／亮色（Sweetie 16 色）
PEOPLE = [
    ((2, 105, 15, 23), 7, (13, 17), {'94b0c2': 'base', '566c86': 'dark', 'f4f4f4': 'light'}),
    ((19, 104, 19, 24), 7, (14, 18), {'f4f4f4': 'base', '94b0c2': 'dark'}),
    ((40, 107, 13, 21), 6, (11, 15), {'f4f4f4': 'base', '94b0c2': 'dark'}),
    ((3, 132, 17, 23), 9, (12, 17), {'41a6f6': 'base', '3b5dc9': 'dark'}),
    ((22, 132, 17, 23), 9, (12, 17), {'b13e53': 'base', '5d275d': 'dark'}),
]
# 第 0 種＝原色；不用橘、黃（會跟膚色糊在一起）；最後一種是主管的深藍西裝（vector.ts 的 SUIT）
SHIRTS = [
    None,
    {'base': 'b13e53', 'dark': '5d275d', 'light': 'ef7d57'},
    {'base': '5d275d', 'dark': '1a1c2c', 'light': 'b13e53'},
    {'base': '38b764', 'dark': '257179', 'light': 'a7f070'},
    {'base': '41a6f6', 'dark': '3b5dc9', 'light': '73eff7'},
    {'base': '257179', 'dark': '29366f', 'light': '73eff7'},
    {'base': '566c86', 'dark': '333c57', 'light': '94b0c2'},
    {'base': '29366f', 'dark': '1a1c2c', 'light': '3b5dc9'},
]


def rgb(h: str):
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def person(src: Image.Image, spec, shirt) -> Image.Image:
    (x, y, w, h), mid, (r0, r1), roles = spec
    crop = src.crop((x, y, x + w, y + h))
    if shirt:
        px = crop.load()
        for j in range(r0, r1 + 1):
            for i in range(w):
                r, g, b, a = px[i, j]
                role = roles.get('%02x%02x%02x' % (r, g, b)) if a else None
                if role:
                    px[i, j] = rgb(shirt.get(role, shirt['base'])) + (a,)
    cell = Image.new('RGBA', (CELL_W, CELL_H))
    cell.alpha_composite(crop, (CELL_W // 2 - mid, CELL_H - h))
    return cell


def main():
    src = Image.open(SRC).convert('RGBA')
    body = src.crop((0, TOP, src.width, src.height))
    per_row = src.width // CELL_W
    cells = [(c, v) for v in range(len(SHIRTS)) for c in range(len(PEOPLE))]
    rows = -(-len(cells) // per_row)
    sheet = Image.new('RGBA', (src.width, body.height + rows * CELL_H))
    sheet.alpha_composite(body, (0, 0))
    boxes = {k: (x, y - TOP, w, h) for k, (x, y, w, h) in SPRITES.items()}
    for n, (c, v) in enumerate(cells):
        px, py = (n % per_row) * CELL_W, body.height + (n // per_row) * CELL_H
        sheet.alpha_composite(person(src, PEOPLE[c], SHIRTS[v]), (px, py))
        boxes[f'p{c}s{v}'] = (px, py, CELL_W, CELL_H)
    out = io.BytesIO()
    sheet.save(out, 'PNG', optimize=True)
    png = out.getvalue()
    (HERE / 'office-sheet.png').write_bytes(png)
    entries = ',\n'.join(f'  {k}: [{x}, {y}, {w}, {h}]' for k, (x, y, w, h) in boxes.items())
    ts = (
        '// 由 assets/build_sheet.py 產生，不要手改。素材：2dPig「Pixel Office」（CC0）https://2dpig.itch.io/pixel-office\n'
        f'export const SHEET_W = {sheet.width}\nexport const SHEET_H = {sheet.height}\n'
        f'export const PEOPLE = {len(PEOPLE)}\nexport const SHIRTS = {len(SHIRTS)} // 第 0 種原色，最後一種主管西裝\n'
        f'export const CELL = {{ w: {CELL_W}, h: {CELL_H}, headX: 10, headY: 8.5 }}\n'
        f'export const SPRITES = {{\n{entries},\n}} as const\n'
        'export type SpriteId = keyof typeof SPRITES\n'
        f"export const SHEET_PNG = '{base64.b64encode(png).decode()}'\n"
    )
    (HERE.parent / 'hooks' / 'sheet.ts').write_text(ts, encoding='utf-8', newline='\n')
    print(f'office-sheet.png {sheet.width}x{sheet.height}，{len(png)} bytes，base64 {len(base64.b64encode(png))} 字元')


main()
