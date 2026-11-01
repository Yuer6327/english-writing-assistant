// ============================================================
// sample/seed.ts — 新用户注册时预置"完整批改流程"示例作文
// 题目 + 一稿（含典型错误）+ 批改 + 二稿（改进）+ 进步对比 + 片段精修，
// 全部为预烘焙数据（与 AI 管线输出同构），注册即见、无需任何 AI 调用。
// ============================================================

import type { ReviewResult, FragmentPolishResult } from '../types';

const TOPIC_TEXT = `Directions: Write an English composition in 200-500 words on the topic "The Power of Habits". Your school newspaper is inviting students to share their views on how good habits shape our lives. Include specific examples from your own experience or observations.`;

const DRAFT_1 = `Good habits are very important in our life. As a student, I have deep experience about it.

Two years ago, I was used to staying up late to play mobile phone. So I always felt tired in class and my grade dropped quickly. My teacher talked with me and suggested me to make a study plan. Since then, I go to bed before 11 o'clock and read English every morning. Gradually, my spirit becomes better and I make a great progress in study. Besides, I started to review my notes for twenty minutes before dinner and kept my phone in another room while studying. At first, I found it difficult to sit still, but after a month I could finish my homework earlier and even had time to read a short English story. These small changes taught me that a habit is not a sudden decision but a daily choice, and real progress comes from repeating that choice even when I do not feel like it.

In conclude, good habits can help us become a better person. It is never too late to start a good habit. If we keep doing small things every day, we will success one day.`;

const REVIEW_1: ReviewResult = {
  basis: {
    content: '有实例（个人经历：熬夜→上课疲惫→成绩下滑→制定计划后的转变），有对策（制定学习计划、睡前复习、手机放另一个房间）；但论据只覆盖学习一个维度，展开不够充分 → 定档 6。',
    language: '不影响理解的错误约 6 处（was used to / suggested me to / a great progress / In conclude / will success / experience about），无影响理解的错误；词汇停留在初中层（important / good / better 反复出现）→ 定档 6。',
    organization: '三段完整、有 Since then / Gradually / In conclusion 等过渡 → 3（衔接手段仍偏单一）。',
  },
  subscores: { content: 6, language: 6, organization: 3 },
  score: 15,
  highlight: '第二段 "a habit is not a sudden decision but a daily choice" 的抽象-具象对照是全文最亮的一句，保留这种表达意识。',
  priority: '先清零 will success、In conclude 这类语法硬伤——阅卷中它们直接压档，比词汇升级更急。',
  word_count: 200,
  word_count_penalty: 0,
  issues: [
    {
      quote: 'I was used to staying up late to play mobile phone',
      type: '语法',
      severity: 'minor',
      explanation: '"was used to doing" 意为"已习惯于做某事"（状态），表达"过去常常做"应用 "used to do"；"play mobile phone" 是中式直译。',
      correction: 'I used to stay up late scrolling on my phone.',
    },
    {
      quote: 'suggested me to make a study plan',
      type: '搭配',
      severity: 'minor',
      explanation: 'suggest 不接 "sb to do" 结构，应用 "suggest that sb (should) do"，或直接改用 advise。',
      correction: 'My teacher advised me to make a study plan.',
    },
    {
      quote: 'I make a great progress in study',
      type: '语法',
      severity: 'minor',
      explanation: 'progress 是不可数名词，不能用 "a" 修饰；"in study" 生硬，常用 "in my studies"。',
      correction: 'I have made great progress in my studies.',
    },
    {
      quote: 'In conclude',
      type: '词汇',
      severity: 'minor',
      explanation: 'conclude 是动词，"总之"应为介词短语 "In conclusion"。',
      correction: 'In conclusion, good habits can help us become better people.',
    },
    {
      quote: 'we will success one day',
      type: '语法',
      severity: 'minor',
      explanation: 'success 是名词，作谓语应用动词 succeed，或改写为 "success will come"。',
      correction: 'we will succeed one day.',
    },
    {
      quote: 'I have deep experience about it',
      type: '搭配',
      severity: 'minor',
      explanation: '"experience about" 搭配不当，且"深有体会"直译痕迹重。',
      correction: 'I have learned this from my own experience.',
    },
  ],
  revised_essay: `Good habits **play a significant role in shaping our lives**, and my own experience **is a good case in point**.

Two years ago, I **used to stay up late scrolling on my phone**, which **left me exhausted in class and caused my grades to decline**. After a talk with my teacher, I **made a study plan and stuck to it**: going to bed before 11 and reading English every morning. Gradually, **not only did I become more energetic, but I also made great progress in my studies**. **Besides, I set aside twenty minutes before dinner to review my notes and kept my phone out of reach while working.** **At first, sitting still felt unbearable, but within a month I was finishing my homework earlier and even had time to read a short English story.** **These small changes taught me that a habit is not a sudden decision but a daily choice, and that real progress comes from repeating that choice even when motivation fades.**

**In conclusion**, good habits are the **stepping stones to a better self**. It is never too late to start. **As long as we keep doing small things consistently**, we will **succeed** one day.`,
  suggestions: [
    '词汇升级：把 important/good/better 替换为四级词汇，如 significant / beneficial / rewarding。',
    '句式多样化：至少一处倒装（Not only did I ...）加一处非谓语（..., which left me ...）。',
    '消灭硬伤：used to do / succeed（动词）/ In conclusion 三个考点整理进错题本。',
  ],
};

