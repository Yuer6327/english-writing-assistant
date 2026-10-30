# 计费平台设计共识

状态：设计定稿，待动工 ｜ 日期：2026-10-25 ｜ 范围：跨项目统一积分计费平台（作文 App 第一期接入）

## 0. 已拍板的决策

| # | 决策 |
|---|---|
| 1 | 积分体系为**平台级**，适用于所有未来项目，不只是作文 App |
| 2 | **1 积分 = 1 元**，坚持不变；余额/消耗以积分展示（两位小数） |
| 3 | **按实际消耗计费**（token 按用量、OCR 按次），不按次数打包 |
| 4 | 不同服务允许不同加价倍率 N（售价 = 上游成本 × N） |
| 5 | **必须有预扣费**（hold/settle），防止余额被打穿 |
| 6 | 计费重请求同一用户在飞 **1 笔**；免费/小请求不计入并行数，但限频 |
| 7 | 注册**不赠送**积分（防刷号）；管理员可手动送分/调额度 |
| 8 | 日额度**按项目隔离**；额度规则区分**用户标签组**（多对多） |
| 9 | 首发付费上游：**DeepSeek 官方**（deepseek-flash，V4.1 Flash 原生多模态）；免费档维持 Agnes |
| 10 | 充值渠道**未确定**（支付宝当面付为候选，研究结论见附录 A）；在线支付前端入口显示"暂未开放"，**兑换码为唯一可用充值方式**；orders 表与状态机照建（结构先行） |
| 11 | 作文 App 先行接入；阅读助手暂不动，但平台从第一天独立 |
| 12 | 政策：积分不过期、不可提现、问题订单人工补退，写入用户协议 |
| 13 | BYOK 凭证**上收平台**（billing 加密存储），跨项目复用；作文 App `api_keys` 表迁移后废弃 |
| 14 | 计费最小单位 = **0.0001 积分（微积分）**，单次结算向上取整到 1 微积分；1 积分 = 1 元（2026-10-30 修订，原「0.01 积分」口径作废） |
| 15 | 兑换码面额：0.1 / 0.5 / 1 / 3 / 5 / 10 元 |
| 16 | 实施仓库：**Yuer6327-billing**（GitHub 私有，本地 D:\OneDrive\桌面\play\codes\Yuer6327-billing）；Worker 名 **yuer-billing** |
| 17 | DeepSeek 暂无 API Key：付费档代码完整实现但目录标记 **disabled**，配置 Key 后启用 |
| 18 | 实施交接：详细实施规格见 `docs/billing-handoff.md`（自足文档，供任何 AI / 人独立实施） |

## 1. 架构

- **独立计费 Worker（billing）+ 独立 billing D1**：钱包、账本、订单、定价目录、额度规则、用户标签全在此库。
- 各项目 Worker 通过**同账号 Service Binding** 内网调用 billing，不开公网路由、不建新子域；唯一例外是支付回调，经作文 App 公开路由代理转入（见 §6）。
- **auth 平台保持纯身份**（s cookie → UUID），永不存钱；auth 的 `users.role` 只表达权限（admin 判定），不用于计费分组。
- 定价目录与额度规则**集中**在 billing，项目侧只报"服务项 id + 用量"，不自己管价格。
- 管理入口：第一期在作文 App 内做 admin 页面（`role === 'admin'` 可见），通过 Service Binding 代理调用 billing 的 admin API，不新增 DNS 记录。

## 2. 账本与精度

- **钱包与账本的记账单位 = 0.0001 积分（微积分）的整数**；对外展示 1 积分 = 1 元（最多 4 位小数）。
- **单次结算向上取整到 1 微积分**：按 token 实结不足 0.0001 积分按 0.0001 计（单次调用最低计费 0.0001 积分）。
  定价时把单次真实成本低于一分的轻服务（如按次 OCR）直接定为一分/次即可。
- 收款侧（充值/订单）同样以分为最小单位（`amount_cents`）——分已是支付渠道的物理下限，无需更细。
- 0.0001 积分（微积分）是**钱包与账本的存储单位**，也是 `usage_logs.micro_points` 的精度；用户侧展示到 2 位小数（最多 4 位）。
- `credit_ledger` **只追加**（delta / balance_after / type / ref / note），是余额唯一真相；`wallets.balance` 仅缓存，定期 `SUM(delta)` 对账。
- 扣减原子性：D1 `batch()` 单事务完成 `UPDATE wallets SET balance = balance - ? WHERE user_id = ? AND balance >= ?`（影响行数为 0 = 余额不足）+ 账本 + 用量记录。
- settle/release 携带 hold id，**幂等**（唯一约束兜底），重试不会重复扣。

## 3. 服务目录与定价

