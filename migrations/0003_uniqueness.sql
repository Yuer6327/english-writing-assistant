-- 上线前必须先执行审查查询；若有重复行，先备份并保留每组 id 最小的一行。
-- SELECT user_id, draft_id, kind, COUNT(*) c FROM quota_events
--  WHERE draft_id IS NOT NULL AND user_id LIKE 'guest:%' GROUP BY 1,2,3 HAVING c > 1;
-- SELECT essay_id, version, COUNT(*) c FROM drafts GROUP BY 1,2 HAVING c > 1;

ALTER TABLE reviews ADD COLUMN meta TEXT;

-- 游客每稿免费批改一次；登录用户仍可重批，不受此索引影响。
CREATE UNIQUE INDEX IF NOT EXISTS uq_quota_guest_draft
  ON quota_events(user_id, draft_id, kind)
  WHERE draft_id IS NOT NULL AND user_id LIKE 'guest:%';

CREATE UNIQUE INDEX IF NOT EXISTS uq_drafts_version
  ON drafts(essay_id, version);
