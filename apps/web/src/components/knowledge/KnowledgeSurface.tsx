import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { summarizeKnowledgeDescendants, type KnowledgeEntry } from "@knotebook/shared";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { jumpToHeading } from "@/components/outline/outline-jump";
import { returnFocusQuietly, type KnowledgeController } from "./controller";
import { KnowledgeCard, type KnowledgeReplacementView } from "./KnowledgeCard";
import { attrValue } from "./placement";
import { useKnowledgeReplacement } from "./use-knowledge-replacement";

export interface KnowledgeContext {
  container: HTMLElement | null;
  entries: readonly KnowledgeEntry[];
  editable: boolean;
  noteId: string | null;
  controller: KnowledgeController;
  replacementOf?: (entry: KnowledgeEntry) => KnowledgeReplacementView | null;
  editSurface?: (blockId: string, close: () => void) => ReactNode;
  sheetFooter?: (entry: KnowledgeEntry) => ReactNode;
}

/** Reads the live entries when it renders, so a card that opens later still shows the current text. */
export function LiveCard({ ctx, blockId, variant, onEdit }: { ctx: KnowledgeContext; blockId: string; variant: "hover" | "sheet"; onEdit: () => void }) {
  const { entries, controller } = ctx;
  const entry = entries.find((e) => e.blockId === blockId);
  const jump = (id: string) => {
    controller.close();
    if (ctx.container) jumpToHeading(ctx.container, id);
  };
  const model = useMemo(() => {
    if (!entry) return null;
    const parent = entry.parentBlockId ? (entries.find((e) => e.blockId === entry.parentBlockId) ?? null) : null;
    // The nearest outdated ancestor explains the inherited state best.
    let outdatedAncestor: KnowledgeEntry | null = null;
    for (let i = entry.ancestorBlockIds.length - 1; i >= 0 && !outdatedAncestor; i -= 1) {
      const found = entries.find((e) => e.blockId === entry.ancestorBlockIds[i]);
      if (found && found.info.status === "outdated") outdatedAncestor = found;
    }
    return { parent, outdatedAncestor, summary: summarizeKnowledgeDescendants(entries, entry.blockId) };
  }, [entries, entry]);
  const resolved = useKnowledgeReplacement(entry ?? null, entries, ctx.noteId, jump);
  if (!entry || !model) return null;
  const replacement = ctx.replacementOf && entry.info.status === "outdated" ? ctx.replacementOf(entry) : resolved;
  return (
    <KnowledgeCard
      entry={entry}
      parent={model.parent}
      outdatedAncestor={model.outdatedAncestor}
      summary={model.summary}
      replacement={replacement}
      variant={variant}
      canEdit={ctx.editable}
      onEdit={onEdit}
      onJump={jump}
      footer={variant === "sheet" ? ctx.sheetFooter?.(entry) : undefined}
    />
  );
}

function headingBlock(container: HTMLElement | null, blockId: string): HTMLElement | null {
  const outer = container?.querySelector<HTMLElement>(`.bn-block-outer[data-id="${attrValue(blockId)}"]`) ?? null;
  return outer?.querySelector<HTMLElement>(":scope > .bn-block > .bn-block-content") ?? null;
}

