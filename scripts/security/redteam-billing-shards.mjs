#!/usr/bin/env node
// ============================================================
// scripts/security/redteam-billing-shards.mjs — A5 分片正确性（90 分片合并）
// 用法：BASE=... GT=<ground-truth 目录> node scripts/security/redteam-billing-shards.mjs
// 依赖三份 wrangler d1 导出：rt-gt-usage.json / rt-gt-ledger.json / rt-gt-wallets.json
// PASS=分片合并与单查询等价 FAIL=重复/丢失/顺序错乱/5xx
// ============================================================

const BASE = process.env.BASE || 'http://127.0.0.1:8790';
const AUTH_TOKEN = process.env.AUTH_INTERNAL_TOKEN || 'dev-auth-token-smoke';
const GT = process.env.GT || process.env.TEMP;
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const results = [];
function record(id, verdict, detail) {
  const v = verdict === true ? 'PASS' : verdict === false ? 'FAIL' : verdict;
  results.push({ id, verdict: v });
  console.log(`[${ { PASS: 'PASS', FAIL: 'FAIL', INFO: 'INFO' }[v] }] ${id} — ${detail}`);
}
async function get(path) {
  const resp = await fetch(BASE + path, { headers: { 'X-Internal-Token': AUTH_TOKEN } });
  const json = (resp.headers.get('content-type') || '').includes('json') ? await resp.json().catch(() => null) : null;
  return { status: resp.status, json };
}

const gtUsage = JSON.parse(readFileSync(join(GT, 'rt-gt-usage.json')))[0].results;
const gtLedger = JSON.parse(readFileSync(join(GT, 'rt-gt-ledger.json')))[0].results;
const gtWallets = JSON.parse(readFileSync(join(GT, 'rt-gt-wallets.json')))[0].results;
const ids = gtWallets.map(r => r.user_id);
console.log(`ground truth: usage=${gtUsage.length} ledger=${gtLedger.length} wallets=${gtWallets.length}`);

async function pageAll(pathBase, rowKey, expectTotal) {
  const rows = [];
  let page = 1, pages = 1, total = -1, sum = null;
  do {
    const r = await get(`${pathBase}&page=${page}&size=50`);
    if (r.status !== 200 || !r.json) return { err: `page ${page} -> ${r.status}` };
    total = r.json.total; pages = r.json.pages; sum = r.json.sum;
    rows.push(...(r.json[rowKey] ?? r.json.rows ?? []));
    if (page > pages + 2) break;
    page++;
  } while (page <= pages);
  return { rows, total, pages, sum };
}
const keyOf = (r) => `${r.id}`;
const orderOk = (rows) => rows.every((r, i) => i === 0 ||
  r.created_at < rows[i - 1].created_at || (r.created_at === rows[i - 1].created_at && r.id < rows[i - 1].id));

console.log('\n=== A5.1 usage 130 ids × 全翻页（11 页）：重复/丢失/顺序/合计 ===');
{
  const r = await pageAll('/admin/usage?ids=' + ids.join(','), 'usage', gtUsage.length);
  if (r.err) record('A5.1 usage 翻页', false, r.err);
  else {
    const uniq = new Set(r.rows.map(keyOf));
    record('A5.1a usage 行完整且无重复（归并=单查询）',
      r.rows.length === gtUsage.length && uniq.size === gtUsage.length &&
      gtUsage.every(g => uniq.has(String(g.id))),
      `rows=${r.rows.length} uniq=${uniq.size} total=${r.total}（gt=${gtUsage.length}）`);
    record('A5.1b usage 全局序 (created_at,id) DESC 跨页一致', orderOk(r.rows),
      `首行=${r.rows[0]?.created_at}/${r.rows[0]?.id} 末行=${r.rows.at(-1)?.created_at}/${r.rows.at(-1)?.id}`);
    const gtSum = gtUsage.reduce((s, x) => s + x.points_charged, 0);
    record('A5.1c usage 跨片 SUM 合并=单查询', r.sum.points === gtSum,
      `sum.points=${r.sum.points} gt=${gtSum} calls=${r.sum.calls} micro=${r.sum.micro}`);
  }
}

