# 多系统连接审查报告（原生 / 高效 / 安全）

> **状态注记（2026-11-07）**：本报告的阶段 0/1 主体已实施（S1 validate 端点+消费方迁移、S2 per-caller 令牌、阶段 0 九项、红队与两轮审计修复），以下行号为报告当日快照仅供追溯；文末「下一份该写的东西」作废。

- **日期**：2026-11-07
- **方式**：6 个并行只读审查子代理独立取证（auth 本体 / 博客集成 / 写作助手集成 / billing 本体与契约 / 横切信任架构 / 未来平台接入模式），全部为静态代码审查，行号为当日快照，后续提交可能漂移。
- **对象**：auth（`D:\fuwari-cf\auth`）· 博客（`D:\fuwari-cf`）· billing（`D:\OneDrive\桌面\play\codes\Yuer6327-billing`）· 写作助手（`D:\OneDrive\桌面\play\codes\english-writing-assistant`）· dns-guard（`D:\fuwari-cf\dns-guard`）
- **本文件结构**：§0 速览 → §1 拓扑 → §2 三个结构性决策 → §3 故障耦合 → §4 分系统明细 → §5 高效性 → §6 接入模式 → §7 路线图 → §8 收敛点说明

---

## 0. 结论速览

**总评**：这套「auth + billing + 多个子域平台」的连接模型今天是能跑的、且不少细节做得比行业平均水平好（恒时 token 比对、hold/settle CAS 幂等闭环、对账 cron、fail-closed 四处拦截、博客侧优雅降级）。但它建立在三个**为省事而生的信任决策**上——消费方直查 auth-db、单把 INTERNAL_TOKEN、根域共享 cookie——三者叠加后，**任何一个子域 Worker 被打穿 = 整个家族的身份库读写权 + 铸币权 + 全体用户会话**。同时「身份」与「契约」没有单源，是「模型库单源在 billing」哲学还没延伸到的两块。

**三个结构性问题（详见 §2）**：

| # | 问题 | 一句话后果 | 根治方案（三个子代理独立收敛到同一答案） |
|---|---|---|---|
| S1 | 消费方直查 auth-db（D1 绑定无只读） | 任一消费方沦陷可改 role=admin、删会话、读 password_hash | auth 出 `/internal/validate`（Service Binding 调用），消费方收回 AUTH_DB 改薄客户端 + 60-300s 缓存 |
| S2 | 三仓共享一把 INTERNAL_TOKEN | essay 泄露 = 无上限铸币（recharge 连金额上限都没有） | 拆 per-caller token：`/admin/*` 只收 auth 把，`/internal/*` 只收 writing 把 |
| S3 | 根域共享会话 cookie（30 天） | 信任半径 = `*.yuer6327.top` 全部 7 个子域 + 未来任意子域 | 长期收窄为按子域下发/SSO 跳转换票；短期立「新子域默认不信任」纪律 |

**一句话路线图**：阶段 0 止血（1-2 天，9 件小事）→ 阶段 1 信任模型收敛（S1+S2，auth 单源化）→ 阶段 2 长期项（cookie 收窄、OAuth 补齐、平台套件化）。

**做得对的（各报告一致确认，保持）**：auth token 32 字节 CSPRNG 落库裸 sha256（高熵 token 的行业标准）、挑战码 HMAC + 恒时比较、`next` 白名单含反斜杠陷阱处理、OAuth redirect_uri 精确匹配；billing 恒时比对、settle/release/expire 四方竞态 CAS 收敛、退款 NOT EXISTS 守卫、对账毒丸防御；写作助手 14 处失败路径全有 releaseQuietly、SSE abort 链路完整；博客全线优雅降级且 fail 语义有注释。

---

## 1. 全家族拓扑（实测）

