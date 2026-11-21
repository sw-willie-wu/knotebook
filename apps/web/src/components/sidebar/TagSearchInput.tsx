import { Component, lazy, Suspense, useRef, useState, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Input } from "@/components/ui/input";
import { Search } from "@/components/ui/icons";
import { useSidebarQuery } from "@/lib/sidebar-query";
import { cn } from "@/lib/utils";
import { mayHaveHash } from "./search-tags";
import type { ComboboxAria, KeyHandler } from "./TagSearchController";

// Lazy-only entry (initial-bundle cap): tokens, the # list and their keys load the first time a token exists or a `#` is typed.
const TagSearchController = lazy(() => import("./TagSearchController"));

/** A failed chunk (offline, stale deploy) leaves the plain text search alone: no error frame, no reload, nothing that could move the icon or input. */
class QuietBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

type Size = "desktop" | "phone";

const SIZE_CLASSES: Record<Size, { pad: string; input: string; field: string; text: string; icon: string }> = {
  desktop: { pad: "pl-7 pr-11 pointer-coarse:pr-10", input: "h-8", field: "min-h-8 py-[3px]", text: "text-[13px]", icon: "left-2 h-3.5 w-3.5" },
  phone: { pad: "pl-9", input: "h-11", field: "min-h-11 py-1", text: "text-base", icon: "left-3 h-4 w-4" },
};

export interface TagSearchInputProps {
  query: string;
  onQueryChange: (query: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  size: Size;
  /** Classes of the positioned wrapper (margins, width). */
  className: string;
  /** Called for an Escape the completion list didn't use. */
  onEscape: (event: KeyboardEvent<HTMLInputElement>) => void;
  inputProps?: Omit<InputHTMLAttributes<HTMLInputElement>, "value" | "onChange" | "onKeyDown" | "className">;
  /** Absolutely positioned content on the right (clear button, shortcut badge). */
  trailing?: ReactNode;
}

/**
 * The search box. With plain text it is one input; tag tokens in front of the text and the `#` completion list come from the lazy controller.
 * The input stays one native element at the same place either way, so adding a token doesn't lose focus.
 */
export function TagSearchInput({ query, onQueryChange, searchRef, size, className, onEscape, inputProps, trailing }: TagSearchInputProps) {
  const { tagTokens } = useSidebarQuery();
  const [reference, setReference] = useState<HTMLDivElement | null>(null);
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [aria, setAria] = useState<ComboboxAria | null>(null);
  const keyRef = useRef<KeyHandler | null>(null);
  const classes = SIZE_CLASSES[size];
  const hasTokens = tagTokens.length > 0;
  const needController = hasTokens || mayHaveHash(query);

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    // keyCode 229: Safari reports keys of a finishing composition as plain keydowns with isComposing already false.
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (keyRef.current?.(event) === true) return;
    if (event.key === "Escape") onEscape(event);
  }

  return (
    <div
      ref={setReference}
      className={cn(
        "relative",
        className,
        hasTokens && cn("flex flex-wrap items-center gap-1 rounded-md border border-input bg-background shadow-sm focus-within:ring-1 focus-within:ring-ring", classes.field, classes.pad),
      )}
    >
      <Search aria-hidden="true" className={cn("pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground", classes.icon)} />
      {needController && (
        <QuietBoundary>
          <Suspense fallback={null}>
            <TagSearchController
              query={query}
              onQueryChange={onQueryChange}
              searchRef={searchRef}
              reference={reference}
              placement={size === "phone" ? "top-start" : "bottom-start"}
              focused={focused}
              caret={caret}
              onCaret={setCaret}
              keyRef={keyRef}
              onAria={setAria}
            />
          </Suspense>
        </QuietBoundary>
      )}
      <Input
        ref={searchRef}
        type="text"
        value={query}
        {...aria}
        {...inputProps}
        placeholder={hasTokens ? undefined : inputProps?.placeholder}
        onChange={(event) => {
          setCaret(event.target.selectionStart ?? event.target.value.length);
          onQueryChange(event.target.value);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
        onFocus={(event) => {
          setFocused(true);
          setCaret(event.currentTarget.selectionStart ?? 0);
          inputProps?.onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          inputProps?.onBlur?.(event);
        }}
        onKeyDown={handleKeyDown}
        className={hasTokens ? cn(classes.text, "h-6 min-w-12 flex-1 border-0 bg-transparent px-1 shadow-none focus-visible:ring-0 pointer-coarse:h-8") : cn(classes.input, classes.pad, classes.text)}
      />
      {trailing}
    </div>
  );
}
