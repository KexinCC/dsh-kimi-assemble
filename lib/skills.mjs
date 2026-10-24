/**
 * lib/skills.mjs —— 注册两个 runtime skill
 * ============================================================================
 * 为什么要覆盖同名 skill：
 *   - 用户级 `~/.agents/skills/kimi-webbridge` 教的是「curl POST /command」。
 *     本机实测那条路会把中文 body 打坏（PowerShell 参数编码），而模型一旦读到
 *     旧 skill 就会照着做。runtime skill 在同一个 layer 里优先于 provider 候选
 *     （rank 250 < 用户根 500），所以同名注册能顶掉它，且**不改用户文件**。
 *   - `kimi-cu` 同理：旧 skill 教的是 node-repl 的 `js` cell；现在直接是工具。
 *
 * 正文保持短：能做什么、按什么顺序做、哪些坑别踩；参数细节在 references/。
 * ============================================================================
 */
import { readFile } from 'node:fs/promises'
import { getLanguage, t } from './i18n.mjs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const WEBBRIDGE_SKILL = `---
name: kimi-webbridge
description: Drive the user's real Chrome through the Kimi browser extension. Use for any website interaction — navigate, read, click, fill, screenshot, scrape, or anything needing the user's logged-in sessions.
---

# Kimi 浏览器扩展（本地桥）

**用本插件的 \`kimi_browser_*\` 工具，不要用 curl / pwsh 调 daemon。**
daemon 在 127.0.0.1:10086，但 shell 内联 JSON 会把中文打坏（实测会变成 BOM 乱码），
而工具链在进程内发 UTF-8，没有这个问题，并且会替你做参数校验与错误诊断。

## 顺序（能一次跑完就别拆）

**连续动作优先用 \`kimi_browser_script {steps:[...]}\` 一次跑完** —— 一步一轮推理很贵。
不确定页面会变成什么样时拆成两段：先跑前半段，用最后一步 \`read\` 看结果，再跑后半段。

1. \`kimi_browser_open\` 打开页面（默认新标签，自动归入一个标签组；默认等到加载完成）。
2. \`kimi_browser_read\` 读无障碍树文本 —— 每行带 \`[ref=eNNN]\`，这就是后续点击要用的 ref。
   开头那三行是页面状态（url / readyState / 滚动 / 焦点 / 元素计数）：先看这里判断页面对不对、
   有没有输入框或 iframe，再决定动作。
3. \`kimi_browser_click\` / \`kimi_browser_fill\` 用 ref 或 CSS 选择器操作。**它们会回报
   \`changed\`**：\`true\` 说明页面真的变了（附带变了什么），\`false\` 说明派发了但什么都没发生——
   这时不要重试同一个元素，先想想是不是点错了、被遮罩挡住、或需要 trusted 事件。
4. **动作后不要立刻再 read**：需要确认变化就用 \`kimi_browser_read {mode:"diff"}\`，它只回变化的行
   （实测约为全量 4% 的字节）。要等异步渲染用 \`kimi_browser_wait {text}\`，不要自己轮询。
5. 其余动作走一等工具：\`kimi_browser_act\`（press / type / clear / select / check / uncheck /
   hover / scroll / drag / mouse_click / upload）、\`kimi_browser_eval\`（页面求值）、
   \`kimi_browser_dialog\`（原生弹窗）、\`kimi_browser_screenshot\`、\`kimi_browser_tabs\`。
   更冷门的（network / save_as_pdf / cdp / highlight）走 \`kimi_browser_script\` 的单步形态。

## 遇到弹窗

原生 \`confirm\`/\`alert\` 会**冻结整个页面 JS**。这时 click/fill/act 会回 \`dialogOpen: true\`
而不是报错 —— 立刻调 \`kimi_browser_dialog {action:"accept"}\`（或 \`dismiss\`）把它放行，
然后继续原来的动作。在这之前不要发别的命令，它们都会挂住。

## 边界

- 有些站点严格校验 \`isTrusted\`（银行、验证码），DOM 级 click/fill 不生效 ——
  \`changed:false\` 会明确告诉你，这时让用户手动操作，不要循环重试。
- iframe 内容不在主文档树里：先 \`kimi_browser_read mode=read\` 看 frames 列表，
  再 \`mode=frame\` 读；iframe 内部的元素不能直接操作。
- **按键分两种**：\`send_keys\` / \`key_type\` 不产生 DOM keydown（实测页面监听器收不到），
  所以「按回车提交表单」这种默认行为不会发生；要发**真实**按键用 \`kimi_browser_act {verb:"press", keys:"Enter", selector:"#q"}\`
  （内部走 CDP + bringToFront，能触发默认行为；组合键仍回落 send_keys，会回 realKey:false）。
  要提交表单更省事的做法是 \`fill\` 的 \`submit=true\`：点提交按钮 → requestSubmit → 真实回车 → 普通回车，并回报走的哪条路。
- 关闭标签组永远由用户发起。
`

