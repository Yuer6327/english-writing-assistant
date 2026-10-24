// ============================================================
// sample/seed.ts — 新用户注册时预置"完整批改流程"示例作文
// 题目 + 一稿（含典型错误）+ 批改 + 二稿（改进）+ 进步对比 + 片段精修，
// 全部为预烘焙数据（与 AI 管线输出同构），注册即见、无需任何 AI 调用。
// ============================================================

import type { ReviewResult, FragmentPolishResult } from '../types';

const TOPIC_TEXT = `Directions: Write an English composition in 120-150 words on the topic "The Power of Habits". Your school newspaper is inviting students to share their views on how good habits shape our lives. Include specific examples from your own experience or observations.`;

const DRAFT_1 = `Good habits are very important in our life. As a student, I have deep experience about it.

Two years ago, I was used to staying up late to play mobile phone. So I always felt tired in class and my grade dropped quickly. My teacher talked with me and suggested me to make a study plan. Since then, I go to bed before 11 o'clock and read English every morning. Gradually, my spirit becomes better and I make a great progress in study.

In conclude, good habits can help us become a better person. It is never too late to start a good habit. If we keep doing small things every day, we will success one day.`;

const REVIEW_1: ReviewResult = {
  diagnosis: {
    content: '主题明确（好习惯的力量），有个人经历作论据，但论据单一：只有"学习习惯"一个维度，未涉及习惯对生活其他方面（健康、情绪、自律）的影响，观点展开不够充分。',
    language: '词汇偏基础（important / good / better 反复出现），距四级水平有差距；存在多处语法与搭配错误：was used to（应为 used to）、suggested me to（应为 suggested that I ...）、make a great progress（progress 不可数）、In conclude（应为 In conclusion）、will success（success 是名词，应为 succeed）；句式以简单句为主，缺少从句、非谓语等加分结构。',
    organization: '三段式结构清晰（引入—事例—总结），Since then / Gradually 等衔接使用得当，但段际过渡手段仍显单一。',
  },
  subscores: { content: 6, language: 6, organization: 3 },
  score: 15,
  overall_comment: '文章结构完整、叙事清楚，能看到习惯带来的改变，是不错的起点。最需要突破的是语言层面：词汇升级和句式多样化，以及纠正几处反复出现的语法硬伤。',
  word_count_assessment: '约 127 词，符合 120-150 词要求。',
  issues: [
    {
      quote: 'I was used to staying up late to play mobile phone',
      type: '语法',
      explanation: '"was used to doing" 意为"已习惯于做某事"（状态），此处表达"过去常常做"应用 "used to do"；"play mobile phone" 是中式直译。',
      correction: 'I used to stay up late scrolling on my phone.',
    },
    {
      quote: 'suggested me to make a study plan',
      type: '搭配',
      explanation: 'suggest 不接 "sb to do" 结构，应用 "suggest that sb (should) do" 或改用 advise。',
      correction: 'My teacher advised me to make a study plan.',
    },
    {
      quote: 'I make a great progress in study',
      type: '语法',
      explanation: 'progress 是不可数名词，不能用 "a" 修饰；"in study" 表达生硬，常用 "in my studies"。',
      correction: 'I have made great progress in my studies.',
    },
    {
      quote: 'In conclude',
      type: '词汇',
      explanation: 'conclude 是动词，"总之"应为介词短语 "In conclusion"。',
      correction: 'In conclusion, good habits can help us become better people.',
    },
    {
      quote: 'we will success one day',
      type: '语法',
      explanation: 'success 是名词，作谓语应用动词 succeed，或改写为 "success will come"。',
      correction: 'we will succeed one day.',
    },
    {
      quote: 'I have deep experience about it',
      type: '搭配',
      explanation: '"experience about" 搭配不当，且此处"深有体会"用词过于直译。',
      correction: 'I have learned this from my own experience.',
    },
  ],
  revised_essay: `Good habits **play a significant role in shaping our lives**, and my own experience **is a good case in point**.

Two years ago, I **used to stay up late scrolling on my phone**, which **left me exhausted in class and caused my grades to decline**. After a talk with my teacher, I **made a study plan and stuck to it**: going to bed before 11 and reading English every morning. Gradually, **not only did I become more energetic, but I also made great progress in my studies**.

**In conclusion**, good habits are the **stepping stones to a better self**. It is never too late to start. **As long as we keep doing small things consistently**, we will **succeed** one day.`,
  suggestions: [
    '词汇升级：把 important/good/better 替换为四级词汇，如 significant / beneficial / rewarding。',
    '句式多样化：至少使用一处倒装（Not only did I ...）、一处非谓语（..., which left me ...）和一处强调句。',
    '内容展开：除学习外，再从健康或自律角度补充一句例证，让"习惯的力量"更有说服力。',
    '消灭硬伤：used to do / succeed（动词）/ In conclusion 三个考点要整理进错题本。',
  ],
};

