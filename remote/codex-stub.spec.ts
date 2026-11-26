// bun test remote：codex-stub/（Codex 外掛）的內容釘死＋轉接程式的行為。
// Codex 的 hook 信任綁整個外掛資料夾的內容（2026-11-25 實測：改任何一個檔、多一個檔、改版號，五個 hook 都變 modified），
// 所以這個資料夾一次定好就不能再改；真正的程式在 codex/codex_office.py，由 po_launch.py 從上線資料夾跑。
import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'

const STUB = join(import.meta.dir, '..', 'codex-stub')
const LAUNCH = join(STUB, 'po_launch.py')
const PINNED: Record<string, string> = {
  '.agents/plugins/marketplace.json': '1fa24812307d082f1830acfb16237a2f5869a0e145550b24a0b13e737707e4e2',
  '.codex-plugin/plugin.json': 'c16899a5df1f18cd0adb24c8de40bbf20a6a682a91fcbc099b35c479357db334',
  '.mcp.json': '1304f075f09eba987c9a1ee17ed09ea551723ece57f7321b2dc6fd31e3493aea',
  'hooks/hooks.json': '2c56ceda2b79d0acedce3ed54b62743239310edbbd3177ade0316d1af6986038',
  'po_launch.py': '53f86347535ed856c68c4469989ee307510778979e971fe6fdbfc0875425f35a',
}
const WHY = 'codex-stub/ 不能改：改了使用者要重新 Trust all（Codex 的 hook 信任綁整個外掛資料夾的內容）。要改程式請改 codex/codex_office.py'

/** 用 lstat 走（不跟符號連結）：回 [相對路徑, 種類] */
function entries(dir: string): [string, string][] {
  return readdirSync(dir).flatMap(n => {
    const f = join(dir, n), st = lstatSync(f), rel = relative(STUB, f).split('\\').join('/')
    return st.isDirectory() ? entries(f) : [[rel, st.isFile() ? 'file' : st.isSymbolicLink() ? 'symlink' : 'other'] as [string, string]]
  })
}

test('codex-stub: the file list is pinned and every entry is a plain file (one more file, or a symlink, also counts as a change)', () => {
  const es = entries(STUB)
  expect(es.map(e => e[0]).sort(), WHY).toEqual(Object.keys(PINNED).sort())
  for (const [f, kind] of es) expect(`${f} ${kind}`, WHY).toBe(`${f} file`)
})

test('codex-stub: every file is byte-for-byte pinned', () => {
  for (const [f, h] of Object.entries(PINNED)) expect(`${f} ${createHash('sha256').update(readFileSync(join(STUB, f))).digest('hex')}`, WHY).toBe(`${f} ${h}`)
})

