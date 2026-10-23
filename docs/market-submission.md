# 发布与收录计划（Release + market submission）

> 这份文件同时是操作手册和观测计划。目标不是"冲热门"，而是用一次低成本的发布，
> 拿到「值不值得投入更大的改造」的证据。

## 一、当前状态

| 项 | 状态 |
|---|---|
| GitHub 仓库（公开、MIT） | ✅ [KexinCC/dsh-kimi-assemble](https://github.com/KexinCC/dsh-kimi-assemble) |
| 自有市集索引（自助分发） | ✅ `https://raw.githubusercontent.com/KexinCC/dsh-kimi-assemble/main/market/index.json` |
| npm 包 | 1.0.1 已发布；1.1.0 待发布 |
| Open Plugin Market（dshopen.org）收录 | 未申请 |

## 二、两条分发路径

### 路径 1：自助（已完成，无需任何人审核）

任何人把上面的索引 URL 加到「发现 → 添加索引源」，就能搜到并安装。

- 优点：立刻可用、完全自主
- 缺点：每个用户都要手动加一次 URL

### 路径 2：进 Open Plugin Market 目录（dshopen.org）

那是社区项目（[polang233/dsh-plugin-index](https://github.com/polang233/dsh-plugin-index)），
收录方式是填一张 issue 表单，共 3 个字段：

1. **插件地址 / Plugin link**（必填）：npm 包名或源码仓库地址
2. **简短说明 / Summary**（必填）：一句话介绍，中英文均可
3. **补充信息 / Additional details**（可选）：Logo、截图、实测说明

提交入口：
`https://github.com/polang233/dsh-plugin-index/issues/new?template=plugin-add.yml`

他们的要求（摘自其 README）：公开源码、**可安装的 npm 版本**、明确的许可证；
经维护者确认也可使用固定 Git 提交。建议有自己的 Logo 与完善描述，会优先审核。

## 三、可直接粘贴的申请内容

**插件地址**

```text
https://github.com/KexinCC/dsh-kimi-assemble
```

（若已发布 npm，可改填包名 `dsh-kimi-assemble`。）

**简短说明**

```text
把 Kimi 浏览器扩展（操作用户本人已登录的 Chrome）与 KimiCU（Windows 真实桌面窗口）接成
DeepSeek Harness 原生工具：17 个工具，动作带「是否真的生效」校验、页面状态行与 diff 读取，
零运行时依赖。前置条件：需先安装 Kimi 官方浏览器扩展；桌面部分另需 Windows + KimiCU。
```

**补充信息**

```text
前提说明：本插件是「桥」，运行时由 Kimi 官方的浏览器扩展与 KimiCU 提供，插件本身不打包它们。
所以它面向的是已经在使用 Kimi 扩展 / KimiCU 的用户；没有这些组件的机器上，工具会明确报错并给出安装步骤。

能力与差异：
- 操作用户真实已登录的浏览器（保留登录态），不是无头浏览器
- Windows 真实窗口（UIA + 真实输入）与浏览器在同一个插件里
- 每个会改变页面的动作都回报 changed / change-diff，避免「点了没反应但工具说成功」

可复现的测量（A/B，脚本化策略，6 个 fixture × 5 次）：
https://github.com/KexinCC/dsh-kimi-assemble/blob/main/bench/RESULTS.md
1.0.1 → 1.1.0：任务成功率 37% → 100%，静默失败 10 → 0。

许可：MIT。零运行时依赖。中英双语 README，附 SECURITY / CONTRIBUTING / CHANGELOG。
```

## 四、30 天观测计划（用来决定要不要投"去掉 Kimi 依赖"）

发布后关注四个数（都可公开查到）：

| 指标 | 在哪看 | 判断 |
|---|---|---|
| npm 近 30 天下载量 | `https://api.npmjs.org/downloads/range/last-month/dsh-kimi-assemble` | < 100 = 无人用；100–1000 = 有小圈子；> 1000 = 有需求 |
| GitHub star / issue | 仓库页面 | 有 issue 在问"能不能不用 Kimi 扩展" = 明确的改造信号 |
| 市场是否收录成功 | dshopen.org 目录页搜插件名 | 未收录说明材料有问题，不是需求问题 |
| 主动咨询 | 社交/群里是否有人问 | 定性信号 |

**决策规则（先定好，避免事后找理由）**

- 下载 < 100 **且** 30 天 0 issue → 不做"去掉 Kimi 依赖"的重写。它保持"自用主力 + 少数同好"定位。
- 出现 ≥3 个 issue / 咨询在问「不用 Kimi 扩展能不能用」→ 启动"自建通道"方案评估
  （CDP attach vs 自维护轻量扩展 vs 内嵌 Playwright，比较门槛与放弃的能力）。
- 下载 100–1000 且反馈集中在"安装太麻烦"→ 优先做**引导**（自动检测 + 一键安装说明），
  而不是重写通道。

## 五、事实提醒

- 这个类别在市场上并不空：`browser` 关键词命中 36 个插件，其中至少有一个已宣称
  "real, signed-in Chrome"，另一个是"扩展 + 本地桥"同架构。我们的差异点是
  **Windows 真实桌面 + 浏览器一体，且动作可验证**，不是"浏览器控制"本身。
- 因此对外文案不要写成"通用浏览器自动化"，要写成"给你已经登录的浏览器和真实桌面加手脚"。
