// ============================================================
// api.js — 统一 API 客户端
// ============================================================

const API_BASE = '/api';
const AUTH_BASE = 'https://auth.yuer6327.top';

/** 跳转统一认证平台（登录/注册/退出），登录后经 nx 机制跳回当前页 */
export function gotoAuth(action = 'login') {
  const next = encodeURIComponent(location.origin + location.pathname + location.search);
  location.href = `${AUTH_BASE}/${action}?next=${next}`;
}

/** 登录链接（用于游客模式下的「登录」按钮/横幅，保留当前页回跳） */
export function loginHref() {
  const next = encodeURIComponent(location.origin + location.pathname + location.search);
  return `${AUTH_BASE}/login?next=${next}`;
}

async function request(path, options = {}) {
  const resp = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    credentials: 'include',
  });

  // 401 → 跳统一认证登录（带 next 回跳）；必须中断调用方的成功路径
  if (resp.status === 401) {
    const err = new Error('登录状态已失效，正在跳转登录');
    err.code = 'auth_required';
    err.status = 401;
    gotoAuth('login');
    throw err;
  }

  const contentType = resp.headers.get('content-type') || '';
  let data;
  try {
    if (!contentType.includes('application/json')) throw new Error('non-json');
    data = await resp.json();
  } catch {
    const err = new Error(resp.ok || resp.status >= 500 ? '服务超时或响应异常，请稍后重试' : `网络错误（HTTP ${resp.status}）`);
    err.code = 'invalid_response';
    err.status = resp.status;
    throw err;
  }
  if (!resp.ok) {
    // 附带后端 details（如 AI 校验失败原因），帮助用户定位问题；截断避免 toast 过长
    const detail = data.details ? `：${String(data.details).slice(0, 300)}` : '';
    const err = new Error(`${data.error || `HTTP ${resp.status}`}${detail}`);
    // 后端业务错误码（402 insufficient_balance / 409 model_disabled 等），前端据此分流
    err.code = data.code || null;
    err.status = resp.status;
    throw err;
  }
  return data;
}

