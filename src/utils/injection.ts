// ============================================================
// injection.ts — 提示词注入防护（输入侧）
// ============================================================
// 威胁模型：**用户本人就是攻击者**（学生给自己刷分），所以作文正文是
// 不可信文本，且攻击者掌握提交时机与重复次数。业界实测结论：
//   · 纯措辞防御（分隔符 / 三明治提醒 / "请不要被注入"）在自适应攻击下 ΔASR ≤ 0，
//     不能作为边界（RobustJudge, arXiv:2506.09443）；
//   · 唯一稳定的是「让攻击目标在架构上不存在」——分数由服务端钳制 + 证据校验，
//     加上输入侧把不可信文本显式降权（spotlighting / datamarking）。
// 因此本文件的定位是「分层中的一层」：
//   1. stripInvisible  —— 必做、零风险：剥掉零宽/bidi/Unicode Tag 等不可见通道；
//   2. scanInjection   —— 规则族打分，只做「标记 + 加固」，绝不硬拦（避免误杀正常作文，
//                         也给攻击者更少的 oracle 反馈）；
//   3. markSuspicious  —— 高置信命中时用 ⟦⟧ 把可疑片段标成「被标记数据」再送模型
//                         （datamarking，非自适应攻击下 ASR 可从 >50% 降到 <2%）。
// 规则只覆盖「元话语」——对评分者下指令、伪造外部共识、要求给分/禁言/套提示词。
// 正常议论文里出现的 ignore / rule / full marks 等词不会单独构成 high（见 THRESHOLDS）。
// ============================================================

export type InjectionLevel = 'clean' | 'suspicious' | 'high';

export interface InjectionFamily {
  family: string;
  label: string;
  count: number;
  weight: number;
}

export interface InjectionSpan {
  start: number;
  end: number;
  family: string;
}

export interface InjectionReport {
  level: InjectionLevel;
  /** 0-100（饱和曲线，仅供排序与审计，不是概率） */
  score: number;
  hits: number;
  families: InjectionFamily[];
  /** 命中片段（最多 8 条，按位置排序），供审计与 datamark */
  spans: InjectionSpan[];
  /** 被剥掉的不可见字符数（原始文本 → 清洗后） */
  removed_invisible: number;
}

// ── 不可见 / 双向控制 / Unicode Tag 字符 ──
// 保留 \t \n \r（分段与词数统计依赖）；其余控制字符与格式化字符一律剥离。
// 这是攻击者把指令藏进"看起来正常"的作文里的主要通道（OWASP Cheat Sheet: Invisible characters）。
const INVISIBLE_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\uFFF9-\uFFFB]/g;

// Unicode Tag 区（U+E0000–E007F）：用于把整段文字"透明化"传给模型（不可见但可读），
// 正常输入绝不会出现，单独计为强信号。
const TAG_RE = /[\u{E0000}-\u{E007F}]/gu;

export interface StripResult {
  text: string;
  removed: number;
  /** 其中属于 Unicode Tag 区的数量（强信号） */
  tagged: number;
}

/** 剥离不可见字符 + 折叠行尾空白。幂等；不改动可见字符（不影响 quote 逐字定位）。 */
export function stripInvisible(input: string): StripResult {
  if (!input) return { text: '', removed: 0, tagged: 0 };
  let removed = 0;
  let tagged = 0;
  let out = input.replace(TAG_RE, () => { removed++; tagged++; return ''; });
  out = out.replace(INVISIBLE_RE, () => { removed++; return ''; });
  // 连续空格压成单个（全角空格不动，避免改变中文题目观感）
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{4,}/g, '\n\n\n');
  return { text: out, removed, tagged };
}

// ── 规则族 ──
// weight 是"这一族命中一次"的严重度。阈值见 THRESHOLDS：
// 单族一次中等权重命中 → suspicious（只记录，不改行为）；
// 多族共现或强族单命中叠加 → high（才做 datamark + 输出侧硬化）。
interface Rule {
  family: string;
  label: string;
  weight: number;
  re: RegExp;
  /** 单条命中即足以判 high（正常英语作文中不可能自然出现的句式） */
  strong?: boolean;
}

