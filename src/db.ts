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
