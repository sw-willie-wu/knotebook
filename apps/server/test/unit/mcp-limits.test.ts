/**
 * #108 §8.1 回應大小上限表的截斷函式（M16）。
 *
 * 這一族守的是 `truncateText` 的邊界，不是「哪些欄位有被截」——後者由
 * `test/mcp-notes.test.ts` 的 key 集合／長度斷言守。
 *
 * #177 起 `truncateText` 的預算按 **JSON 逃脫後**的長度計（`limits.ts`）；`truncateCodeUnits` 是
 * `read_note_section` 分頁用的舊規則（按原長度）。
 */
import { describe, expect, it } from "vitest";
import { MCP_SECTION_CHARS, MCP_TEXT_MAX, truncateCodeUnits, truncateText } from "../../src/mcp/limits.js";
import { noteOwnerSchema, noteSummarySchema, ownerForModel, toNoteSummary } from "../../src/mcp/dto.js";

/** 沒有配對的高位／低位代理。`String.prototype.isWellFormed` 要 ES2024 lib，本 repo 是 ES2023。 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("#108 truncateText", () => {
  it("恰好 200 code unit 不截斷", () => {
    const s = "a".repeat(MCP_TEXT_MAX);
    expect(truncateText(s)).toEqual({ text: s, truncated: false });
  });

  it("201 code unit 截到 200 並標記 truncated", () => {
    const s = "a".repeat(MCP_TEXT_MAX + 1);
    const out = truncateText(s);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBe(MCP_TEXT_MAX);
    expect(out.text).toBe("a".repeat(MCP_TEXT_MAX));
  });

  // 代理對（一個 emoji ＝兩個 code unit）**不切半**：切點恰落在代理對中間時退一格，
  // 回傳 199 個 code unit。切半的後果是回給模型一個孤立代理（lone surrogate）——
  // JSON 序列化不會報錯，只會安靜地送出一個壞字元。
  it("切點落在代理對中間時退一格，不產生孤立代理", () => {
    const s = "a".repeat(MCP_TEXT_MAX - 1) + "\u{1F600}" + "tail";
    const out = truncateText(s);
    expect(out.truncated).toBe(true);
    expect(out.text.length).toBe(MCP_TEXT_MAX - 1);
    expect(out.text).toBe("a".repeat(MCP_TEXT_MAX - 1));
    expect(LONE_SURROGATE.test(out.text)).toBe(false);
    // 對照面：天真的 `slice(0, 200)` 在同一份輸入上會切出孤立代理——沒有這一行，
    // 上面那條「長度 199」的斷言看不出它為什麼是 199。
    expect(LONE_SURROGATE.test(s.slice(0, MCP_TEXT_MAX))).toBe(true);
  });
});

/** JSON 逃脫後的長度（不含兩端引號）——`truncateText` 的預算單位，**獨立真相**直接取自 `JSON.stringify`。 */
const escapedLength = (s: string): number => JSON.stringify(s).length - 2;

