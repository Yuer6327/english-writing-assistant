# CLAUDE.md — 英语作文批改助手架构指南

面向 AI 编码助手（Claude Code / ZCode 等）的项目地图。本项目为 [english-reading-assistant](../english-reading-assistant) 的姊妹项目，架构与基础设施（加密 / 限流 / AI 调用层 / SPA 前端）复用自该项目的成熟实现，业务层围绕"作文批改教学"重写。

## 线上地址与部署形态

- **https://writing.yuer6327.top/**（zone 内 Workers 路由 `writing.yuer6327.top/*`，见 wrangler.toml `routes`）
- DNS 由 [dns-guard](D:\fuwari-cf\dns-guard) 统一守护：灰云 CNAME→优选候选（当前 www.shopify.com），故障自动切换/恢复，与其他子域同步
- **统一认证**（无本地账户）：登录/注册/退出跳转 https://auth.yuer6327.top，后端直查平台 `auth-db`（binding `AUTH_DB`）的 sessions 表；cookie 名 `s`，`token_hash = sha256(cookie 值)` hex。**平台用户 id 是 UUID 字符串**，本库所有 user_id 列均为 TEXT
- 新用户首次访问 GET /api/essays 时惰性预置示例作文（一次性，标记在 user_flags.seeded）

## 项目定位

面向上海高中生的英语作文批改教学网页应用。**不登录也能用**（游客试用），核心流程：

0. **游客试用（未登录）**：每天 1 篇、最多 3 稿（一稿/二稿/三稿）、每稿只能成功批改 1 次（= 每天 3 次批改）；只能用免费通道 + 百度 OCR；精修/润色/按模式自定义提示词/导出设置需登录。身份 = cookie `wg`（随机 32 hex，90 天），user_id 记为 `guest:<id>`；**登录后首次请求自动接管该设备的游客数据**
1. **新建作文**：题目文本 + 可选题目图片（图画/图表作文），题型 v1 仅 `sh-gaokao-essay`（上海高考大作文，内容 10 + 语言 10 + 结构 5 = 25 分，120-150 词）
2. **写稿件**：拍照/上传手写稿 → OCR（默认大模型视觉逐字转写 + 书写质量分；可切百度 OCR）→ **可编辑确认页**（保留学生原始错误）→ 保存；或直接输入
3. **批改**：按生效提示词（`essays.custom_prompt` > `prompt_templates`（按 user+**genre**）> `src/utils/prompts.ts` 内置默认）调用 LLM → 结构化 JSON → 前端渲染分数卡 + 原文错误高亮（quote substring / 空白归一定位）+ 诊断 + 修改全文（**粗体**升级点）+ 建议
4. **二稿迭代**：一稿预填编辑或重拍；批改自动注入上一稿反馈摘要 → `improvement` 进步对比（分差 / 已解决 / 遗留 / 新引入）
5. **片段精修**：正文中选中任意片段 → 浮动按钮 → 3 个版本（稳妥改进 / 高级句式 / 范文级）+ 可复用表达 → 采纳为新稿件
6. **全文润色**：整篇范文级改写 + 逐段原文 vs 润色对照 → 采纳为新稿件
7. **报告导出**：全部/最新稿件 + 批改 → DOCX（docx 库）/ PDF（pdf-lib + fontkit + Noto Sans SC）

注册即送一篇预烘焙示例作文（一稿→批改→二稿→进步对比→片段精修，零 AI 调用，见 `src/sample/seed.ts`）；**游客不预置示例**（会白占「每天 1 篇」名额）。

## 额度模型（重要，别改回去）

- **口径是「成功批改次数」**：只有拿到合法批改结果并落库前才 +1（`quota_events`），失败不扣。
- 计数与规则在**本 Worker**（`src/utils/quota.ts`），不在 billing：成与否、一稿/二稿/三稿、每天一篇这些语义只有业务库知道。
- 登录用户 10 次/日；游客 3 次/日（= 每天一篇 × 一稿二稿三稿，每稿一次）。付费档（DeepSeek/积分）与自备 Key **不占次数**。
- 免费档调 `billing.hold` 必须带 `skipQuota: true`：billing 已删除 writing 的 LLM 次数规则（`Yuer6327-billing/migrations/0002_quota_handoff.sql`），不带该参数会走「无价服务额度用尽 → 409」分支。

