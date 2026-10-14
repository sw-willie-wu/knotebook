import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { MAX_BLOCKS, parseMarkdownForNote } from "../../src/notes/editing/markdown.js";
import { readNoteContentFromDoc } from "../../src/notes/editing/read.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" }); rt.installGlobals();
const ORIGIN = "http://localhost";
const GID = "99999999-9999-4999-8999-999999999999";
/** 寫入者的可見清單（#269：帶 slug／groupId／ownerHandle，站內網址比對用）。 */
const notes = [
  { id: "11111111-1111-4111-8111-111111111111", title: "A", slug: "a", groupId: null, ownerHandle: "alice" },
  { id: "22222222-2222-4222-8222-222222222222", title: "Group Doc", slug: "plan", groupId: GID, ownerHandle: null },
];

// ⚠ 每一處 `EditorSession.open` 都要 `try { … } finally { s.close() }`：`close()` 是唯一釋放 runtime
// lease 的路徑，這裡的 `rt` 又是模組層共用的，回呼一 throw 就永久佔掉一個 in-flight 名額
// （`session.ts` 的 m3 不變量）。**斷言失敗本身就是 throw**，所以「先 close 再 expect」不是替代方案。
const withSession = async (fn: (ed: EditorSession["editor"]) => void) => {
  const s = await EditorSession.open(rt, new Y.Doc());
  try {
    fn(s.editor);
  } finally {
    s.close();
  }
};

