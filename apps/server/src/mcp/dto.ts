/**
 * #108 §8.2：回給模型的筆記摘要。
 *
 * `NoteSummary` 是 REST `NoteDto` 的**子集加 `url`**——刻意不含 `ownerId`／`createdAt`／
 * `slugIsCustom`／`prevSlug`（模型用不到，只佔脈絡）。**REST 的 `NoteDto` 一個字都不改**：
 * 它是已發佈的對外契約（`note-content.test.ts` 逐欄釘住），截斷只發生在 MCP 這一側。
 * ⚠ #175 起有一欄**不是**子集：REST 的 `ownerHandle`／`groupId`／`group` 在這裡收成一個 `owner`
 * （帶種類的物件，見 {@link NoteOwnerForModel}）。
 *
 * `url` 走 `canonicalNotePath`——與 `create_note`（PR2）同一個組字點。組字規則只能有一個
 * 實作：模型自己拼網址拼錯了就是給使用者一條打不開的連結，而且不報錯。
 */
import { z } from "zod";
import { canonicalNotePath } from "@knotebook/shared";
import { MCP_TEXT_MAX, truncateText } from "./limits.js";

/**
 * #175 §9.1：誰的筆記。個人筆記＝那個人的 handle；群組筆記＝那個群組（沒有個人 owner——nullable 的 `ownerHandle` 對模型
 * 是「這篇沒主人？」的誤導，所以換成帶種類的物件；`owner` 比 `ownerHandle` 短 6 字元——`instructions` 另因可見性句改寫再省 1，
 * 合計寬 7，量測見 `server-info.ts` 的註解）。
 *
 * #177：群組 `name` 與 `title` 同一套截斷（{@link truncateText}，按 JSON 逃脫後計）。DB 上限是 80 code point，
 * 一般名稱永遠截不到；只有塞滿需要逃脫的字元（C0 一個算 6）才會被截，此時多帶 `nameTruncated: true`——
 * 旗標語意與 `titleTruncated` 相同（只在真的被截時才有這把 key）。
 */
export type NoteOwnerForModel =
  | { kind: "user"; handle: string }
  | { kind: "group"; id: string; name: string; nameTruncated?: true };

export const noteOwnerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), handle: z.string() }),
  z.object({
    kind: z.literal("group"),
    id: z.string(),
    name: z.string().max(MCP_TEXT_MAX),
    nameTruncated: z.literal(true).optional(),
  }),
]);

/** 群組欄優先（群組筆記的 `ownerHandle` 恆 null，XOR）。兩者皆空不可能（DB `notes_owner_xor_group_chk`）——throw，不猜。 */
export function ownerForModel(row: { ownerHandle: string | null; groupId: string | null; groupName: string | null }): NoteOwnerForModel {
  if (row.groupId !== null) {
    const name = truncateText(row.groupName ?? "");
    return { kind: "group", id: row.groupId, name: name.text, ...(name.truncated ? { nameTruncated: true as const } : {}) };
  }
  if (row.ownerHandle !== null) return { kind: "user", handle: row.ownerHandle };
  throw new Error("ownerForModel：ownerHandle 與 groupId 皆為 null");
}

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
  owner: NoteOwnerForModel;
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
  owner: noteOwnerSchema,
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
  /** 群組筆記恆 null（沒有個人 owner，#175）。 */
  ownerHandle: string | null;
  groupId: string | null;
  groupName: string | null;
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
    owner: ownerForModel(row),
    slug: row.slug,
    url: canonicalNotePath({ ownerHandle: row.ownerHandle, groupId: row.groupId, slug: row.slug }),
    role,
    updatedAt: row.updatedAt.toISOString(),
    // 四欄同進同出，與 REST 的 `toNoteDto` 同一形：`last_edited_at` 是 null 就整個為 null；
    // 編輯者帳號被刪（FK `set null`）時 handle 落空 → 空字串。
    lastEdited: row.lastEditedAt
      ? { at: row.lastEditedAt.toISOString(), byHandle: row.editorHandle ?? "", agentLabel: row.lastEditedAgentLabel }
      : null,
  };
}
