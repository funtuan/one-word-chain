// 挑戰結算：使用 OpenRouter (openai/gpt-oss-120b) 判斷
//  sentenceScore: 剛接上的那個字放進句子後合理與否，-3(非常不合理) 到 3(非常合理)
//    無意義的湊字／填充語助詞會透過「拿掉測試」在此拿到負分，不再另設獨立的語助詞判定。

import type { Restriction } from "./types";

const MODEL = "openai/gpt-oss-120b";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// 固定用 Cerebras 跑 gpt-oss-120b（推論速度快、品質穩定）。
// allow_fallbacks:false → 只走 Cerebras，不可用時整個請求失敗，
// 交由上層重試 / 不計分邏輯處理，絕不悄悄退到其他品質不一的 provider。
const PROVIDER = {
  order: ["cerebras"],
  allow_fallbacks: false,
};

// OpenRouter 計價（USD / token）— gpt-oss-120b 便宜 provider 的估值：輸入 $0.05/M、輸出 $0.45/M。
// ⚠️ 這是估算值，只影響 ai_costs 花費統計、不影響對局；請依實際帳單／provider 頁面校正。
const PRICE_IN_PER_TOKEN = 0.05 / 1_000_000;
const PRICE_OUT_PER_TOKEN = 0.45 / 1_000_000;

export interface Judgement {
  sentenceScore: number; // 剛接上的字放進句子後的合理自然度 -3~3
  reason: string;
  zhuyinMatch?: boolean; // zhuyin 限制：被挑戰字是否符合韻符
  posViolation?: boolean; // pos 限制：被挑戰字是否為禁止的詞性（true = 違規）
  meaningChanged?: boolean; // meaning 限制：被挑戰字是否造成句意改變（false = 違規）
}

// 單次挑戰的模型用量與花費（累計同一次挑戰內的所有重試）
export interface JudgeUsage {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  attempts: number; // 實際呼叫 OpenRouter 的次數
  ok: boolean; // 是否成功取得可解析結果
}

function buildUsage(
  promptTokens: number,
  completionTokens: number,
  attempts: number,
  ok: boolean,
): JudgeUsage {
  const costUsd =
    promptTokens * PRICE_IN_PER_TOKEN + completionTokens * PRICE_OUT_PER_TOKEN;
  return {
    model: MODEL,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    costUsd,
    attempts,
    ok,
  };
}

