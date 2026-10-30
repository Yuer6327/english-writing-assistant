// ============================================================
// routes/essays.ts — 作文 / 稿件 CRUD + 批改 + 精修 / 全文润色
// 挂载于 /api：/essays..., /drafts/:id...
// ============================================================

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, Vars } from '../types';
import { userMiddleware } from '../middleware/auth';
import { aiRateLimit, aiConfigFail, rateLimitHit, clientIp } from '../utils/rate-limit';
import { callAI, extractJSON, friendlyAIError, isAIRateLimitError, ContentPart } from '../utils/ai';
import { getVisionConfig, resolveLane, laneFromBody, type Lane, type ResolvedConfig } from '../utils/api-config';
import * as billing from '../utils/billing';
import { tryAcquire, releaseSlot } from '../utils/inflight';
import {
  checkReviewGate, quotaState, checkEssayGate, checkDraftGate, successStmt, GUEST_DAILY_ESSAYS, beijingDay,
} from '../utils/quota';
import {
  GENRES, fillTemplate, getEffectivePrompt, buildPreviousFeedbackBlock,
  FRAGMENT_POLISH_PROMPT, FULL_REWRITE_PROMPT, validatePromptTemplate,
} from '../utils/prompts';
import {
  countWords, sanitizeReview, sanitizeFragmentPolish, sanitizeFullRewrite,
} from '../utils/validate';
import { seedSampleEssay } from '../sample/seed';
import { MAX_IMAGES, MAX_IMAGE_CHARS, estimateImageTokens, estimateTextTokens } from '../utils/limits';

const api = new Hono<{ Bindings: Env; Variables: Vars }>();

// ── 常量 ──
const MAX_ESSAY_CHARS = 20_000;

/** deepseek-flash 为混合推理模型，reasoning 计入 max_tokens 预算，输出上限放大 */
const maxOutputFor = (lane: Lane, base: number): number => (lane === 'deepseek' ? Math.max(base * 2, 8192) : base);

/** billing 错误 → HTTP 响应（402 等直接透传，code 供前端分流） */
function billingFail(err: unknown): { body: { error: string; code?: string }; status: number } {
  if (err instanceof billing.BillingError) {
    return { body: { error: err.message, code: err.code }, status: err.status };
  }
  console.error('[billing] 调用异常:', err instanceof Error ? err.message : err);
  return { body: { error: '计费服务暂不可用，请稍后重试', code: 'billing_unavailable' }, status: 503 };
}

/** 车道 → 对外标签（前端显示与响应 lane 字段） */
function laneLabel(lane: Lane): 'free' | 'paid' | 'byok' {
  return lane === 'deepseek' ? 'paid' : lane;
}

/** 校验图片数组：每项必须是位图 data URL（拒 SVG 等可携带脚本的 MIME），数量/体积封顶 */
function validImages(images: unknown): { ok: true; images: string[] } | { ok: false; error: string } {
  if (images === undefined || images === null) return { ok: true, images: [] };
  if (!Array.isArray(images)) return { ok: false, error: 'images 需为数组' };
  if (images.length > MAX_IMAGES) return { ok: false, error: `图片最多 ${MAX_IMAGES} 张` };
  for (const img of images) {
    if (typeof img !== 'string' || !/^data:image\/(png|jpe?g|webp|gif|bmp|heic|heif|avif);base64,/i.test(img)) {
      return { ok: false, error: '图片格式不支持（需 jpg/png/webp 等位图）' };
    }
    if (img.length > MAX_IMAGE_CHARS) return { ok: false, error: '单张图片过大，请压缩后再上传' };
  }
  return { ok: true, images: images as string[] };
}

function parseJsonField<T>(v: unknown, fallback: T, context = ''): T {
  if (typeof v !== 'string' || !v) return fallback;
  try { return JSON.parse(v) as T; } catch {
    console.warn(`[parseJson] JSON 损坏${context ? `（${context}）` : ''}`);
    return fallback;
  }
}

