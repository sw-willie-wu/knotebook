import "@/i18n/comments-strings";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { autoUpdate, flip, offset, size, useFloating } from "@floating-ui/react";
import type { MentionCandidateDto } from "@knotebook/shared";
import { Avatar } from "@/components/Avatar";
import { cn } from "@/lib/utils";
import type { MentionToken } from "./mention-token";

export interface MentionOption {
  key: string;
  /** What replaces the typed token (without the trailing space). */
  insert: string;
  candidate: MentionCandidateDto;
  /** Set for an agent-label row listed under its person. */
  label: string | null;
}

/** A person's rows are the person, then each explicit agent label. After `@handle/` only that person's labels matching the typed prefix stay. */
export function buildMentionOptions(candidates: readonly MentionCandidateDto[], token: MentionToken): MentionOption[] {
  const out: MentionOption[] = [];
  for (const c of candidates) {
    if (token.label !== null) {
      if (c.handle.toLowerCase() !== token.handle) continue;
      const typed = token.label.toLowerCase();
      for (const label of c.agentLabels) if (label.toLowerCase().startsWith(typed)) out.push({ key: `${c.userId}/${label}`, insert: `@${c.handle}/${label}`, candidate: c, label });
      continue;
    }
    out.push({ key: c.userId, insert: `@${c.handle}`, candidate: c, label: null });
    for (const label of c.agentLabels) out.push({ key: `${c.userId}/${label}`, insert: `@${c.handle}/${label}`, candidate: c, label });
  }
  return out;
}

export interface MentionListProps {
  id: string;
  options: readonly MentionOption[];
  active: number;
  reference: HTMLElement | null;
  onPick: (option: MentionOption) => void;
  onHover: (index: number) => void;
}

export function mentionOptionId(listId: string, index: number): string {
  return `${listId}-opt-${index}`;
}

/** Not portalled, so a click on an option stays inside the panel (an outside press must not count as one). */
export function MentionList({ id, options, active, reference, onPick, onHover }: MentionListProps) {
  const { t } = useTranslation();
  const { refs, floatingStyles } = useFloating({
    open: true,
    placement: "top-start",
    strategy: "fixed",
    whileElementsMounted: autoUpdate,
    elements: { reference },
    middleware: [
      offset(4),
      flip({ padding: 8 }),
      size({
        padding: 8,
        apply({ rects, availableHeight, elements }) {
          elements.floating.style.minWidth = `${rects.reference.width}px`;
          elements.floating.style.maxHeight = `${Math.max(120, Math.min(280, availableHeight))}px`;
        },
      }),
    ],
  });
  useEffect(() => {
    document.getElementById(mentionOptionId(id, active))?.scrollIntoView?.({ block: "nearest" });
  }, [id, active]);
  return (
    <ul
      ref={refs.setFloating}
      id={id}
      role="listbox"
      aria-label={t("comments.mention.listLabel")}
      // mousedown would blur the textarea and close the list, also when it lands on the list's own scrollbar.
      onMouseDown={(event) => event.preventDefault()}
      style={floatingStyles}
      className="z-50 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
    >
      {options.map((o, index) => (
        <li
          key={o.key}
          id={mentionOptionId(id, index)}
          role="option"
          aria-selected={index === active}
          onClick={() => onPick(o)}
          onMouseMove={() => onHover(index)}
          className={cn(
            "flex min-w-0 cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
            o.label !== null && "pl-9",
            index === active && "bg-accent text-accent-foreground",
          )}
        >
          {o.label === null ? (
            <>
              <Avatar name={o.candidate.displayName} avatar={o.candidate.avatar} size={24} />
              <span className="flex min-w-0 flex-col">
                <span className="truncate font-medium">{o.candidate.displayName}</span>
                <span className="truncate text-xs text-muted-foreground">@{o.candidate.handle}</span>
              </span>
            </>
          ) : (
            <span className="truncate text-xs">
              @{o.candidate.handle}/{o.label}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}