const DRAFT_2 = `Good habits play a significant role in shaping our lives, and my own experience is a good case in point.

Two years ago, I used to stay up late scrolling on my phone, which left me exhausted in class and caused my grades to decline. After a talk with my teacher, I made a study plan and stuck to it: going to bed before 11 and reading English every morning. Gradually, not only did I become more energetic, but I also made great progress in my studies.

In conclusion, good habits are the stepping stones to a better self. It is never too late to start. If we keep doing small things every day, success will come naturally.`;

const REVIEW_2: ReviewResult = {
  diagnosis: {
    content: '立意不变，叙事更完整（补充了"grades decline → plan → result"的因果链），但仍可增加一个非学习维度的例证（如运动、阅读）使论证更立体。',
    language: '词汇明显升级（significant / decline / energetic / stepping stones），倒装句 "not only did I" 与非限制性定语从句运用自然；剩余问题较少，个别表达仍有提升空间。',
    organization: '三段结构完整，衔接词使用得当，结尾呼应主题。',
  },
  subscores: { content: 8, language: 7, organization: 4 },
  score: 19,
  overall_comment: '二稿进步显著：语法硬伤全部清除，倒装与非谓语等加分句式落地自然，叙事链条更完整。向第五档（21-25）冲刺的关键是内容的多维展开与个别措辞的精准度。',
  word_count_assessment: '约 121 词，符合 120-150 词要求。',
  issues: [
    {
      quote: 'If we keep doing small things every day, success will come naturally.',
      type: '句式',
      explanation: '表达正确，但作为全文结尾可再凝练有力，例如用 As long as 引导的强调性结尾。',
      correction: 'As long as we keep doing small things consistently, we will naturally succeed one day.',
    },
    {
      quote: 'a good case in point',
      type: '词汇',
      explanation: '使用得当；可尝试更地道的 is a case in point 直接作表语，去掉 good 避免语义重复。',
      correction: '...and my own experience is a case in point.',
    },
  ],
  revised_essay: `Good habits **play a significant role in shaping our lives**, and my own experience is **a case in point**.

Two years ago, I **used to stay up late scrolling on my phone**, which left me exhausted in class and caused my grades to decline. After a talk with my teacher, I made a study plan and **stuck to it**: going to bed before 11 and reading English every morning. Gradually, **not only did I become more energetic, but I also made great progress in my studies**. **Beyond academics, a habit of jogging every weekend has kept me both healthy and refreshed.**

**In conclusion**, good habits are the **stepping stones to a better self**. It is never too late to start. **As long as we keep doing small things consistently, we will naturally succeed one day.**`,
  suggestions: [
    '冲刺更高档：补充一个非学习维度例证（运动/阅读/时间管理），体现习惯对生活整体的塑造。',
    '结尾句用 As long as ... 收束，比 if 条件句更有力量。',
    '保持已掌握的倒装、非谓语结构，考场上先写对再写难。',
  ],
  improvement: {
    score_delta: 4,
    fixed: [
      'used to do 与 was used to doing 的混用已纠正',
      'suggest / advise 搭配错误已清除',
      'progress 不可数、In conclusion、succeed 动词用法均已修正',
    ],
    remaining: ['内容仍集中在学习维度，缺少第二角度例证'],
    regression: [],
  },
};

const POLISH_FRAGMENT = 'If we keep doing small things every day, success will come naturally.';

