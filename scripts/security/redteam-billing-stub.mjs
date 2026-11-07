#!/usr/bin/env node
// ============================================================
// scripts/security/redteam-billing-stub.mjs — yuer-billing 本地 stub（红队专用）
// 端口 8791（8790 被真实 billing 占用，writing .dev.vars 的 DEV_BILLING_URL 临时指向 8791）。
// 所有 AI 车道（agnes/longcat/deepseek）的 config 一律下发 mock-ai 127.0.0.1:9101 ——
// 不触碰任何真实上游 / 真实 key。行为由 redteam-billing-mode.json 即时控制：
//   {"mode":"ok"}                      正常
//   {"mode":"hold_503"}                hold 返回 503（billing 宕机）
//   {"mode":"hold_402"}                hold 返回 402 余额不足
//   {"mode":"hold_409"}                hold 返回 409 并发冲突
//   {"mode":"hold_slow"}               hold 延迟 10s 再正常返回
//   {"mode":"hold_slow_free"}          同上（供免费车道 hold 延迟观测）
//   {"mode":"settle_503"}              settle 返回 503
//   {"mode":"catalog_503"}             /internal/catalog 503
//   {"mode":"config_503"}              /internal/config 503
//   {"mode":"wallet_broken"}           /internal/wallet 返回 503
// 钱包：内存 Map（微积分）。播种：POST /__seed {userId, target}（仅本机，测试夹具）。
// hold/settle/release 调用追加写 redteam-billing-calls.log（对账用）。
// ============================================================
import http from 'node:http';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 8792;
const DIR = dirname(fileURLToPath(import.meta.url));
const MODE_FILE = join(DIR, 'redteam-billing-mode.json');
const LOG = join(DIR, 'redteam-billing-calls.log');
const TOKENS = new Set(['local-dev-internal-token', 'dev-writing-token-smoke']);
const MOCK = 'http://127.0.0.1:9101/v1';

function mode() {
  try { if (existsSync(MODE_FILE)) return JSON.parse(readFileSync(MODE_FILE, 'utf8')); } catch { /* fallthrough */ }
  return { mode: 'ok' };
}
const log = (line) => { try { appendFileSync(LOG, line + '\n'); } catch { /* ignore */ } };
const now = () => new Date().toISOString().slice(11, 23);

// ── 内存钱包 / holds / byok / codes ──
const wallet = new Map();          // userId -> micro-points
const holds = new Map();           // holdId -> { userId, frozen }
const byok = new Map();            // userId -> {key, baseUrl, model, vision...}
const redeemedCodes = new Set();   // 已用兑换码（重放检测）
let holdSeq = 0;

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

