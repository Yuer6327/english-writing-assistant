# AUDIT.md — 优化任务清单（给编码 Agent 执行）

> 生成：2026-10-27 · 基线：`npm run check` 通过（tsc --noEmit + CSP 哈希）
> 读法：**按 ID 顺序做，每条独立可交付**。每条含「位置 / 现状 / 为什么错 / 改法 / 验收」。行号是生成时的快照，改动后会漂移，以函数名为准。
> 完成一条就在该条前面把 `[ ]` 改成 `[x]`，不要批量勾选。

---

## 0. 动手前必读：不可违反的既有约束

这些都是踩过坑沉淀下来的，改代码时**不能顺手推翻**：

| 约束 | 说明 |
|---|---|
| `[assets] run_worker_first = true` | 删掉后静态资源绕过 Worker，CSP/安全头对 HTML 全部失效 |
| 不要用 Host 判断"是不是本地请求" | `wrangler dev` 会把 Host/Origin 重写成 `routes` 里的生产域名，用环境变量开关 |
| 改 `public/*.html` 内联脚本 → 必须 `npm run csp:hash` | 新哈希填进 `src/middleware/security.ts` 的 `INLINE_SCRIPT_HASHES`，否则 CI 挂 |
| 免费档调 `billing.hold` 必须带 `skipQuota: true` | 否则撞「无价服务额度用尽 → 409」 |
| 批改次数归本 Worker（`quota_events`），不归 billing | billing 只管钱。别把次数逻辑挪回去 |
| 入参校验必须前置于 `billing.hold` | 否则 400 早退留下未释放的冻结额度，要等 cron 过期 |
| `/api/auth/me` 恒 200 | 用 `logged_in` 区分，否则游客一进站就被弹登录 |
| 游客受限能力返 403 `code=login_required` | 前端弹登录引导，不整页跳转 |
| `--text-light` 已按 WCAG AA 调过 | 别再调浅 |

**关于评分封顶（P0-5 的边界）**：提示词里的 9/9/4、总分 ≤22 是**刻意的压分纪律**，目的是防 AI 放水。不要因为"25 分制应该是 10/10/5"就擅自取消封顶，那不是 bug，是设计。要改的只是"呈现方式"。

---

## P0 — 会产生错误结论或直接失败

### [x] P0-1 统一词数口径（最终采用 200-500）

> ⚠️ **最终执行口径（2026-10-27 用户明确指定）**：词数采用 **200-500 词**，不采纳下方原审查的 120-150。代码、前端、seed 与 CLAUDE.md 已统一为 200-500。

**位置**
- `src/utils/prompts.ts` — `GENRES['sh-gaokao-essay'].desc`
- `src/utils/prompts.ts` — `SH_GAOKAO_ESSAY_PROMPT` 的【作文信息】段
- `src/utils/prompts.ts` — `FULL_REWRITE_PROMPT` 的"控制在 200-500 词"
- `public/js/essay.js` — 词数提示逻辑（`wordcount-hint` 与阈值 `n>=200&&n<=500?'ok':n>=160?'bad':''`）
- `public/index.html` — 新建页红字提示
- `src/sample/seed.ts` — 两条 `word_count_assessment`（已是对的，确认即可）

**现状**：提示词要求「200-500 词；词数不足或超出过多应扣分」，前端也按 200-500 判定。但 `seed.ts` 的示例作文是 127 词 / 121 词，assessment 写「符合 120-150 词要求」，CLAUDE.md 也写 120-150。

**为什么错**：上海高考 Guided Writing 官方题干原文是 `Write an English composition in 120-150 words`（2024 真题已核）。一篇合规的 130 词作文会被判词数严重不足并扣内容分；`revised_essay` 与润色稿会被扩写到 250-300 词，学生照抄等于在考场写超标作文。同一系统内示例（127 词"符合且 120-150"）与规则（200-500）互相打脸。

**改法**
1. 在 `GENRES` 增加结构化字段，让前后端都从它取，别再各自硬编码：
   ```ts
   'sh-gaokao-essay': {
     label: '上海高考大作文',
     total: 25,
     minWords: 120,
     maxWords: 150,
     // 判词数问题的宽容区间：区间内不提示，超出才提醒
     softMinWords: 115,
     softMaxWords: 170,
     desc: '内容 10 + 语言 10 + 结构 5，满分 25 分；词数要求 120-150 词',
   }
   ```
