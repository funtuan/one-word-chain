import type {
  ClientMessage,
  EloChange,
  GameMode,
  GameSource,
  GameStatus,
  GameoverReason,
  LastMove,
  PlayerIdentity,
  RankEntry,
  Restriction,
  RestrictionKind,
  Seat,
  SeatInfo,
  ServerMessage,
  WinRule,
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
  recordRoomMatch,
  type GameEventInput,
} from "./db";
import { eloOutcome } from "./elo";
import { SEED_WORDS } from "./seedWords";

const TURN_MS = 20_000;
// 新增/開局限制時，提示彈窗阻擋的緩衝時間；額外加到該回合截止時間，不佔用 20 秒（與前端一致）
const POPUP_MS = 3_000;
const RESULT_MS = 7_000; // 結算結果停留時間
const TARGET = 5; // 隨機配對：先達此分獲勝
// 超時額度：每人每場預設 2 次，超時時自動用掉一次換取 +10 秒（整場不重置）
const TIMEOUT_QUOTA = 2;
const TIMEOUT_EXTEND_MS = 10_000;
// settle() 評分逾時保護：AI 呼叫（含重試）超過此時間仍未完成 -> 視為 DO 重啟/卡死，
// 由 alarm 自行復原（本回合不計分結算），避免永遠卡在「評分中」畫面。
const SETTLE_RECOVERY_MS = 45_000;

// ---- 好友房 ----
const ROOM_ROUNDS = 5; // 好友房：固定回合數，打完看總分排行
const ROOM_MIN_PLAYERS = 2;
const ROOM_MAX_PLAYERS = 6;
// 對局中斷線的重連寬限：超過此時間輪到他（或他超時）即淘汰出局
const LEAVE_GRACE_MS = 30_000;
// 房間閒置回收：等待室／結束後每隔此時間檢查一次，無任何連線即回收
const ROOM_IDLE_TTL_MS = 10 * 60_000;

// 從內建的兩字詞種子表隨機挑一個（見 src/seedWords.ts）
function pickSeed(): string {
  return SEED_WORDS[Math.floor(Math.random() * SEED_WORDS.length)];
}

// 目前生效的限制是否含「位置限制」
function hasPosition(restrictions: Restriction[]): boolean {
  return restrictions.some((r) => r.kind === "position");
}

// 一個座位的完整狀態（身分 + 對局數值）
interface SeatState {
  id: string; // 玩家 UUID（即帳號代碼，絕不可送往前端）
  name: string;
  rating: number; // 開局當下 ELO（隨機配對用；好友房不計）
  games: number; // 開局當下已玩場數（動態 K 用）
  score: number;
  timeoutQuota: number;
  eliminated: boolean; // 好友房：已中離淘汰
  leftAt: number | null; // 對局中斷線的時間戳；null 表示連線中
}

// WebSocket attachment：seat 有值即為玩家；否則為觀戰者。
// 座位查找一律走 attachment（tags 建立後不可變，rematch 重新配位時需要改寫）。
interface WsAttachment {
  pid: string; // 玩家 UUID（可為空字串）
  name: string;
  seat?: Seat;
  spec?: boolean;
}

interface GameState {
  source: GameSource;
  roomCode: string | null; // 好友房房號（source === "room" 才有）
  sessionId: string; // 本場紀錄用 id；好友房 rematch 時換新，讓每場紀錄各自獨立
  hostId: string | null; // 好友房房主的玩家 UUID
  status: GameStatus;
  mode: GameMode;
  seats: SeatState[];
  sentence: string[];
  currentPlayer: Seat;
  firstMover: Seat;
  lastMove: LastMove | null;
  // 最後一手放入當下「已生效」的限制快照。因放入第 N 手可能觸發新增限制、而新限制「從下一位
  // 玩家起生效」，挑戰這一手時須用放入當下的限制集（不含這一手觸發新增的）來評分，避免多判一項。
  lastMoveRestrictions: Restriction[];
  turnDeadline: number;
  restrictions: Restriction[]; // 惡魔模式目前生效的限制（隨字數累加、同回合種類不重複）
  roundStartLen: number; // 本回合開局時的句長（用來算已接入字數）
  prevStartKind: RestrictionKind | null; // 上一回合的起始限制種類（開局挑限制時避開，求跨回合變化）
  round: number; // 回合編號（1 起）
  totalRounds: number | null; // 好友房固定回合數；隨機配對為 null（先達分制）
  seq: number; // 場內事件序號（1 起遞增，供歷史事件排序）
  allowedPositions: number[] | null; // 位置限制：目前玩家可放入的位置
  consecSkips: number; // 連續「超時跳過」數；滿一輪（所有在局者）即本回合不計分結算
  pendingFirstMover?: Seat; // result 階段結束後的下一回合先手
  pendingWinner?: Seat | null; // 隨機配對：result 結束後若非 null 即遊戲結束
  pendingOver?: boolean; // 好友房：result 結束後是否整場結束
  pendingReason?: GameoverReason; // 整場結束原因（rounds / players_left）
  readyPlayers?: Seat[]; // result 階段中已按「準備好了」的座位
  recorded?: boolean; // 是否已寫入戰績（避免重複寫入）
  finalWinner?: Seat | null; // 遊戲結束後的勝方（供重連時補送 gameover）
  finalReason?: GameoverReason;
  finalRanking?: RankEntry[]; // 好友房：最終排名
  pendingChallenger?: Seat; // 評分中的挑戰者（供 DO 重啟後的復原流程使用）
  settleToken?: number; // 每次 settle() 遞增；復原流程會搶先遞增讓舊呼叫的結果失效
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

  // ---- HTTP：內部端點 + WebSocket 升級 ----
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const s = await this.ensureState();

    // 存活檢查（Lobby 配對前用）：房主 WS 仍連著、且此房尚未開局／未結束
    // 才算「可加入」。避免把新配對者導進一個已被放棄的空房而永遠等不到人。
    if (url.pathname.endsWith("/alive")) {
      const joinable =
        this.ctx.getWebSockets().length >= 1 &&
        (!s || (s.source === "match" && s.status === "waiting"));
      return Response.json({ alive: joinable });
    }

    // 建立好友房（Worker 轉發；碰撞時回 409 讓 Worker 換碼重試）
    if (url.pathname.endsWith("/room-init") && request.method === "POST") {
      return this.handleRoomInit(request);
    }

