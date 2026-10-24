// ============================================================
// routes/settings.ts — AI 服务配置（Agnes 免费层 / BYOK 主模型 + 可选视觉模型）
// 改编自兄弟项目 articles.ts 的 api-keys 部分，扩展 vision_* 三列。
// ============================================================

import { Hono } from 'hono';
import type { Env, Vars } from '../types';
import { authMiddleware } from '../middleware/auth';
import { encryptApiKey, decryptApiKey } from '../utils/crypto';
import { AGNES_BASE_URLS, AGNES_MODEL } from '../utils/api-config';

const settings = new Hono<{ Bindings: Env; Variables: Vars }>();

interface SaveBody {
  provider?: 'byok' | 'agnes';
  api_key?: string;
  api_base_url?: string;
  model_name?: string;
  vision_api_key?: string;
  vision_api_base_url?: string;
  vision_model_name?: string;
}

// ── 保存 / 更新 API 配置 ──
settings.post('/api-keys', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<SaveBody>().catch(() => ({}) as SaveBody);
  const p = body.provider === 'agnes' ? 'agnes' : 'byok';

  const existing = await c.env.DB.prepare(
    `SELECT encrypted_key, api_base_url, model_name, provider,
            vision_api_base_url, vision_model_name, vision_encrypted_key
     FROM api_keys WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
  ).bind(userId).first<{
    encrypted_key: string; api_base_url: string; model_name: string; provider: string;
    vision_api_base_url: string | null; vision_model_name: string | null; vision_encrypted_key: string | null;
  }>();

  let visionBaseUrl: string | null = null;
  let visionModel: string | null = null;
  let visionEncrypted: string | null = null;

  if (p === 'agnes') {
    // 公用免费 API：端点与模型固定，视觉即 Agnes 本身（原生支持图像输入）
    const encrypted = await encryptApiKey('', c.env.ENCRYPTION_KEY);
    await c.env.DB.prepare('DELETE FROM api_keys WHERE user_id = ?').bind(userId).run();
    await c.env.DB.prepare(
      `INSERT INTO api_keys (user_id, encrypted_key, api_base_url, model_name, provider)
       VALUES (?, ?, ?, ?, 'agnes')`,
    ).bind(userId, encrypted, AGNES_BASE_URLS[0], AGNES_MODEL).run();
    return c.json({ ok: true, message: '已启用 Agnes 公用免费 API' });
  }

  // ── BYOK 主模型：Key 留空则保留原 Key ──
  let plainKey = body.api_key;
  if (!plainKey || !plainKey.trim()) {
    if (existing && existing.provider === 'byok' && existing.encrypted_key) {
      plainKey = await decryptApiKey(existing.encrypted_key, c.env.ENCRYPTION_KEY);
    }
    if (!plainKey) return c.json({ error: 'API Key 不能为空' }, 400);
  }
  const encrypted = await encryptApiKey(plainKey, c.env.ENCRYPTION_KEY);
  const baseUrl = body.api_base_url?.trim() || existing?.api_base_url || 'https://api.openai.com/v1';
  const model = body.model_name?.trim() || existing?.model_name || 'gpt-4o-mini';

  // ── BYOK 可选视觉模型（手写 OCR / 看图批改用；主模型不支持图片时配置）──
  if (body.vision_model_name?.trim()) {
    visionModel = body.vision_model_name.trim();
    visionBaseUrl = body.vision_api_base_url?.trim() || null;
    let visionKey = body.vision_api_key;
    if (!visionKey?.trim() && existing?.vision_encrypted_key) {
      visionKey = await decryptApiKey(existing.vision_encrypted_key, c.env.ENCRYPTION_KEY);
    }
    visionEncrypted = visionKey?.trim()
      ? await encryptApiKey(visionKey.trim(), c.env.ENCRYPTION_KEY)
      : null;   // 未单独填 Key → 用主 Key（vision_encrypted_key 为 NULL 时回退主密钥）
  }

  await c.env.DB.prepare('DELETE FROM api_keys WHERE user_id = ?').bind(userId).run();
  await c.env.DB.prepare(
    `INSERT INTO api_keys
       (user_id, encrypted_key, api_base_url, model_name, provider,
        vision_api_base_url, vision_model_name, vision_encrypted_key)
     VALUES (?, ?, ?, ?, 'byok', ?, ?, ?)`,
  ).bind(userId, encrypted, baseUrl, model, visionBaseUrl, visionModel, visionEncrypted).run();

  return c.json({ ok: true, message: 'API Key 已保存' });
});

// ── 检查 API 配置状态 ──
settings.get('/api-keys/status', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const row = await c.env.DB.prepare(
    `SELECT api_base_url, model_name, provider, vision_api_base_url, vision_model_name
     FROM api_keys WHERE user_id = ? ORDER BY id DESC LIMIT 1`,
  ).bind(userId).first<{
    api_base_url: string; model_name: string; provider: string;
    vision_api_base_url: string | null; vision_model_name: string | null;
  }>();

  const provider = row?.provider === 'agnes' ? 'agnes' : (row ? 'byok' : 'agnes');
  const model = provider === 'agnes' ? AGNES_MODEL : (row?.model_name || null);

  return c.json({
    configured: !!row,
    provider,
    api_base_url: provider === 'agnes' ? AGNES_BASE_URLS[0] : (row?.api_base_url || null),
    model_name: model,
    vision_model_name: row?.vision_model_name || null,
    vision_api_base_url: row?.vision_api_base_url || null,
    agnes_available: !!c.env.AGNES_API_KEY,
  });
});

export default settings;
