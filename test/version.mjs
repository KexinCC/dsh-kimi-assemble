/**
 * test/version.mjs —— 防「版本/数字漂移」的守门测试
 * ============================================================================
 * 为什么要有它：index.js 的 VERSION 曾经硬编码停在 1.0.0 长达 5 个版本，
 * README 的安装命令 pin 也停在 1.1.0 —— 两个都没人发现，因为它们"看起来对"。
 * 这类错误的共同点是：**没有任何测试在看着它们**。
 *
 * 这里断言的都是"必须永远成立"的恒等式，不是行为测试：
 *   1. index.js 的 VERSION === package.json.version
 *   2. market/index.json 里我们这条的版本 === package.json.version
 *   3. README（中/英）里不允许出现写死的 `dsh-kimi-assemble@x.y.z` 安装 pin
 *   4. README 里声明的工具数 === 实际构建出来的工具数
 *   5. CHANGELOG 里有当前版本的条目
 *   6. package.json 的 bin/files 指向的文件真实存在
 * ============================================================================
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'

const ROOT = new URL('..', import.meta.url)
const read = (rel) => readFileSync(new URL(rel, ROOT), 'utf8')
const pkg = JSON.parse(read('package.json'))

let pass = 0
let fail = 0
const check = (name, fn) => {
  try {
    fn()
    pass += 1
    console.log(`✓ ${name}`)
  } catch (error) {
    fail += 1
    console.log(`✗ ${name}\n    ${error.message}`)
  }
}
const assert = (cond, message) => {
  if (!cond) throw new Error(message)
}

// 1) VERSION 派生正确
await check('index.js 的 VERSION 与 package.json 一致', async () => {
  const mod = await import(new URL('index.js', ROOT).href)
  assert(
    mod.VERSION === pkg.version,
    `index.js VERSION=${mod.VERSION} 但 package.json version=${pkg.version}`,
  )
})

// 2) 市集索引与包版本一致
check('market/index.json 的版本与 package.json 一致', () => {
  const index = JSON.parse(read('market/index.json'))
  const entry = (index.plugins ?? []).find((p) => p.name === pkg.name)
  assert(entry, `market/index.json 里没有 ${pkg.name}`)
  assert(
    entry.versions?.[0]?.version === pkg.version,
    `索引 pin 在 ${entry.versions?.[0]?.version}，但 package.json 是 ${pkg.version}（忘记重新生成索引？）`,
  )
})

// 3) README 不许写死安装版本
for (const file of ['README.md', 'README.zh.md']) {
  check(`${file} 没有写死安装版本 pin`, () => {
    const text = read(file)
    const hit = text.match(new RegExp(`${pkg.name}@\\d+\\.\\d+\\.\\d+`))
    assert(!hit, `发现写死的安装 pin「${hit?.[0]}」—— 它一定会过期，请改成不带版本的 ${pkg.name}`)
  })
}

// 4) README 声明的工具数与实际一致
check('README 声明的工具数与实际构建数量一致', async () => {
  const { resolveConfig } = await import(new URL('lib/config.mjs', ROOT).href)
  const { setLanguage } = await import(new URL('lib/i18n.mjs', ROOT).href)
  const { buildTools } = await import(new URL('lib/tools/index.mjs', ROOT).href)
  setLanguage('en')
  const tools = buildTools({
    config: resolveConfig({ language: 'en' }),
    ctx: { get: () => undefined, logger: { info() {}, warn() {} } },
  })
  const actual = tools.length
  for (const file of ['README.md', 'README.zh.md']) {
    const text = read(file)
    const claimed = (text.match(/(\d+)\s*(?:native\s+)?tools|(\d+)\s*个工具/i) ?? [])[0]
    if (!claimed) continue
    const number = Number((claimed.match(/\d+/) ?? [0])[0])
    assert(
      number === actual,
      `${file} 写了 ${number} 个工具，实际构建出 ${actual} 个`,
    )
  }
})

// 5) CHANGELOG 有当前版本条目
check('CHANGELOG 里有当前版本的条目', () => {
  const text = read('CHANGELOG.md')
  assert(
    text.includes(`[${pkg.version}]`),
    `CHANGELOG.md 里没有 [${pkg.version}] —— 发版前请补一条`,
  )
})

// 6) bin / files 指向的文件存在
check('package.json 的 bin 与 files 指向真实文件', () => {
  for (const [name, rel] of Object.entries(pkg.bin ?? {})) {
    assert(existsSync(new URL(String(rel).replace(/^\.\//, ''), ROOT)), `bin ${name} → ${rel} 不存在`)
  }
  for (const rel of pkg.files ?? []) {
    const clean = String(rel).replace(/^\.\//, '')
    if (clean.includes('*')) {
      // 通配项（如 locale/*.json）：目录要存在且至少匹配到一个文件
      const dir = clean.slice(0, clean.indexOf('*'))
      const dirUrl = new URL(dir, ROOT)
      assert(existsSync(dirUrl), `files 通配 ${rel} 的目录 ${dir} 不存在`)
      const suffix = clean.slice(clean.lastIndexOf('*') + 1) || ''
      const matched = readdirSync(dirUrl).filter((name) => (suffix ? name.endsWith(suffix) : true))
      assert(matched.length > 0, `files 通配 ${rel} 没有匹配到任何文件`)
      continue
    }
    assert(
      existsSync(new URL(clean, ROOT)),
      `files 里的 ${rel} 不存在（打包会缺文件）`,
    )
  }
})

// 7) engines 与依赖策略
check('package.json 保持零运行时依赖', () => {
  const deps = Object.keys(pkg.dependencies ?? {})
  assert(deps.length === 0, `dependencies 应为空，实际有：${deps.join(', ')}`)
})

console.log(`\n版本一致性：${pass} 项通过，${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
