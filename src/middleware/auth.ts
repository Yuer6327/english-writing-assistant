// ============================================================
// middleware/auth.ts — 统一认证会话校验（auth.yuer6327.top）
// ============================================================
// 本站不自建账户：登录/注册跳转 auth.yuer6327.top，会话 cookie 名为 s
// （HttpOnly，同根域共享）。校验方式与 Mathle（wordle.yuer6327.top）一致：
// sha256(cookie 值) 直查平台 auth-db 的 sessions 表。

import { createMiddleware } from 'hono/factory';
import type { Env, Vars } from '../types';

const enc = new TextEncoder();

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** 需要登录的路由挂载此中间件 */
export const authMiddleware = createMiddleware<{ Bindings: Env; Variables: Vars }>(async (c, next) => {
  const m = (c.req.header('cookie') || '').match(/(?:^|;\s*)s=([A-Za-z0-9_-]+)/);
  if (!m) return c.json({ error: '未登录' }, 401);

  let row: { id: string; username: string | null; name: string; role: string } | null = null;
  try {
    row = await c.env.AUTH_DB.prepare(
      `SELECT u.id, u.username, u.name, u.role FROM sessions s
        JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.banned = 0`,
    ).bind(await sha256Hex(m[1]), Date.now()).first();
  } catch (err) {
    console.error('[auth] 查询 auth-db 失败:', err instanceof Error ? err.message : err);
    return c.json({ error: '认证服务暂不可用，请稍后重试' }, 503);
  }
  if (!row) return c.json({ error: '登录已过期，请重新登录' }, 401);

  c.set('userId', row.id);
  c.set('username', row.username || row.name || `user_${row.id.slice(0, 8)}`);
  await next();
});
