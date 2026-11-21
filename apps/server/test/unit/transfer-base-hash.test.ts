import { describe, it, expect } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { bodyLines, lineKey, normalizeBody, normalizeNumbered } from "../../src/transfer/normalize.js";
import { LINE_HASH_BYTES, baseHashes, deriveTransferKey, hmacOf, newBaseKey, newSalt, transferKeyId } from "../../src/transfer/base-hash.js";
import { TRANSFER_FILE_VERSION, writeNoteFile } from "../../src/transfer/frontmatter.js";

/** bulk transfer base hash: frontmatter, HMAC + salt, key_id, normalisation, numbering normalisation. */

describe("normalizeBody", () => {
  it.each([
    ["strip BOM", "\ufeffa\nb", "a\nb"],
    ["CRLF -> LF", "a\r\nb\r\n", "a\nb"],
    ["leading blank lines (including whitespace-only lines) removed", "\n  \n\t\na\n", "a"],
    ["all trailing newlines removed", "a\n\n\n", "a"],
    ["blank lines in the middle kept", "a\n\n\nb", "a\n\n\nb"],
    ["empty string", "", ""],
    ["only newlines", "\n\n", ""],
    ["leading whitespace of the first line is content (not a blank line)", "  a", "  a"],
    ["only trailing newlines are removed, not trailing whitespace", "a  \n", "a  "],
  ])("%s", (_name, raw, want) => {
    expect(normalizeBody(raw)).toBe(want);
  });
});

describe("bodyLines / lineKey / normalizeNumbered", () => {
  it("bodyLines: empty string -> []; otherwise split", () => {
    expect(bodyLines("")).toEqual([]);
    expect(bodyLines("a")).toEqual(["a"]);
    expect(bodyLines("a\n\nb")).toEqual(["a", "", "b"]);
  });
  it("lineKey: trimEnd (spaces, tabs)", () => {
    expect(lineKey("a  ")).toBe("a");
    expect(lineKey("a\t \t")).toBe("a");
    expect(lineKey("  a")).toBe("  a");
  });
  it("normalizeNumbered: a leading number (may be indented) is replaced by 1.; numbers mid-line are untouched", () => {
    expect(normalizeNumbered("3. x")).toBe("1. x");
    expect(normalizeNumbered("   12. y")).toBe("   1. y");
    expect(normalizeNumbered("x 2. y")).toBe("x 2. y");
    expect(normalizeNumbered("1. z")).toBe("1. z");
    expect(normalizeNumbered("- 2. w")).toBe("- 2. w");
  });
});

describe("HMAC + salt line hashing", () => {
  const key = deriveTransferKey("test-app-secret-0123456789abcdef");
  const saltA = Buffer.alloc(16, 0xa1);
  const saltB = Buffer.alloc(16, 0xb2);
  const hashOfLine = (h: Buffer, i: number) => h.subarray(i * LINE_HASH_BYTES, (i + 1) * LINE_HASH_BYTES).toString("hex");

  it("the same line in two rows (two salts) hashes differently; two identical lines in the same row hash the same", () => {
    const lines = ["same line", "other", "same line"];
    const a = baseHashes(key, saltA, { body: lines.join("\n"), title: "T", tags: [], lines, kinds: [0, 0, 0] });
    const b = baseHashes(key, saltB, { body: lines.join("\n"), title: "T", tags: [], lines, kinds: [0, 0, 0] });
    expect(hashOfLine(a.lineHashes, 0)).not.toBe(hashOfLine(b.lineHashes, 0));
    expect(hashOfLine(a.lineHashes, 0)).toBe(hashOfLine(a.lineHashes, 2));
    expect(hashOfLine(a.lineHashes, 0)).not.toBe(hashOfLine(a.lineHashes, 1));
    expect(a.bodySha.equals(b.bodySha)).toBe(false);
    expect(a.titleSha.equals(b.titleSha)).toBe(false);
  });

  it("tagsSha is the HMAC of the tag key: order and case don't matter, a different set does", () => {
    const lines = ["a"];
    const sha = (tags: string[], s = saltA) => baseHashes(key, s, { body: "a", title: "T", tags, lines, kinds: [0] }).tagsSha;
    const ref = createHmac("sha256", key).update(Buffer.concat([saltA, Buffer.from('["a","b"]', "utf8")])).digest();
    expect(sha(["B", "a"]).equals(ref)).toBe(true);
    expect(sha(["b", "a", "A"]).equals(sha(["a", "b"]))).toBe(true);
    expect(sha(["a"]).equals(sha(["a", "b"]))).toBe(false);
    expect(sha(["a"], saltB).equals(sha(["a"]))).toBe(false);
    expect(sha([]).length).toBe(32);
  });

  it("length and shape: lineHashes 8 bytes per line; lineKinds 1 byte per line; body/title 32 bytes", () => {
    const lines = ["a", "", "1. b", "c"];
    const h = baseHashes(key, saltA, { body: lines.join("\n"), title: "T", tags: [], lines, kinds: [0, 0, 1, 0] });
    expect(LINE_HASH_BYTES).toBe(8);
    expect(h.lineHashes.length).toBe(8 * lines.length);
    expect([...h.lineKinds]).toEqual([0, 0, 1, 0]);
    expect(h.bodySha.length).toBe(32);
    expect(h.titleSha.length).toBe(32);
  });

  it("value = HMAC-SHA256(K, salt || x): independently computed, byte-for-byte equal (body uses the passed-in normalised body, line goes through lineKey first)", () => {
    const lines = ["x  ", "y"];
    const body = "x  \ny";
    const h = baseHashes(key, saltA, { body, title: "標題", tags: [], lines, kinds: [0, 0] });
    const ref = (x: string) => createHmac("sha256", key).update(Buffer.concat([saltA, Buffer.from(x, "utf8")])).digest();
    expect(h.bodySha.equals(ref(body))).toBe(true);
    expect(h.titleSha.equals(ref("標題"))).toBe(true);
    expect(h.lineHashes.subarray(0, 8).equals(ref("x").subarray(0, 8))).toBe(true);
    expect(hmacOf(key, saltA, "y").equals(ref("y"))).toBe(true);
  });

  it("kind 1: `3. x` and `1. x` hash the same; kind 0 differ; trailing whitespace does not matter", () => {
    const lines = ["3. x", "1. x", "3. x", "1. x", "a", "a \t"];
    const h = baseHashes(key, saltA, { body: lines.join("\n"), title: "T", tags: [], lines, kinds: [1, 1, 0, 0, 0, 0] });
    expect(hashOfLine(h.lineHashes, 0)).toBe(hashOfLine(h.lineHashes, 1));
    expect(hashOfLine(h.lineHashes, 2)).not.toBe(hashOfLine(h.lineHashes, 3));
    expect(hashOfLine(h.lineHashes, 4)).toBe(hashOfLine(h.lineHashes, 5));
  });

  it("lines and kinds of different length -> throws (a caller error, no silent truncation)", () => {
    expect(() => baseHashes(key, saltA, { body: "a", title: "T", tags: [], lines: ["a"], kinds: [] })).toThrow();
  });
});

