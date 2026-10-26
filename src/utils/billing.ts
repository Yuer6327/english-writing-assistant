// ============================================================
// billing.ts — 计费平台（yuer-billing）Service Binding 客户端
// 方法与 billing Worker 的 /internal/* 与 /admin/* 端点一一对应；
// 非 2xx 抛 BillingError（挂 code，路由层据此透传 402/409 等）。
// ============================================================

import type { Env } from '../types';

export class BillingError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'BillingError';
    this.status = status;
    this.code = code;
  }
}

async function call<T>(env: Env, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.INTERNAL_TOKEN) headers['X-Internal-Token'] = env.INTERNAL_TOKEN;
  let resp: Response;
  try {
    resp = await env.BILLING.fetch(`https://yuer-billing${path}`, {
      method: init?.method ?? 'GET',
      headers,
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  } catch (err) {
    throw new BillingError('计费服务暂不可用，请稍后重试', 503, 'billing_unreachable');
  }
  const data: any = await resp.json().catch(() => ({ error: '计费服务响应异常' }));
  if (!resp.ok) {
    throw new BillingError(data.error || `计费服务错误（${resp.status}）`, resp.status, data.code);
  }
  return data as T;
}

// ── 业务调用（/internal/*）──

export interface HoldInfo {
  mode: 'free' | 'hold' | 'byok';
  holdId?: string;
  frozen?: number;
  quotaRemaining?: number;
}

/** service：'llm:agnes-flash' / 'llm:deepseek-flash' / 'ocr:baidu' / 'byok'
 *  skipQuota：跳过 billing 的免费额度判定（次数由本 Worker 的 quota_events 按
 *  「成功批改」自计，避免调用失败也扣次数） */
export function hold(
  env: Env, userId: string, project: string, service: string,
  opts: { estInputTokens?: number; maxOutputTokens?: number; calls?: number; skipQuota?: boolean } = {},
): Promise<HoldInfo> {
  return call(env, '/internal/hold', { method: 'POST', body: { userId, project, service, ...opts } });
}

export function settle(
  env: Env, holdId: string,
  usage: { promptTokens?: number; completionTokens?: number; calls?: number },
): Promise<{ charged: number; refunded: number; balance: number }> {
  return call(env, `/internal/holds/${holdId}/settle`, { method: 'POST', body: usage });
}

export function release(
  env: Env, holdId: string,
): Promise<{ refunded: number; balance: number }> {
  return call(env, `/internal/holds/${holdId}/release`, { method: 'POST', body: {} });
}

/** 静默释放（失败路径兜底，绝不掩盖主错误） */
export async function releaseQuietly(env: Env, holdId: string | undefined): Promise<void> {
  if (!holdId) return;
  try { await release(env, holdId); } catch (err) {
    console.error('[billing] release 失败（将被 cron 过期释放兜底）:', err instanceof Error ? err.message : err);
  }
}

export function wallet(env: Env, userId: string): Promise<{ balance: number }> {
  return call(env, `/internal/wallet/${userId}`);
}

export interface ModelConfig {
  provider: 'agnes' | 'deepseek' | 'byok';
  key: string;
  baseUrl: string | string[];
  model: string;
  vision: { key: string; baseUrl: string; model: string } | null;
}

/** modelId：'llm:agnes-flash' / 'llm:deepseek-flash' / 'byok'（明文 Key 仅内网） */
export function config(env: Env, userId: string, modelId: string): Promise<ModelConfig> {
  return call(env, `/internal/config/${userId}/${encodeURIComponent(modelId)}`);
}

export interface ByokStatus {
  configured: boolean;
  baseUrl: string | null;
  model: string | null;
  visionModel: string | null;
  visionBaseUrl: string | null;
  agnes_available: boolean;
}

export function byokStatus(env: Env, userId: string): Promise<ByokStatus> {
  return call(env, `/internal/byok/${userId}`);
}

export interface BillingOverview {
  balance: number;
  paid_enabled: boolean;
  quota: Record<string, { service: string; period: string; used: number; limit: number }[]>;
  recent_usage: Record<string, unknown>[];
}

export function overview(env: Env, userId: string, project = 'writing'): Promise<BillingOverview> {
  return call(env, `/internal/overview/${userId}?project=${project}`);
}

export function usageView(
  env: Env, userId: string, limit = 50,
): Promise<{ usage: Record<string, unknown>[]; ledger: Record<string, unknown>[] }> {
  return call(env, `/internal/usage/${userId}?limit=${limit}`);
}

export function redeem(
  env: Env, userId: string, code: string,
): Promise<{ balance: number; points: number }> {
  return call(env, '/internal/redeem', { method: 'POST', body: { userId, code } });
}

// ── 管理代理（/admin/*，仅 admin 角色路由可达）──

export function adminGift(
  env: Env, userId: string, points: number, note?: string,
): Promise<{ balance: number }> {
  return call(env, '/admin/gift', { method: 'POST', body: { userId, points, note } });
}

export function adminByokSet(
  env: Env, userId: string,
  payload: {
    key?: string; baseUrl: string; model: string;
    visionKey?: string; visionBaseUrl?: string; visionModel?: string; clear?: boolean;
  },
): Promise<{ ok: boolean }> {
  return call(env, '/admin/byok/set', { method: 'POST', body: { userId, ...payload } });
}

export function adminCodes(
  env: Env, points: number, count: number, batch?: string,
): Promise<{ codes: string[]; batch: string }> {
  return call(env, '/admin/codes', { method: 'POST', body: { points, count, batch } });
}

export function adminManualOrder(
  env: Env, userId: string, points: number, note?: string,
): Promise<{ orderId: string }> {
  return call(env, '/admin/orders/manual', { method: 'POST', body: { userId, points, note } });
}

export function adminUser(
  env: Env, userId: string,
): Promise<{ balance: number; tags: string[]; recent_ledger: any[]; recent_usage: any[] }> {
  return call(env, `/admin/user/${userId}`);
}

export function adminTags(
  env: Env, userId: string, add: string[] = [], remove: string[] = [],
): Promise<{ tags: string[] }> {
  return call(env, '/admin/tags', { method: 'POST', body: { userId, add, remove } });
}

export function adminOrders(
  env: Env, limit = 50,
): Promise<{ orders: any[] }> {
  return call(env, `/admin/orders?limit=${limit}`);
}

export function adminUsage(
  env: Env, userId?: string, limit = 50,
): Promise<{ usage: any[] }> {
  return call(env, `/admin/usage?limit=${limit}${userId ? `&userId=${encodeURIComponent(userId)}` : ''}`);
}
