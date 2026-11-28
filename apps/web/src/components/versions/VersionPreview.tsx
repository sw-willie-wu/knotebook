import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type * as Y from "yjs";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import { noteSchema } from "@/collab/schema";
import { useVersionSnapshot, VersionSnapshotMismatch } from "@/api/versions";
import { ARTICLE_COLUMN_PADDING, articleColumn } from "@/components/ui/article-column";
import { useNoteWidth } from "@/components/note-width";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { diffBlocks, renderDiff, sideBySideMarks, splitRows, type DiffBlock, type DiffEntry, type DiffMark, type DiffMarkInfo, type SplitRow } from "@/lib/version-diff";
import { forkLiveBlocks, ydocBytesToBlocks } from "@/lib/version-snapshot";
import { safeMediaUrl } from "@/lib/media-url";
import { useContainerWidth } from "@/lib/use-container-width";
import { useWikilinkTitleOf } from "@/lib/use-wikilink-titles";
import { useVersions } from "@/lib/versions-context";
import { useTheme } from "@/theme";
import { cn } from "@/lib/utils";
import { MediaZoomContext } from "@/components/media-zoom/context";
import { FilePreviewLayer } from "@/components/file-preview/FilePreviewLayer";
import { ComparePicker } from "./ComparePicker";
import { KNOWLEDGE_OUTDATED_ATTR } from "@/collab/knowledge-decorations";
import { KnowledgeLayerLazy } from "@/components/knowledge/KnowledgeLayerLazy";
import { useKnowledgeController } from "@/components/knowledge/controller";
import { listKnowledgeInBlocks, type KnowledgeEntry } from "@knotebook/shared";

/** Below the threshold (content-box width, measured by `useContainerWidth`) side-by-side isn't rendered at all (single column only), so the side-by-side grid is always two columns with no container query. */
const SPLIT_MIN_WIDTH = 720;

const NO_MARKS: Map<string, DiffMark> = new Map();

function knowledgeOf(blocks: readonly DiffBlock[]): KnowledgeEntry[] {
  return listKnowledgeInBlocks(blocks.filter((b): b is DiffBlock & { id: string } => typeof b.id === "string"));
}

/** The single column renames deleted blocks to synthetic ids, so the previewed version's entries are re-keyed to the ids the column's DOM carries. */
function rekeyKnowledge(entries: readonly KnowledgeEntry[], top: readonly DiffEntry[]): KnowledgeEntry[] {
  const keyOf = new Map<string, string>();
  for (const e of top) if (e.before?.id !== undefined) keyOf.set(e.before.id, e.key);
  const re = (id: string) => keyOf.get(id) ?? id;
  return entries.map((e) => ({
    ...e,
    blockId: re(e.blockId),
    parentBlockId: e.parentBlockId === null ? null : re(e.parentBlockId),
    ancestorBlockIds: e.ancestorBlockIds.map(re),
    rangeBlockIds: e.rangeBlockIds.map(re),
  }));
}

/**
 * Read-only diff editor (single column, one side of side-by-side, the before/after dialog). No collaboration, `editable={false}`; `resolveFileUrl` always passes `safeMediaUrl` (a snapshot can carry dangerous URLs written by collaborators; same guard as #12).
 * `useCreateBlockNote(…, [blocks])` rebuilds the whole editor when the `blocks` identity changes, so callers must pass a memoised reference (see the useMemo chain in `VersionPreview`).
 * `data-diff` goes on `.bn-block-outer[data-id]`: the attributes survive selection, empty-meta, other-block and same-id `replaceBlocks` transactions, and the read-only editor makes no further ones. Columns and column lists (`[data-node-type=column|columnList][data-id]`) get it too; their elements aren't replaced by the stacking plugin's decoration transactions, so the attributes stay.
 */
