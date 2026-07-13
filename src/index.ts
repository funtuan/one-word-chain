import { Game } from "./game";

export { Game };

interface Env {
  LOBBY: DurableObjectNamespace;
  GAME: DurableObjectNamespace;
  AI: Ai;
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

    // 配對
    if (url.pathname === "/api/matchmake") {
      const id = env.LOBBY.idFromName("global");
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
