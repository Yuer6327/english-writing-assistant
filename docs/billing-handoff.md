# 计费平台实施交接文档（billing handoff）

> **本文档自足**：不依赖任何历史对话，读完即可独立实施。
> 配套设计背景（为什么这么设计）：同仓库 `docs/billing-platform-design.md`。
> 定稿日期：2026-10-25。实施仓库：**Yuer6327-billing**（GitHub 私有，本地 `D:\OneDrive\桌面\play\codes\Yuer6327-billing`），Worker 名 **yuer-billing**。

## 0. 读我

**任务**：按本档实施"跨项目积分计费平台"并接入作文批改 App（english-writing-assistant）。

**一期范围**：billing Worker + billing D1（钱包/账本/预扣费/额度/标签/兑换码/订单/BYOK）、作文 App 扣费全链路改造、模型选择 UI、余额与用量展示、充值区（**在线支付显示"暂未开放"，兑换码为唯一可用充值方式**）、最小 admin 页、BYOK 一次性迁移。

**明确排除**：在线支付渠道的具体实现（渠道未定，仅建订单结构，见 §9.1）、阅读助手接入（平台已为其预留，见 §9.3）、新子域/DNS 变更。

**实施第 0 步**：创建本地仓库 `D:\OneDrive\桌面\play\codes\Yuer6327-billing`，git init，把本文档与设计文档复制到该仓库 `docs/`（本文档改名 `PLAN.md` 亦可），推 GitHub 时用 `gh repo create Yuer6327-billing --private`（推送前与用户确认）。

**工作方式约定**：两个仓库都用 `npx tsc --noEmit` 做类型关；不把任何密钥写进代码/配置文件（一律 wrangler secret / .dev.vars，.dev.vars 已被 gitignore）；文档与注释用中文。

## 1. 环境事实清单

| 项 | 值 |
|---|---|
| OS / Shell | Windows 11 + Git Bash（路径用正斜杠或引号包裹） |
| 作文 App 本地路径 | `D:\OneDrive\桌面\play\codes\english-writing-assistant`（下称 essay） |
| billing 本地路径 | `D:\OneDrive\桌面\play\codes\Yuer6327-billing`（待创建） |
| Cloudflare | wrangler 已登录本机；账号下已有 Workers `english-writing-assistant`（路由 `writing.yuer6327.top/*`，zone `yuer6327.top`） |
| 现有 D1 | `writing-assistant-db`（id `d764c512-70a2-406a-abce-4f6e5c0a041e`，essay 业务库，binding `DB`）；`auth-db`（id `85b7d1cc-fbb4-4ffe-8f1e-b6690c193a1f`，统一认证平台库，essay 只读 binding `AUTH_DB`） |
| 新建 D1 | `billing-db`（实施时 `wrangler d1 create billing-db`，id 填入 billing/wrangler.toml） |
| 本地端口约定 | 阅读助手 8787 / essay 8788 / **billing 8789**（避免冲突） |
| 统一认证 | auth.yuer6327.top 签发会话；cookie 名 `s`（HttpOnly、同根域共享）；校验 = sha256(cookie) 直查 auth-db `sessions` JOIN `users`（users 字段含 `id`(UUID)/`username`/`name`/`role`/`banned`）；生产已开 Turnstile |
| essay 部署 | GitHub Actions：push main → Node 22 → `npm ci` → `tsc --noEmit` → `node scripts/migrate.js --remote` → wrangler-action deploy；`CLOUDFLARE_API_TOKEN` 存于 GitHub Secrets；运行时 secrets 用 `wrangler secret put` 手工注入 |
| essay 现有 secrets | ENCRYPTION_KEY（AES 主密钥，BYOK 迁移后 essay 仍需保留至迁移完成）、AGNES_API_KEY（迁移后归 billing 持有）、BAIDU_OCR_AK / BAIDU_OCR_SK（留在 essay） |

**Windows 已知坑（重要）**：
- `TaskStop`/Ctrl-C 停 `wrangler dev` 会残留 **node/workerd 孤儿进程**占端口——重启动前 `taskkill //F //IM workerd.exe`（Git Bash 下双斜杠）。
- `sed` 处理含 emoji 的文件会静默失败；改文件用 Edit 工具或 node 脚本。
- 终端中文可能乱码，输出重定向到文件再读更稳。
- wrangler.toml 中内联数组键（`routes = [...]`）必须出现在任何 `[[table]]` 段之前——billing 无 routes 天然规避，essay 的 wrangler.toml 修改时保持此顺序。

## 2. 已拍板决策（18 条，重述自设计文档）

