// 共用型別 / WebSocket 訊息協定

export type Role = "p1" | "p2";

export type GameStatus =
  | "waiting"
  | "playing"
  | "settling" // AI 評分中
  | "result" // 顯示結算結果、等待進入下一回合
  | "over";

export interface Scores {
  p1: number;
  p2: number;
}

export interface LastMove {
  player: Role;
  index: number; // 插入位置（插入後該字在句中的索引）
  char: string;
}

// ---- Client -> Server ----
export type ClientMessage =
  | { type: "insert"; index: number; char: string }
  | { type: "challenge" }
  | { type: "ping" };

// ---- Server -> Client ----
export type ServerMessage =
  | { type: "waiting" } // 等待對手加入
  | { type: "judging"; challenger: Role } // 質疑觸發，AI 評分中
  | {
      type: "start";
      you: Role;
      sentence: string[];
      scores: Scores;
      currentPlayer: Role;
      deadline: number; // epoch ms
      target: number;
      canChallenge: boolean;
    }
  | {
      type: "update";
      sentence: string[];
      scores: Scores;
      currentPlayer: Role;
      deadline: number;
      lastMove: LastMove | null;
      canChallenge: boolean;
    }
  | {
      type: "settled";
      challenger: Role;
      challengedChar: string | null; // 被質疑的字；null 表示超時未出手
      A: number; // 整句合理度 -3~3
      B: number; // 末字語助詞程度 0~3
      delta: number; // A - B
      awardedTo: Role | null; // 得分方（null 表平手不計分）
      awardedPoints: number;
      reason: string;
      sentence: string[];
      scores: Scores;
      nextInMs: number; // 幾毫秒後進入下一回合／結束
      final: boolean; // true 表示本回合結束後即分出勝負
    }
  | {
      type: "gameover";
      winner: Role | null;
      scores: Scores;
      reason: "score" | "opponent_left";
    }
  | { type: "error"; message: string };
