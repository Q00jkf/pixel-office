// bun test remote/codex-win.spec.ts：codex-win/（Windows 的 Codex 外掛，0.64.6）內容釘死＋啟動器挑版本。
// Codex 的 hook 信任綁整個外掛資料夾的內容（見 codex-stub.spec.ts），所以這個資料夾一次定好就不能再改；
// 真正的程式在 codex/codex_office.py，由 po_launch_win.py 從 Claude 外掛 cache 最新版跑。.gitattributes 設 -text，各平台位元組相同
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const DIR = join(import.meta.dir, '..', 'codex-win')
const PINNED: Record<string, string> = {
  '.agents/plugins/marketplace.json': '1fa24812307d082f1830acfb16237a2f5869a0e145550b24a0b13e737707e4e2',
  '.codex-plugin/plugin.json': '164ecb1a106cc51e9ee024cbcabe84bb3e8df46128e1b8f9214675d80e3a191d',
  '.mcp.json': 'e5f3aff03051b10982e9ea3f9ea4da75468a57ec36e78a14e7001a64d7dc6b3c',
  'hooks/hooks.json': 'd663dc6f69b42214c8d4a462b75f829fb099eed1b20112b988be1395a0a42dcb',
  'po_launch_win.py': '3ea94dac0eafce10ae74bd45a3c8f6f6d21815a5222562400bae32974ac08c44',
}
const WHY = 'codex-win/ 不能改：改了使用者要重新 Trust all。要改程式請改 codex/codex_office.py'
const files = (d: string): string[] => readdirSync(d).flatMap(n => { const f = join(d, n); return statSync(f).isDirectory() ? files(f) : [relative(DIR, f).split('\\').join('/')] })

test('codex-win：檔案清單與每個檔的 sha256 釘死', () => {
  expect(files(DIR).sort(), WHY).toEqual(Object.keys(PINNED).sort())
  for (const [f, h] of Object.entries(PINNED)) expect(createHash('sha256').update(readFileSync(join(DIR, f))).digest('hex'), `${f}：${WHY}`).toBe(h)
})

test.skipIf(process.platform !== 'win32')('po_launch_win.py：跑 Claude 外掛 cache 裡最新版（照版號比，不照字母）的 codex_office.py；沒有就安靜結束', () => {
  const home = mkdtempSync(join(tmpdir(), 'po-cxwin-'))
  try {
    const root = join(home, '.claude', 'plugins', 'cache', 'pixel-office', 'pixel-office')
    for (const v of ['0.9.0', '0.10.0', '0.11.0']) mkdirSync(join(root, v, 'codex'), { recursive: true })
    for (const v of ['0.9.0', '0.10.0']) writeFileSync(join(root, v, 'codex', 'codex_office.py'), `print('ran ${v}')\n`)
    const run = () => Bun.spawnSync(['python', '-I', '-B', join(DIR, 'po_launch_win.py'), 'x'], { env: { ...process.env, USERPROFILE: home, HOME: home } })
    let r = run()
    expect(r.exitCode).toBe(0)
    expect(r.stdout.toString().trim()).toBe('ran 0.10.0') // 0.11.0 沒有 codex_office.py：跳過
    rmSync(root, { recursive: true, force: true })
    r = run()
    expect(r.exitCode).toBe(0)
    expect(r.stdout.toString().trim()).toBe('')
  } finally { rmSync(home, { recursive: true, force: true }) }
})
