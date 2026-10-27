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

# 人物：裁切框、腿的中線（框內 x）、上衣所在列（框內，含頭尾）、上衣的 主色／暗色／亮色（Sweetie 16 色）、腿從第幾列起
PEOPLE = [
    ((2, 105, 15, 23), 7, (13, 17), {'94b0c2': 'base', '566c86': 'dark', 'f4f4f4': 'light'}, 19),
    ((19, 104, 19, 24), 7, (14, 18), {'f4f4f4': 'base', '94b0c2': 'dark'}, 19),
    ((40, 107, 13, 21), 6, (11, 15), {'f4f4f4': 'base', '94b0c2': 'dark'}, 16),
    ((3, 132, 17, 23), 9, (12, 17), {'41a6f6': 'base', '3b5dc9': 'dark'}, 20),
    ((22, 132, 17, 23), 9, (12, 17), {'b13e53': 'base', '5d275d': 'dark'}, 20),
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


# 自己畫的寵物（2dPig 素材沒有）：跟素材的黑貓、柯基同一種畫法 —— 1 像素 #1a1c2c 描邊、Sweetie 16 色、朝左（往右走時翻面）
PET_COLORS = {
    'k': '1a1c2c', 'w': 'f4f4f4', 'g': '94b0c2', 'd': '333c57', 'o': 'ef7d57', 'r': 'b13e53',
    's': 'ffcd75', 'c': 'ef7d57', 'h': '5d275d', 'u': '41a6f6', 'U': '3b5dc9',
}
PETS = {
    # 山雀（シマエナガ風）：白圓身、背上黑翅、長尾、小黑眼
    'birdSit': [
        '......kkkk......',
        '....kkwwwwkk....',
        '...kwwwwwwwwk...',
        '..kwkwwwwwwwwk..',
        '.kkwwwwwwwggdk..',
        '..kwwowwwwgdddkkk',
        '..kwwwwwwwdddddddk',
        '..kgwwwwwwwdddkkkk',
        '...kgwwwwwwwgk....',
        '....kkkkkkkkk.....',
        '......k...k.......',
    ],
    'birdFly': [
        '.........kk.......',
        '........kddk......',
        '......kkkdddk.....',
        '....kkwwwkddk.....',
        '...kwwwwwwkdk.....',
        '..kwkwwwwwwwk.....',
        '.kkwwwwwwwggk.....',
        '..kwwowwwwgddkkk..',
        '..kgwwwwwwddddddk.',
        '...kgwwwwwwgkkkkk.',
        '....kkkkkkkk......',
    ],
    # 寶寶：藍色連身衣、白尿布
    'babySit': [
        '....kkkk.....',
        '...khhhhk....',
        '..kssssssk...',
        '.kssssssssk..',
        '.kskssssksk..',
        '.kcssssssck..',
        '..kssrrssk...',
        '...kkkkkk....',
        '..kuuuuuuk...',
        '.ksuuuuuusk..',
        '.kkUuuuuUkk..',
        '..kwwwwwwk...',
        '.kssk..kssk..',
        '..kk....kk...',
    ],
    'babyCrawl': [
        '....kkkk..........',
        '...khhhhk.........',
        '..kssssssk........',
        '.kssssssssk.......',
        '.kskssssksk.......',
        '.kcssssssck.kkkkk.',
        '..kssrrssk.kuuuuuk',
        '...kkkkkkkkuuuuwwk',
        '....kuuuuuuuuuwwwk',
        '....kuuuuuuUUUwwwk',
        '....kssk.kUUk.kssk',
        '.....kk...kk...kk.',
    ],
}

# 正面／背面椅（素材只有側面椅）：a 描邊、b 主色、c 暗色、d 椅腳，顏色從同色側面椅取；同一個像素大小
# 正面：人坐在椅子前面、面向畫面（員工座位、會議室上排）；背面：椅背擋住背對畫面的人（會議室下排、主管）
CHAIR_FRONT = [
    '....aaaaaaa....',
    '...abbbbbbba...',
    '...abbbbbbba...',
    '...abbbbbbba...',
    '...acccccccа...'.replace('а', 'a'),
    '....aaaaaaa....',
    '......aca......',
    '.aaaaaaaaaaaaa.',
    '.abbbbbbbbbbba.',
    '.accccccccccca.',
    '.aaaaaaaaaaaaa.',
    '..ad.......da..',
    '..ad.......da..',
    '..ad.......da..',
    '..aa.......aa..',
    '...............',
]
CHAIR_BACK = [
    '...aaaaaaaaa...',
    '..abbbbbbbbba..',
    '..acccccccccа..'.replace('а', 'a'),
    '..accccccccca..',
    '..accccccccca..',
    '...aaaaaaaaa...',
    '......aca......',
    '.aaaaaaaaaaaaa.',
    '.accccccccccca.',
    '.aaaaaaaaaaaaa.',
    '..ad.......da..',
    '..aa.......aa..',
]
# 桌子 T1（jacky 2026-10-27 選）：素材的橘桌換成白桌面、淺灰邊、灰腳；只換桌子的框，人物膚色也有 #ef7d57
DESK_COLORS = {(0xef, 0x7d, 0x57): (0xf4, 0xf7, 0xfa), (0xb1, 0x3e, 0x53): (0xc3, 0xcf, 0xdc), (0x5d, 0x27, 0x5d): (0x56, 0x6c, 0x86)}
DESKS = ['table', 'tableLong']


def recolor_desks(body: Image.Image):
    px = body.load()
    for k in DESKS:
        x, y, w, h = SPRITES[k]
        for j in range(y - TOP, y - TOP + h):
            for i in range(x, x + w):
                r, g, b, a = px[i, j]
                if a and (r, g, b) in DESK_COLORS:
                    px[i, j] = DESK_COLORS[(r, g, b)] + (a,)


CHAIR_COLORS = ['Red', 'Yellow', 'Green', 'Blue', 'White', 'Gray']


def chair_image(rows, src: Image.Image, color: str):
    x, y, _, _ = SPRITES[f'chair{color}']
    pal = {'a': src.getpixel((x, y + 8)), 'b': src.getpixel((x + 4, y + 9)), 'c': src.getpixel((x + 1, y + 9)), 'd': src.getpixel((x + 1, y + 18))}
    im = Image.new('RGBA', (len(rows[0]), len(rows)))
    for j, r in enumerate(rows):
        for i, ch in enumerate(r):
            if ch in pal:
                im.putpixel((i, j), pal[ch])
    return im


def pet_image(rows):
    w = max(len(r) for r in rows)
    im = Image.new('RGBA', (w, len(rows)))
    for j, r in enumerate(rows):
        for i, ch in enumerate(r):
            if ch in PET_COLORS:
                im.putpixel((i, j), rgb(PET_COLORS[ch]) + (255,))
    return im


def rgb(h: str):
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


# 走路格（素材只有站姿）：'' 站立、a／b 正面左／右腳抬起（那一側的腿少一列）、la／lb 同上再把頭往左偏 1 像素（側走，往右走時整張翻面）
FRAMES = ['', 'a', 'b', 'la', 'lb', 'k']  # k＝背面：頭換成整片頭髮色（素材沒有背面）


def step(crop: Image.Image, leg: int, mid: int, frame: str, head_end: int) -> Image.Image:
    if not frame:
        return crop
    out = crop.copy()
    src, px = crop.load(), out.load()
    w, h = crop.size
    lifted = range(0, mid) if frame.endswith('a') else range(mid, w)
    for i in lifted:
        for j in range(leg, h):
            px[i, j] = src[i, j + 1] if j + 1 < h else (0, 0, 0, 0)
    if frame.startswith('l'):
        for j in range(0, head_end):
            for i in range(w):
                px[i, j] = src[i + 1, j] if i + 1 < w else (0, 0, 0, 0)
    return out


def back(crop: Image.Image, head_end: int):
    """頭（上衣以上）的內部塗成頭髮色、外圈留描邊；頭髮色＝第 1～3 列最多的非描邊色"""
    px = crop.load()
    w, h = crop.size
    count = {}
    for j in range(1, 4):
        for i in range(w):
            c = px[i, j]
            if c[3] and c[:3] != (0x1a, 0x1c, 0x2c):
                count[c] = count.get(c, 0) + 1
    hair = max(count, key=count.get)
    shade = tuple(int(v * 0.7) for v in hair[:3]) + (255,)  # 貼著描邊那圈暗一階，跟同色地毯分得開
    solid = lambda i, j: 0 <= i < w and 0 <= j < h and px[i, j][3] > 0
    edge = {(i, j) for j in range(head_end) for i in range(w) if solid(i, j) and not all(solid(i + di, j + dj) for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)))}
    for j in range(head_end):
        for i in range(w):
            if solid(i, j):
                near = any((i + di, j + dj) in edge for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)))
                px[i, j] = (0x1a, 0x1c, 0x2c, 255) if (i, j) in edge else shade if near else hair