describe("transferKeyId", () => {
  it("= first 8 hex of sha256(sha256(`${APP_SECRET}:transfer-base`)); a different APP_SECRET gives a different one", () => {
    const s = "test-app-secret-0123456789abcdef";
    const k = createHash("sha256").update(`${s}:transfer-base`).digest();
    expect(deriveTransferKey(s).equals(k)).toBe(true);
    expect(transferKeyId(deriveTransferKey(s))).toBe(createHash("sha256").update(k).digest("hex").slice(0, 8));
    expect(transferKeyId(deriveTransferKey(s))).toMatch(/^[0-9a-f]{8}$/);
    expect(transferKeyId(deriveTransferKey(s + "x"))).not.toBe(transferKeyId(deriveTransferKey(s)));
  });
});

describe("newBaseKey / newSalt", () => {
  it("newBaseKey is 16 hex (the write-back format guard relies on it) and different each time; newSalt is 16 bytes", () => {
    const a = newBaseKey();
    const b = newBaseKey();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(b).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
    expect(newSalt().length).toBe(16);
    expect(newSalt().equals(newSalt())).toBe(false);
  });
});

describe("writeNoteFile", () => {
  const fm = (title: string) => ({ id: "3f2c0e1a-0000-4000-8000-000000000001", title, role: "editor", base: "7d41c0b2e9a85f13", url: "/n/alice/meeting-notes", tags: [] as string[] });

  it("9 lines of frontmatter in fixed key order; body appended verbatim", () => {
    const out = writeNoteFile(fm("會議紀錄"), "# H\n\nbody  \n");
    expect(out).toBe(
      "---\nknotebook: 1\nid: 3f2c0e1a-0000-4000-8000-000000000001\ntitle: \"會議紀錄\"\ntags: []\nrole: editor\nbase: 7d41c0b2e9a85f13\nurl: /n/alice/meeting-notes\n---\n# H\n\nbody  \n",
    );
    expect(TRANSFER_FILE_VERSION).toBe(1);
    expect(writeNoteFile(fm("x"), "")).toBe(
      "---\nknotebook: 1\nid: 3f2c0e1a-0000-4000-8000-000000000001\ntitle: \"x\"\ntags: []\nrole: editor\nbase: 7d41c0b2e9a85f13\nurl: /n/alice/meeting-notes\n---\n",
    );
  });

  it.each([['"'], ["\\"], ["'"], ["#"], ["a: b"], ["-x"], ["😀 emoji"], ["line1\nline2"], ['a "b" \\c'], ["\u2028"]])("title %j round trip: the title line is equal verbatim after JSON.parse and stays a single line", title => {
    const out = writeNoteFile(fm(title), "body");
    const lines = out.split("\n");
    expect(lines[0]).toBe("---");
    expect(lines[8]).toBe("---");
    expect(lines[9]).toBe("body");
    expect(lines.slice(1, 8).map(l => l.slice(0, l.indexOf(":")))).toEqual(["knotebook", "id", "title", "tags", "role", "base", "url"]);
    expect(lines[3]!.startsWith('title: "')).toBe(true);
    expect(JSON.parse(lines[3]!.slice("title: ".length))).toBe(title);
  });
});