const KIMICU_SKILL = `---
name: kimi-cu
description: Observe and operate real Windows desktop windows (screenshots, accessibility tree, mouse/keyboard) through the local KimiCU agent. Use for GUI automation outside the browser.
---

# KimiCU（Windows 桌面控制）

**用本插件的 \`kimi_cu_*\` 工具**，不要用 node-repl 的 \`js\` cell，也不要 import \`@kimi/cu\`。
工具链直接说 native 管道协议，参数校验和租约都在插件里处理好了。

## 顺序（能一次跑完就别拆）

**连续动作优先用 \`kimi_cu_script {steps:[...]}\` 一次跑完**（整段共用一个租约）。
列表之后可用 \`window:"@0"\` 引用上一步 \`windows\` 结果里的第 0 个窗口。
不确定界面会怎么变时拆成两段：先跑前半段并 \`observe\`，再跑后半段。

1. \`kimi_cu_windows\` 列窗口（id + 标题 + 应用路径）。
2. \`kimi_cu_observe\` 观察目标窗口：无障碍树每行带 \`[index]\`，另有截图、焦点元素。
   - 截图坐标是**窗口截图像素**，不是屏幕坐标，也不是 CSS 坐标。
3. \`kimi_cu_act\` 发输入：click 用 \`element_index\` 或截图 \`x/y\`（二选一）；
   type 往**当前焦点**输入（不聚焦、不清空、不提交）；key 发组合键。
4. 重要结果再 observe 一次复核 —— 输入返回成功只表示**已派发**。

## 容易错的点

- \`scroll\` 的 \`scroll_y > 0\` 是**向下**（旧 MCP 的 dy 语义相反）。
- \`click\` 的 \`element_index\` 与 \`x/y\` 不能混用。
- \`type\` 会覆盖系统剪贴板；提交要另外发 \`Enter\`。
- 索引和 ref 都会失效：导航、弹窗、列表刷新、滚动之后必须重新 observe。
- \`kimi_cu_script\` 的 steps 只接受 action/args/capture：window 要写进每一步的 args（如 {action:"click", args:{window:123, element_index:2}}），写在 step 级会被参数校验直接点名拒绝。
- 托盘隐藏的主窗口不会出现在 kimi_cu_windows 列表里：先用外部手段拿到 hwnd 并恢复显示，再按 id 观察。另外，弹出登录/扫码窗不代表会话失效，先找真正的主窗口，不要急于重新登录。
- 自绘应用（如微信 4.x 主窗口）的 a11y 树可能近乎为空：先确认窗口可见，再退化为「键盘快捷键 + 截图坐标点击 + observe 截图复核」；同一应用的子浮层（搜索浮层、内嵌网页面板）往往反而完整暴露。App 实测图谱见 references/app-quirks.md。
- 同名按钮扎堆（多个「关闭」）时先核对 rect 与 class（标题栏/窗口角位置的大概率是关闭整窗，避开），拿不准就用 Esc 或唯一命中的元素。
- 运行时会拒绝：终端窗口（cmd/PowerShell/Windows Terminal）、Win/Meta 组合键、
  锁屏/安全桌面。遇到拒绝不要换别的路径重试，直接告诉用户。

## 恢复

- \`computer_use_busy\`：另一个会话持有真实输入。停止发输入，只读观察通常仍可用，不要杀别的会话。
- 权限类失败：\`kimi_cu_script {method:"open_panel"}\` 打开面板，让用户手动升级/开管理员模式并确认 UAC，
  不要自动重试那次失败的操作。
- 连接类失败：先 \`kimi_status\`。

方法级细节（返回类型、每个方法的参数）见插件目录 \`references/computer-api.md\`。
`

