// D1 存取層：玩家帳號、排行榜、對戰紀錄
import type { GameMode, PlayerIdentity, PlayerStats, Role } from "./types";
import { eloUpdate } from "./elo";

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

async function ratingOf(db: D1Database, id: string): Promise<number> {
  const row = await db
    .prepare("SELECT rating FROM players WHERE id = ?")
    .bind(id)
    .first<{ rating: number }>();
  return row?.rating ?? 1000;
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

  const [r1, r2] = await Promise.all([ratingOf(db, p1.id), ratingOf(db, p2.id)]);

  let newR1 = r1;
  let newR2 = r2;
  let ratingDelta = 0;
  if (winner === "p1") {
    const u = eloUpdate(r1, r2);
    newR1 = u.winner;
    newR2 = u.loser;
    ratingDelta = u.delta;
  } else if (winner === "p2") {
    const u = eloUpdate(r2, r1);
    newR2 = u.winner;
    newR1 = u.loser;
    ratingDelta = u.delta;
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
