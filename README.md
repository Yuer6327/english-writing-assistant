# 小C — 英语写作助手

[![License: PolyForm Strict 1.0.0](https://img.shields.io/badge/License-PolyForm%20Strict-ff6960.svg)](./LICENSE)

**线上地址：https://writing.yuer6327.top/**

## 为什么叫「小C」

小C，小思（Si）的同族元素。C 代表碳元素——人类最早用于写作的工具之一（铅笔芯），正如小思（硅）是这代 AI 的底色。同属IVA族的碳与硅，一个写在纸上，一个跑在硅片里。

## 这是什么

一台**专为自己提升英语写作**用的批改工作台，面向上海高考英语大作文（内容 10 + 语言 10 + 结构 5 = 25 分，200–500 词）。它不是「写完判个分」的一次性工具，而是围绕**二稿、三稿、多稿打磨**设计的：每一稿批改都带着上一稿的账——分差、已解决、仍存在、新引入，直到把一篇作文真正磨到位。

### 项目特色

- **专注多稿迭代**：一稿批改 → 对照修改 → 二稿再批，自动对比得分变化与问题清单（已解决 / 仍存在 / 新引入）。进步看得见，而不是每次都从零开始
- **不留情面的评分**：按上海高考阅卷口径举证打分——每个分项都要有原文证据支撑，22 分封顶须有范文级表现；提示词完全开放可改（全局模板 + 单篇覆盖）
- **原文错误高亮**：批改结果直接标注在你自己的原文上，点击跳转问题卡片（类型 / 分析 / 修改句）；修改后全文以粗体标出升级点
- **拍照即转文字**：手写稿拍照上传（≤3 张），大模型视觉逐字转写（保留原始错误，不擅自纠错）+ 书写质量评分，转写结果可编辑确认后再批改；图画/图表作文可看图批改
- **片段精修 / 全文润色**：选中任意句子给三个升级版本（稳妥改进 / 高级句式 / 范文级）；整篇范文级改写逐段对照，均可采纳为新稿件继续磨
- **游客零门槛**：不登录即可试用——LongCat 高分模型每日 1 次 + 免费通道 3 次（一稿/二稿/三稿各一次），仅拍照识别受限
- **报告导出**：Word（.docx）/ PDF，含全部稿件、批改详情与进步对比
- **注册即送一篇完整示例**：预烘焙的一稿 → 批改 → 二稿 → 进步对比 → 精修样例，零 AI 调用看懂全流程

---

# AI Agent 指南

> 本节写给在本仓库工作的 AI 编码代理（Claude Code / ZCode 等）。**完整架构指南以 [CLAUDE.md](./CLAUDE.md) 为准**——数据模型、AI 调用约定、SPA 前端约定、扩展指南都在那里，动手前必读。历史审计与安全文档：[docs/AUDIT.md](docs/AUDIT.md)、[docs/SECURITY-GAPS.md](docs/SECURITY-GAPS.md)、[docs/INJECTION.md](docs/INJECTION.md)。

## 架构速览

| 层 | 技术 |
|---|---|
| 后端 | Cloudflare Workers + Hono 4（TypeScript，入口 `src/index.ts`） |
| 数据库 | Cloudflare D1（SQLite），幂等迁移 `migrations/` + `scripts/migrate.js` |
| 前端 | `public/` 原生 HTML/CSS/JS（ES Modules，**无构建步骤**），自研 swup SPA 路由 |
| 认证 | 统一认证平台 auth.yuer6327.top（同根域共享 `s` cookie，本库直查其 `auth-db` sessions 表；**无本地登录接口**） |
| 计费/模型库 | 独立仓库 `Yuer6327-billing`（Service Binding `BILLING`），本仓库钱包/预扣费/模型目录全部经它 |
| AI | OpenAI Chat Completions 兼容；车道（lane）模型——`free`（Agnes）/ `longcat` / `deepseek` / `byok` |

核心业务流：作文（essays）→ 稿件（drafts，version 1/2/3…）→ 批改（reviews，SSE 流式）→ 精修/润色（polishes）→ 导出。游客身份 = cookie `wg`（`user_id = guest:<id>`），登录后自动接管游客数据。

## 改码必守的约定（违反即事故）

1. **北京时间（UTC+8）**：一切业务日期用 `beijingDay()`（`Asia/Shanghai`）归日；SQL 归日一律 `date(created_at, '+8 hours')`。禁纯 UTC 日期。
2. **额度口径是「成功批改次数」**：只有拿到合法批改结果并落库的**同一 `DB.batch` 事务**里才写 `quota_events`（`src/utils/quota.ts`）；失败路径绝不计次。游客「每稿一次」靠唯一索引 + 条件插入硬约束，不靠先查后写。
3. **billing.hold 前必须完成全部入参校验**：hold 之后的早退会留下未释放冻结额度（等 cron 对账才回滚）。免费档/LongCat 对游客传 `skipQuota: true` 之外的车道口径见 `src/routes/essays.ts` 注释；LongCat 对登录用户不占次数、对游客独立计 1 次/日。
4. **模型库单源 = billing catalog**（`/internal/catalog` 下发）：加模型只改 billing 仓库 `catalog.ts` 一处；本仓库 `HARDCODED_LANES` 仅 `free`/`byok` 两个伪车道，前端 LongCat 默认项为展示硬编码、启停仍归 catalog。禁在本仓库枚举车道表。
5. **CSP 内联脚本走 sha256 白名单**：改了 `public/*.html` 里的 `<script>` 必须先 `npm run csp:hash` 更新 `src/middleware/security.ts` 的 `INLINE_SCRIPT_HASHES`，否则 `npm run csp:check`（CI 已接）必挂。只改文本/标签不影响哈希。
6. **静态资源必须过 Worker**：`wrangler.toml` 的 `[assets] run_worker_first = true` 不能关，否则安全头对 HTML 全部失效（本地 `wrangler dev` 同样如此，别只看配置文件就以为生效）。
7. **提示词注入的真边界是 `sanitizeReview`**（`src/utils/validate.ts`）：威胁模型是「学生本人给自己刷分」，措辞类防御只标记不硬拦；改注入规则后必跑 `npm run inj:test`。
8. **BYOK 端点只允许 https**（本地环回除外）；密钥一律 AES-256-GCM，托管在 billing。
9. **游客一律 `guest:` 前缀 user_id**，游客专属能力被拒时返回 403 `code=login_required`（前端弹登录引导，而非整页跳转）；`/api/auth/me` 恒 200。

## 本地开发

```bash
npm install
npm run db:migrate   # 初始化本地 D1（迁移状态存 .wrangler/migration-state.json，勿用 wrangler migrations）
npm run dev          # http://localhost:8788
```

`.dev.vars`（gitignored）模板：

```ini
ENCRYPTION_KEY=<本地随机 32+ 字符>
AGNES_API_KEY=<真实共享密钥，可选；留空则免费通道不可用>
BAIDU_OCR_AK=<可选，复用 english-reading-assistant 的百度应用（AppID 8096172）>
BAIDU_OCR_SK=<同上>
ENABLE_DEV_SESSION=1   # 本地测试会话开关；生产永不配置
```

**要测批改/额度，必须同时本地起 billing**（Service Binding 走 wrangler dev 本地 registry，两个进程共用同一 `XDG_CONFIG_HOME`）：

```bash
export XDG_CONFIG_HOME="D:/OneDrive/桌面/play/codes/.wrangler-registry"
cd ../Yuer6327-billing && node node_modules/wrangler/bin/wrangler.js dev --port 8789   # 先起
cd ../english-writing-assistant && node node_modules/wrangler/bin/wrangler.js dev --port 8788
```

本地无真实 Agnes key 时，可临时把 billing `catalog.ts` 的 agnes `baseUrl` 指向 `.wrangler/mock-llm.cjs`（返回合法批改 JSON），**测完必须还原**。curl 访问本机加 `--noproxy '*'`（本机有全局代理）。

**登录联调**：本地 AUTH_DB 与生产隔离。配好 `ENABLE_DEV_SESSION=1` 后浏览器访问 `/api/auth/dev-session` 拿 `s=test-cookie-1`（需先按 CLAUDE.md「本地联调统一认证」在本地 auth-db 造 users/sessions 表与测试会话行）。注意 `wrangler dev` 会把请求 Host/Origin 重写成生产域名——按 Host 判断环境必失败，用环境变量开关。

## 常用命令

```bash
npm run check          # typecheck + csp:check + inj:test（部署前一条命令全过）
npm run typecheck      # tsc --noEmit
npm run csp:hash       # 打印当前 HTML 内联脚本哈希（改完 HTML 里的 <script> 用）
npm run inj:test       # 注入防护回归（攻击样本必须 high / 正常样本不得 high / 服务端钳制）
npm run db:migrate     # 本地 D1 迁移；db:migrate:remote 为生产
npm run deploy         # 部署（自动维护 writing.yuer6327.top/* 路由）
```

## 平台 API 速览（挂 `/api`，认证靠 Cookie）

| 端点 | 说明 |
|---|---|
| `GET /auth/me` | 会话 + 额度（`quota.longcat_used/limit` 为游客 LongCat 余量）；恒 200 |
| `GET/POST /essays` | 作文列表（注册用户首访惰性预置示例；游客不预置）/ 新建（游客 1 篇/日） |
| `POST /essays/:id/drafts` | 建稿（游客每篇 ≤3 稿）；`PUT/DELETE /drafts/:id` |
| `POST /drafts/:id/review` | 批改，**SSE 流式**（10s 心跳，最终 `data: {status, body}`）；请求体 `model_id`：`longcat`（默认）/`free`/目录短名/`byok`；游客仅 `longcat`/`free` |
| `POST /essays/:id/polish` | 精修（fragment）/全文润色（full），需登录 |
| `POST /ocr` | 手写识别：`mode='vlm'`（需登录）/'baidu'（游客 3 次/日） |
| `/prompts` `/settings` | 提示词模板（按题型 genre 独立）/ BYOK 配置 |
| `/billing/*` | 余额/兑换/用量/管理组（role=admin） |

## 扩展指南

- **新增题型（genre）**：`src/utils/prompts.ts` 注册 `GENRES` + `DEFAULT_PROMPTS[genre]` → 前端下拉加 option；提示词 UI 按 `GENRES` 自动长出。注意 `validate.ts` 分项区间目前按 10/10/5 硬编码，新分制需参数化。
- **新增模型车道**：只改 billing 仓库 `catalog.ts`（price/thinkingBudget/maxOutputFactor/budgetMs 等全部单源），本仓库零改动；`DISABLED_SERVICES` 控制启停。
- **游客限额调整**：全部常量在 `src/utils/quota.ts`；LongCat 日额度并发硬约束在 `migrations/0006_guest_longcat.sql` 的部分唯一索引。

## 部署

已上线 https://writing.yuer6327.top/ 。推送到 `main` 即自动：GitHub Actions 执行类型检查 → 远程迁移 → 部署（需 `CLOUDFLARE_API_TOKEN` secret）。本地手动三连：`npm run check && npm run db:migrate:remote && npm run deploy`。

DNS 由 [dns-guard](D:\fuwari-cf\dns-guard) 统一守护（灰云 CNAME → 优选候选，故障自动切换）；secrets 走 `wrangler secret put`（ENCRYPTION_KEY / AGNES_API_KEY / BAIDU_OCR_AK / BAIDU_OCR_SK）。

## 许可证

[PolyForm Strict 1.0.0](./LICENSE) © 2026 Yuer6327——可以阅读、学习、在非商业场景使用，但**不允许分发副本、不允许修改或基于本作品创作新作品**；任何部署请保留本署名。需要其他授权请联系作者。