export function KnowledgeSurface({ ctx, phone }: { ctx: KnowledgeContext; phone: boolean }) {
  const { t } = useTranslation();
  const { controller, container, entries } = ctx;
  const state = controller.state;
  const entry = state ? entries.find((e) => e.blockId === state.blockId) : undefined;
  const blockId = state?.blockId;
  const mode = state?.mode;
  // The form owns its own target: a heading that is not knowledge yet has no entry, and one a collaborator changed is noticed by the form itself.
  const editing = state?.mode === "edit" && ctx.editable && ctx.editSurface !== undefined;
  const missing = state !== null && !entry && !editing;
  const { close } = controller;
  // Set when the surface was dismissed by pressing or focusing elsewhere: focus must stay where the user put it.
  const dismissedOutside = useRef(false);

  useEffect(() => {
    if (missing) close();
  }, [missing, close]);

  const anchor = useMemo(() => {
    if (!blockId || phone) return null;
    const icon = container?.querySelector<HTMLElement>(`[data-kb-knowledge-icon][data-block-id="${attrValue(blockId)}"]`) ?? null;
    if (mode === "view" && icon) return { getBoundingClientRect: () => icon.getBoundingClientRect(), contextElement: icon };
    if (!headingBlock(container, blockId)) return null;
    // Looked up on every read: a collaborator's change to the heading's attributes makes ProseMirror replace its DOM node.
    return {
      getBoundingClientRect: () => {
        const block = headingBlock(container, blockId);
        if (!block) return new DOMRect();
        const text = block.querySelector<HTMLElement>(".bn-inline-content")?.getBoundingClientRect() ?? block.getBoundingClientRect();
        return new DOMRect(text.left, block.getBoundingClientRect().bottom, 0, 0);
      },
      get contextElement() {
        return headingBlock(container, blockId) ?? undefined;
      },
    };
  }, [blockId, mode, container, phone]);

  if (!state || (!entry && !editing)) return null;
  const label = entry ? entry.heading || t("knowledge.card.untitled") : t("knowledge.form.title");
  const onEdit = () => controller.open(state.blockId, "edit", state.returnFocus);
  const returnFocus = (event: Event) => {
    event.preventDefault();
    const outside = dismissedOutside.current;
    dismissedOutside.current = false;
    if (!outside) returnFocusQuietly(state.returnFocus);
  };
  // A combobox's own list takes the first Escape.
  const escape = (event: KeyboardEvent) => {
    if ((event.target as Element | null)?.closest?.('[role="combobox"][aria-expanded="true"]')) event.preventDefault();
  };
  // The first tabbable control in the form is the remove link: focus the first field instead, and on a phone leave the keyboard down.
  const openFocus = (event: Event) => {
    if (!editing) return;
    const root = event.currentTarget as HTMLElement | null;
    const first = phone ? null : root?.querySelector<HTMLElement>("[data-kb-autofocus]");
    event.preventDefault();
    (first ?? root)?.focus({ preventScroll: true });
  };
  const noteOutside = (event: Event) => {
    if (!event.defaultPrevented) dismissedOutside.current = true;
  };
  const body = editing ? ctx.editSurface!(state.blockId, close) : !entry ? null : <LiveCard ctx={ctx} blockId={state.blockId} variant={phone ? "sheet" : "hover"} onEdit={onEdit} />;

  if (phone) {
    return (
      <Dialog open onOpenChange={(open) => !open && close()}>
        <DialogContent aria-describedby={undefined} dismissOnOutside={!editing} onInteractOutside={editing ? undefined : noteOutside} onCloseAutoFocus={returnFocus} onOpenAutoFocus={openFocus} onEscapeKeyDown={escape} className="grid-cols-[minmax(0,1fr)] gap-3 max-sm:p-4">
          {!editing && <DialogTitle className="pr-6 text-[15px] leading-snug">{label}</DialogTitle>}
          {body}
        </DialogContent>
      </Dialog>
    );
  }
  return (
    <Popover open onOpenChange={(open) => !open && close()}>
      {anchor && <PopoverAnchor virtualRef={{ current: anchor }} />}
      <PopoverContent
        side="bottom"
        align={state.mode === "edit" ? "start" : "center"}
        collisionPadding={8}
        className={editing ? "max-h-[var(--radix-popover-content-available-height)] w-[420px] max-w-[calc(100vw-1rem)] overflow-y-auto p-3" : "w-[350px] max-w-[calc(100vw-1rem)] p-3"}
        aria-label={label}
        onCloseAutoFocus={returnFocus}
        onOpenAutoFocus={openFocus}
        onEscapeKeyDown={escape}
        // The icon toggles the surface itself; letting the outside-press close it first would make the click reopen it.
        onInteractOutside={(e) => {
          if (editing || (e.target as Element | null)?.closest?.("[data-kb-knowledge-icon]")) e.preventDefault();
          noteOutside(e);
        }}
      >
        {body}
      </PopoverContent>
    </Popover>
  );
}