const WEBBRIDGE_SKILL_EN = `---
name: kimi-webbridge
description: Drive the user's real Chrome through the Kimi browser extension. Use for any website interaction — navigate, read, click, fill, screenshot, scrape, or anything needing the user's logged-in sessions.
---

# Kimi browser extension (local bridge)

**Use this plugin's \`kimi_browser_*\` tools; do not call the daemon with curl or pwsh.**
The daemon listens on 127.0.0.1:10086, but inline JSON through a shell corrupts non-ASCII
text (measured: UTF-8 payloads arrive BOM-mangled). The tool layer sends UTF-8 in-process,
and it validates arguments and diagnoses failures for you.

## Order (batch when you can)

**Prefer one \`kimi_browser_script {steps:[...]}\` call for consecutive actions** — each model
round is expensive. When you cannot predict how the page will change, split it in two:
run the first half ending with a \`read\` step, look at the result, then run the second half.

1. \`kimi_browser_open\` opens a page (new tab by default, one tab group; it waits for load unless
   you pass \`wait_until:"none"\`).
2. \`kimi_browser_read\` returns the accessibility tree — each line carries \`[ref=eNNN]\`, which is
   the ref later clicks use. Its first lines are page state (url / readyState / scroll / focused
   element / element counts): check those before acting to see whether you are even on the right
   page and whether it has inputs or iframes.
3. \`kimi_browser_click\` / \`kimi_browser_fill\` take that ref or a CSS selector. **They report
   \`changed\`**: \`true\` means the page really moved (with a description of what changed), \`false\`
   means the dispatch happened but nothing happened on the page — then do not retry the same
   element; reconsider whether it was the right element, covered by an overlay, or needs a trusted
   event.
4. **Do not immediately re-read after an action.** To confirm a change use
   \`kimi_browser_read {mode:"diff"}\`, which returns only the changed lines (~4% of the full
   payload in measurements). To wait for async rendering use \`kimi_browser_wait {text}\` instead
   of polling by hand.
5. Everything else is a first-class tool: \`kimi_browser_act\` (press / type / clear / select /
   check / uncheck / hover / scroll / drag / mouse_click / upload), \`kimi_browser_eval\`,
   \`kimi_browser_dialog\`, \`kimi_browser_screenshot\`, \`kimi_browser_tabs\`. Rarer ones
   (network / save_as_pdf / cdp / highlight) go through the single-step form of
   \`kimi_browser_script\`.

## When a dialog opens

A native \`confirm\`/\`alert\` **freezes all page JS**. Click/fill/act then answer
\`dialogOpen: true\` instead of failing — call \`kimi_browser_dialog {action:"accept"}\` (or
\`dismiss\`) immediately, then continue. Any other command issued before that will hang.

## Limits

- Some sites strictly verify \`isTrusted\` (banking, CAPTCHA). DOM-level click/fill will not
  work there — \`changed:false\` tells you so; tell the user it needs manual input instead of
  retrying in a loop.
- iframe content is not in the main tree: read \`kimi_browser_read mode=read\` first to list
  the frames, then use \`mode=frame\`; elements inside an iframe cannot be driven directly.
- **Two kinds of key press**: \`send_keys\` / \`key_type\` do not produce DOM keydown events
  (measured: page listeners never fire), so default actions like implicit form submission never happen.
  For a **real** key event use \`kimi_browser_act {verb:"press", keys:"Enter", selector:"#q"}\` — it goes
  through CDP (with bringToFront) and does trigger default actions; chords still fall back to send_keys and
  report \`realKey:false\`. To submit a form the easy way use \`fill\` with \`submit=true\`:
  submit button → requestSubmit → real Enter → plain Enter, reporting which route worked.
- Closing a tab group is always the user's call.
`

