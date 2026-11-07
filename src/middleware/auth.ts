// ============================================================
// middleware/auth.ts — 会话校验（统一认证）＋ 游客身份
// ============================================================
// 本站不自建账户：登录/注册跳转 auth.yuer6327.top，会话 cookie 名为 s
// （HttpOnly，同根域共享）。
//
// 校验方式（2026-11-07 信任模型收敛 S1 后）：不再直查 auth-db（AUTH_DB 绑定
// 已收回——消费方持整库读写权等于任一子域沦陷即可改 role/删会话），改为调
// auth 平台的 POST /internal/validate（Service Binding，仅内网可达）：
//   请求：{"s":"<原始 cookie 值>"} + 头 X-Internal-Token: <AUTH_VALIDATE_TOKEN>
//   200：{"v":1,"valid":true,"user":{"id","username","name","role","banned","expiresAt"}}
//        或 {"v":1,"valid":false}
//   401：调用方令牌错（本仓配置问题）；503：auth 库异常
//
// 会话缓存：valid 结果按 sha256(s) isolate 内存缓存 60s（不留存原文，见下），
// 上限 1000 条超限逐出最旧一半（保留近期会话命中，不做全量 clear 放大回源）；
// valid:false 不缓存（登录成功立即可见）。
// 封禁/登出的生效延迟 = 缓存 TTL（≤60s），信任模型收敛的既定取舍。
//
// 降级语义（auth 平台不可达时）：
//   · userMiddleware（登录或游客路由）——无 s cookie 直接游客（不发起调用）；
//     valid:false → 游客；网络/5xx/401 等任何 auth 异常 → 按游客放行
//     （fail-open 仅限本来允许游客的路由：游客本来就不依赖登录态）；
//   · authMiddleware（必须登录路由）——任何 auth 异常 → 503 fail-closed
//     （不能把"认证服务挂了"当成"未登录"放行受保护操作）。
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

// ── validate 客户端 + 会话缓存 ──

/** auth /internal/validate 返回的用户形状（契约 v1） */
interface AuthUser {
  id: string;
  username: string | null;
  name: string;
  role: string;
  banned?: number | boolean;
  expiresAt?: number | string;
}

/** 缓存键 = sha256(原始 cookie 值)：isolate 内存不留存 cookie 原文，
 *  泄漏内存快照也只能拿到哈希（与 auth 库 token_hash 同一单向口径）。 */
const sessionCache = new Map<string, { at: number; user: AuthUser }>();
const SESSION_CACHE_TTL_MS = 60_000;
const SESSION_CACHE_MAX = 1000;
// validate 调用时间预算（W2）：auth hang 不能原样拖住受保护请求——3s 不回即按
// error 降级（authMiddleware 503 fail-closed / userMiddleware 游客放行）
const VALIDATE_TIMEOUT_MS = 3000;
// 契约 v1 用户 id 形状（W1）：UUID / 短横线 id 皆匹配；防数组/对象 id 进入 D1 bind
const USER_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

type SessionResult =
  | { kind: 'ok'; row: AuthUser }
  | { kind: 'none' }
  | { kind: 'error' };

// 缺失口令的一次性告警（P3 审计）：types.ts 把 AUTH_VALIDATE_TOKEN 声明为必填，
// 但运行时（.dev.vars 漏配/secret 忘配）缺失只会让每次 validate 都 401——登录路由
// 静默全站 503、游客路由静默降级，无任何日志可查。这里在首次实际使用时检测并
// console.error 一次（模块级标志防每请求刷屏；Workers 的 env 按请求注入，模块加载期拿不到）。
let authValidateTokenWarned = false;

/** W1 形状防御：valid:true 时 user 必须满足契约 v1，任一字段不合规按 auth 异常降级
 *  （authMiddleware 503 / userMiddleware 游客），绝不把漂移响应当成登录态放行。
 *  返回 null = 合规；返回字符串 = 不合规原因（仅记日志，不含 s 值）。
 *  注：banned 真实 auth 返回 D1 整数（恒 0，SQL 已滤 banned=0）；boolean 与 0/1 均合规，
 *  其余类型或缺失不合规（缺失不能静默视为 false——契约漂移必须显式暴露）。 */
function userShapeError(u: any): string | null {
  if (!u || typeof u !== 'object' || Array.isArray(u)) return 'user 缺失或非对象';
  if (typeof u.id !== 'string' || !USER_ID_RE.test(u.id)) return 'user.id 非 string 或越界（数组 id 不得进入 D1 bind）';
  if (typeof u.role !== 'string') return 'user.role 非 string';
  if (!(typeof u.banned === 'boolean' || (typeof u.banned === 'number' && (u.banned === 0 || u.banned === 1)))) {
    return 'user.banned 非 boolean/0/1 或缺失';
  }
  if (!(u.username === null || typeof u.username === 'string')) return 'user.username 非 string/null';
  if (!(u.name === null || typeof u.name === 'string')) return 'user.name 非 string/null';
  return null;
}

