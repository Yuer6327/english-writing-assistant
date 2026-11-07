#!/usr/bin/env node
// ============================================================
// scripts/security/redteam-billing-holdidem.mjs — A3 hold 幂等键竞态与跨用户
// PASS=防御成立 FAIL=发现漏洞 INFO=观察
// ============================================================

const BASE = process.env.BASE || 'http://127.0.0.1:8790';
const WRITING_TOKEN = process.env.WRITING_INTERNAL_TOKEN || 'dev-writing-token-smoke';
const AUTH_TOKEN = process.env.AUTH_INTERNAL_TOKEN || 'dev-auth-token-smoke';
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
const U = 'u-rt-idem-a', V = 'u-rt-idem-b';
const setup = async (u, target = 200000) =>
  req('POST', '/admin/balance/set', { userId: u, target, note: 'A3 setup', operator: 'redteam' }, AUTH_TOKEN);

console.log('=== A3.1 同用户同 key 并发 10 连发：只冻结一次 ===');
{
  await setup(U);
  const b0 = (await req('GET', `/internal/wallet/${U}`)).json.balance;
  const KEY = 'rt-concurrent-' + crypto.randomUUID();
  const rs = await Promise.all(Array.from({ length: 10 }, () =>
    req('POST', '/internal/hold', { userId: U, project: 'writing', service: 'llm:deepseek-flash', estInputTokens: 1000, maxOutputTokens: 1000, idempotencyKey: KEY })));
  const holdIds = new Set(rs.map(r => r.json?.holdId).filter(Boolean));
  const frozenVals = new Set(rs.map(r => r.json?.frozen).filter(Boolean));
  const b1 = (await req('GET', `/internal/wallet/${U}`)).json.balance;
  const debited = b0 - b1;
  const allHold = rs.every(r => r.json?.mode === 'hold');
  record('A3.1 并发 10 发同 key 只冻结一次', allHold && holdIds.size === 1 && debited === [...frozenVals][0],
    `holdId 去重=${holdIds.size} 余额变动=${debited} frozen=${[...frozenVals].join('/')} 全部 mode=hold=${allHold} (${rs.map(r => r.status).join(',')})`);
  // 清理：释放该 hold
  if (holdIds.size === 1) await req('POST', `/internal/holds/${[...holdIds][0]}/release`, { userId: U });
}

console.log('\n=== A3.2 跨用户撞 key（B1 修复后：幂等键按 (key, user_id) 作用域）===');
{
  await setup(U); await setup(V);
  const KEY = 'rt-crossuser-' + crypto.randomUUID();
  const hA = await req('POST', '/internal/hold', { userId: U, project: 'writing', service: 'llm:deepseek-flash', estInputTokens: 2000, maxOutputTokens: 2000, idempotencyKey: KEY });
  const bA0 = (await req('GET', `/internal/wallet/${U}`)).json.balance;
  const bV0 = (await req('GET', `/internal/wallet/${V}`)).json.balance;
  // B 用同一个 key hold：必须各自独立成 hold（B 不再拿到 A 的句柄，2026-11-07 B1 修复）
  const hB = await req('POST', '/internal/hold', { userId: V, project: 'writing', service: 'llm:deepseek-flash', estInputTokens: 1000, maxOutputTokens: 1000, idempotencyKey: KEY });
  const independent = hB.json?.mode === 'hold' && hB.json?.holdId !== hA.json?.holdId;
  const vDebited = bV0 - (await req('GET', `/internal/wallet/${V}`)).json.balance;
  record('A3.2a 跨用户同 key（串行）：各自独立 holdId（不再拿到他人 hold）', independent && vDebited === hB.json?.frozen ? 'PASS' : 'FAIL',
    `A.holdId=${hA.json?.holdId?.slice(0, 8)}… B.holdId=${hB.json?.holdId?.slice(0, 8)}… 相同=${!independent} B冻结=${vDebited}`);
  // B 以 A 的 userId settle B 自己的 hold → 归属不匹配必须 404（不泄漏存在性）
  const s = await req('POST', `/internal/holds/${hB.json.holdId}/settle`, { userId: U, promptTokens: 1000, completionTokens: 1000 });
  const bA1 = (await req('GET', `/internal/wallet/${U}`)).json.balance;
  record('A3.2b B 以受害者 userId settle → 404 且 A 分文未动', s.status === 404 && bA1 === bA0 ? 'PASS' : 'FAIL',
    `settle=${s.status} A余额 ${bA0}→${bA1}`);
  // 同 key 第二把（并发，双用户）：两个用户各拿各的 hold（idx_holds_idem_active_user 按 key+user 作用域）
  const KEY2 = 'rt-crossuser2-' + crypto.randomUUID();
  const [c1, c2] = await Promise.all([
    req('POST', '/internal/hold', { userId: U, project: 'writing', service: 'llm:deepseek-flash', idempotencyKey: KEY2 }),
    req('POST', '/internal/hold', { userId: V, project: 'writing', service: 'llm:deepseek-flash', idempotencyKey: KEY2 }),
  ]);
  const bothIndependent = c1.json?.mode === 'hold' && c2.json?.mode === 'hold' && c1.json?.holdId !== c2.json?.holdId;
  record('A3.2c 并发双用户同 key：各自独立成 hold（互不接管）', bothIndependent ? 'PASS' : 'FAIL',
    `c1.hold=${c1.json?.holdId?.slice(0, 8)} c2.hold=${c2.json?.holdId?.slice(0, 8)} 相同=${c1.json?.holdId === c2.json?.holdId}（idx_holds_idem_active_user）`);
  if (c2.json?.holdId) await req('POST', `/internal/holds/${c2.json.holdId}/release`, { userId: V });
  if (c1.json?.holdId) await req('POST', `/internal/holds/${c1.json.holdId}/release`, { userId: U });
  if (hB.json?.holdId) await req('POST', `/internal/holds/${hB.json.holdId}/release`, { userId: V });
}

