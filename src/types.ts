// 共用型別 / WebSocket 訊息協定
//
// v3 起全面 seat 制（0..N-1）：一場對局支援 2 人以上，
// 隨機配對（source: "match"）固定 2 人，好友房（source: "room"）2~N 人。
// 舊 p1/p2 協定已廢除，前後端同倉庫同時部署、不留相容層（見 plan/v3-friend-rooms.md 5.2）。

// 座位索引（0 起）。觀戰者無座位（you: null）。
export type Seat = number;

// D1 舊表（matches / game_events 的雙人欄位）仍以 p1/p2 表示，僅資料層使用
export type Role = "p1" | "p2";

// 對局來源：隨機配對 / 好友房
export type GameSource = "match" | "room";

// 遊戲模式：普通 / 惡魔（回合內隨字數累加限制）
export type GameMode = "normal" | "devil";

// 勝負規則：
// - target：先達目標分獲勝（隨機配對，維持既有規則）
// - rounds：固定回合數打完，總分排行（好友房；平手共列同名次）
export type WinRule =
  | { kind: "target"; target: number }
  | { kind: "rounds"; rounds: number };

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
  | "waiting" // 隨機配對：等第二人；好友房：等待室（房主按開始才開局）
  | "playing"
  | "settling" // AI 評分中
  | "result" // 顯示結算結果、等待進入下一回合
  | "over";

export interface LastMove {
  player: Seat;
  index: number; // 放入位置（放入後該字在句中的索引）
  char: string;
}

// 玩家身分（無需登入，client 於 localStorage 產生 UUID）。
// 注意：id 即帳號代碼（等同登入憑證），只存在後端，絕不可放進任何 ServerMessage。
export interface PlayerIdentity {
  id: string;
  name: string;
}

// 座位的公開資訊（廣播給所有連線，含觀戰者；不含玩家 id）
export interface SeatInfo {
  name: string;
  rating: number | null; // ELO 積分（隨機配對才有；好友房不計 ELO，為 null）
  connected: boolean; // 是否連線中（斷線寬限期內仍佔席位）
  eliminated: boolean; // 是否已出局（好友房中離淘汰）
}

// 好友房排名（gameover 用；平手共列同名次，中離者排在所有在局者之後）
export interface RankEntry {
  seat: Seat;
  score: number;
  rank: number;
  eliminated: boolean;
}

