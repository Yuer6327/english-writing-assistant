-- 游客 LongCat 体验档：每天 1 次（北京时间日，与免费通道 3 次相互独立）
-- 同一 (user_id, day) 最多一条 kind='longcat' 计数：
--   业务预检在 src/utils/quota.ts checkReviewGate；本索引是跨 isolate 并发双花的硬约束
--   （两个请求同时过预检时，第二个 INSERT OR IGNORE 落 0 行，路由层据此拦截）。
-- kind='longcat' 行只由游客批改写入（登录用户 LongCat 不计次），部分索引不影响其他 kind。
CREATE UNIQUE INDEX IF NOT EXISTS uq_quota_guest_longcat_day
  ON quota_events(user_id, day)
  WHERE kind = 'longcat';
