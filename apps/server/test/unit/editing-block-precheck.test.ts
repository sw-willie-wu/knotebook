/**
 * block 上限的便宜預判（`plainParagraphFloor`／`topLevelBlockFloor`）。實測：約 988 KB、2.7 萬段的檔回 400
 * `too_many_blocks`，每發同步卡 ~3 秒（完整解析 `tryParseHTMLToBlocks` 約 2.4 s）。預判是**下界**：超過一定超過、估少照舊解析。
 */
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { syntaxCheckRoot } from "@knotebook/shared";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { BLOCK_PRECHECK_MIN_CHARS, MAX_BLOCKS, parseMarkdownForNote, plainParagraphFloor, topLevelBlockFloor } from "../../src/notes/editing/markdown.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" });
rt.installGlobals();
const ORIGIN = "http://localhost";

/** 在一個 scratch session 裡跑 parse，回結果與 `tryParseHTMLToBlocks` 被呼叫的次數（try/finally close：lease 不變量）。 */
async function parseCounting(md: string) {
  const s = await EditorSession.open(rt, new Y.Doc());
  try {
    const spy = vi.spyOn(s.editor, "tryParseHTMLToBlocks");
    const t = performance.now();
    const r = parseMarkdownForNote(s.editor, md, [], ORIGIN);
    const ms = performance.now() - t;
    const calls = spy.mock.calls.length;
    spy.mockRestore();
    return { r, ms, calls };
  } finally {
    s.close();
  }
}
const paras = (n: number, prefix = "p") => Array.from({ length: n }, (_, k) => `${prefix} ${k} lorem ipsum dolor sit amet`).join("\n\n");

describe("plainParagraphFloor（第一層：逐行）", () => {
  it("P1 數「空行之後、字母開頭」的行；同一段的續行、縮排行、清單／引言／標題／數字開頭的不算", () => {
    expect(plainParagraphFloor("a\n\nb\nc\n\n  d\n\n- e\n\n> f\n\n# g\n\n1. h\n\n中文段落")).toBe(3);
    expect(plainParagraphFloor("")).toBe(0);
    expect(plainParagraphFloor("a\r\n\r\nb")).toBe(2);
  });

  it("P2 有 `<` 就不估（HTML 區塊、註解、會吞內容的元素都可能讓字母行不成段）", () => {
    expect(plainParagraphFloor("a\n\nb <\n\nc")).toBe(0);
  });

  it("P3 全文有任何 ``` 或 ~~~ 就不估（BlockNote 不是 CommonMark，fence 怎麼開怎麼收交給第二層）", () => {
    expect(plainParagraphFloor("x\n\n```\n\na\n\nb\n```\n\ny")).toBe(0);
    expect(plainParagraphFloor("~~~~\n\na\n\n~~~\n\nb\n~~~~\n\nc")).toBe(0);
    expect(plainParagraphFloor("``` a`b\n\nc")).toBe(0);
    expect(plainParagraphFloor("a\n\nb ``` inline\n\nc")).toBe(0);
    expect(plainParagraphFloor("a\n\nb\n\nc ~~ d")).toBe(3);
  });
});

describe("topLevelBlockFloor（第二層：頂層 DOM）", () => {
  it("頂層有字的 p／h1–h6／pre 與頂層清單有字的 li 各算一；巢在別的元素裡的、沒字的不算", () => {
    const root = syntaxCheckRoot(
      "<p>a</p><h2>b</h2><pre><code>c</code></pre><ul><li>d</li><li>e</li></ul><ol><li></li></ol><p></p><p><img src=x></p>" +
        "<table><tr><td><p>x</p><p>y</p></td></tr></table><div><p>z</p></div>",
    );
    expect(topLevelBlockFloor(root)).toBe(5);
  });
});

