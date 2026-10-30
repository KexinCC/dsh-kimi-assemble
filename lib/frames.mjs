/**
 * lib/frames.mjs —— iframe 寻址 + 真实鼠标派发
 * ============================================================================
 * 为什么需要：
 *   1. 无障碍快照**不包含** iframe 内部（实测：readSeesInner=false），CSS 选择器也跨不进
 *      帧（click #oa-btn → element not found）。而真实业务系统（门户套 OA）内容全在 iframe 里。
 *   2. 自绘组件（Element UI / Ant Design 的下拉）对 el.click() 无反应，只有真实鼠标事件有用。
 *
 * 设计原则（渐进式披露）：
 *   - **调用方不需要知道这些**：默认自动探测帧、自动在「点了没变化」时补一次真实鼠标。
 *   - 只在真的用了才汇报：`frameUsed` / `clickStrategy` 只在发生变化时出现在结果里。
 *   - 跨源 iframe 不做假装：明确告诉调用方「这一帧跨源，只能读不能点」。
 *
 * 约束（实测得出，必须遵守）：
 *   - CDP 的输入事件（键盘、鼠标）都要先 `Page.bringToFront`，否则一个都不触发。
 *     它的语义是「焦点模拟」，不会抢用户的前台窗口。
 *   - 只处理**同源** iframe：靠 contentDocument 访问，跨源会被浏览器拒绝（我们不绕）。
 * ============================================================================
 */

/** 枚举页面里的 iframe：句柄、src、是否同源 */
const LIST_CODE = `(() => {
  const frames = Array.from(document.querySelectorAll('iframe, frame'));
  return frames.map((frame, index) => {
    let sameOrigin = false;
    let hasDoc = false;
    try {
      const doc = frame.contentDocument;
      hasDoc = !!doc;
      sameOrigin = !!doc;
    } catch (error) {
      sameOrigin = false;
    }
    return {
      handle: '#f' + (index + 1),
      src: String(frame.getAttribute('src') || '').slice(0, 120),
      sameOrigin,
      hasDoc,
    };
  });
})()`

/**
 * 在所有同源 frame 里找元素（也含顶层）。找到就返回**视口绝对坐标**，直接可用于鼠标派发。
 * 找不到时返回帧清单，让调用方知道有什么可选。
 */
const FIND_CODE = (selector, frameHandle) => `(() => {
  const selector = ${JSON.stringify(String(selector))};
  const frameHandle = ${JSON.stringify(frameHandle ?? null)};
  const safeQuery = (doc) => {
    try { return doc ? doc.querySelector(selector) : null; } catch (error) { return null; }
  };
  const center = (frame, el) => {
    const r = el.getBoundingClientRect();
    const base = frame ? frame.getBoundingClientRect() : { left: 0, top: 0 };
    return {
      x: base.left + r.left + r.width / 2,
      y: base.top + r.top + r.height / 2,
      width: r.width,
      height: r.height,
    };
  };
  const frames = Array.from(document.querySelectorAll('iframe, frame'));

  // 指定了帧：只在那一个帧里找
  if (frameHandle) {
    const index = Number(String(frameHandle).replace('#f', '')) - 1;
    const frame = frames[index];
    if (!frame) return { ok: false, reason: 'no-such-frame', handle: frameHandle, frames: ${LIST_CODE} };
    let doc = null;
    try { doc = frame.contentDocument; } catch (error) { doc = null; }
    if (!doc) return { ok: false, reason: 'cross-origin', handle: frameHandle, frames: ${LIST_CODE} };
    const el = safeQuery(doc);
    if (!el) return { ok: false, reason: 'not-in-frame', handle: frameHandle, frames: ${LIST_CODE} };
    return { ok: true, handle: frameHandle, rect: center(frame, el), tag: el.tagName, text: (el.innerText || '').slice(0, 80) };
  }

  // 没指定：先顶层，再逐帧
  const top = safeQuery(document);
  if (top) return { ok: true, handle: null, rect: center(null, top), tag: top.tagName, text: (top.innerText || '').slice(0, 80) };

  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    let doc = null;
    try { doc = frame.contentDocument; } catch (error) { doc = null; }
    if (!doc) continue;
    const el = safeQuery(doc);
    if (!el) continue;
    return {
      ok: true,
      handle: '#f' + (index + 1),
      rect: center(frame, el),
      tag: el.tagName,
      text: (el.innerText || '').slice(0, 80),
    };
  }
  return { ok: false, reason: 'not-found', frames: ${LIST_CODE} };
})()`

