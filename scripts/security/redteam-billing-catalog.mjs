#!/usr/bin/env node
// ============================================================
// scripts/security/redteam-billing-catalog.mjs — A7 catalog 防线（需带 vars 启动）：
//   wrangler dev --var DISABLED_SERVICES:llm:longcat --var DEEPSEEK_PRICE_OUTPUT:banana
//     --var DEEPSEEK_PRICE_INPUT_MISS:-5 --var DEEPSEEK_PRICE_INPUT_HIT:0 --var RECHARGE_MAX_CREDIT:5
// PASS=防御成立 FAIL=发现漏洞 INFO=观察
// ============================================================

const BASE = process.env.BASE || 'http://127.0.0.1:8790';
const WRITING_TOKEN = process.env.WRITING_INTERNAL_TOKEN || 'dev-writing-token-smoke';
const AUTH_TOKEN = process.env.AUTH_INTERNAL_TOKEN || 'dev-auth-token-smoke';
const RECHARGE_TOKEN = process.env.RECHARGE_TOKEN || 'dev-recharge-token-smoke';
const results = [];
function record(id, verdict, detail) {
  const v = verdict === true ? 'PASS' : verdict === false ? 'FAIL' : verdict;
  results.push({ id, verdict: v });
  console.log(`[${ { PASS: 'PASS', FAIL: 'FAIL', INFO: 'INFO' }[v] }] ${id} — ${detail}`);
}
async function req(method, path, body, token = WRITING_TOKEN) {
  const resp = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Internal-Token': token },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: resp.status, json: await resp.json().catch(() => null) };
}
const U = 'u-rt-cat';
await req('POST', '/admin/balance/set', { userId: U, target: 200000, note: 'A7', operator: 'redteam' }, AUTH_TOKEN);

console.log('=== A7.1 DISABLED_SERVICES=llm:longcat 四处 fail-closed ===');
{
  const cat = await req('GET', '/internal/catalog');
  const longcat = cat.json?.services?.find(s => s.id === 'llm:longcat');
  const catStr = JSON.stringify(cat.json);
  record('A7.1a catalog：longcat.enabled=false 且无 secretName/baseUrl 字段',
    longcat?.enabled === false && !catStr.includes('secretName') && !catStr.includes('baseUrl') && !catStr.includes('longcat.chat'),
    `enabled=${longcat?.enabled} 泄漏字段=${['secretName', 'baseUrl', 'api.longcat', 'upstreamModel'].filter(k => catStr.includes(k)).join('|') || '无'}`);
  const ov = await req('GET', `/internal/overview/${U}`);
  const ovLongcat = ov.json?.models?.find(s => s.id === 'llm:longcat');
  record('A7.1b overview：longcat.enabled=false（models 数组同步）', ovLongcat?.enabled === false, `enabled=${ovLongcat?.enabled}`);
  const cfg = await req('GET', `/internal/config/${U}/llm:longcat`);
  record('A7.1c config：longcat → 409 model_disabled（不给 key）', cfg.status === 409 && cfg.json?.code === 'model_disabled',
    `${cfg.status} ${cfg.json?.code}`);
  const hold = await req('POST', '/internal/hold', { userId: U, project: 'writing', service: 'llm:longcat' });
  record('A7.1d hold：longcat → 409 model_disabled', hold.status === 409 && hold.json?.code === 'model_disabled',
    `${hold.status} ${hold.json?.code}`);
  const ocr = cat.json?.services?.find(s => s.id === 'ocr:baidu');
  record('A7.1e 隐藏服务 ocr:baidu 不下发', ocr === undefined, `存在=${ocr !== undefined}`);
}

console.log('\n=== A7.2 priceOverrides 非法值（banana/-5/0）→ 回落目录默认 ===');
{
  const cat = await req('GET', '/internal/catalog');
  const ds = cat.json?.services?.find(s => s.id === 'llm:deepseek-flash');
  record('A7.2a catalog 价格回落默认（hit=2/miss=20/out=30）',
    ds?.price?.inputHitPer1k === 2 && ds?.price?.inputMissPer1k === 20 && ds?.price?.outputPer1k === 30,
    `price=${JSON.stringify(ds?.price)}`);
  const h = await req('POST', '/internal/hold', { userId: U, project: 'writing', service: 'llm:deepseek-flash', estInputTokens: 1000, maxOutputTokens: 1000 });
  record('A7.2b hold 冻结额按默认价（1k/1k→50）不受毒价影响', h.json?.frozen === 50, `frozen=${h.json?.frozen}`);
  if (h.json?.holdId) await req('POST', `/internal/holds/${h.json.holdId}/release`, { userId: U });
}

console.log('\n=== A7.3 RECHARGE_MAX_CREDIT=5 元覆盖 ===');
{
  const r1 = await req('POST', '/admin/recharge', { userId: U, points: 50_000, operator: 'redteam' }, AUTH_TOKEN);      // 恰 5 credit
  const r2 = await req('POST', '/admin/recharge', { userId: U, points: 50_001, operator: 'redteam' }, AUTH_TOKEN);      // 5.0001
  const r3 = await req('POST', '/webhooks/recharge', { userId: U, points: 60_000, externalRef: 'rt-cat-cap-' + crypto.randomUUID().slice(0, 8) }, RECHARGE_TOKEN);
  record('A7.3 cap=5：50_000→200 / 50_001→400 / webhook 60_000→400',
    r1.status === 200 && r2.status === 400 && r2.json?.code === 'recharge_exceeds_cap' && r3.status === 400,
    `${r1.status}/${r2.status}/${r3.status} codes=${r2.json?.code}/${r3.json?.code}`);
}

console.log('\n=== A7.4 catalog/overview 脱敏总检（默认服务也无所敏感字段）===');
{
  const cat = await req('GET', '/internal/catalog');
  const s = JSON.stringify(cat.json);
  record('A7.4 catalog 无 key/baseUrl/upstreamModel/secretName',
    !['baseUrl', 'upstreamModel', 'secretName', 'sk-', 'AGNES', 'DEEPSEEK'].filter(k => s.includes(k)).length,
    `泄漏=${['baseUrl', 'upstreamModel', 'secretName', 'sk-', 'AGNES', 'DEEPSEEK'].filter(k => s.includes(k)).join('|') || '无'}`);
  const ov = await req('GET', `/internal/overview/${U}`);
  const ovs = JSON.stringify(ov.json);
  record('A7.4b overview 同样脱敏', !['baseUrl', 'upstreamModel', 'secretName', 'sk-'].filter(k => ovs.includes(k)).length,
    `泄漏=${['baseUrl', 'upstreamModel', 'secretName', 'sk-'].filter(k => ovs.includes(k)).join('|') || '无'}`);
}

console.log(`\n汇总 PASS=${results.filter(r => r.verdict === 'PASS').length} FAIL=${results.filter(r => r.verdict === 'FAIL').length}`);
process.exit(results.some(r => r.verdict === 'FAIL') ? 1 : 0);
