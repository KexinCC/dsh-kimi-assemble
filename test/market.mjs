/**
 * test/market.mjs —— 校验 market/index.json 符合市集索引 format 1
 * ============================================================================
 * 跑法：node test/market.mjs
 *
 * 这是宿主 @deepseek-ai/dsh-plugin-market-index 里 parseMarketIndex 那几条硬规则的
 * 独立镜像（插件不能在运行时依赖那个包，所以测试里自己实现一遍）。任何一条不过，
 * 用户的「发现」页就会报 invalid-index，因此这里必须逐项断言。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const INDEX_PATH = join(ROOT, 'market', 'index.json')
const MANIFEST = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

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

// ---------------------------------------------------------------------------
// 宿主规则常量（取自 dsh-plugin-market-index 的实现）
// ---------------------------------------------------------------------------
const PACKAGE_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/
const PACKAGE_NAME_MAX_LENGTH = 214
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const LANGUAGE_ID = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/
const MAX_INLINE_ICON_BYTES = 32 * 1024
const MAX_PUBLISH_TIMESTAMP = 100_000_000_000
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/
const DATA_ICON = /^data:image\/(?:svg\+xml|png|jpeg|webp);base64,(.+)$/

/** 本地化文本：字符串，或带 en 的对象且每个键是语言 id。 */
function assertLocalized(value, label) {
  if (typeof value === 'string') return
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} must be a string or a localized object`)
  for (const [language, text] of Object.entries(value)) {
    assert.match(language, LANGUAGE_ID, `${label}.${language} is not a language id`)
    assert.equal(typeof text, 'string', `${label}.${language} must be a string`)
  }
  assert.ok(Object.hasOwn(value, 'en'), `${label} must contain en`)
}

/** SemVer 宽松比较：只需要有效性，这里用正则 + 版本段规范性检查。 */
function assertSemver(value, label) {
  assert.match(String(value), SEMVER, `${label} must be an exact SemVer version`)
}

/** 简易 range 校验：宿主用 semver.validRange，这里覆盖我们实际会写的形状。 */
function assertDshRange(value, label) {
  assert.equal(typeof value, 'string', `${label} must be a string`)
  assert.ok(!value.startsWith('workspace:'), `${label} must not be a workspace: range`)
  assert.match(
    value,
    /^(?:[<>=^~]*\s*v?\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?(?:\s+)?)+$|^\*$/,
    `${label} must look like a SemVer range, got "${value}"`,
  )
}

// ---------------------------------------------------------------------------
if (!existsSync(INDEX_PATH)) {
  console.error('market/index.json is missing; run: node scripts/build-market-index.mjs')
  process.exit(1)
}
const doc = JSON.parse(readFileSync(INDEX_PATH, 'utf8'))

check('format 是 1', () => {
  assert.equal(doc.format, 1)
})

check('title / description 是含 en 的本地化文本', () => {
  assertLocalized(doc.title, 'title')
  if (doc.description !== undefined) assertLocalized(doc.description, 'description')
})

check('metadata 的 categories / labels / sortKeys 结构正确', () => {
  const meta = doc.metadata ?? {}
  for (const [groupId, group] of [
    ['categories', meta.categories],
    ['labels', meta.labels],
    ['sortKeys', meta.sortKeys],
  ]) {
    if (group === undefined) continue
    assert.ok(group && typeof group === 'object', `metadata.${groupId} must be an object`)
    for (const [id, decl] of Object.entries(group)) {
      assert.notEqual(id, '', `metadata.${groupId} must not declare an empty id`)
      assertLocalized(decl?.title, `metadata.${groupId}.${id}.title`)
    }
  }
})

check('plugins 是非空数组且 name 唯一、合法', () => {
  assert.ok(Array.isArray(doc.plugins) && doc.plugins.length > 0)
  const seen = new Set()
  for (const [i, plugin] of doc.plugins.entries()) {
    assert.equal(typeof plugin.name, 'string', `plugins[${i}].name must be a string`)
    assert.ok(plugin.name.length <= PACKAGE_NAME_MAX_LENGTH, `plugins[${i}].name is too long`)
    assert.match(plugin.name, PACKAGE_NAME, `plugins[${i}].name is not a valid npm package name`)
    assert.ok(!seen.has(plugin.name), `plugins[${i}].name duplicates ${plugin.name}`)
    seen.add(plugin.name)
  }
})

check('本包在索引里，且显示字段齐全', () => {
  const plugin = doc.plugins.find((item) => item.name === MANIFEST.name)
  assert.ok(plugin, `${MANIFEST.name} is not listed`)
  assertLocalized(plugin.title, 'plugin.title')
  assertLocalized(plugin.description, 'plugin.description')
})

check('plugin.metadata 引用的 category / labels 都已声明', () => {
  const meta = doc.metadata ?? {}
  for (const [i, plugin] of doc.plugins.entries()) {
    const pm = plugin.metadata ?? {}
    if (pm.category !== undefined) {
      assert.ok(Object.hasOwn(meta.categories ?? {}, pm.category), `plugins[${i}].metadata.category ${pm.category} is not declared`)
    }
    for (const label of pm.labels ?? []) {
      assert.ok(Object.hasOwn(meta.labels ?? {}, label), `plugins[${i}].metadata.labels ${label} is not declared`)
    }
    for (const keyword of pm.keywords ?? []) {
      assert.equal(typeof keyword, 'string', `plugins[${i}].metadata.keywords must be strings`)
    }
  }
})

check('icon 是合法内联 data URL 且不超过 32 KiB', () => {
  for (const [i, plugin] of doc.plugins.entries()) {
    if (plugin.icon === undefined) continue
    const text = plugin.icon
    assert.ok(text.startsWith('data:'), `plugins[${i}].icon must be a data URL or https URL`)
    const payload = DATA_ICON.exec(text)?.[1]
    assert.ok(payload, `plugins[${i}].icon must be a base64 SVG/PNG/JPEG/WebP data URL`)
    assert.match(payload, BASE64, `plugins[${i}].icon payload is not base64`)
    const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
    const bytes = (payload.length / 4) * 3 - padding
    assert.ok(bytes <= MAX_INLINE_ICON_BYTES, `plugins[${i}].icon is ${bytes} bytes, above ${MAX_INLINE_ICON_BYTES}`)
  }
})

check('versions 非空、SemVer 唯一、字段完整', () => {
  for (const [i, plugin] of doc.plugins.entries()) {
    const versions = plugin.versions
    assert.ok(Array.isArray(versions) && versions.length > 0, `plugins[${i}].versions must be a non-empty array`)
    const seen = new Set()
    for (const [j, version] of versions.entries()) {
      const at = `plugins[${i}].versions[${j}]`
      assertSemver(version.version, `${at}.version`)
      assert.ok(!seen.has(version.version), `${at}.version duplicates ${version.version}`)
      seen.add(version.version)
      assert.equal(typeof version.publishTimestamp, 'number', `${at}.publishTimestamp must be a number`)
      assert.ok(Number.isInteger(version.publishTimestamp), `${at}.publishTimestamp must be an integer`)
      assert.ok(
        version.publishTimestamp >= 0 && version.publishTimestamp < MAX_PUBLISH_TIMESTAMP,
        `${at}.publishTimestamp must be Unix seconds in [0, 1e11)`,
      )
      const source = version.source
      assert.ok(source && (source.type === 'npm' || source.type === 'git'), `${at}.source.type must be npm or git`)
      if (source.type === 'git') {
        assert.match(String(source.commit), /^[0-9a-f]{40}$/, `${at}.source.commit must be a lowercase 40-hex commit`)
      }
      if (version.engines?.dsh !== undefined) assertDshRange(version.engines.dsh, `${at}.engines.dsh`)
    }
  }
})

check('索引里的版本与 package.json 一致（防止忘记重新生成）', () => {
  const plugin = doc.plugins.find((item) => item.name === MANIFEST.name)
  const versions = plugin.versions.map((item) => item.version)
  assert.ok(
    versions.includes(MANIFEST.version),
    `index lists ${versions.join(', ')} but package.json is ${MANIFEST.version}; re-run node scripts/build-market-index.mjs`,
  )
  const entry = plugin.versions.find((item) => item.version === MANIFEST.version)
  if (MANIFEST.engines?.dsh && entry.engines?.dsh) {
    assert.equal(entry.engines.dsh, MANIFEST.engines.dsh, 'engines.dsh drifted from package.json')
  }
})

// ---------------------------------------------------------------------------
console.log(`\n市集索引：${passed} 项通过，${failures.length} 项失败`)
if (failures.length > 0) {
  for (const { name, error } of failures) console.error(`✗ ${name}\n  ${error.stack ?? error.message}`)
  process.exitCode = 1
}