| # | 决策 |
|---|---|
| 1 | 积分体系平台级，未来所有项目共用 |
| 2 | **1 积分 = 1 元**不变；界面两位小数 |
| 3 | 按实际消耗计费（LLM 按 token、OCR 按次），不按次打包 |
| 4 | 加价倍率 N 按服务项独立配置（售价 = 上游成本 × N） |
| 5 | 必须预扣费（hold/settle） |
| 6 | heavy 请求（LLM 批改/润色）同用户在飞 **1 笔**；免费/小请求不占并发但限频 |
| 7 | 注册不赠送积分；管理员手动送分/贴标签 |
| 8 | 日额度按项目隔离；额度规则按**用户标签组**（billing 自建多对多标签，不复用 auth 的 role；无标签落 default 组） |
| 9 | 首发付费上游 DeepSeek 官方 `deepseek-flash`；免费档维持 Agnes；`ocr:baidu` 按次 |
| 10 | 充值渠道未定；前端在线支付入口显示"暂未开放"；**兑换码唯一可用**；orders 结构先行 |
| 11 | 作文 App 先行接入；阅读助手暂不动 |
| 12 | 政策：积分不过期、不可提现、问题订单人工补退 |
| 13 | BYOK 凭证上收 billing（加密存储、跨项目复用），essay `api_keys` 表迁移后废弃 |
| 14 | 计费最小单位 = 0.01 积分（分），单次结算**向上取整到分**；0.0001 微点仅存 usage_logs 供成本核算 |
| 15 | 兑换码面额：0.1 / 0.5 / 1 / 3 / 5 / 10 元 |
| 16 | 仓库 Yuer6327-billing（私有）/ Worker 名 yuer-billing |
| 17 | DeepSeek 暂无 Key：付费档代码完整但目录 disabled |
| 18 | billing 无公网路由，仅 Service Binding 内网调用；部署顺序先 billing 后 essay |

## 3. billing 仓库完整规格

### 3.1 目录结构

```
Yuer6327-billing/
├── wrangler.toml
├── package.json              # 依赖仅 hono ^4.6；scripts: dev/deploy/typecheck
├── .dev.vars.example         # 列出需要的 secret 名（不含值）
├── .gitignore                # node_modules/.wrangler/.dev.vars
├── migrations/0001_init.sql
├── scripts/migrate.js        # 参照 essay 同名脚本（wrangler d1 migrations apply）
└── src/
    ├── index.ts              # Hono app：/internal/*、/admin/*、cron scheduled
    ├── catalog.ts            # 服务目录与定价
    ├── wallet.ts             # 钱包/账本/hold/settle/release/gift/redeem
    ├── quota.ts              # 额度规则与用量
    ├── byok.ts               # BYOK 加密存取
    └── types.ts
```

### 3.2 wrangler.toml 要点

```toml
name = "yuer-billing"
main = "src/index.ts"
compatibility_date = "2024-09-23"
# ⚠️ 无 routes —— 不暴露公网，仅同账号 Service Binding 可达
[[d1_databases]]
binding = "DB"
database_name = "billing-db"
database_id = "<wrangler d1 create 后填入>"
[triggers]
crons = ["*/5 * * * *"]        # 过期 hold 释放
[observability]
enabled = true
[dev]
port = 8789
```

Secrets：`ENCRYPTION_KEY`（新造 ≥32 字符随机串，勿复用 essay 的）、`AGNES_API_KEY`（值从 essay 迁移：`wrangler secret put --name english-writing-assistant` 处查看不可行，直接向用户要原始值或让用户自己 put）、`DEEPSEEK_API_KEY`（暂无）、可选 `INTERNAL_TOKEN`（内部调用共享口令，见 3.6）。

### 3.3 migrations/0001_init.sql（完整）

