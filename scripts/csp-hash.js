#!/usr/bin/env node
// ============================================================
// scripts/csp-hash.js — 校验/打印内联脚本的 CSP 哈希
// ============================================================
// CSP 里内联脚本用 sha256 白名单（不用 'unsafe-inline'），
// 因此 public/*.html 里任何 <script>…</script> 内容改动都必须同步哈希。
//
//   node scripts/csp-hash.js          # 校验：不一致则退出码 1
//   node scripts/csp-hash.js --print  # 打印当前 HTML 里所有内联脚本哈希
//
// 校验通过时的输出可用于 CI（npm run csp:check）。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'public');
const securityFile = path.join(root, 'src', 'middleware', 'security.ts');

const printMode = process.argv.includes('--print');

function collectInlineScripts() {
  const found = new Map(); // hash → [files]
  for (const file of fs.readdirSync(publicDir).filter((f) => f.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(publicDir, file), 'utf8');
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const body = m[1];
      if (!body.trim()) continue;
      const hash = crypto.createHash('sha256').update(body, 'utf8').digest('base64');
      if (!found.has(hash)) found.set(hash, []);
      found.get(hash).push(file);
    }
  }
  return found;
}

function collectDeclaredHashes() {
  const src = fs.readFileSync(securityFile, 'utf8');
  const block = src.match(/INLINE_SCRIPT_HASHES\s*=\s*\[([\s\S]*?)\]/);
  if (!block) return null;
  return [...block[1].matchAll(/sha256-([A-Za-z0-9+/=]+)/g)].map((m) => m[1]);
}

const actual = collectInlineScripts();
const actualHashes = [...actual.keys()];

if (printMode) {
  for (const [hash, files] of actual) {
    console.log(`sha256-${hash}`);
    console.log(`  用于: ${[...new Set(files)].join(', ')}`);
  }
  if (!actualHashes.length) console.log('（public/ 下没有内联脚本）');
  process.exit(0);
}

const declared = collectDeclaredHashes();
if (declared === null) {
  console.error('✗ 无法在 src/middleware/security.ts 中找到 INLINE_SCRIPT_HASHES');
  process.exit(1);
}

const missing = actualHashes.filter((h) => !declared.includes(h));
const stale = declared.filter((h) => !actualHashes.includes(h));

if (missing.length || stale.length) {
  console.error('✗ CSP 内联脚本哈希与 public/*.html 不一致');
  for (const h of missing) {
    console.error(`  缺少: 'sha256-${h}'  ← ${[...new Set(actual.get(h))].join(', ')}`);
  }
  for (const h of stale) console.error(`  多余: 'sha256-${h}'`);
  console.error('  修复：node scripts/csp-hash.js --print 后更新 src/middleware/security.ts');
  process.exit(1);
}

console.log(`✓ CSP 内联脚本哈希一致（${actualHashes.length} 条）`);