- 服务项类型：
  - `llm:<model>`：input / output 两档 token 价；
  - `ocr:baidu`：按次；
  - 未来任意服务按"计量单位 + 单价"扩展。
- 售价 = 上游成本 × N，**N 按服务项独立配置**。
- 目录能力位：`vision`（支持图像）、`json_mode`、`heavy`（受并发锁限制）、免费档位绑定。
- **首发目录**：
  | 服务项 | tier | 说明 |
  |---|---|---|
  | `llm:agnes-flash` | free | 免费档，vision，保留 1015 排班 + RPM |
  | `llm:deepseek-flash` | paid | V4.1 Flash，**原生多模态**（图片转 token 计费），OpenAI 兼容 |
  | `ocr:baidu` | quota→paid | 按次计费；上游有月度免费量 |
- DeepSeek 图像输入约束：图片只能放 **user 消息**、仅视觉模型接受图片，违规直接 HTTP 400（不降级）——接入时按此组织消息结构；json mode 一期实测核验。
- 手写 OCR 的 VLM 兜底可挂双档：免费用户走 Agnes，付费用户可选 `deepseek-flash`。

### BYOK 平台化（跨项目复用）

- BYOK 凭证**上收至 billing 平台**：调用一个上游所需的"端点 + 模型 + 密钥"本来就是本平台的领域，用户自带凭证是同一问题的特例。AES-GCM 加密落库，billing 自持独立 ENCRYPTION_KEY。
- 各项目经 Service Binding 获取"解析后的调用配置"（语义同现有 `getUserApiKey`），不再各自存 key；主模型/视觉模型配置结构保持现状。
- 作文 App 现有 `api_keys` 表一次性迁移后废弃：迁移脚本在作文 App 侧用旧密钥解密 → 内网送 billing → 用新密钥加密落库。
- BYOK 用户不计积分、不受额度约束，与免费档/积分档三车道并存。

## 4. 免费额度与用户标签

- **用户标签制，不复用 auth role**：billing-db 自建 `user_groups`（标签）+ `user_group_members`（多对多），一个用户可贴多个标签；无标签用户落 `default` 组。
- 额度规则形如：`项目 × 服务档位 × 标签组 → 每日/每月 N 次`；规则集中配置在 billing。
- 额度**按项目隔离**（作文 App 的额度不消耗在阅读助手里）。
- 额度绑定**服务档位**而非次数券："批改·标准档（走 Agnes）每日 N 次免费"——免费的是特定档位，无法薅去跑付费模型。
- 注册不赠送。管理员手动给额度 = 两个操作：
  1. **送积分**：gift 记账（入账本、带备注），可跨项目花；
  2. **贴标签**：改变该用户命中的日额度规则。
- 命中免费额度 → 该次调用零积分，仍走对应上游，照常限频。

## 5. 预扣费时序

```
调用前: quote+hold（服务项 + 预估用量上限）
        ├─ 命中免费额度 → mode=free，直接放行（计 quota 用量）
        └─ 付费 → 冻结最坏成本；余额不足 → 402
执行中: heavy 服务（LLM 批改/润色）同一用户在飞 ≤1（内存锁，近似保护足够）
        免费/小请求不占并发，但吃 RPM + 日额度
调用后: settle(实际用量) → 差额即时退回账本
失败:   release → 全额解冻
兜底:   hold TTL 5 分钟，cron 到期自动释放（防 Worker 中途崩溃泄漏冻结）
```

- 免费车道不依赖余额：0 积分用户仍可用免费档与 BYOK。
- BYOK 车道保留，不经过 billing。

## 6. 充值（渠道未定，结构先行）

- 金额最小单位 = **分**（整数存储 `amount_cents`）；积分到账 = 元数。面额档位：**0.1 / 0.5 / 1 / 3 / 5 / 10 元**。
- **当前口径：在线支付渠道未确定**（支付宝当面付为候选，签约条件与流程研究见附录 A）。
  一期前端充值区显示"**在线支付暂未开放**"，**兑换码为唯一可用充值方式**。
- 结构先行，渠道无关：
  - `orders` 表 + 状态机（pending → paid → delivered）照建；`channel` 开放枚举（redeem_code / manual / 未来在线渠道）；
  - admin 手动补单（channel=manual）可用；
  - 将来接入任何在线渠道：预下单/回调均经作文 App 公开路由代理转入 billing（billing 保持无公网路由），回调幂等。
- **兑换码（已定）**：admin 批量生成高熵码；兑换接口强限流（防爆破）；0.1、0.5 档适合活动赠码。
- 微信支付个人侧无网站支付 API（小微商户经服务商仅得收款码）；虎皮椒（PC 扫码可用，2025-11 起微信唤醒已关）与面包多（2022 域名被停解析前科）仅作备案候选。

## 7. 数据表（billing-db 草图）

