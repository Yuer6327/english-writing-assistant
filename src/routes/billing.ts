// ============================================================
// routes/billing.ts — 计费平台面向用户的路由（挂 /api/billing）
//   GET  /me                 余额 / 免费额度 / 近期用量
//   POST /redeem             兑换码充值（强限流：5 次/分、20 次/日/用户）
//   GET  /usage?limit=50     用量 + 账单合并视图（本人，只读）
//
// 管理代理 /admin/* 已整体删除（2026-11-07 信任模型收敛 S2）：per-caller
// 令牌拆分后 writing 只持 WRITING_INTERNAL_TOKEN，billing /admin/* 只收 auth
// 侧令牌，本仓无权调用。送分/标签/兑换码/订单/BYOK 迁移等管理入口迁
// 统一认证后台 https://auth.yuer6327.top/admin（待 auth 子代理产物核对）；
// 原 admin 组的 auth-db username 反查（AUTH_DB 直查）随之删除。
// ============================================================

import { Hono } from 'hono';
import type { Env, Vars } from '../types';
import { authMiddleware } from '../middleware/auth';
import { rateLimitHit } from '../utils/rate-limit';
import * as billing from '../utils/billing';

const billingRoutes = new Hono<{ Bindings: Env; Variables: Vars }>();

// ── 用户端点 ──

billingRoutes.get('/me', authMiddleware, async (c) => {
  const userId = c.get('userId');
  let overview: billing.BillingOverview;
  try {
    overview = await billing.overview(c.env, userId, 'writing');
  } catch (err) {
    // billing 不可用时不再抛未捕获异常（那样前端拿到 500 无从判断），统一 503
    console.error('[billing/me] 概览查询失败:', err instanceof Error ? err.message : err);
    return c.json({ error: '计费服务暂不可用，请稍后重试' }, 503);
  }
  let byok = { configured: false };
  try {
    byok = await billing.byokStatus(c.env, userId);
  } catch { /* 前端可用 settings status 兜底 */ }
  return c.json({ ...overview, byok_configured: byok.configured });
});

billingRoutes.post('/redeem', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const body = ((await c.req.json<{ code?: string }>().catch(() => null)) ?? ({} as any));
  const code = (typeof body.code === 'string' ? body.code : '').trim();
  if (!code) return c.json({ error: '请输入兑换码' }, 400);
  // 兑换码格式固定，限制长度避免超长串打到计费服务
  if (code.length > 64) return c.json({ error: '兑换码格式不正确' }, 400);

  // 强限流：5 次/分 + 20 次/日（按北京日期计）
  if (rateLimitHit(`redeem:m:${userId}`, 5, 60_000)) {
    return c.json({ error: '兑换过于频繁，请约 1 分钟后再试' }, 429);
  }
  const dayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  if (rateLimitHit(`redeem:d:${userId}:${dayKey}`, 20, 26 * 3600_000)) {
    return c.json({ error: '今日兑换次数已达上限（20 次），请明日再试' }, 429);
  }

  try {
    return c.json(await billing.redeem(c.env, userId, code));
  } catch (err) {
    if (err instanceof billing.BillingError) {
      return c.json({ error: err.message, code: err.code }, err.status as 404);
    }
    return c.json({ error: '兑换服务暂不可用，请稍后重试' }, 503);
  }
});

billingRoutes.get('/usage', authMiddleware, async (c) => {
  const userId = c.get('userId');
  // limit 钳到 [1,100]：负数直穿 SQLite 会变成「无 LIMIT」（旧实现实测 -5 返回全量）
  const limit = Math.max(1, Math.min(100, parseInt(c.req.query('limit') || '50', 10) || 50));
  try {
    return c.json(await billing.usageView(c.env, userId, limit));
  } catch (err) {
    if (err instanceof billing.BillingError) {
      return c.json({ error: err.message }, err.status as 500);
    }
    return c.json({ error: '计费服务暂不可用' }, 503);
  }
});

export default billingRoutes;
