#!/usr/bin/env node
// ============================================================
// scripts/security/redteam-billing-recharge.mjs — A4 单笔充值上限绕过
// 三个入口：/admin/recharge、/admin/orders/manual、/webhooks/recharge
// 上限 = RECHARGE_MAX_CREDIT（默认 1000 元 = 10_000_000 微积分），extRef 去重后判定
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
async function req(method, path, body, token = AUTH_TOKEN, hdr = 'X-Internal-Token') {
  const resp = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', [hdr]: token },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: resp.status, json: await resp.json().catch(() => null) };
}
const U = 'u-rt-cap';
const CAP = 10_000_000; // 1000 credit 微积分

await req('POST', '/admin/balance/set', { userId: U, target: 0, note: 'A4 reset', operator: 'redteam' });

console.log('=== A4.1 admin/recharge 边界值 ===');
const cases = [
  ['恰好 1000 credit（10_000_000 micro）', CAP, 200],
  ['1000.0001 credit（10_000_001 micro）', CAP + 1, 400],
  ['1000.01 credit（10_000_100 micro）', 10_000_100, 400],
  ['999.9999 credit（9_999_999 micro）', 9_999_999, 200],
  ['1e9 credit 科学计数（1e13 micro）', 1e13, 400],
  ['负数', -CAP, 400],
  ['0', 0, 400],
  ['NaN', NaN, 400],
  ['Infinity', Infinity, 400],
  ['字符串 "10_000_001"', String(CAP + 1), 400],
  ['浮点 1000.00005 credit', 10_000_000.5, 400],
  ['超大 1e15（safe integer 上界附近）', 1e15, 400],
  ['1e34（Number.isInteger=true 陷阱）', 1e34, 400],
];
for (const [name, points, expect] of cases) {
  const r = await req('POST', '/admin/recharge', { userId: U, points, operator: 'redteam', note: 'A4 ' + name });
  record(`A4.1 ${name} → ${expect}`, r.status === expect ? true : false,
    `status=${r.status} code=${r.json?.code ?? '-'} balance=${r.json?.balance ?? '-'}`);
}

console.log('\n=== A4.2 三入口一致性（超限一律 400 recharge_exceeds_cap）===');
{
  const r1 = await req('POST', '/admin/recharge', { userId: U, points: 2 * CAP, operator: 'redteam' });
  const r2 = await req('POST', '/admin/orders/manual', { userId: U, points: 2 * CAP, operator: 'redteam' });
  const r3 = await req('POST', '/webhooks/recharge', { userId: U, points: 2 * CAP, externalRef: 'rt-cap-webhook-1' }, RECHARGE_TOKEN);
  record('A4.2 admin/manual/webhook 超限全 400', [r1, r2, r3].every(r => r.status === 400 && r.json?.code === 'recharge_exceeds_cap'),
    `${r1.status}/${r2.status}/${r3.status} codes=${r1.json?.code}/${r2.json?.code}/${r3.json?.code}`);
}

console.log('\n=== A4.3 extRef 幂等 vs 上限（去重在前：历史单重放不受新上限误伤）===');
{
  const ref = 'rt-cap-ref-' + crypto.randomUUID().slice(0, 8);
  const r1 = await req('POST', '/admin/recharge', { userId: U, points: 500_000, operator: 'redteam', externalRef: ref });
  const b1 = (await req('GET', `/internal/wallet/${U}`)).json.balance;
  // 同 ref 超限金额重放：应命中 extRef 去重（duplicated:true，不扣不加），而非上限 400
  const r2 = await req('POST', '/admin/recharge', { userId: U, points: 2 * CAP, operator: 'redteam', externalRef: ref });
  const b2 = (await req('GET', `/internal/wallet/${U}`)).json.balance;
  record('A4.3a 历史单同 ref 重放（金额超限）→ duplicated 且零资金变动',
    r2.status === 200 && r2.json?.duplicated === true && b1 === b2,
    `r2=${r2.status} dup=${r2.json?.duplicated} 余额 ${b1}→${b2}`);
  // 新 ref + 超限 → 400；随后同 ref 任意重放仍 400（无脏数据）
  const ref2 = 'rt-cap-ref2-' + crypto.randomUUID().slice(0, 8);
  const r3 = await req('POST', '/admin/recharge', { userId: U, points: 2 * CAP, operator: 'redteam', externalRef: ref2 });
  const r4 = await req('POST', '/admin/recharge', { userId: U, points: 2 * CAP, operator: 'redteam', externalRef: ref2 });
  record('A4.3b 被上限拒绝的 extRef 不落库（可复用、无半单）', r3.status === 400 && r4.status === 400,
    `r3=${r3.status} r4=${r4.status}`);
  // webhook 入口同 ref 超限
  const r5 = await req('POST', '/webhooks/recharge', { userId: U, points: 2 * CAP, externalRef: ref2 }, RECHARGE_TOKEN);
  record('A4.3c webhook 同 ref（admin 拒过的）超限仍 400', r5.status === 400, `r5=${r5.status} ${r5.json?.code}`);
}

console.log('\n=== A4.4 cnyCents 一致性旁路探测（points≤cap 但 cnyCents 伪造）===');
{
  const b0 = (await req('GET', `/internal/wallet/${U}`)).json.balance;
  const r = await req('POST', '/admin/recharge', { userId: U, points: 100_000, cnyCents: 1, operator: 'redteam' });
  const b1 = (await req('GET', `/internal/wallet/${U}`)).json.balance;
  record('A4.4 cnyCents 与 points 矛盾（100 credit vs 0.01 元）→ 400', r.status === 400 && b0 === b1,
    `status=${r.status} code=${r.json?.code} 余额不变=${b0 === b1}`);
}

console.log('\n=== A4.5 无 operator / 空 operator 铸币（溯源绕过）===');
{
  const r1 = await req('POST', '/admin/recharge', { userId: U, points: 1000, operator: '   ' });
  const r2 = await req('POST', '/admin/recharge', { userId: U, points: 1000 });
  record('A4.5 operator 空白/缺失 → 400', r1.status === 400 && r2.status === 400, `${r1.status}/${r2.status} ${r1.json?.code}/${r2.json?.code}`);
}

console.log(`\n汇总 PASS=${results.filter(r => r.verdict === 'PASS').length} FAIL=${results.filter(r => r.verdict === 'FAIL').length}`);
process.exit(0);
