/**
 * #108 §8.2：回給模型的筆記摘要。
 *
 * `NoteSummary` 是 REST `NoteDto` 的**子集加 `url`**——刻意不含 `ownerId`／`createdAt`／
 * `slugIsCustom`／`prevSlug`（模型用不到，只佔脈絡）。**REST 的 `NoteDto` 一個字都不改**：
 * 它是已發佈的對外契約（`note-content.test.ts` 逐欄釘住），截斷只發生在 MCP 這一側。
 *
 * `url` 走 `canonicalNotePath`——與 `create_note`（PR2）同一個組字點。組字規則只能有一個
 * 實作：模型自己拼 `/n/<handle>/<slug>` 拼錯了就是給使用者一條打不開的連結，而且不報錯。
 */
import { z } from "zod";
import { canonicalNotePath } from "@knotebook/shared";
import { MCP_TEXT_MAX, truncateText } from "./limits.js";

export interface NoteSummaryForModel {
  id: string;
  title: string;
  /**
   * 只在真的被截斷時才有這把 key，值恆為 `true`。
   * ⚠ **誠實記下（三條突變都實跑過）**：
   * 1. 寫成 `titleTruncated: false` → **`outputSchema` 的 `z.literal(true)` 抓到**（SDK 的
   *    `validateToolOutput` 把整個結果轉成 `isError`，成功路徑的每一案都紅）。**真正的守衛
   *    是它，不是下面的 key 集合斷言**——把 schema 一起放寬成 `z.boolean()` 時，才輪到 key
   *    集合斷言接手。⚠ 這推翻了 plan P8 逐字的「案 14a 是它唯一的守衛」。
   * 2. 寫成 `titleTruncated: undefined` → **沒有任何測試會紅**：`JSON.stringify` 會把
   *    `undefined` 欄位整個丟掉，wire 上與「沒有這把 key」逐位元組相同；`outputSchema` 的
   *    `.optional()` 也收它。`exactOptionalPropertyTypes` 沒開，型別同樣擋不住。
   * 3. 因此「條件展開」這個寫法本身只是紀律（給直接呼叫 `toNoteSummary` 的探針用），
   *    在 MCP 路徑上不是被守著的事實。**誠實缺口。**
   */
  titleTruncated?: true;
  ownerHandle: string;
  slug: string;
  url: string;
  role: string;
  updatedAt: string;
  lastEdited: { at: string; byHandle: string; agentLabel: string | null } | null;
}

/** `outputSchema` 用的 zod 形；欄位順序與 {@link NoteSummaryForModel} 一致。 */
export const noteSummarySchema = z.object({
  id: z.string(),
  title: z.string().max(MCP_TEXT_MAX),
  titleTruncated: z.literal(true).optional(),
  ownerHandle: z.string(),
  slug: z.string(),
  url: z.string(),
  role: z.string(),
  updatedAt: z.string(),
  lastEdited: z
    .object({ at: z.string(), byHandle: z.string(), agentLabel: z.string().nullable() })
    .nullable(),
});

/** `visibleNoteBranches` 的一列（多取的幾欄在這裡被丟掉）。 */
export interface NoteSummaryRow {
  id: string;
  title: string;
  ownerHandle: string;
  slug: string;
  updatedAt: Date;
  lastEditedAt: Date | null;
  lastEditedAgentLabel: string | null;
  editorHandle: string | null;
}

export function toNoteSummary(row: NoteSummaryRow, role: string): NoteSummaryForModel {
  const title = truncateText(row.title);
  return {
    id: row.id,
    title: title.text,
    ...(title.truncated ? { titleTruncated: true as const } : {}),
    ownerHandle: row.ownerHandle,
    slug: row.slug,
    url: canonicalNotePath({ ownerHandle: row.ownerHandle, slug: row.slug }),
    role,
    updatedAt: row.updatedAt.toISOString(),
    // 四欄同進同出，與 REST 的 `toNoteDto` 同一形：`last_edited_at` 是 null 就整個為 null；
    // 編輯者帳號被刪（FK `set null`）時 handle 落空 → 空字串。
    lastEdited: row.lastEditedAt
      ? { at: row.lastEditedAt.toISOString(), byHandle: row.editorHandle ?? "", agentLabel: row.lastEditedAgentLabel }
      : null,
  };
}
