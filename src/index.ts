// ============================================================
// index.ts — Worker 入口：Hono app + 静态资源服务
// ============================================================

import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { trimTrailingSlash } from 'hono/trailing-slash';
import type { Env, Vars } from './types';
import { corsMiddleware, sameOriginGuard, withSecurityHeaders } from './middleware/security';

import authRoutes from './routes/auth';
import essayRoutes from './routes/essays';
import ocrRoutes from './routes/ocr';
import promptRoutes from './routes/prompts';
import settingsRoutes from './routes/settings';
import billingRoutes from './routes/billing';

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// ── 中间件（顺序即嵌套层级：安全头最外层，保证任何分支的响应都被覆盖）──
app.use('*', withSecurityHeaders);
app.use('/api/*', logger());
app.use('*', trimTrailingSlash());

// ── CORS（白名单）+ 写操作同源校验：只作用于 API ──
app.use('/api/*', async (c, next) => {
  c.header('Cache-Control', 'no-store');
  await next();
});
app.use('/api/*', corsMiddleware);
app.use('/api/*', sameOriginGuard);

// ── 请求体大小闸门：按 Content-Length 在入口拒绝（旧实现 6MB JSON 也会被完整解析后才截断）──
// /api/ocr 上限 14MB（3 张 ×4MB base64 + JSON 开销）；其余 API 2.5MB（题目 3 图前端压至 ≤300KB/张绰绰有余）
app.use('/api/*', async (c, next) => {
  const len = Number(c.req.header('content-length') || 0);
  const cap = c.req.path.startsWith('/api/ocr') ? 14 * 1024 * 1024 : 2.5 * 1024 * 1024;
  if (len > cap) return c.json({ error: '请求体过大', code: 'payload_too_large' }, 413);
  await next();
});

// ── API 路由 ──
app.route('/api/auth', authRoutes);
app.route('/api', essayRoutes);      // /api/essays..., /api/drafts...
app.route('/api/ocr', ocrRoutes);
app.route('/api/prompts', promptRoutes);
app.route('/api/settings', settingsRoutes);
app.route('/api/billing', billingRoutes);

// ── 健康检查 ──
app.get('/api/health', (c) => c.json({ status: 'ok', time: new Date().toISOString() }));

// ── 未知 API 路径：明确 404，避免落到静态资源层拿到 index.html ──
app.all('/api/*', (c) => c.json({ error: '接口不存在' }, 404));

// ── 静态资源服务（Workers Assets）──
// Hono 的路由不匹配时交给 assets 处理（SPA fallback 亦然）
app.all('*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
