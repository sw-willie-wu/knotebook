import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { NoteDto, NoteTagDto } from "@knotebook/shared";
import { tagSpaceOfNote, useAddNoteTag, useNoteTags, useRemoveNoteTag, useSpaceTags } from "@/api/tags";
import { errorMessage } from "@/api/favorites";
import { Plus } from "@/components/ui/icons";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { TagCombobox } from "./TagCombobox";
import { TagPill } from "./TagPill";
import { fitPills } from "./pill-fit";
import { tagEntryReturnFocus, useTagEntryRequest } from "./tag-entry";

const NO_TAGS: readonly NoteTagDto[] = [];
const GAP_PX = 5;
const ADD_WIDTH_PX = 20;
const INPUT_WIDTH_PX = 144;
// The "+N" button is a fixed width so the fit never depends on its own count.
const MORE_WIDTH_PX = 40;

const CHIP_BUTTON =
  "relative inline-flex h-5 shrink-0 items-center justify-center rounded-full text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:after:absolute pointer-coarse:after:-inset-2 pointer-coarse:after:content-['']";

/** Renders nothing for a note without tags unless the input was asked for (`openTagEntry`) and is still open. `canEdit` is the tag permission (`canEditNoteTags`), not the note's edit role: an edit share reads tags but never changes them. */
export function NoteTagRow({ note, canEdit }: { note: NoteDto; canEdit: boolean }) {
  const { t } = useTranslation();
  const tags = useNoteTags(note.id);
  const space = tagSpaceOfNote(note);
  const [inputOpen, setInputOpen] = useState(false);
  // Only requests made after this row mounted count, so coming back to a note never reopens the input.
  const request = useTagEntryRequest(note.id);
  const [seenRequest, setSeenRequest] = useState(request);
  if (request !== seenRequest) {
    setSeenRequest(request);
    if (canEdit) setInputOpen(true);
  }
  const list = tags ?? NO_TAGS;
  // The space list only completes names, so it is fetched when the input opens and never for someone who cannot edit.
  const spaceTags = useSpaceTags(space, { enabled: canEdit && inputOpen });
  const add = useAddNoteTag();
  const remove = useRemoveNoteTag();
  const addRef = useRef<HTMLButtonElement>(null);
  const refocusAddRef = useRef(false);
  const returnFocusRef = useRef(false);

  useEffect(() => {
    if (inputOpen) return;
    // With tags the "+" is still there to take focus; without any, the row is gone and the requester says where focus goes back.
    if (refocusAddRef.current) {
      refocusAddRef.current = false;
      addRef.current?.focus();
    } else if (returnFocusRef.current) {
      returnFocusRef.current = false;
      tagEntryReturnFocus(note.id)?.();
    }
  }, [inputOpen, note.id]);

  if (list.length === 0 && !(canEdit && inputOpen)) return null;

  async function submit(name: string): Promise<boolean> {
    if (list.some((tag) => tag.name.toLowerCase() === name.toLowerCase())) return true;
    if (add.isPending) return false;
    try {
      await add.mutateAsync({ noteId: note.id, name, space });
      return true;
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
      return false;
    }
  }

  function removeTag(tag: NoteTagDto): void {
    remove.mutate(
      { noteId: note.id, tagId: tag.id, space },
      { onError: (err) => toast({ title: errorMessage(t, err), variant: "destructive" }) },
    );
  }

  return (
    <TagRowBody
      tags={list}
      canEdit={canEdit}
      inputOpen={inputOpen}
      onRemove={removeTag}
      removingId={remove.isPending ? remove.variables?.tagId : undefined}
      addRef={addRef}
      onOpenInput={() => setInputOpen(true)}
      input={
        <TagCombobox
          key={request}
          loading={spaceTags.isLoading}
          closeOnTab={list.length === 0}
          spaceTags={spaceTags.data ?? []}
          noteTags={list}
          onSubmit={submit}
          onClose={(reason) => {
            // A blur may follow the key close while the input unmounts; it must not undo the choice made here.
            if (reason !== "blur") {
              refocusAddRef.current = list.length > 0;
              returnFocusRef.current = list.length === 0;
            }
            setInputOpen(false);
          }}
        />
      }
    />
  );
}

interface TagRowBodyProps {
  tags: readonly NoteTagDto[];
  canEdit: boolean;
  inputOpen: boolean;
  onRemove: (tag: NoteTagDto) => void;
  removingId: string | undefined;
  addRef: RefObject<HTMLButtonElement | null>;
  onOpenInput: () => void;
  input: ReactNode;
}

