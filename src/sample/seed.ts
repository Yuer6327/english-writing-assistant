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
  diagnosis: {
    content: '主题明确（好习惯的力量），有个人经历作论据，但论据单一：只有"学习习惯"一个维度，未涉及习惯对生活其他方面（健康、情绪、自律）的影响，观点展开不够充分。',
    language: '词汇偏基础（important / good / better 反复出现），距四级水平有差距；存在多处语法与搭配错误：was used to（应为 used to）、suggested me to（应为 suggested that I ...）、make a great progress（progress 不可数）、In conclude（应为 In conclusion）、will success（success 是名词，应为 succeed）；句式以简单句为主，缺少从句、非谓语等加分结构。',
    organization: '三段式结构清晰（引入—事例—总结），Since then / Gradually 等衔接使用得当，但段际过渡手段仍显单一。',
  },
  subscores: { content: 6, language: 6, organization: 3 },
  score: 15,
  overall_comment: '主要问题在语言层：词汇停留在初中层（important/good 反复出现），句式以简单句为主，且 used to / suggest / progress / succeed 等多处语法硬伤在阅卷中会直接压档；内容上论据只有"学习"一个维度。先清零语法硬伤，再升级词汇与句式。',
  word_count: 200,
  word_count_penalty: 0,
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

Two years ago, I **used to stay up late scrolling on my phone**, which **left me exhausted in class and caused my grades to decline**. After a talk with my teacher, I **made a study plan and stuck to it**: going to bed before 11 and reading English every morning. Gradually, **not only did I become more energetic, but I also made great progress in my studies**. **Besides, I set aside twenty minutes before dinner to review my notes and kept my phone out of reach while working.** **At first, sitting still felt unbearable, but within a month I was finishing my homework earlier and even had time to read a short English novel in the evening.** **These small changes taught me that a habit is not a sudden decision but a daily choice, and that real progress comes from repeating that choice even when motivation fades.**

**In conclusion**, good habits are the **stepping stones to a better self**. It is never too late to start. **As long as we keep doing small things consistently**, we will **succeed** one day.`,
  suggestions: [
    '词汇升级：把 important/good/better 替换为四级词汇，如 significant / beneficial / rewarding。',
    '句式多样化：至少使用一处倒装（Not only did I ...）、一处非谓语（..., which left me ...）和一处强调句。',
    '内容展开：除学习外，再从健康或自律角度补充一句例证，让"习惯的力量"更有说服力。',
    '消灭硬伤：used to do / succeed（动词）/ In conclusion 三个考点要整理进错题本。',
  ],
  practice: {
    intro: '针对一稿暴露的语法与搭配硬伤，先把这几个考点练稳。',
    items: [
      {
        chinese: '两年前我常常熬夜玩手机，上课总是很疲惫。',
        answer: 'Two years ago, I used to stay up late playing with my phone, and I was always tired in class.',
        target: 'used to do（过去常常）与 be used to doing（习惯于）的区别，对应原文 "was used to staying up late" 的错误。',
      },
      {
        chinese: '老师建议我制定一份学习计划。',
        answer: 'My teacher advised me to make a study plan. / My teacher suggested that I (should) make a study plan.',
        target: 'suggest 不接 sb to do，应用 suggest that sb (should) do 或改用 advise sb to do。',
      },
      {
        chinese: '经过一个学期的努力，我在学习上取得了很大进步。',
        answer: 'After a term of hard work, I have made great progress in my studies.',
        target: 'progress 不可数，不能用 a 修饰；"在学习上"用 in my studies。',
      },
      {
        chinese: '总之，只要我们坚持做小事，终有一天会成功。',
        answer: 'In conclusion, as long as we keep doing small things, we will succeed one day.',
        target: 'In conclusion（介词短语）与 succeed（动词）的用法，对应原文 "In conclude / will success"。',
      },
    ],
  },
};

const DRAFT_2 = `Good habits play a significant role in shaping our lives, and my own experience is a good case in point.

