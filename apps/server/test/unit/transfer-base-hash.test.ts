import { describe, it, expect } from "vitest";
import { createHash, createHmac } from "node:crypto";
import { bodyLines, lineKey, normalizeBody, normalizeNumbered } from "../../src/transfer/normalize.js";
import { LINE_HASH_BYTES, baseHashes, deriveTransferKey, hmacOf, newBaseKey, newSalt, transferKeyId } from "../../src/transfer/base-hash.js";
import { TRANSFER_FILE_VERSION, writeNoteFile } from "../../src/transfer/frontmatter.js";

/** bulk transfer spec §6.4（frontmatter）、§8.1–§8.2（HMAC＋鹽、key_id）、§9.1（正規化）、§9.3-1（編號正規化）。 */

describe("H1 normalizeBody", () => {
  it.each([
    ["去 BOM", "\ufeffa\nb", "a\nb"],
    ["CRLF → LF", "a\r\nb\r\n", "a\nb"],
    ["開頭空行（含只有空白的行）去掉", "\n  \n\t\na\n", "a"],
    ["結尾所有 \\n 去掉", "a\n\n\n", "a"],
    ["中間空行保留", "a\n\n\nb", "a\n\n\nb"],
    ["空字串", "", ""],
    ["只有換行", "\n\n", ""],
    ["開頭行的前導空白屬於內容（不是空行）", "  a", "  a"],
    ["結尾只去 \\n、不去行尾空白", "a  \n", "a  "],
  ])("%s", (_name, raw, want) => {
    expect(normalizeBody(raw)).toBe(want);
  });
});

describe("H2 bodyLines／lineKey／normalizeNumbered", () => {
  it("bodyLines：空字串 → []；否則 split", () => {
    expect(bodyLines("")).toEqual([]);
    expect(bodyLines("a")).toEqual(["a"]);
    expect(bodyLines("a\n\nb")).toEqual(["a", "", "b"]);
  });
  it("lineKey：trimEnd（空白、tab）", () => {
    expect(lineKey("a  ")).toBe("a");
    expect(lineKey("a\t \t")).toBe("a");
    expect(lineKey("  a")).toBe("  a");
  });
  it("normalizeNumbered：行首（可縮排）的數字編號換成 1.；行中的不動", () => {
    expect(normalizeNumbered("3. x")).toBe("1. x");
    expect(normalizeNumbered("   12. y")).toBe("   1. y");
    expect(normalizeNumbered("x 2. y")).toBe("x 2. y");
    expect(normalizeNumbered("1. z")).toBe("1. z");
    expect(normalizeNumbered("- 2. w")).toBe("- 2. w");
  });
});

describe("H3 HMAC＋鹽的行雜湊", () => {
  const key = deriveTransferKey("test-app-secret-0123456789abcdef");
  const saltA = Buffer.alloc(16, 0xa1);
  const saltB = Buffer.alloc(16, 0xb2);
  const hashOfLine = (h: Buffer, i: number) => h.subarray(i * LINE_HASH_BYTES, (i + 1) * LINE_HASH_BYTES).toString("hex");

  it("同一行在兩列（兩個 salt）雜湊不同；同一列內兩個相同行雜湊相同", () => {
    const lines = ["same line", "other", "same line"];
    const a = baseHashes(key, saltA, { body: lines.join("\n"), title: "T", lines, kinds: [0, 0, 0] });
    const b = baseHashes(key, saltB, { body: lines.join("\n"), title: "T", lines, kinds: [0, 0, 0] });
    expect(hashOfLine(a.lineHashes, 0)).not.toBe(hashOfLine(b.lineHashes, 0));
    expect(hashOfLine(a.lineHashes, 0)).toBe(hashOfLine(a.lineHashes, 2));
    expect(hashOfLine(a.lineHashes, 0)).not.toBe(hashOfLine(a.lineHashes, 1));
    expect(a.bodySha.equals(b.bodySha)).toBe(false);
    expect(a.titleSha.equals(b.titleSha)).toBe(false);
  });

  it("長度與形：lineHashes 每行 8 bytes；lineKinds 每行 1 byte；body／title 32 bytes", () => {
    const lines = ["a", "", "1. b", "c"];
    const h = baseHashes(key, saltA, { body: lines.join("\n"), title: "T", lines, kinds: [0, 0, 1, 0] });
    expect(LINE_HASH_BYTES).toBe(8);
    expect(h.lineHashes.length).toBe(8 * lines.length);
    expect([...h.lineKinds]).toEqual([0, 0, 1, 0]);
    expect(h.bodySha.length).toBe(32);
    expect(h.titleSha.length).toBe(32);
  });

  it("值＝HMAC-SHA256(K, salt ‖ x)：獨立算一次逐位元組相等（body 用傳入的已正規化本文、line 先 lineKey）", () => {
    const lines = ["x  ", "y"];
    const body = "x  \ny";
    const h = baseHashes(key, saltA, { body, title: "標題", lines, kinds: [0, 0] });
    const ref = (x: string) => createHmac("sha256", key).update(Buffer.concat([saltA, Buffer.from(x, "utf8")])).digest();
    expect(h.bodySha.equals(ref(body))).toBe(true);
    expect(h.titleSha.equals(ref("標題"))).toBe(true);
    expect(h.lineHashes.subarray(0, 8).equals(ref("x").subarray(0, 8))).toBe(true);
    expect(hmacOf(key, saltA, "y").equals(ref("y"))).toBe(true);
  });

  it("kind 1 的 3. x 與 1. x 雜湊相同；kind 0 的不同；行尾空白不影響", () => {
    const lines = ["3. x", "1. x", "3. x", "1. x", "a", "a \t"];
    const h = baseHashes(key, saltA, { body: lines.join("\n"), title: "T", lines, kinds: [1, 1, 0, 0, 0, 0] });
    expect(hashOfLine(h.lineHashes, 0)).toBe(hashOfLine(h.lineHashes, 1));
    expect(hashOfLine(h.lineHashes, 2)).not.toBe(hashOfLine(h.lineHashes, 3));
    expect(hashOfLine(h.lineHashes, 4)).toBe(hashOfLine(h.lineHashes, 5));
  });

  it("lines 與 kinds 長度不符 → 丟錯（呼叫端錯誤，不靜默截斷）", () => {
    expect(() => baseHashes(key, saltA, { body: "a", title: "T", lines: ["a"], kinds: [] })).toThrow();
  });
});

