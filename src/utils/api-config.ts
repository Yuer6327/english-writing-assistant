// ============================================================
// api-config.ts — AI 车道解析（模型库单源 = billing catalog）
// 车道约定（2026-11-05 定）：
//   · 免费档 'free'（llm:agnes-flash）与 'byok' 伪车道在客户端**硬编码**——
//     首屏零额外请求、billing 不可用时免费链路仍可用，AGNES_* 常量为此保留；
//   · 其余车道（longcat/deepseek/...）以 billing /internal/catalog 为唯一源，
//     本文件不再维护车道表（旧 LANE_SERVICE 已删除）——加模型只改 billing catalog。
// BYOK 凭证与上游密钥均已上收 yuer-billing（加密存储、跨项目复用）；
// 本文件只负责：车道选择 → 车道归一（catalog 校验）→ 经 Service Binding
// 取明文配置（仅内网），并保留 Agnes 全局共享额度的限流闸门。
// ============================================================

import type { Env, ApiConfig } from '../types';
import { agnesGlobalRateHit, AgnesRateLimitError } from './rate-limit';
import * as billing from './billing';
import type { CatalogEntry } from './billing';
import type { AICallOpts } from './ai';

// ── 硬编码车道：免费档 + BYOK 伪车道（模型库单源约定的客户端例外）──
export const HARDCODED_LANES: Record<string, string> = {
  free: 'llm:agnes-flash',
  byok: 'byok',
};

// ── 公用免费 API（Agnes）——常量保留（免费档硬编码 + 前端展示用）──
export const AGNES_BASE_URLS = [
  'https://apihub.agnes-ai.cn/v1',   // 中国大陆（Workers 出网实际能通）
  'https://apihub.agnes-ai.com/v1',  // 国际
];
export const AGNES_MODEL = 'agnes-3.0-flash';

/**
 * 免费档端点（env 感知）。仅当 ENABLE_DEV_SESSION=1（本地联调/攻防测试门禁）
 * 且配置了 DEV_AGNES_BASE_URL 时，才把免费档指向本地 mock；生产两个变量都不配置，
 * 恒走官方双端点。用于本地无外呼的 AI 链路测试。
 */
export function agnesBaseUrls(env: Env): string | string[] {
  if ((env.ENABLE_DEV_SESSION || '') === '1' && env.DEV_AGNES_BASE_URL) {
    return env.DEV_AGNES_BASE_URL;
  }
  return AGNES_BASE_URLS;
}

/** 用户可选车道：'free'/'byok' 硬编码 + billing catalog 下发的车道短名。
 *  用 string 而非字面量联合——车道集合由 billing catalog 单源定义，客户端不再枚举。 */
export type Lane = string;

/** 模型目录（isolate 内存 TTL 缓存）：一次拉取，所有请求 5 分钟内复用 */
let catalogCache: { at: number; items: CatalogEntry[] } | null = null;
const CATALOG_TTL_MS = 5 * 60_000;

/** 拉取模型目录（缓存优先）。失败/形状非法上抛且不缓存（2026-11-06 审计：
 *  曾把 undefined 缓存 5 分钟 → resolveLane 变 TypeError 全线 500） */
export async function getCatalog(env: Env): Promise<CatalogEntry[]> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) return catalogCache.items;
  const items = await billing.catalog(env);
  if (!Array.isArray(items)) {
    throw new billing.BillingError('模型目录响应异常', 503, 'catalog_invalid');
  }
  catalogCache = { at: Date.now(), items };
  return items;
}

/** 解析后的配置：ApiConfig + 计费所需的服务档位 id + 目录条目（硬编码车道为 null） */
export interface ResolvedConfig extends ApiConfig {
  /** billing 服务档位（hold/settle 用）；byok 视觉模型解析后仍为 'byok' */
  serviceId: string;
  /** 归一化后的车道（'deepseek' 对外显示为按量计费档） */
  lane: Lane;
  /** catalog 条目（行为参数/显示名来源）；free/byok 硬编码车道为 null */
  entry: CatalogEntry | null;
}

/** 用户默认车道（未显式选择时）：已配置 BYOK → byok，否则免费档（与历史行为一致） */
export async function defaultLane(env: Env, userId: string): Promise<Lane> {
  try {
    const st = await billing.byokStatus(env, userId);
    return st.configured ? 'byok' : 'free';
  } catch (err) {
    // billing 不可用时按免费档走（后续 config 解析会给出明确错误）
    console.error('[api-config] byokStatus 失败，默认免费档:', err instanceof Error ? err.message : err);
    return 'free';
  }
}

/** 车道 → 服务 id：硬编码车道直查；目录车道查 catalog（enabled 校验，归一为短名）。
 *  目录拉取失败时目录车道上抛（由调用方 aiConfigFail 兜底）；
 *  未知车道抛 400 unknown_lane，停用车道抛 409 model_disabled。 */