export function DiffEditor({
  blocks,
  marks,
  testId = "diff-pane",
  rootRef,
  knowledge,
}: {
  blocks: DiffBlock[];
  marks: Map<string, DiffMark | DiffMarkInfo>;
  testId?: string;
  rootRef?: MutableRefObject<HTMLElement | null>;
  /**
   * The knowledge of the version this editor shows. `accept` picks which DOM blocks may carry an icon (the single column holds blocks that aren't part of that version). Omitted = no icons, as in the before/after dialog.
   * `memberNoteId`: the previewed note, used only to name members in custom fields.
   */
  knowledge?: { entries: readonly KnowledgeEntry[]; accept?: (outer: HTMLElement) => boolean; memberNoteId?: string | null };
}) {
  const { resolvedTheme } = useTheme();
  const editor = useCreateBlockNote(
    {
      schema: noteSchema,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PartialBlock generic triple (repo convention)
      initialContent: (blocks.length ? blocks : [{ type: "paragraph" }]) as any,
      resolveFileUrl: (url: string) => Promise.resolve(safeMediaUrl(url)),
    },
    [blocks],
  );
  useLayoutEffect(() => {
    const root = editor.domElement;
    if (rootRef) rootRef.current = root ?? null;
    if (!root) return;
    root.querySelectorAll<HTMLElement>('.bn-block-outer[data-id], [data-node-type="column"][data-id], [data-node-type="columnList"][data-id]').forEach((el) => {
      const info = marks.get(el.dataset.id!);
      const mark = typeof info === "string" ? info : (info?.mark ?? "context");
      el.setAttribute("data-diff", mark);
      if (typeof info === "object" && info.moved && mark !== "moved") el.setAttribute("data-diff-moved", "true");
    });
    // A read-only editor makes no transactions, so the strikethrough can be written straight onto the block instead of through a decoration.
    const outdated = new Set((knowledge?.entries ?? []).filter((e) => e.outdated).map((e) => e.blockId));
    root.querySelectorAll<HTMLElement>(`[${KNOWLEDGE_OUTDATED_ATTR}]`).forEach((el) => el.removeAttribute(KNOWLEDGE_OUTDATED_ATTR));
    if (outdated.size > 0) {
      root.querySelectorAll<HTMLElement>(".bn-block-outer[data-id]").forEach((outer) => {
        if (!outdated.has(outer.dataset.id!) || (knowledge?.accept && !knowledge.accept(outer))) return;
        outer.querySelector(":scope > .bn-block > .bn-block-content")?.setAttribute(KNOWLEDGE_OUTDATED_ATTR, "");
      });
    }
  });
  // On unmount (loading branch, switch to single column) hand back null, so the parent doesn't measure or attach an observer to a stale detached root.
  useLayoutEffect(
    () => () => {
      if (rootRef) rootRef.current = null;
    },
    [rootRef],
  );
  const [box, setBox] = useState<HTMLElement | null>(null);
  const controller = useKnowledgeController();
  // A rebuilt editor replaces every block element, so the layer starts over with it.
  const generation = useRef({ blocks, n: 0 });
  if (generation.current.blocks !== blocks) generation.current = { blocks, n: generation.current.n + 1 };
  return (
    <div ref={setBox} data-testid={testId} className="kb-diff relative min-w-0">
      {/* The preview already lives in a panel/dialog, so no second zoom dialog on top: mermaid gets no zoom (context null);
          an image float layer mounted on the outer article column would skip images inside .kb-diff, so both stay consistent. */}
      <MediaZoomContext.Provider value={null}>
        <BlockNoteView editor={editor} editable={false} theme={resolvedTheme} />
      </MediaZoomContext.Provider>
      <FilePreviewLayer container={box} />
      {knowledge && (
        <KnowledgeLayerLazy key={generation.current.n} container={box} entries={knowledge.entries} editable={false} noteId={null} memberNoteId={knowledge.memberNoteId ?? null} controller={controller} accept={knowledge.accept} />
      )}
    </div>
  );
}

interface NonTextChange {
  key: string;
  before: DiffBlock;
  after: DiffBlock;
}

function collectNonText(entries: DiffEntry[], marks: Map<string, DiffMarkInfo>, out: NonTextChange[] = []): NonTextChange[] {
  for (const e of entries) {
    if (marks.get(e.key)?.nonText && e.before && e.after) out.push({ key: e.key, before: e.before, after: e.after });
    collectNonText(e.children, marks, out);
  }
  return out;
}

