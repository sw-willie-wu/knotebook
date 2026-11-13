import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Plus, Search } from "@/components/ui/icons";
import { isKeyboardOpen, useKeyboardInset } from "@/lib/visual-viewport";
import { cn } from "@/lib/utils";
import { PHONE_BAR_FRAME, phoneBarBottomPadding } from "./phone-bar";

interface PhoneListBarProps {
  query: string;
  onQueryChange: (query: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  /** 全螢幕搜尋層開著：右側的「New note」換成「Cancel」。 */
  active: boolean;
  /** 搜尋框取得焦點：開搜尋層。失焦不關（點結果、收鍵盤都會失焦）。 */
  onOpen: () => void;
  /** Cancel 或 Esc：關搜尋層（字已清空）。 */
  onClose: () => void;
  /** 垃圾桶 tab 不建筆記，只留搜尋框。 */
  showNewNote: boolean;
  onCreateNote: () => void;
  newNotePending: boolean;
}

/**
 * 手機清單畫面的底部列：左邊搜尋框、右邊「New note」（搜尋中換成「Cancel」）。
 * 列高 56（內距 6＋控制項 44＋6）加底部 safe area；搜尋框 16px 字級，iOS 才不會聚焦就放大。
 * 螢幕鍵盤開著時列仍在文件流裡，只加 `marginBottom`（視覺視窗的高度差）把它頂到鍵盤正上方，上面的結果區跟著縮短；
 * 只留搜尋框，按鈕收起。離開搜尋：收起鍵盤後視覺視窗變高、Cancel 回來，按 Cancel；外接鍵盤可按 Esc。
 * 鍵盤蓋住了底部 safe area，所以這時不留那段內距。
 */
export function PhoneListBar({ query, onQueryChange, searchRef, active, onOpen, onClose, showNewNote, onCreateNote, newNotePending }: PhoneListBarProps) {
  const { t } = useTranslation();
  const inset = useKeyboardInset();
  const keyboardOpen = isKeyboardOpen(inset);
  return (
    <div
      data-phone-list-bar=""
      style={keyboardOpen ? { marginBottom: inset } : undefined}
      className={cn("flex items-center gap-2", PHONE_BAR_FRAME, phoneBarBottomPadding(keyboardOpen))}
    >
      <div className="relative min-w-0 flex-1">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={searchRef}
          type="text"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          onFocus={onOpen}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            onQueryChange("");
            event.currentTarget.blur();
            onClose();
          }}
          aria-label={t("sidebar.searchLabel")}
          placeholder={t("sidebar.searchPlaceholder")}
          className="h-11 pl-9 text-base"
        />
      </div>
      {keyboardOpen ? null : active ? (
        <Button
          type="button"
          variant="ghost"
          className="h-11 shrink-0 px-3"
          onClick={() => {
            onQueryChange("");
            searchRef.current?.blur();
            onClose();
          }}
        >
          {t("home.cancel")}
        </Button>
      ) : (
        showNewNote && (
          <Button type="button" variant="brand" className="h-11 shrink-0" onClick={onCreateNote} disabled={newNotePending}>
            <Plus aria-hidden="true" className="h-4 w-4" />
            {t("home.newNote")}
          </Button>
        )
      )}
    </div>
  );
}
