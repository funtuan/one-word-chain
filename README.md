# 一字接龍 (One Word Chain)

雙人即時中文一字接龍。輪流在句子中放入單一中文字，任一方可對「對方上一手」發起挑戰，由 AI 裁判評分。先得 **5 分** 者勝，任一方斷線則直接結束。

## 技術架構

- **Cloudflare Workers**：入口 `src/index.ts`，同時服務靜態前端（`public/`）與 API/WebSocket 路由。
- **Durable Objects**：
  - `Lobby`（`src/index.ts`）：全域單一實例，負責隨機配對兩名玩家到同一房間。
  - `Game`（`src/game.ts`）：每房一個實例，以 WebSocket Hibernation API 管理雙方連線、回合狀態、20 秒計時（DO alarm），並在挑戰時呼叫 LLM。
- **OpenRouter**：`openai/gpt-oss-20b:nitro` 進行挑戰結算（`src/llm.ts`）。需設定 `OPENROUTER_API_KEY` 秘密。
- **D1**：`DB` 綁定，儲存玩家帳號與對戰紀錄（`schema.sql`、`src/db.ts`）。

## 帳號與排行榜

- **無需登入**：身分（UUID + 暱稱）記錄在瀏覽器 `localStorage`；首次進入需輸入暱稱（會公開顯示於排行榜與對戰畫面）。
- **對戰紀錄**：每場結束寫入 `matches` 表。
- **ELO 積分**：初始 `1000`，採**動態 K 值 + 前 10 場 placement 定位期**（`src/elo.ts`）：
  - placement（未滿 10 場）：`K=48`，快速定位實力。
  - 之後依分段：`<1200` 用 `K=40`、`1200~2000` 用 `K=32`、`>2000` 用 `K=16`。
  - K 為 per-player，故勝敗雙方變化量可能不對稱（各套用自己的 K）。
  - 每場結束更新雙方積分與勝負場數；對手中途斷線時，留下者判勝並照常結算。
- **排行榜**：`GET /api/leaderboard` 依積分排序；開始畫面「🏆 排行榜」可查看。
- **對戰畫面**：比分與結算改以雙方暱稱顯示（自己一律標示「你」）。

相關 API：`POST /api/register`（upsert 暱稱）、`GET /api/leaderboard`、`GET /api/player?id=`。

### D1 初始化（首次部署前）

```bash
npx wrangler d1 create one-word-chain     # 建立資料庫，將輸出的 database_id 貼到 wrangler.jsonc
npx wrangler d1 execute one-word-chain --remote --file=./schema.sql   # 建表（本地測試改用 --local）
```

## 玩法規則

1. 系統給一個種子字（如「早上」），先手在句中任意位置放入一個字。
2. 輪到你時，20 秒內可「插字」或「挑戰對方上一個字」；超時自動挑戰。
3. 挑戰結算（AI 判定）：
   - **句子合理度 (A)**：現有內容是否合理，同時看「語法通順」與「含義符合常理」（語法通但意思荒謬也算不合理），`-3`（非常不合理）～ `3`（非常合理）。逐字慢慢接、句子不完整屬正常，不因主詞/受詞/語法未完成而扣分。
   - **語助詞程度 (B)**：末字是否為無意義語助詞，`0`（完全不是）～ `3`（完全是）
   - `delta = A − B`。`delta > 0` → 對方（被挑戰方）加 `delta` 分；`delta < 0` → 我方（挑戰者）加 `|delta|` 分；`delta = 0` 不計分。
4. 先累積達 5 分者勝。

> 計分幅度（用 `delta` 大小加分、先到 5 分）是實作預設值，集中在 `src/game.ts` 的 `settle()`，可依需要調整。

## 開發與部署

```bash
npm install
npm run typecheck        # 型別檢查
npm run dev              # 本地開發（http://localhost:8787）
```

⚠️ **本地開發需要 OpenRouter 金鑰**：挑戰結算會呼叫 OpenRouter API，請在專案根目錄建立 `.dev.vars`（已被 `.gitignore` 忽略）：

```
OPENROUTER_API_KEY=sk-or-...
```

未設定金鑰時，挑戰會走「不計分」fallback（仍可測試對戰流程）。

部署：

```bash
npx wrangler secret put OPENROUTER_API_KEY   # 設定正式環境金鑰（僅需一次）
npm run deploy
```

## 手動測試流程

用兩個瀏覽器分頁開啟網址各按「開始配對」即可對戰。