```sql
wallets            (user_id PK, balance, updated_at)          -- balance 为缓存，单位=0.01积分
credit_ledger      (id, user_id, delta, balance_after, type, ref_type, ref_id, note, created_at)
usage_logs         (id, user_id, project, service, prompt_tokens, completion_tokens, calls, micro_points, status, hold_id, created_at)
holds              (id, user_id, service, frozen, expires_at, status)  -- active/settled/released/expired
orders             (id, user_id, channel, amount_cents, points, status, external_ref, created_at, paid_at)
redemption_codes   (code PK, points, batch, status, used_by, used_at)
byok_keys          (user_id PK, encrypted_key, api_base_url, model_name, vision_api_base_url, vision_model_name, vision_encrypted_key, updated_at)
user_groups        (group_key PK, name, note)
user_group_members (user_id, group_key, PRIMARY KEY(user_id, group_key))
quota_rules        (id, project, service, group_key, period, limit_n, enabled)
quota_usage        (user_id, project, service, period, used, PRIMARY KEY(user_id, project, service, period))
```

## 8. 内部 API（Service Binding 调用）

- `POST /internal/hold`  → `{mode: 'free' | 'hold', hold_id?, frozen?}`（额度判定并入此处）
- `POST /internal/holds/:id/settle`  → 按实际用量结算
- `POST /internal/holds/:id/release` → 失败解冻
- `POST /internal/redeem` → 兑换码
- `POST /admin/*` → 送分 / 贴标 / 订单与用量查询 / 规则配置（经作文 App 代理，role=admin 鉴权）

## 9. 一期范围

1. billing Worker（仓库 **Yuer6327-billing**，Worker 名 **yuer-billing**）+ billing D1 迁移 + 定价目录
2. DeepSeek 官方接入（deepseek-flash：代码完整、目录 disabled；拿到 Key 后实测核验 json mode 与图像输入再启用）
3. 兑换码充值全链路 + orders 表/状态机（在线支付渠道未定，结构先行，前端显示"暂未开放"）
4. BYOK 迁移：作文 App `api_keys` → billing `byok_keys`（一次性），作文 App 改走 Service Binding 取配置
5. 作文 App 改造：批改/润色页模型选择（免费档 / 积分档 / 我的 Key）、余额与消耗展示、扣费全链路、充值区（暂未开放提示 + 兑换码）
6. 最小 admin：送分、贴标签、查订单、生成兑换码、手动补单
7. 不迁移阅读助手、不开新子域；实施细节见 `docs/billing-handoff.md`

## 10. 待配置项（动工时定）

- 各服务 N 值与售价表（取 DeepSeek 控制台实际单价后计算；单次成本低于一分的轻服务直接定 0.01 积分/次）
- 日额度初值：批改·标准档 3 次/日、OCR 5 次/日（default 组，后台可调）
- 充值渠道决策与签约（若选当面付：实名支付宝 + 门店照片/地址辅助材料，见附录 A）
- DeepSeek 启用时：`wrangler secret put DEEPSEEK_API_KEY` + 目录 enabled 置 true + 实测核验
- 用户协议文案（不过期/不提现/人工补退/未成年人提示）

## 附录 A：支付宝当面付研究结论（渠道候选，未定）

- 个人**不强制营业执照**：实名支付宝 + 门店照片/地址等辅助材料可签**基础版**（官方文档 2026-06 更新）；
  限额单笔 ≤1000 元、单日 ≤5 万，对 10 元封顶的充值面额毫无压力；办个体户执照可升级解除限额。
- 直连官方 API（`alipay.trade.precreate` 预下单二维码 + 异步回调验签），资金直达本人商家账户，
  **无中间商、无跑路风险**；费率约 0.6% 量级，以签约页为准。
- 签约路径：b.alipay.com → 当面付"立即开通"（执照可不上传）→ open.alipay.com 创建应用 →
  官方密钥工具生成 RSA2 密钥对 → 配置 APPID + 应用私钥 + 支付宝公钥。
- 门店材料要点：招牌名称与店铺名**一致**、照片需"像真实门脸"（建议自行打印店名拍照，勿盗用他人门店照）、
  地址真实可达；类目**避开"金融/网络服务"**（选教育/软件服务/生活服务）；审核约 30 分钟（9:00–19:00）。
- 风险定性：当面付官方定位为线下当面交易，个人网站作线上收款属普遍但场景错位的用法；
  风险是产品政策调整而非资金安全——钱不经过任何第三方。
- 技术可行：CF Workers 纯 fetch + WebCrypto 实现 RSA2 签名即可，无需官方 SDK。
- 其他渠道实况（2026-10 查证）：爱发电未停运但 2024-07 有备案被注销前科，只可做备份；PayJS 已死（无法充值）；
  微信支付个人侧无网站支付 API。
