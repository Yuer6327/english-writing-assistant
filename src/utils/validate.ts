// ============================================================
// validate.ts — AI 返回结果校验 / 净化
// 服务端是唯一权威：quote 必须命中原文、分数必须落在区间、数组封顶，
// 不合规字段丢弃或修正，整体不合法则抛错触发上层严格重试。
// ============================================================

import type {
  ReviewResult, ReviewIssue, ReviewPractice, FragmentPolishResult, FullRewriteResult, OcrVlmResult,
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

const ISSUE_TYPES = ['语法', '词汇', '搭配', '拼写', '标点', '逻辑', '中式表达', '论证'];

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
 * 校验并净化批改结果。
 * @param parsed    AI 返回的 JSON
 * @param essayText 学生作文原文（quote 命中校验基准）
 * @param expectsImprovement 二稿及以上 → 要求 improvement 字段
 * @throws Error 整体不合法（触发上层严格重试）
 */
export function sanitizeReview(parsed: any, essayText: string, expectsImprovement: boolean): ReviewResult {
  if (!parsed || typeof parsed !== 'object') throw new Error('AI 返回不是 JSON 对象');

  const diag = parsed.diagnosis ?? {};
  const sub = parsed.subscores ?? {};

  // 评分纪律封顶（与提示词一致）：分项 ≤9/≤9/≤4 → 总分 ≤22；结构另受定档规则约束
  const arg = parsed.argumentation ?? {};
  const hasExamples = boolFlag(arg.has_examples);
  const hasSolution = boolFlag(arg.has_solution);

  const modelContent = safeScore(sub.content, 0, 9);
  let content = modelContent;
  if (hasExamples === false) content = reconcileScore(content, CONTENT_CAP_NO_EXAMPLES);
  if (hasSolution === false) content = reconcileScore(content, CONTENT_CAP_NO_SOLUTION);

  const modelLanguage = safeScore(sub.language, 0, 9);
  // 无对策不压结构、改压语言：语言上限 9 → 7
  const language = hasSolution === false
    ? reconcileScore(modelLanguage, LANGUAGE_CAP_NO_SOLUTION)
    : modelLanguage;
  // 结构加分规则：内容+语言 <15 → 结构最多 3 分。
  // 定档用「服务端压过的内容分 + 模型原始语言分」：内容下调反映论证缺陷，应连锁结构；
  // 语言下调只是本规则下的追加惩罚，不再二次连锁，否则无对策的惩罚会从 -2 变成 -3。
  let organization = safeScore(sub.organization, 0, 4);
  if (content + modelLanguage < 15) organization = Math.min(organization, 3);

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
      issues.push({
        quote,
        type,
        explanation: str(raw.explanation, 1500),
        correction: str(raw.correction, 1500),
        located: hit,
      });
      if (issues.length >= 10) break;
    }
  }

  // 可定位的问题优先展示；未定位项保留诊断内容但不绘制高亮。
  issues.sort((a, b) => Number(b.located !== false) - Number(a.located !== false));

  // 巩固练习：条目需中文句 + 参考答案；无有效条目则整段丢弃（旧记录无此字段）
  let practice: ReviewPractice | undefined;
  const prac = parsed.practice;
  if (prac && typeof prac === 'object' && Array.isArray(prac.items)) {
    const items = prac.items
      .filter((it: any) => it && typeof it === 'object'
        && typeof it.chinese === 'string' && it.chinese.trim()
        && typeof it.answer === 'string' && it.answer.trim())
      .slice(0, 5)
      .map((it: any) => ({
        chinese: str(it.chinese, 600),
        answer: str(it.answer, 1200),
        target: str(it.target, 400),
      }));
    if (items.length) practice = { intro: str(prac.intro, 300), items };
  }

  const overall = str(parsed.overall_comment, 2000);
  const revised = str(parsed.revised_essay, 20000);

  // 整体合法性：总评与修改全文至少有一项非空，分项诊断至少一项非空
  const hasDiag = !!(diag.content || diag.language || diag.organization);
  if (!overall && !revised && !hasDiag) {
    throw new Error('批改结果为空（缺少总评/诊断/修改全文）');
  }

  const result: ReviewResult = {
    diagnosis: {
      content: str(diag.content, 3000),
      language: str(diag.language, 3000),
      organization: str(diag.organization, 3000),
    },
    subscores: { content, language, organization },
    score: finalScore,
    overall_comment: overall,
    word_count: wordCount,
    word_count_penalty: wordPenalty,
    issues,
    revised_essay: revised,
    suggestions: strArray(parsed.suggestions, 8),
    practice,
    argumentation: hasExamples === null && hasSolution === null ? undefined : {
      has_examples: hasExamples,
      has_solution: hasSolution,
      model_content: modelContent,   // 模型原始内容分（审计：看被服务端压了多少）
      model_language: modelLanguage, // 模型原始语言分（同上）
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
