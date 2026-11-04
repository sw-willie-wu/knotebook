import { describe, expect, it } from "vitest";
import { BASE_WITHOUT_ID_MESSAGE, FRONTMATTER_SCAN_LINES, UNCLOSED_FRONT_MATTER_MESSAGE, parseScalar, readNoteFile, writeNoteFile } from "../../src/transfer/frontmatter.js";
import { normalizeBody } from "../../src/transfer/normalize.js";

/** bulk transfer spec §9.1（frontmatter 讀入、格式守衛、`title` 往返）；plan T2（F1–F8）。 */

const ID = "3f2c1e4a-5b6d-4c7e-8f90-a1b2c3d4e5f6";
const BASE = "0123456789abcdef";
const NUL = String.fromCodePoint(0);
const file = (fmLines: string[], body = "x") => ["---", ...fmLines, "---", body].join("\n");
const errOf = (r: ReturnType<typeof readNoteFile>) => (r.kind === "error" ? r.message : null);

describe("F1 往返：writeNoteFile → readNoteFile 逐字取回", () => {
  const titles = ['a"b', "back\\slash", "it's", "# hash", "key: value", "- dash", "emoji 😀 字", "two\nlines", "sep\u2028line", "  pad  "];
  it.each(titles.map(t => [JSON.stringify(t), t] as const))("title %s", (_l, title) => {
    const body = "# H\n\npara\n\n* a\n* b";
    const text = writeNoteFile({ id: ID, title, role: "owner", base: BASE, url: "/n/x" }, body);
    const r = readNoteFile(text);
    expect(r).toEqual({ kind: "existing", id: ID, base: BASE, title, body: normalizeBody(body) });
  });
});

describe("F2 三種讀法", () => {
  it.each([
    ["plain 去尾空白", "title: plain text  ", "plain text"],
    ["單引號 '' → '", "title: 'it''s'", "it's"],
    ["JSON 逸出", 'title: "a\\"b"', 'a"b'],
    ["JSON \\u 逸出", 'title: "\\u00e9"', "é"],
  ])("%s", (_n, line, want) => {
    const r = readNoteFile(file([`id: ${ID}`, `base: ${BASE}`, line]));
    expect(r.kind === "existing" && r.title).toBe(want);
  });
  it("未閉合的 JSON 字串 → error", () => {
    expect(errOf(readNoteFile(file([`id: ${ID}`, `base: ${BASE}`, 'title: "unterminated'])))).toBe("front matter 的 `title` 格式不對");
  });
  it("parseScalar 直接測", () => {
    expect(parseScalar("'a''b'")).toEqual({ ok: true, value: "a'b" });
    expect(parseScalar("'")).toEqual({ ok: true, value: "'" });
    expect(parseScalar('"x')).toEqual({ ok: false });
  });
});

