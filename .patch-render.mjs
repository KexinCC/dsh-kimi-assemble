import { readFileSync, writeFileSync } from 'node:fs'

const file = 'lib/tools/browser.mjs'
let text = readFileSync(file, 'utf8')
let changed = 0

// click / act：retried 那行之后插入弹窗提示
const retriedLine = `        if (value.retried) lines.push(t('verify.staleRetried', { detail: '' }).trim())`
const withDialog = `${retriedLine}
        if (value.dialogOpen) lines.push(t('verify.dialogBlocked', { message: value.dialogMessage }))`
while (text.includes(retriedLine)) {
  text = text.replace(retriedLine, withDialog)
  changed += 1
}

// fill：在提交分支之前插入
const fillAnchor = `        if (value.submitted && value.verified) {`
if (text.includes(fillAnchor)) {
  text = text.replace(
    fillAnchor,
    `        if (value.dialogOpen) lines.push(t('verify.dialogBlocked', { message: value.dialogMessage }))
${fillAnchor}`,
  )
  changed += 1
}

writeFileSync(file, text, 'utf8')
console.log('inserted dialog render lines:', changed)
