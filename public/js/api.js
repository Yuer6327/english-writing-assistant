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

async function request(path, options = {}) {
  const resp = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    credentials: 'include',
  });

  // 401 → 跳统一认证登录（带 next 回跳）
  if (resp.status === 401) {
    gotoAuth('login');
    return;
  }

  const data = await resp.json().catch(() => ({ error: 'Network error' }));
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

  // --- 提示词模板 ---
  getPrompts: () => request('/prompts'),
  savePrompt: (genre, content) => request(`/prompts/${genre}`, { method: 'PUT', body: JSON.stringify({ content }) }),

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
export function toast(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ── Auth guard ──
export async function requireAuth() {
  try {
    const user = await api.me();
    return user ?? null;
  } catch {
    gotoAuth('login');
    return null;
  }
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

// ── 按需加载外部脚本（幂等：已加载则跳过）──
const loadedScripts = new Set();
export function loadScript(src) {
  if (loadedScripts.has(src)) return Promise.resolve();
  if (document.querySelector(`script[src="${src}"]`)) return Promise.resolve();
  loadedScripts.add(src);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { loadedScripts.delete(src); reject(new Error(`脚本加载失败: ${src}`)); };
    document.head.appendChild(s);
  });
}

// ── 图片压缩（拍照稿/题目图片上传通用）──
// 最长边 ≤1600px，JPEG 质量逐档下调至 ≤300KB（data URL 长度），
// 兼顾手写识别清晰度与 D1 存储/请求体上限。
export async function compressImageFile(file) {
  const img = await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => resolve(image);
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
