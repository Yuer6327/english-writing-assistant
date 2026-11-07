#!/usr/bin/env node
// ============================================================
// scripts/security/redteam-billing-authz.mjs — A1 横向越权全扫 + 令牌变体 + timing
// 只打本地 billing（BASE，默认 127.0.0.1:8790）。PASS=防御成立 FAIL=发现漏洞 INFO=观察
// 用法：BASE=http://127.0.0.1:8790 node scripts/security/redteam-billing-authz.mjs
// ============================================================

const BASE = process.env.BASE || 'http://127.0.0.1:8790';
const WRITING_TOKEN = process.env.WRITING_INTERNAL_TOKEN || 'dev-writing-token-smoke';
const AUTH_TOKEN = process.env.AUTH_INTERNAL_TOKEN || 'dev-auth-token-smoke';
const OLD_SHARED_TOKEN = process.env.OLD_INTERNAL_TOKEN || 'local-dev-internal-token';
const results = [];
function record(id, verdict, detail) {
  results.push({ id, verdict });
  console.log(`[${ { PASS: 'PASS', FAIL: 'FAIL', INFO: 'INFO' }[verdict] }] ${id} — ${detail}`);
}

async function raw(method, path, { headers = {}, body } = {}) {
  const resp = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ct = resp.headers.get('content-type') || '';
  const json = ct.includes('json') ? await resp.json().catch(() => null) : (await resp.text()).slice(0, 120);
  return { status: resp.status, json };
}
const tok = (t) => ({ 'X-Internal-Token': t });

// ── 路由全清单（从 src/index.ts 枚举）──
const ADMIN_ROUTES = [
  ['POST', '/admin/gift'], ['POST', '/admin/recharge'], ['POST', '/admin/balance/set'],
  ['GET', '/admin/wallets?ids=u1'], ['GET', '/admin/user-stats?ids=u1'], ['GET', '/admin/quota-groups'],
  ['GET', '/admin/overview'], ['GET', '/admin/usage'], ['GET', '/admin/ledger'],
  ['POST', '/admin/codes'], ['POST', '/admin/orders/manual'], ['GET', '/admin/orders'],
  ['GET', '/admin/user/u-redteam-x'], ['POST', '/admin/tags'],
];
const INTERNAL_ROUTES = [
  ['POST', '/internal/hold'], ['POST', '/internal/holds/00000000-0000-4000-8000-000000000000/settle'],
  ['POST', '/internal/holds/00000000-0000-4000-8000-000000000000/release'],
  ['GET', '/internal/wallet/u-redteam-x'], ['GET', '/internal/catalog'],
  ['GET', '/internal/config/u-redteam-x/byok'], ['GET', '/internal/byok/u-redteam-x'],
  ['POST', '/internal/byok/set'], ['GET', '/internal/overview/u-redteam-x'],
  ['GET', '/internal/usage/u-redteam-x'], ['GET', '/internal/me/u-redteam-x'], ['POST', '/internal/redeem'],
];
// 各路由的最小合法 body（只用于区分 401 与 4xx；401 必须发生在 body 校验前）
const ADMIN_BODY = {
  '/admin/gift': { userId: 'u-redteam-x', points: 1, operator: 'rt' },
  '/admin/recharge': { userId: 'u-redteam-x', points: 1, operator: 'rt' },
  '/admin/balance/set': { userId: 'u-redteam-x', target: 1, operator: 'rt' },
  '/admin/codes': { points: 100, count: 1, operator: 'rt' },
  '/admin/orders/manual': { userId: 'u-redteam-x', points: 1, operator: 'rt' },
  '/admin/tags': { userId: 'u-redteam-x', add: [] },
  '/internal/hold': { userId: 'u-redteam-x', project: 'writing' },
  '/internal/byok/set': { userId: 'u-redteam-x', clear: true },
  '/internal/redeem': { userId: 'u-redteam-x', code: 'WRT-XXXXXXXXXXXXXXXX' },
};
const bodyOf = (p) => ADMIN_BODY[p.split('?')[0]];

