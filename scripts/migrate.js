#!/usr/bin/env node
// ============================================================
// scripts/migrate.js — 顺序执行 migrations/ 下的全部 SQL 迁移
// ============================================================
// 用法：
//   npm run db:migrate          # 本地（wrangler d1 execute --local）
//   npm run db:migrate:remote   # 生产（--remote）
// 说明：
//   - 逐个按文件名序执行 migrations/*.sql，每步都通过 wrangler d1 execute --json 执行并解析返回码。
//   - 跳过重复执行造成的既有错误（表/列已存在、重复列），视为幂等；其余错误直接终止。
//   - 复用本地 wrangler 可执行文件（bin/wrangler.js），Windows / CI(Linux) 通用。
//   - 状态记录：local → .wrangler/migration-state.json；remote → D1 表 d1_migration_state
//     （2026-10-31 引入：CI 每次是全新环境，本地状态文件不可用；此前远程靠「报错白名单」
//     全量重放，若某迁移文件中途在已应用语句上报错，文件尾部的未应用语句会被永久静默跳过）。
//     引入前的存量迁移（0001-0003）已人工补录进该表，勿删表重放。
// ============================================================

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'migrations');
const DB_NAME = 'writing-assistant-db';
const WRANGLER_BIN = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

const isRemote = process.argv.includes('--remote');
const mode = isRemote ? 'remote' : 'local';
const stateFile = path.join(ROOT, '.wrangler', 'migration-state.json');
const REMOTE_STATE_TABLE = 'd1_migration_state';

// 幂等容错：这些是"重复执行/重复迁移"时的既有错误，跳过不视为失败
const IGNORABLE_ERROR_MARKERS = [
  'already exists',          // 表/索引已存在
  'duplicate column name',   // 列已存在（ALTER TABLE ADD COLUMN）
];

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return { applied: [] };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

// wrangler --remote 会把 SQL 文件先上传，stdout 里混有上传进度行
// （"├ Checking if file needs uploading"、"├ 🌀 Uploading ..." 等），
// 真正的 JSON 结果从第一个 [ 或 { 开始、到最后一个 ] 或 } 结束。
// 提取该子串再解析，兼容 stdout 被进度日志污染的情况。
function parseWranglerJson(out) {
  const start = out.search(/[[{]/);
  if (start === -1) return null;
  const body = out.slice(start);
  const last = Math.max(body.lastIndexOf(']'), body.lastIndexOf('}'));
  if (last === -1) return null;
  try {
    return JSON.parse(body.slice(0, last + 1));
  } catch {
    return null;
  }
}

/** 执行一条任意 SQL（建状态表 / 读写迁移状态），返回解析后的 JSON 或 null */
function execD1Sql(sql) {
  const args = [
    WRANGLER_BIN,
    'd1', 'execute', DB_NAME,
    ...(isRemote ? ['--remote'] : ['--local']),
    '--json',
    `--command=${sql}`,
  ];
  let out;
  try {
    out = execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    const buf = (err && err.stdout) ? String(err.stdout) : '';
    if (!buf.trim()) {
      console.error(`  ✗ 状态表操作失败：${(err && err.message) || err}`);
      process.exit(1);
    }
    out = buf;
  }
  return parseWranglerJson(out);
}

function firstResults(parsed) {
  const arr = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  return arr[0]?.results ?? [];
}

function runMigration(file) {
  const filePath = path.join(MIGRATIONS_DIR, file);
  console.log(`\n▶ 执行迁移 ${file}`);
  const args = [
    WRANGLER_BIN,
    'd1', 'execute', DB_NAME,
    ...(isRemote ? ['--remote'] : ['--local']),
    `--file=${filePath}`,
    '--json',
  ];
  let out;
  try {
    out = execFileSync(process.execPath, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    // wrangler 以非零码退出（如 SQLITE_ERROR 中止批处理）时，stdout 仍带有 JSON 错误体
    const buf = (err && err.stdout) ? String(err.stdout) : '';
    if (buf.trim()) {
      out = buf;
    } else {
      console.error(`  ✗ 执行失败：${(err && err.message) || err}`);
      process.exit(1);
    }
  }
  let results;
  try {
    results = parseWranglerJson(out);
    if (results === null) throw new Error('no JSON');
  } catch {
    console.error(`  ✗ 无法解析 wrangler 输出：${out.slice(0, 500)}`);
    process.exit(1);
  }
  const errors = [];
  for (const r of (Array.isArray(results) ? results : [results])) {
    if (!r) continue;
    if (r.success === false) {
      const e = r.error;
      // 兼容 wrangler 两种错误形状：数组 [{message}] 或对象 {text}
      if (Array.isArray(e)) {
        errors.push(...e.map((x) => x?.message || String(x)));
      } else if (e && typeof e === 'object') {
        errors.push(e.text || e.message || '未知错误');
      } else {
        errors.push(String(e || '未知错误'));
      }
    } else if (Array.isArray(r.error) && r.error.length) {
      errors.push(...r.error.map((e) => e.message || String(e)));
    } else if (r.error && typeof r.error === 'object' && r.error.text) {
      errors.push(r.error.text);
    }
  }
  // 顶层形状：{"error":{"text":"..."}}（语句中止批处理时）
  if (errors.length === 0 && results && results.error && results.error.text) {
    errors.push(results.error.text);
  }
  if (errors.length === 0) {
    console.log('  ✓ 成功');
    return;
  }
  const fatal = errors.filter((e) => !IGNORABLE_ERROR_MARKERS.some((m) => e && e.includes(m)));
  if (fatal.length > 0) {
    console.error(`  ✗ 失败：\n    - ${fatal.join('\n    - ')}`);
    process.exit(1);
  }
  console.log(`  ✓ 完成（幂等跳过已有对象：${errors.join('; ')}）`);
}

// 文件名由正则约束，拼进 SQL 无注入面
function markApplied(file) {
  const parsed = execD1Sql(
    `INSERT INTO ${REMOTE_STATE_TABLE} (name) VALUES ('${file}') ON CONFLICT(name) DO NOTHING`,
  );
  if (parsed === null) {
    console.error(`  ✗ 无法写入迁移状态（${REMOTE_STATE_TABLE}），中止：避免下次全量重放`);
    process.exit(1);
  }
}

function main() {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^[0-9]+_.*\.sql$/.test(f))
    .sort();

  if (files.length === 0) {
    console.error('migrations/ 目录下没有迁移文件');
    process.exit(1);
  }

  let pending;
  if (isRemote) {
    // 远程状态记录在 D1 里（跨机器一致，CI 全新环境也能续上）
    execD1Sql(
      `CREATE TABLE IF NOT EXISTS ${REMOTE_STATE_TABLE} (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))`,
    );
    const rows = firstResults(execD1Sql(`SELECT name FROM ${REMOTE_STATE_TABLE}`)).map((r) => r.name);
    const applied = new Set(rows);
    pending = files.filter((f) => !applied.has(f));
  } else {
    const state = loadState();
    const applied = new Set(state.applied);
    pending = files.filter((f) => !applied.has(`${mode}:${f}`));
  }

  if (pending.length === 0) {
    console.log(`数据库已是最新（${mode}，无待执行迁移）`);
    return;
  }

  console.log(`环境：${mode}，待执行 ${pending.length} 个迁移`);
  for (const file of pending) {
    runMigration(file);
    if (mode === 'local') {
      const state = loadState();
      const applied = new Set(state.applied);
      applied.add(`${mode}:${file}`);
      saveState({ applied: [...applied] });
    } else {
      markApplied(file);
    }
  }
  console.log('\n✓ 全部迁移执行完毕');
}

main();
