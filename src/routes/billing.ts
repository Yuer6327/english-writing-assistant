// ============================================================
// routes/billing.ts — 计费平台面向用户的路由（挂 /api/billing）
//   GET  /me                 余额 / 免费额度 / 近期用量
//   POST /redeem             兑换码充值（强限流：5 次/分、20 次/日/用户）
//   GET  /usage?limit=50     用量 + 账单合并视图
//   /admin/*                 管理组（role==='admin'）：送分 / 查询 / 标签 /
//                            兑换码 / 订单 / 用量 / BYOK 一次性迁移
// ============================================================

import { Hono } from 'hono';
import type { Env, Vars } from '../types';
import { authMiddleware } from '../middleware/auth';
import { rateLimitHit } from '../utils/rate-limit';
import { decryptApiKey } from '../utils/crypto';
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

// ── 管理组（统一认证 role==='admin'）──
const admin = new Hono<{ Bindings: Env; Variables: Vars }>();
admin.use('*', authMiddleware, async (c, next) => {
  if (c.get('role') !== 'admin') return c.json({ error: '无权限' }, 403);
  await next();
});

/** 用户名 → 统一认证 userId（auth-db 只读） */
async function userIdByUsername(env: Env, username: string): Promise<string | null> {
  const row = await env.AUTH_DB.prepare('SELECT id FROM users WHERE username = ?')
    .bind(username.trim()).first<{ id: string }>();
  return row?.id ?? null;
}

admin.post('/gift', async (c) => {
  const body = ((await c.req.json<{ username?: string; points_yuan?: number; note?: string }>().catch(() => null)) ?? ({} as any));
  if (!body.username?.trim()) return c.json({ error: '请输入用户名' }, 400);
  const points = Math.round((Number(body.points_yuan) || 0) * 10000);
  // 单笔上界 100 万元（1e10 微积分）：1e300 级输入会落成 SQLite REAL（实测账实核对失明）
  if (!Number.isFinite(points) || points === 0 || Math.abs(points) > 1e10) return c.json({ error: '积分需为非零数值且单笔 ≤ 100 万元' }, 400);

  const userId = await userIdByUsername(c.env, body.username);
  if (!userId) return c.json({ error: `用户不存在：${body.username}` }, 404);

  try {
    // operator 取会话身份，绝不采信请求体——资金操作的不可抵赖审计锚点
    const r = await billing.adminGift(c.env, userId, points, body.note?.trim().slice(0, 200) || undefined, c.get('userId'));
    return c.json(r);
  } catch (err) {
    if (err instanceof billing.BillingError) return c.json({ error: err.message }, err.status as 400);
    return c.json({ error: '计费服务暂不可用' }, 503);
  }
});

admin.get('/user/:username', async (c) => {
  const userId = await userIdByUsername(c.env, c.req.param('username'));
  if (!userId) return c.json({ error: '用户不存在' }, 404);
  try {
    return c.json(await billing.adminUser(c.env, userId));
  } catch (err) {
    if (err instanceof billing.BillingError) return c.json({ error: err.message }, err.status as 500);
    return c.json({ error: '计费服务暂不可用' }, 503);
  }
});

admin.post('/tags', async (c) => {
  const body = ((await c.req.json<{ username?: string; add?: string[]; remove?: string[] }>().catch(() => null)) ?? ({} as any));
  if (!body.username?.trim()) return c.json({ error: '请输入用户名' }, 400);
  const userId = await userIdByUsername(c.env, body.username);
  if (!userId) return c.json({ error: `用户不存在：${body.username}` }, 404);
  try {
    const clean = (arr: unknown): string[] => (Array.isArray(arr) ? arr : [])
      .filter(x => typeof x === 'string' && x.trim())
      .slice(0, 10)
      .map(x => (x as string).trim().slice(0, 50));
    return c.json(await billing.adminTags(c.env, userId, clean(body.add), clean(body.remove)));
  } catch (err) {
    if (err instanceof billing.BillingError) return c.json({ error: err.message }, err.status as 400);
    return c.json({ error: '计费服务暂不可用' }, 503);
  }
});

