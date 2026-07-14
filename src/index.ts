import { Game } from "./game";
import { getLeaderboard, getPlayer, registerPlayer } from "./db";

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
  constructor(ctx: DurableObjectState) {
    this.ctx = ctx;
  }

  async fetch(_request: Request): Promise<Response> {
    const WAIT_TTL = 30_000;
    const waiting = await this.ctx.storage.get<{ gameId: string; ts: number }>(
      "waiting",
    );

    if (waiting && Date.now() - waiting.ts < WAIT_TTL) {
      // 有人在等 -> 配對，清掉等待狀態
      await this.ctx.storage.delete("waiting");
      return Response.json({ gameId: waiting.gameId });
    }

    // 沒人等（或已過期）-> 建立新房，開始等待
    const gameId = crypto.randomUUID();
    await this.ctx.storage.put("waiting", { gameId, ts: Date.now() });
    return Response.json({ gameId });
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
      return Response.json({ players });
    }

    // 個人戰績
    if (url.pathname === "/api/player") {
      const id = url.searchParams.get("id") ?? "";
      if (!id) return Response.json({ error: "id required" }, { status: 400 });
      const player = await getPlayer(env.DB, id);
      return Response.json({ player });
    }

    // 配對（依模式分開排隊，惡魔模式只與惡魔模式配對）
    if (url.pathname === "/api/matchmake") {
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
