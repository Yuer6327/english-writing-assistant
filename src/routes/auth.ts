// ============================================================
// routes/auth.ts — 当前用户信息（统一认证）
// ============================================================
// 登录/注册/退出已上移到统一认证平台 https://auth.yuer6327.top：
//   登录：https://auth.yuer6327.top/login?next=<回跳地址>
//   注册：https://auth.yuer6327.top/register?next=<回跳地址>
//   退出：https://auth.yuer6327.top/logout?next=<回跳地址>
// 本地不再有登录/注册接口；会话校验见 middleware/auth.ts。

import { Hono } from 'hono';
import type { Env, Vars } from '../types';
import { authMiddleware } from '../middleware/auth';
import { wallet } from '../utils/billing';

const auth = new Hono<{ Bindings: Env; Variables: Vars }>();

// ── 当前用户信息（前端 requireAuth 用；附带钱包余额，失败降级不阻塞登录态）──
auth.get('/me', authMiddleware, async (c) => {
  let balance: number | null = null;
  try {
    balance = (await wallet(c.env, c.get('userId'))).balance;
  } catch (err) {
    console.error('[auth/me] 钱包查询失败（降级为 null）:', err instanceof Error ? err.message : err);
  }
  return c.json({
    id: c.get('userId'),
    username: c.get('username'),
    role: c.get('role'),
    wallet: { balance },
  });
});

// ── dev-only：本地浏览器 UI 联调用测试会话。安全保证是动态自证的——
//    仅当 AUTH_DB 里真的存在这条测试会话（sha256('test-cookie-1'））才发 Set-Cookie；
//    该会话只存在于本地 auth-db 副本（scripts 种入），生产库不存在 → 生产必 404。──
auth.get('/dev-session', async (c) => {
  const enc = new TextEncoder();
  const d = await crypto.subtle.digest('SHA-256', enc.encode('test-cookie-1'));
  const hash = [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
  const row = await c.env.AUTH_DB.prepare('SELECT 1 AS x FROM sessions WHERE token_hash = ?').bind(hash).first();
  if (!row) return c.json({ error: 'not found' }, 404);
  return c.json({ ok: true }, 200, { 'Set-Cookie': 's=test-cookie-1; Path=/; SameSite=Lax' });
});

export default auth;
