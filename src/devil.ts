// 惡魔模式：每回合隨機抽選一個限制（位置 / 注音 / 詞性 / 意思改變），雙方共用。
// 見 plan/v1.md。

import type { PosCategory, Restriction, RestrictionKind } from "./types";

// 注音韻符（韻母）候選：每回合隨機抽 3 個
export const ZHUYIN_FINALS = [
  "ㄚ", "ㄛ", "ㄜ", "ㄝ", "ㄞ", "ㄟ",
  "ㄠ", "ㄡ", "ㄢ", "ㄣ", "ㄤ", "ㄥ",
];

// 詞性限制候選：每回合隨機禁止其中一種詞性
export const POS_CATEGORIES: PosCategory[] = ["名詞", "動詞", "形容詞"];

export const KINDS: RestrictionKind[] = ["position", "zhuyin", "pos", "meaning"];

// 隨機為一回合產生限制；優先挑選前面回合尚未出現過的種類（used 已用過的種類），
// 三種都出現過後由呼叫端重置循環。
export function pickRestriction(used: RestrictionKind[] = []): Restriction {
  let pool = KINDS.filter((k) => !used.includes(k));
  if (pool.length === 0) pool = KINDS;
  const kind = pool[Math.floor(Math.random() * pool.length)];
  if (kind === "zhuyin") {
    return { kind, finals: sample(ZHUYIN_FINALS, 3) };
  }
  if (kind === "pos") {
    const pos = POS_CATEGORIES[Math.floor(Math.random() * POS_CATEGORIES.length)];
    return { kind, pos };
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
