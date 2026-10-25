// ============================================================
// routes/settings.ts — AI 服务配置（免费通道 / BYOK 主模型 + 可选视觉模型）
// BYOK 凭证已上收计费平台（yuer-billing）加密存储、跨项目复用；
// 本路由只做表单校验与 Service Binding 代理，不再读写本地 api_keys 表
// （原表保留作历史备份，一次性迁移见 /api/billing/admin/migrate-byok）。
// ============================================================

import { Hono } from 'hono';
import type { Env, Vars } from '../types';
import { authMiddleware } from '../middleware/auth';
import { AGNES_BASE_URLS, AGNES_MODEL } from '../utils/api-config';
import * as billing from '../utils/billing';

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

  try {
    if (p === 'agnes') {
      // 公用免费 API：清除 billing 侧 BYOK 记录即切回免费通道
      await billing.adminByokSet(c.env, userId, { baseUrl: '', model: '', clear: true });
      return c.json({ ok: true, message: '已启用 Agnes 公用免费 API' });
    }

    // ── BYOK：Key 留空则 billing 侧保留旧值 ──
    const key = body.api_key?.trim();
    const st = await billing.byokStatus(c.env, userId);
    if (!key && !st.configured) return c.json({ error: 'API Key 不能为空' }, 400);

    const baseUrl = body.api_base_url?.trim() || st.baseUrl || 'https://api.openai.com/v1';
    const model = body.model_name?.trim() || st.model || 'gpt-4o-mini';
    await billing.adminByokSet(c.env, userId, {
      key,
      baseUrl,
      model,
      visionKey: body.vision_api_key?.trim() || undefined,
      visionBaseUrl: body.vision_api_base_url?.trim() || undefined,
      visionModel: body.vision_model_name?.trim() || undefined,
    });
    return c.json({ ok: true, message: 'API Key 已保存' });
  } catch (err) {
    if (err instanceof billing.BillingError) {
      return c.json({ error: err.message, code: err.code }, err.status as 400);
    }
    console.error('[settings] 保存 API 配置失败:', err instanceof Error ? err.message : err);
    return c.json({ error: '保存失败：计费服务暂不可用，请稍后重试' }, 503);
  }
});

// ── 检查 API 配置状态（响应形状保持不变，数据源改为 billing）──
settings.get('/api-keys/status', authMiddleware, async (c) => {
  const userId = c.get('userId');
  let st: billing.ByokStatus;
  try {
    st = await billing.byokStatus(c.env, userId);
  } catch (err) {
    console.error('[settings] BYOK 状态查询失败:', err instanceof Error ? err.message : err);
    return c.json({ error: '计费服务暂不可用，请稍后重试' }, 503);
  }

  const provider = st.configured ? 'byok' : 'agnes';
  return c.json({
    configured: st.configured,
    provider,
    api_base_url: provider === 'agnes' ? AGNES_BASE_URLS[0] : (st.baseUrl || null),
    model_name: provider === 'agnes' ? AGNES_MODEL : (st.model || null),
    vision_model_name: st.visionModel || null,
    vision_api_base_url: st.visionBaseUrl || null,
    agnes_available: st.agnes_available,
  });
});

export default settings;
