// ============================================================
// types.ts — 全局类型定义
// ============================================================

/** Workers 环境绑定 */
export interface Env {
  /** 业务库（作文/稿件/批改） */
  DB: D1Database;
  /** 统一认证平台库（auth.yuer6327.top 的 auth-db，只读直查 sessions） */
  AUTH_DB: D1Database;
  /** 计费平台（yuer-billing）Service Binding，内网调用钱包/额度/BYOK */
  BILLING: Fetcher;
  ASSETS: Fetcher;
  ENCRYPTION_KEY: string;
  FRONTEND_ORIGIN: string;
  /** 公用免费 API（Agnes）密钥——deprecated：已上收 billing 持有，迁移完成后删除 */
  AGNES_API_KEY?: string;
  /** 可选：与 billing 共享的内部调用口令（X-Internal-Token） */
  INTERNAL_TOKEN?: string;
  /** 百度云 OCR 应用密钥（AK/SK），wrangler secret put BAIDU_OCR_AK / BAIDU_OCR_SK */
  BAIDU_OCR_AK?: string;
  BAIDU_OCR_SK?: string;
  /** 仅本地开发：置 '1' 才开放 /api/auth/dev-session 测试会话（生产绝不配置） */
  ENABLE_DEV_SESSION?: string;
}

/** Hono 上下文变量（userId 为统一认证平台的用户 id，UUID 字符串；
 *  游客为 'guest:<设备 cookie id>'） */
export interface Vars {
  userId: string;
  username: string;
  /** 认证平台用户角色（'admin' 等，权限判定用；与计费标签组无关） */
  role: string;
  /** true = 未登录的游客会话（每日 3 次批改 + 一篇三稿限制） */
  isGuest: boolean;
}

// ── 业务类型 ──

/** 批改结果（AI 输出 JSON 的结构，前端渲染契约） */
export interface ReviewIssue {
  quote: string;            // 原文逐字片段（用于高亮定位）
  type: string;             // 语法/词汇/搭配/拼写/标点/逻辑/中式表达/论证
  explanation: string;      // 问题分析（中文）
  correction: string;       // 修改后的句子
  located?: boolean;        // false = quote 未命中原文，只展示问题卡片、不高亮
}

export interface ReviewImprovement {
  score_delta: number;      // 本稿得分 − 上一稿得分
  fixed: string[];          // 已解决的问题
  remaining: string[];      // 仍存在的问题
  regression: string[];     // 新引入的问题
}

/** 巩固练习（针对本次批改发现的问题定制的中译英） */
export interface ReviewPracticeItem {
  chinese: string;          // 中文句子（学生译成英语）
  answer: string;           // 参考答案（英文）
  target: string;           // 考点及对应的原文问题
}

export interface ReviewPractice {
  intro: string;            // 一句话说明本组练习针对的薄弱点
  items: ReviewPracticeItem[];
}

export interface ReviewResult {
  diagnosis: { content: string; language: string; organization: string };
  subscores: { content: number; language: number; organization: number };
  score: number;                        // 0-22，= 三维度之和 − 词数扣分（服务端硬扣）
  overall_comment: string;
  word_count: number;                   // 服务端统计的词数（空白分词）
  word_count_penalty: number;           // 词数扣分：<100 词 −5、>500 词 −3、其余 0
  issues: ReviewIssue[];
  revised_essay: string;                // 修改后全文，改动处 **粗体**
  suggestions: string[];
  practice?: ReviewPractice;            // 巩固练习（旧记录可能没有）
  improvement?: ReviewImprovement;      // 二稿及以上才有
  /** 论证自评（服务端据此钳制内容分；null = 模型未填，未钳制） */
  argumentation?: {
    has_examples: boolean | null;
    has_solution: boolean | null;
    model_content: number;              // 模型原始内容分（审计用）
    model_language: number;             // 模型原始语言分（审计用）
  };
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
  provider: 'byok' | 'agnes' | 'deepseek';
  key: string;
  /** 单个端点（BYOK）或候选端点数组（Agnes 双端点，自动切换） */
  baseUrl: string | string[];
  model: string;
  /** BYOK 单独配置的视觉模型（未配置为 null） */
  vision?: { key: string; baseUrl: string; model: string } | null;
}