console.log('\n=== A5.2 ledger 130 ids 全翻页 ===');
{
  const r = await pageAll('/admin/ledger?ids=' + ids.join(','), 'rows', gtLedger.length);
  if (r.err) record('A5.2 ledger 翻页', false, r.err);
  else {
    const uniq = new Set(r.rows.map(keyOf));
    const gtSum = gtLedger.reduce((s, x) => s + x.delta, 0);
    record('A5.2 ledger 完整无重复+delta 合计一致',
      r.rows.length === gtLedger.length && uniq.size === gtLedger.length && r.sum.delta === gtSum && orderOk(r.rows),
      `rows=${r.rows.length} total=${r.total} sum.delta=${r.sum.delta} gt=${gtSum}`);
  }
}

console.log('\n=== A5.3 wallets / user-stats 130 ids（跨片 Map 合并）===');
{
  const w = await get('/admin/wallets?ids=' + ids.join(','));
  const match = gtWallets.every(g => w.json?.balances?.[g.user_id] === g.balance);
  record('A5.3a wallets 130 id 全命中且值=单查询', w.status === 200 && Object.keys(w.json.balances).length === 130 && match,
    `keys=${Object.keys(w.json?.balances ?? {}).length} 值匹配=${match}`);
  const s = await get('/admin/user-stats?ids=' + ids.join(',') + '&days=30');
  const balSum = gtWallets.reduce((a, x) => a + x.balance, 0);
  const ptsSum = gtUsage.reduce((a, x) => a + x.points_charged, 0);
  record('A5.3b user-stats total（users/funded/balance/points）',
    s.json?.total?.users === 130 && s.json?.total?.funded === 130 &&
    s.json?.total?.balance === balSum && s.json?.total?.points === ptsSum,
    `users=${s.json?.total?.users} funded=${s.json?.total?.funded} balance=${s.json?.total?.balance}/${balSum} points=${s.json?.total?.points}/${ptsSum}`);
}

console.log('\n=== A5.4 分片边界 90/91/180/181（1/2/2/3 片；不足 N 用 fake id 补齐）===');
{
  for (const n of [90, 91, 180, 181]) {
    const sub = [...ids, ...Array.from({ length: n }, (_, i) => 'u-fake-' + i)].slice(0, n);
    const u = await get('/admin/usage?ids=' + sub.join(',') + '&size=1000');
    const w = await get('/admin/wallets?ids=' + sub.join(','));
    const s = await get('/admin/user-stats?ids=' + sub.join(','));
    const realN = Math.min(n, ids.length);
    const expectRows = realN * 4;
    record(`A5.4 N=${n}（${Math.ceil(realN / 90)} 片, 边界无重/漏）`,
      u.json?.total === expectRows && (u.json.usage ?? u.json.rows ?? []).length === expectRows &&
      Object.keys(w.json?.balances ?? {}).length === n && s.json?.total?.users === n,
      `usage.total=${u.json?.total}/${expectRows} 行=${(u.json.usage ?? u.json.rows ?? []).length} wallets=${Object.keys(w.json?.balances ?? {}).length}/${n}（含 fake id 补 0=设计）users=${s.json?.total?.users}`);
  }
}

