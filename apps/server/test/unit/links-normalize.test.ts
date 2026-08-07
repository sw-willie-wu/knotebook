import { describe, it, expect } from "vitest";
import { MAX_LINK_TARGETS } from "@knotebook/shared";
import { normalizeLinkTargets } from "../../src/notes/links.js";

const SOURCE = "00000000-0000-0000-0000-000000000000";

function uuidAt(n: number): string {
  return `00000000-0000-0000-0000-${n.toString().padStart(12, "0")}`;
}

describe("normalizeLinkTargets", () => {
  it("去重：同一 target 重複出現多次只算一個", () => {
    const t1 = uuidAt(1);
    const result = normalizeLinkTargets(SOURCE, [t1, t1, t1]);
    expect(result).toEqual({ ok: true, targets: [t1] });
  });

  it("濾除 self-link：target === source 直接剔除", () => {
    const t1 = uuidAt(1);
    const result = normalizeLinkTargets(SOURCE, [SOURCE, t1, SOURCE]);
    expect(result).toEqual({ ok: true, targets: [t1] });
  });

  it("空陣列 → ok:true，targets 為空（語意＝清空所有連結）", () => {
    expect(normalizeLinkTargets(SOURCE, [])).toEqual({ ok: true, targets: [] });
  });

  it("正規化後（去重＋濾 self-link 之後）剛好等於 MAX_LINK_TARGETS → ok:true", () => {
    const targets = Array.from({ length: MAX_LINK_TARGETS }, (_, i) => uuidAt(i + 1));
    const result = normalizeLinkTargets(SOURCE, targets);
    expect(result.ok).toBe(true);
    expect(result.ok && result.targets).toHaveLength(MAX_LINK_TARGETS);
  });

  it("正規化後超過 MAX_LINK_TARGETS 一個 → ok:false", () => {
    const targets = Array.from({ length: MAX_LINK_TARGETS + 1 }, (_, i) => uuidAt(i + 1));
    expect(normalizeLinkTargets(SOURCE, targets)).toEqual({ ok: false });
  });

  it("上限判定在正規化之後：raw 陣列遠超上限，但去重＋濾 self-link 後在上限內 → ok:true", () => {
    // 刻意用「大量重複 + 大量 self-link」讓 raw.length 遠超 MAX_LINK_TARGETS，驗證上限判定
    // 確實是對「正規化後的集合」而非「原始輸入長度」——若誤判會回 ok:false。
    const t1 = uuidAt(1);
    const t2 = uuidAt(2);
    const raw = [
      ...Array.from({ length: MAX_LINK_TARGETS * 3 }, () => SOURCE),
      ...Array.from({ length: MAX_LINK_TARGETS * 3 }, () => t1),
      t2,
    ];
    const result = normalizeLinkTargets(SOURCE, raw);
    expect(result).toEqual({ ok: true, targets: [t1, t2] });
  });
});
