# dsh-kimi-assemble

把两条跑在本机的 Kimi 能力接成 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
的**原生工具**：

| 能力 | 后端 | 工具 |
|---|---|---|
| 操作用户**真实、已登录**的浏览器 | Kimi 浏览器扩展 daemon（WebBridge，`127.0.0.1:10086`） | `kimi_browser_*` |
| 观察与操作**真实 Windows 窗口** | KimiCU native Agent（`\\.\pipe\kimi-cu-win-<user>`） | `kimi_cu_*` |
| 诊断两者 | — | `kimi_status` |

装上之后，模型不需要读 skill、不需要 `curl`、不需要 node-repl 的 `js` cell —— 直接调工具。
UTF-8 全程无损，参数错误会点到字段，连接类失败会给出下一步。

[English](README.md)

---

## 安装

### 先读这个：你得先有什么

本插件是**桥**，不是自带实现。它驱动的是装在你机器上的两个 Kimi 组件；缺了它们，每个
工具调用都会回 `KIMI_WEBRIDGE_DOWN` / `KIMI_CU_NOT_INSTALLED` —— 并附安装指引（插件自己
绝不下载并执行远程安装器，这是安全底线）。

| 你想要… | 你需要 | 怎么装 |
|---|---|---|
| 浏览器控制 | Chrome 或 Edge + **Kimi 浏览器扩展**。本地 Agent 这条路**不需要 Kimi 账号**（只有侧边栏需要）。 | 1) 在 Chrome Web Store / Edge Add-ons 装 “Kimi” 扩展（或[官网手动安装](https://www.kimi.com/products/kimi-browser-extension)）；2) 打开扩展侧边栏 → 设置 → 「本地 Agent 远程控制」→ 点**「去连接」**；3) 把弹窗里给出的安装命令复制到终端执行 —— 这一步会把本地服务装到 `~/.kimi-webbridge`。[常见问题](https://www.kimi.com/help/kimi-webbridge/kimi-webbridge-faq) |
| 桌面控制 | Windows + **KimiCU 运行时**（`kimi-cu.exe`） | 在终端下载并运行 [setup_windows.cmd](https://cdn.kimi.com/kimi-computer-use-windows/latest/setup_windows.cmd)，或在配置里用 `kimicuExePath` 指定已有的 exe |
| 两者任一 | DeepSeek Harness `>= 0.2.0`（已在 `0.2.1-rc.2` 上验证），Node `>= 22` | — |

只想要浏览器能力？设 `kimicuEnabled: false`，五个 `kimi_cu_*` 工具就不会注册（任何系统都一样）。

新机器上跑一次 `kimi_status`，两条桥都报“已安装”就绪；之后插件的发现、启动、重连全部自动
（包括清掉非正常关机残留的 daemon pid 文件）。

```text
plugin_manager install_bundle  target=dsh-kimi-assemble@1.0.0
```

装好后 `cordis_inspect_query(Tool.listTools)` 应出现 13 个 `kimi_*` 工具。

**想用市集索引？** 在「发现 → 索引源」里填下面这个地址，就能直接搜索并安装：

```text
https://dsh-community.github.io/dsh-kimi-assemble/index.json
```

**从旧的 KimiCU MCP 过来？** 建议把那一行停用。它暴露
`mcp__kimicu__js` / `js_reset` / `js_add_node_module_dir`，而本插件已覆盖全部 16 个 KimiCU
方法；留着只会多一条抢真实桌面输入的通路：

```yaml
# 在 <profile>/cordis.patch.yml 里给已有的 mcp-kimicu 行加：
- id: mcp-kimicu
  name: "@deepseek-ai/dsh-mcp-client"
  config: { ... }          # 保持原有 config 不变
  disabled: true
```

## 配置

`config` 是**整段替换**（loader 语义，不是深合并）。只写想改的键，其余走默认值。

| 键 | 默认 | 说明 |
|---|---|---|
| `webbridgeEnabled` | `true` | 关掉就不注册浏览器工具 |
| `webbridgeAddr` | `''` | 空 = 读 `~/.kimi-webbridge/daemon.addr`，再退 `127.0.0.1:10086` |
| `webbridgeAutoStart` | `true` | 连不上时幂等启动 daemon |
| `webbridgeTimeoutMs` | `60000` | 单次浏览器动作超时 |
| `browserGroupTitle` | `DSH` | 标签组默认标题（用户浏览器里可见） |
| `browserReadMaxChars` | `20000` | `kimi_browser_read` 默认预算 |
| `kimicuEnabled` | `true` | 关掉就不注册桌面工具 |
| `kimicuExePath` | `''` | 空 = `KIMI_CU_WINDOWS_EXE` → `KIMI_CU_WINDOWS_HOME` → `%LOCALAPPDATA%\Kimi Computer Use\kimi-cu.exe` → 旧 `KimiCU` 目录 |
| `kimicuAutoStart` | `true` | 连不上时幂等启动 Agent |
| `kimicuTimeoutMs` | `120000` | 单次桌面调用超时 |
| `cuMaxTreeChars` | `12000` | 无障碍树默认截断 |
| `promptSection` | `true` | 是否贡献系统提示段 |
| `registerSkills` | `true` | 是否注册 `kimi-webbridge` / `kimi-cu` 两个 runtime skill（同名覆盖旧的 curl/js 版） |
| `language` | `"auto"` | `auto` → 系统区域是 `zh*` 时中文、否则英文；`en` / `zh` 强制 |
| `disabledTools` | `[]` | 按名字下线个别工具（如 `["kimi_cu_launch"]`） |

工具**描述**恒为英文 —— 它属于模型可见的工具目录。`language` 控制**人**看到的文本：错误信息、
工具输出、提示段、skill 正文。

---

## 工具

### 诊断

- **`kimi_status {deep?}`** —— 两条桥的实况（daemon 地址/版本/扩展连接态，CU
  exe/版本/agent pid/pipe/权限），外加 `hints[]` 里可直接执行的下一步。
  **任何连接类失败后的第一站。**

### 浏览器

- **`kimi_browser_open {url, new_tab=true, group_title?, session?}`** → 最终 URL / 标题 / tabId
- **`kimi_browser_read {mode=read|find|frame, query?, frame?, ref?, max_chars?, cursor?}`** →
  无障碍树文本（带 `[ref=eNNN]`）/ 搜索命中 / iframe 文本
- **`kimi_browser_click {selector, session?}`** —— CSS 或 `@eNNN` / `eNNN` / `[ref=eNNN]`
- **`kimi_browser_fill {selector, value, submit=false, session?}`**
- **`kimi_browser_screenshot {selector?, full_page=false, format=png|jpeg, quality?, session?}`** →
  图片块（模型路由不支持图片时给路径）
- **`kimi_browser_tabs {action=list|list_all|attach|close|close_session, tab_id?}`**
- **`kimi_browser_script`** —— **两种形态**：
  - 单步（逃生口）：`{action, args, session?}`，覆盖全部 35 个 daemon action
    （wait / scroll / evaluate / network / upload / pdf / dialog …）
  - 批量：`{steps:[{action,args,capture?}], stop_on_error?, max_result_chars?}` —— 一次调用 1–25 步
  - 参数表：[`references/browser-actions.md`](references/browser-actions.md)

### 桌面

- **`kimi_cu_windows {filter?, limit?}`** → `[{id, title, app}]`
- **`kimi_cu_observe {window, screenshot=true, text=true, filter?, max_chars?}`** →
  无障碍树（带 `[index]`）+ 焦点 + 截图图片块 + `coordinate_space`
- **`kimi_cu_act {action, window, ...}`** —— `click`（`element_index` **或** `x/y`）、`type`、
  `key`、`scroll`（**`scroll_y > 0` 向下**）、`set_value`、`drag`、`drag_path`、`secondary`、
  `activate`
- **`kimi_cu_launch {app}`**
- **`kimi_cu_script`** —— **两种形态**：
  - 单步：`{action, window, ...}`，或 `{action:"call", args:{method,args}}` 打任意 16 个
    KimiCU 方法（`open_panel`、`list_apps`…）
  - 批量：`{steps:[...], stop_on_error?, settle_ms?, max_result_chars?}` —— 1–30 步**共用一个输入
    租约**；步动作 = 上面 9 个输入动作 + `windows` / `observe` / `launch` / `wait_window` /
    `sleep` / `call`；后续步骤可用 `window:"@n"` 引用上一步 `windows` 结果里的第 n 个窗口
  - 参数表：[`references/computer-api.md`](references/computer-api.md)

---

## 性能：插件很快，轮次才是成本

`node test/bench.mjs` 在开发机上的实测：

| 层 | 实测 | 含义 |
|---|---|---|
| HTTP 健康检查 / status（命中缓存） | **0.0–2.1 ms** | 插件自身开销 |
| HTTP `snapshot` / `list_tabs` / `evaluate` | **4–10 ms** | 插件自身开销 |
| CU `ping` / `list_windows` / `get_window` | **0.5–2.7 ms** | 插件自身开销 |
| CU 租约 begin+end | **0.3 ms** | 可忽略 |
| 浏览器 `navigate` | ~206 ms | 页面加载，daemon 的活 |
| 浏览器 `screenshot` | ~144 ms | Chrome 抓图 |
| CU `get_window_state` 纯文本 | ~82 ms | UIA 树遍历 |
| CU `get_window_state` 带截图 | ~217 ms | UIA + WGC 抓图 |
| **模型一轮推理** | **秒级** | 真正的成本 |

本地执行 0.5–220 ms，模型一轮是秒级。所以优化方向是**一次调用干更多步**，不是抠传输。
批量脚本就是为这个加的：一次工具调用 = 一次模型轮次，过去要 6 轮的 6 步浏览器动作，现在
在**一次 0.6 秒的调用**里跑完。

---

## 为什么「不出差错」

1. **不走 shell。** 浏览器请求在 Host 进程内用 `node:http` + UTF-8 Buffer。Windows 下通过 shell
   内联 JSON 会打坏非 ASCII 文本（实测 daemon 回 `invalid JSON`）—— 那条路已移除。
2. **先校验再碰运行时。** 动作参数在启动任何 Agent 之前编译成请求
   （`planAction` / `preflightSteps`）；互斥字段、枚举越界、未知字段都报 `KIMI_ARGS` 并点名
   到字段（脚本里还会说第几步）。
3. **不猜窗口。** `window` 接受 id、精确标题、子串或 `@n`；0 命中或多命中都报错并列候选，
   绝不默默取第一个。
4. **租约隔离。** 每次桌面调用是一个租约（`begin` → N 次调用 → `end`，`finally` 保证释放），
   进程内全局串行，两条输入流不会互相打断；`begin`/`end` 必须同连接、同 session、同 nonce
   （错配会失败）。批量脚本整段共用一个租约。
5. **派发 ≠ 生效。** 所有输入类工具返回 `dispatched:true`，并要求用 `kimi_cu_observe` 复核。
6. **六类连接故障、六个错误码、六个下一步**（见
   [`references/troubleshooting.md`](references/troubleshooting.md)）。版本过旧不会被「绕过」，
   权限类失败不会被自动重试。
7. **截图降级安全。** 只有当前模型路由声明支持图片时才产生图片块；任何附件失败都降级成文本
   + 本地路径。批量脚本里某一步观察失败只影响那一步。
8. **不动共享资源。** 卸载只关插件自己的 socket —— 不 stop / restart / upgrade / remove daemon，
   也不杀桌面 Agent。

---

## 推荐用法：少花轮次

一次调用能干完的，就别拆：

```js
// 浏览器：打开 → 读 → 填 → 点 → 等 → 读  （1 次调用 = 1 轮推理）
kimi_browser_script({ session: "task-a", steps: [
  { action: "navigate", args: { url: "https://example.com/form" } },
  { action: "read",     args: { max_chars: 1500 } },
  { action: "fill",     args: { selector: "#name", value: "张三" } },
  { action: "click",    args: { selector: "#submit" } },
  { action: "wait",     args: { selector: "#result" } },
  { action: "read",     args: { max_chars: 800 } },
]})

// 桌面：列表 → 观察 → 点 → 观察  （1 次调用，共用 1 个租约）
kimi_cu_script({ steps: [
  { action: "windows", args: { filter: "计算器" } },
  { action: "observe", args: { window: "@0", max_chars: 1200 } },
  { action: "click",   args: { window: "@0", element_index: 12 } },
  { action: "observe", args: { window: "@0", max_chars: 800 } },
]})
```

不确定页面或界面会变成什么样时，拆成两段：先跑前半段并以 `read` / `observe` 结尾，看到结果
再跑后半段。

## 回滚

```text
plugin_manager remove_bundle  target=dsh-kimi-assemble
# 想把旧 MCP 要回来，再把 mcp-kimicu 那行的 disabled: true 去掉
```

daemon 与桌面 Agent 不受影响。

---

## 自检

```bash
node scripts/check-syntax.mjs   # 所有 .js/.mjs 语法
node test/unit.mjs              # 离线：帧编解码、参数校验、preflight、schema 子集、工具清单
node test/faults.mjs            # 死端口、端口被占、扩展未连、运行时过旧、窗口多义
node test/i18n.mjs              # 目录对齐、en 里没有未翻译中文、工具文案与语言无关
node test/market.mjs            # market/index.json 符合 format 1
node test/pack.mjs              # npm 包内容正确且不多带文件

# 只有真机（需要两条桥在跑）
node test/live.mjs              # 协议层连通性，只读
node test/integration.mjs       # 工具层，含批量脚本
node test/bench.mjs             # 延迟拆解
```

离线套件在两种语言下都跑一遍：

```bash
KIMI_LANG=en node test/unit.mjs
KIMI_LANG=zh node test/unit.mjs
```

宿主内验收（2026-10-23）：13 个 `kimi_*` 工具可见；`kimi_cu_observe` 的截图以图片块回到对话；
`kimi_browser_open/read/screenshot` 中文无损往返；6 步批量脚本 0.6 秒跑完；
`kimi-cu` / `kimi-webbridge` 两个 runtime skill 已顶掉旧的 curl/js 版。

## 目录

```
index.js              apply(ctx, config)
lib/
  i18n.mjs            en/zh 目录 + 语言判定（零 IO、零依赖）
  config.mjs          默认值 + 手写校验（不依赖 schemastery）
  errors.mjs          KIMI_* 错误码
  tool.mjs            轻量 defineTool（JSON Schema 子集校验 + 渲染）
  webbridge.mjs       daemon 客户端（自动启动、端口发现、UTF-8）
  kimicu.mjs          管道客户端（帧编解码、租约、自动拉起、窗口解析）
  images.mjs          data URL / 文件 → 附件图片块（带模型能力闸门）
  guidance.mjs        系统提示段
  skills.mjs          两个 runtime skill（挂在 agent scope，同名覆盖 curl/js 版）
  tools/              status / browser（含批量脚本）/ computer（含批量脚本）
references/           动作表、方法表、故障对照
scripts/              语法检查、市集索引生成
market/index.json     生成的市集索引（不随包发布）
test/                 unit / faults / i18n / market / pack / live / integration / bench
```

## 已知限制

- **桌面部分只有 Windows**。浏览器部分在 macOS/Linux 也能跑，daemon 路径按 `~` 解析。
- v1 没有设置面板；配置写在 `cordis.patch.yml` 里。
- 插件不会自己关用户的标签页；`close_session` 只在被要求时用。
- 严格校验 `isTrusted` 的站点（银行、验证码）无法用合成事件驱动，会明确失败而不是假装成功。
- iframe 内部不能直接操作（daemon 限制），只能读。
- 个别窗口（输入法宿主、受保护窗口、完全被遮挡或最小化）截不出图：`kimi_cu_observe`
  会降级成文本并写明原因，而不是让整次调用失败。
- 批量脚本是「盲跑」：中间结果不回模型，所以页面或界面可能不可预测地变化时要拆段。

## 安全

这个插件能驱动你真实的浏览器会话和真实的桌面。它不开放任何监听端口、不发遥测，只连上面写明的
本地 daemon 与本地命名管道。在共享机器上启用前请读 [SECURITY.md](SECURITY.md)。

## 许可

[MIT](LICENSE)
