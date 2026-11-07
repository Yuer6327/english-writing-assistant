// ============================================================
// billing.ts — 计费平台（yuer-billing）Service Binding 客户端
// 方法与 billing Worker 的 /internal/* 端点一一对应；
// 非 2xx 抛 BillingError（挂 code，路由层据此透传 402/409 等）。
// 2026-11-07 per-caller 令牌拆分（审查 §2 S2）：本仓只持有并发送
// WRITING_INTERNAL_TOKEN；billing /admin/* 只收 auth 侧令牌，本仓无权调用——
// 原管理代理方法（gift/tags/codes/orders/...）已删除，管理入口迁统一认证后台。
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

/** 计费调用时间预算（W2，与 auth validate 的 3s 同风格）：billing hang 不能拖住业务请求。
 *  · 快调用（settle/config/wallet/catalog/...）5s：超时按 billing_unreachable 降级
 *    （settle/release 失败由 billing cron 过期释放兜底，不阻塞结果交付）。
 *  · hold 15s：hold 是付费车道的准入门禁，预算必须覆盖正常计费慢查（红队 hold_slow
 *    10s 量级的慢账务也在正常范围内）；超时同样 fail-closed 503，孤儿 hold 由 billing
 *    cron 过期释放。免费车道 hold 本就 fire-and-forget，不受此预算影响。 */
const CALL_TIMEOUT_MS = 5000;
const HOLD_TIMEOUT_MS = 15_000;

// 缺失口令的一次性告警（P3 审计，与 middleware/auth.ts 的 AUTH_VALIDATE_TOKEN 同款）：
// WRITING_INTERNAL_TOKEN 运行时缺失 = 每笔 /internal/* 调用都被 billing 401 拒（fail-closed），
// 此前无任何日志可查。首次实际使用时 console.error 一次，模块级标志防刷屏。
let writingInternalTokenWarned = false;

