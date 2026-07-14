-- 遊玩歷史事件流 + matches 關聯欄位（對既有資料庫的一次性套用）
-- 全新資料庫直接跑 schema.sql 即可，不需本檔。
-- 套用：npx wrangler d1 execute one-word-chain --remote --file=./migrations/0001_game_history.sql
-- 註：SQLite 的 ALTER TABLE ADD COLUMN 不支援 IF NOT EXISTS；若已加過此欄位，該行會報錯（可忽略）。

-- matches 補上 game_id，讓整場摘要能 join 到事件流（舊資料為 NULL）
ALTER TABLE matches ADD COLUMN game_id TEXT;
CREATE INDEX IF NOT EXISTS idx_matches_game ON matches (game_id);

-- 遊玩歷史事件流（append-only，一個動作寫一筆）
CREATE TABLE IF NOT EXISTS game_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id     TEXT NOT NULL,
  seq         INTEGER NOT NULL,
  round       INTEGER NOT NULL,
  type        TEXT NOT NULL,                 -- round_start|move|challenge|timeout_extend|timeout|leave|game_over
  mode        TEXT NOT NULL,
  actor       TEXT,
  actor_id    TEXT,
  char        TEXT,
  pos_index   INTEGER,
  sentence    TEXT,
  challenged  TEXT,
  score_a     INTEGER,
  score_b     INTEGER,
  delta       INTEGER,
  awarded_to  TEXT,
  awarded_pts INTEGER,
  restriction TEXT,
  violation   TEXT,
  reason      TEXT,
  p1_score    INTEGER NOT NULL DEFAULT 0,
  p2_score    INTEGER NOT NULL DEFAULT 0,
  winner      TEXT,
  detail      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_game_events_game ON game_events (game_id, seq);
CREATE INDEX IF NOT EXISTS idx_game_events_type ON game_events (type);
CREATE INDEX IF NOT EXISTS idx_game_events_created ON game_events (created_at DESC);
