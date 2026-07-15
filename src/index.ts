import { Game } from "./game";
import {
  getLeaderboard,
  getPlayer,
  getPlayerRank,
  registerPlayer,
} from "./db";
import type { PlayerStats } from "./types";

export { Game };

interface Env {
  LOBBY: DurableObjectNamespace;
  GAME: DurableObjectNamespace;
  OPENROUTER_API_KEY: string;
  DB: D1Database;
  ASSETS: Fetcher;
}

// ---- 配對用 Durable Object（單一全域實例）----
export class Lobby {
  private ctx: DurableObjectState;
  private env: Env;
  // 房主剛拿到 gameId、WS 還沒接上前的寬限期：這段時間內視為存活，
  // 避免因連線時序把正要進房的房主誤判為死房。
  private static readonly CONNECT_GRACE_MS = 5_000;
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const waiting = await this.ctx.storage.get<{ gameId: string; ts: number }>(
      "waiting",
    );

    // 取消配對：玩家在配對畫面按「取消」時清掉自己建立的等待房，
    // 避免下一位配對者被丟進一個已被放棄的空房而永遠等不到人。
    if (url.pathname === "/api/cancel") {
      const gameId = url.searchParams.get("gameId");
      if (waiting && gameId && waiting.gameId === gameId) {
        await this.ctx.storage.delete("waiting");
      }
      return Response.json({ ok: true });
    }

    // 有人在等 -> 先確認房主仍在線（或仍在連線寬限期內）才配對。
    // 改用存活檢查而非固定 TTL：只要房主還乖乖等著，等再久也配得到；
    // 房主已放棄（關頁）則立即判死、改開新房，兩種情況都能正確處理。
    if (
      waiting &&
      (Date.now() - waiting.ts < Lobby.CONNECT_GRACE_MS ||
        (await this.isRoomAlive(waiting.gameId)))
    ) {
      await this.ctx.storage.delete("waiting");
      return Response.json({ gameId: waiting.gameId });
    }

    // 沒人等（或等待房已死）-> 建立新房，開始等待
    const gameId = crypto.randomUUID();
    await this.ctx.storage.put("waiting", { gameId, ts: Date.now() });
    return Response.json({ gameId });
  }

  // 詢問對應的 Game DO：房主 WS 是否仍連著且此房尚可加入。
  private async isRoomAlive(gameId: string): Promise<boolean> {
    try {
      const stub = this.env.GAME.get(this.env.GAME.idFromName(gameId));
      const res = await stub.fetch(`https://lobby.internal/game/${gameId}/alive`);
      if (!res.ok) return false;
      const { alive } = (await res.json()) as { alive?: boolean };
      return alive === true;
    } catch {
      return false;
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 註冊／更新玩家名稱（無需登入，client 帶 localStorage 的 UUID）
    if (url.pathname === "/api/register" && request.method === "POST") {
      let body: { id?: unknown; name?: unknown };
      try {
        body = (await request.json()) as typeof body;
      } catch {
        return Response.json({ error: "invalid body" }, { status: 400 });
      }
      const id = typeof body.id === "string" ? body.id.slice(0, 64) : "";
      const name =
        typeof body.name === "string" ? body.name.trim().slice(0, 20) : "";
      if (!id || !name) {
        return Response.json({ error: "id and name required" }, { status: 400 });
      }
      const player = await registerPlayer(env.DB, id, name, Date.now());
      return Response.json(player);
    }

    // 排行榜：rating 前幾名
    if (url.pathname === "/api/leaderboard") {
      const limit = Math.min(
        50,
        Math.max(1, Number(url.searchParams.get("limit")) || 20),
      );
      const players = await getLeaderboard(env.DB, limit);
      // 附帶請求者自己的名次（供榜單底部顯示，不論是否在前段）
      const id = url.searchParams.get("id") ?? "";
      let me: (PlayerStats & { rank: number }) | null = null;
      if (id) {
        const r = await getPlayerRank(env.DB, id);
        if (r) me = { rank: r.rank, ...r.player };
      }
      return Response.json({ players, me });
    }

    // 個人戰績
    if (url.pathname === "/api/player") {
      const id = url.searchParams.get("id") ?? "";
      if (!id) return Response.json({ error: "id required" }, { status: 400 });
      const player = await getPlayer(env.DB, id);
      return Response.json({ player });
    }

    // 配對／取消配對（依模式分開排隊，惡魔模式只與惡魔模式配對）
    if (url.pathname === "/api/matchmake" || url.pathname === "/api/cancel") {
      const mode = url.searchParams.get("mode") === "devil" ? "devil" : "normal";
      const id = env.LOBBY.idFromName(`lobby:${mode}`);
      const stub = env.LOBBY.get(id);
      return stub.fetch(request);
    }

    // 對戰 WebSocket： /game/:id/ws
    const m = url.pathname.match(/^\/game\/([^/]+)\/ws$/);
    if (m) {
      const gameId = m[1];
      const id = env.GAME.idFromName(gameId);
      const stub = env.GAME.get(id);
      return stub.fetch(request);
    }

    // 其他 -> 靜態前端
    return env.ASSETS.fetch(request);
  },
};
