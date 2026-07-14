// 惡魔模式：每回合隨機抽選一個限制（位置 / 注音 / 星座），雙方共用。
// 見 plan/v1.md。

import type { Restriction, RestrictionKind } from "./types";

// 注音韻符（韻母）候選：每回合隨機抽 3 個
export const ZHUYIN_FINALS = [
  "ㄚ", "ㄛ", "ㄜ", "ㄝ", "ㄞ", "ㄟ",
  "ㄠ", "ㄡ", "ㄢ", "ㄣ", "ㄤ", "ㄥ",
];

// 12 星座個性描述（供顯示與 AI 判斷語氣是否相符）
export const ZODIACS: { name: string; desc: string }[] = [
  { name: "牡羊座", desc: "具備強烈的開創精神與行動力。喜歡挑戰、不服輸，個性直接像個單純的孩子，但也容易因為衝動而缺乏耐性。" },
  { name: "獅子座", desc: "天生自信、慷慨且具有王者風範。喜歡成為眾人焦點，富有領導魅力與責任感，但有時會有些愛面子。" },
  { name: "射手座", desc: "熱愛自由、熱愛冒險與探索。樂觀開朗、思想開放，對世界充滿好奇心，有時會顯得三分鐘熱度或說話太直。" },
  { name: "金牛座", desc: "腳踏實地、重視感官享受與生活品質。個性溫和但固執，對理財和穩定感有強烈追求。" },
  { name: "處女座", desc: "完美主義者，觀察力敏銳且注重細節。做事有條理、具備分析能力，對自己和他人要求較高。" },
  { name: "魔羯座", desc: "務實、有野心且極具耐心。是典型的實幹家，以目標為導向，雖然給人嚴肅的印象，但非常可靠。" },
  { name: "雙子座", desc: "適應力強、思維靈活且充滿好奇心。能言善道、擅長社交，喜愛吸收新資訊，但有時容易三心二意。" },
  { name: "天秤座", desc: "追求公平、和諧與美感。擅長溝通協調，是團隊中的人際關係潤滑劑，但面臨選擇時容易猶豫不決。" },
  { name: "水瓶座", desc: "思想獨立、創新且充滿人道精神。想法常常不按牌理出牌，重視心靈契合與個人空間。" },
  { name: "巨蟹座", desc: "情感豐富、重視家庭與安全感。同理心強、善於照顧人，但內心敏感，擁有堅硬的外殼來保護自己。" },
  { name: "天蠍座", desc: "神秘、專情且洞察力極強。對目標有強烈的執著與決斷力，愛恨分明，有時佔有慾較強。" },
  { name: "雙魚座", desc: "浪漫、感性且極具想像力。富有同情心，直覺敏銳，容易為了愛與夢想犧牲奉獻，有時會過度沉溺於幻想中。" },
];

// 星座限制的生效門檻：句子超過此長度時才計分
export const ZODIAC_MIN_LEN = 5;

export const KINDS: RestrictionKind[] = ["position", "zhuyin", "zodiac"];

// 隨機為一回合產生限制；優先挑選前面回合尚未出現過的種類（used 已用過的種類），
// 三種都出現過後由呼叫端重置循環。
export function pickRestriction(used: RestrictionKind[] = []): Restriction {
  let pool = KINDS.filter((k) => !used.includes(k));
  if (pool.length === 0) pool = KINDS;
  const kind = pool[Math.floor(Math.random() * pool.length)];
  if (kind === "zhuyin") {
    return { kind, finals: sample(ZHUYIN_FINALS, 3) };
  }
  if (kind === "zodiac") {
    const z = ZODIACS[Math.floor(Math.random() * ZODIACS.length)];
    return { kind, zodiac: z };
  }
  return { kind };
}

// 位置限制：目前句長對應可作答的位置數（句長+1），保留一半、最多 5 個。
// 例：3 個位置留 2、6 個留 3、13 個留 5。
export function computeAllowedPositions(sentenceLength: number): number[] {
  const total = sentenceLength + 1;
  const keep = Math.min(5, Math.ceil(total / 2));
  const all = Array.from({ length: total }, (_, i) => i);
  return sample(all, keep).sort((a, b) => a - b);
}

// 從陣列中不重複隨機抽 n 個
function sample<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  const k = Math.min(n, copy.length);
  for (let i = 0; i < k; i++) {
    const idx = Math.floor(Math.random() * copy.length);
    out.push(copy.splice(idx, 1)[0]);
  }
  return out;
}
