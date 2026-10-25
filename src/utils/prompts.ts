// ============================================================
// prompts.ts — 提示词模板（内置默认 + 占位符填充）
// ============================================================
// 内置默认模板硬编码在此（版本随代码演进，可「恢复默认」）；
// 用户覆盖存 D1 prompt_templates（按 user_id + genre 唯一）；
// 单篇作文可在 essays.custom_prompt 再覆盖一层。
// 优先级：essays.custom_prompt > prompt_templates > 内置默认。

import type { D1Database } from '@cloudflare/workers-types';

// ── 题型注册表（v1 仅上海高考大作文，结构留好扩展位）──
export const GENRES: Record<string, { label: string; total: number; desc: string }> = {
  'sh-gaokao-essay': {
    label: '上海高考大作文',
    total: 25,
    desc: '内容 10 + 语言 10 + 结构 5，满分 25 分；词数要求 200-500 词',
  },
};

// ── 通用硬性约束：禁止免责声明 / AI 自我提及 ──
const NO_META = `硬性规则：
- 不得输出任何免责声明、补充说明或与任务无关的元评论，不得提及 AI 或语言模型。
- 只按要求的 JSON 格式输出，不要 markdown 代码块包裹。`;

// ── 占位符 ──
// {topic}  题目文本（含图片提示语）
// {essay}  学生作文全文
// {word_count} 词数（服务端计算）
// {previous_feedback} 上一稿反馈摘要（二稿及以上注入；一稿替换为空串）
export const PLACEHOLDER_DOC = '可用占位符：{topic} 题目、{essay} 作文全文、{word_count} 词数、{previous_feedback} 上一稿反馈（仅二稿起有内容）';

// ============================================================
// 默认批改提示词（上海高考大作文）
// 框架来源：用户提供（内容10/语言10/结构5 + 档次加分规则 + 诊断→修改→打分）
// ============================================================
const SH_GAOKAO_ESSAY_PROMPT = `你是一名上海高考英语阅卷专家，按真实高考阅卷尺度批改学生作文：先诊断问题，再给出修改稿，最后评分并针对本次问题出巩固练习。

【评分维度】
- 内容（10 分）：主题明确、论点合理、论据充分、逻辑连贯。
- 语言（10 分）：词汇介于四级至六级难度（如用 implement 而非 do），句式多样（名词性从句、非谓语、倒装等），语法准确。
- 结构（5 分）：段落清晰（引言-主体-结论），衔接词恰当（However, Furthermore 等）。

【评分纪律（最高优先级，必须严格遵守）】
- 各维度封顶：内容 ≤ 9、语言 ≤ 9、结构 ≤ 4，因此总分 ≤ 22。无论作文多么优秀，任何分项不得给满分，总分绝不超过 22。
- 定档规则：先按内容+语言之和定档——合计 ≥ 15 者结构可给 3-4 分，< 15 者结构最多 3 分。
- 总分 ≥ 20 仅留给内容、语言、结构近乎无可挑剔的作文；多数作文应落在 12-19 区间。向真实阅卷尺度看齐：不苛求，也绝不放水。

【任务步骤】
1. 诊断：逐项指出内容、语言、结构三个维度的问题，只谈问题与差距，不写表扬。
2. 修改文章：输出优化后的全文，保留学生立意，改动处用 **粗体** 标出。
3. 打分与反馈：给出分项分与总分、问题清单和提升建议。
4. 巩固练习：针对本次发现的真实问题出中译英练习，让学生练到刚出错的知识点。

【作文信息】
- 题目：{topic}
- 词数：{word_count}（上海高考大作文要求 200-500 词；词数不足或超出过多应扣分，并在 word_count_assessment 中具体说明）
{previous_feedback}
【学生作文】
{essay}

【输出格式】
只输出一个 JSON 对象，字段如下：
{
  "diagnosis": {
    "content": "内容维度问题：主题/论点/论据/逻辑（中文）",
    "language": "语言维度问题：词汇/句式/语法错误概况（中文）",
    "organization": "结构维度问题：段落/衔接（中文）"
  },
  "subscores": { "content": 0到9的整数, "language": 0到9的整数, "organization": 0到4的整数 },
  "score": 总分0到22的整数（必须等于三个维度分之和）,
  "overall_comment": "总评 1-2 句：只陈述最需要改进的问题与改进方向（中文）；禁止任何肯定、表扬或「总体/基础尚可」式开场",
  "word_count_assessment": "词数评价（中文，一句话）",
  "issues": [
    {
      "quote": "学生作文原文中逐字连续的片段（用于定位，不得改写、增删词）",
      "type": "语法 | 词汇 | 搭配 | 拼写 | 标点 | 逻辑 | 中式表达 之一",
      "explanation": "问题分析（中文，讲清为什么错）",
      "correction": "修改后的完整句子（英文）"
    }
  ],
  "revised_essay": "修改后的全文，升级词汇与句式至四级-六级水平，改动处用 **粗体** 标出",
  "suggestions": ["2-4 条具体可操作的提升建议（中文）"],
  "practice": {
    "intro": "一句话说明本组练习针对本文哪些薄弱点（中文）",
    "items": [
      {
        "chinese": "中文句子（要求学生译成英语）",
        "answer": "参考答案（英文，体现目标词汇/句式）",
        "target": "本题考点及对应的原文问题（中文，一句话）"
      }
    ]
  }
}

${NO_META}
- issues 中每个 quote 必须是学生作文原文的逐字连续片段，否则该条视为无效；按严重程度排序，最多 10 条；同类小瑕疵（如多处标点）合并为一条说明。
- practice 出 3-4 题：每题必须对应本次批改发现的一个真实问题（issues 或诊断中的薄弱点），句子情境尽量贴合本文话题，难度四级-六级；不要出与本文错误无关的泛泛练习。
- score 必须等于 subscores 三项之和，并遵守全部评分纪律（分项 9/9/4 封顶、总分 ≤ 22、结构定档规则）。`;

