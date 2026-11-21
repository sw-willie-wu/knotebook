import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { TagSearchInput } from "./TagSearchInput";
import { isKeyboardOpen, useKeyboardInset } from "@/lib/visual-viewport";
import { cn } from "@/lib/utils";
import { PHONE_BAR_FRAME, phoneBarBottomPadding } from "./phone-bar";

interface PhoneListBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  /** Clears the text and the tag tokens; defaults to clearing the text only. */
  onClearSearch?: () => void;
  searchRef: RefObject<HTMLInputElement | null>;
  /** Called on focus. There's deliberately no close on blur: tapping a result or dismissing the keyboard both blur. */
  onOpen: () => void;
  onClose: () => void;
}

/**
 * Sticky at the window bottom. With the keyboard open, `bottom` (keyboard height, from the visual viewport difference) lifts it above the keyboard and an equal `marginBottom` lets the last results scroll above it.
 * Search field is 16px so iOS doesn't zoom on focus. The keyboard covers the bottom safe area, so that padding is dropped then.
 */
export function PhoneListBar({ query, onQueryChange, onClearSearch, searchRef, onOpen, onClose }: PhoneListBarProps) {
  const { t } = useTranslation();
  const clear = onClearSearch ?? (() => onQueryChange(""));
  const inset = useKeyboardInset();
  const keyboardOpen = isKeyboardOpen(inset);
  return (
    <div
      data-phone-list-bar=""
      style={keyboardOpen ? { bottom: inset, marginBottom: inset } : undefined}
      className={cn("flex items-center gap-2", PHONE_BAR_FRAME, phoneBarBottomPadding(keyboardOpen))}
    >
      <TagSearchInput
        query={query}
        onQueryChange={onQueryChange}
        searchRef={searchRef}
        size="phone"
        className="min-w-0 flex-1"
        onEscape={(event) => {
          clear();
          event.currentTarget.blur();
          onClose();
        }}
        inputProps={{ onFocus: onOpen, "aria-label": t("sidebar.searchLabel"), placeholder: t("sidebar.searchPlaceholder") }}
      />
      {keyboardOpen ? null : (
        <Button
          type="button"
          variant="ghost"
          className="h-11 shrink-0 px-3"
          onClick={() => {
            clear();
            searchRef.current?.blur();
            onClose();
          }}
        >
          {t("home.cancel")}
        </Button>
      )}
    </div>
  );
}
