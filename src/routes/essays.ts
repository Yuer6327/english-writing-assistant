// ============================================================
// routes/essays.ts — 作文 / 稿件 CRUD + 批改 + 精修 / 全文润色
// 挂载于 /api：/essays..., /drafts/:id...
// ============================================================

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { Env, Vars } from '../types';
import { userMiddleware } from '../middleware/auth';
import { aiRateLimit, aiConfigFail, rateLimitHit, clientIp, memberWriteLimitHit } from '../utils/rate-limit';
import { callAI, callAIStreaming, extractJSON, friendlyAIError, isAIRateLimitError, ContentPart, type AIResult } from '../utils/ai';
import { getVisionConfig, resolveLane, laneFromBody, type Lane, type ResolvedConfig } from '../utils/api-config';
import * as billing from '../utils/billing';
import { tryAcquire, releaseSlot } from '../utils/inflight';
import {
  checkReviewGate, quotaState, checkEssayGate, checkDraftGate, successStmt, GUEST_DAILY_ESSAYS, beijingDay,
} from '../utils/quota';
import {
  GENRES, fillTemplate, getEffectivePrompt, buildPreviousFeedbackBlock, buildReviewMessages,
  SCORE_ONLY_SYSTEM_PROMPT, buildScoreOnlyUser,
  FRAGMENT_POLISH_PROMPT, FULL_REWRITE_PROMPT, validatePromptTemplate,
  SEMANTIC_DETECT_SYSTEM_PROMPT, buildSemanticDetectUser, REVIEW_SYSTEM_PROMPT,
} from '../utils/prompts';
import {
  countWords, sanitizeReview, sanitizeFragmentPolish, sanitizeFullRewrite,
  clampSubscores, medianScore, normalizeReviewShape, INJECTION_SCORE_CAPS,
  enforceEvidenceCoupling, shouldDeliverShadowB,
} from '../utils/validate';
import {
  stripInvisible, scanInjection, markSuspiciousSpans, summarizeInjection,
  redactSpans, validateVerbatimSpans, type InjectionReport, type InjectionSpan,
} from '../utils/injection';
import { shouldForceHarden } from '../utils/audit';
import { scanTopicImages, type ImageTextScan } from '../utils/image-text';
import { seedSampleEssay } from '../sample/seed';
import { MAX_IMAGES, MAX_IMAGE_CHARS, estimateImageTokens, estimateTextTokens } from '../utils/limits';

const api = new Hono<{ Bindings: Env; Variables: Vars }>();

// ── 常量 ──
const MAX_ESSAY_CHARS = 20_000;

/** deepseek-flash 为混合推理模型，reasoning 计入 max_tokens 预算，输出上限放大 */
/** deepseek-flash / deepseek-v4.1-flash 为混合推理模型，reasoning 计入 max_tokens 预算，输出上限放大
 *  （中转推理通道生成更慢更长，预算给得比 deepseek 档更宽） */
const maxOutputFor = (lane: Lane, base: number): number => {
  if (lane === 'deepseek') return Math.max(base * 2, 8192);
  if (lane === 'deepseek-relay') return Math.max(base * 3, 16384);
  return base;
};

/** 车道时间预算（毫秒）：推理通道思考+生成更慢，心跳保活下放宽到 5 分钟 */
const aiBudgetFor = (lane: Lane, startedAt: number): number =>
  startedAt + (lane === 'deepseek-relay' ? 300_000 : 180_000);

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
  return lane === 'deepseek' || lane === 'deepseek-relay' ? 'paid' : lane;
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

