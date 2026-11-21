import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { parseKnowledgeRef } from "@knotebook/shared";
import type { KnowledgeRefCandidate, KnowledgeRefSource } from "./ref-source";

export interface SupersedePickerProps {
  id: string;
  labelledBy: string;
  describedBy?: string;
  invalid?: boolean;
  /** The stored reference, or "". */
  value: string;
  source: KnowledgeRefSource;
  /** Candidates with this reference are left out of the list (the knowledge being edited). */
  exclude?: (candidate: KnowledgeRefCandidate) => boolean;
  onChange: (ref: string) => void;
}

const MAX_SHOWN = 50;

/** The list is part of the form's layout, not a portal: inside a popover or a modal dialog a portalled list would count as an outside press. */
export function SupersedePicker({ id, labelledBy, describedBy, invalid, value, source, exclude, onChange }: SupersedePickerProps) {
  const { t } = useTranslation();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<KnowledgeRefCandidate[]>([]);
  const [active, setActive] = useState(0);
  const [selected, setSelected] = useState<KnowledgeRefCandidate | null>(null);
  const excludeRef = useRef(exclude);
  excludeRef.current = exclude;

  useEffect(() => {
    if (value === "") {
      setSelected(null);
      return;
    }
    const abort = new AbortController();
    void source.resolve(value, abort.signal).then((found) => {
      if (!abort.signal.aborted) setSelected(found);
    });
    return () => abort.abort();
  }, [value, source]);

  useEffect(() => {
    if (!open) return;
    const abort = new AbortController();
    void source.search(query, abort.signal).then((found) => {
      if (abort.signal.aborted) return;
      setResults(found.filter((c) => !excludeRef.current?.(c)).slice(0, MAX_SHOWN));
      setActive(0);
    });
    return () => abort.abort();
  }, [open, query, source]);

  const choose = (candidate: KnowledgeRefCandidate) => {
    onChange(candidate.ref);
    setSelected(candidate);
    setQuery("");
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // An Enter that confirms an input-method composition must not pick a row.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) setOpen(true);
      else setActive((i) => Math.min(i + 1, Math.max(results.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter" && open) {
      // Also keeps the form's own Enter-to-save from firing while a row is being picked.
      event.preventDefault();
      event.stopPropagation();
      const row = results[active];
      if (row) choose(row);
    } else if (event.key === "Escape" && open) {
      event.stopPropagation();
      setOpen(false);
    }
  };

  const shown = selected ? (selected.heading || t("knowledge.card.untitled")) : value !== "" ? t(parseKnowledgeRef(value)?.noteId == null ? "knowledge.card.refMissing" : "knowledge.card.refOtherNote") : "";
  const optionId = (i: number) => `${listId}-${i}`;
  return (
    <div className="relative">
      <Input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && results[active] ? optionId(active) : undefined}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        autoComplete="off"
        value={open ? query : shown}
        placeholder={shown || t("knowledge.picker.placeholder")}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onBlur={(e) => {
          if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node | null)) {
            setOpen(false);
            setQuery("");
          }
        }}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-labelledby={labelledBy}
          className="mt-1 max-h-40 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-sm"
        >
          {results.length === 0 && <li role="presentation" className="px-2 py-1.5 text-sm text-muted-foreground">{t("knowledge.picker.none")}</li>}
          {results.map((candidate, i) => (
            <li
              key={candidate.ref}
              id={optionId(i)}
              role="option"
              aria-selected={candidate.ref === value}
              // mousedown, not click: the input's blur would close the list before a click lands.
              onMouseDown={(e) => {
                e.preventDefault();
                choose(candidate);
              }}
              onMouseMove={() => setActive(i)}
              className={cn("cursor-default rounded-sm px-2 py-1.5 text-sm pointer-coarse:py-2.5", i === active && "bg-accent text-accent-foreground")}
            >
              <span className="block truncate font-medium">{candidate.heading || t("knowledge.card.untitled")}</span>
              {candidate.noteTitle && <span className="block truncate text-xs text-muted-foreground">{candidate.noteTitle}</span>}
              {candidate.conclusion && <span className="block truncate text-xs text-muted-foreground">{candidate.conclusion}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
