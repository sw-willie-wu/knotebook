import { describe, expect, it } from "vitest";
import { frontMatterJson, parseNoteTags, serializeNoteTags, tagsKeyOf } from "../../src/transfer/note-tags-format.js";

const MESSAGE = "The front matter's `tags` must be a JSON array of strings, like [\"a\", \"b\"].";
const valueOf = (line: string): string => line.slice("tags:".length).trim();

describe("serializeNoteTags", () => {
  it("writes a JSON array after `tags: ` with \", \" between names, and [] for none", () => {
    expect(serializeNoteTags(["影像", "AWS", "roadeye"])).toBe('tags: ["影像", "AWS", "roadeye"]');
    expect(serializeNoteTags([])).toBe("tags: []");
  });

  it("names with quotes, commas, colons, backslashes, U+0085 and U+2028 round-trip and the line has no raw U+0085, U+2028 or U+2029", () => {
    const names = ['a"b', "x, y", "k: v", "C:\\Users", "nel\u0085x", "ls\u2028x", "ps\u2029x", "emoji 😀", "-->"];
    const line = serializeNoteTags(names);
    expect(line).not.toMatch(/[\u0085\u2028\u2029\n\r]/);
    expect(line.startsWith("tags: ")).toBe(true);
    expect(parseNoteTags(valueOf(line))).toEqual({ ok: true, tags: names });
  });
});

describe("parseNoteTags", () => {
  it("absent key is undefined; [] is []", () => {
    expect(parseNoteTags(undefined)).toEqual({ ok: true, tags: undefined });
    expect(parseNoteTags("[]")).toEqual({ ok: true, tags: [] });
    expect(parseNoteTags('["a", "b"]')).toEqual({ ok: true, tags: ["a", "b"] });
  });

  it.each([
    ["empty value", ""],
    ["a bare word", "a, b"],
    ["an object", '{"a": 1}'],
    ["a string", '"a"'],
    ["numbers in the array", "[1, 2]"],
    ["null in the array", '["a", null]'],
    ["nested array", '[["a"]]'],
    ["unterminated array", '["a"'],
    ["trailing text", '["a"] x'],
    ["single-quoted names", "['a']"],
  ])("%s is an error with the fixed message", (_name, raw) => {
    expect(parseNoteTags(raw)).toEqual({ ok: false, message: MESSAGE });
  });
});

describe("tagsKeyOf", () => {
  it("ignores order, case and duplicates", () => {
    expect(tagsKeyOf(["b", "A", "a"])).toBe(tagsKeyOf(["a", "B"]));
    expect(tagsKeyOf(["a", "b"])).not.toBe(tagsKeyOf(["a", "c"]));
    expect(tagsKeyOf([])).toBe("[]");
  });
});

describe("frontMatterJson", () => {
  it("escapes C1 controls, U+2028 and U+2029 and JSON.parse restores them", () => {
    const s = "a\u0080b\u0085c\u009fd\u2028e\u2029f\"g\\h\n";
    const out = frontMatterJson(s);
    expect(out).not.toMatch(/[\u0080-\u009f\u2028\u2029\n]/);
    expect(out).toContain("\\u0085");
    expect(out).toContain("\\u2028");
    expect(JSON.parse(out)).toBe(s);
  });

  it("matches JSON.stringify for text without those characters", () => {
    for (const s of ["", "plain", "中文 😀", 'q"uote', "back\\slash"]) expect(frontMatterJson(s)).toBe(JSON.stringify(s));
  });
});