/** 请求体字符串字段统一收敛：JSON 类型混淆（{} / [] / 数字）不再触发 .trim() TypeError → 500 */
function strField(v: unknown): string {
  return typeof v === 'string' ? v : '';
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

/** 游客 IP 级软兜底：清掉 cookie 就能重置次数，IP 计数让刷次数变贵（内存计数，尽力而为）。
 *  scope 分桶：批改/建作文/OCR 的合理频次不同，共用一个桶会互相挤占（过度限制）。 */
function guestIpLimitHit(c: Context<{ Bindings: Env; Variables: Vars }>, scope: string, limit: number): boolean {
  if (!c.get('isGuest')) return false;
  return rateLimitHit(`guest:ip:${scope}:${clientIp(c)}`, limit, 24 * 3600_000);
}

/** 写路径限流统一响应 */
function writeLimitResponse(c: Context<{ Bindings: Env; Variables: Vars }>): Response {
  return c.json({ error: '操作过于频繁，请稍后再试', code: 'write_rate_limited' }, 429);
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
  const body = ((await c.req.json<{
    title?: string; genre?: string; topic_text?: string;
    topic_images?: string[]; custom_prompt?: string;
  }>().catch(() => null)) ?? ({} as any));

  if (memberWriteLimitHit(c)) return writeLimitResponse(c);
  const title = strField(body.title).trim();
  const topicText = strField(body.topic_text).trim();
  if (!title) return c.json({ error: '标题不能为空' }, 400);
  if (!topicText) return c.json({ error: '题目内容不能为空' }, 400);
  // Object.hasOwn 守卫：'__proto__' 等原型键会被真值判定放过，存库后每次批改 500（实测持久自伤 DoS）
  const genre = body.genre && Object.hasOwn(GENRES, body.genre) ? body.genre : 'sh-gaokao-essay';

  const img = validImages(body.topic_images);
  if (!img.ok) return c.json({ error: img.error }, 400);

  const customPromptRaw = strField(body.custom_prompt).trim();
  const customPrompt = customPromptRaw ? customPromptRaw : null;
  if (customPrompt) {
    const valid = validatePromptTemplate(customPrompt);
    if (!valid.ok) return c.json({ error: valid.error }, 400);
  }

  // 游客 IP 兜底：建作文同样受 IP 计数约束（清 cookie 轮换不能再无限灌作文/图片）
  if (guestIpLimitHit(c, 'essay', 15)) {
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
  // D1 单查询绑定参数上限 100：成员建稿数无上限（by design），
  // ≥100 稿时 IN (?) 展开会直接 500 —— 按 90 一批分片取回后合并。
  const reviews: any[] = [];
  for (let i = 0; i < draftIds.length; i += 90) {
    const chunk = draftIds.slice(i, i + 90);
    const rows = await c.env.DB.prepare(
      `SELECT id, draft_id, result, model, reviewed_text, created_at FROM reviews
       WHERE draft_id IN (${chunk.map(() => '?').join(',')}) ORDER BY id ASC`,
    ).bind(...chunk).all<any>();
    reviews.push(...rows.results);
  }

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
        result: normalizeReviewShape(parseJsonField(r.result, {}, `review:${r.id}`)),
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
  if (memberWriteLimitHit(c)) return writeLimitResponse(c);
  const body = ((await c.req.json<{
    title?: string; topic_text?: string; topic_images?: string[]; custom_prompt?: string | null;
  }>().catch(() => null)) ?? ({} as any));

  const essay = await c.env.DB.prepare(
    'SELECT id FROM essays WHERE id = ? AND user_id = ?',
  ).bind(essayId, userId).first();
  if (!essay) return c.json({ error: '作文不存在' }, 404);

  const sets: string[] = [];
  const vals: any[] = [];
  if (body.title !== undefined) {
    const t = strField(body.title).trim();
    if (!t) return c.json({ error: '标题不能为空' }, 400);
    sets.push('title = ?'); vals.push(t.slice(0, 200));
  }
  if (body.topic_text !== undefined) {
    const t = strField(body.topic_text).trim();
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
    const pRaw = strField(body.custom_prompt).trim();
    const p = pRaw ? pRaw : null;
    if (p) {
      const valid = validatePromptTemplate(p);
      if (!valid.ok) return c.json({ error: valid.error }, 400);
    }
    sets.push('custom_prompt = ?'); vals.push(p);
  }
  if (sets.length === 0) return c.json({ ok: true });

  sets.push("updated_at = datetime('now')");
  await c.env.DB.prepare(`UPDATE essays SET ${sets.join(', ')} WHERE id = ? AND user_id = ?`)
    .bind(...vals, essayId, userId).run();
  return c.json({ ok: true });
});

// ── 删除作文（级联删稿件/批改/精修）──
api.delete('/essays/:id', userMiddleware, async (c) => {
  if (memberWriteLimitHit(c)) return writeLimitResponse(c);
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
  if (memberWriteLimitHit(c)) return writeLimitResponse(c);
  const userId = c.get('userId');
  const isGuest = c.get('isGuest');
  const essayId = parseId(c.req.param('id'));
  if (essayId === null) return c.json({ error: '作文不存在' }, 404);
  const body = ((await c.req.json<{
    text?: string; source?: string; handwriting_score?: number; ocr_images?: string[];
  }>().catch(() => null)) ?? ({} as any));

  const essay = await c.env.DB.prepare(
    'SELECT id FROM essays WHERE id = ? AND user_id = ?',
  ).bind(essayId, userId).first();
  if (!essay) return c.json({ error: '作文不存在' }, 404);

  // 入库即剥离零宽 / bidi / Unicode Tag 等不可见字符：批改时的 quote 基准、
  // 前端高亮与导出必须用同一份文本，否则藏起来的指令会在送模型时才生效。
  const text = stripInvisible(strField(body.text)).text.replace(/\r\n/g, '\n').trim();
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
  if (memberWriteLimitHit(c)) return writeLimitResponse(c);
  const userId = c.get('userId');
  const draftId = parseId(c.req.param('id'));
  if (draftId === null) return c.json({ error: '稿件不存在' }, 404);
  const body = ((await c.req.json<{ text?: string }>().catch(() => null)) ?? ({} as any));

  const text = stripInvisible(strField(body.text)).text.replace(/\r\n/g, '\n').trim();
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
  if (memberWriteLimitHit(c)) return writeLimitResponse(c);
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

// ── 对稿件执行批改（SSE：每 10s 心跳保活边缘连接，最终结果作为最后一个 data 事件下发；
//    心跳使浏览器↔边缘不再受 ~100s 空闲限制，主调用可流式生成数分钟）──
api.post('/drafts/:id/review', userMiddleware, aiRateLimit, (c) => {
  const inner = runReview(c);   // 立即开始执行（到首个 await 让出，心跳随后接管）
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const ping = setInterval(() => {
        try { controller.enqueue(enc.encode(': ping\n\n')); } catch { clearInterval(ping); }
      }, 10_000);
      try {
        const res = await inner;
        const body = await res.json();
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ status: res.status, body })}\n\n`));
      } catch (err) {
        console.error('[review] SSE 包装层异常:', err instanceof Error ? err.message : err);
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ status: 500, body: { error: '服务器内部错误' } })}\n\n`));
      } finally {
        clearInterval(ping);
        try { controller.close(); } catch { /* 已关闭 */ }
      }
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
});