async function sweep() {
  console.log('\n=== A1.1 WRITING 令牌逐一打全部 /admin/*（必须全 401）===');
  let bad = [];
  for (const [m, p] of ADMIN_ROUTES) {
    const r = await raw(m, p, { headers: tok(WRITING_TOKEN), body: bodyOf(p) });
    if (r.status !== 401) bad.push(`${m} ${p} -> ${r.status} ${JSON.stringify(r.json).slice(0, 80)}`);
  }
  record('A1.1 WRITING->admin 全 401', bad.length ? 'FAIL' : 'PASS',
    `${ADMIN_ROUTES.length} 路由, 异常=${bad.length}${bad.length ? ' | ' + bad.join(' ; ') : ''}`);

  console.log('\n=== A1.2 AUTH 令牌逐一打全部 /internal/*（设计 200/404/4xx，不允许 401/503/500）===');
  bad = [];
  for (const [m, p] of INTERNAL_ROUTES) {
    const r = await raw(m, p, { headers: tok(AUTH_TOKEN), body: bodyOf(p) });
    const s = r.status;
    if (s === 401 || s === 503 || s >= 500) bad.push(`${m} ${p} -> ${s} ${JSON.stringify(r.json).slice(0, 80)}`);
  }
  record('A1.2 AUTH->internal 无 401/503/5xx', bad.length ? 'FAIL' : 'PASS',
    `${INTERNAL_ROUTES.length} 路由, 异常=${bad.length}${bad.length ? ' | ' + bad.join(' ; ') : ''}`);

  console.log('\n=== A1.3 无令牌/旧共享令牌/变体（401；503 仅在未配置时出现）===');
  const cases = [
    ['无头', {}, ADMIN_ROUTES[0], 401],
    ['空串头', tok(''), ADMIN_ROUTES[0], 401],
    ['旧共享 INTERNAL_TOKEN(admin)', tok(OLD_SHARED_TOKEN), ADMIN_ROUTES[0], 401],
    ['旧共享 INTERNAL_TOKEN(internal)', tok(OLD_SHARED_TOKEN), INTERNAL_ROUTES[3], 401],
    ['WRITING 令牌大小写变体', tok(WRITING_TOKEN.toUpperCase()), INTERNAL_ROUTES[3], 401],
    // 注：undici/HTTP 规范在客户端就剥离首尾空白，服务端永远收到剥净的值——
    // 空白变体无法把「错令牌」变「对令牌」，不构成旁路；此处只验证加料令牌必 401
    ['WRITING 前缀+加长', tok(WRITING_TOKEN + 'x'.repeat(20)), INTERNAL_ROUTES[3], 401],
    ['WRITING 截断', tok(WRITING_TOKEN.slice(0, -2)), INTERNAL_ROUTES[3], 401],
    ['AUTH 令牌打 admin 大小写', tok(AUTH_TOKEN.slice(0, 4) + AUTH_TOKEN.slice(4).toUpperCase()), ADMIN_ROUTES[2], 401],
    ['Bearer 头混用', { Authorization: `Bearer ${WRITING_TOKEN}` }, INTERNAL_ROUTES[3], 401],
    ['令牌放 query', {}, ['/internal/wallet/u-redteam-x?X-Internal-Token=' + encodeURIComponent(WRITING_TOKEN), 'GET'], 401],
    ['令牌放 body', {}, ADMIN_ROUTES[0], 401],
  ];
  bad = [];
  for (const [name, headers, [m, p], expect] of cases) {
    let r;
    if (name === '令牌放 query') {
      r = await raw('GET', m, { headers });
    } else {
      r = await raw(m, p, { headers, body: name === '令牌放 body' ? { ...bodyOf(p), token: WRITING_TOKEN } : bodyOf(p) });
    }
    if (r.status !== expect) bad.push(`${name} -> ${r.status} (期望 ${expect}) ${JSON.stringify(r.json).slice(0, 60)}`);
  }
  // 多值头（数组形式才真正发出两条头；undici 服务端会以 ", " 合并 → 与单值比较必失败）
  for (const [a, b] of [[WRITING_TOKEN, WRITING_TOKEN], ['wrong', WRITING_TOKEN], [WRITING_TOKEN, 'wrong']]) {
    const mv = await fetch(BASE + '/internal/wallet/u-redteam-x', {
      headers: [['X-Internal-Token', a], ['X-Internal-Token', b]],
    });
    if (mv.status !== 401) bad.push(`多值头[${a.slice(0, 6)}…,${b.slice(0, 6)}…] -> ${mv.status} (期望 401)`);
  }
  record('A1.3 变体/旁路全 401', bad.length ? 'FAIL' : 'PASS', bad.length ? bad.join(' ; ') : '12 变体+多值头全部 401');

  console.log('\n=== A1.4 webhook 面令牌隔离 ===');
  const wcases = [
    ['WRITING 令牌当回调口令', { 'X-Recharge-Token': WRITING_TOKEN }],
    ['WRITING 令牌经 X-Internal-Token 载体', { 'X-Internal-Token': WRITING_TOKEN }],
    ['AUTH 令牌当回调口令', { 'X-Recharge-Token': AUTH_TOKEN }],
    ['空口令', { 'X-Recharge-Token': '' }],
    ['无头', {}],
  ];
  bad = [];
  for (const [name, headers] of wcases) {
    const r = await raw('POST', '/webhooks/recharge', { headers, body: { userId: 'u-redteam-x', points: 1, externalRef: 'rt-x' } });
    if (r.status !== 401) bad.push(`${name} -> ${r.status}`);
  }
  const ok = await raw('POST', '/webhooks/recharge', {
    headers: { 'X-Internal-Token': process.env.RECHARGE_TOKEN || 'dev-recharge-token-smoke' },
    body: { userId: 'u-redteam-x', points: 1, externalRef: 'rt-webhook-carrier-ok' },
  });
  record('A1.4 webhook 只认 RECHARGE_TOKEN', bad.length || ok.status !== 200 ? 'FAIL' : 'PASS',
    bad.length ? bad.join(' ; ') : `5 个变体全拒；RECHARGE_TOKEN 经 X-Internal-Token 载体=${ok.status}（设计允许）`);

  console.log('\n=== A1.5 timing 侧信道（恒定时间比较实证）===');
  // 交错采样：同长错令牌 / 异长错令牌 / 正确令牌。测 TTFB，50 轮取中位数。
  const N = 50;
  const samples = { sameLen: [], diffLen: [], correct: [] };
  const fakeSameLen = 'x'.repeat(WRITING_TOKEN.length);
  const fakeShort = 'x';
  for (let i = 0; i < N; i++) {
    for (const [kind, t] of [['sameLen', fakeSameLen], ['diffLen', fakeShort], ['correct', WRITING_TOKEN]]) {
      const t0 = performance.now();
      const r = await fetch(BASE + '/internal/wallet/u-redteam-x', { headers: tok(t) });
      await r.text();
      samples[kind].push(performance.now() - t0);
    }
  }
  const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)].toFixed(2); };
  const p05 = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * 0.05)].toFixed(2); };
  console.log(`    med/ms  sameLen=${med(samples.sameLen)} diffLen=${med(samples.diffLen)} correct=${med(samples.correct)}`);
  console.log(`    p05/ms  sameLen=${p05(samples.sameLen)} diffLen=${p05(samples.diffLen)} correct=${p05(samples.correct)}`);
  const ratio = med(samples.sameLen) / med(samples.correct);
  record('A1.5 timing 同长错/正确 中位数差 < 2x（无显著侧信道）', ratio < 2 ? 'PASS' : 'FAIL',
    `sameLen/correct 中位数比=${ratio.toFixed(2)}（本地回环噪声主导，仅实证量级）`);

  console.log(`\n汇总 PASS=${results.filter(r => r.verdict === 'PASS').length} FAIL=${results.filter(r => r.verdict === 'FAIL').length}`);
  process.exit(results.some(r => r.verdict === 'FAIL') ? 1 : 0);
}
sweep().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(2); });
