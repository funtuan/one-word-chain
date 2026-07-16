// D1 存取層：玩家帳號、排行榜、對戰紀錄（隨機配對／好友房）、AI 花費、遊玩歷史事件
import type {
  GameMode,
  GameSource,
  PlayerIdentity,
  PlayerStats,
  Role,
} from "./types";
import type { JudgeUsage } from "./llm";
import { eloOutcome, type PlayerElo } from "./elo";

const PLAYER_COLS = "id, name, rating, wins, losses, games";

// 註冊／更新玩家名稱（無需登入，新玩家 rating 預設 1000）
export async function registerPlayer(
  db: D1Database,
  id: string,
  name: string,
  now: number,
): Promise<PlayerStats> {
  await db
    .prepare(
      `INSERT INTO players (id, name, rating, wins, losses, games, updated_at)
       VALUES (?, ?, 1000, 0, 0, 0, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
    )
    .bind(id, name, now)
    .run();
  const player = await getPlayer(db, id);
  return player ?? { id, name, rating: 1000, wins: 0, losses: 0, games: 0 };
}

export async function getPlayer(
  db: D1Database,
  id: string,
): Promise<PlayerStats | null> {
  const row = await db
    .prepare(`SELECT ${PLAYER_COLS} FROM players WHERE id = ?`)
    .bind(id)
    .first<PlayerStats>();
  return row ?? null;
}

export async function getLeaderboard(
  db: D1Database,
  limit: number,
): Promise<PlayerStats[]> {
  const { results } = await db
    .prepare(
      `SELECT ${PLAYER_COLS} FROM players
       WHERE games > 0
       ORDER BY rating DESC, wins DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<PlayerStats>();
  return results ?? [];
}

// 取玩家目前名次與戰績（未上榜／無場數回 null）。
// 名次定義與 getLeaderboard 的排序一致：rating DESC, wins DESC。
export async function getPlayerRank(
  db: D1Database,
  id: string,
): Promise<{ rank: number; player: PlayerStats } | null> {
  const player = await getPlayer(db, id);
  if (!player || player.games <= 0) return null;
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS above FROM players
       WHERE games > 0 AND (rating > ? OR (rating = ? AND wins > ?))`,
    )
    .bind(player.rating, player.rating, player.wins)
    .first<{ above: number }>();
  return { rank: (row?.above ?? 0) + 1, player };
}

// 取玩家目前 rating 與已玩場數（不存在則預設 1000 / 0），供動態 K 結算
async function eloOf(db: D1Database, id: string): Promise<PlayerElo> {
  const row = await db
    .prepare("SELECT rating, games FROM players WHERE id = ?")
    .bind(id)
    .first<{ rating: number; games: number }>();
  return { rating: row?.rating ?? 1000, games: row?.games ?? 0 };
}

export interface RecordMatchInput {
  matchId: string;
  gameId: string; // Game Durable Object id，供 join game_events
  p1: PlayerIdentity;
  p2: PlayerIdentity;
  winner: Role | null; // 勝方；理論上結算一定有勝方
  scores: { p1: number; p2: number };
  mode: GameMode;
  reason: "score" | "opponent_left";
  now: number;
}

// 寫入一場對戰紀錄，並依 ELO 更新雙方積分與勝負場數（單一 batch）
export async function recordMatch(
  db: D1Database,
  input: RecordMatchInput,
): Promise<{ ratingDelta: number }> {
  const { p1, p2, winner, scores, mode, reason, matchId, gameId, now } = input;

  const [e1, e2] = await Promise.all([eloOf(db, p1.id), eloOf(db, p2.id)]);

  let newR1 = e1.rating;
  let newR2 = e2.rating;
  let ratingDelta = 0;
  if (winner === "p1") {
    const o = eloOutcome(e1, e2);
    newR1 = o.winner.after;
    newR2 = o.loser.after;
    ratingDelta = o.winner.delta;
  } else if (winner === "p2") {
    const o = eloOutcome(e2, e1);
    newR2 = o.winner.after;
    newR1 = o.loser.after;
    ratingDelta = o.winner.delta;
  }

  const p1Win = winner === "p1" ? 1 : 0;
  const p1Loss = winner === "p2" ? 1 : 0;
  const p2Win = winner === "p2" ? 1 : 0;
  const p2Loss = winner === "p1" ? 1 : 0;

  const upsert = (
    id: string,
    name: string,
    rating: number,
    win: number,
    loss: number,
  ) =>
    db
      .prepare(
        `INSERT INTO players (id, name, rating, wins, losses, games, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           rating = excluded.rating,
           wins = players.wins + excluded.wins,
           losses = players.losses + excluded.losses,
           games = players.games + 1,
           updated_at = excluded.updated_at`,
      )
      .bind(id, name, rating, win, loss, now);

  const winnerId = winner === "p1" ? p1.id : winner === "p2" ? p2.id : null;

  await db.batch([
    upsert(p1.id, p1.name, newR1, p1Win, p1Loss),
    upsert(p2.id, p2.name, newR2, p2Win, p2Loss),
    db
      .prepare(
        `INSERT INTO matches
           (id, game_id, p1_id, p2_id, p1_name, p2_name, winner_id, p1_score, p2_score, mode, reason, rating_delta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        matchId,
        gameId,
        p1.id,
        p2.id,
        p1.name,
        p2.name,
        winnerId,
        scores.p1,
        scores.p2,
        mode,
        reason,
        ratingDelta,
        now,
      ),
  ]);

  return { ratingDelta };
}

