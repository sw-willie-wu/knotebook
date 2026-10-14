import { useMemo, useState, type ReactElement } from "react";
import { Popover } from "radix-ui";
import { useTranslation } from "react-i18next";
import type { BlockNoteEditor } from "@blocknote/core";
import type { NoteDto } from "@knotebook/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote 編輯器泛型三元組，走 repo 慣例用 any（防循環 import，同 spec.tsx）
type AnyEditor = BlockNoteEditor<any, any, any>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- ProseMirror Node 型別在 apps/web 值層級拿不到（memory knotebook-markdown-link-rule）
type AnyPmNode = any;

export interface WikilinkToolbarProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  children: ReactElement;
  broken: boolean;
  label: string;
  displayText: string;
  notes: readonly NoteDto[] | undefined;
  onOpenTarget(): void;
  onSaveLabel(label: string): void;
  onChangeTarget(note: NoteDto): void;
  onRemove(): void;
  onRestoreFocus(): void;
}

/** 更換目標的候選上限（清單過濾與 `[[` 選單同規則：標題小寫包含查詢字）。 */
const TARGET_LIMIT = 20;

/**
 * #269 §7.4：編輯模式點 wikilink 出現的小工具列。Radix Popover 錨在被點的元素；Esc／點外關閉；焦點回歸放在
 * `onCloseAutoFocus`（按鈕、Esc、點外三條關閉路徑都經過它），而且**只在焦點無處可去**（`activeElement` 是 body 或 null）時才拉回
 * 編輯器：點外點到可聚焦的元素（標題欄、另一個 wikilink 的工具列）時焦點已經在那裡，不可搶走。
 * `preventDefault()`：Radix 的 Popover 內容在我們的 handler 之後，若事件沒被 prevent 會做 `triggerRef.current?.focus()`——現在用
 * `Popover.Anchor`、沒有 Trigger 所以是 no-op（拿掉它測試全綠，T10-M4）；留著是防日後改用 `Popover.Trigger` 時焦點被搶回觸發鈕。
 */
export function WikilinkToolbar(p: WikilinkToolbarProps) {
  const { t } = useTranslation();
  const [view, setView] = useState<"menu" | "text" | "target">("menu");
  const [text, setText] = useState(p.label);
  const [query, setQuery] = useState("");
  const matches = useMemo(() => {
    const q = query.toLowerCase();
    return (p.notes ?? []).filter((n) => n.title.toLowerCase().includes(q)).slice(0, TARGET_LIMIT);
  }, [p.notes, query]);
  // 受控關閉（按鈕動作呼叫 `close()`）不會經過 Root 的 onOpenChange，所以兩條路都要自己回到選單態——否則下次打開停在上次的子畫面。
  const reset = () => {
    setView("menu");
    setQuery("");
  };
  const close = () => {
    reset();
    p.onOpenChange(false);
  };
  return (
    <Popover.Root
      open={p.open}
      onOpenChange={(open) => {
        if (!open) reset();
        p.onOpenChange(open);
      }}
    >
      <Popover.Anchor asChild>{p.children}</Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          role="dialog"
          aria-label={t("note.wikilink.toolbar.label")}
          sideOffset={4}
          className="z-50 rounded-md border border-border bg-popover p-1 text-sm text-popover-foreground shadow-md"
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            const active = document.activeElement;
            if (active === null || active === document.body) p.onRestoreFocus();
          }}
        >
          {view === "menu" && (
            <div className="flex gap-1">
              <Button type="button" size="sm" variant="outline" disabled={p.broken} onClick={() => { close(); p.onOpenTarget(); }}>
                {t("note.wikilink.toolbar.open")}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => { setText(p.label); setView("text"); }}>
                {t("note.wikilink.toolbar.editText")}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setView("target")}>
                {t("note.wikilink.toolbar.changeTarget")}
              </Button>
              <Button type="button" size="sm" variant="outline" onClick={() => { close(); p.onRemove(); }}>
                {t("note.wikilink.toolbar.remove")}
              </Button>
            </div>
          )}
          {view === "text" && (
            <form
              className="flex gap-1"
              onSubmit={(e) => {
                e.preventDefault();
                close();
                p.onSaveLabel(text.trim() === "" ? "" : text);
              }}
            >
              <Input aria-label={t("note.wikilink.toolbar.textLabel")} value={text} placeholder={p.displayText} onChange={(e) => setText(e.target.value)} autoFocus />
              <Button type="submit" size="sm" variant="outline">
                {t("note.wikilink.toolbar.save")}
              </Button>
            </form>
          )}
          {view === "target" && (
            <div className="flex w-64 flex-col gap-1">
              <Input aria-label={t("note.wikilink.toolbar.search")} value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
              <div className="flex max-h-60 flex-col overflow-y-auto">
                {matches.map((n) => (
                  <Button key={n.id} type="button" size="sm" variant="ghost" className="justify-start" onClick={() => { close(); p.onChangeTarget(n); }}>
                    {n.title}
                  </Button>
                ))}
              </div>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * 移除連結（§7.4-4）：找出 DOM 落在 `el` 的那一個 wikilink 節點，一筆 transaction 換成純文字。找不到回 false
 * （文件已被別人改掉）。以 `view.nodeDOM(pos)` 比對而不是 props：同一段落可能有兩個 props 完全相同的 wikilink。
 * 節點身上的其他 mark（粗體、文字顏色…：PM 節點帶得到，雖然 BlockNote 的 JSON 不列）原樣留給文字；只丟 `link` mark
 * （不帶 link mark ⇒ §8.4 外掛不會再轉）。
 */
export function removeWikilinkNode(editor: AnyEditor, el: HTMLElement, text: string): boolean {
  const view = editor._tiptapEditor.view;
  let from = -1;
  let size = 0;
  let marks: AnyPmNode[] = [];
  view.state.doc.descendants((node: AnyPmNode, pos: number) => {
    if (from !== -1) return false;
    if (node.type.name === "wikilink") {
      const dom = view.nodeDOM(pos) as Node | null;
      if (dom && (dom === el || dom.contains(el))) {
        from = pos;
        size = node.nodeSize;
        marks = (node.marks as AnyPmNode[]).filter((mark) => mark.type.name !== "link");
      }
    }
    return true;
  });
  if (from === -1) return false;
  view.dispatch(view.state.tr.replaceWith(from, from + size, view.state.schema.text(text, marks)));
  return true;
}
