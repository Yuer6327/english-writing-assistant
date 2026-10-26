-- ============================================================
-- 0002 — 批改次数额度（业务侧「成功计数」）
-- ============================================================
-- 为什么不用 billing 的 quota_usage：
--   1. 口径是「**成功**批改 N 次」——billing 在 hold（调用前）就扣次数，
--      失败也照样扣，用户会看到"没批改成却少了次数"；
--   2. 规则带业务语义：游客每天只能写 1 篇、只能一稿/二稿/三稿、每稿一次；
--      这些只有业务库知道。
-- 因此：billing 只负责钱（钱包/预扣/BYOK），次数额度由本表计数，
-- 调 billing.hold 时带 skipQuota 直通免费档（见 Yuer6327-billing/0002）。

CREATE TABLE IF NOT EXISTS quota_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    TEXT NOT NULL,          -- 统一认证 userId，或游客的 'guest:<设备 id>'
  day        TEXT NOT NULL,          -- 北京日期 YYYY-MM-DD（与 billing periodKey 同口径）
  kind       TEXT NOT NULL,          -- review（成功批改）/ ocr（成功识别）
  essay_id   INTEGER,
  draft_id   INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_quota_user_day ON quota_events(user_id, day, kind);
CREATE INDEX IF NOT EXISTS idx_quota_draft    ON quota_events(user_id, draft_id, kind);
