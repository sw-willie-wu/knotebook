import { useVersionList, type VersionTarget } from "@/api/versions";
import { useVersions } from "@/lib/versions-context";
import { versionLabel } from "./version-labels";

/**
 * 預覽／比較對象的標籤「名稱 (短 id)」（#272 §10.3；Review Focus RF1）：清單裡還有這一版就用清單那一列（改名之後立刻反映），
 * 清單沒有（被「僅手動」篩掉、或在還沒載入的那一頁）才用選取時記下的 `target.name`。
 * 與面板、比較下拉共用同一份清單快取（同一個 query key），不多打請求。
 */
export function useTargetLabel(target: VersionTarget | null): string {
  const { noteId, kindFilter } = useVersions();
  const list = useVersionList(noteId ?? "", target !== null, kindFilter);
  if (target === null) return "";
  const row = list.data?.pages.flatMap((p) => p.versions).find((r) => r.id === target.id);
  return versionLabel(row ?? target);
}
