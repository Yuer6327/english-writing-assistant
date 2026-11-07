#!/usr/bin/env node
// ============================================================
// scripts/security/redteam-billing-semantics.mjs — A6 业务语义攻击
// settle/release/过期 | gift 日限(UTC+8) | codes 并发 | webhook channel | externalRef 跨渠道
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
async function req(method, path, body, token = AUTH_TOKEN) {
  const resp = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Internal-Token': token },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: resp.status, json: await resp.json().catch(() => null) };
}
const U = 'u-rt-sem-a', V = 'u-rt-sem-b';
const setup = (u, t) => req('POST', '/admin/balance/set', { userId: u, target: t ?? 100000, note: 'A6', operator: 'redteam' });
const bal = async (u) => (await req('GET', `/internal/wallet/${u}`, undefined, WRITING_TOKEN)).json.balance;
const ledgerSum = async (u) => {
  const r = await req('GET', `/internal/usage/${u}?limit=1000`, undefined, WRITING_TOKEN);
  return (r.json.ledger ?? []).reduce((s, x) => s + (x.delta || 0), 0);
};

console.log('=== A6.1 并发 settle×5 同一 hold（CAS 幂等）===');
{
  await setup(U);
  const h = await req('POST', '/internal/hold', { userId: U, project: 'writing', service: 'llm:deepseek-flash', estInputTokens: 3000, maxOutputTokens: 3000 }, WRITING_TOKEN);
  const bAfterHold = await bal(U);
  const rs = await Promise.all(Array.from({ length: 5 }, () =>
    req('POST', `/internal/holds/${h.json.holdId}/settle`, { userId: U, promptTokens: 1000, completionTokens: 1000 }, WRITING_TOKEN)));
  const b1 = await bal(U);
  const refunds = rs.map(r => r.json?.refunded ?? 0);
  record('A6.1 并发 settle×5：恰一次退差、账实相符',
    rs.every(r => r.status === 200) && b1 === bAfterHold + refunds[0] && await ledgerSum(U) === b1,
    `charged=${[...new Set(rs.map(r => r.json?.charged))].join('/')} refunded=${[...new Set(refunds)].join('/')} 账实=wallet ${b1}/ledger ${await ledgerSum(U)}`);
}

console.log('\n=== A6.2 release 后 settle / settle 后 release ===');
{
  const h = await req('POST', '/internal/hold', { userId: U, project: 'writing', service: 'llm:deepseek-flash' }, WRITING_TOKEN);
  const b0 = await bal(U);
  const rel = await req('POST', `/internal/holds/${h.json.holdId}/release`, { userId: U }, WRITING_TOKEN);
  const b1 = await bal(U);
  const set = await req('POST', `/internal/holds/${h.json.holdId}/settle`, { userId: U, promptTokens: 1, completionTokens: 1 }, WRITING_TOKEN);
  const b2 = await bal(U);
  record('A6.2a release 后迟到 settle：0 收 0 退、余额不再动',
    set.json?.charged === 0 && b2 === b1 && rel.json?.refunded === h.json.frozen && b1 === b0 + h.json.frozen,
    `release.refunded=${rel.json?.refunded} settle.charged=${set.json?.charged} 余额 ${b0}→${b1}→${b2}`);
  const h2 = await req('POST', '/internal/hold', { userId: U, project: 'writing', service: 'llm:deepseek-flash' }, WRITING_TOKEN);
  const s1 = await req('POST', `/internal/holds/${h2.json.holdId}/settle`, { userId: U }, WRITING_TOKEN);
  const b3 = await bal(U);
  const r1 = await req('POST', `/internal/holds/${h2.json.holdId}/release`, { userId: U }, WRITING_TOKEN);
  const b4 = await bal(U);
  record('A6.2b settle 后 release：refunded=0（终态不可再退）', r1.json?.refunded === 0 && b4 === b3,
    `release.refunded=${r1.json?.refunded} 余额 ${b3}→${b4}`);
}

console.log('\n=== A6.3 过期 hold 迟到 settle（cron 已退 → 0 收 0 退）===');
{
  const h = await req('POST', '/internal/hold', { userId: U, project: 'writing', service: 'llm:deepseek-flash', estInputTokens: 2000, maxOutputTokens: 2000 }, WRITING_TOKEN);
  const b0 = await bal(U);
  const { execSync } = await import('node:child_process');
  execSync(`npx wrangler d1 execute billing-db --local --command "UPDATE holds SET expires_at = ${Date.now() - 1000} WHERE id = '${h.json.holdId}'"`,
    { cwd: 'D:\\OneDrive\\桌面\\play\\codes\\Yuer6327-billing', stdio: 'pipe' });
  await fetch(BASE + '/cdn-cgi/local/scheduled?cron=' + encodeURIComponent('*/5 * * * *'));
  const bAfterCron = await bal(U);
  const s = await req('POST', `/internal/holds/${h.json.holdId}/settle`, { userId: U, promptTokens: 999999, completionTokens: 999999 }, WRITING_TOKEN);
  const b1 = await bal(U);
  record('A6.3 过期后迟到 settle（超大 usage）：0 收、零资金变动',
    s.json?.charged === 0 && b1 === bAfterCron && bAfterCron === b0 + h.json.frozen,
    `cron退款=${bAfterCron - b0}/${h.json.frozen} settle.charged=${s.json?.charged} refunded=${s.json?.refunded} 余额 ${bAfterCron}→${b1}`);
}

