/**
 * #398：會被接受的重內容（一個段落裡幾萬個行內節點）在主執行緒上不能平方。
 * - Y 型別不用 `get(i)` 索引走訪（`note-sections.ts`、`same-canonical.ts`、`decide.ts`）。
 * - jsdom 的三處平方（`jsdom-perf.ts`）：語意不變、而且線性。
 * - 換掉一大段內容用「先插後刪」（`replaceBlocksFresh`），結果與 `replaceBlocks` 相同。
 * 只擋「平方回來」，不量絕對速度：同一形量 N/8 與 N，比例 < 24（線性約 8–16、平方約 64；`expectLinear`），N 很快時
 * 直接算過，另有寬鬆的絕對上限（平方時是十幾秒到幾十秒）。量測之間重用建好的文件，不重複解析。
 */
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { YDOC_FRAGMENT, blocksToNoteMarkdown, topLevelContainers } from "@knotebook/shared";
import { canonicalizeElements } from "@knotebook/shared";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession, replaceBlocksFresh } from "../../src/notes/editing/session.js";
import { outlineOf, topLevelSnapshot } from "../../src/notes/editing/fingerprint.js";
import { sameCanonicalOf } from "../../src/transfer/same-canonical.js";
import { isLoneEmptyParagraph } from "../../src/transfer/decide.js";
import { patchJsdomForLargeTrees } from "../../src/notes/editing/jsdom-perf.js";
import { normalizeBody } from "../../src/transfer/normalize.js";
import { expectLinear, yieldToLoop } from "../perf-helpers.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
const timed = <T,>(f: () => T): [T, number] => {
  const t = performance.now();
  const v = f();
  return [v, performance.now() - t];
};
// 建大文件的每一步之前都讓出事件迴圈（`yieldToLoop`）：這裡的解析與套用都是同步的大工作，連著做會同步佔住 vitest worker
// （onTaskUpdate 60 秒逾時，PR #400 的 CI）。
const parse = async (md: string) => {
  await yieldToLoop();
  const r = await rt.parser.parse({ owner: "u", markdown: md, candidates: [], siteOrigin: "http://localhost" });
  if ("error" in r) throw new Error(JSON.stringify(r));
  return r.blocks;
};
async function docOfBlocks(blocks: unknown[]): Promise<Y.Doc> {
  await yieldToLoop();
  const doc = new Y.Doc();
  const s = await EditorSession.open(rt, doc);
  try {
    replaceBlocksFresh(s.editor, s.editor.document.map(b => b.id), blocks as never);
  } finally {
    s.close();
  }
  return doc;
}
const docOf = async (md: string): Promise<Y.Doc> => docOfBlocks(await parse(md));

describe("Y 型別走訪是線性的（`get(i)` 每次從頭走）", () => {
  it("`x<br>`×1 500 與 ×1.2 萬的段落（約 2.4 萬個子節點）：outlineOf／topLevelSnapshot／canonicalize／sameCanonicalOf 線性（平方時 1–5 秒）", async () => {
    const docs = new Map<number, Y.Doc>();
    for (const n of [1_500, 12_000]) docs.set(n, await docOf("x<br>".repeat(n)));
    const steps: Array<[string, (frag: Y.XmlFragment, top: Y.XmlElement[]) => unknown]> = [
      ["outlineOf", frag => outlineOf(frag)],
      ["topLevelSnapshot", frag => topLevelSnapshot(frag)],
      ["canonicalizeElements", (_, top) => canonicalizeElements(top)],
      ["sameCanonicalOf", (_, top) => sameCanonicalOf(top[0]!)],
    ];
    for (const [name, f] of steps) {
      await expectLinear(`#398 ${name}`, n => {
        const frag = docs.get(n)!.getXmlFragment(YDOC_FRAGMENT);
        const top = topLevelContainers(frag);
        expect(top).toHaveLength(1);
        return timed(() => f(frag, top))[1];
      }, 12_000);
    }
  }, 240_000);
});

describe("isLoneEmptyParagraph 走訪段落的子節點是線性的（要真的走完，形是一個段落裡幾萬個空的 XmlText）", () => {
  it("2 500 與 2 萬個空 XmlText 的段落：結果是 true，而且線性（`get(i)` 時平方）", async () => {
    const docs = new Map<number, Y.XmlFragment>();
    for (const n of [2_500, 20_000]) {
      const doc = new Y.Doc();
      const frag = doc.getXmlFragment(YDOC_FRAGMENT);
      doc.transact(() => {
        const group = new Y.XmlElement("blockGroup");
        const box = new Y.XmlElement("blockContainer");
        const p = new Y.XmlElement("paragraph");
        p.insert(0, Array.from({ length: n }, () => new Y.XmlText()));
        box.insert(0, [p]);
        group.insert(0, [box]);
        frag.insert(0, [group]);
      });
      docs.set(n, frag);
    }
    await expectLinear("#398 isLoneEmptyParagraph", n => {
      const [lone, ms] = timed(() => isLoneEmptyParagraph(docs.get(n)!));
      expect(lone).toBe(true);
      return ms;
    }, 20_000);
  }, 240_000);
});

