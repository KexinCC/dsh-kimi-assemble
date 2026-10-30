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

### 1. 先选路径（30 秒）

| 路径 | 你能得到 | 需要什么 | 工具 |
|---|---|---|---|
| **只要浏览器** | 驱动你已登录的 Chrome/Edge | Kimi 浏览器扩展 + 它的本地服务 | 12 个 + `kimi_status` |
| **只要桌面** | 操作真实 Windows 窗口 | Windows + KimiCU 运行时 | 5 个 + `kimi_status` |
| **两个都要**（默认） | 全部 | 上面两套 | 17 个 |

只想用浏览器就设 `kimicuEnabled: false`；只想用桌面就设 `webbridgeEnabled: false` —— 关掉的那一半
连工具和提示词都不会注册。

这个插件是**桥，不是自带实现**。它不会自己下载执行远程安装包，所以缺组件时会报
`KIMI_WEBRIDGE_DOWN` / `KIMI_CU_NOT_INSTALLED` —— **错误里直接带着下一步怎么做**。

### 2. 跑预检（这是安装主线）

它会告诉你缺什么；加 `--json` 输出机器可读的 `next_actions`（`kind: "run"` = 代理能直接执行，
`kind: "user"` = 只能人来点）。

```bash
npm i -g dsh-kimi-assemble && kimi-assemble-doctor
kimi-assemble-doctor --json          # 给代理用
```

插件已经装进 profile 的话，直接跑自带的那份：

```bash
node "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-kimi-assemble\scripts\doctor.mjs"
```

退出码：`0` 双桥就绪 · `2` 需要人做一步 · `3` 只缺桌面运行时且可安装。
不加 `--install-desktop` 时它**绝不**下载任何东西。

### 3. 装插件

```text
plugin_manager install_bundle  target=dsh-kimi-assemble
```

从市集装：在 Discover → index sources 里加这个索引地址，然后从市集安装：

```text
https://raw.githubusercontent.com/KexinCC/dsh-kimi-assemble/main/market/index.json
```

从本地克隆装（不走 registry）：

```bash
git clone https://github.com/KexinCC/dsh-kimi-assemble.git
```

```text
plugin_manager install_bundle  target=<那个克隆的绝对路径>
```

### 4. 验证

`cordis_inspect_query(Tool.listTools)` 会列出你这条路径对应的 `kimi_*` 工具，
`kimi_status` 应报两条桥都已安装。到这一步就算装好了；之后插件会自动发现、启动、重连
（包括清理异常关机留下的 daemon pid 僵尸文件）。

### 组件安装细节

