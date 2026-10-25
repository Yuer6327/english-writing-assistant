// ============================================================
// index.ts — Worker 入口：Hono app + 静态资源服务
// ============================================================

import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { trimTrailingSlash } from 'hono/trailing-slash';
import type { Env, Vars } from './types';
import { authMiddleware } from './middleware/auth';

import authRoutes from './routes/auth';
import essayRoutes from './routes/essays';
import ocrRoutes from './routes/ocr';
import promptRoutes from './routes/prompts';
import settingsRoutes from './routes/settings';
import billingRoutes from './routes/billing';

const app = new Hono<{ Bindings: Env; Variables: Vars }>();

// ── 中间件 ──
app.use('*', logger());
app.use('*', trimTrailingSlash());

// ── CORS（如果前端单独部署到 Pages）──
app.use('/api/*', async (c, next) => {
  const origin = c.env.FRONTEND_ORIGIN === '*' ? c.req.header('Origin') || '*' : c.env.FRONTEND_ORIGIN;
  c.header('Access-Control-Allow-Origin', origin);
  c.header('Access-Control-Allow-Credentials', 'true');
  c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (c.req.method === 'OPTIONS') return new Response(null, { status: 204 });
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

// ── 静态资源服务（Workers Assets）──
// Hono 的路由不匹配时交给 assets 处理（SPA fallback 亦然）
app.all('*', async (c) => {
  return c.env.ASSETS.fetch(c.req.raw);
});

export default app;
