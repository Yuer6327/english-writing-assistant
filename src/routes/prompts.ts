// ============================================================
// routes/prompts.ts — 批改提示词模板（按模式/题型独立，可保存）
// ============================================================
// 存储：prompt_templates (user_id, genre) —— 每个模式一行，互不影响；
// 内置默认硬编码于 utils/prompts.ts；某模式没有覆盖行时回落内置默认。
// 优先级：essays.custom_prompt（单篇） > prompt_templates（按模式） > 内置默认。
// 「恢复默认」= 删除该 (user, genre) 行，不影响其它模式。
// ============================================================

import { Hono } from 'hono';
import type { Env, Vars } from '../types';
import { authMiddleware } from '../middleware/auth';
import { DEFAULT_PROMPTS, GENRES, PLACEHOLDER_DOC } from '../utils/prompts';

const prompts = new Hono<{ Bindings: Env; Variables: Vars }>();

interface TemplateRow { genre: string; content: string; updated_at: string }

// ── 模式列表（每个模式一条：生效内容 + 是否自定义 + 更新时间）──
prompts.get('/', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const rows = (await c.env.DB.prepare(
    'SELECT genre, content, updated_at FROM prompt_templates WHERE user_id = ?',
  ).bind(userId).all<TemplateRow>()).results;
  const overrides = new Map(rows.map(r => [r.genre, r]));

  const list = Object.keys(GENRES).map(genre => {
    const def = DEFAULT_PROMPTS[genre] ?? '';
    const ov = overrides.get(genre);
    return {
      genre,
      label: GENRES[genre]?.label ?? genre,
      desc: GENRES[genre]?.desc ?? '',
      content: ov?.content ?? def,
      default_content: def,
      is_custom: !!ov,
      updated_at: ov?.updated_at ?? null,
    };
  });
  return c.json({ prompts: list, placeholders: PLACEHOLDER_DOC });
});

// ── 单模式（前端切换模式时按需刷新）──
prompts.get('/:genre', authMiddleware, async (c) => {
  const genre = c.req.param('genre');
  if (!GENRES[genre]) return c.json({ error: '未知模式' }, 404);
  const ov = await c.env.DB.prepare(
    'SELECT content, updated_at FROM prompt_templates WHERE user_id = ? AND genre = ?',
  ).bind(c.get('userId'), genre).first<{ content: string; updated_at: string }>();
  return c.json({
    genre,
    label: GENRES[genre].label,
    desc: GENRES[genre].desc,
    content: ov?.content ?? (DEFAULT_PROMPTS[genre] ?? ''),
    default_content: DEFAULT_PROMPTS[genre] ?? '',
    is_custom: !!ov,
    updated_at: ov?.updated_at ?? null,
  });
});

// ── 保存 / 清除某个模式的覆盖（content 传空 = 该模式恢复内置默认）──
prompts.put('/:genre', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const genre = c.req.param('genre');
  if (!GENRES[genre]) return c.json({ error: '未知模式' }, 404);

  const body = await c.req.json<{ content?: string }>().catch(() => ({}) as any);
  const content = (body.content || '').trim();

  if (!content) {
    await c.env.DB.prepare('DELETE FROM prompt_templates WHERE user_id = ? AND genre = ?')
      .bind(userId, genre).run();
    return c.json({ ok: true, restored: true, genre, is_custom: false, updated_at: null });
  }
  if (content.length > 20000) return c.json({ error: '提示词过长（≤20000 字符）' }, 400);
  // 必须包含核心占位符，否则批改时作文文本无法注入
  if (!content.includes('{essay}')) {
    return c.json({ error: '提示词必须包含 {essay} 占位符（学生作文注入点）' }, 400);
  }

  await c.env.DB.prepare(
    `INSERT INTO prompt_templates (user_id, genre, content, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(user_id, genre) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at`,
  ).bind(userId, genre, content).run();

  const saved = await c.env.DB.prepare(
    'SELECT updated_at FROM prompt_templates WHERE user_id = ? AND genre = ?',
  ).bind(userId, genre).first<{ updated_at: string }>();
  return c.json({ ok: true, genre, is_custom: true, updated_at: saved?.updated_at ?? null });
});

export default prompts;
