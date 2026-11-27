import { describe, expect, it } from "vitest";
import { COMMENT_BODY_MAX, COMMENT_MENTIONS_MAX, COMMENT_QUOTE_MAX, MENTION_CANDIDATES_MAX, parseMentionSpans } from "./comments.js";

const handles = (body: string) => parseMentionSpans(body).map(s => s.handle);

describe("parseMentionSpans", () => {
  it("finds a plain mention with its code-point span", () => {
    expect(parseMentionSpans("hi @bob!")).toEqual([{ start: 3, length: 4, handle: "bob", label: null }]);
    expect(parseMentionSpans("@bob")).toEqual([{ start: 0, length: 4, handle: "bob", label: null }]);
  });

  it("mentions after CJK text and inside full-width brackets", () => {
    expect(parseMentionSpans("請@bob看")).toEqual([{ start: 1, length: 4, handle: "bob", label: null }]);
    expect(parseMentionSpans("（@bob）")).toEqual([{ start: 1, length: 4, handle: "bob", label: null }]);
  });

  it("does not treat an email address as a mention", () => {
    expect(parseMentionSpans("a@b.com")).toEqual([]);
    expect(parseMentionSpans("x_@bob")).toEqual([]);
    expect(parseMentionSpans("x.@bob")).toEqual([]);
    expect(parseMentionSpans("x-@bob")).toEqual([]);
    expect(parseMentionSpans("bob@carol")).toEqual([]);
  });

  it("leaves a trailing dash out of the handle", () => {
    expect(parseMentionSpans("@bob-")).toEqual([{ start: 0, length: 4, handle: "bob", label: null }]);
    expect(parseMentionSpans("@bob--x")).toEqual([{ start: 0, length: 7, handle: "bob--x", label: null }]);
    expect(parseMentionSpans("@bob-/x")).toEqual([{ start: 0, length: 4, handle: "bob", label: null }]);
  });

  it("is not a mention without a handle character", () => {
    expect(parseMentionSpans("@")).toEqual([]);
    expect(parseMentionSpans("@ bob")).toEqual([]);
    expect(parseMentionSpans("@-")).toEqual([]);
    expect(parseMentionSpans("@@bob")).toEqual([{ start: 1, length: 4, handle: "bob", label: null }]);
  });

  it("reads @handle/label, and drops an empty label", () => {
    expect(parseMentionSpans("@alice/xyz")).toEqual([{ start: 0, length: 10, handle: "alice", label: "xyz" }]);
    expect(parseMentionSpans("@bob/claude.x")).toEqual([{ start: 0, length: 13, handle: "bob", label: "claude.x" }]);
    expect(parseMentionSpans("@bob/ hi")).toEqual([{ start: 0, length: 4, handle: "bob", label: null }]);
    expect(parseMentionSpans("@bob/")).toEqual([{ start: 0, length: 4, handle: "bob", label: null }]);
  });

  it("lowercases the handle and keeps the label as written", () => {
    expect(parseMentionSpans("@BOB")).toEqual([{ start: 0, length: 4, handle: "bob", label: null }]);
    expect(parseMentionSpans("@Bob/Claude")).toEqual([{ start: 0, length: 11, handle: "bob", label: "Claude" }]);
  });

  it("accepts a 32-character handle and label, but not a longer one", () => {
    expect(parseMentionSpans(`@${"a".repeat(32)}`)[0]).toMatchObject({ length: 33, handle: "a".repeat(32) });
    expect(parseMentionSpans(`@${"a".repeat(33)}`)).toEqual([]);
    expect(parseMentionSpans(`@${"a".repeat(33)} @bob`)).toEqual([{ start: 35, length: 4, handle: "bob", label: null }]);
    expect(parseMentionSpans(`@bob/${"l".repeat(32)}`)[0]).toMatchObject({ length: 4 + 1 + 32, label: "l".repeat(32) });
    expect(parseMentionSpans(`@bob/${"l".repeat(33)}`)).toEqual([{ start: 0, length: 4, handle: "bob", label: null }]);
  });

  it("checks the handle length after dropping a trailing dash", () => {
    expect(parseMentionSpans(`@${"a".repeat(32)}-`)).toEqual([{ start: 0, length: 33, handle: "a".repeat(32), label: null }]);
    expect(parseMentionSpans(`@${"a".repeat(32)}--`)).toEqual([{ start: 0, length: 33, handle: "a".repeat(32), label: null }]);
    expect(parseMentionSpans(`@${"a".repeat(33)}-`)).toEqual([]);
    expect(parseMentionSpans(`@${"a".repeat(33)}- @bob`)).toEqual([{ start: 36, length: 4, handle: "bob", label: null }]);
  });

  it("keeps trailing dots of a label literally and doesn't count them toward the 32", () => {
    expect(parseMentionSpans("@alice/claude.")).toEqual([{ start: 0, length: 14, handle: "alice", label: "claude." }]);
    const l32 = "l".repeat(32);
    expect(parseMentionSpans(`@bob/${l32}.`)).toEqual([{ start: 0, length: 4 + 1 + 33, handle: "bob", label: `${l32}.` }]);
    expect(parseMentionSpans(`@bob/${l32}...`)).toEqual([{ start: 0, length: 4 + 1 + 35, handle: "bob", label: `${l32}...` }]);
    expect(parseMentionSpans(`@bob/${"l".repeat(33)}.`)).toEqual([{ start: 0, length: 4, handle: "bob", label: null }]);
    expect(parseMentionSpans(`@bob/${l32}.x`)).toEqual([{ start: 0, length: 4, handle: "bob", label: null }]);
  });

  it("returns every candidate, including repeats and more than the mention cap", () => {
    const body = Array.from({ length: COMMENT_MENTIONS_MAX + 1 }, (_, i) => `@u${i}`).join(" ");
    expect(parseMentionSpans(body)).toHaveLength(COMMENT_MENTIONS_MAX + 1);
    expect(handles("@bob @bob @carol")).toEqual(["bob", "bob", "carol"]);
  });

  it("counts offsets in code points after astral characters", () => {
    const body = "😀😀 @bob";
    expect(body.length).toBe(9);
    const [span] = parseMentionSpans(body);
    expect(span).toEqual({ start: 3, length: 4, handle: "bob", label: null });
    expect([...body].slice(span!.start, span!.start + span!.length).join("")).toBe("@bob");
  });

  it("treats a mention right after an astral character as bound", () => {
    expect(parseMentionSpans("😀@bob")).toEqual([{ start: 1, length: 4, handle: "bob", label: null }]);
  });

  it("returns nothing for an empty body", () => {
    expect(parseMentionSpans("")).toEqual([]);
  });
});

describe("limits", () => {
  it("has the documented values", () => {
    expect(COMMENT_BODY_MAX).toBe(4000);
    expect(COMMENT_QUOTE_MAX).toBe(200);
    expect(COMMENT_MENTIONS_MAX).toBe(20);
    expect(MENTION_CANDIDATES_MAX).toBe(8);
  });
});