// ---- 好友房對戰紀錄（不計 ELO、不動 players 勝敗場；純分析用）----

export interface RecordRoomMatchInput {
  matchId: string; // 好友房每場的 sessionId（rematch 各自獨立）
  roomCode: string;
  mode: GameMode;
  rounds: number; // 實際打了幾回合
  playerCount: number;
  reason: string; // rounds | players_left
  players: {
    id: string;
    name: string;
    seat: number;
    score: number;
    rank: number;
    eliminated: boolean;
  }[];
  now: number;
}

// 寫入一場好友房紀錄與各座位名次（單一 batch）
export async function recordRoomMatch(
  db: D1Database,
  input: RecordRoomMatchInput,
): Promise<void> {
  const stmts = [
    db
      .prepare(
        `INSERT INTO room_matches
           (id, room_code, mode, rounds, player_count, reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        input.matchId,
        input.roomCode,
        input.mode,
        input.rounds,
        input.playerCount,
        input.reason,
        input.now,
      ),
    ...input.players.map((p) =>
      db
        .prepare(
          `INSERT INTO room_match_players
             (match_id, player_id, name, seat, score, rank, eliminated)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.matchId,
          p.id,
          p.name,
          p.seat,
          p.score,
          p.rank,
          p.eliminated ? 1 : 0,
        ),
    ),
  ];
  await db.batch(stmts);
}

// ---- AI 花費 ----

export interface RecordAiCostInput {
  gameId: string;
  mode: GameMode;
  restriction: string | null; // 惡魔限制種類，無則 null
  usage: JudgeUsage;
  now: number;
}

