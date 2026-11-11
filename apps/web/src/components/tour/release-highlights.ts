import type { StopId } from "./stops";

/**
 * 「這一版新增」登記檔：完整導覽最後一站之前插入的那一段，介紹這一版比上一版多了什麼。誰打開導覽都看到同一段。
 *
 * - 帶來新功能的 PR：站點定義加進 `stops.ts`、雙語字串加進 `i18n/tour.*.json`，再把站點 id 加進 `stops`。
 *   `version` 還是上一個已發布版本時，順手改成下一版，並拿掉上一版的 id。
 * - 發版：只改這裡——確認 `version` 等於這次的版本、刪掉不想列的；這一版沒有就清空 `stops`，這一段就不出現。
 * - 卡片標題的「vX.Y.Z 新增」取這裡的 `version`，不取 app 版本：兩次發版之間 app 版本仍是上一版，
 *   用它會把還沒發布的功能標成舊版。`release-highlights.guard.test.ts` 擋 `version` 低於 `apps/web/package.json`。
 */
export interface ReleaseHighlights {
  version: string;
  stops: readonly StopId[];
}

export const RELEASE_HIGHLIGHTS: ReleaseHighlights = { version: "0.16.0", stops: [] };
