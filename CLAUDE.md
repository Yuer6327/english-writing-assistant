# CLAUDE.md — 英语作文批改助手架构指南

面向 AI 编码助手（Claude Code / ZCode 等）的项目地图。本项目为 [english-reading-assistant](../english-reading-assistant) 的姊妹项目，架构与基础设施（加密 / 限流 / AI 调用层 / SPA 前端）复用自该项目的成熟实现，业务层围绕"作文批改教学"重写。

## 线上地址与部署形态

- **https://writing.yuer6327.top/**（zone 内 Workers 路由 `writing.yuer6327.top/*`，见 wrangler.toml `routes`）
- DNS 由 [dns-guard](D:\fuwari-cf\dns-guard) 统一守护：灰云 CNAME→优选候选（当前 www.shopify.com），故障自动切换/恢复，与其他子域同步
- **统一认证**（无本地账户）：登录/注册/退出跳转 https://auth.yuer6327.top，后端直查平台 `auth-db`（binding `AUTH_DB`）的 sessions 表；cookie 名 `s`，`token_hash = sha256(cookie 值)` hex。**平台用户 id 是 UUID 字符串**，本库所有 user_id 列均为 TEXT
- 新用户首次访问 GET /api/essays 时惰性预置示例作文（一次性，标记在 user_flags.seeded）

## 项目定位

面向上海高中生的英语作文批改教学网页应用，核心流程：

1. **新建作文**：题目文本 + 可选题目图片（图画/图表作文），题型 v1 仅 `sh-gaokao-essay`（上海高考大作文，内容 10 + 语言 10 + 结构 5 = 25 分，120-150 词）
2. **写稿件**：拍照/上传手写稿 → OCR（默认大模型视觉逐字转写 + 书写质量分；可切百度 OCR）→ **可编辑确认页**（保留学生原始错误）→ 保存；或直接输入
3. **批改**：按生效提示词（`essays.custom_prompt` > `prompt_templates`（按 user+genre）> `src/utils/prompts.ts` 内置默认）调用 LLM → 结构化 JSON → 前端渲染分数卡 + 原文错误高亮（quote substring / 空白归一定位）+ 诊断 + 修改全文（**粗体**升级点）+ 建议
4. **二稿迭代**：一稿预填编辑或重拍；批改自动注入上一稿反馈摘要 → `improvement` 进步对比（分差 / 已解决 / 遗留 / 新引入）
5. **片段精修**：正文中选中任意片段 → 浮动按钮 → 3 个版本（稳妥改进 / 高级句式 / 范文级）+ 可复用表达 → 采纳为新稿件
6. **全文润色**：整篇范文级改写 + 逐段原文 vs 润色对照 → 采纳为新稿件
7. **报告导出**：全部/最新稿件 + 批改 → DOCX（docx 库）/ PDF（pdf-lib + fontkit + Noto Sans SC）

注册即送一篇预烘焙示例作文（一稿→批改→二稿→进步对比→片段精修，零 AI 调用，见 `src/sample/seed.ts`）。

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
├── wrangler.toml              # 端口 8788（避开阅读助手 8787）；D1: writing-assistant-db
├── migrations/0001_init.sql   # 全部业务表
├── src/
│   ├── index.ts               # Hono 入口：CORS + 路由挂载 + ASSETS fallback
│   ├── types.ts               # Env / Vars / ReviewResult 等业务类型
│   ├── middleware/auth.ts     # JWT 校验中间件（c.set('userId')）
│   ├── routes/
│   │   ├── auth.ts            # 注册（含 seed）/登录/me/logout
│   │   ├── essays.ts          # ★ 核心：作文+稿件 CRUD / 批改 / 精修 / 全文润色（挂 /api）
│   │   ├── ocr.ts             # 双通道手写识别（vlm / baidu，挂 /api/ocr）
│   │   ├── prompts.ts         # 提示词模板（生效值查看 / 覆盖 / 恢复默认）
│   │   └── settings.ts        # BYOK（主模型+可选视觉模型）/ Agnes 切换
│   ├── utils/
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

