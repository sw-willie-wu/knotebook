import { describe, expect, it } from "vitest";
import { BASE_WITHOUT_ID_MESSAGE, FRONTMATTER_SCAN_LINES, UNCLOSED_FRONT_MATTER_MESSAGE, parseScalar, readNoteFile, writeNoteFile } from "../../src/transfer/frontmatter.js";
import { normalizeBody } from "../../src/transfer/normalize.js";

const ID = "3f2c1e4a-5b6d-4c7e-8f90-a1b2c3d4e5f6";
const BASE = "0123456789abcdef";
const NUL = String.fromCodePoint(0);
const file = (fmLines: string[], body = "x") => ["---", ...fmLines, "---", body].join("\n");
const errOf = (r: ReturnType<typeof readNoteFile>) => (r.kind === "error" ? r.message : null);

describe("round trip: writeNoteFile -> readNoteFile returns it verbatim", () => {
  const titles = ['a"b', "back\\slash", "it's", "# hash", "key: value", "- dash", "emoji 😀 字", "two\nlines", "sep\u2028line", "  pad  "];
  it.each(titles.map(t => [JSON.stringify(t), t] as const))("title %s", (_l, title) => {
    const body = "# H\n\npara\n\n* a\n* b";
    const text = writeNoteFile({ id: ID, title, role: "owner", base: BASE, url: "/n/x", tags: [] }, body);
    const r = readNoteFile(text);
    expect(r).toEqual({ kind: "existing", id: ID, base: BASE, title, tags: [], body: normalizeBody(body) });
  });
  it("writeNoteFile puts tags right after title", () => {
    const text = writeNoteFile({ id: ID, title: "T", role: "owner", base: BASE, url: "/n/x", tags: ["影像", 'a"b'] }, "body");
    const lines = text.split("\n");
    expect(lines[3]).toBe('title: "T"');
    expect(lines[4]).toBe('tags: ["影像", "a\\"b"]');
    expect(lines[5]).toBe("role: owner");
    expect(readNoteFile(text)).toMatchObject({ kind: "existing", tags: ["影像", 'a"b'] });
  });
});

describe("tags", () => {
  const TAGS_MESSAGE = "The front matter's `tags` must be a JSON array of strings, like [\"a\", \"b\"].";
  it("reads tags from existing and new files; no tags line is undefined", () => {
    expect(readNoteFile(file([`id: ${ID}`, `base: ${BASE}`, 'tags: ["a", "B c"]']))).toMatchObject({ kind: "existing", tags: ["a", "B c"] });
    expect(readNoteFile(file(["knotebook: 1", "tags: []"]))).toMatchObject({ kind: "new", tags: [] });
    expect(readNoteFile(file(["knotebook: 1", 'tags: ["x"]']))).toMatchObject({ kind: "new", tags: ["x"] });
    expect(readNoteFile(file([`id: ${ID}`, `base: ${BASE}`]))).toMatchObject({ kind: "existing", tags: undefined });
    expect(readNoteFile(file(["knotebook: 1"]))).toMatchObject({ kind: "new", tags: undefined });
  });
  it("tags twice is an error", () => {
    expect(errOf(readNoteFile(file([`id: ${ID}`, 'tags: ["a"]', 'tags: ["b"]', `base: ${BASE}`])))).toBe("The front matter has `tags` more than once.");
  });
  it.each([["a YAML list", ["tags:", "  - a"]], ["bare words", ["tags: a, b"]], ["numbers", ["tags: [1]"]]])("%s is an error with the fixed message", (_n, lines) => {
    expect(errOf(readNoteFile(file([`id: ${ID}`, ...lines, `base: ${BASE}`])))).toBe(TAGS_MESSAGE);
  });
  it("a tags line without a knotebook:/id:/base: line is body text", () => {
    const text = '---\ntags: ["a"]\n---\nbody';
    expect(readNoteFile(text)).toEqual({ kind: "new", title: undefined, folderId: undefined, body: normalizeBody(text) });
  });
});

describe("three ways to read a title", () => {
  it.each([
    ["plain, trailing whitespace removed", "title: plain text  ", "plain text"],
    ["single quote '' -> '", "title: 'it''s'", "it's"],
    ["JSON escape", 'title: "a\\"b"', 'a"b'],
    ["JSON unicode escape", 'title: "\\u00e9"', "é"],
  ])("%s", (_n, line, want) => {
    const r = readNoteFile(file([`id: ${ID}`, `base: ${BASE}`, line]));
    expect(r.kind === "existing" && r.title).toBe(want);
  });
  it("unterminated JSON string -> error", () => {
    expect(errOf(readNoteFile(file([`id: ${ID}`, `base: ${BASE}`, 'title: "unterminated'])))).toBe("The front matter's `title` is malformed.");
  });
  it("parseScalar directly", () => {
    expect(parseScalar("'a''b'")).toEqual({ ok: true, value: "a'b" });
    expect(parseScalar("'")).toEqual({ ok: true, value: "'" });
    expect(parseScalar('"x')).toEqual({ ok: false });
  });
});