describe("jsdom 修補（活清單立即重算、插入／移除時多算的索引）", () => {
  it("修補生效", () => {
    expect(patchJsdomForLargeTrees()).toBe(true);
  });
  it("活清單照樣是活的：先取用 childNodes／children，改動之後長度與內容即時正確", () => {
    const div = document.createElement("div");
    const nodes = div.childNodes;
    const els = div.children;
    expect(nodes.length).toBe(0);
    div.append("a", document.createElement("b"), "c");
    expect(nodes.length).toBe(3);
    expect(els.length).toBe(1);
    expect(nodes[1]!.nodeName).toBe("B");
    div.firstChild!.remove();
    expect(nodes.length).toBe(2);
    expect([...nodes].map(n => n.nodeName)).toEqual(["B", "#text"]);
    div.insertBefore(document.createElement("i"), div.lastChild);
    expect([...els].map(e => e.tagName)).toEqual(["B", "I"]);
  });
  it("有 Range 掛著時照原本更新它（不走省略索引的路）：插在／移除 Range 之前的位移，之後的不動", () => {
    const div = document.createElement("div");
    div.append("a", "b", "c");
    const range = document.createRange();
    range.setStart(div, 1);
    range.setEnd(div, 2);
    div.insertBefore(document.createElement("x"), div.lastChild); // 插在 Range 後面（索引 2）：不動
    expect([range.startOffset, range.endOffset]).toEqual([1, 2]);
    div.insertBefore(document.createElement("y"), div.firstChild); // 插在前面：兩端各 +1
    expect([range.startOffset, range.endOffset]).toEqual([2, 3]);
    div.removeChild(div.lastChild!); // 拿掉 Range 後面的：不動
    expect([range.startOffset, range.endOffset]).toEqual([2, 3]);
    div.removeChild(div.firstChild!); // 拿掉前面那個：各 -1
    expect([range.startOffset, range.endOffset]).toEqual([1, 2]);
  });
  it("在一個有 2 500 與 2 萬個子節點的元素中間逐一插入、換掉、移除：線性（未修補時平方）", async () => {
    const run = (n: number) => {
      const div = document.createElement("div");
      for (let i = 0; i < n; i++) div.append(document.createElement("span"), "t");
      void div.childNodes.length; // 先取用活清單
      const spans = Array.from(div.querySelectorAll("span"));
      const [, insertMs] = timed(() => {
        for (const s of spans) s.before(document.createTextNode("<"));
      });
      const [, replaceMs] = timed(() => {
        for (const s of spans) s.replaceWith(...Array.from(s.childNodes));
      });
      const [, removeMs] = timed(() => {
        for (let x = div.firstChild; x !== null; ) {
          const next = x.nextSibling?.nextSibling ?? null;
          x.nextSibling?.remove();
          x = next;
        }
      });
      return { insertMs, replaceMs, removeMs };
    };
    for (const k of ["insertMs", "replaceMs", "removeMs"] as const) await expectLinear(`#398 jsdom ${k}`, n => run(n)[k], 20_000);
  }, 120_000);
  it("讀出（blocksToNoteMarkdown）`x<br>`×750／6 000 與有色字×375／3 000 的段落：線性（未修補 6 000、3 000 時 3.2 秒、2.8 秒，且平方）", async () => {
    for (const [label, unit, n] of [["x<br>", "x<br>", 6_000], ["color", '<span style="color:red">x</span> ', 3_000]] as const) {
      const docs = new Map<number, Y.Doc>();
      for (const k of [n / 8, n]) docs.set(k, await docOf(unit.repeat(k)));
      await expectLinear(`#398 read ${label}`, async k => {
        const md = unit.repeat(k);
        const s = await EditorSession.open(rt, docs.get(k)!);
        try {
          const [out, ms] = timed(() => blocksToNoteMarkdown(s.editor, s.editor.document));
          expect(out.length).toBeGreaterThan(md.length / 2);
          return ms;
        } finally {
          s.close();
        }
      }, n);
    }
  }, 240_000);
});