```
浏览器（持根域 cookie s：Domain=yuer6327.top · Max-Age 30d · Secure+HttpOnly+SameSite=Lax）
  │  同一 cookie 自动发给 zone 内【所有】子域（信任半径 = 整个 *.yuer6327.top）
  ▼
┌─ Cloudflare zone yuer6327.top ── DNS 由 dns-guard 单一共享状态机同步切换 ─────────────┐
│  正常: 灰云 CNAME→优选外部域   全失效: AAAA 100:: 橙云占位（流量仍落各子域 Workers 路由）│
│  RECORDS 7 子域: blog / auth / writing / wordle / english / opan / zenupd             │
│                                                                                       │
│  auth Worker ══ D1 读写 ══► auth-db ◄══ AUTH_DB「直查」══ writing Worker               │
│    │  ▲                                    （blog Pages Functions 亦持 AUTH_DB 4 处）  │
│    │  └──BILLING binding──┐                （Mathle/wordle 同模式）                     │
│    │   (X-Internal-Token) │                                                           │
│    │        yuer-billing Worker（无公网路由, workers_dev=false）                       │
│    │        ▲ BILLING binding（writing 亦持同一 INTERNAL_TOKEN）                       │
│    │        ╚══ D1 ══► billing-db（钱包/账本/hold，资金真相源）                         │
│  信任方向：消费方把 auth-db 的 role/banned 当身份真相；billing 把调用方自报的           │
│  userId/operator 当真相（内网信任，零二次鉴权，billing src/index.ts:267-271）           │
│                                                                                       │
│  dns-guard Worker：GUARD_KV + CF_API_TOKEN（Zone DNS Edit，可改写全家 DNS）+ Bark 推送  │
└───────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. 三个结构性信任决策

### S1 消费方直查 auth-db【安全 P1 / 原生 P1】

- **现状**：官方接入姿势就是直查——auth-integrate SKILL.md:20-25 教消费方加 D1 绑定，`sha256(cookie) → sessions JOIN users`。同一条 SQL 在 writing（middleware/auth.ts:49-53、routes/billing.ts:88）、blog 四个 Functions（comment-identity.ts:15 / post-access.ts:37 / twikoo.ts:208）、Mathle 各复制一遍。
- **为什么是问题**：① D1 绑定**没有只读模式**，「只读」只是注释（writing wrangler.toml:26）；被入侵的消费方可 `UPDATE users SET role='admin'`、删会话、读 password_hash/totp_secret。② auth-db 的 database_id 硬编码在多仓，**同账户任意 Worker 都能按 id 绑上**——auth-db 连 billing 那道 token 闸门都没有。③ N 个应用硬编码 sessions/users 表结构，auth 侧改列即全站静默断裂，schema 演进被锁死。
- **为什么不改不行**：auth 其实**已有**对外校验面（`/api/me` cookie 版、`/api/userinfo` Bearer 版、`/oauth/token`，README.md:85-99 也写明第一方应转发 cookie 调 /api/me），但 SKILL 教的是另一条路——官方文档与官方姿势分裂。
- **根治**：auth 加 `POST /internal/validate`（Service Binding 可调，仅 binding 可达），返回版本化 `{v:1, user:{sub,username,name,role,banned,exp}}`；消费方收回 AUTH_DB 改 `[[services]] AUTH` + ~15 行薄客户端 + 60-300s isolate 缓存（封禁/登出生效延迟 = 缓存 TTL，可接受）。套路与 BILLING binding 完全同构，已被 writing 验证过。SKILL.md 同步改写。

### S2 单把 INTERNAL_TOKEN【安全 P1→P2】

- **现状**：auth（src/lib/billing.ts:34）、writing（src/utils/billing.ts:23）、billing 校验（src/index.ts:33-42，fail-closed 503，实现正确含恒时比较）共享同一把密钥。`/admin/*` 与 `/internal/*` 共用同一守卫（index.ts:44-53）。
- **为什么是问题**：essay 的 env 持有可打 billing 全部 `/admin/*` 铸币端点的口令；**recharge 端点无金额上限**（仅 assertValidPoints 1e10 微积分 = 100 万元单笔界，wallet.ts:28-36；gift 有日限 wallet.ts:742-750、codes 有批上限 index.ts:505-507，唯独 recharge 没有）。operator 字段靠调用方自报任意串（index.ts:334-336），审计「可溯源」仅对诚实调用方成立。`.prod-internal-token.secbackup` 明文 token 在 OneDrive 同步路径下随盘上云（gitignore 已覆盖但同步盘不设防）。
- **per-caller 拆分改造清单（billing 侧实测，约半小时）**：① billing types.ts:19 拆两个 secret；② index.ts internalGuard 参数化 expected token，`/admin/*` 只绑 AUTH 把、`/internal/*` 只绑 WRITING 把；③ `/internal/usage` 双方共用（e utils/billing.ts:169 与 a lib/billing.ts:227 都调），双把接受或按 header 选；④ 两个消费方各改发自己的 token；⑤ 三仓 `wrangler secret put` + 轮换 + 清掉 OneDrive 备份。
- **不建议做的**：短时 JWT / introspection / 细粒度 scope 对 2 个消费方的单人平台属过度工程（billing 侧审查结论）；binding 已是同账号同信任域，两把 token 已覆盖 90% 收益。

### S3 根域共享会话 cookie【安全 P1（长期项）】

- **现状**：`Domain=yuer6327.top`（auth session.ts:29-31，COOKIE_DOMAIN 见 wrangler.jsonc:27），30 天 TTL，`next` 白名单放行任意 `*.yuer6327.top`（login.ts:18）。7 个在役子域全部跑独立自定义 Worker。
- **为什么是问题**：HttpOnly 只防 JS 窃取，不防子域**服务端**——任一子域（含未来误部署、opan 挂的外部存储、zenupd 改写的 XML 链路）整取家族会话并可直查 auth-db 冒充任意用户。这是 SSO 便利的固有代价，不是 bug。
- **处理**：**列长期项，不现在动**（消费方过多，一次切换风险大于收益）。短期纪律：新子域上线 checklist 把「能读 s + 能查 auth-db」列为默认假设，敏感/实验性系统勿放同根域。同源 cookie cookie-tossing 一线：writing 已修（middleware/auth.ts:42-47 matchAll 取最后一个），**blog 三处仍取第一个**（comment-identity.ts:11、post-access.ts:31-33、twikoo.ts:202）——非提权（值仍须查库命中），属 fail-closed 的可用性缺陷，一行修复。

---

## 3. 故障耦合矩阵（实测）

| 故障 | auth | 写作助手 | 博客 | 说明 |
|---|---|---|---|---|
| **auth-db 挂** | 全站不可用（index.ts:22-25 会话中间件罩全部路由） | **连游客都 503**：userMiddleware 在 AUTH_DB 异常时一律 503（auth.ts:131,142），未登录访客作文 CRUD/批改全灭 | 优雅：identity 500→前端按未登录渲染；post-access 500→保守隐藏；twikoo 免拦 catch→false 回落匿名判定 | F1【P2】writing 游客路径应降级放行 |
| **billing 挂** | 后台/账户页 503 空态 fail-open 展示（lib/billing.ts:31-48，2500ms 超时） | **核心功能全停**：hold 失败即 503（essays.ts:647-659），**免费档同样要过 hold**（essays.ts:639-649），catalog 非硬编码车道 503（api-config.ts:126-130） | 无依赖（全仓 0 处 billing 引用，正确） | F2【P2】且 api-config.ts:5 注释「billing 不可用时免费链路仍可用」**与现实矛盾**（Agnes key 也来自 billing.config） |
| **dns-guard 全失效** | — | — | — | F3【P2→可接受】AAAA 100:: 橙云占位后流量仍落 CF 边缘、各子域自己的 Workers 路由出内容，**无中断**。真实风险：单一状态机一次错误决策 7 子域同步遭殃（applyAll）；CF_API_TOKEN 泄露 = 全家 DNS 可改写 |
| **部署顺序** | 依赖 billing 先在 | 依赖 billing 先在 | — | F4【P2】约束只写在注释（auth wrangler.jsonc:20-24、writing wrangler.toml:68-71），无 CI 校验；跨仓无原子但 essay 侧 503 兜底 + catalog 5min TTL 可接受 |

---

## 4. 分系统发现明细

### 4.1 auth 本体（14 项）

**P1**
1. 【安全】消费方直查 auth-db = 每应用整库读写权（SKILL.md:20-25；D1 无只读）→ 见 §2 S1。
2. 【原生】对外校验面已存在但与官方接入姿势分裂，schema 耦合无版本化（/api/me、/api/userinfo、/oauth/token 于 oauth.ts:230-280；README.md:85-99 vs SKILL.md:22-24）→ 与 1 合并根治。

**P2**
3. 【安全】密码登录无 Turnstile（web.ts:113-137，views/auth.ts:4 自认），撞库仅靠限流（lp:ip 10/10min、lp:acct 5/15min，web.ts:118-129）。建议照 register 现成模式补（web.ts:229-230）。
4. 【安全】资金与管理写操作无 step-up 再认证：充值/扣减/设定余额仅 adminGuard（web.ts:1662-1671、659-664），30 天会话内 cookie 被窃即可动钱。建议 billing.manage/users.manage 写操作要求近 N 分钟重验密码或 TOTP（可复用 totp_ticket 挑战）。
5. 【安全】会话无轮换、无滑动续期，固定 30 天（session.ts:6、43-51）。敏感操作后轮换 token；可加滑动续期 + 缩短绝对上限。

**P3**
6. 【安全】admin 重置密码明文进 URL query（web.ts:832-838；client add 的 secret 同病 web.ts:1111）→ 改 flash 一次性展示。
7. 【原生】OAuth 供给缺口：无 PKCE、无 per-app scope（schema.sql:81-87 无 scope 列，授权页三行写死 views/authorize.ts:9-13）、无撤销端点。第三方接入需求出现时再补。
8. 【高效】oauth_tokens 永不 GC（gcExpired 只清四表 util.ts:69-74）→ batch 里补一条 DELETE。
9. 【高效】/avatar/:id 等公开高频路由跑会话中间件（index.ts:22-29），博客评论区每条评论的头像都白跑一次 → 照 fonts 先例（index.ts:15-19）短路公开 GET。
10. 【安全】D1 限流非原子（ratelimit.ts:3-19 先 SELECT 再写）→ 有兜底可接受，或改条件 UPSERT。
11. 【安全】CSRF = Origin 头 + SameSite=Lax，无 token（index.ts:32-41）→ 现状可接受；若收敛优先给 /admin 写路由加 token。
12. 【安全】根域 cookie 信任域 = 未来所有子域（session.ts:30、login.ts:18）→ 见 §2 S3。
13. 【安全】token 哈希无 pepper（session.ts:48、oauth.ts:207）→ 高熵 token 下盐无意义，现状正确；若加 HMAC pepper 会同时断裂直查模式，与 S1 是同一件事。
14. 【原生】并发会话无设备元数据（schema.sql:23-28），用户自助只有全杀（web.ts:639-644）→ 加 device/last_used 列，支撑会话列表与轮换。

### 4.2 博客（11 项）

**P2**
1. 【安全】**评论显示身份未与会话绑定，可冒充**：nick/mail 是客户端断言（Layout.astro:824-825 写 localStorage），proxy 只用 session 决定免拦；合成邮箱规律固定 `{id}@comment.yuer6327.top`（comment-identity.ts:24），他人可把 mail 改成受害者合成邮箱 → 头像映射出受害者统一头像。**建议：twikoo.ts 对已登录 COMMENT_SUBMIT 服务端覆写 body.nick/body.mail——当前唯一「可冒充他人身份」的实际攻击面，改动小收益大。**
2. 【安全】`s=` 三处取首个 match（comment-identity.ts:11、post-access.ts:31-33、twikoo.ts:202），writing 已修取最后（auth.ts:42-47）→ 一行对齐。
3. 【原生】auth 集成样板 4 处复制、3 条 SQL 各写一遍、3/4 端点无测试（仅 post-access 有 test-post-access.mjs）→ 抽 `functions/lib/auth-session.ts` 一处维护。
4. 【高效】直连 auth D1 零延迟零成本可接受，但无契约：auth 改表/改 hash 即静默断裂 → schema 契约（表/列/hash 规则/fail 语义）写入 auth 侧文档 + 4 端点集成测试。
5. 【安全】twikoo 代理 CSRF 面：不校验 Content-Type（twikoo.ts:302-309），text/plain 表单可跨站提交；跨站是否带 `s` 取决于 SameSite（docs/comment-quality-guard.md:37 只记 Secure;HttpOnly，SameSite 待确认）。→ proxy 对 COMMENT_SUBMIT 加同域 Origin 校验（Origin 已取到 twikoo.ts:332，成本低）。

**P3**
6. 【原生】auth 域名硬编码 6 处（AccessGate.astro:39、AccountPanel.astro:13/24/45、comment-identity.ts:27、comment-avatars.ts:27）→ 常量化。
7. 【一致】`next` 回跳两套口径：AccessGate.astro:39 只带 pathname 丢 query，AccountPanel.astro:45 带 pathname+search。
8. 【一致】授权名单是构建期快照（src/utils/post-access.ts:121-128），用户改名/角色变更需重建博客 → docs 注明，或名单迁运行时查库。
9. 【安全】access 文章封面/正文图片文件无门禁（docs/access-image-leak-audit.md #4/5/6 既有审计未修）→ 按方案 A/B 落地。
10. 【高效】首页每张受限卡各打一次 /api/post-access 各 1 次查询（Layout.astro:2070-2089）→ 受限卡多时加批量端点，现状体量可不改。
11. 【原生】dev 特判三套口径（Layout.astro:805/815/2049）→ 统一一个 dev 探测常量。

### 4.3 写作助手（12 项 + 可搬走性 + 成本基线）

**P2**
1. 【高效】billing.config 不缓存：每次 AI 请求 1 次跨 Worker 调用（api-config.ts:104），对比 catalog 有 5min isolate 缓存（api-config.ts:49-62）→ 按 (userId,serviceId) 缓存，免费档可全局缓存。
9. 【高效】批改上游调用无硬闸：注释称「最多 ~6 次」（essays.ts:614），实际 3 采样 + 双通道语义检测 + 双通道预清洗 + B 盲评 + 主调用含重试 = 最多 ~10 次（essays.ts:924-926、797-816、819-830、894、1035-1042）→ 修正注释 + per-lane calls 硬顶。

**P3（节选，全 12 项）**
2. 免费档 hold 是空操作仍付 1 次内网调用（essays.ts:649-656 skipQuota 仍调 hold、:1147 无 settle；本地跳过先例 ocr.ts:85-96）。⚠️ 落地前实查：billing 侧审查发现 free 用量行在 hold 时即写（b/src/wallet.ts:151-166），若本地跳过 hold，billing 失去免费档报表——需先把 0 元记账改显式端点或接受盲区。
3. api-config.ts:5 注释「billing 不可用时免费链路仍可用」与现实矛盾（Agnes key 来自 billing.config，hold 失败一律 503 essays.ts:657-659）→ 改注释或对 Agnes 配置本地缓存。
4. 会话校验零缓存：每 API 请求 1 条 AUTH_DB 查询（auth.ts:49-53），essay 页加载 ≥3 条 → 30-60s isolate 缓存；无 s cookie 的游客请求可显式短路。
5. settings 页重复拉 /api/auth/me（api.js:242 强刷一次 + settings.js:29,83 绕过缓存再拉）→ 复用 requireAuth 返回值。
6. settle 已返回 balance（billing.ts:74）但批改响应只透传 points_charged（essays.ts:1157,1308），前端扣费后全量重拉 me 刷新余额（api.js:254-263）→ 余额塞进批改响应。
7. 一次性迁移端点 /api/billing/admin/migrate-byok 仍在生产路由（billing.ts:198-235）→ 确认线上迁移完成后删除。
8. 普通用户自助 BYOK 走 billing 的 /admin/byok/set（settings.ts:69,81 → billing.ts:187-195）→ billing 拆 /internal/byok/set，/admin 只留管理员动作。
10. INTERNAL_TOKEN 可选（types.ts:19；billing.ts:23 仅配置时附头）→ 生产强制，billing 拒收无令牌。
11. 免费档用量明细：billing 侧在 hold 即写 free 用量行（wallet.ts:151-166），settle 级 usage 明细缺失；两个子代理对此证据有出入，落地前以 wallet.ts 实查为准。
12. 双额度体系并存：quota_events「成功才计数」（quota.ts:1-16，0002 迁移自述与 billing 口径分歧）+ 游客 IP 兜底 per-isolate 内存近似（rate-limit.ts:4-5）→ 搬平台时随行，滥用升级换 DO/KV。

**可搬走性（未来平台的复制清单）**
- `utils/billing.ts`（231 行）全通用，必改 3 处：:33 `https://yuer-billing` 常量、:30-33 dev 回退段、:162 project 默认 'writing'。
- `api-config.ts` 的 getCatalog/laneToService/laneFromBody/aiCallOpts（:49-138、:159-174）通用，必改 HARDCODED_LANES（:20-23）、AGNES_*（:26-30）、defaultLane 分支（:75-84）、agnesGlobalRateHit 特判（:102）。
- `middleware/auth.ts` 的 sha256Hex/resolveSession/两中间件（:29-59、:129-151）通用；takeoverGuestData（:83-111）混入 essays/drafts 表名（:98-103）需参数化。
- 402 处理分散三处（essays.ts:60-66、rate-limit.ts:108-118、api.js:51-54）且 rate-limit.ts:10 反向 import BillingError → 收敛进 billing.ts 再整体搬运。
- inflight.ts 通用。

**每请求成本基线**（代码推演）：登录用户免费档批改一次 = 跨 Worker 2（config+hold）+ AUTH_DB 1 + 业务 D1 9-11 + 上游 AI ≤10；付费/LongCat +settle = 3 次跨 Worker。页面加载：首页 ≈ AUTH_DB 2 + 业务 D1 4 + billing 1；essay 页另加 /api/billing/me = AUTH_DB 1 + billing 2。

### 4.4 billing（20 项，含确认良好项）

**P1**
7. 【高效】**D1 绑定参数上限风险**：stats.ts:295 注释称「D1 变量上限 999」（那是 SQLite 裸默认），idsClause slice(0,500)（stats.ts:295-302）、userStats 500（:519）、/admin/wallets 200（index.ts:371）；auth 组页把整组成员展开传 ids（a/lib/billing.ts:183）——**D1 平台限制为每查询 100 个绑定参数，成员 >100 的组筛选会直接 500**（唯一按文档推断未实测项）→ 切片 ≤90 或临时表 JOIN。

**P2**
2. 【安全】`/internal/*` 与 `/admin/*` 共用守卫同一把 token + recharge 无金额上限（index.ts:44-53、310-520；wallet.ts:28-36）→ 见 §2 S2 拆分清单。
6. 【安全】hold 无幂等键（index.ts:87-123 未收 idempotency key，holdId 服务端生成 wallet.ts:189）→ 可加可选 idempotencyKey + UNIQUE 列，或接受现状写入契约（自愈窗口 ≤10min TTL，方向是冻住非丢钱）。
20. 【安全】`.prod-internal-token.secbackup` 明文 token 在 OneDrive 同步路径（gitignore 已覆盖 .gitignore:8，但同步盘不设防）→ 密码管理器/移出仓库树，随 per-caller 拆分一并轮换。

**确认良好（实测代码，勿重复怀疑）**
8. settle 幂等闭环完整：CAS 认领 active→settled（wallet.ts:433-435）、重放按 usage_logs 如实报（:411-417）、缺 usage 行交 cron 防双退（:407-410）、退款 NOT EXISTS（:456-468）、补扣按 note 判别（:476-484）、失败回滚翻 active（:499-503）、四方竞态收敛（:437-452）。
9. release/expireHolds 同三件套（wallet.ts:515-568、573-609）；TTL 10min > budgetMs 300s，迟到 settle 按 0 收/全额退（:418-421）。
10. 对账覆盖 settled/released/孤儿 hold/孤儿兑换码/账实漂移告警 + 毒丸防御（wallet.ts:290-368）；仅 debit 两语句间崩溃留人工补（:100-114，注释自认可接受）。
12. fail-closed 四处拦截核实（index.ts:164/246-248/202/143）+ secret 缺失 fail-fast；priceOverrides 换算正确（catalog.ts:238-254）。
14. essay 消费端契约质量高：错误码原样透传（essays.ts:60-66）、settle 失败不阻塞结果、14 处失败路径全有 releaseQuietly。
1. token 比对确为恒时（index.ts:20-27）。

**P3（节选）**
16. 新消费方接入需改 billing 侧两处：catalog.ts:221 `PROJECTS=['writing']` 硬编码 + index.ts:96-98 project 白名单 + 种 quota_rules——handoff §9.3 漏了 PROJECTS 改动点。
17. 契约漂移 4 处：README.md:78「单位分」vs :11「微积分」自相矛盾；README.md:39-40 RECHARGE_TOKEN 回退描述与 index.ts:57-63 矛盾；handoff §3.6 端点表缺 userId 可选字段与 503/409 错误码；§3.4/§3.5 新旧口径混存（已有「以实现为准」横幅兜底）。
11. quota 口径差：essay 免费档按「成功批改」自计，billing free 用量行在 hold 即写且失败也计 calls——admin 统计的服务分布会高估免费档调用数（钱不受影响）。

---

## 5. 高效性：已确认的冗余与优化清单

按「改动行数 ÷ 收益」排序：

1. billing.config 加 isolate TTL 缓存（写作助手 #1）——省每次 AI 请求 1 跨 Worker 往返。
2. settle 的 balance 回写批改/润色响应（写作助手 #6）——消掉每次扣费后整轮 /api/auth/me。
3. settings 页复用会话（#5）——每页省 1-2 次 me。
4. auth `/avatar/:id` 等公开路由短路会话中间件（auth #9）——博客每条评论头像加载都在受益。
5. free 车道跳过 hold（#2，带 §4.3 #11 的记账权衡）。
6. 会话校验 30-60s isolate 缓存（#4）——注意与 S1 根治合并做，避免做两遍。
7. 首页受限卡批量 post-access（博客 #10）——体量大了再说。

---

## 6. 未来平台接入模式

**现状：从零接入 future.yuer6327.top 要 11 步，只有 auth 段有成文流程**。步骤 4（DNS）活在 dns-guard 注释里，步骤 6-7（billing/catalog）活在一次性的 billing-handoff 里，agent 要跨 4 个仓库 6 份文档拼步骤。

**复制粘贴审计**：Mathle ↔ writing 的 auth 核心 12 行约 90% 相同但零共享（JS vs TS 只能抄不能 import）；**reading 是最重的漂移证据——姊妹项目身份体系完全分叉（自建 JWT+PBKDF2，wrangler.toml 无 AUTH_DB），统一认证对它 0%**。SKILL.md L25 声称的返回形状与两个实现都不一致（Mathle 无 username、writing 无 email）。

**标准化方案对比**（两个视角：AI agent 照做 / 单人维护）：

| 方案 | 判词 |
|---|---|
| A 共享 npm 包 @yuer/platform-kit | 对单人+异构栈（1 JS + 2 TS）过度工程；等第 3 个计费平台出现、>5 平台全 TS 再说（规则：**被抄第 3 次才抽象**） |
| **B auth 出 binding 校验端点** | **推荐**：消费方只留 ~15 行薄客户端 + 1 个 `[[services]]`，与 BILLING 套路完全同构；加固（取最后 s=、banned 语义）改 auth 一处全平台生效、消费方零重发。即 §2 S1 的目标架构 |
| C starter 模板库 | 被 reading 案例证伪：复制后各自演化，模板≠标准 |
| D 文档驱动+修漂移 | 只够过渡，作 B 的底座 |

**接入 checklist v1**（B 落地前的文档驱动版，12 步含 secrets 清单与验证命令）已由子代理产出，收编目标 = auth-integrate SKILL.md；要点：routes 用 zone_name 勿用 zone_id、过渡期抄 writing auth.ts:41-59（含取最后 s=）、secrets 清单（ENCRYPTION_KEY/INTERNAL_TOKEN/项目专属）、部署顺序先 billing 后消费方、DNS 灰云 CNAME 后先确认 Workers 路由再注册 dns-guard RECORDS。

**立即值得做的三件小事**（不等 B）：① SKILL.md 增补「DNS 与 dns-guard」「billing/catalog 接入」两节 + secrets 清单；② Mathle response.js:51 改取最后一个 `s=`；③ billing-handoff §3.4/§3.5 旧口径移到文末附录。

---

## 7. 路线图

### 阶段 0：止血（1-2 天，全部小改）

| # | 事项 | 仓 | 出处 |
|---|---|---|---|
| 1 | blog 三处 `s=` 改 matchAll 取最后 + 抽 functions/lib/auth-session.ts | blog | 博客 #2#3 |
| 2 | twikoo 对已登录 COMMENT_SUBMIT 服务端覆写 nick/mail（身份冒充） | blog | 博客 #1 |
| 3 | writing 游客/无 cookie 请求在 AUTH_DB 异常时降级放行（只放游客路径，登录路径保持 503 fail-closed） | writing | 横切 F1 |
| 4 | billing.config isolate 缓存 + api-config.ts:5 / essays.ts:614 两处注释修正 | writing | 写 #1#3#9 |
| 5 | billing stats ids 切片 ≤90（D1 100 上限） | billing | billing #7 |
| 6 | recharge 加金额上限（对齐 gift 日限模式） | billing | billing #2 |
| 7 | 确认后删 /api/billing/admin/migrate-byok | writing | 写 #7 |
| 8 | 文档一次清完：billing README 单位+RECHARGE_TOKEN 两处矛盾、handoff §3.6 补 userId/503、§9.3 补 PROJECTS、api-config.ts:5 | billing/writing | billing #5#16#17 |
| 9 | .prod-internal-token.secbackup 移出 OneDrive/入密码管理器 | billing | billing #20 |

### 阶段 1：信任模型收敛（S1+S2 根治，auth 单源化）

1. auth 出 `POST /internal/validate`（binding 可调，返回 `{v:1,user:{…}}`）；SKILL.md 改写为薄客户端姿势。
2. writing / blog / wordle 收回 AUTH_DB binding，改 `[[services]] AUTH` + 60-300s 缓存（auth-db 故障时缓存 grace 放行游客——与阶段 0 #3 的降级逻辑合并设计）。**先 writing 后 blog**（Pages Functions 迁移）。
3. INTERNAL_TOKEN 拆 per-caller 两把（§2 S2 的 5 步清单）+ 全家族轮换。
4. auth 加固：密码登录补 Turnstile；billing.manage/users.manage 写操作 step-up 重验；oauth_tokens GC；会话敏感操作后轮换。
5. blog twikoo COMMENT_SUBMIT 加同域 Origin 校验（先确认 s cookie SameSite=Lax）。

### 阶段 2：长期项

1. **cookie 收窄 / SSO 跳转换票**（根域 → 按子域下发）：消费方多，一次切换风险大于收益，先以「新子域默认不信任」纪律止损。
2. OAuth 补齐：scope 列 + 动态确认页 + RFC 7009 撤销 + PKCE——第三方接入需求出现时。
3. billing.ts / api-config.ts 套件化：被第 3 个平台抄时再抽包（或平台 >5 且全 TS 统一 Hono 时升级 npm 包）。
4. dns-guard：RECORDS 以各仓 routes 为源生成；应急接口去掉 `?token=` 查询串通道（index.ts:828）；补 workers_dev 显式声明。
5. 会话设备元数据 + 账户页会话管理（auth #14）。

---

## 8. 收敛点说明（这份报告为什么可信）

三个独立子代理在互不知情的情况下推荐了**同一个目标架构**：auth 本体审查（Top3 第 1）、横切架构审查（方案 A 对比后推荐）、接入模式审查（方案 B 推荐）——三者描述的机制完全一致：auth 出 binding 可调校验端点、消费方收回 AUTH_DB 改薄客户端 + 短缓存。「catalog 单源在 billing」的既有哲学自然延伸为「身份单源在 auth、契约单源在 auth 文档」。

两处子代理证据冲突已标注、落地前需实查：① 免费档用量对 billing 的可见性（§4.3 #11）；② D1 绑定参数 100 上限的组页 500（§4.4 #7，按平台文档推断，建议实测一次 >100 成员的组）。

---

*审查子代理产出原稿（六份完整报告）见会话记录；本文件为汇总定稿。下一份该写的东西：阶段 0 的 9 个 PR。*
