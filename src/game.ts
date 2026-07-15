import type {
  ClientMessage,
  GameMode,
  GameStatus,
  LastMove,
  PlayerIdentity,
  Restriction,
  RestrictionKind,
  Role,
  Scores,
  ServerMessage,
} from "./types";
import { judge } from "./llm";
import {
  computeAllowedPositions,
  pickRestriction,
  targetRestrictionCount,
} from "./devil";
import {
  getPlayer,
  recordAiCost,
  recordGameEvent,
  recordMatch,
  type GameEventInput,
} from "./db";
import { eloOutcome } from "./elo";
import { SEED_WORDS } from "./seedWords";

const TURN_MS = 20_000;
// 新增/開局限制時，提示彈窗阻擋的緩衝時間；額外加到該回合截止時間，不佔用 20 秒（與前端一致）
const POPUP_MS = 3_000;
const RESULT_MS = 7_000; // 結算結果停留時間
const TARGET = 5;
// 超時額度：每人每場預設 2 次，超時時自動用掉一次換取 +10 秒（整場不重置）
const TIMEOUT_QUOTA = 2;
const TIMEOUT_EXTEND_MS = 10_000;
// 從內建的兩字詞種子表隨機挑一個（見 src/seedWords.ts）
function pickSeed(): string {
  return SEED_WORDS[Math.floor(Math.random() * SEED_WORDS.length)];
}

// 目前生效的限制是否含「位置限制」
function hasPosition(restrictions: Restriction[]): boolean {
  return restrictions.some((r) => r.kind === "position");
}

interface GameState {
  status: GameStatus;
  mode: GameMode;
  sentence: string[];
  scores: Scores;
  currentPlayer: Role;
  firstMover: Role;
  lastMove: LastMove | null;
  turnDeadline: number;
  restrictions: Restriction[]; // 惡魔模式目前生效的限制（隨字數累加、同回合種類不重複）
  roundStartLen: number; // 本回合開局時的句長（用來算已接入字數）
  prevStartKind: RestrictionKind | null; // 上一回合的起始限制種類（開局挑限制時避開，求跨回合變化）
  timeoutQuota: Scores; // 雙方剩餘的超時額度（整場不重置）
  round: number; // 回合編號（1 起，供歷史事件）
  seq: number; // 場內事件序號（1 起遞增，供歷史事件排序）
  allowedPositions: number[] | null; // 位置限制：目前玩家可放入的位置
  pendingFirstMover?: Role; // result 階段結束後的下一回合先手
  pendingWinner?: Role | null; // result 階段結束後若非 null 即遊戲結束
  readyPlayers?: Role[]; // result 階段中已按「準備好了」的玩家（雙方到齊即提前推進）
  players: { p1: PlayerIdentity | null; p2: PlayerIdentity | null }; // 雙方身分
  ratings: { p1: number; p2: number }; // 雙方 ELO 積分（開局當下，整局不變）
  games: { p1: number; p2: number }; // 雙方已玩場數（開局當下，供動態 K / placement）
  recorded?: boolean; // 是否已寫入戰績（避免重複寫入）
  finalWinner?: Role | null; // 遊戲結束後的勝方（供斷線者重連時補送 gameover）
  finalReason?: "score" | "opponent_left"; // 結束原因（同上）
}

interface Env {
  OPENROUTER_API_KEY: string;
  DB: D1Database;
}

