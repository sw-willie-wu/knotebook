import { useEffect, useMemo } from "react";
import type { AiPreview } from "@/ai/preview";
import { DiffEditor } from "@/components/versions/VersionPreview";
import { diffBlocks, renderDiff } from "@/lib/version-diff";

/**
 * 框選 AI 框的預覽區（#263 spec §5.4）：`DiffEditor` 單欄渲染 `renderDiff(diffBlocks(before, after))`（只含被改的區塊）。
 *
 * ⚠ **只准經 `VersionsLazy` 延遲載入**（`lazy(() => import("@/components/versions/VersionsLazy"))`，掛載點包 `VersionsLazyBoundary`）：
 * 本檔把 `DiffEditor` 與 `@/lib/version-diff`（及 `diff` 套件）拉進來，被靜態 import 時 Rollup 會把它們搬進呼叫端 chunk——
 * `scripts/check-bundle-size.mjs` 的 `u{2DE}-`（diff 套件字面）marker 會紅（build 後 `node scripts/check-bundle-size.mjs`）。
 *
 * 就緒訊號（§5.4）：掛載完成後 `onReady(preview)`（帶回它渲染的那份物件）；cleanup 呼叫 `onReady(null)`。boundary 進錯誤態
 * （本元件卸載）或 preview 換新（父層以 key 重掛，React 保證舊 cleanup 先於新 effect）都會把父層的 `readyFor` 正確更新。
 */
export function SelectionAiPreview({ preview, onReady }: { preview: AiPreview; onReady: (ready: AiPreview | null) => void }) {
  // `DiffEditor` 以 `blocks` 身分決定要不要重建編輯器——一律記憶化。
  const rendered = useMemo(() => renderDiff(diffBlocks(preview.before, preview.after)), [preview]);
  useEffect(() => {
    onReady(preview);
    return () => onReady(null);
  }, [preview, onReady]);
  return <DiffEditor blocks={rendered.blocks} marks={rendered.marks} testId="selection-ai-preview" />;
}