```sql
-- 钱包（balance 单位=分(0.01积分)，缓存；真相在 credit_ledger）
CREATE TABLE IF NOT EXISTS wallets (
  user_id    TEXT PRIMARY KEY,
  balance    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 账本（只追加；delta 单位=分）
CREATE TABLE IF NOT EXISTS credit_ledger (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL,
  delta         INTEGER NOT NULL,          -- 正=入账/退款/赠送，负=消费
  balance_after INTEGER NOT NULL,
  type          TEXT NOT NULL,             -- recharge/consume/refund/gift
  ref_type      TEXT,
  ref_id        TEXT,
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ledger_user ON credit_ledger(user_id, id DESC);

-- 用量日志（每次真实调用一条；micro 单位=0.0001积分）
CREATE TABLE IF NOT EXISTS usage_logs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id           TEXT NOT NULL,
  project           TEXT NOT NULL,         -- 'writing' / 未来 'reading'…
  service           TEXT NOT NULL,         -- 'llm:agnes-flash' / 'llm:deepseek-flash' / 'ocr:baidu' / 'byok'
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  calls             INTEGER NOT NULL DEFAULT 1,
  micro_points      INTEGER NOT NULL,      -- 实际成本（微点，成本核算用）
  points_charged    INTEGER NOT NULL,      -- 实扣（分；free/byok 为 0）
  status            TEXT NOT NULL,         -- ok/free/byok/failed
  hold_id           TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_logs(user_id, id DESC);

-- 预扣
CREATE TABLE IF NOT EXISTS holds (
  id         TEXT PRIMARY KEY,             -- crypto.randomUUID()
  user_id    TEXT NOT NULL,
  project    TEXT NOT NULL,
  service    TEXT NOT NULL,
  frozen     INTEGER NOT NULL,             -- 冻结金额（分）
  status     TEXT NOT NULL DEFAULT 'active',  -- active/settled/released/expired
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at INTEGER NOT NULL              -- epoch ms，created + 5min
);
CREATE INDEX IF NOT EXISTS idx_holds_active ON holds(status, expires_at);

-- 订单（在线渠道未定，结构先行）
CREATE TABLE IF NOT EXISTS orders (
  id           TEXT PRIMARY KEY,           -- 自生成订单号，如 'ORD' + 时间戳 + 随机
  user_id      TEXT NOT NULL,
  channel      TEXT NOT NULL,              -- redeem_code/manual/…（开放枚举）
  amount_cents INTEGER NOT NULL DEFAULT 0, -- 人民币分
  points       INTEGER NOT NULL,           -- 到账积分（分）
  status       TEXT NOT NULL,              -- pending/paid/delivered/cancelled
  external_ref TEXT,
  note         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  paid_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, id DESC);

-- 兑换码
CREATE TABLE IF NOT EXISTS redemption_codes (
  code       TEXT PRIMARY KEY,             -- 'WRT-' + 16 位高熵随机（Crockford base32）
  points     INTEGER NOT NULL,             -- 分
  batch      TEXT,
  status     TEXT NOT NULL DEFAULT 'unused',  -- unused/used/disabled
  used_by    TEXT,
  used_at    TEXT
);

-- 用户标签组（计费域；auth 的 role 只管权限，两者不混用）
CREATE TABLE IF NOT EXISTS user_groups (
  group_key TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  note      TEXT
);
CREATE TABLE IF NOT EXISTS user_group_members (
  user_id    TEXT NOT NULL,
  group_key  TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, group_key)
);

-- 免费额度规则与用量
CREATE TABLE IF NOT EXISTS quota_rules (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  project   TEXT NOT NULL,
  service   TEXT NOT NULL,                -- 绑定"服务档位"，如 llm:agnes-flash
  group_key TEXT NOT NULL DEFAULT 'default',
  period    TEXT NOT NULL DEFAULT 'daily',   -- daily/monthly
  limit_n   INTEGER NOT NULL,
  enabled   INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS quota_usage (
  user_id  TEXT NOT NULL,
  project  TEXT NOT NULL,
  service  TEXT NOT NULL,
  period   TEXT NOT NULL,                 -- daily: '2026-10-25'；monthly: '2026-10'（Asia/Shanghai）
  used     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, project, service, period)
);

-- BYOK（平台级、跨项目；AES-256-GCM，格式同 essay：base64(iv):base64(ct)）
CREATE TABLE IF NOT EXISTS byok_keys (
  user_id              TEXT PRIMARY KEY,
  encrypted_key        TEXT NOT NULL,
  api_base_url         TEXT NOT NULL,
  model_name           TEXT NOT NULL,
  vision_api_base_url  TEXT,
  vision_model_name    TEXT,
  vision_encrypted_key TEXT,             -- NULL = 回退主密钥
  updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 初始数据
INSERT INTO user_groups (group_key, name) VALUES ('default', '默认组');
INSERT INTO quota_rules (project, service, group_key, period, limit_n) VALUES
  ('writing', 'llm:agnes-flash', 'default', 'daily', 3),
  ('writing', 'ocr:baidu',       'default', 'daily', 5);
```

### 3.4 catalog.ts 规格