2. 提示词里改为引用该区间（模板字符串拼进去，不要再写死数字）：
   `- 词数：{word_count}（上海高考大作文要求 120-150 词，约 130 词最佳；少于 115 或多于 170 属明显偏离，应扣分并在 word_count_assessment 中具体说明）`
3. `FULL_REWRITE_PROMPT` 的"控制在 200-500 词"改为"控制在 120-150 词（约 130 词）"。
4. 前端判定改为：`n < softMin || n > softMax ? 'bad' : 'ok'`，文案「128 词（考试要求 120-150）」。新建页与工作台两处同步，并确保两处文案一致（不要一处写 200-500、一处写 120-150）。
5. `word_count_assessment` 的输出要求固定为三段式：「当前 N 词 / 要求 120-150 / 差 X 词（或超出 X 词）」。

**验收**
- 全仓库 `grep -rn "200-500\|200 - 500" src public` 无残留（历史评论除外）。
- 提交一篇 130 词作文，`word_count_assessment` 不再出现"不足"字样；提交 320 词作文，明确提示超出。
- 润色稿词数落在 120-150。

---

### [x] P0-2 修正图片 token 估算（现按 base64 字符数折算，虚高 50-100 倍）

**位置** `src/routes/essays.ts` — `estimateImageTokens()`；调用点在 review 路由的 `billing.hold`；同样的问题在 `src/routes/ocr.ts` 的 `estInputTokens` 计算。

**现状** `Math.ceil(images.join('').length / 4)`。单张 data URL 上限 400,000 字符 → 单张估算 100,000 tokens，三张 300,000。

**为什么错** billing 用它算冻结额（deepseek 档 `inputPer1k = 0.4` 分 → 一张图冻结 ≈40 分），而真实多模态输入通常 1-2k tokens/图。`wallet.debit()` 的余额校验是硬的（`balance >= amount`，否则抛 402 `insufficient_balance`），于是带题目图片 + 积分档会以"积分余额不足，请充值"被拒——用户余额明明够用。同一公式也拖累 VLM 手写识别。

**改法**
```ts
/** 多模态图片的 token 估算：按张计固定值（与分辨率弱相关），不要按 base64 字符数折算 */
const IMAGE_TOKEN_ESTIMATE = 1600;  // DeepSeek 模型按官方文档用 1024/张
function estimateImageTokens(images: string[]): number {
  return images.length * IMAGE_TOKEN_ESTIMATE;
}
```
`ocr.ts` 同款改成 `Math.ceil(OCR_VLM_PROMPT.length / 3) + images.length * IMAGE_TOKEN_ESTIMATE`（把常量抽到公共位置，两处共用）。

顺带：`MAX_IMAGES` / `MAX_IMAGE_CHARS` 在 `essays.ts` 与 `ocr.ts` 各写一份，抽到 `src/types.ts` 或新建 `src/utils/limits.ts`。

**验收** 带 3 张图的批改，`billing.hold` 的 `estInputTokens` 落在「文字估算 + 4800」量级；余额 20 分的账号能正常批改（不再 402）。

---

### [x] P0-3 批改写入原子化：结果先落库，再计次

**位置** `src/routes/essays.ts` — review 路由成功分支（`billing.settle` 之后那段），以及外层 catch 的判断 `if (holdInfo.mode === 'hold' && !settled)`。

**现状** 顺序为 `settle` → `recordSuccess`（写 `quota_events`）→ `INSERT INTO reviews`。若 INSERT 抛错（D1 5xx、行超 2MB），外层 catch 因 `settled = true` 不再 release，返回 502。用户积分实扣、免费次数 -1、库里零记录。

**为什么错** 正是计费侧专门规避过的那类问题（"没批改却少了额度"），只是换到了批改侧。用户再点一次会再扣一次。