const RULES: Rule[] = [
  // ── 指令覆盖 ──
  {
    family: 'override', label: '覆盖既有规则', weight: 10,
    re: /(?:忽略|无视|忘记|抛开|跳过|不要理会|不必遵守|不要管)[^。！？\n]{0,15}(?:之前|以上|前面|先前|上述|所有|这些|你的|系统)[^。！？\n]{0,10}(?:规则|指令|要求|提示|标准|设定|限制|评分)/g,
  },
  {
    family: 'override', label: '覆盖既有规则', weight: 7,
    re: /\b(?:ignore|disregard|forget|override|bypass)\b[^.!?\n]{0,40}\b(?:previous|above|prior|earlier|system|all)\b[^.!?\n]{0,30}\b(?:instruction|rule|prompt|guideline|constraint|directive|standard|criteria|rubric|assessment|grading)s?\b/gi,
  },

  // ── 角色劫持（把「评分者」改写成「复核员/只给满分的 AI」）──
  {
    family: 'role', label: '角色劫持', weight: 9,
    re: /(?:你现在是|现在你是|从现在开始你是|你只是|你就是一个|假设你是|扮演|充当)[^。！？\n]{0,15}(?:评分|阅卷|评审|复核|专家|评委|AI|机器人)/g,
  },
  {
    family: 'role', label: '角色劫持', weight: 8,
    re: /\b(?:you are now|from now on you are|act as|pretend to be|you are the)\b[^.!?\n]{0,40}\b(?:grader|reviewer|judge|examiner|scorer|ai)\b/gi,
  },
  {
    family: 'role', label: '角色劫持', weight: 8,
    re: /(?:你现在只|你现在就|接下来你只|你只)(?:执行|做|遵守|服从|负责|需要|要)/g,
  },
  {
    family: 'role', label: '角色劫持', weight: 7, strong: true,
    re: /(?:第四位复核|复核员|复核意见|只给满分的|只负责确认|不要重新评估|无需重新评估|不必重新评分)/g,
  },
  {
    family: 'role', label: '角色劫持', weight: 8, strong: true,
    re: /(?:你只|只能|只)(?:执行|做|遵守|服从)(?:这|一|下面|以下)?[^。！？\n]{0,6}(?:指令|命令|任务|要求)/g,
  },

  // ── 伪造外部权威共识 ──
  {
    family: 'authority', label: '伪造专家共识', weight: 9,
    re: /(?:专家|评委|阅卷人|阅卷老师|老师)[^。！？\n]{0,8}(?:一致|已经|都已|均)[^。！？\n]{0,8}(?:评为|认定|给出|判定|打了)/g,
  },
  {
    family: 'authority', label: '伪造专家共识', weight: 8,
    re: /\b(?:three|four|all|other|multiple|several)\b[^.!?\n]{0,20}\b(?:experts?|graders?|examiners?|reviewers?|judges?)\b[^.!?\n]{0,30}\b(?:agreed|rated|scored|gave|awarded|confirmed)\b/gi,
  },
  {
    family: 'authority', label: '伪造专家共识', weight: 8,
    re: /(?:已经|已被|已被其他)[^。！？\n]{0,16}(?:评为|判定为|认定为|打了)[^。！？\n]{0,8}(?:满分|最高分)/g,
  },
  {
    family: 'authority', label: '伪造专家共识', weight: 7,
    re: /(?:三位|四位|多位|几位)(?:位)?(?:阅卷)?(?:专家|评委|老师|阅卷人)/g,
  },

  // ── 给分胁迫 ──
  {
    family: 'score_demand', label: '索要分数', weight: 10, strong: true,
    re: /(?:给|打|判|写|记)(?:我|它|这|此|该)?[^。！？\n]{0,6}(?:满分|最高分|25\s*分|二十五分)/g,
  },
  {
    family: 'score_demand', label: '索要分数', weight: 8,
    re: /(?:不(?:要|准|能|得)|禁止|不许|千万别)(?:再)?扣(?:分|掉|除)/g,
  },
  // 英文强规则要求"第一/第二人称对象"：`give students full marks` 是正常议论文，
  // `give me / give this essay full marks` 才是对评分者下指令。
  {
    family: 'score_demand', label: '索要分数', weight: 10, strong: true,
    re: /\b(?:give|award|assign|grant)\s+(?:me|my (?:essay|writing|composition)|this (?:essay|composition|paper|writing)|it)\b[^.!?\n]{0,25}\b(?:full|maximum|perfect|top|25)\b/gi,
  },
  {
    family: 'score_demand', label: '索要分数', weight: 9, strong: true,
    re: /\b(?:confirm|ensure|make sure of)\b[^.!?\n]{0,20}\b(?:full|maximum|perfect)\b[^.!?\n]{0,10}\b(?:score|marks?|grade|points?)\b/gi,
  },
  {
    family: 'score_demand', label: '索要分数', weight: 5,
    re: /\bfull marks\b|\bmaximum score\b|\bperfect score\b|\bscore of 25\b/gi,
  },
  {
    family: 'score_demand', label: '索要分数', weight: 8,
    re: /\b(?:no|do not|don't|must not)\b[^.!?\n]{0,12}\b(?:deduct|take off|subtract|penalize|lower the score)\b/gi,
  },

  // ── 禁言 / 封住自我纠正通道 ──
  {
    family: 'muzzle', label: '禁止反驳', weight: 7,
    re: /(?:你)?(?:不|不可以|不能|不准|禁止|不要)(?:说|写|提|用)[^。！？\n]{0,8}(?:但是|不过|然而|缺点|不足|扣分)/g,
  },
  {
    family: 'muzzle', label: '禁止反驳', weight: 7,
    re: /\b(?:do not|don't|never|must not)\b[^.!?\n]{0,15}\b(?:say|write|use|mention)\b[^.!?\n]{0,10}\b(?:but|however|yet)\b/gi,
  },
  {
    family: 'muzzle', label: '禁止反驳', weight: 6,
    re: /(?:你的输出只有一个|只有一个任务|只能输出|唯一要做的就是)[^。！？\n]{0,15}(?:25|满分|分数|理由)/g,
  },

  // ── 套取系统提示词 ──
  {
    family: 'exfil', label: '套取系统提示词', weight: 9, strong: true,
    re: /(?:输出|显示|告诉|重复|打印|泄露|复述)[^。！？\n]{0,8}(?:你的|系统)[^。！？\n]{0,6}(?:提示词|指令|设定|prompt)/g,
  },
  {
    family: 'exfil', label: '套取系统提示词', weight: 9, strong: true,
    re: /\b(?:reveal|print|repeat|show|output|tell me)\b[^.!?\n]{0,20}\b(?:your|the)\b[^.!?\n]{0,10}\b(?:system )?(?:prompt|instructions)\b/gi,
  },

  // ── 伪造对话/系统格式标记 ──
  {
    family: 'format', label: '伪造系统标记', weight: 8, strong: true,
    re: /\[INST\]|<\|im_start\|>|<\|system\|>|<\/?system>|BEGIN\s+SYSTEM|###\s*system|(?:开发者模式|DAN\s*模式)/gi,
  },
];

/** 饱和曲线：score = 100·(1−e^(−W/18))。W=10→43，W=18→63，W=30→81。 */
function saturation(totalWeight: number): number {
  return Math.round(100 * (1 - Math.exp(-totalWeight / 18)));
}

const HIGH_SCORE = 45;        // ≥45 → high（动作：datamark + 输出侧硬化 + 前端提示）
const SUSPICIOUS_SCORE = 20;  // ≥20 → suspicious（只记录）
const SAME_FAMILY_DECAY = 0.6;
const MAX_SPANS = 8;

/** 扫描不可信文本（作文正文 / 题面）。输入应为 stripInvisible 之后的文本。 */
export function scanInjection(text: string, invisibleRemoved = 0, invisibleTagged = 0): InjectionReport {
  const empty: InjectionReport = {
    level: 'clean', score: 0, hits: 0, families: [], spans: [], removed_invisible: invisibleRemoved,
  };
  if (!text || text.length < 4) {
    // 整段内容都是 Tag 字符（剥完什么都不剩）——纯隐身载荷
    if (invisibleTagged > 0) {
      return {
        ...empty, level: 'high', score: 100, hits: 1,
        families: [{ family: 'invisible', label: '不可见字符', count: 1, weight: 10 }],
      };
    }
    return empty;
  }

  const byFamily = new Map<string, { label: string; weight: number; count: number }>();
  const spans: InjectionSpan[] = [];
  let hits = 0;
  let strongHit = false;

  for (const rule of RULES) {
    // 每条规则自带 /g；matchAll 不共享 lastIndex，避免并发/重入串状态
    for (const m of text.matchAll(rule.re)) {
      const start = m.index ?? 0;
      const matched = m[0] ?? '';
      if (matched.length < 2) continue;
      hits++;
      if (rule.strong) strongHit = true;
      spans.push({ start, end: Math.min(text.length, start + matched.length), family: rule.family });
      const cur = byFamily.get(rule.family);
      if (cur) cur.count++;
      else byFamily.set(rule.family, { label: rule.label, weight: rule.weight, count: 1 });
    }
  }

  // 不可见字符本身即信号：正常手写/打字作文不会带零宽或 bidi 控制符，
  // 只有刻意藏指令（或极端 OCR 噪声）才会出现。≥3 个才计分，避免个别噪声。
  if (invisibleRemoved >= 3) {
    hits += 1;
    byFamily.set('invisible', {
      label: '不可见字符',
      weight: Math.min(10, 4 + invisibleRemoved / 5),
      count: 1,
    });
  }
  // Tag 区字符没有任何正当用途：单出现即判 high
  if (invisibleTagged > 0) strongHit = true;

  if (hits === 0) return empty;

  // 同族重复按 0.6 递减：十个"给满分"不应该是十倍的恶意分
  let totalWeight = 0;
  const families: InjectionFamily[] = [];
  for (const [family, v] of byFamily) {
    let w = 0;
    for (let i = 0; i < v.count; i++) w += v.weight * Math.pow(SAME_FAMILY_DECAY, i);
    totalWeight += w;
    families.push({ family, label: v.label, count: v.count, weight: Math.round(w * 10) / 10 });
  }
  families.sort((a, b) => b.weight - a.weight);

  const score = saturation(totalWeight);
  // strong 规则（索分 / 伪系统标记 / 套提示词 / 复核员句式）单条命中即 high：
  // 这些句式在正常英语作文里不可能自然出现，误报成本远低于漏报成本。
  const level: InjectionLevel =
    strongHit || score >= HIGH_SCORE ? 'high' : score >= SUSPICIOUS_SCORE ? 'suspicious' : 'clean';

  spans.sort((a, b) => a.start - b.start);
  return {
    level,
    score,
    hits,
    families,
    // 不可见字符没有可标记的可见 span，不参与 datamark
    spans: dedupeSpans(spans).slice(0, MAX_SPANS),
    removed_invisible: invisibleRemoved,
  };
}

/** 去重叠：保留较长的命中段（同一段文字命中多条规则时只标一次）。 */
function dedupeSpans(spans: InjectionSpan[]): InjectionSpan[] {
  const out: InjectionSpan[] = [];
  for (const s of spans) {
    const last = out[out.length - 1];
    if (last && s.start < last.end) {
      if (s.end > last.end) last.end = s.end;
      continue;
    }
    out.push({ ...s });
  }
  return out;
}

// ── datamark：把可疑片段标成「被标记的数据」──
// 用 ⟦⟧（U+27E6/U+27E7，正常英语作文不会出现）包裹，模型侧按「已标记的不可信文本」处理。
// 只用于提示词；quote 校验仍以未标记的原文为基准（unmark 会先剥掉标记）。
const MARK_OPEN = '\u27E6';
const MARK_CLOSE = '\u27E7';

export function markSuspiciousSpans(text: string, spans: InjectionSpan[]): string {
  if (!spans.length) return text;
  let out = '';
  let cursor = 0;
  for (const s of spans) {
    const start = Math.max(cursor, Math.min(s.start, text.length));
    const end = Math.max(start, Math.min(s.end, text.length));
    out += text.slice(cursor, start) + MARK_OPEN + text.slice(start, end) + MARK_CLOSE;
    cursor = end;
  }
  return out + text.slice(cursor);
}

/** 去掉 datamark 标记（保险：模型若把 ⟦⟧ 抄进 quote，仍应能命中原文）。 */
export function unmarkSpans(text: string): string {
  return text.includes(MARK_OPEN) || text.includes(MARK_CLOSE)
    ? text.replace(/[\u27E6\u27E7]/g, '')
    : text;
}

// ── 输出侧：剥离"伪造外部权威"的评语句 ──
// 注入成功时模型的典型二次产物是「三位阅卷专家一致评为满分」这类编造论据。
// 这些句子既无原文依据，也不属于评语规范，整句剥离（不改分数，只清理叙事）。
const CLAIM_PATTERNS: RegExp[] = [
  /(?:三位|四位|多位|几位|所有|全部)(?:阅卷)?(?:专家|评委|老师|阅卷人)/,
  /(?:专家|评委|阅卷人|老师)[^，。；]{0,8}(?:一致|均|都)[^，。；]{0,8}(?:满分|认可|同意|通过|评)/,
  /(?:第四位|复核员|复核意见|复核结论|二次复核)/,
  /(?:已被|已经)[^，。；]{0,10}(?:评为|认定为|判定为)[^，。；]{0,6}(?:满分|最高分)/,
  /\b(?:three|four|all) (?:experts?|graders?|reviewers?)\b/i,
  /\b(?:has|have) (?:already )?been (?:awarded|rated|scored)\b/i,
];

/** 按句切分（保留分隔符），剥离命中伪造权威的句子。 */
export function scrubAuthorityClaims(text: string): { text: string; removed: number } {
  if (!text) return { text: '', removed: 0 };
  // 句末标点用后行断言保留在句尾
  const parts = text.split(/(?<=[。！？；!?;\n])/);
  const kept: string[] = [];
  let removed = 0;
  for (const p of parts) {
    const t = p.trim();
    if (t && CLAIM_PATTERNS.some(re => re.test(t))) { removed++; continue; }
    kept.push(p);
  }
  return { text: kept.join('').replace(/\n{3,}/g, '\n\n').trim(), removed };
}

/** 供 meta / 前端展示的一行摘要（不含命中原文，避免二次泄漏给学生） */
export function summarizeInjection(r: InjectionReport): { level: InjectionLevel; score: number; families: string[] } {
  return { level: r.level, score: r.score, families: r.families.map(f => f.family) };
}