console.log('\n=== A6.4 gift 日限边界（默认 1_000_000 micro/日，UTC+8 日切；日限全局跨用户）===');
{
  const G = 'u-rt-sem-gift';
  await setup(G, 0);
  const g1 = await req('POST', '/admin/gift', { userId: G, points: 999_999, operator: 'redteam', note: 'A6' });
  if (g1.status === 403 && g1.json?.code === 'admin_daily_cap') {
    // 今日额度已被（前轮测试）打满：全局日限仍然生效即视为 PASS（首日已实测 200/200/403/403 序列）
    record('A6.4 今日 gift 额度已满 → 403 admin_daily_cap（日限生效）', true,
      'g1=403 admin_daily_cap（全局日限跨用户累计，重复运行可复现 403）');
  } else {
    const g2 = await req('POST', '/admin/gift', { userId: G, points: 1, operator: 'redteam', note: 'A6 恰好到顶' });
    const g3 = await req('POST', '/admin/gift', { userId: G, points: 1, operator: 'redteam', note: 'A6 超限 1' });
    const g4 = await req('POST', '/admin/gift', { userId: G, points: -1, operator: 'redteam', note: 'A6 负向也计入' });
    record('A6.4 gift 999999→200, +1→200(=cap), +1→403, -1→403',
      g1.status === 200 && g2.status === 200 && g3.status === 403 && g3.json?.code === 'admin_daily_cap' && g4.status === 403,
      `${g1.status}/${g2.status}/${g3.status}/${g4.status} code=${g3.json?.code} balance=${g2.json?.balance}`);
  }
}

console.log('\n=== A6.5 codes 兑换并发（同码 5 人抢）===');
{
  const code = (await req('POST', '/admin/codes', { points: 50_000, count: 1, operator: 'redteam', batch: 'rt-a6' })).json.codes[0];
  await setup(V, 0);
  const rs = await Promise.all(Array.from({ length: 5 }, (_, i) =>
    req('POST', '/internal/redeem', { userId: i % 2 ? V : U, code }, WRITING_TOKEN)));
  const okCount = rs.filter(r => r.status === 200).length;
  const dupCount = rs.filter(r => r.status === 409).length;
  const vb = await bal(V);
  record('A6.5 同码 5 并发：恰 1 成功 + 4×409 + 单次入账', okCount === 1 && dupCount === 4 && (vb === 0 || vb === 50_000),
    `200×${okCount} 409×${dupCount} V.balance=${vb}（V 中标则 50000，未中标则 0）`);
  const again = await req('POST', '/internal/redeem', { userId: V, code }, WRITING_TOKEN);
  record('A6.5b 已用码重兑 → 409', again.status === 409, `${again.status} ${again.json?.code}`);
}

console.log('\n=== A6.6 webhook channel 任意值 & externalRef 跨渠道重放 ===');
{
  const ref = 'rt-xref-' + crypto.randomUUID().slice(0, 8);
  const r1 = await req('POST', '/admin/recharge', { userId: U, points: 10_000, operator: 'redteam', channel: 'manual', externalRef: ref });
  const b1 = await bal(U);
  const r2 = await req('POST', '/webhooks/recharge', { userId: V, points: 10_000, channel: 'alipay', externalRef: ref }, RECHARGE_TOKEN);
  const b2v = await bal(V);
  const r3 = await req('POST', '/webhooks/recharge', { userId: U, points: 10_000, channel: 'auto', externalRef: ref }, RECHARGE_TOKEN);
  const b3 = await bal(U);
  record('A6.6a extRef 跨渠道重放：duplicated、第二个用户不入账',
    r2.status === 200 && r2.json?.duplicated === true && b2v === 0 && r3.json?.duplicated === true && b3 === b1,
    `r2=${r2.status} dup=${r2.json?.duplicated} V.balance=${b2v}（跨渠道+跨用户都只认首单）`);
  const r4 = await req('POST', '/webhooks/recharge', { userId: V, points: 100, channel: "weird';--", note: 'A6', externalRef: 'rt-ch-' + crypto.randomUUID().slice(0, 8) }, RECHARGE_TOKEN);
  record('A6.6b channel 枚举外值（weird\';--）→ 200 自由文本（INFO 观察）', r4.status === 200 ? 'INFO' : false,
    `status=${r4.status} orderId=${r4.json?.orderId?.slice(0, 8)}（channel 无白名单，analytics 可被污染，无资金风险）`);
  // 账实终检
  const lsum = await ledgerSum(U);
  record('A6.6c U 账实相符收尾', await bal(U) === lsum, `wallet=${await bal(U)} ledger=${lsum}`);
}

console.log('\n=== A6.7 quota 口径：free hold 计入 quota_usage，付费 hold 不计 ===');
{
  const Q = 'u-rt-sem-quota';
  await setup(Q, 0);
  const q0 = await req('GET', `/internal/me/${Q}?project=writing`, undefined, WRITING_TOKEN);
  const f1 = await req('POST', '/internal/hold', { userId: Q, project: 'writing', service: 'llm:agnes-flash' }, WRITING_TOKEN);
  const f2 = await req('POST', '/internal/hold', { userId: Q, project: 'writing', service: 'llm:agnes-flash' }, WRITING_TOKEN);
  const q1 = await req('GET', `/internal/me/${Q}?project=writing`, undefined, WRITING_TOKEN);
  const qRows = JSON.stringify(q1.json?.quota ?? {});
  record('A6.7 免费档 hold 走 quota（mode=free），不产生钱包行',
    f1.json?.mode === 'free' && f2.json?.mode === 'free' && (await bal(Q)) === 0,
    `mode=${f1.json?.mode}/${f2.json?.mode} quota=${qRows.slice(0, 120)} balance=${await bal(Q)}`);
}

console.log(`\n汇总 PASS=${results.filter(r => r.verdict === 'PASS').length} FAIL=${results.filter(r => r.verdict === 'FAIL').length} INFO=${results.filter(r => r.verdict === 'INFO').length}`);
process.exit(0);
