import type {
  ClientMessage,
  GameMode,
  GameStatus,
  LastMove,
  Restriction,
  RestrictionKind,
  Role,
  Scores,
  ServerMessage,
} from "./types";
import { judge } from "./llm";
import { computeAllowedPositions, KINDS, pickRestriction, ZODIAC_MIN_LEN } from "./devil";
import { SEED_WORDS } from "./seedWords";

const TURN_MS = 20_000;
const RESULT_MS = 10_000; // 結算結果停留時間
const TARGET = 5;
// 從內建的兩字詞種子表隨機挑一個（見 src/seedWords.ts）
function pickSeed(): string {
  return SEED_WORDS[Math.floor(Math.random() * SEED_WORDS.length)];
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
  restriction: Restriction | null; // 惡魔模式本回合限制
  usedRestrictions: RestrictionKind[]; // 已出現過的限制種類（循環用完後重置）
  allowedPositions: number[] | null; // 位置限制：目前玩家可放入的位置
  pendingFirstMover?: Role; // result 階段結束後的下一回合先手
  pendingWinner?: Role | null; // result 階段結束後若非 null 即遊戲結束
}

interface Env {
  AI: Ai;
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
    if (existing.length >= 2) {
      return new Response("game full", { status: 409 });
    }

    const role: Role = existing.length === 0 ? "p1" : "p2";
    const mode: GameMode =
      new URL(request.url).searchParams.get("mode") === "devil"
        ? "devil"
        : "normal";

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role });

    // 第二位玩家加入 -> 開局（模式以第一位玩家（房主）為準）
    if (existing.length === 1) {
      await this.startGame();
    } else {
      // 第一位玩家：記住此房的模式
      await this.ctx.storage.put("mode", mode);
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
    if (!s || s.status !== "playing") return;
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
    await this.save();
    await this.ctx.storage.deleteAlarm();
    this.broadcast({
      type: "gameover",
      winner,
      scores: s.scores,
      reason: "opponent_left",
    });
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
      if (s.pendingWinner) {
        s.status = "over";
        await this.save();
        this.broadcast({
          type: "gameover",
          winner: s.pendingWinner,
          scores: s.scores,
          reason: "score",
        });
      } else {
        await this.beginRound(s.pendingFirstMover ?? "p1");
      }
      return;
    }

    if (s.status !== "playing") return;
    if (Date.now() < s.turnDeadline - 500) {
      // 尚未真的超時（可能是舊 alarm），重設
      await this.ctx.storage.setAlarm(s.turnDeadline);
      return;
    }

    // 超時：由當前玩家自動質疑對方上一手
    if (s.lastMove && s.lastMove.player !== s.currentPlayer) {
      await this.settle(s.currentPlayer);
    } else {
      // 本回合第一手就超時、沒有可質疑的對象 -> 對方 +1
      const opponent: Role = s.currentPlayer === "p1" ? "p2" : "p1";
      s.scores[opponent] += 1;
      s.status = "settling";
      await this.save();
      const final = this.startResultPhase();
      this.broadcast({
        type: "settled",
        challenger: s.currentPlayer,
        challengedChar: null,
        A: 0,
        B: 0,
        delta: 0,
        awardedTo: opponent,
        awardedPoints: 1,
        reason: "超時未出手，對方得分",
        sentence: s.sentence,
        scores: s.scores,
        nextInMs: RESULT_MS,
        final,
        restriction: s.restriction,
      });
      await this.save();
      await this.ctx.storage.setAlarm(Date.now() + RESULT_MS);
    }
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
    // 位置限制：為下一位玩家重新開放一半位置
    s.allowedPositions =
      s.restriction?.kind === "position"
        ? computeAllowedPositions(s.sentence.length)
        : null;
    await this.save();
    await this.ctx.storage.setAlarm(s.turnDeadline);
    this.broadcastUpdate();
  }

  private async handleChallenge(role: Role) {
    const s = this.state!;
    if (!s.lastMove || s.lastMove.player === role) {
      this.sendTo(this.socketOf(role), {
        type: "error",
        message: "目前沒有可質疑的字",
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
    const { A, B, reason, zhuyinMatch, zodiacScore, posViolation } = await judge(
      this.env.AI,
      sentence,
      lastChar,
      lastIndex,
      s.restriction,
    );

    // 惡魔模式加成（皆折入 delta；delta>0 被質疑方得分、<0 質疑方得分）
    let delta = A - B;
    // 注音限制：被質疑字不符韻符 -> 質疑方 +3
    if (s.restriction?.kind === "zhuyin" && zhuyinMatch === false) {
      delta -= 3;
    }
    // 星座限制：句子超過門檻長度時，語氣相符度直接折入（正=被質疑方、負=質疑方）
    if (
      s.restriction?.kind === "zodiac" &&
      s.sentence.length > ZODIAC_MIN_LEN &&
      typeof zodiacScore === "number"
    ) {
      delta += zodiacScore;
    }
    // 詞性限制：被質疑字為禁止的詞性 -> 質疑方 +3
    if (s.restriction?.kind === "pos" && posViolation === true) {
      delta -= 3;
    }

    let awardedTo: Role | null = null;
    let awardedPoints = 0;
    const challenged: Role = challenger === "p1" ? "p2" : "p1";
    if (delta > 0) {
      // 句子合理、非語助詞 -> 質疑錯誤 -> 對方（被質疑方）加分
      awardedTo = challenged;
      awardedPoints = delta;
    } else if (delta < 0) {
      // 句子不合理／是語助詞 -> 質疑正確 -> 我方（質疑者）加分
      awardedTo = challenger;
      awardedPoints = -delta;
    }
    if (awardedTo) s.scores[awardedTo] += awardedPoints;

    const final = this.startResultPhase();
    await this.save();
    this.broadcast({
      type: "settled",
      challenger,
      challengedChar: lastChar,
      A,
      B,
      delta,
      awardedTo,
      awardedPoints,
      reason,
      sentence: s.sentence,
      scores: s.scores,
      nextInMs: RESULT_MS,
      final,
      restriction: s.restriction,
      zhuyinMatch,
      zodiacScore,
      posViolation,
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
    return winner !== null;
  }

  // ---- 開局 / 開回合 ----
  private async startGame() {
    const mode = (await this.ctx.storage.get<GameMode>("mode")) ?? "normal";
    this.state = {
      status: "waiting",
      mode,
      sentence: [],
      scores: { p1: 0, p2: 0 },
      currentPlayer: "p1",
      firstMover: "p1",
      lastMove: null,
      turnDeadline: 0,
      restriction: null,
      usedRestrictions: [],
      allowedPositions: null,
    };
    await this.beginRound("p1");
  }

  private async beginRound(firstMover: Role) {
    const s = this.state!;
    const seed = pickSeed();
    s.sentence = [...seed];
    s.lastMove = null;
    s.firstMover = firstMover;
    s.currentPlayer = firstMover;
    s.status = "playing";
    s.turnDeadline = Date.now() + TURN_MS;
    // 惡魔模式：每回合抽一個限制，優先挑前面回合沒出現過的種類
    if (s.mode === "devil") {
      if (!s.usedRestrictions || s.usedRestrictions.length >= KINDS.length) {
        s.usedRestrictions = [];
      }
      s.restriction = pickRestriction(s.usedRestrictions);
      s.usedRestrictions.push(s.restriction.kind);
    } else {
      s.restriction = null;
    }
    s.allowedPositions =
      s.restriction?.kind === "position"
        ? computeAllowedPositions(s.sentence.length)
        : null;
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
        restriction: s.restriction,
        allowedPositions: s.allowedPositions,
      });
    }
  }

  private broadcastUpdate() {
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
      });
    }
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