// 本場 ELO 變化（隨機配對；依 seat 排列）
export interface EloChange {
  before: number;
  after: number;
  delta: number;
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

export type GameoverReason =
  | "score" // 隨機配對：先達目標分
  | "opponent_left" // 隨機配對：對方離線判勝
  | "rounds" // 好友房：固定回合數打完
  | "players_left"; // 好友房：中離只剩最後 1 人

// ---- Client -> Server ----
export type ClientMessage =
  | { type: "insert"; index: number; char: string }
  | { type: "challenge" }
  | { type: "ready" } // 結算停留階段，玩家按「準備好了」提前推進
  | { type: "startRoom" } // 好友房：房主按「開始遊戲」
  | { type: "restartRoom" } // 好友房：結束後房主按「再來一場」（同房重置，紀錄另起新場）
  | { type: "leave" } // 主動離開：等待室退出（房主=解散）；對局中立即出局
  | { type: "ping" };

// ---- Server -> Client ----
export type ServerMessage =
  | { type: "waiting" } // 隨機配對：等待對手加入
  | {
      // 好友房等待室狀態（成員增減、重連時廣播）
      type: "roomState";
      code: string; // 房號（6 碼短碼）
      mode: GameMode;
      rule: WinRule;
      players: { name: string; host: boolean; connected: boolean }[];
      you: Seat | null; // 自己在名單中的位置；null 表示觀戰（房已滿）
      isHost: boolean;
      minPlayers: number;
      maxPlayers: number;
    }
  | { type: "roomClosed"; reason: "host_left" | "expired" }
  | { type: "judging"; challenger: Seat } // 挑戰觸發，AI 評分中
  | {
      // 開局／回合開始／中途加入與重連的完整快照
      type: "start";
      you: Seat | null; // null 表示觀戰者
      source: GameSource;
      rule: WinRule;
      round: number; // 回合編號（1 起）
      seats: SeatInfo[];
      sentence: string[];
      scores: number[]; // 依 seat 排列
      currentPlayer: Seat;
      deadline: number; // epoch ms
      lastMove: LastMove | null; // 重連／觀戰快照需要；回合開始時為 null
      canChallenge: boolean;
      mode: GameMode;
      restrictions: Restriction[]; // 惡魔模式目前生效的限制（可能多個）
      allowedPositions: number[] | null; // 位置限制：目前可放入的位置；null 表示不限
      timeoutQuota: number[]; // 各座位剩餘的超時額度（整場不重置）
    }
  | {
      type: "update";
      sentence: string[];
      scores: number[];
      currentPlayer: Seat;
      deadline: number;
      lastMove: LastMove | null;
      canChallenge: boolean;
      allowedPositions: number[] | null; // 位置限制：下一位玩家可放入的位置
      restrictions: Restriction[]; // 惡魔模式目前生效的限制（隨字數累加）
      newRestrictions: Restriction[]; // 本次接龍新增的限制（供前端跳提示彈窗）；無則空陣列
      timeoutQuota: number[];
    }
  | {
      // 超時但當事人尚有額度：自動用掉一次，該回合 +10 秒，不計分
      type: "timeoutExtend";
      player: Seat; // 超時並用掉額度的一方
      deadline: number; // 延長後的新截止時間（epoch ms）
      timeoutQuota: number[]; // 更新後各座位剩餘額度
    }
  | {
      // 好友房（3 人以上在局）：超時且無額度 -> 本回合跳過、不給分，輪到下一位
      type: "timeoutSkip";
      player: Seat; // 被跳過的一方
      currentPlayer: Seat; // 接手的下一位
      deadline: number;
      canChallenge: boolean; // 收訊者是否可挑戰（依各連線分送）
      timeoutQuota: number[];
    }
  | {
      // 席位狀態變化（斷線進入寬限、重連回來、淘汰出局）
      type: "presence";
      seats: SeatInfo[];
    }
  | {
      type: "settled";
      challenger: Seat;
      challenged: Seat | null; // 被挑戰方；null 表示超時／全員跳過（無被挑戰者）
      challengedChar: string | null; // 被挑戰的字；null 表示超時未出手
      challengedIndex: number | null; // 被挑戰字在 sentence 中的位置；null 表示超時未出手
      sentenceScore: number; // 剛接上的字放進句子後的合理度 -3~3
      delta: number; // 實際計分變化
      awardedTo: Seat | null; // 得分方（null 表平手不計分）
      awardedPoints: number;
      reason: string;
      sentence: string[];
      scores: number[];
      round: number; // 本回合編號（好友房顯示「第 X / N 回合」）
      nextInMs: number; // 幾毫秒後進入下一回合／結束
      final: boolean; // true 表示本回合結束後即分出勝負
      restrictions: Restriction[]; // 惡魔模式結算當下生效的限制（供顯示）
      zhuyinMatch?: boolean; // zhuyin 限制：被挑戰字是否符合韻符
      posViolation?: boolean; // pos 限制：被挑戰字是否為禁止的詞性（true = 違規）
      meaningChanged?: boolean; // meaning 限制：被挑戰字是否造成句意改變（false = 違規）
    }
  | {
      // 結算停留階段的「準備好了」狀態：哪些座位已按下
      type: "readyState";
      ready: Seat[];
    }
  | {
      type: "gameover";
      source: GameSource;
      winner: Seat | null; // 隨機配對：勝方；好友房：第一名（同分並列取 null）
      ranking: RankEntry[]; // 全排名（好友房；隨機配對亦附上供統一渲染）
      scores: number[];
      reason: GameoverReason;
      // 本場 ELO 變化（依 seat 排列）；null 表示本場未計入積分（好友房一律 null）
      elo: EloChange[] | null;
      canRestart: boolean; // 好友房：收訊者是否為房主（可按「再來一場」）
      // 以下僅在重連／中途加入補送結果時附帶（沒收過 start 的端需要這些才能正確顯示）
      you?: Seat | null;
      seats?: SeatInfo[];
    }
  | { type: "error"; message: string };
