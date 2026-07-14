// 挑戰結算：使用 OpenRouter (openai/gpt-oss-20b) 判斷
//  A: 當前整句話合理與否，-3(非常不合理) 到 3(非常合理)
//  B: 最後放入的字是否為無意義語助詞，0(完全不是) 到 3(完全是)

import type { Restriction } from "./types";

// :nitro 變體：依 throughput 排序 provider，優先選擇最快的服務
const MODEL = "openai/gpt-oss-20b:nitro";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

// OpenRouter 計價（USD / token）— 來源：openrouter.ai/openai/gpt-oss-20b
// openai/gpt-oss-20b：輸入 $0.075/M、輸出 $0.30/M
const PRICE_IN_PER_TOKEN = 0.075 / 1_000_000;
const PRICE_OUT_PER_TOKEN = 0.30 / 1_000_000;

export interface Judgement {
  A: number;
  B: number;
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
  restriction?: Restriction | null,
): Promise<Judgement & { usage: JudgeUsage }> {
  const chars = Array.from(sentence);
  const zhuyinOn = restriction?.kind === "zhuyin" && !!restriction.finals?.length;
  const posOn = restriction?.kind === "pos" && !!restriction.pos;
  const meaningOn = restriction?.kind === "meaning";

  const jsonFields = ['"A": <整數>', '"B": <整數>', '"reason": "<20字內中文理由>"'];

  const lines = [
    "你是一個嚴謹的中文一字接龍裁判。",
    "玩家輪流在句子中放入單一中文字，另一方可挑戰句子不合理。",
    "請針對「當前整句話」以及「最後被放入的那個字」做兩項評分：",
    "A = 這句話目前的內容是否既合理又自然，範圍 -3 到 3 的整數。",
    "評 A 要同時看三個層面，任一層面不佳都要扣分：(1) 語法是否通順；(2) 含義是否合理、符合常理邏輯；(3) 語感是否自然，也就是用詞與搭配是否符合台灣繁體中文母語人士的自然講法。",
    "特別注意第 (3) 點：就算語法沒有明顯錯誤、含義也不算荒謬，只要唸起來拗口、生硬、詞語搭配牽強生造、或不像台灣母語人士自然會講出來的話（例如「街邊好區」這種硬湊、不自然的組合），就要判為不自然而給負分，絕對不可因為「勉強說得通」就給正分或高分。",
    "第 (2) 點：就算語法通順，若字詞搭配後的意思荒謬、矛盾或不符常識（例如「太陽在海裡游泳」），也要判為不合理、給低分。",
    "評分請「從嚴」，寧可扣分也不要輕易給高分，評分基準如下：3 = 通順、自然、意義清楚，明顯是母語人士會自然講出來的話；1 到 2 = 大致通順自然，但略平淡或普通；0 = 中性、難以判斷；-1 到 -2 = 唸起來生硬拗口、搭配牽強、不像母語人士會講的話（例如「街邊好區」）；-3 = 語意荒謬、矛盾或完全不通。",
    "重要：句子是玩家一次一個字慢慢接出來的，本來就可能還沒接完。請「不要」因為主詞、受詞或整句語法尚未接完整而扣分；但詞語彼此之間搭配生硬、不自然，仍要依第 (3) 點照常扣分。",
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
  if (posOn) {
    const pos = restriction!.pos!;
    lines.push(
      `本回合有「詞性限制」：本回合「禁止」放入詞性為「${pos}」的字。`,
      `posViolation = 判斷「最後放入的那個字」（${lastChar}）在整句話中所扮演的詞性是否為「${pos}」，是（違規）則 true、否則 false（布林值）。請依該字在此句中的實際用法判斷，而非它單獨時可能的詞性。`,
    );
    jsonFields.push('"posViolation": <true 或 false>');
  }
  if (meaningOn) {
    lines.push(
      `本回合有「意思改變限制」：每次放入的字都必須讓整句話的含義產生實質改變。`,
      `meaningChanged = 比較「有這個字」與「把最後放入的那個字（${lastChar}）拿掉」兩種情況，判斷整句話的含義是否有實質改變。若拿掉這個字後句意幾乎相同（此字可有可無、沒有帶來新的資訊或改變語意），則為 false（違規）；若這個字確實讓句意產生實質改變，則為 true（布林值）。`,
      `請「從嚴」判斷，並特別注意：結構助詞（的、地、得、之、了、著、過）與純語氣詞（啊、呢、嗎、吧、喔、呀），多半只是讓語法更完整、更通順，本身並不帶來新資訊，此類字原則上判為 false（違規）。`,
      `例如：「我大臣」→「我的大臣」、「他來」→「他來了」、「慢走」→「慢慢走」，拿掉該字後句意幾乎相同，都應判 false（違規）。`,
      `只有當該字明確改變了句子的指涉、數量、否定、時態或轉折等實質語意（例如加「不」變否定、加「三」指定數量、加「昨」改變時間）時，才判為 true。`,
    );
    jsonFields.push('"meaningChanged": <true 或 false>');
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
      // OpenRouter chat-completions 格式（OpenAI 相容）；:nitro 變體自行處理 provider 路由
      const resp = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
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
  if (typeof obj.posViolation === "boolean") result.posViolation = obj.posViolation;
  if (typeof obj.meaningChanged === "boolean") result.meaningChanged = obj.meaningChanged;
  return result;
}

function clampInt(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.round(n)));
}
