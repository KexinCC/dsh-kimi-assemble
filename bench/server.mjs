/**
 * bench/server.mjs —— 受控实验台：静态 fixture + oracle
 * ============================================================================
 * 为什么需要它：
 *   「任务成功了吗」不能问模型，也不能只看工具返回值 —— el.click() 派发成功但页面
 *   没动的静默失败，恰恰是本次要消灭的对象。所以每个任务都配一个**机器可判定的
 *   终态**：要么服务端记录到某个请求（导航类），要么页面里出现某个标记（渲染类）。
 *
 * 跑法：node bench/server.mjs   （打印 http://127.0.0.1:<port>/ 后常驻）
 * 由 bench/run.mjs 自动起停，一般不单独跑。
 * ============================================================================
 */
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, extname, join, normalize } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(HERE, 'fixtures')

/** 页面渲染模板：统一外壳，避免各 fixture 各写一套。 */
function page(title, body, script = '') {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;margin:24px;max-width:60rem}
button{font-size:15px;padding:6px 12px;margin:4px 8px 4px 0}
.row{padding:4px 8px;border-bottom:1px solid #eee}
.pad{color:#888;font-size:13px}</style></head>
<body><h1>${title}</h1>${body}${script ? `<script>${script}</script>` : ''}</body></html>`
}

/** 撑大 aria 树用的填充文本（模拟真实长页面）。 */
function padding(rows = 40) {
  let html = '<div class="pad">'
  for (let i = 0; i < rows; i += 1) html += `<p>Filler paragraph ${i + 1}: unrelated body copy that inflates the accessibility tree.</p>`
  return `${html}</div>`
}

const ROUTES = {
  '/': () => page('Fixture index', `<ul>
    <li><a href="/click-nav.html">click-nav — button navigates</a></li>
    <li><a href="/silent.html">silent — click does nothing</a></li>
    <li><a href="/slow.html">slow — content renders after 1.2s</a></li>
    <li><a href="/list.html">list — 60 rows, click row 42</a></li>
    <li><a href="/form.html">form — Enter swallowed by suggestions</a></li>
    <li><a href="/form-suggest.html">form-suggest — first Enter only picks a suggestion</a></li>
    <li><a href="/form-button-only.html">form-button-only — Enter does nothing</a></li>
    <li><a href="/dialog.html">dialog — confirm() blocks JS</a></li>
  </ul>`),

  // 1. 正常导航：点 #go 跳到 /done.html
  '/click-nav.html': () =>
    page(
      'click-nav',
      '<p>Press the only button.</p><button id="go">Continue</button>',
      `document.getElementById('go').addEventListener('click', () => { location.href = '/done.html' })`,
    ),

  // 2. 静默失败：点击有 handler，但页面什么都不变
  '/silent.html': () =>
    page(
      'silent',
      '<p>This page has a button that reports success but changes nothing.</p><button id="noop">Save</button>',
      `document.getElementById('noop').addEventListener('click', () => { /* intentionally does nothing */ })`,
    ),

  // 3. 慢渲染：1.2 秒后出现标记
  '/slow.html': () =>
    page(
      'slow',
      '<p>Waiting for data…</p><div id="slot">loading</div>',
      `setTimeout(() => { document.getElementById('slot').textContent = 'LATE_OK' }, 1200)`,
    ),

  // 4. 长列表：60 行，点第 42 行跳转
  '/list.html': () =>
    page(
      'list',
      `<p>Click row 42.</p>${Array.from({ length: 60 }, (_, i) => {
        const n = i + 1
        return `<div class="row"><button id="row-${n}" onclick="location.href='/row.html?n=${n}'">Row ${n}</button> row item ${n} label</div>`
      }).join('')}${padding(30)}`,
    ),

  // 5. 表单：Enter 被联想列表吞掉，只有点 #submit 才真正提交
  '/form.html': () =>
    page(
      'form',
      `<p>Type a query and submit.</p>
       <form id="f"><input id="q" name="q" placeholder="Search" autocomplete="off"><button id="submit" type="submit">Search now</button></form>
       <div id="sug" hidden>suggestions</div>`,
      `const q = document.getElementById('q')
       q.addEventListener('input', () => { document.getElementById('sug').hidden = q.value.length === 0 })
       q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); document.getElementById('sug').hidden = false } })
       document.getElementById('f').addEventListener('submit', (e) => { e.preventDefault(); location.href = '/form-done.html' })`,
    ),

  // 6. 原生弹窗：confirm 冻结页面 JS，接受后跳转
  '/dialog.html': () =>
    page(
      'dialog',
      '<p>Press the button; the page asks for confirmation.</p><button id="confirm">Delete item</button>',
      `document.getElementById('confirm').addEventListener('click', () => { if (window.confirm('Delete this item?')) location.href = '/dialog-done.html' })`,
    ),

  // 7. 联想下拉吞回车：第一次回车只是选中建议，页面不动；Esc 关掉下拉后再回车才提交
  '/form-suggest.html': () =>
    page(
      'form-suggest',
      `<p>Type a query; suggestions pop up and the first Enter only picks one.</p>
       <form id="f2"><input id="q2" name="q2" placeholder="Search" autocomplete="off"><button id="go2" type="submit">Go</button></form>
       <ul id="sug2" hidden><li>suggestion-a</li><li>suggestion-b</li></ul>`,
      `const q = document.getElementById("q2")
       const sug = document.getElementById("sug2")
       let open = false
       q.addEventListener("input", () => { open = q.value.length > 0; sug.hidden = !open })
       q.addEventListener("keydown", (e) => {
         if (e.key !== "Enter") return
         if (open) { e.preventDefault(); open = false; sug.hidden = true; return }  // 吞掉回车，只关下拉
       })
       document.getElementById("f2").addEventListener("submit", (e) => { e.preventDefault(); location.href = "/form-suggest-done.html" })`,
    ),

  // 8. 回车完全无效：只有点提交按钮才提交
  '/form-button-only.html': () =>
    page(
      'form-button-only',
      `<p>Enter does nothing here; only the button submits.</p>
       <form id="f3"><input id="q3" name="q3" placeholder="Value"><button id="go3" type="submit">Commit</button></form>`,
      `document.getElementById("q3").addEventListener("keydown", (e) => { if (e.key === "Enter") e.preventDefault() })
       document.getElementById("f3").addEventListener("submit", (e) => { e.preventDefault(); location.href = "/form-button-only-done.html" })`,
    ),

  // 9. 对照：回车就能提交的正常表单
  '/form-plain.html': () =>
    page(
      'form-plain',
      `<p>Enter submits normally here.</p>
       <form id="f4"><input id="q4" name="q4" placeholder="Value"><button id="go4" type="submit">Send</button></form>`,
      `document.getElementById("f4").addEventListener("submit", (e) => { e.preventDefault(); location.href = "/form-plain-done.html" })`,
    ),

  '/form-plain-done.html': () => page('form-plain done', '<p id="mark">PLAIN_OK</p>'),
  '/form-suggest-done.html': () => page('form-suggest done', '<p id="mark">SUGGEST_OK</p>'),
  '/form-button-only-done.html': () => page('form-button-only done', '<p id="mark">BUTTON_OK</p>'),
  '/done.html': () => page('click-nav done', '<p id="mark">NAV_OK</p>'),
  '/row.html': () => page('row done', '<p id="mark">ROW_OK</p>'),
  '/form-done.html': () => page('form done', '<p id="mark">FORM_OK</p>'),
  '/dialog-done.html': () => page('dialog done', '<p id="mark">DIALOG_OK</p>'),
  // 同源 iframe + 自绘下拉 + window.open —— 模拟「门户套 OA」这类真实系统
  '/portal.html': () =>
    page(
      'portal',
      [
        '<div id="top">top level</div>',
        '<iframe id="f1" src="/oa-inner.html" style="margin-top:86px;width:700px;height:420px;border:1px solid #ccc"></iframe>',
        '<div id="sso" style="display:inline-block;padding:8px 12px;background:#0a7;color:#fff" onclick="window.__openCount=(window.__openCount||0)+1; window.open(\'/done.html\', \'_blank\')">SSO</div>',
      ].join(""),
    ),
  '/oa-inner.html': () =>
    page(
      'oa inner',
      [
        '<button id="oa-btn" onclick="document.getElementById(\'mark\').textContent=\'INNER_CLICKED\'">OA 提交</button>',
        '<div id="mark">idle</div>',
        // Element-UI 风格：不是 <select>，而是 div 触发器 + 浮层选项，JS click 无效
        '<div id="el-select" style="margin-top:8px;border:1px solid #999;padding:4px;width:180px">请选择<span class="val"></span><div class="opts" style="display:none;border:1px solid #333;background:#fff">',
        '  <div class="opt" data-v="A">选项A</div><div class="opt" data-v="B">选项B</div>',
        '</div></div>',
        // 只有真实鼠标事件才会被这个监听器接受
        '<script>window.__needRealMouse = true; document.getElementById("el-select").addEventListener("mousedown", function () { window.__realMouse = (window.__realMouse || 0) + 1; this.querySelector(".opts").style.display = "block"; });',
        'document.querySelectorAll("#el-select .opt").forEach(function(el){ el.addEventListener("click", function(){ document.querySelector("#el-select .val").textContent = el.dataset.v }) });</script>',
      ].join(""),
    ),
  '/portal-done.html': () => page('portal done', '<p id="mark">PORTAL_OK</p>'),
}

/**
 * 起服务。
 * @returns {Promise<{url: string, hits: string[], close: () => Promise<void>}>}
 */
export async function startServer(port = 0) {
  const hits = []
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    // 每次请求都记进 oracle（fixture 自己的静态资源也会命中，只关心 .html）
    if (path.endsWith('.html') || path === '/') hits.push(path)

    const route = ROUTES[path]
    if (route) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(route())
      return
    }
    // 兜底：允许直接读 fixtures 目录里的静态文件
    const safe = normalize(join(FIXTURES, path.replace(/^\/+/, '')))
    if (safe.startsWith(FIXTURES)) {
      readFile(safe)
        .then((buf) => {
          const type = extname(safe) === '.js' ? 'text/javascript' : extname(safe) === '.css' ? 'text/css' : 'text/plain'
          res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' })
          res.end(buf)
        })
        .catch(() => {
          res.writeHead(404, { 'Content-Type': 'text/plain' })
          res.end('not found')
        })
      return
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' })
    res.end('not found')
  })

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve))
  const actual = server.address()
  const url = `http://127.0.0.1:${actual.port}`

  return {
    url,
    /** oracle：哪些页面被请求过 */
    hits,
    resetHits: () => {
      hits.length = 0
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.()
        server.close(resolve)
      }),
  }
}

// 独立运行时常驻，方便手工验证 fixture
if (process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1])) {
  const server = await startServer(Number(process.env.BENCH_PORT ?? 0))
  console.log(`fixtures: ${server.url}/`)
  console.log('Ctrl+C to stop.')
}