const POLISH_RESULT: FragmentPolishResult = {
  versions: [
    {
      style: '稳妥改进版',
      text: 'As long as we keep doing small things consistently, we will naturally succeed one day.',
      changes: [
        { point: '衔接', before: 'If we keep doing', after: 'As long as we keep doing', why: 'As long as 语气更强，结尾更有号召力，是高考范文中常见收束句式。' },
        { point: '用词', before: 'every day', after: 'consistently', why: '副词 consistently 精准表达"持之以恒"，比 every day 更凝练。' },
      ],
    },
    {
      style: '高级句式版',
      text: 'Only by doing small things consistently day after day can we eventually taste the sweetness of success.',
      changes: [
        { point: '句式', before: 'If we keep doing ..., success will come', after: 'Only by doing ... can we ...', why: 'Only + 状语置于句首引起部分倒装（can we），是高考写作的高分句型。' },
        { point: '用词', before: 'success will come naturally', after: 'taste the sweetness of success', why: '比喻性表达让抽象概念具象化，更具画面感。' },
      ],
    },
    {
      style: '范文级',
      text: 'It is those small, consistent efforts that quietly pave the way to our eventual success.',
      changes: [
        { point: '句式', before: 'If we keep doing small things every day', after: 'It is those small, consistent efforts that ...', why: '强调句 It is ... that ... 突出"点滴努力"这一核心信息。' },
        { point: '用词', before: 'success will come naturally', after: 'quietly pave the way to our eventual success', why: 'pave the way（铺路）意象生动，eventual 体现过程的积累性。' },
      ],
    },
  ],
  learnings: [
    '收尾句式三件套：As long as we ... / Only by ... can we ... / It is ... that ... 可背熟套用',
    '副词升级：every day → consistently / day after day / over time',
    '抽象名词具象化：success → taste the sweetness of success / pave the way to success',
  ],
};

/** 为新用户预置示例作文（完整批改流程演示）；失败仅记日志，不影响注册 */
export async function seedSampleEssay(db: D1Database, userId: string): Promise<void> {
  try {
    const result = await db.prepare(
      `INSERT INTO essays (user_id, title, genre, topic_text, topic_images, custom_prompt)
       VALUES (?, ?, 'sh-gaokao-essay', ?, NULL, NULL)`,
    ).bind(userId, '示例：The Power of Habits', TOPIC_TEXT).run();
    const essayId = result.meta.last_row_id as number;
    if (!essayId) throw new Error('作文插入未返回 id');

    const d1 = await db.prepare(
      `INSERT INTO drafts (essay_id, user_id, version, text, source, word_count, handwriting_score)
       VALUES (?, ?, 1, ?, 'text', ?, NULL)`,
    ).bind(essayId, userId, DRAFT_1, DRAFT_1.trim().split(/\s+/).length).run();
    const draft1Id = d1.meta.last_row_id as number;

    await db.prepare(
      `INSERT INTO reviews (draft_id, essay_id, user_id, result, model, reviewed_text)
       VALUES (?, ?, ?, ?, '示例数据（注册预置）', ?)`,
    ).bind(draft1Id, essayId, userId, JSON.stringify(REVIEW_1), DRAFT_1).run();

    const d2 = await db.prepare(
      `INSERT INTO drafts (essay_id, user_id, version, text, source, word_count, handwriting_score)
       VALUES (?, ?, 2, ?, 'text', ?, NULL)`,
    ).bind(essayId, userId, DRAFT_2, DRAFT_2.trim().split(/\s+/).length).run();
    const draft2Id = d2.meta.last_row_id as number;

    await db.prepare(
      `INSERT INTO reviews (draft_id, essay_id, user_id, result, model, reviewed_text)
       VALUES (?, ?, ?, ?, '示例数据（注册预置）', ?)`,
    ).bind(draft2Id, essayId, userId, JSON.stringify(REVIEW_2), DRAFT_2).run();

    await db.prepare(
      `INSERT INTO polishes (essay_id, draft_id, user_id, mode, fragment, instruction, result)
       VALUES (?, ?, ?, 'fragment', ?, '让结尾更有力量', ?)`,
    ).bind(essayId, draft2Id, userId, POLISH_FRAGMENT, JSON.stringify(POLISH_RESULT)).run();
  } catch (err: any) {
    console.error(`[sample-essay] 预置示例作文失败（不影响注册）: ${err?.message ?? err}`);
    try {
      await db.prepare('DELETE FROM essays WHERE user_id = ? AND title = ?')
        .bind(userId, '示例：The Power of Habits').run();
    } catch { /* ignore */ }
  }
}
