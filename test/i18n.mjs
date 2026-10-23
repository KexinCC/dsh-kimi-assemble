/**
 * test/i18n.mjs —— 目录一致性 + 模型可见文案与语言无关
 * ============================================================================
 * 跑法：node test/i18n.mjs
 *
 * 断言四件事：
 *   1. en / zh 两个 catalog 的键集合完全相同（缺一个键就等于少一句翻译）；
 *   2. en 的值里不含 CJK 字符（否则就是「没翻译」）；
 *   3. 每条文案的占位符在两种语言里一致（否则替换时会出现 {x} 残留）；
 *   4. 工具 description 与语言无关 —— 同一个工具在 en/zh 下描述必须逐字节相同。
 * ============================================================================
 */
import assert from 'node:assert/strict'

import { catalogKeys, catalogValue, createTranslator, resolveLanguage, setLanguage, getLanguage } from '../lib/i18n.mjs'
import { resolveConfig } from '../lib/config.mjs'
import { buildTools } from '../lib/tools/index.mjs'

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

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/
const PLACEHOLDER = /\{(\w+)\}/g

/**
 * 允许在 en 文案里出现 CJK 的键：它们引用的是 Kimi 扩展/桌面端界面上的
 * **真实按钮名**（中文系统上就是这么显示的），英文用户也需要照着找。
 * 加键必须在这里写明理由；除此之外 en 里出现 CJK 一律视为漏翻译。
 */
const CJK_ALLOWED_IN_EN = new Set([
  'status.browserNotInstalled', // 引用扩展侧边栏按钮「本地 Agent 远程控制 / 去连接」
])

/** 抽出模板里的占位符名字集合。 */
function placeholders(template) {
  return new Set([...String(template).matchAll(PLACEHOLDER)].map((match) => match[1]))
}

const enKeys = new Set(catalogKeys('en'))
const zhKeys = new Set(catalogKeys('zh'))

check('catalog：en 与 zh 的键集合完全相同', () => {
  const onlyEn = [...enKeys].filter((key) => !zhKeys.has(key))
  const onlyZh = [...zhKeys].filter((key) => !enKeys.has(key))
  assert.deepEqual(onlyEn, [], `only in en: ${onlyEn.join(', ')}`)
  assert.deepEqual(onlyZh, [], `only in zh: ${onlyZh.join(', ')}`)
  assert.ok(enKeys.size > 100, `catalog looks too small: ${enKeys.size}`)
})

check('catalog：en 的值不含 CJK 字符（白名单除外，见 CJK_ALLOWED_IN_EN）', () => {
  const offenders = [...enKeys].filter(
    (key) => !CJK_ALLOWED_IN_EN.has(key) && CJK.test(String(catalogValue('en', key))),
  )
  assert.deepEqual(offenders, [], `untranslated keys: ${offenders.join(', ')}`)
  // 白名单本身不能失效：里面的键必须真的含 CJK，否则删掉它
  const stale = [...CJK_ALLOWED_IN_EN].filter((key) => !CJK.test(String(catalogValue('en', key))))
  assert.deepEqual(stale, [], `whitelist entries without CJK any more: ${stale.join(', ')}`)
})

check('catalog：每个键的占位符在两种语言里一致', () => {
  const bad = []
  for (const key of enKeys) {
    const a = [...placeholders(catalogValue('en', key))].sort().join(',')
    const b = [...placeholders(catalogValue('zh', key))].sort().join(',')
    if (a !== b) bad.push(`${key} (en: ${a} | zh: ${b})`)
  }
  assert.deepEqual(bad, [], bad.join('; '))
})

check('catalog：非空文案', () => {
  const empty = [...enKeys].filter(
    (key) => String(catalogValue('en', key)).trim() === '' || String(catalogValue('zh', key)).trim() === '',
  )
  assert.deepEqual(empty, [], `empty values: ${empty.join(', ')}`)
})

check('translator：缺失的占位符参数原样保留（便于发现漏传）', () => {
  const t = createTranslator('en')
  assert.match(t('script.stepLine', { mark: '✓' }), /\{index\}/)
})

check('translator：未知键返回键名而不是抛错', () => {
  const t = createTranslator('en')
  assert.equal(t('no.such.key'), 'no.such.key')
})

check('resolveLanguage：显式配置优先，其次是 KIMI_LANG，再次是区域', () => {
  assert.equal(resolveLanguage('zh', { LANG: 'en_US.UTF-8' }), 'zh')
  assert.equal(resolveLanguage('en', { LANG: 'zh_CN.UTF-8' }), 'en')
  assert.equal(resolveLanguage('auto', { KIMI_LANG: 'zh', LANG: 'en_US.UTF-8' }), 'zh')
  assert.equal(resolveLanguage('auto', { KIMI_LANG: 'en', LANG: 'zh_CN.UTF-8' }), 'en')
  assert.equal(resolveLanguage('auto', { LANG: 'zh_CN.UTF-8' }), 'zh')
  assert.equal(resolveLanguage('auto', { LANG: 'de_DE.UTF-8' }), 'en')
  assert.ok(['en', 'zh'].includes(resolveLanguage('auto', {})))
})

check('工具 description 与语言无关（en 与 zh 逐字节相同）', () => {
  const ctx = { get: () => undefined, logger: { warn() {}, info() {} } }
  const build = () => buildTools({ config: resolveConfig({}), ctx })

  setLanguage('en')
  const english = build().map((tool) => [tool.name, tool.description, JSON.stringify(tool.parameters)])
  setLanguage('zh')
  const chinese = build().map((tool) => [tool.name, tool.description, JSON.stringify(tool.parameters)])
  setLanguage('en')

  assert.deepEqual(
    chinese.map((row) => row[0]),
    english.map((row) => row[0]),
    'tool names changed with the language',
  )
  for (let i = 0; i < english.length; i += 1) {
    assert.equal(chinese[i][1], english[i][1], `${english[i][0]} description changed with the language`)
    assert.equal(chinese[i][2], english[i][2], `${english[i][0]} parameters changed with the language`)
  }
})

check('工具 description 里没有 CJK（模型侧统一英文）', () => {
  setLanguage('zh')
  const tools = buildTools({ config: resolveConfig({}), ctx: { get: () => undefined, logger: { warn() {}, info() {} } } })
  const offenders = tools.filter((tool) => CJK.test(tool.description)).map((tool) => tool.name)
  setLanguage('en')
  assert.deepEqual(offenders, [], `descriptions with CJK: ${offenders.join(', ')}`)
})

check('参数 description 里没有 CJK（模型侧统一英文）', () => {
  setLanguage('zh')
  const tools = buildTools({ config: resolveConfig({}), ctx: { get: () => undefined, logger: { warn() {}, info() {} } } })
  const offenders = []
  for (const tool of tools) {
    const text = JSON.stringify(tool.parameters)
    if (CJK.test(text)) offenders.push(tool.name)
  }
  setLanguage('en')
  assert.deepEqual(offenders, [], `parameter schemas with CJK: ${offenders.join(', ')}`)
})

check('setLanguage：只接受 en / zh，其余回落到 en', () => {
  setLanguage('zh')
  assert.equal(getLanguage(), 'zh')
  setLanguage('fr')
  assert.equal(getLanguage(), 'en')
  setLanguage('en')
})

console.log(`\ni18n：${passed} 项通过，${failures.length} 项失败`)
if (failures.length > 0) {
  for (const { name, error } of failures) console.error(`✗ ${name}\n  ${error.stack ?? error.message}`)
  process.exitCode = 1
}