## 技术栈

| 层 | 技术 |
|---|---|
| 后端 | Cloudflare Workers + Hono 4（TypeScript，`src/index.ts` 入口） |
| 数据库 | Cloudflare D1（SQLite），幂等迁移 `migrations/` + `scripts/migrate.js`（顺序执行，state 存 `.wrangler/migration-state.json`） |
| 前端 | `public/` 原生 HTML/CSS/JS（ES Modules，**无构建步骤**），Workers Assets 直接服务 |
| 认证 | **统一认证平台 auth.yuer6327.top**（同根域共享 `s` cookie，直查 auth-db sessions；无本地登录/注册接口） |
| 密钥 | BYOK AES-256-GCM 加密存 D1；平台级 Secret 走 `wrangler secret put` / `.dev.vars` |
| AI | OpenAI Chat Completions 兼容格式；多模态走 `content` 数组（`image_url` data URL） |

## 目录结构

```
├── wrangler.toml              # 端口 8788（避开阅读助手 8787）；D1: writing-assistant-db；
│                              # assets.run_worker_first=true（静态资源必须过 Worker，否则安全头对 HTML 失效）
├── migrations/0001_init.sql   # 全部业务表
├── scripts/
│   ├── migrate.js             # 顺序执行 D1 迁移
│   └── csp-hash.js            # 校验 public/*.html 内联脚本的 CSP sha256 是否与 Worker 常量一致
├── src/
│   ├── index.ts               # Hono 入口：安全头 → CORS/同源校验 → 路由 → ASSETS fallback
│   ├── types.ts               # Env / Vars / ReviewResult 等业务类型
│   ├── middleware/
│   │   ├── auth.ts            # ★ 会话：authMiddleware（必须登录）/ userMiddleware（登录或游客）
│   │   │                      #   游客 cookie wg、登录后接管游客数据
│   │   └── security.ts        # ★ 安全响应头 + CSP + CORS 白名单 + 写操作同源校验
│   ├── routes/
│   │   ├── auth.ts            # /me（200 + logged_in，游客不跳登录）/ dev-session
│   │   ├── essays.ts          # ★ 核心：作文+稿件 CRUD / 批改 / 精修 / 全文润色（挂 /api）
│   │   ├── ocr.ts             # 双通道手写识别（vlm / baidu，挂 /api/ocr）
│   │   ├── prompts.ts         # 提示词模板：按模式（genre）独立读写
│   │   └── settings.ts        # BYOK（主模型+可选视觉模型）/ Agnes 切换
│   ├── utils/
│   │   ├── quota.ts           # ★ 批改次数额度（成功计数 / 游客规则 / 每日 10 次）
│   │   ├── ai.ts              # ★ callAI 调用层：多端点 failover、response_format 回退、
│   │   │                      #   90s 超时、extractJSON 容错、friendlyAIError 中文化
│   │   ├── prompts.ts         # ★ 全部提示词：上海高考大作文默认模板（用户框架）、
│   │   │                      #   VLM 手写转写、片段精修、全文润色 + fillTemplate/getEffectivePrompt
│   │   ├── validate.ts        # ★ AI 结果校验净化：safeScore 收敛、quote 命中原文、
│   │   │                      #   加分规则强制（内容+语言<15 → 结构≤3）、数组封顶
│   │   ├── api-config.ts      # getUserApiKey（主模型）/ getVisionConfig（视觉优先级解析）
│   │   ├── crypto.ts / jwt.ts / rate-limit.ts / baidu-ocr.ts   # 照抄兄弟项目
│   └── sample/seed.ts         # 注册预置示例作文（与 AI 输出同构的烘焙数据）
└── public/
    ├── index.html + js/index.js       # 作文列表 + 新建（图片压缩上传）
    ├── essay.html + js/essay.js       # ★ 工作台：稿件 Tabs / OCR 确认 / 批改渲染 /
    │                                  #   高亮标注 / 选段精修 / 全文润色 / 提示词覆盖
    ├── settings.html + js/settings.js # AI 配置（Agnes/BYOK+视觉模型）+ 提示词模板编辑
    ├── login.html / register.html + js/auth.js
    ├── js/api.js              # 统一客户端 + toast/压缩/compressImageFile/renderBold
    ├── js/swup.js             # 自研 SPA 路由（SPA_PAGES: / index essay settings）
    ├── js/export.js           # 报告导出 DOCX/PDF（CDN 按需加载）
    └── css/style.css          # 兄弟项目变量体系 + 靛蓝强调色 + 工作台组件样式
```

