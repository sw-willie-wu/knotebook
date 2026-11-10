import { afterEach, describe, expect, it } from "vitest";
import { act, waitFor } from "@testing-library/react";
import * as Y from "yjs";
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { noteSchema } from "@/collab/schema";
import { selectInBlock, type AnyEditor } from "@/test/ai-host";
import { CUSTOM_COLORS_STYLE_ID, installCustomColors, resetCustomColorsForTest } from "./custom-colors";

// 遠端共編者套的自訂色，本機編輯器沒有人操作過：登記只能靠 DOM 觀察。
// 兩個編輯器各自一份 Y.Doc、互傳 update，掛在 body 下兩個兄弟容器。

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  resetCustomColorsForTest();
  document.body.innerHTML = "";
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 50));
const rules = () =>
  Array.from((document.getElementById(CUSTOM_COLORS_STYLE_ID) as HTMLStyleElement | null)?.sheet?.cssRules ?? []).map(
    (r) => (r as CSSStyleRule).selectorText,
  );

async function pair() {
  const d1 = new Y.Doc();
  const d2 = new Y.Doc();
  const make = (doc: Y.Doc, n: number) => {
    const editor = BlockNoteEditor.create(
      withCollaboration({
        schema: noteSchema,
        collaboration: {
          provider: { awareness: undefined },
          fragment: doc.getXmlFragment(YDOC_FRAGMENT),
          user: { id: `u${n}`, name: `User ${n}`, color: "hsl(0 65% 45%)" },
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any -- withCollaboration 的選項型別要求完整的 schema 三元組
      } as any),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 同上
    ) as any as AnyEditor;
    const el = document.createElement("div");
    document.body.appendChild(el);
    editor.mount(el);
    cleanups.push(() => {
      editor.unmount();
      el.remove();
      doc.destroy();
    });
    return { editor, el };
  };
  const a = make(d1, 1);
  await tick();
  a.editor.replaceBlocks(a.editor.document, [{ id: "b1", type: "paragraph", content: "hello world" }]);
  await tick();
  Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1));
  const b = make(d2, 2);
  await tick();
  const sync = async () => {
    Y.applyUpdate(d2, Y.encodeStateAsUpdate(d1, Y.encodeStateVector(d2)));
    Y.applyUpdate(d1, Y.encodeStateAsUpdate(d2, Y.encodeStateVector(d1)));
    await tick();
  };
  return { a, b, sync };
}

const INLINE_SEL = '[data-style-type="textColor"][data-value="#ff6600"]';

describe("installCustomColors with a remote collaborator (#378)", () => {
  it("OB6 遠端套的色碼，在被觀察的容器裡登記", async () => {
    const { a, b, sync } = await pair();
    installCustomColors(b.el);
    act(() => {
      selectInBlock(a.editor, "b1", 0, 5);
      a.editor.addStyles({ textColor: "#ff6600" });
    });
    await sync();
    await waitFor(() => expect(rules()).toContain(INLINE_SEL));
  });

  it("OB6 對照：觀察的是別的容器時，不會登記", async () => {
    const { a, b, sync } = await pair();
    const third = document.createElement("div");
    document.body.appendChild(third);
    installCustomColors(third);
    act(() => {
      selectInBlock(a.editor, "b1", 0, 5);
      a.editor.addStyles({ textColor: "#ff6600" });
    });
    await sync();
    await tick();
    // 先確認遠端的 span 真的長到 B 的 DOM，否則「沒有規則」可能只是遠端更新沒到。
    expect(b.el.querySelector(INLINE_SEL)).not.toBeNull();
    expect(rules()).not.toContain(INLINE_SEL);
  });
});