/** 在帧内用 JS 点击（同源） */
const JS_CLICK_CODE = (selector, frameHandle) => `(() => {
  const selector = ${JSON.stringify(String(selector))};
  const index = Number(String(${JSON.stringify(String(frameHandle))}).replace('#f', '')) - 1;
  const frame = document.querySelectorAll('iframe, frame')[index];
  if (!frame) return { ok: false, reason: 'no-such-frame' };
  let doc = null;
  try { doc = frame.contentDocument; } catch (error) { doc = null; }
  if (!doc) return { ok: false, reason: 'cross-origin' };
  const el = doc.querySelector(selector);
  if (!el) return { ok: false, reason: 'not-in-frame' };
  el.click();
  return { ok: true };
})()`

/** 在帧内设置输入值，并派发 input/change（同源） */
const JS_FILL_CODE = (selector, frameHandle, value) => `(() => {
  const selector = ${JSON.stringify(String(selector))};
  const value = ${JSON.stringify(String(value))};
  const index = Number(String(${JSON.stringify(String(frameHandle))}).replace('#f', '')) - 1;
  const frame = document.querySelectorAll('iframe, frame')[index];
  if (!frame) return { ok: false, reason: 'no-such-frame' };
  let doc = null;
  try { doc = frame.contentDocument; } catch (error) { doc = null; }
  if (!doc) return { ok: false, reason: 'cross-origin' };
  const el = doc.querySelector(selector);
  if (!el) return { ok: false, reason: 'not-in-frame' };
  const proto = el.tagName === 'TEXTAREA' ? doc.defaultView.HTMLTextAreaElement.prototype : doc.defaultView.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
  if (setter) setter.call(el, value); else el.value = value;
  el.dispatchEvent(new doc.defaultView.Event('input', { bubbles: true }));
  el.dispatchEvent(new doc.defaultView.Event('change', { bubbles: true }));
  el.focus();
  return { ok: true };
})()`

/** 列出帧（给 read 用，只在页面有帧时才调用） */
export function listFramesCode() {
  return LIST_CODE
}

/**
 * 找一个元素，返回它在视口里的绝对中心点。
 * @param {(action: string, args: object, options?: object) => Promise<any>} call daemon 调用
 * @param {string} session
 * @param {string} selector
 * @param {{frame?: string, signal?: AbortSignal}} [options]
 */
export async function findTarget(call, session, selector, options = {}) {
  const data = await call(
    'evaluate',
    { code: FIND_CODE(selector, options.frame) },
    { session, signal: options.signal, timeoutMs: 8_000 },
  )
  return normalizeEval(data)
}

/** 在指定帧里用 JS 点击 / 填值（同源），失败返回原因 */
export async function jsClickInFrame(call, session, selector, frameHandle, options = {}) {
  const data = await call(
    'evaluate',
    { code: JS_CLICK_CODE(selector, frameHandle) },
    { session, signal: options.signal, timeoutMs: 8_000 },
  )
  return normalizeEval(data)
}

export async function jsFillInFrame(call, session, selector, frameHandle, value, options = {}) {
  const data = await call(
    'evaluate',
    { code: JS_FILL_CODE(selector, frameHandle, value) },
    { session, signal: options.signal, timeoutMs: 8_000 },
  )
  return normalizeEval(data)
}

/** daemon 的 evaluate 返回形状不固定，统一成对象 */
function normalizeEval(data) {
  if (data === undefined || data === null) return { ok: false, reason: 'no-result' }
  if (typeof data === 'object' && data.json !== undefined) {
    const json = data.json
    return typeof json === 'string' ? safeParse(json) : json
  }
  if (typeof data === 'object' && data.value !== undefined) {
    return typeof data.value === 'string' ? safeParse(data.value) : data.value
  }
  return typeof data === 'string' ? safeParse(data) : data
}

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return { ok: false, reason: 'unparsable', raw: String(text).slice(0, 200) }
  }
}

