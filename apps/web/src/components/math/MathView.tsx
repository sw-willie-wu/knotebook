import "@/i18n/math-strings";
import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { renderMath, type MathRenderResult } from "@/lib/katex";
import { MATH_SCROLL_ATTR } from "@/lib/table-scroll-hint";
import { cn } from "@/lib/utils";

export interface MathViewProps {
  /** LaTeX source (the block's `tex` prop). */
  tex: string;
  /** Whether the current role can edit. When false, only "Show source" is offered. */
  editable: boolean;
  /** Commits new source. Called only when the source actually changed. */
  onChange(tex: string): void;
}

/**
 * Two-state view of a math block (#338), structured like `mermaid/MermaidView.tsx`.
 *
 * The HTML is injected with `dangerouslySetInnerHTML`. That is safe only while `trust: false` holds in
 * `lib/katex.ts` (`\href` and `\html*` have no effect) and KaTeX escapes all text; read that file's
 * header before changing it.
 */
export function MathView({ tex, editable, onChange }: MathViewProps): JSX.Element {
  const { t } = useTranslation();
  // A collaborator's client can write any value into the prop: anything that isn't a string is a blank formula.
  const source = typeof tex === "string" ? tex : "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(source);
  // The source when the editor opened: a peer's change that arrives while it is open must not count as the user's edit.
  const openedWith = useRef(source);
  const [result, setResult] = useState<MathRenderResult | null>(null);

  useEffect(() => {
    let cancelled = false;
    void renderMath(source).then((next) => {
      if (!cancelled) setResult(next);
    });
    return () => {
      cancelled = true;
    };
  }, [source]);

  const startEditing = (): void => {
    setDraft(source);
    openedWith.current = source;
    setEditing(true);
  };

  /**
   * Writes only what the user changed: an unchanged draft would write back the source as it was when the editor opened,
   * over a peer's newer one, and a no-op `updateBlock` still produces a Yjs update that pollutes other people's undo.
   * When both changed, the user's draft is written (the last writer wins). The viewer's read-only source never writes.
   */
  const commit = (): void => {
    setEditing(false);
    if (editable && draft !== openedWith.current) onChange(draft);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // The Esc that ends an input method composition belongs to the input method.
    if (event.key === "Escape" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      event.stopPropagation();
      commit();
    }
  };

  const body = (() => {
    if (result === null) return null;
    if (result.ok) {
      return <div className="overflow-x-auto" {...{ [MATH_SCROLL_ATTR]: "" }} dangerouslySetInnerHTML={{ __html: result.html }} />;
    }
    if (result.message === "") {
      // The hint asks to click the formula, which only an editor can do.
      return editable ? <p className="text-sm text-muted-foreground">{t("note.math.empty")}</p> : null;
    }
    return (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-destructive">
          {t("note.math.loadError")}
        </p>
        <pre className="overflow-x-auto rounded-md bg-muted/40 p-3 font-mono text-xs">{source}</pre>
      </div>
    );
  })();

  // The toolbar has a single button with a single direction: into the source. The way out is Esc or
  // clicking elsewhere (both go through `commit`), so while editing a hint is shown instead of a second button.
  // The viewer (`editable=false`) keeps this button, labelled "Show source": it is their only way to see
  // the source (a read-only textarea).
  //
  // This button must not be nested with the "click the formula to edit" button: nested `<button>` is invalid
  // HTML and one click would trigger both (pinned by a unit test).
  // Position: overlaid on the top-right inside the box. The group's position comes from `.block-control-group`
  // in `index.css` and the button shares `.block-control` with the code block's language picker; the outer
  // element is `relative` as the containing block. The overlap with the edit button is deliberate: where they
  // overlap the click goes to this button, and when editable both do the same thing.
  // Hidden with opacity, not `hidden`, so it stays in the tab order and keyboard users can reach it. Touch
  // devices have no hover, so they keep it dimly visible.
  // The button is not rendered while editing; a hint sits below the textarea instead. If a button is ever
  // added while editing, preventDefault on mousedown: otherwise the textarea blur commits first and the click
  // looks dead.
  // `w-full` is required: BlockNote's `bn-block-content` is a flex container and would shrink-wrap a child
  // with no declared width to its content width (about 140px).
  return (
    <div className="group relative w-full">
      {editing ? null : (
        <div
          className={cn(
            "block-control-group",
            "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-60 [@media(hover:none)]:group-focus-within:opacity-100",
          )}
        >
          <button type="button" onClick={startEditing} className="block-control">
            {editable ? t("note.math.edit") : t("note.math.showSource")}
          </button>
        </div>
      )}

      {editing ? (
        <>
          <textarea
            aria-label={t("note.math.sourceLabel")}
            value={draft}
            autoFocus
            readOnly={!editable}
            spellCheck={false}
            rows={Math.max(2, draft.split("\n").length + 1)}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={handleKeyDown}
            className="w-full resize-y rounded-md border border-input bg-muted/40 p-3 font-mono text-sm pointer-coarse:text-base outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <p className="mt-1 text-right text-xs text-muted-foreground">{t("note.math.escHint")}</p>
        </>
      ) : editable ? (
        <button
          type="button"
          aria-label={t("note.math.editArea")}
          onClick={startEditing}
          className={cn("block w-full cursor-text rounded-md border border-transparent p-2 text-left", "hover:border-input")}
        >
          {body}
        </button>
      ) : (
        <div className="py-2">{body}</div>
      )}
    </div>
  );
}