admin.post('/codes', async (c) => {
  const body = ((await c.req.json<{ points_yuan?: number; count?: number; batch?: string }>().catch(() => null)) ?? ({} as any));
  const points = Math.round((Number(body.points_yuan) || 0) * 10000);
  // 单笔上界 100 万元（1e10 微积分）
  if (!Number.isFinite(points) || points <= 0 || points > 1e10) return c.json({ error: '面额需为正数且单笔 ≤ 100 万元' }, 400);

  const count = Math.max(1, Math.min(200, Number(body.count) || 1));
  try {
    return c.json(await billing.adminCodes(c.env, points, count, body.batch?.trim().slice(0, 60) || undefined, c.get('userId')));
  } catch (err) {
    if (err instanceof billing.BillingError) return c.json({ error: err.message }, err.status as 400);
    return c.json({ error: '计费服务暂不可用' }, 503);
  }
});

admin.post('/orders/manual', async (c) => {
  const body = ((await c.req.json<{ username?: string; points_yuan?: number; note?: string }>().catch(() => null)) ?? ({} as any));
  if (!body.username?.trim()) return c.json({ error: '请输入用户名' }, 400);
  const points = Math.round((Number(body.points_yuan) || 0) * 10000);
  if (!Number.isFinite(points) || points <= 0 || points > 1e10) return c.json({ error: '积分需为正数且单笔 ≤ 100 万元' }, 400);
  const userId = await userIdByUsername(c.env, body.username);
  if (!userId) return c.json({ error: `用户不存在：${body.username}` }, 404);
  try {
    return c.json(await billing.adminManualOrder(c.env, userId, points, body.note?.trim().slice(0, 200) || undefined, c.get('userId')));
  } catch (err) {
    if (err instanceof billing.BillingError) return c.json({ error: err.message }, err.status as 400);
    return c.json({ error: '计费服务暂不可用' }, 503);
  }
});

admin.get('/orders', async (c) => {
  const limit = Math.min(200, parseInt(c.req.query('limit') || '50', 10) || 50);
  try {
    return c.json(await billing.adminOrders(c.env, limit));
  } catch (err) {
    return c.json({ error: '计费服务暂不可用' }, 503);
  }
});

admin.get('/usage', async (c) => {
  const username = c.req.query('username')?.trim();
  let userId: string | undefined;
  if (username) {
    userId = (await userIdByUsername(c.env, username)) ?? undefined;
    if (!userId) return c.json({ error: `用户不存在：${username}` }, 404);
  }
  const limit = Math.min(200, parseInt(c.req.query('limit') || '50', 10) || 50);
  try {
    return c.json(await billing.adminUsage(c.env, userId, limit));
  } catch (err) {
    return c.json({ error: '计费服务暂不可用' }, 503);
  }
});

// ── BYOK 一次性迁移：essay api_keys（byok 行）→ billing 重新加密托管 ──
admin.post('/migrate-byok', async (c) => {
  interface ApiKeyRow {
    user_id: string; provider: string; encrypted_key: string;
    api_base_url: string; model_name: string;
    vision_api_base_url: string | null; vision_model_name: string | null; vision_encrypted_key: string | null;
  }
  const rows = (await c.env.DB.prepare(
    `SELECT user_id, provider, encrypted_key, api_base_url, model_name,
            vision_api_base_url, vision_model_name, vision_encrypted_key
     FROM api_keys`,
  ).all<ApiKeyRow>()).results;

  let migrated = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.provider !== 'byok') { skipped++; continue; }   // agnes 行无需记录（免费车道固定）
    try {
      const key = await decryptApiKey(row.encrypted_key, c.env.ENCRYPTION_KEY);
      const visionKey = row.vision_encrypted_key
        ? await decryptApiKey(row.vision_encrypted_key, c.env.ENCRYPTION_KEY)
        : undefined;
      await billing.adminByokSet(c.env, row.user_id, {
        key,
        baseUrl: row.api_base_url,
        model: row.model_name,
        visionKey,
        visionBaseUrl: row.vision_api_base_url ?? undefined,
        visionModel: row.vision_model_name ?? undefined,
      });
      migrated++;
    } catch (err) {
      failed++;
      console.error(`[migrate-byok] 用户 ${row.user_id} 迁移失败:`, err instanceof Error ? err.message : err);
    }
  }
  return c.json({ source_rows: rows.length, migrated, skipped, failed });
});

billingRoutes.route('/admin', admin);

export default billingRoutes;
