# SECURITY.md — 攻防对抗审计报告（2026-10-30/31）

> 本轮以攻击者视角对 **english-writing-assistant** 与 **Yuer6327-billing** 做了全面攻防演练：
> 全程在本地 wrangler dev + 本地 D1 + 本地 mock AI 上进行，**零真实上游调用**
> （Agnes / DeepSeek / 百度 OCR 的密钥全部替换为占位符，演练后已还原）。
> 攻击套件保留在仓库中，可随时复跑作为安全回归：
>
> ```bash
> node scripts/security/mock-ai.mjs &                 # 本地 mock AI（:9101）
> node scripts/security/attack-writing.mjs            # writing 全套件（:8788）
> node scripts/security/attack-billing.mjs            # billing 资金套件（:8789）
> ```
>
> 最终结果：**writing 37 PASS / 0 FAIL · billing 23 PASS / 0 FAIL**

---

## 一、攻击面与守住的部分（无需修改）

| 攻击面 | 攻击方式 | 结果 |
|---|---|---|
| 横向越权 | 双账号互访 essay/draft/review/images/polish | 全部 404/403，数据未破坏 |
| 游客访问登录专属能力 | polish/prompts/settings/billing/redeem | 401/403 正确分流 |
| 伪造会话 | 猜测/伪造 `s` cookie | 回落游客态，不 500 |
| admin 越权 | 普通用户打 admin 接口 | 403（role 来自统一认证） |
| 非法路径参数 | NaN/负数/超大/小数/十六进制/科学计数 | 全部 4xx，无 5xx |
| SQL 注入 | UNION/条件探针走路径与表单 | 参数化挡下，无 5xx |
| 存储型 XSS | 标题/题目/稿件注入 HTML | 服务端原样存储 + 前端全部 `escapeHtml` + CSP（无 `unsafe-inline` 脚本）双保险（渲染路径逐个核对过） |
| AI 输出投毒 | mock 返回 HTML/越界分/50 条超长 issue | `sanitizeReview` 钳制 9/9/4、总分≤22、10 条封顶、长度截断 |
| 提示词注入 | 自定义提示词缺 `{essay}`、作文内嵌 `{essay}` 字面量 | 保存 400；`fillTemplate` 单遍替换不展开 |
| BYOK 密钥泄漏 | status/billing/me 响应找明文 Key | 均不回吐；上游报错也只给分类文案 |
| BYOK 端点滥用 | file:// / 带凭据 / 非 https / 超长 | 全部 400 |
| CORS / CSRF | 任意 Origin 反射、跨源写 | 不发 ACAO；写请求 403 |
| 兑换码 | 重放、跨用户、爆破 30 次 | 单次核销；409；无 5xx |
| 游客同稿并发批改 | 双并发 review | 恰好一次（唯一索引/NOT EXISTS/并发锁） |
| 游客并发建稿 | ×5 并发 | ≤3 稿、版本唯一 |
| 会员日额度 | 11 连批 | 第 11 次 409 |

## 二、本轮发现并已修复的漏洞

### F1【严重·资金】billing `release()` 无认领守卫 → 并发双重退款
- **实测**：12 笔 hold 并发 settle×2 + release×2，受击用户余额**凭空增加**（12 笔净额全为正）。
- **根因**：`release` 先 SELECT 看状态再无条件 `UPDATE status='released'` + 退款；两个并发 release（或 release 与 settle/cron 交错）都读到 `active`、各自退一次。
- **修复**（Yuer6327-billing/src/wallet.ts）：release 改为先认领 `UPDATE holds SET status='released' WHERE id=? AND status='active' RETURNING frozen`，没抢到的一律走幂等语义零退款；退款 batch 失败时把 hold 还原回 `active` 交给 cron 兜底。

### F2【中·健壮】billing 数值入口不设防
- 负数/NaN/Infinity/1e15 的 `estInputTokens / maxOutputTokens / calls` 直接进定价与 SQL。
- **修复**：`/internal/hold` 边界校验（负数与非有限值 400）；`estimateHoldCost` / `actualCostMicro` / wallet `calls` 全部钳制（token≤1e6、calls≤100、非有限→默认/0），上游 usage 异常值无法炸 SQL 或算出 NaN 账目。

### F3【中·滥用】游客建作文/OCR 无 IP 级兜底
- 清 cookie 即新身份，`guest:ip` 计数原来只挂在批改上；实测同一 IP 轮换 cookie 连建 20 篇（每篇可带 3×400KB 图片），可无限消耗 D1 存储与百度 OCR 免费额度。
- **修复**（writing）：建作文、OCR 均挂 `guestIpLimitHit`（15 次/日、10 次/日），与批改同口径。