describe("F3 辨識", () => {
  it("`knotebook:` 開頭的 frontmatter（沒 id）→ new", () => {
    expect(readNoteFile("---\nknotebook: 1\n---\nx")).toEqual({ kind: "new", title: undefined, folderId: undefined, body: "x" });
  });
  it("`id:` 行即可辨識", () => {
    expect(readNoteFile(`---\nid: ${ID}\nbase: ${BASE}\n---`).kind).toBe("existing");
  });
  it("分隔線開頭但沒有 knotebook:／id: → 整檔是本文", () => {
    const text = "---\ntitle: x\n---\nbody";
    expect(readNoteFile(text)).toEqual({ kind: "new", title: undefined, folderId: undefined, body: normalizeBody(text) });
  });
  it(`第 ${FRONTMATTER_SCAN_LINES} 行的 --- 算 frontmatter；第 ${FRONTMATTER_SCAN_LINES + 1} 行才出現 → 掃描範圍內沒有收尾 → 400（8000 探索測試 B）`, () => {
    const filler = (n: number) => Array.from({ length: n }, (_, i) => `x${i}: y`);
    // 1 起算：第 1 行 `---`、第 2 行 id、第 3 行 base、filler、第 N 行 `---`
    const at = (n: number) => ["---", `id: ${ID}`, `base: ${BASE}`, ...filler(n - 4), "---", "body"].join("\n");
    expect(readNoteFile(at(FRONTMATTER_SCAN_LINES)).kind).toBe("existing");
    const late = at(FRONTMATTER_SCAN_LINES + 1);
    expect(errOf(readNoteFile(late))).toBe(UNCLOSED_FRONT_MATTER_MESSAGE);
  });
  it("F3b（8000 探索測試 B）開頭 --- 與 knotebook:／id: 卻沒有收尾 → error；開頭 --- 但沒有 knotebook:／id:、也沒收尾 → 整檔是本文；開頭不是 --- → 本文", () => {
    expect(errOf(readNoteFile("---\nknotebook: 1\ntitle: T\nbody line"))).toBe(UNCLOSED_FRONT_MATTER_MESSAGE);
    expect(errOf(readNoteFile(`---\nid: ${ID}\nbase: ${BASE}\nbody`))).toBe(UNCLOSED_FRONT_MATTER_MESSAGE);
    const hr = "---\nplain text after a rule";
    expect(readNoteFile(hr)).toEqual({ kind: "new", title: undefined, folderId: undefined, body: normalizeBody(hr) });
    const notFirst = "text\n---\nknotebook: 1";
    expect(readNoteFile(notFirst)).toEqual({ kind: "new", title: undefined, folderId: undefined, body: normalizeBody(notFirst) });
  });
  it("tags 清單夾在中間照常讀", () => {
    const r = readNoteFile(file([`id: ${ID}`, "tags:", "  - a", "  - b", `base: ${BASE}`, 'title: "T"']));
    expect(r).toMatchObject({ kind: "existing", id: ID, base: BASE, title: "T" });
  });
});

describe("F4 必要鍵", () => {
  it("有 id 無 base → error", () => {
    expect(errOf(readNoteFile(file([`id: ${ID}`])))).toBe("有 id 的檔案必須有 base");
  });
  it.each([
    ["id 非 uuid", ["id: not-a-uuid", `base: ${BASE}`], "front matter 的 `id` 格式不對"],
    ["base 15 hex", [`id: ${ID}`, "base: 0123456789abcde"], "front matter 的 `base` 格式不對"],
    ["base 17 hex", [`id: ${ID}`, "base: 0123456789abcdef0"], "front matter 的 `base` 格式不對"],
    ["base 大寫 hex", [`id: ${ID}`, "base: 0123456789ABCDEF"], "front matter 的 `base` 格式不對"],
  ])("%s", (_n, fm, msg) => {
    expect(errOf(readNoteFile(file(fm)))).toBe(msg);
  });
  it("大寫 uuid 的 id → 接受並轉小寫", () => {
    expect(readNoteFile(file([`id: ${ID.toUpperCase()}`, `base: ${BASE}`]))).toMatchObject({ kind: "existing", id: ID });
  });
  it("N7（8000 探索測試）沒 id 有 base → error（不再當新檔、多建一篇）；只有 base 行也認得是 front matter", () => {
    expect(errOf(readNoteFile(file(["knotebook: 1", `base: ${BASE}`])))).toBe(BASE_WITHOUT_ID_MESSAGE);
    expect(errOf(readNoteFile(file([`base: ${BASE}`, 'title: "T"'])))).toBe(BASE_WITHOUT_ID_MESSAGE);
    // id 行認不出來（鍵名打錯）也一樣
    expect(errOf(readNoteFile(file(["knotebook: 1", `ld: ${ID}`, `base: ${BASE}`])))).toBe(BASE_WITHOUT_ID_MESSAGE);
    expect(BASE_WITHOUT_ID_MESSAGE).toBe("front matter 有 base 卻沒有 id：這是下載來的檔，請保留原本的 id 行再送");
  });
  it("N7（8000 探索測試）冒號前有空白或 tab：`id :`、`base :`、`title\\t:` 照常讀成既有筆記", () => {
    expect(readNoteFile(file(["knotebook: 1", `id : ${ID}`, `base : ${BASE}`, 'title\t: "T"']))).toEqual({ kind: "existing", id: ID, base: BASE, title: "T", body: "x" });
    // 只有 `id :` 能辨識的 front matter（沒有 knotebook 行）也認得
    expect(readNoteFile(file([`id  : ${ID}`, `base: ${BASE}`])).kind).toBe("existing");
    // 沒有收尾的 `id :` 也照 B 擋
    expect(errOf(readNoteFile(`---\nid : ${ID}\nbody`))).toBe(UNCLOSED_FRONT_MATTER_MESSAGE);
    expect(errOf(readNoteFile(`---\nbase: ${BASE}\nbody`))).toBe(UNCLOSED_FRONT_MATTER_MESSAGE);
    // 審查 M5：訊息照實寫出觸發條件（字面）
    expect(UNCLOSED_FRONT_MATTER_MESSAGE).toBe(
      "front matter 沒有結尾的 `---`：檔案開頭有 `---`，前 200 行內有 `knotebook:`、`id:` 或 `base:` 行（冒號前可以有空白），卻找不到收尾的 `---`",
    );
    expect(FRONTMATTER_SCAN_LINES).toBe(200);
  });
});