/** 路径/请求体里的自增 id：必须是正整数，否则直接当"不存在"（避免 NaN 绑定与无谓查库） */
function parseId(raw: unknown): number | null {
  if (typeof raw !== 'string' && typeof raw !== 'number') return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** 仅登录用户可用的能力：游客拿到 403（code=login_required），前端弹登录引导而非整页跳转 */
function memberOnly(c: Context<{ Bindings: Env; Variables: Vars }>): Response | null {
  if (!c.get('isGuest')) return null;
  return c.json({ error: '该功能登录后可用（游客仅支持批改）', code: 'login_required' }, 403);
}

/** 游客 IP 级软兜底：清掉 cookie 就能重置次数，IP 计数让刷次数变贵（内存计数，尽力而为） */
function guestIpLimitHit(c: Context<{ Bindings: Env; Variables: Vars }>, limit: number): boolean {
  if (!c.get('isGuest')) return false;
  return rateLimitHit(`guest:ip:${clientIp(c)}`, limit, 24 * 3600_000);
}

/**
 * 游客建作文的并发回收：先插入，再看今天名下已有几篇；超出 1 篇时只保留 id 最小的
 * 那篇，其余由各请求自行删除自己的插入。三个并发请求同时通过预检（TOCTOU）时，
 * 每个请求都看到全部插入、只删自己的（id 不是最小者），最终恰好收敛为 1 篇 ——
 * 旧实现「先 count 后 insert」没有互斥，实测并发 3 请求能建出 3 篇。
 * 返回 true = 本次插入被回收（应回 403）。
 */
async function reclaimGuestExtraEssays(db: Env['DB'], userId: string, insertedId: number): Promise<boolean> {
  const day = beijingDay();
  const rows = (await db.prepare(
    "SELECT id FROM essays WHERE user_id = ? AND date(created_at, '+8 hours') = ? ORDER BY id ASC",
  ).bind(userId, day).all<{ id: number }>()).results;
  if (rows.length <= GUEST_DAILY_ESSAYS) return false;
  if (rows[0].id === insertedId) return false;   // 我是最早的，留下；其余请求会自删
  await db.prepare('DELETE FROM essays WHERE id = ? AND user_id = ?').bind(insertedId, userId).run();
  return true;
}

// ============================================================
// 作文 CRUD
// ============================================================

// ── 创建作文 ──
api.post('/essays', userMiddleware, async (c) => {
  const userId = c.get('userId');
  const isGuest = c.get('isGuest');
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

  const customPrompt = body.custom_prompt?.trim() ? body.custom_prompt.trim() : null;
  if (customPrompt) {
    const valid = validatePromptTemplate(customPrompt);
    if (!valid.ok) return c.json({ error: valid.error }, 400);
  }

  // 游客 IP 兜底：建作文同样受 IP 计数约束（清 cookie 轮换不能再无限灌作文/图片）
  if (guestIpLimitHit(c, 15)) {
    return c.json({ error: '今日请求次数过多，请明天再试或登录使用', code: 'guest_ip_limit' }, 429);
  }

  // 游客：每天 1 篇（一稿/二稿/三稿共用那 3 次批改）
  const gate = await checkEssayGate(c.env.DB, userId, isGuest);
  if (!gate.ok) return c.json({ error: gate.error, code: gate.code }, gate.status);

  const result = await c.env.DB.prepare(
    `INSERT INTO essays (user_id, title, genre, topic_text, topic_images, custom_prompt)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(userId, title.slice(0, 200), genre, topicText.slice(0, 8000),
    JSON.stringify(img.images), customPrompt).run();

  // 并发预检绕过回收：预检（count）与插入之间无互斥，N 个并发请求都能通过；
  // 插入后按「保留今日最早一篇」收敛，超出者自删并回 403。
  if (isGuest) {
    const reclaimed = await reclaimGuestExtraEssays(c.env.DB, userId, result.meta.last_row_id as number);
    if (reclaimed) {
      return c.json({ error: '游客每天只能写一篇作文，登录后不限篇数。', code: 'guest_essay_limit' }, 403);
    }
  }

  return c.json({ essay_id: result.meta.last_row_id as number });
});

// ── 作文列表（含稿件数与最新得分）──
api.get('/essays', userMiddleware, async (c) => {
  const userId = c.get('userId');
  const isGuest = c.get('isGuest');

  // 新用户首次访问：预置示例作文（一次性；标记入 user_flags，用户清空作文后不会重复灌入）
  // 游客不预置：他们要的是空白试用，塞一篇示例会占用"每天 1 篇"的名额
  if (!isGuest) {
    const claim = await c.env.DB.prepare(
      "INSERT OR IGNORE INTO user_flags (user_id, flag) VALUES (?, 'seeded')",
    ).bind(userId).run();
    if (claim.meta.changes === 1) {
      const cnt = await c.env.DB.prepare(
        'SELECT COUNT(*) AS n FROM essays WHERE user_id = ?',
      ).bind(userId).first<{ n: number }>();
      if ((cnt?.n ?? 0) === 0) await seedSampleEssay(c.env.DB, userId);
    }
  }

  const rows = await c.env.DB.prepare(
    `SELECT e.id, e.title, e.genre, e.created_at, e.updated_at,
            (SELECT COUNT(*) FROM drafts WHERE essay_id = e.id) AS draft_count,
            (SELECT json_extract(r.result, '$.score') FROM reviews r JOIN drafts d ON r.draft_id = d.id
              WHERE d.essay_id = e.id ORDER BY r.id DESC LIMIT 1) AS latest_score
     FROM essays e WHERE e.user_id = ? ORDER BY e.updated_at DESC LIMIT 200`,
  ).bind(userId).all<{ id: number; title: string; genre: string; created_at: string; updated_at: string; draft_count: number; latest_score: number | null }>();

  const essays = rows.results.map(r => ({
    id: r.id, title: r.title, genre: r.genre,
    genre_label: GENRES[r.genre]?.label ?? r.genre,
    draft_count: r.draft_count,
    latest_score: typeof r.latest_score === 'number' ? r.latest_score : null,
    created_at: r.created_at, updated_at: r.updated_at,
  }));
  return c.json({ essays, quota: await quotaState(c.env.DB, userId, isGuest) });
});

// ── 作文详情（题目 + 全部稿件及其批改 + 最近精修记录）──
api.get('/essays/:id', userMiddleware, async (c) => {
  const userId = c.get('userId');
  const essayId = parseId(c.req.param('id'));
  if (essayId === null) return c.json({ error: '作文不存在' }, 404);

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
    `SELECT id, draft_id, mode, created_at
     FROM polishes WHERE essay_id = ? ORDER BY id DESC LIMIT 20`,
  ).bind(essayId).all<any>()).results;

  return c.json({
    essay: {
      ...essay,
      topic_images: parseJsonField<string[]>(essay.topic_images, []),
      genre_label: GENRES[essay.genre]?.label ?? essay.genre,
      genre_total: GENRES[essay.genre]?.total ?? 25,
      word_limits: GENRES[essay.genre] ?? GENRES['sh-gaokao-essay'],
    },
    drafts: drafts.results.map(d => ({
      id: d.id, essay_id: d.essay_id, version: d.version, text: d.text,
      source: d.source, word_count: d.word_count, handwriting_score: d.handwriting_score,
      ocr_image_count: parseJsonField<string[]>(d.ocr_images, []).length,
      review_count: d.review_count, created_at: d.created_at,
      reviews: reviews.filter(r => r.draft_id === d.id).map(r => ({
        id: r.id, model: r.model, created_at: r.created_at, reviewed_text: r.reviewed_text ?? null,
        result: parseJsonField(r.result, {}, `review:${r.id}`),
      })),
    })),
    polishes: polishes.map(p => ({
      id: p.id, draft_id: p.draft_id, mode: p.mode, created_at: p.created_at,
    })),
  });
});

// ── 按需读取某稿 OCR 原图（详情接口只返回图片数量）──
api.get('/drafts/:id/images', userMiddleware, async (c) => {
  const draftId = parseId(c.req.param('id'));
  if (draftId === null) return c.json({ error: '稿件不存在' }, 404);
  const row = await c.env.DB.prepare(
    'SELECT ocr_images FROM drafts WHERE id = ? AND user_id = ?',
  ).bind(draftId, c.get('userId')).first<{ ocr_images: string | null }>();
  if (!row) return c.json({ error: '稿件不存在' }, 404);
  return c.json({ images: parseJsonField<string[]>(row.ocr_images, []) });
});

// ── 更新作文（标题/题目/自定义提示词）──
api.put('/essays/:id', userMiddleware, async (c) => {
  const userId = c.get('userId');
  const essayId = parseId(c.req.param('id'));
  if (essayId === null) return c.json({ error: '作文不存在' }, 404);
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
    const p = body.custom_prompt && body.custom_prompt.trim() ? body.custom_prompt.trim() : null;
    if (p) {
      const valid = validatePromptTemplate(p);
      if (!valid.ok) return c.json({ error: valid.error }, 400);
    }
    sets.push('custom_prompt = ?'); vals.push(p);
  }
  if (sets.length === 0) return c.json({ ok: true });

  sets.push("updated_at = datetime('now')");
  await c.env.DB.prepare(`UPDATE essays SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, essayId).run();
  return c.json({ ok: true });
});

// ── 删除作文（级联删稿件/批改/精修）──
api.delete('/essays/:id', userMiddleware, async (c) => {
  const userId = c.get('userId');
  const essayId = parseId(c.req.param('id'));
  if (essayId === null) return c.json({ error: '作文不存在' }, 404);
  const r = await c.env.DB.prepare('DELETE FROM essays WHERE id = ? AND user_id = ?').bind(essayId, userId).run();
  if (!r.meta.changes) return c.json({ error: '作文不存在' }, 404);
  return c.json({ ok: true });
});

// ============================================================
// 稿件
// ============================================================

// ── 新增稿件（一稿/二稿/…；来源：photo/text/polish）──
api.post('/essays/:id/drafts', userMiddleware, async (c) => {
  const userId = c.get('userId');
  const isGuest = c.get('isGuest');
  const essayId = parseId(c.req.param('id'));
  if (essayId === null) return c.json({ error: '作文不存在' }, 404);
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

  // 游客：每篇最多 3 稿（一稿/二稿/三稿）；登录用户不限
  const gate = await checkDraftGate(c.env.DB, userId, isGuest, essayId, version);
  if (!gate.ok) return c.json({ error: gate.error, code: gate.code }, gate.status);

  let result: Awaited<ReturnType<ReturnType<typeof c.env.DB.prepare>['run']>> | null = null;
  let actualVersion = version;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      result = await c.env.DB.prepare(
        `INSERT INTO drafts (essay_id, user_id, version, text, source, word_count, handwriting_score, ocr_images)
         SELECT ?, ?, COALESCE(MAX(version), 0) + 1, ?, ?, ?, ?, ?
           FROM drafts WHERE essay_id = ?`,
      ).bind(essayId, userId, text, source, countWords(text), handwriting,
        img.images.length ? JSON.stringify(img.images) : null, essayId).run();
      break;
    } catch (err) {
      if (attempt === 1 || !/UNIQUE constraint failed/i.test(String(err))) throw err;
    }
  }
  if (!result) return c.json({ error: '稿件保存冲突，请重试', code: 'draft_conflict' }, 409);

  const saved = await c.env.DB.prepare('SELECT version FROM drafts WHERE id = ?')
    .bind(result.meta.last_row_id).first<{ version: number }>();
  actualVersion = saved?.version ?? version;

  // 并发可能让实际版本越过预检值；以真实写入版本复核并回收越界稿。
  const actualGate = await checkDraftGate(c.env.DB, userId, isGuest, essayId, actualVersion);
  if (!actualGate.ok) {
    await c.env.DB.prepare('DELETE FROM drafts WHERE id = ?').bind(result.meta.last_row_id).run();
    return c.json({ error: actualGate.error, code: actualGate.code }, actualGate.status);
  }

  await c.env.DB.prepare("UPDATE essays SET updated_at = datetime('now') WHERE id = ?").bind(essayId).run();

  return c.json({ draft_id: result.meta.last_row_id as number, version: actualVersion });
});