def person(src: Image.Image, spec, shirt, frame: str = '') -> Image.Image:
    (x, y, w, h), mid, (r0, r1), roles, leg = spec
    crop = src.crop((x, y, x + w, y + h))
    if shirt:
        px = crop.load()
        for j in range(r0, r1 + 1):
            for i in range(w):
                r, g, b, a = px[i, j]
                role = roles.get('%02x%02x%02x' % (r, g, b)) if a else None
                if role:
                    px[i, j] = rgb(shirt.get(role, shirt['base'])) + (a,)
    if frame == 'k':
        back(crop, r0)
    else:
        crop = step(crop, leg, mid, frame, r0)
    cell = Image.new('RGBA', (CELL_W, CELL_H))
    cell.alpha_composite(crop, (CELL_W // 2 - mid, CELL_H - h))
    return cell


def main():
    src = Image.open(SRC).convert('RGBA')
    body = src.crop((0, TOP, src.width, src.height))
    recolor_desks(body)
    per_row = src.width // CELL_W
    cells = [(c, v, f) for v in range(len(SHIRTS)) for c in range(len(PEOPLE)) for f in FRAMES]
    rows = -(-len(cells) // per_row)
    people = Image.new("RGBA", (src.width, body.height + rows * CELL_H))
    people.alpha_composite(body, (0, 0))
    boxes = {k: (x, y - TOP, w, h) for k, (x, y, w, h) in SPRITES.items()}
    for n, (c, v, f) in enumerate(cells):
        px, py = (n % per_row) * CELL_W, body.height + (n // per_row) * CELL_H
        people.alpha_composite(person(src, PEOPLE[c], SHIRTS[v], f), (px, py))
        boxes[f'p{c}s{v}{f}'] = (px, py, CELL_W, CELL_H)
    # 寵物、正背面椅接在人物格最後一列的空位後面，放不下就另起一列
    extras = {k: pet_image(v) for k, v in PETS.items()}
    for color in CHAIR_COLORS:
        extras[f'chairFront{color}'] = chair_image(CHAIR_FRONT, src, color)
        extras[f'chairBack{color}'] = chair_image(CHAIR_BACK, src, color)
    px, py = (len(cells) % per_row) * CELL_W + 2, body.height + (len(cells) // per_row) * CELL_H
    spots = {}
    for k, im in extras.items():
        if px + im.width > src.width:
            px, py = 2, py + CELL_H
        spots[k] = (px, py + CELL_H - im.height)
        px += im.width + 2
    sheet = Image.new('RGBA', (src.width, py + CELL_H))
    sheet.alpha_composite(people, (0, 0))
    for k, im in extras.items():
        sheet.alpha_composite(im, spots[k])
        boxes[k] = (*spots[k], im.width, im.height)
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
