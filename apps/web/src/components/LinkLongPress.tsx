import { useEffect } from "react";
import { useBlockNoteEditor, useEditorDOMElement } from "@blocknote/react";
import { createLongPress } from "@/lib/long-press";

const LINK_SELECTOR = 'a[data-inline-content-type="link"]';

/**
 * spec 2026-10-13 site-links rev 7 §7.4：可編輯時，觸控長按一般連結（link mark）⇒ BlockNote 原生連結工具列。
 * 做法：長按成立時把游標（空選取）放進連結文字裡，交給 `LinkToolbarController` 既有的「游標在連結內」路徑開工具列（selection 優先於 hover）。
 * 點一下維持 BlockNote 原行為（`clickHandler.ts` 的 `window.open`）。長按後補發的 mousedown／mouseup／click 在 capture 攔下——
 * ProseMirror 的 `handleClick` 跑在 mouseup，不攔就會照樣開新分頁。掛在 `<BlockNoteView>` 裡（要它的 context）；唯讀時什麼都不攔。
 */
export function LinkLongPress() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any
  const editor = useBlockNoteEditor<any, any, any>();
  const dom = useEditorDOMElement();

  useEffect(() => {
    if (!dom) return;
    let link: HTMLAnchorElement | null = null;
    const press = createLongPress(() => {
      if (!link?.isConnected || !editor.isEditable) return;
      const view = editor._tiptapEditor.view;
      // 樣式可能把一條連結切成多個 `<a>`：試這段的內部與兩端，找出整條連結的範圍，再把游標放在「起點後一格」（link mark 不
      // inclusive，邊界上 `getLinkAtSelection` 找不到）。整條只有一個字時三處都找不到，不開（docs/known-limitations.md）。
      const start = view.posAtDOM(link, 0);
      const end = view.posAtDOM(link, link.childNodes.length);
      const range = [start + 1, end, start].map((p) => editor.getLinkMarkAtPos(p)).find((r) => r !== undefined);
      if (!range) return;
      editor._tiptapEditor.commands.setTextSelection(range.from + 1);
    });
    const linkOf = (target: EventTarget | null) => {
      const el = target instanceof Element ? target.closest<HTMLAnchorElement>(LINK_SELECTOR) : null;
      return el && dom.contains(el) ? el : null;
    };
    const onDown = (e: PointerEvent) => {
      // 可編輯與否在事件當下判（`editable` 由 BlockNoteView 的 effect 設定，晚於子元件的 effect）。
      link = editor.isEditable ? linkOf(e.target) : null;
      if (link) press.down(e);
      else press.reset();
    };
    const onMove = (e: PointerEvent) => press.move(e);
    const onEnd = () => press.end();
    const onContextMenu = (e: MouseEvent) => {
      if (press.contextMenu()) e.preventDefault();
    };
    const swallow = (e: MouseEvent) => {
      if (!press.suppressing()) return;
      if (e.type === "click") press.consumeClick();
      e.preventDefault();
      e.stopPropagation();
    };
    const listeners: Array<[string, (e: never) => void]> = [
      ["pointerdown", onDown],
      ["pointermove", onMove],
      ["pointerup", onEnd],
      ["pointercancel", onEnd],
      ["contextmenu", onContextMenu],
      ["mousedown", swallow],
      ["mouseup", swallow],
      ["click", swallow],
    ];
    for (const [type, fn] of listeners) dom.addEventListener(type, fn as EventListener, true);
    return () => {
      press.dispose();
      for (const [type, fn] of listeners) dom.removeEventListener(type, fn as EventListener, true);
    };
  }, [dom, editor]);

  return null;
}
