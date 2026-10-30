import {
  useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent, type Ref,
  type SyntheticEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { autoUpdate, flip, offset, size, useFloating } from "@floating-ui/react";
import { normalizeEmail, type UserSuggestionDto } from "@knotebook/shared";
import { isSuggestQuery, useUserSuggestions } from "@/api/users";
import { Input } from "@/components/ui/input";
import { otherTokens, replaceToken, tokenAt } from "@/lib/email-list";
import { cn } from "@/lib/utils";

/** 打字停多久才查（ms）。 */
export const SUGGEST_DEBOUNCE_MS = 200;

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export interface UserEmailComboboxProps {
  value: string;
  onChange: (email: string) => void;
  /** 可及名稱；沒給 `placeholder` 時兼 placeholder。 */
  label: string;
  placeholder?: string;
  /** 已在名單上的人（成員、已分享對象）不再出現在建議裡。 */
  excludeUserIds?: ReadonlyArray<string>;
  /**
   * 收多個地址（群組加成員，#331 批次加入）：`type="text"`（`type="email"` 的原生驗證會擋下多個地址）、
   * 只拿游標所在的那一個地址去查、選取只換掉那一個；框裡已經打過的地址不再建議。分隔規則與 `parseEmailList` 同一份
   * （`lib/email-list.ts`）。沒開＝單一地址（分享對話框）：`type="email"`，選取填入整格。
   */
  multiple?: boolean;
  /** 唯讀時（批次加入跑的期間）不開清單、不能選取。 */
  readOnly?: boolean;
  onPaste?: (event: ClipboardEvent<HTMLInputElement>) => void;
  "aria-describedby"?: string;
  /** 指向內部的 `<input>`（例如對話框關掉後把焦點還回來）。 */
  ref?: Ref<HTMLInputElement>;
  className?: string;
}

/**
 * 加成員／分享對話框共用的 email 輸入框＋「認識的人」建議（`GET /api/users/suggest`，只含同群組成員與自己分享過的對象，
 * 不是全站名錄）。WAI-ARIA combobox（list autocomplete）：輸入框 `role="combobox"`、清單 `role="listbox"`，鍵盤 ↑／↓ 移動、
 * Enter 選取、Esc 收起；`aria-activedescendant` 指向目前那一項，焦點始終留在輸入框。
 *
 * 選取只是把 email 填進輸入框，不代為送出（角色下拉還要選）。沒有選中項目時 Enter 照常送出外層表單——打完整 email
 * 一樣能加，建議清單只是輔助。≥ 2 字、停 200 ms 才查；查詢失敗就當作沒有建議。
 * `multiple` 時查的、換的都只是游標所在的那一個地址，選完補上 `, `、游標放在後面，可以接著打下一個。
 *
 * 清單用 floating-ui 定位但**不 portal**：留在對話框的 DOM 裡，點選項不算 Radix Dialog 的「點外面」。
 * 高度 32px 的輸入框沿用 `ui/input`（`ui/button.tsx` 的同列等高規範）。
 */
export function UserEmailCombobox({
  value, onChange, label, placeholder, excludeUserIds, multiple = false, readOnly = false, onPaste,
  "aria-describedby": describedBy, ref, className,
}: UserEmailComboboxProps) {
  const { t } = useTranslation();
  const listId = useId();
  const optionId = (index: number) => `${listId}-opt-${index}`;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const setInputRef = useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );
  // open：使用者打過字之後才為真；選取、Esc、失焦、送出、變唯讀都收起。
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  // multiple：游標位置（打字、移動游標時更新），用來找游標所在的那一個地址；選取後要把游標放到補上的 `, ` 後面
  const [caret, setCaret] = useState(0);
  const pendingCaretRef = useRef<number | null>(null);
  if (readOnly && open) {
    setOpen(false);
    setActive(-1);
  }

  const span = multiple ? tokenAt(value, caret) : null;
  const liveQuery = span ? span.token : value.trim();
  const query = useDebounced(liveQuery, SUGGEST_DEBOUNCE_MS);
  const suggestions = useUserSuggestions(query, open);

  const exclude = new Set(excludeUserIds ?? []);
  const typed = span ? new Set(otherTokens(value, span.start, span.end).map(normalizeEmail)) : null;
  const items: UserSuggestionDto[] =
    open && isSuggestQuery(query) && isSuggestQuery(liveQuery)
      ? (suggestions.data ?? []).filter((u) => !exclude.has(u.userId) && !typed?.has(normalizeEmail(u.email)))
      : [];
  const expanded = items.length > 0;
  const activeIndex = active < items.length ? active : -1;

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
        apply({ rects, availableHeight, elements }) {
          elements.floating.style.minWidth = `${rects.reference.width}px`;
          elements.floating.style.maxHeight = `${Math.max(120, Math.min(280, availableHeight))}px`;
        },
      }),
    ],
  });

  // Esc 要先收起清單、不關掉外層 Radix Dialog：Radix 在 document 的 capture 階段聽 Escape，
  // 所以這裡在更早的 window capture 攔下（只在清單開著、且事件來自這個輸入框時）。
  useEffect(() => {
    if (!expanded) return;
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.key !== "Escape" || event.target !== inputRef.current) return;
      event.stopPropagation();
      event.preventDefault();
      setOpen(false);
      setActive(-1);
    }
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [expanded]);

  // 選取後的新值由外層 state 寫回來，寫回之後才放游標
  useLayoutEffect(() => {
    const next = pendingCaretRef.current;
    const input = inputRef.current;
    if (next === null || !input || input.value !== value) return;
    pendingCaretRef.current = null;
    input.setSelectionRange(next, next);
  }, [value]);

  function pick(user: UserSuggestionDto): void {
    if (readOnly) return;
    if (span) {
      const replaced = replaceToken(value, span.start, span.end, user.email);
      setCaret(replaced.caret);
      if (replaced.text === value) {
        // 值沒變（選的就是已經打完整的那個、後面也已有分隔）：外層不會重繪，直接放游標
        inputRef.current?.setSelectionRange(replaced.caret, replaced.caret);
      } else {
        pendingCaretRef.current = replaced.caret;
        onChange(replaced.text);
      }
    } else {
      onChange(user.email);
    }
    setOpen(false);
    setActive(-1);
    inputRef.current?.focus();
  }

  /** multiple：游標移到另一個地址時，清單（還是舊地址的建議）收起——不然選了會換掉游標所在的那個。 */
  function handleSelect(event: SyntheticEvent<HTMLInputElement>): void {
    const input = event.currentTarget;
    const next = input.selectionStart ?? input.value.length;
    if (tokenAt(input.value, next).start !== tokenAt(input.value, caret).start) {
      setOpen(false);
      setActive(-1);
    }
    setCaret(next);
  }

  /** #331 的貼上（換行改逗號）在外層直接改值、不經過 onChange：清單也要收起。 */
  function handlePaste(event: ClipboardEvent<HTMLInputElement>): void {
    onPaste?.(event);
    if (event.defaultPrevented) {
      setOpen(false);
      setActive(-1);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>): void {
    // 輸入法選字中的 ↑／↓／Enter 是給輸入法的（同 FilePanel、SelectionAiBox）
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      if (!open) {
        if (!readOnly) setOpen(true);
        return;
      }
      if (!expanded) return;
      event.preventDefault();
      setActive((i) => (i + 1 >= items.length ? 0 : i + 1));
    } else if (event.key === "ArrowUp") {
      if (!expanded) return;
      event.preventDefault();
      setActive((i) => (i <= 0 ? items.length - 1 : i - 1));
    } else if (event.key === "Enter") {
      if (expanded && activeIndex >= 0) {
        // 選取，不送出表單
        event.preventDefault();
        pick(items[activeIndex]!);
      } else {
        setOpen(false);
        setActive(-1);
      }
    }
  }

  return (
    <div ref={refs.setReference} className={cn("relative", className)}>
      <Input
        ref={setInputRef}
        type={multiple ? "text" : "email"}
        inputMode={multiple ? "email" : undefined}
        required
        readOnly={readOnly}
        autoComplete="off"
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={expanded}
        aria-controls={expanded ? listId : undefined}
        aria-activedescendant={expanded && activeIndex >= 0 ? optionId(activeIndex) : undefined}
        aria-describedby={describedBy}
        placeholder={placeholder ?? label}
        aria-label={label}
        value={value}
        onChange={(event) => {
          // 使用者自己改了值：上一次選取留下、還沒放的游標位置作廢
          pendingCaretRef.current = null;
          onChange(event.target.value);
          if (multiple) setCaret(event.target.selectionStart ?? event.target.value.length);
          setOpen(true);
          setActive(-1);
        }}
        // 只換游標所在的地址：游標移到別的地址（方向鍵、點一下）時收起清單、跟著換查詢
        onSelect={multiple ? handleSelect : undefined}
        onPaste={handlePaste}
        onKeyDown={handleKeyDown}
        onBlur={() => {
          setOpen(false);
          setActive(-1);
        }}
      />
      {expanded && (
        <ul
          ref={refs.setFloating}
          id={listId}
          role="listbox"
          aria-label={t("userSuggest.listLabel")}
          style={floatingStyles}
          className="z-50 overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {items.map((user, index) => (
            <li
              key={user.userId}
              id={optionId(index)}
              role="option"
              aria-selected={index === activeIndex}
              // mousedown 預設會讓輸入框失焦（→ 收起清單、click 落空）：擋掉，焦點留在輸入框。
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(user)}
              onMouseMove={() => setActive(index)}
              className={cn(
                "flex min-w-0 cursor-pointer flex-col rounded-sm px-2 py-1.5 text-sm",
                index === activeIndex && "bg-accent text-accent-foreground",
              )}
            >
              <span className="truncate font-medium">{user.displayName}</span>
              <span className="truncate text-xs text-muted-foreground">{user.email}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
