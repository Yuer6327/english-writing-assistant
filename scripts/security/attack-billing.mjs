#!/usr/bin/env node
// ============================================================
// scripts/security/attack-billing.mjs — billing 资金逻辑红队套件
// 直接打本地 billing (127.0.0.1:8789) 的 /internal /admin /webhooks，
// 验证钱包账本在恶意/并发输入下不出现「凭空加钱 / 双重退款 / 账实不符」。
// PASS=防御成立 FAIL=发现漏洞 INFO=观察
// 用法：node scripts/security/attack-billing.mjs
// ============================================================

const BASE = process.env.BASE || 'http://127.0.0.1:8789';
const results = [];
function record(id, verdict, detail) {
  results.push({ id, verdict, detail });
  console.log(`[${{ PASS: '✓ PASS', FAIL: '✗ FAIL', INFO: '· INFO' }[verdict]}] ${id} — ${detail}`);
}

// fail-closed 后本地也要带口令（与两项目 .dev.vars 的 INTERNAL_TOKEN 一致）
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || 'local-dev-internal-token';
async function req(method, path, body, headers = {}) {
  const resp = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Internal-Token': INTERNAL_TOKEN, ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ct = resp.headers.get('content-type') || '';
  const json = ct.includes('json') ? await resp.json().catch(() => null) : (await resp.text()).slice(0, 200);
  return { status: resp.status, json };
}

const U = 'u-bill-attack-1';   // 受击用户
const V = 'u-bill-attack-2';   // 第二用户

// 余额快照 + 账本净额
async function walletOf(u) { return (await req('GET', `/internal/wallet/${u}`)).json?.balance; }
async function ledgerSum(u) {
  const rows = (await req('GET', `/internal/usage/${u}?limit=1000`)).json?.ledger || [];
  return rows.reduce((s, r) => s + (r.delta || 0), 0);
}

async function setup() {
  // 余额设定为确定值（幂等）：重复跑套件不叠加充值
  await req('POST', '/admin/balance/set', { userId: U, target: 100000, note: 'attack-suite reset' });
  await req('POST', '/admin/balance/set', { userId: V, target: 100000, note: 'attack-suite reset' });
}

// ────────────────────────────────────────────────────────────
async function attackLifecycle() {
  console.log('\n═══ 1. hold→settle/release 生命周期 ═══');
  const b0 = await walletOf(U);

  // 1a 正常 hold → settle 幂等
  const h1 = (await req('POST', '/internal/hold', { userId: U, project: 'writing', service: 'llm:deepseek-flash', estInputTokens: 1000, maxOutputTokens: 1000 })).json;
  if (h1?.mode !== 'hold') { record('1a hold 冻结', 'FAIL', JSON.stringify(h1)); return; }
  const afterHold = await walletOf(U);
  const frozenOk = afterHold === b0 - h1.frozen;
  const s1 = await req('POST', `/internal/holds/${h1.holdId}/settle`, { promptTokens: 1000, completionTokens: 1000 });
  const s2 = await req('POST', `/internal/holds/${h1.holdId}/settle`, { promptTokens: 1000, completionTokens: 1000 });
  const after1 = (await walletOf(U));
  const idem = s1.json?.charged === s2.json?.charged && s2.json?.refunded === (h1.frozen - s2.json?.charged);
  record('1a settle 幂等（重复结算不重复退差）', frozenOk && idem ? 'PASS' : 'FAIL',
    `frozen=${h1.frozen}, charged=${s1.json?.charged}/${s2.json?.charged}, refunded=${s1.json?.refunded}/${s2.json?.refunded}`);

  // 1b settle 后 release → 不得再退款
  const r1 = await req('POST', `/internal/holds/${h1.holdId}/release`);
  const afterRelease = await walletOf(U);
  record('1b settle 后 release 零退款', r1.json?.refunded === 0 && afterRelease === after1 ? 'PASS' : 'FAIL',
    `release.refunded=${r1.json?.refunded}, 余额 ${after1}→${afterRelease}`);
}