```ts
interface ServiceDef {
  id: string;                    // 内部服务 id（对外暴露的唯一标识）
  kind: 'llm' | 'percall';
  tier: 'free' | 'paid';
  enabled: boolean;              // disabled 时 hold/config 返回 409 model_disabled
  heavy: boolean;                // 受"同用户在飞 1 笔"并发锁限制
  vision: boolean;
  jsonMode: boolean;             // 请求是否带 response_format
  secretName?: string;           // 'AGNES_API_KEY' | 'DEEPSEEK_API_KEY'
  baseUrl: string | string[];    // 数组 = essay ai.ts 的多端点 failover
  upstreamModel: string;
  // 定价（分）：llm 为 分/1k tokens；percall 为 分/次。= 上游成本 × N
  price: { inputPer1k?: number; outputPer1k?: number; perCall?: number } | null;
  priceN?: number;
  note?: string;
}
```

初始三条 + 一个伪模型：
1. `llm:agnes-flash` — free / enabled / heavy / vision:true / **jsonMode:false**（Agnes 不支持 response_format）/ baseUrl 双端点数组 `['https://apihub.agnes-ai.cn/v1','https://apihub.agnes-ai.com/v1']` / upstreamModel `agnes-3.0-flash` / secret AGNES_API_KEY / price null（免费）。
2. `llm:deepseek-flash` — paid / **enabled:false（无 Key）** / heavy / vision:true / jsonMode:true（启用时实测核验，见 §9.2）/ baseUrl `https://api.deepseek.com/v1` / upstreamModel `deepseek-flash` / secret DEEPSEEK_API_KEY / price null（拿到控制台单价后填，N 先按 2）。
3. `ocr:baidu` — kind percall / tier free-quota（额度内免费，超出按次）/ enabled:true / heavy:false / price `{perCall: 1}`（1 分 = 0.01 积分）。
4. 伪模型 `byok` — 不入目录；`config/hold` 遇到 `modelId='byok'` 走 byok_keys 解析，零计费。

另外导出 `PROJECTS = ['writing']`（未来加 'reading'）与 `estimateHoldCost(service, estInputTokens, maxOutputTokens)`：llm = `ceil((est_in*inputPer1k + max_out*outputPer1k)/1000)`，最低 1 分；percall = perCall。

### 3.5 行为规格

**钱包/账本（wallet.ts）**
- 所有余额变更走 `credit_ledger`（只追加）+ `wallets.balance` 缓存，同一 D1 `batch()` 内完成。扣减模板：
  `UPDATE wallets SET balance = balance - ? WHERE user_id = ? AND balance >= ?` → 影响行数 0 = 余额不足（402）；随后插 ledger（含 balance_after = 旧值 − delta）。
- **hold(userId, project, service, est)**：免费额度判定（quota.check）命中 → 直接扣 quota_usage 并返回 `mode:'free'`；否则按 estimateHoldCost 冻结（同上模板，先 `INSERT INTO wallets ... ON CONFLICT(user_id) DO NOTHING` 保证行存在）。hold id = UUID，TTL 5 分钟。
- **settle(holdId, usage)**：实际成本 micro = f(usage)（llm：`(in*inputPer1k + out*outputPer1k)/1000 * 10000` 微点；percall：perCall*10000 微点）；实扣分 = `max(1, ceil(micro/100))`（向上取整到分）；若 frozen > 实扣，差额以 ledger type=refund 入账；holds.status='settled'；写 usage_logs。**幂等**：hold 已 settled/released 时直接返回原结果（200）。
- **release(holdId)**：ledger type=refund 退回 frozen，status='released'。幂等同上。
- **cron（scheduled handler）**：`UPDATE holds SET status='expired' WHERE status='active' AND expires_at < now`，逐条退回 frozen（batch）。
- **gift(userId, points, note)**：ledger type=gift（管理员手动送分，可为任意非零分值）。
- **redeem(userId, code)**：单 batch 内 `UPDATE redemption_codes SET status='used', used_by=? WHERE code=? AND status='unused'`（行数 0 → 409 已用/404 无效）→ wallet 入账 → ledger type=recharge ref=code → order(channel='redeem_code', status='delivered')。

**额度（quota.ts）**
- 规则匹配：project + service + 用户标签组（多标签时任一命中取 limit 最大；无标签用 'default'）+ period。
- period key：`new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })`；monthly 用 `'YYYY-MM'`（同 timezone）。
- 扣减：`INSERT INTO quota_usage ... ON CONFLICT(user_id, project, service, period) DO UPDATE SET used = used + 1 RETURNING used`，used > limit_n 则拒绝（返回 free 配额已用尽 → 上层走 hold）。

**BYOK（byok.ts）**
- AES-256-GCM，与 essay `src/utils/crypto.ts` 完全同构（key = SHA-256(ENCRYPTION_KEY)，格式 `base64(iv):base64(ct)`）——迁移时无需格式转换，只需**用 billing 的新密钥重新加密**。
- `set(userId, {key, baseUrl, model, vision?})`、`get(userId)`（解密为明文配置，仅经内网返回）、`has(userId)`。

