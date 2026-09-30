'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'app.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 数据库初始化（幂等）
db.exec(`
CREATE TABLE IF NOT EXISTS scripts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  original_srt TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS source_segments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id  INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,          -- 原稿中的序号（从 1 开始）
  start_ms   INTEGER NOT NULL,
  end_ms     INTEGER NOT NULL,
  text       TEXT NOT NULL,
  UNIQUE(script_id, seq)
);

CREATE TABLE IF NOT EXISTS branches (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id  INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'revision',  -- revision | merged
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS branch_segments (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id  INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  ord        INTEGER NOT NULL,          -- 分支内顺序（从 1 开始）
  start_ms   INTEGER NOT NULL,
  end_ms     INTEGER NOT NULL,
  text       TEXT NOT NULL
);

-- 来源关联：
-- 拆分：一个来源片段关联到多个分支片段
-- 合并：多个来源片段关联到同一个分支片段
CREATE TABLE IF NOT EXISTS segment_sources (
  branch_segment_id INTEGER NOT NULL REFERENCES branch_segments(id) ON DELETE CASCADE,
  source_id  INTEGER NOT NULL REFERENCES source_segments(id) ON DELETE CASCADE,
  PRIMARY KEY (branch_segment_id, source_id)
);

-- 放映质检规则（每份稿件一份；阈值为 NULL 表示不检查该项）
CREATE TABLE IF NOT EXISTS qc_rules (
  script_id       INTEGER PRIMARY KEY REFERENCES scripts(id) ON DELETE CASCADE,
  min_duration_ms INTEGER,                 -- 单条显示时长下限（毫秒）
  max_duration_ms INTEGER,                 -- 单条显示时长上限（毫秒）
  max_cps         REAL,                    -- 每秒可见字符数上限
  min_gap_ms      INTEGER,                 -- 相邻片段最小间隔（毫秒）
  version         INTEGER NOT NULL DEFAULT 1,  -- 规则版本：实际内容变化时 +1
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS qc_banned_words (
  script_id INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  pos       INTEGER NOT NULL,              -- 词序
  word      TEXT NOT NULL,
  UNIQUE(script_id, word)
);

-- 质检豁免：仅对「该分支当时的片段内容/时码 + 规则版本」有效。
-- branch_segment_id 不加外键：片段被删除后保留审计记录。
CREATE TABLE IF NOT EXISTS qc_exemptions (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  branch_id         INTEGER NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
  branch_segment_id INTEGER NOT NULL,
  rule_code         TEXT NOT NULL,         -- duration_min | duration_max | cps | gap | banned
  detail            TEXT NOT NULL DEFAULT '',  -- banned: word:<词>；其余规则为固定标识
  reason            TEXT NOT NULL DEFAULT '',
  rule_version      INTEGER NOT NULL,      -- 豁免时的规则版本
  snap_ord          INTEGER NOT NULL,      -- 以下为豁免时的片段快照
  snap_start_ms     INTEGER NOT NULL,
  snap_end_ms       INTEGER NOT NULL,
  snap_text         TEXT NOT NULL,
  snap_prev_end_ms  INTEGER,               -- gap 命中：上一片段当时的终点
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_source_segments_script ON source_segments(script_id);
CREATE INDEX IF NOT EXISTS idx_branches_script ON branches(script_id);
CREATE INDEX IF NOT EXISTS idx_branch_segments_branch ON branch_segments(branch_id);
CREATE INDEX IF NOT EXISTS idx_segment_sources_bs ON segment_sources(branch_segment_id);
CREATE INDEX IF NOT EXISTS idx_segment_sources_src ON segment_sources(source_id);
CREATE INDEX IF NOT EXISTS idx_qc_banned_words_script ON qc_banned_words(script_id);
CREATE INDEX IF NOT EXISTS idx_qc_exemptions_branch ON qc_exemptions(branch_id);
-- 同一命中槽位（分支 + 片段 + 规则 + 细节）至多一条豁免
CREATE UNIQUE INDEX IF NOT EXISTS idx_qc_exemptions_slot
  ON qc_exemptions(branch_id, branch_segment_id, rule_code, detail);
`);

module.exports = db;