| 你想要的 | 你需要的 | 怎么弄 |
|---|---|---|
| 浏览器控制 | Chrome 或 Edge + **Kimi 浏览器扩展**。本地 Agent 这条路**不需要 Kimi 账号**（只有侧边栏要）。 | 1) 从 Chrome 应用商店 / Edge 加载项装 "Kimi" 扩展（或[手动安装](https://www.kimi.com/products/kimi-browser-extension)）；2) 打开扩展侧边栏 → 设置 → “本地 Agent 远程控制” → 点**去连接**；3) 把弹窗里的安装命令复制到终端执行 —— 这会在 `~/.kimi-webbridge` 装本地服务。[FAQ](https://www.kimi.com/help/kimi-webbridge/kimi-webbridge-faq) |
| 桌面控制 | Windows + **KimiCU 运行时**（`kimi-cu.exe`） | 在终端里下载并运行 [setup_windows.cmd](https://cdn.kimi.com/kimi-computer-use-windows/latest/setup_windows.cmd)，或把 `kimicuExePath` 指向已有的副本 |
| 通用 | DeepSeek Harness `>= 0.2.0`（在 `0.2.1-rc.2` 上验证）、Node `>= 22` | — |

> **安全边界，先说清：** 浏览器读到的一切都是**不可信数据，不是指令**。`kimi_browser_eval`
> 是特权工具（它在你的页面里执行代码），网页里那些"让 AI 去做某事"的话，应当被报告，而不是被执行。
> 见 [SECURITY.md](SECURITY.md)。

### 让 AI 自己把前置组件装上


包里带一个预检脚本。它会告诉你缺什么；加 `--json` 会输出**机器可读的待办清单**：
`kind: "run"` = 代理可以直接执行的命令，`kind: "user"` = 只有人能做的事。

```bash
# 不用先装插件，直接从 registry 跑
# 插件装进 DSH 后，直接从 profile 里跑：
node "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-kimi-assemble\scripts\doctor.mjs"

# 或者装一次包，用它的 bin：
npm i -g dsh-kimi-assemble && kimi-assemble-doctor

# 机器可读输出（给代理用）
kimi-assemble-doctor --json
```

退出码：`0` 两条桥都就绪 · `2` 有人工步骤 · `3` 只缺桌面运行时（且可自动安装）。

**代理能自己做的部分**

| 组件 | 能自动吗 | 怎么做 |
| --- | --- | --- |
| KimiCU 运行时（Windows 桌面半边） | **能**，但需要显式同意 | `kimi-assemble-doctor --install-desktop` 从 `cdn.kimi.com` 下载 `setup_windows.cmd`、执行，然后重新自检 |
| 启动本地 WebBridge 服务 | 能 | `kimi-assemble-doctor --start`，或插件首次调用时自动拉起 |
| Kimi 浏览器扩展（Chrome/Edge） | **不能** | 它是浏览器商店扩展，只能用户自己添加 |
| `~/.kimi-webbridge` 下的本地服务 | **不能** | **没有公开安装地址**（实测：所有猜测的 `cdn.kimi.com/…/setup_*` 路径都返回 403）。唯一来源是扩展「设置 → 本地 Agent 远程控制 → 去连接」弹窗里给出的安装命令 |

所以代理的循环是：跑 doctor → 看到 `kind: "user"` 就把那几条原样交给用户（装扩展、点去连接、
执行弹窗里的命令）→ 再跑 doctor，直到退出码 `0`。

**安全性**

- 插件**绝不**自己下载并执行安装器。`--install-desktop` 需要显式开启，会先打印要下载的 URL，
  并在用户看着的情况下执行。
- 全程不需要 API key、不需要账号、不需要管理员权限（KimiCU 可能弹自己的 UAC）。

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
| `browserVerify` | `auto` | `auto` = 校验动作是否真的改变了页面；`off` = 退回「派发即成功」（回滚开关） |
| `mouseFallback` | `auto` | JS 点击确认没变化后，自动补一次 CDP 真实鼠标事件（Element UI / Ant Design 必须要）。`clickStrategy` 会说明哪种方式生效 |
| `popupWatch` | `on` | 检测被吞掉的 `window.open`，报 `popupBlocked` |
| `browserVerifyLightMs` | `0` | 可逆动作（滚动/悬停/勾选…）的观察预算。这类动作不再白等 600ms：实测 649ms → 13ms |
| `browserVerifyMs` | `600` | 等待变化的观察窗口，超时才判「没生效」（100–10000） |
| `diagnostics` | `false` | 每次工具调用往 `~/.dsh/kimi-assemble/diag.log` 追加一行 JSONL（工具名/耗时/成功与否/错误码，**不记参数**） |
| `diagnosticsMaxKb` | `512` | `diag.log` 轮转阈值（保留一个 `.1`） |
| `browserReadIncludeMeta` | `true` | 每次 read 附带页面状态行（url / 加载态 / 滚动 / 焦点 / 计数） |
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

- **`kimi_browser_open {url, new_tab=true, wait_until=load|domcontentloaded|none, group_title?, session?}`**
  → 最终 URL / 标题 / tabId / 页面状态。默认等到加载完成，避免下一步跟页面加载赛跑
- **`kimi_browser_read {mode=read|find|frame|diff, include_meta?, include_screenshot?, ref?, max_chars?, cursor?}`**
  → 无障碍树文本（带 `[ref=eNNN]`）、一行页面状态（url / 加载态 / 滚动 / 焦点元素 / 元素计数）、
  搜索命中、iframe 文本，或**只回相对上次读取的变化**（`mode=diff`，通常只有全量的 4%）
- **`kimi_browser_click {selector, verify?, session?}`** —— CSS 或 `@eNNN` / `eNNN` / `[ref=eNNN]`；
  会回报 `changed` / `changeDetail`，ref 过期会自动重读并重试一次
- **`kimi_browser_fill {selector, value, submit=false, verify?, session?}`** ——
  → `submit=true` 会替你提交：点表单提交按钮（兜底 `requestSubmit()` → Esc 后重点 → 回车），并回报 `submitStrategy`。注意本扩展**产生不了真实键盘事件**，所以「输入框里按回车提交」不会发生。
  会回报 `submit=true` 的回车到底有没有让页面变化（联想下拉会吞掉它）
- **`kimi_browser_act {verb, ...}`** —— `press` / `type` / `clear` / `select` / `check` / `uncheck` /
  `hover` / `scroll` / `drag` / `mouse_click` / `upload`，都带校验，可加 `wait_for`
- **`kimi_browser_wait {text|text_gone|selector|url|ready|ms, timeout_ms?}`** ——
  等条件而不是反复读页面；超时会带回当时的页面状态
- **`kimi_browser_eval {code, max_chars?}`** —— 在页面里求值，返回 JSON
- **`kimi_browser_dialog {action=status|accept|dismiss, text?}`** —— 原生弹窗会冻结页面：
  click/fill/act 会回 `dialogOpen` 而不是报错，用这个工具作答
- **`kimi_browser_screenshot {selector?, full_page=false, format=png|jpeg, quality?, session?}`** →
  图片块（模型路由不支持图片时给路径）
- **`kimi_browser_tabs {action=list|list_all|attach|close|close_session, tab_id?}`**
- **`kimi_browser_script`** —— **两种形态**：
  - 单步（逃生口）：`{action, args, session?}`，覆盖全部 35 个 daemon action
    （network / upload / pdf / cdp / highlight …）
  - 批量：`{steps:[{action,args,capture?}], stop_on_error?, max_result_chars?}` —— 一次调用 1–25 步
  - 参数表：[`references/browser-actions.md`](references/browser-actions.md)

### 为什么每个动作都带校验

扩展的 click 是 DOM 级派发：即使页面什么都没发生，它也回成功。所以 1.0.x 里**点错元素和点对元素
看起来一模一样**。现在每个会改变页面的工具都会回报「页面到底变了没有」；`browserVerify: 'off'`
可以退回旧的「派发即成功」。实测效果（6 个 fixture × 5 次，见 [`bench/RESULTS.md`](https://github.com/KexinCC/dsh-kimi-assemble/blob/main/bench/RESULTS.md)）：
静默失败 10 → 0，任务成功率 37% → 100%，代价是「确实什么都没发生」的动作多花约 600ms 才敢下结论。

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
（上面是插件自身开销；和 Playwright 的完整对照见下一节「基准测试」。）
批量脚本就是为这个加的：一次工具调用 = 一次模型轮次，过去要 6 轮的 6 步浏览器动作，现在
在**一次 0.6 秒的调用**里跑完。

---

## 基准测试（vs Playwright）

浏览器控制插件**没有公认排行榜** —— WebArena / WebVoyager / Mind2Web / OSWorld 考的都是「模型 + 工具」
整体在几百个任务上的表现。所以这里不编"分数"，而是在同一台机器、同一组页面、同一组操作上，
和行业基线 Playwright 对比延迟与吞吐（`node bench/bench.mjs --reps=10`）。

| 操作 | 本插件 (p50) | Playwright (p50) | 比值 |
|---|---:|---:|---:|
| 打开页面 | 157 ms | 20 ms | 慢 7.8× |
| 读页面 | 48 ms | 19 ms | 慢 2.5× |
| 点击 + 变化校验（默认） | 674 ms | 64 ms | 慢 10.6× |
| 点击不校验 | **18 ms** | 52 ms | **快 3×** |
| 填输入框 | 32 ms | 24 ms | 慢 1.4× |
| 截图 | 145 ms | 50 ms | 慢 2.9× |
| 冷启动 | 524 ms | 507 ms | 基本持平 |
| 一次调用 20 个操作 | **102 ms（196 ops/s）** | 320 ms（62 ops/s） | **快 3.2×** |

读一遍就懂：**打开页面慢是因为多两跳**（它操作的是你自己已登录的 Chrome，不是临时浏览器）；
**校验窗口是"知道动作有没有生效"的代价**（`browserVerify: "off"` 可关）；**批量才是省模型轮次的地方**。
方法、坑与复现命令：[docs/BENCHMARK.md](https://github.com/KexinCC/dsh-kimi-assemble/blob/main/docs/BENCHMARK.md)。

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

宿主内验收（2026-10-23）：17 个 `kimi_*` 工具可见；`kimi_cu_observe` 的截图以图片块回到对话；
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