export async function judge(
  apiKey: string,
  sentence: string,
  lastChar: string,
  lastIndex: number,
  restrictions: Restriction[] = [],
): Promise<Judgement & { usage: JudgeUsage }> {
  const chars = Array.from(sentence);
  // 同回合種類不重複，故每種至多一個；多個限制可同時生效。
  const zhuyinR = restrictions.find((r) => r.kind === "zhuyin");
  const posR = restrictions.find((r) => r.kind === "pos");
  const zhuyinOn = !!zhuyinR?.finals?.length;
  const posOn = !!posR?.pos;
  const meaningOn = restrictions.some((r) => r.kind === "meaning");

  const jsonFields = [
    '"sentenceScore": <-3 到 3 的整數>',
    '"reason": "<20 字內中文理由>"',
  ];

  const lines = [
    "你是嚴謹的台灣繁體中文「一字接龍」裁判。玩家輪流在句子裡接上一個字，對手可挑戰句子不合理，由你裁定。",
    "句子是一個字一個字慢慢接出來的，可能還沒接完；不要因為主詞、受詞或整句還沒完整就扣分。這次剛接上、要評判的那個字會用【】標出，那正是評分的重點；【】符號本身不算句子內容，判斷時忽略符號，但要針對它框住的字評分。",
    "【句子評分 sentenceScore】評分焦點是「剛接上、用【】標出的那個字」：把它加進來之後，這個字放在這個位置合不合理、自不自然，給 -3 到 3 的整數。不是只看整句大致讀不讀得懂，而是看這個新字有沒有讓句子更通順到位，還是多餘、牽強、硬湊。針對這個新字四點同時看，任一點差就扣分：",
    "　一、語法上這個字接在這個位置通不通順。",
    "　二、加上這個字後意思是否合理、符合常理（例如「太陽在海裡【游】泳」意思荒謬，要扣分）。",
    "　三、語感是否自然：母語人士會不會這樣接？就算語法沒錯、這個字字面上也有意思，只要接上後唸起來拗口、生硬，或跟前後搭配牽強、像硬湊出來的詞（不是台灣人平常會講的組合），就算不自然，要扣分。",
    "　四、這個字有沒有實質貢獻：用「拿掉測試」判斷——把這個字從句子拿掉，如果整句的意思和語氣幾乎沒變，代表它可有可無、只是湊字，要往負分給；如果拿掉後句子明顯少了意思或語氣，代表它有貢獻。這是通則，適用任何情形，不必特別針對某類字。",
    "請從嚴評分，重點是「這個新接的字」而非整句籠統印象，不要因為整句『勉強說得通』就給高分。基準：3＝這個字接得漂亮、通順自然、意思清楚，明顯是母語人士會這樣接；1 到 2＝接得還行但平淡；0＝中性、難判斷；-1 到 -2＝這個字生硬拗口、多餘或搭配牽強；-3＝加上後意思荒謬、矛盾或完全不通。",
    "語助詞、語氣詞（的、了、啊、呢、嗎、吧、喔…）也用同一套拿掉測試判斷，不要因為它長得像語助詞就扣分：只要它在這句話裡確實帶出語氣、情緒或改變意思（拿掉後語氣或意思會變），就算有貢獻、給正分，例如「你吃飽沒【啊】」「【啊】你要去嗎」的啊帶出口語或招呼語氣；只有當它純粹是可有可無的填充、拿掉後語氣和意思幾乎不變時，才算湊字、給負分。",
    "評分範例（只示範標準，別照抄理由）：「我今天很【開】心」——拿掉「開」就不成詞、意思大變，有貢獻，判 3；「他【幫】幫忙」——「幫幫忙」比「幫忙」更口語委婉、拿掉語氣就變，有貢獻，判 2；反之，若某個字拿掉後整句意思、語氣完全一樣，只是重複或填充來拖長字數，判 -2。",
  ];

  if (zhuyinOn) {
    const finals = zhuyinR!.finals!.join("、");
    lines.push(
      `【注音限制 zhuyinMatch】本回合只允許韻母（結尾韻符）是 ${finals} 的字。判斷最後接上的字「${lastChar}」的注音韻母是不是上述其中之一，是就 true、不是就 false。`,
    );
    jsonFields.push('"zhuyinMatch": <true 或 false>');
  }
  if (posOn) {
    const pos = posR!.pos!;
    lines.push(
      `【詞性限制 posViolation】本回合禁止接上詞性為「${pos}」的字。依「${lastChar}」在這句話裡的實際用法（不是它單獨時的詞性）判斷它是不是「${pos}」，是（代表違規）就 true、否則 false。`,
    );
    jsonFields.push('"posViolation": <true 或 false>');
  }
  if (meaningOn) {
    lines.push(
      `【語意限制 meaningChanged】本回合每接一個字都必須讓整句話的意思產生實質改變。比較「有這個字」和「拿掉最後接上的字（${lastChar}）」兩種情況：若拿掉後意思幾乎一樣（這個字可有可無、沒帶來新資訊），判 false（代表違規）；若確實改變了意思，判 true。`,
      `請從嚴判斷。結構助詞（的、地、得、之、了、著、過）和純語氣詞（啊、呢、嗎、吧、喔、呀）多半只是讓語法更完整，本身不帶新資訊，原則上判 false，例如「我大臣→我的大臣」「他來→他來了」「慢走→慢慢走」拿掉後意思幾乎一樣。只有當這個字明確改變了指涉、數量、否定、時態或轉折等實質意思（例如加「不」變否定、加「三」指定數量、加「昨」改變時間），才判 true。`,
    );
    jsonFields.push('"meaningChanged": <true 或 false>');
  }

  lines.push(
    "全部以台灣日常用法判斷，理由用繁體中文、20 字以內。",
    `只回傳 JSON，格式為 {${jsonFields.join("、")}}，不要有其他文字。`,
  );
  const instructions = lines.join("\n");

  const markedSentence = chars
    .map((ch, i) => (i === lastIndex ? `【${ch}】` : ch))
    .join("");

  const input = `整句話：「${markedSentence}」\n最後放入的字：「${lastChar}」`;

  const MAX_ATTEMPTS = 3;
  let lastError = false;
  // 跨重試累計：同一次挑戰可能呼叫模型多次，每次都要計費
  let promptTokens = 0;
  let completionTokens = 0;
  let attempts = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let text = "";
    attempts++;
    try {
      // OpenRouter chat-completions 格式（OpenAI 相容）；provider 欄位指定只走 Cerebras
      const resp = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          provider: PROVIDER,
          messages: [
            { role: "system", content: instructions },
            { role: "user", content: input },
          ],
          max_tokens: 5000,
          temperature: 0, // 判分求一致，關掉取樣隨機性
        }),
      });
      if (!resp.ok) {
        // 非 2xx：視為失敗並重試（此次未計費）
        lastError = true;
        continue;
      }
      const res: any = await resp.json();
      const u = extractUsage(res);
      promptTokens += u.prompt;
      completionTokens += u.completion;
      text = extractText(res);
      lastError = false;
    } catch (err) {
      // AI 呼叫失敗，重試（此次通常未計費，token 以 0 計）
      lastError = true;
      continue;
    }

    const parsed = parseJudgement(text);
    if (parsed) {
      return {
        ...parsed,
        usage: buildUsage(promptTokens, completionTokens, attempts, true),
      };
    }
    // 無法解析，重試
  }

  // 三次都失敗 -> 中性判定（不計分），但仍回報已產生的花費
  const usage = buildUsage(promptTokens, completionTokens, attempts, false);
  return lastError
    ? { sentenceScore: 0, reason: "AI 判定失敗，本回合不計分", usage }
    : { sentenceScore: 0, reason: "無法解析 AI 回應，本回合不計分", usage };
}