## 数据模型（migrations/0001_init.sql）

- `users` / `api_keys`（api_keys 含 `provider`（byok/agnes）+ 可选 `vision_*` 三列：主模型不支持图片时单独指定视觉模型，空则视觉=主模型；BYOK 已迁 billing，该表仅历史备份）
- `essays`：title, genre, topic_text, topic_images(JSON data URL), custom_prompt（user_id 可为 `guest:<id>`）
- `drafts`：essay_id, version（1=一稿，删除中间稿不重排）, text, source(photo/text/polish), word_count, handwriting_score, ocr_images
- `reviews`：draft_id, result(JSON=ReviewResult), model, **reviewed_text（批改时稿件快照，稿件后改不影响已出报告）**, created_at
- `polishes`：mode(fragment/full), fragment, instruction, result
- `prompt_templates`：PRIMARY KEY(user_id, **genre**) —— 每个模式一行、独立保存与恢复；内置默认在代码里
- `quota_events`（0002）：user_id, day(北京日期), kind(review/ocr), essay_id, draft_id —— **成功**才写一行，额度状态/门禁都由它算

## AI 调用约定（改代码前必读）

- **双通道**：Agnes 免费层（`AGNES_BASE_URLS` 双端点 failover，`agnes-3.0-flash` **原生支持图像 URL 输入**，手写 OCR/看图批改开箱即用）/ BYOK（用户 Key+端点+模型）。未配 Key 默认走 Agnes。
- **限流**：`aiRateLimit` 中间件（Agnes 用户 18 RPM/人）+ `agnesGlobalRateHit()` 全局桶；1015（Cloudflare 挡端点）按 retry-after 排班，预算内（≤12s）就地等，超预算快速失败回传秒数。
- **图片**：客户端 `compressImageFile`（长边≤1600、≤300KB/张、≤3 张）→ data URL；服务端 `validImages` 复验。
- **批改调用**：题目带图时走 `getVisionConfig` + contentParts（text + images）；调用后 `sanitizeReview` 校验，失败附错误信息**严格重试一次**，仍失败 502 带 details。
- **额度与计费**：批改前 `checkReviewGate`（免费档才判次数），成功后 `recordSuccess`；`billing.hold` 对免费档传 `skipQuota: true`（付费档照常预扣）。重试/失败的中间成本不计次。
- **响应格式**：`response_format: json_object`，Agnes 模型自动跳过（不支持该参数，失败一次后缓存跳过）。
- **提示词占位符**：`{topic} {essay} {word_count} {previous_feedback}`，`fillTemplate` 替换；`{essay}` 为必填项（保存模板时强校验）。

## 前端约定（swup SPA）

- 页面模块导出 `{ init, cleanup }`，`cleanup` 必须终止轮询/移除全局副作用（essay.js 的 cleanup 移除选区浮动按钮与模态框）。
- 绑定事件用模块顶层一次性委托（essay.js 的 mouseup 委托在 document 上，init 里只做幂等绑定）。
- `data-page-module` 在 `<main>` 自身属性上，swup 切页时显式复制（innerHTML 不带属性）。
- quote 高亮定位：先原文 `indexOf`，失败再 `buildNormMap` 空白归一映射回原文下标（`essay.js`）。

