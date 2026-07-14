// 挑戰結算：使用 OpenRouter (xiaomi/mimo-v2.5) 判斷，固定 provider 為 Xiaomi
//  A: 當前整句話合理與否，-3(非常不合理) 到 3(非常合理)
//  B: 最後放入的字是否為無意義語助詞，0(完全不是) 到 3(完全是)

import type { Restriction } from "./types";
import { ZODIAC_MIN_LEN } from "./devil";

const MODEL = "xiaomi/mimo-v2.5";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
// 固定 provider 為 Xiaomi，不允許 fallback 到其他 provider
const PROVIDER_ROUTING = { order: ["xiaomi"], allow_fallbacks: false };

// OpenRouter 計價（USD / token）— 來源：openrouter.ai/xiaomi/mimo-v2.5
// xiaomi/mimo-v2.5：輸入 $0.105/M、輸出 $0.28/M
const PRICE_IN_PER_TOKEN = 0.105 / 1_000_000;
const PRICE_OUT_PER_TOKEN = 0.28 / 1_000_000;

export interface Judgement {
  A: number;
  B: number;
  reason: string;
  zhuyinMatch?: boolean; // zhuyin 限制：被挑戰字是否符合韻符
  zodiacScore?: number; // zodiac 限制：語氣相符度 -3~3
  posViolation?: boolean; // pos 限制：被挑戰字是否為禁止的詞性（true = 違規）
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
  restriction?: Restriction | null,
): Promise<Judgement & { usage: JudgeUsage }> {
  const chars = Array.from(sentence);
  const zhuyinOn = restriction?.kind === "zhuyin" && !!restriction.finals?.length;
  // 星座限制：僅在句子超過門檻長度時計分
  const zodiacOn =
    restriction?.kind === "zodiac" &&
    !!restriction.zodiac &&
    chars.length > ZODIAC_MIN_LEN;
  const posOn = restriction?.kind === "pos" && !!restriction.pos;

  const jsonFields = ['"A": <整數>', '"B": <整數>', '"reason": "<20字內中文理由>"'];

  const lines = [
    "你是一個嚴謹的中文一字接龍裁判。",
    "玩家輪流在句子中放入單一中文字，另一方可挑戰句子不合理。",
    "請針對「當前整句話」以及「最後被放入的那個字」做兩項評分：",
    "A = 這句話目前的內容是否合理，範圍 -3 到 3 的整數（-3 非常不合理、0 普通、3 非常合理）。",
    "評 A 要同時看兩個層面：(1) 語法是否通順；(2) 含義是否合理、符合常理邏輯。就算語法通順，若字詞搭配後的意思荒謬、矛盾或不符常識（例如「太陽在海裡游泳」），也要判為不合理、給低分。",
    "重要：句子是玩家一次一個字慢慢接出來的，本來就可能還沒接完。請「不要」因為主詞、受詞或語法不完整而扣分，只需判斷現有的字彼此搭配起來，語法與含義是否都合理、說得通。",
    "B = 最後放入的那個字在整句話中是否只是無意義的語助詞（例如 的、了、啊、呢、嗎、吧、喔），範圍 0 到 3 的整數（0 完全不是語助詞、3 完全是無意義語助詞）。",
    "整句話中，最後放入的那個字會被【】包住標示位置。【】本身不是句子內容，判斷語法與含義時請忽略這對符號。",
  ];

  if (zhuyinOn) {
    const finals = restriction!.finals!.join("、");
    lines.push(
      `本回合有「注音韻符限制」：允許的韻符為 ${finals}。`,
      `zhuyinMatch = 判斷「最後放入的那個字」（${lastChar}）的注音韻母（結尾韻符）是否為上述其中之一，是則 true、否則 false（布林值）。`,
    );
    jsonFields.push('"zhuyinMatch": <true 或 false>');
  }
  if (zodiacOn) {
    const z = restriction!.zodiac!;
    lines.push(
      `本回合有「星座語氣限制」：整句話必須像「${z.name}」會講出來的話。${z.name}特質：${z.desc}`,
      `zodiacScore = 判斷當前整句話的語氣、內容有多符合${z.name}的個性，範圍 -3 到 3 的整數（-3 完全不像、0 普通、3 非常像）。`,
    );
    jsonFields.push('"zodiacScore": <整數>');
  }
  if (posOn) {
    const pos = restriction!.pos!;
    lines.push(
      `本回合有「詞性限制」：本回合「禁止」放入詞性為「${pos}」的字。`,
      `posViolation = 判斷「最後放入的那個字」（${lastChar}）在整句話中所扮演的詞性是否為「${pos}」，是（違規）則 true、否則 false（布林值）。請依該字在此句中的實際用法判斷，而非它單獨時可能的詞性。`,
    );
    jsonFields.push('"posViolation": <true 或 false>');
  }

  lines.push(
    "以台灣常見語句用法判斷，回應理由使用繁體中文",
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
      // OpenRouter chat-completions 格式（OpenAI 相容），並固定 provider 為 Xiaomi
      const resp = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          provider: PROVIDER_ROUTING,
          messages: [
            { role: "system", content: instructions },
            { role: "user", content: input },
          ],
          max_tokens: 5000,
          temperature: 0.2,
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
    ? { A: 0, B: 0, reason: "AI 判定失敗，本回合不計分", usage }
    : { A: 0, B: 0, reason: "無法解析 AI 回應，本回合不計分", usage };
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
  const A = clampInt(obj.A, -3, 3);
  const B = clampInt(obj.B, 0, 3);
  if (A === null || B === null) return null;
  const reason =
    typeof obj.reason === "string" ? obj.reason.slice(0, 60) : "";
  const result: Judgement = { A, B, reason };
  if (typeof obj.zhuyinMatch === "boolean") result.zhuyinMatch = obj.zhuyinMatch;
  const zs = clampInt(obj.zodiacScore, -3, 3);
  if (zs !== null && obj.zodiacScore != null) result.zodiacScore = zs;
  if (typeof obj.posViolation === "boolean") result.posViolation = obj.posViolation;
  return result;
}

function clampInt(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.round(n)));
}