**改法**
```ts
// 结果与计次同批提交（D1 db.batch 是事务）；顺序上结果在前
const stmts = [
  c.env.DB.prepare(
    `INSERT INTO reviews (draft_id, essay_id, user_id, result, model, reviewed_text, meta)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(draftId, draft.essay_id, userId, JSON.stringify(result), model, draft.text, JSON.stringify(meta)),
];
if (lane === 'free') {
  stmts.push(c.env.DB.prepare(
    'INSERT INTO quota_events (user_id, day, kind, essay_id, draft_id) VALUES (?, ?, ?, ?, ?)',
  ).bind(userId, beijingDay(), 'review', draft.essay_id, draftId));
}
const [insert] = await c.env.DB.batch(stmts);
```
- 把 `recordSuccess` 拆出一个「只构造语句、不执行」的变体（如 `successStmt()`），或直接在这条路由内联构造语句，别让 `quota.ts` 的纯执行接口继续被误用。
- batch 失败时**不要把已拿到的 result 丢掉**：照常 200 返回结果（内容是合法的），同时 `console.error` 打一条带 `review_id` 缺失标记的告警。宁可"结果给了但没计次"，也不要"扣了钱什么都没有"。

**验收** 手动让 INSERT 失败（临时改成非法表名）→ 用户仍拿到批改结果、不返回 502、`quota_events` 无新增行。

---

### [x] P0-4 补三处唯一约束，消灭并发重复

**位置** `migrations/`（新建 `0003_uniqueness.sql`）、`src/utils/quota.ts`、`src/routes/essays.ts`（新建稿件 + 列表播种）

**（a）游客同稿可批两次（TOCTOU）**
`checkReviewGate` 读「未批改过」→ 中间隔 30-90 秒 AI 调用 → `recordSuccess` 写行，全程无互斥；`quota_events` 只有普通索引。双标签页 / 超时重试 / 多 isolate 都能让同一稿批两次、计次 +2（BYOK 车道连 inflight 锁都不占）。

（b）**稿件版本号 MAX+1 无唯一约束**
`drafts` 缺 `UNIQUE(essay_id, version)`。并发写出两个"二稿"；游客 3 稿门禁用预读 version 判定，可写第 4 稿。前端 Tab 按 version 渲染（明确不重排），重号后展示与批改引用全串。

（c）**示例播种并发重复**
`/api/essays` 先读 flag、再 count、再 seed、最后写 flag。新用户首屏并发两次请求会各灌一份示例。`seed.ts` 的失败兜底按 title 删除，可能误删用户自己写的同名作文。

**改法**
```sql
-- migrations/0003_uniqueness.sql
-- 同一稿同一类型只允许一条计数（游客「每稿一次」的硬约束）
CREATE UNIQUE INDEX IF NOT EXISTS uq_quota_draft
  ON quota_events(user_id, draft_id, kind)
  WHERE draft_id IS NOT NULL;

-- 稿件版本号唯一
CREATE UNIQUE INDEX IF NOT EXISTS uq_drafts_version
  ON drafts(essay_id, version);