    // 查好友房狀態（加入前的確認畫面用）
    if (url.pathname.endsWith("/room-info")) {
      if (!s || s.source !== "room") {
        return Response.json({ ok: false }, { status: 404 });
      }
      return Response.json({
        ok: true,
        code: s.roomCode,
        mode: s.mode,
        status: s.status,
        playerCount: s.seats.length,
        minPlayers: ROOM_MIN_PLAYERS,
        maxPlayers: ROOM_MAX_PLAYERS,
        rounds: ROOM_ROUNDS,
      });
    }

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    return this.handleConnect(url, s);
  }

  private async handleRoomInit(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      code?: string;
      mode?: string;
      hostId?: string;
    };
    const code = (body.code ?? "").slice(0, 12);
    if (!code) return Response.json({ error: "code required" }, { status: 400 });

    // 已有活房（等待／進行中，或還有人連著）-> 房號被佔用
    const s = await this.ensureState();
    if (s && !(s.status === "over" && this.ctx.getWebSockets().length === 0)) {
      return Response.json({ error: "occupied" }, { status: 409 });
    }
    if (s) await this.wipe(); // 舊房已死：回收後重用房號

    this.state = {
      source: "room",
      roomCode: code,
      sessionId: crypto.randomUUID(),
      hostId: (body.hostId ?? "").slice(0, 64) || null,
      status: "waiting",
      mode: body.mode === "devil" ? "devil" : "normal",
      seats: [],
      sentence: [],
      currentPlayer: 0,
      firstMover: 0,
      lastMove: null,
      lastMoveRestrictions: [],
      turnDeadline: 0,
      restrictions: [],
      roundStartLen: 0,
      prevStartKind: null,
      round: 0,
      totalRounds: ROOM_ROUNDS,
      seq: 0,
      allowedPositions: null,
      consecSkips: 0,
    };
    await this.save();
    await this.ctx.storage.setAlarm(Date.now() + ROOM_IDLE_TTL_MS);
    return Response.json({ ok: true });
  }

  // ---- WebSocket 連線：入座 / 重連 / 觀戰 ----
  private async handleConnect(
    url: URL,
    s: GameState | undefined,
  ): Promise<Response> {
    const pid = (url.searchParams.get("playerId") ?? "").slice(0, 64);
    const name = (url.searchParams.get("name") ?? "").trim().slice(0, 20);
    // 官方前端一律帶 playerId（loadIdentity 保證非空）；拒絕空 id 連線，
    // 順帶消除座位以「空 pid」辨識所衍生的一整類邊界問題（見 resyncAttachments）。
    if (!pid) {
      return new Response("playerId required", { status: 400 });
    }

    // 房號連結指向的房間已解散（或從未存在）：不可在此 DO 上建立隨機配對狀態
    if (!s) {
      const m = url.pathname.match(/^\/game\/([^/]+)\/ws$/);
      if (m && decodeURIComponent(m[1]).startsWith("room:")) {
        return new Response("room not found", { status: 404 });
      }
    }

    // 隨機配對的第一位玩家：建立對局狀態（模式以第一位玩家為準）
    if (!s) {
      this.state = {
        source: "match",
        roomCode: null,
        sessionId: crypto.randomUUID(),
        hostId: null,
        status: "waiting",
        mode: url.searchParams.get("mode") === "devil" ? "devil" : "normal",
        seats: [this.newSeat(pid, name, 0)],
        sentence: [],
        currentPlayer: 0,
        firstMover: 0,
        lastMove: null,
        lastMoveRestrictions: [],
        turnDeadline: 0,
        restrictions: [],
        roundStartLen: 0,
        prevStartKind: null,
        round: 0,
        totalRounds: null,
        seq: 0,
        allowedPositions: null,
        consecSkips: 0,
      };
      await this.save();
      // 若對手一直沒來就孤兒化：等待室沒人等待逾時後回收（隨機配對的 Lobby 存活
      // 檢查只看實際連線數，孤兒房不會被配對到，純粹是儲存空間清理）。
      await this.ctx.storage.setAlarm(Date.now() + ROOM_IDLE_TTL_MS);
      const ws = this.accept({ pid, name, seat: 0 });
      this.sendTo(ws, { type: "waiting" });
      return ws.response;
    }

    // 同 id 已在座 -> 視為重連而非新玩家（多分頁／斷線回來都走這裡）
    const existingSeat = pid
      ? s.seats.findIndex((sk) => sk.id === pid)
      : -1;
    if (existingSeat >= 0) {
      return this.acceptReconnect(existingSeat, pid, name);
    }

    // 等待中：入座
    if (s.status === "waiting") {
      const cap = s.source === "match" ? 2 : ROOM_MAX_PLAYERS;
      if (s.seats.length < cap) {
        const seat = s.seats.length;
        s.seats.push(this.newSeat(pid, name, seat));
        await this.save();
        const ws = this.accept({ pid, name, seat });

        if (s.source === "match") {
          if (s.seats.length === 2) {
            await this.startGame();
          } else {
            this.sendTo(ws, { type: "waiting" });
          }
        } else {
          this.sendRoomState();
        }
        return ws.response;
      }
      // 好友房已滿員：連結被點開 -> 觀戰（等待室裡先看名單，開局後看對戰）
      if (s.source === "room") {
        const ws = this.accept({ pid, name, spec: true });
        this.sendRoomState();
        return ws.response;
      }
      return new Response("game full", { status: 409 });
    }

    // 已開局／已結束：好友房 -> 觀戰；隨機配對 -> 僅結束後可取結果
    if (s.source === "match" && s.status !== "over") {
      return new Response("game full", { status: 409 });
    }
    const ws = this.accept({ pid, name, spec: true });
    if (s.status === "over") {
      this.sendTo(ws.socket, this.buildGameover(null, true));
    } else {
      this.sendTo(ws.socket, this.buildStart(null));
    }
    return ws.response;
  }

  // 重連：關掉同座位的舊連線、以新連線補位，並補送目前狀態
  private async acceptReconnect(
    seat: Seat,
    pid: string,
    name: string,
  ): Promise<Response> {
    const s = this.state!;
    const olds = this.socketsOfSeat(seat);
    const ws = this.accept({ pid, name, seat });
    for (const old of olds) {
      try {
        // 先抹掉舊連線的座位標記，避免其 close 事件被誤判為「玩家離開」
        old.serializeAttachment({ pid: "", name: "", spec: true });
        old.close(1000, "reconnected");
      } catch {
        /* ignore */
      }
    }
    if (name && s.seats[seat].name !== name) {
      s.seats[seat].name = name;
    }
    if (s.seats[seat].leftAt !== null) {
      s.seats[seat].leftAt = null;
    }
    await this.save();

    switch (s.status) {
      case "waiting":
        if (s.source === "room") this.sendRoomState();
        else this.sendTo(ws.socket, { type: "waiting" });
        break;
      case "over":
        this.sendTo(ws.socket, this.buildGameover(seat, true));
        break;
      default:
        // playing / settling / result：補送完整快照（result 的結算彈窗略過，
        // 下一回合開始時會再收到 start）
        this.sendTo(ws.socket, this.buildStart(seat));
        this.broadcastPresence();
        break;
    }
    return ws.response;
  }

  private newSeat(pid: string, name: string, seat: Seat): SeatState {
    return {
      id: pid,
      name: name || `玩家 ${seat + 1}`,
      rating: 1000,
      games: 0,
      score: 0,
      timeoutQuota: TIMEOUT_QUOTA,
      eliminated: false,
      leftAt: null,
    };
  }

  private accept(att: WsAttachment): { socket: WebSocket; response: Response } {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment(att);
    return {
      socket: pair[1],
      response: new Response(null, { status: 101, webSocket: pair[0] }),
    };
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

    const s = await this.ensureState();
    if (!s) return;
    const att = this.attOf(ws);
    const seat = att?.seat ?? null;

    if (msg.type === "startRoom") {
      await this.handleStartRoom(seat);
      return;
    }
    if (msg.type === "restartRoom") {
      await this.handleRestartRoom(seat);
      return;
    }
    if (msg.type === "leave") {
      await this.handleLeave(ws, seat);
      return;
    }
    if (seat === null) return; // 觀戰者不可操作

    // 結算停留階段的「準備好了」：不受「輪到你」限制
    if (msg.type === "ready") {
      await this.handleReady(seat);
      return;
    }

    if (s.status !== "playing") return;
    if (seat !== s.currentPlayer) {
      this.sendTo(ws, { type: "error", message: "還沒輪到你" });
      return;
    }

    if (msg.type === "insert") {
      await this.handleInsert(seat, msg.index, msg.char);
    } else if (msg.type === "challenge") {
      await this.handleChallenge(seat);
    }
  }

  async webSocketClose(ws: WebSocket) {
    const s = await this.ensureState();
    if (!s || s.status === "over") return;
    const att = this.attOf(ws);
    const seat = att?.seat ?? null;
    if (seat === null) return; // 觀戰者離開不影響對局
    // 同座位還有其他活連線（重連取代舊線的時序）-> 不視為離開
    if (this.socketsOfSeat(seat).some((w) => w !== ws)) return;

    if (s.status === "waiting") {
      await this.leaveWaiting(seat);
      return;
    }

    if (s.status === "result") {
      // 結算停留階段：勝負（match 的 pendingWinner／room 的 pendingOver）已經決定，
      // 交由既有的 RESULT_MS alarm 收尾即可；不可再套用下方「斷線即判負」，
      // 否則剛獲勝的一方若在停留期間斷線，會被誤判為輸家。
      if (s.source === "match") return;
      s.seats[seat].leftAt = Date.now();
      await this.save();
      this.broadcastPresence();
      return;
    }

    if (s.source === "match") {
      // 隨機配對：斷線即判負（維持既有規則）
      const winner: Seat | null = s.seats.length === 2 ? (seat === 0 ? 1 : 0) : null;
      this.logEvent({
        type: "leave",
        actor: this.seatLabel(seat),
        actorId: s.seats[seat]?.id ?? null,
        winner: this.seatLabel(winner),
        reason: "opponent_left",
      });
      await this.finishGame(winner, "opponent_left");
      return;
    }

    // 好友房：進入重連寬限（輪到他且寬限已過才淘汰），先廣播席位狀態
    s.seats[seat].leftAt = Date.now();
    await this.save();
    this.broadcastPresence();
  }

  async webSocketError(ws: WebSocket) {
    await this.webSocketClose(ws);
  }

  // ---- 等待室 ----
  // 房主按「開始遊戲」：人數達下限即可開局
  private async handleStartRoom(seat: Seat | null) {
    const s = this.state!;
    if (s.source !== "room" || s.status !== "waiting" || seat === null) return;
    if (!this.isHostSeat(seat)) return;
    if (s.seats.length < ROOM_MIN_PLAYERS) {
      this.sendTo(this.socketOfSeat(seat), {
        type: "error",
        message: `至少需要 ${ROOM_MIN_PLAYERS} 位玩家才能開始`,
      });
      return;
    }
    await this.startGame();
  }

  // 結束後房主按「再來一場」：同房重置回等待室；觀戰者遞補入座；紀錄另起新場
  private async handleRestartRoom(seat: Seat | null) {
    const s = this.state!;
    if (s.source !== "room" || s.status !== "over" || seat === null) return;
    if (seat !== this.effectiveHostSeat()) return;

    // 重建名單：原座位中仍連線者依序保留，再讓連線中的觀戰者遞補
    const roster: SeatState[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < s.seats.length; i++) {
      if (this.socketsOfSeat(i).length === 0) continue;
      roster.push({ ...s.seats[i] });
      if (s.seats[i].id) seen.add(s.seats[i].id);
    }
    for (const ws of this.ctx.getWebSockets()) {
      if (roster.length >= ROOM_MAX_PLAYERS) break;
      const att = this.attOf(ws);
      if (!att || att.seat !== undefined) continue;
      if (att.pid && seen.has(att.pid)) continue;
      if (att.pid) seen.add(att.pid);
      roster.push(this.newSeat(att.pid, att.name, roster.length));
    }
    for (const sk of roster) {
      sk.score = 0;
      sk.timeoutQuota = TIMEOUT_QUOTA;
      sk.eliminated = false;
      sk.leftAt = null;
    }

    s.seats = roster;
    s.sessionId = crypto.randomUUID(); // 新的一場：紀錄各自獨立
    s.status = "waiting";
    s.sentence = [];
    s.lastMove = null;
    s.lastMoveRestrictions = [];
    s.round = 0;
    s.seq = 0;
    s.restrictions = [];
    s.allowedPositions = null;
    s.consecSkips = 0;
    s.prevStartKind = null;
    s.readyPlayers = [];
    s.recorded = false;
    s.pendingWinner = undefined;
    s.pendingOver = undefined;
    s.pendingReason = undefined;
    s.finalWinner = undefined;
    s.finalReason = undefined;
    s.finalRanking = undefined;
    this.resyncAttachments();
    await this.save();
    await this.ctx.storage.setAlarm(Date.now() + ROOM_IDLE_TTL_MS);
    this.sendRoomState();
  }

  // 主動離開：等待室退出（房主=解散）；對局中立即出局
  private async handleLeave(ws: WebSocket, seat: Seat | null) {
    const s = this.state!;
    if (seat === null) {
      try {
        ws.close(1000, "bye");
      } catch {
        /* ignore */
      }
      return;
    }
    if (s.status === "waiting") {
      // 先抹座位標記再關線，避免 close 事件重複處理
      ws.serializeAttachment({ pid: "", name: "", spec: true } as WsAttachment);
      try {
        ws.close(1000, "bye");
      } catch {
        /* ignore */
      }
      await this.leaveWaiting(seat);
      return;
    }
    if (s.status === "over") return;
    if (s.source === "match") {
      // 隨機配對：離開即判負（沿用斷線流程）
      try {
        ws.close(1000, "bye");
      } catch {
        /* ignore */
      }
      return; // close handler 會結算
    }
    // 好友房對局中：立即淘汰（不留寬限）
    ws.serializeAttachment({ pid: "", name: "", spec: true } as WsAttachment);
    try {
      ws.close(1000, "bye");
    } catch {
      /* ignore */
    }
    await this.eliminateSeat(seat, "主動離開");
  }

  // 等待室成員離開：房主 -> 給重連寬限，逾時才解散；其他人 -> 移出名單（釋出的空位
  // 讓目前連線中的觀戰者遞補入座）。
  private async leaveWaiting(seat: Seat) {
    const s = this.state!;
    if (s.source === "match") {
      s.seats.splice(seat, 1);
      this.resyncAttachments();
      await this.save();
      return;
    }
    if (this.isHostSeat(seat)) {
      // 房主在等待室斷線：可能只是重整頁面／訊號不穩，給一段寬限而非立即解散，
      // 否則一次意外斷線就會把所有已加入的好友直接踢光。acceptReconnect 會在
      // 房主重連時清掉 leftAt；寬限逾時仍未回來才真正解散（見 alarm()）。
      s.seats[seat].leftAt = Date.now();
      await this.save();
      await this.ctx.storage.setAlarm(Date.now() + LEAVE_GRACE_MS);
      this.sendRoomState();
      return;
    }
    s.seats.splice(seat, 1);
    this.resyncAttachments();
    this.promoteSpectatorIfRoom();
    await this.save();
    this.sendRoomState();
  }

  // 把一位目前連線中、尚未入座的觀戰者遞補進剛釋出的空位（供等待室有人離開時使用；
  // 開局後的重開一場走 handleRestartRoom 自己的名單重建邏輯，不會經過這裡）。
  private promoteSpectatorIfRoom(): boolean {
    const s = this.state!;
    if (s.source !== "room" || s.seats.length >= ROOM_MAX_PLAYERS) return false;
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attOf(ws);
      if (!att || att.seat !== undefined) continue; // 已入座
      const seat = s.seats.length;
      s.seats.push(this.newSeat(att.pid, att.name, seat));
      try {
        ws.serializeAttachment({ pid: att.pid, name: att.name, seat });
      } catch {
        /* ignore */
      }
      return true;
    }
    return false;
  }

  // 解散房間：通知所有連線並回收
  private async closeRoom(reason: "host_left" | "expired") {
    this.broadcast({ type: "roomClosed", reason });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.close(1000, reason);
      } catch {
        /* ignore */
      }
    }
    await this.wipe();
  }

  // ---- 回合計時 / 房間回收 ----
  async alarm() {
    const s = await this.ensureState();
    if (!s) return;

    // 等待室中的房主斷線寬限：逾時仍未重連才真正解散房間。
    if (s.status === "waiting" && s.source === "room") {
      const hostSeat = s.seats.findIndex((sk) => !!sk.id && sk.id === s.hostId);
      const leftAt = hostSeat >= 0 ? s.seats[hostSeat].leftAt : null;
      if (leftAt !== null) {
        if (Date.now() - leftAt > LEAVE_GRACE_MS) {
          await this.closeRoom("host_left");
        } else {
          await this.ctx.storage.setAlarm(leftAt + LEAVE_GRACE_MS);
        }
        return;
      }
    }

    // 等待室／結束後的閒置回收：沒有任何連線即回收；還有人就再等一輪
    if (s.status === "waiting" || s.status === "over") {
      if (this.ctx.getWebSockets().length === 0) {
        await this.wipe();
      } else {
        await this.ctx.storage.setAlarm(Date.now() + ROOM_IDLE_TTL_MS);
      }
      return;
    }

    // 結算結果停留結束 -> 進入下一回合或結束遊戲
    if (s.status === "result") {
      await this.advanceFromResult();
      return;
    }

    // settle() 的復原用 alarm 被喚醒：代表 judge() 那次呼叫已經逾時／連同 DO 重啟消失，
    // 自行以不計分結算收尾，讓對局能繼續而不是永遠卡在「評分中」畫面。
    if (s.status === "settling") {
      await this.recoverStuckSettle();
      return;
    }

    if (s.status !== "playing") return;
    if (Date.now() < s.turnDeadline - 500) {
      // 尚未真的超時（可能是舊 alarm），重設
      await this.ctx.storage.setAlarm(s.turnDeadline);
      return;
    }

    const timedOut = s.currentPlayer;
    const cur = s.seats[timedOut];

    // 好友房：當前玩家已斷線且寬限已過 -> 直接淘汰，不再消耗超時額度
    if (
      s.source === "room" &&
      cur.leftAt !== null &&
      Date.now() - cur.leftAt > LEAVE_GRACE_MS
    ) {
      await this.eliminateSeat(timedOut, "斷線逾時出局");
      return;
    }

    // 超時：若當事人尚有超時額度，自動用掉一次、該回合 +10 秒，不計分
    if (cur.timeoutQuota > 0) {
      cur.timeoutQuota -= 1;
      s.turnDeadline = Date.now() + TIMEOUT_EXTEND_MS;
      this.logEvent({
        type: "timeout_extend",
        actor: this.seatLabel(timedOut),
        actorId: cur.id || null,
        sentence: s.sentence.join(""),
        restriction: this.restrictionKinds(),
        detail: { quotaLeft: cur.timeoutQuota },
      });
      await this.save();
      await this.ctx.storage.setAlarm(s.turnDeadline);
      this.broadcast({
        type: "timeoutExtend",
        player: timedOut,
        deadline: s.turnDeadline,
        timeoutQuota: this.quotas(),
      });
      return;
    }

    // 沒有額度：
    // - 在局僅剩 2 人（含超時者）：另一人直接 +3 並結算本回合（涵蓋隨機配對）
    // - 3 人以上：超時者本回合跳過、不給分，輪到下一位
    const others = this.activeSeats().filter((i) => i !== timedOut);
    if (others.length <= 1) {
      const awardedTo = others.length === 1 ? others[0] : null;
      if (awardedTo !== null) s.seats[awardedTo].score += 3;
      s.status = "settling";
      this.logEvent({
        type: "timeout",
        actor: this.seatLabel(timedOut),
        actorId: cur.id || null,
        awardedTo: this.seatLabel(awardedTo),
        awardedPoints: 3,
        sentence: s.sentence.join(""),
        restriction: this.restrictionKinds(),
        reason: "超時未出手，對方直接得分",
      });
      await this.save();
      const final = this.startResultPhase();
      this.broadcast({
        type: "settled",
        challenger: timedOut,
        challenged: null,
        challengedChar: null,
        challengedIndex: null,
        sentenceScore: 0,
        delta: 0,
        awardedTo,
        awardedPoints: awardedTo !== null ? 3 : 0,
        reason: "超時未出手，對方直接得分",
        sentence: s.sentence,
        scores: this.scores(),
        round: s.round,
        nextInMs: RESULT_MS,
        final,
        restrictions: s.restrictions,
      });
      await this.save();
      await this.ctx.storage.setAlarm(Date.now() + RESULT_MS);
      return;
    }

    // 跳過：連續跳滿一輪（所有在局者都沒出手）-> 本回合不計分結算，避免回合卡死
    s.consecSkips += 1;
    this.logEvent({
      type: "timeout",
      actor: this.seatLabel(timedOut),
      actorId: cur.id || null,
      awardedTo: null,
      awardedPoints: 0,
      sentence: s.sentence.join(""),
      restriction: this.restrictionKinds(),
      reason: "超時未出手，本回合跳過",
    });
    if (s.consecSkips >= this.activeSeats().length) {
      s.status = "settling";
      await this.save();
      const final = this.startResultPhase();
      this.broadcast({
        type: "settled",
        challenger: timedOut,
        challenged: null,
        challengedChar: null,
        challengedIndex: null,
        sentenceScore: 0,
        delta: 0,
        awardedTo: null,
        awardedPoints: 0,
        reason: "全員超時未出手，本回合不計分",
        sentence: s.sentence,
        scores: this.scores(),
        round: s.round,
        nextInMs: RESULT_MS,
        final,
        restrictions: s.restrictions,
      });
      await this.save();
      await this.ctx.storage.setAlarm(Date.now() + RESULT_MS);
      return;
    }

    const next = await this.advancePastEliminations(timedOut);
    if (next === null || this.activeSeats().length <= 1) {
      await this.finishRoomGame("players_left");
      return;
    }
    s.currentPlayer = next;
    s.turnDeadline = Date.now() + TURN_MS;
    await this.save();
    await this.ctx.storage.setAlarm(s.turnDeadline);
    for (const ws of this.ctx.getWebSockets()) {
      const seat = this.attOf(ws)?.seat ?? null;
      this.sendTo(ws, {
        type: "timeoutSkip",
        player: timedOut,
        currentPlayer: next,
        deadline: s.turnDeadline,
        canChallenge: seat !== null && this.canChallenge(seat),
        timeoutQuota: this.quotas(),
      });
    }
  }

  // ---- 動作處理 ----
  private async handleInsert(seat: Seat, index: number, char: string) {
    const s = this.state!;
    const c = (char ?? "").trim();
    if ([...c].length !== 1 || !/^[一-鿿]$/u.test(c)) {
      this.sendTo(this.socketOfSeat(seat), {
        type: "error",
        message: "請輸入單一中文字",
      });
      return;
    }
    if (!Number.isInteger(index) || index < 0 || index > s.sentence.length) {
      this.sendTo(this.socketOfSeat(seat), {
        type: "error",
        message: "放入位置無效",
      });
      return;
    }
    // 位置限制：只能插在本回合開放的位置
    if (s.allowedPositions && !s.allowedPositions.includes(index)) {
      this.sendTo(this.socketOfSeat(seat), {
        type: "error",
        message: "此位置本回合不開放",
      });
      return;
    }

    s.sentence.splice(index, 0, c);
    s.lastMove = { player: seat, index, char: c };
    // 快照這一手放入當下已生效的限制；本手觸發新增的限制（下方 while）不算在內，
    // 挑戰這一手時只用此快照評分，避免多判一項。
    s.lastMoveRestrictions = [...s.restrictions];
    s.consecSkips = 0;

    const next = await this.advancePastEliminations(seat);
    if (next === null || this.activeSeats().length <= 1) {
      await this.finishRoomGame("players_left");
      return;
    }
    s.currentPlayer = next;
    s.turnDeadline = Date.now() + TURN_MS;

    // 惡魔模式：本回合每接 5 個字累加一個新限制（種類不重複，最多用滿所有種類）。
    // 新增的限制從下一位玩家起生效。
    const newRestrictions: Restriction[] = [];
    if (s.mode === "devil") {
      const added = s.sentence.length - s.roundStartLen;
      const target = targetRestrictionCount(added);
      while (s.restrictions.length < target) {
        const nextR = pickRestriction(s.restrictions.map((r) => r.kind));
        if (!nextR) break;
        s.restrictions.push(nextR);
        newRestrictions.push(nextR);
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
      actor: this.seatLabel(seat),
      actorId: s.seats[seat].id || null,
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

  private async handleChallenge(seat: Seat) {
    const s = this.state!;
    if (!s.lastMove || s.lastMove.player === seat) {
      this.sendTo(this.socketOfSeat(seat), {
        type: "error",
        message: "目前沒有可挑戰的字",
      });
      return;
    }
    await this.settle(seat);
  }

  // ---- 結算 ----
  private async settle(challenger: Seat) {
    const s = this.state!;
    s.status = "settling";
    s.consecSkips = 0;
    s.pendingChallenger = challenger;
    s.settleToken = (s.settleToken ?? 0) + 1;
    const myToken = s.settleToken;
    await this.save();
    // 不用 deleteAlarm：改設一個寬鬆的復原用 alarm。若 judge() 正常完成，稍後會被
    // RESULT_MS 的 alarm 覆蓋；若 DO 在評分中重啟導致這次呼叫消失，逾時後 alarm()
    // 會自行復原（本回合不計分結算），避免永遠卡在「評分中」畫面。
    await this.ctx.storage.setAlarm(Date.now() + SETTLE_RECOVERY_MS);

    // 通知所有人：AI 評分中（顯示等待畫面）
    this.broadcast({ type: "judging", challenger });

    const lastChar = s.lastMove!.char;
    const lastIndex = s.lastMove!.index;
    const challenged = s.lastMove!.player;
    const sentence = s.sentence.join("");
    // 這一手放入當下已生效的限制（不含這一手觸發新增的）；評分、違規判定、結算顯示都以此為準。
    // 舊存檔可能沒有此欄位，退回目前限制集以策安全。
    const activeRestrictions = s.lastMoveRestrictions ?? s.restrictions;
    // 量測整段評分（含所有重試）的實際耗時，對照 SETTLE_RECOVERY_MS 追查逾時原因。
    const judgeStart = Date.now();
    const {
      sentenceScore,
      reason,
      zhuyinMatch,
      posViolation,
      meaningChanged,
      noBoringViolation,
      usage,
    } = await judge(
      this.env.OPENROUTER_API_KEY,
      sentence,
      lastChar,
      lastIndex,
      activeRestrictions,
    );
    const judgeMs = Date.now() - judgeStart;

    // 評分期間對局可能已被搶先結束（如全員中離、房主解散），或本次呼叫已被
    // recoverStuckSettle() 判定逾時、由另一條路徑接手處理：放棄本次結算。
    if (this.state?.status !== "settling" || this.state?.settleToken !== myToken) {
      // judge() 有回來、只是太慢（已被復原接手）或對局已結束；記下耗時以便追查逾時。
      console.log(
        JSON.stringify({
          ev: "judge_abandoned",
          game: this.recordGameId(),
          judgeMs,
          attempts: usage.attempts,
          ok: usage.ok,
          status: this.state?.status ?? null,
        }),
      );
      return;
    }

    // 記錄本次挑戰的 AI 花費：不阻塞結算，寫入失敗也不影響對局
    const gameId = this.recordGameId();
    console.log(
      JSON.stringify({ ev: "judge_cost", game: gameId, judgeMs, ...usage }),
    );
    this.ctx.waitUntil(
      recordAiCost(this.env.DB, {
        gameId,
        mode: s.mode,
        restriction: this.restrictionKinds(activeRestrictions),
        usage,
        now: Date.now(),
      }).catch((e) => console.error("recordAiCost failed", e)),
    );

    // 違規判定（惡魔模式的注音／詞性／語意限制任一違反）：
    // 直接判挑戰方 +3，忽略句子評分等其他分數的加總。
    const zhuyinViolation =
      activeRestrictions.some((r) => r.kind === "zhuyin") && zhuyinMatch === false;
    const posViolationHit =
      activeRestrictions.some((r) => r.kind === "pos") && posViolation === true;
    const meaningViolation =
      activeRestrictions.some((r) => r.kind === "meaning") &&
      meaningChanged === false;
    // 別太無聊限制：AI 判定被挑戰字是否為無聊字（人稱代名詞／語氣感嘆詞／親屬稱謂）。
    const noBoringViolationHit =
      activeRestrictions.some((r) => r.kind === "noboring") &&
      noBoringViolation === true;
    const violated =
      zhuyinViolation || posViolationHit || meaningViolation || noBoringViolationHit;

    // delta>0 被挑戰方得分、<0 挑戰方得分。
    // 多人下計分只在「挑戰者 ↔ 被挑戰者」之間流動，其他玩家不動。
    let delta: number;
    if (violated) {
      delta = -3;
    } else {
      delta = sentenceScore;
    }

    let awardedTo: Seat | null = null;
    let awardedPoints = 0;
    if (delta > 0) {
      // 句子合理 -> 挑戰錯誤 -> 被挑戰方加分
      awardedTo = challenged;
      awardedPoints = delta;
    } else if (delta < 0) {
      // 句子不合理／湊字 -> 挑戰正確 -> 挑戰者加分
      awardedTo = challenger;
      awardedPoints = -delta;
    }
    if (awardedTo !== null) s.seats[awardedTo].score += awardedPoints;

    // 歷史：挑戰結算（AI 評分、得分、違規判定）
    const violation = zhuyinViolation
      ? "zhuyin"
      : posViolationHit
        ? "pos"
        : meaningViolation
          ? "meaning"
          : noBoringViolationHit
            ? "noboring"
            : null;
    this.logEvent({
      type: "challenge",
      actor: this.seatLabel(challenger),
      actorId: s.seats[challenger].id || null,
      challenged: this.seatLabel(challenged),
      char: lastChar,
      sentence: s.sentence.join(""),
      scoreA: sentenceScore,
      scoreB: 0, // 已移除語助詞判定，保留欄位相容舊資料，固定 0
      delta,
      awardedTo: this.seatLabel(awardedTo),
      awardedPoints,
      restriction: this.restrictionKinds(activeRestrictions),
      violation,
      reason,
      detail: { zhuyinMatch, posViolation, meaningChanged, noBoringViolation },
    });

    const final = this.startResultPhase();
    await this.save();
    this.broadcast({
      type: "settled",
      challenger,
      challenged,
      challengedChar: lastChar,
      challengedIndex: lastIndex,
      sentenceScore,
      delta,
      awardedTo,
      awardedPoints,
      reason,
      sentence: s.sentence,
      scores: this.scores(),
      round: s.round,
      nextInMs: RESULT_MS,
      final,
      restrictions: activeRestrictions,
      zhuyinMatch,
      posViolation,
      meaningChanged,
      noBoringViolation,
    });
    await this.ctx.storage.setAlarm(Date.now() + RESULT_MS);
  }

  // settle() 卡死復原：搶先遞增 settleToken 讓可能仍在跑的舊 judge() 呼叫失效，
  // 以「不計分」結算本回合，讓對局能繼續（而不是永遠卡在評分中畫面）。
  private async recoverStuckSettle() {
    const s = this.state!;
    s.settleToken = (s.settleToken ?? 0) + 1;
    const challenger = s.pendingChallenger ?? s.currentPlayer;
    const challenged = s.lastMove?.player ?? null;
    const reason = "系統評分逾時，本回合不計分";
    // 逾時復原被觸發：代表 judge() 在 SETTLE_RECOVERY_MS 內沒回來（AI 太慢／卡住，
    // 或 DO 在評分中重啟）。搭配 judge_attempt 的逐次耗時可判斷是哪家 provider 卡住。
    console.log(
      JSON.stringify({
        ev: "judge_timeout",
        game: this.recordGameId(),
        recoveryMs: SETTLE_RECOVERY_MS,
        char: s.lastMove?.char ?? null,
      }),
    );
    this.logEvent({
      type: "challenge",
      actor: this.seatLabel(challenger),
      actorId: s.seats[challenger]?.id || null,
      challenged: this.seatLabel(challenged),
      char: s.lastMove?.char ?? null,
      sentence: s.sentence.join(""),
      scoreA: 0,
      scoreB: 0,
      delta: 0,
      awardedTo: null,
      awardedPoints: 0,
      restriction: this.restrictionKinds(s.lastMoveRestrictions),
      reason,
    });
    const final = this.startResultPhase();
    await this.save();
    this.broadcast({
      type: "settled",
      challenger,
      challenged,
      challengedChar: s.lastMove?.char ?? null,
      challengedIndex: s.lastMove?.index ?? null,
      sentenceScore: 0,
      delta: 0,
      awardedTo: null,
      awardedPoints: 0,
      reason,
      sentence: s.sentence,
      scores: this.scores(),
      round: s.round,
      nextInMs: RESULT_MS,
      final,
      restrictions: s.lastMoveRestrictions ?? s.restrictions,
    });
    await this.ctx.storage.setAlarm(Date.now() + RESULT_MS);
  }

  // 進入結果停留階段：算出勝負與下一回合先手，交由 alarm 於 RESULT_MS 後推進。
  // 回傳是否為決勝回合。
  private startResultPhase(): boolean {
    const s = this.state!;
    s.status = "result";
    s.readyPlayers = [];
    s.pendingFirstMover = this.nextActiveFrom(s.firstMover);

    if (s.source === "match") {
      const winner: Seat | null =
        s.seats[0].score >= TARGET ? 0 : s.seats[1].score >= TARGET ? 1 : null;
      s.pendingWinner = winner;
      return winner !== null;
    }

    // 好友房：固定回合數打完（或在局人數不足）即整場結束
    const active = this.activeSeats().length;
    if (active <= 1) {
      s.pendingOver = true;
      s.pendingReason = "players_left";
    } else if (s.totalRounds !== null && s.round >= s.totalRounds) {
      s.pendingOver = true;
      s.pendingReason = "rounds";
    } else {
      s.pendingOver = false;
      s.pendingReason = undefined;
    }
    return s.pendingOver === true;
  }

  // 結算停留結束（alarm 到期或全員都按「準備好了」）：進入下一回合或結束遊戲
  private async advanceFromResult() {
    const s = this.state!;
    if (s.status !== "result") return;
    if (s.source === "match" && s.pendingWinner !== null && s.pendingWinner !== undefined) {
      this.logEvent({
        type: "game_over",
        winner: this.seatLabel(s.pendingWinner),
        reason: "score",
      });
      await this.finishGame(s.pendingWinner, "score");
      return;
    }
    if (s.source === "room" && s.pendingOver) {
      await this.finishRoomGame(s.pendingReason ?? "rounds");
      return;
    }
    // 下一回合先手：座位順序輪替；跳過已淘汰／寬限已過者
    let fm = s.pendingFirstMover ?? 0;
    const sk = s.seats[fm];
    if (!sk || sk.eliminated) {
      const next = await this.advancePastEliminations(fm);
      if (next === null || this.activeSeats().length <= 1) {
        await this.finishRoomGame("players_left");
        return;
      }
      fm = next;
    }
    await this.beginRound(fm);
  }

  // 結算停留階段，玩家按「準備好了」：記錄該座位；在局且連線中的座位全按了即提前推進。
  private async handleReady(seat: Seat) {
    const s = this.state!;
    if (s.status !== "result") return;
    if (s.seats[seat]?.eliminated) return;
    const ready = s.readyPlayers ?? [];
    if (!ready.includes(seat)) ready.push(seat);
    s.readyPlayers = ready;
    await this.save();
    this.broadcast({ type: "readyState", ready });
    const waitingOn = this.activeSeats().filter(
      (i) => !ready.includes(i) && this.socketsOfSeat(i).length > 0,
    );
    if (waitingOn.length === 0) {
      await this.ctx.storage.deleteAlarm();
      await this.advanceFromResult();
    }
  }

  // ---- 淘汰 / 回合輪轉 ----
  // 是否「真的在局」：未淘汰，且非「斷線且寬限已過」（好友房）。
  // 寬限已過者尚未被正式標記 eliminated（要等輪到他／被輪轉邏輯掃到才補標），
  // 但所有計數/判斷都必須立刻把他視為不在局，否則會被指派回合或分到超時獎勵分。
  private isActive(seat: Seat): boolean {
    const s = this.state!;
    const sk = s.seats[seat];
    if (sk.eliminated) return false;
    if (s.source === "room" && sk.leftAt !== null && Date.now() - sk.leftAt > LEAVE_GRACE_MS) {
      return false;
    }
    return true;
  }

  // 在局座位（未淘汰，且非寬限已過的斷線者）。
  private activeSeats(): Seat[] {
    const s = this.state!;
    return s.seats.map((_, i) => i).filter((i) => this.isActive(i));
  }

  // 從 from 之後找下一位在局座位；沿途淘汰「斷線且寬限已過」者。
  // 找不到其他在局座位時回傳 null。
  private async advancePastEliminations(from: Seat): Promise<Seat | null> {
    const s = this.state!;
    const n = s.seats.length;
    for (let step = 1; step <= n; step++) {
      const i = (from + step) % n;
      const sk = s.seats[i];
      if (sk.eliminated) continue;
      if (
        s.source === "room" &&
        sk.leftAt !== null &&
        Date.now() - sk.leftAt > LEAVE_GRACE_MS
      ) {
        await this.markEliminated(i, "斷線逾時出局");
        continue;
      }
      if (i === from) return null; // 繞了一圈：沒有其他在局座位
      return i;
    }
    return null;
  }

  // 下一位在局座位（供計算下一回合先手）；沿途把寬限已過的斷線席位正式標記淘汰
  // （副作用：直接 mutate state，呼叫端需自行 save()），維持與 advancePastEliminations 一致的行為。
  private nextActiveFrom(from: Seat): Seat {
    const s = this.state!;
    const n = s.seats.length;
    for (let step = 1; step <= n; step++) {
      const i = (from + step) % n;
      const sk = s.seats[i];
      if (sk.eliminated) continue;
      if (
        s.source === "room" &&
        sk.leftAt !== null &&
        Date.now() - sk.leftAt > LEAVE_GRACE_MS
      ) {
        sk.eliminated = true;
        s.readyPlayers = (s.readyPlayers ?? []).filter((x) => x !== i);
        this.logEvent({
          type: "leave",
          actor: this.seatLabel(i),
          actorId: sk.id || null,
          reason: "斷線逾時出局",
        });
        continue;
      }
      return i;
    }
    return from;
  }

  // 標記淘汰並記錄事件（不做後續輪轉；由呼叫端決定）
  private async markEliminated(seat: Seat, why: string) {
    const s = this.state!;
    if (s.seats[seat].eliminated) return;
    s.seats[seat].eliminated = true;
    s.readyPlayers = (s.readyPlayers ?? []).filter((i) => i !== seat);
    this.logEvent({
      type: "leave",
      actor: this.seatLabel(seat),
      actorId: s.seats[seat].id || null,
      reason: why,
    });
    await this.save();
    this.broadcastPresence();
  }

  // 淘汰一位玩家並接續對局：輪到他則跳到下一位；在局 ≤1 則整場結束
  private async eliminateSeat(seat: Seat, why: string) {
    const s = this.state!;
    if (s.status === "over" || s.seats[seat]?.eliminated) return;
    await this.markEliminated(seat, why);

    if (this.activeSeats().length <= 1) {
      if (s.status === "result") await this.ctx.storage.deleteAlarm();
      await this.finishRoomGame("players_left");
      return;
    }
    if (s.status === "playing" && s.currentPlayer === seat) {
      const next = await this.advancePastEliminations(seat);
      if (next === null || this.activeSeats().length <= 1) {
        await this.finishRoomGame("players_left");
        return;
      }
      s.currentPlayer = next;
      s.turnDeadline = Date.now() + TURN_MS;
      await this.save();
      await this.ctx.storage.setAlarm(s.turnDeadline);
      for (const ws of this.ctx.getWebSockets()) {
        const sSeat = this.attOf(ws)?.seat ?? null;
        this.sendTo(ws, {
          type: "timeoutSkip",
          player: seat,
          currentPlayer: next,
          deadline: s.turnDeadline,
          canChallenge: sSeat !== null && this.canChallenge(sSeat),
          timeoutQuota: this.quotas(),
        });
      }
      return;
    }
    // result 階段：淘汰後若剩餘在局者都已準備好，提前推進
    if (s.status === "result") {
      const ready = s.readyPlayers ?? [];
      const waitingOn = this.activeSeats().filter(
        (i) => !ready.includes(i) && this.socketsOfSeat(i).length > 0,
      );
      if (waitingOn.length === 0) {
        await this.ctx.storage.deleteAlarm();
        await this.advanceFromResult();
      }
    }
  }

  // ---- 勝負結算 / 紀錄 ----
  // 隨機配對結束（達標或斷線判負）。刻意不排閒置回收 alarm：gameId 是隨機 UUID、
  // 結束後不會被配對重用，讓結果永久可查（斷線的一方晚點重試連線仍能拿到正確結果），
  // 也避免「結果被清空後重試連線變成一場全新配對」這種更嚴重的錯亂。
  private async finishGame(winner: Seat | null, reason: GameoverReason) {
    const s = this.state!;
    s.status = "over";
    s.finalWinner = winner;
    s.finalReason = reason;
    s.finalRanking = this.computeRanking();
    await this.save();
    await this.ctx.storage.deleteAlarm();
    this.sendGameoverAll();
    await this.recordResult();
  }

  // 好友房結束（固定回合打完或只剩 1 人）：全排名，不計 ELO
  private async finishRoomGame(reason: GameoverReason) {
    const s = this.state!;
    if (s.status === "over") return;
    s.status = "over";
    s.finalReason = reason;
    s.finalRanking = this.computeRanking();
    // 第一名唯一才有 winner；同分並列為 null
    const tops = s.finalRanking.filter((r) => r.rank === 1);
    s.finalWinner = tops.length === 1 ? tops[0].seat : null;
    this.logEvent({
      type: "game_over",
      winner: this.seatLabel(s.finalWinner ?? null),
      reason,
      detail: { ranking: s.finalRanking },
    });
    await this.save();
    await this.ctx.storage.deleteAlarm();
    this.sendGameoverAll();
    await this.recordResult();
    await this.ctx.storage.setAlarm(Date.now() + ROOM_IDLE_TTL_MS);
  }

  // 排名：在局者優先、分數高者在前；中離者排在所有在局者之後。
  // 同組（同淘汰狀態）且同分共列同名次。
  private computeRanking(): RankEntry[] {
    const s = this.state!;
    const entries = s.seats.map((sk, seat) => ({
      seat,
      score: sk.score,
      eliminated: sk.eliminated,
    }));
    entries.sort((a, b) => {
      if (a.eliminated !== b.eliminated) return a.eliminated ? 1 : -1;
      return b.score - a.score;
    });
    const out: RankEntry[] = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      const prev = out[i - 1];
      const rank =
        prev &&
        prev.eliminated === e.eliminated &&
        prev.score === e.score
          ? prev.rank
          : i + 1;
      out.push({ ...e, rank });
    }
    return out;
  }

  // 依開局當下的 ELO 與勝方，算出本場積分變化（隨機配對；供 gameover 顯示）。
  // 條件與 recordResult 一致：無勝方／缺身分／同一人時回 null（本場不計分）。
  private computeElo(): EloChange[] | null {
    const s = this.state;
    if (!s || s.source !== "match" || s.seats.length !== 2) return null;
    const winner = s.finalWinner;
    const [a, b] = s.seats;
    if (winner === null || winner === undefined || !a.id || !b.id || a.id === b.id) {
      return null;
    }
    const e0 = { rating: a.rating, games: a.games };
    const e1 = { rating: b.rating, games: b.games };
    if (winner === 0) {
      const o = eloOutcome(e0, e1);
      return [o.winner, o.loser];
    }
    const o = eloOutcome(e1, e0);
    return [o.loser, o.winner];
  }

  // 依已持久化的結果組出 gameover 訊息。
  // withIdentity=true（重連／中途加入補送）會附帶收訊者身分與座位名單。
  private buildGameover(you: Seat | null, withIdentity = false): ServerMessage {
    const s = this.state!;
    const msg: ServerMessage = {
      type: "gameover",
      source: s.source,
      winner: s.finalWinner ?? null,
      ranking: s.finalRanking ?? this.computeRanking(),
      scores: this.scores(),
      reason: s.finalReason ?? "score",
      elo: this.computeElo(),
      canRestart:
        s.source === "room" && you !== null && you === this.effectiveHostSeat(),
    };
    if (withIdentity) {
      msg.you = you;
      msg.seats = this.seatInfos();
    }
    return msg;
  }

  private sendGameoverAll() {
    for (const ws of this.ctx.getWebSockets()) {
      const seat = this.attOf(ws)?.seat ?? null;
      this.sendTo(ws, this.buildGameover(seat));
    }
  }

  // 寫入一筆遊玩歷史事件：遞增場內序號、帶入 game/回合/模式/比分快照。
  // 以 waitUntil 非阻塞寫入，D1 不可用或失敗都不影響對局。
  private logEvent(
    e: Omit<
      GameEventInput,
      "gameId" | "seq" | "round" | "mode" | "now" | "p1Score" | "p2Score" | "source" | "scores"
    >,
  ) {
    const s = this.state;
    if (!s) return;
    s.seq = (s.seq ?? 0) + 1;
    const payload: GameEventInput = {
      ...e,
      gameId: this.recordGameId(),
      seq: s.seq,
      round: s.round ?? 0,
      mode: s.mode,
      source: s.source,
      now: Date.now(),
      p1Score: s.seats[0]?.score ?? 0,
      p2Score: s.seats[1]?.score ?? 0,
      scores: s.source === "room" ? this.scores() : null,
    };
    this.ctx.waitUntil(
      recordGameEvent(this.env.DB, payload).catch((err) =>
        console.error("recordGameEvent failed", err),
      ),
    );
  }

  // 遊戲結束時寫入戰績；只寫一次，D1 失敗不影響遊戲流程。
  // 隨機配對：matches + ELO；好友房：room_matches（不計 ELO、不動 players 表）。
  private async recordResult() {
    const s = this.state;
    if (!s || s.recorded) return;

    if (s.source === "match") {
      const [a, b] = s.seats;
      const winner = s.finalWinner;
      // 需雙方身分且非同一人；勝方必須明確才更新積分
      if (winner === null || winner === undefined || !a?.id || !b?.id || a.id === b.id) {
        return;
      }
      s.recorded = true;
      await this.save();
      try {
        await recordMatch(this.env.DB, {
          matchId: crypto.randomUUID(),
          gameId: this.recordGameId(),
          p1: { id: a.id, name: a.name },
          p2: { id: b.id, name: b.name },
          winner: winner === 0 ? "p1" : "p2",
          scores: { p1: a.score, p2: b.score },
          mode: s.mode,
          reason: s.finalReason === "opponent_left" ? "opponent_left" : "score",
          now: Date.now(),
        });
      } catch {
        /* D1 不可用（如純本地 dev）時略過，不阻斷遊戲 */
      }
      return;
    }

    // 好友房：紀錄整場與各座位名次（分析用；不計 ELO、不進 players 勝敗場）
    s.recorded = true;
    await this.save();
    const ranking = s.finalRanking ?? this.computeRanking();
    try {
      await recordRoomMatch(this.env.DB, {
        matchId: s.sessionId,
        roomCode: s.roomCode ?? "",
        mode: s.mode,
        rounds: s.round,
        playerCount: s.seats.length,
        reason: s.finalReason ?? "rounds",
        players: ranking.map((r) => ({
          id: s.seats[r.seat].id,
          name: s.seats[r.seat].name,
          seat: r.seat,
          score: r.score,
          rank: r.rank,
          eliminated: r.eliminated,
        })),
        now: Date.now(),
      });
    } catch {
      /* D1 不可用時略過 */
    }
  }

  // ---- 開局 / 開回合 ----
  private async startGame() {
    const s = this.state!;
    // 隨機配對：開局查雙方目前 ELO 與已玩場數（未註冊者預設 1000 / 0），整局固定
    if (s.source === "match") {
      try {
        const rows = await Promise.all(
          s.seats.map((sk) => (sk.id ? getPlayer(this.env.DB, sk.id) : null)),
        );
        rows.forEach((row, i) => {
          if (row) {
            s.seats[i].rating = row.rating;
            s.seats[i].games = row.games;
          }
        });
      } catch {
        /* D1 不可用時用預設 1000 / 0 */
      }
    }
    for (const sk of s.seats) {
      sk.score = 0;
      sk.timeoutQuota = TIMEOUT_QUOTA;
      sk.eliminated = false;
      sk.leftAt = null;
    }
    s.round = 0;
    s.prevStartKind = null;
    s.consecSkips = 0;
    await this.beginRound(0);
  }

  private async beginRound(firstMover: Seat) {
    const s = this.state!;
    const seed = pickSeed();
    s.round = (s.round ?? 0) + 1;
    s.sentence = [...seed];
    s.lastMove = null;
    s.lastMoveRestrictions = [];
    s.firstMover = firstMover;
    s.currentPlayer = firstMover;
    s.status = "playing";
    s.consecSkips = 0;
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
      actor: this.seatLabel(firstMover),
      actorId: s.seats[firstMover]?.id || null,
      sentence: seed,
      restriction: this.restrictionKinds(),
      detail: s.restrictions.length ? { restrictions: s.restrictions } : null,
    });
    await this.save();
    await this.ctx.storage.setAlarm(s.turnDeadline);

    for (const ws of this.ctx.getWebSockets()) {
      const seat = this.attOf(ws)?.seat ?? null;
      this.sendTo(ws, this.buildStart(seat));
    }
  }

  // 開局／回合開始／重連與觀戰的完整快照
  private buildStart(you: Seat | null): ServerMessage {
    const s = this.state!;
    return {
      type: "start",
      you,
      source: s.source,
      rule: this.rule(),
      round: s.round,
      seats: this.seatInfos(),
      sentence: s.sentence,
      scores: this.scores(),
      currentPlayer: s.currentPlayer,
      deadline: s.turnDeadline,
      lastMove: s.lastMove,
      canChallenge: you !== null && this.canChallenge(you),
      mode: s.mode,
      restrictions: s.restrictions,
      allowedPositions: s.allowedPositions,
      timeoutQuota: this.quotas(),
    };
  }

  private broadcastUpdate(newRestrictions: Restriction[] = []) {
    const s = this.state!;
    for (const ws of this.ctx.getWebSockets()) {
      const seat = this.attOf(ws)?.seat ?? null;
      this.sendTo(ws, {
        type: "update",
        sentence: s.sentence,
        scores: this.scores(),
        currentPlayer: s.currentPlayer,
        deadline: s.turnDeadline,
        lastMove: s.lastMove,
        canChallenge: seat !== null && this.canChallenge(seat),
        allowedPositions: s.allowedPositions,
        restrictions: s.restrictions,
        newRestrictions,
        timeoutQuota: this.quotas(),
      });
    }
  }

  // 等待室狀態：逐連線分送（you / isHost 因人而異）
  private sendRoomState() {
    const s = this.state!;
    if (s.source !== "room") return;
    const players = s.seats.map((sk, i) => ({
      name: sk.name,
      host: !!sk.id && sk.id === s.hostId,
      connected: this.socketsOfSeat(i).length > 0,
    }));
    for (const ws of this.ctx.getWebSockets()) {
      const att = this.attOf(ws);
      const seat = att?.seat ?? null;
      this.sendTo(ws, {
        type: "roomState",
        code: s.roomCode ?? "",
        mode: s.mode,
        rule: this.rule(),
        players,
        you: seat,
        isHost: seat !== null && this.isHostSeat(seat),
        minPlayers: ROOM_MIN_PLAYERS,
        maxPlayers: ROOM_MAX_PLAYERS,
      });
    }
  }

  private broadcastPresence() {
    this.broadcast({ type: "presence", seats: this.seatInfos() });
  }

  // ---- 快照輔助 ----
  private rule(): WinRule {
    const s = this.state!;
    return s.source === "match"
      ? { kind: "target", target: TARGET }
      : { kind: "rounds", rounds: s.totalRounds ?? ROOM_ROUNDS };
  }

  private seatInfos(): SeatInfo[] {
    const s = this.state!;
    return s.seats.map((sk, i) => ({
      name: sk.name,
      rating: s.source === "match" ? sk.rating : null,
      connected: sk.leftAt === null && this.socketsOfSeat(i).length > 0,
      eliminated: sk.eliminated,
    }));
  }

  private scores(): number[] {
    return this.state!.seats.map((sk) => sk.score);
  }

  private quotas(): number[] {
    return this.state!.seats.map((sk) => sk.timeoutQuota);
  }

  // 限制的種類字串（逗號分隔，供歷史/計費紀錄）；無則 null。
  // 預設取目前生效限制；挑戰結算可傳入「被挑戰手當下的限制快照」以如實記錄實際評分依據。
  private restrictionKinds(rs = this.state?.restrictions): string | null {
    if (!rs?.length) return null;
    return rs.map((r) => r.kind).join(",");
  }

  private canChallenge(seat: Seat): boolean {
    const s = this.state!;
    return (
      s.status === "playing" &&
      s.currentPlayer === seat &&
      !!s.lastMove &&
      s.lastMove.player !== seat
    );
  }

  // 歷史紀錄用的 gameId：隨機配對沿用 DO id；好友房用 per 場 sessionId（rematch 各自獨立）
  private recordGameId(): string {
    const s = this.state!;
    return s.source === "room" ? s.sessionId : this.ctx.id.toString();
  }

  // 歷史紀錄的座位標籤：隨機配對維持 p1/p2（相容既有分析）；好友房 s0..sN
  private seatLabel(seat: Seat | null | undefined): string | null {
    if (seat === null || seat === undefined) return null;
    const s = this.state!;
    if (s.source === "match") return seat === 0 ? "p1" : "p2";
    return `s${seat}`;
  }

  private isHostSeat(seat: Seat): boolean {
    const s = this.state!;
    const id = s.seats[seat]?.id;
    return !!id && id === s.hostId;
  }

  // 好友房「有效房主」：原房主若仍在局且連線中就是他；否則退回目前連線中、
  // 座位序號最小的在局者。避免房主中途淘汰／斷線後，沒有任何人能觸發重開一場，
  // 導致房間卡死（其他玩家的 keepalive 讓閒置回收 alarm 永遠續期）。
  private effectiveHostSeat(): Seat | null {
    const s = this.state!;
    const hostSeat = s.seats.findIndex((sk) => !!sk.id && sk.id === s.hostId);
    if (
      hostSeat >= 0 &&
      !s.seats[hostSeat].eliminated &&
      this.socketsOfSeat(hostSeat).length > 0
    ) {
      return hostSeat;
    }
    const fallback = s.seats
      .map((_, i) => i)
      .filter((i) => !s.seats[i].eliminated && this.socketsOfSeat(i).length > 0);
    return fallback.length ? fallback[0] : null;
  }

  // ---- 連線工具 ----
  private attOf(ws: WebSocket): WsAttachment | null {
    try {
      const att = ws.deserializeAttachment() as WsAttachment | null;
      if (!att) return null;
      // 座位若已不存在（等待室名單變動）視為觀戰
      const s = this.state;
      if (att.seat !== undefined && s && att.seat >= s.seats.length) {
        return { ...att, seat: undefined, spec: true };
      }
      return att;
    } catch {
      return null;
    }
  }

  private socketsOfSeat(seat: Seat): WebSocket[] {
    return this.ctx
      .getWebSockets()
      .filter((ws) => this.attOf(ws)?.seat === seat);
  }

  private socketOfSeat(seat: Seat): WebSocket | undefined {
    return this.socketsOfSeat(seat)[0];
  }

  // 等待室名單變動（退出／rematch 重配位）後，依 pid 重寫所有連線的座位標記
  private resyncAttachments() {
    const s = this.state!;
    for (const ws of this.ctx.getWebSockets()) {
      let att: WsAttachment | null = null;
      try {
        att = ws.deserializeAttachment() as WsAttachment | null;
      } catch {
        continue;
      }
      if (!att) continue;
      // pid 一律非空（handleConnect 已擋空 id），故單純以 pid 對應座位即可辨識身分。
      const idx = att.pid ? s.seats.findIndex((sk) => sk.id === att.pid) : -1;
      const next: WsAttachment =
        idx >= 0
          ? { pid: att.pid, name: att.name, seat: idx }
          : { pid: att.pid, name: att.name, spec: true };
      try {
        ws.serializeAttachment(next);
      } catch {
        /* ignore */
      }
    }
  }

  private broadcast(msg: ServerMessage) {
    for (const ws of this.ctx.getWebSockets()) this.sendTo(ws, msg);
  }

  private sendTo(
    ws: WebSocket | { socket: WebSocket } | undefined,
    msg: ServerMessage,
  ) {
    if (!ws) return;
    const sock = "socket" in ws ? ws.socket : ws;
    try {
      sock.send(JSON.stringify(msg));
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

  // 回收房間：清空持久化狀態（含 alarm），DO 可被同房號重用
  private async wipe() {
    this.state = undefined;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}
