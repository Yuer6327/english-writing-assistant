#!/usr/bin/env node
// ============================================================
// ai-smoke.mjs — 真实模型批改冒烟测试
// ============================================================
// 把一篇作文原文喂给免费档（Agnes），打印「模型原始 JSON」与「服务端净化后分数」，
// 用于校准评分尺度（提示词改了先用它验落点，不必起 wrangler dev）。
//
// 用法：
//   node scripts/ai-smoke.mjs essay.txt "题目文本"
//   node scripts/ai-smoke.mjs essay.txt "题目文本" --dry   # 只构建提示词，不调 AI
//
// 从 docx 取正文（Git Bash）：
//   unzip -p 作文.docx word/document.xml | sed -e 's/<\/w:p>/\n/g' -e 's/<[^>]*>//g' | sed '/^$/d' > essay.txt
//
// ⚠️ 会消耗免费共享额度（每次约 4k tokens，30-70s；429 max connections 时自动退避重试）。

import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = process.cwd();
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const [essayPath, topicArg] = args.filter(a => a !== '--dry');

if (!essayPath) {
  console.error('用法: node scripts/ai-smoke.mjs <essay.txt> ["题目"] [--dry]');
  process.exit(1);
}

const ESSAY = readFileSync(path.resolve(ROOT, essayPath), 'utf8').trim();
if (!ESSAY) { console.error('作文文件为空'); process.exit(1); }
const TOPIC = topicArg || '（未提供题目）';
const WORDS = ESSAY.split(/\s+/).filter(Boolean).length;

// ── 把 TS 提示词/校验模块打包成可直接 import 的 mjs ──
const tmp = mkdtempSync(path.join(tmpdir(), 'ai-smoke-'));
const build = f => execSync(
  `npx esbuild src/utils/${f}.ts --bundle --format=esm --platform=node --log-level=error --outfile=${path.join(tmp, f + '.mjs')}`,
  { cwd: ROOT, stdio: 'inherit' },
);
build('prompts');
build('validate');
const { DEFAULT_PROMPTS, fillTemplate } = await import(pathToFileURL(path.join(tmp, 'prompts.mjs')).href);
const { sanitizeReview } = await import(pathToFileURL(path.join(tmp, 'validate.mjs')).href);

const prompt = fillTemplate(DEFAULT_PROMPTS['sh-gaokao-essay'], {
  topic: TOPIC, essay: ESSAY, word_count: String(WORDS), previous_feedback: '',
});
console.log(`[info] 词数=${WORDS}  提示词长度=${prompt.length}`);
if (DRY) {
  console.log(prompt);
  rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

const vars = readFileSync(path.join(ROOT, '.dev.vars'), 'utf8');
const KEY = (vars.match(/^AGNES_API_KEY=(.+)$/m)?.[1] ?? '').trim();
if (!KEY) { console.error('.dev.vars 缺少 AGNES_API_KEY'); process.exit(1); }

const ENDPOINTS = ['https://apihub.agnes-ai.cn/v1', 'https://apihub.agnes-ai.com/v1'];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function callAI(userPrompt) {
  let lastErr;
  for (let attempt = 1; attempt <= 10; attempt++) {
    for (let i = 0; i < ENDPOINTS.length; i++) {
      const base = ENDPOINTS[(attempt + i) % ENDPOINTS.length];
      const t0 = Date.now();
      try {
        const resp = await fetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
          body: JSON.stringify({
            model: 'agnes-3.0-flash',
            messages: [{ role: 'user', content: userPrompt }],
            temperature: 0.3,
            max_tokens: 4096,
          }),
          signal: AbortSignal.timeout(120000),
        });
        const text = await resp.text();
        if (!resp.ok) {
          lastErr = new Error(`${base} → HTTP ${resp.status}: ${text.slice(0, 160)}`);
          console.error(`[warn] 第${attempt}轮 ${base} → ${resp.status}`);
          continue;
        }
        const data = JSON.parse(text);
        console.log(`[info] ${base} OK ${((Date.now() - t0) / 1000).toFixed(1)}s usage=${JSON.stringify(data.usage)}`);
        return { content: data.choices?.[0]?.message?.content ?? '', base };
      } catch (e) {
        lastErr = e;
        console.error(`[warn] 第${attempt}轮 ${base} ${e.message}`);
      }
    }
    const wait = 6 + attempt * 3;
    console.log(`[info] 全部端点失败，等 ${wait}s 重试（${attempt}/10）`);
    await sleep(wait * 1000);
  }
  throw lastErr;
}

function extractJSON(text) {
  try { return JSON.parse(text); } catch { /* continue */ }
  const fence = text.match(/```json\s*([\s\S]*?)```/);
  if (fence) { try { return JSON.parse(fence[1].trim()); } catch { /* continue */ } }
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace) { try { return JSON.parse(brace[0]); } catch { /* continue */ } }
  throw new Error('无法解析为 JSON');
}

const { content, base } = await callAI(prompt);
const parsed = extractJSON(content);

console.log('\n=== 模型原始 ===');
console.log('argumentation:', JSON.stringify(parsed.argumentation));
console.log('subscores    :', JSON.stringify(parsed.subscores), '（合计', ['content', 'language', 'organization'].reduce((s, k) => s + (Number(parsed.subscores?.[k]) || 0), 0), '）');
console.log('diagnosis.content:', parsed.diagnosis?.content);
console.log('issues       :', (parsed.issues ?? []).length, '条 →', (parsed.issues ?? []).map(i => i.type).join(','));

const result = sanitizeReview(parsed, ESSAY, false);
console.log('\n=== 服务端净化后 ===');
console.log('subscores:', JSON.stringify(result.subscores), ' 总分:', result.score);
console.log('argumentation:', JSON.stringify(result.argumentation));
console.log('quote 命中:', result.issues.filter(i => i.located !== false).length + '/' + result.issues.length);

writeFileSync(path.join(ROOT, '.ai-smoke-last.json'),
  JSON.stringify({ endpoint: base, topic: TOPIC, words: WORDS, raw: parsed, sanitized: result }, null, 2), 'utf8');
console.log('\n[info] 完整结果写入 .ai-smoke-last.json');
rmSync(tmp, { recursive: true, force: true });