describe("parseMarkdownForNote", () => {
  it("wikilink 重綁、mermaid 還原、unbound 計數", async () => {
    await withSession(ed => {
      const r = parseMarkdownForNote(ed, "x [[A]] [[B]]\n\n```mermaid\ngraph TD\n```", notes, ORIGIN);
      if ("error" in r) throw new Error(r.error);
      expect(r.unbound).toBe(1);
      expect(r.blocks.map(b => b.type)).toEqual(["paragraph", "mermaid"]);
    });
  });
  it("空／純空白 → empty_content；> MAX_BLOCKS → too_many_blocks", async () => {
    await withSession(ed => {
      expect(parseMarkdownForNote(ed, "   \n  \n", notes, ORIGIN)).toEqual({ error: "empty_content" });
      expect(parseMarkdownForNote(ed, Array.from({ length: MAX_BLOCKS + 1 }, (_, i) => `p${i}`).join("\n\n"), notes, ORIGIN)).toEqual({ error: "too_many_blocks" });
    });
  });
  it("未知型別整筆拒絕（不靜默剝除）", async () => {
    await withSession(ed => {
      const r = parseMarkdownForNote(ed, "<custom-widget>x</custom-widget>", notes, ORIGIN);
      // BlockNote 對未知 HTML 元素通常降級為 paragraph；本案釘住「若 parse 產出的 type 不在 schema
      // 白名單 → unsupported_block」，用收窄白名單的假 editor 來驗。真 schema ＝ defaultBlockSpecs
      // 全集＋mermaid／codeBlock（見 shared 的 createHeadlessNoteSchema），markdown/HTML parser 產得
      // 出來的 type 一定在裡面——所以**整合層造不出這個碼**，那邊的清單要誠實寫明不驗，別硬塞。
      const narrowed = { ...ed, schema: { blockSchema: { paragraph: ed.schema.blockSchema.paragraph } }, tryParseMarkdownToBlocks: ed.tryParseMarkdownToBlocks.bind(ed) } as unknown as typeof ed;
      expect(parseMarkdownForNote(narrowed, "# heading", notes, ORIGIN)).toEqual({ error: "unsupported_block" });
      expect("error" in r ? r.error : "ok").not.toBe("unsupported_block"); // 真 schema 下純 HTML 不會炸成 500
    });
  });

  // ── href 的 scheme 過濾（issue #153）──────────────────────────────────────
  //
  // `parseMarkdownForNote` 的白名單只驗 **block** 型別、不看 inline content，所以
  // `link` 一路通過；擋掉 `javascript:`／`data:` 的**唯一**那道防線是 `@blocknote/core`
  // 內嵌 Tiptap Link extension 的預設 `isValidLink` 正則（它的 `parseHTML.getAttrs`
  // 對不合法的 href 回 `false` ⇒ mark 不成立 ⇒ 退化成純文字）。而那是一個**可被覆寫
  // 的 option**，`packages/shared/src/note-schema-config.ts` 對 `link` 零額外守衛
  // （對照 `image`／`audio`／`video`／`file` 都被 `withGuardedExternalHTML` 包過）。
  // 升級套件或換掉 markdown 解析器，這道防線會**無聲**消失——這一案就是釘住它。
  describe("href 的 scheme 過濾（唯一防線在上游，這裡是它的守衛）", () => {
    /** 遞迴收集所有 inline content 的 type（`{ type, href }` 形，方便正向對照比值）。 */
    const inlines = (blocks: unknown[]): Array<{ type: string; href?: unknown }> =>
      (blocks as Array<{ content?: unknown; children?: unknown[] }>).flatMap(b => [
        ...(Array.isArray(b.content) ? (b.content as Array<{ type: string; href?: unknown }>) : []),
        ...(Array.isArray(b.children) ? inlines(b.children) : []),
      ]);

    // 正向對照證明「抽 link 的取值路徑是對的」：少了它，下面「沒有 link 存活」那兩句
    // 會在 `inlines()` 寫壞成恆回空陣列時照樣全綠。
    // ⚠ 別把理由寫成「必須排在前面、否則失敗後跑不到」——那是假的：vitest 預設
    // `bail: 0`，一個 `it` 失敗不會中止其他 `it`（實測弄壞 `inlines()` 時，這條與下面
    // 兩個 it.each 列**全部照跑照紅**）。只有**同一個 `it` 內**的斷言才會在第一個失敗
    // 處中止。排在前面純粹是給讀的人的順序，不是它有鑑別力的條件。
    it("正向對照：合法的 https 連結真的變成 link，href 一字不差", async () => {
      await withSession(ed => {
        const r = parseMarkdownForNote(ed, "[x](https://example.com)", notes, ORIGIN);
        if ("error" in r) throw new Error(r.error);
        const links = inlines(r.blocks).filter(c => c.type === "link");
        expect(links).toHaveLength(1);
        expect(links[0]!.href).toBe("https://example.com");
      });
    });

    it.each([
      ["javascript:", "[x](javascript:alert(1))"],
      ["data:", "[x](data:text/html,evil)"],
    ])("%s 的 href 不會產出任何 link inline content（退化成純文字）", async (_scheme, markdown) => {
      await withSession(ed => {
        const r = parseMarkdownForNote(ed, markdown, notes, ORIGIN);
        if ("error" in r) throw new Error(r.error);
        const content = inlines(r.blocks);
        expect(content.filter(c => c.type === "link")).toEqual([]);
        // 文字本身要還在（確認是「退化成純文字」而不是「整段被吃掉」——後者會讓
        // 上面那句恆真）。
        expect(content.some(c => c.type === "text")).toBe(true);
      });
    });
  });

  // ── http(s) 連結會開新分頁（issue #153）──────────────────────────────────
  //
  // 同一個風險模型的另一半。編輯器只給 `http(s)` 連結加「開新分頁」圖示
  // （`apps/web/src/index.css`），那個標示之所以為真，**唯一**的依據是
  // `@blocknote/core` 的 Link extension 在 `addOptions().HTMLAttributes` 裡**靜態**寫著
  // `target: "_blank"`——我們沒有覆寫它，也沒有任何地方複述它（全樹 grep `_blank` 只有
  // 註解與無關的 Yjs fixture）。上游哪天把它改成條件式，圖示就開始對使用者說謊，而在
  // 這一案之前**不會有任何測試變紅**。
  it("http(s) 連結匯出的 HTML 帶 target=\"_blank\"——圖示語意的唯一依據", async () => {
    await withSession(ed => {
      const r = parseMarkdownForNote(ed, "[abs](https://example.com/p)", notes, ORIGIN);
      if ("error" in r) throw new Error(r.error);
      const html = ed.blocksToHTMLLossy(r.blocks);
      // 先確認這一輪真的產出了 anchor——否則下面那句會在「根本沒有連結」時恆假／
      // 誤導（同上面正向對照的理由）。
      expect(html, `沒有變成 link：${html}`).toContain('href="https://example.com/p"');
      expect(html, `連結沒有 target="_blank"，「開新分頁」圖示的標示就不成立：${html}`).toContain(
        'target="_blank"',
      );
    });
  });

  describe("#269 站內連結 → wikilink（§8.5、§9.2）", () => {
    const wl = (r: ReturnType<typeof parseMarkdownForNote>) => {
      if ("error" in r) throw new Error(r.error);
      return r.blocks;
    };
    it("三形（/notes/<id>、/n/、/g/）相對與同 origin 絕對、帶 #b- 錨點 → wikilink；label 規則；unbound 不計站內連結", async () => {
      await withSession(ed => {
        const r = parseMarkdownForNote(
          ed,
          `[A](/notes/11111111-1111-4111-8111-111111111111) [自訂](${ORIGIN}/n/alice/a#b-h1) [x](/g/${GID}/plan) [[A]]`,
          notes,
          ORIGIN,
        );
        if ("error" in r) throw new Error(r.error);
        expect(r.unbound).toBe(0);
        const content = (r.blocks[0] as { content: Array<{ type: string; props?: Record<string, string> }> }).content.filter(n => n.type === "wikilink");
        expect(content.map(n => n.props)).toEqual([
          { targetNoteId: "11111111-1111-4111-8111-111111111111", snapshotTitle: "A", label: "", anchorBlockId: "" },
          { targetNoteId: "11111111-1111-4111-8111-111111111111", snapshotTitle: "自訂", label: "自訂", anchorBlockId: "h1" },
          { targetNoteId: "22222222-2222-4222-8222-222222222222", snapshotTitle: "x", label: "x", anchorBlockId: "" },
          { targetNoteId: "11111111-1111-4111-8111-111111111111", snapshotTitle: "A" },
        ]);
      });
    });

    it("寫入者看不到的目標、看不到的群組、舊 slug、帶 query、#/ fragment、/p/ → 維持一般連結（不計 unbound）", async () => {
      await withSession(ed => {
        const r = parseMarkdownForNote(
          ed,
          [
            "[n](/notes/33333333-3333-4333-8333-333333333333)",
            `[g](/g/88888888-8888-4888-8888-888888888888/plan)`,
            "[old](/n/alice/old-slug)",
            "[q](/n/alice/a?present)",
            "[s](/n/alice/a#/slide)",
            "[p](/p/alice/a)",
          ].join(" "),
          notes,
          ORIGIN,
        );
        if ("error" in r) throw new Error(r.error);
        expect(r.unbound).toBe(0);
        const types = (r.blocks[0] as { content: Array<{ type: string }> }).content.filter(n => n.type !== "text").map(n => n.type);
        expect(types).toEqual(["link", "link", "link", "link", "link", "link"]);
      });
    });

    it("表格裡的站內連結與 [[…]] 都綁；表格裡找不到的 [[…]] 計入 unbound", async () => {
      await withSession(ed => {
        const blocks = wl(parseMarkdownForNote(ed, "| a | b |\n| --- | --- |\n| [x](/n/alice/a) | [[A]] [[Nope]] |", notes, ORIGIN));
        const table = blocks[0] as { type: string; content: { rows: Array<{ cells: unknown[] }> } };
        expect(table.type).toBe("table");
        const body = JSON.stringify(table.content.rows);
        expect(body).toContain('"type":"wikilink"');
        expect(body.match(/"type":"wikilink"/g)).toHaveLength(2);
        const r = parseMarkdownForNote(ed, "| a |\n| --- |\n| [[Nope]] |", notes, ORIGIN);
        if ("error" in r) throw new Error(r.error);
        expect(r.unbound).toBe(1);
      });
    });
  });
});