// 寫入一次挑戰的模型花費（每次挑戰結算一筆）
export async function recordAiCost(
  db: D1Database,
  input: RecordAiCostInput,
): Promise<void> {
  const { gameId, mode, restriction, usage, now } = input;
  await db
    .prepare(
      `INSERT INTO ai_costs
         (game_id, model, mode, restriction, prompt_tokens, completion_tokens,
          total_tokens, cost_usd, attempts, ok, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      gameId,
      usage.model,
      mode,
      restriction,
      usage.promptTokens,
      usage.completionTokens,
      usage.totalTokens,
      usage.costUsd,
      usage.attempts,
      usage.ok ? 1 : 0,
      now,
    )
    .run();
}

// ---- 管理後台統計報表 ----

const DAY_MS = 86_400_000;

// 依時區位移把 epoch ms 換成當地日期字串 YYYY-MM-DD（預設 UTC+8）。
function dayKey(ms: number, offsetMin: number): string {
  return new Date(ms + offsetMin * 60_000).toISOString().slice(0, 10);
}

// SQLite 端把 created_at（epoch ms）依位移換算成當地日期字串，與 dayKey 對齊。
const dayExpr = (col: string) =>
  `date((${col}/1000) + (? * 60), 'unixepoch')`;

export interface AdminOverview {
  totalPlayers: number; // 曾註冊玩家數
  totalMatches: number; // 累計對戰場數
  matches24h: number; // 近 24 小時場數
  matches7d: number; // 近 7 天場數
  activePlayers7d: number; // 近 7 天有出賽的相異玩家數
  newPlayers7d: number; // 近 7 天首度出賽的玩家數
  aiCost7dUsd: number; // 近 7 天 AI 花費（USD）
  aiCostTotalUsd: number; // 累計 AI 花費（USD）
  modeSplit7d: { normal: number; devil: number }; // 近 7 天模式分布（隨機配對）
  // ---- 好友房（多人）：獨立統計，不與上方隨機配對合算 ----
  roomTotal: number; // 累計好友房場數
  roomMatches24h: number; // 近 24 小時好友房場數
  roomMatches7d: number; // 近 7 天好友房場數
  roomActivePlayers7d: number; // 近 7 天有進好友房的相異玩家數（含匿名者排除）
  roomAvgPlayers7d: number; // 近 7 天好友房平均人數
  roomModeSplit7d: { normal: number; devil: number }; // 近 7 天好友房模式分布
}

// 後台總覽數字（單次併發查詢）。
export async function getAdminOverview(
  db: D1Database,
  now: number,
): Promise<AdminOverview> {
  const t24 = now - DAY_MS;
  const t7 = now - 7 * DAY_MS;
  const num = (r: { c?: number } | null) => r?.c ?? 0;

  const [
    totalPlayers,
    totalMatches,
    m24,
    m7,
    active7,
    new7,
    cost7,
    costTotal,
    modeRows,
    roomTotal,
    room24,
    room7,
    roomActive7,
    roomModeRows,
  ] = await Promise.all([
    db.prepare(`SELECT COUNT(*) c FROM players`).first<{ c: number }>(),
    db.prepare(`SELECT COUNT(*) c FROM matches`).first<{ c: number }>(),
    db
      .prepare(`SELECT COUNT(*) c FROM matches WHERE created_at >= ?`)
      .bind(t24)
      .first<{ c: number }>(),
    db
      .prepare(`SELECT COUNT(*) c FROM matches WHERE created_at >= ?`)
      .bind(t7)
      .first<{ c: number }>(),
    db
      .prepare(
        `SELECT COUNT(DISTINCT pid) c FROM (
           SELECT p1_id pid FROM matches WHERE created_at >= ?
           UNION ALL SELECT p2_id FROM matches WHERE created_at >= ?
         )`,
      )
      .bind(t7, t7)
      .first<{ c: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) c FROM (
           SELECT pid, MIN(created_at) f FROM (
             SELECT p1_id pid, created_at FROM matches
             UNION ALL SELECT p2_id pid, created_at FROM matches
           ) GROUP BY pid HAVING f >= ?
         )`,
      )
      .bind(t7)
      .first<{ c: number }>(),
    db
      .prepare(`SELECT COALESCE(SUM(cost_usd),0) s FROM ai_costs WHERE created_at >= ?`)
      .bind(t7)
      .first<{ s: number }>(),
    db
      .prepare(`SELECT COALESCE(SUM(cost_usd),0) s FROM ai_costs`)
      .first<{ s: number }>(),
    db
      .prepare(
        `SELECT mode, COUNT(*) c FROM matches WHERE created_at >= ? GROUP BY mode`,
      )
      .bind(t7)
      .all<{ mode: string; c: number }>(),
    // ---- 好友房統計（room_matches / room_match_players）----
    db.prepare(`SELECT COUNT(*) c FROM room_matches`).first<{ c: number }>(),
    db
      .prepare(`SELECT COUNT(*) c FROM room_matches WHERE created_at >= ?`)
      .bind(t24)
      .first<{ c: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) c, COALESCE(AVG(player_count),0) avg FROM room_matches WHERE created_at >= ?`,
      )
      .bind(t7)
      .first<{ c: number; avg: number }>(),
    db
      .prepare(
        `SELECT COUNT(DISTINCT rmp.player_id) c
         FROM room_match_players rmp
         JOIN room_matches rm ON rm.id = rmp.match_id
         WHERE rm.created_at >= ? AND rmp.player_id <> ''`,
      )
      .bind(t7)
      .first<{ c: number }>(),
    db
      .prepare(
        `SELECT mode, COUNT(*) c FROM room_matches WHERE created_at >= ? GROUP BY mode`,
      )
      .bind(t7)
      .all<{ mode: string; c: number }>(),
  ]);

  const modeSplit7d = { normal: 0, devil: 0 };
  for (const r of modeRows.results ?? []) {
    if (r.mode === "devil") modeSplit7d.devil = r.c;
    else modeSplit7d.normal = r.c;
  }

  const roomModeSplit7d = { normal: 0, devil: 0 };
  for (const r of roomModeRows.results ?? []) {
    if (r.mode === "devil") roomModeSplit7d.devil = r.c;
    else roomModeSplit7d.normal = r.c;
  }

  return {
    totalPlayers: num(totalPlayers),
    totalMatches: num(totalMatches),
    matches24h: num(m24),
    matches7d: num(m7),
    activePlayers7d: num(active7),
    newPlayers7d: num(new7),
    aiCost7dUsd: cost7?.s ?? 0,
    aiCostTotalUsd: costTotal?.s ?? 0,
    modeSplit7d,
    roomTotal: num(roomTotal),
    roomMatches24h: num(room24),
    roomMatches7d: room7?.c ?? 0,
    roomActivePlayers7d: num(roomActive7),
    roomAvgPlayers7d: Math.round((room7?.avg ?? 0) * 10) / 10,
    roomModeSplit7d,
  };
}

export interface DailyStats {
  days: string[]; // YYYY-MM-DD，由舊到新
  matches: number[]; // 每日對戰場數（隨機配對）
  active: number[]; // 每日相異出賽玩家數（隨機配對）
  newPlayers: number[]; // 每日首度出賽玩家數（隨機配對）
  roomMatches: number[]; // 每日好友房場數（多人）
}

// 近 N 天逐日走勢；缺資料的日子補 0，確保 X 軸連續。
export async function getDailyStats(
  db: D1Database,
  days: number,
  offsetMin: number,
  now: number,
): Promise<DailyStats> {
  const since = now - days * DAY_MS;

  const [matchRows, activeRows, newRows, roomRows] = await Promise.all([
    db
      .prepare(
        `SELECT ${dayExpr("created_at")} d, COUNT(*) c
         FROM matches WHERE created_at >= ? GROUP BY d`,
      )
      .bind(offsetMin, since)
      .all<{ d: string; c: number }>(),
    db
      .prepare(
        `SELECT d, COUNT(DISTINCT pid) c FROM (
           SELECT ${dayExpr("created_at")} d, p1_id pid FROM matches WHERE created_at >= ?
           UNION ALL
           SELECT ${dayExpr("created_at")} d, p2_id pid FROM matches WHERE created_at >= ?
         ) GROUP BY d`,
      )
      .bind(offsetMin, since, offsetMin, since)
      .all<{ d: string; c: number }>(),
    db
      .prepare(
        `SELECT ${dayExpr("f")} d, COUNT(*) c FROM (
           SELECT pid, MIN(created_at) f FROM (
             SELECT p1_id pid, created_at FROM matches
             UNION ALL SELECT p2_id pid, created_at FROM matches
           ) GROUP BY pid
         ) WHERE f >= ? GROUP BY d`,
      )
      .bind(offsetMin, since)
      .all<{ d: string; c: number }>(),
    db
      .prepare(
        `SELECT ${dayExpr("created_at")} d, COUNT(*) c
         FROM room_matches WHERE created_at >= ? GROUP BY d`,
      )
      .bind(offsetMin, since)
      .all<{ d: string; c: number }>(),
  ]);

  const toMap = (rows: { results?: { d: string; c: number }[] }) => {
    const m = new Map<string, number>();
    for (const r of rows.results ?? []) m.set(r.d, r.c);
    return m;
  };
  const mMatch = toMap(matchRows);
  const mActive = toMap(activeRows);
  const mNew = toMap(newRows);
  const mRoom = toMap(roomRows);

  const dayList: string[] = [];
  for (let i = days - 1; i >= 0; i--) dayList.push(dayKey(now - i * DAY_MS, offsetMin));

  return {
    days: dayList,
    matches: dayList.map((d) => mMatch.get(d) ?? 0),
    active: dayList.map((d) => mActive.get(d) ?? 0),
    newPlayers: dayList.map((d) => mNew.get(d) ?? 0),
    roomMatches: dayList.map((d) => mRoom.get(d) ?? 0),
  };
}

export interface RecentMatch {
  id: string;
  p1Name: string;
  p2Name: string;
  p1Score: number;
  p2Score: number;
  winnerName: string | null; // 勝方名稱；平手 null
  mode: GameMode;
  reason: string;
  ratingDelta: number;
  createdAt: number;
  rounds: number | null; // 回合數（無 game_events 對應則 null）
  events: number | null; // 事件筆數
  durationMs: number | null; // 對局時長
}

// 最近 N 場對戰，附帶自 game_events 聚合的回合數／時長／事件數。
export async function getRecentMatches(
  db: D1Database,
  limit: number,
  offsetMin: number,
): Promise<RecentMatch[]> {
  void offsetMin;
  const { results } = await db
    .prepare(
      `SELECT m.id, m.p1_id, m.p2_id, m.p1_name, m.p2_name,
              m.p1_score, m.p2_score, m.winner_id, m.mode, m.reason,
              m.rating_delta, m.created_at,
              g.rounds, g.events, g.dur_ms
       FROM matches m
       LEFT JOIN (
         SELECT game_id, MAX(round) rounds, COUNT(*) events,
                (MAX(created_at) - MIN(created_at)) dur_ms
         FROM game_events GROUP BY game_id
       ) g ON g.game_id = m.game_id
       ORDER BY m.created_at DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<{
      id: string;
      p1_id: string;
      p2_id: string;
      p1_name: string;
      p2_name: string;
      p1_score: number;
      p2_score: number;
      winner_id: string | null;
      mode: string;
      reason: string;
      rating_delta: number;
      created_at: number;
      rounds: number | null;
      events: number | null;
      dur_ms: number | null;
    }>();

  return (results ?? []).map((r) => ({
    id: r.id,
    p1Name: r.p1_name,
    p2Name: r.p2_name,
    p1Score: r.p1_score,
    p2Score: r.p2_score,
    winnerName:
      r.winner_id === r.p1_id
        ? r.p1_name
        : r.winner_id === r.p2_id
          ? r.p2_name
          : null,
    mode: r.mode as GameMode,
    reason: r.reason,
    ratingDelta: r.rating_delta,
    createdAt: r.created_at,
    rounds: r.rounds,
    events: r.events,
    durationMs: r.dur_ms,
  }));
}