### 3.6 内部 API 契约（全部经 Service Binding；可校验 `X-Internal-Token`）

| 端点 | 请求 | 成功响应 | 错误 |
|---|---|---|---|
| `POST /internal/hold` | `{userId, project, service, modelId?, estInputTokens?, maxOutputTokens?, calls?}` | `{mode:'free', quotaRemaining}` / `{mode:'hold', holdId, frozen}` / `{mode:'byok'}` | 402 `{error,code:'insufficient_balance'}`；409 `{code:'model_disabled'}`；404 未知服务 |
| `POST /internal/holds/:id/settle` | `{promptTokens?, completionTokens?, calls?}` | `{charged, refunded, balance}`（幂等） | 404 |
| `POST /internal/holds/:id/release` | — | `{refunded, balance}`（幂等） | 404 |
| `GET /internal/wallet/:userId` | — | `{balance}`（无行则建 0 余额行） | — |
| `GET /internal/config/:userId/:modelId` | — | `{provider:'agnes'\|'deepseek'\|'byok', key, baseUrl: string\|string[], model, vision?: {key, baseUrl, model} \| null}`（明文 key 仅内网返回） | 404 未知模型；409 model_disabled；404 未配置 byok |
| `POST /internal/redeem` | `{userId, code}` | `{balance, points}` | 404/409/429 |
| `POST /admin/gift` | `{userId, points, note}` | `{balance}` | — |
| `POST /admin/byok/set` | `{userId, key?, baseUrl, model, visionKey?, visionBaseUrl?, visionModel?}`（key 省略=保留旧值） | `{ok}` | — |
| `POST /admin/codes` | `{points, count, batch?}` | `{codes: string[]}`（一次性返回，明码不落日志） | — |
| `POST /admin/orders/manual` | `{userId, points, note}` | `{orderId}`（channel=manual，直接 delivered+入账） | — |
| `GET /admin/user/:userId` | — | `{balance, tags, recent_ledger, recent_usage}` | — |
| `POST /admin/tags` | `{userId, add?: string[], remove?: string[]}` | `{tags}` | — |
| `GET /admin/orders?limit=` / `GET /admin/usage?userId=&limit=` | — | 行数组 | — |

说明：`hold` 的默认 modelId 规则在 billing 内实现——请求未带 modelId 时：byok_keys 有记录 → 'byok'，否则 'llm:agnes-flash'（与 essay 现状行为一致）。

## 4. 作文 App（essay）后端改造规格

锚点为当前行号，**以函数名定位为准**（改动后行号会漂移）。

1. **`src/types.ts`**：`Env` 加 `BILLING: Fetcher`；`Vars` 加 `role: string`；`AGNES_API_KEY` 注释标记 deprecated（迁移期保留可选）。
2. **`wrangler.toml`**：文件末尾追加 `[[services]]`（binding = "BILLING"，service = "yuer-billing"）。注意现有 `routes = [...]` 内联数组必须保持在一切 `[[table]]` 段之前。
3. **`src/utils/billing.ts`（新建）**：`env.BILLING.fetch` 封装，方法一一对应 §3.6；非 2xx 抛错并挂 `err.code`；可选带 `X-Internal-Token`（secret INTERNAL_TOKEN，双方可先留空）。
4. **`src/utils/ai.ts`**：`callAI` 返回值 `Promise<string>` → `Promise<{content: string, usage?: {prompt_tokens: number, completion_tokens: number}}>`。`callAIFetch` 从 `data.usage` 取值随 content 一起返回；多端点/重试路径透传"成功那次"的 usage（失败重试的中间成本不单独计费，吸收进 N）。4 个调用点同步改：essays.ts 批改循环（~L383）、polish fragment（~L484）、polish full（~L516）、ocr.ts vlm 循环。**其余逻辑（1015 排班、response_format 回退、extractJSON、超时）一律不动**。
5. **`src/utils/api-config.ts`**：`getUserApiKey`/`getVisionConfig` **签名不变**，实现改为 `billing.resolveModel(userId, 'free'|'byok')`（agnes 的 `agnesGlobalRateHit()` 检查保留在解析路径，抛 `AgnesRateLimitError`）；新增 `resolveLane(env, userId, modelId: 'free'|'deepseek'|'byok')` 供路由用。AGNES_BASE_URLS/AGNES_MODEL 常量保留（前端展示用）。
6. **`src/middleware/auth.ts`**（~L23-38）：SQL 已查出 `u.role`，补 `c.set('role', row.role)` 一行。
7. **`src/routes/auth.ts`** `/me`：响应改 `{id, username, role, wallet: {balance}}`——balance 经 billing 取，失败降级 `wallet: {balance: null}`（不阻塞登录态）。
8. **`src/utils/rate-limit.ts`**：`aiRateLimit` 现按 api_keys.provider 决定是否拦——改为**对所有用户**应用用户级 18/min；全局 Agnes 桶 `agnesGlobalRateHit()` 维持在 api-config 解析路径生效；删除对 `api_keys` 表的查询（该表将废弃）。
9. **`src/routes/essays.ts`**
   - `POST /drafts/:id/review`（~L308）与 `POST /essays/:id/polish`（~L424）：body 增加可选 `model_id: 'free'|'deepseek'|'byok'`。
   - **hold 插入点**：cfg 解析成功后、callAI 循环前。`billing.hold(userId, 'writing', serviceId, {estInputTokens, maxOutputTokens})`——estInputTokens = `ceil((systemPrompt + userPrompt).length / 3)`，maxOutputTokens 用调用同值（4096/3000）。mode='hold' 时获取**并发锁**（模块级 `Map<userId, true>`，已占用 → 429「已有批改任务进行中」；finally 释放）；mode='byok'/'free' 不锁。
   - **settle 插入点**：sanitize 成功、INSERT 之前。响应 JSON 增加 `points_charged`（分，前端 ÷100 显示）与 `lane`（free/paid/byok）。
   - **release 插入点**：所有失败路径（429 短路、502、外层 catch）——`try/catch` 包住"hold 之后"的全部逻辑，catch 里先 release 再返回。
   - 402 直接透传：`c.json({error, code: 'insufficient_balance'}, 402)`。
