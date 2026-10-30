// 讀路徑 markdown 的 golden（spec §11.2 末段、§13.1）：同一份 blocks 在 server 與 web（PR-2 Task 5）讀出逐位元組相同。
// 輸入一律先寫進編輯器，再拿 `ed.document`（完整 blocks，與真實讀路徑同形）去序列化——external HTML 的 data-* 順序跟著 props 鍵序走。
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { parseMarkdownForNote } from "../../src/notes/editing/markdown.js";
import { COLUMNS_OPEN_TAG, blocksToNoteMarkdown, columnOpenTag } from "@knotebook/shared";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" }); rt.installGlobals();
type Ed = EditorSession["editor"];

// ⚠ 同 editing-colors.test.ts：每一處 open 都 `try/finally close()`（lease 不變量）。
const withSession = async <T>(fn: (ed: Ed) => T, doc = new Y.Doc()): Promise<T> => {
  const s = await EditorSession.open(rt, doc);
  try {
    return fn(s.editor);
  } finally {
    s.close();
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組
type AnyBlocks = any[];
const docWith = async (blocks: AnyBlocks): Promise<Y.Doc> => {
  const doc = new Y.Doc();
  await withSession(ed => {
    ed.replaceBlocks(ed.document, blocks);
  }, doc);
  return doc;
};

const ROUND_TRIPS = ["exact", "text", "skip", "reject:unsupported_columns"] as const;
type GoldenCase = { id: string; roundTrip: (typeof ROUND_TRIPS)[number]; note?: string; blocks: AnyBlocks; markdown: string };
const goldens = JSON.parse(readFileSync(new URL("../../../../packages/shared/test-fixtures/note-markdown-goldens.json", import.meta.url), "utf8")) as { cases: GoldenCase[] };
const byId = (id: string): GoldenCase => {
  const c = goldens.cases.find(x => x.id === id);
  if (!c) throw new Error(`no golden ${id}`);
  return c;
};
const count = (s: string, sub: string) => s.split(sub).length - 1;

describe("note-markdown goldens（讀出）", () => {
  it("id 不重複、roundTrip 是已知值", () => {
    const ids = goldens.cases.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of goldens.cases) expect(ROUND_TRIPS, c.id).toContain(c.roundTrip);
  });

  it.each(goldens.cases.map(c => [c.id, c] as const))("%s", async (_id, c) => {
    const doc = await docWith(c.blocks);
    const md = await withSession(ed => blocksToNoteMarkdown(ed, ed.document), doc);
    expect(md, `${c.id} 實際：${JSON.stringify(md)}`).toBe(c.markdown);
  });

  // spec §11.1 規則 1–7：列的 markdown＝外層行＋各欄（開標籤、空行、欄內容單獨序列化、空行、</div>）＋ </div>。
  it.each(["G1-cols-3", "G1-cols-4", "G1-cols-mixed"])("GC：%s 由欄內容單獨序列化組出", async id => {
    const c = byId(id);
    const doc = await docWith(c.blocks);
    const expected = await withSession(ed => {
      const lines = [COLUMNS_OPEN_TAG];
      for (const col of ed.document[0].children) {
        lines.push(columnOpenTag(col.props.width as number), "");
        const inner = blocksToNoteMarkdown(ed, col.children).replace(/\n+$/, "");
        if (inner !== "") lines.push(inner, "");
        lines.push("</div>");
      }
      lines.push("</div>");
      return lines.join("\n") + "\n";
    }, doc);
    expect(expected).toBe(c.markdown);
  });

  it.each<[string, (md: string) => void]>([
    ["G1-cols-empty", md => expect(md).toContain('<div data-kb-column style="flex:1">\n\n</div>\n</div>')],
    ["G1-cols-5", md => expect(count(md, "<div data-kb-column ")).toBe(5)],
    ["G1-row-in-column", md => {
      expect(count(md, "data-kb-columns")).toBe(1);
      expect(count(md, "<div data-kb-column ")).toBe(2);
      expect(md).toContain('<p data-background-color="yellow">y</p>');
    }],
    ["G1-row-under-paragraph", md => expect(md).not.toContain("data-kb-")],
    ["G2-img-in-toggle-heading", md => {
      expect(md.trimEnd()).not.toContain("\n");
      expect(md).toContain('<figure><img alt="n" src="/api/uploads/00000000-0000-4000-8000-000000000001" width="300"></figure>');
      expect(md).not.toMatch(/data-preview-width|data-name/);
    }],
    ["G3-table-colwidth", md => {
      const [first, ...rest] = md.split("</tr>");
      expect(first).toContain('colwidth="120"');
      expect(first).toContain('colwidth="240"');
      expect(rest.join("")).not.toContain("colwidth");
      expect(md).not.toMatch(/colgroup|tbody/);
    }],
    ["G3-table-colspan-partial", md => expect(md).toContain('colspan="2" colwidth="120,"')],
    ["G3-table-colored-merged", md => expect(count(md, 'colwidth=","')).toBe(2)],
  ])("規則斷言：%s", (id, check) => check(byId(id).markdown));

  it("G0-control：只有加了欄寬的表格變 HTML，其餘段落逐字同 G0-plain", () => {
    const plain = byId("G0-plain").markdown.split("\n\n");
    const ctl = byId("G0-control").markdown.split("\n\n");
    const ti = plain.findIndex(s => s.startsWith("| h1"));
    expect(ti).toBeGreaterThan(-1);
    expect(ctl).toHaveLength(plain.length);
    expect(ctl[ti]).toMatch(/^<table>/);
    expect(ctl.filter((_, i) => i !== ti)).toEqual(plain.filter((_, i) => i !== ti));
  });

  // gate r2 Important-1：#222 以來經 MCP 往返存下的 NaN 欄寬（JSON 寫不出 NaN，以程式造）。
  it("G3-nan-legacy：既存 NaN 欄寬讀成空段，與 G3-table-colored-merged 逐字相同", async () => {
    const base = byId("G3-table-colored-merged");
    const blocks = structuredClone(base.blocks);
    blocks[0].content.columnWidths = [NaN, NaN, undefined];
    const doc = await docWith(blocks);
    const [html, md] = await withSession(ed => [ed.blocksToHTMLLossy(ed.document), blocksToNoteMarkdown(ed, ed.document)], doc);
    expect(html).toContain('colwidth="NaN,NaN"');
    expect(md).not.toContain("NaN");
    expect(count(md, 'colwidth=","')).toBe(2);
    expect(md).toBe(base.markdown);
  });
});

// spec §13.1 round-trip：每個 golden 的 markdown 原樣寫回（parseMarkdownForNote，候選清單一律 []，與讀出端不轉換一致）→ 寫進新文件 → 再讀。
const ORIGIN = "http://localhost";
/** 去掉 id 的 block JSON。 */
const shape = (blocks: unknown): string => JSON.stringify(blocks, (k, v) => (k === "id" ? undefined : v));
const writeBack = (md: string) => withSession(ed => parseMarkdownForNote(ed, md, [], ORIGIN));
/** blocks 經真編輯器寫進新文件，回讀出的 markdown 與 `ed.document`。 */
const readBack = async (blocks: AnyBlocks) => withSession(ed => [blocksToNoteMarkdown(ed, ed.document), ed.document] as const, await docWith(blocks));
const accepted = (id: string, r: Awaited<ReturnType<typeof writeBack>>): AnyBlocks => {
  if ("error" in r) throw new Error(`${id} 寫回被拒：${r.error}`);
  return r.blocks;
};

describe("note-markdown goldens（原樣寫回 RT）", () => {
  it.each(goldens.cases.map(c => [c.id, c] as const))("RT %s", async (_id, c) => {
    const r = await writeBack(c.markdown);
    if (c.roundTrip.startsWith("reject:")) {
      expect(r).toEqual({ error: c.roundTrip.slice("reject:".length) });
      return;
    }
    const [md2, doc2] = await readBack(accepted(c.id, r));
    if (c.roundTrip === "skip") {
      // 攤平類（不合法結構、pipe table 的合併格）不要求等於原文，但寫回一次就收斂：md2 再寫回、再讀仍是 md2
      const [md3] = await readBack(accepted(`${c.id}（第二輪）`, await writeBack(md2)));
      expect(md3, `${c.id} 第二輪：${JSON.stringify(md3)}`).toBe(md2);
      return;
    }
    expect(md2, `${c.id} 再讀：${JSON.stringify(md2)}`).toBe(c.markdown);
    if (c.roundTrip === "exact") {
      const [, docOrig] = await readBack(c.blocks);
      expect(shape(doc2)).toBe(shape(docOrig));
    }
  });

  it("RT G3-nan-legacy：既存 NaN 欄寬的讀出原樣寫回被接受，再讀的 markdown 與結構同 G3-table-colored-merged", async () => {
    const base = byId("G3-table-colored-merged");
    const blocks = structuredClone(base.blocks);
    blocks[0].content.columnWidths = [NaN, NaN, undefined];
    const [md1] = await readBack(blocks);
    const [md2, doc2] = await readBack(accepted("G3-nan-legacy", await writeBack(md1)));
    expect(md2).toBe(base.markdown);
    const [, docBase] = await readBack(base.blocks);
    expect(shape(doc2)).toBe(shape(docBase));
  });

  it("RT G2-img-escape：寫回的 name、caption、url 逐字等於原值", async () => {
    const c = byId("G2-img-escape");
    const p = accepted(c.id, await writeBack(c.markdown))[0].props;
    const o = c.blocks[0].props;
    expect([p.name, p.caption, p.url]).toEqual([o.name, o.caption, o.url]);
  });
});