describe("H4 transferKeyId", () => {
  it("＝ sha256(sha256(`${APP_SECRET}:transfer-base`)) 前 8 hex；換 APP_SECRET 就不同", () => {
    const s = "test-app-secret-0123456789abcdef";
    const k = createHash("sha256").update(`${s}:transfer-base`).digest();
    expect(deriveTransferKey(s).equals(k)).toBe(true);
    expect(transferKeyId(deriveTransferKey(s))).toBe(createHash("sha256").update(k).digest("hex").slice(0, 8));
    expect(transferKeyId(deriveTransferKey(s))).toMatch(/^[0-9a-f]{8}$/);
    expect(transferKeyId(deriveTransferKey(s + "x"))).not.toBe(transferKeyId(deriveTransferKey(s)));
  });
});

describe("H5 newBaseKey／newSalt", () => {
  it("newBaseKey 是 16 hex（PR-2 的格式守衛靠它）、每次不同；newSalt 16 bytes", () => {
    const a = newBaseKey();
    const b = newBaseKey();
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(b).toMatch(/^[0-9a-f]{16}$/);
    expect(a).not.toBe(b);
    expect(newSalt().length).toBe(16);
    expect(newSalt().equals(newSalt())).toBe(false);
  });
});

describe("H6 writeNoteFile", () => {
  const fm = (title: string) => ({ id: "3f2c0e1a-0000-4000-8000-000000000001", title, role: "editor", base: "7d41c0b2e9a85f13", url: "/n/willie/meeting-notes" });

  it("8 行 frontmatter，鍵序逐字照 §6.4；本文原樣接上", () => {
    const out = writeNoteFile(fm("會議紀錄"), "# H\n\nbody  \n");
    expect(out).toBe(
      "---\nknotebook: 1\nid: 3f2c0e1a-0000-4000-8000-000000000001\ntitle: \"會議紀錄\"\nrole: editor\nbase: 7d41c0b2e9a85f13\nurl: /n/willie/meeting-notes\n---\n# H\n\nbody  \n",
    );
    expect(TRANSFER_FILE_VERSION).toBe(1);
    expect(writeNoteFile(fm("x"), "")).toBe(
      "---\nknotebook: 1\nid: 3f2c0e1a-0000-4000-8000-000000000001\ntitle: \"x\"\nrole: editor\nbase: 7d41c0b2e9a85f13\nurl: /n/willie/meeting-notes\n---\n",
    );
  });

  it.each([['"'], ["\\"], ["'"], ["#"], ["a: b"], ["-x"], ["😀 emoji"], ["line1\nline2"], ['a "b" \\c'], ["\u2028"]])("標題 %j 往返：title 行 JSON.parse 後逐字相等、仍單行", title => {
    const out = writeNoteFile(fm(title), "body");
    const lines = out.split("\n");
    expect(lines[0]).toBe("---");
    expect(lines[7]).toBe("---");
    expect(lines[8]).toBe("body");
    expect(lines.slice(1, 7).map(l => l.slice(0, l.indexOf(":")))).toEqual(["knotebook", "id", "title", "role", "base", "url"]);
    expect(lines[3]!.startsWith('title: "')).toBe(true);
    expect(JSON.parse(lines[3]!.slice("title: ".length))).toBe(title);
  });
});
