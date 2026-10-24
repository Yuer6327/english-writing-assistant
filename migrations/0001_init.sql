-- ============================================================
-- 英语作文批改助手 — D1 初始迁移
-- 账户体系使用统一认证平台（auth.yuer6327.top / auth-db），
-- 本库没有 users 表；各表的 user_id = 平台用户 id。
-- ============================================================

-- 用户级标记（如 seeded：新用户首次访问时是否已预置示例作文）
CREATE TABLE IF NOT EXISTS user_flags (
  user_id    TEXT    NOT NULL,
  flag       TEXT    NOT NULL,
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, flag)
);

-- 用户 BYOK API 密钥（AES-GCM 加密存储）
CREATE TABLE IF NOT EXISTS api_keys (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT    NOT NULL,
  encrypted_key TEXT    NOT NULL,   -- iv_base64:ciphertext_base64
  provider      TEXT    NOT NULL DEFAULT 'byok',   -- byok / agnes
  api_base_url  TEXT    DEFAULT 'https://api.openai.com/v1',
  model_name    TEXT    DEFAULT 'gpt-4o-mini',
  -- 视觉模型（可选）：BYOK 主模型不支持图片时（如 deepseek-chat）单独指定
  -- 用于手写 OCR / 图画作文看图批改；为空则直接用主模型发图
  vision_api_base_url   TEXT,
  vision_model_name     TEXT,
  vision_encrypted_key  TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 作文（题目 + 元信息）
CREATE TABLE IF NOT EXISTS essays (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      TEXT NOT NULL,
  title        TEXT    NOT NULL,
  genre        TEXT    NOT NULL DEFAULT 'sh-gaokao-essay',  -- v1 仅上海高考大作文
  topic_text   TEXT    NOT NULL,            -- 题目文本
  topic_images TEXT,                        -- JSON array：data URL（压缩后 ≤300KB/张，≤3 张）
  custom_prompt TEXT,                       -- 本作文自定义批改提示词（空则用用户模板/内置默认）
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- 稿件（一稿/二稿/…）
CREATE TABLE IF NOT EXISTS drafts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  essay_id       INTEGER NOT NULL,
  user_id        TEXT    NOT NULL,
  version        INTEGER NOT NULL,          -- 1 = 一稿
  text           TEXT    NOT NULL,
  source         TEXT    NOT NULL DEFAULT 'text',  -- photo(拍照OCR) / text(输入) / polish(精修采纳)
  word_count     INTEGER NOT NULL DEFAULT 0,
  handwriting_score REAL,                  -- OCR(大模型)给出的书写质量 0-1；百度OCR/直接输入为 NULL
  ocr_images     TEXT,                     -- JSON array：原始照片 data URL（压缩后存储）
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (essay_id) REFERENCES essays(id) ON DELETE CASCADE
);

-- 批改结果
CREATE TABLE IF NOT EXISTS reviews (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id   INTEGER NOT NULL,
  essay_id   INTEGER NOT NULL,
  user_id    TEXT    NOT NULL,
  result     TEXT    NOT NULL,   -- JSON：{diagnosis, subscores, score, overall_comment, issues, revised_essay, suggestions, improvement?}
  reviewed_text TEXT,             -- 批改时的稿件快照（稿件后续修改不影响已出报告）
  model      TEXT,               -- 使用的模型（审计用）
  created_at TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE CASCADE
);

-- 精修 / 全文润色记录
CREATE TABLE IF NOT EXISTS polishes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  essay_id    INTEGER NOT NULL,
  draft_id    INTEGER,                    -- 关联稿件（全文润色必填；片段精修可空）
  user_id     TEXT NOT NULL,
  mode        TEXT    NOT NULL,           -- fragment / full
  fragment    TEXT,                       -- 片段精修的原文片段
  instruction TEXT,                       -- 学生附加要求
  result      TEXT    NOT NULL,           -- JSON
  created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (essay_id) REFERENCES essays(id) ON DELETE CASCADE
);

-- 用户自定义提示词模板（按题型覆盖内置默认；内置默认硬编码在 src/utils/prompts.ts）
CREATE TABLE IF NOT EXISTS prompt_templates (
  user_id    TEXT    NOT NULL,
  genre      TEXT    NOT NULL,
  content    TEXT    NOT NULL,
  updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, genre)
);

-- ── 索引 ──
CREATE INDEX IF NOT EXISTS idx_essays_user     ON essays(user_id);
CREATE INDEX IF NOT EXISTS idx_drafts_essay    ON drafts(essay_id);
CREATE INDEX IF NOT EXISTS idx_reviews_draft   ON reviews(draft_id);
CREATE INDEX IF NOT EXISTS idx_reviews_essay   ON reviews(essay_id);
CREATE INDEX IF NOT EXISTS idx_polishes_essay  ON polishes(essay_id);