const KIMICU_SKILL_EN = `---
name: kimi-cu
description: Observe and operate real Windows desktop windows (screenshots, accessibility tree, mouse/keyboard) through the local KimiCU agent. Use for GUI automation outside the browser.
---

# KimiCU (Windows desktop control)

**Use this plugin's \`kimi_cu_*\` tools.** Do not use the node-repl \`js\` cell and do not import
\`@kimi/cu\`. The tool layer speaks the native pipe protocol directly and handles argument
validation and input leases.

## Order (batch when you can)

**Prefer one \`kimi_cu_script {steps:[...]}\` call for consecutive actions** (the whole script
shares one lease). After a \`windows\` step, refer to the n-th listed window with
\`window:"@n"\`. When you cannot predict how the UI will change, split it in two: run the first
half ending with \`observe\`, then run the second half.

1. \`kimi_cu_windows\` lists windows (id + title + app path).
2. \`kimi_cu_observe\` observes one window: the accessibility tree has one \`[index]\` per line,
   plus a screenshot and the focused element.
   - Screenshot coordinates are **window screenshot pixels**, not screen coordinates and not
     CSS pixels.
3. \`kimi_cu_act\` sends input: click with \`element_index\` or screenshot \`x/y\` (exactly one);
   type goes to the **current focus** (it does not focus, clear or submit); key sends a chord.
4. Observe again for anything that matters — a successful input call only means **dispatched**.

## Traps

- \`scroll\` with \`scroll_y > 0\` scrolls **down** (the opposite of the old MCP \`dy\`).
- \`click\` takes \`element_index\` or \`x/y\`, never both.
- \`type\` overwrites the system clipboard; send \`Enter\` separately to submit.
- Indices and refs expire: re-observe after navigation, dialogs, list refreshes and scrolling.
- In \`kimi_cu_script\`, step objects accept only action/args/capture: the window goes inside each args (e.g. {action:"click", args:{window:123, element_index:2}}); a step-level \`window\` field is rejected by validation.
- Tray-hidden windows never appear in \`kimi_cu_windows\`: locate the hwnd externally, restore visibility, then observe by id. A stray login/QR window does not mean the session was lost — find the real main window before re-logging in.
- Custom-drawn apps (e.g. the WeChat 4.x main window) can expose a near-empty a11y tree: confirm visibility first, then fall back to keyboard shortcuts + screenshot-coordinate clicks + a verify screenshot. Child surfaces of the same app (search popovers, embedded web panels) often expose full trees. Per-app field notes: references/app-quirks.md.
- When same-named buttons cluster (multiple 关闭/Close), vet rect and class first (title-bar corner ≈ closes the whole window — avoid); prefer Escape or an unambiguous element.
- The runtime refuses terminal windows (cmd/PowerShell/Windows Terminal), Win/Meta chords and
  the lock/secure desktop. Do not route around a refusal — tell the user.

## Recovery

- \`computer_use_busy\`: another session holds real input. Stop sending input; read-only
  observation usually still works. Do not kill the other session.
- Permission failures: \`kimi_cu_script {action:"call", args:{method:"open_panel"}}\` opens the
  panel so the user can elevate or enable admin mode and confirm UAC. Do not auto-retry the
  operation that failed.
- Connection failures: call \`kimi_status\` first.

Method-level detail (return types, per-method arguments) is in this plugin's
\`references/computer-api.md\`.
`

/** 按当前语言选一篇正文。 */
function pickSkill(zh, en) {
  return getLanguage() === 'zh' ? zh : en
}

/**
 * 注册 runtime skills。
 *
 * 为什么必须挂在 **agent scope** 而不是全局：
 *   标准预设把 `skill-filesystem` 挂在 preset 层里，而 `dsh-skill` 的合并顺序是
 *   「global 层先，preset 层后覆盖」—— 全局注册的 runtime skill 会被 preset 层里
 *   扫到的同名用户级 skill 顶掉（实测：kimi-webbridge 仍然是 curl 版正文）。
 *   注册到 `agent.ctx` 上，两个 entry 就落在同一个 preset 层里，runtime 的
 *   runtimeOrder(-1) 优先于 providerOrder(0)，同名覆盖才真正生效。
 *
 * @param {import('@deepseek-ai/cordis').Context} scopeCtx 通常是 agent.ctx
 * @param {object} config
 * @returns {Array<() => void>} disposers
 */
