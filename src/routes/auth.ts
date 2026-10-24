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

const auth = new Hono<{ Bindings: Env; Variables: Vars }>();

// ── 当前用户信息（前端 requireAuth 用）──
auth.get('/me', authMiddleware, async (c) => {
  return c.json({ id: c.get('userId'), username: c.get('username') });
});

export default auth;
