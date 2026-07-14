-- 一字接龍：帳號與排名系統資料表（D1 / SQLite）
-- 建立指令見 README「帳號與排行榜」段落。

-- 玩家（以 client 產生的 UUID 為主鍵，無需登入）
CREATE TABLE IF NOT EXISTS players (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  rating     INTEGER NOT NULL DEFAULT 1000, -- ELO 積分，初始 1000
  wins       INTEGER NOT NULL DEFAULT 0,
  losses     INTEGER NOT NULL DEFAULT 0,
  games      INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL DEFAULT 0     -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_players_rating ON players (rating DESC);
CREATE INDEX IF NOT EXISTS idx_players_wins ON players (wins DESC);

-- 對戰紀錄（每場結束寫一筆）
CREATE TABLE IF NOT EXISTS matches (
  id           TEXT PRIMARY KEY,
  p1_id        TEXT NOT NULL,
  p2_id        TEXT NOT NULL,
  p1_name      TEXT NOT NULL,
  p2_name      TEXT NOT NULL,
  winner_id    TEXT,                         -- 勝方 id；平手為 NULL（理論上不會發生）
  p1_score     INTEGER NOT NULL,
  p2_score     INTEGER NOT NULL,
  mode         TEXT NOT NULL,                -- normal | devil
  reason       TEXT NOT NULL,                -- score | opponent_left
  rating_delta INTEGER NOT NULL DEFAULT 0,   -- 勝方本場獲得的 ELO 分數
  created_at   INTEGER NOT NULL              -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_matches_created ON matches (created_at DESC);