console.log('\n=== A3.3 终态后同 key 重放 = 新 hold（无双重冻结/无复用句柄）===');
{
  await setup(U);
  const KEY = 'rt-replay-' + crypto.randomUUID();
  const h1 = await req('POST', '/internal/hold', { userId: U, project: 'writing', service: 'llm:deepseek-flash', idempotencyKey: KEY });
  const s1 = await req('POST', `/internal/holds/${h1.json.holdId}/settle`, { userId: U, promptTokens: 10, completionTokens: 10 });
  const bAfterSettle = (await req('GET', `/internal/wallet/${U}`)).json.balance;
  const h2 = await req('POST', '/internal/hold', { userId: U, project: 'writing', service: 'llm:deepseek-flash', idempotencyKey: KEY });
  const bAfter2 = (await req('GET', `/internal/wallet/${U}`)).json.balance;
  const newHold = h2.json?.holdId !== h1.json.holdId;
  const debitedOnce = bAfterSettle - bAfter2 === h2.json?.frozen;
  record('A3.3a settled 后同 key → 新 hold、再冻结一次', newHold && debitedOnce && h2.json?.mode === 'hold',
    `新holdId=${newHold} 二次冻结=${debitedOnce} frozen=${h2.json?.frozen}`);
  const h3 = await req('POST', '/internal/hold', { userId: U, project: 'writing', service: 'llm:deepseek-flash', idempotencyKey: KEY });
  const bAfter3 = (await req('GET', `/internal/wallet/${U}`)).json.balance;
  record('A3.3b active 存在时同 key 重放 → 返回原 hold（不第三次冻结）',
    h3.json?.holdId === h2.json?.holdId && bAfter3 === bAfter2,
    `holdId相同=${h3.json?.holdId === h2.json?.holdId} 余额不变=${bAfter3 === bAfter2}`);
  // released 后同 key → 新 hold
  await req('POST', `/internal/holds/${h2.json.holdId}/release`, { userId: U });
  const h4 = await req('POST', '/internal/hold', { userId: U, project: 'writing', service: 'llm:deepseek-flash', idempotencyKey: KEY });
  record('A3.3c released 后同 key → 新 hold', h4.json?.holdId !== h2.json?.holdId && h4.json?.mode === 'hold',
    `h4.holdId=${h4.json?.holdId?.slice(0, 8)} frozen=${h4.json?.frozen}`);
  await req('POST', `/internal/holds/${h4.json.holdId}/release`, { userId: U });
}

console.log('\n=== A3.4 key 形态边界 ===');
{
  await setup(U);
  const cases = [
    ['129 字符', 'k'.repeat(129), 400],
    ['128 字符', 'k'.repeat(128), 200],
    ['空串', '', 400],
    ['纯空白', '   ', 400],
    ['null', null, 200],      // null = 不带 key（可多次 hold）
    ['数字 123', 123, 400],
    ['SQL 元字符', '\'\';DROP TABLE holds;--', 200],
  ];
  for (const [name, key, expect] of cases) {
    const r = await req('POST', '/internal/hold', { userId: U, project: 'writing', service: 'llm:deepseek-flash', idempotencyKey: key });
    const ok = r.status === expect;
    record(`A3.4 key=${name} → ${expect}`, ok ? 'PASS' : 'FAIL',
      `status=${r.status} mode=${r.json?.mode ?? r.json?.code}（${r.json?.error ?? ''}）`);
    if (r.json?.holdId) await req('POST', `/internal/holds/${r.json.holdId}/release`, { userId: U });
  }
  // unicode key 唯一性
  const kU = '🔑-_unicode-卡';
  const u1 = await req('POST', '/internal/hold', { userId: U, project: 'writing', service: 'llm:deepseek-flash', idempotencyKey: kU });
  const u2 = await req('POST', '/internal/hold', { userId: U, project: 'writing', service: 'llm:deepseek-flash', idempotencyKey: kU });
  record('A3.4b unicode key 幂等生效', u1.json?.holdId === u2.json?.holdId, `holdId相同=${u1.json?.holdId === u2.json?.holdId}`);
  await req('POST', `/internal/holds/${u1.json.holdId}/release`, { userId: U });
  // 兜底：holds 表还活着（DROP 注入无效）
  const alive = await req('POST', '/internal/hold', { userId: U, project: 'writing', service: 'llm:deepseek-flash' });
  record('A3.4c 注入 key 后 holds 表完好（参数化查询）', alive.status === 200 ? 'PASS' : 'FAIL', `status=${alive.status}`);
  await req('POST', `/internal/holds/${alive.json.holdId}/release`, { userId: U });
}

