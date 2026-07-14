// 共用型別 / WebSocket 訊息協定

export type Role = "p1" | "p2";

// 遊戲模式：普通 / 惡魔（每回合隨機限制）
export type GameMode = "normal" | "devil";

// 惡魔模式的回合限制種類
export type RestrictionKind = "position" | "zhuyin" | "pos" | "meaning";

// 詞性限制：本回合「不可放入」的詞性（三選一）
export type PosCategory = "名詞" | "動詞" | "形容詞";

export interface Restriction {
  kind: RestrictionKind;
  finals?: string[]; // zhuyin：本回合允許的 3 個韻符
  pos?: PosCategory; // pos：本回合禁止的詞性
}

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
  index: number; // 放入位置（放入後該字在句中的索引）
  char: string;
}

// 玩家身分（無需登入，client 於 localStorage 產生 UUID）
export interface PlayerIdentity {
  id: string;
  name: string;
}

// 排行榜／個人戰績（對應 D1 players 表）
export interface PlayerStats {
  id: string;
  name: string;
  rating: number;
  wins: number;
  losses: number;
  games: number;
}

// ---- Client -> Server ----
export type ClientMessage =
  | { type: "insert"; index: number; char: string }
  | { type: "challenge" }
  | { type: "ping" };

// ---- Server -> Client ----
export type ServerMessage =
  | { type: "waiting" } // 等待對手加入
  | { type: "judging"; challenger: Role } // 挑戰觸發，AI 評分中
  | {
      type: "start";
      you: Role;
      sentence: string[];
      scores: Scores;
      currentPlayer: Role;
      deadline: number; // epoch ms
      target: number;
      canChallenge: boolean;
      mode: GameMode;
      restriction: Restriction | null; // 惡魔模式本回合限制
      allowedPositions: number[] | null; // 位置限制：目前可放入的位置；null 表示不限
      names: { p1: string; p2: string }; // 雙方顯示名稱
      ratings: { p1: number; p2: number }; // 雙方 ELO 積分（開局當下）
      timeoutQuota: Scores; // 雙方剩餘的超時額度（整場不重置）
    }
  | {
      type: "update";
      sentence: string[];
      scores: Scores;
      currentPlayer: Role;
      deadline: number;
      lastMove: LastMove | null;
      canChallenge: boolean;
      allowedPositions: number[] | null; // 位置限制：下一位玩家可放入的位置
      timeoutQuota: Scores; // 雙方剩餘的超時額度
    }
  | {
      // 超時但當事人尚有額度：自動用掉一次，該回合 +10 秒，不計分
      type: "timeoutExtend";
      player: Role; // 超時並用掉額度的一方
      deadline: number; // 延長後的新截止時間（epoch ms）
      timeoutQuota: Scores; // 更新後雙方剩餘額度
    }
  | {
      type: "settled";
      challenger: Role;
      challengedChar: string | null; // 被挑戰的字；null 表示超時未出手
      challengedIndex: number | null; // 被挑戰字在 sentence 中的位置；null 表示超時未出手
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
      restriction: Restriction | null; // 惡魔模式本回合限制（供顯示）
      zhuyinMatch?: boolean; // zhuyin 限制：被挑戰字是否符合韻符
      posViolation?: boolean; // pos 限制：被挑戰字是否為禁止的詞性（true = 違規）
      meaningChanged?: boolean; // meaning 限制：被挑戰字是否造成句意改變（false = 違規）
    }
  | {
      type: "gameover";
      winner: Role | null;
      scores: Scores;
      reason: "score" | "opponent_left";
      // 本場 ELO 變化（雙方）；null 表示本場未計入積分
      elo: {
        p1: { before: number; after: number; delta: number };
        p2: { before: number; after: number; delta: number };
      } | null;
      // 以下僅在斷線者重連、補送結果時附帶（重連端沒收過 start，需要這些才能正確顯示）
      you?: Role; // 收訊端自己的身分
      names?: { p1: string; p2: string }; // 雙方顯示名稱
    }
  | { type: "error"; message: string };