/** 内置默认模板注册表 */
export const DEFAULT_PROMPTS: Record<string, string> = {
  'sh-gaokao-essay': SH_GAOKAO_ESSAY_PROMPT,
};

// ── 二稿起注入的「上一稿反馈」段落（填入 {previous_feedback}）──
export function buildPreviousFeedbackBlock(
  prevScore: number,
  prevIssues: { quote: string; type: string; correction: string }[],
): string {
  const issueLines = prevIssues.slice(0, 6)
    .map(i => `  - [${i.type}] ${i.quote} → ${i.correction}`)
    .join('\n');
  return `\n- 上一稿反馈（本稿为修改稿，请额外评估进步情况）：\n  上一稿得分：${prevScore}/25\n  上一稿主要问题：\n${issueLines || '  （无记录）'}\n  请在输出 JSON 中额外增加 "improvement" 字段：\n  {"improvement": {"score_delta": 本稿得分减上一稿得分, "fixed": ["已解决的问题（中文短句）"], "remaining": ["仍存在的问题"], "regression": ["新引入的问题（如无则空数组）"]}}\n`;
}

// ============================================================
// VLM 手写识别提示词（OCR，逐字转写不纠错 + 书写质量分）
// ============================================================
export const OCR_VLM_PROMPT = `你是高精度手写文字识别引擎。请转写图片中手写的英语作文全文（多张图片按顺序是同一篇作文的不同部分，按顺序合并为全文）。

转写要求：
- 严格逐字转写：学生写错的拼写、语法、标点一律原样保留，绝不纠正、不润色、不补全。
- 保留段落划分：按图片中的空行或缩进判断段落边界，段落之间用一个空行分隔。
- 忽略被划掉的内容、教师批改痕迹、涂改（只转写最终保留的正文）。
- 无法辨认的词用 [?] 占位，不要猜测。
- 同时评估书写质量 handwriting_score（0-1，保留两位小数）：
  0.90-0.99 几乎完美（印刷体般工整，实际极少能达到）；0.80-0.89 优秀；0.70-0.79 良好；0.60-0.69 可辨认但大小/倾斜不一致；低于 0.60 严重影响辨认。

只输出一个 JSON 对象：
{"text": "转写出的作文全文", "handwriting_score": 0到1的数值, "notes": "识别中不确定之处的说明（中文，没有则空字符串）"}

${NO_META}`;

