// ============================================================
// middleware/security.ts — 安全响应头 / CSP / 同源校验 / CORS 白名单
// ============================================================
// 设计要点：
//   1. 前端与 API 同源（Workers Assets 直接服务 public/），跨域 CORS 不是刚需。
//      旧实现把请求的 Origin 原样反射给任意站点 + Allow-Credentials: true，
//      等于对全网开放带 Cookie 的读权限；现改为**白名单**（默认只有自身源）。
//   2. 写操作（非 GET/HEAD/OPTIONS）做 Origin/Referer 同源校验，与 SameSite
//      形成双保险（Cookie 属性由统一认证平台下发，本站无法完全控制）。
//   3. 统一注入安全响应头（CSP 用内联脚本哈希而非 'unsafe-inline'，
//      即使将来出现 HTML 注入也无法执行内联脚本）。

import { createMiddleware } from 'hono/factory';
import type { Env, Vars } from '../types';

/** 内联主题初始化脚本的 sha256（public/*.html 全部一致）。
 *  改动 HTML 里的 <script> 后必须重新计算：`npm run csp:hash` */
export const INLINE_SCRIPT_HASHES = [
  "'sha256-qPZnaYwLA6xkpIBdFgmYp5t/5veuOUmtWw+9EaGfaxY='",
];

const CSP_DIRECTIVES: Record<string, string[]> = {
  'default-src': ["'self'"],
  'base-uri': ["'self'"],
  'object-src': ["'none'"],
  'frame-ancestors': ["'none'"],
  'form-action': ["'self'", 'https://auth.yuer6327.top'],
  // 导出用的 docx / pdf-lib / fontkit 走 jsdmirror CDN（export.js 动态加载）
  'script-src': ["'self'", ...INLINE_SCRIPT_HASHES, 'https://cdn.jsdmirror.com'],
  // 全站大量内联 style 属性与动态 style，无法用哈希穷举
  'style-src': ["'self'", "'unsafe-inline'"],
  // 图片：本地、data URL（题目/手写稿）、blob:（压缩前的预览）、站点图标
  'img-src': ["'self'", 'data:', 'blob:', 'https://blog.yuer6327.top'],
  'font-src': ["'self'", 'data:'],
  // connect：同源 API + CDN（PDF 中文字体是 fetch 抓的 arraybuffer）
  'connect-src': ["'self'", 'https://cdn.jsdmirror.com'],
  'manifest-src': ["'self'"],
  'upgrade-insecure-requests': [],
};

const CSP = Object.entries(CSP_DIRECTIVES)
  .map(([k, v]) => (v.length ? `${k} ${v.join(' ')}` : k))
  .join('; ');

/** 所有响应统一注入的静态安全头（已存在的头不覆盖，便于下游自定义） */
const BASE_HEADERS: Record<string, string> = {
  'Content-Security-Policy': CSP,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** FRONTEND_ORIGIN（逗号分隔）→ 允许来源列表；`*` 视为"无跨域需求"（仅同源） */
export function allowedOrigins(env: Env): string[] {
  return (env.FRONTEND_ORIGIN || '')
    .split(',')
    .map(s => s.trim().replace(/\/+$/, ''))
    .filter(s => !!s && s !== '*');
}

function requestOrigin(c: { req: { url: string } }): string {
  try {
    return new URL(c.req.url).origin;
  } catch {
    return '';
  }
}

// ── 1. 安全响应头（包住所有响应，含静态资源）──
export const withSecurityHeaders = createMiddleware<{ Bindings: Env; Variables: Vars }>(async (c, next) => {
  await next();
  const res = c.res;
  if (!res) return;
  const headers = new Headers(res.headers);
  // Headers 构造时会把多条 Set-Cookie 合并成一个逗号串，重建响应前必须逐条还原
  const getSetCookie = (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === 'function') {
    const cookies = getSetCookie.call(res.headers);
    if (cookies.length) {
      headers.delete('set-cookie');
      for (const cookie of cookies) headers.append('set-cookie', cookie);
    }
  }
  for (const [name, value] of Object.entries(BASE_HEADERS)) {
    // X-Frame-Options 强制覆盖：Workers Assets 会自带 SAMEORIGIN，按「缺失才补」的
    // 通用规则我们的 DENY 会被它顶掉（生产实测）。本站无同源 iframe 需求，DENY 更严。
    if (name === 'X-Frame-Options' || !headers.has(name)) headers.set(name, value);
  }
  // 204/304 不允许带 body，其余原样透传（含流式响应）
  c.res = new Response(res.status === 204 || res.status === 304 ? null : res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
});

// ── 2. CORS：白名单反射（不再对任意 Origin 开口）──
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const corsMiddleware = createMiddleware<{ Bindings: Env; Variables: Vars }>(async (c, next) => {
  const reqOrigin = c.req.header('origin');
  const self = requestOrigin(c);
  const allow = allowedOrigins(c.env);

  // 带 Origin 的响应必须声明 Vary，避免边缘/浏览器缓存串源
  c.header('Vary', reqOrigin ? 'Origin, Accept-Encoding' : 'Accept-Encoding');

  if (reqOrigin && (reqOrigin === self || allow.includes(reqOrigin))) {
    c.header('Access-Control-Allow-Origin', reqOrigin);
    c.header('Access-Control-Allow-Credentials', 'true');
    c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    c.header('Access-Control-Allow-Headers', 'Content-Type');
    c.header('Access-Control-Max-Age', '600');
  }
  // 未命中白名单：不下发 ACAO，浏览器自行拦截（不反射、不返回 5xx）

  if (c.req.method === 'OPTIONS') return c.body(null, 204);
  await next();
});

// ── 3. 写操作同源校验（CSRF 纵深防御）──
// 无 Origin / Referer 的请求（curl、服务端到服务端）放行：
// 认证依旧依赖会话 Cookie，此类请求本身不携带浏览器凭据。
export const sameOriginGuard = createMiddleware<{ Bindings: Env; Variables: Vars }>(async (c, next) => {
  if (SAFE_METHODS.has(c.req.method)) return next();

  const self = requestOrigin(c);
  const allow = allowedOrigins(c.env);
  let source = c.req.header('origin') || '';
  if (!source) {
    const referer = c.req.header('referer');
    if (referer) {
      try { source = new URL(referer).origin; } catch { source = ''; }
    }
  }
  if (source && source !== self && !allow.includes(source)) {
    console.warn(`[security] 跨源写请求被拒绝: ${c.req.method} ${c.req.path} ← ${source}`);
    return c.json({ error: '请求来源不被允许' }, 403);
  }
  await next();
});