10. **`src/routes/ocr.ts`** `POST /api/ocr`：baidu 分支入口 hold（service='ocr:baidu'，免费额度 5 次/日内 mode=free，超出 frozen=1 分）、settle（calls=1）在成功 return 前；vlm 分支与 review 同构（est 按 images 体积 + 提示词估）。失败路径 release。
11. **`src/routes/settings.ts`**：`POST /api/settings/api-keys` 改为写 billing（byok：`admin/byok/set`（key 明文经内网传输，加密在 billing 侧）；agnes：清除 byok 记录语义 = 请求 billing 删除或置空，实现时用 `admin/byok/set` 加 `clear: true` 参数即可）；`GET /api/settings/api-keys/status` 响应保持现有形状（数据源改 billing + byok.has）。
12. **`src/routes/billing.ts`（新建，挂 `/api/billing`）**：
    - `GET /me`（authMiddleware）→ `{balance, paid_enabled, quota: {writing: [{service, used, limit}]}, recent_usage: [...20 条]}`
    - `POST /redeem`（authMiddleware + 强限流：5 次/分、20 次/日/用户）→ billing redeem
    - `GET /usage?limit=50` → usage_logs/ledger 合并视图
    - admin 全组（先查 `c.get('role') === 'admin'`，否则 403）：
      - `POST /admin/gift`：body `{username, points_yuan, note}`——先 `AUTH_DB` 查 `SELECT id FROM users WHERE username = ?` 得 userId，再 billing gift（points_yuan × 100 转分）
      - `GET /admin/user/:username`、`POST /admin/tags`、`POST /admin/codes`、`POST /admin/orders/manual`、`GET /admin/orders`、`GET /admin/usage`：均为 billing 透传
      - `POST /admin/migrate-byok`：见 §6
13. **`src/index.ts`**：挂载 `billingRoutes` 到 `/api/billing`（CORS 已覆盖 /api/*）。

## 5. 前端改造规格（public/）

风格约束：只用 `style.css` 现有 token/类（`.card/.btn/.badge/.form-*/.modal-*`、`--primary` 等），不引入新色值。锚点以函数/元素 id 定位。

1. **`public/js/api.js`**：加命名空间 `billing: {me(), redeem(code), usage(), admin: {gift, user, tags, codes, orders, manualOrder, migrateByok}}`；`request()` 的错误对象补挂 `err.code`（后端 402 的 `insufficient_balance` 靠它分流）。
2. **`public/js/essay.js`** — 三处 AI 触发点：
   - 模型选择控件：批改在 `renderDraftPanel()` 按钮行（~L171-180，「开始批改」旁）；精修在 `openPolishModal()`（~L646）表单内；统一 `<select>`：免费通道 / DeepSeek（积分）（仅当 `billing.me().paid_enabled`）/ 我的 Key（仅当 settings status provider==='byok'）。默认值 = 我的 Key（若配置）否则免费通道，与服务端默认规则一致；精修/批改各自记忆上次选择（内存即可）。
   - 积分档提示：选中 DeepSeek 时在按钮旁显示 muted 文案「按用量计积分，通常约 0.02~0.1 积分/次，实结多退少补」。
   - OCR 弹窗（`openDraftModal()`，现有 radio `name="ocr-engine"` 行）加一行 muted 说明：「百度 OCR 每日 5 次免费，超出 0.01 积分/次；大模型识别按用量计积分」。
   - **402 处理**：runReview/runFullRewrite/精修/OCR 的 catch 里判 `err.code === 'insufficient_balance'` → `wbModal()` 弹「余额不足」卡片（余额 + 「去设置页充值」链接 `/settings.html#billing`），其余错误维持 toast。
   - 成功展示：响应新增 `points_charged`，在 `renderReview()` 的模型行（现有 rv.model `<span class="muted">`）旁追加「本次消耗 X 积分」（X = points_charged/100，两位小数；0 则显示「免费」）。
