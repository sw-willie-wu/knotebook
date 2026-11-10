import { describe, expect, it } from "vitest";
import {
  fallbackGroupFolderName,
  folderNameWithSuffix,
  normalizeFolderName,
  normalizeFolderNameLoose,
} from "../../src/folders/names.js";

const NUL = String.fromCodePoint(0);
const SMILE = "😀";

describe("NM-1 normalizeFolderName（使用者輸入）", () => {
  const cases: Array<[string, string, ReturnType<typeof normalizeFolderName>]> = [
    ["NUL", `A${NUL}B`, { ok: false, reason: "unstorable" }],
    ["落單代理", "\uD800", { ok: false, reason: "unstorable" }],
    ["先 trim（n2）：尾端換行被修掉", " A\n", { ok: true, name: "A" }],
    ["字中間的換行", "A\nB", { ok: false, reason: "control" }],
    ["Tab", "A\tB", { ok: false, reason: "control" }],
    ["DEL", "A\u007FB", { ok: false, reason: "control" }],
    ["C1 U+0085", "A\u0085B", { ok: false, reason: "control" }],
    ["C1 U+0080", "A\u0080B", { ok: false, reason: "control" }],
    ["C0 上界 U+001F", "A\u001FB", { ok: false, reason: "control" }],
    ["C1 上界 U+009F", "A\u009FB", { ok: false, reason: "control" }],
    ["區間外 U+0020（空白）", "A B", { ok: true, name: "A B" }],
    ["區間外 U+00A0（NBSP）", "A\u00A0B", { ok: true, name: "A\u00A0B" }],
    ["行分隔 U+2028", "A\u2028B", { ok: false, reason: "control" }],
    ["段分隔 U+2029", "A\u2029B", { ok: false, reason: "control" }],
    ["bidi U+202A", "A\u202AB", { ok: false, reason: "control" }],
    ["bidi U+202E（RLO）", "A\u202EB", { ok: false, reason: "control" }],
    ["bidi U+2066", "A\u2066B", { ok: false, reason: "control" }],
    ["bidi U+2069", "A\u2069B", { ok: false, reason: "control" }],
    ["區間外 U+2027", "A\u2027B", { ok: true, name: "A\u2027B" }],
    ["區間外 U+202F", "A\u202FB", { ok: true, name: "A\u202FB" }],
    ["區間外 U+2065", "A\u2065B", { ok: true, name: "A\u2065B" }],
    ["區間外 U+206A", "A\u206AB", { ok: true, name: "A\u206AB" }],
    ["ZWNJ 保留", "A\u200CB", { ok: true, name: "A\u200CB" }],
    ["ZWJ emoji 序列保留", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}", { ok: true, name: "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}" }],
    ["NFC", "e\u0301", { ok: true, name: "\u00E9" }],
    ["80 個 😀（以 code point 計）", SMILE.repeat(80), { ok: true, name: SMILE.repeat(80) }],
    ["81 個 a", "a".repeat(81), { ok: false, reason: "length" }],
    ["空字串", "", { ok: false, reason: "length" }],
    ["只有空白", "   ", { ok: false, reason: "length" }],
    ["其他可存字元原樣", "a/b›c", { ok: true, name: "a/b›c" }],
  ];
  it.each(cases)("%s", (_label, raw, expected) => {
    expect(normalizeFolderName(raw)).toEqual(expected);
  });
});

describe("NM-2 normalizeFolderNameLoose（系統代建）", () => {
  it("全是控制字元 → fallback", () => {
    expect(normalizeFolderNameLoose("\u0001\u0002", "Group")).toBe("Group");
  });
  it("去控制字元之後再 trim", () => {
    expect(normalizeFolderNameLoose("A\u0001 ", "Group")).toBe("A");
    expect(normalizeFolderNameLoose("A \u0001", "Group")).toBe("A");
    expect(normalizeFolderNameLoose("\u0001 A", "Group")).toBe("A");
  });
  it("NUL 被去掉", () => {
    expect(normalizeFolderNameLoose(`A${NUL}B`, "Group")).toBe("AB");
  });
  it("落單代理被去掉", () => {
    expect(normalizeFolderNameLoose("\uD800X", "Group")).toBe("X");
    expect(normalizeFolderNameLoose("\u{1F3A8} 設計", "Group")).toBe("\u{1F3A8} 設計");
  });
  it("行分隔與 bidi 控制被去掉，ZWNJ／ZWJ 保留", () => {
    expect(normalizeFolderNameLoose("A\u2028B\u2029C\u202AD\u202EE\u2066F\u2069G", "Group")).toBe("ABCDEFG");
    expect(normalizeFolderNameLoose("A\u200CB\u200DC", "Group")).toBe("A\u200CB\u200DC");
  });
  it("NFD → NFC", () => {
    expect(normalizeFolderNameLoose("e\u0301", "Group")).toBe("\u00E9");
  });
  it("截到 80 code point", () => {
    expect(normalizeFolderNameLoose("字".repeat(100), "Group")).toBe("字".repeat(80));
  });
  it("截完不留尾端空白", () => {
    expect(normalizeFolderNameLoose(`${"a".repeat(79)} bb`, "Group")).toBe("a".repeat(79));
  });
});

describe("NM-3 folderNameWithSuffix", () => {
  it("80 個 a、n=2 → 76 個 a＋「 (2)」", () => {
    const r = folderNameWithSuffix("a".repeat(80), 2);
    expect(r).toBe(`${"a".repeat(76)} (2)`);
    expect(Array.from(r).length).toBe(80);
  });
  it("n=10 → 75 個 a＋「 (10)」", () => {
    expect(folderNameWithSuffix("a".repeat(80), 10)).toBe(`${"a".repeat(75)} (10)`);
  });
  it("短名不截", () => {
    expect(folderNameWithSuffix("ab", 2)).toBe("ab (2)");
  });
  it("截完 trimEnd，不留雙空白", () => {
    const base = `${"a".repeat(75)}  zz`;
    expect(Array.from(base).length).toBe(79);
    expect(folderNameWithSuffix(base, 2)).toBe(`${"a".repeat(75)} (2)`);
  });
  it("😀 以 1 個 code point 計", () => {
    const r = folderNameWithSuffix(SMILE.repeat(80), 2);
    expect(r).toBe(`${SMILE.repeat(76)} (2)`);
    expect(Array.from(r).length).toBe(80);
  });
  it("n=1 → base", () => {
    expect(folderNameWithSuffix("ab", 1)).toBe("ab");
  });
});

describe("NM-4 fallbackGroupFolderName", () => {
  it.each(["zh-TW,zh;q=0.9", "zh", " ZH-cn"])("%j → 群組", (al) => {
    expect(fallbackGroupFolderName(al)).toBe("群組");
  });
  it.each(["en-US,zh-TW;q=0.9", "", undefined])("%j → Group", (al) => {
    expect(fallbackGroupFolderName(al)).toBe("Group");
  });
});