describe("#177 truncateText 按 JSON 逃脫後的長度計", () => {
  it("C0（U+0001，逃脫成 6）：40 個只留 33 個（198），不切出半個 \u0001", () => {
    const out = truncateText("\u0001".repeat(40));
    expect(out.truncated).toBe(true);
    expect(out.text).toBe("\u0001".repeat(33));
    expect(escapedLength(out.text)).toBe(198);
  });

  it("C0 恰好填滿預算不截、多一個 code unit 就整個字丟掉", () => {
    const fits = `${"a".repeat(MCP_TEXT_MAX - 6)}\u0001`; // 194 ＋ 6 ＝ 200
    expect(truncateText(fits)).toEqual({ text: fits, truncated: false });
    const over = `${"a".repeat(MCP_TEXT_MAX - 5)}\u0001`; // 195 ＋ 6 ＝ 201
    expect(truncateText(over)).toEqual({ text: "a".repeat(MCP_TEXT_MAX - 5), truncated: true });
  });

  it.each([
    ['"', "雙引號"],
    ["\\", "反斜線"],
    ["\n", "換行（短逃脫 \n）"],
  ])("%j（%s，逃脫成 2）：100 個不截、101 個截到 100", ch => {
    expect(truncateText(ch.repeat(100))).toEqual({ text: ch.repeat(100), truncated: false });
    const out = truncateText(ch.repeat(101));
    expect(out).toEqual({ text: ch.repeat(100), truncated: true });
    expect(escapedLength(out.text)).toBe(MCP_TEXT_MAX);
  });

  it("不需要逃脫的非 ASCII（CJK、U+2028、DEL、C1）照舊按原長度：201 個截到 200", () => {
    for (const ch of ["中", " ", "\u007f", "\u0085"]) {
      expect(truncateText(ch.repeat(MCP_TEXT_MAX))).toEqual({ text: ch.repeat(MCP_TEXT_MAX), truncated: false });
      expect(truncateText(ch.repeat(MCP_TEXT_MAX + 1))).toEqual({ text: ch.repeat(MCP_TEXT_MAX), truncated: true });
    }
  });

  it("代理對與逃脫字元相鄰時整對留或整對丟，不產生孤立代理", () => {
    const fits = `${'"'.repeat(99)}\u{1F600}`; // 198 ＋ 2 ＝ 200
    expect(truncateText(fits)).toEqual({ text: fits, truncated: false });
    const s = `${'"'.repeat(99)}a\u{1F600}`; // 198 ＋ 1 ＝ 199，代理對放不下
    const out = truncateText(s);
    expect(out).toEqual({ text: `${'"'.repeat(99)}a`, truncated: true });
    expect(LONE_SURROGATE.test(out.text)).toBe(false);
  });

  // 逐位對照 `JSON.stringify`：每一個 code unit（含孤立代理）重複 250 次，留下的個數必須恰好是
  // floor(200 ／ 該字逃脫後的長度)——同時證明「不超過預算」與「沒有少留」。
  it("0x0000–0xFFFF 每個 code unit：留下的個數＝floor(200／JSON.stringify 的逃脫長度)", () => {
    const bad: string[] = [];
    for (let c = 0; c <= 0xffff; c += 1) {
      const ch = String.fromCharCode(c);
      const cost = escapedLength(ch);
      const out = truncateText(ch.repeat(250));
      if (out.text !== ch.repeat(Math.floor(MCP_TEXT_MAX / cost)) || !out.truncated) bad.push(c.toString(16));
    }
    expect(bad).toEqual([]);
  });

  // 混合字母的決定性亂數：不變量是「逃脫後 ≤ 200、是原字串的前綴、再多一個字（或一整對）就會超」。
  it("混合字串（固定種子 500 組）：逃脫後 ≤ 200、前綴、最大化", () => {
    const alphabet = ["a", "中", '"', "\\", "\n", "\u0001", "\u001f", "\u{1F600}", "\uD800", " "];
    let seed = 177;
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let k = 0; k < 500; k += 1) {
      let s = "";
      const len = 1 + rnd(300);
      for (let j = 0; j < len; j += 1) s += alphabet[rnd(alphabet.length)];
      const out = truncateText(s);
      expect(s.startsWith(out.text)).toBe(true);
      expect(escapedLength(out.text)).toBeLessThanOrEqual(MCP_TEXT_MAX);
      expect(out.truncated).toBe(out.text !== s);
      if (out.truncated) {
        const rest = s.slice(out.text.length);
        const c0 = rest.charCodeAt(0);
        const step = c0 >= 0xd800 && c0 <= 0xdbff && /^[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(rest) ? 2 : 1;
        expect(escapedLength(s.slice(0, out.text.length + step))).toBeGreaterThan(MCP_TEXT_MAX);
      }
    }
  });
});

describe("#177 truncateCodeUnits（read_note_section 分頁）仍按原長度", () => {
  it("C0 不計逃脫：4001 個 U+0001 截到 4000", () => {
    const out = truncateCodeUnits("\u0001".repeat(MCP_SECTION_CHARS + 1), MCP_SECTION_CHARS);
    expect(out).toEqual({ text: "\u0001".repeat(MCP_SECTION_CHARS), truncated: true });
  });

  it("切點落在代理對中間時退一格", () => {
    const s = `${"a".repeat(MCP_SECTION_CHARS - 1)}\u{1F600}`;
    expect(truncateCodeUnits(s, MCP_SECTION_CHARS)).toEqual({ text: "a".repeat(MCP_SECTION_CHARS - 1), truncated: true });
  });
});

describe("#177 回給模型的 DTO 欄位走同一套截斷", () => {
  const groupRow = (groupName: string) => ({ ownerHandle: null, groupId: "g-1", groupName });

  it("群組名：一般名稱原樣、沒有 nameTruncated", () => {
    expect(ownerForModel(groupRow("Team"))).toEqual({ kind: "group", id: "g-1", name: "Team" });
  });

  it("群組名：80 個 U+0001（DB 上限內的合規值）截到 33 個並帶 nameTruncated，且過 outputSchema", () => {
    const owner = ownerForModel(groupRow("\u0001".repeat(80)));
    expect(owner).toEqual({ kind: "group", id: "g-1", name: "\u0001".repeat(33), nameTruncated: true });
    expect(noteOwnerSchema.safeParse(owner).success).toBe(true);
  });

  it("群組名：80 個 `\"`（逃脫後 160）不截", () => {
    expect(ownerForModel(groupRow('"'.repeat(80)))).toEqual({ kind: "group", id: "g-1", name: '"'.repeat(80) });
  });

  it("標題：101 個 `\"` 截到 100 並帶 titleTruncated，且過 outputSchema", () => {
    const summary = toNoteSummary(
      {
        id: "n-1",
        title: '"'.repeat(101),
        ownerHandle: "alice",
        groupId: null,
        groupName: null,
        slug: "s",
        updatedAt: new Date(0),
        lastEditedAt: null,
        lastEditedAgentLabel: null,
        editorHandle: null,
      },
      "owner"
    );
    expect(summary.title).toBe('"'.repeat(100));
    expect(summary.titleTruncated).toBe(true);
    expect(noteSummarySchema.safeParse(summary).success).toBe(true);
  });
});