// ── 修改稿件文本（保存后可重新批改）──
api.put('/drafts/:id', userMiddleware, async (c) => {
  const userId = c.get('userId');
  const draftId = parseId(c.req.param('id'));
  if (draftId === null) return c.json({ error: '稿件不存在' }, 404);
  const body = await c.req.json<{ text?: string }>().catch(() => ({}) as any);

  const text = (body.text || '').replace(/\r\n/g, '\n').trim();
  if (text.length < 10) return c.json({ error: '稿件内容过短' }, 400);
  // 与新建稿件同一条上限，避免绕过前端直接写超长文本撑爆 D1 行体积
  if (text.length > MAX_ESSAY_CHARS) return c.json({ error: '稿件内容过长' }, 400);

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
api.delete('/drafts/:id', userMiddleware, async (c) => {
  const userId = c.get('userId');
  const draftId = parseId(c.req.param('id'));
  if (draftId === null) return c.json({ error: '稿件不存在' }, 404);
  const r = await c.env.DB.prepare('DELETE FROM drafts WHERE id = ? AND user_id = ?').bind(draftId, userId).run();
  if (!r.meta.changes) return c.json({ error: '稿件不存在' }, 404);
  return c.json({ ok: true });
});

// ============================================================
// 批改
// ============================================================

// ── 对稿件执行批改 ──
api.post('/drafts/:id/review', userMiddleware, aiRateLimit, async (c) => {
  const startedAt = Date.now();
  const aiDeadline = startedAt + 90_000;
  const userId = c.get('userId');
  const isGuest = c.get('isGuest');
  const draftId = parseId(c.req.param('id'));
  if (draftId === null) return c.json({ error: '稿件不存在' }, 404);
  const body = await c.req.json<{ model_id?: string }>().catch(() => ({}) as any);

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

  // 游客只能用免费通道（没有钱包/自备 Key）；付费通道需要登录
  if (isGuest && body.model_id && body.model_id !== 'free') {
    return c.json({ error: '游客只能使用免费通道，登录后可选 DeepSeek 或自备 Key', code: 'login_required' }, 403);
  }

  // 次数门禁（业务侧口径：成功才计数）——放在调 AI 之前，避免白烧 token
  if (guestIpLimitHit(c, 15)) {
    return c.json({ error: '今日批改次数过多，请明天再试或登录使用', code: 'guest_ip_limit' }, 429);
  }
  const lane: Lane = isGuest ? 'free' : await laneFromBody(c.env, userId, body.model_id);
  const gate = await checkReviewGate(c.env.DB, userId, isGuest, { lane, draftId });
  if (!gate.ok) return c.json({ error: gate.error, code: gate.code }, gate.status);

  // 生效提示词：作文自定义 > 用户模板（按题型） > 内置默认
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

  // 模型配置解析（车道已在门禁前确定）
  let cfg: ResolvedConfig;
  let contentParts: ContentPart[] | undefined;
  try {
    if (topicImages.length) {
      cfg = await getVisionConfig(c.env, userId, lane);
      contentParts = [
        { type: 'text', text: filled },
        ...topicImages.map(url => ({ type: 'image_url', image_url: { url } })),
      ];
    } else {
      cfg = await resolveLane(c.env, userId, lane);
    }
  } catch (err) {
    const fail = aiConfigFail(err);
    return c.json(fail.body, fail.status);
  }

  // ── 预扣费（免费额度 → mode:'free'；BYOK → mode:'byok'；付费 → 冻结）──
  // 免费档带 skipQuota：次数由上面的 checkReviewGate/recordSuccess 按「成功」计数，
  // 不由 billing 在调用前扣（否则失败也扣次数）。
  const maxOutput = maxOutputFor(lane, 4096);
  let holdInfo: billing.HoldInfo;
  try {
    holdInfo = await billing.hold(c.env, userId, 'writing', cfg.serviceId, {
      estInputTokens: estimateTextTokens(filled) + estimateImageTokens(topicImages, cfg.provider, cfg.model),
      maxOutputTokens: maxOutput,
      skipQuota: lane === 'free',
    });
  } catch (err) {
    const fail = billingFail(err);
    return c.json(fail.body, fail.status as 402);
  }

  // heavy 并发锁：同用户在飞 1 笔（免费档与付费档占用；BYOK 不占）
  // 免费档也必须锁：否则连点会并发跑多次，成功后 3 次额度被瞬间吃光
  const lockToken = holdInfo.mode !== 'byok' ? tryAcquire(userId) : null;
  if (holdInfo.mode !== 'byok' && lockToken === null) {
    await billing.releaseQuietly(c.env, holdInfo.holdId);
    return c.json({ error: '已有批改任务进行中，请等待完成后再试', code: 'concurrent_limit' }, 429);
  }
  const locked = holdInfo.mode !== 'byok';

  let settled = false;
  let charged = 0;
  try {
    // 调用 + 校验 + 一次严格重试
    let result = null as ReturnType<typeof sanitizeReview> | null;
    let lastErr = '';
    let attemptsUsed = 0;
    let lastUsage: { prompt_tokens: number; completion_tokens: number } | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      attemptsUsed = attempt + 1;
      try {
        const userPrompt = attempt === 0
          ? filled
          : `${filled}\n\n【重试提醒】上一次返回不合法（${lastErr}）。请严格按上述 JSON 格式输出，quote 必须逐字取自作文原文。`;
        const raw = await callAI(
          cfg.key, cfg.baseUrl, cfg.model, '', userPrompt, true, contentParts, maxOutput, 0.3, aiDeadline);
        lastUsage = raw.usage;
        result = sanitizeReview(extractJSON(raw.content), draft.text, !!prevReview);
        break;
      } catch (err: any) {
        if (isAIRateLimitError(err)) {
          await billing.releaseQuietly(c.env, holdInfo.holdId);
          return c.json({ error: friendlyAIError(err), rate_limited: true }, 429);
        }
        lastErr = err?.message ?? String(err);
        console.error(`[review] 第 ${attempt + 1} 次尝试失败: ${lastErr}`);
        // 配置/网络/超时类失败立即终止，不把 4xx 与 abort 叠成第二轮
        if (/^AI API error \d{3}|abort|timed? ?out|fetch failed|超时/i.test(lastErr)) throw err;
      }
    }
    if (!result) {
      await billing.releaseQuietly(c.env, holdInfo.holdId);
      console.error(`[review] AI 输出校验失败（${attemptsUsed} 次）: ${lastErr.slice(0, 300)}`);
      return c.json({ error: '批改失败：AI 返回格式不符合要求，请稍后重试' }, 502);
    }

    // 结算（实际成本，多退少补；settle 失败不阻塞结果返回，未结算的 hold 由 cron 过期释放兜底）
    if (holdInfo.mode === 'hold') {
      try {
        const s = await billing.settle(c.env, holdInfo.holdId!, {
          promptTokens: lastUsage?.prompt_tokens,
          completionTokens: lastUsage?.completion_tokens,
        });
        charged = s.charged;
        settled = true;
      } catch (err) {
        console.error('[review] settle 失败（hold 将被 cron 过期释放）:', err instanceof Error ? err.message : err);
      }
    }

    // improvement 分差兜底：以真实分差覆盖
    if (result.improvement && prevReview) {
      result.improvement.score_delta = result.score - prevReview.score;
    }

    const model = cfg.provider === 'agnes' ? `${cfg.model}（免费通道）`
      : cfg.provider === 'deepseek' ? `${cfg.model}（按量计费）` : cfg.model;

    const meta = JSON.stringify({
      elapsed_ms: Date.now() - startedAt,
      attempts: attemptsUsed,
      prompt_tokens: lastUsage?.prompt_tokens ?? null,
      completion_tokens: lastUsage?.completion_tokens ?? null,
      issues_total: result.issues.length,
      issues_unlocated: result.issues.filter(i => i.located === false).length,
      prompt_source: promptSource,
    });

    // 结果与成功计次同一事务；游客「每稿一次」由唯一索引和条件插入硬约束。
    const stmts = [isGuest && lane === 'free'
      ? c.env.DB.prepare(
        `INSERT INTO reviews (draft_id, essay_id, user_id, result, model, reviewed_text, meta)
         SELECT ?, ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (
             SELECT 1 FROM quota_events
              WHERE user_id = ? AND draft_id = ? AND kind = 'review'
           )`,
      ).bind(draftId, draft.essay_id, userId, JSON.stringify(result), model, draft.text, meta,
        userId, draftId)
      : c.env.DB.prepare(
        `INSERT INTO reviews (draft_id, essay_id, user_id, result, model, reviewed_text, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(draftId, draft.essay_id, userId, JSON.stringify(result), model, draft.text, meta)];
    if (lane === 'free') stmts.push(successStmt(c.env.DB, userId, 'review', draft.essay_id, draftId));

    let insert: { meta: { last_row_id: number | null; changes: number } } | null = null;
    try {
      const [insertResult, quotaResult] = await c.env.DB.batch(stmts as any);
      insert = insertResult as any;
      // 游客并发重试时第二笔不重复写结果、不计次，直接释放。
      if (isGuest && lane === 'free' && insert?.meta.changes === 0) {
        if (holdInfo.mode === 'hold' && !settled) await billing.releaseQuietly(c.env, holdInfo.holdId);
        return c.json({
          error: '这稿已经批改过了。写下一篇（二稿/三稿）才能再批改——游客每天 3 次，一稿、二稿、三稿各一次。',
          code: 'already_reviewed',
        }, 409);
      }
      if (isGuest && lane === 'free' && (quotaResult as any)?.meta?.changes === 0) {
        console.error('[review] 游客额度写入被唯一约束拦截（结果已落库但未计次）');
      }
    } catch (err) {
      // 已生成且已结算的合法结果优先交付；落库失败不丢结果、不算用户失败。
      console.error('[review] 结果落库失败，本次结果未持久化、未计次:', err instanceof Error ? err.message : err);
    }

    try {
      await c.env.DB.prepare("UPDATE essays SET updated_at = datetime('now') WHERE id = ?").bind(draft.essay_id).run();
    } catch (err) {
      console.error('[review] 更新作文时间失败:', err instanceof Error ? err.message : err);
    }

    return c.json({
      review_id: insert?.meta?.last_row_id ?? null,
      persisted: insert?.meta?.changes === 1,
      prompt_source: promptSource,
      model,
      result,
      points_charged: charged,          // 分（前端 ÷100 展示）
      lane: laneLabel(lane),            // free / paid / byok
      quota: await quotaState(c.env.DB, userId, isGuest),
    });
  } catch (err: any) {
    // 外层兜底：任何未结算的意外失败都释放预扣
    if (holdInfo.mode === 'hold' && !settled) {
      await billing.releaseQuietly(c.env, holdInfo.holdId);
    }
    console.error('[review] 未预期失败:', err?.message ?? err);
    return c.json({ error: friendlyAIError(err) }, 502);
  } finally {
    if (locked) releaseSlot(userId, lockToken);
  }
});

// ============================================================
// 精修（片段） / 全文润色
// ============================================================

api.post('/essays/:id/polish', userMiddleware, aiRateLimit, async (c) => {
  // 精修/润色对游客关闭（免费通道的 token 成本只留给 3 次批改）
  const denied = memberOnly(c);
  if (denied) return denied;
  const aiDeadline = Date.now() + 90_000;
  const userId = c.get('userId');
  const essayId = parseId(c.req.param('id'));
  if (essayId === null) return c.json({ error: '作文不存在' }, 404);
  const body = await c.req.json<{
    mode?: string; fragment?: string; instruction?: string; draft_id?: number; model_id?: string;
  }>().catch(() => ({}) as any);

  // ── 入参校验一律前置到预扣费之前 ──
  // 旧实现把片段长度校验放在 hold 之后，早退时既没 settle 也没 release，
  // 冻结的积分要等 cron 过期才回滚（用户会看到"没批改却扣了额度"）。
  const isFragment = body.mode === 'fragment';
  const fragment = (body.fragment || '').trim();
  const instruction = (body.instruction || '').trim().slice(0, 1000) || '无特别要求，按常规标准精修';
  if (isFragment) {
    if (fragment.length < 3) return c.json({ error: '选中的片段过短' }, 400);
    if (fragment.length > 3000) return c.json({ error: '选中的片段过长（≤3000 字符）' }, 400);
  }

  const essay = await c.env.DB.prepare(
    'SELECT * FROM essays WHERE id = ? AND user_id = ?',
  ).bind(essayId, userId).first<{
    id: number; genre: string; topic_text: string;
  }>();
  if (!essay) return c.json({ error: '作文不存在' }, 404);

  // 精修/润色的上下文稿件：指定 draft_id，否则最新稿
  let contextDraftId: number | null = null;
  let contextText = '';
  const bodyDraftId = parseId(body.draft_id);
  if (bodyDraftId !== null) {
    const d = await c.env.DB.prepare(
      'SELECT id, text FROM drafts WHERE id = ? AND essay_id = ? AND user_id = ?',
    ).bind(bodyDraftId, essayId, userId).first<{ id: number; text: string }>();
    if (d) { contextDraftId = d.id; contextText = d.text; }
  }
  if (!contextText) {
    const d = await c.env.DB.prepare(
      'SELECT id, text FROM drafts WHERE essay_id = ? AND user_id = ? ORDER BY version DESC LIMIT 1',
    ).bind(essayId, userId).first<{ id: number; text: string }>();
    if (d) { contextDraftId = d.id; contextText = d.text; }
  }

  // 全文润色必须有稿件；放在扣费前判断，避免"扣了冻结额度才发现没得润色"
  if (!isFragment && !contextText) {
    return c.json({ error: '该作文还没有稿件，无法润色' }, 400);
  }

  const lane = await laneFromBody(c.env, userId, body.model_id);
  let cfg: ResolvedConfig;
  try {
    cfg = await resolveLane(c.env, userId, lane);
  } catch (err) {
    const fail = aiConfigFail(err);
    return c.json(fail.body, fail.status);
  }

  const maxOutput = maxOutputFor(lane, isFragment ? 3000 : 4096);

  // ── 预扣费（片段 / 全文输出上限）──
  let holdInfo: billing.HoldInfo;
  try {
    const estBase = estimateTextTokens(
      essay.topic_text + (contextText || '') + (isFragment ? fragment : ''));
    holdInfo = await billing.hold(c.env, userId, 'writing', cfg.serviceId, {
      estInputTokens: estBase,
      maxOutputTokens: maxOutput,
      // 免费档的每日次数由本 Worker 的 quota_events 管（批改才计数，精修/润色不计次），
      // billing 侧不再对它做次数判定（writing 的 LLM 次数规则已删除）
      skipQuota: lane === 'free',
    });
  } catch (err) {
    const fail = billingFail(err);
    return c.json(fail.body, fail.status as 402);
  }

  const lockToken = holdInfo.mode !== 'byok' ? tryAcquire(userId) : null;
  if (holdInfo.mode !== 'byok' && lockToken === null) {
    await billing.releaseQuietly(c.env, holdInfo.holdId);
    return c.json({ error: '已有 AI 任务进行中，请等待完成后再试', code: 'concurrent_limit' }, 429);
  }
  const locked = holdInfo.mode !== 'byok';

  let settled = false;
  let charged = 0;
  try {
    if (isFragment) {
      // ── 片段精修（fragment / instruction 已在扣费前校验）──
      const filled = fillTemplate(FRAGMENT_POLISH_PROMPT, {
        topic: essay.topic_text.slice(0, 2000),
        essay: contextText.slice(0, 8000),
        fragment,
        instruction,
      });

      let parsedResult = null as ReturnType<typeof sanitizeFragmentPolish> | null;
      let lastErr = '';
      let lastUsage: { prompt_tokens: number; completion_tokens: number } | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const userPrompt = attempt === 0
            ? filled
            : `${filled}\n\n【重试提醒】上一次返回不合法（${lastErr}），请严格按 JSON 格式输出。`;
          const raw = await callAI(cfg.key, cfg.baseUrl, cfg.model, '', userPrompt, true, undefined, maxOutput, 0.4, aiDeadline);
          lastUsage = raw.usage;
          parsedResult = sanitizeFragmentPolish(extractJSON(raw.content));
          break;
        } catch (err: any) {
          if (isAIRateLimitError(err)) {
            await billing.releaseQuietly(c.env, holdInfo.holdId);
            return c.json({ error: friendlyAIError(err), rate_limited: true }, 429);
          }
          lastErr = err?.message ?? String(err);
          if (/^AI API error \d{3}|abort|timed? ?out|fetch failed|超时/i.test(lastErr)) throw err;
        }
      }
      if (!parsedResult) {
        await billing.releaseQuietly(c.env, holdInfo.holdId);
        throw new Error(lastErr || '精修失败');
      }

      if (holdInfo.mode === 'hold') {
        try {
          const s = await billing.settle(c.env, holdInfo.holdId!, {
            promptTokens: lastUsage?.prompt_tokens,
            completionTokens: lastUsage?.completion_tokens,
          });
          charged = s.charged;
          settled = true;
        } catch (err) {
          console.error('[polish] settle 失败（hold 将被 cron 过期释放）:', err instanceof Error ? err.message : err);
        }
      }

      const insert = await c.env.DB.prepare(
        `INSERT INTO polishes (essay_id, draft_id, user_id, mode, fragment, instruction, result)
         VALUES (?, ?, ?, 'fragment', ?, ?, ?)`,
      ).bind(essayId, contextDraftId, userId, fragment, instruction, JSON.stringify(parsedResult)).run();
      return c.json({
        polish_id: insert.meta.last_row_id as number, mode: 'fragment', result: parsedResult,
        points_charged: charged, lane: laneLabel(lane),
      });
    }

    // ── 全文润色 ──
    if (!contextText) {
      await billing.releaseQuietly(c.env, holdInfo.holdId);
      return c.json({ error: '该作文还没有稿件，无法润色' }, 400);
    }
    const filled = fillTemplate(FULL_REWRITE_PROMPT, {
      topic: essay.topic_text.slice(0, 2000),
      essay: contextText,
      word_count: String(countWords(contextText)),
    });

    let parsedResult = null as ReturnType<typeof sanitizeFullRewrite> | null;
    let lastErr = '';
    let lastUsage: { prompt_tokens: number; completion_tokens: number } | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const userPrompt = attempt === 0
          ? filled
          : `${filled}\n\n【重试提醒】上一次返回不合法（${lastErr}），请严格按 JSON 格式输出。`;
        const raw = await callAI(cfg.key, cfg.baseUrl, cfg.model, '', userPrompt, true, undefined, maxOutput, 0.4, aiDeadline);
        lastUsage = raw.usage;
        parsedResult = sanitizeFullRewrite(extractJSON(raw.content), contextText);
        break;
      } catch (err: any) {
        if (isAIRateLimitError(err)) {
          await billing.releaseQuietly(c.env, holdInfo.holdId);
          return c.json({ error: friendlyAIError(err), rate_limited: true }, 429);
        }
        lastErr = err?.message ?? String(err);
      }
    }
    if (!parsedResult) {
      await billing.releaseQuietly(c.env, holdInfo.holdId);
      throw new Error(lastErr || '润色失败');
    }

    if (holdInfo.mode === 'hold') {
      try {
        const s = await billing.settle(c.env, holdInfo.holdId!, {
          promptTokens: lastUsage?.prompt_tokens,
          completionTokens: lastUsage?.completion_tokens,
        });
        charged = s.charged;
        settled = true;
      } catch (err) {
        console.error('[polish] settle 失败（hold 将被 cron 过期释放）:', err instanceof Error ? err.message : err);
      }
    }

    const insert = await c.env.DB.prepare(
      `INSERT INTO polishes (essay_id, draft_id, user_id, mode, fragment, instruction, result)
       VALUES (?, ?, ?, 'full', NULL, NULL, ?)`,
    ).bind(essayId, contextDraftId, userId, JSON.stringify(parsedResult)).run();
    return c.json({
      polish_id: insert.meta.last_row_id as number, mode: 'full', result: parsedResult,
      points_charged: charged, lane: laneLabel(lane),
    });
  } catch (err: any) {
    if (holdInfo.mode === 'hold' && !settled) {
      await billing.releaseQuietly(c.env, holdInfo.holdId);
    }
    return c.json({ error: friendlyAIError(err) }, 502);
  } finally {
    if (locked) releaseSlot(userId, lockToken);
  }
});

export default api;
