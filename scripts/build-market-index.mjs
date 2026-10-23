/**
 * scripts/build-market-index.mjs —— 生成插件市集索引（format 1）
 * ============================================================================
 * 跑法：node scripts/build-market-index.mjs
 *
 * 生成 market/index.json，供 DSH「发现」页的索引源使用。格式来自
 * @deepseek-ai/dsh-plugin-market-index 的 parseMarketIndex：
 *   - 顶层 format 必须是 1；
 *   - title / description 是本地化对象，**必须含 en**；
 *   - 每个 plugin 的 name 是合法 npm 包名，versions 非空；
 *   - 每个 version 需要 version(SemVer) / publishTimestamp(整数秒) / source；
 *   - engines.dsh 存在时会单独决定兼容性；
 *   - icon 可以是 data: base64（≤32 KiB 解码后），或与索引同源的相对路径。
 *
 * 图标用内联 base64：索引与仓库分开发布时不会出现相对路径失效。
 * ============================================================================
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const ICON_PATH = join(ROOT, 'icon.svg')
const INLINE_ICON_LIMIT = 32 * 1024

/** 读出图标并转成 data URL；超限就报错而不是悄悄丢掉。 */
function inlineIcon() {
  if (!existsSync(ICON_PATH)) throw new Error('icon.svg is missing')
  const bytes = readFileSync(ICON_PATH)
  if (bytes.length > INLINE_ICON_LIMIT) {
    throw new Error(`icon.svg is ${bytes.length} bytes, above the ${INLINE_ICON_LIMIT} byte inline limit`)
  }
  return `data:image/svg+xml;base64,${bytes.toString('base64')}`
}

const repoUrl = (manifest.repository?.url ?? '').replace(/^git\+/, '').replace(/\.git$/, '')

const index = {
  format: 1,
  title: {
    en: 'Kimi Local Bridges',
    zh: 'Kimi 本地桥',
  },
  description: {
    en: 'Plugins that connect the Kimi browser extension and KimiCU desktop control to DeepSeek Harness.',
    zh: '把 Kimi 浏览器扩展与 KimiCU 桌面控制接入 DeepSeek Harness 的插件。',
  },
  metadata: {
    categories: {
      tools: { title: { en: 'Tools', zh: '工具' } },
    },
    labels: {
      browser: { title: { en: 'Browser', zh: '浏览器' } },
      desktop: { title: { en: 'Desktop', zh: '桌面' } },
      windows: { title: { en: 'Windows only', zh: '仅 Windows' } },
      'real-session': { title: { en: 'Uses your real session', zh: '使用真实登录态' } },
    },
    sortKeys: {
      added: { title: { en: 'Added', zh: '加入时间' } },
    },
  },
  plugins: [
    {
      name: manifest.name,
      title: {
        en: 'Kimi Local Bridges',
        zh: 'Kimi 能力本地集成',
      },
      description: {
        en: 'REQUIRES the official Kimi browser extension first (Chrome/Edge, no Kimi account needed) and, for desktop control, the KimiCU runtime on Windows — this plugin is the bridge, not the runtime. With those present it registers native tools: kimi_browser_* drives your real logged-in browser, kimi_cu_* observes and operates Windows windows, and batch scripts run many actions in one model round.',
        zh: '需要先安装 Kimi 官方浏览器扩展（Chrome/Edge，本地调用不需要 Kimi 账号）；桌面控制还需要 Windows 上的 KimiCU 运行时 —— 本插件是桥，不带运行时。两者就绪后注册原生工具：kimi_browser_* 操作你真实登录的浏览器，kimi_cu_* 观察与操作 Windows 窗口，批量脚本一次调用跑完多步。',
      },
      icon: inlineIcon(),
      author: manifest.author,
      homepage: manifest.homepage,
      repository: {
        type: 'git',
        url: repoUrl,
      },
      metadata: {
        category: 'tools',
        keywords: ['kimi', 'webbridge', 'kimicu', 'browser', 'desktop', 'automation', 'computer-use'],
        labels: ['browser', 'desktop', 'windows', 'real-session'],
        sortKeys: { added: '2026-10-23' },
      },
      versions: [
        {
          version: manifest.version,
          publishTimestamp: Math.floor(Date.now() / 1000),
          source: { type: 'npm' },
          engines: { dsh: manifest.engines.dsh },
        },
      ],
    },
  ],
}

const outDir = join(ROOT, 'market')
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'index.json'), `${JSON.stringify(index, null, 2)}\n`, 'utf8')

console.log(`market/index.json written (${manifest.name}@${manifest.version})`)
console.log(`icon inlined: ${Buffer.from(index.plugins[0].icon.split(',')[1], 'base64').length} bytes`)
console.log('Next: node test/market.mjs')
console.log('Then publish this file (GitHub Pages, raw URL, or any static host) and add its URL as an index source.')