// 目录：与真实 billing 形状对齐，但 price 档位自造（本地无真实价）
const CATALOG = [
  { id: 'llm:agnes-flash', lane: 'free', provider: 'agnes', tier: 'free', enabled: true, heavy: true, vision: true, jsonMode: false, displayName: '免费通道', hint: null, streamOnly: false, maxOutputFactor: 1, maxOutputMin: null, budgetMs: null, thinkingBudget: null, imageTokenEstimate: null, noRetry: false, price: null },
  { id: 'llm:longcat', lane: 'longcat', provider: 'longcat', tier: 'free', enabled: true, heavy: true, vision: true, jsonMode: true, displayName: 'LongCat-2.5（限时免费）', hint: '限时免费 · 推理模型生成较慢', streamOnly: false, maxOutputFactor: 3, maxOutputMin: 16384, budgetMs: 300000, thinkingBudget: 8192, imageTokenEstimate: null, noRetry: false, price: null },
  { id: 'llm:deepseek-flash', lane: 'deepseek', provider: 'deepseek', tier: 'paid', enabled: true, heavy: false, vision: false, jsonMode: true, displayName: 'DeepSeek 快档', hint: null, streamOnly: true, maxOutputFactor: 3, maxOutputMin: null, budgetMs: 300000, thinkingBudget: null, imageTokenEstimate: null, noRetry: false, price: { inputHitPer1k: 5, inputMissPer1k: 20, outputPer1k: 80 } },
];
const CONFIGS = {
  'llm:agnes-flash': { provider: 'agnes', key: 'sk-mock-agnes-local', baseUrl: [MOCK], model: 'agnes-3.0-flash', vision: null },
  'llm:longcat': { provider: 'longcat', key: 'sk-mock-longcat-local', baseUrl: MOCK, model: 'LongCat-2.5', vision: null },
  'llm:deepseek-flash': { provider: 'deepseek', key: 'sk-mock-deepseek-local', baseUrl: MOCK, model: 'deepseek-chat', vision: null },
};

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  let body = '';
  for await (const ch of req) body += ch;
  let B = {}; try { B = JSON.parse(body || '{}'); } catch { /* ignore */ }
  const m = mode().mode;
  const tk = req.headers['x-internal-token'];

  // 播种夹具（仅本机回环，供红队脚本复位钱包）
  if (p === '/__seed' && req.method === 'POST') {
    wallet.set(B.userId, Math.round(Number(B.target) || 0));
    return json(res, 200, { ok: true, balance: wallet.get(B.userId) });
  }
  if (p === '/__reset' && req.method === 'POST') {
    wallet.clear(); holds.clear(); byok.clear(); redeemedCodes.clear();
    return json(res, 200, { ok: true });
  }

  if (!TOKENS.has(tk)) return json(res, 401, { error: '内部调用令牌无效', code: 'bad_internal_token' });

  // ── hold ──
  if (p === '/internal/hold' && req.method === 'POST') {
    log(`${now()} hold uid=${B.userId} svc=${B.service} skipQuota=${B.skipQuota} mode=${m} estIn=${B.estInputTokens} maxOut=${B.maxOutputTokens}`);
    if (m === 'hold_503') return json(res, 503, { error: '计费服务暂不可用，请稍后重试' });
    if (m === 'hold_402') return json(res, 402, { error: '余额不足，请充值后再试', code: 'insufficient_balance' });
    if (m === 'hold_409') return json(res, 409, { error: '已有任务进行中', code: 'concurrent_limit' });
    if (m === 'hold_slow' || m === 'hold_slow_free') await new Promise(r => setTimeout(r, 10000));
    const svc = String(B.service || '');
    if (svc === 'byok') {
      const st = byok.get(B.userId);
      if (!st?.key) return json(res, 404, { error: '未配置 BYOK', code: 'byok_not_configured' });
      return json(res, 200, { mode: 'byok' });
    }
    const entry = CATALOG.find(c => c.id === svc);
    if (!entry || !entry.enabled) return json(res, 409, { error: '该模型通道已停用', code: 'service_disabled' });
    if (entry.tier === 'paid') {
      const bal = wallet.get(B.userId) || 0;
      if (bal <= 0) return json(res, 402, { error: '余额不足，请充值后再试', code: 'insufficient_balance' });
      const holdId = `h-${++holdSeq}`;
      const frozen = 5000; // 0.5 credit 预冻结
      wallet.set(B.userId, bal - frozen);
      holds.set(holdId, { userId: B.userId, frozen });
      return json(res, 200, { mode: 'hold', holdId, frozen, quotaRemaining: 100 });
    }
    // 免费档 / 限时免费（longcat）：0 元放行
    return json(res, 200, { mode: 'free' });
  }

  // ── settle / release ──
  const sm = p.match(/^\/internal\/holds\/([^/]+)\/(settle|release)$/);
  if (sm) {
    const [, holdId, op] = sm;
    const h = holds.get(holdId);
    log(`${now()} ${op} hold=${holdId} uid=${B.userId} known=${!!h}`);
    if (m === 'settle_503' && op === 'settle') return json(res, 503, { error: '计费服务暂不可用，请稍后重试' });
    if (!h) return json(res, 404, { error: 'hold 不存在或已过期', code: 'hold_not_found' });
    if (B.userId && h.userId !== B.userId) return json(res, 403, { error: 'hold 归属不匹配', code: 'hold_owner_mismatch' });
    holds.delete(holdId);
    const bal = (wallet.get(h.userId) || 0) + h.frozen;
    wallet.set(h.userId, bal);
    if (op === 'release') return json(res, 200, { refunded: h.frozen, balance: bal });
    const out = Math.max(0, Math.round(Number(B.completionTokens) || 0));
    const charged = Math.min(out * 2, bal); // 假价：2 微积分/token，封顶余额
    wallet.set(h.userId, bal - charged);
    return json(res, 200, { charged, refunded: h.frozen - charged, balance: wallet.get(h.userId) });
  }

  // ── wallet / overview / usage ──
  const wm = p.match(/^\/internal\/wallet\/(.+)$/);
  if (wm) {
    if (m === 'wallet_broken') return json(res, 503, { error: '计费服务暂不可用，请稍后重试' });
    return json(res, 200, { balance: wallet.get(decodeURIComponent(wm[1])) || 0 });
  }
  const om = p.match(/^\/internal\/overview\/([^?/]+)/);
  if (om) {
    const uid = decodeURIComponent(om[1]);
    return json(res, 200, { balance: wallet.get(uid) || 0, paid_enabled: true, quota: {}, recent_usage: [], models: CATALOG });
  }
  const um = p.match(/^\/internal\/usage\/([^?/]+)/);
  if (um) {
    const uid = decodeURIComponent(um[1]);
    return json(res, 200, { usage: [], ledger: [{ user_id: uid, delta: 0, note: 'stub' }], limit: Number(u.searchParams.get('limit')) || 50 });
  }

  // ── catalog / config ──
  if (p === '/internal/catalog') {
    if (m === 'catalog_503') return json(res, 503, { error: '计费服务暂不可用，请稍后重试' });
    return json(res, 200, { services: CATALOG });
  }
  const cm = p.match(/^\/internal\/config\/([^/]+)\/(.+)$/);
  if (cm) {
    const uid = decodeURIComponent(cm[1]);
    const mid = decodeURIComponent(cm[2]);
    log(`${now()} config uid=${uid} model=${mid} mode=${m}`);
    if (m === 'config_503') return json(res, 503, { error: '计费服务暂不可用，请稍后重试' });
    if (mid === 'byok') {
      const st = byok.get(uid);
      if (!st?.key) return json(res, 404, { error: '未配置 BYOK', code: 'byok_not_configured' });
      return json(res, 200, { provider: 'byok', key: st.key, baseUrl: st.baseUrl || MOCK, model: st.model || 'gpt-4o-mini', vision: st.visionKey ? { key: st.visionKey, baseUrl: st.visionBaseUrl || st.baseUrl || MOCK, model: st.visionModel || 'gpt-4o-mini' } : null });
    }
    const cfg = CONFIGS[mid];
    if (!cfg) return json(res, 404, { error: '未知模型', code: 'unknown_model' });
    return json(res, 200, cfg);
  }

  // ── byok ──
  const bs = p.match(/^\/internal\/byok\/(.+)$/);
  if (bs && req.method === 'GET') {
    const uid = decodeURIComponent(bs[1]);
    const st = byok.get(uid);
    return json(res, 200, { configured: !!st?.key, baseUrl: st?.baseUrl ?? null, model: st?.model ?? null, visionModel: st?.visionModel ?? null, visionBaseUrl: st?.visionBaseUrl ?? null, agnes_available: true });
  }
  if (p === '/internal/byok/set' && req.method === 'POST') {
    log(`${now()} byok/set uid=${B.userId} clear=${B.clear} hasKey=${!!B.key}`);
    if (B.clear) { byok.delete(B.userId); return json(res, 200, { ok: true }); }
    byok.set(B.userId, { key: B.key, baseUrl: B.baseUrl, model: B.model, visionKey: B.visionKey, visionBaseUrl: B.visionBaseUrl, visionModel: B.visionModel });
    return json(res, 200, { ok: true });
  }

  // ── redeem（一次性码：WRT-OK1 只能用一次）──
  if (p === '/internal/redeem' && req.method === 'POST') {
    const code = String(B.code || '');
    log(`${now()} redeem uid=${B.userId} code=${code.slice(0, 20)}`);
    if (redeemedCodes.has(code)) return json(res, 409, { error: '兑换码已被使用', code: 'code_used' });
    if (code === 'WRT-OK1' || code === 'WRT-OK2') {
      redeemedCodes.add(code);
      const bal = (wallet.get(B.userId) || 0) + 10000;
      wallet.set(B.userId, bal);
      return json(res, 200, { balance: bal, points: 10000 });
    }
    return json(res, 404, { error: '兑换码不存在或已失效', code: 'code_not_found' });
  }

  return json(res, 404, { error: 'not found' });
});
server.listen(PORT, '127.0.0.1', () => console.log(`[redteam-billing-stub] listening on 127.0.0.1:${PORT}`));
