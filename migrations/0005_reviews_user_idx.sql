-- 0005: reviews 按 user_id 的索引 —— F3「注入命中累计」门禁查询
-- （WHERE user_id = ? AND created_at > ... AND json_extract(meta,...)）此前是全表扫描；
-- reviews 随批改次数无界增长，索引是查询的前置条件。
CREATE INDEX IF NOT EXISTS idx_reviews_user_created ON reviews(user_id, created_at);
