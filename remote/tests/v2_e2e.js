// 手機版 v2 整頁測試（無頭 Chrome）：node remote/tests/v2_e2e.js [網址] [截圖資料夾]
// 要 playwright-core（NODE_PATH 指到有它的 node_modules）；Chrome 用本機的 Google Chrome（或環境變數 CHROME）
// 示意模式：點人進對話、點名牌開卡、人事室、協作桌新增／改人數／改名、換座位、排班／薪水單開得起來、三種寬度沒有橫捲
// 真資料：只看不送（點人開完整對話、Codex 開最後回覆），整段測試不能有任何 POST
// 0.63.56 端點驗證：伺服器要用 PO_DEV=1 開在測試埠 8781／8782（PO_DEV=1 PO_PORT=8782 bun remote/server.ts），不然資料端點都回 401
const { chromium } = require('playwright-core')
;(async () => {
  const base = process.argv[2] || 'http://127.0.0.1:8781'
  const probe = await fetch(base + '/state.json?demo=1').catch(() => null)
  if (!probe || probe.status === 401) { console.log('FAIL 伺服器要用 PO_DEV=1 開在 8781／8782（0.63.56 端點驗證），不然讀不到資料'); process.exit(1) }
  const shots = process.argv[3]
  const b = await chromium.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true })
  const fails = [], log = []
  const ok = (c, m) => { (c ? log : fails).push((c ? 'OK ' : 'FAIL ') + m) }
  async function page(w, h, url, mobile = true) {
    const p = await b.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1, isMobile: mobile, hasTouch: mobile })
    p.errs = []; p.on('pageerror', e => p.errs.push(String(e)))
    p.posts = []; p.on('request', r => { if (r.method() !== 'GET') p.posts.push(new URL(r.url()).pathname) })
    await p.goto(base + url); await p.waitForTimeout(2500)
    return p
  }
  const st = p => p.evaluate(() => window.PO.state())
  const noHScroll = p => p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)

  // ---------- 手機 390×844 示意 48 人 ----------
  let p = await page(390, 844, '/?demo=48')
  await p.evaluate(() => window.PO.post('/tables', { op: 'reset' })); await p.reload(); await p.waitForTimeout(2500) // 同一個伺服器連跑：示意座位表回到預設
  let s = await st(p)
  ok(s && s.people.length === 48, `示意 48 人載入（${s && s.people.length}）`)
  ok(s.tables.length >= 2, `團隊自動開協作桌 ${s.tables.length} 張`)
  ok(s.people.filter(x => x.team).every(x => /^t\d+\./.test(x.seat)), '有主管的人都坐協作桌')
  ok(await noHScroll(p), '390 寬沒有橫捲')
  const top = await p.evaluate(() => { const h = document.querySelector('header'), c = document.getElementById('count'); return { theme: document.querySelector('meta[name=theme-color]').content, bg: getComputedStyle(h).borderImageSource, // D-1（0.63.56）起木紋橫條改用 border-image
       plate: getComputedStyle(c).borderImageSource, h: h.getBoundingClientRect().height } })
  ok(top.theme === '#3b2412' && /ui_title_bar/.test(top.bg) && /ui_title_plate/.test(top.plate) && top.h <= 56, '主畫面頂端是木頭招牌（木紋橫條、米白名牌、狀態列深咖啡）' + JSON.stringify({ theme: top.theme, h: top.h }))
  ok(await p.locator('#v2ov .seat:not(.empty)').count() === 48, '48 個有人的座位點擊區')
  // 拉椅子（2026-11-24）：近側起立＝人和椅子一起往後 → 原地站起 → 往左走出椅子；入座倒過來，坐下後一起靠回去
  const pull = await p.evaluate(() => {
    const m = window.PO_SCENE.motion, near = m.seats().filter(k => /^t\d+\.\d*[13579]$/.test(k) && m.entry(k))
    if (near.length < 2) return null
    const tr = { from: near[0], to: near[1], start: 0, speed: 36 }, P = m.plan(tr), at = t => m.pose(tr, t)
    const back = m.seatXY(near[0]).back, a = at(m.CHAIR_MS / 2), r = at(m.CHAIR_MS + 10), s1 = at(P.w0 + 50), end = at(P.end + 1), push = at(P.end - m.CHAIR_MS / 2)
    return { a, r, s1, end, push, slotY: P.eA.slot.y, sitY: m.anchors(near[0]).sit.y, side: P.eA.side.x, backX: back.x, sit2: m.anchors(near[1]).sit }
  })
  ok(pull && pull.a.phase === 'pull' && pull.a.y > pull.sitY && pull.a.y < pull.slotY, '近側起立：先坐著跟椅子一起往後')
  ok(pull && pull.r.phase === 'rise' && Math.abs(pull.r.y - pull.slotY) < 0.01, '近側起立：在拉開的位置原地站起')
  ok(pull && pull.s1.phase === 'step' && pull.s1.facing === 'left' && pull.side < pull.backX, '近側起立：往左走出椅子（不從椅子正後方穿過）')
  ok(pull && pull.push.phase === 'push' && pull.end.pose === 'sit' && !pull.end.phase && Math.abs(pull.end.y - pull.sit2.y) < 0.01, '近側入座：坐下後跟椅子一起靠回桌邊')
  // 四位角色新圖＋遠側獨立椅子（2026-11-24 上線）
  const art = await p.evaluate(async () => {
    const m = window.PO_SCENE.motion, far = m.seats().find(k => /^t\d+\.\d*[02468]$/.test(k)), s = far && m.seatXY(far), e = far && m.entry(far)
    const near = m.seats().find(k => /^t\d+\.\d*[13579]$/.test(k))
    const M = await (await fetch('/v2/assets/manifest.json')).json()
    const names = ['claude', 'chatgpt', 'gemini', 'deepseek'].flatMap(sp => [`full_${sp}_up_rise_0`, `full_${sp}_down_type_0`, `full_${sp}_left_walk_7`])
    const got = await Promise.all(names.map(n => fetch(`/v2/assets/${n}.png`).then(r => r.ok && !!M[n])))
    return { chair: !!(s && s.chair), dir: e && e.dir, feetFar: s && Math.abs(m.anchors(far).sit.y - s.feet) < 0.01, feetNear: near && Math.abs(m.anchors(near).sit.y - m.seatXY(near).feet) < 0.01, missing: names.filter((n, i) => !got[i]) }
  })
  ok(art.chair && art.dir === -1, '遠側座位用獨立椅子，起立往上拉椅子')
  ok(art.feetFar && art.feetNear, '坐姿錨點＝座位的腳底線（遠側、近側）')
  ok(!art.missing.length, `四位角色起立、打字、側走影格都有登記也載得到（${art.missing.join(',') || '全有'}）`)
  // 0.63.1：圖片網址帶內容雜湊；帶對的 v 放一年，沒帶照舊 5 分鐘
  const cache = await p.evaluate(async () => {
    const imgs = performance.getEntriesByType('resource').map(e => new URL(e.name)).filter(u => /^\/v2\/assets\/.+\.(png|json)$/.test(u.pathname))
    const one = imgs.find(u => u.pathname.endsWith('/floor_tile.png'))
    const cc = async q => (await fetch('/v2/assets/floor_tile.png' + q)).headers.get('cache-control')
    const css = [...document.styleSheets].flatMap(s => { try { return [...s.cssRules].map(r => r.cssText) } catch { return [] } }).join('\n')
    return { n: imgs.length, unv: imgs.filter(u => !u.searchParams.get('v')).map(u => u.pathname), good: one && await cc(one.search), bare: await cc(''), bad: await cc('?v=zzz'), css: /assets\/ui_card\.png\?v=\w+/.test(css) }
  })
  ok(cache.n > 20 && !cache.unv.length, `場景載的圖、manifest 網址都帶 v（${cache.n} 個；沒帶：${cache.unv.slice(0, 3).join(',') || '無'}）`)
  ok(/immutable/.test(cache.good || '') && cache.bare === 'max-age=300' && cache.bad === 'max-age=300', `帶對的 v 放一年、沒帶或對不上 5 分鐘（${cache.good}／${cache.bare}／${cache.bad}）`)
  ok(cache.css, 'scene.css 裡的選單圖網址帶 v')
  // 0.62.5 自動多開幫手（示意）：上方通知「想加一位幫手…要加嗎？」加／不要；快被關的幫手有「留著」；答過就收起
  ok(await p.locator('#v2help .hask').count() === 2 && (await p.textContent('#v2help')).includes('想加一位幫手'), '幫手請求通知（示意）')
  // 0.63.37 Codex 生圖幫手：通知寫明是 Codex 生圖
  ok((await p.textContent('#v2help [data-ask="demo-ask-art"][data-op="yes"] >> xpath=ancestor::div[contains(@class,"ncard")]')).includes('想加一位 Codex 生圖幫手'), 'Codex 生圖幫手請求通知（示意）')
  ok(await p.locator('#v2help [data-keep]').count() === 1, '閒置幫手快被關的通知有「留著」')
  // 0.62.17：通知列收起＝縮回一行小條（通知還在）；點小條再展開；展開最高 40vh
  await p.click('#v2helpx'); await p.waitForTimeout(300)
  ok(await p.isVisible('#v2helpmini') && !(await p.isVisible('#v2help .hask')), '通知列收起變小條')
  await p.click('#v2helpmini'); await p.waitForTimeout(300)
  ok(await p.isVisible('#v2help .hask') && (await p.$eval('#v2help', e => e.getBoundingClientRect().height)) <= (await p.evaluate(() => innerHeight)) * 0.4 + 1, '點小條展開、高度不超過 40vh')
  await p.locator('#v2help [data-ask="demo-ask"][data-op="yes"]').click(); await p.waitForTimeout(600)
  ok((await p.textContent('#ptoast')).includes('會開一位幫手'), '按「加」（示意）')
  await p.locator('#v2help [data-ask="demo-ask-art"][data-op="yes"]').click()
  ok(await p.waitForFunction(() => (document.querySelector('#ptoast')?.textContent || '').includes('會開一位 Codex 生圖幫手'), null, { timeout: 8000 }).then(() => true, () => false), 'Codex 生圖幫手按「加」（示意）')
  // 0.63.40 Codex 幫手要人工確認：寫明 tmux 名稱、不會自動關；按「知道了」收掉
  ok((await p.textContent('#v2help .hcheck')).includes('一直沒進辦公室名冊') && (await p.textContent('#v2help .hcheck')).includes('tmux po-cxp-demo0001'), 'Codex 幫手人工確認提醒（示意）')
  await p.locator('#v2help [data-hcheck]').click(); await p.waitForTimeout(400)
  ok(await p.locator('#v2help .hcheck').count() === 0, '人工確認提醒按「知道了」收掉')
  // 0.63.41：同一個原因解除後再發生（伺服器給新的開始時間）要再顯示：先讓它消失，再用新的開始時間回來
  const setChecks = async list => { await p.unroute('**/state.json*').catch(() => {}); await p.route('**/state.json*', async route => { const r = await route.fetch(); const j = await r.json(); if (j.helpers) j.helpers.checks = list; await route.fulfill({ response: r, json: j }) }) }
  await setChecks([]); await p.waitForTimeout(1800)
  await setChecks([{ id: 'demo-check', at: 1, name: '（示意）生圖幫手', why: '一直沒進辦公室名冊', retry: false, session: 'po-cxp-demo0001' }])
  ok(await p.waitForFunction(() => document.querySelectorAll('#v2help .hcheck').length === 1, null, { timeout: 8000 }).then(() => true, () => false), '人工確認：解除後同原因再發生會再顯示')
  await setChecks([{ id: 'demo-check', at: 2, name: '（示意）生圖幫手', why: '閒置 30 分鐘，這次自動關閉沒成功', retry: true, session: 'po-cxp-demo0001' }])
  ok(await p.waitForFunction(() => (document.querySelector('#v2help .hcheck')?.textContent || '').includes('下一輪會再試'), null, { timeout: 8000 }).then(() => true, () => false), '人工確認：自動關閉失敗寫「下一輪會再試」')
  await setChecks([]); await p.waitForTimeout(1500); await p.unroute('**/state.json*')
  // 示意原本那件（開始時間沒變）回來了，再收一次，免得擋到後面的點擊
  await p.waitForFunction(() => document.querySelectorAll('#v2help .hcheck').length === 1, null, { timeout: 8000 }).catch(() => {})
  if (await p.locator('#v2help [data-hcheck]').count()) { await p.locator('#v2help [data-hcheck]').click(); await p.waitForTimeout(400) }
  await p.waitForTimeout(400)
  await p.locator('#v2help [data-keep]').click(); await p.waitForTimeout(600)
  // 0.62.8 換主管交接（示意）：原主管沒交接 → 要等還是直接換；換好了的通知 → 知道了
  ok((await p.textContent('#v2help')).includes('要等，還是直接換'), '交接：原主管沒交接時問使用者')
  await p.locator('#v2help [data-hoop="wait"]').click(); await p.waitForTimeout(600)
  ok((await p.textContent('#ptoast')).includes('再等 5 分鐘'), '交接：按「再等 5 分鐘」（示意）')
  ok((await p.textContent('#v2help')).includes('已接任主管'), '交接：換好了的通知')
  await p.locator('#v2help [data-hook]').click(); await p.waitForTimeout(300)
  // 0.62.12 整桌開會開完了（示意）：點「看結論」開結論
  ok((await p.textContent('#v2help')).includes('開完會了'), '通知「某桌開完會了」')
  ok((await p.textContent('#v2help')).includes('卡在電腦上的確認畫面') && (await p.textContent('#v2help')).includes('tmux attach -t po-cxp-1234abcd'), '通知「新員工卡在確認畫面」附 tmux attach')
  ok(await p.locator('#v2help [data-stuckopt]').count() === 3 && (await p.textContent('#v2help .hstuck')).includes('2. Trust all and continue'), '卡住通知列出畫面上的選項')
  await p.locator('#v2help [data-stuckopt="n2"]').click(); await p.waitForTimeout(500)
  ok((await p.textContent('#ptoast')).includes('Trust all and continue'), '點選項送出（示意）')
  await p.locator('#v2help [data-stuckok]').click(); await p.waitForTimeout(300)
  ok(!(await p.textContent('#v2help')).includes('卡在電腦上的確認畫面'), '按「知道了」收掉卡住通知')
  // 0.63.28 Codex 交給 App（示意）：通知「可以在 App 打開「…」接著聊了」，按「知道了」收掉；示意的 at 固定，輪詢不會當成新通知
  ok((await p.textContent('#v2help .hcxh')).includes('可以在 App 打開「（示意）報價小幫手」接著聊了'), 'Codex 交給 App 的通知（示意）')
  await p.locator('#v2help [data-cxhok]').click(); await p.waitForTimeout(1500)
  ok(await p.locator('#v2help .hcxh').count() === 0, '按「知道了」收掉交給 App 通知，輪詢後不再跳回來')
  // 0.63.48 乙案：在 App 裡關掉、沒有座位的 Codex（示意 cxnew）在畫面最下面一條灰卡；有座位的（cxaway）照舊畫在座位上，不進灰卡
  ok(await p.locator('#v2away .awcard').count() === 1 && (await p.textContent('#v2away .awcard')).includes('cxnew') && (await p.textContent('#v2away .awcard')).includes('在 App 裡關了'), '在 App 裡關掉的 Codex 有灰卡（不佔座位）')
  const awb = await p.locator('#v2away .awcard').boundingBox()
  ok(awb && awb.height >= 44 && awb.y + awb.height <= 844, `灰卡按鈕至少 44 px、在畫面內（${awb && Math.round(awb.height)}）`)
  // 第二階段（B③）：點灰卡進完整對話，只能看（輸入框收起、沒有 ⚙），頂端「接回後台」（App 還開著：停用、點了說原因）
  await p.locator('#v2away .awcard').click(); await p.waitForTimeout(600)
  ok(await p.isVisible('#chat') && !(await p.isVisible('#chsay')) && !(await p.isVisible('#chcfg')) && (await p.textContent('#chbtns')).includes('接回後台') && (await p.getAttribute('#chbtns .chip', 'aria-disabled')) === 'true', '點灰卡進完整對話：只能看、頂端接回後台（App 還開著：停用）')
  ok((await p.textContent('#chsent')).includes('只能看'), '灰卡對話底下寫「只能看」')
  await p.click('#chback'); await p.waitForTimeout(400)
  await p.click('#mclose').catch(() => {})
  await p.click('#hrbtn'); await p.waitForTimeout(300)
  ok(await p.isVisible('#hrent-away') && /\d+ 位/.test(await p.textContent('#hrent-away')), '人事室第一層有「在 App 裡的 Codex」入口與人數')
  await p.click('#hrent-away'); await p.waitForTimeout(300)
  ok((await p.textContent('#hrstaff')).includes('cxnew') && (await p.textContent('#hrstaff')).includes('關掉'), '人事室「在 App 裡的 Codex」列出名字與關掉時間')
  await p.locator('#hrstaff .hr-row[data-away]').first().click(); await p.waitForTimeout(600)
  ok(await p.isVisible('#chat') && !(await p.isVisible('#chsay')) && (await p.textContent('#chbtns')).includes('接回後台'), '人事室「在 App 裡的 Codex」點人進唯讀完整對話（頂端接回後台）')
  await p.click('#chback'); await p.waitForTimeout(400)
  ok(await p.isVisible('#hrroom .hr-l2'), '關掉對話回到人事室「在 App 裡的 Codex」頁')
  await p.click('#hrroom .hr-l2back').catch(() => {}); await p.waitForTimeout(300)
  await p.click('#hrroom .hr-back').catch(() => {}); await p.waitForTimeout(200)
  await p.locator('#v2help [data-meet]').click(); await p.waitForTimeout(800)
  ok((await p.textContent('#mbody')).includes('要不要含運費'), '點「看結論」看得到結論')
  await p.click('#mclose').catch(() => {})
  ok(!(await p.isVisible('#v2help')), '答完、留完通知收起來')
  ok((await p.locator('.tplate').first().textContent()).includes('交接中'), '交接中的桌牌寫「交接中」')
  // 0.62.8 招聘：身分（員工／主管）、坐哪（現有的桌／開新桌／辦公區）；主管＋已有主管的桌提示會走交接
  await p.click('#hrbtn'); await p.waitForTimeout(300)
  await p.click('#hrroom .hr-hire'); await p.waitForTimeout(300)
  ok(await p.locator('input[name="hrole"]').count() === 3 && await p.locator('#hseat option[value="new"]').count() === 1 && await p.locator('#hseat option[value="none"]').count() === 1, '招聘有身分（員工／主管／行政）與坐哪')
  // 0.62.20 招 Codex：選 Codex → 主管不能選、提示會花 ChatGPT 的用量；切回 Claude 恢復
  await p.locator('input[name="hagent"][value="codex"]').check(); await p.waitForTimeout(150)
  ok(await p.locator('input[name="hrole"][value="manager"]').isDisabled() && (await p.textContent('#hagentnote')).includes('ChatGPT 的用量'), '招聘選 Codex：主管停用、提示用量')
  ok(!(await p.isVisible('#hchrome')), '選 Codex 時不顯示「操作瀏覽器」')
  await p.locator('input[name="hagent"][value="claude"]').check(); await p.waitForTimeout(150)
  ok(!(await p.locator('input[name="hrole"][value="manager"]').isDisabled()) && !(await p.isVisible('#hagentnote')), '切回 Claude 恢復')
  ok(await p.isVisible('#hchrome'), 'Claude 招聘有「可以操作瀏覽器（--chrome）」')
  const bossT = s.tables.find(t => (t.members || []).some(id => s.people.find(x => x.id === id && x.role === 'manager')))
  await p.selectOption('#hseat', String(bossT.id)); await p.check('input[name="hrole"][value="manager"]'); await p.waitForTimeout(100)
  ok((await p.textContent('#hseatnote')).includes('會走交接'), '主管＋已有主管的桌：提示會走交接')
  await p.check('input[name="hrole"][value="staff"]'); await p.waitForTimeout(100)
  ok((await p.textContent('#hseatnote')).includes('掛在'), '員工＋有主管的桌：提示會掛主管')
  await p.click('#mclose').catch(() => {})
  await p.click('#hrroom .hr-back').catch(() => {}); await p.waitForTimeout(200)
  ok(await p.locator('#v2ov .spot').count() === 0, '家具沒有點擊區（家具選單拿掉了）')
  ok((await p.textContent('#count')).includes('48 人在線'), '標題列中文人數')
  // 11-26 定案 A：點人物直接進完整對話（取代人物卡第一層）；右上 ⚙ 進設定（三頁），返回一路回到完整對話
  const who = s.people.find(x => x.plate === '報價助理')
  await p.locator(`#v2ov .seat[data-seat="${who.seat}"]`).click(); await p.waitForTimeout(500)
  ok(await p.isVisible('#chat') && !(await p.isVisible('#card')), '點「報價助理」直接進完整對話，不開狀態卡')
  ok((await p.textContent('#chname')).includes('報價助理'), '對話標題是報價助理')
  ok((await p.textContent('#chlog')).includes('示意回覆'), '示意對話內容出來')
  ok(/正在|思考|閒著|等你|剛做完|卡住|卡在允許/.test(await p.textContent('#chmode')) && (await p.textContent('#chline')).length > 0, '頂端狀態列：狀態＋模型那一行')
  ok(await p.isVisible('#chchibi') && await p.isVisible('#chsay'), '頂端有 Q 版大頭、底部有輸入框')
  ok(!(await p.isVisible('#v2help')), '完整對話整頁時通知列收起')
  ok((await p.getAttribute('#chmode', 'role')) === 'status' && (await p.getAttribute('#chsent', 'aria-live')) === 'polite', '狀態列、送達狀態是 live region（審查 C-3）')
  ok(await p.evaluate(() => ['chcfg', 'chback'].every(id => { const b = document.getElementById(id).getBoundingClientRect(), x = b.left + b.width / 2; return [b.top - 7, b.bottom + 7].every(y => document.elementFromPoint(x, y) === document.getElementById(id)) })), '⚙、× 上下各多 7px 也點得到（44px 點擊範圍，審查 C-2）')
  ok(await p.evaluate(() => { const q = PO.find(PO.state().people.find(x => x.mode === 'idle')?.id); if (!q) return true; PO.openChat(q); return !/打斷/.test(document.getElementById('chbtns').textContent) }), '閒著的人沒有打斷鍵（審查 C-1）')
  await p.evaluate(id => PO.openChat(PO.find(id)), who.id); await p.waitForTimeout(400)
  ok(await noHScroll(p), '完整對話 390 寬沒有橫捲')
  await p.click('#chcfg'); await p.waitForTimeout(400)
  ok(await p.isVisible('#card') && (await p.textContent('#c2title')).includes('設定') && await p.locator('#c2body [data-sub]').count() === 3, '⚙ 設定：智力與模式／人事／對話三頁')
  await p.click('#c2body [data-sub="hr"]'); await p.waitForTimeout(300)
  ok((await p.textContent('#c2title')).includes('人事') && (await p.textContent('#c2body')).includes('調部門'), '設定 → 人事（調部門）')
  await p.click('#c2back'); await p.waitForTimeout(300)
  ok((await p.textContent('#c2title')).includes('設定'), '人事返回到設定')
  await p.click('#c2back'); await p.waitForTimeout(400)
  ok(!(await p.isVisible('#card')) && await p.isVisible('#chat'), '設定返回回到完整對話')
  await p.click('#chback'); await p.waitForTimeout(300)
  ok(!(await p.isVisible('#chat')) && !(await p.isVisible('#card')), '× 關掉後沒有對話、沒有殘留卡片')
  // 點名牌也直接進完整對話
  await p.locator(`#v2ov .tag[data-seat="${who.seat}"]`).click(); await p.waitForTimeout(400)
  ok(await p.isVisible('#chat') && (await p.textContent('#chname')).includes('報價助理'), '點名牌直接進完整對話')
  await p.click('#chback'); await p.waitForTimeout(300)
  // 0.63.54 上線條件：手機核准沒開（本機不是 Access 的手機頁）時，允許卡寫清楚原因、不給允許鍵（示意第二位有一張卡）
  {
    const S0 = await st(p), asker = S0.people.find(x => x.approvalInfo)
    ok(typeof S0.now === 'number' && Math.abs(S0.now - Date.now()) < 60e3, 'state.json 帶伺服器時間 now（手機算倒數用）')
    ok(asker && asker.approvalInfo.options.length === 0 && /手機核准還沒開，請到電腦按/.test(asker.approvalInfo.why) && asker.caps.approve === false, '手機核准沒開：approvalInfo 不給按鈕、why 寫原因、caps.approve false')
    await p.locator(`#v2ov .seat[data-seat="${asker.seat}"]`).click(); await p.waitForTimeout(500)
    ok((await p.textContent('#chask')).includes('手機核准還沒開，請到電腦按') && await p.locator('#chask [data-ak="allow"]').count() === 0 && await p.locator('#chask [data-ak-pc]').count() === 1, '允許卡寫「手機核准還沒開，請到電腦按」、沒有允許鍵、有「到電腦上看」')
    // 0.63.56：允許卡倒數（deadline − state.now，示意卡是 now＋100 秒）；why 已寫「請到電腦按」就不再多一行「請到 … 按」
    ok(/^還有 1:[34]\d，過了交回電腦$/.test(await p.textContent('#chask .askcd') || ''), '允許卡倒數「還有 1:4x，過了交回電腦」' + JSON.stringify(await p.textContent('#chask .askcd')))
    ok(await p.locator('#chask .note').count() === 1, '允許卡沒有重複的「請到 … 按」')
    await p.click('#chback'); await p.waitForTimeout(300)
  }
  // 人物卡第一層（人事室名單還會開，第 C 項再改）：照舊
  await p.evaluate(id => PO.show(PO.find(id)), who.id); await p.waitForTimeout(400)
  ok(await p.isVisible('#card'), '人物卡第一層照舊開得起來')
  const info = await p.textContent('#info')
  ok(/正在|思考|閒著|等你|剛做完|卡住/.test(info) && !/Status|Title/.test(info), '狀態卡的狀態列是中文')
  ok(await p.isVisible('#hr [data-p="chat"]'), '狀態卡有「完整對話」')
  // 2026-11-25 員工卡兩層：三個入口；人事二級從右邊進來、「‹ 返回」回第一層，輸入框的字留著
  ok(await p.locator('#hr [data-sub]').count() === 3, '第一層有智力與模式／人事／對話三個入口')
  await p.fill('#text', '還沒送的字'); await p.click('#hr [data-sub="hr"]'); await p.waitForTimeout(300)
  ok(await p.isVisible('#c2') && !(await p.isVisible('#c1')) && (await p.textContent('#c2title')).includes('人事') && (await p.textContent('#c2body')).includes('調部門'), '人事二級（調部門）')
  await p.click('#c2back'); await p.waitForTimeout(300)
  ok(await p.isVisible('#c1') && !(await p.isVisible('#c2')) && (await p.inputValue('#text')) === '還沒送的字', '返回第一層、輸入的字還在')
  await p.fill('#text', '')
  await p.click('#close'); await p.waitForTimeout(200)
  // 人事室 → 協作桌 → 新增 6 人桌 → 點桌牌改 8 人 → 改名
  await p.click('#hrbtn'); await p.waitForTimeout(400)
  ok(await p.isVisible('#hrroom'), '標題列「人事室」開人事室')
  // 11-26 定案 C：人事室兩層。第一層一頁看完（不捲）；員工在第二層（按位置分組、可收合、搜尋；點人進完整對話）
  {
    const fit = await p.evaluate(() => { const b = document.querySelector('#hrroom .hr-body'); return b.scrollHeight <= b.clientHeight + 1 })
    ok(fit && await noHScroll(p), '人事室第一層 390×844 一頁看完、沒有橫捲')
    ok(await p.locator('#hrwait .hr-row').count() <= 3, '第一層「等你回覆」最多列 3 位')
    ok((await p.textContent('#hrroom .hr-ents')).includes('48 位在線'), '第一層「員工」入口寫在線人數')
    await p.click('#hrroom [data-l2="staff"]'); await p.waitForTimeout(400)
    ok(await p.isVisible('#hrroom .hr-l2') && !(await p.isVisible('#hrroom .hr-l1')) && (await p.textContent('#hrroom .hr-l2title')) === '員工', '進員工頁（第二層）')
    ok(await p.locator('#hrstaff .hr-row').count() === 48, '人事室員工清單 48 人')
    ok(await p.locator('#hrroom .hr-gh').count() >= 2 && (await p.textContent('#hrroom .hr-gh >> nth=-1')).includes('辦公區'), '員工按位置分組（協作桌各一組、辦公區一組）')
    const g0 = await p.locator('#hrroom .hr-grp >> nth=0 >> .hr-row').count()
    await p.locator('#hrroom .hr-gh').first().click(); await p.waitForTimeout(200)
    ok(await p.locator('#hrstaff .hr-row').count() === 48 - g0 && (await p.evaluate(() => localStorage.getItem('po-hr-fold') || '')).includes('t'), '收合一組，收合狀態存本機')
    await p.fill('#hrroom .hr-search input', '報價'); await p.waitForTimeout(200)
    ok(await p.locator('#hrroom .hr-gh').count() === 0 && await p.locator('#hrstaff .hr-row').count() > 0, '搜尋時不管收合，直接列結果')
    await p.fill('#hrroom .hr-search input', ''); await p.locator('#hrroom .hr-gh').first().click(); await p.waitForTimeout(200)
    await p.locator('#hrstaff .hr-row').first().click(); await p.waitForTimeout(500)
    ok(await p.isVisible('#chat') && !(await p.isVisible('#card')), '員工名單點人直接進完整對話')
    await p.click('#chback'); await p.waitForTimeout(400)
    await p.click('#hrroom .hr-l2back'); await p.waitForTimeout(400)
    ok(await p.isVisible('#hrroom .hr-l1'), '員工頁返回第一層')
  }
  await p.click('#hrroom [data-q="shift"]'); await p.waitForTimeout(300)
  ok((await p.textContent('#mtitle')).includes('排班'), '人事室開排班')
  // 0.62.13 整桌排班：對象多整桌、整桌才有「要做什麼」、開會改題目、每週幾
  ok(await p.locator('#swho option[value^="t:"]').count() > 0, '排班對象有「整桌」')
  ok(!(await p.isVisible('#saction')), '對象是一個人時沒有「要做什麼」')
  await p.selectOption('#swho', (await p.locator('#swho option[value^="t:"]').first().getAttribute('value')))
  await p.selectOption('#saction', 'meet'); await p.selectOption('#sdays', 'weekly'); await p.waitForTimeout(100)
  ok(await p.isVisible('#saction') && (await p.textContent('#stextlbl')) === '會議題目' && await p.isVisible('#sdow'), '整桌開會：題目、每週幾')
  await p.click('#mclose')
  await p.click('#hrroom [data-q="pay"]'); await p.waitForTimeout(300)
  ok((await p.textContent('#mtitle')).includes('薪水單'), '人事室開薪水單')
  await p.click('#mclose')
  await p.click('#hrroom [data-q="tables"]'); await p.waitForTimeout(300)
  await p.fill('#v2tname', '測試桌'); await p.click('#mbody [data-add="6"]'); await p.click('#v2add'); await p.waitForTimeout(1500) // 參考圖 C1：先選人數再按「建立」
  s = await st(p)
  const t6 = s.tables.find(t => t.name === '測試桌')
  ok(t6 && t6.size === 6, '新增 6 人「測試桌」')
  await p.click('#hrroom .hr-back'); await p.waitForTimeout(400) // 關的動畫 0.18 秒
  ok(!(await p.isVisible('#hrroom')), '人事室返回')
  await p.locator('.tplate', { hasText: '測試桌' }).click(); await p.waitForTimeout(200)
  await p.click('#mbody [data-size="8"]'); await p.waitForTimeout(1500)
  s = await st(p); ok(s.tables.find(t => t.id === t6.id).size === 8, '點桌牌改成 8 人')
  await p.locator('.tplate', { hasText: '測試桌' }).click(); await p.waitForTimeout(200)
  await p.fill('#v2tname', '改名桌'); await p.click('#v2rename'); await p.waitForTimeout(1500)
  s = await st(p); ok(s.tables.some(t => t.id === t6.id && t.name === '改名桌'), '協作桌改名')
  // 0.62.10 同桌共用筆記（示意）：桌牌選單「📒 共用筆記」有紅點數量；待你決定在最上面；📝 交代
  {
    const nt = (await st(p)).tables.find(t => t.decide > 0)
    await p.locator(`.tplate[data-table="${nt.id}"]`).click(); await p.waitForTimeout(200)
    ok((await p.textContent('#v2notes')).includes(String(nt.decide)), `📒 共用筆記按鈕有待你決定數量（${nt.decide}）`)
    ok((await p.textContent('#v2notes')).includes(`進行中的任務 ${nt.tasks} 件`), '桌牌選單顯示進行中的任務數')
    await p.click('#v2notes'); await p.waitForTimeout(600)
    const secs = await p.locator('#mbody h3.sec').allTextContents()
    ok(secs[0].startsWith('待你決定') && secs.some(x => x.startsWith('分工與進度')) && secs.some(x => x.startsWith('各人做到哪')) && secs.some(x => x.startsWith('使用者交代')) && secs.some(x => x.startsWith('主管寫的')), `共用筆記段落（${secs.join('／')}）`)
    // 0.62.11 任務卡片
    ok((await p.textContent('#mbody')).includes('（示意）報價單') && await p.locator('#mbody .v2task .v2tpart').count() >= 2 && (await p.textContent('#mbody .v2task')).includes('等前面'), '共用筆記的任務卡片（進度、每份狀態）')
    await p.fill('#v2nask', '今天先做報價'); await p.click('#v2naskgo'); await p.waitForTimeout(600)
    ok((await p.textContent('#ptoast')).includes('交代'), '📝 交代（示意）')
    await p.click('#mclose').catch(() => {})
  }
  // 0.62.9 協作桌記協作資料夾
  await p.locator(`.tplate[data-table="${t6.id}"]`).click(); await p.waitForTimeout(200)
  await p.fill('#v2tcollab', '~/.claude/pixel-office/team-v2'); await p.click('#v2tcollabgo'); await p.waitForTimeout(1500)
  s = await st(p); ok(s.tables.find(t => t.id === t6.id).collab === '~/.claude/pixel-office/team-v2', '協作桌設協作資料夾')
  // 0.62.2 同桌第一批：桌牌狀態、同桌名單、📣 傳話給這桌（示意只回報會傳給誰）、紙飛機
  const team = s.tables.find(t => t.count > 1)
  ok(team && typeof team.status === 'string' && (await p.locator(`.tplate[data-table="${team.id}"]`).textContent()).includes(team.handover ? '主管交接中' : team.status), `桌牌寫狀態「${team && (team.handover ? '主管交接中' : team.status)}」`) // 選單美術第二批：交接中的桌牌只寫「主管交接中」
  await p.locator(`.tplate[data-table="${team.id}"]`).click(); await p.waitForTimeout(300)
  ok(await p.locator('#mbody [data-who]').count() === team.count, `桌子選單列同桌 ${team.count} 位`)
  // 2026-11-25 整桌傳照片（📷）：示意只回報會傳給誰
  const tinyJpg = Buffer.from(await p.evaluate(() => { const c = document.createElement('canvas'); c.width = c.height = 8; return c.toDataURL('image/jpeg').split(',')[1] }), 'base64')
  const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.click('#v2sayph')]); await fc.setFiles({ name: 'a.jpg', mimeType: 'image/jpeg', buffer: tinyJpg })
  await p.waitForFunction(n => (document.getElementById('ptoast').textContent || '').includes(`會嘗試傳給 ${n} 位一張照片`), team.count, { timeout: 8000 }).catch(() => {})
  ok((await p.textContent('#ptoast')).includes(`會嘗試傳給 ${team.count} 位一張照片`), '📷 整桌傳照片（示意）回報會傳給誰')
  // 審查 photo ①②：照片準備中（解碼故意放慢）再按一次 → 擋下；換到別張桌子 → 這張照片取消、不送，也不拿別桌的草稿
  {
    const other = s.tables.find(t => t.id !== team.id)
    const says = []; const onReq = r => { if (r.method() === 'POST' && r.url().includes('/table-say')) says.push(r.postData() || '') }
    p.on('request', onReq)
    await p.evaluate(() => { const o = window.createImageBitmap; window.__cib = o; window.createImageBitmap = f => new Promise(r => setTimeout(() => r(o.call(window, f)), 1500)) })
    await p.locator(`.tplate[data-table="${team.id}"]`).click(); await p.waitForTimeout(300)
    await p.fill('#v2say', 'A 桌的話')
    const [fc2] = await Promise.all([p.waitForEvent('filechooser'), p.click('#v2sayph')]); await fc2.setFiles({ name: 'a.jpg', mimeType: 'image/jpeg', buffer: tinyJpg })
    await p.waitForTimeout(200)
    await p.click('#v2sayph'); await p.waitForTimeout(150)
    ok((await p.textContent('#ptoast')).includes('上一則還在送'), '📷 照片處理中再按照片：擋下（共用送出鎖）')
    await p.click('#v2saygo'); await p.waitForTimeout(150)
    ok((await p.textContent('#ptoast')).includes('上一則還在送'), '📷 照片處理中按文字送出：也擋下')
    // 選單蓋著桌牌：照手機上的順序，先關選單再點別張桌牌（用 evaluate，不等 Playwright 的可點檢查，免得等到照片已送出）
    if (other) { await p.evaluate(id => { window.PO.closeSheet(); document.querySelector(`.tplate[data-table="${id}"]`).click() }, other.id); await p.waitForTimeout(200); if (await p.$('#v2say')) await p.fill('#v2say', 'B 桌的草稿') }
    else await p.evaluate(() => window.PO.closeSheet())
    await p.waitForTimeout(2200)
    ok(says.length === 0, `📷 準備照片時換了選單：沒有送出（${says.length} 筆 /table-say）`)
    ok((await p.textContent('#ptoast')).includes('換了對象'), '📷 準備照片時換了選單：提示取消')
    if (other && await p.$('#v2say')) ok((await p.inputValue('#v2say')) === 'B 桌的草稿', '📷 取消不動新選單的草稿')
    // 複驗 ②：照片送出後（準備中）又打了新的話：送到時不關選單、新草稿留著
    await p.evaluate(id => { window.PO.closeSheet(); document.querySelector(`.tplate[data-table="${id}"]`).click() }, team.id); await p.waitForTimeout(300)
    await p.fill('#v2say', '第一句')
    const [fc3] = await Promise.all([p.waitForEvent('filechooser'), p.click('#v2sayph')]); await fc3.setFiles({ name: 'a.jpg', mimeType: 'image/jpeg', buffer: tinyJpg })
    await p.waitForTimeout(300); await p.fill('#v2say', '又打了新的話')
    await p.waitForTimeout(2500)
    ok(says.length === 1 && JSON.parse(says[0]).text === '第一句', '📷 送的是點下去當下的附話')
    ok(await p.evaluate(() => window.PO.isOn(document.getElementById('menu'))) && (await p.inputValue('#v2say')) === '又打了新的話', '📷 送到時輸入框改過：選單不關、新草稿留著')
    await p.evaluate(() => { window.createImageBitmap = window.__cib })
    p.off('request', onReq)
    await p.evaluate(() => window.PO.closeSheet()); await p.waitForTimeout(300)
  }
  await p.locator(`.tplate[data-table="${team.id}"]`).click(); await p.waitForTimeout(300)
  await p.fill('#v2say', '大家回報進度'); await p.click('#v2saygo'); await p.waitForTimeout(800)
  ok((await p.textContent('#ptoast')).includes(`會嘗試傳給 ${team.count} 位`), '📣 傳話給這桌（示意）回報會傳給誰')
  // 0.62.4 桌子聊天室（示意）：桌牌選單 → 💬 聊天室，照時間排，長訊息點了展開
  await p.locator(`.tplate[data-table="${team.id}"]`).click(); await p.waitForTimeout(300)
  await p.click('#v2chat'); await p.waitForTimeout(800)
  ok((await p.textContent('#mtitle')).includes('聊天室') && await p.locator('#mbody .v2msg').count() === 3, '聊天室列出 3 則（示意）')
  const long = p.locator('#mbody .v2msg').nth(1)
  ok(!(await long.locator('.v2full').isVisible()), '長訊息先只顯示第一行')
  await long.click(); await p.waitForTimeout(200)
  ok((await long.locator('.v2full').textContent()).includes('付款條件') && await long.locator('.v2full').isVisible(), '點了展開全文')
  await p.click('#mclose').catch(() => {})
  // 0.62.7 整桌等你回覆（示意）：桌牌選單最上面「🙋 回覆等你的人」→ 卡片（等最久在上）、按允許另列一區；回完收到下面變灰；全部回同一句要按兩次
  s = await st(p)
  const seatOf = new Map(s.people.map(x => [x.id, x.seat]))
  const waitT = s.tables.filter(t => t.team && s.people.filter(x => seatOf.get(x.id)?.startsWith(`t${t.id}.`) && x.mode === 'waiting' && !x.approval).length >= 2)
  ok(waitT.length >= 2, `示意有兩張桌子有人等你回覆（${waitT.length}）`)
  for (const [k, wt] of waitT.slice(0, 2).entries()) {
    const ats = s.people.filter(x => seatOf.get(x.id)?.startsWith(`t${wt.id}.`) && x.mode === 'waiting')
    const asks = ats.filter(x => !x.approval), perms = ats.filter(x => x.approval)
    await p.locator(`.tplate[data-table="${wt.id}"]`).click(); await p.waitForTimeout(300)
    ok((await p.textContent('#v2waitgo')).includes(`（${ats.length}）`), `桌 ${wt.id} 選單最上面「回覆等你的人（${ats.length}）」`)
    await p.click('#v2waitgo'); await p.waitForTimeout(300)
    ok(await p.locator('#mbody .v2wcard[data-id]').count() === asks.length && await p.locator('#mbody .v2wperm').count() === perms.length, `桌 ${wt.id}：${asks.length} 張回覆卡、${perms.length} 位卡在按允許`)
    if (k === 0) {
      const first = p.locator('#mbody .v2wcard[data-id]').first()
      const firstId = await first.getAttribute('data-id')
      await first.locator('.v2wq[data-q="繼續"]').click(); await p.waitForTimeout(600)
      ok((await p.textContent('#ptoast')).includes('會回給'), '快速鍵「繼續」（示意）')
      ok(await p.locator('#mbody .v2wcard.done').count() === 1 && await p.locator('#mbody .v2wcard[data-id]').last().getAttribute('data-id') === firstId, '回完的卡片收到最下面、變灰')
      ok((await p.textContent('#mbody .v2wcard.done')).includes('已回'), '標「已回」')
      for (const c of await p.locator('#mbody .v2wcard[data-id]:not(.done)').all()) { await c.locator('.v2wtext').fill('好，照做'); await c.locator('.v2wsend').click(); await p.waitForTimeout(500) }
    } else {
      await p.fill('#v2wall', '繼續，做完回報'); await p.click('#v2wallgo'); await p.waitForTimeout(200)
      ok(await p.isVisible('#v2wallsure') && (await p.textContent('#v2wallsure')).includes(`要傳給 ${asks.length} 位嗎`), '全部回同一句先確認')
      await p.click('#v2wallgo'); await p.waitForTimeout(600)
    }
    ok((await p.textContent('#mbody')).includes('這桌都回完了'), `桌 ${wt.id}：全部回完寫「這桌都回完了」`)
    await p.click('#mclose').catch(() => {})
  }
  // 0.62.12 整桌開會（示意）：開會中的桌牌、參與者泡泡；別張有主管的桌：🗣 開會 → 參與者預設全勾、用量提示、按兩次送出
  {
    const s9 = await st(p)
    const mt = s9.tables.find(t => t.meeting)
    ok(mt && (await p.locator(`.tplate[data-table="${mt.id}"]`).textContent()).includes('開會中'), '開會中的桌牌寫「開會中：題目」')
    ok(s9.people.some(x => x.meeting), '開會的人有標記（頭上泡泡）')
    const ot = s9.tables.find(t => !t.meeting && t.team && (t.members || []).length >= 3)
    await p.locator(`.tplate[data-table="${ot.id}"]`).click(); await p.waitForTimeout(300)
    await p.click('#v2meet'); await p.waitForTimeout(300)
    const n = ot.members.length
    ok((await p.textContent('#v2mcost')).includes(`${n} 位參與，會花 ${n} 份用量`), `開會預設全桌 ${n} 位、提示用量`)
    await p.locator('.v2mwho:not([disabled])').first().uncheck(); await p.waitForTimeout(100)
    ok((await p.textContent('#v2mcost')).includes(`${n - 1} 位參與`), '取消一位，用量跟著變')
    await p.fill('#v2mtopic', '本週計畫'); await p.click('#v2mgo'); await p.waitForTimeout(100)
    ok(await p.isVisible('#v2msure') && (await p.textContent('#v2msure')).includes('確定開會'), '送出前再確認一次') // 選單美術第三批：確認卡＋確定開會／取消
    await p.click('#v2mgo2'); await p.waitForTimeout(600)
    ok((await p.textContent('#ptoast')).includes('會開會'), '開會（示意）')
    // 0.63.45 設成一組：剛好一位主管的桌 → 選單一列「設成一組」→ 確認卡列三件事 → 確定（示意）
    await p.click('#mclose').catch(() => {})
    const gt = s9.tables.find(t => (t.members || []).filter(id => s9.people.find(x => x.id === id)?.role === 'manager').length === 1)
    await p.locator(`.tplate[data-table="${gt.id}"]`).click(); await p.waitForTimeout(300)
    ok((await p.textContent('#v2team')).includes('設成一組') && !(await p.locator('#v2team').isDisabled()), '一位主管的桌：選單有「設成一組」')
    await p.click('#v2team'); await p.waitForTimeout(500)
    const card = await p.textContent('#mbody')
    ok(card.includes('會做這三件事') && card.includes('登記身分') && card.includes('collab.md') && card.includes('通知'), '設成一組先出確認卡（登記、協作紀錄、通知）')
    // 審查第 9 列：協作路徑很長、沒有斷點（示意路徑故意這樣）也不能橫向溢出；390 與 320 寬都量
    const noOverflow = () => p.evaluate(() => { const m = document.querySelector('#mbody'); return document.documentElement.scrollWidth <= document.documentElement.clientWidth && [...m.querySelectorAll('.mcard')].every(c => c.scrollWidth <= c.clientWidth + 1) })
    ok(card.includes('very-long-collaboration-folder') && await noOverflow(), '確認卡長路徑 390 寬不橫向溢出')
    const vp = p.viewportSize()
    await p.setViewportSize({ width: 320, height: 568 }); await p.waitForTimeout(300)
    ok(await noOverflow(), '確認卡長路徑 320 寬不橫向溢出')
    // 測試員 BUG-5：320×568 取消／確定鍵至少 44px 高、整顆在畫面與選單裡
    const btn = await p.evaluate(() => ['#v2teamno', '#v2teamgo'].map(q => { const r = document.querySelector(q).getBoundingClientRect(), m = document.querySelector('#mbody').getBoundingClientRect(); return { h: r.height, inside: r.left >= m.left - 0.5 && r.right <= m.right + 0.5 && r.right <= window.innerWidth } }))
    ok(btn.every(b => b.h >= 44 && b.inside), `320×568 取消／確定鍵 ≥44px 高、不超出（${JSON.stringify(btn)}）`)
    await p.setViewportSize(vp); await p.waitForTimeout(300)
    await p.click('#v2teamgo'); await p.waitForTimeout(600)
    ok((await p.textContent('#ptoast')).includes('（示意）會把這桌設成一組'), '確定設成一組（示意）')
    await p.click('#mclose').catch(() => {})
  }
  let flew = false
  for (let i = 0; i < 26 && !flew; i++) { await p.waitForTimeout(1000); flew = await p.evaluate(() => window.PO_SCENE.motion.mail().planes.length > 0) }
  ok(flew, '有人傳話時手機畫紙飛機')
  // 換座位（API；示意只改示意座位表）
  const off = s.people.find(x => /^o\d+$/.test(x.seat))
  const r = await p.evaluate(([id, k]) => window.PO.post('/move', { id, seat: k }), [off.id, `t${t6.id}.0`])
  await p.waitForTimeout(1500)
  s = await st(p)
  ok(r.ok && s.people.find(x => x.id === off.id).seat === `t${t6.id}.0`, `換座位：${off.plate} 到改名桌（${r.text}）`)
  // 0.63.45：沒主管的桌不限人數都能升主管；「設成一組」變灰、提示先指定主管
  await p.locator(`.tplate[data-table="${t6.id}"]`).click(); await p.waitForTimeout(300)
  ok(await p.locator('#mbody [data-boss]').count() === 1, '1 人沒主管的桌也有「升主管」')
  ok(await p.locator('#v2team').isDisabled() && (await p.textContent('#v2team')).includes('先指定主管'), '沒主管：「設成一組」變灰、提示先指定主管')
  await p.click('#mclose').catch(() => {})
  // 0.62.3 缺主管：再拖 3 位沒主管的人到改名桌（共 4 人）→ 桌牌紅「缺主管」、選單有升主管
  for (const [i, x] of s.people.filter(x => /^o\d+$/.test(x.seat) && x.role !== 'manager').slice(0, 3).entries()) await p.evaluate(([id, k]) => window.PO.post('/move', { id, seat: k }), [x.id, `t${t6.id}.${i + 1}`])
  await p.waitForTimeout(1500)
  s = await st(p)
  ok(s.tables.find(t => t.id === t6.id).noBoss === true, '4 人沒主管的桌子標缺主管')
  ok((await p.locator(`.tplate[data-table="${t6.id}"]`).textContent()).includes('缺主管'), '桌牌寫「缺主管」')
  await p.locator(`.tplate[data-table="${t6.id}"]`).click(); await p.waitForTimeout(300)
  ok(await p.locator('#mbody [data-boss]').count() === 4, '缺主管選單每位都有「升主管」')
  await p.locator('#mbody [data-boss]').first().click(); await p.locator('#mbody [data-boss]').first().click(); await p.waitForTimeout(800)
  ok((await p.textContent('#ptoast')).includes('升主管'), '按兩次升主管（示意）')
  // 0.62.10 建議加行政：再拖 2 位到改名桌（6 人、沒有行政）→ 桌牌「建議加行政」，點了進招聘、身分預設行政
  await p.click('#mclose').catch(() => {})
  for (const [i, x] of (await st(p)).people.filter(x => /^o\d+$/.test(x.seat) && x.role !== 'manager').slice(0, 2).entries()) await p.evaluate(([id, k]) => window.PO.post('/move', { id, seat: k }), [x.id, `t${t6.id}.${i + 4}`])
  await p.waitForTimeout(1500)
  ok(await p.locator(`.tsugbtn[data-sug="${t6.id}"]`).isVisible(), '6 人沒行政：桌牌建議加行政') // 選單美術第三批：建議加行政是桌牌旁邊另一顆小標籤
  await p.locator(`.tsugbtn[data-sug="${t6.id}"]`).click(); await p.waitForTimeout(300)
  ok(await p.locator('input[name="hrole"][value="admin"]').isChecked() && (await p.textContent('#hseatnote')).includes('行政'), '點「建議加行政」進招聘、身分預設行政')
  await p.click('#mclose').catch(() => {})
  // 示意模式送指令要被擋下
  const blocked = await p.evaluate(() => window.PO.post('/command', { id: 'demo-000', text: 'x' }))
  ok(!blocked.ok, '示意模式送指令被擋下')
  ok(p.posts.every(x => x === '/move' || x === '/tables' || x === '/table-say' || x === '/table-reply' || x === '/table-note' || x === '/table-meet' || x === '/table-boss' || x === '/table-team' || x === '/helper' || x === '/helper-keep' || x === '/handover' || x === '/stuck'), `示意模式只送出換座位／協作桌／整桌傳話（示意）（${[...new Set(p.posts)].join(',')}）`)
  ok(!p.errs.length, '手機頁面沒有錯誤 ' + p.errs.join(' | '))
  if (shots) await p.screenshot({ path: `${shots}/phone-demo48.png` })
  await p.close()

  // ---------- 平板、電腦：單點最後一位開對話、沒有橫捲 ----------
  for (const [w, h, n, mobile] of [[820, 1180, 60, true], [1440, 900, 12, false]]) {
    p = await page(w, h, `/?demo=${n}`, mobile)
    if (await p.isVisible('#v2helpx')) { await p.click('#v2helpx'); await p.waitForTimeout(200) } // 示意通知列會蓋到人，先收起
    s = await st(p)
    ok(await noHScroll(p), `${w} 寬 demo=${n} 沒有橫捲`)
    const last = s.people[s.people.length - 1]
    await p.locator(`#v2ov .seat[data-seat="${last.seat}"]`).scrollIntoViewIfNeeded()
    await p.locator(`#v2ov .seat[data-seat="${last.seat}"]`).click(); await p.waitForTimeout(400)
    ok(await p.isVisible('#chat') && (await p.textContent('#chname')).includes(last.plate), `${w} 寬點最後一位「${last.plate}」直接進對話`)
    ok(await noHScroll(p), `${w} 寬完整對話沒有橫捲`)
    ok(!p.errs.length, `${w} 寬沒有錯誤 ` + p.errs.join(' | '))
    if (shots) { await p.click('#chback'); await p.waitForTimeout(200); await p.screenshot({ path: `${shots}/w${w}-demo${n}.png` }) }
    await p.close()
  }

  // ---------- 真資料：只看不送 ----------
  p = await page(390, 844, '/')
  s = await st(p)
  ok(s && s.people.length > 0, `真資料 ${s && s.people.length} 人`)
  ok(s.people.every(x => x.seat), '真資料每個人都有座位')
  ok(await noHScroll(p), '真資料 390 寬沒有橫捲')
  // 真資料可能有通知列（開完會、交接、幫手）蓋住場景：先收起（只在這頁收，不送 POST）
  if (await p.isVisible('#v2helpx')) { await p.click('#v2helpx'); await p.waitForTimeout(400) }
  const claude = s.people.find(x => !x.kind)
  if (claude) {
    await p.locator(`#v2ov .seat[data-seat="${claude.seat}"]`).click(); await p.waitForTimeout(2500)
    const n = await p.locator('#chlog .cb, #chlog .ct').count()
    ok(await p.isVisible('#chat') && !(await p.isVisible('#card')) && n > 0, `真資料點「${claude.plate}」直接進完整對話（${n} 則）`)
    await p.click('#chcfg'); await p.waitForTimeout(400)
    await p.click('#c2body [data-sub="cfg"]'); await p.waitForTimeout(300)
    ok((await p.textContent('#c2title')).includes('智力'), '真資料 ⚙ 設定進得了智力與模式')
    await p.click('#close2'); await p.waitForTimeout(300)
    await p.click('#chback'); await p.waitForTimeout(200)
  }
  const codex = s.people.find(x => x.kind === 'codex')
  if (codex) {
    await p.locator(`#v2ov .seat[data-seat="${codex.seat}"]`).click(); await p.waitForTimeout(2000)
    // 0.62.19：找得到紀錄檔就是完整對話（有它回的、工具），找不到才退回最後一則回覆
    const n = await p.locator('#chlog .cb, #chlog .ct').count()
    ok(n > 1 || (await p.textContent('#chlog')).includes('Codex 的完整對話在 Codex 那邊'), `Codex「${codex.plate}」開完整對話（${n} 則）`)
    await p.click('#chback')
  } else log.push('（沒有在線的 Codex，略過）')
  ok(p.posts.length === 0, `真資料整段沒有任何 POST（${p.posts.join(',')}）`)
  ok(!p.errs.length, '真資料沒有錯誤 ' + p.errs.join(' | '))
  if (shots) await p.screenshot({ path: `${shots}/phone-real.png` })
  await p.close()

  await b.close()
  console.log(log.join('\n'))
  if (fails.length) { console.log(fails.join('\n')); process.exitCode = 1 }
  console.log(`\n${log.length} 過、${fails.length} 沒過`)
})()
