// ============================================================
// routes/auth.ts — 当前用户信息（统一认证）+ 游客会话
// ============================================================
// 登录/注册/退出已上移到统一认证平台 https://auth.yuer6327.top：
//   登录：https://auth.yuer6327.top/login?next=<回跳地址>
//   注册：https://auth.yuer6327.top/register?next=<回跳地址>
//   退出：https://auth.yuer6327.top/logout?next=<回跳地址>
// 本地不再有登录/注册接口；会话校验见 middleware/auth.ts。
//
// GET /me 用 userMiddleware：未登录不返回 401，而是 200 + logged_in:false，
// 前端据此渲染游客模式（否则每个游客进来就被弹去登录页）。
// ============================================================

import { Hono } from 'hono';
import type { Env, Vars } from '../types';
import { userMiddleware } from '../middleware/auth';
import { wallet } from '../utils/billing';
import { quotaState } from '../utils/quota';

const auth = new Hono<{ Bindings: Env; Variables: Vars }>();

// ── 当前会话（前端 requireAuth / 游客模式判定；配额状态一并返回）──
auth.get('/me', userMiddleware, async (c) => {
  const userId = c.get('userId');
  const isGuest = c.get('isGuest');

  let quota = null;
  try {
    quota = await quotaState(c.env.DB, userId, isGuest);
  } catch (err) {
    console.error('[auth/me] 配额查询失败（降级为 null）:', err instanceof Error ? err.message : err);
  }

  if (isGuest) {
    return c.json({ logged_in: false, id: userId, guest: true, quota });
  }

  let balance: number | null = null;
  try {
    balance = (await wallet(c.env, userId)).balance;
  } catch (err) {
    console.error('[auth/me] 钱包查询失败（降级为 null）:', err instanceof Error ? err.message : err);
  }
  return c.json({
    logged_in: true,
    id: userId,
    username: c.get('username'),
    role: c.get('role'),
    wallet: { balance },
    quota,
  });
});

// ── dev-only：本地浏览器 UI 联调用测试会话 ──
// 门禁：必须显式开启 ENABLE_DEV_SESSION=1（只写在 gitignored 的 .dev.vars 里，
// 生产 Worker 永不配置该变量）；不用 Host 判断——wrangler dev 会把
// 请求 URL/Host 重写成 routes 里的生产域名，按 Host 反而会误杀本地联调。
// 2026-11-07 起 AUTH_DB 直查已收回：无法再本地验"会话行存在"，改为直接发固定
// 测试 cookie `s=test-cookie-1`——该值是否有效由会话校验端（auth dev 或本地
// stub 的 /internal/validate）决定，stub 侧应放行 test-cookie-1 / test-cookie-2。
auth.get('/dev-session', async (c) => {
  if ((c.env.ENABLE_DEV_SESSION || '') !== '1') return c.json({ error: 'not found' }, 404);
  // Secure 属性照加：浏览器把 localhost/127.0.0.1 视为可信源，http 下也收 Secure cookie
  // （Chrome 89+ / Firefox 84+；wrangler dev 默认即 localhost）。唯一代价是经局域网 IP
  // 的 http 访问会拒收——本地 UI 联调不走该路径，属预期收紧而非回归。
  return c.json({ ok: true }, 200, {
    'Set-Cookie': 's=test-cookie-1; Path=/; HttpOnly; SameSite=Lax; Secure',
  });
});

export default auth;
