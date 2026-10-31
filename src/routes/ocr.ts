// ============================================================
// routes/ocr.ts — 手写稿拍照识别（双通道）
//   vlm  ：多模态大模型（默认；逐字转写不纠错 + 书写质量分；
//          免费档 agnes-3.0-flash 原生支持图像 URL 输入）
//   baidu：百度云通用文字识别（免费额度大、印刷体/工整字稳；
//          无书写质量分，适合省模型额度场景）
// 计费：baidu 走 ocr:baidu（每日 5 次免费额度，超出按次预扣）；
//       vlm 与批改同构（免费额度 / BYOK / 付费档预扣）。
// ============================================================

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, Vars } from '../types';
import { userMiddleware } from '../middleware/auth';
import { aiRateLimit, aiConfigFail, clientIp, rateLimitHit } from '../utils/rate-limit';
import { callAI, extractJSON, friendlyAIError, isAIRateLimitError } from '../utils/ai';
import { getVisionConfig, defaultLane, type Lane } from '../utils/api-config';
import * as billing from '../utils/billing';
import { tryAcquire, releaseSlot } from '../utils/inflight';
import { checkGuestOcrGate, recordSuccess } from '../utils/quota';
import { OCR_VLM_PROMPT } from '../utils/prompts';
import { sanitizeOcrVlm } from '../utils/validate';
import { MAX_IMAGES, MAX_IMAGE_CHARS, estimateImageTokens, estimateTextTokens } from '../utils/limits';
import { baiduOcr, BAIDU_ENDPOINT_LABELS } from '../utils/baidu-ocr';

const ocr = new Hono<{ Bindings: Env; Variables: Vars }>();

/** 游客 IP 级软兜底（scope 独立分桶，与 essays.ts 同口径：清 cookie 重置后，IP 计数让刷额度变贵） */
function guestIpLimitHit(c: Context<{ Bindings: Env; Variables: Vars }>, scope: string, limit: number): boolean {
  if (!c.get('isGuest')) return false;
  return rateLimitHit(`guest:ip:${scope}:${clientIp(c)}`, limit, 24 * 3600_000);
}

function parseDataUrl(dataUrl: unknown): { ok: true; base64: string } | { ok: false; error: string } {
  // 类型必须先判：非字符串直接 .match 会抛 TypeError → 500，暴露出栈信息
  if (typeof dataUrl !== 'string') return { ok: false, error: '图片数据格式无效，需为 data URL' };
  // 仅收位图 MIME：SVG 内可携带 <script>，虽然 <img> 引用不执行、直接导航也被浏览器拦，
  // 但历史数据显示这属于「宁可少收」的输入面（见 docs/SECURITY.md）
  const m = dataUrl.match(/^data:image\/(png|jpe?g|webp|gif|bmp|heic|heif|avif);base64,/i);
  if (!m) return { ok: false, error: '图片格式不支持（需 jpg/png/webp 等位图）' };
  const base64 = dataUrl.slice(m[0].length);
  if (!/^[A-Za-z0-9+/=]+$/.test(base64)) return { ok: false, error: '图片数据无效' };
  return { ok: true, base64 };
}