function TagRowBody({ tags, canEdit, inputOpen, onRemove, removingId, addRef, onOpenInput, input }: TagRowBodyProps) {
  const { t } = useTranslation();
  const rowRef = useRef<HTMLDivElement>(null);
  const pillRefs = useRef(new Map<string, HTMLElement>());
  const [expanded, setExpanded] = useState(false);
  // Infinity until measured: the first paint shows every pill, then the layout effect trims before the browser paints.
  const [visibleCount, setVisibleCount] = useState(Infinity);
  const [resizeTick, setResizeTick] = useState(0);
  const moreRef = useRef<HTMLButtonElement>(null);
  const lessRef = useRef<HTMLButtonElement>(null);
  // Toggling swaps one button for the other; without this focus would fall to <body>.
  const focusToggleRef = useRef<"more" | "less" | null>(null);

  useEffect(() => {
    const target = focusToggleRef.current;
    focusToggleRef.current = null;
    if (target === "less") lessRef.current?.focus();
    else if (target === "more") moreRef.current?.focus();
  }, [expanded]);

  useLayoutEffect(() => {
    const row = rowRef.current;
    if (expanded || !row) return;
    const rowWidth = row.clientWidth;
    // No layout (hidden ancestor, or no layout engine): nothing to measure against.
    if (rowWidth === 0) {
      setVisibleCount(Infinity);
      return;
    }
    const widths = tags.map((tag) => Math.min(pillRefs.current.get(tag.id)?.offsetWidth ?? 0, rowWidth));
    const trailing = canEdit ? (inputOpen ? INPUT_WIDTH_PX : ADD_WIDTH_PX) + GAP_PX : 0;
    setVisibleCount(fitPills(widths, rowWidth - trailing, GAP_PX, MORE_WIDTH_PX));
  }, [tags, expanded, canEdit, inputOpen, resizeTick]);

  useEffect(() => {
    const row = rowRef.current;
    if (!row || typeof ResizeObserver === "undefined") return;
    let lastWidth = row.clientWidth;
    const observer = new ResizeObserver(() => {
      if (row.clientWidth === lastWidth) return;
      lastWidth = row.clientWidth;
      setResizeTick((n) => n + 1);
    });
    observer.observe(row);
    return () => observer.disconnect();
  }, []);

  const setPillRef = useCallback(
    (id: string) => (node: HTMLElement | null) => {
      if (node) pillRefs.current.set(id, node);
      else pillRefs.current.delete(id);
    },
    [],
  );

  const shownCount = expanded ? tags.length : Math.min(visibleCount, tags.length);
  const hiddenCount = tags.length - shownCount;

  return (
    <div
      ref={rowRef}
      role="group"
      aria-label={t("tags.label")}
      data-note-tags=""
      className={cn("relative flex items-center gap-x-[5px]", expanded ? "flex-wrap gap-y-[3px]" : "flex-nowrap")}
    >
      {tags.map((tag, index) => {
        const hidden = index >= shownCount;
        return (
          <span
            key={tag.id}
            ref={setPillRef(tag.id)}
            data-pill-hidden={hidden ? "" : undefined}
            aria-hidden={hidden || undefined}
            className={cn("inline-flex min-w-0 max-w-full", hidden && "pointer-events-none invisible absolute left-0 top-0")}
          >
            <TagPill tag={tag} onRemove={canEdit ? () => onRemove(tag) : undefined} removeDisabled={removingId === tag.id} />
          </span>
        );
      })}
      {hiddenCount > 0 && (
        <button
          ref={moreRef}
          type="button"
          aria-label={t("tags.more", { count: hiddenCount })}
          aria-expanded={false}
          onClick={() => {
            focusToggleRef.current = "less";
            setExpanded(true);
          }}
          className={cn(CHIP_BUTTON, "w-10 bg-muted")}
        >
          +{hiddenCount}
        </button>
      )}
      {expanded && (
        <button
          ref={lessRef}
          type="button"
          aria-expanded={true}
          onClick={() => {
            focusToggleRef.current = "more";
            setExpanded(false);
          }}
          className={cn(CHIP_BUTTON, "px-2")}
        >
          {t("tags.showLess")}
        </button>
      )}
      {canEdit &&
        (inputOpen ? (
          input
        ) : (
          <button ref={addRef} type="button" aria-label={t("tags.add")} onClick={onOpenInput} className={cn(CHIP_BUTTON, "size-5")}>
            <Plus aria-hidden="true" className="size-3.5" />
          </button>
        ))}
    </div>
  );
}
