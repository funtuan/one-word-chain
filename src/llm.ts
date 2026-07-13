// 質疑結算：使用 Workers AI (@cf/openai/gpt-oss-120b) 判斷
//  A: 當前整句話合理與否，-3(非常不合理) 到 3(非常合理)
//  B: 最後插入的字是否為無意義語助詞，0(完全不是) 到 3(完全是)

const MODEL = "@cf/openai/gpt-oss-120b";

export interface Judgement {
  A: number;
  B: number;
  reason: string;
}

export async function judge(
  ai: Ai,
  sentence: string,
  lastChar: string,
  lastIndex: number,
): Promise<Judgement> {
  const instructions = [
    "你是一個嚴謹的中文一字接龍裁判。",
    "玩家輪流在句子中插入單一中文字，另一方可質疑句子不合理。",
    "請針對「當前整句話」以及「最後被插入的那個字」做兩項評分：",
    "A = 這句話目前的內容是否合理，範圍 -3 到 3 的整數（-3 非常不合理、0 普通、3 非常合理）。",
    "評 A 要同時看兩個層面：(1) 語法是否通順；(2) 含義是否合理、符合常理邏輯。就算語法通順，若字詞搭配後的意思荒謬、矛盾或不符常識（例如「太陽在海裡游泳」），也要判為不合理、給低分。",
    "重要：句子是玩家一次一個字慢慢接出來的，本來就可能還沒接完。請「不要」因為主詞、受詞或語法不完整而扣分，只需判斷現有的字彼此搭配起來，語法與含義是否都合理、說得通。",
    "B = 最後插入的那個字在整句話中是否只是無意義的語助詞（例如 的、了、啊、呢、嗎、吧、喔），範圍 0 到 3 的整數（0 完全不是語助詞、3 完全是無意義語助詞）。",
    "整句話中，最後插入的那個字會被【】包住標示位置。【】本身不是句子內容，判斷語法與含義時請忽略這對符號。",
    '只回傳 JSON，格式為 {"A": <整數>, "B": <整數>, "reason": "<20字內中文理由>"}，不要有其他文字。',
  ].join("\n");

  const chars = Array.from(sentence);
  const markedSentence = chars
    .map((ch, i) => (i === lastIndex ? `【${ch}】` : ch))
    .join("");

  const input = `整句話：「${markedSentence}」\n最後插入的字：「${lastChar}」`;

  let text = "";
  try {
    const res: any = await ai.run(MODEL as any, {
      instructions,
      input,
      max_tokens: 5000,
      temperature: 0.2,
    } as any);
    text = extractText(res);
  } catch (err) {
    // AI 呼叫失敗 -> 中性判定（不計分）
    return { A: 0, B: 0, reason: "AI 判定失敗，本回合不計分" };
  }

  const parsed = parseJudgement(text);
  return parsed ?? { A: 0, B: 0, reason: "無法解析 AI 回應，本回合不計分" };
}

function extractText(res: any): string {
  if (!res) return "";
  if (typeof res === "string") return res;
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
  return { A, B, reason };
}

function clampInt(v: unknown, min: number, max: number): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.max(min, Math.min(max, Math.round(n)));
}
