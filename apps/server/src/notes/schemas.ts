// #108：請求字串 schema 的**單一真相**（不變量 S 的第一、二關：格式 guard → NUL 拒絕）。
// 這些原本是 `routes/notes.ts` 的模組私有 const；MCP 工具要逐字重用同一份（M14），而
// route → route 相依會讓兩個路由模組互相牽動，所以收在這個葉節點模組（同 `http/errors.ts`）。
// ⚠ `MD` 的 `.max(262_144)` 與 `POST /api/notes/:id/edits` 的 `bodyLimit` 是同一個數字但
// **不同單位**（UTF-16 code unit vs byte），兩道都要，不可互相取代。
// **任何新的呼叫端一律 import 這裡，不得另建一份。**
// ⚠ 誠實記下：`NOTE_ID` 要用 `UUID_RE`，而它住在 `notes/service.ts`（那個模組會碰
// `db/schema`），所以本檔**不再是純葉節點**——它相依到 domain 層，只是仍然不相依任何路由。
// 沒把 `UUID_RE` 搬過來是刻意的：它有八個既有 import 端（實查），搬動超出 #108 的觸及面。
import { z } from "zod";
import { SECTION_ID_RE } from "@knotebook/shared";
import { UUID_RE } from "./service.js";

export const NUL = String.fromCharCode(0);
export const noNul = (s: string) => !s.includes(NUL);
// （`.refine` 必須排在 `.regex` 之後：它回的是 ZodEffects，其上已無 `.regex`。）

// #106 不變量 S（寫入端）：三個字串欄位在進任何比較之前先在 schema 層擋 NUL（U+0000）並要求格式。
// ⚠ **`.refine()` 一律最後**——同上面那條規則（它回 ZodEffects，其上沒有
// `.regex`／`.max`，寫反了 import 這個模組就 TypeError，整台 server 起不來）。
// ⚠ `SEC` 的 `.refine(noNul)` 今天完全被 `SECTION_ID_RE` 蓋住、`FP` 的被 `/^[0-9a-f]{16}$/` 蓋住
// （NUL 本來就過不了那兩個字元集），**沒有、也做不出會因為刪掉它而變紅的測試**——它們是刻意
// 留的第二道，讓「NUL 一律 400」在字元集日後被放寬時仍成立。`MD` 的那道則是真的守著
// （`note-edits.test.ts` 的 `markdown: "x" + NUL` 那個 case 只靠它）。
export const MD = z.string().max(262_144).refine(noNul);
export const FP = z.string().regex(/^[0-9a-f]{16}$/).refine(noNul);
export const SEC = z.string().max(64).regex(SECTION_ID_RE).refine(noNul);

/** #108：原本是 `routes/notes.ts` 的行內字面量（`createBodySchema` 的 `title`），具名化供
 * MCP 的 `create_note` 逐字重用（M14／M9）。**不含 `.optional()`**——那是呼叫端的事。
 * 為什麼要 `.refine(noNul)`、以及 `.refine` 為什麼排在 `.min(1)` 之後，見 `routes/notes.ts`
 * 的 `createBodySchema` 註解；守衛是 `notes.test.ts` 的 POST 空 title／含 NUL title 兩案。 */
export const TITLE = z.string().min(1).refine(noNul);

/** #108：MCP 工具收進來的 `note_id`（不變量 S／M9 的格式 guard ＋ NUL 兩關）。REST 側的
 * 同一道關是路由裡的 `UUID_RE.test(id)`（路徑參數不走 zod），兩者共用同一個 regex。
 * `.refine(noNul)` 今天完全被 `UUID_RE` 蓋住，理由與 `SEC`／`FP` 那兩道相同（見上）。
 * ⚠ 這裡**不**兼作授權：格式關只是不讓垃圾進到 pg 的 uuid 欄位（`22P02` 會變成 500），
 * 「這篇筆記你看不看得到」一律由呼叫端的 `resolveRole` 決定。
 * ⚠ 這道 `.regex()` 是**第二層**：`resolveRole` 內部也有同一個 guard，所以拿掉它行為只從
 * 「輸入驗證錯誤」退化成 `not_found`（突變實測過）。守衛＝`mcp-content.test.ts` 的
 * 「不合格式的 section_id／note_id …」那一案後半。 */
export const NOTE_ID = z.string().regex(UUID_RE).refine(noNul);

// `POST /api/notes/:id/edits` 的 body（spec §5）：`op` 決定其餘欄位，逐格 `.strict()`。
// `append` 的 `if_match` 是選配（spec M-7：不帶就跳過核對）；其餘四個 op 皆必填。
//
// #108 D-N：從 `routes/notes.ts` **逐字**搬過來的（一個字都沒改），因為 MCP 的 `edit_note`
// 也吃這一份——**per-op 必填矩陣只能有一份實作**（raw shape 表達不了「哪個 op 要哪些欄位」，
// 而規格 §8.6 逐字要求「同必填矩陣」）。
// ⚠ MCP 側呼叫它時**必須逐鍵條件展開**再餵進來：`.strict()` 看的是 `Object.keys`，
//   `{op:"append", section_id: undefined}` 會被判 `unrecognized_keys`（實測），
//   `delete_section` ＋ `markdown: undefined` 同一顆雷。守衛＝`mcp-edit-note.test.ts` 的 S4 兩發。
export const editBodySchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("replace_all"), markdown: MD, if_match: FP }).strict(),
  z.object({ op: z.literal("replace_section"), section_id: SEC, markdown: MD, if_match: FP }).strict(),
  z.object({ op: z.literal("insert_after"), section_id: SEC, markdown: MD, if_match: FP }).strict(),
  z.object({ op: z.literal("append"), markdown: MD, if_match: FP.optional() }).strict(),
  z.object({ op: z.literal("delete_section"), section_id: SEC, if_match: FP }).strict(),
]);
