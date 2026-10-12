import { lazy, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AiPreview } from "@/ai/preview";
import { Button } from "@/components/ui/button";
import { VersionsLazyBoundary } from "@/components/versions/VersionsLazyBoundary";
import { useAiSession, type AiSessionState } from "./AiSession";

// ⚠ 只准這樣載入（Global Constraints 16）：靜態 import 會把 DiffEditor＋diff 套件搬進 NotePage chunk。
const SelectionAiPreview = lazy(() =>
  import("@/components/versions/VersionsLazy").then((m) => ({ default: m.SelectionAiPreview })),
);

/** 框內焦點轉移的去處（#263 §5.3）。 */
export type BoxFocusTarget = "cancel" | "container" | "editor";
/** 由框提供：執行動作，若動作前焦點在框內、且動作有生效（回傳不是 false），就在轉場後把焦點放到 `target`。 */
export type RunWithFocus = (action: () => boolean | void, target: BoxFocusTarget) => void;

type DoneState = Extract<AiSessionState, { phase: "done" }>;

/** 每份 preview 物件一個穩定的數字 key：preview 換新時讓預覽子元件整個重掛（舊 cleanup 先跑 onReady(null)，再由新的 onReady）。 */
function usePreviewKey(preview: AiPreview): number {
  const keys = useRef(new WeakMap<AiPreview, number>());
  const next = useRef(0);
  let key = keys.current.get(preview);
  if (key === undefined) {
    next.current += 1;
    key = next.current;
    keys.current.set(preview, key);
  }
  return key;
}

/**
 * 框選 AI 框的預覽態（#263 spec §5.4）：noChange 提示、inline diff 預覽（lazy）、按鈕列。由 `SelectionAiBox` 在 `phase === "done"` 時渲染。
 *
 * 預覽就緒：`previewReady = readyFor === state.preview`——由子元件的 `onReady` 推導，不用 effect 重設（子效果先於父效果執行、模組已快取時
 * 旗標會被父層 effect 永久清掉）。**未就緒時套用停用**（D4：沒看到就不能套），boundary 錯誤時同樣停用、框另留捨棄。
 * `onReady` 直接傳 `setReadyFor`（穩定參照）：inline 箭頭函式會讓子層每次父層 render 都多跑一輪 cleanup／ready。
 *
 * 按鈕列：未套用 → 套用／捨棄／重試（錨點非 ok 時只剩捨棄）；已套用（direct 自動套用）→ 還原（錨點非 ok 時停用）／關閉。
 */
export function SelectionAiResult({ state, anchorOk, run }: { state: DoneState; anchorOk: boolean; run: RunWithFocus }) {
  const { t } = useTranslation();
  const session = useAiSession();
  const [readyFor, setReadyFor] = useState<AiPreview | null>(null);
  const previewReady = readyFor === state.preview;
  const previewKey = usePreviewKey(state.preview);

  return (
    <div className="flex flex-col">
      {state.preview.noChange && <p role="status" className="px-3 pt-2 text-xs text-muted-foreground">{t("ai.box.noChange")}</p>}
      <div className="kb-ai-preview">
        <VersionsLazyBoundary
          noteId={state.target.anchor.noteId}
          fallback={<p className="px-3 py-2 text-xs text-muted-foreground">{t("ai.box.loadingPreview")}</p>}
          crashMessageKey="ai.box.previewCrash"
          errorClassName="px-3 py-2"
        >
          <SelectionAiPreview key={previewKey} preview={state.preview} onReady={setReadyFor} />
        </VersionsLazyBoundary>
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-border px-3 py-2">
        {state.applied !== null ? (
          <>
            <Button type="button" variant="outline" size="sm" disabled={!anchorOk} onClick={() => run(() => session.revert(), "container")}>
              {t("ai.box.revert")}
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => run(() => session.close(), "editor")}>
              {t("ai.box.close")}
            </Button>
          </>
        ) : (
          <>
            {anchorOk && (
              <Button
                type="button"
                variant="brandDeep"
                size="sm"
                disabled={state.preview.noChange || !previewReady}
                onClick={() => run(() => session.apply(previewReady), "editor")}
              >
                {t("ai.box.apply")}
              </Button>
            )}
            <Button type="button" variant="ghost" size="sm" onClick={() => run(() => session.close(), "editor")}>
              {t("ai.box.discard")}
            </Button>
            {anchorOk && (
              <Button type="button" variant="outline" size="sm" onClick={() => run(() => session.retry(), "cancel")}>
                {t("ai.box.retry")}
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
