import { toast } from "@/components/ui/toast";

/**
 * 兩個複製入口共用的絕對網址組法：`new URL(path, origin).href`。拖曳把手給未編碼的 `canonicalNotePath`、「#」給瀏覽器的
 * 百分比編碼 `location.pathname`——經同一道正規化後，非 ASCII slug 兩邊得到同一字串。
 */
export function absoluteUrl(path: string, origin: string = window.location.origin): string {
  return new URL(path, origin).href;
}

/** #269 §10.1：段落連結＝`<筆記網址>#b-<區塊id>`。 */
export function blockLinkUrl(base: string, blockId: string): string {
  return `${base}#b-${blockId}`;
}

/** §10.3：寫進剪貼簿；成功 toast「已複製段落連結」、失敗 toast 錯誤。 */
export async function copyBlockLink(url: string, t: (key: string) => string): Promise<void> {
  try {
    await navigator.clipboard.writeText(url);
    toast({ title: t("note.blockLink.copied") });
  } catch {
    toast({ title: t("note.blockLink.copyFailed"), variant: "destructive" });
  }
}
