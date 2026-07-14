// ELO 積分計算：動態 K 值（分段）+ 前 N 場 placement 保護期
//
// - placement：前 PLACEMENT_GAMES 場用超大 K，讓系統快速定位新玩家的實力區間。
// - 之後依分段：低分波動大、高分穩定。
// K 為 per-player（依各自 rating 與已玩場數），故勝敗雙方變化量不一定對稱。

export const PLACEMENT_GAMES = 10; // 前幾場視為定位期
const K_PLACEMENT = 48; // 定位期的超大 K
const K_LOW = 40; // rating < 1200
const K_MID = 32; // 1200 ~ 2000
const K_HIGH = 16; // rating > 2000

export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

// 依玩家目前 rating 與「本場之前」已玩場數決定 K 值
export function kFactor(rating: number, games: number): number {
  if (games < PLACEMENT_GAMES) return K_PLACEMENT;
  if (rating < 1200) return K_LOW;
  if (rating > 2000) return K_HIGH;
  return K_MID;
}

export interface PlayerElo {
  rating: number;
  games: number; // 本場之前已完成的場數
}

export interface EloChange {
  before: number;
  after: number;
  delta: number; // 帶正負號的變化量
}

// 一場對戰的完整結算（勝、敗各自套用自己的 K）
export function eloOutcome(
  winner: PlayerElo,
  loser: PlayerElo,
): { winner: EloChange; loser: EloChange } {
  const expWinner = expectedScore(winner.rating, loser.rating); // 勝方期望勝率
  const kW = kFactor(winner.rating, winner.games);
  const kL = kFactor(loser.rating, loser.games);
  // 勝方 S=1、敗方 S=0；敗方期望勝率為 (1 - expWinner)
  const winDelta = Math.round(kW * (1 - expWinner));
  const loseDelta = -Math.round(kL * (1 - expWinner));
  return {
    winner: {
      before: winner.rating,
      after: winner.rating + winDelta,
      delta: winDelta,
    },
    loser: {
      before: loser.rating,
      after: loser.rating + loseDelta,
      delta: loseDelta,
    },
  };
}