export function registerSkills(scopeCtx, config) {
  if (!config.registerSkills) return []
  const skills = scopeCtx.get('skills')
  if (!skills) return []
  const disposers = []
  const resourceBase = { kind: 'directory', path: PLUGIN_ROOT }
  const entries = [
    {
      name: 'kimi-webbridge',
      content: pickSkill(WEBBRIDGE_SKILL, WEBBRIDGE_SKILL_EN),
      description:
        getLanguage() === 'zh'
          ? '用 kimi_browser_* 工具操作用户真实浏览器（Kimi 扩展本地桥）'
          : "Drive the user's real browser with the kimi_browser_* tools (Kimi extension local bridge).",
      whenToUse: t('skill.whenToUse.browser'),
    },
    {
      name: 'kimi-cu',
      content: pickSkill(KIMICU_SKILL, KIMICU_SKILL_EN),
      description:
        getLanguage() === 'zh'
          ? '用 kimi_cu_* 工具观察与操作 Windows 桌面（KimiCU 本地桥）'
          : 'Observe and operate the Windows desktop with the kimi_cu_* tools (KimiCU local bridge).',
      whenToUse: t('skill.whenToUse.desktop'),
    },
  ]
  for (const entry of entries) {
    try {
      disposers.push(
        skills.register({
          name: entry.name,
          description: entry.description,
          whenToUse: entry.whenToUse,
          content: entry.content,
          resourceBase,
          source: 'runtime',
        }),
      )
    } catch (error) {
      scopeCtx.logger?.warn?.(t('log.skillFailed', { name: entry.name, reason: error?.message ?? error }))
    }
  }
  return disposers
}

/**
 * 为每个 Agent 在其作用域里注册 skill，并在 Agent 销毁或插件卸载时清理。
 * 同一 Agent 重复 created（resume 等）时先释放旧注册，避免 first-wins 留下空 disposer。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} config
 * @returns {() => void} 插件级清理函数
 */
export function installSkillRegistrations(ctx, config) {
  if (!config.registerSkills) return () => {}
  const byAgent = new Map()

  const registerFor = (agent) => {
    const scopeCtx = agent?.ctx
    if (!scopeCtx) return
    const previous = byAgent.get(agent)
    if (previous) {
      for (const dispose of previous) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    }
    byAgent.set(agent, registerSkills(scopeCtx, config))
  }

  const offCreated = ctx.on('agent/created', ({ agent }) => {
    try {
      registerFor(agent)
    } catch (error) {
      ctx.logger?.warn?.(t('log.agentSkillFailed', { reason: error?.message ?? error }))
    }
  })

  const offDisposed = ctx.on('agent/disposed', ({ agent }) => {
    const disposers = byAgent.get(agent)
    if (!disposers) return
    byAgent.delete(agent)
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* ignore */
      }
    }
  })

  // 插件可能在已有会话之后才装上（HMR/新装）：对已经活着的 Agent 补一次注册，
  // 否则当前会话里 `skill kimi-webbridge` 仍然会读到旧的 curl 版正文。
  try {
    const agents = ctx.get('agents')
    for (const agent of agents?.list?.() ?? []) registerFor(agent)
  } catch (error) {
    ctx.logger?.warn?.(t('log.agentSkillFailed', { reason: error?.message ?? error }))
  }

  return () => {
    offCreated()
    offDisposed()
    for (const disposers of byAgent.values()) {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* ignore */
        }
      }
    }
    byAgent.clear()
  }
}

/** 读插件自带的参考文档（工具或测试用）。 */
export async function readReference(name) {
  const safe = String(name ?? '').replace(/[^a-z0-9-]/gi, '')
  if (!safe) throw new Error('reference 名字非法')
  return readFile(join(PLUGIN_ROOT, 'references', `${safe}.md`), 'utf8')
}
