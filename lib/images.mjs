/**
 * lib/images.mjs —— 截图 → 对话里的图片块
 * ============================================================================
 * 两条桥的截图形态不同：
 *   - WebBridge 返回 {path, mimeType, format}（文件已落盘）
 *   - KimiCU 返回 {url:"data:image/png;base64,..."}（内联 data URL）
 * 这里统一成 ctx.attachments 的 ImageAttachmentRef，渲染成 {type:'image'}。
 *
 * 关键约束（照抄宿主 read_image / mcp-client 的做法）：
 *   1. 先验证**当前模型路由**声明支持 image 输入，否则不产生图片块，
 *      降级成一行文本 + 本地路径 —— 否则适配器会在请求时炸掉。
 *   2. 任何 AttachmentError（太大/超像素/格式）都降级成文本，不让「看一眼」
 *      失败把整个工具调用变成错误。
 * ============================================================================
 */
import { readFile } from 'node:fs/promises'
import { errText } from './errors.mjs'
import { t } from './i18n.mjs'

const MEDIA_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

function sniffMediaType(bytes) {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && bytes.subarray(0, 3).toString('latin1') === 'GIF') return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return undefined
}

/**
 * 当前调用路由是否声明支持图片输入。取不到信息时按「不支持」处理（保守）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{agent?: any, signal?: AbortSignal}} exec
 * @returns {Promise<{supported: boolean, provider?: string, model?: string, reason?: string}>}
 */
export async function imageRouteSupport(ctx, exec) {
  try {
    const routed = exec?.agent?.session?.requestHeader?.()?.config
    const provider = routed?.provider ?? exec?.agent?.options?.provider
    const model = routed?.model ?? exec?.agent?.options?.model
    if (!provider || !model) return { supported: false, reason: t('img.noRoute') }
    const llm = ctx.get('llm')
    if (!llm) return { supported: false, provider, model, reason: t('img.noLlm') }
    const info = await llm.resolveModelInfo(provider, model, exec?.signal)
    const supported = Array.isArray(info?.inputModalities) && info.inputModalities.includes('image')
    return { supported, provider, model, reason: supported ? undefined : t('img.modelNoImage', { model }) }
  } catch (error) {
    return { supported: false, reason: t('img.probeFailed', { detail: errText(error) }) }
  }
}

/**
 * 把一段图片字节存成附件并返回图片块；失败时返回 null 并给出原因。
 * @returns {Promise<{block: object|null, reason?: string, attachmentId?: string}>}
 */
async function saveImageBlock(ctx, exec, bytes, mediaType, name) {
  const attachments = ctx.get('attachments')
  if (!attachments) return { block: null, reason: t('img.noAttachments') }
  const support = await imageRouteSupport(ctx, exec)
  if (!support.supported) return { block: null, reason: support.reason ?? t('img.routeNoImage') }
  try {
    const ref = await attachments.saveImage({ data: bytes, mediaType, name })
    return {
      block: { type: 'image', attachment: ref },
      attachmentId: ref.attachmentId,
    }
  } catch (error) {
    return { block: null, reason: t('img.rejected', { detail: errText(error) }) }
  }
}

/**
 * WebBridge 截图（已落盘）→ 图片块。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{agent?: any, signal?: AbortSignal}} exec
 * @param {{path: string, mimeType?: string, format?: string}} shot
 * @param {string} [name]
 */
export async function attachScreenshotFile(ctx, exec, shot, name) {
  if (!shot?.path) return { block: null, reason: t('img.noPath') }
  let bytes
  try {
    bytes = await readFile(shot.path)
  } catch (error) {
    return { block: null, reason: t('img.unreadable', { detail: errText(error) }), path: shot.path }
  }
  const declared = shot.mimeType
  const sniffed = sniffMediaType(bytes)
  const mediaType = declared && declared.startsWith('image/') ? declared : sniffed
  if (!mediaType) return { block: null, reason: t('img.badFormat'), path: shot.path }
  const saved = await saveImageBlock(ctx, exec, bytes, mediaType, name ?? 'webbridge-screenshot.png')
  return { ...saved, path: shot.path, bytes: bytes.length }
}

/**
 * KimiCU data URL → 图片块。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{agent?: any, signal?: AbortSignal}} exec
 * @param {string} dataUrl
 * @param {string} [name]
 */
export async function attachDataUrl(ctx, exec, dataUrl, name) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(String(dataUrl ?? ''))
  if (!match) return { block: null, reason: t('img.badDataUrl') }
  const mediaType = match[1]
  const bytes = Buffer.from(match[2], 'base64')
  if (bytes.length === 0) return { block: null, reason: t('img.empty') }
  const saved = await saveImageBlock(ctx, exec, bytes, mediaType, name ?? 'kimi-cu-screenshot.png')
  return { ...saved, bytes: bytes.length }
}
