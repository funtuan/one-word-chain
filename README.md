# 一字接龍 (One Word Chain)

雙人即時中文一字接龍。輪流在句子中放入單一中文字，任一方可對「對方上一手」發起質疑，由 AI 裁判評分。先得 **5 分** 者勝，任一方斷線則直接結束。

## 技術架構

- **Cloudflare Workers**：入口 `src/index.ts`，同時服務靜態前端（`public/`）與 API/WebSocket 路由。
- **Durable Objects**：
  - `Lobby`（`src/index.ts`）：全域單一實例，負責隨機配對兩名玩家到同一房間。
  - `Game`（`src/game.ts`）：每房一個實例，以 WebSocket Hibernation API 管理雙方連線、回合狀態、20 秒計時（DO alarm），並在質疑時呼叫 LLM。
- **Workers AI**：`@cf/openai/gpt-oss-120b` 進行質疑結算（`src/llm.ts`）。

## 玩法規則

1. 系統給一個種子字（如「早上」），先手在句中任意位置放入一個字。
2. 輪到你時，20 秒內可「插字」或「質疑對方上一個字」；超時自動質疑。
3. 質疑結算（AI 判定）：
   - **句子合理度 (A)**：現有內容是否合理，同時看「語法通順」與「含義符合常理」（語法通但意思荒謬也算不合理），`-3`（非常不合理）～ `3`（非常合理）。逐字慢慢接、句子不完整屬正常，不因主詞/受詞/語法未完成而扣分。
   - **語助詞程度 (B)**：末字是否為無意義語助詞，`0`（完全不是）～ `3`（完全是）
   - `delta = A − B`。`delta > 0` → 對方（被質疑方）加 `delta` 分；`delta < 0` → 我方（質疑者）加 `|delta|` 分；`delta = 0` 不計分。
4. 先累積達 5 分者勝。

> 計分幅度（用 `delta` 大小加分、先到 5 分）是實作預設值，集中在 `src/game.ts` 的 `settle()`，可依需要調整。

## 開發與部署

```bash
npm install
npm run typecheck        # 型別檢查
npm run dev              # 本地開發（http://localhost:8787）
```

⚠️ **本地開發的 AI 限制**：`wrangler dev`（純 local）不支援 AI 綁定，質疑一律走「不計分」fallback，適合測試對戰流程。要實測 AI 評分需登入 Cloudflare 後使用：

```bash
npx wrangler login
npx wrangler dev --remote   # AI 綁定連到真實 Workers AI
```

部署：

```bash
npm run deploy
```

## 手動測試流程

用兩個瀏覽器分頁開啟網址各按「開始配對」即可對戰。