/**
 * 派发一次真实鼠标点击（CDP）。
 *
 * **必须**先 Page.bringToFront：实测不带它时 mousedown 一次都不触发；
 * 带上之后自绘下拉才会打开。bringToFront 是焦点模拟，不会抢用户前台窗口。
 */
export async function realMouseClick(call, point, options = {}) {
  if (!point || typeof point.x !== 'number' || typeof point.y !== 'number') {
    return { ok: false, reason: 'no-point' }
  }
  await call('cdp', { method: 'Page.bringToFront' }, { session: options.session, signal: options.signal })
  const base = { x: Math.round(point.x), y: Math.round(point.y), button: 'left', clickCount: 1, buttons: 1 }
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await call(
      'cdp',
      { method: 'Input.dispatchMouseEvent', params: { type, ...base } },
      { session: options.session, signal: options.signal },
    )
  }
  return { ok: true, x: base.x, y: base.y }
}

/**
 * 在被点击元素周围装一个 window.open 探针（同源顶层）。
 * 点击前装、点击后读，就能判断「弹窗被吞」——这是用户实际踩过的坑：
 * window.open 调用了、标签页却没出来，且没有任何反馈。
 */
export const POPUP_HOOK_CODE = `(() => {
  if (window.__kimiPopupProbe) { window.__kimiPopupProbe.calls = 0; return 'already-installed'; }
  window.__kimiPopupProbe = { calls: 0 };
  const original = window.open;
  window.open = function (...args) {
    try { window.__kimiPopupProbe.calls += 1; } catch (error) { /* 计数失败不影响页面 */ }
    const result = original.apply(this, args);
    try { window.__kimiPopupProbe.blocked = result === null || result === undefined; } catch (error) { /* ignore */ }
    return result;
  };
  return 'installed';
})()`

export const POPUP_READ_CODE = `(() => {
  const probe = window.__kimiPopupProbe;
  return probe ? { calls: probe.calls || 0, blocked: probe.blocked === true } : { calls: 0, blocked: false };
})()`

/**
 * 深度签名：把顶层和各同源帧的可见文本长度一起算进来。
 * 为什么需要：顶层的 signature（url/title/nodes/textLen）**看不见 iframe 内的变化**，
 * 于是「帧里点成功了」会被误报成 unchanged。实测踩过这个坑。
 */
export const DEEP_SIG_CODE = `(() => {
  const visibleLen = (doc) => {
    try {
      const walker = doc.createTreeWalker(doc.body || doc, NodeFilter.SHOW_TEXT);
      let total = 0;
      while (walker.nextNode()) {
        const parent = walker.currentNode.parentElement;
        if (!parent) continue;
        const tag = parent.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEMPLATE') continue;
        total += (walker.currentNode.nodeValue || '').trim().length;
      }
      return total;
    } catch (error) {
      return -1;
    }
  };
  const frames = Array.from(document.querySelectorAll('iframe, frame'));
  const inner = [];
  for (let index = 0; index < frames.length; index += 1) {
    let doc = null;
    try { doc = frames[index].contentDocument; } catch (error) { doc = null; }
    inner.push({ handle: '#f' + (index + 1), len: doc ? visibleLen(doc) : -2 });
  }
  return { top: visibleLen(document), frames: inner };
})()`

/** 读深度签名 */
export async function deepSignature(call, session, options = {}) {
  const data = await call('evaluate', { code: DEEP_SIG_CODE }, { session, signal: options.signal, timeoutMs: 6_000 })
  return normalizeEval(data)
}

/** 两个深度签名是否不同 */
export function deepChanged(before, after) {
  if (!before || !after) return null
  if (before.top !== after.top) return true
  const b = new Map((before.frames ?? []).map((f) => [f.handle, f.len]))
  for (const frame of after.frames ?? []) {
    if (b.get(frame.handle) !== frame.len) return true
  }
  return false
}
