// ============================================================
// routes/ocr.ts — 手写稿拍照识别（双通道）
//   vlm  ：多模态大模型（默认；逐字转写不纠错 + 书写质量分；
//          Agnes 免费层 agnes-3.0-flash 原生支持图像 URL 输入）
//   baidu：百度云通用文字识别（免费额度大、印刷体/工整字稳；
//          无书写质量分，适合省模型额度场景）
// ============================================================

import { Hono } from 'hono';
import type { Env, Vars } from '../types';
import { authMiddleware } from '../middleware/auth';
import { aiRateLimit, aiConfigFail } from '../utils/rate-limit';
import { callAI, extractJSON, friendlyAIError, isAIRateLimitError } from '../utils/ai';
import { getVisionConfig } from '../utils/api-config';
import { OCR_VLM_PROMPT } from '../utils/prompts';
import { sanitizeOcrVlm } from '../utils/validate';
import { baiduOcr, BAIDU_ENDPOINT_LABELS } from '../utils/baidu-ocr';

const ocr = new Hono<{ Bindings: Env; Variables: Vars }>();

const MAX_IMAGES = 3;
const MAX_IMAGE_CHARS = 400_000;   // data URL 长度上限（约 300KB 二进制）

function parseDataUrl(dataUrl: string): { ok: true; base64: string } | { ok: false; error: string } {
  const m = dataUrl.match(/^data:([a-z0-9+/.\-]+);base64,/);
  if (!m) return { ok: false, error: '图片数据格式无效，需为 data URL' };
  const base64 = dataUrl.slice(m[0].length);
  if (!/^[A-Za-z0-9+/=]+$/.test(base64)) return { ok: false, error: '图片数据无效' };
  return { ok: true, base64 };
}

ocr.post('/', authMiddleware, aiRateLimit, async (c) => {
  const body = await c.req.json<{ images?: string[]; mode?: string }>().catch(() => ({}) as any);
  const images = Array.isArray(body.images) ? body.images : [];
  if (images.length === 0) return c.json({ error: '请至少上传一张图片' }, 400);
  if (images.length > MAX_IMAGES) return c.json({ error: `图片最多 ${MAX_IMAGES} 张` }, 400);

  const mode = body.mode === 'baidu' ? 'baidu' : 'vlm';

  // ── 百度 OCR ──
  if (mode === 'baidu') {
    if (!c.env.BAIDU_OCR_AK || !c.env.BAIDU_OCR_SK) {
      return c.json({ error: '百度 OCR 未启用（缺少 BAIDU_OCR_AK / BAIDU_OCR_SK 配置），请改用大模型识别' }, 500);
    }
    try {
      const parts: string[] = [];
      let endpointUsed = '';
      for (const img of images) {
        // 百度限制：base64 urlencode 后不超过 4MB
        const parsed = parseDataUrl(img);
        if (!parsed.ok) return c.json({ error: parsed.error }, 400);
        if (parsed.base64.length > 4 * 1024 * 1024) {
          return c.json({ error: '图片过大（Base64 超过 4MB），请压缩后再试' }, 400);
        }
        const { text, endpoint } = await baiduOcr(c.env.BAIDU_OCR_AK, c.env.BAIDU_OCR_SK, parsed.base64);
        endpointUsed = endpoint;
        if (text.trim()) parts.push(text.trim());
      }
      const text = parts.join('\n\n');
      if (!text.trim()) return c.json({ error: '未识别到文字，请确认图片清晰或更换图片' }, 422);
      return c.json({
        text,
        handwriting_score: null,
        engine: 'baidu',
        endpoint: BAIDU_ENDPOINT_LABELS[endpointUsed] || endpointUsed,
      });
    } catch (err: any) {
      return c.json({ error: 'OCR 识别失败', details: err?.message ?? String(err) }, 500);
    }
  }

  // ── 大模型视觉 OCR ──
  for (const img of images) {
    if (typeof img !== 'string' || !/^data:image\/[a-z0-9.+-]+;base64,/i.test(img)) {
      return c.json({ error: '图片需为 data URL 格式' }, 400);
    }
    if (img.length > MAX_IMAGE_CHARS) return c.json({ error: '单张图片过大，请压缩后再上传' }, 400);
  }

  let cfg;
  try {
    cfg = await getVisionConfig(c.env, c.get('userId'));
  } catch (err) {
    const fail = aiConfigFail(err);
    return c.json(fail.body, fail.status);
  }

  const contentParts = [
    { type: 'text', text: OCR_VLM_PROMPT },
    ...images.map((url: string) => ({ type: 'image_url', image_url: { url } })),
  ];

  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await callAI(cfg.key, cfg.baseUrl, cfg.model, '', '', true, contentParts, 4096, 0.1);
      const result = sanitizeOcrVlm(extractJSON(raw));
      if (!result.text.trim()) throw new Error('识别结果为空');
      return c.json({
        text: result.text,
        handwriting_score: result.handwriting_score,
        notes: result.notes,
        engine: 'vlm',
      });
    } catch (err: any) {
      if (isAIRateLimitError(err)) {
        return c.json({ error: friendlyAIError(err), rate_limited: true }, 429);
      }
      lastErr = err?.message ?? String(err);
      console.error(`[ocr][vlm] 第 ${attempt + 1} 次尝试失败: ${lastErr}`);
    }
  }
  return c.json({ error: '手写识别失败', details: lastErr.slice(0, 300) }, 502);
});

export default ocr;
