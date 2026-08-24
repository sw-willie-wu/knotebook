import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { canEdit, isTerminal, type CollabState } from "@/collab/connection";
import { cn } from "@/lib/utils";

/**
 * 進入「非 connected 且非終態」相位多久之後，badge 才升級成離線警示（ms，issue #48）。
 *
 * 為什麼要等：開一篇筆記的頭零點幾秒、以及正常的短暫重連，本來就會經過 connecting／
 * reconnecting-once。若一進這些相位就閃警示，每次開筆記都會看到雜訊。3 秒足以濾掉那些
 * 一閃即逝的過場，又不會拖太久才告訴使用者「你正在離線編輯」。
 */
export const OFFLINE_WARN_MS = 3_000;

/** 已連線／終態的固定樣式（終態導頁前的那一瞬間不會空白）。離線警示另算，見下。 */
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
 * issue #48：非 connected 相位**持續超過 `OFFLINE_WARN_MS`** 之後，phase 徽章升級成
 * 警示色，文案依 `synced` 分兩種——
 *   - 從未同步過（`synced` 為 false）：這篇筆記還沒載入伺服器內容、目前唯讀（editable 由
 *     `NotePage` 一併擋掉），文案是「尚未載入」；
 *   - 曾同步、後來斷線（`synced` 為 true）：仍可編輯，但打的字只在本機、還沒同步回去，
 *     文案是「離線編輯中」。
 * 短暫的過場（開頁的頭幾秒、幾百毫秒的重連）不升級——見 `OFFLINE_WARN_MS`。
 *
 * `role="status"` + `aria-live="polite"`：撤權／降級／離線這些狀態改變不是使用者主動
 * 觸發的，螢幕閱讀器需要被動得知，但不該打斷當下的朗讀（故 polite 而非 assertive）。
 */
export function ConnectionBadge({ state, synced = true }: { state: CollabState; synced?: boolean }) {
  const { t } = useTranslation();

  // 「非 connected 且非終態」已經持續超過門檻。用 timer 而非「進相位的時刻」相減，才能
  // 在跨過門檻的當下觸發一次 re-render（否則畫面要等下一次不相關的 render 才升級）。
  const [offlineSustained, setOfflineSustained] = useState(false);
  const offlinePhase = state.phase !== "connected" && !isTerminal(state);
  // 用 ref 讀最新值，讓 effect 的 deps 只有 offlinePhase——避免 setOfflineSustained 造成的
  // re-render 把 effect 重跑、timer 一直被清掉重設而永遠觸發不了。
  const sustainedRef = useRef(offlineSustained);
  sustainedRef.current = offlineSustained;

  useEffect(() => {
    if (!offlinePhase) {
      if (sustainedRef.current) setOfflineSustained(false);
      return;
    }
    if (sustainedRef.current) return; // 已經升級了，不必再排 timer
    const timer = setTimeout(() => setOfflineSustained(true), OFFLINE_WARN_MS);
    return () => clearTimeout(timer);
  }, [offlinePhase]);

  const showOffline = offlinePhase && offlineSustained;
  const phase =
    showOffline
      ? {
          key: synced ? "note.connection.offlineEditing" : "note.connection.offlineUnsynced",
          className: "border-destructive text-destructive",
        }
      : PHASE_STYLES[state.phase];

  const role = state.phase === "connected" ? state.role : null;

  return (
    <div role="status" aria-live="polite" className="flex shrink-0 items-center gap-2 text-xs">
      <span className={cn("rounded-full border px-2 py-0.5", phase.className)}>{t(phase.key)}</span>
      {role && role !== "none" && (
        <span className="rounded-full border border-border px-2 py-0.5 text-muted-foreground">{t(`roles.${role}`)}</span>
      )}
      {role && !canEdit(role) && (
        <span className="rounded-full border border-border px-2 py-0.5 text-muted-foreground">{t("note.readOnly")}</span>
      )}
    </div>
  );
}
