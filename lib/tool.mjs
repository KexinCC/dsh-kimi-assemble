/**
 * lib/tool.mjs —— 轻量 defineTool（不依赖 @deepseek-ai/dsh-tools）
 * ============================================================================
 * 为什么自己写：profile 是 autoInstallPeers: false，`@deepseek-ai/dsh-tools`
 * 不一定可 import；而且宿主的 defineTool 只做 schema 编译 + 参数校验，我们
 * 本来就要写自定义校验（互斥字段、枚举归一化、点名到字段的错误文案）。
 *
 * 产出的是宿主 ToolDefinition 的**原始形态**：
 *   { name, description, parameters(JSON Schema), output:{schema, render}, execute }
 * 宿主的 ctx.tools.register 只要求 output.schema 属于它的 JSON Schema 子集
 * （type/oneOf/properties/required/additionalProperties/items/enum/const +
 * description/title/default/examples），并且会自己校验参数；但它**不做**语义
 * 校验，所以这里的 execute 入口统一先跑 spec.validate。
 *
 * 与宿主 defineTool 的差异（有意为之）：
 *   - 参数 schema 直接写 JSON Schema，不经过作者 DSL。
 *   - 校验失败抛 KimiError(KIMI_ARGS)，message 点名到字段。
 *   - 支持 `normalize(args)` 在验证后做归一化（如 selector → @e ref）。
 * ============================================================================
 */
import { argsError } from './errors.mjs'
import { t } from './i18n.mjs'

const JSON_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return typeof value
}

function typeMatches(expected, value) {
  const actual = typeOf(value)
  if (expected === actual) return true
  // integer 值也是合法 number
  if (expected === 'number' && actual === 'integer') return true
  return false
}

/**
 * 按 JSON Schema 子集校验一个值。只覆盖我们实际用到的关键字。
 * @returns {string[]} 违规描述（空 = 通过）
 */
function checkValue(schema, value, path) {
  const problems = []
  if (!schema || typeof schema !== 'object') return problems

  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf.map((branch) => checkValue(branch, value, path))
    if (branches.some((branch) => branch.length === 0)) return problems
    problems.push(t('args.notAnyOf', { field: path }))
    return problems
  }

  const expected = schema.type
  if (typeof expected === 'string') {
    if (!typeMatches(expected, value)) {
      problems.push(t('args.wrongType', { field: path, expected, actual: typeOf(value) }))
      return problems
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((item) => item === value)) {
    problems.push(
      t('args.enum', {
        field: path,
        allowed: schema.enum.map((item) => JSON.stringify(item)).join(' / '),
        actual: JSON.stringify(value),
      }),
    )
    return problems
  }

  if (expected === 'object' && value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties && typeof schema.properties === 'object' ? schema.properties : {}
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) {
        problems.push(t('args.required', { field: path ? `${path}.${key}` : key }))
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) {
          problems.push(
            t('args.unknownField', {
              field: path ? `${path}.${key}` : key,
              available: Object.keys(properties).join(', ') || t('render.none'),
            }),
          )
        }
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!Object.hasOwn(value, key) || value[key] === undefined) continue
      problems.push(...checkValue(child, value[key], path ? `${path}.${key}` : key))
    }
  }

  if (expected === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, index) => {
      problems.push(...checkValue(schema.items, item, `${path}[${index}]`))
    })
  }

  return problems
}

/**
 * 定义一个工具。
 * @param {object} spec
 * @param {string} spec.name 模型可见名字
 * @param {string} spec.description 模型可见描述（写「做什么 + 什么时候用 + 返回值」）
 * @param {Record<string, unknown>} spec.parameters 原始 JSON Schema（object 根）
 * @param {(args: any, exec: any) => Promise<any>} spec.execute 业务实现
 * @param {(value: any, args: any) => Array<object>} spec.render 值 → 内容块
 * @param {(args: any) => any} [spec.normalize] 校验后归一化参数
 * @param {(args: any) => boolean} [spec.isConcurrencySafe]
 * @param {number} [spec.timeoutMs]
 * @param {Record<string, unknown>} spec.outputSchema 输出值 schema
 */
export function defineTool(spec) {
  const { name, description, parameters, execute, render, normalize, isConcurrencySafe, timeoutMs } = spec
  const outputSchema = spec.outputSchema ?? { type: 'object', additionalProperties: true, properties: {} }
  if (!name || typeof name !== 'string') throw new Error('defineTool: name is required')
  if (!description || typeof description !== 'string') throw new Error(`defineTool(${name}): description is required`)
  if (!parameters || parameters.type !== 'object') throw new Error(`defineTool(${name}): parameters must be an object-rooted JSON Schema`)
  if (typeof execute !== 'function') throw new Error(`defineTool(${name}): execute is required`)
  if (typeof render !== 'function') throw new Error(`defineTool(${name}): render is required`)

  return {
    name,
    description,
    parameters,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(isConcurrencySafe ? { isConcurrencySafe } : {}),
    output: {
      schema: outputSchema,
      render: (args, value) => render(value, args),
    },
    async execute(rawArgs, exec) {
      const input = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {}
      const problems = checkValue(parameters, input, '')
      if (problems.length > 0) {
        throw argsError(t('args.invalid', { problems: problems.join('; ') }))
      }
      const args = normalize ? normalize(input) : input
      return execute(args, exec)
    },
  }
}

/**
 * 简化 JSON Schema 构造：只列字段名 → schema，自动收集 required。
 * @param {Record<string, {schema: object, required?: boolean}>} fields
 */
export function objectSchema(fields) {
  const properties = {}
  const required = []
  for (const [key, field] of Object.entries(fields)) {
    properties[key] = field.schema
    if (field.required) required.push(key)
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

/**
 * 字段构造。
 * 注意：宿主只接受 JSON Schema 子集（type/oneOf/properties/required/
 * additionalProperties/items/enum/const + description/title/default/examples），
 * **不接受 minimum/maximum**，所以数值范围写进 description，并由业务层再校验。
 *
 * 这些 description 是**模型可见**的，因此恒为英文、与 config.language 无关
 * （见 test/i18n.mjs 的「description 与语言无关」断言）。
 */
export const stringField = (description, extra = {}) => ({ schema: { type: 'string', description, ...extra } })
export const boolField = (description, extra = {}) => ({ schema: { type: 'boolean', description, ...extra } })
export const intField = (description, extra = {}) => {
  const { minimum, maximum, ...rest } = extra
  const range =
    minimum !== undefined || maximum !== undefined
      ? ` Range: ${minimum ?? '-∞'} to ${maximum ?? '+∞'}.`
      : ''
  return { schema: { type: 'integer', description: `${description}${range}`, ...rest } }
}
export const numField = (description, extra = {}) => ({ schema: { type: 'number', description, ...extra } })
export const enumField = (description, values) => ({ schema: { type: 'string', description, enum: values } })
export const arrayField = (description, items) => ({ schema: { type: 'array', description, items } })
export const objField = (description, extra = {}) => ({
  schema: { type: 'object', description, additionalProperties: true, properties: {}, ...extra },
})

/** 截断长文本，附明确提示（agent-experience：标记省略，并给出取更多的方式）。 */
export function truncate(text, maxChars) {
  const value = String(text ?? '')
  if (value.length <= maxChars) return { text: value, truncated: false }
  return {
    text: value.slice(0, maxChars),
    truncated: true,
    note: t('render.truncated', { max: maxChars }),
  }
}

/** 内容块构造：纯文本。 */
export const textBlock = (text) => ({ type: 'text', text: String(text) })
