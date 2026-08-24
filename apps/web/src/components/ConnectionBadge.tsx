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
export function ConnectionBadge({
  state,
  synced,
  canEdit: roleCanEdit,
}: {
  state: CollabState;
  synced: boolean;
  /** 這個角色能不能編輯內容——離線相位拿不到 `role`（只在 connected 非 null），所以由呼叫
   * 端算好傳進來。決定升級文案：曾同步後斷線時，可編輯角色才顯示「離線編輯中」，viewer
   * 顯示中性的「離線」（對 viewer 說「變更尚未同步」是假話——他不能編輯、也沒有變更）。 */
  canEdit: boolean;
}) {
  const { t } = useTranslation();

  // 「還不能用」已經持續超過門檻。用 timer 而非「進相位的時刻」相減，才能在跨過門檻的
  // 當下觸發一次 re-render（否則畫面要等下一次不相關的 render 才升級）。
  //
  // ⚠ **「還不能用」＝非 connected，或 connected 但還沒 synced**（審查兩位獨立指出）：
  // `onAuthenticated` 就進 `connected`，但 `provider.synced` 要再一個 round trip；若
  // server 的 `onLoadDocument` 慢或丟錯，會永久卡在「已連線 · 擁有者」配一篇空白唯讀
  // 筆記。只看 phase 的話這一格永遠不升級——正是 #48 要消滅的形狀，只是方向反過來。
  // 併進同一顆 timer 就不會誤傷正常開頁：connecting→connected→synced 走完通常 <1s，
  // 跨不過門檻、不閃。
  const [offlineSustained, setOfflineSustained] = useState(false);
  const offlinePhase = !isTerminal(state) && (state.phase !== "connected" || !synced);
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
  // 三分支：從未同步（不管角色）→「尚未載入」；曾同步且可編輯→「離線編輯中」；曾同步但
  // 不可編輯（viewer）→ 中性「離線」。
  const offlineKey = !synced
    ? "note.connection.offlineUnsynced"
    : roleCanEdit
      ? "note.connection.offlineEditing"
      : "note.connection.offline";
  const phase = showOffline
    ? { key: offlineKey, className: "border-destructive text-destructive" }
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