3. **`public/settings.html` + `settings.js`**：在「AI 服务配置」与「批改提示词模板」两张 card 之间插入「账户与用量」card（`id="card-billing"`，可深链 `#billing`）：余额大数字（两位小数）、兑换码表单（输入 + 兑换按钮 → toast + 刷新余额）、近 20 条用量表（时间/服务/消耗/状态）、以及一行 muted 提示「**在线支付暂未开放**，当前可通过兑换码充值」。settings.js 的 `init()` 加 `initBillingSection()`（沿用现有 initXxx 模式）。
4. **`public/admin.html` + `public/js/admin.js`（新建页）**：`<main data-page-module="/js/admin.js">`；`requireAuth()` 后 `role !== 'admin'` 渲染「无权限」并中止。区块：送积分（用户名/金额元/备注）、用户查询（余额+标签+近期账目）、标签管理（加/删组、贴/撕标签）、生成兑换码（面额下拉 0.1/0.5/1/3/5/10 元 + 数量 → 一次性 textarea 展示 + 复制按钮，**刷新即丢**）、订单查询、手动补单。路径加进 `swup.js` 的 `SPA_PAGES`。
5. **导航栏余额 pill**：navbar 在三份 HTML 复制粘贴且 swup 持久化——用 JS 注入（新小模块或并入 auth.js）：requireAuth 后拉 `billing.me()`，向 `.navbar-right` append `<a class="badge" href="/settings.html#billing">X.XX 积分</a>`；注入前查重防 swup 重复追加；admin 额外注入「管理」链接。

## 6. BYOK 一次性迁移程序

1. 前提：billing 已部署且 `byok_keys` 为空；essay 新代码已上线（settings 保存已改写 billing）。
2. 管理员调 `POST /api/billing/admin/migrate-byok`（essay 侧实现）：遍历 essay `api_keys` 全表 → `provider='byok'` 的行用 essay `ENCRYPTION_KEY` 解密（`decryptApiKey`）→ 经 Service Binding 送 billing `/admin/byok/set`（billing 用**自己的新密钥**重新加密）；`provider='agnes'` 的行跳过（免费车道无需记录）。
3. 校验：响应比对 `{source_rows, migrated, skipped}` 三数一致；抽查一个用户 `GET /admin/user/:id` 看 byok 配置；让一位 BYOK 用户实测批改。
4. 回滚：迁移是**复制不是搬移**，`api_keys` 原表未动——回滚 = api-config 切回旧实现（迁移期代码里保留旧函数一段时日）。
5. 收尾（确认稳定数日后）：essay 删除 `AGNES_API_KEY` secret（billing 已持有）；`api_keys` 表保留不删（历史凭证备份），代码中不再读它。

## 7. 实施顺序（每步带验证）

| 步 | 内容 | 验证 |
|---|---|---|
| 0 | 建本地仓库 + 复制两份文档 + `gh repo create Yuer6327-billing --private`（先问用户） | `git status` 干净，GitHub 可见 |
| 1 | `wrangler d1 create billing-db` → id 填入 wrangler.toml | `wrangler d1 list` 可见 |
| 2 | billing 骨架（package.json/wrangler.toml/index.ts health） | `tsc --noEmit` 过；`wrangler dev` 8789 起得来 |
| 3 | 迁移 SQL 本地应用 + catalog/wallet/quota/byok + `/internal/*` + `/admin/*` | `wrangler d1 migrations apply billing-db --local`；dev 下 curl 直打 8789 走通 hold→settle/release 幂等、redeem、402 |
| 4 | essay 后端改造（§4 全部） | `tsc --noEmit` 过；**双 dev 同跑**（billing 8789 + essay 8788，wrangler dev registry 会把 `[[services]]` 解析到本地 billing；若不通，临时用 `wrangler dev --remote` 或加 dev-only 测试路由直调） |
| 5 | BYOK 迁移路由 + 前端全部（§5） | 本地 UI 全流程手测 |
| 6 | billing CI（照抄 essay deploy.yml：tsc → `wrangler d1 migrations apply billing-db --remote` → deploy）+ 推送 GitHub | push 后 Actions 绿 |
| 7 | secrets：billing `wrangler secret put ENCRYPTION_KEY AGNES_API_KEY`（新生成/向用户要值）；**先部署 billing 再部署 essay**（binding 按名称解析，目标必须已存在） | 生产 `/api/health`（billing 无公网，以 essay 侧 `/api/billing/me` 200 为准） |
| 8 | 生产 e2e：§8 清单逐项 | 全绿后按 §6 收尾 |

