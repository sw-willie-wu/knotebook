// #108：請求字串 schema 的**單一真相**（不變量 S 的第一、二關：格式 guard → NUL 拒絕）。
// 這些原本是 `routes/notes.ts` 的模組私有 const；MCP 工具要逐字重用同一份（M14），而
// route → route 相依會讓兩個路由模組互相牽動，所以收在這個葉節點模組（同 `http/errors.ts`）。
// ⚠ `MD` 的 `.max(262_144)` 與 `POST /api/notes/:id/edits` 的 `bodyLimit` 是同一個數字但
// **不同單位**（UTF-16 code unit vs byte），兩道都要，不可互相取代。
// **任何新的呼叫端一律 import 這裡，不得另建一份。**
import { z } from "zod";
import { SECTION_ID_RE } from "@knotebook/shared";

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
