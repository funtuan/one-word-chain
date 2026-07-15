// 惡魔模式：限制（位置 / 注音 / 詞性 / 意思改變）雙方共用。
// 回合開局先給 1 個限制，單回合內每接 5 個字再累加 1 個，同回合限制種類不重複。
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

// 隨機產生一個限制，其種類不在 exclude 內；可用種類已用盡時回 null。
// 供兩種用途：回合開局挑起始限制（exclude 放上一回合起始種類以求變化）、
// 單回合內累加限制（exclude 放本回合已生效的種類，確保不重複）。
export function pickRestriction(exclude: RestrictionKind[] = []): Restriction | null {
  const pool = KINDS.filter((k) => !exclude.includes(k));
  if (pool.length === 0) return null;
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

// 依「本回合已接入的字數」算出應同時生效的限制數：開局 1 個，每 5 個字 +1，最多不超過種類總數。
// 例：0~4 字 → 1、5~9 字 → 2、10~14 字 → 3、15 字以上 → 4（封頂）。
export function targetRestrictionCount(charsAdded: number): number {
  return Math.min(KINDS.length, 1 + Math.floor(charsAdded / 5));
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