describe("F5 格式守衛（NUL、落單代理）", () => {
  it("本文含 NUL → error", () => {
    expect(errOf(readNoteFile(file([`id: ${ID}`, `base: ${BASE}`], `a${NUL}b`)))).toBe("檔案含 NUL 字元");
  });
  it.each([
    ["title JSON 逸出成 NUL", 'title: "\\u0000"', "title"],
    ["title JSON 逸出成落單代理", 'title: "\\ud800"', "title"],
  ])("%s → error", (_n, line, key) => {
    expect(errOf(readNoteFile(file([`id: ${ID}`, `base: ${BASE}`, line])))).toBe(`front matter 的 \`${key}\` 格式不對`);
  });
  it("base 的 JSON 值含 NUL → error", () => {
    expect(errOf(readNoteFile(file([`id: ${ID}`, 'base: "0123456789abcde\\u0000"'])))).toBe("front matter 的 `base` 格式不對");
  });
  it("folder_id 非 uuid → error", () => {
    expect(errOf(readNoteFile(file(["knotebook: 1", "folder_id: not-a-uuid"])))).toBe("front matter 的 `folder_id` 格式不對");
  });
  it("成對代理（emoji）不誤擋", () => {
    expect(readNoteFile(file([`id: ${ID}`, `base: ${BASE}`, 'title: "\\ud83d\\ude00"']))).toMatchObject({ title: "😀" });
  });
});

describe("F6 title", () => {
  it("沒有 title 行 → undefined", () => {
    expect(readNoteFile(file([`id: ${ID}`, `base: ${BASE}`]))).toMatchObject({ kind: "existing", title: undefined });
  });
  it.each([
    ['title: ""', 'title: ""'],
    ["title:（空 plain）", "title:"],
  ])("%s → error", (_n, line) => {
    expect(errOf(readNoteFile(file([`id: ${ID}`, `base: ${BASE}`, line])))).toBe("title 不能是空的");
  });
});

describe("F7 正規化", () => {
  it("CRLF＋BOM＋本文開頭兩行空行＋結尾 \\n\\n → body＝normalizeBody；CRLF 檔照樣辨識", () => {
    const raw = `\ufeff---\r\nid: ${ID}\r\nbase: ${BASE}\r\n---\r\n\r\n\r\nline1\r\nline2  \r\n\r\n`;
    expect(readNoteFile(raw)).toEqual({ kind: "existing", id: ID, base: BASE, title: undefined, body: "line1\nline2  " });
  });
});

describe("F8 重複鍵與大小寫", () => {
  it.each([
    ["兩行 title", [`id: ${ID}`, `base: ${BASE}`, 'title: "a"', 'title: "b"'], "title"],
    ["兩行 id", [`id: ${ID}`, `id: ${ID}`, `base: ${BASE}`], "id"],
  ])("%s → error", (_n, fm, key) => {
    expect(errOf(readNoteFile(file(fm)))).toBe(`front matter 的 \`${key}\` 重複`);
  });
  it("tags 重複 → 照常", () => {
    expect(readNoteFile(file([`id: ${ID}`, "tags: a", "tags: b", `base: ${BASE}`])).kind).toBe("existing");
  });
  it("folder_id 大寫 uuid → 回小寫", () => {
    expect(readNoteFile(file(["knotebook: 1", `folder_id: ${ID.toUpperCase()}`]))).toMatchObject({ kind: "new", folderId: ID });
  });
});
