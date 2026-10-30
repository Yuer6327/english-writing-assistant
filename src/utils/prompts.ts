// ============================================================
// prompts.ts — 提示词模板（内置默认 + 占位符填充）
// ============================================================
// 内置默认模板硬编码在此（版本随代码演进，可「恢复默认」）；
// 用户覆盖存 D1 prompt_templates（按 user_id + genre 唯一）；
// 单篇作文可在 essays.custom_prompt 再覆盖一层。
// 优先级：essays.custom_prompt > prompt_templates > 内置默认。

import type { D1Database } from '@cloudflare/workers-types';

// ── 题型注册表（v1 仅上海高考大作文，结构留好扩展位）──
export interface GenreSpec {
  label: string;
  total: number;
  minWords: number;
  maxWords: number;
  softMinWords: number;
  softMaxWords: number;
  desc: string;
}

export const GENRES: Record<string, GenreSpec> = {
  'sh-gaokao-essay': {
    label: '上海高考大作文',
    total: 25,
    minWords: 200,
    maxWords: 500,
    softMinWords: 200,
    softMaxWords: 500,
    desc: '内容 10 + 语言 10 + 结构 5，满分 25 分；词数要求 200-500 词',
  },
};

export const REVIEW_SCORE_CEILING = 22;
const ESSAY_GENRE = GENRES['sh-gaokao-essay'];

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
const SH_GAOKAO_ESSAY_PROMPT = `你是一名上海高考英语阅卷专家，按真实阅卷尺度批改学生作文：先诊断问题，再给修改稿，最后评分并出巩固练习。

【评分维度】
- 内容 10 分：主题明确、论点合理、逻辑连贯，论证有实例。
- 语言 10 分：词汇四级-六级（如 implement 而非 do），句式多样（名词性从句、非谓语、倒装），语法准确。
- 结构 5 分：引言-主体-结论清晰，衔接词恰当（However, Furthermore）。

【分档锚点（先对档再给分，别凭感觉压分）】
- 语言：8-9 词汇丰富、句式多变、几乎无错｜7 少量小错，句式有变化｜6 有若干搭配/语法错误但全文可读，属合格作文常态｜4-5 错误频繁或句式单一，阅读受阻｜0-3 错误密集、影响理解
  （判断依据是「是否影响理解」，不是错误条数：能顺畅读完就不低于 6）
- 内容：8-9 论点清晰+实例+对策｜6-7 论点清晰，实例与对策有其一｜4-5 论点可辨但论证空泛｜0-3 偏题或无明确论点
- 结构：4 三段清晰，有开头结尾且用了过渡词（First / So / All in all 之类）｜3 段落完整但缺过渡｜2 段落混乱或缺首尾｜0-1 无结构

【论证要求（硬性，直接决定内容分）】
- 议论文必须写实例：具体的人、事、数据、研究结论、新闻报道均可，一两句即可；不能通篇只讲道理。
- 寓言、类比、成语典故、格言都不算实例（如「盲人摸象」只是比喻，不算论证材料）。
- 实例可自拟，不要求真实出处；但需有明确论证对象，避免 many people / some students 这类空泛主语。
- 无任何实例 → 内容分 ≤ 6。
- 鼓励写对策：摆出问题后给出对应解决办法（谁该做什么、如何改善），有此层次内容分可给 8-9；只摆问题不谈对策 → 内容分 ≤ 7、语言分 ≤ 7（语言上限由 9 降 2）。
- 改稿必须补齐缺失的实例与对策。

【评分纪律（最高优先级；与上条冲突取更严者）】
- 分项封顶：内容 ≤ 9、语言 ≤ 9、结构 ≤ 4，总分 ≤ 22；任何分项不给满分。
- 结构定档：内容+语言 ≥ 15 可给 3-4 分，< 15 最多 3 分。
- 总分 ≥ 20 仅限三维度近乎无可挑剔。
- 尺度基准：上海卷实际均分约 15 分。结构完整、表达基本通顺的中等作文应落 15-17；有明显缺陷才落 12-14。不苛求，绝不放水。
- 参考基准（语言通顺、结构完整时，按论证情况对号入座）：
  有实例 + 有对策 → 18-20｜有实例、无对策 → 16-17｜无实例、有对策 → 15-16｜两者皆无 → 12-13。
  例：无实例但有对策、语言读得通、三段有过渡 → 内容 6 语言 7 结构 3 = 16。

【任务步骤】
1. 诊断：逐项说清三维度问题，只谈问题与差距，不写表扬；每项 ≤ 2 句，内容项须明确回答有无实例、有无对策。
2. 修改稿：保留学生立意，补足实例与对策，改动处用 **粗体** 标出。
3. 打分与反馈：给出分项分、总分、问题清单、提升建议。
4. 练习：针对本次真实问题出中译英。

【作文信息】
- 题目：{topic}
- 词数：{word_count}（要求 ${ESSAY_GENRE.minWords}-${ESSAY_GENRE.maxWords} 词，约 300 词最佳；少于 ${ESSAY_GENRE.softMinWords} 或多于 ${ESSAY_GENRE.softMaxWords} 属明显偏离，应扣分并在 word_count_assessment 中具体说明）
{previous_feedback}
【学生作文】
{essay}

【输出格式】
只输出一个 JSON 对象（先判 argumentation，再据此定 subscores）：
{
  "argumentation": { "has_examples": true或false, "has_solution": true或false },
  "diagnosis": {
    "content": "内容维度问题：论点/论据（有无实例、有无对策）/逻辑（中文）",
    "language": "语言维度问题：词汇/句式/语法错误概况（中文）",
    "organization": "结构维度问题：段落/衔接（中文）"
  },
  "subscores": { "content": 0到9的整数, "language": 0到9的整数, "organization": 0到4的整数 },
  "overall_comment": "总评 1-2 句：只说最需改进的问题与方向（中文）；禁肯定、表扬或「总体/基础尚可」式开场",
  "word_count_assessment": "固定三段式：当前 N 词 / 要求 ${ESSAY_GENRE.minWords}-${ESSAY_GENRE.maxWords} 词 / 符合要求（或差 X 词、超出 X 词）",
  "issues": [
    {
      "quote": "学生作文原文中逐字连续的片段（用于定位，不得改写、增删词）",
      "type": "语法 | 词汇 | 搭配 | 拼写 | 标点 | 逻辑 | 中式表达 | 论证 之一",
      "explanation": "问题分析（中文，讲清为什么错）",
      "correction": "修改后的完整句子（英文）"
    }
  ],
  "revised_essay": "修改后的全文，升级词汇与句式至四级-六级水平，改动处用 **粗体** 标出",
  "suggestions": ["2-4 条具体可操作的提升建议（中文，至少 1 条给出可直接照做的解决办法）"],
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
- argumentation 必须如实填写：服务端会交叉校验，报 true 而全文无实例，内容分按无实例处理。
- 判 has_solution=false 时不要假装文中有对策；只有真正给出「谁该做什么」才算 true。
- issues 中每个 quote 必须是学生作文原文的逐字连续片段，否则该条无效；按严重程度排序，最多 10 条；同类小瑕疵（如多处标点）合并为一条。内容类问题（缺实例、缺对策、论证跳跃）type 用「论证」，quote 取最能体现问题的那句原文。
- practice 出 3-4 题：每题对应本次批改发现的一个真实问题，情境贴合本文话题，难度四级-六级；若核心问题是缺实例，至少 1 题改为「给定情境，用一句含实例的英文表达」，参考答案即示范句。
- 总分由服务端按 subscores 三项之和计算，不要额外输出 score 字段。`;

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
  return `\n- 上一稿反馈（本稿为修改稿，请额外评估进步情况）：\n  上一稿得分：${prevScore}/${REVIEW_SCORE_CEILING}（本系统上限 ${REVIEW_SCORE_CEILING}）\n  上一稿主要问题：\n${issueLines || '  （无记录）'}\n  请在输出 JSON 中额外增加 "improvement" 字段：\n  {"improvement": {"score_delta": 本稿得分减上一稿得分, "fixed": ["已解决的问题（中文短句）"], "remaining": ["仍存在的问题"], "regression": ["新引入的问题（如无则空数组）"]}}\n`;
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
export const FULL_REWRITE_PROMPT = `你是上海高考英语写作教练。请对学生的整篇作文做「范文级」润色重写：保持学生的立意与内容框架不变，升级词汇（四级-六级难度）、句式（名词性从句、非谓语、倒装、强调句等）、衔接与结构，并控制在 ${ESSAY_GENRE.minWords}-${ESSAY_GENRE.maxWords} 词（约 300 词）。

【题目】
{topic}

【学生作文】（原文 {word_count} 词）
{essay}

只输出一个 JSON 对象：
{
  "rewritten": "润色后的完整作文（${ESSAY_GENRE.minWords}-${ESSAY_GENRE.maxWords} 词）",
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

export function validatePromptTemplate(content: string): { ok: true } | { ok: false; error: string } {
  if (!content.includes('{essay}')) {
    return { ok: false, error: '提示词必须包含 {essay} 占位符（学生作文正文）' };
  }
  if (content.length > 20000) return { ok: false, error: '提示词过长（≤20000 字符）' };
  return { ok: true };
}

/** 单次替换，避免作文正文里的占位符字样被后续轮次误替换。 */
export function fillTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  let source = template;
  if (!validatePromptTemplate(source).ok) {
    console.warn('[prompt] 生效模板缺少 {essay}，已回退内置默认模板');
    source = DEFAULT_PROMPTS['sh-gaokao-essay'];
  }
  return source.replace(
    /\{(topic|essay|word_count|previous_feedback|fragment|instruction)\}/g,
    (_, key: string) => vars[key] ?? '',
  );
}

/** 生效提示词：essays.custom_prompt > prompt_templates > 内置默认 */
export async function getEffectivePrompt(
  db: D1Database,
  userId: string,
  genre: string,
  customPrompt: string | null | undefined,
): Promise<{ prompt: string; source: 'custom' | 'user-template' | 'default' }> {
  if (customPrompt && customPrompt.trim()) {
    if (validatePromptTemplate(customPrompt).ok) return { prompt: customPrompt, source: 'custom' };
    console.warn('[prompt] 单篇自定义模板无效，回退内置默认模板');
    return { prompt: DEFAULT_PROMPTS[genre] ?? DEFAULT_PROMPTS['sh-gaokao-essay'], source: 'default' };
  }
  const row = await db.prepare(
    'SELECT content FROM prompt_templates WHERE user_id = ? AND genre = ?',
  ).bind(userId, genre).first<{ content: string }>();
  if (row?.content?.trim()) {
    if (validatePromptTemplate(row.content).ok) return { prompt: row.content, source: 'user-template' };
    console.warn('[prompt] 用户模板无效，回退内置默认模板');
  }
  return { prompt: DEFAULT_PROMPTS[genre] ?? DEFAULT_PROMPTS['sh-gaokao-essay'], source: 'default' };
}
