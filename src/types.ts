// ============================================================
// types.ts — 全局类型定义
// ============================================================

/** Workers 环境绑定 */
export interface Env {
  /** 业务库（作文/稿件/批改） */
  DB: D1Database;
  /** 统一认证平台库（auth.yuer6327.top 的 auth-db，只读直查 sessions） */
  AUTH_DB: D1Database;
  ASSETS: Fetcher;
  ENCRYPTION_KEY: string;
  FRONTEND_ORIGIN: string;
  /** 公用免费 API（Agnes）密钥，wrangler secret put AGNES_API_KEY */
  AGNES_API_KEY?: string;
  /** 百度云 OCR 应用密钥（AK/SK），wrangler secret put BAIDU_OCR_AK / BAIDU_OCR_SK */
  BAIDU_OCR_AK?: string;
  BAIDU_OCR_SK?: string;
}

/** Hono 上下文变量（userId 为统一认证平台的用户 id，UUID 字符串） */
export interface Vars {
  userId: string;
  username: string;
}

// ── 业务类型 ──

/** 批改结果（AI 输出 JSON 的结构，前端渲染契约） */
export interface ReviewIssue {
  quote: string;            // 原文逐字片段（用于高亮定位）
  type: string;             // 语法/词汇/搭配/拼写/标点/逻辑/中式表达
  explanation: string;      // 问题分析（中文）
  correction: string;       // 修改后的句子
}

export interface ReviewImprovement {
  score_delta: number;      // 本稿得分 − 上一稿得分
  fixed: string[];          // 已解决的问题
  remaining: string[];      // 仍存在的问题
  regression: string[];     // 新引入的问题
}

export interface ReviewResult {
  diagnosis: { content: string; language: string; organization: string };
  subscores: { content: number; language: number; organization: number };
  score: number;                        // 0-25，= 三维度之和
  overall_comment: string;
  word_count_assessment: string;
  issues: ReviewIssue[];
  revised_essay: string;                // 修改后全文，改动处 **粗体**
  suggestions: string[];
  improvement?: ReviewImprovement;      // 二稿及以上才有
}

/** 片段精修结果 */
export interface PolishVersion {
  style: string;            // 稳妥改进版 / 高级句式版 / 范文级
  text: string;
  changes: { point: string; before: string; after: string; why: string }[];
}

export interface FragmentPolishResult {
  versions: PolishVersion[];
  learnings: string[];
}

/** 全文润色结果 */
export interface FullRewriteResult {
  rewritten: string;
  paragraph_changes: { original: string; rewritten: string; changes: { point: string; before: string; after: string }[] }[];
  summary: string;
}

/** VLM 手写识别结果 */
export interface OcrVlmResult {
  text: string;
  handwriting_score: number | null;   // 0-1
  notes: string;
}

/** AI 提供方配置（主模型 / 视觉模型） */
export interface ApiConfig {
  provider: 'byok' | 'agnes';
  key: string;
  /** 单个端点（BYOK）或候选端点数组（Agnes 双端点，自动切换） */
  baseUrl: string | string[];
  model: string;
}
