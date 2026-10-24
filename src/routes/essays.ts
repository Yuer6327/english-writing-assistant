// ============================================================
// routes/essays.ts — 作文 / 稿件 CRUD + 批改 + 精修 / 全文润色
// 挂载于 /api：/essays..., /drafts/:id...
// ============================================================

import { Hono } from 'hono';
import type { Env, Vars, ApiConfig } from '../types';
import { authMiddleware } from '../middleware/auth';
import { aiRateLimit, aiConfigFail } from '../utils/rate-limit';
import { callAI, extractJSON, friendlyAIError, isAIRateLimitError, ContentPart } from '../utils/ai';
import { getUserApiKey, getVisionConfig } from '../utils/api-config';
import {
  GENRES, fillTemplate, getEffectivePrompt, buildPreviousFeedbackBlock,
  FRAGMENT_POLISH_PROMPT, FULL_REWRITE_PROMPT,
} from '../utils/prompts';
import {
  countWords, sanitizeReview, sanitizeFragmentPolish, sanitizeFullRewrite,
} from '../utils/validate';
import { seedSampleEssay } from '../sample/seed';

const api = new Hono<{ Bindings: Env; Variables: Vars }>();

// ── 常量 ──
const MAX_IMAGES = 3;
const MAX_IMAGE_CHARS = 400_000;          // data URL 长度上限（约 300KB 二进制）
const MAX_ESSAY_CHARS = 20_000;

/** 校验图片数组：每项必须是 data:image/ URL，数量/体积封顶 */
function validImages(images: unknown): { ok: true; images: string[] } | { ok: false; error: string } {
  if (images === undefined || images === null) return { ok: true, images: [] };
  if (!Array.isArray(images)) return { ok: false, error: 'images 需为数组' };
  if (images.length > MAX_IMAGES) return { ok: false, error: `图片最多 ${MAX_IMAGES} 张` };
  for (const img of images) {
    if (typeof img !== 'string' || !/^data:image\/[a-z0-9.+-]+;base64,/i.test(img)) {
      return { ok: false, error: '图片需为 data URL 格式' };
    }
    if (img.length > MAX_IMAGE_CHARS) return { ok: false, error: '单张图片过大，请压缩后再上传' };
  }
  return { ok: true, images: images as string[] };
}

function parseJsonField<T>(v: unknown, fallback: T): T {
  if (typeof v !== 'string' || !v) return fallback;
  try { return JSON.parse(v) as T; } catch { return fallback; }
}

// ============================================================
// 作文 CRUD
// ============================================================