function NonTextDialog({ change, onClose }: { change: NonTextChange; onClose: () => void }) {
  const { t } = useTranslation();
  const before = useMemo(() => [change.before], [change]);
  const after = useMemo(() => [change.after], [change]);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t("versions.preview.nonTextChanged")}</DialogTitle>
        </DialogHeader>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <section className="min-w-0">
            <h3 className="mb-1 text-xs text-muted-foreground">{t("versions.preview.before")}</h3>
            <DiffEditor blocks={before} marks={NO_MARKS} />
          </section>
          <section className="min-w-0">
            <h3 className="mb-1 text-xs text-muted-foreground">{t("versions.preview.after")}</h3>
            <DiffEditor blocks={after} marks={NO_MARKS} />
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Hatched block left in the opposite column: px relative to the column `section`; `row` = first row number covered (React key); `left`/`width` = horizontal extent of that column's top-level `.bn-block-outer` (without the editor's side padding), null when unmeasurable = full column width. */
interface Spacer {
  side: "left" | "right";
  row: number;
  top: number;
  height: number;
  left: number | null;
  width: number | null;
}

/**
 * Top-level units of one diff editor, in document order and one-to-one with the `blocks` passed in (with empty blocks the placeholder paragraph DiffEditor renders is an extra 0th, which `splitRows` gives no row number): top-level `.bn-block-outer` plus top-level column lists.
 * Nested children sit deeper (`.bn-block-outer > .bn-block > .bn-block-group > .bn-block-outer`), so a plain `.bn-block-outer` selector would match them too. A top-level `columnList` hangs directly under `.bn-block-group` without a `.bn-block-outer`; one row = one alignment row, no per-column alignment inside (same as nested).
 * `root` must be `editor.domElement`, which is the `.bn-editor` element itself (hence `:scope > .bn-block-group`).
 */
function topLevelOuters(root: HTMLElement | null): HTMLElement[] {
  return root ? Array.from(root.querySelectorAll<HTMLElement>(':scope > .bn-block-group > :is(.bn-block-outer, [data-node-type="columnList"])')) : [];
}

/** Fractional `getBoundingClientRect().height` (border box), not integer `offsetHeight`: h3 line height is 31.2px, h5 21.6px, scaled images are fractional too, and rounding error accumulates row by row into misalignment. The border box excludes its own margin, so margins needn't be cleared first. */
function blockHeight(el: HTMLElement): number {
  return el.getBoundingClientRect().height;
}

function heightsOf(roots: Array<HTMLElement | null>): number[][] {
  return roots.map((r) => topLevelOuters(r).map(blockHeight));
}

/** < 0.5px per block counts as unchanged, so fractional jitter doesn't re-layout repeatedly. */
function sameHeights(x: number[][], y: number[][]): boolean {
  return x.length === y.length && x.every((list, i) => list.length === y[i].length && list.every((v, j) => Math.abs(v - y[i][j]) < 0.5));
}

/**
 * Each row's height is the max of the two sides' top-level block heights. The spacing is written only as the NEXT block's `margin-top` (the shorter side's difference below the row; the full row height opposite a single-sided row; at column end the column `section`'s `padding-bottom`):
 * the obvious "margin-bottom on the shorter side, margin-top on the next opposite" collapses margins at the same boundary to the larger instead of adding, undercounting when a shorter side is followed by an opposite single-sided row.
 * jsdom measures all zeros → only clear and mark; no style, no spacer.
 */
