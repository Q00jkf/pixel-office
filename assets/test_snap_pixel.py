"""assets/snap_pixel.py 的測試：python assets/test_snap_pixel.py（要 pillow、imagequant、numpy）"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np  # noqa: E402
from PIL import Image, ImageFilter  # noqa: E402

import snap_pixel as sp  # noqa: E402

COLORS = [(200, 40, 40), (40, 160, 60), (240, 220, 180), (60, 40, 30)]


def fake_pixel_art(cell=8, off=3, n=12, blur=True, noise=True, seed=7):
    """已知格寬、偏移的假像素圖：n×n 格、四色亂排、外圈一格透明；再加柔化、雜訊，模擬 Codex 的圖"""
    rng = np.random.default_rng(seed)
    grid = rng.integers(0, len(COLORS), (n, n))
    size = off + n * cell + cell
    a = np.zeros((size, size, 4), np.uint8)
    for j in range(1, n - 1):
        for i in range(1, n - 1):
            a[off + j * cell:off + (j + 1) * cell, off + i * cell:off + (i + 1) * cell] = (*COLORS[grid[j, i]], 255)
    im = Image.fromarray(a, 'RGBA')
    if blur:
        im = im.filter(ImageFilter.GaussianBlur(0.8))
    if noise:
        b = np.array(im).astype(np.int16)
        b[..., :3] += rng.integers(-6, 7, b[..., :3].shape).astype(np.int16)
        im = Image.fromarray(np.clip(b, 0, 255).astype(np.uint8), 'RGBA')
    return im, grid


class SnapPixelTest(unittest.TestCase):
    def test_detects_cell_and_offset_through_blur_and_noise(self):
        im, _ = fake_pixel_art(cell=8, off=3)
        c, ox, oy, share = sp.detect_cell(sp.clean_alpha(im))
        self.assertEqual((c, ox, oy), (8, 3, 3))
        self.assertGreater(share, sp.MIN_GRID_SHARE)

    def test_detects_many_cell_sizes_and_offsets(self):
        for c, o in [(5, 0), (6, 2), (9, 4), (12, 5), (16, 0), (20, 7), (27, 13), (40, 11)]:
            for seed in (1, 2, 3):
                im, _ = fake_pixel_art(cell=c, off=o, n=14, seed=seed)
                r = sp.detect_cell(sp.clean_alpha(im))
                self.assertEqual(r[:3] if r else None, (c, o, o), (c, o, seed))

    def test_samples_back_the_same_cells(self):
        im, grid = fake_pixel_art(cell=8, off=3)
        cells = sp.sample_cells(sp.clean_alpha(im), 8, 3, 3)
        self.assertEqual(cells.size, (10, 10))  # 12 格扣掉外圈透明的一圈
        a = np.array(cells)
        for j in range(10):
            for i in range(10):
                want = COLORS[grid[j + 1, i + 1]]
                self.assertTrue(all(abs(int(a[j, i, k]) - want[k]) <= 8 for k in range(3)), (j, i, a[j, i], want))

    def test_irregular_art_is_not_guessed(self):
        rng = np.random.default_rng(3)
        a = np.zeros((300, 300, 4), np.uint8)
        y = 0
        while y < 300:  # 色塊高、寬都亂數：沒有整齊的格
            h, x = int(rng.integers(5, 23)), 0
            while x < 300:
                w = int(rng.integers(5, 23))
                a[y:y + h, x:x + w] = (*COLORS[int(rng.integers(0, 4))], 255)
                x += w
            y += h
        self.assertIsNone(sp.detect_cell(Image.fromarray(a, 'RGBA')))
        r = sp.process(Image.fromarray(a, 'RGBA'), 12, [], 'auto')
        self.assertIn('--cell', r['error'])

    def test_alpha_edges_are_clean_and_palette_is_respected(self):
        im, _ = fake_pixel_art(cell=8, off=3)
        pal = np.array([(210, 50, 50), (50, 150, 70), (230, 210, 170), (70, 50, 40)], np.uint8)
        out = sp.map_palette(sp.sample_cells(sp.clean_alpha(im), 8, 3, 3), pal)
        a = np.array(out)
        self.assertTrue(set(np.unique(a[..., 3])) <= {0, 255})
        used = {tuple(p) for p in a[a[..., 3] == 255][:, :3]}
        self.assertTrue(used <= {tuple(p) for p in pal})

    def test_crisp_scale_is_an_integer_and_output_is_repeatable(self):
        im, _ = fake_pixel_art(cell=8, off=3)
        r1 = sp.process(im, 6, ['plant'], 'auto', 16)
        self.assertEqual(r1['crisp'].width, r1['cells'].width * r1['k'])
        self.assertEqual(r1['crisp'].height, r1['cells'].height * r1['k'])
        r2 = sp.process(im, 6, ['plant'], 'auto', 16)  # 同輸入同輸出（調色盤抽樣固定種子）
        self.assertEqual(sp.to_png(r1['crisp']), sp.to_png(r2['crisp']))
        self.assertEqual(sp.to_png(r1['soft']), sp.to_png(r2['soft']))


    def test_default_is_one_cell_per_target_pixel_and_never_stops(self):
        # 顧問 2026-11-25：預設平滑、一格＝目標 1 像素；不規則的圖也不會停下
        rng = np.random.default_rng(5)
        a = np.zeros((300, 260, 4), np.uint8)
        a[20:280, 30:230] = (*COLORS[1], 255)
        a[60:120, 50:200] = (*COLORS[0], 255)
        r = sp.process(Image.fromarray(a, 'RGBA'), 12, ['plant'])
        self.assertNotIn('error', r)
        target = 12 * sp.px_per_unit(['plant'])
        self.assertLessEqual(abs(r['soft'].width - target), 1)
        self.assertLessEqual(abs(r['cells'].width - target), 2)  # 一格＝目標 1 像素
        self.assertEqual(r['k'], 1)


    # ---------- 審查 ②：沒有像素格的簡單輪廓不能判出格寬 ----------
    def test_single_rectangle_on_plain_background_is_not_a_grid(self):
        a = np.zeros((96, 128, 4), np.uint8)
        a[...] = (240, 240, 240, 255)
        a[20:70, 30:90] = (200, 40, 40, 255)
        im = Image.fromarray(a, 'RGBA')
        self.assertIsNone(sp.detect_cell(im))
        r = sp.process(im, 12, [], 'auto')
        self.assertIn('--cell', r['error'])
        self.assertNotIn('--cell 0 ', r['error'] + ' ')  # 只列有效的建議

    def test_too_few_grid_lines_are_refused(self):
        a = np.zeros((120, 120, 4), np.uint8)
        a[...] = (240, 240, 240, 255)
        for x in (10, 40):  # 只有兩條直線、兩條橫線：格線太少
            a[:, x:x + 2] = (20, 20, 20, 255)
            a[x:x + 2, :] = (20, 20, 20, 255)
        self.assertIsNone(sp.detect_cell(Image.fromarray(a, 'RGBA')))

    # ---------- 審查 ①：參數與輸出路徑 ----------
    def test_arguments_are_checked(self):
        for u in (0, -1, float('inf'), float('nan'), 1e9):
            self.assertIsNotNone(sp.check_args(u, 'target', 48), u)
        for c in ('0', '-3', 'nan', 'inf', 'abc', '999'):
            self.assertIsNotNone(sp.check_args(12, c, 48), c)
        for k in (1, 0, 300):
            self.assertIsNotNone(sp.check_args(12, 'target', k), k)
        self.assertIsNone(sp.check_args(12, 'auto', 48))
        self.assertIsNone(sp.check_args(12, '6.5', 48))

    def test_outputs_stay_inside_out_dir(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, 'out')
            ok = sp.safe_output(out, 'mug', [])
            self.assertEqual(os.path.dirname(ok), os.path.realpath(out))
            for bad in ('../evil', 'a/b', '/etc/x', '..', '', '.hidden', 'x' * 80):
                with self.assertRaises(ValueError, msg=bad):
                    sp.safe_output(out, bad, [])
            outside = os.path.join(d, 'outside.png')
            os.symlink(outside, os.path.join(out, 'link.png'))  # 指到外面的連結
            with self.assertRaises(ValueError):
                sp.safe_output(out, 'link', [])
            src = os.path.join(out, 'same.png')
            open(src, 'wb').write(b'x')
            with self.assertRaises(ValueError):  # 跟輸入同一個檔
                sp.safe_output(out, 'same', [src])
            open(ok, 'wb').write(b'x')
            with self.assertRaises(ValueError):  # 預覽跟主輸出同一個檔
                sp.safe_output(out, 'mug.png', [None, ok])
            late = os.path.join(os.path.realpath(out), 'late.png')
            os.symlink(outside, late)  # 驗完之後才冒出來的連結：rename 換掉的是連結本身，不會寫到它指的地方
            sp.write_atomic(late, b'data')
            self.assertFalse(os.path.exists(outside))
            self.assertFalse(os.path.islink(late))
            self.assertEqual(open(late, 'rb').read(), b'data')
            self.assertEqual([n for n in os.listdir(out) if n.endswith('.tmp')], [])  # 沒留下暫存檔

    def test_same_name_outputs_are_refused_even_before_they_exist(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, 'out')
            main = sp.safe_output(out, 'mug', [])
            self.assertFalse(os.path.exists(main))
            with self.assertRaises(ValueError):
                sp.safe_output(out, 'mug.png', [None, main])  # 預覽跟主輸出同名、兩個都還沒建立

    def test_outputs_differing_only_in_case_are_refused(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, 'out')
            main = sp.safe_output(out, 'mug', [])
            for other in ('Mug', 'MUG.png', 'mUg.PNG'):
                with self.assertRaises(ValueError, msg=other):
                    sp.safe_output(out, other, [None, main])

    def test_isolated_pixels_that_widen_the_range_cannot_blow_up_the_crisp_scale(self):
        # 左邊 20 px 寬的實心長條＋最右邊一個孤立像素：範圍有 2000 寬，切格（10 px）後孤立那格不到一半實心被丟掉，
        # 實際只剩 2 格寬、倍率變成約 1000：要在配色、放大前擋下
        a = np.zeros((1600, 2000, 4), np.uint8)
        a[:, :20] = (*COLORS[0], 255)
        a[800, 1999] = (*COLORS[1], 255)
        calls = []
        orig = sp.map_palette
        sp.map_palette = lambda *x, **k: calls.append('map')
        try:
            r = sp.process(Image.fromarray(a, 'RGBA'), 200, [], '10')
        finally:
            sp.map_palette = orig
        self.assertIn('超過像素預算', r['error'])
        self.assertEqual(calls, [])

    def test_hard_links_are_refused_and_never_truncated(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, 'out')
            os.makedirs(out)
            src = os.path.join(d, 'src.png')
            open(src, 'wb').write(b'original art')
            os.link(src, os.path.join(out, 'h.png'))  # 輸出路徑其實是輸入的硬連結
            with self.assertRaises(ValueError):
                sp.safe_output(out, 'h', [src])
            a = os.path.join(out, 'a.png')
            open(a, 'wb').write(b'old')
            ext = os.path.join(d, 'ext.png')
            os.link(a, ext)  # 外部檔跟輸出共用同一份資料
            sp.write_atomic(os.path.realpath(a), b'new')
            self.assertEqual(open(ext, 'rb').read(), b'old')  # 外部那份沒被截斷
            self.assertEqual(open(a, 'rb').read(), b'new')

    def test_big_inputs_and_outputs_are_refused_before_allocating(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            big = os.path.join(d, 'big.png')
            Image.new('1', (9000, 9000)).save(big)  # 8100 萬像素：只讀標頭就擋
            with self.assertRaises(ValueError):
                sp.open_input(big)
        calls = []
        orig_s, orig_m = sp.sample_cells, sp.map_palette
        sp.sample_cells = lambda *a, **k: calls.append('sample')
        sp.map_palette = lambda *a, **k: calls.append('map')
        try:
            a = np.zeros((2000, 100, 4), np.uint8)
            a[...] = (*COLORS[0], 255)
            r = sp.process(Image.fromarray(a, 'RGBA'), 200, [], 'target', need_crisp=False)  # 平滑版會是 2000×40000
            self.assertIn('預算', r['error'])
            r = sp.process(Image.fromarray(a[:800, :100].copy(), 'RGBA'), 200, [], '0.5')  # 銳利版約 2010×16010：切格前就擋
            self.assertIn('error', r)
        finally:
            sp.sample_cells, sp.map_palette = orig_s, orig_m
        self.assertEqual(calls, [])

    def test_preview_budget_uses_the_same_layout_as_the_real_preview(self):
        # 審查的例子：上方 156×60 實心＋右下一個孤立像素，原圖案 160×300；--cell 3、4 格寬 →
        # 銳利版 52×20、平滑版 40×75，第一欄照原比例是 52×98，預覽實際 384×236＝90,624 像素
        a = np.zeros((300, 160, 4), np.uint8)
        a[:60, :156] = (*COLORS[0], 255)
        a[299, 159] = (*COLORS[1], 255)
        im = Image.fromarray(a, 'RGBA')
        r = sp.process(im, 4, [], '3', need_preview=True)
        self.assertEqual((r['crisp'].size, r['soft'].size), ((52, 20), (40, 75)))
        real = sp.preview(r, [], 4).size
        self.assertEqual(real, (384, 236))
        self.assertEqual(sp.preview_size(r['crisp'].size, r['soft'].size, r['clean'].size, []), real)
        calls = []
        orig_budget, orig_map = sp.MAX_PREVIEW_PX, sp.map_palette
        sp.MAX_PREVIEW_PX = 80_000  # 舊算法估 384×190＝72,960 會放行
        sp.map_palette = lambda *x, **k: calls.append('map')
        try:
            r = sp.process(im, 4, [], '3', need_preview=True)
        finally:
            sp.MAX_PREVIEW_PX, sp.map_palette = orig_budget, orig_map
        self.assertIn('預覽會是', r['error'])  # 切格前的估算（格數取上限，偏大）或切格後的實際尺寸擋下都可以
        self.assertEqual(calls, [])

    def test_reference_palette_is_built_only_after_sizes_pass(self):
        a = np.zeros((1600, 2000, 4), np.uint8)
        a[:, :20] = (*COLORS[0], 255)
        a[800, 1999] = (*COLORS[1], 255)
        calls = []
        orig = sp.reference_palette
        sp.reference_palette = lambda *x, **k: calls.append('pal')
        try:
            r = sp.process(Image.fromarray(a, 'RGBA'), 200, ['plant'], '10')
        finally:
            sp.reference_palette = orig
        self.assertIn('error', r)
        self.assertEqual(calls, [])

    def test_suggestions_are_only_usable_cell_sizes(self):
        self.assertEqual(sp.suggest_cells(0.2, 0), [])
        self.assertEqual(sp.suggest_cells(999, 300), [])
        self.assertEqual(len(sp.suggest_cells(6.694, 27)), 2)

    def test_reference_files_are_closed(self):
        import warnings
        im, _ = fake_pixel_art(cell=8, off=3)
        with warnings.catch_warnings():
            warnings.simplefilter('error', ResourceWarning)
            sp.process(im, 6, ['plant', 'copier'], 'auto', 16)
            sp.px_per_unit(['plant'])


if __name__ == '__main__':
    unittest.main()
