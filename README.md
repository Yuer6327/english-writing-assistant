# 英语作文批改助手（english-writing-assistant）

**线上地址：https://writing.yuer6327.top/**

面向上海高中生的 AI 英语作文批改教学网页应用。拍照上传手写稿自动转文字，按上海高考大作文评分标准（内容 10 + 语言 10 + 结构 5）智能批改，支持二稿迭代、片段精修、全文润色与报告导出。

> 架构复用自姊妹项目 [english-reading-assistant](../english-reading-assistant)（Cloudflare Workers + Hono + D1 + 原生前端）。
> 账户使用 [统一认证平台](https://auth.yuer6327.top)（同根域一次登录全站通用）；DNS 优选线路由 dns-guard 自动守护。

## 功能

- **拍照转文字**：上传手写稿照片（≤3 张），大模型视觉逐字转写（保留学生原始错误，不擅自纠错）并给出书写质量评分；可切换百度 OCR。转写结果进入**可编辑确认页**，识别有误可手动修正
- **智能批改**：按可自定义的系统提示词（默认内置「上海高考英语阅卷专家」模板：三维度评分 + 档次加分规则 + 诊断 → 修改 → 打分）输出：
  - 分数卡（总分 + 内容/语言/结构分项）
  - 原文错误**高亮标注**（点击跳转问题卡片：类型 / 分析 / 修改句）
  - 逐项诊断、修改后全文（**粗体**标出升级点）、提升建议
  - 题目带图片（图画作文）时模型看图批改
- **二稿迭代**：一稿预填修改或重新拍照；二稿批改自动对比上一稿，给出得分变化与「已解决 / 仍存在 / 新引入」问题清单
- **片段精修**：正文中选中任意句子，AI 给出「稳妥改进 / 高级句式（倒装、非谓语、强调句）/ 范文级」三个升级版本 + 逐处改动理由 + 可复用表达，一键采纳为新稿件
- **全文润色**：整篇范文级改写，逐段「原文 vs 润色」对照，可采纳为新稿件继续打磨
- **报告导出**：Word（.docx）/ PDF，含全部稿件、批改详情与进步对比
- **提示词完全可改**：全局模板（设置页）+ 单篇作文覆盖（工作台），随时恢复内置默认
- 注册即送一篇完整示例（一稿 → 批改 → 二稿 → 进步对比 → 精修），零等待看懂全流程

## AI 服务

| 方式 | 说明 |
|---|---|
| Agnes 公用免费 API（默认） | 免登录零配置，`agnes-3.0-flash`，支持手写图片识别与看图批改 |
| 自备 API Key（BYOK） | 任意 OpenAI 兼容端点（OpenAI / DeepSeek / OpenRouter…），Key AES-GCM 加密存储；主模型不支持图片时可单独配置视觉模型 |

百度 OCR（可选）：平台配置 `BAIDU_OCR_AK/SK` 后可作为识别备选，不消耗模型额度。

## 本地开发

```bash
npm install
# 配置 .dev.vars（参考下方）后：
npm run db:migrate   # 初始化本地 D1
npm run dev          # http://localhost:8788
```

登录联调：本地 AUTH_DB 与生产隔离，按 CLAUDE.md「本地联调统一认证」造测试会话后带 `Cookie: s=<token>` 访问。

`.dev.vars` 模板（本地开发用，gitignored）：

```ini
ENCRYPTION_KEY=<本地随机 32+ 字符>
AGNES_API_KEY=<真实共享密钥，可选；留空则免费通道不可用>
BAIDU_OCR_AK=<复用 english-reading-assistant 的百度应用（AppID 8096172）>
BAIDU_OCR_SK=<同上>
```

类型检查：`npm run typecheck`

## 部署（Cloudflare Workers）

已上线 https://writing.yuer6327.top/ ，日常更新只需：

```bash
npm run typecheck && npm run db:migrate:remote && npm run deploy
```

首次部署（已完成）备忘：`wrangler d1 create writing-assistant-db`（真实 database_id 已写入 wrangler.toml）、secrets（ENCRYPTION_KEY / AGNES_API_KEY）、路由 `writing.yuer6327.top/*` 由 wrangler.toml `routes` 维护；DNS 灰云 CNAME 由 dns-guard 管理（RECORDS 已收录本子域）。

推送到 `main` 分支时 GitHub Actions 自动执行类型检查 → 远程迁移 → 部署（需配置 `CLOUDFLARE_API_TOKEN` secret）。

## 项目结构

见 [CLAUDE.md](./CLAUDE.md)（面向 AI 编码助手的完整架构指南：数据模型、AI 调用约定、SPA 前端约定、扩展指南）。