// 單場詳情：對戰基本資料 + 事件流（供後台還原「他們比了什麼」）。
export interface MatchDetailMeta {
  id: string;
  gameId: string | null;
  p1Id: string;
  p2Id: string;
  p1Name: string;
  p2Name: string;
  p1Score: number;
  p2Score: number;
  winner: Role | null; // 勝方角色；平手 null
  mode: GameMode;
  reason: string;
  ratingDelta: number;
  createdAt: number;
}

export interface MatchEvent {
  seq: number;
  round: number;
  type: GameEventType;
  actor: Role | null;
  char: string | null;
  posIndex: number | null;
  sentence: string | null;
  challenged: Role | null;
  sentenceScore: number | null; // AI 整句合理度 -3~3（對應 score_a）
  delta: number | null;
  awardedTo: Role | null;
  awardedPts: number | null;
  restriction: string | null; // 生效限制種類（逗號分隔）
  violation: string | null;
  reason: string | null;
  p1Score: number;
  p2Score: number;
  winner: Role | null;
  detail: unknown | null; // 解析後的 JSON（restrictions / addedRestrictions 等）
  createdAt: number;
}

export interface MatchDetail {
  match: MatchDetailMeta;
  events: MatchEvent[];
}

// 取單一場次的完整過程；查無此 match 回 null。
// 事件依 game_id（整場穩定）自 game_events 撈出，以 seq 排序還原時序。
export async function getMatchDetail(
  db: D1Database,
  matchId: string,
): Promise<MatchDetail | null> {
  const m = await db
    .prepare(
      `SELECT id, game_id, p1_id, p2_id, p1_name, p2_name,
              winner_id, p1_score, p2_score, mode, reason, rating_delta, created_at
       FROM matches WHERE id = ?`,
    )
    .bind(matchId)
    .first<{
      id: string;
      game_id: string | null;
      p1_id: string;
      p2_id: string;
      p1_name: string;
      p2_name: string;
      winner_id: string | null;
      p1_score: number;
      p2_score: number;
      mode: string;
      reason: string;
      rating_delta: number;
      created_at: number;
    }>();
  if (!m) return null;

  const match: MatchDetailMeta = {
    id: m.id,
    gameId: m.game_id,
    p1Id: m.p1_id,
    p2Id: m.p2_id,
    p1Name: m.p1_name,
    p2Name: m.p2_name,
    p1Score: m.p1_score,
    p2Score: m.p2_score,
    winner:
      m.winner_id === m.p1_id ? "p1" : m.winner_id === m.p2_id ? "p2" : null,
    mode: m.mode as GameMode,
    reason: m.reason,
    ratingDelta: m.rating_delta,
    createdAt: m.created_at,
  };

  let events: MatchEvent[] = [];
  if (m.game_id) {
    const { results } = await db
      .prepare(
        `SELECT seq, round, type, actor, char, pos_index, sentence, challenged,
                score_a, delta, awarded_to, awarded_pts, restriction, violation, reason,
                p1_score, p2_score, winner, detail, created_at
         FROM game_events WHERE game_id = ? ORDER BY seq ASC`,
      )
      .bind(m.game_id)
      .all<{
        seq: number;
        round: number;
        type: string;
        actor: string | null;
        char: string | null;
        pos_index: number | null;
        sentence: string | null;
        challenged: string | null;
        score_a: number | null;
        delta: number | null;
        awarded_to: string | null;
        awarded_pts: number | null;
        restriction: string | null;
        violation: string | null;
        reason: string | null;
        p1_score: number;
        p2_score: number;
        winner: string | null;
        detail: string | null;
        created_at: number;
      }>();
    events = (results ?? []).map((r) => {
      let detail: unknown = null;
      if (r.detail) {
        try {
          detail = JSON.parse(r.detail);
        } catch {
          detail = null;
        }
      }
      return {
        seq: r.seq,
        round: r.round,
        type: r.type as GameEventType,
        actor: r.actor as Role | null,
        char: r.char,
        posIndex: r.pos_index,
        sentence: r.sentence,
        challenged: r.challenged as Role | null,
        sentenceScore: r.score_a,
        delta: r.delta,
        awardedTo: r.awarded_to as Role | null,
        awardedPts: r.awarded_pts,
        restriction: r.restriction,
        violation: r.violation,
        reason: r.reason,
        p1Score: r.p1_score,
        p2Score: r.p2_score,
        winner: r.winner as Role | null,
        detail,
        createdAt: r.created_at,
      };
    });
  }

  return { match, events };
}