// 從回應取出 token 用量（相容 Chat Completions 與 Responses 兩種欄位命名）
function extractUsage(res: any): { prompt: number; completion: number } {
  const u = res?.usage ?? res ?? {};
  const prompt = numOr0(u.prompt_tokens, u.input_tokens);
  const completion = numOr0(u.completion_tokens, u.output_tokens);
  return { prompt, completion };
}

function numOr0(...vals: unknown[]): number {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return 0;
}

function extractText(res: any): string {
  if (!res) return "";
  if (typeof res === "string") return res;
  // Chat Completions 風格：choices[0].message.content
  const choice = res.choices?.[0]?.message?.content;
  if (typeof choice === "string" && choice) return choice;
  if (typeof res.response === "string") return res.response;
  // Responses API 風格：output 陣列
  if (Array.isArray(res.output)) {
    const parts: string[] = [];
    for (const item of res.output) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (typeof c?.text === "string") parts.push(c.text);
        }
      } else if (typeof content === "string") {
        parts.push(content);
      }
    }
    if (parts.length) return parts.join("\n");
  }
  if (typeof res.result === "string") return res.result;
  return JSON.stringify(res);
}

function parseJudgement(text: string): Judgement | null {
  if (!text) return null;
  // 取出第一個 {...} JSON 物件（容忍 ```json 圍欄與前後文字）
  const match = text.match(/\{[\s\S]*\}/);
  const raw = match ? match[0] : text;
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    return null;
  }
  const sentenceScore = clampInt(obj.sentenceScore, -3, 3);
  if (sentenceScore === null) return null;
  const reason =
    typeof obj.reason === "string" ? obj.reason.slice(0, 60) : "";
  const result: Judgement = { sentenceScore, reason };
  if (typeof obj.zhuyinMatch === "boolean") result.zhuyinMatch = obj.zhuyinMatch;
  if (typeof obj.posViolation === "boolean") result.posViolation = obj.posViolation;
  if (typeof obj.meaningChanged === "boolean") result.meaningChanged = obj.meaningChanged;
  return result;
}

function clampInt(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.round(n)));
}
