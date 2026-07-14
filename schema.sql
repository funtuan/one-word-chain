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
  game_id      TEXT,                         -- Game Durable Object id（可 join game_events；舊資料為 NULL）
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
CREATE INDEX IF NOT EXISTS idx_matches_game ON matches (game_id);

-- 遊玩歷史事件流（append-only，一個動作寫一筆，供日後分析）
-- type 種類：
--   round_start    回合開始（種子詞、惡魔限制、先手）
--   move           一次接龍（放入的字與位置）
--   challenge      挑戰結算（AI 評分、得分、違規判定）
--   timeout_extend 超時但用掉額度 +10 秒（不計分）
--   timeout        超時且無額度，對方直接 +3
--   leave          有人離開／斷線，對方判勝
--   game_over      整場結束（勝負、原因）
CREATE TABLE IF NOT EXISTS game_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id     TEXT NOT NULL,                 -- Game Durable Object id（整場穩定）
  seq         INTEGER NOT NULL,              -- 場內事件序號（1 起遞增，決定順序）
  round       INTEGER NOT NULL,              -- 回合編號（1 起）
  type        TEXT NOT NULL,                 -- 見上方 type 說明
  mode        TEXT NOT NULL,                 -- normal | devil（冗餘存放，省去 join）
  actor       TEXT,                          -- 事件主體 p1 | p2 | NULL
  actor_id    TEXT,                          -- actor 的玩家 UUID（可 NULL）

  -- 接龍 move / 被挑戰字
  char        TEXT,                          -- move：放入的字；challenge/timeout：被結算的末字（超時為 NULL）
  pos_index   INTEGER,                       -- move：放入位置
  sentence    TEXT,                          -- 事件當下的完整句子（round_start 為種子詞）

  -- 挑戰／超時結算
  challenged  TEXT,                          -- challenge：被挑戰方 p1 | p2
  score_a     INTEGER,                       -- AI 整句合理度 -3~3
  score_b     INTEGER,                       -- AI 末字語助詞程度 0~3
  delta       INTEGER,                       -- 判定值（>0 被挑戰方得分、<0 挑戰方得分）
  awarded_to  TEXT,                          -- 得分方 p1 | p2 | NULL（平手）
  awarded_pts INTEGER,                       -- 得分
  restriction TEXT,                          -- 惡魔限制種類 position|zhuyin|pos|meaning 或 NULL
  violation   TEXT,                          -- 違規種類 filler|zhuyin|pos|meaning 或 NULL
  reason      TEXT,                          -- AI 或系統說明文字

  -- 比分快照（事件後）
  p1_score    INTEGER NOT NULL DEFAULT 0,
  p2_score    INTEGER NOT NULL DEFAULT 0,
  winner      TEXT,                          -- game_over：勝方 p1 | p2 | NULL
  detail      TEXT,                          -- 長尾結構化資料（JSON）：finals / zhuyinMatch / posViolation / meaningChanged 等
  created_at  INTEGER NOT NULL               -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_game_events_game ON game_events (game_id, seq);
CREATE INDEX IF NOT EXISTS idx_game_events_type ON game_events (type);
CREATE INDEX IF NOT EXISTS idx_game_events_created ON game_events (created_at DESC);

-- AI 挑戰花費紀錄（每次挑戰結算寫一筆，含重試累計）
CREATE TABLE IF NOT EXISTS ai_costs (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  game_id           TEXT,                          -- Game Durable Object id
  model             TEXT NOT NULL,                 -- 例：@cf/openai/gpt-oss-120b
  mode              TEXT,                          -- normal | devil
  restriction       TEXT,                          -- 惡魔限制種類（position/zhuyin/pos/meaning）或 NULL
  prompt_tokens     INTEGER NOT NULL DEFAULT 0,    -- 累計輸入 token（含所有重試）
  completion_tokens INTEGER NOT NULL DEFAULT 0,    -- 累計輸出 token（含 reasoning、含所有重試）
  total_tokens      INTEGER NOT NULL DEFAULT 0,
  cost_usd          REAL NOT NULL DEFAULT 0,       -- 本次挑戰總花費（USD）
  attempts          INTEGER NOT NULL DEFAULT 1,    -- 實際呼叫模型次數
  ok                INTEGER NOT NULL DEFAULT 1,    -- 是否成功取得可解析結果
  created_at        INTEGER NOT NULL               -- epoch ms
);
CREATE INDEX IF NOT EXISTS idx_ai_costs_created ON ai_costs (created_at DESC);