async function validateSession(c: Ctx, rawCookie: string): Promise<SessionResult> {
  const key = await sha256Hex(rawCookie);
  const hit = sessionCache.get(key);
  if (hit && Date.now() - hit.at < SESSION_CACHE_TTL_MS) {
    return { kind: 'ok', row: hit.user };
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (c.env.AUTH_VALIDATE_TOKEN) headers['X-Internal-Token'] = c.env.AUTH_VALIDATE_TOKEN;
  else if (!authValidateTokenWarned) {
    authValidateTokenWarned = true;
    console.error('[auth] AUTH_VALIDATE_TOKEN missing — all authenticated routes will 503');
  }
  const body = JSON.stringify({ s: rawCookie });
  let resp: Response;
  try {
    // 本地开发回退（与 billing 的 DEV_BILLING_URL 同款双门禁）：auth dev 未就绪时
    // 把 validate 指向本地 stub（scripts/security 下有现成 mock 思路）。生产两个
    // 变量都不配置，恒走 Service Binding。
    const devDirect = (c.env.ENABLE_DEV_SESSION || '') === '1' && !!c.env.DEV_AUTH_URL;
    resp = devDirect
      ? await fetch((c.env.DEV_AUTH_URL as string).replace(/\/$/, '') + '/internal/validate', { method: 'POST', headers, body, signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS) })
      : await c.env.AUTH.fetch('https://auth/internal/validate', { method: 'POST', headers, body, signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS) });
  } catch (err) {
    console.error('[auth] AUTH.fetch 异常:', err instanceof Error ? err.message : err);
    return { kind: 'error' };
  }
  if (!resp.ok) {
    // 401 = 我方令牌错（配置问题）、503 = auth 库异常——对消费方统一按"auth 不可用"处理，
    // 由中间件按路由性质降级（游客放行 / 503 fail-closed）
    console.error('[auth] validate 非 2xx:', resp.status);
    return { kind: 'error' };
  }
  const data: any = await resp.json().catch(() => null);
  // 契约形状防御：v/valid 缺失视为 auth 侧异常（契约漂移不能被静默当成"未登录"）
  if (!data || data.v !== 1 || typeof data.valid !== 'boolean') {
    console.error('[auth] validate 响应形状异常（契约漂移?）');
    return { kind: 'error' };
  }
  // W1：valid:true 时 user 形状二次防御——id 越界/数组、role 非 string、banned 缺失或
  // 非布尔/0/1、username/name 非 string|null 都按 auth 异常降级（503/游客），不进缓存
  if (data.valid) {
    const shapeErr = userShapeError(data.user);
    if (shapeErr) {
      console.error('[auth] validate user 形状不合规（契约漂移?）:', shapeErr);
      return { kind: 'error' };
    }
  }
  // valid:false 或 banned → 未登录态（不缓存：封禁解除/重新登录后下一次请求立即可见）
  if (!data.valid || !data.user || data.user.banned) return { kind: 'none' };
  // W3：缓存满不再全量 clear（会把近期热会话一并逐出、放大 auth 回源）——
  // Map 迭代序=插入序，逐出最旧一半，其余保持命中
  if (sessionCache.size >= SESSION_CACHE_MAX) {
    let evicted = 0;
    for (const k of sessionCache.keys()) {
      sessionCache.delete(k);
      if (++evicted >= SESSION_CACHE_MAX / 2) break;
    }
  }
  sessionCache.set(key, { at: Date.now(), user: data.user });
  return { kind: 'ok', row: data.user };
}

/** 从 Cookie 头取【最后一个】s=：浏览器按 cookie path 长度排序发送，若同名 cookie 被植入
 *  （兄弟子域/可注入 cookie 的向量），窄 path 的会在前面遮蔽真会话；
 *  取最后匹配与 Hono getCookie 语义一致（后写者优先），不依赖排序。 */
function extractSessionCookie(c: Ctx): string | null {
  const matches = [...(c.req.header('cookie') || '').matchAll(/(?:^|;\s*)s=([A-Za-z0-9_-]+)/g)];
  const m = matches[matches.length - 1];
  return m ? m[1] : null;
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
    // user_flags 一并接管（2026-11-06 审计）：游客期打上的 forced_harden / seeded 等标记
    // 不迁移会在登录后丢失（F3 累计硬化逃逸窗口）。OR IGNORE 保留成员已有标记。
    await c.env.DB.prepare(
      'INSERT OR IGNORE INTO user_flags (user_id, flag) SELECT ?, flag FROM user_flags WHERE user_id = ?',
    ).bind(userId, scope).run();
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

function bindMember(c: Ctx, row: AuthUser): void {
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

/** 需要登录的路由挂载此中间件（401 由前端跳统一认证）。
 *  fail-closed：auth 任何异常 → 503（绝不把"认证挂了"降级成"未登录"）。 */
export const authMiddleware = createMiddleware<{ Bindings: Env; Variables: Vars }>(async (c, next) => {
  const raw = extractSessionCookie(c);
  if (!raw) return c.json({ error: '未登录', code: 'login_required' }, 401);
  const s = await validateSession(c, raw);
  if (s.kind === 'error') return c.json({ error: '认证服务暂不可用，请稍后重试' }, 503);
  if (s.kind === 'none') return c.json({ error: '未登录', code: 'login_required' }, 401);

  bindMember(c, s.row);
  await takeoverGuestData(c, s.row.id);
  await next();
});

/** 登录或游客均可访问的路由（游客会在响应里拿到 wg cookie）。
 *  降级语义：无 s cookie 不发起 validate 调用直接游客；valid:false → 游客；
 *  auth 异常（网络/5xx/令牌错）→ 按游客放行（fail-open 仅限本来允许游客的路由）。 */
export const userMiddleware = createMiddleware<{ Bindings: Env; Variables: Vars }>(async (c, next) => {
  const raw = extractSessionCookie(c);
  if (raw) {
    const s = await validateSession(c, raw);
    if (s.kind === 'ok') {
      bindMember(c, s.row);
      await takeoverGuestData(c, s.row.id);
      await next();
      return;
    }
    // none（未登录/封禁）与 error（auth 不可用）都落到游客——本中间件挂载的路由
    // 全部允许游客使用，降级不会放大权限（游客能力集 ⊂ 登录能力集）
    if (s.kind === 'error') {
      console.error('[auth] auth 不可用，游客路由降级放行（fail-open）');
    }
  }
  bindGuest(c);
  await next();
});