ocr.post('/', userMiddleware, aiRateLimit, async (c) => {
  const aiDeadline = Date.now() + 90_000;
  const userId = c.get('userId');
  const isGuest = c.get('isGuest');
  const body = ((await c.req.json<{ images?: string[]; mode?: string }>().catch(() => null)) ?? ({} as any));
  const images = Array.isArray(body.images) ? body.images : [];
  if (images.length === 0) return c.json({ error: '请至少上传一张图片' }, 400);
  if (images.length > MAX_IMAGES) return c.json({ error: `图片最多 ${MAX_IMAGES} 张` }, 400);

  const mode = body.mode === 'baidu' ? 'baidu' : 'vlm';

  // 游客 IP 兜底：OCR 打的是共享百度/AI 额度，清 cookie 轮换不能无限刷
  if (guestIpLimitHit(c, 'ocr', 10)) {
    return c.json({ error: '今日识别次数过多，请明天再试或登录使用', code: 'guest_ip_limit' }, 429);
  }

  // 游客：仅百度通道、每天 3 次；大模型视觉识别需要登录
  const ocrGate = await checkGuestOcrGate(c.env.DB, userId, isGuest, mode);
  if (!ocrGate.ok) return c.json({ error: ocrGate.error, code: ocrGate.code }, ocrGate.status);

  // ── 百度 OCR（按次计费：每日 5 次免费额度，超出按 images 数预扣）──
  if (mode === 'baidu') {
    if (!c.env.BAIDU_OCR_AK || !c.env.BAIDU_OCR_SK) {
      return c.json({ error: '百度 OCR 未启用（缺少 BAIDU_OCR_AK / BAIDU_OCR_SK 配置），请改用大模型识别' }, 500);
    }

    // 先校验图片格式/体积（避免预扣后才失败）
    const parsedImages: string[] = [];
    for (const img of images) {
      // 百度限制：base64 **urlencode 后** ≤4MB（+/= 会被 URLSearchParams 编码成 3 字节，按编码后口径校验）
      const parsed = parseDataUrl(img);
      if (!parsed.ok) return c.json({ error: parsed.error }, 400);
      const urlencodeExtra = (parsed.base64.match(/[+/=]/g) || []).length * 2;
      if (parsed.base64.length + urlencodeExtra > 4 * 1024 * 1024) {
        return c.json({ error: '图片过大（Base64 超过 4MB），请压缩后再试' }, 400);
      }
      parsedImages.push(parsed.base64);
    }

    // 游客不经过 billing（没有钱包/免费额度记录），只受本地次数门禁约束
    let holdInfo: billing.HoldInfo = { mode: 'free' };
    if (!isGuest) {
      try {
        holdInfo = await billing.hold(c.env, userId, 'writing', 'ocr:baidu', { calls: images.length });
      } catch (err) {
        if (err instanceof billing.BillingError) {
          return c.json({ error: err.message, code: err.code }, err.status as 402);
        }
        return c.json({ error: '计费服务暂不可用，请稍后重试' }, 503);
      }
    }

    let settled = false;
    try {
      const parts: string[] = [];
      let endpointUsed = '';
      for (const base64 of parsedImages) {
        const { text, endpoint } = await baiduOcr(c.env.BAIDU_OCR_AK, c.env.BAIDU_OCR_SK, base64);
        endpointUsed = endpoint;
        if (text.trim()) parts.push(text.trim());
      }
      const text = parts.join('\n\n');
      if (!text.trim()) {
        await billing.releaseQuietly(c.env, holdInfo.holdId);
        return c.json({ error: '未识别到文字，请确认图片清晰或更换图片' }, 422);
      }

      // 游客识别次数（成功才计数，与批改同口径）
      if (isGuest) await recordSuccess(c.env.DB, userId, 'ocr');

      if (holdInfo.mode === 'hold') {
        try {
          const s = await billing.settle(c.env, holdInfo.holdId!, { calls: images.length });
          settled = true;
          return c.json({
            text,
            handwriting_score: null,
            engine: 'baidu',
            endpoint: BAIDU_ENDPOINT_LABELS[endpointUsed] || endpointUsed,
            points_charged: s.charged,
            lane: 'paid' as const,
          });
        } catch (err) {
          console.error('[ocr:baidu] settle 失败（hold 将被 cron 过期释放）:', err instanceof Error ? err.message : err);
        }
      }
      return c.json({
        text,
        handwriting_score: null,
        engine: 'baidu',
        endpoint: BAIDU_ENDPOINT_LABELS[endpointUsed] || endpointUsed,
        points_charged: 0,
        lane: 'free' as const,
      });
    } catch (err: any) {
      if (holdInfo.mode === 'hold' && !settled) {
        await billing.releaseQuietly(c.env, holdInfo.holdId);
      }
      console.error('[ocr:baidu] 识别失败:', err?.message ?? String(err));
      // 不透传上游原始报文（可能含端点/账号线索），统一走中文友好文案
      return c.json({ error: 'OCR 识别失败，请稍后重试或改用大模型识别' }, 502);
    }
  }

  // ── 大模型视觉 OCR（与批改同构：免费额度 / BYOK / 付费档）──
  for (const img of images) {
    if (typeof img !== 'string' || !/^data:image\/(png|jpe?g|webp|gif|bmp|heic|heif|avif);base64,/i.test(img)) {
      return c.json({ error: '图片格式不支持（需 jpg/png/webp 等位图）' }, 400);
    }
    if (img.length > MAX_IMAGE_CHARS) return c.json({ error: '单张图片过大，请压缩后再上传' }, 400);
  }

  let cfg;
  const vlmLane: Lane = await defaultLane(c.env, userId);
  try {
    cfg = await getVisionConfig(c.env, userId, vlmLane);
  } catch (err) {
    const fail = aiConfigFail(err);
    return c.json(fail.body, fail.status);
  }

  // deepseek 为混合推理模型，reasoning 计入 max_tokens 预算，输出上限放大
  const maxOutput = vlmLane === 'deepseek' ? 8192 : 4096;

  let holdInfo: billing.HoldInfo;
  try {
    holdInfo = await billing.hold(c.env, userId, 'writing', cfg.serviceId, {
      estInputTokens: estimateTextTokens(OCR_VLM_PROMPT) + estimateImageTokens(images, cfg.provider, cfg.model),
      maxOutputTokens: maxOutput,
      skipQuota: vlmLane === 'free',
    });
  } catch (err) {
    if (err instanceof billing.BillingError) {
      return c.json({ error: err.message, code: err.code }, err.status as 402);
    }
    return c.json({ error: '计费服务暂不可用，请稍后重试' }, 503);
  }

  const lockToken = holdInfo.mode !== 'byok' ? tryAcquire(userId) : null;
  if (holdInfo.mode !== 'byok' && lockToken === null) {
    await billing.releaseQuietly(c.env, holdInfo.holdId);
    return c.json({ error: '已有 AI 任务进行中，请等待完成后再试', code: 'concurrent_limit' }, 429);
  }
  const locked = holdInfo.mode !== 'byok';

  const contentParts = [
    { type: 'text', text: OCR_VLM_PROMPT },
    ...images.map((url: string) => ({ type: 'image_url', image_url: { url } })),
  ];

  let settled = false;
  try {
    let lastErr = '';
    let lastUsage: { prompt_tokens: number; completion_tokens: number } | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const raw = await callAI(cfg.key, cfg.baseUrl, cfg.model, '', '', true, contentParts, maxOutput, 0.1, aiDeadline);
        lastUsage = raw.usage;
        const result = sanitizeOcrVlm(extractJSON(raw.content));
        if (!result.text.trim()) throw new Error('识别结果为空');

        let charged = 0;
        if (holdInfo.mode === 'hold') {
          try {
            const s = await billing.settle(c.env, holdInfo.holdId!, {
              promptTokens: lastUsage?.prompt_tokens,
              completionTokens: lastUsage?.completion_tokens,
            });
            charged = s.charged;
            settled = true;
          } catch (err) {
            console.error('[ocr:vlm] settle 失败（hold 将被 cron 过期释放）:', err instanceof Error ? err.message : err);
          }
        }
        return c.json({
          text: result.text,
          handwriting_score: result.handwriting_score,
          notes: result.notes,
          engine: 'vlm',
          points_charged: charged,
          lane: holdInfo.mode === 'hold' ? ('paid' as const) : (holdInfo.mode === 'free' ? 'free' as const : 'byok' as const),
        });
      } catch (err: any) {
        if (isAIRateLimitError(err)) {
          await billing.releaseQuietly(c.env, holdInfo.holdId);
          return c.json({ error: friendlyAIError(err), rate_limited: true }, 429);
        }
        lastErr = err?.message ?? String(err);
        console.error(`[ocr][vlm] 第 ${attempt + 1} 次尝试失败: ${lastErr}`);
        if (/^AI API error \d{3}|abort|timed? ?out|fetch failed|超时/i.test(lastErr)) throw err;
      }
    }
    await billing.releaseQuietly(c.env, holdInfo.holdId);
    console.error('[ocr] VLM 识别失败（原始错误仅日志）:', lastErr.slice(0, 300));
    return c.json({ error: '手写识别失败，请稍后重试或更换识别引擎' }, 502);
  } catch (err: any) {
    if (holdInfo.mode === 'hold' && !settled) {
      await billing.releaseQuietly(c.env, holdInfo.holdId);
    }
    return c.json({ error: friendlyAIError(err) }, 502);
  } finally {
    if (locked) releaseSlot(userId, lockToken);
  }
});

export default ocr;
