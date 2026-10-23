/**
 * test/pack.mjs —— 校验 npm 包内容（发布前最后一道闸）
 * ============================================================================
 * 跑法：node test/pack.mjs
 *
 * 用 `npm pack --dry-run --json` 拿到真实打包清单（不写入磁盘），断言：
 *   - 运行必需的文件都在（index.js / lib / cordis.patch.yml / locale / icon）
 *   - 文档与协议文件在（README ×2 / LICENSE / CHANGELOG / SECURITY）
 *   - test/ 与 scripts/ 不在包里（省体积、避免把测试工具装给用户）
 *   - 没有混进 .tgz / node_modules / 临时 profile
 *
 * 需要 npm 在 PATH 上；没有就跳过并说明（CI 里一定有）。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')

let passed = 0
const failures = []
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log(`✓ ${name}`)
  } catch (error) {
    failures.push({ name, error })
    console.log(`✗ ${name} — ${error.message}`)
  }
}

/** 跑 npm pack --dry-run 并返回文件清单；npm 不可用时返回错误。 */
function readPackList() {
  // Windows 上 npm 是 .cmd，经 shell 执行会触发 DEP0190（参数未转义告警）并污染退出码。
  // 优先直接用 node 跑随 Node 一起安装的 npm-cli.js，完全绕开 shell；找不到再退回 .cmd。
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(ROOT, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ]
  const cli = candidates.find((path) => existsSync(path))
  const command = cli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const args = (cli ? [cli] : []).concat(['pack', '--dry-run', '--json'])

  let stdout
  try {
    stdout = execFileSync(command, args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      ...(cli ? {} : { shell: process.platform === 'win32' }),
    })
  } catch (error) {
    return { error: String(error.stderr ?? error.message).slice(0, 400) }
  }
  const parsed = JSON.parse(stdout)
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  return { files: (entry?.files ?? []).map((file) => String(file.path).replaceAll('\\', '/')), size: entry?.size ?? 0 }
}

const result = readPackList()

if (result.error) {
  console.log(`跳过：npm pack 不可用（${result.error.split('\n')[0]}）`)
  console.log('\n打包检查：跳过，0 项失败')
  process.exit(0)
}

const files = result.files
const has = (path) => files.includes(path)
const some = (pattern) => files.some((path) => pattern.test(path))

check('运行必需文件都在包里', () => {
  for (const required of ['index.js', 'package.json', 'cordis.patch.yml', 'icon.svg']) {
    assert.ok(has(required), `missing ${required}`)
  }
  for (const required of [
    'lib/i18n.mjs',
    'lib/errors.mjs',
    'lib/config.mjs',
    'lib/tool.mjs',
    'lib/webbridge.mjs',
    'lib/kimicu.mjs',
    'lib/images.mjs',
    'lib/guidance.mjs',
    'lib/skills.mjs',
    'lib/tools/index.mjs',
    'lib/tools/status.mjs',
    'lib/tools/browser.mjs',
    'lib/tools/computer.mjs',
  ]) {
    assert.ok(has(required), `missing ${required}`)
  }
})

check('locale 与 references 在包里', () => {
  assert.ok(has('locale/en.json'), 'missing locale/en.json')
  assert.ok(has('locale/zh.json'), 'missing locale/zh.json')
  for (const ref of ['references/app-quirks.md', 'references/browser-actions.md', 'references/computer-api.md', 'references/troubleshooting.md']) {
    assert.ok(has(ref), `missing ${ref}`)
  }
})

check('文档与协议文件在包里', () => {
  for (const doc of ['README.md', 'README.zh.md', 'LICENSE', 'CHANGELOG.md']) {
    assert.ok(has(doc), `missing ${doc}`)
  }
  // SECURITY.md 不在 files 里也可以，但它对可控制桌面的插件很重要；有就必须带上
  if (has('SECURITY.md')) console.log('    (SECURITY.md included)')
})

check('测试与脚本不在包里', () => {
  assert.ok(!some(/^test\//), `test files leaked: ${files.filter((f) => f.startsWith('test/')).join(', ')}`)
  assert.ok(!some(/^scripts\//), `script files leaked: ${files.filter((f) => f.startsWith('scripts/')).join(', ')}`)
  assert.ok(!some(/^market\//), 'market index should not ship in the package')
})

check('没有混进构建产物或临时文件', () => {
  const junk = files.filter(
    (path) =>
      path.includes('node_modules/') ||
      path.endsWith('.tgz') ||
      path.startsWith('.tmp-profile/') ||
      path.startsWith('tmp-profile/') ||
      /^tmp-.*\.mjs$/.test(path) ||
      path.endsWith('.log'),
  )
  assert.deepEqual(junk, [], `junk files: ${junk.join(', ')}`)
})

check('包体积合理（< 200 KiB）', () => {
  const size = result.size ?? 0
  assert.ok(size > 0, 'npm reported an empty package')
  assert.ok(size < 200 * 1024, `package is ${Math.round(size / 1024)} KiB, larger than expected`)
})

check('包里的 package.json 不再声明 private', () => {
  // npm pack 清单里没有文件内容，直接断言仓库里的清单
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.notEqual(manifest.private, true, 'package.json still has private: true')
  assert.equal(manifest.publishConfig?.access, 'public', 'publishConfig.access must be public')
})

console.log(`\n打包检查：${passed} 项通过，${failures.length} 项失败（${files.length} 个文件，${Math.round((result.size ?? 0) / 1024)} KiB）`)
if (failures.length > 0) {
  for (const { name, error } of failures) console.error(`✗ ${name}\n  ${error.stack ?? error.message}`)
  process.exitCode = 1
}