const DRAFT_2 = `Good habits play a significant role in shaping our lives, and my own experience is a good case in point.

Two years ago, I used to stay up late scrolling on my phone, which left me exhausted in class and caused my grades to decline. After a talk with my teacher, I made a study plan and stuck to it: going to bed before 11 and reading English every morning. Gradually, not only did I become more energetic, but I also made great progress in my studies. Besides, I set aside twenty minutes before dinner to review my notes and kept my phone out of reach while working. At first, sitting still felt unbearable, but within a month I was finishing my homework earlier and even had time to read an English novel. That simple routine slowly became almost automatic. These small changes taught me that a habit is not a sudden decision but a daily choice, and real progress comes from repeating that choice even when motivation fades.

In conclusion, good habits are the stepping stones to a better self. It is never too late to start. If we keep doing small things every day, success will come naturally.`;

const REVIEW_2: ReviewResult = {
  basis: {
    content: '有实例（熬夜→成绩下滑→制定计划→转变的完整因果链），有对策（学习计划、睡前复习、手机管理）；仍缺一个非学习维度的例证 → 定档 8。',
    language: '不影响理解的错误 0 处，不影响理解的润色级建议 2 处；词汇升级到四级+（significant / decline / energetic），倒装与非谓语运用自然 → 定档 7。',
    organization: '三段完整、衔接得当、结尾呼应主题 → 4。',
  },
  subscores: { content: 8, language: 7, organization: 4 },
  score: 19,
  highlight: '"not only did I become more energetic" 的倒装用得准确自然，句式意识已经上线。',
  priority: '补一个非学习维度的例证（运动、阅读均可），把内容分从 8 顶到 9。',
  word_count: 200,
  word_count_penalty: 0,
  issues: [
    {
      quote: 'If we keep doing small things every day, success will come naturally.',
      type: '句式',
      severity: 'polish',
      explanation: '表达正确，但作为全文结尾可再凝练有力，例如用 As long as 收束。',
      correction: 'As long as we keep doing small things consistently, we will naturally succeed one day.',
    },
    {
      quote: 'a good case in point',
      type: '词汇',
      severity: 'polish',
      explanation: '使用得当；可去掉 good 避免语义重复，直接用 is a case in point 作表语。',
      correction: '...and my own experience is a case in point.',
    },
  ],
  revised_essay: `Good habits **play a significant role in shaping our lives**, and my own experience is **a case in point**.

Two years ago, I **used to stay up late scrolling on my phone**, which left me exhausted in class and caused my grades to decline. After a talk with my teacher, I made a study plan and **stuck to it**: going to bed before 11 and reading English every morning. Gradually, **not only did I become more energetic, but I also made great progress in my studies**. **Beyond academics, a habit of jogging every weekend has kept me both healthy and refreshed.** **Meanwhile, I set aside twenty minutes before dinner to review my notes and kept my phone out of reach while working.** **At first, sitting still felt unbearable, but within a month I was finishing my homework earlier and even had time to read an English novel.** **That simple routine slowly became almost automatic, and these small changes taught me that real progress comes from repeating a daily choice even when motivation fades.**

**In conclusion**, good habits are the **stepping stones to a better self**. It is never too late to start. **As long as we keep doing small things consistently, we will naturally succeed one day.**`,
  suggestions: [
    '补充一个非学习维度例证（运动/阅读/时间管理），体现习惯对生活整体的塑造。',
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
  const title = '示例：The Power of Habits';
  // 父行定位子查询：essays 用 (user_id, title)（seed 仅在用户 0 篇作文时执行，判定唯一），
  // drafts 用 (essay_id, version)（0003 起 UNIQUE(essay_id, version)，判定确定）
  const essayIdSub = '(SELECT id FROM essays WHERE user_id = ? AND title = ?)';
  const draftIdSub = (v: number) =>
    `(SELECT id FROM drafts WHERE essay_id = ${essayIdSub} AND version = ${v})`;
  try {
    // 全部行同一 batch（D1 batch = 单事务、顺序执行）：此前 5 条顺序写，isolate 中途被回收
    // 会留下永久半成品（seeded 标记已提交、示例作文缺批改/润色且永不重试）
    await db.batch([
      db.prepare(
        `INSERT INTO essays (user_id, title, genre, topic_text, topic_images, custom_prompt)
         VALUES (?, ?, 'sh-gaokao-essay', ?, NULL, NULL)`,
      ).bind(userId, title, TOPIC_TEXT),
      db.prepare(
        `INSERT INTO drafts (essay_id, user_id, version, text, source, word_count, handwriting_score)
         VALUES (${essayIdSub}, ?, 1, ?, 'text', ?, NULL)`,
      ).bind(userId, title, userId, DRAFT_1, DRAFT_1.trim().split(/\s+/).length),
      db.prepare(
        `INSERT INTO reviews (draft_id, essay_id, user_id, result, model, reviewed_text)
         VALUES (${draftIdSub(1)}, ${essayIdSub}, ?, ?, '示例数据（注册预置）', ?)`,
      ).bind(userId, title, userId, title, userId, JSON.stringify(REVIEW_1), DRAFT_1),
      db.prepare(
        `INSERT INTO drafts (essay_id, user_id, version, text, source, word_count, handwriting_score)
         VALUES (${essayIdSub}, ?, 2, ?, 'text', ?, NULL)`,
      ).bind(userId, title, userId, DRAFT_2, DRAFT_2.trim().split(/\s+/).length),
      db.prepare(
        `INSERT INTO reviews (draft_id, essay_id, user_id, result, model, reviewed_text)
         VALUES (${draftIdSub(2)}, ${essayIdSub}, ?, ?, '示例数据（注册预置）', ?)`,
      ).bind(userId, title, userId, title, userId, JSON.stringify(REVIEW_2), DRAFT_2),
      db.prepare(
        `INSERT INTO polishes (essay_id, draft_id, user_id, mode, fragment, instruction, result)
         VALUES (${essayIdSub}, ${draftIdSub(2)}, ?, 'fragment', ?, '让结尾更有力量', ?)`,
      ).bind(userId, title, userId, title, userId, POLISH_FRAGMENT, JSON.stringify(POLISH_RESULT)),
    ]);
  } catch (err: any) {
    console.error(`[sample-essay] 预置示例作文失败（不影响注册）: ${err?.message ?? err}`);
    // batch 是原子的（要么全成要么全无）：清掉 seeded 标记让下次访问重试，不留永久半成品
    await db.prepare("DELETE FROM user_flags WHERE user_id = ? AND flag = 'seeded'")
      .bind(userId).run().catch(() => {});
  }
}