## 安全约定（改代码前必读）

| 面 | 机制 | 注意 |
|---|---|---|
| 会话 | `authMiddleware`（必须登录）/ `userMiddleware`（登录或游客） | `/api/auth/me` **恒 200**（`logged_in` 区分），否则游客一进站就被弹登录；游客专属能力返回 **403 `code=login_required`**（前端弹登录引导，而非整页跳转） |
| 游客身份 | cookie `wg`（HttpOnly/SameSite=Lax/90 天，https 才加 Secure） | 清 cookie 可重置次数 → 另有 IP 级内存兜底（`guest:ip:*`）；登录后静默接管 `guest:<id>` 名下的作文/稿件/批改/精修 |
| 响应头 | `middleware/security.ts` 统一注入 CSP / X-Frame-Options / nosniff / Referrer-Policy / Permissions-Policy / HSTS | **CSP 内联脚本走 sha256，不用 `unsafe-inline`**；改 `public/*.html` 里的 `<script>` 后必须 `npm run csp:hash` 看新哈希并更新 `INLINE_SCRIPT_HASHES`，否则 `npm run csp:check`（CI 已接）会挂 |
| 静态资源 | `[assets] run_worker_first = true` | 关掉的话静态文件由边缘直接返回、**绕过 Worker，安全头对 HTML 全部失效**（本地 `wrangler dev` 同样如此，别只看配置文件就以为生效） |
| CORS | 白名单反射（自身源 + `FRONTEND_ORIGIN` 逗号列表） | `FRONTEND_ORIGIN="*"` 现在表示"仅同源"，不再反射任意 Origin；响应带 `Vary: Origin` |
| CSRF | 非 GET 请求校验 Origin/Referer 同源 | 无 Origin 的请求（curl/服务端）放行，认证仍靠 Cookie |
| 调试后门 | `GET /api/auth/dev-session` | 需 `.dev.vars` 里 `ENABLE_DEV_SESSION=1` **且** 本地 auth-db 有测试会话行才发 Cookie；生产不配置该变量 → 恒 404。**不要用 Host 判断**：`wrangler dev` 会把请求 URL/Host 重写成 `routes` 里的生产域名 |
| 计费 | `hold → settle/release` | **入参校验必须放在 `hold` 之前**，否则 400 早退会留下未释放的冻结额度（要等 cron 过期才对账）；免费档带 `skipQuota`，次数由 `quota_events` 计 |
| 入参 | 自增 id 统一走 `parseId()`；文本长度封顶 | 新增/修改稿件同为 `MAX_ESSAY_CHARS`；BYOK 端点只允许 https（本地环回除外） |

## 前端 UI 约定

- **用视觉提示代替文字说明**：状态用徽章/进度条/颜色+下划线，说明性长句压成 `.chip` 标签或塞进 `title`，不要在前端堆大段文案。
- 交互元素必须是真控件：列表项用 `<a>`（可 Tab/新窗口），图标按钮带 `aria-label`，弹窗带 `role="dialog"` + 焦点陷阱 + 关闭后归还焦点。
- 焦点环靠全局 `:focus-visible`；`--text-light` 已按 WCAG AA（≥4.5:1）调过，别再调浅。
- 未在 HTML/JS 中出现的类不要留在 `style.css`（历史遗留已清理一次，约 450 行）。

## 常用命令

```bash
npm run dev            # wrangler dev → http://localhost:8788
npm run typecheck      # tsc --noEmit
npm run csp:check      # 校验 CSP 内联脚本哈希（CI 必跑）
npm run csp:hash       # 打印当前 HTML 内联脚本哈希（改完 HTML 用）
npm run check          # typecheck + csp:check（部署前一条命令）
npm run db:migrate     # 本地 D1 迁移（db:migrate:remote 为生产）
npm run deploy         # 部署（自动维护 writing.yuer6327.top/* 路由）
```

