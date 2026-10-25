// ============================================================
// rate-limit.ts — 极简内存滑动窗口限流
// 用于：注册/登录防爆破、AI 调用防单个账户耗尽共享 Agnes 免费额度。
// 说明：Workers 多 isolate 下为"按实例"的近似保护（每个 isolate 各计数一份），
//       但配合 Cloudflare 边缘分发仍能显著遏制滥用，且零外部依赖、零重构。
// ============================================================

import { createMiddleware } from 'hono/factory';
import type { Env, Vars } from '../types';
import { BillingError } from './billing';

interface Bucket {
  timestamps: number[]; // 窗口内的请求时间戳（ms）
  last: number;         // 最后一次命中时间（回收判定用）
}

const buckets = new Map<string, Bucket>();

/** 最大回收窗口：兑换码日限流用 26h，超过这个时长的桶一定已经失效 */
const MAX_TTL_MS = 26 * 3600_000;

/** 内存占用兜底：条目过多时回收"窗口已过"的桶（旧实现只删空数组，带时间戳的桶永不释放） */
function gc(now: number) {
  if (buckets.size < 500) return;
  for (const [k, b] of buckets) {
    if (b.timestamps.length === 0 || now - b.last > MAX_TTL_MS) buckets.delete(k);
  }
}

/**
 * 滑动窗口限流判定：窗口 windowMs 内请求数已达 limit 则返回 true（应拒绝）。
 * @param key 调用方构造（如 `ip:${ip}`、`user:${userId}`）
 */
export function rateLimitHit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) {
    b = { timestamps: [], last: now };
    buckets.set(key, b);
  }
  // 丢弃窗口外的旧时间戳
  b.timestamps = b.timestamps.filter(t => now - t < windowMs);
  b.last = now;
  if (b.timestamps.length >= limit) {
    gc(now);
    return true;
  }
  b.timestamps.push(now);
  gc(now);
  return false;
}

/** 获取客户端 IP（Cloudflare 首选，其次转发头，最后兜底） */
export function clientIp(c: { req: { header(name: string): string | undefined } }): string {
  return (
    c.req.header('CF-Connecting-IP')
    || c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    || 'unknown'
  ) as string;
}

// ── AI 调用限流（挂在 authMiddleware 之后）──
// Agnes 公用免费档 RPM 20（整把共享密钥共用，不是每用户 20）。
// 用户级 18/分钟 对所有用户生效（防单账户突发）；
// 全局 18/分钟（agnesGlobalRateHit，挂在 api-config 免费车道解析路径）拦住多用户叠加打爆共享额度。
const AI_USER_RPM = 18;
const AI_GLOBAL_RPM = 18;
const AI_WINDOW_MS = 60 * 1000;

export const aiRateLimit = createMiddleware<{ Bindings: Env; Variables: Vars }>(async (c, next) => {
  const userId = c.get('userId');
  if (rateLimitHit(`ai:user:${userId}`, AI_USER_RPM, AI_WINDOW_MS)) {
    return c.json({ error: 'AI 调用过于频繁，请约 1 分钟后再试（每分钟约 20 次）' }, 429);
  }
  await next();
});

/** Agnes 共享密钥的全局 RPM 闸门；命中时返回 true（应拒绝） */
export function agnesGlobalRateHit(): boolean {
  return rateLimitHit('ai:agnes:global', AI_GLOBAL_RPM, AI_WINDOW_MS);
}

export class AgnesRateLimitError extends Error {
  constructor(message = '免费 API 调用过于频繁（每分钟约 20 次），请稍后再试') {
    super(message);
    this.name = 'AgnesRateLimitError';
  }
}

export function isAgnesRateLimitError(err: unknown): boolean {
  if (err instanceof AgnesRateLimitError) return true;
  const msg = err instanceof Error ? err.message : String(err || '');
  return /每分钟约 20|rate limit|RPM/i.test(msg) || /\b429\b/.test(msg);
}

/** getUserApiKey/resolveLane 失败时的 HTTP 响应：BillingError 原样透传（409/404/503…），限流 429，其余 500 */
export function aiConfigFail(err: unknown): { body: { error: string; code?: string; details?: string }; status: 400 | 402 | 404 | 409 | 429 | 500 | 503 } {
  if (err instanceof BillingError) {
    return { body: { error: err.message, code: err.code }, status: err.status as 409 };
  }
  if (isAgnesRateLimitError(err)) {
    const msg = err instanceof Error ? err.message : '免费 API 调用过于频繁，请稍后再试';
    return { body: { error: msg }, status: 429 };
  }
  const details = err instanceof Error ? err.message : String(err);
  return { body: { error: 'AI 配置不可用', details }, status: 500 };
}