describe("recognition", () => {
  it("front matter starting with `knotebook:` (no id) -> new", () => {
    expect(readNoteFile("---\nknotebook: 1\n---\nx")).toEqual({ kind: "new", title: undefined, folderId: undefined, body: "x" });
  });
  it("an `id:` line is enough to recognise it", () => {
    expect(readNoteFile(`---\nid: ${ID}\nbase: ${BASE}\n---`).kind).toBe("existing");
  });
  it("starts with a separator but has no knotebook:/id: -> the whole file is body", () => {
    const text = "---\ntitle: x\n---\nbody";
    expect(readNoteFile(text)).toEqual({ kind: "new", title: undefined, folderId: undefined, body: normalizeBody(text) });
  });
  it(`a --- on line ${FRONTMATTER_SCAN_LINES} counts as front matter; one first appearing on line ${FRONTMATTER_SCAN_LINES + 1} -> no closing within the scan range -> 400`, () => {
    const filler = (n: number) => Array.from({ length: n }, (_, i) => `x${i}: y`);
    // 1-based: line 1 `---`, line 2 id, line 3 base, filler, line N `---`
    const at = (n: number) => ["---", `id: ${ID}`, `base: ${BASE}`, ...filler(n - 4), "---", "body"].join("\n");
    expect(readNoteFile(at(FRONTMATTER_SCAN_LINES)).kind).toBe("existing");
    const late = at(FRONTMATTER_SCAN_LINES + 1);
    expect(errOf(readNoteFile(late))).toBe(UNCLOSED_FRONT_MATTER_MESSAGE);
  });
  it("opening --- with knotebook:/id: but no closing -> error; opening --- without knotebook:/id: and no closing -> the whole file is body; not starting with --- -> body", () => {
    expect(errOf(readNoteFile("---\nknotebook: 1\ntitle: T\nbody line"))).toBe(UNCLOSED_FRONT_MATTER_MESSAGE);
    expect(errOf(readNoteFile(`---\nid: ${ID}\nbase: ${BASE}\nbody`))).toBe(UNCLOSED_FRONT_MATTER_MESSAGE);
    const hr = "---\nplain text after a rule";
    expect(readNoteFile(hr)).toEqual({ kind: "new", title: undefined, folderId: undefined, body: normalizeBody(hr) });
    const notFirst = "text\n---\nknotebook: 1";
    expect(readNoteFile(notFirst)).toEqual({ kind: "new", title: undefined, folderId: undefined, body: normalizeBody(notFirst) });
  });
  it("a tags line in the middle is read as usual", () => {
    const r = readNoteFile(file([`id: ${ID}`, 'tags: ["a", "b"]', `base: ${BASE}`, 'title: "T"']));
    expect(r).toMatchObject({ kind: "existing", id: ID, base: BASE, title: "T", tags: ["a", "b"] });
  });
});

describe("required keys", () => {
  it("id without base -> error", () => {
    expect(errOf(readNoteFile(file([`id: ${ID}`])))).toBe("A file with an id must also have a base.");
  });
  it.each([
    ["id is not a uuid", ["id: not-a-uuid", `base: ${BASE}`], "The front matter's `id` is malformed."],
    ["base 15 hex", [`id: ${ID}`, "base: 0123456789abcde"], "The front matter's `base` is malformed."],
    ["base 17 hex", [`id: ${ID}`, "base: 0123456789abcdef0"], "The front matter's `base` is malformed."],
    ["base is upper-case hex", [`id: ${ID}`, "base: 0123456789ABCDEF"], "The front matter's `base` is malformed."],
  ])("%s", (_n, fm, msg) => {
    expect(errOf(readNoteFile(file(fm)))).toBe(msg);
  });
  it("upper-case uuid id -> accepted and lower-cased", () => {
    expect(readNoteFile(file([`id: ${ID.toUpperCase()}`, `base: ${BASE}`]))).toMatchObject({ kind: "existing", id: ID });
  });
  it("no id but base -> error (no longer treated as a new file, which would create an extra note); a base line alone is also recognised as front matter", () => {
    expect(errOf(readNoteFile(file(["knotebook: 1", `base: ${BASE}`])))).toBe(BASE_WITHOUT_ID_MESSAGE);
    expect(errOf(readNoteFile(file([`base: ${BASE}`, 'title: "T"'])))).toBe(BASE_WITHOUT_ID_MESSAGE);
    // same when the id line is not recognised (key misspelled)
    expect(errOf(readNoteFile(file(["knotebook: 1", `ld: ${ID}`, `base: ${BASE}`])))).toBe(BASE_WITHOUT_ID_MESSAGE);
    expect(BASE_WITHOUT_ID_MESSAGE).toBe("The front matter has a base but no id. This is a downloaded file: keep its original id line and send it again.");
  });
  it("whitespace or tab before the colon: `id :`, `base :`, `title\\t:` are still read as an existing note", () => {
    expect(readNoteFile(file(["knotebook: 1", `id : ${ID}`, `base : ${BASE}`, 'title\t: "T"']))).toEqual({ kind: "existing", id: ID, base: BASE, title: "T", body: "x" });
    // front matter recognisable only through `id :` (no knotebook line) is also recognised
    expect(readNoteFile(file([`id  : ${ID}`, `base: ${BASE}`])).kind).toBe("existing");
    // an unterminated `id :` is also rejected
    expect(errOf(readNoteFile(`---\nid : ${ID}\nbody`))).toBe(UNCLOSED_FRONT_MATTER_MESSAGE);
    expect(errOf(readNoteFile(`---\nbase: ${BASE}\nbody`))).toBe(UNCLOSED_FRONT_MATTER_MESSAGE);
    // the message states the triggering condition literally
    expect(UNCLOSED_FRONT_MATTER_MESSAGE).toBe(
      "The front matter has no closing `---`: the file starts with `---` and has a `knotebook:`, `id:` or `base:` line (spaces allowed before the colon) in its first 200 lines, but no `---` line closes it.",
    );
    expect(FRONTMATTER_SCAN_LINES).toBe(200);
  });
});

