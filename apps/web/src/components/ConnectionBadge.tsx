import { useTranslation } from "react-i18next";
import { canEdit, type CollabState } from "@/collab/connection";
import { cn } from "@/lib/utils";

/** 狀態機的 phase → i18n key + 視覺樣式。終態也給值，導頁前的那一瞬間不會空白。 */
const PHASE_STYLES: Record<CollabState["phase"], { key: string; className: string }> = {
  connecting: { key: "note.connection.connecting", className: "border-border text-muted-foreground" },
  connected: { key: "note.connection.connected", className: "border-border text-muted-foreground" },
  "reconnecting-once": { key: "note.connection.reconnecting", className: "border-border text-muted-foreground" },
  kicked: { key: "note.connection.kicked", className: "border-destructive text-destructive" },
  deleted: { key: "note.connection.deleted", className: "border-destructive text-destructive" },
};

/**
 * 編輯頁右上角的連線狀態徽章：顯示 `collabReducer` 的 phase，連上之後另外顯示
 * 目前角色；角色不可編輯（viewer／none）時再補一個「唯讀」標記——N4 降級除了
 * toast 之外，也要有一個持續存在的視覺線索。
 *
 * `role="status"` + `aria-live="polite"`：撤權／降級這些狀態改變不是使用者主動觸發的，
 * 螢幕閱讀器需要被動得知，但不該打斷當下的朗讀（故 polite 而非 assertive）。
 */
export function ConnectionBadge({ state }: { state: CollabState }) {
  const { t } = useTranslation();
  const { key, className } = PHASE_STYLES[state.phase];
  const role = state.phase === "connected" ? state.role : null;

  return (
    <div role="status" aria-live="polite" className="flex shrink-0 items-center gap-2 text-xs">
      <span className={cn("rounded-full border px-2 py-0.5", className)}>{t(key)}</span>
      {role && role !== "none" && (
        <span className="rounded-full border border-border px-2 py-0.5 text-muted-foreground">{t(`roles.${role}`)}</span>
      )}
      {role && !canEdit(role) && (
        <span className="rounded-full border border-border px-2 py-0.5 text-muted-foreground">{t("note.readOnly")}</span>
      )}
    </div>
  );
}