console.log('\n=== A3.5 free 路径同 key（幂等键不覆盖 mode=free —— 记录口径）===');
{
  await setup(U);
  const KEY = 'rt-free-' + crypto.randomUUID();
  const f1 = await req('POST', '/internal/hold', { userId: U, project: 'writing', service: 'llm:agnes-flash', skipQuota: true, idempotencyKey: KEY });
  const f2 = await req('POST', '/internal/hold', { userId: U, project: 'writing', service: 'llm:agnes-flash', skipQuota: true, idempotencyKey: KEY });
  record('A3.5 free 路径同 key 各记一条 usage（文档口径：只对 hold 路径生效）',
    f1.json?.mode === 'free' && f2.json?.mode === 'free' ? 'INFO' : 'FAIL',
    `mode=${f1.json?.mode}/${f2.json?.mode}（无资金面，纯 usage 计数）`);
}

console.log('\n=== A3.6 settle/release 归属必填 + recharge channel 白名单（B2/B3 回归）===');
{
  await setup(U);
  const h = await req('POST', '/internal/hold', { userId: U, project: 'writing', service: 'llm:deepseek-flash', estInputTokens: 1000, maxOutputTokens: 1000 });
  const id = h.json?.holdId;
  // B2：缺 userId → 400（settle 与 release 同口径）
  const sNo = await req('POST', `/internal/holds/${id}/settle`, { promptTokens: 10, completionTokens: 10 });
  const rNo = await req('POST', `/internal/holds/${id}/release`, {});
  record('A3.6a settle/release 缺 userId → 400', sNo.status === 400 && rNo.status === 400 ? 'PASS' : 'FAIL',
    `settle=${sNo.status} release=${rNo.status}`);
  // B2：带错误 userId → 404（不泄漏 hold 存在性），hold 仍 active 可正常操作
  const sWrong = await req('POST', `/internal/holds/${id}/settle`, { promptTokens: 10, completionTokens: 10, userId: 'u-rt-idem-not-owner' });
  const rWrong = await req('POST', `/internal/holds/${id}/release`, { userId: 'u-rt-idem-not-owner' });
  const stillActive = (await req('POST', `/internal/holds/${id}/settle`, { promptTokens: 10, completionTokens: 10, userId: U })).status === 200;
  record('A3.6b settle/release 带错误 userId → 404 且不破坏原 hold', sWrong.status === 404 && rWrong.status === 404 && stillActive ? 'PASS' : 'FAIL',
    `settle=${sWrong.status} release=${rWrong.status} 正确 userId 复核=${stillActive}`);
  // B3：channel 形状白名单——垃圾文本 400，现值全兼容（webhook 渠道走 RECHARGE_TOKEN）
  const RECHARGE_TOKEN = process.env.RECHARGE_TOKEN || 'dev-recharge-token-smoke';
  const chBad = await req('POST', '/admin/recharge', { userId: U, points: 100, operator: 'redteam', channel: "weird';--" }, AUTH_TOKEN);
  const chOk1 = await req('POST', '/admin/recharge', { userId: U, points: 100, operator: 'redteam', channel: 'manual' }, AUTH_TOKEN);
  const chOk2 = await req('POST', '/admin/recharge', { userId: U, points: 100, operator: 'redteam', channel: 'alipay' }, AUTH_TOKEN);
  const chOk3 = await fetch(BASE + '/webhooks/recharge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Recharge-Token': RECHARGE_TOKEN },
    body: JSON.stringify({ userId: U, points: 100, externalRef: 'rt-ch-' + crypto.randomUUID(), channel: 'auto' }),
  });
  record('A3.6c channel 垃圾文本 400（manual/alipay/auto 兼容）',
    chBad.status === 400 && chOk1.status === 200 && chOk2.status === 200 && chOk3.status === 200 ? 'PASS' : 'FAIL',
    `bad=${chBad.status} manual=${chOk1.status} alipay=${chOk2.status} auto=${chOk3.status}`);
}

console.log(`\n汇总 PASS=${results.filter(r => r.verdict === 'PASS').length} FAIL=${results.filter(r => r.verdict === 'FAIL').length} INFO=${results.filter(r => r.verdict === 'INFO').length}`);
process.exit(0);