// ── API 命名空间 ──
export const api = {
  // --- Auth（登录/注册/退出已上移统一认证平台）---
  me: () => request('/auth/me'),

  // --- AI 服务设置 ---
  saveApiKey: (payload) => request('/settings/api-keys', { method: 'POST', body: JSON.stringify(payload) }),
  getApiKeyStatus: () => request('/settings/api-keys/status'),

  // --- 提示词模板（按模式/题型独立）---
  getPrompts: () => request('/prompts'),
  getPrompt: (genre) => request(`/prompts/${encodeURIComponent(genre)}`),
  savePrompt: (genre, content) => request(`/prompts/${encodeURIComponent(genre)}`, { method: 'PUT', body: JSON.stringify({ content }) }),

  // --- 作文 ---
  getEssays: () => request('/essays'),
  createEssay: (payload) => request('/essays', { method: 'POST', body: JSON.stringify(payload) }),
  getEssay: (id) => request(`/essays/${id}`),
  updateEssay: (id, payload) => request(`/essays/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deleteEssay: (id) => request(`/essays/${id}`, { method: 'DELETE' }),

  // --- 稿件 ---
  createDraft: (essayId, payload) => request(`/essays/${essayId}/drafts`, { method: 'POST', body: JSON.stringify(payload) }),
  updateDraft: (draftId, text) => request(`/drafts/${draftId}`, { method: 'PUT', body: JSON.stringify({ text }) }),
  deleteDraft: (draftId) => request(`/drafts/${draftId}`, { method: 'DELETE' }),

  // --- 批改 / 精修 / 润色 / OCR ---
  reviewDraft: (draftId, modelId) => request(`/drafts/${draftId}/review`, {
    method: 'POST',
    body: JSON.stringify(modelId ? { model_id: modelId } : {}),
  }),
  polish: (essayId, payload) => request(`/essays/${essayId}/polish`, { method: 'POST', body: JSON.stringify(payload) }),
  ocr: (images, mode) => request('/ocr', { method: 'POST', body: JSON.stringify({ images, mode }) }),

  // --- 计费（余额 / 兑换码 / 用量 / 管理）---
  billing: {
    me: () => request('/billing/me'),
    redeem: (code) => request('/billing/redeem', { method: 'POST', body: JSON.stringify({ code }) }),
    usage: (limit = 50) => request(`/billing/usage?limit=${limit}`),
    admin: {
      gift: (username, pointsYuan, note) => request('/billing/admin/gift', {
        method: 'POST', body: JSON.stringify({ username, points_yuan: pointsYuan, note }),
      }),
      user: (username) => request(`/billing/admin/user/${encodeURIComponent(username)}`),
      tags: (username, add = [], remove = []) => request('/billing/admin/tags', {
        method: 'POST', body: JSON.stringify({ username, add, remove }),
      }),
      codes: (pointsYuan, count) => request('/billing/admin/codes', {
        method: 'POST', body: JSON.stringify({ points_yuan: pointsYuan, count }),
      }),
      orders: (limit = 50) => request(`/billing/admin/orders?limit=${limit}`),
      manualOrder: (username, pointsYuan, note) => request('/billing/admin/orders/manual', {
        method: 'POST', body: JSON.stringify({ username, points_yuan: pointsYuan, note }),
      }),
      migrateByok: () => request('/billing/admin/migrate-byok', { method: 'POST', body: '{}' }),
    },
  },
};

// ── Toast ──
// 成功/信息：3 秒自动消失（现状不变）。
// 报错：持久保留，需点击右上角 × 手动关闭（避免一闪而过错过失败原因）；
//      最多同时保留 3 条报错，超出移除最早的。
function dismissToast(el) {
  if (!el || el.classList.contains('toast-leaving')) return;
  el.classList.add('toast-leaving');
  const delay = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180;
  setTimeout(() => el.remove(), delay);
}

export function toast(message, type = 'info') {
  let stack = document.getElementById('toast-stack');
  if (!stack) {
    stack = document.createElement('div');
    stack.id = 'toast-stack';
    document.body.appendChild(stack);
  }

  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');

  if (type === 'error') {
    el.classList.add('toast-persist');
    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = message;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.textContent = '×';
    close.setAttribute('aria-label', '关闭');
    close.addEventListener('click', () => dismissToast(el));
    el.append(text, close);

    const errors = stack.querySelectorAll('.toast-error');
    if (errors.length >= 3) errors[0].remove();
    stack.appendChild(el);
    return el;
  }

  el.textContent = message;
  stack.appendChild(el);
  setTimeout(() => dismissToast(el), 3000);
  return el;
}

// ── 会话 ──
// 会话在页面生命周期内只取一次并缓存：
//   1. 导航栏注入与页面 init 会同时要会话，缓存后只发一个请求；
//   2. 更重要——游客首次访问时若并发两个请求，服务端会各发一个新 wg cookie，
//      页面拿着 A 的会话却带着 B 的 cookie，数据就对不上了。
//   （登录/退出都会整页跳转，缓存不会过期；需要强制刷新用 getSession(true)）
let sessionCache = null;
let sessionPromise = null;

/** 会话探测（不跳转）：登录返回 logged_in:true，游客返回 logged_in:false + quota */
export function getSession(force = false) {
  if (!force && sessionCache) return Promise.resolve(sessionCache);
  if (!force && sessionPromise) return sessionPromise;
  sessionPromise = (async () => {
    try {
      sessionCache = await api.me();
      return sessionCache;
    } catch (err) {
      if (err.status === 401) {
        sessionCache = { logged_in: false };
        return sessionCache;
      }
      toast(`无法验证登录状态：${err.message}`, 'error');
      return null;
    } finally {
      sessionPromise = null;
    }
  })();
  return sessionPromise;
}

/** 需要登录的页面用：未登录直接跳统一认证（游客访问设置/管理页） */
export async function requireAuth() {
  const session = await getSession(true);
  if (!session) return null;
  if (session.logged_in) return session;
  gotoAuth('login');
  return null;
}

// ── HTML escape ──
export function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 将 **粗体** 标记转为 <strong>（用于批改修改稿/精修片段渲染） */
export function renderBold(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
}

// ── UTC 时间戳 → 北京时间（数据库 datetime('now') 存的是 UTC，前端默认按北京时区展示）──
export function formatBeijingTime(str) {
  if (!str) return '';
  const m = String(str).match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return String(str);
  const [, y, mo, d, h, mi, s] = m;
  const t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(s || 0)) + 8 * 3600 * 1000;
  const dt = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())} ${p(dt.getUTCHours())}:${p(dt.getUTCMinutes())}${s ? ':' + p(dt.getUTCSeconds()) : ''}`;
}

/** 词数（与服务端 countWords 一致：空白分词） */
export function countWords(text) {
  const t = (text || '').trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

// ── 等第映射（25 分制；由分数推导，前端本地计算，旧批改记录同样适用）──
export function gradeFor(score) {
  if (typeof score !== 'number' || !Number.isFinite(score)) return null;
  if (score >= 20) return { grade: 'A', label: '优秀' };
  if (score >= 15) return { grade: 'B', label: '良好' };
  if (score >= 10) return { grade: 'C', label: '合格' };
  return { grade: 'D', label: '待提高' };
}

// ── 按需加载外部脚本（并发共享同一个加载 Promise）──
const scriptPromises = new Map();
/** 加载外部脚本；外部 CDN 一律带 integrity（SRI）——镜像被投毒时浏览器拒绝执行而非注入代码 */
export function loadScript(src, integrity) {
  if (scriptPromises.has(src)) return scriptPromises.get(src);
  const existing = document.querySelector(`script[src="${src}"]`);
  if (existing?.dataset.loaded === 'true') return Promise.resolve();
  const promise = new Promise((resolve, reject) => {
    const s = existing || document.createElement('script');
    s.addEventListener('load', () => { s.dataset.loaded = 'true'; resolve(); }, { once: true });
    s.addEventListener('error', () => {
      scriptPromises.delete(src);
      reject(new Error(`脚本加载失败${integrity ? '（校验不匹配或网络异常）' : ''}: ${src}`));
    }, { once: true });
    if (!existing) {
      if (integrity) {
        s.integrity = integrity;
        s.crossOrigin = 'anonymous';
      }
      s.src = src;
      s.async = true;
      document.head.appendChild(s);
    }
  });
  scriptPromises.set(src, promise);
  return promise;
}

// ── 图片压缩（拍照稿/题目图片上传通用）──
// 最长边 ≤1600px，JPEG 质量逐档下调至 ≤300KB（data URL 长度），
// 兼顾手写识别清晰度与 D1 存储/请求体上限。
export async function compressImageFile(file) {
  const img = await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('无法读取该图片')); };
    image.src = url;
  });
  const MAX_EDGE = 1600;
  const MAX_CHARS = 300 * 1024;
  let { width, height } = img;
  if (width > MAX_EDGE || height > MAX_EDGE) {
    const scale = MAX_EDGE / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  for (let q = 0.9; q >= 0.5; q -= 0.1) {
    const url = canvas.toDataURL('image/jpeg', q);
    if (url.length <= MAX_CHARS || q <= 0.5) return url;
  }
  return canvas.toDataURL('image/jpeg', 0.5);
}