### F4【中·限流绕过】`clientIp()` 回落 X-Forwarded-For 首跳
- XFF 首跳是客户端可伪造的头；一旦被采信，`guest:ip` 限流按假 IP 分桶，轮换即失效。
- **修复**（writing/src/utils/rate-limit.ts）：只信 Cloudflare 注入的 `CF-Connecting-IP`（边缘会覆盖客户端伪造值）；取不到统一落 `unknown` 单桶。

### F5【中·TOCTOU】游客并发建作文可超每日 1 篇
- 门禁「先 count 后 insert」无互斥；同一游客 cookie 并发 3 请求实测建出 3 篇。
- **修复**（writing/src/routes/essays.ts）：插入后回收——查今日名下全部作文，只保留 id 最小的一篇，其余由各自请求自删并回 403（确定性收敛，无二次竞态）。

### F6【低·信息泄漏】上游原始报文透传
- `ocr.ts` 的 `details: lastErr.slice(0,300)`、`aiConfigFail` 的 `details: err.message` 会把内部/上游报文（可能含端点、路径线索）回给前端。
- **修复**：响应只留分类文案，原文仅进日志（与 ocr.ts 既有的「不透传上游报文」原则对齐）。

### F7【低·输入面】data URL MIME 收紧
- 旧校验接受 `data:image/svg+xml`。SVG 内可携带脚本（`<img>` 引用虽不执行，仍属可少收的输入面）。
- **修复**：`validImages` / OCR `parseDataUrl` 均改为位图白名单（png/jpeg/webp/gif/bmp/heic/heif/avif）。

### F8【低·计费精度】免费档中文 token 低估 → 系统性少冻结
- `chars/3` 对中文低估约 2 倍（DeepSeek 中文 ≈0.6 token/字），结算走「补扣」让余额变负，平台默默吃亏。
- **修复**（writing/src/utils/limits.ts）：新增 `estimateTextTokens`（CJK 0.6 token/字 + 其他 0.25/字符），批改/润色/OCR 三处统一换用；高估部分 settle 自动退差。

### F9【基础设施·本地联调】dev registry 不可靠的回退
- Windows 下 wrangler 多 worker dev registry 偶发 `Network connection lost`。
- **修复**：新增两个**仅本地生效**（生产绝不配置，`ENABLE_DEV_SESSION=1` 同款门禁）的变量：
  - `DEV_AGNES_BASE_URL`：免费档 AI 指向本地 mock（`agnesBaseUrls(env)`，须 `ENABLE_DEV_SESSION=1`）；
  - `DEV_BILLING_URL`：billing 客户端改走 HTTP 直连，绕开 dev registry。

## 三、测试自身的教训（已固化进套件）

1. **不带 cookie 的并发请求各自是新游客**——「同游客并发」必须先领 cookie 再并发（B3 踩过）。
2. **mock 模式文件跨轮残留**——套件启动时强制复位 `mock-mode.json`（byok 组的 401 模式污染过 quota 组）。
3. **内存限流桶跨轮残留**——每轮套件用随机 `CF-Connecting-IP` 隔离 IP 桶；AI 调用间 3.5s 节流避免撞 18 RPM。
4. **账本口径**——hold 的冻结扣款行 `ref_id` 为 NULL，按 ref_id 聚合净额会漏掉扣款；资金不变量应查「每笔 hold 的 refund 行 ≤1」。

## 四、遗留风险与上线检查清单

| 项 | 状态 | 说明 |
|---|---|---|
| `INTERNAL_TOKEN` 生产必须配置 | ⚠️ 需人工确认 | billing `/internal/*` `/admin/*` 与 essay→billing 调用共享口令；本地未配置属预期 |
| billing 无公网入口 | ✅ 已确认 | `workers_dev = false` + `preview_urls = false` + 无 routes；部署后可 `curl https://<workers.dev>/health` 应 4xx |
| `/api/auth/dev-session` | ✅ 双门禁 | `ENABLE_DEV_SESSION=1` + AUTH_DB 存在测试会话行；生产两条件均不满足。仍建议部署后抽查 404 |
| 限流计数在内存（多 isolate 各一份） | 已知取舍 | AUDIT P1-7（落 D1）仍未做；本轮修复不依赖它 |
| `takeoverGuestData` | 安全 | 游客 id 为 128-bit 随机，不可枚举 |
| BYOK baseUrl 允许 loopback http | 安全 | Workers 运行时无 loopback 网络可打；仅本地联调用 |

## 五、本轮不改动但值得后续做的（接 AUDIT.md）

- P1-7：限流计数落 D1（多 isolate 下内存桶是近似保护）。
- P2-5：统一 429 语义（`code` + `retry_after`），前端可倒计时。
- billing `redeem`：核销（guarded UPDATE）与入账（credit+order）分两批，中间崩溃会「码烧了钱没到」；可合并进一个 batch（先 claim 后，同批写入）。
- `expireHolds` 认领与退款 batch 之间崩溃会留下「expired 未退款」的 hold；可加对账查询兜底。
