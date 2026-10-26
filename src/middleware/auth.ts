// ============================================================
// middleware/auth.ts — 会话校验（统一认证）＋ 游客身份
// ============================================================
// 本站不自建账户：登录/注册跳转 auth.yuer6327.top，会话 cookie 名为 s
// （HttpOnly，同根域共享）。校验方式与 Mathle（wordle.yuer6327.top）一致：
// sha256(cookie 值) 直查平台 auth-db 的 sessions 表。
//
// 两个中间件：
//   authMiddleware  — 必须登录（设置页/提示词/计费/精修润色）
//   userMiddleware  — 登录或游客（作文 CRUD / 批改 / OCR）
// 游客身份 = 本域 cookie `wg`（随机 32 hex，HttpOnly，90 天），
// user_id 记为 `guest:<id>`，与真实 UUID 天然不冲突、数据互不可见。
// 登录后首次请求会把该设备名下的游客数据静默接管到账号下。
// ============================================================

import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env, Vars } from '../types';

const GUEST_COOKIE = 'wg';
const GUEST_TTL_S = 90 * 24 * 3600;
const GUEST_ID_RE = /^[a-f0-9]{16,64}$/i;

type Ctx = Context<{ Bindings: Env; Variables: Vars }>;

const enc = new TextEncoder();

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

interface SessionRow { id: string; username: string | null; name: string; role: string }

type SessionResult =
  | { kind: 'ok'; row: SessionRow }
  | { kind: 'none' }
  | { kind: 'error' };

async function resolveSession(c: Ctx): Promise<SessionResult> {
  const m = (c.req.header('cookie') || '').match(/(?:^|;\s*)s=([A-Za-z0-9_-]+)/);
  if (!m) return { kind: 'none' };
  try {
    const row = await c.env.AUTH_DB.prepare(
      `SELECT u.id, u.username, u.name, u.role FROM sessions s
        JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ? AND u.banned = 0`,
    ).bind(await sha256Hex(m[1]), Date.now()).first<SessionRow>();
    return row ? { kind: 'ok', row } : { kind: 'none' };
  } catch (err) {
    console.error('[auth] 查询 auth-db 失败:', err instanceof Error ? err.message : err);
    return { kind: 'error' };
  }
}

function setGuestCookie(c: Ctx, id: string): void {
  // wrangler dev 会把 URL 重写成生产域名，但本地仍走 http；Secure 仅在 https 下加
  let secure = false;
  try { secure = new URL(c.req.url).protocol === 'https:'; } catch { /* 忽略 */ }
  setCookie(c, GUEST_COOKIE, id, {
    path: '/', httpOnly: true, sameSite: 'Lax', maxAge: GUEST_TTL_S, secure,
  });
}

function ensureGuestId(c: Ctx): string {
  const existing = getCookie(c, GUEST_COOKIE);
  if (existing && GUEST_ID_RE.test(existing)) return existing;
  const id = crypto.randomUUID().replace(/-/g, '');
  setGuestCookie(c, id);
  return id;
}

/**
 * 登录后接管本设备的游客数据（作文/稿件/批改/精修）。
 * 只在 cookie 存在时触发，成本 = 1 次 count；无数据仅清 cookie。
 * 先迁移再清 cookie：迁移失败时保留 cookie，下次请求可重试。
 */
async function takeoverGuestData(c: Ctx, userId: string): Promise<void> {
  const gid = getCookie(c, GUEST_COOKIE);
  if (!gid || !GUEST_ID_RE.test(gid)) return;
  const scope = `guest:${gid}`;
  try {
    const cnt = await c.env.DB.prepare(
      'SELECT COUNT(*) AS n FROM essays WHERE user_id = ?',
    ).bind(scope).first<{ n: number }>();
    if ((cnt?.n ?? 0) > 0) {
      const db = c.env.DB;
      await db.batch([
        db.prepare('UPDATE essays   SET user_id = ? WHERE user_id = ?').bind(userId, scope),
        db.prepare('UPDATE drafts   SET user_id = ? WHERE user_id = ?').bind(userId, scope),
        db.prepare('UPDATE reviews  SET user_id = ? WHERE user_id = ?').bind(userId, scope),
        db.prepare('UPDATE polishes SET user_id = ? WHERE user_id = ?').bind(userId, scope),
      ]);
      console.log(`[auth] 已接管游客数据 ${scope} → ${userId}（${cnt?.n} 篇作文）`);
    }
    deleteCookie(c, GUEST_COOKIE, { path: '/' });
  } catch (err) {
    // 接管失败不阻塞登录：保留 cookie，下次请求重试
    console.error('[auth] 游客数据接管失败:', err instanceof Error ? err.message : err);
  }
}

function bindMember(c: Ctx, row: SessionRow): void {
  c.set('userId', row.id);
  c.set('username', row.username || row.name || `user_${row.id.slice(0, 8)}`);
  c.set('role', row.role || 'user');
  c.set('isGuest', false);
}

function bindGuest(c: Ctx): void {
  const id = ensureGuestId(c);
  c.set('userId', `guest:${id}`);
  c.set('username', '游客');
  c.set('role', 'guest');
  c.set('isGuest', true);
}

/** 需要登录的路由挂载此中间件（401 由前端跳统一认证） */
export const authMiddleware = createMiddleware<{ Bindings: Env; Variables: Vars }>(async (c, next) => {
  const s = await resolveSession(c);
  if (s.kind === 'error') return c.json({ error: '认证服务暂不可用，请稍后重试' }, 503);
  if (s.kind === 'none') return c.json({ error: '未登录', code: 'login_required' }, 401);

  bindMember(c, s.row);
  await takeoverGuestData(c, s.row.id);
  await next();
});

/** 登录或游客均可访问的路由（游客会在响应里拿到 wg cookie） */
export const userMiddleware = createMiddleware<{ Bindings: Env; Variables: Vars }>(async (c, next) => {
  const s = await resolveSession(c);
  if (s.kind === 'error') return c.json({ error: '认证服务暂不可用，请稍后重试' }, 503);

  if (s.kind === 'ok') {
    bindMember(c, s.row);
    await takeoverGuestData(c, s.row.id);
  } else {
    bindGuest(c);
  }
  await next();
});