async function laneToService(env: Env, lane: Lane): Promise<{ serviceId: string; entry: CatalogEntry | null }> {
  // Object.hasOwn 防原型链键（'constructor'/'hasOwnProperty' 等会 truthy 命中）
  const hardcoded = Object.hasOwn(HARDCODED_LANES, lane) ? HARDCODED_LANES[lane] : undefined;
  if (hardcoded) return { serviceId: hardcoded, entry: null };
  const entry = (await getCatalog(env)).find((e) => e.lane === lane || e.id === lane);
  if (!entry) throw new billing.BillingError(`未知模型通道：${lane}`, 400, 'unknown_lane');
  if (!entry.enabled) throw new billing.BillingError('该模型暂不可用', 409, 'model_disabled');
  return { serviceId: entry.id, entry };
}

/** 按显式车道解析模型配置（路由层用） */
export async function resolveLane(env: Env, userId: string, lane: Lane): Promise<ResolvedConfig> {
  // Agnes 全局共享额度闸门：只拦免费车道（BYOK / 付费档不吃共享桶）
  if (lane === 'free' && agnesGlobalRateHit()) throw new AgnesRateLimitError();
  const { serviceId, entry } = await laneToService(env, lane);
  const cfg = await billing.config(env, userId, serviceId);
  if (cfg.provider === 'agnes') cfg.baseUrl = agnesBaseUrls(env);
  return {
    provider: cfg.provider,
    key: cfg.key,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    vision: cfg.vision ?? null,
    serviceId,
    lane,
    entry,
  };
}

/** 请求体里的 model_id → 车道（目录车道归一为短名）。
 *  缺省/未知 → 用户默认车道（恒为 byok/free，绝不静默换成付费档）；
 *  显式选择的目录车道：目录拉取失败 → 503 显式报错（2026-11-06 审计：静默降级免费档
 *  会违背用户车道选择并白扣每日免费次数）；车道已停用 → 409（早报错优于 hold 时再炸）。 */
export async function laneFromBody(env: Env, userId: string, modelId: unknown): Promise<Lane> {
  const v = typeof modelId === 'string' ? modelId : null;
  if (!v) return defaultLane(env, userId);
  if (Object.hasOwn(HARDCODED_LANES, v)) return v;
  let entries: CatalogEntry[];
  try {
    entries = await getCatalog(env);
  } catch {
    throw new billing.BillingError('模型通道暂不可用，请稍后重试或改用免费通道', 503, 'catalog_unavailable');
  }
  const entry = entries.find((e) => e.lane === v || e.id === v);
  if (!entry) return defaultLane(env, userId);
  if (!entry.enabled) {
    throw new billing.BillingError('该模型暂不可用', 409, 'model_disabled');
  }
  return entry.lane;
}

/** 主模型配置（兼容旧调用：未显式选择车道时用默认车道） */
export async function getUserApiKey(env: Env, userId: string): Promise<ResolvedConfig> {
  return resolveLane(env, userId, await defaultLane(env, userId));
}

/** 视觉模型配置：BYOK 单独配置了视觉模型则用之，否则与主模型相同（含 Agnes，原生支持图片） */
export async function getVisionConfig(env: Env, userId: string, lane?: Lane): Promise<ResolvedConfig> {
  const resolvedLane = lane ?? (await defaultLane(env, userId));
  const cfg = await resolveLane(env, userId, resolvedLane);
  if (cfg.provider === 'byok' && cfg.vision?.model) {
    return { ...cfg, key: cfg.vision.key, baseUrl: cfg.vision.baseUrl, model: cfg.vision.model };
  }
  return cfg;
}

/** 目录条目 → ai.ts 调用参数（response_format 支持性 / 仅流式 / 思考 / 免重试）。
 *  硬编码车道（null）不传：ai.ts 按模型名正则 + 运行时记忆推断（既有行为）。
 *  配置了 thinkingBudget 的模型（LongCat 系）：默认调用显式关思考——辅助小调用
 *  （语义检测 / 盲评 / 采样，15~40s 死线）烧不起思考；深度调用用 aiDeepOpts。 */
export function aiCallOpts(entry: CatalogEntry | null | undefined): AICallOpts | undefined {
  if (!entry) return undefined;
  return {
    supportsResponseFormat: entry.jsonMode,
    streamOnly: entry.streamOnly,
    noRetry: entry.noRetry,
    ...(entry.thinkingBudget ? { thinking: 'off' as const } : {}),
  };
}

/** 深度调用（批改主调用 / 全文润色）：配置了思考预算的模型按预算开思考（catalog 单源）。 */
export function aiDeepOpts(entry: CatalogEntry | null | undefined): AICallOpts | undefined {
  const base = aiCallOpts(entry);
  if (!base || !entry?.thinkingBudget) return base;
  return { ...base, thinking: entry.thinkingBudget };
}