console.log('\n=== A5.5 page/size 越界 ===');
{
  const pBig = await get('/admin/usage?ids=' + ids.join(',') + '&page=100000&size=50');
  const pNeg = await get('/admin/usage?ids=' + ids.join(',') + '&page=-3&size=50');
  const s0 = await get('/admin/usage?ids=' + ids.join(',') + '&size=0');
  const sNeg = await get('/admin/usage?ids=' + ids.join(',') + '&size=-5');
  const sBig = await get('/admin/usage?ids=' + ids.join(',') + '&size=100000');
  const lBig = await get('/admin/ledger?ids=' + ids.join(',') + '&page=99999999&size=50');
  // pageMeta 把 page 钳到最后一页（page=100000 → page=11，返回末页 20 行）——优雅降级
  const lastUsage = pBig.json.rows.length;
  record('A5.5a page=100000 → 钳到末页不 500', pBig.status === 200 && pBig.json.page === pBig.json.pages &&
    lastUsage === 520 - (pBig.json.pages - 1) * 50,
    `page=${pBig.json?.page}/${pBig.json?.pages} rows=${lastUsage}`);
  record('A5.5b page=-3 → 回落 page=1', pNeg.status === 200 && pNeg.json.page === 1, `page=${pNeg.json?.page}`);
  record('A5.5c size=0/-5/100000 → 钳制不 500',
    s0.status === 200 && sNeg.status === 200 && sBig.status === 200 &&
    s0.json.rows.length <= 1000 && sBig.json.rows.length <= 1000,
    `size0=${s0.json.rows.length} sizeNeg=${sNeg.json.rows.length} sizeBig=${sBig.json.rows.length}`);
  record('A5.5d ledger page=99999999 → 钳到末页不 500', lBig.status === 200 && lBig.json.page === lBig.json.pages &&
    lBig.json.rows.length === 390 - (lBig.json.pages - 1) * 50,
    `page=${lBig.json?.page}/${lBig.json?.pages} rows=${lBig.json?.rows?.length}`);
}

console.log('\n=== A5.6 ids 恶意内容（SQL 元字符/空元素/重复/超量）===');
{
  const evil = [
    ['引号', encodeURIComponent("u-rt-shard-000'--")],
    ['括号注入', encodeURIComponent("u-rt-shard-000),('x")],
    ['逗号+引号', encodeURIComponent("u-rt-shard-000',x")],
    ['空元素 A,,B', 'A,,B'],
    ['注释符', encodeURIComponent('--')],
    ['分号', encodeURIComponent('u-rt-shard-000;DROP TABLE usage_logs;--')],
    ['百分号', encodeURIComponent('u-rt-shard-%')],
  ];
  for (const [name, v] of evil) {
    const r = await get('/admin/usage?ids=' + v + '&size=10');
    record(`A5.6 ids=${name} → 200/0 行不 500`, r.status === 200 && (r.json?.usage ?? r.json?.rows ?? []).length === 0,
      `status=${r.status} total=${r.json?.total}`);
  }
  const dup = await get('/admin/usage?ids=u-rt-shard-000,u-rt-shard-000,u-rt-shard-000&size=10');
  record('A5.6b 重复 id 不重复出行（IN 语义）', dup.status === 200 && dup.json?.total === 4, `total=${dup.json?.total}`);
  const big600 = await get('/admin/usage?ids=' + [...ids, ...Array.from({ length: 470 }, (_, i) => 'u-fake-' + i)].join(',') + '&size=10');
  const big1200 = await get('/admin/wallets?ids=' + [...ids, ...Array.from({ length: 1100 }, (_, i) => 'u-fake-' + i)].join(','));
  record('A5.6c 600 ids（截 500）usage.total 仍=520', big600.status === 200 && big600.json?.total === 520, `total=${big600.json?.total}`);
  record('A5.6d 1230 ids（截 500）wallets 不 500', big1200.status === 200, `status=${big1200.status}`);
  // 表完好
  const alive = await get('/admin/usage?ids=u-rt-shard-000');
  record('A5.6e 注入后表完好（参数化）', alive.status === 200 && alive.json?.total === 4, `total=${alive.json?.total}`);
}

console.log(`\n汇总 PASS=${results.filter(r => r.verdict === 'PASS').length} FAIL=${results.filter(r => r.verdict === 'FAIL').length}`);
process.exit(results.some(r => r.verdict === 'FAIL') ? 1 : 0);
