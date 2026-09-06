import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { EditingRuntime } from "../../src/notes/editing/runtime.js";
import { EditorSession } from "../../src/notes/editing/session.js";
import { MAX_BLOCKS, parseMarkdownForNote } from "../../src/notes/editing/markdown.js";

const rt = new EditingRuntime({ baseUrl: "http://localhost/" }); rt.installGlobals();
const notes = [{ id: "11111111-1111-4111-8111-111111111111", title: "A" }];

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
      const r = parseMarkdownForNote(ed, "x [[A]] [[B]]\n\n```mermaid\ngraph TD\n```", notes);
      if ("error" in r) throw new Error(r.error);
      expect(r.unbound).toBe(1);
      expect(r.blocks.map(b => b.type)).toEqual(["paragraph", "mermaid"]);
    });
  });
  it("空／純空白 → empty_content；> MAX_BLOCKS → too_many_blocks", async () => {
    await withSession(ed => {
      expect(parseMarkdownForNote(ed, "   \n  \n", notes)).toEqual({ error: "empty_content" });
      expect(parseMarkdownForNote(ed, Array.from({ length: MAX_BLOCKS + 1 }, (_, i) => `p${i}`).join("\n\n"), notes)).toEqual({ error: "too_many_blocks" });
    });
  });
  it("未知型別整筆拒絕（不靜默剝除）", async () => {
    await withSession(ed => {
      const r = parseMarkdownForNote(ed, "<custom-widget>x</custom-widget>", notes);
      // BlockNote 對未知 HTML 元素通常降級為 paragraph；本案釘住「若 parse 產出的 type 不在 schema
      // 白名單 → unsupported_block」，用收窄白名單的假 editor 來驗。真 schema ＝ defaultBlockSpecs
      // 全集＋mermaid／codeBlock（見 shared 的 createHeadlessNoteSchema），markdown/HTML parser 產得
      // 出來的 type 一定在裡面——所以**整合層造不出這個碼**，那邊的清單要誠實寫明不驗，別硬塞。
      const narrowed = { ...ed, schema: { blockSchema: { paragraph: ed.schema.blockSchema.paragraph } }, tryParseMarkdownToBlocks: ed.tryParseMarkdownToBlocks.bind(ed) } as unknown as typeof ed;
      expect(parseMarkdownForNote(narrowed, "# heading", notes)).toEqual({ error: "unsupported_block" });
      expect("error" in r ? r.error : "ok").not.toBe("unsupported_block"); // 真 schema 下純 HTML 不會炸成 500
    });
  });
});
