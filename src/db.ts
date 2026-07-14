// D1 存取層：玩家帳號、排行榜、對戰紀錄、AI 花費
import type { GameMode, PlayerIdentity, PlayerStats, Role } from "./types";
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
  const { p1, p2, winner, scores, mode, reason, matchId, now } = input;

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
           (id, p1_id, p2_id, p1_name, p2_name, winner_id, p1_score, p2_score, mode, reason, rating_delta, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        matchId,
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

// ---- AI 花費 ----

export interface RecordAiCostInput {
  gameId: string;
  mode: GameMode;
  restriction: string | null; // 惡魔限制種類，無則 null
  usage: JudgeUsage;
  now: number;
}

// 寫入一次質疑的模型花費（每次質疑結算一筆）
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