async function call<T>(env: Env, path: string, init?: { method?: string; body?: unknown }, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.WRITING_INTERNAL_TOKEN) headers['X-Internal-Token'] = env.WRITING_INTERNAL_TOKEN;
  else if (!writingInternalTokenWarned) {
    writingInternalTokenWarned = true;
    console.error('[billing] WRITING_INTERNAL_TOKEN missing — all /internal/* calls will 401');
  }
  const body = init?.body !== undefined ? JSON.stringify(init.body) : undefined;
  let resp: Response;
  try {
  // 本地开发回退：wrangler 多 worker dev registry 在部分环境不稳（Network connection lost）。
  // 双门禁（ENABLE_DEV_SESSION=1 且配置了 DEV_BILLING_URL）才走 HTTP 直连——生产两个变量都不配，
  // 恒走 Service Binding；误配单一变量的半开状态直接被门禁挡掉（否则计费流量+内部令牌会发往任意主机）。
  const devDirect = (env.ENABLE_DEV_SESSION || '') === '1' && !!env.DEV_BILLING_URL;
  resp = devDirect
    ? await fetch((env.DEV_BILLING_URL as string).replace(/\/$/, '') + path, { method: init?.method ?? 'GET', headers, body, signal: AbortSignal.timeout(timeoutMs) })
    : await env.BILLING.fetch(`https://yuer-billing${path}`, { method: init?.method ?? 'GET', headers, body, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    console.error('[billing] BILLING.fetch 异常:', err instanceof Error ? err.message : err);
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
  return call(env, '/internal/hold', { method: 'POST', body: { userId, project, service, ...opts } }, HOLD_TIMEOUT_MS);
}

export function settle(
  env: Env, holdId: string,
  usage: {
    promptTokens?: number; completionTokens?: number;
    /** 上游 usage 的输入缓存命中/未命中拆分：billing 按上游实际计费维度计价（N=1） */
    promptCacheHitTokens?: number; promptCacheMissTokens?: number;
    calls?: number;
  },
  /** 可选归属校验：携带即要求 hold.user_id 匹配（纵深防御，2026-11-06 审计） */
  userId?: string,
): Promise<{ charged: number; refunded: number; balance: number }> {
  return call(env, `/internal/holds/${holdId}/settle`, { method: 'POST', body: { ...usage, userId } });
}

export function release(
  env: Env, holdId: string, userId?: string,
): Promise<{ refunded: number; balance: number }> {
  return call(env, `/internal/holds/${holdId}/release`, { method: 'POST', body: { userId } });
}

/** 静默释放（失败路径兜底，绝不掩盖主错误）。userId 可选透传（hold 归属校验，与 settle 同口径） */
export async function releaseQuietly(env: Env, holdId: string | undefined, userId?: string): Promise<void> {
  if (!holdId) return;
  try { await release(env, holdId, userId); } catch (err) {
    console.error('[billing] release 失败（将被 cron 过期释放兜底）:', err instanceof Error ? err.message : err);
  }
}

export function wallet(env: Env, userId: string): Promise<{ balance: number }> {
  return call(env, `/internal/wallet/${userId}`);
}

export interface ModelConfig {
  provider: string;   // 'agnes' | 'longcat' | 'deepseek' | 'byok' | ...（由 billing catalog 单源下发，客户端不再枚举）
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

/** 服务目录条目（GET /internal/catalog 下发的脱敏子集；模型库单源，客户端不自维护模型表）。
 *  免费档约定在客户端硬编码（lane 'free'），不依赖本列表。 */
export interface CatalogEntry {
  id: string;              // billing 服务 id（'llm:longcat' 等；hold/settle/config 用）
  lane: string;            // 对外车道短名（前端选项 value，兼容旧 model_id）
  provider: string;        // 'deepseek' | 'longcat' | ...
  tier: 'free' | 'free-quota' | 'paid';
  enabled: boolean;
  heavy: boolean;
  vision: boolean;
  jsonMode: boolean;       // 上游支持 response_format
  displayName: string;     // 下拉显示名（也是响应里 model 展示串）
  hint: string | null;     // 选中提示文案
  streamOnly: boolean;     // 仅流式可用
  maxOutputFactor: number; // max_tokens 放大倍数（reasoning 占预算）
  maxOutputMin: number | null;
  budgetMs: number | null; // AI 时间预算
  thinkingBudget: number | null; // 思考预算（LongCat 系 budget_tokens；null = 不发思考参数）
  imageTokenEstimate: number | null;
  noRetry: boolean;
  price: { inputHitPer1k: number; inputMissPer1k: number; outputPer1k: number } | null; // 微积分/1k；null=免费
}

/** 模型库（billing 目录）。TTL 缓存由 api-config.getCatalog 管理（含失败降级口径） */
export async function catalog(env: Env): Promise<CatalogEntry[]> {
  const d = await call<{ services: CatalogEntry[] }>(env, '/internal/catalog');
  return d.services;
}

export function byokStatus(env: Env, userId: string): Promise<ByokStatus> {
  return call(env, `/internal/byok/${userId}`);
}

/** 用户自助保存 BYOK（settings 页）：走 /internal/byok/set（原 /admin/byok/set 已随
 *  per-caller 令牌拆分对本仓关闭，审查 §4.3 #8）。 */
export function byokSet(
  env: Env, userId: string,
  payload: {
    key?: string; baseUrl: string; model: string;
    visionKey?: string; visionBaseUrl?: string; visionModel?: string; clear?: boolean;
  },
): Promise<{ ok: boolean }> {
  return call(env, '/internal/byok/set', { method: 'POST', body: { userId, ...payload } });
}

export interface BillingOverview {
  balance: number;
  paid_enabled: boolean;
  relay_enabled?: boolean;
  longcat_enabled?: boolean;
  /** 客户端模型库单源（含免费档）；旧版逐车道 flag 保留一个版本兼容 */
  models?: CatalogEntry[];
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

// ── 管理代理已整体删除（2026-11-07）：/admin/* 只收 auth 侧令牌，本仓无权调用。
// 送分/标签/兑换码/订单等管理入口迁统一认证后台 https://auth.yuer6327.top/admin
// （链接待 auth 子代理产物核对）；用量查询走上方 usageView（/internal/usage，只读）。
