# 一字接龍 (One Word Chain)

即時中文一字接龍。輪流在句子中放入單一中文字，可對「上一位玩家的那一手」發起挑戰，由 AI 裁判評分。

- **隨機配對**（2 人）：先得 **5 分** 者勝，計 ELO；任一方斷線則直接結束。
- **好友房**（v3，2~6 人）：開房拿 6 碼房號／邀請連結，好友點連結加入，房主按開始。固定 **5 回合**打完看總分排名；不計 ELO。支援觀戰（滿員／開局後點連結進入）、斷線 30 秒重連寬限、同房「再來一場」（紀錄各自獨立）。

## 技術架構

- **Cloudflare Workers**：入口 `src/index.ts`，同時服務靜態前端（`public/`）與 API/WebSocket 路由。
- **Durable Objects**：
  - `Lobby`（`src/index.ts`）：全域單一實例，負責隨機配對兩名玩家到同一房間。
  - `Game`（`src/game.ts`）：每房一個實例（好友房以 `room:房號` 為 DO name），以 WebSocket Hibernation API 管理各座位連線與觀戰者、回合狀態、20 秒計時與房間閒置回收（DO alarm），並在挑戰時呼叫 LLM。好友房等待室狀態也在此 DO，無獨立 Room DO。
- **OpenRouter**：`openai/gpt-oss-20b` 進行挑戰結算，並透過 `provider` 欄位指定走最便宜的 Weights & Biases（WandB）服務（`src/llm.ts`）。需設定 `OPENROUTER_API_KEY` 秘密。
- **D1**：`DB` 綁定，儲存玩家帳號、對戰紀錄與**遊玩歷史事件**（`schema.sql`、`src/db.ts`）。

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

相關 API：`POST /api/register`（upsert 暱稱）、`GET /api/leaderboard`、`GET /api/player?id=`、`POST /api/room`（建好友房，回 6 碼房號）、`GET /api/room/info?code=`（加入前查房間模式／人數／狀態）。

> **好友房不計 ELO、不計勝敗場**（避免互刷），僅寫入 `room_matches` / `room_match_players` 供分析。

### D1 初始化（首次部署前）

```bash
npx wrangler d1 create one-word-chain     # 建立資料庫，將輸出的 database_id 貼到 wrangler.jsonc
npx wrangler d1 execute one-word-chain --remote --file=./schema.sql   # 建表（本地測試改用 --local）
```

### 遊玩歷史（供日後分析）

每場遊戲的關鍵動作皆寫入 `game_events` 表（append-only 事件流，見 `schema.sql`）：

- `round_start` 回合開始（種子詞、先手、惡魔限制）
- `move` 每次接龍（放入的字與位置）
- `challenge` 挑戰結算（AI 評分 A/B、得分方、違規種類、理由）
- `timeout_extend` 超時但用掉額度 +10 秒（不計分）／ `timeout` 超時無額度，對方 +3
- `leave` 有人離開／斷線判勝 ／ `game_over` 整場結束

以 `game_id`（= Game DO id）串連整場；`matches` 亦新增 `game_id` 可 join 摘要。事件寫入採 `ctx.waitUntil` 非阻塞、失敗不影響對局。**既有資料庫**（已建過 `matches`）需跑一次性遷移補上新表與欄位：

```bash
npx wrangler d1 execute one-word-chain --remote --file=./migrations/0001_game_history.sql
npx wrangler d1 execute one-word-chain --remote --file=./migrations/0002_friend_rooms.sql  # v3 好友房
```

好友房事件同樣寫入 `game_events`：`source='room'`、`game_id` 為該場 sessionId（同房 rematch 各自成場）、`actor` 為 `s0..sN`、`scores` 欄存全座位比分 JSON。

常用分析查詢範例：

```sql
-- 各違規種類出現次數
SELECT violation, COUNT(*) FROM game_events WHERE type='challenge' AND violation IS NOT NULL GROUP BY violation;
-- 每場平均接龍步數
SELECT AVG(moves) FROM (SELECT game_id, COUNT(*) moves FROM game_events WHERE type='move' GROUP BY game_id);
-- 結束原因分布（達標 / 超時 / 離開）
SELECT type, COUNT(*) FROM game_events WHERE type IN ('game_over','timeout','leave') GROUP BY type;
```

## 玩法規則

1. 系統給一個種子字（如「早上」），先手在句中任意位置放入一個字。
2. 輪到你時，20 秒內可「放入一字」或「挑戰對方上一個字」；超時自動挑戰。
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

## 戰況數據後台（隱藏頁）

管理員專用的數據報表，位於未對外連結的隱藏路徑 **`/admin`**，需輸入密碼才能查看：

- 總覽卡片：累計對戰、近 24 小時／7 天場數、活躍與新增玩家、模式分布、AI 花費。
- 走勢圖：每日對戰場數、每日活躍／新增玩家人數（可切換近 7／14／30／90 天）。
- 最近對戰列表：比分、勝方、模式、回合數、時長、積分變化。

資料一律經後端 `/api/admin/*` 以密碼授權（常數時間比對），前端頁面本身不含任何資料。

密碼設定（Worker secret，未設定時後台停用並回 `503`）：

```bash
npx wrangler secret put ADMIN_PASSWORD       # 設定正式環境後台密碼
```

本機開發時於 `.dev.vars` 加入 `ADMIN_PASSWORD=<你的密碼>` 即可（預設範例為 `devadmin`）。

## 手動測試流程

用兩個瀏覽器分頁開啟網址各按「開始配對」即可對戰。
