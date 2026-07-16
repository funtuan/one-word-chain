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

// 分數膨脹（低分成就感設計）：1800 分以下，贏「加多」、輸「減少」，讓多玩累積更有感。
// 1800 分以上維持標準 ELO（零和），高分區才有真正的競爭意義。
export const INFLATION_CEILING = 1800; // 到此分數膨脹歸零；以上不膨脹
const INFLATION_SPAN = 800; // 從 1800 往下線性拉滿到 (1800-800)=1000，1000 以下都吃滿膨脹
const GAIN_BONUS = 0.5; // 膨脹拉滿時得分最多 +50%
const LOSS_RELIEF = 0.5; // 膨脹拉滿時扣分最多 -50%

// 膨脹強度 t ∈ [0,1]：rating≥1800 為 0（標準 ELO）；越低於 1800 越接近 1（膨脹最強）。
function inflationT(rating: number): number {
  if (rating >= INFLATION_CEILING) return 0;
  return Math.min(1, (INFLATION_CEILING - rating) / INFLATION_SPAN);
}

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
  const baseDelta = kW * (1 - expWinner);
  const baseLoss = kL * (1 - expWinner);
  // 低分膨脹（各自依自己的 rating）：贏方按 GAIN_BONUS 放大、輸方按 LOSS_RELIEF 減免。
  const gainMul = 1 + GAIN_BONUS * inflationT(winner.rating);
  const lossMul = 1 - LOSS_RELIEF * inflationT(loser.rating);
  // 贏至少 +1，避免大熱門獲勝被四捨五入成 0 而缺乏成就感。
  const winDelta = Math.max(1, Math.round(baseDelta * gainMul));
  const loseDelta = -Math.round(baseLoss * lossMul);
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