// ---- 好友房（多人）後台查詢 ----

export interface RoomMatchPlayer {
  playerId: string;
  name: string;
  seat: number;
  score: number;
  rank: number; // 1 起；同分共列
  eliminated: boolean; // 是否中離淘汰
}

export interface RecentRoomMatch {
  id: string;
  roomCode: string;
  mode: GameMode;
  rounds: number;
  playerCount: number;
  reason: string; // rounds | players_left
  createdAt: number;
  players: RoomMatchPlayer[]; // 依名次排序
}

// 最近 N 場好友房，附各座位名次（供後台一覽多人戰績），依時間新到舊。
export async function getRecentRoomMatches(
  db: D1Database,
  limit: number,
): Promise<RecentRoomMatch[]> {
  const { results } = await db
    .prepare(`SELECT id FROM room_matches ORDER BY created_at DESC LIMIT ?`)
    .bind(limit)
    .all<{ id: string }>();
  const ids = (results ?? []).map((r) => r.id);
  const list = await getRecentRoomMatchesByIds(db, ids);
  // 依上方時間排序還原（byIds 不保證順序）
  const order = new Map(ids.map((id, i) => [id, i]));
  return list.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

export interface RoomMatchDetailMeta extends RecentRoomMatch {}

// 好友房事件：actor/challenged/awardedTo/winner 為座位標籤 s0..sN；
// scores 為全座位比分快照（依 seat 排列）。
export interface RoomMatchEvent {
  seq: number;
  round: number;
  type: GameEventType;
  actor: string | null; // s0..sN
  char: string | null;
  posIndex: number | null;
  sentence: string | null;
  challenged: string | null;
  sentenceScore: number | null;
  delta: number | null;
  awardedTo: string | null;
  awardedPts: number | null;
  restriction: string | null;
  violation: string | null;
  reason: string | null;
  scores: number[] | null; // 事件後全座位比分
  winner: string | null;
  detail: unknown | null;
  createdAt: number;
}

export interface RoomMatchDetail {
  match: RoomMatchDetailMeta;
  events: RoomMatchEvent[];
}

// 取單一好友房場次的完整過程；查無此場回 null。
// 事件依 game_id（= room_matches.id = sessionId）撈出，以 seq 排序還原時序。
export async function getRoomMatchDetail(
  db: D1Database,
  matchId: string,
): Promise<RoomMatchDetail | null> {
  const [meta] = await getRecentRoomMatchesByIds(db, [matchId]);
  if (!meta) return null;

  const { results } = await db
    .prepare(
      `SELECT seq, round, type, actor, char, pos_index, sentence, challenged,
              score_a, delta, awarded_to, awarded_pts, restriction, violation, reason,
              scores, winner, detail, created_at
       FROM game_events WHERE game_id = ? ORDER BY seq ASC`,
    )
    .bind(matchId)
    .all<{
      seq: number;
      round: number;
      type: string;
      actor: string | null;
      char: string | null;
      pos_index: number | null;
      sentence: string | null;
      challenged: string | null;
      score_a: number | null;
      delta: number | null;
      awarded_to: string | null;
      awarded_pts: number | null;
      restriction: string | null;
      violation: string | null;
      reason: string | null;
      scores: string | null;
      winner: string | null;
      detail: string | null;
      created_at: number;
    }>();

  const parse = (s: string | null): unknown | null => {
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  };

  const events: RoomMatchEvent[] = (results ?? []).map((r) => ({
    seq: r.seq,
    round: r.round,
    type: r.type as GameEventType,
    actor: r.actor,
    char: r.char,
    posIndex: r.pos_index,
    sentence: r.sentence,
    challenged: r.challenged,
    sentenceScore: r.score_a,
    delta: r.delta,
    awardedTo: r.awarded_to,
    awardedPts: r.awarded_pts,
    restriction: r.restriction,
    violation: r.violation,
    reason: r.reason,
    scores: parse(r.scores) as number[] | null,
    winner: r.winner,
    detail: parse(r.detail),
    createdAt: r.created_at,
  }));

  return { match: meta, events };
}

// 內部：依 id 清單取好友房場次與名次（getRoomMatchDetail 借用相同組裝邏輯）。
async function getRecentRoomMatchesByIds(
  db: D1Database,
  ids: string[],
): Promise<RecentRoomMatch[]> {
  if (!ids.length) return [];
  const placeholders = ids.map(() => "?").join(",");
  const { results: matchRows } = await db
    .prepare(
      `SELECT id, room_code, mode, rounds, player_count, reason, created_at
       FROM room_matches WHERE id IN (${placeholders})`,
    )
    .bind(...ids)
    .all<{
      id: string;
      room_code: string;
      mode: string;
      rounds: number;
      player_count: number;
      reason: string;
      created_at: number;
    }>();
  const rows = matchRows ?? [];
  if (!rows.length) return [];

  const { results: playerRows } = await db
    .prepare(
      `SELECT match_id, player_id, name, seat, score, rank, eliminated
       FROM room_match_players WHERE match_id IN (${placeholders})
       ORDER BY rank ASC, seat ASC`,
    )
    .bind(...ids)
    .all<{
      match_id: string;
      player_id: string;
      name: string;
      seat: number;
      score: number;
      rank: number;
      eliminated: number;
    }>();

  const byMatch = new Map<string, RoomMatchPlayer[]>();
  for (const p of playerRows ?? []) {
    const arr = byMatch.get(p.match_id) ?? [];
    arr.push({
      playerId: p.player_id,
      name: p.name,
      seat: p.seat,
      score: p.score,
      rank: p.rank,
      eliminated: !!p.eliminated,
    });
    byMatch.set(p.match_id, arr);
  }

  return rows.map((r) => ({
    id: r.id,
    roomCode: r.room_code,
    mode: r.mode as GameMode,
    rounds: r.rounds,
    playerCount: r.player_count,
    reason: r.reason,
    createdAt: r.created_at,
    players: byMatch.get(r.id) ?? [],
  }));
}

// ---- 遊玩歷史事件 ----

export type GameEventType =
  | "round_start"
  | "move"
  | "challenge"
  | "timeout_extend"
  | "timeout"
  | "leave"
  | "game_over";

// 一筆歷史事件；除 gameId/seq/round/type/mode/now 外皆選填，依事件種類帶入。
// 座位標籤：隨機配對維持 "p1"/"p2"（相容既有分析），好友房為 "s0".."sN"。
export interface GameEventInput {
  gameId: string;
  seq: number;
  round: number;
  type: GameEventType;
  mode: GameMode;
  source?: GameSource; // match | room（舊資料為 NULL，等同 match）
  now: number;
  actor?: string | null;
  actorId?: string | null;
  char?: string | null;
  posIndex?: number | null;
  sentence?: string | null;
  challenged?: string | null;
  scoreA?: number | null;
  scoreB?: number | null;
  delta?: number | null;
  awardedTo?: string | null;
  awardedPoints?: number | null;
  restriction?: string | null;
  violation?: string | null;
  reason?: string | null;
  p1Score?: number;
  p2Score?: number;
  scores?: number[] | null; // 好友房：全座位比分快照（JSON 存放）
  winner?: string | null;
  detail?: Record<string, unknown> | null;
}

// 寫入一筆遊玩歷史事件（append-only）。由呼叫端以 waitUntil 包住，寫入失敗不影響對局。
export async function recordGameEvent(
  db: D1Database,
  e: GameEventInput,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO game_events
         (game_id, seq, round, type, mode, source, actor, actor_id,
          char, pos_index, sentence,
          challenged, score_a, score_b, delta, awarded_to, awarded_pts,
          restriction, violation, reason,
          p1_score, p2_score, scores, winner, detail, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      e.gameId,
      e.seq,
      e.round,
      e.type,
      e.mode,
      e.source ?? "match",
      e.actor ?? null,
      e.actorId ?? null,
      e.char ?? null,
      e.posIndex ?? null,
      e.sentence ?? null,
      e.challenged ?? null,
      e.scoreA ?? null,
      e.scoreB ?? null,
      e.delta ?? null,
      e.awardedTo ?? null,
      e.awardedPoints ?? null,
      e.restriction ?? null,
      e.violation ?? null,
      e.reason ?? null,
      e.p1Score ?? 0,
      e.p2Score ?? 0,
      e.scores ? JSON.stringify(e.scores) : null,
      e.winner ?? null,
      e.detail ? JSON.stringify(e.detail) : null,
      e.now,
    )
    .run();
}
