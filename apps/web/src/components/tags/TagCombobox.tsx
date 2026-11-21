import { useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { autoUpdate, flip, offset, size, useFloating } from "@floating-ui/react";
import { normalizeTagName, type NoteTagDto, type SpaceTagDto } from "@knotebook/shared";
import { tagSuggestions } from "@/lib/tag-suggestions";
import { cn } from "@/lib/utils";
import { TagDot } from "./TagDot";
import { tagOptions, type TagOption } from "./tag-options";

export interface TagComboboxProps {
  spaceTags: readonly SpaceTagDto[];
  noteTags: readonly NoteTagDto[];
  /** Resolves true when the tag is on the note afterwards; the input is cleared then and stays open for the next one. */
  onSubmit: (name: string) => Promise<boolean>;
  onClose: (reason: "escape" | "tab" | "blur") => void;
  /** True while the space list is still loading: nothing is listed then, so the existing tags never appear above suggestions that were already on screen. */
  loading?: boolean;
  /** Tab closes the input instead of moving on; for a row with no tags left, where leaving would drop focus on <body>. */
  closeOnTab?: boolean;
}

function optionName(option: TagOption): string {
  return option.kind === "existing" ? option.tag.name : option.name;
}

/** Not portalled, and everything in the list swallows mousedown: a portal or a mousedown default would blur the input, which closes it. */
export function TagCombobox({ spaceTags, noteTags, onSubmit, onClose, loading = false, closeOnTab = false }: TagComboboxProps) {
  const { t } = useTranslation();
  const listId = useId();
  const optionId = (index: number) => `${listId}-opt-${index}`;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [invalid, setInvalid] = useState(false);

  // A layout effect, so an input mounted inside a user gesture (flushSync) has focus before the gesture ends; iOS only raises the keyboard then.
  useLayoutEffect(() => {
    inputRef.current?.focus();
  }, []);

  const options = useMemo(() => {
    if (loading) return [];
    const existingKeys = new Set(spaceTags.map((tag) => tag.name.toLowerCase()));
    return tagOptions({
      query,
      spaceTags,
      noteTagIds: new Set(noteTags.map((tag) => tag.id)),
      suggestions: tagSuggestions(t, { query, existingKeys }),
    });
  }, [query, spaceTags, noteTags, t, loading]);
  const activeIndex = active < options.length ? active : -1;
  const expanded = options.length > 0 || invalid;

  const { refs, floatingStyles } = useFloating({
    open: expanded,
    placement: "bottom-start",
    strategy: "fixed",
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(4),
      flip({ padding: 8 }),
      size({
        padding: 8,
        apply({ availableHeight, elements }) {
          elements.floating.style.minWidth = "12rem";
          elements.floating.style.maxHeight = `${Math.max(120, Math.min(280, availableHeight))}px`;
        },
      }),
    ],
  });

  async function submit(name: string): Promise<void> {
    if (await onSubmit(name)) {
      setQuery("");
      setActive(-1);
      setInvalid(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      if (options.length === 0) return;
      event.preventDefault();
      setActive((i) => (i + 1 >= options.length ? 0 : i + 1));
    } else if (event.key === "ArrowUp") {
      if (options.length === 0) return;
      event.preventDefault();
      setActive((i) => (i <= 0 ? options.length - 1 : i - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (activeIndex >= 0) {
        void submit(optionName(options[activeIndex]!));
        return;
      }
      const name = normalizeTagName(query);
      if (name === null) {
        setInvalid(true);
        return;
      }
      const existing = spaceTags.find((tag) => tag.name.toLowerCase() === name.toLowerCase());
      void submit(existing?.name ?? name);
    } else if (event.key === "Tab" && closeOnTab) {
      event.preventDefault();
      onClose("tab");
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose("escape");
    }
  }

  const groups: Array<{ key: string; label: string; items: Array<{ option: TagOption; index: number }> }> = [];
  options.forEach((option, index) => {
    const key = option.kind === "suggestion" ? "suggested" : "inSpace";
    let group = groups.find((g) => g.key === key);
    if (!group) {
      group = { key, label: t(key === "suggested" ? "tags.suggested" : "tags.inSpace"), items: [] };
      groups.push(group);
    }
    group.items.push({ option, index });
  });

  return (
    <div ref={refs.setReference} className="inline-flex">
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        autoComplete="off"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-activedescendant={expanded && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-label={t("tags.inputLabel")}
        aria-invalid={invalid || undefined}
        placeholder={t("tags.inputPlaceholder")}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(-1);
          setInvalid(false);
        }}
        onKeyDown={handleKeyDown}
        onBlur={() => onClose("blur")}
        className="h-5 w-36 rounded-full border border-input bg-background px-2 text-xs shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring pointer-coarse:h-8 pointer-coarse:text-base"
      />
      {expanded && (
        <div
          ref={refs.setFloating}
          id={listId}
          style={floatingStyles}
          className="z-50 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {invalid && (
            <p role="alert" onMouseDown={(event) => event.preventDefault()} className="px-2 py-1.5 text-xs text-destructive">
              {t("tags.nameInvalid")}
            </p>
          )}
          <ul role="listbox" aria-label={t("tags.label")}>
            {groups.map((group) => (
              <li key={group.key} role="presentation">
                <p role="presentation" onMouseDown={(event) => event.preventDefault()} className="px-2 pb-0.5 pt-1.5 text-xs text-muted-foreground">
                  {group.label}
                </p>
                <ul role="presentation">
                  {group.items.map(({ option, index }) => (
                    <li
                      key={option.kind === "existing" ? option.tag.id : `${option.kind}:${option.name}`}
                      id={optionId(index)}
                      role="option"
                      aria-selected={index === activeIndex}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => void submit(optionName(option))}
                      onMouseMove={() => setActive(index)}
                      className={cn(
                        "flex min-w-0 cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm",
                        index === activeIndex && "bg-accent text-accent-foreground",
                      )}
                    >
                      {option.kind === "existing" && <TagDot color={option.tag.color} />}
                      <span className="truncate">
                        {option.kind === "create" ? t("tags.create", { name: option.name }) : optionName(option)}
                      </span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