function alignSplit(rows: SplitRow[], roots: [HTMLElement | null, HTMLElement | null], secs: [HTMLElement | null, HTMLElement | null]): Spacer[] {
  const outs = [topLevelOuters(roots[0]), topLevelOuters(roots[1])];
  for (const list of outs)
    for (const el of list) {
      el.style.marginTop = "";
      el.style.marginBottom = "";
      el.removeAttribute("data-diff-row");
    }
  for (const s of secs) if (s) s.style.paddingBottom = "";
  rows.forEach((row, r) => {
    if (row.left !== null) outs[0][row.left]?.setAttribute("data-diff-row", String(r));
    if (row.right !== null) outs[1][row.right]?.setAttribute("data-diff-row", String(r));
  });
  const h = outs.map((list) => list.map(blockHeight));
  if (h.every((list) => list.every((x) => x === 0))) return [];
  const margin = [new Map<number, number>(), new Map<number, number>()];
  const pend = [0, 0];
  for (const row of rows) {
    const idx = [row.left, row.right];
    const hh = idx.map((i, s) => (i === null ? 0 : (h[s][i] ?? 0)));
    const height = Math.max(hh[0], hh[1]);
    for (let s = 0; s < 2; s += 1) {
      const i = idx[s];
      if (i === null) {
        pend[s] += height;
      } else {
        if (pend[s] > 0) margin[s].set(i, pend[s]);
        pend[s] = height - hh[s];
      }
    }
  }
  margin.forEach((m, s) => m.forEach((v, i) => outs[s][i] && (outs[s][i].style.marginTop = `${v}px`)));
  pend.forEach((v, s) => {
    const sec = secs[s];
    if (v > 0 && sec) sec.style.paddingBottom = `${v}px`;
  });
  // spacer: a single-sided row's position in the opposite column = the top of the side with content (after margins are written both columns are equal height in the row); consecutive single-sided rows merge into one block (the hatching doesn't break).
  // Horizontal: the spacer narrows to the empty side's top-level block extent (first top-level `.bn-block-outer` of that column; an empty column still has a placeholder paragraph).
  const secRects = secs.map((s) => s?.getBoundingClientRect() ?? null);
  const span = outs.map((list, s) => {
    const r = list[0]?.getBoundingClientRect();
    const base = secRects[s];
    return r && base && r.width > 0 ? { left: r.left - base.left, width: r.width } : null;
  });
  const out: Spacer[] = [];
  rows.forEach((row, r) => {
    if (row.left !== null && row.right !== null) return;
    const s = row.left === null ? 0 : 1; // the empty side
    const el = s === 0 ? outs[1][row.right!] : outs[0][row.left!];
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const top = rect.top - (secRects[s]?.top ?? 0);
    const side = s === 0 ? "left" : "right";
    const prev = out[out.length - 1];
    if (prev && prev.side === side && Math.abs(prev.top + prev.height - top) <= 1) prev.height = top + rect.height - prev.top;
    else out.push({ side, row: r, top, height: rect.height, left: span[s]?.left ?? null, width: span[s]?.width ?? null });
  });
  return out;
}

function SpacerDiv({ spacer }: { spacer: Spacer }) {
  const style: CSSProperties = { top: spacer.top, height: spacer.height };
  if (spacer.left !== null && spacer.width !== null) Object.assign(style, { left: spacer.left, width: spacer.width, right: "auto" });
  return <div aria-hidden className="kb-diff-spacer" style={style} />;
}

/**
 * Renders in `NoteEditor`'s `previewSlot` (an `overflow-y-auto` scroll container): single = one read-only editor rendering `renderDiff`; side-by-side = two, neither a scroll container, scrolling together in the slot's one container.
 * All derived values use `useMemo`: `DiffEditor` rebuilds the editor when `blocks` identity changes, and this component re-renders often (list debounce invalidation, window-focus refetch, ResizeObserver, context changes); anything unmemoised makes the preview jump to the top and rebuild.
 * Always return the `ref` wrapper: `useContainerWidth` installs its measurer only at mount, so an early return in the loading state would leave it never attached.
 */
