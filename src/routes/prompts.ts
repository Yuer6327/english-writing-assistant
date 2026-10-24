// ============================================================
// routes/prompts.ts — 批改提示词模板（查看生效值 / 保存覆盖 / 恢复默认）
// 内置默认硬编码于 utils/prompts.ts；用户覆盖存 prompt_templates。
// ============================================================

import { Hono } from 'hono';
import type { Env, Vars } from '../types';
import { authMiddleware } from '../middleware/auth';
import { DEFAULT_PROMPTS, GENRES } from '../utils/prompts';

const prompts = new Hono<{ Bindings: Env; Variables: Vars }>();

// ── 模板列表（含生效内容与是否默认）──
prompts.get('/', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const rows = await c.env.DB.prepare(
    'SELECT genre, content FROM prompt_templates WHERE user_id = ?',
  ).bind(userId).all<{ genre: string; content: string }>();
  const overrides = new Map(rows.results.map(r => [r.genre, r.content]));

  const list = Object.entries(DEFAULT_PROMPTS).map(([genre, def]) => ({
    genre,
    label: GENRES[genre]?.label ?? genre,
    desc: GENRES[genre]?.desc ?? '',
    content: overrides.get(genre) ?? def,
    is_default: !overrides.has(genre),
  }));
  return c.json({ prompts: list });
});

// ── 保存 / 清除覆盖（content 传空 = 恢复内置默认）──
prompts.put('/:genre', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const genre = c.req.param('genre');
  if (!DEFAULT_PROMPTS[genre]) return c.json({ error: '未知题型' }, 404);

  const body = await c.req.json<{ content?: string }>().catch(() => ({}) as any);
  const content = (body.content || '').trim();

  if (!content) {
    await c.env.DB.prepare('DELETE FROM prompt_templates WHERE user_id = ? AND genre = ?')
      .bind(userId, genre).run();
    return c.json({ ok: true, restored: true });
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
  return c.json({ ok: true });
});

export default prompts;
