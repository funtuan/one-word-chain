// ELO 積分計算（初始 1000，K 值 32）

const K = 32;

export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

// 給定勝方與敗方目前積分，回傳更新後積分與勝方獲得的分數（對稱：敗方扣同值）
export function eloUpdate(
  ratingWinner: number,
  ratingLoser: number,
): { winner: number; loser: number; delta: number } {
  const expWinner = expectedScore(ratingWinner, ratingLoser);
  const delta = Math.round(K * (1 - expWinner));
  return {
    winner: ratingWinner + delta,
    loser: ratingLoser - delta,
    delta,
  };
}