export function VersionPreview({ doc, forceSingle = false }: { doc: Y.Doc; forceSingle?: boolean }) {
  const { t } = useTranslation();
  const { noteId, preview, compareRight, splitMode, onlyChanges, stopPreview, setCompareRight, reportPreviewWide } = useVersions();
  const ref = useRef<HTMLDivElement>(null);
  const width = useContainerWidth(ref);
  const [noteWidth] = useNoteWidth(noteId);

  const rightTarget = compareRight === "current" ? null : compareRight;
  const left = useVersionSnapshot(noteId ?? "", preview);
  const right = useVersionSnapshot(noteId ?? "", rightTarget);

  // Left mismatch → leave preview; right mismatch → right reverts to "Current state" with the same toast, preview stays. Both `useVersionSnapshot` hooks already invalidate the list.
  const leftGone = left.error instanceof VersionSnapshotMismatch;
  const rightGone = rightTarget !== null && right.error instanceof VersionSnapshotMismatch;
  // A read failure (not a mismatch) shows a generic error in the preview area instead of staying on "loading".
  // The diff needs only the two snapshots (and the live-doc fork), not the version list: a list that failed or hasn't arrived (especially the filtered one, #258) must not interrupt the preview, so this component doesn't subscribe to it (panel, full page and compare dropdown each subscribe and show their own errors).
  const failed = (left.isError && !leftGone) || (rightTarget !== null && right.isError && !rightGone);
  useEffect(() => {
    if (!leftGone) return;
    toast({ title: t("versions.preview.gone") });
    stopPreview();
  }, [leftGone, stopPreview, t]);
  useEffect(() => {
    if (!rightGone) return;
    toast({ title: t("versions.preview.gone") });
    setCompareRight("current");
  }, [rightGone, setCompareRight, t]);

  const leftBlocks = useMemo(() => (left.data ? ydocBytesToBlocks(left.data) : null), [left.data]);
  const rightBlocks = useMemo(() => (right.data ? ydocBytesToBlocks(right.data) : null), [right.data]);
  const rightIsCurrent = compareRight === "current";
  const [a, b] = useMemo<[DiffBlock[] | null, DiffBlock[] | null]>(() => {
    // "Current state" is a one-off fork of the live doc, read when the right side or the previewed version changes; not subscribed (the preview compares snapshots).
    if (rightIsCurrent) return [leftBlocks, preview ? forkLiveBlocks(doc) : null];
    return [leftBlocks, rightBlocks];
  }, [rightIsCurrent, leftBlocks, rightBlocks, preview, doc]);
  const entries = useMemo(() => (a && b ? diffBlocks(a, b) : null), [a, b]);
  const titleOf = useWikilinkTitleOf(a, b);
  const collapsedText = useCallback((n: number) => t("versions.preview.collapsed", { count: n }), [t]);
  // #269: titleOf is memoised on value-equal related titles: a refetch that doesn't change them gives the same function, so nothing recomputes and DiffEditor doesn't rebuild.
  const single = useMemo(() => (entries ? renderDiff(entries, { onlyChanges, collapsedText, titleOf }) : null), [entries, onlyChanges, collapsedText, titleOf]);
  const sides = useMemo(() => (entries ? sideBySideMarks(entries) : null), [entries]);
  const nonText = useMemo(() => (entries && single ? collectNonText(entries, single.marks) : []), [entries, single]);
  // Each side's knowledge comes from its own blocks. The single column mixes both versions plus collapsed placeholders, so it shows the previewed version's (`a`) and skips blocks that version doesn't have.
  const knowledgeA = useMemo(() => ({ entries: a ? knowledgeOf(a) : [], memberNoteId: noteId }), [a, noteId]);
  const knowledgeB = useMemo(() => ({ entries: b ? knowledgeOf(b) : [], memberNoteId: noteId }), [b, noteId]);
  const knowledgeSingle = useMemo(
    () => ({
      entries: rekeyKnowledge(knowledgeA.entries, entries ?? []),
      accept: (outer: HTMLElement) => {
        const info = single?.marks.get(outer.dataset.id!);
        return info?.mark !== "added" && info?.mark !== "collapsed";
      },
      memberNoteId: noteId,
    }),
    [knowledgeA, entries, single, noteId],
  );

  // Side-by-side exists only when the preview area is wide enough: narrow is always single; the user's chosen "side-by-side" stays in splitMode and returns when wide again. Same condition as the controller's `splitActive`.
  const wide = !forceSingle && width >= SPLIT_MIN_WIDTH;
  const split = wide && splitMode !== "single";
  // Report the width verdict to the banner/page (only this component can measure it); reset to zero on unmount. useLayoutEffect: on the first wide preview the banner gets previewWide before paint, avoiding a frame without the side-by-side button (no test distinguishes this from useEffect).
  useLayoutEffect(() => {
    reportPreviewWide(wide);
    return () => reportPreviewWide(false);
  }, [wide, reportPreviewWide]);

  // Side-by-side block alignment and the "view before/after" button positions share one layout effect and one ResizeObserver. The button overlays the wrapper, top aligned to its block (right column / single column), so it is measured after the alignment margins are written.
  // The child DiffEditor's DOM and rootRef are ready in its own layout effect (children before parents). A late editor root size change (images/embeds growing it) goes through the ResizeObserver, debounced with requestAnimationFrame,
  // and nothing is rewritten if the two columns' top-level height signature is unchanged (writing margins itself resizes the root and triggers the observer).
  const rows = useMemo(() => (a && b && entries ? splitRows(a, b, entries) : null), [a, b, entries]);
  const leftRoot = useRef<HTMLElement | null>(null);
  const rightRoot = useRef<HTMLElement | null>(null);
  const singleRoot = useRef<HTMLElement | null>(null);
  const leftSec = useRef<HTMLElement>(null);
  const rightSec = useRef<HTMLElement>(null);
  const [spacers, setSpacers] = useState<Spacer[]>([]);
  const [tops, setTops] = useState<Record<string, number>>({});
  useLayoutEffect(() => {
    const wrap = ref.current;
    if (!wrap) return;
    const roots: Array<HTMLElement | null> = split ? [leftRoot.current, rightRoot.current] : [singleRoot.current];
    let measured: number[][] = [];
    const run = () => {
      if (split && rows) {
        const next = alignSplit(rows, [leftRoot.current, rightRoot.current], [leftSec.current, rightSec.current]);
        setSpacers((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
      }
      measured = heightsOf(roots);
      const base = wrap.getBoundingClientRect().top;
      const next: Record<string, number> = {};
      for (const c of nonText) {
        const els = wrap.querySelectorAll(`.bn-block-outer[data-id="${CSS.escape(c.key)}"]`);
        const el = els[els.length - 1];
        if (el) next[c.key] = el.getBoundingClientRect().top - base;
      }
      setTops((cur) => (JSON.stringify(cur) === JSON.stringify(next) ? cur : next));
    };
    run();
    if (typeof ResizeObserver === "undefined") return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!sameHeights(heightsOf(roots), measured)) run();
      });
    });
    for (const r of roots) if (r) ro.observe(r);
    return () => {
      ro.disconnect();
      if (raf) cancelAnimationFrame(raf);
    };
  }, [rows, split, width, nonText]);
  const [opened, setOpened] = useState<NonTextChange | null>(null);
  // On a new preview (or new right side), reset the "view before/after" dialog and button positions during render (same "reset state from props" form as useVersionsController).
  const seqNow = `${preview?.id ?? ""}|${rightTarget?.id ?? "current"}`;
  const [forSeq, setForSeq] = useState(seqNow);
  if (forSeq !== seqNow) {
    setForSeq(seqNow);
    setOpened(null);
    setTops({});
  }

  // Side-by-side, the two compare dropdowns are the column headers (replacing the plain text labels, same position); the banner then has none.
  // The header row depends only on `preview && split`, not on the body's loading/failed branches: otherwise a failed right snapshot leaves nothing to change the right side, and picking an uncached version in a column header unmounts the trigger before the menu closes, dropping focus to body.
  // The header row and both columns share one grid column width and gap.
  const splitHead =
    preview && split ? (
      <div data-testid="diff-split-head" className="grid grid-cols-2 gap-4">
        <div className="min-w-0 px-4 pb-1 text-xs">
          <ComparePicker side="left" />
        </div>
        <div className="min-w-0 border-l border-border px-4 pb-1 text-xs">
          <ComparePicker side="right" />
        </div>
      </div>
    ) : null;

  let body: ReactNode = null;
  if (preview) {
    if (failed) {
      body = (
        <p role="alert" className="text-sm text-muted-foreground">
          {t("errors.fallback")}
        </p>
      );
    } else if (!a || !b || !single || !sides) {
      body = <p className="text-sm text-muted-foreground">{t("versions.preview.loading")}</p>;
    } else if (split) {
      body = (
        <div data-testid="diff-split" className="kb-diff-split grid min-h-0 flex-1 grid-cols-2 gap-4">
          <section ref={leftSec} className="relative min-w-0">
            <DiffEditor blocks={a} marks={sides.left} rootRef={leftRoot} knowledge={knowledgeA} />
            {spacers.map((s) => s.side === "left" && <SpacerDiv key={s.row} spacer={s} />)}
          </section>
          <section ref={rightSec} className="relative min-w-0 border-l border-border">
            <DiffEditor blocks={b} marks={sides.right} rootRef={rightRoot} knowledge={knowledgeB} />
            {spacers.map((s) => s.side === "right" && <SpacerDiv key={s.row} spacer={s} />)}
          </section>
        </div>
      );
    } else {
      body = (
        <div data-testid="diff-single" className={cn(articleColumn(noteWidth), ARTICLE_COLUMN_PADDING)}>
          <DiffEditor blocks={single.blocks} marks={single.marks} testId="diff-single-editor" rootRef={singleRoot} knowledge={knowledgeSingle} />
        </div>
      );
    }
  }

  return (
    <div ref={ref} className="relative flex min-h-full flex-col p-4">
      {splitHead}
      {body}
      {nonText.map((c) => (
        <Button key={c.key} type="button" variant="outline" size="sm" className="absolute h-7 bg-background text-xs" style={{ top: tops[c.key] ?? 0, right: "1rem" }} onClick={() => setOpened(c)}>
          {t("versions.preview.nonTextChanged")}
        </Button>
      ))}
      {opened && <NonTextDialog change={opened} onClose={() => setOpened(null)} />}
    </div>
  );
}
