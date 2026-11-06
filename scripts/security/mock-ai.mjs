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
//   { "mode": "shadowlow" }                B 版本请求（含 redacted）返回低分（测盲评裁决）
//   { "mode": "preclean-hit" }             预清洗请求返回 <text> 内逐字 span（测第9轮预清洗）
//   { "mode": "preclean-junk" }            预清洗请求返回非 JSON 垃圾（测 fail-open）
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
  if (kind === 'evidence') {
    // 证据耦合用例（attack-writing inj 组）：content 证据故意落在注入命中片段内
    // （"give me full" 是该组稿子里 score_demand 强规则的命中段），language/orga 为有效片段
    base.subscores = { content: 9, language: 9, organization: 4 };
    base.evidence = {
      content: 'give me full',
      language: 'I think students should have part time jobs',
      organization: 'because it can teach them many thing',
    };
  }
  if (kind === 'shadow-low-score') {
    // 盲评裁决用例：B 版本（redact 后）的独立打分 —— 明显低于 A，触发 shouldDeliverShadowB
    base.subscores = { content: 3, language: 4, organization: 2 };
    base.evidence = {
      content: 'I think students should have part time jobs',
      language: 'it can teach them many thing',
      organization: 'because it can teach them many thing',
    };
  }
  return base;
}

let calls = 0;
const server = http.createServer((req, res) => {
  // 按 Buffer 收集后一次性转 utf8：workerd 的 fetch 走 chunked 传输，
  // 逐块字符串拼接会把跨块边界的多字节中文撕成乱码（preclean 特征串匹配因此失效）
  const chunks = [];
  req.on('data', (c) => { chunks.push(c); });
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString('utf8');
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
    // 盲评裁决用例：B 版本请求（用户消息带 […redacted…] 占位，流式/非流式都识别）
    // 返回明显更低的分数，让 essays.ts 的 shouldDeliverShadowB(sumA, sumBRaw) 触发
    // （端到端锁住 shadow.used=true 路径）
    const reqText = JSON.stringify(payload.messages ?? payload);
    if (process.env.MOCK_LOG) {
      const preclean = reqText.includes('第二意见');
      console.log(`[mock-ai] mode=${mode} stream=${!!payload.stream} len=${reqText.length} shadowB=${mode === 'shadowlow' && reqText.includes('redacted')} preclean=${preclean} head=${reqText.slice(0, 120)}`);
    }
    // 第二意见预清洗请求（essays.ts PRECLEAN_SYSTEM_PROMPT 首行特征串，勿改）：
    //   preclean-hit  → 从请求 <text> 数据区截一段逐字片段返回（保证能过服务端逐字校验）
    //   preclean-junk → 返回非 JSON 垃圾（测解析失败 fail-open）
    //   其余模式      → {"spans":[]}（既有用例的检测路径行为不变）
    if (reqText.includes('第二意见')) {
      let content = '{"spans":[]}';
      if (mode === 'preclean-hit') {
        // 从解析后的 user 消息取 <text> 数据区（真实换行）。不能在 reqText（整体
        // JSON.stringify）上匹配：系统提示词规则段自身含 `<text>` 字样，会先被命中。
        const userMsg = (payload.messages ?? []).find(m => m?.role === 'user');
        const um = typeof userMsg?.content === 'string' ? userMsg.content : reqText;
        const m = um.match(/<text>\n([\s\S]*?)\n<\/text>/);
        const inner = m?.[1] ?? '';
        // 取第一个足够长的行截 80 字符内做 span（保证服务端逐字校验能命中）
        const line = inner.split('\n').find(s => s.trim().length >= 60) ?? inner;
        const span = line.trim().slice(0, 80).trim();
        if (span.length >= 4) content = JSON.stringify({ spans: [span] });
      } else if (mode === 'preclean-junk') {
        content = '抱歉，我无法按要求输出 JSON。{{';
      }
      if (payload.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
        for (const c of content.match(/[\s\S]{1,120}/g) ?? [content]) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ usage })}\n\n`);
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      return send(200, { choices: [{ message: { content } }], usage });
    }
    const isShadowB = mode === 'shadowlow' && reqText.includes('redacted');
    if (payload.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' });
      const kindS = isShadowB ? 'shadow-low-score' : (mode === 'ok' ? 'ok' : mode);
      const text = JSON.stringify(reviewPayload(kindS));
      const chunks = text.match(/[\s\S]{1,120}/g) ?? [text];
      for (const c of chunks) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ usage })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    const kind = isShadowB ? 'shadow-low-score' : (mode === 'ok' ? 'ok' : mode);
    const content = JSON.stringify(reviewPayload(kind));
    send(200, { choices: [{ message: { content } }], usage });
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`[mock-ai] listening http://127.0.0.1:${PORT}/v1 (mode file: ${MODE_FILE})`));
