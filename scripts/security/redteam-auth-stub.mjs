#!/usr/bin/env node
// ============================================================
// scripts/security/redteam-auth-stub.mjs — auth /internal/validate 本地 stub
// （红队专用，端口 9102；writing .dev.vars 的 DEV_AUTH_URL 指向这里）
// 行为由 redteam-auth-mode.json 即时控制（每请求重读，无需重启）：
//   {"mode":"ok"}            正常：test-cookie-1/2 → u-attack-1/2，其余 valid:false
//   {"mode":"503"}           503（auth 库异常）
//   {"mode":"timeout"}       挂起 15s 不响应
//   {"mode":"malformed"}     返回非 JSON 文本（契约漂移）
//   {"mode":"v2"}            返回 {"v":2,...}（未知版本）
//   {"mode":"nouser"}        {"v":1,"valid":true}（user 字段缺失）
//   {"mode":"weirdid"}       valid:true 但 user.id 是数组
//   {"mode":"adminrole"}     任意 s 都 valid:true 且 role:"admin"
//   {"mode":"banned"}        test-cookie-1 返回 banned:true
//   {"mode":"401"}           401（调用方令牌错）
//   {"mode":"slow3"}         延迟 3s 后正常返回（测降级时延）
// 所有调用追加写入 redteam-auth-calls.log（放大效应计数用）。
// ============================================================
import http from 'node:http';
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = 9102;
const DIR = dirname(fileURLToPath(import.meta.url));
const MODE_FILE = join(DIR, 'redteam-auth-mode.json');
const LOG = join(DIR, 'redteam-auth-calls.log');
const TOKEN = 'local-dev-auth-validate-token';

function mode() {
  try {
    if (!existsSync(MODE_FILE)) return { mode: 'ok' };
    return JSON.parse(readFileSync(MODE_FILE, 'utf8'));
  } catch { return { mode: 'ok' }; }
}
const now = () => new Date().toISOString().slice(11, 23);

const USERS = {
  'test-cookie-1': { id: 'u-attack-1', username: 'attacker1', name: 'Attacker One', role: 'user', banned: 0, expiresAt: Date.now() + 3600e3 },
  'test-cookie-2': { id: 'u-attack-2', username: 'victim1', name: 'Victim One', role: 'user', banned: 0, expiresAt: Date.now() + 3600e3 },
};

const server = http.createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  let s = '';
  try { s = JSON.parse(body).s ?? ''; } catch { /* malformed body */ }
  const m = mode().mode;
  appendFileSync(LOG, `${now()} mode=${m} s=${s.slice(0, 40)}\n`);

  const hdr = req.headers['x-internal-token'];
  if (m === '503') { res.writeHead(503, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'auth db unavailable' })); }
  if (m === '401') { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'bad caller token' })); }
  if (m === 'timeout') { await new Promise(r => setTimeout(r, 15000)); res.writeHead(200); return res.end('{}'); }
  if (m === 'slow3') { await new Promise(r => setTimeout(r, 3000)); }
  if (hdr !== TOKEN && m !== 'no-token-check') {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'bad token' }));
  }
  if (m === 'malformed') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('<html>not json</html>'); }
  if (m === 'v2') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ v: 2, valid: true, user: USERS['test-cookie-1'] })); }
  if (m === 'nouser') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ v: 1, valid: true })); }
  if (m === 'weirdid') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ v: 1, valid: true, user: { ...USERS['test-cookie-1'], id: ['evil-array-id'], role: 'user' } }));
  }
  if (m === 'adminrole') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ v: 1, valid: true, user: { id: 'u-evil-admin', username: 'evil', name: 'Evil', role: 'admin', banned: 0 } }));
  }
  if (m === 'banned') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (s === 'test-cookie-1') return res.end(JSON.stringify({ v: 1, valid: true, user: { ...USERS['test-cookie-1'], banned: 1 } }));
    const u = USERS[s];
    if (u) return res.end(JSON.stringify({ v: 1, valid: true, user: u }));
    return res.end(JSON.stringify({ v: 1, valid: false }));
  }
  // ok
  res.writeHead(200, { 'Content-Type': 'application/json' });
  let u = USERS[s];
  if (!u && /^rt-\d+$/.test(s)) u = { id: `u-rt-${s.slice(3)}`, username: `rt${s.slice(3)}`, name: `RT${s.slice(3)}`, role: 'user', banned: 0 };
  res.end(JSON.stringify(u ? { v: 1, valid: true, user: u } : { v: 1, valid: false }));
});
server.listen(PORT, '127.0.0.1', () => console.log(`[redteam-auth-stub] listening on 127.0.0.1:${PORT}`));