describe("replaceBlocksFresh（先插後刪）", () => {
  it("結果與 replaceBlocks 相同（文件、插入的 id）", async () => {
    for (const [from, to] of [["# A\n\nb\n\nc", "x\n\n- y\n\nz"], ["a\n\nb\n\nc", ""], ["a\n\nb", "**c**"]] as const) {
      // （換成空、文件因此變空的形不比：編輯器會正規化出一顆新 id 的空段落，兩邊 id 本來就不同；正式路徑不會換成空——
      //  解析出空是 `empty_content`、撤回時會變空就補一顆段落。）
      const a = await docOf(from);
      const b = new Y.Doc();
      Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
      const blocks = to === "" ? [] : await parse(to);
      // 一次只開一個 session（`runtime.acquire()` 不可重入：持有 lease 時再開，碰上重建會互等）。
      const run = async (doc: Y.Doc, f: (ed: EditorSession["editor"], ids: string[]) => string[]) => {
        const s = await EditorSession.open(rt, doc);
        try {
          const inserted = f(s.editor, s.editor.document.slice(0, 2).map(x => x.id));
          return { inserted, document: s.editor.document };
        } finally {
          s.close();
        }
      };
      const ra = await run(a, (ed, ids) => ed.replaceBlocks(ids, blocks).insertedBlocks.map(x => x.id));
      const rb = await run(b, (ed, ids) => replaceBlocksFresh(ed, ids, blocks).map(x => x.id));
      expect(rb.inserted).toEqual(ra.inserted);
      expect(rb.document).toEqual(ra.document);
    }
  }, 60_000);
  // 被換掉的段落固定 `x<br>`×2 000，換入的 `**b** _i_`×n 直接組成 block JSON（同解析的結果，見下面的 `formatted`），不經 markdown 解析：
  // 原本兩者都靠解析建（被換掉的隨規模 ×2n，最大 4.8 萬），光建輸入就是幾段 3–5 秒以上的同步工作，慢的 CI 上會佔住 vitest worker 超過
  // 60 秒（onTaskUpdate 逾時，PR #400 的 CI）。平方出在「同一個交易裡逐段套格式」的換入內容，換掉的部分只是線性的刪除；固定下來讓比例只量
  // 平方的那一項，規模也就能加大到 4.8 萬（平方的寫法在這裡約 8 秒、比例遠超過 24）。
  it("`x<br>`×2 000 的段落換成 `**b** _i_`×6 000／4.8 萬：線性（replaceBlocks 在同一個交易裡逐段套格式，平方：4.9 萬約 12 秒）", async () => {
    // 解析 `"**b** _i_ ".repeat(n)` 得到的那一段：粗體 b、空白、斜體 i、空白……（最後的空白去掉）
    const formatted = (n: number) => [
      {
        type: "paragraph",
        props: { backgroundColor: "default", textColor: "default", textAlignment: "left" },
        content: Array.from({ length: n }, () => [
          { type: "text", text: "b", styles: { bold: true } },
          { type: "text", text: " ", styles: {} },
          { type: "text", text: "i", styles: { italic: true } },
          { type: "text", text: " ", styles: {} },
        ])
          .flat()
          .slice(0, -1),
        children: [],
      },
    ];
    expect(formatted(3)).toEqual((await parse("**b** _i_ ".repeat(3))).map(({ id: _id, ...b }: { id?: string }) => b));
    const inputs = new Map<number, { state: Uint8Array; blocks: unknown[] }>();
    const base = Y.encodeStateAsUpdate(await docOf("x<br>".repeat(2_000)));
    for (const n of [48_000 / 8, 48_000]) inputs.set(n, { state: base, blocks: formatted(n) });
    await expectLinear("#398 replaceBlocksFresh", async n => {
      const { state, blocks } = inputs.get(n)!;
      const doc = new Y.Doc();
      Y.applyUpdate(doc, state);
      const s = await EditorSession.open(rt, doc);
      try {
        return timed(() => replaceBlocksFresh(s.editor, s.editor.document.map(b => b.id), blocks as never))[1];
      } finally {
        s.close();
      }
    }, 48_000);
  }, 360_000);
});

describe("主執行緒上的字串處理是線性的", () => {
  it("normalizeBody：換行×3.125／25 萬接一個字，線性（原本的 `/\n+$/` 25 萬約 20 秒），結果不變", async () => {
    await expectLinear("normalizeBody", n => {
      const s = "a" + "\n".repeat(n) + "b\n\n\n";
      const [out, ms] = timed(() => normalizeBody(s));
      expect(out).toBe("a" + "\n".repeat(n) + "b");
      return ms;
    }, 250_000);
    expect(normalizeBody("\ufeff\r\n \n\tx\r\ny\n\n")).toBe("\tx\ny");
  });
  it("讀出：code block 裡 1.25／10 萬個換行接一個字，線性（原本的 `/[ \t]+$/`、`/\n+$/` 平方）", async () => {
    // 「粗體裡一長串空白」那形量不出我們這邊的修正：同一份輸入 BlockNote 自己的 HTML → markdown 也有平方的 `/^(.*?)(\s*)$/`
    // （10 萬個空白 2.2 秒），蓋過它——見回報。這裡只量 code block 的換行。
    // 前面一段有色字：讓讀出走逐段組字（`serializeNodes`）那條路——尾端換行就是在那裡去的。
    const mdOf = (n: number) => '<span style="color:red">c</span>\n\n```\nw' + "\n".repeat(n) + "x\n```";
    const docs = new Map<number, Y.Doc>();
    for (const n of [12_500, 100_000]) docs.set(n, await docOf(mdOf(n)));
    await expectLinear("#398 read code-block newlines", async n => {
      const s = await EditorSession.open(rt, docs.get(n)!);
      try {
        const [out, ms] = timed(() => blocksToNoteMarkdown(s.editor, s.editor.document));
        expect(out.length).toBeGreaterThan(n); // 前提：換行真的進了文件、也讀出來了
        return ms;
      } finally {
        s.close();
      }
    }, 100_000);
  }, 240_000);
});
