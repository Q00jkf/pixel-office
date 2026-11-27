// 像素辦公室手機版 v2 場景（2026-11-22 從 v2 預覽併進外掛）：上方「協作區」、下方「辦公區」。
// - 協作區：協作桌可坐 2／4／6／8 人，圍著桌子面對面坐（偶數座位在遠側面向下、奇數在近側面向上，每兩個一欄）；
//   同一個主管底下的人自動同桌（伺服器 office.ts 分配）；使用者可以加桌子、改人數、改名、刪除（人事室或點桌牌）
// - 辦公區：一排左右各一張雙人桌、中間走道（寬螢幕一排更多張），大家都面向下
// - 座位代號（伺服器給）：協作桌 `t<桌號>.<i>`、辦公區 `o<k>`
// 單位：「格」（一張 4 人桌寬 80 格）；畫的時候乘上 scale×螢幕倍率。圖層：底圖（地板、牆、家具、桌子）→ 遠側坐著的人 →
// 桌面前景（桌面＋遠側筆電）→ 近側螢幕 → 近側坐著的人 → 近側椅子前景 → 走路的人 → 狀態圖示；點擊區、名牌、閃圈用 DOM 疊上去
// 家具只是擺設（點了沒有選單）；沒有寵物。點人＝完整對話、點名牌＝狀態卡、點空位＝招聘、點桌牌＝改協作桌、長按拖人＝換座位
// 跟頁面（page.html）的介面：window.PO（狀態、卡片、完整對話、選單、送出）
;(() => {
  const PO = () => window.PO || {}
  const A = '/v2/assets/'
  // 0.63.1：server.ts 傳出時把下面換成 {名字: 內容雜湊}（manifest 是 'manifest.json'），網址帶 ?v= 讓換過的圖重新抓
  const AV = '__ASSET_V__'
  const src = n => A + n + '.png' + (AV[n] ? '?v=' + AV[n] : '')
  // 角色主視覺（0.63.46）：kv_stand_<角色>（招聘大站姿）、kv_chibi_<角色>（員工卡 Q 版）；還沒交件的先用場景的正面圖暫代。四種角色以外回空字串＝不顯示
  const KV_SP = ['claude', 'chatgpt', 'gemini', 'deepseek']
  const kvSrc = (kind, sp) => { if (!KV_SP.includes(sp)) return ''; const n = `kv_${kind}_${sp}`; return src(AV[n] ? n : sp + '_front') }
  window.PO_KV = { chibi: sp => kvSrc('chibi', sp), stand: sp => kvSrc('stand', sp) }
  // ---------- 尺寸（格） ----------
  const GW = 80, AISLE = 24, SIDE = 10, TOP = 70, BOTTOM = 52
  // 協作桌：桌牌在近側名牌下面（使用者 2026-11-23：名牌和桌牌擠成一團）；每排之間多留 4 格給桌牌
  const SIGN_DY = 10, ROW_GAP = 42, FAR_ROOM = 25 // FAR_ROOM：下一排遠側的頭＋名牌要的高度（格）
  // 近側椅子（2026-11-23「扶手和座墊間 1～2 px 灰線」）：桌子底圖裡原本畫著正面椅子，背面圖蓋上去時左右下緣會露出底下椅子的黑邊，
  // 背影的人衣服也會從扶手下面露出來 → 背面圖橫向放寬 BACK_K 倍蓋住；人剪到扶手上緣（椅高 CLIP_K）
  const BACK_K = 1.08, CLIP_K = 0.3
  const DESK_PX = 1038, U = GW / DESK_PX       // 桌組原圖（裁切後）1 px＝U 格
  const CAP_PX = 117.5, COL_PX = 395, RIGHT_PX = 525.5 // 協作桌切片：左端、每一欄、右半（含最後一欄與右端）
  const OFFICE_CROP = 0.40                      // 辦公桌＝4 人桌上面 40%（遠側椅子、遠側筆電、桌面上半）
  let GH = 56, OH = 22.4, CROW = 94, OROW = 52, M = null, geom = null
  const CHAR_W = 27, CH = CHAR_W * 1.02
  const ZH = { idle: '閒著', thinking: '思考中', typing: '正在寫', reading: '正在讀', waiting: '等你回覆／核准', done: '剛做完', blocked: '卡住了' }
  const SPZH = { claude: 'Claude', deepseek: 'DeepSeek', chatgpt: 'ChatGPT', gemini: 'Gemini' }
  const SCREEN = { idle: '#6fb7e0', typing: '#8fe4ff', thinking: '#a9b6ff', reading: '#b5e8c8', waiting: '#ffb35c', blocked: '#ff7a7a', done: '#9be59b' }
  const ICON = { waiting: 'hand', thinking: 'think', reading: 'book', done: 'done', blocked: 'error' }
  const SIZES = [2, 4, 6, 8]
  // 清單頭像（美術 A #15）：真資料裡 Claude 員工的 species 都是 claude，人事室一排同一張臉分不出誰；
  // 外型沒特別指定（claude）的照 id 雜湊輪四種角色，Codex 固定 ChatGPT、其他指定的照指定。只換清單頭像，場景裡的人物不變
  const FACES = ['claude', 'chatgpt', 'gemini', 'deepseek']
  function faceOf(p) {
    if (p.kind === 'codex') return 'chatgpt'
    const sp = p.species || 'claude'
    if (sp !== 'claude' || !p.id) return sp
    let h = 0; for (const c of String(p.id)) h = (h * 31 + c.charCodeAt(0)) >>> 0
    return FACES[h % FACES.length]
  }

  // ---------- 載入圖片 ----------
  const img = {}
  const NAMES = ['desk', 'desk_over', 'desk_chairs', 'floor_tile', 'wall_tile', 'meeting', 'window_day', 'window_night', 'bookshelf', 'hydrangea', 'credenza', 'clock', 'calendar',
    'copier', 'mailbox', 'vending', 'runner', 'plant', 'sofa_set', 'water_cooler', 'whiteboard', 'floor_lamp', 'icon_hand', 'icon_think', 'icon_book', 'icon_done', 'icon_error', 'icon_star',
    'chair_back', 'logo_claude', 'logo_chatgpt', 'logo_gemini', 'logo_deepseek', 'boss_chair',
    ...['claude', 'deepseek', 'chatgpt', 'gemini'].flatMap(s => [`${s}_front`, `${s}_back`])]
  const loadImg = n => new Promise(ok => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ok(null); i.src = src(n) }).then(i => { img[n] = i; if (i) indexFull(n, i) })
  // 開卡卡頓：原本 fullFrames 每次重畫、每人好幾次都把幾百個圖名用正規式篩一遍再排序。改成圖載到時放進「物種｜方向｜動作」索引（照格號排好），
  // fullFrames 的結果也快取，只有全身圖新進來才清
  const fullIdx = new Map(), framesCache = new Map()
  function indexFull(n, i) {
    const m = FULL_RE.exec(n); if (!m) return
    const k = m[1] + '|' + m[2] + '|' + m[3], list = (fullIdx.get(k) || []).filter(x => x.n !== +m[4]) // 同一張載兩次只留新的
    list.push({ n: +m[4], i }); list.sort((a, b) => a.n - b.n); fullIdx.set(k, list)
    framesCache.clear()
  }
  // 全身角色圖：manifest 裡有登記的 full_<species>_<facing>_<pose>_<frame> 才載入
  // pose：stand／walk／sit（sit 1、2＝打字中兩格）／paper、letter（拿紙、拿信站姿，之後出差動作用）
  // 新規格（448×512）另有 type（打字 4 格）、rise（起立 4 格）、sitdown（坐下 4 格）
  const FULL_RE = /^full_([a-z]+)_(up|down|left|right)_(stand|walk|sit|type|rise|sitdown|paper|letter)_(\d+)$/
  // 專用桌子圖（build_tables.py）：manifest 有 tables_geom 才載入 ctable4／6／8、office2 與各自的 _over、_chairs
  // （_over、_chairs 沒有登記在 manifest 的大小表裡，以 tables_geom 有這張桌子為準；載不到的 art() 會退回拼接版）
  const tableImgs = j => Object.keys(j.tables_geom || {}).flatMap(n => [n, n + '_over', ...(n.startsWith('ctable') ? [n + '_chairs'] : [])])
  // 分三批載（0.62.17：原本等 246 張全部載完才畫，慢網路要十幾秒）：
  // 第一批＝地板、牆、桌子（版面要靠桌子圖算，載完才第一次畫）；第二批＝角色；第三批＝擺設、圖示、標誌。
  // 前一批載完才開始下一批（不搶頻寬）；後兩批每到幾張就補畫一次。圖是 onload 之後才放進 img，沒到的就不畫（不會有破圖）
  // 桌子圖很大（一張 0.5～1.4 MB）：第一批只載用得到的尺寸（辦公桌、4 人桌＝2 人桌縮放要用、現在有的桌子），其他尺寸新增那種桌子時才載（needTables）；
  // 有椅背圖（chair_back）就用不到 _chairs，椅背圖沒載到才補載
  const T1 = ['floor_tile', 'wall_tile', 'desk', 'desk_over', 'desk_chairs', 'chair_back']
  const T2 = [...['claude', 'deepseek', 'chatgpt', 'gemini'].flatMap(s => [`${s}_front`, `${s}_back`]), ...NAMES.filter(n => /^icon_/.test(n))] // 狀態圖示（舉手等你）很小又重要，跟角色一起
  const T3 = NAMES.filter(n => !T1.includes(n) && !T2.includes(n))
  const PER_FRAME = n => /^(icon_|logo_)/.test(n) || n === 'boss_chair' // 每格現畫的；其他（擺設、椅背）在底圖裡，要重做圖層
  let tier1 = false, refreshT = 0, needLayers = false
  const later = (n, layer) => loadImg(n).then(() => {
    if (!img[n]) return
    if (layer) needLayers = true
    clearTimeout(refreshT)
    refreshT = setTimeout(() => { if (needLayers) { needLayers = false; layerKey = '' } render() }, 150)
  })
  const manifest = fetch(A + 'manifest.json' + (AV['manifest.json'] ? '?v=' + AV['manifest.json'] : '')).then(r => r.json()).then(j => {
    M = j
    geom = M.desk_geom
    GH = 724 * U
    OH = GH * OFFICE_CROP
    CROW = Math.ceil(GH + 38) // 遠側頭頂＋名牌約高出桌子 22 格、近側名牌＋桌牌在下方約 13 格
    OROW = Math.ceil(OH + 30)
    return j
  })
  const asked = new Set()
  const tableSet = n => M && M.tables_geom && M.tables_geom[n] ? [n, n + '_over', ...(n.startsWith('ctable') && !img.chair_back && asked.has('chair_back') ? [n + '_chairs'] : [])] : []
  const tablesFor = j => ['office2', 'ctable4', ...new Set(((j && j.tables) || []).map(t => 'ctable' + t.size))].flatMap(tableSet)
  const firstState = new Promise(r => PO().onState(r))
  const ready = manifest.then(() => firstState).then(j => { const ns = [...T1, ...(M.far_chair ? ['far_chair', 'boss_chair_front'] : []), ...tablesFor(j)]; ns.forEach(n => asked.add(n)); return Promise.all(ns.map(loadImg)) }).then(() => { tier1 = true })
  // 之後才出現的桌子尺寸：先用拼接版畫，圖到了重做圖層
  function needTables() { if (!tier1) return; for (const n of tablesFor(st)) if (!asked.has(n)) { asked.add(n); later(n, true) } }
  // 角色：第二批只載坐、站、打字（一打開就看得到的）；走路、起立、坐下（有人換位子才用到，沒載到先用站姿）跟第三批一起
  const FULL_NOW = /_(sit|stand|type)_\d+$/
  ready.then(() => manifest).then(j => Promise.all([...T2, ...Object.keys(j).filter(k => FULL_RE.test(k) && FULL_NOW.test(k))].map(n => later(n, false)))
    .then(() => Promise.all([...T3.filter(n => !asked.has(n)).map(n => later(n, !PER_FRAME(n))), ...Object.keys(j).filter(k => FULL_RE.test(k) && !FULL_NOW.test(k)).map(n => later(n, false))])))
  const ar = n => (M && M[n] ? M[n].h / M[n].w : 1)
  const tableW = cols => (CAP_PX + (cols - 1) * COL_PX + RIGHT_PX) * U
  const isSeat = k => typeof k === 'string' && /^(t\d+\.\d+|o\d+)$/.test(k)
  // 專用桌子圖的縮放：讓相鄰兩個座位的距離都等於原本 4 人桌的座位間距（30.4 格），不管哪張桌子人都不會擠在一起
  // （Codex 交件說明：各張圖的座位間距本來就不一致，要以座位對齊）。2 人桌畫得太深（約其他桌的兩倍），先不用、照舊拼接，等重畫
  const STD_SPACING = COL_PX * U
  function art(name) {
    const g = M && M.tables_geom && M.tables_geom[name]
    if (!g || !img[name] || !img[name + '_over'] || !g.cols.length) return null
    let u
    if (g.cols.length >= 2) u = STD_SPACING / ((g.cols[g.cols.length - 1].cx - g.cols[0].cx) / (g.cols.length - 1))
    else { // 只有一欄（2 人桌）：讓筆電背蓋跟 4 人桌的一樣寬
      const a4 = name !== 'ctable4' && art('ctable4'); if (!a4) return null
      const lw = c => c.lid[2] - c.lid[0]
      u = lw(a4.g.cols[0]) * a4.u / lw(g.cols[0])
    }
    return { name, g, u, w: g.w * u, h: g.h * u }
  }
  // 2 人桌：第一版畫得太深（約 4 人桌兩倍），v2（2026-11-22 美術）桌深接近 4 人桌才用；太深就退回拼接
  const tableArt = size => { const a = art('ctable' + size); return a && (size !== 2 || a.h < 1.3 * ((art('ctable4') || { h: GH }).h)) ? a : null }

  // ---------- 版面 ----------
  let L = null
  /** tables：伺服器給的協作桌；officeNeed：辦公區要幾個座位 */
  function plan(cw, tables, officeNeed) {
    // 辦公桌：有專用圖就用它的寬高（雙人桌），沒有就用 4 人桌上半張
    const oa = art('office2'), DW = oa ? oa.w : GW, DH = oa ? oa.h : OH
    const maxCols = Math.max(2, Math.min(8, Math.floor((cw / 2 - 2 * SIDE + AISLE) / (DW + AISLE))))
    const desksNeed = Math.ceil(officeNeed / 2)
    let cols = Math.max(2, Math.min(maxCols, desksNeed)) // 人少時一排少放幾張、整個場景放大
    const tts = [...tables].sort((a, b) => a.id - b.id).map(t => { const a = tableArt(t.size), c = t.size / 2; return { ...t, cols: c, art: a, w: a ? a.w : tableW(c), h: a ? a.h : GH } })
    // 場景寬：辦公區一排的寬、最寬的協作桌，至少跟原本手機版一樣寬（兩張 4 人桌並排＋中央走道）
    const w4 = (tableArt(4) || { w: GW }).w
    const widthOf = c => Math.max(2 * SIDE + c * DW + (c - 1) * AISLE, ...tts.map(t => t.w + 2 * SIDE), 2 * SIDE + 2 * Math.max(GW, w4) + AISLE)
    // 美術 A #12：平板、寬螢幕放大會碰到 3.2 倍上限、兩側留大片空白：辦公桌一排多放幾張讓場景變寬（協作桌照場景寬換排，跟著一排多張）
    while (cw / widthOf(cols) > 3.2 && cols < Math.max(maxCols, 8)) cols++ // 加到不用頂著上限放大為止（倍率略低於 3.2、剛好填滿寬度）
    const w = widthOf(cols)
    // 協作區：桌子依序往右排，排不下就換一排；每排置中、頂端對齊；排高＝該排最深的桌子＋上下名牌
    const tbls = [], rows = []
    let row = []
    const rowW = r => r.reduce((n, t) => n + t.w, 0) + (r.length - 1) * AISLE
    for (const tt of tts) {
      if (row.length && rowW([...row, tt]) > w - 2 * SIDE) { rows.push(row); row = [] }
      row.push(tt)
    }
    if (row.length) rows.push(row)
    // 美術 A #1、#2：桌牌兩行（桌名（N人）／狀態）。字級在手機上有 9px 下限，換成格數會跟縮放變，所以照這次的縮放算名牌、桌牌要多高：
    // 近側名牌下面留 2 格才放桌牌（不貼在一起），桌牌下面再留下一排遠側的頭＋名牌
    const s0 = Math.min(cw / w, 3.2), fsU = Math.max(9, Math.min(13, 4.6 * s0)) / s0
    const signDy = Math.max(SIGN_DY, fsU * 1.55 + 4 / s0 + 2), signH = fsU * 1.35 * 2 + 8 / s0
    const cy0 = TOP + 24
    let y = cy0, added = 0 // added：桌牌兩行比原本多用的格數；拉長場景時要補回去，休息角的空間才跟原本一樣（審查 ①）
    rows.forEach((r, i) => {
      let x = (w - rowW(r)) / 2
      for (const t of r) { t.x = x; t.y = y; t.row = i; x += t.w + AISLE; tbls.push(t) }
      // 桌名很長、縮到 75% 還放不下會換行：照字寬估這排最多要幾行，多的行數一起留（審查 #2 極端長桌名）
      const tw = t => [...`${t.name}（${t.size}人）`].reduce((n, ch) => n + (/[ -~]/.test(ch) ? 0.6 : 1), 0) * fsU * 0.75
      const more = Math.max(0, ...r.map(t => Math.ceil(tw(t) / Math.max(10, Math.max(t.w, 70) - 4 * fsU)) - 1))
      const gap = Math.max(ROW_GAP, signDy + signH + more * fsU * 1.25 + FAR_ROOM)
      added += gap - ROW_GAP
      y += Math.max(...r.map(t => t.h)) + gap
    })
    const collabEnd = rows.length ? y - FAR_ROOM + 3 : cy0 + 26 // 沒桌子：留一塊「＋ 加協作桌」
    // 辦公區
    const oy0 = collabEnd + 34, orow = Math.ceil(DH + 30)
    const orows = Math.max(1, Math.ceil(desksNeed / cols))
    const x0 = (w - (cols * DW + (cols - 1) * AISLE)) / 2
    const desks = []
    for (let d = 0; d < orows * cols; d++) desks.push({ d, x: x0 + (d % cols) * (DW + AISLE), y: oy0 + Math.floor(d / cols) * orow, row: Math.floor(d / cols), w: DW, h: DH, art: oa })
    const lastY = oy0 + (orows - 1) * orow
    const h = lastY + DH + 14 + BOTTOM
    return { cols, w, h, added, tables: tbls, collabRows: rows.length, collabTop: cy0, collabEnd, signDy, officeTop: oy0, officeRows: orows, desks, extra: 0, spotLane: lastY + DH + 9 }
  }

  /** 座位的位置（格）：cx＝中心、top／bottom＝半身像上下緣、far＝面向下（遠側）；lid／scr＝筆電背蓋／螢幕（絕對座標） */
  function seatXY(key) {
    let m = /^t(\d+)\.(\d+)$/.exec(key)
    if (m) {
      const t = L.tables.find(t => t.id === +m[1]); if (!t) return null
      const i = +m[2]; if (i >= t.size) return null
      const col = Math.floor(i / 2), far = i % 2 === 0
      if (t.art) return geomArt(t.art, t.x, t.y, col, far, { zone: 'collab', table: t })
      return geomOf(t.x, t.y, col, far, GH, { zone: 'collab', table: t })
    }
    m = /^o(\d+)$/.exec(key)
    if (m) {
      const k = +m[1], desk = L.desks[Math.floor(k / 2)]; if (!desk) return null
      if (desk.art) return geomArt(desk.art, desk.x, desk.y, k % 2, true, { zone: 'office', desk })
      return geomOf(desk.x, desk.y, k % 2, true, OH, { zone: 'office', desk })
    }
    return null
  }
  /** 專用桌子圖的座位：位置來自 build_tables.py 量到的背蓋／螢幕框（原圖像素 × u） */
  function geomArt(a, x, y, col, far, extra) {
    const c = a.g.cols[col], S = v => v * a.u
    const lid = [x + S(c.lid[0]), y + S(c.lid[1]), x + S(c.lid[2]), y + S(c.lid[3])], cx = x + S(c.cx)
    // 使用者 2026-11-22：「正面打字手不在鍵盤上」——原本遠側的人整個坐在筆電上方（腳、膝蓋露出來、筆電在小腿前）。
    // 改成：筆電背蓋上緣對到胸口（坐姿圖由上往下約 45%），只露出頭、肩、上臂，手在背蓋後面的鍵盤上
    // top／bottom＝坐姿全身圖的上下緣（anchors() 的坐點＝top＋SIT_H＝bottom）
    // 主管椅 v2（美術 2026-11-22，352×352，原尺寸直接疊、不放大）：在 4 人桌原圖上左上角＝座位中心往左 176、背蓋上緣往上 255
    // （第一版 220×220 會整張被坐著的人擋住，使用者要求重畫）；其他桌依背蓋寬（4 人桌 162）等比換算
    const kb = (c.lid[2] - c.lid[0]) / 162
    const boss = { x: x + S(c.cx - 176 * kb), y: y + S(c.lid[1] - 255 * kb), w: S(352 * kb), h: S(352 * kb) }
    // 遠側獨立椅子的框（見 FAR_FIX）；ink＝椅子實際畫到的範圍
    const fx = (FAR_FIX[a.name] || [])[col] || [1, 0, 0], fs = kb * fx[0]
    const chair = { x: x + S(c.cx - 176 * fs + fx[1]), y: y + S(c.lid[1] - 255 * fs + fx[2]), w: S(352 * fs), h: S(352 * fs) }
    chair.ink = { x0: chair.x + chair.w * FAR_BOX[0] / 352, x1: chair.x + chair.w * FAR_BOX[2] / 352 }
    chair.out = chair.h * FAR_PULL / 352
    // feet＝新規格坐姿的腳底線：遠側座面＝背蓋下緣往上 4.4 格（手落在筆電底座高度），腳＝座面往下 11.4 格（character-redraw.md 第八節）
    if (far) { const bottom = lid[1] + SIT_H * 0.45; return { cx, top: bottom - SIT_H, bottom, feet: lid[3] + 7, far: true, gp: { x, y }, H: a.h, lid, boss, chair, ...extra } }
    const scr = [x + S(c.scr[0]), y + S(c.scr[1]), x + S(c.scr[2]), y + S(c.scr[3])]
    // 「背面的椅子怪怪的」：整張近側椅子蓋在背影前面，人只露出頭（頭頂在椅背上緣往上 7 格，螢幕還看得到狀態顏色）
    const chairTop = c.chair_top != null ? y + S(c.chair_top) : scr[3] + 2
    const top = chairTop - 7
    // 「討論桌背對坐的椅子也怪怪的」：背影坐姿畫到腳，椅腳之間是空的，裙擺、頭髮會從椅座下面露出來 → 畫到椅座就剪掉
    const clipY = c.chair_bottom != null ? y + S(c.chair_top + (c.chair_bottom - c.chair_top) * CLIP_K) : null
    // 椅子背面圖（美術 2026-11-22，208×244，畫在 4 人桌原圖上左上角＝座位中心往左 104、椅背上緣往上 4，椅高 239）：
    // 其他桌型依椅子高度等比換算；標誌中心在背面圖的 (104, 82)
    let back = null
    if (c.chair_bottom != null) {
      const k = (c.chair_bottom - c.chair_top) / 239
      back = { x: x + S(c.cx - 104 * BACK_K * k), y: y + S(c.chair_top - 4 * k), w: S(208 * BACK_K * k), h: S(244 * k), lx: x + S(c.cx), ly: y + S(c.chair_top - 4 * k + 82 * k) }
    }
    // 近側座面＝椅背上緣往下 9.8 格，腳＝座面往下 11.4 格
    return { cx, top, bottom: top + SIT_H, feet: chairTop + 21.2, far: false, gp: { x, y }, H: a.h, lid, scr, clipY, back, ...extra }
  }
  function geomOf(x, y, col, far, H, extra) {
    const off = COL_PX * col
    const lid = [x + (215 + off) * U, y + 113 * U, x + (415 + off) * U, y + 232 * U]
    const cx = x + (315 + off) * U
    if (far) { const bottom = y + 232 * U - 4; return { cx, top: bottom - CH, bottom, far: true, gp: { x, y }, H, lid, ...extra } }
    const scr = [x + (232 + off) * U, y + 293 * U, x + (402 + off) * U, y + 398 * U]
    const top = y + 398 * U - 0.5
    return { cx, top, bottom: top + CH, far: false, gp: { x, y }, H, scr, ...extra }
  }
  const allSeats = () => [
    ...L.tables.flatMap(t => Array.from({ length: t.size }, (_, i) => `t${t.id}.${i}`)),
    ...L.desks.flatMap(d => [`o${d.d * 2}`, `o${d.d * 2 + 1}`]),
  ]

  // 頂端、底部的家具（格）
  function decor(w, h) {
    const it = [], add = (what, name, x, y, ww, label) => it.push({ what, name, x, y, w: ww, h: ww * ar(name), label })
    add('meeting', 'meeting', 5, 3, 56, '會議區')
    const shelfX = w - 32
    add('cabinet', 'bookshelf', shelfX, 3, 26, '書櫃（資料）')
    const plantX = shelfX - 15
    it.push({ what: null, name: 'hydrangea', x: plantX, y: 28, w: 14, h: 14 * ar('hydrangea') })
    const left = 66, right = plantX - 2, avail = right - left
    const WW = 32, n = Math.max(1, Math.min(6, Math.floor((avail + 10) / (WW + 14))))
    const gap = (avail - n * WW) / (n + 1)
    const wins = []
    for (let i = 0; i < n; i++) wins.push(left + gap + i * (WW + gap))
    wins.forEach(x => add('window', 'window_day', x, 4, WW, '窗戶（白天／夜間）'))
    const clockX = n > 1 ? (wins[0] + WW + wins[1]) / 2 - 4 : Math.min(right - 9, wins[0] + WW + 2)
    add('clock', 'clock', clockX, 5, 8, '時鐘')
    const cw = Math.min(44, avail - 4)
    if (cw > 24) {
      const cx = left + (avail - cw) / 2
      it.push({ what: null, name: 'credenza', x: cx, y: 44 - cw * ar('credenza'), w: cw, h: cw * ar('credenza') })
      add('calendar', 'calendar', cx + cw - 12, 44 - cw * ar('credenza') - 5, 9, '月曆')
    } else add('calendar', 'calendar', clockX, 22, 8, '月曆')
    const b = h - BOTTOM
    for (const l of lounge(w, L.spotLane, b)) it.push({ what: null, name: l.name, x: l.x, y: l.y, w: l.w, h: l.w * ar(l.name) })
    it.push({ what: null, name: 'runner', x: w / 2 - 40, y: b + 36, w: 80, h: 80 * ar('runner') })
    add('printer', 'copier', SIDE + 1, b + 8, 20, '影印機（信件）')
    add('mailbox', 'mailbox', w - 74, b + 10, 11, '郵筒（git）')
    add('vending', 'vending', w - 60, b + 2, 20, '販賣機')
    it.push({ what: null, name: 'plant', x: w - 37, y: b + 6, w: 26, h: 26 * ar('plant') })
    return it
  }

  // 人少時辦公區下面空出來的地板（使用者 2026-11-23：不要縮短場景，鋪擺設補起來）：用現有素材排「休息角」，一組高 44 格，
  // 放得下幾組就在空地板上下置中排幾組。不擋走路：擺設都在去影印機／郵筒／販賣機的橫走道（lane）下方，
  // 左邊避開影印機那條直走道（x＜SIDE＋24）、右邊避開郵筒與販賣機（w−78～w−38）；地毯是地板，走過去沒關係
  const LOUNGE_H = 40, LOUNGE_GAP = 14
  function lounge(w, lane, b) {
    const top = lane + 10, band = b - 4 - top, mid = Math.min(w / 2, w - 78 - 22)
    const out = []
    const n = Math.floor((band + LOUNGE_GAP) / (LOUNGE_H + LOUNGE_GAP))
    // 放不下一整組（手機常見）：沙發區整組等比縮小放進去；太矮（不到 26 格）就只鋪地毯和兩盆
    if (n < 1) {
      if (band < 20) return out
      if (band < 26) {
        const y = top + (band - 16) / 2
        out.push({ name: 'runner', x: mid - 36, y: y + 4, w: 72 }, { name: 'hydrangea', x: SIDE + 30, y, w: 12 }, { name: 'plant', x: w - 32, y: y - 2, w: 18 })
        return out
      }
    }
    const k = n < 1 ? band / LOUNGE_H : 1, m = Math.max(1, n)
    const y0 = top + (band - (m * LOUNGE_H * k + (m - 1) * LOUNGE_GAP)) / 2
    for (let i = 0; i < m; i++) {
      const y = y0 + i * (LOUNGE_H + LOUNGE_GAP)
      if (i % 2 === 0) { // 沙發區（Codex 2026-11-23 畫的沙發茶几、立燈、白板、飲水機）；第 2、4…組換書櫃邊櫃，不要整排一樣
        out.push({ name: 'runner', x: mid - 36 * k, y: y + 27 * k, w: 72 * k })
        out.push({ name: 'sofa_set', x: mid - 22 * k, y: y + k, w: 44 * k })
        out.push({ name: 'floor_lamp', x: mid - 34 * k, y: y + 2 * k, w: 11 * k })
        out.push({ name: 'whiteboard', x: SIDE + 22, y: y + 10 * k, w: 32 * k })
        out.push({ name: 'water_cooler', x: w - 18 - 12 * k, y: y + 9 * k, w: 13 * k })
        continue
      }
      out.push({ name: 'runner', x: mid - 36, y: y + 26, w: 72 })
      out.push({ name: 'credenza', x: mid - 20, y: y + 8, w: 40 })
      out.push({ name: 'bookshelf', x: SIDE + 26, y: y + 2, w: 20 })
      out.push({ name: 'hydrangea', x: SIDE + 47, y: y + 20, w: 11 })
      out.push({ name: 'plant', x: w - 32, y: y + 12, w: 20 })
    }
    return out
  }

  // ---------- 動線（全身角色走路用；座標＝格，錨點＝腳底中心） ----------
  // 路線只走水平／垂直：站點 → 自己那條橫走道 →（換排就走一條上下都沒擋到的直走道）→ 對方的橫走道 → 對方站點
  // 橫走道：遠側座位在桌子上緣往上 16 格、近側在桌子下緣往下 16 格；底部家具在最後一排辦公桌下方
  // 直走道：左右牆邊、各排桌子之間的空隙；挑上下兩條橫走道之間都沒穿過桌子（含遠側的人頭）的那條裡最近的
  const SIT_H = 25.5, STAND_H = 36
  // 拉椅子（使用者 2026-11-24：「入座前椅子應該往後退，起立後再靠回去；入座或起立都從椅子的左邊過去」）：
  // 只有近側有單獨的椅背圖（chair_back）能動；遠側椅子畫在桌圖裡，等單獨的椅子圖再接，先照舊。
  // 起立：人和椅子一起往後 PULL_K×椅高 →（原地）站起來 → 往左走到椅子左邊 → 椅子靠回去；入座倒過來
  const PULL_K = 0.32, SIDE_GAP = 2.5
  // 遠側獨立椅子（mg2 2026-11-24，art-inbox/2026-11-24-far-chairs）：352×352 畫布、比例照 4 人桌原圖；
  // 左上角＝（cx − 176×s + dx, 背蓋上緣 − 255×s + dy），s＝kb×倍率，kb＝背蓋寬 ÷ 162。倍率、dx、dy 是 mg2 逐座量的補正（原圖 px）
  // 椅子實際範圍在畫布 (67,156)–(278,351)；往後拉 FAR_PULL 畫布 px（往上）
  const FAR_FIX = {
    ctable2: [[1.105, 8, 2]], ctable4: [[1, 0, 0], [1.035, 8, 3]], ctable6: [[1.04, 1, 4], [1.06, 3, 5], [1.03, 4, 3]],
    ctable8: [[1.045, 2, 2], [1.04, 3, 2], [1.025, 2, 0], [1.035, 2, 2]], office2: [[1.04, 4, 0], [1.04, 8, 0]],
  }
  // 主管高背椅比員工椅寬（v3：x 27～324），主管進出要從它的左緣外面走：左緣照圖實際畫到的地方算（inkLeft），換圖不用改數字
  const FAR_BOX = [67, 156, 278, 351], FAR_PULL = 50
  // 主管坐在高背椅（遠側）時，名牌、開會泡泡、信封往上移，不壓椅背頂邊（主管 2026-11-24）
  const BOSS_LIFT = 2
  const bossLift = (s, p) => (s && s.far && s.chair && p && p.role === 'manager' && img.far_chair && img.boss_chair_front ? BOSS_LIFT : 0)
  const inkMemo = new Map()
  function inkLeft(im) { // 圖最左邊不透明那一欄（畫布 px）
    if (!im) return null
    if (inkMemo.has(im)) return inkMemo.get(im)
    const c = document.createElement('canvas'); c.width = im.width; c.height = im.height
    const x = c.getContext('2d'); x.drawImage(im, 0, 0); const d = x.getImageData(0, 0, c.width, c.height).data
    let l = c.width
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) l = Math.min(l, ((i - 3) / 4) % c.width)
    inkMemo.set(im, l); return l
  }
  const MEET = {
    door: [0.88, 0.86], lane: 0.91,
    seats: [{ x: 0.28, y: 0.64, facing: 'down' }, { x: 0.66, y: 0.64, facing: 'down' }, { x: 0.30, y: 0.82, facing: 'up' }, { x: 0.64, y: 0.82, facing: 'up' }],
    side: [0.16, 0.80],
  }
  const blockRects = () => [
    ...L.tables.map(t => ({ x0: t.x - 1, x1: t.x + t.w + 1, y0: t.y - 22, y1: t.y + t.h + 2 })),
    ...L.desks.map(d => ({ x0: d.x - 1, x1: d.x + d.w + 1, y0: d.y - 22, y1: d.y + d.h + 2 })),
  ]
  const motion = {
    SIT_H, STAND_H,
    layerOf(p) { return p.pose === 'sit' || p.phase ? 'seat' : 'top' },
    /** 座位的錨點：sit、stand（腳底中心＋面向）、lane（這個座位出入的橫走道 y） */
    anchors(key) {
      const s = seatXY(key); if (!s) return null
      // sit.y＝腳底線（新圖照它對腳）；舊圖底緣在 top＋SIT_H，畫的時候往上補 d0
      const sy = s.feet != null ? s.feet : s.top + SIT_H, d0 = sy - (s.top + SIT_H)
      if (s.far) return { seat: key, far: true, x: s.cx, d0, sit: { x: s.cx, y: sy, facing: 'down' }, stand: { x: s.cx, y: s.gp.y - 2, facing: 'down' }, lane: s.gp.y - 16 }
      return { seat: key, far: false, x: s.cx, d0, sit: { x: s.cx, y: sy, facing: 'up' }, stand: { x: s.cx, y: s.gp.y + s.H + 3, facing: 'up' }, lane: s.gp.y + s.H + 16 }
    },
    deskRects: () => [...L.tables.map(t => ({ x: t.x, y: t.y, w: t.w, h: t.h })), ...L.desks.map(d => ({ x: d.x, y: d.y, w: d.w, h: d.h }))],
    lanes() {
      const ys = new Set()
      for (const k of allSeats()) { const a = motion.anchors(k); if (a) ys.add(Math.round(a.lane * 100) / 100) }
      for (const s of Object.values(motion.spots())) ys.add(Math.round(s.lane * 100) / 100)
      return [...ys].sort((a, b) => a - b)
    },
    /** 從 y0 到 y1 這段上下都沒擋到的直走道 x（牆邊一定可以走） */
    connectors(y0, y1) {
      const lo = Math.min(y0, y1), hi = Math.max(y0, y1), R = blockRects()
      const xs = new Set([7, L.w - 7])
      const rowsOf = list => { const m = new Map(); for (const r of list) { const k = Math.round(r.y); if (!m.has(k)) m.set(k, []); m.get(k).push(r) } return [...m.values()] }
      for (const r of rowsOf([...L.tables.map(t => ({ x: t.x, y: t.y, w: t.w })), ...L.desks.map(d => ({ x: d.x, y: d.y, w: d.w }))])) {
        r.sort((a, b) => a.x - b.x)
        for (let i = 0; i + 1 < r.length; i++) xs.add((r[i].x + r[i].w + r[i + 1].x) / 2)
      }
      return [...xs].filter(x => !R.some(r => x >= r.x0 && x <= r.x1 && r.y1 > lo && r.y0 < hi))
    },
    spots() {
      const it = n => items.find(i => i.name === n)
      const out = {}, first = L.tables.length ? L.collabTop - 16 : L.officeTop - 16
      const meet = it('meeting')
      if (meet) out.meeting = { x: meet.x + meet.w + 2, y: meet.y + meet.h * MEET.door[1], facing: 'left', lane: first }
      for (const [k, n] of [['printer', 'copier'], ['mailbox', 'mailbox'], ['vending', 'vending']]) {
        const f = it(n); if (f) out[k] = { x: f.x + f.w / 2, y: f.y + 2, facing: 'down', lane: L.spotLane }
      }
      return out
    },
    meetSeat(i) { const m = items.find(t => t.name === 'meeting'), s = MEET.seats[i]; return { x: m.x + m.w * s.x, y: m.y + m.h * s.y, facing: s.facing } },
    meetRoute(i) {
      const m = items.find(t => t.name === 'meeting'), P = (fx, fy) => ({ x: m.x + m.w * fx, y: m.y + m.h * fy })
      const out = motion.spots().meeting, inDoor = P(MEET.door[0], MEET.door[1]), lane = m.y + m.h * MEET.lane, seat = motion.meetSeat(i)
      const pts = [{ x: out.x, y: out.y }, inDoor, { x: inDoor.x, y: lane }]
      if (MEET.seats[i].facing === 'down') { const sx = m.x + m.w * MEET.side[i]; pts.push({ x: sx, y: lane }, { x: sx, y: seat.y }) } else pts.push({ x: seat.x, y: lane })
      pts.push({ x: seat.x, y: seat.y })
      return pts.filter((p, k) => k === 0 || p.x !== pts[k - 1].x || p.y !== pts[k - 1].y)
    },
    route(a, b) {
      const pts = [{ x: a.x, y: a.y }, { x: a.x, y: a.lane }]
      if (Math.abs(a.lane - b.lane) > 0.01) {
        const xs = motion.connectors(a.lane, b.lane)
        const cx = xs.reduce((best, x) => (Math.abs(x - a.x) + Math.abs(x - b.x) < Math.abs(best - a.x) + Math.abs(best - b.x) ? x : best), xs[0] ?? 7)
        pts.push({ x: cx, y: a.lane }, { x: cx, y: b.lane })
      }
      pts.push({ x: b.x, y: b.lane }, { x: b.x, y: b.y })
      return pts.filter((p, i) => i === 0 || p.x !== pts[i - 1].x || p.y !== pts[i - 1].y)
    },
    seatRoute(from, to) { const A = motion.anchors(from), B = motion.anchors(to); return motion.route({ ...A.stand, lane: A.lane }, { ...B.stand, lane: B.lane }) },
    length: path => path.reduce((n, p, i) => i ? n + Math.abs(p.x - path[i - 1].x) + Math.abs(p.y - path[i - 1].y) : 0, 0),
    at(path, d) {
      d = Math.max(0, d)
      for (let i = 0; i < path.length - 1; i++) {
        const a = path[i], b = path[i + 1], len = Math.abs(b.x - a.x) + Math.abs(b.y - a.y)
        if (d <= len + 1e-6) { const t = len === 0 ? 1 : Math.min(1, d / len); const dx = Math.sign(b.x - a.x), dy = Math.sign(b.y - a.y); return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, dx, dy, facing: motion.facing(dx, dy) } }
        d -= len
      }
      return null
    },
    facing: (dx, dy) => (dy < 0 ? 'up' : dy > 0 ? 'down' : dx < 0 ? 'left' : dx > 0 ? 'right' : 'down'),
    rejoin(old, d, to) {
      const here = motion.at(old.path, d)
      if (!here) return motion.route(old.end, to)
      const lanes = motion.lanes()
      const on = lanes.find(y => Math.abs(y - here.y) < 0.01)
      if (on !== undefined) return motion.route({ x: here.x, y: here.y, lane: on }, to)
      const near = lanes.reduce((b, y) => (Math.abs(y - here.y) < Math.abs(b - here.y) ? y : b), lanes[0])
      return [{ x: here.x, y: here.y }, ...motion.route({ x: here.x, y: near, lane: near }, to)].filter((p, i, a) => i === 0 || p.x !== a[i - 1].x || p.y !== a[i - 1].y)
    },
    STAND_MS: 400, CHAIR_MS: 350,
    /** 拉椅子的座位（近側、有椅背圖）：out＝人和椅子一起往後幾格；slot＝拉開後站的位置（椅子和桌子中間）；side＝椅子左邊 */
    entry(key, boss) {
      const s = seatXY(key); if (!s) return null
      if (s.far) { // 遠側：椅子往上拉，人從椅子左邊往上走到走道
        if (!s.chair || !img.far_chair) return null
        const out = s.chair.out, y = motion.anchors(key).sit.y - out
        const bl = boss && img.boss_chair_front ? inkLeft(img.boss_chair_front) : null
        const x0 = bl != null ? s.chair.x + s.chair.w * bl / img.boss_chair_front.width : s.chair.ink.x0
        return { out, dir: -1, slot: { x: s.cx, y }, side: { x: x0 - SIDE_GAP, y } }
      }
      if (!s.back || !img.chair_back) return null
      const out = s.back.h * PULL_K, y = motion.anchors(key).sit.y + out
      return { out, dir: 1, slot: { x: s.cx, y }, side: { x: s.back.x - SIDE_GAP, y } }
    },
    /** 一趟的分段：拉椅子的座位從 slot 出發／抵達，中間經過椅子左邊；其他照舊從站點出發 */
    plan(trip) {
      const A = motion.anchors(trip.from), dest = isSeat(trip.to) ? motion.anchors(trip.to) : null
      const B = dest ? { ...dest.stand, lane: dest.lane } : motion.spots()[trip.to]
      if (!A || !B) return null
      const who = st && st.people.find(x => x.id === trip.id), boss = !!(who && who.role === 'manager') // 主管椅比較寬
      const eA = motion.entry(trip.from, boss), eB = dest ? motion.entry(trip.to, boss) : null
      let path = motion.route(eA ? { ...eA.side, lane: A.lane } : { ...A.stand, lane: A.lane }, eB ? { ...eB.side, lane: dest.lane } : B)
      if (eA) path = [eA.slot, ...path]
      if (eB) path = [...path, eB.slot]
      path = path.filter((p, i, a) => i === 0 || Math.abs(p.x - a[i - 1].x) + Math.abs(p.y - a[i - 1].y) > 1e-6)
      const ms = d => d / trip.speed * 1000, { STAND_MS: SM, CHAIR_MS: CM } = motion
      const w0 = (eA ? CM : 0) + SM, walkMs = ms(motion.length(path)), w1 = w0 + walkMs
      const step = (e, a) => e ? Math.abs(e.slot.x - e.side.x) + (a.far ? Math.max(0, e.side.y - a.stand.y) : 0) : 0
      const stepA = step(eA, A), stepB = step(eB, dest)
      const end = w1 + (dest ? SM + (eB ? CM : 0) : 0)
      return { A, dest, B, eA, eB, path, w0, w1, end, stepA, stepB, len: motion.length(path), ms }
    },
    /** trip：{ from: 座位, to: 座位或 spots() 的鍵, start, speed }；回 { pose: sit／stand／walk, x, y, facing, phase?, k? }
     *  phase：pull（坐著跟椅子一起往後）、rise、step（椅子旁邊橫走，畫在椅子後面）、settle、push（坐著跟椅子一起靠回去） */
    pose(trip, t) {
      const P = motion.plan(trip)
      if (!P) return { pose: 'sit', x: 0, y: 0, facing: 'down' }
      const { A, dest, B, eA, eB, path, w0, w1 } = P, SM = motion.STAND_MS, CM = motion.CHAIR_MS
      const e = t - trip.start
      const lerp = (p, q, k) => ({ x: p.x + (q.x - p.x) * k, y: p.y + (q.y - p.y) * k })
      const atA = { seat: trip.from, far: A.far, d0: A.d0 }, atB = dest ? { seat: trip.to, far: dest.far, d0: dest.d0 } : {}
      if (e < 0) return { pose: 'sit', ...A.sit, ...atA }
      if (eA) {
        if (e < CM) { const k = e / CM; return { pose: 'sit', phase: 'pull', k, ...lerp(A.sit, eA.slot, k), facing: A.sit.facing, ...atA } }
        if (e < w0) return { pose: 'stand', phase: 'rise', k: (e - CM) / SM, ...eA.slot, facing: A.sit.facing, ...atA }
      } else if (e < SM) { const k = e / SM; return { pose: 'stand', phase: 'rise', k, ...lerp(A.sit, A.stand, k), facing: A.sit.facing, ...atA } }
      const d = (e - w0) / 1000 * trip.speed, w = e < w1 ? motion.at(path, d) : null
      if (w) {
        if (eA && d < P.stepA) return { pose: 'walk', phase: 'step', x: w.x, y: w.y, facing: w.facing, dist: d, ...atA }
        if (eB && d > P.len - P.stepB) return { pose: 'walk', phase: 'step', x: w.x, y: w.y, facing: w.facing, dist: d, ...atB }
        return { pose: 'walk', x: w.x, y: w.y, facing: w.facing, dist: d }
      }
      const e2 = e - w1
      if (dest && eB) {
        if (e2 < SM) return { pose: 'stand', phase: 'settle', k: Math.max(0, e2) / SM, ...eB.slot, facing: dest.sit.facing, ...atB }
        if (e2 < SM + CM) { const k = (e2 - SM) / CM; return { pose: 'sit', phase: 'push', k, ...lerp(eB.slot, dest.sit, k), facing: dest.sit.facing, ...atB } }
      } else if (dest && e2 < SM) { const k = Math.max(0, e2) / SM; return { pose: 'stand', phase: 'settle', k, ...lerp(dest.stand, dest.sit, k), facing: dest.sit.facing, ...atB } }
      return dest ? { pose: 'sit', ...dest.sit, ...atB } : { pose: 'stand', x: B.x, y: B.y, facing: B.facing }
    },
    tripMs(trip) { const P = motion.plan(trip); return P ? P.end : 0 },
    /** 這個座位的椅子現在往後拉了幾格（0＝靠在桌邊） */
    chairOut(key, now = Date.now()) {
      let out = 0
      for (const tr of trips.values()) {
        if (tr.from !== key && tr.to !== key) continue
        const P = motion.plan(tr); if (!P) continue
        const e = now - tr.start, CM = motion.CHAIR_MS, c = v => Math.max(0, Math.min(1, v))
        if (tr.from === key && P.eA) { // 坐著一起往後 → 等人走出椅子左邊再靠回去
          const back = P.w0 + P.ms(P.stepA)
          out = Math.max(out, P.eA.out * (e < CM ? c(e / CM) : c(1 - (e - back) / CM)))
        }
        if (tr.to === key && P.eB) { // 走到椅子左邊之前拉開 → 坐下後一起靠回去
          const at = P.w1 - P.ms(P.stepB), push = P.w1 + motion.STAND_MS
          out = Math.max(out, P.eB.out * (e < push ? c((e - (at - CM)) / CM) : c(1 - (e - push) / CM)))
        }
      }
      return out
    },
  }

  // ---------- 畫面 ----------
  const main = document.querySelector('main')
  const host = document.createElement('div'); host.id = 'v2'
  host.innerHTML = '<div id="v2wrap"><canvas id="v2c"></canvas><div id="v2ov"></div></div>'
  main.appendChild(host)
  const wrap = host.querySelector('#v2wrap'), cv = host.querySelector('#v2c'), ov = host.querySelector('#v2ov')
  const g = cv.getContext('2d')
  if (PO().demo) {
    const d = document.createElement('div'); d.id = 'v2demo'
    d.textContent = '示意資料：這些不是真的 session，跨平台角色只是示意，按了不會送出任何東西（換座位、改協作桌只改示意資料）'
    document.querySelector('header').after(d)
  }
  const ghost = document.createElement('div'); ghost.id = 'v2ghost'; document.body.appendChild(ghost)

  let st = null, layers = null, layerKey = '', scale = 1, K = 1, frame = 0, ovKey = '', items = []
  const bySeat = () => { const m = new Map(); for (const p of (st ? st.people : [])) if (p.seat != null) m.set(p.seat, p); return m }

  /** 協作桌：4 人桌切成「左端、一欄、右半」拼成 cols 欄（暫用；有專用美術再換） */
  function drawTable(ctx, im, x, y, cols) {
    if (!im) return
    const s = im.width / DESK_PX
    let dx = 0
    const piece = (a, b) => { ctx.drawImage(im, a * s, 0, (b - a) * s, im.height, x + dx * U, y, (b - a) * U, GH); dx += b - a }
    piece(0, CAP_PX)
    for (let c = 0; c < cols - 1; c++) piece(CAP_PX, CAP_PX + COL_PX)
    piece(CAP_PX + COL_PX, DESK_PX)
  }
  /** 辦公桌：4 人桌的遠側半張（暫用），補畫桌緣與地毯下緣 */
  function drawOffice(ctx, im, x, y, edge) {
    if (!im) return
    ctx.drawImage(im, 0, 0, im.width, im.height * OFFICE_CROP, x, y, GW, OH)
    if (edge) {
      ctx.fillStyle = '#c7ab7c'; ctx.fillRect(x + 40 * U, y + OH - 0.6, (1000 - 40) * U, 1.2)
      ctx.fillStyle = '#6e3a1c'; ctx.fillRect(x + 100 * U, y + OH - 1.4, (940 - 100) * U, 1.6)
    }
  }

  function buildLayers(night) {
    const W = Math.round(L.w * K), H = Math.round(L.h * K)
    const mk = () => { const c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d'); x.setTransform(K, 0, 0, K, 0, 0); x.imageSmoothingQuality = 'high'; return [c, x] }
    const [base, b] = mk(), [front, f] = mk(), [chairs, c] = mk()
    const fp = b.createPattern(img.floor_tile, 'repeat'); fp.setTransform(new DOMMatrix().scale(72 / M.floor_tile.w))
    b.fillStyle = fp; b.fillRect(0, 0, L.w, L.h)
    const wp = b.createPattern(img.wall_tile, 'repeat-x'); wp.setTransform(new DOMMatrix().scale(40 / M.wall_tile.h))
    b.fillStyle = wp; b.fillRect(0, 0, L.w, 40)
    b.fillStyle = '#0000001f'; b.fillRect(0, 40, L.w, 3)
    // 分區只靠「💻 辦公區」標籤；原本那條 1.2 格的分隔線看起來像地板裂縫（2026-11-23 拿掉）
    if (!L.tables.length) { b.strokeStyle = '#6e432688'; b.lineWidth = 0.6; b.setLineDash([2, 1.5]); b.strokeRect(SIDE + 6, L.collabTop - 8, L.w - 2 * SIDE - 12, 28); b.setLineDash([]) }
    items = decor(L.w, L.h)
    for (const it of items) {
      const name = it.name === 'window_day' && night ? 'window_night' : it.name
      if (it.what === 'pet') continue
      if (img[name]) b.drawImage(img[name], it.x, it.y, it.w, it.h)
    }
    b.fillStyle = '#6e4326'; b.fillRect(0, 0, 4, L.h); b.fillRect(L.w - 4, 0, 4, L.h); b.fillRect(0, L.h - 4, L.w, 4)
    b.fillStyle = '#9c6438'; b.fillRect(4, 0, 1, L.h); b.fillRect(L.w - 5, 0, 1, L.h)
    for (const t of L.tables) {
      if (t.art) { // 專用協作桌圖：底圖、桌面前景、近側椅子前景三層同位置
        const n = t.art.name
        b.drawImage(img[n], t.x, t.y, t.w, t.h); f.drawImage(img[n + '_over'], t.x, t.y, t.w, t.h)
        // 近側椅子：有背面圖就每個近側座位疊一張背面（蓋住桌圖裡的正面椅子與坐著的人的下半身）；沒有就用原本切出來的正面椅子
        // 有背面圖就每格現畫（拉椅子會動），見 draw() 的 drawChairs
        if (img.chair_back) { /* 每格畫 */ }
        else if (img[n + '_chairs']) c.drawImage(img[n + '_chairs'], t.x, t.y, t.w, t.h)
        continue
      }
      drawTable(b, img.desk, t.x, t.y, t.cols)
      drawTable(f, img.desk_over, t.x, t.y, t.cols)
      drawTable(c, img.desk_chairs, t.x, t.y, t.cols)
    }
    for (const d of L.desks) {
      if (d.art) { b.drawImage(img[d.art.name], d.x, d.y, d.w, d.h); f.drawImage(img[d.art.name + '_over'], d.x, d.y, d.w, d.h); continue }
      drawOffice(b, img.desk, d.x, d.y, true); drawOffice(f, img.desk_over, d.x, d.y, false)
    }
    return { base, front, chairs }
  }

  function relayout() {
    const people = st ? st.people : []
    const tables = (st && st.tables) || []
    const offIdx = people.map(p => /^o(\d+)$/.exec(p.seat || '')).filter(Boolean).map(m => +m[1])
    const officeNeed = Math.max(offIdx.length ? Math.max(...offIdx) + 1 : 0, offIdx.length + 1, 2)
    const cw = main.clientWidth || innerWidth
    const P = plan(cw, tables, officeNeed)
    // 使用者 2026-11-23：人少時不縮短場景、下面鋪休息角。桌牌兩行多用的格數（P.added）一起加進最小高度，休息角的空間跟原本一樣（審查 ①）
    const s0 = Math.min(cw / P.w, 3.2), minH = (innerHeight - 40) / s0 + (P.added || 0)
    if (P.h < minH) { P.extra = Math.ceil(minH - P.h); P.h += P.extra; P.spotLane += 0 }
    L = P
    scale = Math.min(cw / P.w, 3.2)
    // 美術 A #6：畫布像素跟螢幕像素 1:1（iPhone 是 3 倍螢幕；原本上限 2.5，瀏覽器再放大 1.2 倍、整張多一層糊）。
    // 長場景照舊受高度 14000 px 限制，另加總面積 1600 萬像素（iOS 畫布上限約 1670 萬）
    K = scale * Math.min(window.devicePixelRatio || 1, 3, 14000 / (P.h * scale), Math.sqrt(16e6 / (P.w * P.h * scale * scale)))
    const key = `${P.w}x${P.h}|${P.cols}|${P.tables.map(t => `${t.id}:${t.size}:${t.x.toFixed(1)}:${t.y}`).join(',')}|${P.desks.length}|${K.toFixed(3)}|${st && st.night ? 'n' : 'd'}`
    wrap.style.width = Math.floor(P.w * scale) + 'px'
    wrap.style.height = Math.floor(P.h * scale) + 'px'
    if (key !== layerKey) {
      layerKey = key
      cv.width = Math.round(P.w * K); cv.height = Math.round(P.h * K)
      layers = buildLayers(st && st.night)
      ovKey = ''
    }
  }

  // ---------- 全身角色 ----------
  function fullFrames(sp, facing, pose) {
    const ck = sp + '|' + facing + '|' + pose
    if (framesCache.has(ck)) return framesCache.get(ck)
    const r = fullFramesRaw(sp, facing, pose); framesCache.set(ck, r); return r
  }
  function fullFramesRaw(sp, facing, pose) {
    const get = (f, ps) => (fullIdx.get(sp + '|' + f + '|' + ps) || []).map(x => x.i)
    let fr = get(facing, pose), mirror = false
    if (!fr.length && facing === 'right') { fr = get('left', pose); mirror = fr.length > 0 }
    if (!fr.length && pose === 'walk') return fullFrames(sp, facing, 'stand')
    return fr.length ? { fr, mirror } : null
  }
  const hasFull = sp => !!(fullFrames(sp, 'down', 'sit') && fullFrames(sp, 'up', 'sit') && fullFrames(sp, 'down', 'stand'))
  // 新規格：畫布 448×512、1 格＝12.8 px、腳底在 (224, 500)；手機版 assets 存成一半（224×256，見 assets/import_characters.py），照圖寬換算。走 2.84 格換一格
  const NEW_W = 448, NEW_H = 512, NEW_PX = 12.8, NEW_AX = 224, NEW_AY = 500, STRIDE = 2.84
  const isNew = im => !!im && im.width * NEW_H === im.height * NEW_W && im.width >= NEW_W / 2
  /** 新規格的這個人有沒有某個動作（rise、sitdown、type） */
  const hasPose = (sp, facing, pose) => { const f = fullFrames(sp, facing, pose); return f && isNew(f.fr[0]) ? f : null }
  function drawFull(sp, q, tick = 0) {
    let pose = q.pose === 'sit' ? 'sit' : q.pose === 'walk' ? 'walk' : 'stand', idx = tick
    // 新規格：起立、坐下依進度選格；打字 4 格；走路依走過的距離換格（不滑腳）
    const ph = q.phase === 'rise' ? hasPose(sp, q.facing, 'rise') : q.phase === 'settle' ? hasPose(sp, q.facing, 'sitdown') : null
    if (ph) { pose = q.phase === 'rise' ? 'rise' : 'sitdown'; idx = Math.min(ph.fr.length - 1, Math.floor((q.k || 0) * ph.fr.length)) }
    else if (q.typing && hasPose(sp, q.facing, 'type')) { pose = 'type'; idx = tick }
    const f = fullFrames(sp, q.facing, pose) || fullFrames(sp, 'down', pose === 'sit' ? 'sit' : 'stand'); if (!f) return
    if (pose === 'walk' && q.dist != null && isNew(f.fr[0])) idx = Math.floor(q.dist / STRIDE)
    const im = f.fr[idx % f.fr.length]
    let w, h, x0, y0
    if (isNew(im)) { w = NEW_W / NEW_PX; h = NEW_H / NEW_PX; x0 = -NEW_AX / NEW_PX; y0 = q.y - NEW_AY / NEW_PX } // 坐、起立、坐下的 q.y 都是腳底線（場景大小只看規格，不看存檔解析度）
    else { h = pose === 'sit' ? SIT_H : STAND_H; w = h * im.width / im.height; x0 = -w / 2; y0 = q.y - h - (pose === 'sit' ? q.d0 || 0 : 0) }
    if (f.mirror) { g.save(); g.translate(q.x, 0); g.scale(-1, 1); g.drawImage(im, x0, y0, w, h); g.restore() }
    else g.drawImage(im, q.x + x0, y0, w, h)
  }
  /** 這個人坐在這個方向時是不是新規格（新圖不剪，交給椅子圖層遮） */
  const newSit = (sp, facing) => { const f = fullFrames(sp, facing, 'sit'); return !!(f && isNew(f.fr[0])) }
  function movers(now, layer, far) {
    const out = []
    for (const tr of trips.values()) {
      const p = st && st.people.find(x => x.id === tr.id); if (!p || !hasFull(p.species || 'claude')) continue
      const q = motion.pose(tr, now)
      if (q.pose === 'sit' && !q.phase) continue
      if (motion.layerOf(q) !== layer || (layer === 'seat' && q.far !== far)) continue
      out.push({ p, q })
    }
    return out.sort((a, b) => a.q.y - b.q.y)
  }
  const walking = id => { const tr = trips.get(id); if (!tr) return false; const q = motion.pose(tr, Date.now()); return q.pose !== 'sit' || !!q.phase }
  function drawSeated(key, p, s, bob) {
    const sp = p.species || 'claude'
    if (!hasFull(sp)) return drawChar(p, s, bob)
    if (walking(p.id)) return
    const an = motion.anchors(key), a = an.sit, nu = newSit(sp, a.facing)
    // 打字中：新規格正面、背面都播 type_0..3（每 140ms 一格、不再上下晃）；舊圖照舊：正面坐姿有第 1、2 格就輪流播，加上下晃
    const typeNew = p.mode === 'typing' && !!hasPose(sp, a.facing, 'type')
    const typing = !typeNew && p.mode === 'typing' && a.facing === 'down' && (fullFrames(sp, 'down', 'sit') || { fr: [] }).fr.length >= 3
    const clip = s.clipY != null && !nu
    if (clip) { g.save(); g.beginPath(); g.rect(0, 0, L.w, s.clipY); g.clip() }
    const b = bumpOf(p.id), q = { pose: 'sit', x: a.x, y: a.y + (nu ? 0 : bob) + b.dy, facing: a.facing, d0: an.d0, typing: typeNew }, fr = typeNew ? frame : typing ? 1 + (frame % 2) : 0
    drawFull(sp, q, fr)
    if (b.glow) { g.save(); g.globalCompositeOperation = 'lighter'; g.globalAlpha = b.glow; drawFull(sp, q, fr); g.restore() }
    if (clip) g.restore()
  }
  function drawChar(p, s, bob) {
    const name = `${p.species || 'claude'}_${s.far ? 'front' : 'back'}`, im = img[name] || img[`claude_${s.far ? 'front' : 'back'}`]
    if (!im) return
    const w = CHAR_W, h = w * ar(name), b = bumpOf(p.id)
    const y = (s.far ? s.bottom - h : s.top) + bob + b.dy
    g.drawImage(im, s.cx - w / 2, y, w, h)
    if (b.glow) { g.save(); g.globalCompositeOperation = 'lighter'; g.globalAlpha = b.glow; g.drawImage(im, s.cx - w / 2, y, w, h); g.restore() }
  }
  // 點人物：跳一下、亮一下（第 4 段，0.3 秒）；跳的高度取半格，維持像素感
  const bumps = new Map(), BUMP_MS = 300
  function bump(id) { if (PO().RM && PO().RM.matches) return; bumps.set(id, Date.now()); if (layers) draw() }
  function bumpOf(id) {
    const t0 = bumps.get(id); if (t0 == null) return { dy: 0, glow: 0 }
    const t = (Date.now() - t0) / BUMP_MS
    if (t >= 1) { bumps.delete(id); return { dy: 0, glow: 0 } }
    return { dy: -Math.round(Math.sin(Math.PI * t) * 6) / 2, glow: 0.5 * (1 - t) }
  }

  /** 美術 A #3：椅子貼齊實際螢幕像素（座標、寬高都取整到 1/K 格），不留半透明的接縫 */
  function snapDraw(im, x, y, w, h) {
    const x0 = Math.round(x * K) / K, y0 = Math.round(y * K) / K
    g.drawImage(im, x0, y0, Math.round((x + w) * K) / K - x0, Math.round((y + h) * K) / K - y0)
  }
  function draw() {
    if (!layers) return
    const seats = bySeat()
    const geo = new Map(); for (const [k] of seats) { const s = seatXY(k); if (s) geo.set(k, s) }
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, cv.width, cv.height)
    g.drawImage(layers.base, 0, 0)
    g.setTransform(K, 0, 0, K, 0, 0)
    g.imageSmoothingQuality = 'high'
    // 打字（手、螢幕字行）每 140ms 一格（frame）；身體上下晃、等待圖示跳、開會的點維持每 450ms 一格（slow），太快會抖
    const now = Date.now(), tick = Math.floor(now / 180), slow = Math.floor(now / 450)
    const bob = p => (p.mode === 'typing' && slow % 2 ? 0.5 : 0)
    // 主管椅：主管坐在遠側（協作桌 0 號或辦公區）時，在他背後疊酒紅金邊高背椅（蓋住原本的青綠椅背）
    if (img.far_chair) { // 遠側獨立椅子（底圖已拿掉遠側椅子）：每格畫，拉椅子時往上移；主管的位子（坐著或正在進出）換主管椅
      const boss = new Set()
      for (const [k, p] of seats) if (p.role === 'manager') boss.add(k)
      for (const tr of trips.values()) { const p = st && st.people.find(x => x.id === tr.id); if (p && p.role === 'manager') { boss.add(tr.from); boss.add(tr.to) } }
      for (const k of allSeats()) {
        const s = geo.get(k) || seatXY(k); if (!s || !s.far || !s.chair) continue
        const im = boss.has(k) && img.boss_chair_front ? img.boss_chair_front : img.far_chair
        snapDraw(im, s.chair.x, s.chair.y - motion.chairOut(k, now), s.chair.w, s.chair.h)
      }
    } else if (img.boss_chair) for (const [k, p] of seats) { const s = geo.get(k); if (s && s.far && s.boss && p.role === 'manager' && !walking(p.id)) g.drawImage(img.boss_chair, s.boss.x, s.boss.y, s.boss.w, s.boss.h) }
    for (const [k, p] of seats) { const s = geo.get(k); if (s && s.far) drawSeated(k, p, s, bob(p)) }
    for (const m of movers(now, 'seat', true)) drawFull(m.p.species || 'claude', m.q, tick)
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.drawImage(layers.front, 0, 0)
    g.setTransform(K, 0, 0, K, 0, 0)
    for (const [k, p] of seats) {
      const s = geo.get(k); if (!s) continue
      if (s.far) { g.fillStyle = p.mode === 'idle' ? '#e8b840' : '#4ade80'; g.beginPath(); g.arc(s.lid[2] - 1.6, s.lid[1] + 1.6, 0.55, 0, 7); g.fill(); continue }
      const r = s.scr, x = r[0] + 0.3, y = r[1] + 0.3, w = r[2] - r[0] - 0.6, h = r[3] - r[1] - 0.6
      g.fillStyle = SCREEN[p.mode] || SCREEN.idle; g.globalAlpha = 0.85; g.fillRect(x, y, w, h); g.globalAlpha = 1
      g.fillStyle = '#1e2433aa'
      const lines = p.mode === 'typing' || p.mode === 'reading' ? 4 : 2
      for (let i = 0; i < lines; i++) g.fillRect(x + 1.2, y + 1.2 + i * 1.6, (p.mode === 'typing' ? 2 + ((frame + i * 3) % 7) : 4 + (i % 2) * 2) * w / 12, 0.6)
    }
    for (const [k, p] of seats) { const s = geo.get(k); if (s && !s.far) drawSeated(k, p, s, bob(p)) }
    for (const m of movers(now, 'seat', false)) {
      const s = m.q.pose === 'sit' && m.q.seat && !newSit(m.p.species || 'claude', m.q.facing) ? seatXY(m.q.seat) : null
      if (s && s.clipY != null) { g.save(); g.beginPath(); g.rect(0, 0, L.w, s.clipY + motion.chairOut(m.q.seat, now)); g.clip() }
      drawFull(m.p.species || 'claude', m.q, tick)
      if (s && s.clipY != null) g.restore()
    }
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.drawImage(layers.chairs, 0, 0)
    g.setTransform(K, 0, 0, K, 0, 0)
    // 近側椅背：每格畫，拉椅子時往後（往下）移
    // 椅背標誌：近側有人坐（走路、起立中不貼；坐著跟椅子一起移動時跟著椅子）就貼他那家 AI 的標誌；Codex 用 ChatGPT 的；像素圖用最近鄰放大
    if (img.chair_back) {
      const owner = new Map()
      for (const [k, p] of seats) if (!walking(p.id)) owner.set(k, p)
      for (const tr of trips.values()) {
        const q = motion.pose(tr, now); if (!q.phase || !q.seat) continue // 起立、走出、走進、坐下、跟椅子一起移動時，標誌都留在椅背上
        const p = st && st.people.find(x => x.id === tr.id); if (p) owner.set(q.seat, p)
      }
      for (const t of L.tables) {
        if (!t.art) continue
        for (let i = 1; i < t.size; i += 2) {
          const k = `t${t.id}.${i}`, s = geo.get(k) || seatXY(k); if (!s || !s.back) continue
          const dy = motion.chairOut(k, now)
          snapDraw(img.chair_back, s.back.x, s.back.y + dy, s.back.w, s.back.h)
          const p = owner.get(k), lg = p && img['logo_' + (p.kind === 'codex' ? 'chatgpt' : p.species || 'claude')]; if (!lg) continue
          const sz = s.back.w * 0.3
          g.imageSmoothingEnabled = false
          g.drawImage(lg, s.back.lx - sz / 2, s.back.ly + dy - sz / 2, sz, sz)
          g.imageSmoothingEnabled = true
        }
      }
    }
    for (const m of movers(now, 'top', null)) drawFull(m.p.species || 'claude', m.q, tick)
    for (const [k, p] of seats) {
      const ic = ICON[p.mode]; if (!ic || !img['icon_' + ic]) continue
      const s = geo.get(k); if (!s) continue
      const sz = p.mode === 'waiting' ? 10 : 7.5, lift = p.mode === 'waiting' && slow % 2 ? 0.8 : 0
      const tr = trips.get(p.id), q = tr && hasFull(p.species || 'claude') ? motion.pose(tr, now) : null
      if (q && (q.pose !== 'sit' || q.phase)) { g.drawImage(img['icon_' + ic], q.x + 5, q.y - (q.pose === 'sit' ? SIT_H : STAND_H) - lift, sz, sz); continue }
      g.drawImage(img['icon_' + ic], s.cx + 5, (s.far ? s.top : s.top - 4) - lift, sz, sz)
    }
    // 整桌開會（第 9 項）：參與的人頭上冒對話泡泡（白底、三個點輪流變深）
    for (const [k, p] of seats) {
      if (!p.meeting || walking(p.id)) continue
      const s = geo.get(k); if (!s) continue
      // 選單美術第三批（ref3-H5）：米白切角框、深棕框線、左下小尾巴，三個方點輪流變青綠（三格循環）
      // 主管高背椅比較寬：泡泡往左移到椅背外面，不壓椅背
      const bl = bossLift(s, p) ? inkLeft(img.boss_chair_front) : null
      const x = bl != null ? Math.min(s.cx - 15, s.chair.x + s.chair.w * bl / img.boss_chair_front.width - 11.5) : s.cx - 15
      const y = (s.far ? s.top : s.top - 4) - 1.5 - bossLift(s, p), w = 11, h = 6, c = 0.9
      g.fillStyle = '#fffaf0'; g.strokeStyle = '#3b2412'; g.lineWidth = 0.55
      g.beginPath(); g.moveTo(x + c, y); g.lineTo(x + w - c, y); g.lineTo(x + w, y + c); g.lineTo(x + w, y + h - c); g.lineTo(x + w - c, y + h)
      g.lineTo(x + 3.6, y + h); g.lineTo(x + 2.2, y + h + 1.8); g.lineTo(x + 2.4, y + h); g.lineTo(x + c, y + h); g.lineTo(x, y + h - c); g.lineTo(x, y + c); g.closePath(); g.fill(); g.stroke()
      for (let i = 0; i < 3; i++) { g.fillStyle = slow % 3 === i ? '#3f7a6e' : '#d8c3a2'; g.fillRect(x + 2.3 + i * 2.6, y + h / 2 - 0.8, 1.6, 1.6) }
    }
    if (st && st.night) { g.fillStyle = '#101a4a55'; g.fillRect(0, 0, L.w, L.h) }
    drawMail(now)
    if (DEBUG) drawDebug()
    followTags(now)
  }

  // 走路中的全身角色：座位上的名牌先藏，另畫一個跟著走的名牌；點名牌、點身上都開狀態卡
  const walkTags = new Map()
  function followTags(now) {
    const live = new Set()
    for (const tr of trips.values()) {
      const p = st && st.people.find(x => x.id === tr.id); if (!p || !hasFull(p.species || 'claude')) continue
      const q = motion.pose(tr, now); if (q.pose === 'sit' && !q.phase) continue
      live.add(p.id)
      let w = walkTags.get(p.id)
      if (!w) {
        const cur = () => st && st.people.find(x => x.id === p.id)
        const el = document.createElement('span'); el.className = 'tag walking'; el.setAttribute('role', 'button'); el.tabIndex = 0
        el.addEventListener('click', ev => { ev.stopPropagation(); const c = cur(); if (c) PO().openChat(c) }) // 11-26 定案 A：點人物、名牌直接進完整對話
        const hit = document.createElement('button'); hit.className = 'seat walking'
        hit.addEventListener('click', ev => { ev.stopPropagation(); const c = cur(); if (c) PO().openChat(c) })
        const ring = document.createElement('span'); ring.className = 'ring walking'
        ov.append(hit, el, ring); w = { el, hit, ring }; walkTags.set(p.id, w)
      }
      const px = v => (v * scale).toFixed(1) + 'px'
      w.el.textContent = p.plate; w.el.classList.toggle('boss', p.role === 'manager'); w.el.setAttribute('aria-label', `${p.plate} 的狀態卡（走路中）`)
      w.el.style.left = px(q.x); w.el.style.top = px(q.y - STAND_H - 6.5)
      w.el.style.fontSize = Math.max(9, Math.min(13, 4.6 * scale)).toFixed(1) + 'px'
      w.hit.setAttribute('aria-label', `${p.plate}（走路中）`)
      Object.assign(w.hit.style, { left: px(q.x - 9), top: px(q.y - STAND_H), width: px(18), height: px(STAND_H) })
      w.ring.style.display = p.mode === 'waiting' ? '' : 'none'
      Object.assign(w.ring.style, { left: px(q.x + 10), top: px(q.y - STAND_H + 5), width: px(15), height: px(15) })
      for (const e of ov.querySelectorAll(`[data-seat="${p.seat}"]:not(.walking)`)) e.style.visibility = 'hidden'
      for (const e of ov.querySelectorAll(`.ring:not(.walking)`)) if (e.dataset.id === p.id) e.style.visibility = 'hidden'
    }
    for (const [id, w] of walkTags) if (!live.has(id) || !w.el.isConnected) {
      w.el.remove(); w.hit.remove(); w.ring.remove(); walkTags.delete(id)
      const p = st && st.people.find(x => x.id === id)
      if (p) for (const e of ov.querySelectorAll(`[data-seat="${p.seat}"]:not(.walking)`)) e.style.visibility = ''
      for (const e of ov.querySelectorAll('.ring:not(.walking)')) if (e.dataset.id === id) e.style.visibility = ''
    }
  }

  // ---------- 偵錯：?debug=paths 畫橫走道（藍）、直走道候選（紫）、坐點（藍）、站點（綠）、目的地（橘）、正在走的人的路線 ----------
  const DEBUG = new URLSearchParams(location.search).get('debug') === 'paths'
  function drawDebug() {
    g.save(); g.lineWidth = 0.5
    g.strokeStyle = '#2563ebcc'; g.setLineDash([2, 1.5])
    for (const y of motion.lanes()) { g.beginPath(); g.moveTo(SIDE, y); g.lineTo(L.w - SIDE, y); g.stroke() }
    g.setLineDash([])
    const dot = (p, c) => { g.fillStyle = c; g.beginPath(); g.arc(p.x, p.y, 1.1, 0, 7); g.fill() }
    for (const k of allSeats()) { const a = motion.anchors(k); if (a) { dot(a.sit, '#1d4ed8'); dot(a.stand, '#16a34a') } }
    for (const p of Object.values(motion.spots())) dot(p, '#ea580c')
    for (const tr of trips.values()) {
      const P = motion.plan(tr); if (!P) continue
      const path = P.path
      g.strokeStyle = '#7c3aedcc'; g.lineWidth = 0.8; g.beginPath(); path.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y))); g.stroke()
    }
    g.restore()
  }

  // ---------- 疊在上面的 DOM ----------
  const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  function overlay() {
    const seats = bySeat()
    const key = [layerKey, scale.toFixed(3), ...[...seats].map(([k, p]) => `${k}:${p.id}:${p.plate}:${p.mode}:${p.role}:${inApp(p) ? 1 : 0}`), ...awayList().map(a => `away:${a.id}:${a.seat || ''}:${a.plate}:${a.at || ''}`), ...L.tables.map(t => `${t.id}:${t.label || t.name}:${t.status || ''}:${t.noBoss ? 1 : 0}:${t.handover ? 1 : 0}:${t.suggestAdmin ? 1 : 0}:${t.meeting || ''}`)].join('|')
    if (key === ovKey) return
    ovKey = key
    const px = v => (v * scale).toFixed(1) + 'px'
    const fs = Math.max(9, Math.min(13, 4.6 * scale)).toFixed(1) + 'px'
    let html = ''
    // 家具只是擺設，不疊點擊區（使用者 2026-11-22：家具選單、寵物不要）
    // 分區標示：協作區（點了開協作桌清單）、辦公區
    html += `<button class="zone" data-zone="collab" style="left:${px(L.w / 2)};top:${px(L.collabTop - 22)};font-size:${fs}">🤝 協作區　＋</button>`
    html += `<span class="zone office" style="left:${px(L.w / 2)};top:${px(L.collabEnd + 1)};font-size:${fs}">💻 辦公區</span>`
    if (!L.tables.length) html += `<button class="zone add" data-zone="add" style="left:${px(L.w / 2)};top:${px(L.collabTop + 2)};font-size:${fs}">＋ 加協作桌（同主管底下的人會自動同桌）</button>`
    // 桌牌一眼看（roadmap 第 4 項）：桌名後面直接寫「3 人工作中・1 位等你」；有人等你就變橘色；桌名太長先縮桌名、狀態留著
    // 缺主管（第 5 項）：4 人以上沒有主管，桌牌變紅寫「缺主管」，點了挑一位升主管
    // 選單美術第三批（ref3-H5）：開會中＝第五種底（青綠）＋講台圖示；「建議加行政」另一顆小標籤（行政圖示），桌名、題目各自縮
    for (const t of L.tables) {
      const kind = t.noBoss ? 'err' : t.handover ? 'ho' : t.meeting ? 'meet' : t.waiting ? 'wait' : t.blocked ? 'err' : 'ok'
      const ic = t.noBoss || kind === 'err' ? 'warn' : t.handover ? 'hourglass' : t.meeting ? 'meeting' : t.waiting ? 'alarm' : 'pencil'
      // 美術 A #1：第一行只寫「桌名（N人）」（不再拼主管名），狀態放第二行；放不下先縮字、再換行，不硬截（fitPlates）
      const st2 = t.noBoss ? '缺主管' : t.handover ? '主管交接中' : t.meeting ? `開會中：<span class="tm">${esc(t.meeting)}</span>` : t.grouped ? `已成組・${esc(t.status || '')}` : t.status ? esc(t.status) : ''
      const mw = Math.max(t.w, 70)
      const plate = `<button class="tplate ${kind}" data-table="${t.id}" title="${esc(t.name)}（${t.size}人）${t.noBoss ? '・缺主管' : ''}${t.meeting ? '・開會中：' + esc(t.meeting) : ''}${t.status ? '・' + esc(t.status) : ''}"><span class="tline"><i class="ico ${ic}"></i><span class="tl">${esc(t.name)}</span><span class="tn">（${t.size}人）</span></span>${st2 ? `<span class="ts">${st2}</span>` : ''}</button>`
      const sug = t.suggestAdmin ? `<button class="tsugbtn" data-sug="${t.id}" title="建議加行政（點了開招聘）"><span class="tsug"><i class="ico admin"></i>建議加行政</span></button>` : ''
      html += `<div class="tpwrap" style="left:${px(t.x + t.w / 2)};top:${px(t.y + t.h + (L.signDy || SIGN_DY))};font-size:${fs};max-width:${px(mw)}">${plate}${sug}</div>`
    }
    for (const k of allSeats()) {
      const s = seatXY(k), p = seats.get(k); if (!s) continue
      const label = p ? `${p.plate}（${ZH[p.mode] || p.modeText || p.mode}${p.approval ? '：' + p.approval : ''}）${p.demo ? '・示意 ' + SPZH[p.species] : ''}${p.kind === 'codex' ? '・Codex' : ''}${inApp(p) ? '・在 App 裡' : ''}` : `空位（${s.zone === 'collab' ? s.table.name : '辦公區'}）`
      html += `<button class="seat${p ? '' : ' empty'}" data-seat="${k}" aria-label="${esc(label)}" title="${esc(label)}" style="left:${px(s.cx - 14)};top:${px(s.top)};width:${px(28)};height:${px(s.bottom - s.top)}"></button>`
      if (!p) continue
      const ty = s.far ? s.top - 6.5 - bossLift(s, p) : s.gp.y + s.H + 0.5
      const cls = p.mode === 'waiting' ? ' wait' : p.mode === 'blocked' ? ' err' : ''
      html += `<span class="tag${p.role === 'manager' ? ' boss' : ''}${cls}" data-seat="${k}" role="button" tabindex="0" aria-label="${esc(p.plate)} 的狀態卡" title="狀態卡：${esc(p.plate)}${inApp(p) ? '（在 App 裡）' : ''}" style="left:${px(s.cx)};top:${px(ty)};max-width:${px(36)};font-size:${fs}">${esc(p.plate)}</span>` + (inApp(p) ? `<span class="tapp${s.far ? '' : ' up'}" style="left:${px(s.cx)};top:${px(ty)};font-size:${fs}">在 App 裡</span>` : '')
      if (p.mode === 'waiting') html += `<span class="ring" data-id="${esc(p.id)}" style="left:${px(s.cx + 10)};top:${px((s.far ? s.top : s.top - 4) + 5)};width:${px(15)};height:${px(15)}"></span>`
    }
    const ghostSeats = new Set()
    for (const a of [...awayList()].sort((x, y) => (y.at || 0) - (x.at || 0))) { // 同一空位多筆：只畫最新那筆（審查 17）
      if (!a.seat || seats.get(a.seat) || ghostSeats.has(a.seat)) continue
      const s = seatXY(a.seat); if (!s) continue
      ghostSeats.add(a.seat)
      const ty = s.far ? s.top - 6.5 : s.gp.y + s.H + 0.5
      html += `<span class="tag ghost" data-away="${esc(a.id)}" role="button" tabindex="0" aria-label="${esc(a.plate)}：在 App 裡" title="${esc(a.plate)}：在 App 裡" style="left:${px(s.cx)};top:${px(ty)};max-width:${px(36)};font-size:${fs}">${esc(a.plate)}</span><span class="tapp${s.far ? '' : ' up'}" style="left:${px(s.cx)};top:${px(ty)};font-size:${fs}">在 App 裡</span>`
    }
    ov.innerHTML = html
    fitPlates()
  }
  /** 美術 A #1：桌牌第一行（桌名（N人））放不下：先縮字到 75%，還不行才換行；第二行狀態一樣先縮字（開會題目最後才用省略號） */
  function fitPlates() {
    for (const el of ov.querySelectorAll('.tplate .tline, .tplate .ts')) {
      let k = 1
      while (el.scrollWidth > el.clientWidth + 1 && k > 0.76) { k -= 0.05; el.style.fontSize = k.toFixed(2) + 'em' }
      if (el.scrollWidth > el.clientWidth + 1 && el.classList.contains('tline')) el.classList.add('wrap')
    }
  }

  function render() { if (!st || !geom || !tier1) return; needTables(); relayout(); draw(); overlay() }
  const trips = new Map(), lastSeat = new Map(), WALK_SPEED = 36
  function trackTrips(j, now = Date.now()) {
    if (!L || !items.length) return
    for (const p of j.people || []) {
      const was = lastSeat.get(p.id)
      if (was != null && p.seat != null && was !== p.seat && seatXY(was) && seatXY(p.seat)) trips.set(p.id, { id: p.id, from: was, to: p.seat, start: now, speed: WALK_SPEED })
      if (p.seat != null) lastSeat.set(p.id, p.seat)
    }
    for (const [id, t] of trips) if (now > t.start + motion.tripMs(t) + 200 || !(j.people || []).some(p => p.id === id) || !seatXY(t.from) || !seatXY(t.to)) trips.delete(id)
  }
  // ---------- 傳話的紙飛機（roadmap 第 3 項，跟 Desktop 面板一樣）：寄件人 sentAt 變了就從寄件人飛到收件人（sentToId），飛到後收件人頭上冒信封；
  // 只收到（寄件人不在辦公室、gotAt 變了）就只冒信封。第一次看到的不算（重新整理不會把舊信再飛一次）
  const PLANE_MS = 1600, ENV_MS = 4000
  const mail = { planes: [], envs: [], sent: new Map(), got: new Map() }
  function trackMail(j, now = Date.now()) {
    const ppl = j.people || []
    for (const p of ppl) {
      if (mail.sent.has(p.id) && p.sentAt && p.sentAt !== mail.sent.get(p.id) && p.sentToId && ppl.some(x => x.id === p.sentToId)) {
        mail.planes.push({ from: p.id, to: p.sentToId, start: now })
        mail.envs = mail.envs.filter(e => e.id !== p.sentToId)
        mail.envs.push({ id: p.sentToId, start: now + PLANE_MS, end: now + PLANE_MS + ENV_MS })
        const r = ppl.find(x => x.id === p.sentToId); if (r) mail.got.set(r.id, r.gotAt) // 這封已用飛機表現
      }
      mail.sent.set(p.id, p.sentAt)
    }
    for (const p of ppl) {
      if (mail.got.has(p.id) && p.gotAt && p.gotAt !== mail.got.get(p.id) && !mail.envs.some(e => e.id === p.id)) mail.envs.push({ id: p.id, start: now, end: now + ENV_MS })
      mail.got.set(p.id, p.gotAt)
    }
    mail.planes = mail.planes.filter(pl => now - pl.start <= PLANE_MS)
    mail.envs = mail.envs.filter(e => now < e.end)
  }
  const mailBusy = (now = Date.now()) => mail.planes.some(pl => now - pl.start <= PLANE_MS) || mail.envs.some(e => now < e.end)
  function spotOf(id) {
    const p = st && st.people.find(x => x.id === id); if (!p || !p.seat) return null
    const s = seatXY(p.seat); return s ? { x: s.cx, y: (s.far ? s.top : s.top - 4) - bossLift(s, p) } : null
  }
  function drawMail(now) {
    for (const pl of mail.planes) {
      const a = spotOf(pl.from), b = spotOf(pl.to), t = (now - pl.start) / PLANE_MS
      if (!a || !b || t < 0 || t > 1) continue
      const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t - Math.sin(Math.PI * t) * 14, d = Math.sign(b.x - a.x) || 1
      g.save(); g.translate(x, y); g.scale(d * 1.4, 1.4)
      g.fillStyle = '#f1f8ff'; g.strokeStyle = '#566c86'; g.lineWidth = 0.3
      g.beginPath(); g.moveTo(3, 0); g.lineTo(-4, -2.6); g.lineTo(-1.6, 0); g.lineTo(-4, 2.6); g.closePath(); g.fill(); g.stroke()
      g.fillStyle = '#b0bec5'; g.beginPath(); g.moveTo(-1.6, 0); g.lineTo(-4, 2.6); g.lineTo(-2.4, 0.4); g.closePath(); g.fill()
      g.restore()
    }
    for (const e of mail.envs) {
      if (now < e.start || now >= e.end) continue
      const s = spotOf(e.id); if (!s) continue
      const w = 9, h = 6, x = s.x - w / 2, y = s.y - 9 - (Math.floor(now / 300) % 2 ? 0.8 : 0)
      g.fillStyle = '#fff8e1'; g.strokeStyle = '#d84315'; g.lineWidth = 0.5
      g.fillRect(x, y, w, h); g.strokeRect(x, y, w, h)
      g.beginPath(); g.moveTo(x, y); g.lineTo(x + w / 2, y + h * 0.55); g.lineTo(x + w, y); g.stroke()
    }
  }
  // ---------- 自動多開幫手（roadmap 第 13 項）：主管請求加幫手 → 頁面上方跳通知（加／不要）；幫手閒置快被關 → 通知（留著） ----------
  const helpBar = document.createElement('div')
  helpBar.id = 'v2help'
  helpBar.style.cssText = 'position:fixed;left:8px;right:8px;top:56px;z-index:50;display:none;flex-direction:column'
  document.body.appendChild(helpBar)
  let helpKey = '', seenAsks = null, seenChecks = null, lastHelp = null
  // 通知列平常收成一行小條（0.62.17，B 評估：展開的通知列擋場景點擊）：點小條才展開；有新通知自動展開一次，
  // 8 秒沒動作就自己縮回（在裡面按、捲、打字就不縮）；展開最高 40vh 可捲（scene.css）
  let helpOpen = false, helpTimer = 0
  const helpSeen = new Set()
  function setHelpOpen(open, auto) {
    helpOpen = open; clearTimeout(helpTimer)
    helpBar.classList.toggle('mini', !open)
    if (open && auto) helpTimer = setTimeout(() => setHelpOpen(false), 8000)
  }
  for (const ev of ['pointerdown', 'focusin', 'wheel', 'touchstart', 'keydown']) helpBar.addEventListener(ev, () => clearTimeout(helpTimer), { passive: true })
  helpBar.addEventListener('scroll', () => clearTimeout(helpTimer), { passive: true })
  const hidden = new Set() // 答過、留過、按 × 收起的：這頁不再顯示（有新的才再跳）
  function renderHelp(j) {
    lastHelp = j
    const h0 = j.helpers || { asks: [], notices: [] }
    const h = { asks: h0.asks.filter(a => !hidden.has(a.id)), notices: h0.notices.filter(n => !hidden.has(n.sid + n.closeAt)) }
    const ho = handoverItems(j)
    const mt = ((j.meetings && j.meetings.done) || []).filter(m => !hidden.has('meet:' + m.id))
    // 新員工卡在電腦上的確認畫面（0.63.3）：伺服器偵測，畫面不在了自己消失；不代按
    const sk = (j.stuck || []).filter(s => !hidden.has('stuck:' + s.id))
    // Codex 交給 App 好了（工程師B 0.63.28）：提醒到 App 打開那段對話；按「知道了」收掉
    const cxk = x => 'cxh:' + x.id + ':' + (x.at || '') // 審查 18：同一段再交一次（at 不同）要再通知
    const cxh = (j.codexHandoffs || []).filter(x => !hidden.has(cxk(x)))
    // Codex 生圖幫手要人工確認（工程師B 0.63.40／0.63.41）：每一件狀況用「幫手 ID＋開始時間」當 key，按「知道了」只收這一件；
    // 狀況解除（伺服器不再列）就把舊的收起紀錄清掉，之後再發生（新的開始時間）會再出現
    const hck = c => 'hcheck:' + c.id + ':' + (c.at || 0)
    const hcAll = h0.checks || [], hcNow = new Set(hcAll.map(hck))
    for (const k of [...hidden]) if (typeof k === 'string' && k.startsWith('hcheck:') && !hcNow.has(k)) hidden.delete(k)
    const hc = hcAll.filter(c => !hidden.has(hck(c)))
    const key = JSON.stringify([h.asks.map(a => a.id), h.notices.map(n => n.sid), ho.map(x => x.key), mt.map(m => m.id), sk.map(s => s.id + s.title + (s.options || []).map(o => o.label).join('|')), cxh.map(x => [cxk(x), x.plate, x.title]), hc.map(hck)])
    if (key === helpKey) return
    helpKey = key
    // 新請求：有權限就跳系統通知、手機震動（沒權限不另外問）
    const ids = h.asks.map(a => a.id)
    if (seenAsks) for (const a of h.asks) if (!seenAsks.has(a.id)) {
      try { if (window.Notification && Notification.permission === 'granted') new Notification('像素辦公室', { body: `${a.table || a.plate} 想加一位${a.kind === 'codex-art' ? ' Codex 生圖' : ''}幫手：${a.reason}` }) } catch {}
      try { navigator.vibrate && navigator.vibrate(200) } catch {}
    }
    seenAsks = new Set(ids)
    if (seenChecks) for (const c of hc) if (!seenChecks.has(hck(c))) {
      try { if (window.Notification && Notification.permission === 'granted') new Notification('像素辦公室', { body: `幫手 ${c.name}${c.why}，請到電腦上看` }) } catch {}
      try { navigator.vibrate && navigator.vibrate(200) } catch {}
    }
    seenChecks = new Set(hc.map(hck))
    // 照參考圖 ref2-F6：外框「辦公室通知」＋收起；一則一張卡（圖示＋標題、一行說明、按鈕）
    const card = (ic, title, desc, btns, cls = '') => `<div class="ncard${cls}"><div class="nt"><i class="ico ${ic}"></i><b>${title}</b></div>${desc ? `<div class="nd">${desc}</div>` : ''}<div class="nb">${btns}</div></div>`
    const total = h.asks.length + h.notices.length + ho.length + mt.length + sk.length + cxh.length + hc.length
    helpBar.innerHTML = `<button class="nmini" id="v2helpmini" aria-label="辦公室通知 ${total} 則，點開"><i class="ico megaphone"></i><span>辦公室通知</span><span class="v2dot">${total}</span><i class="nchev"></i></button>` +
      `<div class="nhead"><b>辦公室通知</b><button id="v2helpx" class="mbtn" aria-label="收起">收起</button></div>` +
      // 0.63.4：畫面上解析得出選項的，列成按鈕，點了由伺服器替他按（只送這些選項）；解析不出來的照舊只提醒
      sk.map(s => { const op = s.options || []
        if (s.win) return card('warn', `新員工 ${esc(s.name)} 開了但還沒進辦公室`, `可能停在確認畫面（例如信任資料夾、權限）。請到電腦上找 ${esc(s.session)} 的視窗${s.dir ? `（資料夾 ${esc(s.dir)}；如果停在信任詢問，標題可能顯示 claude）` : '（如果停在信任詢問，標題可能顯示 claude）'}`,
          `<span></span><button class="mbtn" data-stuckok="${esc(s.id)}">知道了</button>`, ' hstuck')
        return card('warn', `新員工 ${esc(s.name)} 卡在電腦上的確認畫面`,
          `畫面：${esc(s.title)}。${op.length ? '在這裡選一項，辦公室替他按；或' : '請'}到電腦上執行 <code>tmux attach -t ${esc(s.session)}</code> 處理`,
          (op.length ? `<div class="nopts">${op.map(o => `<button class="mbtn${/^\d\./.test(o.label) ? '' : ' sub'}" data-stuckid="${esc(s.id)}" data-stuckopt="${esc(o.id)}" data-stucklabel="${esc(o.label)}">${esc(o.label)}</button>`).join('')}</div>` : '<span></span>') +
          `<button class="mbtn" data-stuckok="${esc(s.id)}">知道了</button>`, ' hstuck') }).join('') +
      cxh.map(x => card('check', `可以在 App 打開「${esc(x.title || x.plate || '這段對話')}」接著聊了`, `${esc(x.plate || 'Codex')} 已經交給 ChatGPT／Codex App，在 App 的對話清單裡找這個名字`,
        `<span></span><button class="mbtn" data-cxhok="${esc(cxk(x))}">知道了</button>`, ' hcxh')).join('') +
      h.asks.map(a => card('helper', `${esc(a.table || a.plate)}想加一位${a.kind === 'codex-art' ? ' Codex 生圖' : ''}幫手`, `${esc(a.plate)} 請求：${esc(a.reason)}${a.task ? '；要做：' + esc(a.task.slice(0, 80)) : ''}${a.online === false ? '（主管已不在線）' : ''}`,
        `<button class="mbtn go" data-ask="${esc(a.id)}" data-op="yes">加</button><button class="mbtn" data-ask="${esc(a.id)}" data-op="no">不要</button>`, ' hask')).join('') +
      hc.map(c => card('warn', `幫手 ${esc(c.name)}${esc(c.why)}`, c.retry ? `下一輪會再試自動關閉；也可以到電腦上看 <code>tmux ${esc(c.session)}</code>，或手動解雇` : `辦公室不會自動關它。請到電腦上看 <code>tmux ${esc(c.session)}</code>，要關就手動解雇`,
        `<span></span><button class="mbtn" data-hcheck="${esc(hck(c))}">知道了</button>`, ' hcheck')).join('') +
      h.notices.map(n => card('alarm', `幫手 ${esc(n.name)} 閒置快 30 分鐘`, `約 ${Math.max(1, Math.round((n.closeAt - Date.now()) / 60e3))} 分鐘後自動關閉。`,
        `<span></span><button class="mbtn" data-keep="${esc(n.sid)}">留著</button>`, ' hnote')).join('') +
      ho.map(x => handoverHtml(x, card)).join('') +
      // 整桌開會開完了（第 9 項）：點開看結論
      mt.map(m => card('check', `「${esc(m.label)}」開完會了`, `題目：${esc(m.topic)}`, `<button class="mbtn go" data-meet="${esc(m.id)}">看結論</button><button class="mbtn" data-meetok="${esc(m.id)}">知道了</button>`)).join('')
    // 通知列從上方狀態列（與示意資料橫幅）下面開始，不壓到它們
    const above = document.getElementById('v2demo') || document.querySelector('header')
    if (above) helpBar.style.top = Math.round(above.getBoundingClientRect().bottom + 4) + 'px'
    // 通知從上方滑入、收起時滑出（第 4 段）
    if (total) PO().pop(helpBar, 'flex'); else PO().unpop(helpBar)
    // 有沒看過的通知：自動展開一次；其他時候維持原本展開／收合
    const keys = [...h.asks.map(a => 'a:' + a.id), ...h.notices.map(n => 'n:' + n.sid + n.closeAt), ...ho.map(x => x.key), ...mt.map(m => 'meet:' + m.id), ...sk.map(s => 'stuck:' + s.id + s.title), ...cxh.map(cxk), ...hc.map(hck)]
    const fresh = keys.filter(k => !helpSeen.has(k)); keys.forEach(k => helpSeen.add(k))
    if (fresh.length) setHelpOpen(true, true); else setHelpOpen(helpOpen && total > 0)
    document.getElementById('v2helpmini').addEventListener('click', () => setHelpOpen(true))
    helpBar.querySelectorAll('[data-meet]').forEach(b => b.addEventListener('click', () => { hidden.add('meet:' + b.dataset.meet); helpKey = ''; renderHelp(lastHelp); showMeetingResult(b.dataset.meet) }))
    helpBar.querySelectorAll('[data-stuckopt]').forEach(b => b.addEventListener('click', async () => {
      helpBar.querySelectorAll(`[data-stuckid="${b.dataset.stuckid}"]`).forEach(x => { x.disabled = true }); b.textContent = '按下去了…'
      const r = await PO().post('/stuck', { id: b.dataset.stuckid, opt: b.dataset.stuckopt, label: b.dataset.stucklabel })
      toast(r.text || r.error || '沒有回應'); helpKey = ''; PO().load()
    }))
    helpBar.querySelectorAll('[data-stuckok]').forEach(b => b.addEventListener('click', () => { hidden.add('stuck:' + b.dataset.stuckok); helpKey = ''; renderHelp(lastHelp) }))
    helpBar.querySelectorAll('[data-hcheck]').forEach(b => b.addEventListener('click', () => { hidden.add(b.dataset.hcheck); helpKey = ''; renderHelp(lastHelp) }))
    helpBar.querySelectorAll('[data-cxhok]').forEach(b => b.addEventListener('click', () => { hidden.add(b.dataset.cxhok); helpKey = ''; renderHelp(lastHelp) }))  // 工程師B：伺服器只留 1 小時，前端藏起來就好
    helpBar.querySelectorAll('[data-meetok]').forEach(b => b.addEventListener('click', () => { hidden.add('meet:' + b.dataset.meetok); helpKey = ''; renderHelp(lastHelp) }))
    bindHandover(helpBar)
    helpBar.querySelectorAll('[data-ask]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true
      const r = await PO().post('/helper', { ask: b.dataset.ask, op: b.dataset.op })
      toast(r.text || r.error || '沒有回應'); hidden.add(b.dataset.ask); helpKey = ''; renderHelp(lastHelp); PO().load()
    }))
    helpBar.querySelectorAll('[data-keep]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true
      const r = await PO().post('/helper-keep', { sid: b.dataset.keep })
      const n = h.notices.find(x => x.sid === b.dataset.keep); if (n) hidden.add(n.sid + n.closeAt)
      toast(r.text || r.error || '沒有回應'); helpKey = ''; renderHelp(lastHelp); PO().load()
    }))
    const x = document.getElementById('v2helpx')
    if (x) x.addEventListener('click', () => setHelpOpen(false)) // 收起＝縮回小條（通知還在；按各則的「知道了」才拿掉）
  }

  // 通知列縮回小條（等同按「收起」）：從通知列開結論頁時用，不然結論頁被通知列蓋住
  function hideHelpBar() { setHelpOpen(false) }
  // ---------- 換主管交接（roadmap 第 6 項，0.62.8）：要問使用者的（原主管沒交接／離線）、換好了的通知；放在同一條通知列 ----------
  function handoverItems(j) {
    const v = j.handovers || { asks: [], done: [] }
    return [...v.asks.map(a => ({ ...a, key: `ho:${a.id}:${a.kind}`, ask: true })), ...v.done.map(d => ({ ...d, key: `hodone:${d.id}` }))].filter(x => !hidden.has(x.key))
  }
  function handoverHtml(x, card) {
    if (!x.ask) return card('check', `「${esc(x.label)}」交接完成`, `${esc(x.newName)} 已接任主管，${esc(x.oldName)} 改為員工。`, `<span></span><button class="mbtn" data-hook="${esc(x.key)}">知道了</button>`)
    const btn = (op, t, go) => `<button class="mbtn${go ? ' go' : ''}" data-hoid="${esc(x.id)}" data-hokey="${esc(x.key)}" data-hoop="${op}">${t}</button>`
    if (x.kind === 'wait') return card('hourglass', `「${esc(x.label)}」主管交接等待確認`, `${esc(x.oldName)} 5 分鐘內未交接給 ${esc(x.newName)}。要等，還是直接換？`, btn('wait', '再等 5 分鐘') + btn('swap', '直接換', true))
    return card('warn', `「${esc(x.label)}」原主管離線`, `${esc(x.oldName)} 離線了。要直接讓 ${esc(x.newName)} 接任嗎？（他會讀 collab.md、檢查點接手）`, btn('swap', '直接換', true) + btn('cancel', '不換'))
  }
  function bindHandover(bar) {
    bar.querySelectorAll('[data-hoop]').forEach(b => b.addEventListener('click', async () => {
      b.disabled = true
      const r = await PO().post('/handover', { ask: b.dataset.hoid, op: b.dataset.hoop })
      toast(r.text || r.error || '沒有回應'); hidden.add(b.dataset.hokey); helpKey = ''; renderHelp(lastHelp); PO().load()
    }))
    bar.querySelectorAll('[data-hook]').forEach(b => b.addEventListener('click', () => { hidden.add(b.dataset.hook); helpKey = ''; renderHelp(lastHelp) }))
  }

  /**
   * 不在名冊上的 App Codex（工程師B 0.63.28 state.codexAway：交出去還沒在 App 打開、已在 App 關掉、或在 App 新開的）
   * 每筆 { id, plate, title, at, handedOff, resumable, why?, seat? }：有 seat 就在那個座位畫半透明名牌「在 App 裡」；人事室另列一區。
   * 0.63.48 乙案：沒有座位的（在 App 新開的）在畫面最下面一條灰卡，24 小時內（伺服器只給一天內的），不佔座位；點了開同一張「接回後台」選單。
   * plate＝在線時卡片上的名字（名牌＋同名編號）；at＝交出去或在 App 關掉的時間
   */
  const awayList = () => { const j = (PO().state && PO().state()) || st; return (j && j.codexAway) || [] } // 複驗 17：讀最新 state，不等場景的 st 更新
  const two2 = n => String(n).padStart(2, '0')
  const awayWhen = (at, sec) => { if (!at) return ''; const d = new Date(at), n = new Date(), t = two2(d.getHours()) + ':' + two2(d.getMinutes()) + (sec ? ':' + two2(d.getSeconds()) : ''); return d.toDateString() === n.toDateString() ? t : `${d.getMonth() + 1}/${d.getDate()} ${t}` }
  /** 同名都列（主管裁示）：名字一樣、關掉時間又在同一分鐘的，時間加秒才分得出來；回 id → 顯示的時間 */
  const awayTimes = list => { const m = new Map(); for (const a of list) { const sec = list.some(b => b !== a && b.plate === a.plate && awayWhen(b.at) === awayWhen(a.at)); m.set(a.id, awayWhen(a.at, sec)) } return m }
  const awayStrip = document.createElement('div')
  awayStrip.id = 'v2away'; awayStrip.setAttribute('role', 'group'); awayStrip.setAttribute('aria-label', '在 App 裡關掉的 Codex')
  document.body.appendChild(awayStrip)
  let awayStripKey = null
  function drawAwayStrip() {
    const list = awayList().filter(a => !a.seat).sort((x, y) => (y.at || 0) - (x.at || 0))
    const tm = awayTimes(awayList())
    const k = list.map(a => `${a.id}:${a.plate}:${tm.get(a.id)}:${a.resumable ? 1 : 0}`).join('|')
    if (k === awayStripKey) return
    awayStripKey = k
    awayStrip.style.display = list.length ? '' : 'none'
    awayStrip.innerHTML = list.map(a => `<button type="button" class="awcard" data-away="${esc(a.id)}" aria-label="${esc(a.plate)}：${a.handedOff ? '交給 App' : '在 App 裡關了'} ${esc(tm.get(a.id))}，點了可接回後台"><b>${esc(a.plate)}</b><small>${a.handedOff ? '交給 App' : '在 App 裡關了'}${a.at ? '・' + esc(tm.get(a.id)) : ''}</small></button>`).join('')
  }
  awayStrip.addEventListener('click', ev => { const b = ev.target.closest('.awcard'); if (b) awayGo(b.dataset.away) })
  // 第二階段（B③）：灰卡點了進完整對話（唯讀，頂端「接回後台」）；舊前端沒有 openAwayChat 時照舊開接回選單
  const awayGo = id => PO().openAwayChat ? PO().openAwayChat(id) : openAway(id)
  let awayOpen = null // { id, sid }：開著的離線選單（審查 17：狀態更新時重畫，按鈕跟著能不能接回變）
  const awayHtml = a => `<div class="mcard"><b>在 ChatGPT／Codex App 裡</b><small>${esc(a.title || '')}${a.title ? '・' : ''}${a.handedOff ? '從辦公室交過去的' : '在 App 新開的'}</small></div>` +
    (a.resumable ? '<div class="note">接回後台後回到辦公室，可以從手機換智力、打斷、解雇。</div><button class="mbtn go" id="awaygo">🖥 接回後台</button>'
      : `<div class="note">${esc(a.why || '現在接不回來')}</div><button class="mbtn" disabled>🖥 接回後台</button>`)
  let awayKey = '', awaySending = false
  function drawAway(fill) {
    if (!awayOpen || awaySending) return
    if (fill && PO().sheetId() !== awayOpen.sid) { awayOpen = null; return } // 使用者已關掉或換了選單
    const a = awayList().find(x => x.id === awayOpen.id)
    if (!a) { if (fill) { awayOpen = null; awayKey = ''; PO().sheet('在 App 裡', '<div class="note">這位已經不在 App 清單上（可能接回辦公室了）</div>', true) } return }
    const k = JSON.stringify([a.plate, a.title, a.handedOff, a.resumable, a.why])
    if (fill && k === awayKey) return
    awayKey = k
    if (fill) PO().sheet(`${a.plate}`, awayHtml(a), true); else { sheet(`${a.plate}`, awayHtml(a)); awayOpen.sid = PO().sheetId() }
    const go = document.getElementById('awaygo')
    if (go) go.addEventListener('click', async () => {
      const cur = awayList().find(x => x.id === awayOpen.id) // 提交前重取：App 又拿回鎖就不送
      if (!cur || !cur.resumable) { awayKey = ''; drawAway(true); toast(cur ? cur.why || '現在接不回來' : '這位已經不在 App 清單上'); return }
      if (!PO().reqLock(cur.id)) return
      const sid = awayOpen.sid
      awaySending = true; go.disabled = true; go.textContent = '確認中…'
      let r
      try { r = await PO().post('/codex-handoff', { id: cur.id, to: 'tmux' }) } finally { awaySending = false; PO().reqUnlock() }
      toast(`${cur.plate}：${r.text || r.error || '沒有回應'}`)
      const same = PO().sheetId() === sid // 審查 16：回來時還是同一個選單才動它
      if (r.ok && same) { awayOpen = null; closeSheet() } else if (same) { awayKey = ''; drawAway(true) }
      PO().load()
    })
  }
  function openAway(id) {
    if (awaySending || (PO().reqBusy && PO().reqBusy())) { toast('上一個還在確認，等一下再按'); return } // 複驗①：送出中不換選單
    if (!awayList().some(x => x.id === id)) { toast('這位已經不在 App 清單上'); return }
    awayOpen = { id, sid: 0 }; awayKey = ''; drawAway(false)
  }
  PO().onState && PO().onState(() => { drawAway(true); drawAwayStrip() })

  /** Codex 在 App 裡（工程師B 0.63.28）：在線的看 src＝app；交出去還沒在 App 打開、或已在 App 關掉的不在名冊，另見 codexAway */
  function inApp(p) { return p.kind === 'codex' && p.src === 'app' }
  // ---------- 招聘（roadmap 第 6 項，0.62.8）：多「身分」（員工／主管）與「坐哪」（現有的桌／開新桌／辦公區）；取代 page.html 的 openHire ----------
  // 主管＋已有主管的桌：伺服器回 need＝replace，先問「要讓新人取代某某當這桌主管嗎？某某會先交接。」，按好才送（走交接流程）
  const HIRE_NOTE = { fable: '最聰明、最貴', opus: '聰明，大部分工作', sonnet: '快又省，日常雜事', haiku: '最快最省，簡單的事' }
  function openHireV2(pre, preRole) {
    const s0 = st; if (!s0) return
    const dirs = s0.hireDirs || [], tables = s0.tables || [], ppl = s0.people || []
    const bossOf = t => (t.members || []).map(id => ppl.find(p => p.id === id)).find(p => p && p.role === 'manager')
    const preTable = pre && /^t(\d+)\./.exec(pre) ? +/^t(\d+)\./.exec(pre)[1] : undefined
    // 0.62.20：誰來做（Claude／Codex）；Codex 開在電腦背景的 tmux，會花 ChatGPT 的用量，先只能當員工或行政
    const cxm = s0.codexModels || []
    sheet('招聘新員工',
      // 從角色卡挑（0.64.4，jacky「按椅子進到招聘新員工時沒有看到 role 的選擇」）：照下面選的座位，有主管的桌＝叫角色到這桌、沒主管的桌＝開主管到這桌、辦公區＝開專案
      `<button class="mrow" id="hcards"><span><b>從角色卡挑</b><small>照下面選的「坐哪」：有主管的桌列角色卡（含其他專案）、沒主管的桌和辦公區列主管卡；不用卡就照下面填</small></span></button>` +
      `<label>誰來做</label><div class="v2hrole"><label><input type="radio" name="hagent" value="claude" checked>Claude</label><label><input type="radio" name="hagent" value="codex"${s0.noCodexHire ? ' disabled' : ''}>Codex</label>${s0.agyHire ? '<label><input type="radio" name="hagent" value="agy">agy</label>' : ''}</div>` +
      (s0.noCodexHire ? `<div class="v2hnote">${esc(s0.noCodexHire)}</div>` : '') +
      `<div id="hagentnote" class="v2hnote" style="display:none"></div>` +
      `<label>名字</label><input id="hname" maxlength="20" placeholder="輸入員工名字（也是 Claude app 裡的對話名稱）">` +
      // 選的角色的大站姿（0.63.46）：Claude→Claude、Codex→ChatGPT。放在名字欄下面（測試員：320 寬放上面會把名字欄擠出第一屏）；
      // 圖載不到就整塊收起來，不留 220px 空白（測試員 KV-1）
      `<div class="v2hkv" id="hkvbox"><img id="hkv" alt="" src="${esc(kvSrc('stand', 'claude'))}"></div>` +
      `<label>身分</label><div class="v2hrole">${[['staff', '員工'], ['manager', '主管'], ['admin', '行政']].map(([v, t]) => `<label><input type="radio" name="hrole" value="${v}"${(preRole || 'staff') === v ? ' checked' : ''}>${t}</label>`).join('')}</div>` +
      `<label>坐哪</label><select id="hseat"><option value="none"${preTable === undefined ? ' selected' : ''}>不坐桌（辦公區）</option>` +
      tables.map(t => { const b = bossOf(t); return `<option value="${t.id}"${t.id === preTable ? ' selected' : ''}>${esc(t.label || t.name)}（${t.count ?? '?'}／${t.size} 人・${b ? '主管 ' + esc(b.plate) : '沒有主管'}）</option>` }).join('') +
      `<option value="new">開新桌（選主管才行）</option></select>` +
      `<div id="hseatnote" class="v2hnote"></div>` +
      `<label>智力</label><select id="hmodel">${Object.entries(s0.models || {}).map(([k, v]) => `<option value="${k}"${k === 'sonnet' ? ' selected' : ''}>${esc(v)}｜${HIRE_NOTE[k] || ''}</option>`).join('')}</select>` +
      `<div id="hcfg"></div>` +
      (dirs.length > 1 ? `<label>在哪裡上班</label><select id="hdir">${dirs.map(d => `<option value="${esc(d.path)}"${d.default ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}</select>` : '') +
      `<label id="hchromel" class="v2hcheck"><input type="checkbox" id="hchrome">可以操作瀏覽器（--chrome，Claude in Chrome；要電腦上的 Chrome 裝好擴充功能）</label>` +
      `<label>第一件工作</label><textarea id="htask" rows="2" placeholder="輸入要交代的工作…（可不寫，進來後再交代）"></textarea>` +
      `<button class="mbtn go" id="hgo">招聘</button>`)
    const $ = id => document.getElementById(id)
    const role = () => (document.querySelector('input[name="hrole"]:checked') || {}).value || 'staff'
    const agent = () => (document.querySelector('input[name="hagent"]:checked') || {}).value || 'claude'
    const claudeModels = $('hmodel').innerHTML
    $('hcards').addEventListener('click', () => {
      const v = $('hseat').value, t = tables.find(x => String(x.id) === v), b = t && bossOf(t)
      if (t && b && !b.kind) openCardsV2('member', b, t.id)
      else if (t && !b) openCardsV2('project', undefined, t.id)
      else if (t) toast('這桌的主管不是 Claude，只能照下面填的招聘')
      else openCardsV2('project')
    })
    $('hkv').onerror = () => { $('hkvbox').hidden = true }
    $('hkv').onload = () => { $('hkvbox').hidden = false }
    // 投入程度（預設中）、模式（預設自動）：Codex 換成它自己的清單（伺服器給；沒給就不顯示、不送）
    const cfgSync = (cx, keepOld) => {
      if (agent() === 'agy') { // 0.64.5：agy 的模式只有自動／手動／接受編輯／規劃；投入程度預設照 agy 自己的
        $('hcfg').innerHTML = `<label>投入程度</label><select id="heffort"><option value="" selected>照 agy 預設</option>${(s0.efforts || []).map(e => `<option value="${esc(e.v)}">${esc(e.name)}</option>`).join('')}</select>` +
          `<label>模式</label><select id="hperm">${(s0.agyPerms || []).map(m => `<option value="${esc(m.v)}"${m.v === 'auto' ? ' selected' : ''}>${esc(m.name)}${m.desc ? '｜' + esc(m.desc) : ''}</option>`).join('')}</select>`
        return
      }
      const o = PO().cfgOpts ? PO().cfgOpts(cx ? { kind: 'codex' } : {}, cx ? $('hmodel').value : undefined) : { efforts: [], perms: [] }
      const pick = (l, d) => (l.find(x => x.v === d) || l[0] || {}).v
      const keep = keepOld && ($('heffort') || {}).value, keepP = keepOld && ($('hperm') || {}).value, ed = cx ? (o.efforts.some(e => e.v === keep) ? keep : '') : pick(o.efforts, 'medium'), pd = keepP && o.perms.some(m => m.v === keepP) ? keepP : pick(o.perms, 'auto') // 換模型不把唯讀／手動改回自動
      // Codex：投入程度預設「照模型預設」（不帶 effort，工程師B 11-24），換模型時清單跟著換
      $('hcfg').innerHTML = (o.efforts.length ? `<label>投入程度</label><select id="heffort">${cx ? `<option value=""${ed ? '' : ' selected'}>照模型預設</option>` : ''}${o.efforts.map(e => `<option value="${esc(e.v)}"${e.v === ed ? ' selected' : ''}>${esc(e.name)}</option>`).join('')}</select>` : '') +
        (o.perms.length ? `<label>模式</label><select id="hperm">${o.perms.map(m => `<option value="${esc(m.v)}"${m.v === pd ? ' selected' : ''}>${esc(m.name)}${m.desc ? '｜' + esc(m.desc) : ''}</option>`).join('')}</select>` : '')
    }
    cfgSync(false)
    $('hmodel').addEventListener('change', () => { if (agent() === 'codex') cfgSync(true, true) }) // 換模型：還有的投入程度就保留
    const agentSync = () => {
      const cx = agent() === 'codex', ag = agent() === 'agy', other = cx || ag, mgr = document.querySelector('input[name="hrole"][value="manager"]')
      $('hkv').src = kvSrc('stand', cx ? 'chatgpt' : ag ? 'gemini' : 'claude')
      mgr.disabled = other
      if (other && mgr.checked) document.querySelector('input[name="hrole"][value="staff"]').checked = true
      $('hmodel').innerHTML = cx ? (cxm.length ? cxm.map((m, i) => `<option value="${esc(m.slug)}">${esc(m.name)}${i === 0 ? '｜預設' : ''}</option>`).join('') : '<option value="default">Codex 預設</option>')
        : ag ? '<option value="default">agy 預設</option>' + (s0.agyModels || []).map(m => `<option value="${esc(m.slug)}">${esc(m.name)}</option>`).join('') : claudeModels
      cfgSync(cx)
      $('hname').placeholder = cx ? '輸入員工名字（Codex 的名牌由辦公室給，這是它的職稱）' : ag ? '輸入員工名字（英數字 12 字內也當名牌，其他的當職稱）' : '輸入員工名字（也是 Claude app 裡的對話名稱）'
      $('hchromel').style.display = other ? 'none' : ''; if (other) $('hchrome').checked = false
      const n = $('hagentnote'); n.style.display = other ? '' : 'none'
      n.innerHTML = cx ? (s0.hireWin ? '<i class="ico warn"></i>會花 ChatGPT 的用量（不是 Claude 的）。電腦上開一個 Codex 視窗，先只能當員工或行政；手機不能替它按允許、換模型，只能傳話' : '<i class="ico warn"></i>會花 ChatGPT 的用量（不是 Claude 的）。開在電腦背景，先只能當員工或行政；進辦公室要二十秒左右')
        : ag ? '<i class="ico warn"></i>會花 Google 的用量（不是 Claude 的）。電腦上開一個 agy 視窗，先只能當員工或行政；手機不能替它按允許、換模型，只能傳話' : ''
      n.classList.toggle('warn', other)
      note()
    }
    const note = () => {
      const v = $('hseat').value, t = tables.find(x => String(x.id) === v), b = t && bossOf(t), r = role()
      $('hseatnote').textContent = v === 'none' ? '坐辦公區，不掛主管' : v === 'new' ? (r === 'manager' ? '開一張以他命名的桌，坐主管椅' : '⚠ 開新桌要選「主管」')
        : r === 'admin' ? `當這桌的行政${b ? `，掛在 ${b.plate} 底下` : ''}，坐主管旁邊：整理筆記、進度摘要、追蹤卡住、提醒期限、幫主管寫報告；不派工、不做決定`
        : r === 'staff' ? (b ? `入座，掛在 ${b.plate} 底下` : '入座，這桌沒有主管（滿 4 人會顯示缺主管）')
        : b ? `⚠ 這桌已有主管 ${b.plate}：會走交接（${b.plate} 交接完才換）` : '當這桌主管，同桌其他人掛到他底下'
      // ⚠ 開頭的說明＝警告樣式（紅字＋警告圖示，參考圖 ref2-F5）
      const n = $('hseatnote'), w = n.textContent.startsWith('⚠'), adm = !w && role() === 'admin'
      n.classList.toggle('warn', w); n.classList.toggle('admin', adm)
      if (w) n.innerHTML = '<i class="ico warn"></i>' + esc(n.textContent.replace(/^⚠\s*/, ''))
      else if (adm) n.innerHTML = '<i class="ico admin"></i><span>' + esc(n.textContent) + '</span>' // ref3-H6：行政的說明前面放夾板圖示
      $('hgo').dataset.sure = ''; $('hgo').textContent = '招聘'
    }
    $('hseat').addEventListener('change', note); if ($('hdir')) $('hdir').addEventListener('change', note); document.querySelectorAll('input[name="hrole"]').forEach(r => r.addEventListener('change', note))
    document.querySelectorAll('input[name="hagent"]').forEach(r => r.addEventListener('change', agentSync)); note()
    const sure = () => ($('hgo').dataset.sure || '').split(' ').filter(Boolean)
    $('hgo').addEventListener('click', async ev => {
      const name = $('hname').value.trim()
      if (!name) { toast('先取個名字'); return }
      const body = { name, agent: agent(), role: role(), seat: $('hseat').value, model: $('hmodel').value, effort: ($('heffort') || {}).value || undefined, perm: ($('hperm') || {}).value, dir: ($('hdir') || {}).value, task: $('htask').value, chrome: agent() === 'claude' && $('hchrome').checked, replace: sure().includes('replace'), trustOk: sure().includes('trust') }
      ev.target.disabled = true
      const j = await PO().post('/hire', body)
      ev.target.disabled = false
      // 主管換人（replace）、Windows 上資料夾還沒信任過（trust，設計 windows-hire 2.）：先說明，再按一次才開
      if (j.need === 'replace' || j.need === 'trust') { ev.target.dataset.sure = [...sure(), j.need].join(' '); ev.target.textContent = `${j.text} ${j.need === 'trust' ? '還是要開就按這裡' : '按這裡確定'}`; return }
      if (j.ok) closeSheet()
      toast(j.text || j.error || '沒有回應')
    })
  }
  // ---------- 排班（roadmap 第 8 項，0.62.13）：對象多「整桌」（到時間送給當下坐在這桌的每個人）、動作（各自回報／開會）、日期多「每週幾」；取代 page.html 的 openShift ----------
  const DOW = ['週日', '週一', '週二', '週三', '週四', '週五', '週六']
  function openShiftV2() {
    const s0 = st || {}, list = s0.shifts || [], ppl = s0.people || [], tables = s0.tables || []
    const when = t => new Date(t).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    sheet('📅 排班',
      (list.length ? list.map(x => `<div class="mcard shift${x.on ? '' : ' off'}"><b class="big">${esc(x.time)} → ${esc(x.name)}</b><small>${esc(x.daysText || (x.days === 'weekdays' ? '平日' : '每天'))}${x.table !== undefined ? (x.action === 'meet' ? '・整桌開會' : '・整桌各自回報') : ''}${x.on ? '' : '・暫停中'}</small><div>${x.action === 'meet' ? '題目：' : ''}${esc(x.text)}</div>` +
        (x.last ? `<div class="${x.last.ok ? 'ok' : 'bad'}">上次結果：${when(x.last.at)} ${esc(x.last.msg)}</div>` : '') +
        `<div class="g3"><button class="chip prim" data-s="run" data-sid="${x.sid}">現在跑</button><button class="chip" data-s="toggle" data-sid="${x.sid}">${x.on ? '暫停' : '恢復'}</button><button class="chip red" data-s="del" data-sid="${x.sid}">刪除</button></div></div>`).join('')
        : '<div class="note">還沒有排班</div>') +
      `<h3 class="sec line"><i class="ico alarm"></i>新增排班</h3>` +
      `<label>對象</label><select id="swho"><optgroup label="一個人">${ppl.map(p => `<option value="p:${esc(p.id)}">${esc(p.plate)}</option>`).join('')}</optgroup>` +
      (tables.length ? `<optgroup label="整桌（到時間送給當下坐在這桌的每個人）">${tables.map(t => `<option value="t:${t.id}">整桌：${esc(t.label || t.name)}</option>`).join('')}</optgroup>` : '') + `</select>` +
      `<div id="sact" style="display:none"><label>要做什麼</label><select id="saction" class="v2segsel"><option value="report">各自回報（每人回報主管，主管整理一份給你）</option><option value="meet">開會（到時間直接整桌開會）</option></select><div class="v2seg" data-for="saction"><button type="button" class="mbtn" data-v="report">各自回報</button><button type="button" class="mbtn" data-v="meet">開會</button></div></div>` +
      `<label>時間</label><input id="stime" type="time" value="09:00">` +
      `<label>哪幾天</label><select id="sdays" class="v2segsel"><option value="daily">每天</option><option value="weekdays">平日（週一到週五）</option><option value="weekly">每週幾</option></select><div class="v2seg" data-for="sdays"><button type="button" class="mbtn" data-v="daily">每天</button><button type="button" class="mbtn" data-v="weekdays">平日</button><button type="button" class="mbtn" data-v="weekly">每週幾</button></div>` +
      `<div id="sdowbox" style="display:none"><label>每週哪一天</label><select id="sdow">${DOW.map((d, i) => `<option value="${i}"${i === 1 ? ' selected' : ''}>${d}</option>`).join('')}</select></div>` +
      `<label id="stextlbl">交代什麼</label><textarea id="stext" rows="3" placeholder="例：整理今天的行程，列出要準備的東西"></textarea>` +
      `<button class="mbtn go" id="sadd">排進去</button>` +
      `<div class="note">到時間要在線才收得到；整桌的不在線的人會略過，結果註明誰不在線。整桌開會到時間直接開，不先問你。</div>`)
    const $ = id => document.getElementById(id)
    const sync = () => {
      const table = $('swho').value.startsWith('t:'), meet = table && $('saction').value === 'meet'
      $('sact').style.display = table ? '' : 'none'
      $('sdowbox').style.display = $('sdays').value === 'weekly' ? '' : 'none'
      $('stextlbl').textContent = meet ? '會議題目' : '交代什麼'
      $('stext').placeholder = meet ? '例：本週計畫' : table ? '例：回報今天的進度與明天要做的事' : '例：整理今天的行程，列出要準備的東西'
    }
    // 選單美術第三批（ref3-H7）：「要做什麼」「哪幾天」改成一排切換鈕；下拉留著（看不見）當資料來源，按鈕只是改它的值
    const segSync = () => document.querySelectorAll('#mbody .v2seg').forEach(g => g.querySelectorAll('[data-v]').forEach(b => b.classList.toggle('on', $(g.dataset.for).value === b.dataset.v)))
    document.querySelectorAll('#mbody .v2seg [data-v]').forEach(b => b.addEventListener('click', () => { const sel = $(b.parentElement.dataset.for); sel.value = b.dataset.v; sel.dispatchEvent(new Event('change')) }))
    ;['swho', 'saction', 'sdays'].forEach(id => $(id).addEventListener('change', () => { sync(); segSync() })); sync(); segSync()
    document.getElementById('mbody').querySelectorAll('[data-s]').forEach(b => b.addEventListener('click', async () => {
      if (b.dataset.s === 'del' && !b.dataset.sure) { b.dataset.sure = '1'; b.classList.add('redon'); b.textContent = '再按一次刪除'; return }
      const j = await PO().post('/schedule', { op: b.dataset.s, sid: b.dataset.sid })
      toast(j.text || '沒有回應')
      await PO().load(); openShiftV2()
    }))
    $('sadd').addEventListener('click', async () => {
      const v = $('swho').value, table = v.startsWith('t:')
      const body = { op: 'add', time: $('stime').value, days: $('sdays').value, dow: $('sdow').value, text: $('stext').value, ...(table ? { table: +v.slice(2), action: $('saction').value } : { id: v.slice(2) }) }
      const j = await PO().post('/schedule', body)
      toast(j.text || '沒有回應')
      if (j.ok) { await PO().load(); openShiftV2() }
    })
  }
  // ---------- 叫角色、開專案（設計 windows-hire 4.）：清單由伺服器從角色卡算（/cards.json、/projects.json），點一張就開 ----------
  // kind=member：p＝被點的人，開出來掛在他底下；kind=project：開那個專案的主管。已在線的回「改傳話」；資料夾沒信任過先說明、再按一次才開
  // table（0.64.2）：從協作桌叫的，叫出來坐這桌（員工掛這桌主管、主管坐主管椅）；空桌的主管選單底下附招聘一般 session、桌子設定
  async function openCardsV2(kind, p, table) {
    const tb = table === undefined ? undefined : ((st && st.tables) || []).find(x => x.id === table)
    const title = tb ? (kind === 'member' ? '叫角色到這桌' : '開主管到這桌') : kind === 'member' ? `叫 ${p.plate} 的團隊成員` : '開專案'
    if (PO().demo) { PO().toast('示意資料：這裡會列出角色卡，點了在電腦上開出那個角色'); return }
    const sid = PO().sheet(title, PO().LOADING)
    let j; try { j = await (await fetch(kind === 'member' ? `/cards.json?id=${encodeURIComponent(p.id)}` : '/projects.json', { cache: 'no-store' })).json() } catch {}
    if (PO().sheetId() !== sid) return // 等的時候關掉或換了別的選單
    if (!j || !j.ok) { PO().sheet(title, `<div class="note">${esc((j && j.text) || '連不到電腦')}</div>`, true); return }
    const groups = new Map()
    for (const c of j.cards || []) groups.set(c.group, [...(groups.get(c.group) || []), c])
    const models = (st && st.models) || {}
    const others = [...groups].filter(([, list]) => list[0].other)
    const cardRows = list => list.map(c => `<button class="mrow" data-code="${esc(c.code)}"><span><b>${esc(c.name)}</b>${c.desc ? `<small>${esc(c.desc)}</small>` : ''}</span></button>`).join('')
    PO().sheet(title,
      `<div class="note">${kind === 'member' ? `${esc(j.project || '')} 專案的角色卡與小隊；點了在電腦上開一個視窗，掛在 ${esc(p.plate)} 底下` : '有主管卡的專案；點了在電腦上開出那個專案的主管'}${tb ? `，坐「${esc(tb.name)}」` : ''}</div>` +
      (st && (st.agyHire || st.codexSummon) && kind === 'member' ? `<label>誰來開</label><select id="cagent"><option value="claude" selected>Claude</option>${st.codexSummon ? '<option value="codex">Codex（ChatGPT 的用量；手機只能傳話）</option>' : ''}${st.agyHire ? '<option value="agy">agy（Google 的用量；手機只能傳話）</option>' : ''}</select>` : '') +
      (Object.keys(models).length ? `<label id="cmodell">智力</label><select id="cmodel">${Object.entries(models).map(([k, v]) => `<option value="${esc(k)}"${k === 'opus' ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>` : '') +
      // 在線主管是「這個專案」的，不是某張卡的人：放在專案分組標題那一行（測試 #7）
      ([...groups].filter(([, list]) => !list[0].other).map(([g, list]) => { const on = [...new Set(list.flatMap(c => c.managers || []))]
        return `<h3 class="sec line">${esc(g)}${on.length ? `・在線主管：${on.map(esc).join('、')}` : ''}</h3>` + cardRows(list) }).join('')
        || '<div class="note">沒有找到角色卡</div>') +
      // 其他專案（0.64.2）：預設收起；點開才列，叫出來一樣掛在被點的人底下、開在那張卡自己的專案
      (others.length ? `<details class="others"><summary class="mrow"><span><b>其他專案</b><small>${others.length} 個專案；叫出來一樣掛在 ${esc(p.plate)} 底下</small></span></summary>` +
        others.map(([g, list]) => `<h3 class="sec line">${esc(g.replace(/^其他專案・/, ''))}</h3>` + cardRows(list)).join('') + '</details>' : '') +
      // 從桌子來的：不照角色卡，招聘一般 session 到這桌；空桌另外留一條路到桌子設定（改名、人數、刪除）
      (tb ? `<h3 class="sec line">其他</h3><button class="mrow" id="cgen"><span><b>${kind === 'member' ? '開一般 session 到這桌' : '招聘一般 session 當主管'}</b><small>不用角色卡，自己取名字、交代工作</small></span></button>` +
        (kind === 'project' ? `<button class="mrow" id="ctable"><span><b>桌子設定</b><small>改名、幾人座、協作資料夾、刪除</small></span></button>` : '') : ''), true)
    const cg = document.getElementById('cgen'); if (cg) cg.addEventListener('click', () => openHireV2(`t${table}.`, kind === 'member' ? 'staff' : 'manager'))
    const ct = document.getElementById('ctable'); if (ct) ct.addEventListener('click', () => openTable(table))
    const ca = document.getElementById('cagent'), cm = document.getElementById('cmodel'), cml = document.getElementById('cmodell')
    if (ca && cm) ca.addEventListener('change', () => { const ag = ca.value !== 'claude'; cm.style.display = cml.style.display = ag ? 'none' : '' }) // agy、Codex 用它們自己的預設模型
    document.querySelectorAll('#mbody [data-code]').forEach(b => b.addEventListener('click', async () => {
      const sure = (b.dataset.sure || '').split(' ').filter(Boolean)
      const r = await PO().post('/summon', { kind, ...(kind === 'member' ? { id: p.id } : {}), ...(tb ? { table } : {}), code: b.dataset.code, model: (document.getElementById('cmodel') || {}).value, agent: (document.getElementById('cagent') || {}).value || 'claude', trustOk: sure.includes('trust') })
      if (r.need === 'trust') { b.dataset.sure = 'trust'; b.querySelector('b').textContent = `${r.text} 還是要開就再按一次`; return }
      if (r.ok) PO().closeSheet()
      toast(r.text || r.error || '沒有回應')
    }))
  }
  // ---------- 關係（設計 windows-hire 5.）：底部「辦公室｜關係」兩個分頁；關係＝用狀態裡的 role、team、agent 畫樹（主管 → 部門主管 → 員工），不加新資料 ----------
  // 點節點＝開那人的狀態卡（跟點辦公室裡的人一樣），長按空白或按「開專案」＝開專案。畫法參考團隊視窗的關係圖，不共用程式（那邊是滑鼠、這邊是觸控）
  const bareAgent = a => String(a || '').split(' [')[0]
  /** people → { roots, kids }：team＝某位在線主管的 agent 就掛在他底下；同名主管有幾位時挑坐同一張協作桌的，沒有才掛第一位；找不到主管或成環的當根 */
  const tableOfSeat = s => (/^t(\d+)\./.exec(s || '') || [])[1]
  function relTree(people) {
    const boss = new Map()
    for (const p of people) if (p.role === 'manager' && p.agent) boss.set(bareAgent(p.agent), [...(boss.get(bareAgent(p.agent)) || []), p])
    const up = p => {
      const l = (p.team && boss.get(bareAgent(p.team)) || []).filter(b => b.id !== p.id), t = tableOfSeat(p.seat)
      return (t && l.find(b => tableOfSeat(b.seat) === t)) || l[0]
    }
    const kids = new Map(), roots = []
    for (const p of people) {
      let b = up(p), seen = new Set([p.id])
      for (let q = b; q; q = up(q)) { if (seen.has(q.id)) { b = undefined; break } seen.add(q.id) } // 成環（互相掛）：當根
      if (b) kids.set(b.id, [...(kids.get(b.id) || []), p]); else roots.push(p)
    }
    const order = (a, b) => (b.role === 'manager') - (a.role === 'manager') || String(a.plate).localeCompare(String(b.plate))
    for (const l of kids.values()) l.sort(order)
    return { roots: roots.sort(order), kids }
  }
  const REL_DOT = { typing: 'work', thinking: 'work', reading: 'work', done: 'done', blocked: 'err', waiting: 'wait' }
  const relNode = (p, kids, depth) => {
    const k = kids.get(p.id) || []
    return `<li><button class="rnode${p.role === 'manager' ? ' boss' : ''}" data-id="${esc(p.id)}"><span class="rav" style="background-image:url('${src(faceOf(p) + '_front')}')"></span>` +
      `<span class="rtxt"><b>${p.role === 'manager' ? '<i class="rstar">★</i>' : ''}${esc(p.plate)}${p.kind === 'codex' ? ' <i class="rtag">Codex</i>' : ''}</b>` +
      `<small><em class="rdot ${REL_DOT[p.mode] || 'idle'}"></em>${esc(ZH[p.mode] || p.mode || '')}${p.title && p.title !== p.plate ? '・' + esc(p.title) : ''}${k.length ? `・${k.length} 人` : ''}</small></span></button>` +
      (k.length && depth < 8 ? `<ul>${k.map(c => relNode(c, kids, depth + 1)).join('')}</ul>` : '') + '</li>'
  }
  const rel = document.createElement('div'); rel.id = 'relroom'; rel.setAttribute('role', 'region'); rel.setAttribute('aria-label', '關係')
  rel.innerHTML = '<div class="rwrap"><div class="rhead"><b>關係</b><small>誰在誰底下；長按空白開專案</small><button class="mbtn" id="relproj">開專案</button></div><div id="reltree"></div></div>'
  const tabs = document.createElement('nav'); tabs.id = 'v2tabs'; tabs.setAttribute('aria-label', '畫面')
  tabs.innerHTML = '<button data-tab="office" class="on">辦公室</button><button data-tab="rel">關係</button>'
  document.body.append(rel, tabs)
  let relOn = false, relKey = ''
  function relRender() {
    if (!relOn || !st) return
    const people = st.people || [], key = people.map(p => [p.id, p.plate, p.role, p.team, p.agent, p.mode, p.title].join('\u0001')).join('\u0002')
    if (key === relKey) return
    relKey = key
    const { roots, kids } = relTree(people)
    const top = roots.filter(p => p.role === 'manager' || kids.has(p.id)), loose = roots.filter(p => !top.includes(p))
    document.getElementById('reltree').innerHTML = !people.length ? '<div class="note">辦公室現在沒有人</div>'
      : (top.length ? `<ul class="rtree">${top.map(p => relNode(p, kids, 0)).join('')}</ul>` : '') +
        (loose.length ? `<h3 class="rsec">沒掛主管</h3><ul class="rtree flat">${loose.map(p => relNode(p, kids, 0)).join('')}</ul>` : '')
  }
  function setTab(t) {
    relOn = t === 'rel'; relKey = ''
    const hd = document.querySelector('header'); if (hd) rel.style.top = Math.round(hd.getBoundingClientRect().bottom) + 'px' // 標題列會折行，高度不固定
    rel.classList.toggle('on', relOn)
    tabs.querySelectorAll('[data-tab]').forEach(b => { b.classList.toggle('on', b.dataset.tab === t); b.setAttribute('aria-pressed', String(b.dataset.tab === t)) })
    relRender()
  }
  tabs.addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (b) setTab(b.dataset.tab) })
  ready.then(() => PO().onState && PO().onState(() => relRender()))
  let relPress = null
  rel.addEventListener('click', e => {
    if (relPress && relPress.fired) { relPress = null; return }
    if (e.target.closest('#relproj')) { openCardsV2('project'); return }
    const n = e.target.closest('.rnode'); if (!n) return
    const p = (st && st.people || []).find(x => x.id === n.dataset.id)
    if (!p) { toast('這位已經不在線'); return }
    if (PO().show) PO().show(p)
  })
  // 長按空白（不是節點、不是按鈕）約 0.6 秒＝開專案
  rel.addEventListener('pointerdown', e => {
    if (e.target.closest('button')) return
    const x = e.clientX, y = e.clientY
    relPress = { x, y, fired: false, timer: setTimeout(() => { if (relPress) { relPress.fired = true; try { navigator.vibrate && navigator.vibrate(20) } catch {} openCardsV2('project') } }, 600) }
  })
  rel.addEventListener('pointermove', e => { if (relPress && !relPress.fired && Math.hypot(e.clientX - relPress.x, e.clientY - relPress.y) > 10) { clearTimeout(relPress.timer); relPress = null } })
  ;['pointerup', 'pointercancel'].forEach(t => rel.addEventListener(t, () => { if (relPress && !relPress.fired) { clearTimeout(relPress.timer); relPress = null } }))
  window.PO_REL = { relTree } // 給測試
  ready.then(() => { if (window.PO) { window.PO.openHire = openHireV2; window.PO.openShift = openShiftV2; window.PO.openSummon = p => openCardsV2('member', p); window.PO.openProjects = () => openCardsV2('project') } })
  // 狀態一拿到就接（通知列不用等圖）；場景等第一批圖到了才畫（render 自己會擋），到了馬上畫一次
  manifest.then(() => { PO().onState(j => { st = j; trackMail(j); render(); trackTrips(j); renderHelp(j) }) })
  ready.then(() => render()).finally(() => dispatchEvent(new Event('po:scene-ready'))) // 第一次畫好（或載入失敗）：收掉載入畫面
  // 給測試看的：版面、座位、走路路線（tests/ 用）
  window.PO_SCENE = { motion: Object.assign(motion, { layout: () => (L ? { ...L, GW, GH, OH, AISLE, SIDE, TOP, CROW, OROW, BOTTOM } : null), ready: () => !!(L && items.length), trips: () => [...trips.values()], mail: () => ({ planes: mail.planes.slice(), envs: mail.envs.slice() }), seats: () => (L ? allSeats() : []), seatXY }) }
  // 人物動作（第 2 段）：每 140ms 一格（約每秒 7 格）；只在有人在動、頁面在前景時才重畫
  setInterval(() => { if (document.hidden) return; frame++; if (st && layers && st.people.some(p => p.meeting || p.mode === 'typing' || p.mode === 'thinking' || p.mode === 'waiting' || p.mode === 'reading')) draw() }, 140)
  if (DEBUG) setInterval(() => { if (st && layers) draw() }, 120)
  // 走路、紙飛機每 100ms；點人物跳一下那 0.3 秒每 50ms
  let half = 0
  if (!DEBUG) setInterval(() => { if (document.hidden || !st || !layers) return; half ^= 1; if (bumps.size || (half && (mailBusy() || [...trips.values()].some(t => { const p = st.people.find(x => x.id === t.id); return p && hasFull(p.species || 'claude') })))) draw() }, 50)
  addEventListener('resize', () => { ovKey = ''; render() })

  // ---------- 協作桌：清單（人事室、協作區標示）與單張桌子的選單 ----------
  const toast = t => PO().toast && PO().toast(t)
  const sheet = (title, html) => PO().sheet(title, html)
  const closeSheet = () => PO().closeSheet()
  const sizeBtns = (cur, attr) => SIZES.map(n => `<button class="mbtn v2size${n === cur ? ' on' : ''}" ${attr}="${n}">${n} 人</button>`).join('')
  async function tablesOp(body) {
    const r = await PO().post('/tables', body); PO().load()
    toast(r.text || '沒有回應')
    return r
  }
  function openTables() {
    const tables = (st && st.tables) || []
    sheet('協作桌清單',
      `<div class="note">同一個主管底下的人會自動坐同一張協作桌；也可以長按一個人拖到任何座位。</div>` +
      (tables.length ? tables.map(t => `<button class="mrow" data-open="${t.id}"><span><b>${esc(t.name)}（${t.size} 人）</b><small>${t.teamName ? '團隊：' + esc(t.teamName) : t.auto ? '自動開的' : '還沒有團隊'}</small></span></button>`).join('') : '<div class="note">還沒有協作桌</div>') +
      `<h3 class="sec">新增一張</h3><label>名字</label><input id="v2tname" maxlength="12" placeholder="例：讀書會">` +
      `<label>幾人座</label><div class="v2sizes">${sizeBtns(4, 'data-add')}</div><button class="mbtn go" id="v2add">建立</button>`)
    const body = document.getElementById('mbody')
    body.querySelectorAll('[data-open]').forEach(b => b.addEventListener('click', () => openTable(+b.dataset.open)))
    let addSize = 4
    body.querySelectorAll('[data-add]').forEach(b => b.addEventListener('click', () => {
      addSize = +b.dataset.add; body.querySelectorAll('[data-add]').forEach(x => x.classList.toggle('on', x === b))
    }))
    document.getElementById('v2add').addEventListener('click', async () => {
      const r = await tablesOp({ op: 'add', size: addSize, name: document.getElementById('v2tname').value })
      if (r.ok) closeSheet()
    })
  }
  // 設成一組的確認卡：先問伺服器會做什麼（登記誰、寫在哪、通知幾位），按「確定」才做
  async function openTableTeam(id) {
    const sid = PO().sheetId()
    const v = await PO().post('/table-team', { table: id, op: 'preview' })
    if (PO().sheetId() !== sid) return // 等回應時使用者已經換到別頁：不蓋掉（審查第 3 列）
    if (!v.ok) { toast(v.text || v.error || '沒有回應'); return }
    const t = ((st && st.tables) || []).find(x => x.id === id)
    sheet(`設成一組：${t ? t.name : ''}`,
      `<div class="mcard"><b class="big">會做這三件事</b>` +
      `<small>1. 登記身分：${esc(v.boss)} 登記成主管；${v.members.length ? esc(v.members.join('、')) + ' 掛到他底下' : '目前沒有其他成員'}（之後換桌、離桌不會自動撤銷）</small>` +
      `<small>2. 協作紀錄：<span class="path">${esc(v.dir)}/collab.md</span>（已有就只補成員列，不覆蓋）</small>` +
      `<small>3. 通知：${v.notify ? `傳訊息給 ${v.notify} 位${v.again ? '（只通知新成員與主管）' : ''}` : '大家都通知過了，這次不再傳'}</small></div>` +
      `<div class="mline team"><button class="mbtn" id="v2teamno">取消</button><button class="mbtn go" id="v2teamgo">確定</button></div>`)
    document.getElementById('v2teamno').addEventListener('click', () => openTable(id))
    const go = document.getElementById('v2teamgo')
    go.addEventListener('click', async () => {
      if (go.disabled) return
      go.disabled = true
      let r
      const sid2 = PO().sheetId()
      try { r = await PO().post('/table-team', { table: id, op: 'go', ver: v.ver }) } finally { go.disabled = false }
      toast(r.text || r.error || '沒有回應')
      if (PO().sheetId() !== sid2) { PO().load(); return }
      if (r.ok) { closeSheet(); PO().load() } else if (/請重看確認卡/.test(r.text || '')) openTableTeam(id)
    })
  }
  // 點桌牌（0.64.2）：沒人坐的空桌直接跳主管選單（底下有「桌子設定」）；其他照舊開桌子選單
  function openTableTap(id) {
    const t = ((st && st.tables) || []).find(x => x.id === id)
    if (t && !(t.members || []).length && !PO().demo) openCardsV2('project', undefined, id); else openTable(id)
  }
  function openTable(id) {
    const t = ((st && st.tables) || []).find(x => x.id === id)
    if (!t) { toast('找不到這張桌子'); return }
    const ppl = (st && st.people) || [], members = (t.members || []).map(id => ppl.find(p => p.id === id)).filter(Boolean)
    const waitN = members.filter(p => p.mode === 'waiting').length
    // 設成一組（0.63.45）：桌上剛好一位主管才能按；沒主管的桌每位都能升主管（不限人數，主管 2026-11-25 裁示）
    const bosses = members.filter(p => p.role === 'manager'), noMgr = members.length > 0 && !bosses.length
    const teamRow = !members.length ? ''
      : bosses.length === 1 ? (() => {
        // 未登記（team 還不是這位主管）與未通知分開寫（審查第 7 列）；沒做完的（groupPartial）不標已成組
        const gap = [t.groupUnreg ? `${t.groupUnreg} 位未登記` : '', t.groupUnnotified ? `${t.groupUnnotified} 位未通知` : ''].filter(Boolean).join('・')
        const head = t.grouped ? (gap ? `已成組・${gap}` : '已成組') : t.groupPartial ? `設成一組（上次沒做完${gap ? '：' + gap : ''}）` : '設成一組'
        const sub = t.grouped ? (gap ? '按這裡補登記、補通知' : '再按會重新登記，已通知過的不再通知') : t.groupPartial ? '按這裡再做一次，已完成的不重複' : `主管 ${esc(bosses[0].plate)}、成員 ${members.length - 1} 位：登記身分、建協作紀錄、通知每個人`
        return `<button class="mrow ic" id="v2team"><i class="ico ${t.grouped ? 'check' : 'helper'}"></i><span><b>${head}</b><small>${sub}</small></span></button>`
      })()
      : `<button class="mrow ic" id="v2team" disabled><i class="ico helper"></i><span><b>設成一組</b><small>${bosses.length ? `這桌有 ${bosses.length} 位主管，先降一位` : '先指定主管（同桌名單按「升主管」）'}</small></span></button>`
    // 叫人到這桌（0.64.2）：有一位 Claude 主管＝照他專案的角色卡叫、或開一般 session；沒主管＝開主管（角色卡或一般 session）
    const boss1 = bosses.length === 1 && !bosses[0].kind ? bosses[0] : undefined
    const callRows = boss1
      ? `<button class="mrow ic" id="v2callrole"><i class="ico helper"></i><span><b>叫角色到這桌</b><small>從角色卡挑（含其他專案），掛在 ${esc(boss1.plate)} 底下</small></span></button>` +
        `<button class="mrow ic" id="v2callgen"><i class="ico helper"></i><span><b>開一般 session 到這桌</b><small>不用角色卡，掛在 ${esc(boss1.plate)} 底下</small></span></button>`
      : !bosses.length ? `<button class="mrow ic" id="v2callboss"><i class="ico helper"></i><span><b>開主管到這桌</b><small>從專案的主管卡挑，或招聘一般 session 當主管</small></span></button>` : ''
    sheet(t.name,
      callRows +
      // 整桌等你回覆（第 7 項）：有人在等就放最上面
      // 缺主管（ref2-F2）：紅色警告卡放最上面
      (t.noBoss ? `<div class="mcard warn"><i class="ico warn"></i><div><b>缺主管</b><span>這桌 ${members.length} 人沒有主管。請挑一位升主管，同桌其他人會掛到他底下。</span></div></div>` : '') +
      (waitN ? `<button class="mrow ic v2wait-open" id="v2waitgo"><i class="ico alarm"></i><span><b>回覆等你的人（${waitN}）</b></span></button>` : '') +
      `<div class="mcard"><b class="big">${esc(t.name)}</b><small>${t.teamName ? '團隊：' + esc(t.teamName) : '還沒有團隊坐這裡'}${t.auto ? '（自動開的；改過就會固定留著）' : ''}${t.status ? '・' + esc(t.status) : ''}</small></div>` +
      // 同桌名單（roadmap 第 1 項）＋📣 傳話給這桌（第 2 項）
      `<button class="mrow ic" id="v2notes"><i class="ico notes"></i><span><b>共用筆記${t.decide ? `<span class="v2dot">${t.decide}</span>` : ''}</b>${t.tasks ? `<small>進行中的任務 ${t.tasks} 件</small>` : ''}</span></button>` +
      teamRow +
      // 整桌開會（第 9 項）：沒主管的桌變灰寫「先挑一位主管」；開會中可以結束
      // 選單美術第三批（ref3-H2）：開會＝講台圖示、開會中＝沙漏＋淡琥珀、沒主管＝變灰；聊天室加一行說明
      (t.meeting ? `<button class="mrow ic amber" id="v2meetend"><i class="ico hourglass"></i><span><b>開會中：${esc(t.meeting)}</b><small>點這裡結束（不等結論）</small></span></button>`
        : members.some(p => p.role === 'manager') ? `<button class="mrow ic" id="v2meet"><i class="ico meeting"></i><span><b>開會</b><small>在這張桌子開，主持人是這桌主管</small></span></button>`
        : `<button class="mrow ic" id="v2meet" disabled><i class="ico meeting"></i><span><b>開會</b><small>先挑一位主管</small></span></button>`) +
      `<button class="mrow ic" id="v2chat"><i class="ico chat"></i><span><b>聊天室</b><small>查看最近 30 天的桌內訊息</small></span></button>` +
      `<h3 class="sec line">同桌名單<small>（${members.length}／${t.size}）</small></h3>` +
      (members.length ? members.map(p => `<div class="prow${noMgr ? ' boss' : ''}"><button class="pbtn" data-who="${esc(p.id)}"><span class="pav" style="background-image:url('${src(faceOf(p) + '_front')}')"></span><span class="pt"><b>${p.role === 'manager' ? '★ ' : ''}${esc(p.plate)}</b><small><i class="pdot ${{ typing: 'g', thinking: 'g', reading: 'g', done: 'g', waiting: 'y', blocked: 'y' }[p.mode] || ''}"></i>${esc(ZH[p.mode] || p.modeText || p.mode)}${p.agent ? '　・　' + esc(p.agent) : ''}</small></span></button>${noMgr ? (p.kind ? `<button class="mbtn pboss" aria-disabled="true" data-why="主管只能是 Claude">升主管</button>` : `<button class="mbtn pboss" data-boss="${esc(p.id)}">升主管</button>`) : ''}</div>`).join('') : '<div class="note">現在沒有人坐這張桌子</div>') +
      (members.length ? `<h3 class="sec line"><i class="ico megaphone"></i>傳話給這桌</h3><div class="note">會嘗試送給同桌 ${members.length} 位</div><div class="mline"><textarea id="v2say" maxlength="3800" rows="1" placeholder="輸入要傳的話…（例：大家先把手上的事告一段落，回報進度）"></textarea><button class="mbtn" id="v2sayph" aria-label="傳照片給整桌">📷</button><button class="mbtn go" id="v2saygo">送出</button></div>` : '') +
      `<h3 class="sec line">桌子名字</h3><div class="mline"><input id="v2tname" maxlength="12" value="${esc(t.name)}"><button class="mbtn go" id="v2rename">改名</button></div>` +
      // 協作資料夾（0.62.9）：交接、接手讀這裡的 collab.md、checkpoints/；空白＝照主管的工作資料夾找
      `<h3 class="sec line">協作資料夾</h3><div class="note">交接、接手讀這裡的 collab.md 與檢查點；空白＝照主管的工作資料夾找</div><div class="mline"><input id="v2tcollab" maxlength="300" value="${esc(t.collab || '')}" placeholder="例：~/.claude/pixel-office/team-v2"><button class="mbtn" id="v2tcollabgo">存</button></div>` +
      `<h3 class="sec line">幾人座</h3><div class="v2sizes">${sizeBtns(t.size, 'data-size')}</div>` +
      `<button class="mbtn danger" id="v2del">刪除這張桌子</button>`)
    const body = document.getElementById('mbody')
    body.querySelectorAll('[data-who]').forEach(b => b.addEventListener('click', () => { closeSheet(); PO().openChat(ppl.find(p => p.id === b.dataset.who)) }))
    body.querySelectorAll('[data-why]').forEach(b => b.addEventListener('click', () => toast(b.dataset.why)))
    body.querySelectorAll('[data-boss]').forEach(b => b.addEventListener('click', async () => {
      const p = ppl.find(x => x.id === b.dataset.boss)
      if (!b.dataset.sure) { b.dataset.sure = '1'; b.classList.add('danger'); b.textContent = `確定升 ${p ? p.plate : ''}？`; return }
      const r = await PO().post('/table-boss', { table: id, id: b.dataset.boss })
      toast(r.text || r.error || '沒有回應')
      if (r.ok) { closeSheet(); PO().load() }
    }))
    const tm = document.getElementById('v2team'); if (tm && !tm.disabled) tm.addEventListener('click', () => openTableTeam(id))
    const cr = document.getElementById('v2callrole'); if (cr) cr.addEventListener('click', () => openCardsV2('member', boss1, id))
    const cgn = document.getElementById('v2callgen'); if (cgn) cgn.addEventListener('click', () => openHireV2(`t${id}.`, 'staff'))
    const cb = document.getElementById('v2callboss'); if (cb) cb.addEventListener('click', () => openCardsV2('project', undefined, id))
    document.getElementById('v2chat').addEventListener('click', () => openTableChat(id))
    const wg = document.getElementById('v2waitgo'); if (wg) wg.addEventListener('click', () => openWaitReply(id))
    document.getElementById('v2notes').addEventListener('click', () => openTableNotes(id))
    const mg = document.getElementById('v2meet'); if (mg && !mg.disabled) mg.addEventListener('click', () => openTableMeet(id))
    const me = document.getElementById('v2meetend')
    if (me) me.addEventListener('click', async () => {
      if (!me.dataset.sure) { me.dataset.sure = '1'; me.querySelector('small').textContent = '再按一次確定結束'; return }
      const r = await PO().post('/table-meet-end', { id: t.meetingId }); toast(r.text || r.error || '沒有回應'); if (r.ok) { closeSheet(); PO().load() }
    })
    // 📣 傳話／📷 照片給整桌：文字與照片共用整桌的送出鎖（審查 photo ②）；點下去當下就記下桌號、附的話、選單世代（審查 photo ①）
    const go = document.getElementById('v2saygo')
    // 複驗 ②：輸入框記版本；送出後又打了新的話，送到時不關選單、不清掉（比照單人）
    const sayBox = document.getElementById('v2say')
    let sayVer = 0
    if (sayBox) sayBox.addEventListener('input', () => { sayVer++ })
    const sayCtx = () => ({ table: id, sid: PO().sheetId(), text: sayBox ? sayBox.value : '', v: sayVer })
    const sameSheet = c => PO().sheetId() === c.sid
    const doneOk = c => { if (!sameSheet(c)) return; if (sayVer === c.v && sayBox && sayBox.value === c.text) { closeSheet(); PO().load() } else PO().load() }
    if (go) go.addEventListener('click', async () => {
      const c = sayCtx()
      if (!c.text.trim()) { toast('先寫要傳的話'); return }
      if (!PO().sendLock('table')) return
      go.disabled = true
      let r
      try { r = await PO().post('/table-say', { table: c.table, text: c.text.trim() }) } finally { go.disabled = false; PO().sendUnlock('table') }
      toast(r.text || r.error || '沒有回應')
      if (r.ok) doneOk(c)
    })
    // 📷 照片給整桌（顧問 11-25）：伺服器存一份，Claude 用 Read、Codex 用 view_image；準備照片期間換了選單（換桌、關掉）就取消
    const ph = document.getElementById('v2sayph')
    if (ph) ph.addEventListener('click', () => PO().choosePhoto({ key: 'table', ctx: sayCtx(), still: sameSheet, say: toast, send: async (data, c) => {
      const r = await PO().post('/table-say', { table: c.table, text: c.text.trim(), data })
      if (r.ok) doneOk(c)
      return r.text || r.error || '沒有回應'
    } }))
    document.getElementById('v2rename').addEventListener('click', async () => { if ((await tablesOp({ op: 'edit', id, name: document.getElementById('v2tname').value })).ok) closeSheet() })
    document.getElementById('v2tcollabgo').addEventListener('click', async () => { if ((await tablesOp({ op: 'edit', id, collab: document.getElementById('v2tcollab').value })).ok) closeSheet() })
    body.querySelectorAll('[data-size]').forEach(b => b.addEventListener('click', async () => { if ((await tablesOp({ op: 'edit', id, size: +b.dataset.size })).ok) closeSheet() }))
    const del = document.getElementById('v2del')
    del.addEventListener('click', async () => {
      if (!del.dataset.sure) { del.dataset.sure = '1'; del.classList.add('sure'); del.textContent = `再按一次確定刪除「${t.name}」（坐在這裡的人會改坐別處）`; return } // 0.63.60：寫出桌名，免得刪錯桌
      if ((await tablesOp({ op: 'delete', id, force: true })).ok) closeSheet()
    })
  }
  // ---------- 同桌共用筆記（roadmap 第 11 項，0.62.10）：手機上看是一份；待你決定放最上面（紅點＋數量）；最下面「📝 交代」 ----------
  // ---------- 整桌開會（roadmap 第 9 項，0.62.12）：題目、參與者（預設全桌、主管一定在）、送出前提示用量 ----------
  function openTableMeet(id) {
    const t = ((st && st.tables) || []).find(x => x.id === id); if (!t) return
    const ppl = (st && st.people) || [], members = (t.members || []).map(m => ppl.find(p => p.id === m)).filter(Boolean)
    // 選單美術第三批（ref3-H3）：參與者一人一列（頭像、名字、主持人標籤、切角勾選框）；按「開會」先出確認卡（確定開會／取消）
    sheet(`${t.label || t.name}：開會`,
      `<label>題目</label><input id="v2mtopic" maxlength="40" placeholder="例：本週計畫">` +
      `<h3 class="sec line"><i class="ico meeting"></i>參與者</h3>` +
      members.map(p => `<label class="v2mrow"><span class="pav" style="background-image:url('${src(faceOf(p) + '_front')}')"></span><span class="v2mname">${p.role === 'manager' ? '★ ' : ''}${esc(p.plate)}</span>${p.role === 'manager' ? '<span class="v2mhost">主持人</span>' : ''}<input type="checkbox" class="v2mwho" value="${esc(p.id)}" checked${p.role === 'manager' ? ' disabled' : ''}></label>`).join('') +
      `<div class="note" id="v2mcost"></div><button class="mbtn go" id="v2mgo">開會</button>` +
      `<div id="v2msure" hidden><div class="mcard amber v2msure"><i class="ico hourglass"></i><div><b>確定開會？</b><span id="v2msuretxt"></span></div></div>` +
      `<div class="mline"><button class="mbtn go" id="v2mgo2">確定開會</button><button class="mbtn" id="v2mno">取消</button></div></div>`)
    const who = () => [...document.querySelectorAll('.v2mwho')].filter(c => c.checked).map(c => c.value)
    const go = document.getElementById('v2mgo'), sure = document.getElementById('v2msure')
    const cost = () => { const n = who().length; document.getElementById('v2mcost').textContent = `${n} 位參與，會花 ${n} 份用量。`; sure.hidden = true; go.hidden = false }
    document.querySelectorAll('.v2mwho').forEach(c => c.addEventListener('change', cost)); cost()
    go.addEventListener('click', () => {
      const topic = document.getElementById('v2mtopic').value.trim()
      if (!topic) { toast('先寫題目'); return }
      const n = who().length
      if (n < 2) { toast('至少要兩位參與'); return }
      document.getElementById('v2msuretxt').textContent = `${n} 位參與，會花 ${n} 份用量。`
      sure.hidden = false; go.hidden = true
    })
    document.getElementById('v2mno').addEventListener('click', cost)
    const go2 = document.getElementById('v2mgo2')
    go2.addEventListener('click', async () => {
      const topic = document.getElementById('v2mtopic').value.trim()
      go2.disabled = true
      const r = await PO().post('/table-meet', { table: id, topic, ids: who() })
      go2.disabled = false
      toast(r.text || r.error || '沒有回應')
      if (r.ok) { closeSheet(); PO().load() }
    })
  }
  async function showMeetingResult(mid) {
    // 選單美術第三批（ref3-H4）：結論一張卡、會議資料夾路徑框；從通知列按「看結論」時先收起通知列（不然結論頁被它蓋住）
    hideHelpBar()
    const tok = sheet('會議結論', PO().LOADING)
    let j = { ok: false }
    try { j = await (await fetch(`/meeting.json?id=${encodeURIComponent(mid)}${PO().demo ? '&demo=' + PO().demoN : ''}`, { cache: 'no-store' })).json() } catch {}
    if (PO().sheetId() !== tok) return
    if (!j.ok) { sheet('會議結論', loadErr(j.text || '讀不到結論'), true); return }
    sheet(`${j.label}：${j.topic}`, `<div class="mcard v2mres"><b class="big">會議結論</b><div class="md">${PO().md ? PO().md(j.text) : `<div class="v2npre">${esc(j.text)}</div>`}</div></div>${j.dir ? `<h3 class="sec">會議資料夾</h3><div class="v2path">${esc(j.dir)}</div>` : ''}`, true)
  }

  const TASK_CLS = { waiting: 'wait', doing: 'doing', done: 'done', stuck: 'stuck' }
  function taskCards(tk) {
    if (!tk || (!tk.active.length && !tk.done.length)) return '<div class="note">還沒有任務（主管派工時用 office_task 登記）</div>'
    // 選單美術第三批（ref3-H1）：分工每行右邊一顆狀態徽章（完成／進行中／等前面／卡住）；已完成收成可展開的列
    const card = c => `<div class="mcard v2task"><b class="big">${esc(c.title)}</b><small>${esc(c.progress)}</small>` +
      c.parts.map(p => `<div class="v2tpart ${TASK_CLS[p.state] || ''}"><span class="v2tw">${p.n}. ${esc(p.who)}：${esc(p.what)}${p.note ? `<span class="v2tnote">${esc(p.note)}</span>` : ''}</span><span class="v2tst ${TASK_CLS[p.state] || ''}">${esc(p.stateZh)}</span></div>`).join('') + `</div>`
    return tk.active.map(card).join('') + (tk.done.length ? `<details class="v2tdone"><summary class="mrow ic"><i class="ico check"></i><span><b>已完成（留 7 天）</b><small>${tk.done.length} 件，展開查看</small></span></summary>${tk.done.map(card).join('')}</details>` : '')
  }
  // 先開選單（讀取中），資料回來再補（第 2 段：不等伺服器）；again＝交代完重讀，不再閃「讀取中」
  const tname = id => { const t = ((st && st.tables) || []).find(x => x.id === id); return t ? t.label || t.name : '協作桌' }
  const loadErr = t => `<div class="note po-err">${esc(t)}</div>`
  async function openTableNotes(id, again) {
    const title = `${tname(id)} 共用筆記`, tok = again ? PO().sheetId() : sheet(title, PO().LOADING)
    let j = { ok: false }
    try { j = await (await fetch(`/table-notes.json?table=${id}${PO().demo ? '&demo=' + PO().demoN : ''}`, { cache: 'no-store' })).json() } catch {}
    if (PO().sheetId() !== tok) return
    if (!j.ok) { sheet(title, loadErr(j.text || '讀不到共用筆記'), true); return }
    const pre = t => `<div class="v2npre">${esc(t)}</div>`
    const sec = (title, body, cls = '') => `<h3 class="sec${cls}">${title}</h3>${body}`
    const roleZh = { manager: '主管', admin: '行政', staff: '員工' }
    // 選單美術第三批（ref3-H1）：要你動手的放上面（待你決定、使用者交代），看看就好的在下面；區塊小標＋圖示＋細線
    const hsec = (ic, title, body) => `<h3 class="sec line">${ic ? `<i class="ico ${ic}"></i>` : ''}${title}</h3>${body}`
    sheet(`${j.label} 共用筆記`,
      hsec('warn', `待你決定${j.decide.length ? `<span class="v2dot">${j.decide.length}</span>` : ''}`, j.decide.length ? j.decide.map(d => `<div class="mcard warn"><i class="ico warn"></i><div><b>${esc(d.text)}</b>${d.where ? `<span>細節：${esc(d.where)}</span>` : ''}</div></div>`).join('') : '<div class="note">沒有要你決定的事</div>') +
      hsec('megaphone', '使用者交代', `<div class="mcard amber v2nask">${j.asks.length ? j.asks.map(a => `<div class="v2nrow">${esc(a)}</div>`).join('') : '<div class="v2nrow dim">還沒有交代</div>'}` +
        `<div class="mline"><input id="v2nask" maxlength="2000" placeholder="輸入新的交代…（直接記下來、傳給主管）"><button class="mbtn go" id="v2naskgo">交代</button></div></div>`) +
      // 任務卡片（第 10 項）：主管用 office_task 登記、各人更新自己那份；全部完成收進「已完成」（7 天）
      hsec('task', `任務${j.tasks && j.tasks.active.length ? `<span class="v2pill">進行中 ${j.tasks.active.length} 件</span>` : ''}`, taskCards(j.tasks)) +
      hsec('minutes', '會議紀錄', j.meetings && j.meetings.length ? j.meetings.map(m => `<details class="v2meetlog"><summary class="mrow ic"><i class="ico ${m.done ? 'minutes' : 'meeting'}"></i><span><b>${esc(m.name)}</b><small>${m.done ? '有結論' : '討論中／沒有結論'}・展開查看</small></span></summary>${m.result ? `<div class="mcard"><div class="v2npre">${esc(m.result)}</div></div>` : ''}</details>`).join('') : '<div class="note">還沒有整桌開會</div>') +
      hsec('', '分工與進度（自動）', j.auto.length ? j.auto.map(p => `<div class="v2nrow2${p.blocked ? ' stuck' : p.waiting ? ' wait' : ''}">${esc(p.plate)}・${roleZh[p.role] || '員工'}${p.title && p.title !== p.plate ? '・' + esc(p.title) : ''}・${esc(p.doing)}</div>`).join('') : '<div class="note">—</div>') +
      hsec('', '各人做到哪', j.progress.length ? j.progress.map(p => `<div class="mcard v2prog"><div class="v2ph"><b>${esc(p.plate)}</b>${p.head ? `<small>${esc(p.head)}</small>` : ''}</div>${p.head ? pre(p.text || '') : '<small>還沒有檢查點</small>'}</div>`).join('') : '<div class="note">—</div>') +
      hsec('', '主管寫的', !j.hasBoss ? '<div class="note">這桌還沒有主管</div>' : j.bossPart ? (!j.bossPart.scope && !j.bossPart.parts.length ? '<div class="note">主管還沒寫目標、交接紀錄、重要檔案</div>' : `<div class="mcard">${j.bossPart.scope ? `<small>範圍</small>${pre(j.bossPart.scope)}` : ''}${j.bossPart.parts.map(p => `<b>${esc(p.title)}</b>${pre(p.text)}`).join('')}</div>`) : '<div class="note">主管還沒寫</div>') +
      (j.admin ? hsec('admin', `行政整理（${esc(j.admin.plate)}）`, j.admin.text.trim() ? `<div class="mcard">${pre(j.admin.text)}</div>` : '<div class="note">行政還沒寫</div>') : '') +
      hsec('', '筆記資料夾', `<div class="v2path">${esc(j.dir)}</div>`), true)
    const go = document.getElementById('v2naskgo')
    go.addEventListener('click', async () => {
      const text = document.getElementById('v2nask').value
      if (!text.trim()) { toast('先寫要交代的話'); return }
      go.disabled = true
      const r = await PO().post('/table-note', { table: id, text })
      go.disabled = false
      toast(r.text || r.error || '沒有回應')
      if (r.ok) openTableNotes(id, true)
    })
  }

  // ---------- 整桌等你回覆（roadmap 第 7 項，0.62.7，只做手機）----------
  // 打開時抓一份「在等的人」：等最久的在上面；回完的收到最下面變灰標「已回」（這頁記著，不等伺服器）；
  // 卡在等你按允許的（有 approval）另列一區，只寫要到他的視窗按允許、卡在哪個動作。送出走 /table-reply（也記進這桌聊天室）
  const waitDone = new Map() // 桌號 → 已回的 id
  function openWaitReply(id) {
    const t = ((st && st.tables) || []).find(x => x.id === id)
    if (!t) { toast('找不到這張桌子'); return }
    const ppl = (st && st.people) || []
    const at = (t.members || []).map(m => ppl.find(p => p.id === m)).filter(p => p && p.mode === 'waiting')
    const asks = at.filter(p => !p.approval).sort((a, b) => (a.since || 0) - (b.since || 0))
    const perms = at.filter(p => p.approval)
    const done = waitDone.get(id) || new Set(); waitDone.set(id, done)
    renderWaitReply(t, asks, perms, done)
  }
  function renderWaitReply(t, asks, perms, done) {
    const mins = since => since ? Math.max(0, Math.round((Date.now() - since) / 60e3)) : 0
    const open = asks.filter(p => !done.has(p.id)), closed = asks.filter(p => done.has(p.id))
    const card = (p, isDone) => {
      const said = (p.reply && p.reply.text || '').trim(), lines = said.split('\n'), more = lines.length > 3
      if (isDone) return `<div class="v2wcard done" data-id="${esc(p.id)}"><div class="v2wname"><span>${esc(p.plate)}</span><span class="v2wtag">已回</span></div></div>`
      return `<div class="v2wcard" data-id="${esc(p.id)}">` +
        `<div class="v2wname"><span class="pav" style="background-image:url('${src(faceOf(p) + '_front')}')"></span><span class="pt"><b>${esc(p.plate)}</b><small class="wait">等了 ${mins(p.since)} 分鐘</small></span></div>` +
        (said ? `<div class="v2wsaid${more ? ' more' : ''}">${esc(lines.slice(0, 3).join('\n'))}${more ? '<span class="v2wmore">展開</span>' : ''}</div><div class="v2wfull">${esc(said)}</div>` : '<div class="v2wsaid">（沒有最後的話）</div>') +
        (isDone ? '' : `<textarea class="v2wtext" rows="1" maxlength="3800" placeholder="輸入給這位的回覆…"></textarea>` +
          `<div class="v2wbtns"><button class="mbtn go v2wsend">送出</button><button class="mbtn v2wq" data-q="繼續">繼續</button><button class="mbtn v2wq" data-q="照你建議的">照你建議的</button></div>`) +
        `</div>`
    }
    // 照參考圖 ref2-F4：全部回同一句 → 等待回覆 → 等待允許 → 已回覆 → 都回完了
    sheet(`回覆等你的人`,
      (open.length > 1 ? `<div class="v2wall"><h3 class="sec line"><i class="ico megaphone"></i>全部回同一句（${open.length} 位）</h3><textarea id="v2wall" rows="1" maxlength="3800" placeholder="輸入給 ${open.length} 位的回覆…"></textarea><button class="mbtn go" id="v2wallgo">傳給全部 ${open.length} 位</button><div class="v2wsure" id="v2wallsure" hidden>要傳給 ${open.length} 位嗎？再按一次送出。</div></div>` : '') +
      (open.length ? `<h3 class="sec line">等待回覆</h3>` + open.map(p => card(p, false)).join('') : '') +
      (!asks.length && !perms.length ? '<div class="note">現在沒有人在等你回覆</div>' : '') +
      (perms.length ? `<h3 class="sec line"><i class="ico warn"></i>等待允許</h3>` + perms.map(p => `<div class="mcard warn v2wperm"><i class="ico warn"></i><div><b>${esc(p.plate)}・${esc(p.approval)}</b><span>要到他的視窗按允許（等了 ${mins(p.since)} 分鐘；這裡不能代按）。</span></div></div>`).join('') : '') +
      (closed.length ? `<h3 class="sec line"><i class="ico check"></i>已回覆</h3>` + closed.map(p => card(p, true)).join('') : '') +
      (asks.length && !open.length ? '<div class="v2wdone">這桌都回完了</div>' : ''))
    const body = document.getElementById('mbody')
    const send = async (ids, text, btn) => {
      if (!text.trim()) { toast('先寫要回的話'); return false }
      if (btn) btn.disabled = true
      const r = await PO().post('/table-reply', { table: t.id, ids, text })
      if (btn) btn.disabled = false
      toast(r.text || r.error || '沒有回應')
      if (!r.ok) return false
      for (const x of r.sent || ids) done.add(x)
      renderWaitReply(t, asks, perms, done); PO().load()
      return true
    }
    body.querySelectorAll('.v2wcard[data-id]').forEach(c => {
      const pid = c.dataset.id, s = c.querySelector('.v2wsaid.more')
      if (s) s.addEventListener('click', () => { s.style.display = 'none'; c.querySelector('.v2wfull').style.display = 'block' })
      const go = c.querySelector('.v2wsend'); if (go) go.addEventListener('click', () => send([pid], c.querySelector('.v2wtext').value, go))
      c.querySelectorAll('.v2wq').forEach(q => q.addEventListener('click', () => send([pid], q.dataset.q, q)))
    })
    const all = document.getElementById('v2wallgo')
    if (all) all.addEventListener('click', () => {
      const text = document.getElementById('v2wall').value
      if (!text.trim()) { toast('先寫要回的話'); return }
      if (!all.dataset.sure) { all.dataset.sure = '1'; document.getElementById('v2wallsure').hidden = false; return }
      send(open.map(p => p.id), text, all)
    })
  }

  // ---------- 桌子聊天室（roadmap 第 12 項）：照時間排一條；長訊息先顯示第一行，點了展開 ----------
  async function openTableChat(id) {
    const t = ((st && st.tables) || []).find(x => x.id === id)
    const tok = sheet(`${t ? t.label || t.name : '協作桌'} 聊天室`, PO().LOADING)
    let j = { ok: false, items: [] }
    try { j = await (await fetch(`/table-chat.json?table=${id}${PO().demo ? '&demo=' + PO().demoN : ''}`, { cache: 'no-store' })).json() } catch {}
    if (PO().sheetId() !== tok) return
    const two = n => String(n).padStart(2, '0')
    const when = at => { const d = new Date(at); return `${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}` }
    const items = j.items || []
    const nm = n => String(n || '').replace(/^[^\p{L}\p{N}]+/u, '')
    sheet(`${t ? t.label || t.name : '協作桌'} 聊天室`,
      `<div class="note">同桌互傳的話：只保留最近 30 天；解散桌子時會清除。</div>` +
      (j.ok === false ? `<div style="color:#b13e53">${esc(j.text || '讀不到')}</div>` : items.length ? items.map((c, i) => {
        const line = (c.text.split('\n').find(l => l.trim()) || '').trim(), more = line !== c.text.trim() || line.length > 60
        const all = /整桌/.test(c.to.name || '')
        return `<div class="v2msg mcard${all ? ' amber' : ''}${more ? ' more' : ''}" data-i="${i}">` +
          `<small>${when(c.at)}</small><b>${all ? '<i class="ico megaphone"></i>' : ''}${esc(nm(c.from.name))} → ${esc(nm(c.to.name))}</b>` +
          `<div class="v2head">${esc(line.length > 60 ? line.slice(0, 60) + '…' : line)}${more ? '<span class="v2more">展開</span>' : ''}</div>` +
          `<div class="v2full" style="display:none">${esc(c.text)}</div></div>`
      }).join('') : '<div class="note">還沒有同桌互傳的話</div>'), true)
    const body = document.getElementById('mbody')
    body.querySelectorAll('.v2msg').forEach(m => m.addEventListener('click', () => {
      const full = m.querySelector('.v2full'), head = m.querySelector('.v2head'), open = full.style.display === 'none'
      full.style.display = open ? 'block' : 'none'; head.style.display = open ? 'none' : 'block'
    }))
    body.scrollTop = body.scrollHeight
  }

  // ---------- 點擊：點人、點名牌＝狀態卡（照 GitHub 版，使用者 2026-11-22；卡上「💬 完整對話」再進對話）；點空位＝招聘；點桌牌＝改協作桌 ----------
  let press = null, drag = null, swallow = 0
  ov.addEventListener('click', ev => {
    if (Date.now() - swallow < 600) return
    const zone = ev.target.closest('.zone[data-zone]')
    if (zone) { if (zone.dataset.zone === 'add') tablesOp({ op: 'add', size: 4 }); else openTables(); return }
    const tp = ev.target.closest('.tplate')
    const sg = ev.target.closest('.tsugbtn') // 建議加行政（另一顆小標籤）：開招聘、身分預選行政
    if (sg) { openHireV2(`t${sg.dataset.sug}.`, 'admin'); return }
    if (tp && !(PO().RM && PO().RM.matches)) { tp.classList.remove('po-pop'); void tp.offsetWidth; tp.classList.add('po-pop') } // 點桌牌：彈一下
    if (tp) { if (ev.target.closest('.tsug')) openHireV2(`t${tp.dataset.table}.`, 'admin'); else openTableTap(+tp.dataset.table); return }
    const gh = ev.target.closest('.tag.ghost'); if (gh) { awayGo(gh.dataset.away); return }
    const tag = ev.target.closest('.tag')
    if (tag) { const p = bySeat().get(tag.dataset.seat); if (p) bump(p.id); if (p) PO().openChat(p); return } // 11-26 定案 A：點名牌直接進完整對話
    const b = ev.target.closest('.seat')
    if (!b || !b.dataset.seat) return
    const p = bySeat().get(b.dataset.seat)
    if (p) { bump(p.id); PO().openChat(p) } // 11-26 定案 A：點人物直接進完整對話
    else if (PO().demo) toast('示意資料：空位按了會開「招聘新員工」')
    else openHireV2(b.dataset.seat)
  })
  ov.addEventListener('keydown', ev => { if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.closest('.tag')) { ev.preventDefault(); ev.target.click() } })
  const openSession = p => PO().openChat(p)
  const seatAt = (x, y) => { const el = document.elementFromPoint(x, y); const b = el && el.closest && el.closest('#v2ov .seat'); return b && b.dataset.seat ? b.dataset.seat : undefined }
  const mark = seat => ov.querySelectorAll('.seat').forEach(b => { b.classList.toggle('drop', !!drag && b.dataset.seat === seat && seat !== drag.seat); b.classList.toggle('picked', !!drag && b.dataset.seat === drag.seat) })
  const stop = () => { if (press) clearTimeout(press.timer); press = null; drag = null; ghost.style.display = 'none'; mark() }
  ov.addEventListener('pointerdown', ev => {
    const b = ev.target.closest('.seat'); if (!b || !b.dataset.seat) return
    const p = bySeat().get(b.dataset.seat); if (!p) return
    press = { x: ev.clientX, y: ev.clientY, timer: setTimeout(() => {
      drag = { id: p.id, seat: p.seat, plate: p.plate }; press = null
      if (navigator.vibrate) navigator.vibrate(30)
      ghost.textContent = `搬 ${p.plate}`; ghost.style.left = ev.clientX + 'px'; ghost.style.top = ev.clientY + 'px'; ghost.style.display = 'block'
      mark(p.seat)
    }, 450) }
  })
  ov.addEventListener('contextmenu', e => e.preventDefault())
  addEventListener('pointermove', ev => {
    if (press && Math.hypot(ev.clientX - press.x, ev.clientY - press.y) > 10) stop()
    if (!drag) return
    ghost.style.left = ev.clientX + 'px'; ghost.style.top = ev.clientY + 'px'
    mark(seatAt(ev.clientX, ev.clientY))
  })
  addEventListener('touchmove', ev => { if (drag) ev.preventDefault() }, { passive: false })
  addEventListener('pointerup', async ev => {
    if (!drag) { stop(); return }
    const who = drag, to = seatAt(ev.clientX, ev.clientY)
    stop(); swallow = Date.now()
    if (to === undefined || to === who.seat) { toast('沒放在別的座位上，沒有搬'); return }
    const r = await PO().post('/move', { id: who.id, seat: to }); PO().load()
    toast(r.text || '沒有回應')
  })
  addEventListener('pointercancel', () => { if (!drag) stop() })

  // ---------- 可展開的列收合（第 4 段）：先跑往上收的動畫，0.16 秒後才真的關；展開的動畫在 scene.css ----------
  document.addEventListener('click', e => {
    const sm = e.target.closest && e.target.closest('summary'), d = sm && sm.parentElement
    if (!d || d.tagName !== 'DETAILS' || !d.open || (PO().RM && PO().RM.matches)) return
    e.preventDefault()
    if (d.classList.contains('po-closing')) return
    d.classList.add('po-closing')
    setTimeout(() => { d.open = false; d.classList.remove('po-closing') }, 160)
  })

  // ---------- 人事室（2026-11-22，使用者定稿「門沿浮雕版」：_個人/像素辦公室/人事室-門沿浮雕概念圖.png） ----------
  // 整頁：上方暖木門框＋奶油色「人事室」牌＋兩側菊花，木門楣上有藍鯨、白龍、四角星小浮雕；左上返回、右上招聘
  // 內容：等你回覆／核准排最前（點列直接進對話）→ 員工（搜尋＋協作桌／排班／薪水單一排入口；點列開狀態卡）
  // 功能都接回原本的：招聘 openHire、協作桌 openTables、排班／薪水單走原本人事室選單（客製前端裡的函式），權限與確認不變
  const hr = document.createElement('div'); hr.id = 'hrroom'; hr.setAttribute('role', 'dialog'); hr.setAttribute('aria-label', '人事室')
  // 11-26 定案 C：人事室兩層。第一層總覽（390 寬一頁看完）：等你回覆前 3 位＋一排入口（員工、協作桌、App 裡的 Codex、排班、薪水單）；
  // 第二層從右滑進、左上返回（跟人物卡同一套動畫）：員工（搜尋＋按位置分組、可收合）、全部等你回覆、App 裡的 Codex。
  // 協作桌、排班、薪水單沿用原本的選單（內容不變），改從這裡進。點員工、等你回覆的人＝直接進完整對話（定案 A）
  hr.innerHTML = `<div class="hr-wrap">
    <div class="hr-head">
      <!-- 使用者 2026-11-22：門框要完全照定稿概念圖 → 直接用概念圖頁首（852×202），等比例縮放；返回、招聘是疊在圖上的透明按鈕 -->
      <img class="hr-headimg" src="${src('hr_head')}" alt="人事室">
      <button class="hr-back" aria-label="返回辦公室"></button>
      <button class="hr-hire" aria-label="招聘新員工"></button>
    </div>
    <div class="hr-body">
      <div class="hr-l1">
        <section class="hr-sec" id="hrwait"><h2><span>等你回覆</span><b class="hr-count"></b></h2><div class="hr-list"></div></section>
        <nav class="hr-ents" aria-label="人事室">
          <button class="hr-ent" data-l2="staff"><span class="hr-ei" aria-hidden="true">👥</span><span class="hr-txt"><b>員工</b><small id="hrn-staff"></small></span><span class="hr-go" aria-hidden="true">›</span></button>
          <button class="hr-ent" data-q="tables"><img class="hr-ic" src="${src('hr_ic_tables')}" alt=""><span class="hr-txt"><b>協作桌</b><small id="hrn-tables"></small></span><span class="hr-go" aria-hidden="true">›</span></button>
          <button class="hr-ent" data-l2="away" id="hrent-away"><span class="hr-ei" aria-hidden="true">📱</span><span class="hr-txt"><b>在 App 裡的 Codex</b><small id="hrn-away"></small></span><span class="hr-go" aria-hidden="true">›</span></button>
          <button class="hr-ent" data-q="project"><span class="hr-ei" aria-hidden="true"><i class="ico notes"></i></span><span class="hr-txt"><b>開專案</b><small>從專案的主管卡開人</small></span><span class="hr-go" aria-hidden="true">›</span></button>
          <button class="hr-ent" data-q="shift"><img class="hr-ic" src="${src('hr_ic_shift')}" alt=""><span class="hr-txt"><b>排班</b><small id="hrn-shift"></small></span><span class="hr-go" aria-hidden="true">›</span></button>
          <button class="hr-ent" data-q="pay"><img class="hr-ic" src="${src('hr_ic_pay')}" alt=""><span class="hr-txt"><b>薪水單</b><small id="hrn-pay"></small></span><span class="hr-go" aria-hidden="true">›</span></button>
        </nav>
      </div>
      <div class="hr-l2" hidden>
        <div class="hr-l2bar"><button class="hr-l2back">‹ 返回</button><h2 class="hr-l2title"></h2></div>
        <div class="hr-tools" id="hrtools"><label class="hr-search"><span aria-hidden="true">🔍</span><input type="search" placeholder="搜尋員工（名字、職稱）" aria-label="搜尋員工"></label></div>
        <div class="hr-list" id="hrstaff"></div>
      </div>
    </div></div>`
  document.body.appendChild(hr)
  const MODE_HR = { typing: ['工作中', 'work'], thinking: ['工作中', 'work'], reading: ['工作中', 'work'], idle: ['閒置', 'idle'], done: ['剛做完', 'done'], blocked: ['卡住了', 'err'], waiting: ['等你回覆', 'wait'] }
  const minsAgo = t => { if (!t) return ''; const m = Math.max(0, Math.round((Date.now() - t) / 60000)); return m < 60 ? `${m} 分鐘` : `${Math.round(m / 60)} 小時` }
  const avatar = p => `<span class="hr-av" style="background-image:url('${src(faceOf(p) + '_front')}')"></span>`
  const fmtN = n => n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0)
  const star = p => p.role === 'manager' ? '<i class="hr-star">★</i>' : ''
  const waitRow = p => `<button class="hr-row" data-id="${esc(p.id)}" data-act="chat">${avatar(p)}<span class="hr-txt"><b>${star(p)}${esc(p.plate)}</b><small><em class="hr-chip wait">${p.approval ? '等你核准' : '等你回覆'}</em>・${minsAgo(p.since)}${p.title ? `<span class="hr-wt">・${esc(p.title)}</span>` : ''}</small></span><span class="hr-go" aria-hidden="true">›</span></button>`
  const staffRow = p => {
    const [t, c] = MODE_HR[p.mode] || [p.modeText || p.mode, 'idle']
    return `<button class="hr-row" data-id="${esc(p.id)}" data-act="chat">${avatar(p)}<span class="hr-txt"><b>${star(p)}${esc(p.plate)}${p.kind === 'codex' ? ' <i class="hr-tag">Codex</i>' : ''}</b><small><em class="hr-dot ${c}"></em>${esc(t)}${p.title && p.title !== p.plate ? '・' + esc(p.title) : ''}</small></span><span class="hr-go" aria-hidden="true">›</span></button>`
  }
  // 員工頁的收合：每組（協作桌 t<id>、辦公區 office）收起來的記在本機；搜尋時不管收合，直接列結果
  const FOLD_KEY = 'po-hr-fold'
  let fold = new Set()
  try { fold = new Set(JSON.parse(localStorage.getItem(FOLD_KEY) || '[]')) } catch {}
  const saveFold = () => { try { localStorage.setItem(FOLD_KEY, JSON.stringify([...fold])) } catch {} }
  let hrQuery = '', l2 = '' // l2：'' 第一層；'staff'｜'wait'｜'away' 第二層
  const L2T = { staff: '員工', wait: '等你回覆', away: '在 App 裡的 Codex' }
  /** 排班：今天還沒到的次數（暫停的不算） */
  function shiftsLeft(list, now = new Date()) {
    const hm = now.getHours() * 60 + now.getMinutes(), d = now.getDay()
    return (list || []).filter(x => x.on !== false && (x.days === 'daily' || (x.days === 'weekdays' ? d >= 1 && d <= 5 : x.days === 'weekly' ? d === (x.dow ?? 1) : false)) && (() => { const [h, m] = String(x.time || '').split(':').map(Number); return h * 60 + m > hm })()).length
  }
  function hrRender() {
    if (hr.style.display !== 'flex' || !st) return
    const people = st.people || [], tables = st.tables || []
    const waiting = people.filter(p => p.mode === 'waiting').sort((a, b) => (a.since || 0) - (b.since || 0))
    const away = awayList()
    // ---- 第一層 ----
    hr.querySelector('#hrwait .hr-count').textContent = waiting.length || ''
    hr.querySelector('#hrwait').style.display = waiting.length ? '' : 'none'
    hr.querySelector('#hrwait .hr-list').innerHTML = waiting.slice(0, 3).map(waitRow).join('') +
      (waiting.length > 3 ? `<button class="hr-more" data-l2="wait">還有 ${waiting.length - 3} 位 ›</button>` : '')
    const stuck = people.filter(p => p.mode === 'blocked').length
    hr.querySelector('#hrn-staff').textContent = `${people.length} 位在線${stuck ? `・${stuck} 位卡住` : ''}`
    const noBoss = tables.filter(t => t.noBoss).length
    hr.querySelector('#hrn-tables').textContent = `${tables.length} 桌${noBoss ? `・缺主管 ${noBoss} 桌` : ''}`
    hr.querySelector('#hrent-away').style.display = away.length ? '' : 'none'
    hr.querySelector('#hrn-away').textContent = `${away.length} 位`
    const left = shiftsLeft(st.shifts)
    hr.querySelector('#hrn-shift').textContent = (st.shifts || []).length ? `今天還有 ${left} 次` : '還沒有排班'
    const out = people.reduce((t, p) => t + (p.usage ? p.usage.o || 0 : 0), 0)
    hr.querySelector('#hrn-pay').textContent = people.some(p => p.usage) ? `今天寫出 ${fmtN(out)}` : '今天還沒有用量'
    // ---- 第二層 ----
    if (!l2) return
    if (l2 === 'away' && !away.length) { closeL2(); return }
    hr.querySelector('#hrtools').style.display = l2 === 'staff' ? '' : 'none'
    const list = hr.querySelector('#hrstaff')
    if (l2 === 'wait') { list.innerHTML = waiting.map(waitRow).join('') || '<div class="hr-empty">沒有人在等你</div>'; return }
    if (l2 === 'away') {
      const awayTm = awayTimes(away)
      list.innerHTML = away.map(a => `<button class="hr-row" data-away="${esc(a.id)}">${avatar({ species: 'chatgpt' })}<span class="hr-txt"><b>${esc(a.plate)} <i class="hr-tag">Codex</i></b><small><em class="hr-dot idle"></em>在 App 裡・${a.handedOff ? '從辦公室交過去' : '在 App 新開的'}${a.at ? '・' + (a.handedOff ? '' : '關掉 ') + esc(awayTm.get(a.id)) : ''}${a.resumable ? '・點了可接回後台' : '・' + esc(a.why || '現在接不回來')}</small></span></button>`).join('')
      return
    }
    const q = hrQuery.trim().toLowerCase()
    const order = (a, b) => (b.role === 'manager') - (a.role === 'manager') || String(a.plate).localeCompare(String(b.plate), 'zh-Hant')
    if (q) {
      const hit = people.filter(p => [p.plate, p.title, p.agent, p.name].some(v => v && String(v).toLowerCase().includes(q))).sort(order)
      list.innerHTML = hit.map(staffRow).join('') || '<div class="hr-empty">找不到符合的員工</div>'
      return
    }
    // 按位置分組：每張協作桌一組（桌名＋人數、主管第一），其他人一組「辦公區」
    const byId = new Map(people.map(p => [p.id, p])), seen = new Set()
    const groups = tables.map(t => {
      const ms = (t.members || []).map(id => byId.get(id)).filter(Boolean)
      ms.forEach(p => seen.add(p.id))
      return { key: 't' + t.id, name: t.name || t.label || `協作桌 ${t.id}`, ms }
    }).filter(g => g.ms.length)
    const rest = people.filter(p => !seen.has(p.id))
    if (rest.length) groups.push({ key: 'office', name: '辦公區', ms: rest })
    list.innerHTML = groups.map(g => {
      const shut = fold.has(g.key)
      return `<section class="hr-grp${shut ? ' shut' : ''}"><button class="hr-gh" data-fold="${esc(g.key)}" aria-expanded="${!shut}"><b>${esc(g.name)}</b><small>${g.ms.length} 人</small><span class="hr-gc" aria-hidden="true">${shut ? '▸' : '▾'}</span></button>` +
        (shut ? '' : `<div class="hr-gl">${g.ms.sort(order).map(staffRow).join('')}</div>`) + '</section>'
    }).join('') || '<div class="hr-empty">目前沒有員工在線</div>'
  }
  function openL2(kind) {
    l2 = kind
    hr.querySelector('.hr-l1').hidden = true
    const page = hr.querySelector('.hr-l2'); page.hidden = false
    hr.querySelector('.hr-l2title').textContent = L2T[kind]
    hr.querySelector('.hr-body').scrollTop = 0
    if (!(PO().RM && PO().RM.matches)) { page.classList.remove('c2in'); void page.offsetWidth; page.classList.add('c2in') }
    hrRender()
    hr.querySelector('.hr-l2back').focus()
  }
  function closeL2() {
    if (!l2) return
    l2 = ''
    hr.querySelector('.hr-l2').hidden = true
    const l1 = hr.querySelector('.hr-l1'); l1.hidden = false
    if (!(PO().RM && PO().RM.matches)) { l1.classList.remove('c1back'); void l1.offsetWidth; l1.classList.add('c1back') }
    hrRender()
  }
  function openHR() { l2 = ''; hr.querySelector('.hr-l2').hidden = true; hr.querySelector('.hr-l1').hidden = false; PO().pop(hr, 'flex'); hrRender(); hr.querySelector('.hr-back').focus() }
  function closeHR() { PO().unpop(hr) }
  window.PO_SCENE.openHR = openHR
  PO().onState(() => hrRender())
  hr.querySelector('.hr-back').addEventListener('click', closeHR)
  hr.querySelector('.hr-l2back').addEventListener('click', closeL2)
  hr.addEventListener('keydown', e => { if (e.key === 'Escape') { if (l2) closeL2(); else closeHR() } })
  hr.querySelector('.hr-hire').addEventListener('click', () => PO().openHire())
  hr.querySelector('.hr-search input').addEventListener('input', e => { hrQuery = e.target.value; hrRender() })
  hr.addEventListener('click', e => {
    const q = e.target.closest('[data-q]')
    if (q) { if (q.dataset.q === 'tables') openTables(); else if (q.dataset.q === 'project') openCardsV2('project'); else if (q.dataset.q === 'shift') PO().openShift(); else PO().openPay(); return }
    const g = e.target.closest('[data-l2]'); if (g) { openL2(g.dataset.l2); return }
    const f = e.target.closest('[data-fold]')
    if (f) { const k = f.dataset.fold; if (fold.has(k)) fold.delete(k); else fold.add(k); saveFold(); hrRender(); return }
    const r = e.target.closest('.hr-row'); if (!r) return
    if (r.dataset.away) { awayGo(r.dataset.away); return }
    const p = (st && st.people || []).find(x => x.id === r.dataset.id); if (!p) { toast('這位已經不在線'); return }
    openSession(p) // 定案 C：員工名單點下去直接進完整對話
  })
  // 標題列的「☰ 人事室」與「N 人在線 · M 位等你」都開人事室
  document.getElementById('hrbtn').addEventListener('click', openHR)
  document.getElementById('count').addEventListener('click', openHR)
})()
