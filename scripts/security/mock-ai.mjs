#!/usr/bin/env node
// ============================================================
// scripts/security/mock-ai.mjs — 本地 mock AI 端点（攻防测试专用）
// 监听 127.0.0.1:9101，提供 OpenAI 兼容 /v1/chat/completions。
// 通过同目录 mock-mode.json 切换行为（改动即时生效，无需重启）：
//   { "mode": "ok" }                       正常返回合法批改 JSON（默认）
//   { "mode": "http401" }                  返回 401（测失败路径/不重试）
//   { "mode": "http429" }                  返回 429 + retry-after 2
//   { "mode": "badjson" }                  返回非法 JSON（测严格重试）
//   { "mode": "xss" }                      返回带 HTML/事件属性的字段（测前端转义）
//   { "mode": "greedy" }                   返回超大 usage（测计费钳制）
//   { "mode": "overflow" }                 返回超长字符串与越界分数（测 sanitize）
// ============================================================
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 9101;
const DIR = dirname(fileURLToPath(import.meta.url));
const MODE_FILE = join(DIR, 'mock-mode.json');

function readMode() {
  try {
    if (!existsSync(MODE_FILE)) return { mode: 'ok' };
    return JSON.parse(readFileSync(MODE_FILE, 'utf8'));
  } catch {
    return { mode: 'ok' };
  }
}

const ESSAY_SNIPPET = 'I think students should have part time jobs because it can teach them many thing.';

function reviewPayload(kind) {
  const base = {
    argumentation: { has_examples: true, has_solution: true },
    diagnosis: {
      content: '论点明确但实例略单薄，建议补充具体数据或人物事例。',
      language: '存在若干搭配与单复数问题，如 many thing 应为 many things。',
      organization: '三段结构完整，但缺少过渡词，段落衔接生硬。',
    },
    subscores: { content: 7, language: 6, organization: 3 },
    overall_comment: '整体中等偏上，注意论证的具体性。',
    issues: [
      { quote: ESSAY_SNIPPET.slice(0, 40), type: '语法', explanation: 'many 后应接复数名词。', correction: 'many things' },
      { quote: 'students should have part time jobs', type: '搭配', explanation: 'part-time 需连字符。', correction: 'part-time jobs' },
    ],
    revised_essay: 'I think students should have **part-time** jobs because it can teach them **many things**.',
    suggestions: ['补充一个具体实例', '使用更多衔接词'],
    practice: {
      intro: '针对名词单复数与搭配问题',
      items: [{ chinese: '兼职工作能教会学生很多东西。', answer: 'Part-time jobs can teach students many things.', target: 'many things 复数搭配' }],
    },
  };
  if (kind === 'xss') {
    // 恶意模型输出：模拟提示词注入把 HTML 带进结果字段
    base.overall_comment = '<img src=x onerror="window.__xss=1"><script>window.__xss=1</script>';
    base.diagnosis.content = '<svg onload=window.__xss=1>';
    base.issues[0].quote = ESSAY_SNIPPET.slice(0, 40);
    base.issues[0].explanation = '"><img src=x onerror=window.__xss=1>';
    base.issues[0].correction = '<a href="javascript:window.__xss=1">fix</a>';
    base.revised_essay = 'Normal text <iframe src=javascript:window.__xss=1></iframe>';
    base.practice.items[0].answer = '<b onmouseover=window.__xss=1>answer</b>';
    base.suggestions = ['<img src=x onerror=window.__xss=1>'];
  }
  if (kind === 'overflow') {
    base.subscores = { content: 99, language: -5, organization: 100 };
    base.overall_comment = 'A'.repeat(100000);
    base.revised_essay = 'B'.repeat(100000);
    base.issues = Array.from({ length: 50 }, (_, i) => ({
      quote: 'injected-quote-not-in-essay-' + i, type: '语法', explanation: 'X'.repeat(5000), correction: 'Y'.repeat(5000),
    }));
    base.suggestions = Array.from({ length: 50 }, () => 'Z'.repeat(5000));
  }
  if (kind === 'quote-miss') {
    base.issues = [{ quote: ' totally absent quote here ', type: '拼写', explanation: '未命中原文的引用。', correction: 'fix' }];
  }
  return base;
}

let calls = 0;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    calls++;
    const { mode } = readMode();
    const usage = mode === 'greedy'
      ? { prompt_tokens: 900000, completion_tokens: 900000 }
      : { prompt_tokens: 4200, completion_tokens: 1800 };

    const send = (status, obj) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(obj));
    };

    if (mode === 'http401') return send(401, { error: { message: 'Invalid API key provided' } });
    if (mode === 'http429') {
      res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '2' });
      return res.end(JSON.stringify({ error: { message: 'rate limited' } }));
    }

    let payload;
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      return send(400, { error: { message: 'bad request body' } });
    }

    if (mode === 'badjson') {
      return send(200, { choices: [{ message: { content: 'this is not json at all {{' } }], usage });
    }
    const kind = mode === 'ok' ? 'ok' : mode;
    const content = JSON.stringify(reviewPayload(kind));
    send(200, { choices: [{ message: { content } }], usage });
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`[mock-ai] listening http://127.0.0.1:${PORT}/v1 (mode file: ${MODE_FILE})`));
