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
  /** This note's knowledge; answers at once. */
  source: KnowledgeRefSource;
  /** Other notes' knowledge, asked once typing pauses; without it only this note is listed. */
  remote?: KnowledgeRefSource | null;
  /** Candidates with this reference are left out of the list (the knowledge being edited). */
  exclude?: (candidate: KnowledgeRefCandidate) => boolean;
  onChange: (ref: string) => void;
}

const MAX_SHOWN = 50;
const REMOTE_DEBOUNCE_MS = 250;

type RemoteState = { items: KnowledgeRefCandidate[]; error: "failed" | "busy" | null };
const NO_REMOTE: RemoteState = { items: [], error: null };

/** The list is part of the form's layout, not a portal: inside a popover or a modal dialog a portalled list would count as an outside press. */
export function SupersedePicker({ id, labelledBy, describedBy, invalid, value, source, remote, exclude, onChange }: SupersedePickerProps) {
  const { t } = useTranslation();
  const listId = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<KnowledgeRefCandidate[]>([]);
  const [others, setOthers] = useState<RemoteState>(NO_REMOTE);
  const [composing, setComposing] = useState(false);
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
    const settle = (found: KnowledgeRefCandidate | null) => {
      if (!abort.signal.aborted) setSelected(found);
    };
    void source
      .resolve(value, abort.signal)
      .then((found) => (found || !remote ? found : remote.resolve(value, abort.signal)))
      .then(settle, () => settle(null));
    return () => abort.abort();
  }, [value, source, remote]);

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

  const trimmed = query.trim();
  useEffect(() => {
    setOthers(NO_REMOTE);
    if (!open || !remote || composing || trimmed === "") return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      remote.search(trimmed, abort.signal).then(
        (found) => {
          if (!abort.signal.aborted) setOthers({ items: found.filter((c) => !excludeRef.current?.(c)).slice(0, MAX_SHOWN), error: null });
        },
        (err: unknown) => {
          if (abort.signal.aborted) return;
          setOthers({ items: [], error: (err as { status?: number } | null)?.status === 429 ? "busy" : "failed" });
        },
      );
    }, REMOTE_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [open, remote, composing, trimmed]);

  const rows = [...results, ...others.items];

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
      else setActive((i) => Math.min(i + 1, Math.max(rows.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (event.key === "Enter" && open) {
      // Also keeps the form's own Enter-to-save from firing while a row is being picked.
      event.preventDefault();
      event.stopPropagation();
      const row = rows[active];
      if (row) choose(row);
    } else if (event.key === "Escape" && open) {
      event.stopPropagation();
      setOpen(false);
    }
  };

  const shown = selected ? (selected.heading || t("knowledge.card.untitled")) : value !== "" ? t(parseKnowledgeRef(value)?.noteId == null ? "knowledge.card.refMissing" : "knowledge.card.refOtherNote") : "";
  const optionId = (i: number) => `${listId}-${i}`;
  const renderRow = (candidate: KnowledgeRefCandidate, i: number) => (
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
  );
  const sectionTitle = (key: string) => (
    <li role="presentation" className="px-2 pb-0.5 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {t(key)}
    </li>
  );
  const note = (text: string) => (
    <li role="presentation" className="px-2 py-1.5 text-sm text-muted-foreground">
      {text}
    </li>
  );
  return (
    <div className="relative">
      <Input
        id={id}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && rows[active] ? optionId(active) : undefined}
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
        onCompositionStart={() => setComposing(true)}
        onCompositionEnd={() => setComposing(false)}
        onKeyDown={onKeyDown}
      />
      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-labelledby={labelledBy}
          className="mt-1 max-h-40 overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-sm"
        >
          {remote && sectionTitle("knowledge.picker.thisNote")}
          {results.length === 0 && note(t("knowledge.picker.none"))}
          {results.map((candidate, i) => renderRow(candidate, i))}
          {remote && trimmed !== "" && (
            <>
              {sectionTitle("knowledge.picker.otherNotes")}
              {others.error === "busy" && note(t("knowledge.picker.searchBusy"))}
              {others.error === "failed" && note(t("knowledge.picker.searchFailed"))}
              {others.items.map((candidate, i) => renderRow(candidate, results.length + i))}
            </>
          )}
        </ul>
      )}
    </div>
  );
}
