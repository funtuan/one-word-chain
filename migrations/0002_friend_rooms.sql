-- v3 好友房（開房傳連結、2 人以上）對既有資料庫的一次性套用
-- 全新資料庫直接跑 schema.sql 即可，不需本檔。
-- 套用：npx wrangler d1 execute one-word-chain --remote --file=./migrations/0002_friend_rooms.sql
-- 註：SQLite 的 ALTER TABLE ADD COLUMN 不支援 IF NOT EXISTS；若已加過此欄位，該行會報錯（可忽略）。

-- game_events 補上來源與多人比分快照
-- source：match（隨機配對，舊資料為 NULL 等同 match）| room（好友房）
-- scores：好友房的全座位比分快照（JSON 陣列，依 seat 排列）；隨機配對為 NULL（沿用 p1_score/p2_score）
ALTER TABLE game_events ADD COLUMN source TEXT;
ALTER TABLE game_events ADD COLUMN scores TEXT;

-- 好友房整場紀錄（每場結束寫一筆；rematch 以新 id 各自成場）
-- 好友房不計 ELO、不動 players 勝敗場（可互刷，僅留作分析）。
CREATE TABLE IF NOT EXISTS room_matches (
  id           TEXT PRIMARY KEY,              -- 該場 sessionId（同房 rematch 各自獨立）
  room_code    TEXT NOT NULL,                 -- 6 碼房號
  mode         TEXT NOT NULL,                 -- normal | devil
  rounds       INTEGER NOT NULL,              -- 實際打完的回合數
  player_count INTEGER NOT NULL,
  reason       TEXT NOT NULL,                 -- rounds（固定回合打完）| players_left（中離只剩 1 人）
  created_at   INTEGER NOT NULL               -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_room_matches_created ON room_matches (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_room_matches_code ON room_matches (room_code);

-- 好友房各座位的名次（每場每座位一筆）
CREATE TABLE IF NOT EXISTS room_match_players (
  match_id   TEXT NOT NULL,                   -- room_matches.id
  player_id  TEXT NOT NULL,                   -- 玩家 UUID（匿名為空字串）
  name       TEXT NOT NULL,
  seat       INTEGER NOT NULL,                -- 座位（0 起）
  score      INTEGER NOT NULL,
  rank       INTEGER NOT NULL,                -- 名次（1 起；同分共列）
  eliminated INTEGER NOT NULL DEFAULT 0,      -- 是否中離淘汰
  PRIMARY KEY (match_id, seat)
);
CREATE INDEX IF NOT EXISTS idx_room_match_players_player ON room_match_players (player_id);