// ── 创建作文 ──
api.post('/essays', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{
    title?: string; genre?: string; topic_text?: string;
    topic_images?: string[]; custom_prompt?: string;
  }>().catch(() => ({}) as any);

  const title = (body.title || '').trim();
  const topicText = (body.topic_text || '').trim();
  if (!title) return c.json({ error: '标题不能为空' }, 400);
  if (!topicText) return c.json({ error: '题目内容不能为空' }, 400);
  const genre = body.genre && GENRES[body.genre] ? body.genre : 'sh-gaokao-essay';

  const img = validImages(body.topic_images);
  if (!img.ok) return c.json({ error: img.error }, 400);

  const customPrompt = body.custom_prompt?.trim() ? body.custom_prompt.trim().slice(0, 20000) : null;

  const result = await c.env.DB.prepare(
    `INSERT INTO essays (user_id, title, genre, topic_text, topic_images, custom_prompt)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(userId, title.slice(0, 200), genre, topicText.slice(0, 8000),
    JSON.stringify(img.images), customPrompt).run();

  return c.json({ essay_id: result.meta.last_row_id as number });
});

// ── 作文列表（含稿件数与最新得分）──
api.get('/essays', authMiddleware, async (c) => {
  const userId = c.get('userId');

  // 新用户首次访问：预置示例作文（一次性；标记入 user_flags，用户清空作文后不会重复灌入）
  const flag = await c.env.DB.prepare(
    "SELECT 1 FROM user_flags WHERE user_id = ? AND flag = 'seeded'",
  ).bind(userId).first();
  if (!flag) {
    const cnt = await c.env.DB.prepare(
      'SELECT COUNT(*) AS n FROM essays WHERE user_id = ?',
    ).bind(userId).first<{ n: number }>();
    if ((cnt?.n ?? 0) === 0) {
      await seedSampleEssay(c.env.DB, userId);
    }
    await c.env.DB.prepare(
      "INSERT OR IGNORE INTO user_flags (user_id, flag) VALUES (?, 'seeded')",
    ).bind(userId).run();
  }

  const rows = await c.env.DB.prepare(
    `SELECT e.id, e.title, e.genre, e.created_at, e.updated_at,
            (SELECT COUNT(*) FROM drafts WHERE essay_id = e.id) AS draft_count,
            (SELECT r.result FROM reviews r JOIN drafts d ON r.draft_id = d.id
              WHERE d.essay_id = e.id ORDER BY r.id DESC LIMIT 1) AS latest_review
     FROM essays e WHERE e.user_id = ? ORDER BY e.updated_at DESC`,
  ).bind(userId).all<{ id: number; title: string; genre: string; created_at: string; updated_at: string; draft_count: number; latest_review: string | null }>();

  const essays = rows.results.map(r => {
    const review = parseJsonField<{ score?: number } | null>(r.latest_review, null);
    return {
      id: r.id, title: r.title, genre: r.genre,
      genre_label: GENRES[r.genre]?.label ?? r.genre,
      draft_count: r.draft_count,
      latest_score: typeof review?.score === 'number' ? review.score : null,
      created_at: r.created_at, updated_at: r.updated_at,
    };
  });
  return c.json({ essays });
});

// ── 作文详情（题目 + 全部稿件及其批改 + 最近精修记录）──
api.get('/essays/:id', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const essayId = parseInt(c.req.param('id'));

  const essay = await c.env.DB.prepare(
    'SELECT * FROM essays WHERE id = ? AND user_id = ?',
  ).bind(essayId, userId).first<{
    id: number; title: string; genre: string; topic_text: string;
    topic_images: string | null; custom_prompt: string | null;
    created_at: string; updated_at: string;
  }>();
  if (!essay) return c.json({ error: '作文不存在' }, 404);

  const drafts = await c.env.DB.prepare(
    `SELECT d.*, (SELECT COUNT(*) FROM reviews WHERE draft_id = d.id) AS review_count
     FROM drafts d WHERE d.essay_id = ? ORDER BY d.version ASC`,
  ).bind(essayId).all<any>();

  const draftIds = drafts.results.map(d => d.id);
  const reviews = draftIds.length
    ? (await c.env.DB.prepare(
        `SELECT id, draft_id, result, model, reviewed_text, created_at FROM reviews
         WHERE draft_id IN (${draftIds.map(() => '?').join(',')}) ORDER BY id ASC`,
      ).bind(...draftIds).all<any>()).results
    : [];

  const polishes = (await c.env.DB.prepare(
    `SELECT id, draft_id, mode, fragment, instruction, result, created_at
     FROM polishes WHERE essay_id = ? ORDER BY id DESC LIMIT 20`,
  ).bind(essayId).all<any>()).results;

  return c.json({
    essay: {
      ...essay,
      topic_images: parseJsonField<string[]>(essay.topic_images, []),
      genre_label: GENRES[essay.genre]?.label ?? essay.genre,
      genre_total: GENRES[essay.genre]?.total ?? 25,
    },
    drafts: drafts.results.map(d => ({
      id: d.id, essay_id: d.essay_id, version: d.version, text: d.text,
      source: d.source, word_count: d.word_count, handwriting_score: d.handwriting_score,
      ocr_images: parseJsonField<string[]>(d.ocr_images, []),
      review_count: d.review_count, created_at: d.created_at,
      reviews: reviews.filter(r => r.draft_id === d.id).map(r => ({
        id: r.id, model: r.model, created_at: r.created_at, reviewed_text: r.reviewed_text ?? null,
        result: parseJsonField(r.result, {}),
      })),
    })),
    polishes: polishes.map(p => ({
      id: p.id, draft_id: p.draft_id, mode: p.mode, fragment: p.fragment,
      instruction: p.instruction, created_at: p.created_at,
      result: parseJsonField(p.result, {}),
    })),
  });
});

// ── 更新作文（标题/题目/自定义提示词）──
api.put('/essays/:id', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const essayId = parseInt(c.req.param('id'));
  const body = await c.req.json<{
    title?: string; topic_text?: string; topic_images?: string[]; custom_prompt?: string | null;
  }>().catch(() => ({}) as any);

  const essay = await c.env.DB.prepare(
    'SELECT id FROM essays WHERE id = ? AND user_id = ?',
  ).bind(essayId, userId).first();
  if (!essay) return c.json({ error: '作文不存在' }, 404);

  const sets: string[] = [];
  const vals: any[] = [];
  if (body.title !== undefined) {
    const t = body.title.trim();
    if (!t) return c.json({ error: '标题不能为空' }, 400);
    sets.push('title = ?'); vals.push(t.slice(0, 200));
  }
  if (body.topic_text !== undefined) {
    const t = body.topic_text.trim();
    if (!t) return c.json({ error: '题目内容不能为空' }, 400);
    sets.push('topic_text = ?'); vals.push(t.slice(0, 8000));
  }
  if (body.topic_images !== undefined) {
    const img = validImages(body.topic_images);
    if (!img.ok) return c.json({ error: img.error }, 400);
    sets.push('topic_images = ?'); vals.push(JSON.stringify(img.images));
  }
  if (body.custom_prompt !== undefined) {
    // 显式传 null / 空串 = 清除自定义，回落用户模板/内置默认
    const p = body.custom_prompt && body.custom_prompt.trim() ? body.custom_prompt.trim().slice(0, 20000) : null;
    sets.push('custom_prompt = ?'); vals.push(p);
  }
  if (sets.length === 0) return c.json({ ok: true });

  sets.push("updated_at = datetime('now')");
  await c.env.DB.prepare(`UPDATE essays SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, essayId).run();
  return c.json({ ok: true });
});