// #269 Task 6 RF1：讀出（readNoteContentFromDoc → wikilinksToLinks〔不跳脫〕→ colors.ts 的 markdown 分支以 `escapeLinkText`
// 跳脫站內連結文字、上色區塊的原始 HTML 分支不跳脫 → BlockNote markdown）再寫回（parseMarkdownForNote）的往返——BlockNote 的
// 匯出本身不跳脫文字；這裡用真編輯器量往返結果。
describe("#269 RF1：wikilink 讀出→寫回，label 逐字相同（段落與表格 cell）", () => {
  const ID = notes[0]!.id;
  const wlNode = (label: string) => ({ type: "wikilink", props: { targetNoteId: ID, snapshotTitle: "snap", label, anchorBlockId: "" } });
  const docWith = async (blocks: unknown[]) => {
    const doc = new Y.Doc();
    const s = await EditorSession.open(rt, doc);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 泛型三元組
      s.editor.replaceBlocks(s.editor.document, blocks as any);
    } finally {
      s.close();
    }
    return doc;
  };
  const readMd = async (doc: Y.Doc) => {
    const r = await readNoteContentFromDoc(rt, doc);
    if (r === "section_not_found" || !("markdown" in r)) throw new Error("unexpected shape");
    return r.markdown;
  };
  const labelsOf = (blocks: unknown) => [...JSON.stringify(blocks).matchAll(/"label":("(?:[^"\\]|\\.)*")/g)].map(m => JSON.parse(m[1]!) as string);

  /** 讀出 → 寫回 → 再讀出 → 再寫回：兩輪的 label 都要等於原值，第二輪的 markdown 與第一輪位元組相同（反斜線不累積）。 */
  const roundTripTwice = async (blocks: unknown[]) => {
    const md1 = await readMd(await docWith(blocks));
    let back1: unknown[] = [];
    await withSession(ed => {
      const r = parseMarkdownForNote(ed, md1, notes, ORIGIN);
      if ("error" in r) throw new Error(r.error);
      back1 = r.blocks;
    });
    const md2 = await readMd(await docWith(back1));
    let back2: unknown[] = [];
    await withSession(ed => {
      const r = parseMarkdownForNote(ed, md2, notes, ORIGIN);
      if ("error" in r) throw new Error(r.error);
      back2 = r.blocks;
    });
    return { md1, md2, labels1: labelsOf(back1), labels2: labelsOf(back2) };
  };
  const SIX = ["[Draft] Plan *v2*", "a]b\\", "a_b_ `c` ~~s~~ x|y", "C:\\path\\", "![img] #h", "foo]bar"];
  const headerRow = { cells: [[{ type: "text", text: "h", styles: {} }]] };

  it.each(SIX)("markdown 形（無色段落＋無色表格 cell）：%s", async text => {
    const r = await roundTripTwice([
      { type: "paragraph", content: [wlNode(text)] },
      { type: "table", content: { type: "tableContent", rows: [headerRow, { cells: [[wlNode(text)]] }] } },
    ]);
    expect(r.labels1).toEqual([text, text]);
    expect(r.labels2).toEqual([text, text]);
    expect(r.md2).toBe(r.md1);
  });

  // 審查 r0 I1：上色區塊整塊以原始 HTML 讀出，裡面的連結文字**不得**跳脫（HTML 寫回不反跳脫，會一輪多一層反斜線）。
  // 中間夾一個無色段落：文件有顏色時無色節點走 `flush()` 的 markdown 分支——那條分支的跳脫也在這一案觀測。
  it.each(SIX)("HTML 形（底色段落、文字色段落、有上色 cell 的表格）＋夾在中間的無色段落：%s", async text => {
    const r = await roundTripTwice([
      { type: "paragraph", props: { backgroundColor: "yellow" }, content: [wlNode(text)] },
      { type: "paragraph", content: [wlNode(text)] },
      { type: "paragraph", props: { textColor: "red" }, content: [wlNode(text)] },
      { type: "table", content: { type: "tableContent", rows: [headerRow, { cells: [{ type: "tableCell", props: { backgroundColor: "red" }, content: [wlNode(text)] }] }] } },
    ]);
    expect(r.md1).toContain(`<a href="/notes/${ID}"`); // 確實走了 HTML 分支
    expect(r.md1).toContain(`](/notes/${ID})`); // 無色段落確實走 markdown 分支
    expect(r.labels1).toEqual([text, text, text, text]);
    expect(r.labels2).toEqual([text, text, text, text]);
    expect(r.md2).toBe(r.md1);
  });

  // 上色的區塊整塊以 HTML 讀出（colors.ts `toBlockHTML`）——裡面的連結是 `<a href="/notes/<id>">`，不是 `[text](…)`；
  // READ_NOTE_LINK_SENTENCE 的括號子句依此寫成。
  it("上色段落裡的 wikilink 讀出為 <a href=\"/notes/<id>\">", async () => {
    const doc = await docWith([{ type: "paragraph", props: { backgroundColor: "yellow" }, content: [wlNode("L")] }]);
    const md = await readMd(doc);
    expect(md).toContain(`<a href="/notes/${ID}"`);
    expect(md).not.toContain(`](/notes/${ID})`);
  });
});