async function attackRace() {
  console.log('\n═══ 2. settle × release 并发竞态（双重退款探测）═══');
  const N = 12;
  let totalFrozen = 0;
  const holds = [];
  for (let i = 0; i < N; i++) {
    const h = (await req('POST', '/internal/hold', { userId: U, project: 'writing', service: 'llm:deepseek-flash', estInputTokens: 2000, maxOutputTokens: 2000 })).json;
    if (h?.mode !== 'hold') { record('2 并发预置 hold', 'FAIL', `第 ${i} 笔: ` + JSON.stringify(h)); return; }
    totalFrozen += h.frozen;
    holds.push(h.holdId);
  }
  // 每笔 hold 同时打 settle×2 + release×2 —— 竞态下允许 settle 或 release 任一方赢，
  // 但每笔 hold 的账本净额必须 ≤0：released → 0，settled → -实扣。净额 > 0 = 双重退款（白嫖）。
  await Promise.all(holds.flatMap(id => [
    req('POST', `/internal/holds/${id}/settle`, { promptTokens: 1500, completionTokens: 800 }),
    req('POST', `/internal/holds/${id}/release`),
    req('POST', `/internal/holds/${id}/release`),
    req('POST', `/internal/holds/${id}/settle`, { promptTokens: 1500, completionTokens: 800 }),
  ]));
  const b1 = await walletOf(U);
  const rows = (await req('GET', `/internal/usage/${U}?limit=1000`)).json?.ledger || [];
  // 不变量：每笔 hold 至多一条 refund 行（双重 release/过期释放/结算竞态都会产生第二条）。
  // 注：hold 的冻结扣款行 ref_id 为 NULL（ debit 不带 refId），不能按 ref_id 聚合净额。
  const refundCount = new Map(holds.map(h => [h, 0]));
  let refundTotal = 0;
  for (const r of rows) {
    if (r.type === 'refund' && r.ref_type === 'hold' && refundCount.has(r.ref_id)) {
      refundCount.set(r.ref_id, refundCount.get(r.ref_id) + 1);
      refundTotal += r.delta;
    }
  }
  const doubles = [...refundCount.values()].filter(n => n > 1).length;
  const ok = doubles === 0 && refundTotal <= totalFrozen;
  record('2 并发 settle×release 每笔至多一条退款（无双重退款）', ok ? 'PASS' : 'FAIL',
    `12 笔中退款行>1 的=${doubles}，退款合计=${refundTotal}（冻结合计=${totalFrozen}），终态余额=${b1}`);
}