// ── 删除作文（级联删稿件/批改/精修）──
api.delete('/essays/:id', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const essayId = parseInt(c.req.param('id'));
  const r = await c.env.DB.prepare('DELETE FROM essays WHERE id = ? AND user_id = ?').bind(essayId, userId).run();
  if (!r.meta.changes) return c.json({ error: '作文不存在' }, 404);
  return c.json({ ok: true });
});

// ============================================================
// 稿件
// ============================================================

// ── 新增稿件（一稿/二稿/…；来源：photo/text/polish）──
api.post('/essays/:id/drafts', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const essayId = parseInt(c.req.param('id'));
  const body = await c.req.json<{
    text?: string; source?: string; handwriting_score?: number; ocr_images?: string[];
  }>().catch(() => ({}) as any);

  const essay = await c.env.DB.prepare(
    'SELECT id FROM essays WHERE id = ? AND user_id = ?',
  ).bind(essayId, userId).first();
  if (!essay) return c.json({ error: '作文不存在' }, 404);

  const text = (body.text || '').replace(/\r\n/g, '\n').trim();
  if (text.length < 10) return c.json({ error: '稿件内容过短' }, 400);
  if (text.length > MAX_ESSAY_CHARS) return c.json({ error: '稿件内容过长' }, 400);

  const source = ['photo', 'text', 'polish'].includes(body.source) ? body.source : 'text';
  const img = validImages(body.ocr_images);
  if (!img.ok) return c.json({ error: img.error }, 400);

  let handwriting: number | null = null;
  if (typeof body.handwriting_score === 'number' && Number.isFinite(body.handwriting_score)) {
    handwriting = Math.max(0, Math.min(1, body.handwriting_score));
  }

  const maxRow = await c.env.DB.prepare(
    'SELECT MAX(version) AS v FROM drafts WHERE essay_id = ?',
  ).bind(essayId).first<{ v: number | null }>();
  const version = (maxRow?.v ?? 0) + 1;

  const result = await c.env.DB.prepare(
    `INSERT INTO drafts (essay_id, user_id, version, text, source, word_count, handwriting_score, ocr_images)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(essayId, userId, version, text, source, countWords(text), handwriting,
    img.images.length ? JSON.stringify(img.images) : null).run();

  await c.env.DB.prepare("UPDATE essays SET updated_at = datetime('now') WHERE id = ?").bind(essayId).run();

  return c.json({ draft_id: result.meta.last_row_id as number, version });
});

// ── 修改稿件文本（保存后可重新批改）──
api.put('/drafts/:id', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const draftId = parseInt(c.req.param('id'));
  const body = await c.req.json<{ text?: string }>().catch(() => ({}) as any);

  const text = (body.text || '').replace(/\r\n/g, '\n').trim();
  if (text.length < 10) return c.json({ error: '稿件内容过短' }, 400);

  const draft = await c.env.DB.prepare(
    'SELECT id, essay_id FROM drafts WHERE id = ? AND user_id = ?',
  ).bind(draftId, userId).first<{ id: number; essay_id: number }>();
  if (!draft) return c.json({ error: '稿件不存在' }, 404);

  await c.env.DB.prepare('UPDATE drafts SET text = ?, word_count = ? WHERE id = ?')
    .bind(text, countWords(text), draftId).run();
  await c.env.DB.prepare("UPDATE essays SET updated_at = datetime('now') WHERE id = ?").bind(draft.essay_id).run();
  return c.json({ ok: true, word_count: countWords(text) });
});

// ── 删除稿件（连带其批改记录）──
api.delete('/drafts/:id', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const draftId = parseInt(c.req.param('id'));
  const r = await c.env.DB.prepare('DELETE FROM drafts WHERE id = ? AND user_id = ?').bind(draftId, userId).run();
  if (!r.meta.changes) return c.json({ error: '稿件不存在' }, 404);
  return c.json({ ok: true });
});

// ============================================================
// 批改
// ============================================================

// ── 对稿件执行批改 ──
api.post('/drafts/:id/review', authMiddleware, aiRateLimit, async (c) => {
  const userId = c.get('userId');
  const draftId = parseInt(c.req.param('id'));

  const draft = await c.env.DB.prepare(
    'SELECT * FROM drafts WHERE id = ? AND user_id = ?',
  ).bind(draftId, userId).first<{ id: number; essay_id: number; version: number; text: string }>();
  if (!draft) return c.json({ error: '稿件不存在' }, 404);

  const essay = await c.env.DB.prepare(
    'SELECT * FROM essays WHERE id = ? AND user_id = ?',
  ).bind(draft.essay_id, userId).first<{
    id: number; genre: string; topic_text: string; topic_images: string | null; custom_prompt: string | null;
  }>();
  if (!essay) return c.json({ error: '作文不存在' }, 404);

  // 生效提示词：作文自定义 > 用户模板 > 内置默认
  const { prompt: template, source: promptSource } = await getEffectivePrompt(
    c.env.DB, userId, essay.genre, essay.custom_prompt);

  // 上一稿反馈（二稿起注入，驱动 improvement 对比）
  const prevDraft = await c.env.DB.prepare(
    'SELECT id FROM drafts WHERE essay_id = ? AND version < ? ORDER BY version DESC LIMIT 1',
  ).bind(draft.essay_id, draft.version).first<{ id: number }>();
  let prevReview: { score: number; issues: { quote: string; type: string; correction: string }[] } | null = null;
  if (prevDraft) {
    const prevRow = await c.env.DB.prepare(
      'SELECT result FROM reviews WHERE draft_id = ? ORDER BY id DESC LIMIT 1',
    ).bind(prevDraft.id).first<{ result: string }>();
    if (prevRow) {
      const parsed = parseJsonField<any>(prevRow.result, {});
      if (typeof parsed?.score === 'number' && Array.isArray(parsed?.issues)) {
        prevReview = { score: parsed.score, issues: parsed.issues };
      }
    }
  }

  const topicImages = parseJsonField<string[]>(essay.topic_images, []);
  const topic = essay.topic_text + (topicImages.length ? '\n（题目配有图片，见本消息附图）' : '');

  const filled = fillTemplate(template, {
    topic,
    essay: draft.text,
    word_count: String(countWords(draft.text)),
    previous_feedback: prevReview
      ? buildPreviousFeedbackBlock(prevReview.score, prevReview.issues)
      : '',
  });

  // 题目带图 → 视觉通道（图画作文看图批改）；纯文本 → 主模型
  let cfg: ApiConfig;
  let contentParts: ContentPart[] | undefined;
  try {
    if (topicImages.length) {
      cfg = await getVisionConfig(c.env, userId);
      contentParts = [
        { type: 'text', text: filled },
        ...topicImages.map(url => ({ type: 'image_url', image_url: { url } })),
      ];
    } else {
      cfg = await getUserApiKey(c.env, userId);
    }
  } catch (err) {
    const fail = aiConfigFail(err);
    return c.json(fail.body, fail.status);
  }

  // 调用 + 校验 + 一次严格重试
  let result = null as ReturnType<typeof sanitizeReview> | null;
  let lastErr = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const userPrompt = attempt === 0
        ? filled
        : `${filled}\n\n【重试提醒】上一次返回不合法（${lastErr}）。请严格按上述 JSON 格式输出，quote 必须逐字取自作文原文。`;
      const raw = await callAI(
        cfg.key, cfg.baseUrl, cfg.model, '', userPrompt, true, contentParts, 4096, 0.3);
      result = sanitizeReview(extractJSON(raw), draft.text, !!prevReview);
      break;
    } catch (err: any) {
      if (isAIRateLimitError(err)) {
        return c.json({ error: friendlyAIError(err), rate_limited: true }, 429);
      }
      lastErr = err?.message ?? String(err);
      console.error(`[review] 第 ${attempt + 1} 次尝试失败: ${lastErr}`);
    }
  }
  if (!result) {
    return c.json({ error: '批改失败：AI 返回格式不符合要求', details: lastErr.slice(0, 300) }, 502);
  }

  // improvement 分差兜底：以真实分差覆盖
  if (result.improvement && prevReview) {
    result.improvement.score_delta = result.score - prevReview.score;
  }

  const model = cfg.provider === 'agnes' ? `${cfg.model}（免费通道）` : cfg.model;
  const insert = await c.env.DB.prepare(
    `INSERT INTO reviews (draft_id, essay_id, user_id, result, model, reviewed_text)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(draftId, draft.essay_id, userId, JSON.stringify(result), model, draft.text).run();

  await c.env.DB.prepare("UPDATE essays SET updated_at = datetime('now') WHERE id = ?").bind(draft.essay_id).run();

  return c.json({
    review_id: insert.meta.last_row_id as number,
    prompt_source: promptSource,
    model,
    result,
  });
});

