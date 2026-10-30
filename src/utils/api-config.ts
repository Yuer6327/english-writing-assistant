// ============================================================
// api-config.ts — AI 提供方配置解析（经 billing 平台）
// BYOK 凭证与上游密钥均已上收 yuer-billing（加密存储、跨项目复用）；
// 本文件只负责：车道选择（free/deepseek/byok）→ 经 Service Binding
// 取明文配置（仅内网），并保留 Agnes 全局共享额度的限流闸门。
// 旧实现（直查 essay api_keys 表）已在 BYOK 迁移后废弃，原表保留作历史备份。
// ============================================================

import type { Env, ApiConfig } from '../types';
import { agnesGlobalRateHit, AgnesRateLimitError } from './rate-limit';
import * as billing from './billing';

// ── 公用免费 API（Agnes）——常量保留（前端展示用）──
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

/** 用户可选车道（前端模型选择器的值 → billing 服务档位） */
export type Lane = 'free' | 'deepseek' | 'byok';

export const LANE_SERVICE: Record<Lane, string> = {
  free: 'llm:agnes-flash',
  deepseek: 'llm:deepseek-flash',
  byok: 'byok',
};

/** 解析后的配置：ApiConfig + 计费所需的服务档位 id */
export interface ResolvedConfig extends ApiConfig {
  /** billing 服务档位（hold/settle 用）；byok 视觉模型解析后仍为 'byok' */
  serviceId: string;
  /** 归一化后的车道（'deepseek' 对外显示为积分档） */
  lane: Lane;
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

/** 按显式车道解析模型配置（路由层用） */
export async function resolveLane(env: Env, userId: string, lane: Lane): Promise<ResolvedConfig> {
  // Agnes 全局共享额度闸门：只拦免费车道（BYOK / 付费档不吃共享桶）
  if (lane === 'free' && agnesGlobalRateHit()) throw new AgnesRateLimitError();
  const serviceId = LANE_SERVICE[lane];
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
  };
}

function normalizeLane(v: string | undefined | null): Lane | null {
  return v === 'free' || v === 'deepseek' || v === 'byok' ? v : null;
}

/** 请求体里的 model_id → 车道（非法/缺省 → 用户默认车道） */
export async function laneFromBody(env: Env, userId: string, modelId: unknown): Promise<Lane> {
  return normalizeLane(typeof modelId === 'string' ? modelId : null) ?? defaultLane(env, userId);
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