## 8. 验收清单（无 DeepSeek Key 可全测）

1. 免费档批改成功，`/api/billing/me` 的 quota.used_today +1，`points_charged=0`；
2. 同一日额度用尽（把 quota_rules.limit_n 临时改 0 最快）→ 明确报错文案（而非 5xx）；
3. BYOK 用户走"我的 Key"批改成功，全程零扣费、不占免费额度；
4. admin 送积分 → 余额即时变化，ledger 有 gift 记录；
5. admin 生成兑换码 → 用户兑换成功 → 余额/订单/账本三处一致；重复兑换同一码 409；兑换接口连打触发限流 429；
6. 余额为 0 + 额度用尽 + 无 BYOK → 批改返回 **402**，前端弹「余额不足」；兑换后流程恢复；
7. 连点「开始批改」→ 第二笔被并发锁拦下（429 文案），无双重扣费；
8. DeepSeek 选项不出现在模型选择器（disabled）；`model_id='deepseek'` 直打 API 返回 409 model_disabled。
另：两个仓库 `tsc --noEmit` 干净；账本 `SUM(delta)` = wallets.balance 抽查一致。

## 9. 延后项档案

### 9.1 在线支付渠道（未定）

当前口径：渠道未确定，**代码不做任何在线支付实现**，充值区 UI 显示"暂未开放"。领先候选为支付宝当面付，完整研究结论在设计文档附录 A（个人可签基础版、限额单笔≤1000/日≤5万、签约路径 b.alipay.com → open.alipay.com、RSA2 纯 fetch 可行、类目避开金融/网络服务）。将来接入时：预下单/回调经 essay 公开路由代理转 billing（billing 保持无公网），回调按订单状态机幂等；`orders.channel` 已开放枚举，勿写死。

### 9.2 DeepSeek 启用（两步 + 核验）

`wrangler secret put DEEPSEEK_API_KEY`（yuer-billing）→ catalog 中 `llm:deepseek-flash` enabled 改 true → 从控制台取实际单价填 price（N 先按 2）→ 实测核验：json mode（response_format 是否稳定）、图像输入（**图片只能放 user 消息，仅视觉模型接受，违规直接 HTTP 400 不降级**——构造消息时注意）、按实测单价修订价格。

### 9.3 阅读助手将来接入

新增 `services` binding → project 用 `'reading'` → 在 billing 配 reading 的 quota_rules → BYOK 自动共享（平台级）。essay 的 `callAI` 改造（返回 usage）届时可直接抄。

## 10. 上游事实（2026-10 查证，实施时复核）

- **DeepSeek**：现行模型 `deepseek-flash`（V4.1 Flash，2026-09-10 发布，原生多模态，图片转 token 计费；旧名 `deepseek-v4-flash-vision-exp` 已标下线但可调用）。OpenAI 兼容。json mode 未见官方明确文档，**启用时必须实测**。
- **Agnes（免费档）**：`agnes-3.0-flash`，双端点 `apihub.agnes-ai.cn`（大陆）/ `apihub.agnes-ai.com`（国际）各自独立限流；被 Cloudflare 1015 边缘限流时响应带精确 `retry-after`；**不支持 response_format**（essay ai.ts 已有跳过机制与 1015 排班，勿破坏）；账户 RPM 约 20/分钟（全局共享）。
- **百度 OCR**：AK/SK 换 access_token（30 天有效）；端点降级链 handwriting → accurate_basic → general；错误码 17/18/19 = 额度耗尽；handwriting 约 200 次一次性、accurate 约 1000 次/月（免费额度）。
- **auth 平台**：users.role 现用于权限判定（admin）；生产 Turnstile 开启；essay 对 auth-db 为只读直查，**不要**往 auth-db 写任何计费数据。
