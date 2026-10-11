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
 * 為什麼要 `.refine(noNul)`、以及 `.refine` 為什麼排在 `.min(1)` 之後，見本檔下方
 * `createBodySchema` 的註解；守衛是 `notes.test.ts` 的 POST 空 title／含 NUL title 兩案。 */
export const TITLE = z.string().min(1).refine(noNul);

/** #108：MCP 工具收進來的 `note_id`（不變量 S／M9 的格式 guard ＋ NUL 兩關）。REST 側的
 * 同一道關是路由裡的 `UUID_RE.test(id)`（路徑參數不走 zod），兩者共用同一個 regex；REST 的轉小寫在 app 層
 * `lowercaseUuidParams`（`http/uuid-params.ts`）。
 * `.refine(noNul)` 今天完全被 `UUID_RE` 蓋住，理由與 `SEC`／`FP` 那兩道相同（見上）。
 * ⚠ 這裡**不**兼作授權：格式關只是不讓垃圾進到 pg 的 uuid 欄位（`22P02` 會變成 500），
 * 「這篇筆記你看不看得到」一律由呼叫端的 `resolveRole` 決定。
 * ⚠ 這道 `.regex()` 是**第二層**：`resolveRole` 內部也有同一個 guard，所以拿掉它行為只從
 * 「輸入驗證錯誤」退化成 `not_found`（突變實測過）。守衛＝`mcp-content.test.ts` 的
 * 「不合格式的 section_id／note_id …」那一案後半。
 * #240：`.transform` 轉小寫——**wire 上 MCP `note_id` 的收斂點**（只有 MCP 工具用這個 schema；SDK 把 parse 後的值交給
 * handler）。live doc、presence、寫入佇列、版本狀態都以小寫字串為鍵，大寫 id 會打到另一份。handler 內殘留的
 * `toLowerCase()`（`read-note-image.ts:61`、`move-note-to-group.ts` 的 moved 分支重讀）是防禦，不是保證。
 * 守衛＝`mcp-write-schemas.test.ts` U-240a、`unit/mcp-register.test.ts` U-F1 ②、`mcp-content`／`mcp-edit-note` 的 L1a／L1b／L2／L3。 */
export const NOTE_ID = z.string().regex(UUID_RE).refine(noNul).transform(s => s.toLowerCase());

/** #175 PR5：`groupId` 的格式 guard——REST `POST /api/notes` 的 `createBodySchema` 與 MCP `create_note`
 * 吃**同一個物件**（D18／M14：寫入側不發明第二套契約）。**不含 `.optional()`**（呼叫端的事）。
 * 原本是 `createBodySchema` 的行內 `z.string().uuid()`，具名化時一個字都沒改——**不加
 * `.refine(noNul)`**：uuid 格式本身就排除了 NUL（含 NUL 的字串一律 `Invalid uuid`，zod 3.25.76 實測），
 * 加了是冗餘，只會讓 issues 陣列多一條（REST 只回 `issues[0]`，訊息不變）。
 * ⚠ 這裡只擋格式（大小寫皆收）；成員資格與新建旗標由 `notes/create-target.ts` 的 `loadCreateTarget` 決定。 */
export const GROUP_ID = z.string().uuid();

// 建立時 title 允許省略（DB 端有 default "Untitled"），但若有帶就不可為空字串——
// 與 PATCH 的 title 驗證同一套規則，避免「傳空字串把標題清空」這種語意混淆的落地方式。
// ⚠ 行為變更（對既有呼叫端）：#106 把這個 schema 從 z.object 的預設 strip 改成 `.strict()`，
// 所以「多帶未知欄位」從**靜默忽略**變成 400 invalid_body。刻意的：`content` 一旦上線，
// 打錯成 `contents`／`body` 的請求靜默建出一篇空筆記，比直接回 400 難除錯得多；也與兩條
// 新路由（不變量 S 要求 `.strict()`）一致。已寫進 docs/api.md 與 CHANGELOG 的 Changed。
// ⚠ `title` 也補上 `.refine(noNul)`：這是**既有的洞**，不是新開的——今天 `title` 只有 `.min(1)`，
// 含 U+0000 的標題會一路寫進 pg 的 text 欄位，pg 直接拒收（`22021`），錯誤逃到全域
// errorHandler → 500。既然正在改這一行就順手拉進不變量 S（行為只從 500 變成正常的 400）。
// `PATCH /api/notes/:id` 的 `updateBodySchema.title` 原本有同一個洞，#180 W16 改成 `TITLE.optional()`（搬到本檔檔尾）。
// `.refine` 排在 `.min(1)` 之後（ZodEffects 上沒有 `.min`）。
// #103 §6.4：`groupId` 建在群組裡；#175 Q13：與 `content` 可以並存（帶內容建在群組裡）。
export const createBodySchema = z
  .object({ title: TITLE.optional(), content: MD.optional(), groupId: GROUP_ID.optional() })
  .strict();

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

// PATCH 契約（spec §11.4 逐字）：title／slug 皆選配，但至少要帶一項——兩者都缺時走
// safeParse 失敗路徑，回 400 invalid_body（與其他 body schema 一致，不特地為「空
// payload」開一條不同的錯誤碼）。`slug` 允許顯式 `null`（清除既有自訂網址代稱）與
// 字串（新設定，routes 內再走 `prepareSlugForPatch` 正規化+驗證）——`undefined`
// （鍵不存在）代表「這次 PATCH 不動 slug」，三態語意靠 zod 的 `nullable().optional()`
// 表達，不能只用 `nullable()`（那樣呼叫端必須每次都明確傳 `slug: null` 才能不改動）。
// 未知欄位一律被 z.object 預設的 strip 行為丟棄（不需要額外 `.strict()`/`.passthrough()`）。
// #180 W16：`title` 改吃 `TITLE`（含 NUL 守衛）——PATCH、`POST /api/notes`、`create_note`、`edit_note` 的 rename 四條改標題的路
// 吃同一個物件。export 內層 `updateBodyObject` 是為了 `mcp-write-schemas.test.ts` 的同源斷言（外層 `.refine` 是 ZodEffects，沒有 `.shape`）。
export const updateBodyObject = z.object({
  title: TITLE.optional(),
  slug: z.string().nullable().optional(),
});
export const updateBodySchema = updateBodyObject.refine(b => b.title !== undefined || b.slug !== undefined, {
  message: "title 與 slug 至少需帶一項",
});