Two years ago, I used to stay up late scrolling on my phone, which left me exhausted in class and caused my grades to decline. After a talk with my teacher, I made a study plan and stuck to it: going to bed before 11 and reading English every morning. Gradually, not only did I become more energetic, but I also made great progress in my studies. Besides, I set aside twenty minutes before dinner to review my notes and kept my phone out of reach while working. At first, sitting still felt unbearable, but within a month I was finishing my homework earlier and even had time to read an English novel. That simple routine slowly became almost automatic. These small changes taught me that a habit is not a sudden decision but a daily choice, and real progress comes from repeating that choice even when motivation fades.

In conclusion, good habits are the stepping stones to a better self. It is never too late to start. If we keep doing small things every day, success will come naturally.`;

const REVIEW_2: ReviewResult = {
  diagnosis: {
    content: '立意不变，叙事更完整（补充了"grades decline → plan → result"的因果链），但仍可增加一个非学习维度的例证（如运动、阅读）使论证更立体。',
    language: '词汇明显升级（significant / decline / energetic / stepping stones），倒装句 "not only did I" 与非限制性定语从句运用自然；剩余问题较少，个别表达仍有提升空间。',
    organization: '三段结构完整，衔接词使用得当，结尾呼应主题。',
  },
  subscores: { content: 8, language: 7, organization: 4 },
  score: 19,
  overall_comment: '语法硬伤已基本清零，当前最大短板是内容：论据仍局限于学习单一维度，缺少第二个角度的例证；结尾 if 条件句正确但平淡。补足非学习维度的例证并升级收尾句式，即可向 21 分以上冲刺。',
  word_count: 200,
  word_count_penalty: 0,
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

Two years ago, I **used to stay up late scrolling on my phone**, which left me exhausted in class and caused my grades to decline. After a talk with my teacher, I made a study plan and **stuck to it**: going to bed before 11 and reading English every morning. Gradually, **not only did I become more energetic, but I also made great progress in my studies**. **Beyond academics, a habit of jogging every weekend has kept me both healthy and refreshed.** **Meanwhile, I set aside twenty minutes before dinner to review my notes and kept my phone out of reach while working.** **At first, sitting still felt unbearable, but within a month I was finishing my homework earlier and even had time to read an English novel.** **That simple routine slowly became almost automatic, and these small changes taught me that real progress comes from repeating a daily choice even when motivation fades.**

**In conclusion**, good habits are the **stepping stones to a better self**. It is never too late to start. **As long as we keep doing small things consistently, we will naturally succeed one day.**`,
  suggestions: [
    '冲刺更高档：补充一个非学习维度例证（运动/阅读/时间管理），体现习惯对生活整体的塑造。',
    '结尾句用 As long as ... 收束，比 if 条件句更有力量。',
    '保持已掌握的倒装、非谓语结构，考场上先写对再写难。',
  ],
  practice: {
    intro: '二稿语言已较扎实，本组练习聚焦内容多维展开与高级收尾句式。',
    items: [
      {
        chinese: '除了学习，周末跑步的习惯让我保持健康、精力充沛。',
        answer: 'Beyond academics, the habit of jogging at weekends keeps me healthy and energetic.',
        target: '非学习维度例证的表达，补足内容维度"论据单一"的问题。',
      },
      {
        chinese: '只有坚持每天练习，我们才能最终尝到成功的滋味。',
        answer: 'Only by practicing every day can we eventually taste the sweetness of success.',
        target: 'Only + 状语置于句首引起部分倒装（can we），高分收尾句式。',
      },
      {
        chinese: '正是这些微小的日常习惯为我们日后的成功铺平了道路。',
        answer: 'It is these small daily habits that pave the way to our future success.',
        target: '强调句 It is ... that ...，替换平淡陈述，强化结尾。',
      },
    ],
  },
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
  }
}
