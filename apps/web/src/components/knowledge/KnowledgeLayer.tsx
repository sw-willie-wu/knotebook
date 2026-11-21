import { memo, useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { BlockNoteEditor } from "@blocknote/core";
import { useTranslation } from "react-i18next";
import type { KnowledgeEntry } from "@knotebook/shared";
import "@/i18n/knowledge-strings";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { useIsPhone, useNoHover } from "@/lib/layout-tiers";
import { Button } from "@/components/ui/button";
import { markKnowledgeVerified } from "./commands";
import { isReturningFocus, type KnowledgeController } from "./controller";
import { KnowledgeForm } from "./KnowledgeForm";
import { KnowledgeIconButton } from "./KnowledgeIcon";
import type { KnowledgeReplacementView } from "./KnowledgeCard";
import { KnowledgeSurface, LiveCard, type KnowledgeContext } from "./KnowledgeSurface";
import { attrValue, knowledgeIconPlace } from "./placement";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple (repo convention)
type AnyEditor = BlockNoteEditor<any, any, any>;

export interface KnowledgeLayerProps {
  /** Lets the layer build the edit form and the phone sheet's quick action itself, so they stay in this chunk; `editSurface` and `sheetFooter` override them. */
  editor?: AnyEditor;
  container: HTMLElement | null;
  entries: readonly KnowledgeEntry[];
  editable: boolean;
  noteId: string | null;
  controller: KnowledgeController;
  accept?: (outer: HTMLElement) => boolean;
  replacementOf?: (entry: KnowledgeEntry) => KnowledgeReplacementView | null;
  editSurface?: (blockId: string, close: () => void) => ReactNode;
  sheetFooter?: (entry: KnowledgeEntry) => ReactNode;
}

type Place = { top: number; left: number };
type Places = ReadonlyMap<string, Place>;
const NO_PLACES: Places = new Map();

function samePlaces(a: Places, b: Places): boolean {
  if (a.size !== b.size) return false;
  for (const [id, p] of a) {
    const q = b.get(id);
    if (!q || q.top !== p.top || q.left !== p.left) return false;
  }
  return true;
}

function measure(container: HTMLElement, entries: readonly KnowledgeEntry[], accept: ((outer: HTMLElement) => boolean) | undefined): Places {
  const wanted = new Set(entries.map((e) => e.blockId));
  const out = new Map<string, Place>();
  // One pass over the blocks instead of a selector per entry: with thousands of entries the latter is quadratic.
  for (const outer of container.querySelectorAll<HTMLElement>(".bn-block-outer[data-id]")) {
    const id = outer.dataset.id!;
    if (!wanted.has(id) || out.has(id)) continue;
    if (accept && !accept(outer)) continue;
    const place = knowledgeIconPlace(outer, container);
    if (place) out.set(id, place);
  }
  return out;
}

/** Same entries in the same order, drawn the same way: only some headings' text or fields changed, so only their icons can have moved (a block moved or inserted elsewhere shifts icons without touching any heading's text; the layer's observers catch that). */
function changedIds(prev: readonly KnowledgeEntry[], next: readonly KnowledgeEntry[]): string[] | null {
  if (prev.length !== next.length) return null;
  const changed: string[] = [];
  for (let i = 0; i < next.length; i += 1) {
    const a = prev[i]!;
    const b = next[i]!;
    if (a.blockId !== b.blockId || a.icon !== b.icon) return null;
    if (a !== b && a.heading !== b.heading) changed.push(b.blockId);
  }
  return changed;
}

function measureSome(container: HTMLElement, ids: readonly string[], accept: ((outer: HTMLElement) => boolean) | undefined, into: Map<string, Place>): void {
  for (const id of ids) {
    const outer = container.querySelector<HTMLElement>(`.bn-block-outer[data-id="${attrValue(id)}"]`);
    const place = outer && (!accept || accept(outer)) ? knowledgeIconPlace(outer, container) : null;
    if (place) into.set(id, place);
    else into.delete(id);
  }
}

/** Observers exist only while there is at least one entry; a full measurement happens at most once per animation frame. */
function useIconPlaces(container: HTMLElement | null, entries: readonly KnowledgeEntry[], accept: KnowledgeLayerProps["accept"]): Places {
  const [places, setPlaces] = useState<Places>(NO_PLACES);
  const acceptRef = useRef(accept);
  acceptRef.current = accept;
  const entriesRef = useRef(entries);
  const measuredRef = useRef<{ container: HTMLElement | null; entries: readonly KnowledgeEntry[] }>({ container: null, entries: [] });
  const active = container !== null && entries.length > 0;

  // Layout effect: the first measurement lands before paint, so icons don't pop in a frame after the text.
  useLayoutEffect(() => {
    entriesRef.current = entries;
    const before = measuredRef.current;
    measuredRef.current = { container, entries };
    if (!container || entries.length === 0) {
      setPlaces((cur) => (cur.size === 0 ? cur : NO_PLACES));
      return;
    }
    const changed = before.container === container ? changedIds(before.entries, entries) : null;
    if (changed === null) {
      const next = measure(container, entries, acceptRef.current);
      setPlaces((cur) => (samePlaces(cur, next) ? cur : next));
    } else if (changed.length > 0) {
      setPlaces((cur) => {
        const next = new Map(cur);
        measureSome(container, changed, acceptRef.current, next);
        return samePlaces(cur, next) ? cur : next;
      });
    }
  }, [container, entries]);

  useLayoutEffect(() => {
    if (!container || !active) return;
    let frame = 0;
    let disposed = false;
    const run = () => {
      frame = 0;
      const next = measure(container, entriesRef.current, acceptRef.current);
      setPlaces((cur) => (samePlaces(cur, next) ? cur : next));
    };
    const schedule = () => {
      if (frame === 0 && !disposed) frame = requestAnimationFrame(run);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(container);
    // Content above an icon can move it without changing the column's own size when the column is taller than its content.
    const editorRoot = container.querySelector(".bn-editor");
    if (editorRoot) observer.observe(editorRoot);
    // A drag, a collaborator's move or an undo reorders blocks without changing the editor's size, so only a structural change tells us.
    // Only a real element added to or removed from a block container counts: typing mutates inline content, and every remote y-prosemirror
    // transaction removes and re-inserts the trailing-block widget on the root group, which would otherwise re-measure every icon per remote keystroke.
    const blocks = editorRoot
      ? new MutationObserver((records) => {
          const structural = records.some(
            (r) =>
              r.target instanceof Element &&
              r.target.matches(".bn-block-group, .bn-block") &&
              [...r.addedNodes, ...r.removedNodes].some((n) => n instanceof Element && !n.classList.contains("ProseMirror-widget")),
          );
          if (structural) schedule();
        })
      : null;
    blocks?.observe(editorRoot!, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    fonts?.addEventListener?.("loadingdone", schedule);
    void fonts?.ready?.then(schedule);
    return () => {
      disposed = true;
      if (frame !== 0) cancelAnimationFrame(frame);
      observer.disconnect();
      blocks?.disconnect();
      window.removeEventListener("resize", schedule);
      fonts?.removeEventListener?.("loadingdone", schedule);
    };
  }, [container, active]);

  return places;
}

interface ItemProps {
  entry: KnowledgeEntry;
  top: number;
  left: number;
  hoverable: boolean;
  phone: boolean;
  editable: boolean;
  surfaceOpen: boolean;
  ctxRef: { current: KnowledgeContext };
}

// Only what the icon draws takes part in the comparison: the card reads the live entries when it opens.
const IconItem = memo(
  function IconItem({ entry, top, left, hoverable, phone, editable, surfaceOpen, ctxRef }: ItemProps) {
    const { blockId } = entry;
    const [hoverOpen, setHoverOpen] = useState(false);
    const buttonRef = useRef<HTMLButtonElement>(null);
    const onClick = useCallback(
      (el: HTMLButtonElement) => {
        setHoverOpen(false);
        const { controller } = ctxRef.current;
        if (controller.state?.blockId === blockId) {
          controller.close();
          return;
        }
        // With a pointer that hovers, an editor goes straight to the form; the card is what hover is for.
        controller.open(blockId, editable && hoverable && !phone ? "edit" : "view", el);
      },
      [blockId, editable, hoverable, phone, ctxRef],
    );
    const button = (
      <KnowledgeIconButton
        ref={buttonRef}
        entry={entry}
        top={top}
        left={left}
        expanded={surfaceOpen}
        onClick={onClick}
        onFocus={(e) => {
          if (isReturningFocus()) e.preventDefault();
        }}
      />
    );
    if (!hoverable) return button;
    return (
      <HoverCard openDelay={300} closeDelay={150} open={hoverOpen && !surfaceOpen} onOpenChange={(next) => setHoverOpen(next && !surfaceOpen)}>
        <HoverCardTrigger asChild>{button}</HoverCardTrigger>
        <HoverCardContent side="bottom" align="center" collisionPadding={8} className="w-[350px] max-w-[calc(100vw-1rem)] p-3">
          <LiveCard
            ctx={ctxRef.current}
            blockId={blockId}
            variant="hover"
            onEdit={() => ctxRef.current.controller.open(blockId, "edit", buttonRef.current)}
          />
        </HoverCardContent>
      </HoverCard>
    );
  },
  (a, b) =>
    a.entry.blockId === b.entry.blockId && a.entry.icon === b.entry.icon && a.top === b.top && a.left === b.left &&
    a.hoverable === b.hoverable && a.phone === b.phone && a.editable === b.editable && a.surfaceOpen === b.surfaceOpen && a.ctxRef === b.ctxRef,
);

export function KnowledgeLayer({ container, entries, editable, noteId, controller, accept, replacementOf, editSurface, sheetFooter, editor }: KnowledgeLayerProps): ReactNode {
  const { t } = useTranslation();
  const places = useIconPlaces(container, entries, accept);
  const noHover = useNoHover();
  const phone = useIsPhone();
  const ctxRef = useRef<KnowledgeContext>(null as never);
  const getEntries = useCallback(() => ctxRef.current.entries, []);
  const formFor = editor && editable
    ? (blockId: string, close: () => void) => <KnowledgeForm key={blockId} editor={editor} blockId={blockId} getEntries={getEntries} noteId={noteId} phone={phone} close={close} />
    : undefined;
  const verifyFor = editor && editable
    ? (entry: KnowledgeEntry) =>
        entry.info.status === "outdated" ? null : (
          <Button type="button" variant="outline" className="h-11 flex-1 text-[15px]" onClick={() => void markKnowledgeVerified(editor, entry.blockId)}>
            {t("knowledge.card.markVerified")}
          </Button>
        )
    : undefined;
  const ctx: KnowledgeContext = { container, entries, editable, noteId, controller, replacementOf, editSurface: editSurface ?? formFor, sheetFooter: sheetFooter ?? verifyFor };
  ctxRef.current = ctx;
  if (entries.length === 0 && controller.state === null) return null;
  const seen = new Set<string>();
  const openId = controller.state?.blockId ?? null;
  return (
    <>
      {entries.map((entry) => {
        const place = places.get(entry.blockId);
        // A dragged copy can share its source's block id; the first one owns the icon.
        if (!place || seen.has(entry.blockId)) return null;
        seen.add(entry.blockId);
        return (
          <IconItem
            key={entry.blockId}
            entry={entry}
            top={place.top}
            left={place.left}
            hoverable={!noHover}
            phone={phone}
            editable={editable}
            surfaceOpen={openId === entry.blockId}
            ctxRef={ctxRef}
          />
        );
      })}
      <KnowledgeSurface ctx={ctx} phone={phone} />
    </>
  );
}
