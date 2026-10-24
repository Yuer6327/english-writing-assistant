// ============================================================
// api-config.ts — AI 提供方配置解析（BYOK + Agnes 免费层）
// 复用自 english-reading-assistant 的 articles.ts，扩展了可选视觉模型列。
// ============================================================

import type { Env, ApiConfig } from '../types';
import { encryptApiKey, decryptApiKey } from './crypto';
import { agnesGlobalRateHit, AgnesRateLimitError } from './rate-limit';

// ── 公用免费 API（Agnes）──
// 双官方端点（中国大陆优先）；agnes-3.0-flash 原生支持图像 URL 输入，
// 手写 OCR 与看图批改对免费用户开箱即用。
export const AGNES_BASE_URLS = [
  'https://apihub.agnes-ai.cn/v1',   // 中国大陆（Workers 出网实际能通）
  'https://apihub.agnes-ai.com/v1',  // 国际
];
const AGNES_BASE_URL = AGNES_BASE_URLS[0]; // 存入 DB 的主端点（展示用）
export const AGNES_MODEL = 'agnes-3.0-flash';

interface ApiKeyRow {
  encrypted_key: string;
  api_base_url: string;
  model_name: string;
  vision_api_base_url: string | null;
  vision_model_name: string | null;
  vision_encrypted_key: string | null;
  provider: string;
}

async function readRow(env: Env, userId: string): Promise<ApiKeyRow | null> {
  return env.DB.prepare(
    `SELECT encrypted_key, api_base_url, model_name,
            vision_api_base_url, vision_model_name, vision_encrypted_key, provider
     FROM api_keys WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
  ).bind(userId).first<ApiKeyRow>();
}

async function toConfig(env: Env, row: ApiKeyRow): Promise<ApiConfig> {
  if (row.provider === 'agnes') {
    if (!env.AGNES_API_KEY) {
      throw new Error('Agnes 公用免费 API 未配置（缺少 AGNES_API_KEY Secret）');
    }
    if (agnesGlobalRateHit()) {
      throw new AgnesRateLimitError();
    }
    return { provider: 'agnes', key: env.AGNES_API_KEY, baseUrl: AGNES_BASE_URLS, model: AGNES_MODEL };
  }
  const plainKey = await decryptApiKey(row.encrypted_key, env.ENCRYPTION_KEY);
  return { provider: 'byok', key: plainKey, baseUrl: row.api_base_url, model: row.model_name };
}

/** 主模型配置（未配置任何 Key 时回退 Agnes 免费层） */
export async function getUserApiKey(env: Env, userId: string): Promise<ApiConfig> {
  const row = await readRow(env, userId);
  if (!row) {
    // 未配置：默认免费通道（与兄弟项目一致的行为）
    if (!env.AGNES_API_KEY) {
      throw new Error('尚未配置 AI 服务：请到「设置」绑定 API Key，或联系管理员开启免费通道');
    }
    if (agnesGlobalRateHit()) throw new AgnesRateLimitError();
    return { provider: 'agnes', key: env.AGNES_API_KEY, baseUrl: AGNES_BASE_URLS, model: AGNES_MODEL };
  }
  return toConfig(env, row);
}

/** 视觉模型配置：BYOK 单独配置了视觉模型则用之，否则与主模型相同（含 Agnes，原生支持图片） */
export async function getVisionConfig(env: Env, userId: string): Promise<ApiConfig> {
  const row = await readRow(env, userId);
  if (!row) {
    if (!env.AGNES_API_KEY) {
      throw new Error('尚未配置 AI 服务：请到「设置」绑定 API Key，或联系管理员开启免费通道');
    }
    if (agnesGlobalRateHit()) throw new AgnesRateLimitError();
    return { provider: 'agnes', key: env.AGNES_API_KEY, baseUrl: AGNES_BASE_URLS, model: AGNES_MODEL };
  }
  if (row.provider === 'byok' && row.vision_model_name?.trim()) {
    const key = row.vision_encrypted_key
      ? await decryptApiKey(row.vision_encrypted_key, env.ENCRYPTION_KEY)
      : await decryptApiKey(row.encrypted_key, env.ENCRYPTION_KEY);
    return {
      provider: 'byok',
      key,
      baseUrl: row.vision_api_base_url?.trim() || row.api_base_url,
      model: row.vision_model_name.trim(),
    };
  }
  return toConfig(env, row);
}