`.dev.vars`（gitignored）：ENCRYPTION_KEY（本地随机即可）、AGNES_API_KEY（真实共享密钥）、BAIDU_OCR_AK/SK（可选）、ENABLE_DEV_SESSION=1（本地测试会话开关，生产不配）。

**本地同时跑 billing（要测批改/额度必做）**：`[[services]]` 走 wrangler dev 的本地 registry，**两个进程必须用同一个 `XDG_CONFIG_HOME`**，否则 essay 侧永远显示 `env.BILLING ... local [not connected]`：

```bash
export XDG_CONFIG_HOME="D:/OneDrive/桌面/play/codes/.wrangler-registry"
cd ../Yuer6327-billing && node node_modules/wrangler/bin/wrangler.js dev --port 8789   # 先起
cd ../english-writing-assistant && node node_modules/wrangler/bin/wrangler.js dev --port 8788  # 再起（先起后起无所谓，但 essay 启动时必须能连上）
# 改了 billing 代码/迁移要重启 billing；只改 essay 代码 wrangler 会热重载
```
本地无真实 Agnes key 时，可临时把 billing `catalog.ts` 的 agnes `baseUrl` 指向一个假 `/v1/chat/completions`（返回合法批改 JSON），**测完必须还原**（`.wrangler/mock-llm.cjs` 有现成实现）。curl 访问本机要加 `--noproxy '*'`（本机装了全局代理）。

**本地联调统一认证**：AUTH_DB 走本地 sqlite（与生产隔离），需先造最小表+测试会话；配好 `ENABLE_DEV_SESSION=1` 后浏览器直接访问 `/api/auth/dev-session` 即可拿到 cookie 值 `test-cookie-1`：

```bash
# 本地 auth-db 造 users/sessions 表并插入测试会话（cookie 值 test-cookie-1，
# token_hash = sha256('test-cookie-1') = 95496838ab4f1634...）
npx wrangler d1 execute auth-db --local --command "CREATE TABLE ...; INSERT ..."
# 之后 curl -H "Cookie: s=test-cookie-1" http://127.0.0.1:8788/api/essays
```

> ⚠️ `wrangler dev` 会把请求的 Host/Origin 重写成 `routes` 里的生产域名（`http://writing.yuer6327.top`），
> 所以本地按 Host 判断"是不是本地请求"一定失败；需要区分环境请用环境变量开关。
> 另：`XDG_CONFIG_HOME` 指向项目内可写目录，可避免沙箱内 wrangler 写日志目录 EPERM。

**生产 secrets**（wrangler secret put）：ENCRYPTION_KEY、AGNES_API_KEY、BAIDU_OCR_AK / BAIDU_OCR_SK（复用 english-reading-assistant 的百度应用，AppID 8096172，均已配置）。

## 新增题型（扩展指南）

1. `src/utils/prompts.ts`：`GENRES` 注册（label/total/desc）+ `DEFAULT_PROMPTS[genre]` 模板
2. 迁移无需改（genre 是自由字符串）；前端 `index.html` 下拉框加 option
3. 提示词 UI **无需再改**：设置页的模式下拉与工作台的「存为该模式模板」都按 `GENRES` 自动长出条目，各模式独立保存、互不覆盖
4. `validate.ts` 的 subscores 区间目前按 10/10/5 硬编码——**新题型分制不同需要参数化**（从 GENRES 取 total/结构满分）

## 已知取舍

- 批改/润色为一次性 JSON 调用（无流式），免费通道实测 18-75 秒，前端按钮有"批改中（约 10-30 秒）"提示
- 图片以 data URL 存 D1 文本列（≤3 张×300KB，个人工具规模够用；超出应换 R2）
- 删除中间稿件后 version 出现空号，Tab 按剩余 version 展示（不重排，保持批改记录引用稳定）