describe("parseMarkdownForNote 的預判（2.7 萬段）", () => {
  it("B1 純 markdown 2.7 萬段 → too_many_blocks，沒進完整解析（tryParseHTMLToBlocks 0 次）", async () => {
    const md = paras(27_000);
    expect(Buffer.byteLength(md)).toBeGreaterThan(900_000);
    const { r, calls, ms } = await parseCounting(md);
    expect(r).toEqual({ error: "too_many_blocks" });
    expect(calls).toBe(0);
    console.log(`[B1] ${Math.round(ms)} ms`);
  }, 60_000);

  it("B1b 短於第二層門檻的純 markdown（MAX_BLOCKS + 1 段單字母，約 6 KB）→ 第一層擋下、沒進完整解析（第二層不看這麼短的檔）", async () => {
    const md = Array.from({ length: MAX_BLOCKS + 1 }, () => "a").join("\n\n");
    expect(md.length).toBeLessThan(BLOCK_PRECHECK_MIN_CHARS);
    const { r, calls } = await parseCounting(md);
    expect(r).toEqual({ error: "too_many_blocks" });
    expect(calls).toBe(0);
  }, 60_000);

  it("B2 開頭帶一個 HTML 標籤（第一層不估）的 2.7 萬段 → 第二層擋下：too_many_blocks、沒進完整解析", async () => {
    const md = "<b>x</b>\n\n" + paras(27_000);
    const { r, calls, ms } = await parseCounting(md);
    expect(r).toEqual({ error: "too_many_blocks" });
    expect(calls).toBe(0);
    console.log(`[B2] ${Math.round(ms)} ms`);
  }, 60_000);

  it("B3 下界不誤判：恰 MAX_BLOCKS 段（純 markdown 與帶 HTML 兩形）→ 解析成功、恰 MAX_BLOCKS 顆；多一段 → too_many_blocks", async () => {
    for (const head of ["", "<b>x</b> "]) {
      const ok = await parseCounting(head + paras(MAX_BLOCKS));
      expect(ok.r, `head=${JSON.stringify(head)}`).not.toHaveProperty("error");
      expect((ok.r as { blocks: unknown[] }).blocks, `head=${JSON.stringify(head)}`).toHaveLength(MAX_BLOCKS);
      const over = await parseCounting(head + paras(MAX_BLOCKS + 1));
      expect(over.r, `head=${JSON.stringify(head)}`).toEqual({ error: "too_many_blocks" });
    }
  }, 60_000);

  // 六種形狀——第一層照 CommonMark 數 fence 時都會把 BlockNote 解析成 1–3 顆的內容誤判成 too_many_blocks。
  const FENCE_HEADS: Array<[string, string]> = [
    ["info string 含 backtick（BlockNote 照開 fence）", "``` a`b\n\n"],
    ["收尾 fence 後帶 NBSP", "```\ncode\n```\u00a0\n\nZed\n\n```\n\n"],
    ["表格列開頭的 ```", "a | b\n--|--\n```|x\n```\n\n"],
    ["段落續行裡縮排的 fence", "Lead\n  ```\n```\n\n"],
    ["引言 lazy 續行裡縮排的 fence", "> q\n  ```\n```\n\n"],
    ["清單項裡的 fence 接第 0 欄收尾", "- item\n  ```\n  code\n```\n\n"],
  ];
  for (const [name, head] of FENCE_HEADS) {
    it(`B5 ${name}＋${MAX_BLOCKS + 10} 段 → 照常解析成功（不被第一層誤判）`, async () => {
      const md = head + Array.from({ length: MAX_BLOCKS + 10 }, (_, k) => `Para ${k}`).join("\n\n");
      const { r } = await parseCounting(md);
      expect(r, name).not.toHaveProperty("error");
      expect((r as { blocks: unknown[] }).blocks.length, name).toBeLessThanOrEqual(MAX_BLOCKS);
    }, 60_000);
  }

  it("B4 code fence 裡 3 000 段 → 一顆 code block，照常解析成功（第一層不把 fence 裡的算進去）", async () => {
    const md = "```\n" + paras(3_000) + "\n```";
    expect(md.length).toBeGreaterThan(BLOCK_PRECHECK_MIN_CHARS);
    const { r, calls } = await parseCounting(md);
    expect(calls).toBe(1);
    expect((r as { blocks: Array<{ type: string }> }).blocks.map(b => b.type)).toEqual(["codeBlock"]);
  }, 60_000);
});