```
- 建索引前先跑一次去重检查（生产可能有历史脏数据）：
  ```sql
  SELECT user_id, draft_id, kind, COUNT(*) c FROM quota_events
   WHERE draft_id IS NOT NULL GROUP BY 1,2,3 HAVING c > 1;
  SELECT essay_id, version, COUNT(*) c FROM drafts GROUP BY 1,2 HAVING c > 1;
  ```
  有结果就先清重（保留 id 最小的），再建唯一索引。
- `recordSuccess` 改 `INSERT OR IGNORE`；`meta.changes === 0` 视为重复 → 释放 hold + 返回 409 `already_reviewed`。
- 新建稿件改单条原子插入：
  ```sql
  INSERT INTO drafts (essay_id, user_id, version, text, source, word_count, handwriting_score, ocr_images)
  SELECT ?, ?, COALESCE(MAX(version), 0) + 1, ?, ?, ?, ?, ?
    FROM drafts WHERE essay_id = ?
  ```
  冲突（唯一索引报错）时重试一次。注意门禁要基于**实际写入的 version**，所以先插入再判 `version > GUEST_MAX_DRAFTS` 时回滚删除。
- 播种改「先抢 flag 再 seed」：`INSERT OR IGNORE INTO user_flags(user_id, flag)` 后看 `meta.changes`，抢到的人才播种；`seed.ts` 的失败兜底改成按 `essay_id` 删除，别按 title。

**验收** 并发压测：同一稿同时发 2 个 review 请求 → 只产生 1 条 review、1 条 quota_event。同一作文同时发 2 个新建稿件 → version 为 2 和 3（或一个 409），不出现两条 version=2。

---

### [x] P0-5 把「上限 22/25」告诉用户（不要取消封顶）

**位置** `src/utils/prompts.ts`（`buildPreviousFeedbackBlock` 的 `/25`）、`public/js/essay.js`（分数卡）、`src/utils/validate.ts`

**现状** 提示词与 `sanitizeReview` 都强制 9/9/4、总分 ≤22（刻意压分，合理）。但前端一律按 `/25` 展示，从未告知上限；二稿反馈块也写死 `上一稿得分：x/25`，模型看到的基准会失真（19/25 像"还行"，19/22 像"接近封顶"）。另外 `sanitizeReview` 里 `finalScore = score === sum ? score : sum` 让 `parsed.score` 成为死代码。

**改法**
1. **不要动**提示词里的封顶规则本身。
2. 分数卡固定加一行注记：`本系统采用保守阅卷口径（上限 22/25），真实阅卷可给 23-25`。21-22 分在徽章上标「系统内满分」。
3. `buildPreviousFeedbackBlock` 里 `/${prevScore}` 的分母改为传入 `ceiling`（22），文案写 `上一稿得分：19/22（本系统上限 22）`。
4. 从 AI 输出 schema 里删掉 `score` 字段（提示词里去掉该行、`sanitizeReview` 里 `score = content + language + organization` 直接算），减少模型无谓输出。若担心兼容旧记录，`parseJsonField` 读旧数据时字段缺失也不影响渲染。

**验收** 分数卡出现上限说明；二稿 prompts 里出现 `/22`；`grep -n "parsed.score" src/utils/validate.ts` 无残留。

---

## P1 — 用户可感知的失败 / 明显浪费

### [x] P1-1 AI 重试按错误类型分流 + 全局时间预算

**位置** `src/utils/ai.ts`（`AI_TIMEOUT_MS`、`callAIEndpoints`）、`src/routes/essays.ts`（三处 attempt 循环）、`src/routes/ocr.ts`（同款）

**现状** 除 429/1015 外任何异常都进第二次 attempt：BYOK key 失效（401）、模型名错（400）、90s 超时都会再打一遍，叠上双端点 failover 与 1015 就地等待 12s，最坏 ≈ 2×90s×2。而 Cloudflare 对客户端连接的空闲超时约 100 秒，超出返回 524（HTML 错误页）——前端 `api.js` 直接 `resp.json()`，解析 HTML 会抛 `Unexpected token <`。另外 billing hold 5 分钟过期，超时请求 settle 时 hold 已 expired，`charged=0`，等于免费白用。

**改法**
1. `callAI` 增加 `deadline?: number` 参数（绝对时间戳）。`callAIEndpoints` 每次换端点/等待前检查剩余预算，不够一个新端点就直接抛错。
2. attempt 循环只对「JSON 解析失败 / sanitize 校验失败」重试；`AI API error 4xx`（非 429）与 abort 立即失败，不再打第二轮。
3. `AI_TIMEOUT_MS` 由 90s 降到 40s；单次请求总预算硬顶 90s。
4. `api.js` 的 `request()` 在 `resp.ok` 之前先看 `content-type`，非 JSON 时抛「服务超时，请稍后重试或刷新查看结果」，不要让它冒 `Unexpected token`。

**验收** 把 AI 端点配成 401，批改立即失败（1 次调用，不重试），返回明确文案；把端点拖到 45s，总耗时不超过 90s。

### [x] P1-2 批改 job 化（可中断、可恢复）

**位置** `src/routes/essays.ts`（review 路由）、`migrations/`（`reviews` 加列）、`public/js/essay.js`、`public/js/api.js`

**现状** 前端 fetch 无 `AbortController`、无超时、无重试。用户切后台、锁屏、手滑刷新，页面状态就没了。服务端其实已把结果写进 `reviews`，但用户不知道"刷新就有"。

**改法**（分两步，可以只做第一步）
1. **最小版**：`localStorage` 记 `pending-review:<draftId>=timestamp`，进入工作台时若发现有标记，轮询 `api.getEssay` 每 3s 一次、最多 180s，出现新 review 就渲染并清除标记。同时按钮文案加「可以离开此页面，结果会自动保存」。
2. **完整版**：`reviews` 加 `status TEXT DEFAULT 'done'`（pending/done/failed）；review 路由变 `202 + job_id`，后台用 `c.executionCtx.waitUntil()` 跑 AI；新增 `GET /api/drafts/:id/review-status` 返回状态与结果。前端 2s 轮询。
   ⚠️ `waitUntil` 的后台任务有执行时长上限，**必须先确认免费档的 CPU 限额**（`wrangler.toml` 未配 `limits.cpu_ms`，默认值按套餐走）。若确认不够，退回方案 1 + P1-1 的时间预算。

**验收** 批改过程中刷新页面，3 秒内恢复"批改中"状态；完成后自动渲染，不需要手动刷新。

### [x] P1-3 `custom_prompt` 必须校验 `{essay}`

**位置** `src/routes/essays.ts`（创建/更新作文）、`src/routes/prompts.ts`（已有校验，抽出来共用）、`src/utils/prompts.ts`（`fillTemplate`）

**现状** 创建/更新作文的 `custom_prompt` 只 trim + slice，唯一强校验在模板接口。`fillTemplate` 会把未知占位符清空，于是 AI 手里没有作文却仍返回一份"批改"，`checkReviewGate` 已放行、`recordSuccess` 照扣。这是"AI 没看我的作文却收了我一次额度"。

**改法**
```ts
// src/utils/prompts.ts 导出，三处共用
export function validatePromptTemplate(content: string): { ok: true } | { ok: false; error: string } {
  if (!content.includes('{essay}')) return { ok: false, error: '提示词必须包含 {essay} 占位符（学生作文正文）' };
  if (content.length > 20000) return { ok: false, error: '提示词过长' };
  return { ok: true };
}
```
`fillTemplate` 里再加一道运行时断言：模板不含占位符时**回退内置默认**并 `console.warn`，不要静默拼出空作文。

**验收** 保存不含 `{essay}` 的自定义提示词 → 400 明确报错；历史数据即使已存在，批改时回退默认模板且日志有 warn。

### [x] P1-4 详情接口不再返回 `ocr_images`（前端从不读取）

**位置** `src/routes/essays.ts`（`GET /essays/:id` 的 `SELECT d.*` 与响应映射）、`src/index.ts`（`/api/*` 缓存头）

**现状** 每稿最多 3 张 × ≤400K 字符原样返回。全仓库只有 `public/js/essay.js` 保存稿件时**写入**该字段，渲染从不读取。三稿就白带 ≈3.6MB；D1 单行上限 2MB，再宽会写失败，正好触发 P0-3 的资损链路。

**改法**
1. 详情响应把 `ocr_images` 换成 `ocr_image_count: number`。
2. 新增 `GET /api/drafts/:id/images` 返回该稿原图数组，前端「查看原图」时按需拉。
3. `src/index.ts` 给 `/api/*` 统一加 `Cache-Control: no-store`（现在没有，用户数据可能被浏览器缓存）。
4. 顺手把 `polishes` 也在响应里收敛（前端同样未用完整 `result`，若确认未用则只回 `id/mode/created_at`，需要时单独取）。

**验收** 三稿带图的作文，`GET /api/essays/:id` 响应体 < 200KB；工作台照常可用。

### [x] P1-5 并发锁加 TTL 与 owner token

**位置** `src/utils/inflight.ts`、调用点 `src/routes/essays.ts`

**现状** `tryAcquire` 只写 `set(userId, true)`，只有 `finally` 里的 release 会删。请求若在 finally 前被平台终止（isolate 回收、CPU 超限、连接中断），键永久残留 → 该用户所有批改都 429「已有批改任务进行中」，直到 isolate 换代。另外文件头注释写"免费/BYOK 不锁"，代码是 `mode !== 'byok'`——免费档恰恰也锁，而它是主路径。

**改法**
```ts
const inflight = new Map<string, { ts: number; token: string }>();
const LOCK_TTL_MS = 3 * 60_000;

export function tryAcquire(userId: string): string | null {
  const cur = inflight.get(userId);
  if (cur && Date.now() - cur.ts < LOCK_TTL_MS) return null;
  const token = crypto.randomUUID();
  inflight.set(userId, { ts: Date.now(), token });
  return token;
}
export function releaseSlot(userId: string, token: string | null): void {
  if (!token) return;
  if (inflight.get(userId)?.token === token) inflight.delete(userId);
}
```
调用点改成 `const lock = tryAcquire(userId)`，`finally` 里 `releaseSlot(userId, lock)`。同时把注释改成与实际一致（免费档也锁，理由是防连点吃光额度）。

**验收** 在 finally 之前抛异常模拟泄漏 → 3 分钟后同一用户能再次批改。

### [x] P1-6 定位失败的 issue 不丢弃，标记后展示

**位置** `src/utils/validate.ts`（`sanitizeReview` 的 quote 命中校验）、`public/js/essay.js`（问题清单渲染）

**现状** `if (!hit) continue;` —— quote 差一个标点、大小写、弯引号就整条丢掉，前端完全不知道少了什么；`issues` 还封顶 10 条，若前几条恰好定位失败，学生只拿到 7 条。

**改法**
1. `sanitizeReview` 保留条目，加 `located: boolean`；未命中的仍进数组（受 10 条上限约束，但排在后面）。
2. 前端：未定位项不画原文高亮，卡片上加 `<span class="chip">原文中未找到，可能含特殊字符</span>`，仍展示 explanation 与 correction。
3. 服务端统计 `issues_dropped = 未命中数 / 总数`，写进 `reviews.meta`（见 P1-11），超过 0.3 告警。

**验收** 构造一个 quote 带弯引号的批改结果 → 该条仍显示在清单里，标注"未在原文找到"。

### [ ] P1-7 限流计数落 D1（内存 Map 在多 isolate 下双向失效）

**位置** `src/utils/rate-limit.ts`、`src/routes/essays.ts`（`guestIpLimitHit`）

**现状** `guest:ip:*` 是"清 cookie 重置次数"的唯一兜底，但只活在一个 isolate，换代即清零；`ai:agnes:global` 18 RPM 同理——多 isolate 时实际是 18×N（打爆共享额度），单 isolate 热点时又会误拒正常用户。

**改法** 把这两类计数落 D1：
```sql
CREATE TABLE IF NOT EXISTS rate_events (
  key TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, day)
);
```
用 `INSERT INTO rate_events(key,day,n) VALUES(?,?,1) ON CONFLICT(key,day) DO UPDATE SET n = n + 1 RETURNING n` 判阈值。内存层降级为"最快路径预筛"（先查内存，命中才查 D1，避免每次 AI 调用多一次写）。
`quota_events` 不受影响，所以真正受损的只有 Agnes 共享额度与防滥用——别把这两件事混为一谈。

**验收** 两个不同 isolate（可用两个 colo 反复请求）下 `guest:ip` 计数一致。

### [ ] P1-8 OCR 畸变在确认页高亮

**位置** `src/routes/ocr.ts`（返回结构）、`public/js/essay.js`（OCR 确认页）

**现状** OCR 结果进"可编辑确认页"，但学生很难看出 model 把 `through` 读成 `throuqh`。这个畸变会被当成本人的拼写错误写进 issues，反过来"教"他去改一个自己没写错的词。

**改法**（纯前端，零 AI 成本）
1. 内置约 3-5k 高频词表（`public/data/common-words.txt`，一行一词即可）。
2. 确认页对每个 token 做：不在词表 + 与词表中某词编辑距离 ≤2 且首字母相同 → 标黄底 + `title="可能是识别错误"`。
3. 只标不自动改（禁止 AI 擅改原文的既有原则）。用户手动改完高亮消失。

**验收** 把 `environment` 改成 `enviroment` 塞进确认页 → 该词高亮。

### [ ] P1-9 巩固练习加"自己对照"模式

**位置** `src/utils/prompts.ts`（`practice` 已出 3-4 题）、`public/js/essay.js`（练习区渲染）

**现状** 学生写完没有对答案的入口，只能眼对参考译文，无法判断"我这句算不算对"。出题花的 token 白费一半。

**改法**（先做零成本版）
- 练习区加输入框；点「对照」后并排展示学生答案与参考答案，并标出参考答案里**学生未覆盖**的目标词/结构（大小写不敏感的子串匹配即可）。
- 不做 AI 判分。若后续验证有人用，再走一次轻量调用（只比对本组 3-4 句，成本约批改的 1/5）。

**验收** 输入"我昨天去了公园"式的中式英译，对照面板标出漏掉的 `yesterday` / 时态标记。

### [ ] P1-10 统一结构化调用封装 + 不再回吐上游原文

**位置** `src/routes/essays.ts`（精修/润色的 attempt 循环）、`src/utils/ai.ts`（`friendlyAIError`）

**现状** 精修/润色吞掉 `lastErr` 直接 throw，attempt 序号、模型、lane、耗时全丢；`friendlyAIError` 对未知错误 `return raw.slice(0, 300)`，BYOK 的 401/400 报文（含 endpoint、模型名、key 前缀）直接进前端 toast。而 `ocr.ts` 已明确反其道（"不透传上游原始报文"），两处策略不一致。

**改法**
1. 抽 `runStructuredCall({ label, cfg, prompt, maxOutput, temperature, sanitize, deadline })`，内部封装 attempt 循环、错误分类（配合 P1-1）、日志。review / 精修 / 润色 / OCR 四处复用，预计消掉约 200 行重复。
2. `friendlyAIError(err, { exposeRaw = false })`：对外只给分类文案 + `traceId`，原始报文只进日志。

**验收** 配一个错误 key 触发 401，前端看到的是"AI 配置无效，请到设置检查 KEY"，不含 baseUrl。

### [ ] P1-11 结构化日志与关键路径埋点

**位置** `src/index.ts`（`logger()`）、`src/routes/essays.ts`（写 reviews 处）

**现状** `app.use('*', logger())` 对每个静态资源打两行（observability 已开 persist，既存储又计费），真正需要的慢请求/失败样本被淹没。`callAI` 拿到了 `usage` 却只用于 settle，`reviews` 只存 `model` 字符串。

**改法**
1. `logger()` 只保留 `/api/*`（或仅 DEV 环境）。
2. `reviews` 加列 `meta TEXT`（JSON）：`{ elapsed_ms, attempts, prompt_tokens, completion_tokens, issues_total, issues_unlocated, prompt_source }`。批改成功时写入（配合 P0-3 的 batch）。
3. 出口打一条结构化日志：`{ evt: 'review.end', reqId, userId, lane, model, attempts, durMs, status, code }`；`reqId` 取 `cf-ray` 或 `crypto.randomUUID()`，存进 `Vars`。

**验收** 从 `wrangler tail` 能按 reqId 追一条完整批改链路；能算出近 7 天平均耗时与失败率。

### [ ] P1-12 PDF 中文字体改为本地托管 + 子集

**位置** `public/js/export.js`（`NOTO_FONT_URL`、`ensureNotoFont`）、`wrangler.toml`（无需改，assets 自动服务 `public/`）

**现状** `NotoSansSC-Regular.otf` 全字库走 CDN，缓存只存在 `_libs.notoFont` 内存变量，刷新即失。学生 4G 导一份 PDF 先花近 10MB。

**改法**
1. 字体放 `public/fonts/NotoSansSC-Regular-subset.otf`（GB2312 子集约 2-3MB 即可，CJK 扩展字基本用不到）。
2. `export.js` 改为 `fetch('/fonts/...')`，`font-src 'self'` 已经允许。
3. 给静态资源加长缓存：`app.all('*')` 里对 `/fonts/`、`/css/`、`/js/` 且带 `?v=` 的请求设 `Cache-Control: public, max-age=31536000, immutable`。
4. 顺手加分阶段文案：「① 载入排版组件 → ② 下载字体 → ③ 生成文件」，别让学生以为没点上。

**验收** 首次导出后刷新再导出，Network 里字体走 `from disk cache`。

---

## P2 — 打磨与可维护性

### [ ] P2-1 抽 `withHold()`，收敛 essays.ts（787 行 → 约 450 行）
四个 handler 各抄一遍 `hold → attempt → settle → release → finally`（review / 精修 / 全文润色 / OCR）。精修与润色几乎逐行重复。先做 P1-1、P1-10 再抽，避免一边抽一边改逻辑。

### [x] P2-2 `fillTemplate` 改单次正则替换
现在是 `split/join` 顺序替换，正文含 `{word_count}` 字样会在后续轮被吃掉，末尾还有条正则清残留。改：
```ts
return template.replace(/\{(topic|essay|word_count|previous_feedback|fragment|instruction)\}/g,
  (_, k: string) => vars[k] ?? '');
```

### [ ] P2-3 加 cron 清理
`quota_events` 只增不减；`polishes` 全量永久保留（`LIMIT 20` 只限读取）；`polishes.draft_id` 无 FK，删稿后留孤儿行；`wrangler.toml` 没有 `[triggers] crons`。加一个每日 cron：清 >90 天的 `quota_events`、清 `draft_id` 已不存在的 polishes。

### [x] P2-4 列表接口别为拿一个 score 取整份 JSON
`SELECT r.result` 之后只用 `score`。改 `json_extract(result,'$.score')`，或把 score 落独立列（批改成功时更新）。同时加 `LIMIT 200`。

### [ ] P2-5 统一 429 语义
`guest_ip_limit` / `concurrent_limit` / `rate_limited`（这条连 code 都没有）都是 429 但语义完全不同。统一 `{ code, retry_after }`，前端才能给"等 N 秒再试"。

### [x] P2-6 `parseJsonField` 的 catch 加日志
现在静默返回 fallback，批改结果损坏时前端渲染空白且无迹可查。catch 里 `console.warn` 带 review id。

### [ ] P2-7 同步 CLAUDE.md 与代码
CLAUDE.md 写 120-150 词 / 25 分，代码写 200-500 并封顶 22。P0-1、P0-5 做完后必须同步文档——给 Agent 读的地图一旦和代码打架，下次改动会继续放大分歧。另外 `GET /api/auth/dev-session` 建议再加一个独立 secret 校验（现仅靠 `ENABLE_DEV_SESSION=1` + 固定 cookie 值）。

---

## 新增功能（不在修 bug 范畴，按性价比排序）

| 功能 | 成本 | 最小可行版 |
|---|---|---|
| **错误画像** | S | 数据已在 `reviews.result.issues[].type`。一条聚合 SQL（按 type 分组计数、标"第 N 次犯"）+ 一个条形榜页面。 |
| **批改质量反馈** | S | 每条 issue 旁 👎 + 三选一原因（改错了/不是我的错/太笼统），新建 `issue_feedback` 表。这是提示词迭代和回归样本的唯一来源。 |
| **老师/家长版一页纸** | S/M | 复用 `export.js` 的 docx 管道，只输出「分数+档位+5 条扣分处+一句话建议」，A4 一页。 |

---

## 明确不做（别自作主张加）

| 想法 | 理由 |
|---|---|
| 班级 / 多人协作 / 排行榜 | 有第二个人就要权限、共享、教师端、通知一整套；单租户 D1 + Workers 撑不住多租户演进。 |
| 多题型一起上 | 每个题型都要独立评分锚点、独立 validate 区间（9/9/4 现为硬编码）、独立调优。先让上海大作文做到"学生信这个分数"。 |
| 流式输出批改 | 结果是结构化 JSON，流式只把"等 60 秒"变成"看字符爬"，收益低、解析复杂度高。要解决的是 P1-2 的可恢复，不是流式。 |
| 语音 / 口语评分 | 与"作文批改"心智不在一处，另需音频链路与评分标准。 |

---

## 附：口径速查（避免再次算错）

| 项 | 值 | 出处 |
|---|---|---|
| 上海高考 Guided Writing 词数 | **200-500 词**（用户 2026-10-27 指定口径） | 用户确认；覆盖原审查的 120-150 |
| 作文满分与分项 | 25 分 = 内容 10 + 语言 10 + 结构 5 | `GENRES.total` |
| 本系统评分上限 | **22**（内容≤9/语言≤9/结构≤4），刻意压分 | `prompts.ts` 评分纪律 |
| 游客额度 | 3 次/日 = 每天 1 篇 × 一稿/二稿/三稿，每稿成功 1 次 | `quota.ts` |
| 登录用户免费额度 | 10 次/日 | `quota.ts` |
| D1 单行 / SQL / 绑定参数上限 | **2MB / 100KB / 100 个** | Cloudflare D1 limits |
| 单张图上限 | 400,000 字符 data URL（前端压到 ≤300KB 二进制） | `MAX_IMAGE_CHARS` |
| AI 调用超时 | 90s（P1-1 建议降到 40s） | `ai.ts` |
| Cloudflare 客户端空闲超时 | 约 100s，超出 524 | 平台行为 |