// ============================================================
// 精修（片段） / 全文润色
// ============================================================

api.post('/essays/:id/polish', authMiddleware, aiRateLimit, async (c) => {
  const userId = c.get('userId');
  const essayId = parseInt(c.req.param('id'));
  const body = await c.req.json<{
    mode?: string; fragment?: string; instruction?: string; draft_id?: number;
  }>().catch(() => ({}) as any);

  const essay = await c.env.DB.prepare(
    'SELECT * FROM essays WHERE id = ? AND user_id = ?',
  ).bind(essayId, userId).first<{
    id: number; genre: string; topic_text: string;
  }>();
  if (!essay) return c.json({ error: '作文不存在' }, 404);

  // 精修/润色的上下文稿件：指定 draft_id，否则最新稿
  let contextDraftId: number | null = null;
  let contextText = '';
  if (body.draft_id) {
    const d = await c.env.DB.prepare(
      'SELECT id, text FROM drafts WHERE id = ? AND essay_id = ? AND user_id = ?',
    ).bind(body.draft_id, essayId, userId).first<{ id: number; text: string }>();
    if (d) { contextDraftId = d.id; contextText = d.text; }
  }
  if (!contextText) {
    const d = await c.env.DB.prepare(
      'SELECT id, text FROM drafts WHERE essay_id = ? AND user_id = ? ORDER BY version DESC LIMIT 1',
    ).bind(essayId, userId).first<{ id: number; text: string }>();
    if (d) { contextDraftId = d.id; contextText = d.text; }
  }

  let cfg: ApiConfig;
  try {
    cfg = await getUserApiKey(c.env, userId);
  } catch (err) {
    const fail = aiConfigFail(err);
    return c.json(fail.body, fail.status);
  }

  try {
    if (body.mode === 'fragment') {
      // ── 片段精修 ──
      const fragment = (body.fragment || '').trim();
      if (fragment.length < 3) return c.json({ error: '选中的片段过短' }, 400);
      if (fragment.length > 3000) return c.json({ error: '选中的片段过长（≤3000 字符）' }, 400);
      const instruction = (body.instruction || '').trim().slice(0, 1000) || '无特别要求，按常规标准精修';

      const filled = fillTemplate(FRAGMENT_POLISH_PROMPT, {
        topic: essay.topic_text.slice(0, 2000),
        essay: contextText.slice(0, 8000),
        fragment,
        instruction,
      });

      let parsedResult = null as ReturnType<typeof sanitizeFragmentPolish> | null;
      let lastErr = '';
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const userPrompt = attempt === 0
            ? filled
            : `${filled}\n\n【重试提醒】上一次返回不合法（${lastErr}），请严格按 JSON 格式输出。`;
          const raw = await callAI(cfg.key, cfg.baseUrl, cfg.model, '', userPrompt, true, undefined, 3000, 0.4);
          parsedResult = sanitizeFragmentPolish(extractJSON(raw));
          break;
        } catch (err: any) {
          if (isAIRateLimitError(err)) return c.json({ error: friendlyAIError(err), rate_limited: true }, 429);
          lastErr = err?.message ?? String(err);
        }
      }
      if (!parsedResult) throw new Error(lastErr || '精修失败');

      const insert = await c.env.DB.prepare(
        `INSERT INTO polishes (essay_id, draft_id, user_id, mode, fragment, instruction, result)
         VALUES (?, ?, ?, 'fragment', ?, ?, ?)`,
      ).bind(essayId, contextDraftId, userId, fragment, instruction, JSON.stringify(parsedResult)).run();
      return c.json({ polish_id: insert.meta.last_row_id as number, mode: 'fragment', result: parsedResult });
    }

    // ── 全文润色 ──
    if (!contextText) return c.json({ error: '该作文还没有稿件，无法润色' }, 400);
    const filled = fillTemplate(FULL_REWRITE_PROMPT, {
      topic: essay.topic_text.slice(0, 2000),
      essay: contextText,
      word_count: String(countWords(contextText)),
    });

    let parsedResult = null as ReturnType<typeof sanitizeFullRewrite> | null;
    let lastErr = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const userPrompt = attempt === 0
          ? filled
          : `${filled}\n\n【重试提醒】上一次返回不合法（${lastErr}），请严格按 JSON 格式输出。`;
        const raw = await callAI(cfg.key, cfg.baseUrl, cfg.model, '', userPrompt, true, undefined, 4096, 0.4);
        parsedResult = sanitizeFullRewrite(extractJSON(raw), contextText);
        break;
      } catch (err: any) {
        if (isAIRateLimitError(err)) return c.json({ error: friendlyAIError(err), rate_limited: true }, 429);
        lastErr = err?.message ?? String(err);
      }
    }
    if (!parsedResult) throw new Error(lastErr || '润色失败');

    const insert = await c.env.DB.prepare(
      `INSERT INTO polishes (essay_id, draft_id, user_id, mode, fragment, instruction, result)
       VALUES (?, ?, ?, 'full', NULL, NULL, ?)`,
    ).bind(essayId, contextDraftId, userId, JSON.stringify(parsedResult)).run();
    return c.json({ polish_id: insert.meta.last_row_id as number, mode: 'full', result: parsedResult });
  } catch (err: any) {
    return c.json({ error: friendlyAIError(err) }, 502);
  }
});

export default api;
