-- 游客「每稿一次」的跨 isolate 硬约束：同一游客稿最多一条批改记录。
-- 此前仅靠 quota_events 唯一索引 + 同 isolate 内存锁，两个 isolate 并发批改
-- 同一游客稿件时 reviews 表可能落两条（计费已 settle 两次，前端取最新一条展示）。
-- 已于 2026-10-31 核查线上无存量重复行；DELETE 仅为幂等自愈保留（防部分环境有残留）。
-- 登录用户不受影响（user_id 不匹配 guest:% 谓词）。

DELETE FROM reviews WHERE user_id LIKE 'guest:%'
  AND id NOT IN (SELECT MAX(id) FROM reviews WHERE user_id LIKE 'guest:%' GROUP BY draft_id);

CREATE UNIQUE INDEX IF NOT EXISTS uq_reviews_guest_draft
  ON reviews(draft_id)
  WHERE user_id LIKE 'guest:%';
