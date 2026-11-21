import { useId, useLayoutEffect, useMemo, useRef, useState, type InputHTMLAttributes, type KeyboardEvent, type MutableRefObject, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { Placement } from "@floating-ui/react";
import { useGroups } from "@/api/groups";
import { useNotes } from "@/api/notes";
import "@/i18n/tags-strings";
import { TagDot } from "@/components/tags/TagDot";
import { X } from "@/components/ui/icons";
import { useSidebarQuery } from "@/lib/sidebar-query";
import { TagHashList } from "./TagHashList";
import { addToken, filterableTagSpaces, hashFragmentAt, hashOptions, removeFragment, spaceKeyOf, tokenFromTag } from "./search-tags-logic";

/** Attributes the input takes while the completion list can be open (built here so the first bundle doesn't carry the attribute names). */
export type ComboboxAria = InputHTMLAttributes<HTMLInputElement>;

/** Return true when the key was used here; the box then does nothing else with it. */
export type KeyHandler = (event: KeyboardEvent<HTMLInputElement>) => boolean;

export interface TagSearchControllerProps {
  query: string;
  onQueryChange: (query: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  reference: HTMLElement | null;
  placement: Placement;
  focused: boolean;
  caret: number;
  onCaret: (caret: number) => void;
  keyRef: MutableRefObject<KeyHandler | null>;
  onAria: (aria: ComboboxAria | null) => void;
}

/**
 * Everything the search box needs only when a tag is involved (a token exists or a `#` was typed), loaded as one lazy chunk (initial-bundle cap):
 * the tokens in front of the text, the `#` completion list and the keys that drive it. The input itself stays in the entry; this reaches it through `keyRef` and `onAria`.
 */
export default function TagSearchController({ query, onQueryChange, searchRef, reference, placement, focused, caret, onCaret, keyRef, onAria }: TagSearchControllerProps) {
  const { t } = useTranslation();
  const { tagTokens, setTagTokens } = useSidebarQuery();
  const notes = useNotes().data;
  const groups = useGroups().data;
  const spaces = useMemo(() => filterableTagSpaces(notes ?? [], groups ?? []), [notes, groups]);
  const listId = useId();
  const optionId = (index: number) => `${listId}-opt-${index}`;
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [activeState, setActiveState] = useState<{ key: string; index: number }>({ key: "", index: 0 });
  const pendingCaret = useRef<number | null>(null);

  const hash = useMemo(() => (spaces.length === 0 ? null : hashFragmentAt(query, Math.min(caret, query.length))), [spaces.length, query, caret]);
  const sections = useMemo(() => (hash === null ? [] : hashOptions(spaces, hash.fragment, tagTokens)), [spaces, hash, tagTokens]);
  const flat = useMemo(() => sections.flatMap((section) => section.tags.map((tag) => ({ tag, space: section.space }))), [sections]);
  const hasOptions = focused && hash !== null && flat.length > 0;
  const open = hasOptions && dismissed !== hash.start;
  const fragmentKey = hash === null ? "" : `${hash.start}:${hash.fragment}`;
  const activeIndex = activeState.key === fragmentKey ? Math.min(activeState.index, flat.length - 1) : 0;
  const start = hash?.start ?? 0;
  const end = hash === null ? 0 : start + 1 + hash.fragment.length;

  // A highlight left over from an earlier list must not carry into the next one that has the same word.
  if (!open && activeState.key !== "") setActiveState({ key: "", index: 0 });

  // Esc keeps the word as plain text until the caret leaves it.
  if (dismissed !== null && (hash === null || hash.start !== dismissed)) setDismissed(null);

  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    searchRef.current?.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [query, searchRef]);

  const controls = open ? listId : undefined;
  const activeDescendant = open ? optionId(activeIndex) : undefined;
  useLayoutEffect(() => {
    onAria(
      hasOptions
        ? { role: "combobox", "aria-autocomplete": "list", "aria-expanded": open, "aria-controls": controls, "aria-activedescendant": activeDescendant }
        : null,
    );
  }, [onAria, hasOptions, open, controls, activeDescendant]);
  useLayoutEffect(() => () => onAria(null), [onAria]);

  function pick(index: number): void {
    const choice = flat[index];
    if (choice === undefined || hash === null) return;
    const next = removeFragment(query, { start, end });
    pendingCaret.current = next.caret;
    onCaret(next.caret);
    onQueryChange(next.text);
    setTagTokens(addToken(tagTokens, tokenFromTag(choice.tag, choice.space)));
    searchRef.current?.focus();
  }

  const handleKey: KeyHandler = (event) => {
    if (open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : -1;
        setActiveState({ key: fragmentKey, index: (activeIndex + step + flat.length) % flat.length });
        return true;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        pick(activeIndex);
        return true;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDismissed(start);
        return true;
      }
    }
    if (event.key === "Backspace" && tagTokens.length > 0 && event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0) {
      event.preventDefault();
      setTagTokens(tagTokens.slice(0, -1));
      return true;
    }
    return false;
  };
  useLayoutEffect(() => {
    keyRef.current = handleKey;
    return () => {
      keyRef.current = null;
    };
  });

  return (
    <>
      {tagTokens.length > 0 && (
        <ul className="contents">
          {tagTokens.map((token) => (
            <li key={token.id} data-space={spaceKeyOf(token.space)} className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-full bg-muted py-0.5 pl-2 pr-1 text-xs">
              <TagDot color={token.color} />
              <span className="truncate">{token.name}</span>
              <button
                type="button"
                aria-label={t("tagSearch.removeToken", { name: token.name })}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setTagTokens(tagTokens.filter((other) => other.id !== token.id));
                  searchRef.current?.focus();
                }}
                className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-background hover:text-foreground pointer-coarse:size-6"
              >
                <X aria-hidden="true" className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <TagHashList
          sections={sections}
          activeIndex={activeIndex}
          listId={listId}
          optionId={optionId}
          reference={reference}
          placement={placement}
          onPick={pick}
          onHover={(index) => setActiveState({ key: fragmentKey, index })}
        />
      )}
    </>
  );
}