export class Game {
  private ctx: DurableObjectState;
  private env: Env;
  private state: GameState | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  // ---- HTTP: WebSocket 升級 ----
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }

    const existing = this.ctx.getWebSockets();
    const url = new URL(request.url);
    const reqPlayerId = (url.searchParams.get("playerId") ?? "").slice(0, 64);

    // 遊戲已結束（含斷線判負）：不重新開局，改為補送結果給重連的玩家。
    // 斷線算輸的一方重連回來時，這裡讓他也能看到自己敗北的對戰結果。
    const s = await this.ensureState();
    if (s && s.status === "over") {
      const you = this.resolveRole(reqPlayerId, s);
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1], you ? [you] : []);
      if (you) pair[1].serializeAttachment({ role: you });
      this.sendTo(pair[1], this.buildGameover(you ?? undefined));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (existing.length >= 2) {
      return new Response("game full", { status: 409 });
    }

    const role: Role = existing.length === 0 ? "p1" : "p2";
    const mode: GameMode =
      url.searchParams.get("mode") === "devil" ? "devil" : "normal";

    // 玩家身分（無需登入；沿用 client 於 localStorage 產生的 UUID 與名稱）
    const identity: PlayerIdentity = {
      id: reqPlayerId,
      name:
        (url.searchParams.get("name") ?? "").trim().slice(0, 20) ||
        (role === "p1" ? "玩家 1" : "玩家 2"),
    };
    const players =
      (await this.ctx.storage.get<GameState["players"]>("players")) ??
      ({ p1: null, p2: null } as GameState["players"]);
    players[role] = identity;
    await this.ctx.storage.put("players", players);

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role });

    // 第二位玩家加入且尚未開過局 -> 開局（模式以第一位玩家（房主）為準）。
    // 已有對局狀態時不重新開局，避免斷線重連的時序把進行中的對局重置。
    if (existing.length === 1 && !s) {
      await this.startGame();
    } else if (!s) {
      // 第一位玩家：記住此房的模式
      await this.ctx.storage.put("mode", mode);
      this.sendTo(server, { type: "waiting" });
    } else {
      // 對局進行中卻又有連線進來（少見的重連時序）：不重開局。
      // 依「斷線判負」設計，既有的 close 結算後，broadcast 的 gameover 也會送達此連線。
      this.sendTo(server, { type: "waiting" });
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  // ---- WebSocket 訊息 ----
  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(typeof raw === "string" ? raw : "") as ClientMessage;
    } catch {
      return;
    }
    if (msg.type === "ping") return;

    const role = this.roleOf(ws);
    if (!role) return;

    const s = await this.ensureState();
    if (!s) return;

    // 結算停留階段的「準備好了」：不受「輪到你」限制，雙方皆可按
    if (msg.type === "ready") {
      await this.handleReady(role);
      return;
    }

    if (s.status !== "playing") return;
    if (role !== s.currentPlayer) {
      this.sendTo(ws, { type: "error", message: "還沒輪到你" });
      return;
    }

    if (msg.type === "insert") {
      await this.handleInsert(role, msg.index, msg.char);
    } else if (msg.type === "challenge") {
      await this.handleChallenge(role);
    }
  }

  async webSocketClose(ws: WebSocket) {
    const s = await this.ensureState();
    if (!s || s.status === "over") return;
    const leaver = this.roleOf(ws);
    const winner: Role | null = leaver === "p1" ? "p2" : leaver === "p2" ? "p1" : null;
    s.status = "over";
    s.finalWinner = winner;
    s.finalReason = "opponent_left";
    // 歷史：有人離開／斷線，對方判勝
    this.logEvent({
      type: "leave",
      actor: leaver,
      winner,
      reason: "opponent_left",
    });
    await this.save();
    await this.ctx.storage.deleteAlarm();
    this.broadcast(this.buildGameover());
    await this.recordResult(winner, "opponent_left");
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }

  // ---- 回合計時 ----
  async alarm() {
    const s = await this.ensureState();
    if (!s) return;

    // 結算結果停留結束 -> 進入下一回合或結束遊戲
    if (s.status === "result") {
      await this.advanceFromResult();
      return;
    }

    if (s.status !== "playing") return;
    if (Date.now() < s.turnDeadline - 500) {
      // 尚未真的超時（可能是舊 alarm），重設
      await this.ctx.storage.setAlarm(s.turnDeadline);
      return;
    }

    // 超時：若當事人尚有超時額度，自動用掉一次、該回合 +10 秒，不計分
    const timedOut = s.currentPlayer;
    if ((s.timeoutQuota?.[timedOut] ?? 0) > 0) {
      s.timeoutQuota[timedOut] -= 1;
      s.turnDeadline = Date.now() + TIMEOUT_EXTEND_MS;
      // 歷史：超時但用掉額度 +10 秒（不計分）
      this.logEvent({
        type: "timeout_extend",
        actor: timedOut,
        sentence: s.sentence.join(""),
        restriction: this.restrictionKinds(),
        detail: { quotaLeft: s.timeoutQuota[timedOut] },
      });
      await this.save();
      await this.ctx.storage.setAlarm(s.turnDeadline);
      this.broadcast({
        type: "timeoutExtend",
        player: timedOut,
        deadline: s.turnDeadline,
        timeoutQuota: s.timeoutQuota,
      });
      return;
    }

    // 沒有額度：當前玩家直接算輸，對方 +3（不轉為挑戰）
    const opponent: Role = s.currentPlayer === "p1" ? "p2" : "p1";
    s.scores[opponent] += 3;
    s.status = "settling";
    // 歷史：超時且無額度，對方直接 +3
    this.logEvent({
      type: "timeout",
      actor: timedOut,
      awardedTo: opponent,
      awardedPoints: 3,
      sentence: s.sentence.join(""),
      restriction: this.restrictionKinds(),
      reason: "超時未出手，對方直接得分",
    });
    await this.save();
    const final = this.startResultPhase();
    this.broadcast({
      type: "settled",
      challenger: s.currentPlayer,
      challengedChar: null,
      challengedIndex: null,
      sentenceScore: 0,
      isFiller: false,
      delta: 0,
      awardedTo: opponent,
      awardedPoints: 3,
      reason: "超時未出手，對方直接得分",
      sentence: s.sentence,
      scores: s.scores,
      nextInMs: RESULT_MS,
      final,
      restrictions: s.restrictions,
    });
    await this.save();
    await this.ctx.storage.setAlarm(Date.now() + RESULT_MS);
  }

  // ---- 動作處理 ----
  private async handleInsert(role: Role, index: number, char: string) {
    const s = this.state!;
    const c = (char ?? "").trim();
    if ([...c].length !== 1 || !/^[一-鿿]$/u.test(c)) {
      this.sendTo(this.socketOf(role), {
        type: "error",
        message: "請輸入單一中文字",
      });
      return;
    }
    if (!Number.isInteger(index) || index < 0 || index > s.sentence.length) {
      this.sendTo(this.socketOf(role), { type: "error", message: "放入位置無效" });
      return;
    }
    // 位置限制：只能插在本回合開放的位置
    if (s.allowedPositions && !s.allowedPositions.includes(index)) {
      this.sendTo(this.socketOf(role), {
        type: "error",
        message: "此位置本回合不開放",
      });
      return;
    }

    s.sentence.splice(index, 0, c);
    s.lastMove = { player: role, index, char: c };
    s.currentPlayer = role === "p1" ? "p2" : "p1";
    s.turnDeadline = Date.now() + TURN_MS;

    // 惡魔模式：本回合每接 5 個字累加一個新限制（種類不重複，最多用滿所有種類）。
    // 新增的限制從下一位玩家起生效。
    const newRestrictions: Restriction[] = [];
    if (s.mode === "devil") {
      const added = s.sentence.length - s.roundStartLen;
      const target = targetRestrictionCount(added);
      while (s.restrictions.length < target) {
        const next = pickRestriction(s.restrictions.map((r) => r.kind));
        if (!next) break;
        s.restrictions.push(next);
        newRestrictions.push(next);
      }
    }
    // 本次有新增限制：下一手多給 POPUP_MS 緩衝（提示彈窗阻擋期間不計入 20 秒）
    if (newRestrictions.length) {
      s.turnDeadline = Date.now() + TURN_MS + POPUP_MS;
    }

    // 位置限制：為下一位玩家重新開放一半位置（只要目前生效的限制含位置限制就套用）
    s.allowedPositions = hasPosition(s.restrictions)
      ? computeAllowedPositions(s.sentence.length)
      : null;
    // 歷史：一次接龍（附目前生效限制；本次若有新增限制記於 detail）
    this.logEvent({
      type: "move",
      actor: role,
      char: c,
      posIndex: index,
      sentence: s.sentence.join(""),
      restriction: this.restrictionKinds(),
      detail: newRestrictions.length
        ? { addedRestrictions: newRestrictions.map((r) => r.kind) }
        : null,
    });
    await this.save();
    await this.ctx.storage.setAlarm(s.turnDeadline);
    this.broadcastUpdate(newRestrictions);
  }

  private async handleChallenge(role: Role) {
    const s = this.state!;
    if (!s.lastMove || s.lastMove.player === role) {
      this.sendTo(this.socketOf(role), {
        type: "error",
        message: "目前沒有可挑戰的字",
      });
      return;
    }
    await this.settle(role);
  }

  // ---- 結算 ----
  private async settle(challenger: Role) {
    const s = this.state!;
    s.status = "settling";
    await this.save();
    await this.ctx.storage.deleteAlarm();

    // 通知雙方：AI 評分中（顯示等待畫面）
    this.broadcast({ type: "judging", challenger });

    const lastChar = s.lastMove!.char;
    const lastIndex = s.lastMove!.index;
    const sentence = s.sentence.join("");
    const {
      sentenceScore,
      isFiller,
      reason,
      zhuyinMatch,
      posViolation,
      meaningChanged,
      usage,
    } = await judge(
        this.env.OPENROUTER_API_KEY,
        sentence,
        lastChar,
        lastIndex,
        s.restrictions,
      );

    // 記錄本次挑戰的 AI 花費：不阻塞結算，寫入失敗也不影響對局
    const gameId = this.ctx.id.toString();
    console.log(JSON.stringify({ ev: "judge_cost", game: gameId, ...usage }));
    this.ctx.waitUntil(
      recordAiCost(this.env.DB, {
        gameId,
        mode: s.mode,
        restriction: this.restrictionKinds(),
        usage,
        now: Date.now(),
      }).catch((e) => console.error("recordAiCost failed", e)),
    );

    // 違規判定（語助詞／注音限制／詞性限制任一違反）：
    // 直接判挑戰方 +3，忽略句子評分等其他分數的加總。
    const fillerViolation = isFiller === true;
    const zhuyinViolation =
      s.restrictions.some((r) => r.kind === "zhuyin") && zhuyinMatch === false;
    const posViolationHit =
      s.restrictions.some((r) => r.kind === "pos") && posViolation === true;
    const meaningViolation =
      s.restrictions.some((r) => r.kind === "meaning") &&
      meaningChanged === false;
    const violated =
      fillerViolation || zhuyinViolation || posViolationHit || meaningViolation;

    // delta>0 被挑戰方得分、<0 挑戰方得分
    let delta: number;
    if (violated) {
      // 違規 -> 挑戰方（對方）直接 +3
      delta = -3;
    } else {
      delta = sentenceScore;
    }

    let awardedTo: Role | null = null;
    let awardedPoints = 0;
    const challenged: Role = challenger === "p1" ? "p2" : "p1";
    if (delta > 0) {
      // 句子合理、非語助詞 -> 挑戰錯誤 -> 對方（被挑戰方）加分
      awardedTo = challenged;
      awardedPoints = delta;
    } else if (delta < 0) {
      // 句子不合理／是語助詞 -> 挑戰正確 -> 我方（挑戰者）加分
      awardedTo = challenger;
      awardedPoints = -delta;
    }
    if (awardedTo) s.scores[awardedTo] += awardedPoints;

    // 歷史：挑戰結算（AI 評分、得分、違規判定）
    const violation = fillerViolation
      ? "filler"
      : zhuyinViolation
        ? "zhuyin"
        : posViolationHit
          ? "pos"
          : meaningViolation
            ? "meaning"
            : null;
    this.logEvent({
      type: "challenge",
      actor: challenger,
      challenged,
      char: lastChar,
      sentence: s.sentence.join(""),
      scoreA: sentenceScore,
      scoreB: isFiller ? 1 : 0,
      delta,
      awardedTo,
      awardedPoints,
      restriction: this.restrictionKinds(),
      violation,
      reason,
      detail: { zhuyinMatch, posViolation, meaningChanged },
    });

    const final = this.startResultPhase();
    await this.save();
    this.broadcast({
      type: "settled",
      challenger,
      challengedChar: lastChar,
      challengedIndex: lastIndex,
      sentenceScore,
      isFiller,
      delta,
      awardedTo,
      awardedPoints,
      reason,
      sentence: s.sentence,
      scores: s.scores,
      nextInMs: RESULT_MS,
      final,
      restrictions: s.restrictions,
      zhuyinMatch,
      posViolation,
      meaningChanged,
    });
    await this.ctx.storage.setAlarm(Date.now() + RESULT_MS);
  }

  // 進入結果停留階段：算出勝負與下一回合先手，交由 alarm 於 RESULT_MS 後推進。
  // 回傳是否為決勝回合。
  private startResultPhase(): boolean {
    const s = this.state!;
    const winner: Role | null =
      s.scores.p1 >= TARGET ? "p1" : s.scores.p2 >= TARGET ? "p2" : null;
    s.status = "result";
    s.pendingWinner = winner;
    s.pendingFirstMover = s.firstMover === "p1" ? "p2" : "p1";
    s.readyPlayers = []; // 重置「準備好了」狀態
    return winner !== null;
  }

  // 結算停留結束（alarm 到期或雙方都按「準備好了」）：進入下一回合或結束遊戲
  private async advanceFromResult() {
    const s = this.state!;
    if (s.status !== "result") return;
    if (s.pendingWinner) {
      s.status = "over";
      s.finalWinner = s.pendingWinner;
      s.finalReason = "score";
      // 歷史：整場結束（達標得勝）
      this.logEvent({
        type: "game_over",
        winner: s.pendingWinner,
        reason: "score",
      });
      await this.save();
      this.broadcast(this.buildGameover());
      await this.recordResult(s.pendingWinner, "score");
    } else {
      await this.beginRound(s.pendingFirstMover ?? "p1");
    }
  }

  // 結算停留階段，玩家按「準備好了」：記錄該方；雙方到齊即取消 alarm、提前推進。
  private async handleReady(role: Role) {
    const s = this.state!;
    if (s.status !== "result") return;
    const ready = s.readyPlayers ?? [];
    if (!ready.includes(role)) ready.push(role);
    s.readyPlayers = ready;
    await this.save();
    this.broadcast({ type: "readyState", ready });
    // 雙方都準備好 -> 取消停留 alarm，立即推進到下一回合／結束
    if (ready.includes("p1") && ready.includes("p2")) {
      await this.ctx.storage.deleteAlarm();
      await this.advanceFromResult();
    }
  }

  // 依開局當下的 ELO 與勝方，算出本場雙方積分變化（供 gameover 顯示）。
  // 條件與 recordResult 一致：無勝方／缺身分／同一人時回 null（本場不計分）。
  private computeElo(winner: Role | null): {
    p1: { before: number; after: number; delta: number };
    p2: { before: number; after: number; delta: number };
  } | null {
    const s = this.state;
    if (!s) return null;
    const p1 = s.players?.p1;
    const p2 = s.players?.p2;
    if (!winner || !p1?.id || !p2?.id || p1.id === p2.id) return null;
    const r = s.ratings ?? { p1: 1000, p2: 1000 };
    const g = s.games ?? { p1: 0, p2: 0 };
    const e1 = { rating: r.p1, games: g.p1 };
    const e2 = { rating: r.p2, games: g.p2 };
    if (winner === "p1") {
      const o = eloOutcome(e1, e2);
      return { p1: o.winner, p2: o.loser };
    }
    const o = eloOutcome(e2, e1);
    return { p1: o.loser, p2: o.winner };
  }

  // 依 playerId 判斷重連者原本是哪一方；找不到時退回目前沒有連線的那一方（通常即斷線者）。
  private resolveRole(playerId: string, s: GameState): Role | null {
    if (playerId) {
      if (s.players?.p1?.id === playerId) return "p1";
      if (s.players?.p2?.id === playerId) return "p2";
    }
    if (!this.socketOf("p1")) return "p1";
    if (!this.socketOf("p2")) return "p2";
    return null;
  }

  // 依已持久化的結果組出 gameover 訊息。
  // you 有值時（斷線者重連補送）會附帶自己的身分與名稱，讓沒收過 start 的端也能正確顯示。
  private buildGameover(you?: Role): ServerMessage {
    const s = this.state!;
    const winner = s.finalWinner ?? null;
    const msg: ServerMessage = {
      type: "gameover",
      winner,
      scores: s.scores,
      reason: s.finalReason ?? "score",
      elo: this.computeElo(winner),
    };
    if (you) {
      msg.you = you;
      msg.names = this.names();
    }
    return msg;
  }

  // 某一方的玩家 UUID（無身分時回 null）
  private idOf(role: Role | null | undefined): string | null {
    if (!role) return null;
    return this.state?.players?.[role]?.id ?? null;
  }

  // 寫入一筆遊玩歷史事件：遞增場內序號、帶入 game/回合/模式/比分快照。
  // 以 waitUntil 非阻塞寫入，D1 不可用或失敗都不影響對局。seq 的遞增會隨呼叫端既有的 save() 持久化。
  private logEvent(
    e: Omit<
      GameEventInput,
      "gameId" | "seq" | "round" | "mode" | "now" | "p1Score" | "p2Score"
    >,
  ) {
    const s = this.state;
    if (!s) return;
    s.seq = (s.seq ?? 0) + 1;
    const payload: GameEventInput = {
      ...e,
      gameId: this.ctx.id.toString(),
      seq: s.seq,
      round: s.round ?? 0,
      mode: s.mode,
      now: Date.now(),
      p1Score: s.scores.p1,
      p2Score: s.scores.p2,
      actorId: e.actorId ?? this.idOf(e.actor),
    };
    this.ctx.waitUntil(
      recordGameEvent(this.env.DB, payload).catch((err) =>
        console.error("recordGameEvent failed", err),
      ),
    );
  }

  // 遊戲結束時寫入戰績並更新 ELO；只寫一次，D1 失敗不影響遊戲流程
  private async recordResult(
    winner: Role | null,
    reason: "score" | "opponent_left",
  ) {
    const s = this.state;
    if (!s || s.recorded) return;
    const p1 = s.players?.p1;
    const p2 = s.players?.p2;
    // 需雙方身分且非同一人；勝方必須明確才更新積分
    if (!winner || !p1?.id || !p2?.id || p1.id === p2.id) return;
    s.recorded = true;
    await this.save();
    try {
      await recordMatch(this.env.DB, {
        matchId: crypto.randomUUID(),
        gameId: this.ctx.id.toString(),
        p1,
        p2,
        winner,
        scores: s.scores,
        mode: s.mode,
        reason,
        now: Date.now(),
      });
    } catch {
      /* D1 不可用（如純本地 dev）時略過，不阻斷遊戲 */
    }
  }

  // ---- 開局 / 開回合 ----
  private async startGame() {
    const mode = (await this.ctx.storage.get<GameMode>("mode")) ?? "normal";
    const players =
      (await this.ctx.storage.get<GameState["players"]>("players")) ??
      ({ p1: null, p2: null } as GameState["players"]);
    // 開局查雙方目前 ELO 與已玩場數（未註冊者預設 1000 / 0），整局固定
    const ratings = { p1: 1000, p2: 1000 };
    const games = { p1: 0, p2: 0 };
    try {
      const [a, b] = await Promise.all([
        players.p1?.id ? getPlayer(this.env.DB, players.p1.id) : null,
        players.p2?.id ? getPlayer(this.env.DB, players.p2.id) : null,
      ]);
      if (a) {
        ratings.p1 = a.rating;
        games.p1 = a.games;
      }
      if (b) {
        ratings.p2 = b.rating;
        games.p2 = b.games;
      }
    } catch {
      /* D1 不可用時用預設 1000 / 0 */
    }
    this.state = {
      status: "waiting",
      mode,
      sentence: [],
      scores: { p1: 0, p2: 0 },
      currentPlayer: "p1",
      firstMover: "p1",
      lastMove: null,
      turnDeadline: 0,
      restrictions: [],
      roundStartLen: 0,
      prevStartKind: null,
      timeoutQuota: { p1: TIMEOUT_QUOTA, p2: TIMEOUT_QUOTA },
      round: 0,
      seq: 0,
      allowedPositions: null,
      players,
      ratings,
      games,
    };
    await this.beginRound("p1");
  }

  // 雙方顯示名稱（供 start 訊息用）
  private names(): { p1: string; p2: string } {
    const p = this.state?.players;
    return {
      p1: p?.p1?.name ?? "玩家 1",
      p2: p?.p2?.name ?? "玩家 2",
    };
  }

  private async beginRound(firstMover: Role) {
    const s = this.state!;
    const seed = pickSeed();
    s.round = (s.round ?? 0) + 1;
    s.sentence = [...seed];
    s.lastMove = null;
    s.firstMover = firstMover;
    s.currentPlayer = firstMover;
    s.status = "playing";
    // 惡魔模式：回合開局先給 1 個限制（避開上一回合的起始種類，求跨回合變化）；
    // 之後在 handleInsert 內隨接入字數累加。
    s.restrictions = [];
    if (s.mode === "devil") {
      const first = pickRestriction(s.prevStartKind ? [s.prevStartKind] : []);
      if (first) {
        s.restrictions.push(first);
        s.prevStartKind = first.kind;
      }
    }
    s.roundStartLen = s.sentence.length;
    // 有起始限制時，首手多給 POPUP_MS 緩衝（提示彈窗阻擋期間不計入 20 秒）
    s.turnDeadline = Date.now() + TURN_MS + (s.restrictions.length ? POPUP_MS : 0);
    s.allowedPositions = hasPosition(s.restrictions)
      ? computeAllowedPositions(s.sentence.length)
      : null;
    // 歷史：回合開始（種子詞、先手、惡魔起始限制）
    this.logEvent({
      type: "round_start",
      actor: firstMover,
      sentence: seed,
      restriction: this.restrictionKinds(),
      detail: s.restrictions.length ? { restrictions: s.restrictions } : null,
    });
    await this.save();
    await this.ctx.storage.setAlarm(s.turnDeadline);

    for (const ws of this.ctx.getWebSockets()) {
      const role = this.roleOf(ws);
      if (!role) continue;
      this.sendTo(ws, {
        type: "start",
        you: role,
        sentence: s.sentence,
        scores: s.scores,
        currentPlayer: s.currentPlayer,
        deadline: s.turnDeadline,
        target: TARGET,
        canChallenge: this.canChallenge(role),
        mode: s.mode,
        restrictions: s.restrictions,
        allowedPositions: s.allowedPositions,
        names: this.names(),
        ratings: s.ratings ?? { p1: 1000, p2: 1000 },
        timeoutQuota: s.timeoutQuota ?? { p1: TIMEOUT_QUOTA, p2: TIMEOUT_QUOTA },
      });
    }
  }

  private broadcastUpdate(newRestrictions: Restriction[] = []) {
    const s = this.state!;
    for (const ws of this.ctx.getWebSockets()) {
      const role = this.roleOf(ws);
      if (!role) continue;
      this.sendTo(ws, {
        type: "update",
        sentence: s.sentence,
        scores: s.scores,
        currentPlayer: s.currentPlayer,
        deadline: s.turnDeadline,
        lastMove: s.lastMove,
        canChallenge: this.canChallenge(role),
        allowedPositions: s.allowedPositions,
        restrictions: s.restrictions,
        newRestrictions,
        timeoutQuota: s.timeoutQuota ?? { p1: TIMEOUT_QUOTA, p2: TIMEOUT_QUOTA },
      });
    }
  }

  // 目前生效限制的種類字串（逗號分隔，供歷史/計費紀錄）；無則 null
  private restrictionKinds(): string | null {
    const rs = this.state?.restrictions;
    if (!rs?.length) return null;
    return rs.map((r) => r.kind).join(",");
  }

  private canChallenge(role: Role): boolean {
    const s = this.state!;
    return (
      s.status === "playing" &&
      s.currentPlayer === role &&
      !!s.lastMove &&
      s.lastMove.player !== role
    );
  }

  // ---- 工具 ----
  private roleOf(ws: WebSocket): Role | null {
    const att = ws.deserializeAttachment() as { role?: Role } | null;
    if (att?.role) return att.role;
    const tags = this.ctx.getTags(ws);
    if (tags.includes("p1")) return "p1";
    if (tags.includes("p2")) return "p2";
    return null;
  }

  private socketOf(role: Role): WebSocket | undefined {
    return this.ctx.getWebSockets(role)[0];
  }

  private broadcast(msg: ServerMessage) {
    for (const ws of this.ctx.getWebSockets()) this.sendTo(ws, msg);
  }

  private sendTo(ws: WebSocket | undefined, msg: ServerMessage) {
    if (!ws) return;
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      /* ignore */
    }
  }

  private async ensureState(): Promise<GameState | undefined> {
    if (this.state) return this.state;
    this.state = await this.ctx.storage.get<GameState>("state");
    return this.state;
  }

  private async save() {
    if (this.state) await this.ctx.storage.put("state", this.state);
  }
}