async function runReview(c: Context<{ Bindings: Env; Variables: Vars }>): Promise<Response> {
  const startedAt = Date.now();
  const userId = c.get('userId');
  const isGuest = c.get('isGuest');
  const body = ((await c.req.json<{ model_id?: string }>().catch(() => null)) ?? ({} as any));
  const lane: Lane = isGuest ? 'free' : await laneFromBody(c.env, userId, body.model_id);
  // 流式 + 心跳下不再受 ~100s 边缘空闲限制；预算按车道放宽（推理通道 5 分钟）
  const aiDeadline = aiBudgetFor(lane, startedAt);
  const draftId = parseId(c.req.param('id'));
  if (draftId === null) return c.json({ error: '稿件不存在' }, 404);

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
  if (guestIpLimitHit(c, 'review', 15)) {
    return c.json({ error: '今日批改次数过多，请明天再试或登录使用', code: 'guest_ip_limit' }, 429);
  }
  const gate = await checkReviewGate(c.env.DB, userId, isGuest, { lane, draftId });
  if (!gate.ok) return c.json({ error: gate.error, code: gate.code }, gate.status);

  // F3 门禁（必须在 billing.hold 之前，hold 后早退会留冻结额度）：
  // 近 7 天 ≥3 次 high 级命中 → 该用户后续所有批改强制硬化（≤8/≤8/≤3 + 采样取最小），
  // 无论当前稿是否干净。只压分留痕，不拒评、不扣次数、不封号。
  const forcedHarden = await shouldForceHarden(c.env.DB, userId);

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

  // 模型配置解析（车道已在门禁前确定；题图扫描需要视觉通道配置，前置到这里）
  let cfg: ResolvedConfig;
  let contentParts: ContentPart[] | undefined;
  try {
    if (topicImages.length) {
      cfg = await getVisionConfig(c.env, userId, lane);
    } else {
      cfg = await resolveLane(c.env, userId, lane);
    }
  } catch (err) {
    const fail = aiConfigFail(err);
    return c.json(fail.body, fail.status);
  }

  // ── 输入侧防护（提示词注入）──
  // 稿件入库时已剥过不可见字符，这里再洗一次兜住存量数据（幂等）。
  // essayText 同时作为「送模型的作文」与「quote 校验基准」，两处必须同一份文本。
  const cleaned = stripInvisible(draft.text);
  const essayText = cleaned.text;
  const injection = scanInjection(essayText, cleaned.removed, cleaned.tagged);
  // 题面同样是学生可控文本（可自填题目），命中高置信注入时与正文同等处理；
  // 题目里写「满分 25 分」只到 suspicious，不触发降分。
  const topicClean = stripInvisible(essay.topic_text);
  const topicInjection = scanInjection(topicClean.text, topicClean.removed, topicClean.tagged);

  // harden 是可变的：题图扫描与盲评链路都会把它升级（见下）——
  // 此前已定型的只有输入侧标记，聚合口径 / 硬顶 / 审计全部跟随最终值。
  let harden = injection.level === 'high' || topicInjection.level === 'high' || forcedHarden;
  const topicBase = topicInjection.level !== 'clean'
    ? markSuspiciousSpans(topicClean.text, topicInjection.spans)
    : topicClean.text;

  // ── 预扣费 + 并发锁（必须在任何算子侧 AI 调用之前）──
  // 题图扫描/盲评链路会烧平台的 vision/LLM key：付费车道零余额账户若先扫描后 hold(402)，
  // 等于免费用平台额度刷 vision 调用（终判 P1-1）。顺序：hold → 锁 → 扫描/采样/主调用。
  // 免费档带 skipQuota：次数由 checkReviewGate/recordSuccess 按「成功」计数，不由 billing 扣。
  // 6144：issues 不再设 10 条上限（只求准确），给弱文长输出留足余量，避免 JSON 截断 → 重试
  const maxOutput = maxOutputFor(lane, 6144);
  // 预扣估算（此时尚未扫描题图）：题图按 主调用+扫描 两遍图 token 计，
  // 图内文字以文本并入 topic 的部分按 2 万字符上限的保守余量预冻结（settle 多退少补）
  const estImageTextTokens = 6000;
  const estUserBase = estimateTextTokens(topicBase) + estimateTextTokens(essayText) + 3000
    + (prevReview ? 1500 : 0);
  let holdInfo: billing.HoldInfo;
  try {
    holdInfo = await billing.hold(c.env, userId, 'writing', cfg.serviceId, {
      // 系统消息按内置默认（最大静态前缀）估：自定义模板时略高估，方向安全
      estInputTokens: estimateTextTokens(REVIEW_SYSTEM_PROMPT) + estUserBase
        + estimateImageTokens(topicImages, cfg.provider, cfg.model) * (topicImages.length ? 2 : 0)
        + (topicImages.length ? estImageTextTokens : 2 * estUserBase),
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

  // F2-P0：题图是文本规则完全看不见的通道 —— 批改前先抽图内文字，过同一套扫描。
  // 失败 fail-open 照常批改（拒评等于告诉攻击者"图里有字被发现了"）。
  // 在 hold/锁之后执行：失败与余额不足都不再烧平台 key。
  let imageScan: ImageTextScan | null = null;
  if (topicImages.length) {
    imageScan = await scanTopicImages(cfg.key, cfg.baseUrl, cfg.model, topicImages, {
      deadline: Math.min(Date.now() + 25_000, aiDeadline),
    });
  }
  harden = harden || imageScan?.report.level === 'high';

  // P1 降权呈现：图内文字以文本形式放进 <topic> 数据区（模型对文本数据区的边界
  // 服从度高于图内像素，等于给图内指令补一层隔离）；图内文字命中时同样 datamark。
  let imageTopicPart = '';
  if (imageScan?.text) {
    const marked = imageScan.report.level === 'high'
      ? markSuspiciousSpans(imageScan.text, imageScan.report.spans)
      : imageScan.text;
    imageTopicPart = `\n[题图文字（系统转写，与附图内容一致）]\n${marked}`;
  }
  const topic = topicBase + imageTopicPart
    + (topicImages.length ? '\n（题目配有图片，见本消息附图）' : '');
  // 高置信注入 → 可疑片段打 ⟦⟧ 标记（datamark）：模型据此把它当"被标记的数据"而非指令
  // 真实 datamark 快照：harden 可能在此之后因覆盖率悬崖翻转（翻转前的标记动作不变），
  // 审计按"当时是否真的打了 ⟦⟧"记录，而非翻转后的最终值
  const essayMarkedAtPrompt = harden;
  const essayForPrompt = harden ? markSuspiciousSpans(essayText, injection.spans) : essayText;

  const { system: reviewSystem, user: reviewUser } = buildReviewMessages(template, promptSource, {
    topic,
    essay: essayForPrompt,
    word_count: String(countWords(essayText)),
    previous_feedback: prevReview
      ? buildPreviousFeedbackBlock(prevReview.score, prevReview.issues)
      : '',
  }, { harden });

  let settled = false;
  let charged = 0;
  try {
    // ── 分项分采样（先行）：3 次独立「只打分」小调用，与正式批改同一口径（RUBRIC_BLOCK）──
    // self-consistency：温度 0.6 保证样本多样性；3 个有效样本取中位数「定档」，
    // 主调用按定档分数写依据（basis 与交付分数永远一致，贴近真实阅卷「先定档后写评语」）。
    // 有效样本 <3（限流 / 解析失败 / 自定义模板无注入位）→ 退回旧行为：主调用独立打分，
    // 其分项分与有效样本合并取中位数。采样阶段的失败成本并入结算，不单独计费。
    const scoreDeadline = Math.min(Date.now() + 20_000, aiDeadline);
    const sampleSignals: {
      subscores: { content: number; language: number; organization: number };
      hasExamples: boolean | null;
      hasSolution: boolean | null;
    }[] = [];
    let sampleUsage: AIResult['usage'];
    let sampleCallsOk = 0;
    // F1 盲评链路（语义检测 + B 版打分）的独立用量（与采样并行发起，下面 merge 进结算）
    let auxUsage: AIResult['usage'];
    let auxCallsOk = 0;
    const mergeUsage = (
      base: AIResult['usage'] | undefined, u: AIResult['usage'] | undefined,
    ): AIResult['usage'] => {
      if (!u) return base;
      const add = (a?: number, b?: number): number | undefined =>
        a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
      return base
        ? {
          prompt_tokens: (base.prompt_tokens ?? 0) + (u.prompt_tokens ?? 0),
          completion_tokens: (base.completion_tokens ?? 0) + (u.completion_tokens ?? 0),
          prompt_cache_hit_tokens: add(base.prompt_cache_hit_tokens, u.prompt_cache_hit_tokens),
          prompt_cache_miss_tokens: add(base.prompt_cache_miss_tokens, u.prompt_cache_miss_tokens),
        }
        : u;
    };

    // ── F1 双通道盲评（shadow scoring）+ 语义检测器（与采样并行发起）──
    // 规则族是公开的正则：委婉化 / 换语种 / 纯语义施压能整段绕过（实测 8 变体 7 个判 clean，
    // 且"一个弱规则诱饵"就能让改写 payload 藏进 suspicious 档躲过检测器）。
    // 对策不依赖"识别攻击"：
    //   · 规则命中（suspicious+）→ 用规则 span；clean 或 suspicious 时再跑语义检测器
    //     （suspicious 也跑：防"诱饵占位让真 payload 躲进 suspicious"的免检门）；
    //   · 检测器摘出的"对评分者说的话"经逐字校验后与规则 span 合并 → 生成 B 版本；
    //   · B 版本把可疑内容替换为等长占位后独立打分；若 B（封顶前原始分）比 A 低 ≥2
    //     → 注入生效，交付 B（交付时才按注入口径封顶）。
    // 覆盖率悬崖：摘出的元话语占正文 >40% → B 版本失真（整篇大半被删），不跑盲评，
    // 但降级为强制硬化（≤8/≤8/≤3 + 采样取最小）——"payload 越大审查越少"的激励必须反过来。
    // 只在无题图时启用（有题图时题图扫描已覆盖多模态通道，避免延迟叠加）；
    // 失败 / 超时 / 限流一律跳过（fail-open），绝不影响主链路。
    // B 版本只用于取分：交付的 basis / issues / 修改稿仍来自 A，绝不把占位符漏给学生。
    const shadowState = {
      source: null as 'rule' | 'semantic' | null,
      detectorSpans: 0,   // 语义检测器摘到的 span 数（规则命中时为 0）
      overflow: false,    // 元话语覆盖率 >40%（放弃盲评，降级强制硬化）
      scoresRaw: null as { content: number; language: number; organization: number } | null,
      scores: null as { content: number; language: number; organization: number } | null,
      argumentation: null as { has_examples: boolean; has_solution: boolean } | null,
    };
    const shadowChain = (async (): Promise<void> => {
      if (topicImages.length) return;
      const chainStart = Date.now();
      try {
        let spans: InjectionSpan[] = [];
        if (injection.level !== 'clean' && injection.spans.length) {
          spans = [...injection.spans];
          shadowState.source = 'rule';
        }
        // 语义检测：clean 必跑（自适应攻击在规则下全漏）；suspicious 也跑
        // （规则只命中诱饵时，真 payload 靠它摘出）；high（已硬化）不跑，省延迟。
        if (!harden && (injection.level === 'clean' || injection.level === 'suspicious')) {
          const det = await callAI(cfg.key, cfg.baseUrl, cfg.model,
            SEMANTIC_DETECT_SYSTEM_PROMPT, buildSemanticDetectUser(essayText),
            true, undefined, maxOutputFor(lane, 400), 0.1,
            Math.min(chainStart + 15_000, aiDeadline));
          if (det.usage) { auxUsage = mergeUsage(auxUsage, det.usage); auxCallsOk++; }
          const found = validateVerbatimSpans(essayText, extractJSON(det.content)?.spans);
          shadowState.detectorSpans = found.length;
          if (found.length) {
            // 覆盖率按合并后的 span 集算（规则 + 语义，去重叠）。
            // 超过 40% → 整篇大半是元话语，B 版本失真（遮蔽删文评分失真，RobustJudge 教训）：
            // 彻底放弃盲评（含已有的规则 span，行为与文档口径一致），改由强制硬化兜底。
            const merged = [...spans];
            for (const s of found) {
              if (!merged.some(m => s.start < m.end && m.start < s.end)) merged.push(s);
            }
            const covered = merged.reduce((a, s) => a + (s.end - s.start), 0);
            if (covered > essayText.length * 0.4) {
              shadowState.overflow = true;   // 覆盖率悬崖 → 放弃盲评，主流程强制硬化
              spans = [];
            } else {
              spans = merged;
              if (!shadowState.source) shadowState.source = 'semantic';
            }
          }
        }
        if (!spans.length || !shadowState.source) { shadowState.source = null; return; }
        const redacted = redactSpans(essayText, spans);
        if (redacted === essayText) { shadowState.source = null; return; }
        const bUser = buildScoreOnlyUser(topic, redacted, countWords(essayText), false);
        const res = await callAI(cfg.key, cfg.baseUrl, cfg.model, SCORE_ONLY_SYSTEM_PROMPT,
          bUser, true, undefined, maxOutputFor(lane, 900), 0.2,
          Math.min(chainStart + 40_000, aiDeadline));
        if (res.usage) { auxUsage = mergeUsage(auxUsage, res.usage); auxCallsOk++; }
        const j = extractJSON(res.content);
        if (!j || typeof j !== 'object' || !j.subscores) { shadowState.source = null; return; }
        // 常态口径（论证纪律等）+ 证据耦合先行；注入口径封顶（≤8/≤8/≤3）只在交付时做——
        // 比较必须用封顶前原始分，否则 sumA≥21 的干净高分稿会被自动判"注入生效"（红队 P1-1）。
        // 注意：clampSubscores（含结构定档）在此应用两次（此处 + 交付封顶），
        // 第二次以证据降档后的内容分复算结构档——方向是 B 更低更易触发交付，偏差 ≤1 分，保守可接受。
        const ev = enforceEvidenceCoupling(
          clampSubscores(j.argumentation ?? {}, j.subscores),
          j.evidence, essayText, spans,
        );
        shadowState.scoresRaw = ev.subscores;
        shadowState.scores = clampSubscores({}, ev.subscores, INJECTION_SCORE_CAPS);
        const arg = j.argumentation ?? {};
        if (typeof arg.has_examples === 'boolean' && typeof arg.has_solution === 'boolean') {
          shadowState.argumentation = { has_examples: arg.has_examples, has_solution: arg.has_solution };
        }
      } catch (err) {
        shadowState.source = null;
        shadowState.overflow = false;
        console.error('[review] 盲评链路失败（跳过）:', err instanceof Error ? err.message : err);
      }
    })();

    if (scoreDeadline - Date.now() > 5_000) {
      const scoreUser = buildScoreOnlyUser(topic, essayForPrompt, countWords(essayText), harden);
      const rescores = await Promise.allSettled([
        callAI(cfg.key, cfg.baseUrl, cfg.model, SCORE_ONLY_SYSTEM_PROMPT, scoreUser, true, undefined, maxOutputFor(lane, 900), 0.6, scoreDeadline),
        callAI(cfg.key, cfg.baseUrl, cfg.model, SCORE_ONLY_SYSTEM_PROMPT, scoreUser, true, undefined, maxOutputFor(lane, 900), 0.6, scoreDeadline),
        callAI(cfg.key, cfg.baseUrl, cfg.model, SCORE_ONLY_SYSTEM_PROMPT, scoreUser, true, undefined, maxOutputFor(lane, 900), 0.6, scoreDeadline),
      ]);
      for (const r of rescores) {
        if (r.status !== 'fulfilled') {
          console.error(`[review] 打分采样失败（不计入）: ${r.reason?.message ?? r.reason}`);
          continue;
        }
        const u = r.value.usage;
        if (u) {
          sampleCallsOk++;
          // 采样成本并入结算（含缓存拆分），付费车道不多收也不白嫖
          sampleUsage = mergeUsage(sampleUsage, u);
        }
        try {
          const j = extractJSON(r.value.content);
          // 形状不完整的输出（如 {"error":...}）直接弃样：缺 subscores 会被钳成 0 分，污染中位数
          if (!j || typeof j !== 'object' || !j.subscores) throw new Error('采样输出缺少 subscores');
          const arg = j.argumentation ?? {};
          // 证据耦合（F1-P0）：采样分同样必须有原文逐字证据，落在注入段内 → 降档
          const ev = enforceEvidenceCoupling(
            clampSubscores(arg, j.subscores, harden ? INJECTION_SCORE_CAPS : undefined),
            j.evidence, essayText, injection.spans,
          );
          sampleSignals.push({
            subscores: ev.subscores,
            hasExamples: typeof arg.has_examples === 'boolean' ? arg.has_examples : null,
            hasSolution: typeof arg.has_solution === 'boolean' ? arg.has_solution : null,
          });
        } catch { /* 采样输出不合法 → 该样本丢弃 */ }
      }
    }
    await shadowChain;

    // 覆盖率悬崖（检测器摘出的元话语占正文 >40%）→ 强制硬化：
    // "payload 越大审查越少"的激励必须反过来。采样跑在原口径下，
    // 定档/交付分在下面补封顶；harden 翻转同时作用于聚合、主调用钳制与审计。
    if (shadowState.overflow) harden = true;

    // 3 个有效样本且为内置默认模板（有注入位）→ 中位数定档；布尔判定取多数（平票/全缺视为未知 → 不钳制）
    // 注入命中时改取最小值：三次采样都会被同一段注入污染，中位数救不了；取最小值才逼近"干净时该给的分"
    const aggregate = harden ? (v: number[]) => Math.min(...v) : medianScore;
    let agreed: { content: number; language: number; organization: number } | null = null;
    let agreedArg: { has_examples: boolean; has_solution: boolean } | null = null;
    if (sampleSignals.length >= 3 && promptSource === 'default') {
      const majority = (vals: (boolean | null)[]): boolean => {
        const b = vals.filter((v): v is boolean => v !== null);
        return b.filter(Boolean).length * 2 >= b.length;
      };
      agreedArg = {
        has_examples: majority(sampleSignals.map(s => s.hasExamples)),
        has_solution: majority(sampleSignals.map(s => s.hasSolution)),
      };
      agreed = {
        content: aggregate(sampleSignals.map(s => s.subscores.content)),
        language: aggregate(sampleSignals.map(s => s.subscores.language)),
        organization: aggregate(sampleSignals.map(s => s.subscores.organization)),
      };
    }

    // F1 盲评裁决（定档路径）：比较用 B 的封顶前原始分（红队 P1-1：B 恒封顶会让
    // sumA≥21 的干净高分稿自动满足 delta≥2），交付用封顶分。放在主调用之前：
    // basis 由主调用按 B 的分数展开，交付分数与依据保持一致。
    let shadowUsed = false;
    let shadowSumA: number | null = null;
    let shadowSumB: number | null = null;
    if (shadowState.scores && shadowState.scoresRaw && shadowState.source && agreed) {
      const sumBRaw = shadowState.scoresRaw.content + shadowState.scoresRaw.language
        + shadowState.scoresRaw.organization;
      const sumA = agreed.content + agreed.language + agreed.organization;
      if (shouldDeliverShadowB(sumA, sumBRaw)) {
        agreed = shadowState.scores;
        if (shadowState.argumentation) {
          agreedArg = shadowState.argumentation;   // B 的分数按 B 的自评钳过，自洽
        } else if (agreedArg) {
          // B 未给自评 → 按交付口径的 argumentation 再收敛（防 has_examples=false + content=8）
          agreed = clampSubscores(agreedArg, agreed, INJECTION_SCORE_CAPS);
        }
        shadowUsed = true;
        shadowSumA = sumA;
        shadowSumB = sumBRaw;
      }
    }

    // 覆盖率悬崖升级 harden 后，采样是未硬化口径 → 定档分补封顶（shadowUsed 已封顶，幂等）
    if (shadowState.overflow && agreed) {
      agreed = clampSubscores({}, agreed, INJECTION_SCORE_CAPS);
    }

    // 主调用用户消息：定档时在末位注入评分（可变数据区），否则用原始消息
    const baseUser = agreed
      ? `${reviewUser}\n\n【评分已定（多次独立评卷结果汇总，不得更改）】
- argumentation：has_examples = ${agreedArg!.has_examples}，has_solution = ${agreedArg!.has_solution}
- 分项分：内容 ${agreed.content} / 语言 ${agreed.language} / 结构 ${agreed.organization}
你的任务：写出支撑上述分项分的 basis 依据、问题清单、highlight/priority 与修改稿；argumentation 与 subscores 按上述值原样输出。`
      : reviewUser;
    // 视觉批改：题目图文与定档分数同入用户消息（组装放在定档之后）
    if (topicImages.length) {
      contentParts = [
        { type: 'text', text: baseUser },
        ...topicImages.map(url => ({ type: 'image_url', image_url: { url } })),
      ];
    }

    // 调用 + 校验 + 一次严格重试
    let result = null as ReturnType<typeof sanitizeReview> | null;
    let lastErr = '';
    let attemptsUsed = 0;
    let lastUsage: AIResult['usage'];
    for (let attempt = 0; attempt < 2; attempt++) {
      attemptsUsed = attempt + 1;
      try {
        const userPrompt = attempt === 0
          ? baseUser
          : `${baseUser}\n\n【重试提醒】上一次返回不合法（${lastErr}）。请严格按上述 JSON 格式输出，quote 必须逐字取自作文原文。`;
        const raw = await callAIStreaming(
          cfg.key, cfg.baseUrl, cfg.model, reviewSystem, userPrompt, true, contentParts, maxOutput, 0.2, aiDeadline);
        lastUsage = raw.usage;
        const parsed = extractJSON(raw.content);
        if (parsed && typeof parsed === 'object' && parsed.error === 'illegible') {
          // 模型明确判定作文无法辨认：重试必然同样失败，释放预扣并友好返回（finally 释放并发锁）
          await billing.releaseQuietly(c.env, holdInfo.holdId);
          console.error('[review] 模型判定作文正文无法辨认（illegible）');
          return c.json({
            error: '作文正文基本无法辨认（可能因手写不清或识别失败），请核对原文或换一张更清晰的照片后重试',
            code: 'essay_illegible',
          }, 422);
        }
        result = sanitizeReview(parsed, essayText, !!prevReview, {
          harden,
          injSpans: injection.spans,   // F1 证据耦合：证据落在注入段内 → 降档
        });
        // 定档覆盖：分项分以采样中位数为准（口径一致性由 clampSubscores 保证），
        // 主调用只负责举证与展开——basis 与交付分数从此必然一致
        if (agreed) {
          result.subscores = agreed;
          result.score = Math.max(0,
            agreed.content + agreed.language + agreed.organization - result.word_count_penalty);
          if (result.argumentation) {
            result.argumentation.has_examples = agreedArg!.has_examples;
            result.argumentation.has_solution = agreedArg!.has_solution;
          }
        }
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

    // 采样 / 盲评链路与主调用用量合并（失败重试的中间成本不单独计费，吸收进加价倍率 N）
    sampleUsage = mergeUsage(sampleUsage, auxUsage);
    if (sampleUsage) {
      lastUsage = mergeUsage(lastUsage, sampleUsage);
    }

    // 未定档 → 主调用分项分与有效采样合并取中位数（主调用也是一路独立信号）
    const scoreSamples = agreed ? 3 : 1 + sampleSignals.length;
    if (!agreed && sampleSignals.length > 0) {
      const samples = [result.subscores, ...sampleSignals.map(s => s.subscores)];
      result.subscores = {
        content: aggregate(samples.map(s => s.content)),
        language: aggregate(samples.map(s => s.language)),
        organization: aggregate(samples.map(s => s.organization)),
      };
      // 总分随中位数重算（词数扣分不变）
      result.score = Math.max(0,
        result.subscores.content + result.subscores.language + result.subscores.organization
        - result.word_count_penalty);
    }
    // 覆盖率悬崖升级 harden 后，采样是未硬化口径 → 中位数补封顶
    if (shadowState.overflow && !agreed) {
      result.subscores = clampSubscores({}, result.subscores, INJECTION_SCORE_CAPS);
      result.score = Math.max(0,
        result.subscores.content + result.subscores.language + result.subscores.organization
        - result.word_count_penalty);
    }

    // F1 盲评裁决（非定档路径，如自定义模板 / 采样不足）：主调用结果 vs B 版本
    if (shadowState.scores && shadowState.scoresRaw && shadowState.source && !agreed) {
      const sumBRaw = shadowState.scoresRaw.content + shadowState.scoresRaw.language
        + shadowState.scoresRaw.organization;
      const sumA = result.subscores.content + result.subscores.language + result.subscores.organization;
      if (shouldDeliverShadowB(sumA, sumBRaw)) {
        result.subscores = shadowState.scores;
        if (result.argumentation) {
          if (shadowState.argumentation) {
            result.argumentation.has_examples = shadowState.argumentation.has_examples;
            result.argumentation.has_solution = shadowState.argumentation.has_solution;
          } else {
            // B 未给自评 → 按交付 argumentation 再收敛，保持"自评与分数"自洽
            result.subscores = clampSubscores(result.argumentation, result.subscores, INJECTION_SCORE_CAPS);
          }
        }
        result.score = Math.max(0,
          result.subscores.content + result.subscores.language + result.subscores.organization
          - result.word_count_penalty);
        shadowUsed = true;
        shadowSumA = sumA;
        shadowSumB = sumBRaw;
      }
    }

    // 盲评裁决生效 = 注入确认生效（才交付更低分）→ 审计与前端横幅同口径
    if (shadowUsed && result.integrity) {
      result.integrity.shadow_used = true;
      result.integrity.injection_flagged = true;
    }

    // 结算（实际成本，多退少补；settle 失败不阻塞结果返回，未结算的 hold 由 cron 过期释放兜底）
    if (holdInfo.mode === 'hold') {
      try {
        const s = await billing.settle(c.env, holdInfo.holdId!, {
          promptTokens: lastUsage?.prompt_tokens,
          completionTokens: lastUsage?.completion_tokens,
          promptCacheHitTokens: lastUsage?.prompt_cache_hit_tokens,
          promptCacheMissTokens: lastUsage?.prompt_cache_miss_tokens,
          // 主调用（含一次 JSON 重试的可能）+ 成功的采样 + 盲评链路（语义检测 / B 版打分）
          calls: 1 + sampleCallsOk + auxCallsOk,
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
      sample_prompt_tokens: sampleUsage?.prompt_tokens ?? null,
      sample_completion_tokens: sampleUsage?.completion_tokens ?? null,
      sample_calls_ok: sampleCallsOk,
      score_samples: scoreSamples,
      issues_total: result.issues.length,
      issues_unlocated: result.issues.filter(i => i.located === false).length,
      prompt_source: promptSource,
      // 注入防护审计：命中族、分值、被标记片段数、被剥离的伪权威评语数
      injection: {
        essay: summarizeInjection(injection),
        topic: summarizeInjection(topicInjection),
        // image.failed：抽取失败 fail-open（与"扫了且干净"在审计上区分开，红队 P2-4）
        image: imageScan?.scanned
          ? { ...summarizeInjection(imageScan.report), failed: imageScan.failed === true }
          : undefined,
        // 审计按真实标记动作记录（essay 在翻转前的口径打标；topic 按 suspicious+ 打标）
        spans_marked_essay: essayMarkedAtPrompt ? injection.spans.length : 0,
        spans_marked_topic: topicInjection.level !== 'clean' ? topicInjection.spans.length : 0,
        invisible_removed: cleaned.removed,
        // F1：语义检测 + 双通道盲评的审计（shadow.used = 已按 B 版本分数交付）
        semantic: { spans: shadowState.detectorSpans },
        shadow: shadowState.source ? {
          source: shadowState.source,
          sum_a: shadowSumA,
          sum_b: shadowSumB,
          used: shadowUsed,
        } : null,
        // F3：近 7 天累计命中触发的强制硬化
        forced_harden: forcedHarden,
      },
      integrity: result.integrity ?? null,
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
      ).bind(draftId, draft.essay_id, userId, JSON.stringify(result), model, essayText, meta,
        userId, draftId)
      : c.env.DB.prepare(
        `INSERT INTO reviews (draft_id, essay_id, user_id, result, model, reviewed_text, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(draftId, draft.essay_id, userId, JSON.stringify(result), model, essayText, meta)];
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

    const imageFlagged = !!imageScan && imageScan.report.level !== 'clean';
    const injected = harden || shadowUsed
      || injection.level !== 'clean' || topicInjection.level !== 'clean' || imageFlagged;
    return c.json({
      review_id: insert?.meta?.last_row_id ?? null,
      persisted: insert?.meta?.changes === 1,
      prompt_source: promptSource,
      model,
      result,
      // 输入侧检出疑似元指令时告知前端（前端只展示一句"已忽略文中的评分指令"，
      // 不给攻击者任何"差一点就成功"的反馈，也不暴露命中规则与盲评细节）
      injection: injected
        ? {
          level: (harden || shadowUsed) ? 'high' as const : 'suspicious' as const,
          flagged: harden || shadowUsed,
        }
        : undefined,
      points_charged: charged,          // 微积分（前端 ÷10000 展示为积分）
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
}

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
  const body = ((await c.req.json<{
    mode?: string; fragment?: string; instruction?: string; draft_id?: number; model_id?: string;
  }>().catch(() => null)) ?? ({} as any));

  // ── 入参校验一律前置到预扣费之前 ──
  // 旧实现把片段长度校验放在 hold 之后，早退时既没 settle 也没 release，
  // 冻结的积分要等 cron 过期才回滚（用户会看到"没批改却扣了额度"）。
  const isFragment = body.mode === 'fragment';
  const fragment = strField(body.fragment).trim();
  const instruction = strField(body.instruction).trim().slice(0, 1000) || '无特别要求，按常规标准精修';
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
      let lastUsage: AIResult['usage'];
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
            promptCacheHitTokens: lastUsage?.prompt_cache_hit_tokens,
            promptCacheMissTokens: lastUsage?.prompt_cache_miss_tokens,
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
    let lastUsage: AIResult['usage'];
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
        // 与批改/精修同口径：配置/网络/超时类失败立即终止，不白跑第二轮（多等 40-80s）
        if (/^AI API error \d{3}|abort|timed? ?out|fetch failed|超时/i.test(lastErr)) throw err;
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
          promptCacheHitTokens: lastUsage?.prompt_cache_hit_tokens,
          promptCacheMissTokens: lastUsage?.prompt_cache_miss_tokens,
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