test('codex-stub: hooks and MCP both go through the pinned launcher, in isolated mode, with a fixed version path', () => {
  const py = readFileSync(LAUNCH, 'utf8')
  expect(py).toContain('pwd.getpwuid(os.getuid()).pw_dir') // 主目錄用帳號資料，不吃 HOME
  expect(py).not.toMatch(/os\.environ\.get\("HOME|expanduser/)
  const hooks = JSON.parse(readFileSync(join(STUB, 'hooks', 'hooks.json'), 'utf8')).hooks
  const cmds = Object.values(hooks).flatMap((xs: any) => xs.flatMap((x: any) => x.hooks.map((h: any) => h.command)))
  expect(cmds.length).toBe(5)
  for (const c of cmds) expect(c).toMatch(/^python -I -B "\$\{PLUGIN_ROOT\}\/po_launch\.py" hook \w+$/)
  const mcp = JSON.parse(readFileSync(join(STUB, '.mcp.json'), 'utf8')).mcpServers.pixel_office
  expect(mcp.args.slice(0, 2)).toEqual(["-I", "-B"])
  expect(mcp.args[3]).toContain("'1.0.0','po_launch.py'")
  expect(mcp.args[3]).not.toContain('glob')
})

// ---------- 行為測試（trust 審查 ①②③⑦）：用真的 python 跑 po_launch.py ----------
const python = (args: string[], env: Record<string, string> = {}) => {
  const r = Bun.spawnSync(['python3', ...args], { env: { ...process.env, ...env } as any, stdout: 'pipe', stderr: 'pipe', timeout: 20e3 })
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() }
}
/** 載入 po_launch.py 當模組（不跑 main），執行一段測試程式碼 */
const withLauncher = (code: string, env: Record<string, string> = {}) =>
  python(['-I', '-B', '-c', `import importlib.util,os,sys\nspec=importlib.util.spec_from_file_location('pl', ${JSON.stringify(LAUNCH)})\npl=importlib.util.module_from_spec(spec);spec.loader.exec_module(pl)\n${code}`], env)

test('po_launch: walks from / without following symlinks; refuses symlinked dirs or files, group/other-writable dirs or files, and world-writable ancestors like /tmp', () => {
  // 測試樹放在 repo 裡（祖先目錄都是自己的、不可他人寫）；/tmp 下的樹應該整個被拒（/tmp 是所有人可寫）
  const root = mkdtempSync(join(import.meta.dir, '..', '.po-launch-test-'))
  try {
    const rel = join(root, '.claude', 'pixel-office', 'release', 'codex')
    mkdirSync(rel, { recursive: true }); chmodSync(root, 0o755)
    writeFileSync(join(rel, 'codex_office.py'), 'print("OK-RELEASE")\n'); chmodSync(join(rel, 'codex_office.py'), 0o644)
    const tryRead = (home: string) => withLauncher(`try:\n    r=pl.read_target(${JSON.stringify(home)})\n    print('GOT' if r and r[1].startswith(b'print("OK') else 'NONE')\nexcept OSError as e:\n    print('REFUSED', e.errno)`).out.trim()
    expect(tryRead(root)).toBe('GOT')
    chmodSync(join(rel, 'codex_office.py'), 0o664); expect(tryRead(root)).toBe('NONE'); chmodSync(join(rel, 'codex_office.py'), 0o644)
    chmodSync(rel, 0o775); expect(tryRead(root)).toBe('NONE'); chmodSync(rel, 0o755)
    // 程式檔換成指到別處的符號連結
    writeFileSync(join(root, 'evil.py'), 'print("EVIL")\n')
    rmSync(join(rel, 'codex_office.py')); symlinkSync(join(root, 'evil.py'), join(rel, 'codex_office.py'))
    expect(tryRead(root)).toMatch(/^REFUSED/)
    rmSync(join(rel, 'codex_office.py')); writeFileSync(join(rel, 'codex_office.py'), 'print("OK-RELEASE")\n'); chmodSync(join(rel, 'codex_office.py'), 0o644)
    // 中間一層（release）換成符號連結
    const real = join(root, 'real-release'); mkdirSync(join(real, 'codex'), { recursive: true }); writeFileSync(join(real, 'codex', 'codex_office.py'), 'print("OK-LINKED")\n')
    rmSync(join(root, '.claude', 'pixel-office', 'release'), { recursive: true }); symlinkSync(real, join(root, '.claude', 'pixel-office', 'release'))
    expect(tryRead(root)).toMatch(/^REFUSED/)
  } finally { rmSync(root, { recursive: true, force: true }) }
  // /private/tmp（所有人可寫的祖先）下的樹：拒；macOS 的 tmpdir() 在 /var/folders，/var 是符號連結：也拒
  for (const parent of ['/private/tmp', tmpdir()]) {
    const t = mkdtempSync(join(parent, 'po-launch-'))
    try {
      mkdirSync(join(t, '.claude', 'pixel-office', 'release', 'codex'), { recursive: true })
      writeFileSync(join(t, '.claude', 'pixel-office', 'release', 'codex', 'codex_office.py'), 'print("OK")\n')
      const r = withLauncher(`try:\n    print('GOT' if pl.read_target(${JSON.stringify(t)}) else 'NONE')\nexcept OSError:\n    print('REFUSED')`).out.trim()
      expect(r === 'NONE' || r === 'REFUSED', `${parent}: ${r}`).toBe(true)
    } finally { rmSync(t, { recursive: true, force: true }) }
  }
})

test('po_launch: $HOME pointing at a fake release changes nothing (home comes from the account database)', () => {
  const fake = mkdtempSync(join(import.meta.dir, '..', '.po-home-test-'))
  try {
    mkdirSync(join(fake, '.claude', 'pixel-office', 'release', 'codex'), { recursive: true })
    writeFileSync(join(fake, '.claude', 'pixel-office', 'release', 'codex', 'codex_office.py'), 'print("FAKE-HOME-RAN")\n')
    const r = python(['-I', '-B', LAUNCH, 'install'], { HOME: fake })
    expect(r.code).toBe(0)
    expect(r.out).not.toContain('FAKE-HOME-RAN')
  } finally { rmSync(fake, { recursive: true, force: true }) }
})

test('po_launch: SystemExit, errors and a hook that runs too long all end quietly with exit 0', () => {
  const run = (src: string, argv: string, secs = 9) => withLauncher(`pl.HOOK_SECONDS=${secs}\npl.read_target=lambda h: ('/x/codex_office.py', ${JSON.stringify(src)}.encode())\nimport time;t=time.time();rc=pl.main(${argv});print('RC', rc, round(time.time()-t))`)
  expect(run('import sys; sys.exit(3)', "['hook','Stop']").out).toContain('RC 0')
  expect(run('raise ValueError("x")', "['hook','Stop']").out).toContain('RC 0')
  expect(run('print("ran", __file__)', "['install']").out).toContain('ran /x/codex_office.py')
  const slow = run('while True: pass', "['hook','Stop']", 1)
  expect(slow.out).toContain('RC 0 1') // 自己的期限（測試設 1 秒）
})

test('MCP: the command runs the fixed 1.0.0 launcher, never a newer-looking cache folder', () => {
  const ch = mkdtempSync(join(tmpdir(), 'po-mcp-'))
  try {
    const base = join(ch, 'plugins', 'cache', 'pixel-office-codex', 'pixel-office')
    for (const [v, tag] of [['1.0.0', 'FIXED'], ['9.9.9', 'NEWER']]) { mkdirSync(join(base, v), { recursive: true }); writeFileSync(join(base, v, 'po_launch.py'), `import sys\nprint("${tag}", sys.argv[1:])\n`) }
    utimesSync(join(base, '9.9.9'), new Date(), new Date(Date.now() + 3600e3))
    const args = JSON.parse(readFileSync(join(STUB, '.mcp.json'), 'utf8')).mcpServers.pixel_office.args
    const r = python(args, { CODEX_HOME: ch, HOME: '/nonexistent' })
    expect(r.out).toContain("FIXED ['mcp']")
    expect(r.out).not.toContain('NEWER')
  } finally { rmSync(ch, { recursive: true, force: true }) }
})