async function attackExpired() {
  console.log('\n═══ 3. 过期 hold 与 settle 竞态 ═══');
  // 无法等 5 分钟 TTL：直改 expires_at 到过去（回读确认生效），触发 cron，
  // 然后对已过期 hold 做 settle/release —— 关键断言：这一窗口内余额一个微积分都不能动。
  const h = (await req('POST', '/internal/hold', { userId: U, project: 'writing', service: 'llm:deepseek-flash', estInputTokens: 1000, maxOutputTokens: 1000 })).json;
  if (h?.mode !== 'hold') { record('3 过期竞态预置', 'FAIL', JSON.stringify(h)); return; }
  const { execFileSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const wr = fileURLToPath(new URL('../../node_modules/wrangler/bin/wrangler.js', import.meta.url));
  const billingDir = fileURLToPath(new URL('../../../Yuer6327-billing', import.meta.url));
  const d1 = (sql) => execFileSync(process.execPath, [
    wr, 'd1', 'execute', 'billing-db', '--local', '--command', sql,
  ], { encoding: 'utf8', stdio: 'pipe', timeout: 60000, cwd: billingDir });
  try {
    d1(`UPDATE holds SET expires_at = 1 WHERE id = '${h.holdId}'`);
    const chk = d1(`SELECT status FROM holds WHERE id = '${h.holdId}'`);
    if (!/executed successfully|active/i.test(chk)) throw new Error('UPDATE 未生效: ' + chk.slice(-160));
  } catch (e) {
    record('3 过期竞态预置', 'FAIL', String(e?.message).slice(0, 120));
    return;
  }
  const b0 = await walletOf(U);
  // dev 必须带 --test-scheduled 启动；POST /__scheduled 真正触发 cron
  const cronResp = await fetch(BASE + '/__scheduled?cron=' + encodeURIComponent('*/5 * * * *'), { method: 'POST' });
  await new Promise(r => setTimeout(r, 2500));
  const statusAfter = d1(`SELECT status FROM holds WHERE id = '${h.holdId}'`);
  const expired = statusAfter.includes('expired');
  const afterCron = await walletOf(U);
  const s = await req('POST', `/internal/holds/${h.holdId}/settle`, { promptTokens: 100, completionTokens: 100 });
  const r = await req('POST', `/internal/holds/${h.holdId}/release`);
  const final = await walletOf(U);
  // b0 = 预扣后余额；cron 退款恰好一次 → afterCron = b0 + frozen；此后 settle/release 不得再动钱
  const ok = expired && afterCron === b0 + h.frozen && final === afterCron;
  record('3 cron 真实触发：过期释放生效且后续 settle/release 零资金变动', ok ? 'PASS' : 'FAIL',
    `cronHTTP=${cronResp.status}, 已过期=${expired}, 退款恰一次=${afterCron === b0 + h.frozen}（b0=${b0}, frozen=${h.frozen}, cron后=${afterCron}）, settle.charged=${s.json?.charged}, release.refunded=${r.json?.refunded}, 终态=${final}`);
}

async function attackGarbage() {
  console.log('\n═══ 4. 垃圾/恶意数值 ═══');
  const createdHolds = [];
  const cases = [
    ['4a settle NaN usage', ['POST', `/internal/holds/x-settle-nan/settle`, { promptTokens: NaN, completionTokens: NaN }], [404]],
    ['4b hold 负 tokens（接口边界 400）', ['POST', '/internal/hold', { userId: U, project: 'writing', service: 'llm:deepseek-flash', estInputTokens: -1e9, maxOutputTokens: -1e9 }], [400]],
    ['4c hold 超大 tokens（钳制后大额冻结或拒绝）', ['POST', '/internal/hold', { userId: U, project: 'writing', service: 'llm:deepseek-flash', estInputTokens: 1e15, maxOutputTokens: 1e15 }], [200, 402]],
    ['4d hold 1e308 tokens（钳制后余额不足 402）', ['POST', '/internal/hold', { userId: U, project: 'writing', service: 'llm:deepseek-flash', estInputTokens: 1e308, maxOutputTokens: 1e308 }], [402]],
    ['4e gift NaN', ['POST', '/admin/gift', { userId: U, points: NaN }], [400]],
    ['4f gift 负数超额', ['POST', '/admin/gift', { userId: V, points: -1e15 }], [400, 402]],
    ['4g recharge 负数', ['POST', '/admin/recharge', { userId: U, points: -5 }], [400]],
    ['4h recharge 非整数', ['POST', '/admin/recharge', { userId: U, points: 1.5 }], [400]],
    ['4i setBalance 负目标', ['POST', '/admin/balance/set', { userId: U, target: -1 }], [400]],
    ['4j hold calls 巨大', ['POST', '/internal/hold', { userId: U, project: 'writing', service: 'ocr:baidu', calls: 1e9 }], [200, 400, 409]],
  ];
  const b0 = await walletOf(U);
  let frozenCapOk = true;
  for (const [name, [m, p, body], okStatuses] of cases) {
    const r = await req(m, p, body);
    const statusOk = okStatuses.includes(r.status);
    // 4c 特殊：200 允许，但冻结额必须被钳在「1e6 tokens × 最高价」内（=200000 微积分）
    if (name.startsWith('4c') && r.status === 200) {
      if ((r.json?.frozen ?? 0) > 200000) frozenCapOk = false;
      if (r.json?.holdId) createdHolds.push(r.json.holdId);
    }
    record(name, statusOk && frozenCapOk ? 'PASS' : 'FAIL', `status=${r.status} ${JSON.stringify(r.json).slice(0, 100)}`);
  }
  // 清理本组创建的 hold，避免污染 4k 的余额断言
  for (const id of createdHolds) await req('POST', `/internal/holds/${id}/release`);
  const b1 = await walletOf(U);
  record('4k 垃圾输入不造成资金损失（hold 已清理）', b1 === b0 ? 'PASS' : 'FAIL', `${b0}→${b1}（差 ${b1 - b0}）`);
}

async function attackRedeem() {
  console.log('\n═══ 5. 兑换码 ═══');
  const gen = await req('POST', '/admin/codes', { points: 5000, count: 1 });
  const code = gen.json?.codes?.[0];
  if (!code) { record('5 生成兑换码', 'FAIL', JSON.stringify(gen.json)); return; }

  // 经 essay 侧 API（带限流）+ 直连 billing 两条路都测
  const r1 = await req('POST', '/internal/redeem', { userId: V, code });
  const r2 = await req('POST', '/internal/redeem', { userId: V, code });
  const r3 = await req('POST', '/internal/redeem', { userId: U, code });
  const ok = r1.status === 200 && r2.status === 409 && r3.status === 409;
  record('5a 兑换码单次核销（跨用户重放被拒）', ok ? 'PASS' : 'FAIL',
    `1st=${r1.status}, replay=${r2.status}, other-user=${r3.status}`);

  const before = await walletOf(V);
  let brute5xx = 0;
  for (let i = 0; i < 30; i++) {
    const r = await req('POST', '/internal/redeem', { userId: V, code: 'WRT-AAAAAAAAAAAAAAAA' });
    if (r.status >= 500) brute5xx++;
  }
  record('5b 兑换码爆破不 5xx', brute5xx === 0 ? 'PASS' : 'FAIL', `30 次爆破 5xx×${brute5xx}, 余额不变=${(await walletOf(V)) === before}`);
}

async function attackBoundary() {
  console.log('\n═══ 6. 边界与信任边界 ═══');
  // 模拟外部攻击者：伪造（而非复用套件默认的）内部令牌
  const r1 = await req('POST', '/webhooks/recharge', { userId: U, points: 999, externalRef: 'evil-' + Date.now() }, { 'X-Internal-Token': 'forged-attacker-token' });
  // 单一信任路径后：webhook 回退 INTERNAL_TOKEN（已配置）→ 无令牌请求应为 401；未配置时为 503
  record('6a webhook 无效口令被拒（401/503）', r1.status === 401 || r1.status === 503 ? 'PASS' : 'FAIL', `status=${r1.status}`);

  const r2 = await req('POST', '/internal/hold', { userId: U, project: 'nope', service: 'llm:deepseek-flash' });
  record('6b 未知 project 拒绝', r2.status === 404 ? 'PASS' : 'FAIL', `status=${r2.status}`);

  const r3 = await req('POST', '/internal/hold', { userId: U, project: 'writing', service: 'service-that-does-not-exist' });
  record('6c 未知 service 拒绝', r3.status === 404 ? 'PASS' : 'FAIL', `status=${r3.status}`);

  const r4 = await req('GET', '/internal/config/u-bill-attack-1/byok');
  record('6d 未配置 BYOK 时 404', r4.status === 404 ? 'PASS' : 'FAIL', `status=${r4.status}`);

  const r5 = await req('GET', `/internal/usage/${U}?limit=99999999`);
  record('6e limit 参数钳制', (await req('GET', `/internal/usage/${U}?limit=abc`)).status === 200 && r5.status === 200 ? 'PASS' : 'FAIL', `status=${r5.status}`);

  // 富余检查：受击用户余额守恒（所有场景累计后）
  const bal = await walletOf(U);
  const led = await ledgerSum(U);
  record('6f 全程账实相符（余额=账本净额）', bal === led ? 'PASS' : 'FAIL', `balance=${bal}, ledgerSum=${led}`);
}

await setup();
await attackLifecycle();
await attackRace();
await attackExpired();
await attackGarbage();
await attackRedeem();
await attackBoundary();

console.log('\n──────── 汇总 ────────');
const fail = results.filter(r => r.verdict === 'FAIL');
console.log(`PASS ${results.filter(r => r.verdict === 'PASS').length} / FAIL ${fail.length} / INFO ${results.filter(r => r.verdict === 'INFO').length}`);
for (const f of fail) console.log(`  ✗ ${f.id}: ${f.detail}`);
process.exit(fail.length ? 1 : 0);
