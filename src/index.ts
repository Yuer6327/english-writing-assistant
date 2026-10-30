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
