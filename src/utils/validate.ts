// ============================================================
// validate.ts — AI 返回结果校验 / 净化
// 服务端是唯一权威：quote 必须命中原文、分数必须落在区间、数组封顶，
// 不合规字段丢弃或修正，整体不合法则抛错触发上层严格重试。
// ============================================================

import type {
  ReviewResult, ReviewIssue, FragmentPolishResult, FullRewriteResult, OcrVlmResult,
} from '../types';

/** 分数收敛到 [min, max] 的整数 */
function safeScore(v: unknown, min: number, max: number, fallback = 0): number {
  const n = typeof v === 'number' ? v : parseFloat(String(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function str(v: unknown, maxLen = 8000): string {
  return typeof v === 'string' ? v.slice(0, maxLen) : '';
}

function strArray(v: unknown, cap: number, itemLen = 500): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map(x => typeof x === 'string' ? x.trim() : '')
    .filter(Boolean)
    .slice(0, cap)
    .map(s => s.slice(0, itemLen));
}

/** 空白归一（\s+ → 单空格，trim）：quote 与原文两边都归一后再比对 */
function normWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

const ISSUE_TYPES = ['语法', '词汇', '搭配', '拼写', '标点', '逻辑', '中式表达', '论证', '识别存疑'];
const ISSUE_SEVERITIES = ['critical', 'minor', 'polish'] as const;

// ── 论证硬性上限（提示词 + 服务端双保险）──
// 模型在 argumentation 里自报「有无实例 / 有无对策」，服务端据此钳制内容分，
// 防止模型口头遵守、打分放水。字段缺失视为未知 → 不钳制（老记录 / 模型漏填）。
const CONTENT_CAP_NO_EXAMPLES = 6;   // 无实例：内容 ≤6（刚过及格线，仍不给高分）
const CONTENT_CAP_NO_SOLUTION = 7;   // 只摆问题不谈对策：内容 ≤7
const LANGUAGE_CAP_NO_SOLUTION = 7;  // 同上：语言上限由 9 降到 7（不再扣结构，改用语言分体现差距）

// ── 词数硬扣分（纯服务端判定，不看模型自评）──
// 阈值与扣分固定写死：<100 词 → −5；>500 词 → −3。总分扣完不低于 0。
const WORD_SHORT_UNDER = 100;
const WORD_SHORT_PENALTY = 5;
const WORD_LONG_OVER = 500;
const WORD_LONG_PENALTY = 3;

/**
 * 模型分 vs 服务端上限：上限是硬顶，折中不得抬分。
 * 模型更严 → 保留模型分；模型给高 → 以服务端为准。
 * （「相差 ≤1 取中间值」在硬顶前提下四舍五入后恒等于上限，故直接取较小值。）
 */
function reconcileScore(model: number, cap: number): number {
  return Math.min(model, cap);
}

/** 只认真正的布尔值；字符串 "true" / undefined 一律视为未知 */
function boolFlag(v: unknown): boolean | null {
  return typeof v === 'boolean' ? v : null;
}

/**
 * 按 argumentation 自评 + 服务端钳制规则收敛一组分项分。
 * 供 sanitizeReview 与独立打分采样（essays.ts 3 采样取中位数）共用，保证口径一致。
 */
export function clampSubscores(
  arg: any,
  sub: any,
): { content: number; language: number; organization: number } {
  const hasExamples = boolFlag(arg?.has_examples);
  const hasSolution = boolFlag(arg?.has_solution);

  let content = safeScore(sub?.content, 0, 9);
  if (hasExamples === false) content = reconcileScore(content, CONTENT_CAP_NO_EXAMPLES);
  if (hasSolution === false) content = reconcileScore(content, CONTENT_CAP_NO_SOLUTION);

  let language = safeScore(sub?.language, 0, 9);
  if (hasSolution === false) language = reconcileScore(language, LANGUAGE_CAP_NO_SOLUTION);

  // 结构定档用钳制前的内容分 + 钳制前的语言分（语义同 sanitizeReview：追加惩罚不二次连锁）
  let organization = safeScore(sub?.organization, 0, 4);
  if (content + safeScore(sub?.language, 0, 9) < 15) organization = Math.min(organization, 3);

  return { content, language, organization };
}

/**
 * 分数采样聚合：奇数个取中位数；偶数个取均值后向下取整（方向偏严，符合「压低」口径）。
 */
export function medianScore(values: number[]): number {
  const v = [...values].sort((a, b) => a - b);
  const mid = v.length >> 1;
  return v.length % 2 ? v[mid] : Math.floor((v[mid - 1] + v[mid]) / 2);
}

/**
 * 校验并净化批改结果。
 * @param parsed    AI 返回的 JSON
 * @param essayText 学生作文原文（quote 命中校验基准）
 * @param expectsImprovement 二稿及以上 → 要求 improvement 字段
 * @throws Error 整体不合法（触发上层严格重试）
 */
export function sanitizeReview(parsed: any, essayText: string, expectsImprovement: boolean): ReviewResult {
  if (!parsed || typeof parsed !== 'object') throw new Error('AI 返回不是 JSON 对象');

  const basis = parsed.basis ?? {};

  // 评分纪律封顶（与提示词一致）：分项 ≤9/≤9/≤4 → 总分 ≤22；结构另受定档规则约束
  const arg = parsed.argumentation ?? {};
  const hasExamples = boolFlag(arg.has_examples);
  const hasSolution = boolFlag(arg.has_solution);
  const modelContent = safeScore(parsed.subscores?.content, 0, 9);
  const modelLanguage = safeScore(parsed.subscores?.language, 0, 9);
  const { content, language, organization } = clampSubscores(arg, parsed.subscores);

  const sum = content + language + organization;
  // 词数扣分：硬阈值，服务端自算，模型不参与（分项保持模型判定的原始分，只在总分上扣）
  const wordCount = countWords(essayText);
  const wordPenalty = wordCount < WORD_SHORT_UNDER ? WORD_SHORT_PENALTY
    : wordCount > WORD_LONG_OVER ? WORD_LONG_PENALTY
    : 0;
  const finalScore = Math.max(0, sum - wordPenalty);

  // quote 命中校验：先原文 substring，再空白归一比对
  const normEssay = normWs(essayText);
  const issues: ReviewIssue[] = [];
  if (Array.isArray(parsed.issues)) {
    for (const raw of parsed.issues) {
      if (!raw || typeof raw !== 'object') continue;
      const quote = str(raw.quote, 600).trim();
      if (quote.length < 2) continue;
      const hit = essayText.includes(quote) || normEssay.includes(normWs(quote));
      const type = ISSUE_TYPES.includes(raw.type) ? raw.type : '其他';
      const severity = ISSUE_SEVERITIES.includes(raw.severity) ? raw.severity : 'minor';
      issues.push({
        quote,
        type,
        severity,
        explanation: str(raw.explanation, 1500),
        correction: str(raw.correction, 1500),
        located: hit,
      });
      if (issues.length >= 50) break;  // 纯安全阀：提示词已约束「只列有把握的」，防异常输出刷爆结果
    }
  }

  // 可定位的问题优先展示；未定位项保留说明但不绘制高亮。
  issues.sort((a, b) => Number(b.located !== false) - Number(a.located !== false));

  const revised = str(parsed.revised_essay, 20000);
  const highlight = str(parsed.highlight, 300);
  const priority = str(parsed.priority, 300);

  // 整体合法性：修改全文 / 分项依据 / 问题清单 / 亮点·优先点至少有一项非空
  const hasBasis = !!(basis.content || basis.language || basis.organization);
  if (!revised && !hasBasis && issues.length === 0 && !highlight && !priority) {
    throw new Error('批改结果为空（缺少依据/问题清单/修改全文）');
  }

  const result: ReviewResult = {
    basis: {
      content: str(basis.content, 600),
      language: str(basis.language, 600),
      organization: str(basis.organization, 600),
    },
    subscores: { content, language, organization },
    score: finalScore,
    highlight,
    priority,
    word_count: wordCount,
    word_count_penalty: wordPenalty,
    issues,
    revised_essay: revised,
    // 数量不设硬上限（只求准确），20 为异常安全阀
    suggestions: strArray(parsed.suggestions, 20, 400),
    argumentation: hasExamples === null && hasSolution === null ? undefined : {
      has_examples: hasExamples,
      has_solution: hasSolution,
      model_content: modelContent,   // 模型原始内容分（审计：看被服务端压了多少）
      model_language: modelLanguage, // 模型原始语言分（审计用）
    },
  };

  if (expectsImprovement || (parsed.improvement && typeof parsed.improvement === 'object')) {
    const imp = parsed.improvement ?? {};
    result.improvement = {
      score_delta: Number.isFinite(Number(imp.score_delta))
        ? Math.round(Number(imp.score_delta))
        : finalScore - sum,   // 无有效值时按分差兜底（上层会传入上一稿分）
      fixed: strArray(imp.fixed, 10, 300),
      remaining: strArray(imp.remaining, 10, 300),
      regression: strArray(imp.regression, 10, 300),
    };
  }

  return result;
}

/** 校验并净化片段精修结果 */
export function sanitizeFragmentPolish(parsed: any): FragmentPolishResult {
  if (!parsed || !Array.isArray(parsed.versions) || parsed.versions.length === 0) {
    throw new Error('精修结果缺少 versions');
  }
  const versions = parsed.versions
    .filter((v: any) => v && typeof v === 'object' && typeof v.text === 'string' && v.text.trim())
    .slice(0, 3)
    .map((v: any) => ({
      style: str(v.style, 30) || '改进版',
      text: str(v.text, 4000),
      changes: (Array.isArray(v.changes) ? v.changes : [])
        .filter((c: any) => c && typeof c === 'object')
        .slice(0, 8)
        .map((c: any) => ({
          point: str(c.point, 60),
          before: str(c.before, 800),
          after: str(c.after, 800),
          why: str(c.why, 800),
        })),
    }));
  if (versions.length === 0) throw new Error('精修结果无有效版本');
  return { versions, learnings: strArray(parsed.learnings, 6, 400) };
}

/** 校验并净化全文润色结果 */
export function sanitizeFullRewrite(parsed: any, essayText: string): FullRewriteResult {
  if (!parsed || typeof parsed.rewritten !== 'string' || !parsed.rewritten.trim()) {
    throw new Error('润色结果缺少 rewritten');
  }
  const normEssay = normWs(essayText);
  const paragraph_changes = (Array.isArray(parsed.paragraph_changes) ? parsed.paragraph_changes : [])
    .filter((p: any) => p && typeof p === 'object' && typeof p.rewritten === 'string')
    .slice(0, 12)
    .map((p: any) => ({
      // original 尽量取原文逐字片段；未命中的保留原文案（前端对照仍可读）
      original: str(p.original, 4000),
      rewritten: str(p.rewritten, 4000),
      changes: (Array.isArray(p.changes) ? p.changes : [])
        .filter((c: any) => c && typeof c === 'object')
        .slice(0, 6)
        .map((c: any) => ({
          point: str(c.point, 60),
          before: str(c.before, 800),
          after: str(c.after, 800),
        })),
    }))
    .filter((p: { original: string; rewritten: string }) =>
      !p.original || essayText.includes(p.original) || normEssay.includes(normWs(p.original)) || p.original.length < 3,
    );
  return {
    rewritten: str(parsed.rewritten, 20000),
    paragraph_changes,
    summary: str(parsed.summary, 2000),
  };
}

/** 校验并净化 VLM 手写识别结果 */
export function sanitizeOcrVlm(parsed: any): OcrVlmResult {
  if (!parsed || typeof parsed.text !== 'string' || !parsed.text.trim()) {
    throw new Error('识别结果为空');
  }
  let score: number | null = null;
  if (typeof parsed.handwriting_score === 'number' && Number.isFinite(parsed.handwriting_score)) {
    score = Math.max(0, Math.min(1, parsed.handwriting_score));
  }
  return {
    text: parsed.text.slice(0, 20000),
    handwriting_score: score,
    notes: str(parsed.notes, 1000),
  };
}

/** 词数（空白分词，前后端一致） */
export function countWords(text: string): number {
  const t = (text || '').trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

/**
 * 旧版批改结果结构兼容映射（读取路径，不改库存数据）：
 * 2026-11 前的结果用 diagnosis{content,language,organization} + overall_comment，
 * 2026-11 改版为 basis + priority（highlight 为新增字段，旧结果无此数据，保持缺省）。
 * 详情接口统一过这里，网页渲染与 PDF 导出（buildReportPayload）即同时兼容新旧两代结果。
 */
export function normalizeReviewShape(result: unknown): any {
  if (!result || typeof result !== 'object') return result;
  const r = result as Record<string, any>;
  if (r.basis || !r.diagnosis) return r;
  const d = (r.diagnosis ?? {}) as Record<string, any>;
  return {
    ...r,
    basis: {
      content: typeof d.content === 'string' ? d.content : '',
      language: typeof d.language === 'string' ? d.language : '',
      organization: typeof d.organization === 'string' ? d.organization : '',
    },
    priority: typeof r.priority === 'string' && r.priority ? r.priority : (typeof r.overall_comment === 'string' ? r.overall_comment : undefined),
  };
}