// ============================================================
// 片段精修提示词
// ============================================================
export const FRAGMENT_POLISH_PROMPT = `你是上海高考英语写作教练。学生正在打磨一篇高考大作文（题目：{topic}），现选中了一个片段请求精修。

【作文全文（上下文参考，保持精修片段与全文风格、时态一致）】
{essay}

【选中的片段】
{fragment}

【学生的额外要求】
{instruction}

请给出 3 个精修版本，每个版本都要：
1. "稳妥改进版"：修正错误、表达更地道，难度与原文相当，学生跳一跳够得着；
2. "高级句式版"：运用名词性从句、非谓语、倒装、强调句等高考加分句式；
3. "范文级"：词汇（四级-六级）、句式、衔接全面升级，接近范文水准。

只输出一个 JSON 对象：
{
  "versions": [
    {
      "style": "稳妥改进版",
      "text": "精修后的片段（英文）",
      "changes": [{"point": "改动类型：句式/用词/衔接/语法", "before": "原表达", "after": "新表达", "why": "改动理由（中文）"}]
    },
    {"style": "高级句式版", "...": "同上结构"},
    {"style": "范文级", "...": "同上结构"}
  ],
  "learnings": ["2-4 条可复用的表达或句型：中文说明 + 英文示例"]
}

${NO_META}`;

// ============================================================
// 全文润色提示词
// ============================================================
export const FULL_REWRITE_PROMPT = `你是上海高考英语写作教练。请对学生的整篇作文做「范文级」润色重写：保持学生的立意与内容框架不变，升级词汇（四级-六级难度）、句式（名词性从句、非谓语、倒装、强调句等）、衔接与结构，并控制在 200-500 词。

【题目】
{topic}

【学生作文】（原文 {word_count} 词）
{essay}

只输出一个 JSON 对象：
{
  "rewritten": "润色后的完整作文（200-500 词）",
  "paragraph_changes": [
    {
      "original": "原文的一个段落（或一句话，短文可按句拆分）",
      "rewritten": "对应润色结果",
      "changes": [{"point": "改动类型：句式/用词/衔接", "before": "原表达", "after": "新表达"}]
    }
  ],
  "summary": "本次润色的核心提升点（中文，一小段话）"
}

${NO_META}
- paragraph_changes 按原文顺序覆盖全文每个段落，original 必须是原文的逐字片段。`;

// ============================================================
// 模板工具
// ============================================================

/** 占位符替换（缺失变量替换为空串/合理默认） */
export function fillTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{${k}}`).join(v ?? '');
  }
  // 未提供 的变量替换为空（模板里残留未知占位符也清掉）
  out = out.replace(/\{(?:topic|essay|word_count|previous_feedback|fragment|instruction)\}/g, '');
  return out;
}

/** 生效提示词：essays.custom_prompt > prompt_templates > 内置默认 */
export async function getEffectivePrompt(
  db: D1Database,
  userId: string,
  genre: string,
  customPrompt: string | null | undefined,
): Promise<{ prompt: string; source: 'custom' | 'user-template' | 'default' }> {
  if (customPrompt && customPrompt.trim()) {
    return { prompt: customPrompt, source: 'custom' };
  }
  const row = await db.prepare(
    'SELECT content FROM prompt_templates WHERE user_id = ? AND genre = ?',
  ).bind(userId, genre).first<{ content: string }>();
  if (row?.content?.trim()) {
    return { prompt: row.content, source: 'user-template' };
  }
  return { prompt: DEFAULT_PROMPTS[genre] ?? DEFAULT_PROMPTS['sh-gaokao-essay'], source: 'default' };
}
