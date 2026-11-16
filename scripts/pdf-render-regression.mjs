// Node 回归：驱动 pdf-report.js renderReport 生成 PDF → pdf.js 文本提取验证
// 用法：node scripts/pdf-render-regression.mjs（输出 .wrangler/test/*.pdf + 文本摘要）
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = new URL('..', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');

// ── 载入 pdf-lib（CDN min 包的 ESM 直读不可行，用 node_modules 同版本）──
const PDFLib = require('pdf-lib');

// ── 把 public/js/pdf-report.js 当 ESM 导入（无外部依赖，仅 import api.js 的 gradeFor）──
// pdf-report.js import 了 './api.js'（浏览器侧 toast 等）。为免牵连，这里直接内联复制渲染核心不可取；
// 改为读源码 + 把 import 行剥掉后 eval 成模块。
let src = readFileSync(new URL('../public/js/pdf-report.js', import.meta.url), 'utf8');
src = src.replace(/^import .*$/gm, '');            // 剥掉浏览器 import
src += `\nexport { renderReport as __renderReport };`;

// gradeFor 被 renderReport 使用：提供桩实现（与 api.js 语义一致的截断版）
const gradeFor = (score) => {
  if (score >= 21) return { grade: 'A', label: '优秀' };
  if (score >= 16) return { grade: 'B', label: '良好' };
  if (score >= 11) return { grade: 'C', label: '合格' };
  return { grade: 'D', label: '待提高' };
};
const gradeForS = `const gradeFor = ${gradeFor.toString()};`;

const mod = await import('data:text/javascript;base64,' + Buffer.from(gradeForS + src).toString('base64'));

// ── 测试数据：中英混排 + 长文 + 多稿 + **标记** ──
const data = {
  title: '高三上期中-使用人工智能方面的经验和教训',
  genre_label: '概要写作',
  word_limits: { minWords: 200, maxWords: 500 },
  topic: '最近，你班开展了"使用人工智能方面的经验和教训"的主题班会。请你写一篇发言稿，内容包括：\n1. 你使用人工智能的经历；\n2. 遇到的问题与教训；\n3. 你的建议。\n注意：词数 200-500；The Impact of AI on Learning — 引用标题测试。',
  drafts: [
    {
      version: 1, word_count: 312, text: 'Good morning, everyone!\n\nToday I would like to share my experience with AI tools. 人工智能已经深刻改变了我们的学习方式，but it is a double-edged sword. At first, I relied on ChatGPT to write my essays, which saved me a lot of time. However, when the exam came, I realized that I had learned nothing.',
      review: {
        score: 17, subscores: { content: 7, language: 7, organization: 3 }, word_count_penalty: 0,
        priority: '过度依赖 AI 生成内容，缺少自己的思考过程。',
        highlight: '**结构清晰**，能主动反思 AI 的利与弊。',
        basis: { content: '能覆盖要点，但 AI 使用经历叙述较笼统，缺少具体事例支撑。内容 7/10。', language: '句式有变化，如 "which saved me a lot of time"；但存在中式英语痕迹。语言 7/10。', organization: '开头-主体-结尾完整，段落衔接自然。结构 3/3。' },
        issues: [
          { type: '搭配', severity: 'critical', quote: 'relied on ChatGPT to write my essays', correction: 'relied on ChatGPT to draft my essays', explanation: 'write 搭配没错，但 draft 更贴合"初稿"语义，且避免与下文 write 重复。' },
          { type: '语法', severity: 'minor', quote: 'when the exam came, I realized that I had learned nothing', correction: 'when the exam came, I realized that I had learnt little', explanation: 'nothing 语气过绝对；little 更准确，也体现让步语气。' },
          { type: '润色', severity: 'polish', quote: 'a double-edged sword', correction: 'a double-edged sword that demands careful handling', explanation: '补足宾语从句，句子更完整。' },
        ],
        revised_essay: 'Good morning, everyone!\n\nToday I would like to share my **drafting** experience with AI tools. 人工智能是一把双刃剑。At first, I relied on ChatGPT to **draft** my essays, which saved me a lot of time. However, when the exam came, I realized that I had learnt **little**.',
        suggestions: ['先自己列提纲，再用 AI 补充例证。', '把 AI 当"陪练"而非"枪手"。', '誊抄 AI 稿前逐句改写成自己的话。'],
        improvement: { score_delta: 0, fixed: [], remaining: ['中式英语'], regression: [] },
      },
    },
    {
      version: 2, word_count: 356, text: 'Good morning, everyone!\n\nLast term, I treated AI as my ghostwriter. 这次期中考试给我敲响了警钟：离开 AI 我几乎写不出完整的句子。Now I set a rule for myself: outline first, AI second, my own words last.',
      review: {
        score: 19, subscores: { content: 8, language: 8, organization: 3 }, word_count_penalty: 0,
        priority: '建议阶段仍可加入量化数据（如错误率下降）增强说服力。',
        highlight: '**观点成熟**，能提出可操作的"三步法"。',
        basis: { content: '经历-教训-建议三要点齐全，教训部分有真实细节。内容 8/10。', language: '"敲响了警钟"英译地道；并列句式运用熟练。语言 8/10。', organization: '三步法收尾，结构完整有力。结构 3/3。' },
        issues: [
          { type: '用词', severity: 'minor', quote: 'ghostwriter', correction: 'ghostwriter（可保留）或 crutch', explanation: 'ghostwriter 形象生动；如担心过于文学化可用 crutch。' },
        ],
        revised_essay: 'Good morning, everyone!\n\nLast term, I treated AI as my **crutch**. 这次期中考试给我敲响了警钟：离开 AI 我几乎写不出完整的句子。Now I set a rule for myself: **outline first, AI second, my own words last**.',
        suggestions: ['保持"先自己后 AI"的习惯。', '定期限时手写作文，检验真实水平。'],
        improvement: { score_delta: 2, fixed: ['中式英语表达'], remaining: ['个别搭配可再打磨'], regression: [] },
      },
    },
  ],
};

mkdirSync(new URL('../.wrangler/test/', import.meta.url), { recursive: true });
const pdfBlob = await mod.__renderReport(data, { PDFLib, topicImages: [] });
const bytes = new Uint8Array(await pdfBlob.arrayBuffer());
const out = new URL('../.wrangler/test/report-fonts.pdf', import.meta.url);
writeFileSync(out, bytes);
console.log('PDF written:', out.pathname || out.href, bytes.length, 'bytes');

// ── pdf.js 验证 ──
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
const path = await import('node:path');
// pdf.js 用 fetch 读 cMapUrl；含中文/百分号编码的路径会失败，走 process.cwd 的纯 ASCII 相对路径
const cMapDir = path.relative(process.cwd(), path.join(process.cwd(), 'node_modules/pdfjs-dist/cmaps')).replace(/\\/g, '/') + '/';
const doc = await pdfjs.getDocument({
  data: new Uint8Array(bytes),
  cMapUrl: cMapDir,
  cMapPacked: true,
  useSystemFonts: true,
}).promise;
console.log('pages:', doc.numPages);
let allText = '';
for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const items = (await page.getTextContent()).items;
  const txt = items.map(it => it.str).join('');
  allText += txt;
  console.log(`page ${i}: ${txt.length} chars`);
}
// 关键内容断言
const musts = ['高三上期中', '使用人工智能方面的经验和教训', 'Good morning', '人工智能', 'double-edged', '敲响了警钟', 'outline first', '第', '稿', '25'];
const missing = musts.filter(m => !allText.includes(m.replace(/\s/g, '')) && !allText.includes(m));
if (missing.length) { console.error('MISSING TEXT:', missing); process.exit(1); }
console.log('ALL KEY TEXT PRESENT ✓');

// ── 渲染 PNG（@napi-rs/canvas + pdf.js）供视觉审查 ──
const { createCanvas } = await import('@napi-rs/canvas');
for (let i = 1; i <= doc.numPages; i++) {
  const page = await doc.getPage(i);
  const viewport = page.getViewport({ scale: 1.8 });
  const canvas = createCanvas(viewport.width, viewport.height);
  const ctx = canvas.getContext('2d');
  await page.render({ canvasContext: ctx, viewport, background: '#ffffff' }).promise;
  const png = new URL(`../.wrangler/test/report-fonts-p${i}.png`, import.meta.url);
  writeFileSync(png, canvas.toBuffer('image/png'));
  console.log('PNG:', path.basename(png.pathname || String(png)));
}
console.log('RENDER DONE');
