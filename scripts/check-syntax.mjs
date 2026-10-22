/**
 * scripts/check-syntax.mjs —— 语法体检（跨平台，不依赖 shell 的 find/node --check 组合）
 * ============================================================================
 * 跑法：node scripts/check-syntax.mjs
 *
 * 宿主加载插件失败时，报错往往只是一行 "Unexpected token"。这个脚本把
 * 仓库里所有 .js/.mjs 逐个过一遍 node --check，并打印行号与文件，让 CI 和
 * 本地都能在装进 profile 之前发现语法错误。
 * ============================================================================
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SKIP_DIRS = new Set(['node_modules', '.git', 'market.tmp', '.tmp-profile'])

/** 递归收集 .js / .mjs 文件。 */
function collect(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.github') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      collect(full, out)
    } else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

const files = collect(ROOT).sort()
let failed = 0

for (const file of files) {
  const label = relative(ROOT, file).replaceAll('\\', '/')
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    failed += 1
    const stderr = String(error.stderr ?? error.message)
    console.error(`✗ ${label}`)
    console.error(
      stderr
        .split('\n')
        .filter((line) => line.trim() !== '')
        .slice(0, 8)
        .map((line) => `  ${line}`)
        .join('\n'),
    )
  }
}

if (failed === 0) {
  console.log(`语法检查：${files.length} 个文件全部通过`)
} else {
  console.error(`\n语法检查：${failed}/${files.length} 个文件有错误`)
  process.exitCode = 1
}

// 额外提醒：确保仓库里没有体积异常的文件被误提交（图标上限 256 KiB）
for (const file of files) {
  const size = statSync(file).size
  if (size > 512 * 1024) console.warn(`⚠ 大文件（${Math.round(size / 1024)} KiB）：${relative(ROOT, file)}`)
}