- `users` / `api_keys`（api_keys 含 `provider`（byok/agnes）+ 可选 `vision_*` 三列：主模型不支持图片时单独指定视觉模型，空则视觉=主模型）
- `essays`：title, genre, topic_text, topic_images(JSON data URL), custom_prompt
- `drafts`：essay_id, version（1=一稿，删除中间稿不重排）, text, source(photo/text/polish), word_count, handwriting_score, ocr_images
- `reviews`：draft_id, result(JSON=ReviewResult), model, **reviewed_text（批改时稿件快照，稿件后改不影响已出报告）**, created_at
- `polishes`：mode(fragment/full), fragment, instruction, result
- `prompt_templates`：PRIMARY KEY(user_id, genre)，内置默认在代码里、可恢复

## AI 调用约定（改代码前必读）

- **双通道**：Agnes 免费层（`AGNES_BASE_URLS` 双端点 failover，`agnes-3.0-flash` **原生支持图像 URL 输入**，手写 OCR/看图批改开箱即用）/ BYOK（用户 Key+端点+模型）。未配 Key 默认走 Agnes。
- **限流**：`aiRateLimit` 中间件（Agnes 用户 18 RPM/人）+ `agnesGlobalRateHit()` 全局桶；1015（Cloudflare 挡端点）按 retry-after 排班，预算内（≤12s）就地等，超预算快速失败回传秒数。
- **图片**：客户端 `compressImageFile`（长边≤1600、≤300KB/张、≤3 张）→ data URL；服务端 `validImages` 复验。
- **批改调用**：题目带图时走 `getVisionConfig` + contentParts（text + images）；调用后 `sanitizeReview` 校验，失败附错误信息**严格重试一次**，仍失败 502 带 details。
- **响应格式**：`response_format: json_object`，Agnes 模型自动跳过（不支持该参数，失败一次后缓存跳过）。
- **提示词占位符**：`{topic} {essay} {word_count} {previous_feedback}`，`fillTemplate` 替换；`{essay}` 为必填项（保存模板时强校验）。

## 前端约定（swup SPA）

- 页面模块导出 `{ init, cleanup }`，`cleanup` 必须终止轮询/移除全局副作用（essay.js 的 cleanup 移除选区浮动按钮与模态框）。
- 绑定事件用模块顶层一次性委托（essay.js 的 mouseup 委托在 document 上，init 里只做幂等绑定）。
- `data-page-module` 在 `<main>` 自身属性上，swup 切页时显式复制（innerHTML 不带属性）。
- quote 高亮定位：先原文 `indexOf`，失败再 `buildNormMap` 空白归一映射回原文下标（`essay.js`）。

## 常用命令

```bash
npm run dev            # wrangler dev → http://localhost:8788
npm run typecheck      # tsc --noEmit
npm run db:migrate     # 本地 D1 迁移（db:migrate:remote 为生产）
npm run deploy         # 部署（自动维护 writing.yuer6327.top/* 路由）
```

`.dev.vars`（gitignored）：ENCRYPTION_KEY（本地随机即可）、AGNES_API_KEY（真实共享密钥）、BAIDU_OCR_AK/SK（可选）。

**本地联调统一认证**：AUTH_DB 走本地 sqlite（与生产隔离），需先造最小表+测试会话：

```bash
# 本地 auth-db 造 users/sessions 表并插入测试会话（cookie 值 testsession）
npx wrangler d1 execute auth-db --local --command "CREATE TABLE ...; INSERT ..."
# 之后 curl -H "Cookie: s=testsession" http://127.0.0.1:8788/api/essays
```

**生产 secrets**（wrangler secret put）：ENCRYPTION_KEY、AGNES_API_KEY、BAIDU_OCR_AK / BAIDU_OCR_SK（复用 english-reading-assistant 的百度应用，AppID 8096172，均已配置）。

## 新增题型（扩展指南）

1. `src/utils/prompts.ts`：`GENRES` 注册（label/total/desc）+ `DEFAULT_PROMPTS[genre]` 模板
2. 迁移无需改（genre 是自由字符串）；前端 `index.html` 下拉框加 option
3. `validate.ts` 的 subscores 区间目前按 10/10/5 硬编码——**新题型分制不同需要参数化**（从 GENRES 取 total/结构满分）

## 已知取舍

- 批改/润色为一次性 JSON 调用（无流式），免费通道实测 18-75 秒，前端按钮有"批改中（约 10-30 秒）"提示
- 图片以 data URL 存 D1 文本列（≤3 张×300KB，个人工具规模够用；超出应换 R2）
- 删除中间稿件后 version 出现空号，Tab 按剩余 version 展示（不重排，保持批改记录引用稳定）