describe("format guards (NUL, lone surrogates)", () => {
  it("body containing NUL -> error", () => {
    expect(errOf(readNoteFile(file([`id: ${ID}`, `base: ${BASE}`], `a${NUL}b`)))).toBe("The file contains a NUL character.");
  });
  it.each([
    ["title JSON-escaped to NUL", 'title: "\\u0000"', "title"],
    ["title JSON-escaped to a lone surrogate", 'title: "\\ud800"', "title"],
  ])("%s -> error", (_n, line, key) => {
    expect(errOf(readNoteFile(file([`id: ${ID}`, `base: ${BASE}`, line])))).toBe(`The front matter's \`${key}\` is malformed.`);
  });
  it("base's JSON value contains NUL -> error", () => {
    expect(errOf(readNoteFile(file([`id: ${ID}`, 'base: "0123456789abcde\\u0000"'])))).toBe("The front matter's `base` is malformed.");
  });
  it("folder_id is not a uuid -> error", () => {
    expect(errOf(readNoteFile(file(["knotebook: 1", "folder_id: not-a-uuid"])))).toBe("The front matter's `folder_id` is malformed.");
  });
  it("paired surrogates (emoji) are not wrongly rejected", () => {
    expect(readNoteFile(file([`id: ${ID}`, `base: ${BASE}`, 'title: "\\ud83d\\ude00"']))).toMatchObject({ title: "😀" });
  });
});

describe("title", () => {
  it("no title line -> undefined", () => {
    expect(readNoteFile(file([`id: ${ID}`, `base: ${BASE}`]))).toMatchObject({ kind: "existing", title: undefined });
  });
  it.each([
    ['title: ""', 'title: ""'],
    ["title: (empty plain)", "title:"],
  ])("%s -> error", (_n, line) => {
    expect(errOf(readNoteFile(file([`id: ${ID}`, `base: ${BASE}`, line])))).toBe("The front matter's `title` can't be empty.");
  });
});

describe("normalisation", () => {
  it("CRLF + BOM + two blank lines at the start of the body + trailing blank lines -> body = normalizeBody; a CRLF file is still recognised", () => {
    const raw = `\ufeff---\r\nid: ${ID}\r\nbase: ${BASE}\r\n---\r\n\r\n\r\nline1\r\nline2  \r\n\r\n`;
    expect(readNoteFile(raw)).toEqual({ kind: "existing", id: ID, base: BASE, title: undefined, body: "line1\nline2  " });
  });
});

describe("duplicate keys and case", () => {
  it.each([
    ["two title lines", [`id: ${ID}`, `base: ${BASE}`, 'title: "a"', 'title: "b"'], "title"],
    ["two id lines", [`id: ${ID}`, `id: ${ID}`, `base: ${BASE}`], "id"],
  ])("%s -> error", (_n, fm, key) => {
    expect(errOf(readNoteFile(file(fm)))).toBe(`The front matter has \`${key}\` more than once.`);
  });
  it("upper-case uuid folder_id -> returned lower-cased", () => {
    expect(readNoteFile(file(["knotebook: 1", `folder_id: ${ID.toUpperCase()}`]))).toMatchObject({ kind: "new", folderId: ID });
  });
});
