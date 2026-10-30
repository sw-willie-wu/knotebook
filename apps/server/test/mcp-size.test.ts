/**
 * #108 PR1 Task 5：回應大小的兩道門檻（規格 §14.2 案 11b／11c、不變量 M16）。
 *
 * 兩個數字是**兩件不同的事**，不要混：
 * - {@link N_LIST_MAX} 管 **`tools/list` 的脈絡成本**（所有工具的 input／output schema 全部
 *   進模型脈絡，「schema 慢慢變胖」需要有東西擋）。它是**測試門檻**，不是生產常數，所以
 *   不進 `src/`。
 * - {@link MCP_MAX_WIRE} 是 §8.1 的 `N`，管**單次 `tools/call` 的回應**。它是**哨兵不是
 *   目標值**：破了代表 `mcp/limits.ts` 那張表的某一列漏接，正確處置是回頭查那一列，
 *   **不是調大 N**。
 *
 * ⚠ 量的一律是 **wire 回應**（`res.body.length`，UTF-16 code unit），不是 payload：D11 的
 * 鏡像讓同一份 payload 在回應裡出現兩次（第二次還被 JSON 逃脫），`wire ≈ 2.1 × payload`。
 * `tools/list` 那一發還含 SDK 自產的 `"execution":{"taskSupport":"forbidden"}` 與兩份 schema
 * 各自的 `"$schema"` 行——量整個 body 才算得到真正進脈絡的成本。
 *
 * image block 是 N 的唯一豁免，由 `MCP_IMAGE_MAX_BYTES` 管——案 (vi)。
 */
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import * as Y from "yjs";
import { groups, noteSearchSections, noteStates, notes, uploads, users } from "../src/db/schema.js";
import { MCP_IMAGE_MAX_BYTES, MCP_LIST_WIRE_BUDGET, MCP_PAGE_MAX } from "../src/mcp/limits.js";
import { writeSearchIndex } from "../src/notes/search-index.js";
import { SEARCH_EXTRACTOR_VERSION } from "../src/notes/search-text.js";
import { buildCollabTestApp, type CollabTestCtx } from "./helpers.js";
import { getContent, seedContent, seedTokenForUser } from "./editing-helpers.js";
import { mcpPost, rpc } from "./mcp-helpers.js";
import { seedUpload } from "./copy-helpers.js";
import { cookieOf, seedGroup } from "./group-helpers.js";
import { seedFolderChain, setNoteFolder } from "./folder-helpers.js";
import { wireCost } from "../src/mcp/wire-budget.js";
import { markTrashed } from "./trash-helpers.js";
import type { Db } from "../src/db/index.js";
import type { FastifyInstance } from "fastify";

const PASSWORD = "correct-horse-battery";

/**
 * §8.1 的 `N`：一次 `tools/call` 的 wire 回應上限（UTF-16 code unit）。與
 * `POST /api/notes/:id/edits` 的 `bodyLimit` 同一個數字——請求進得來多大，回應就不該更大。
 */
export const MCP_MAX_WIRE = 262_144;

/**
 * `tools/list` 的 wire 回應上限（UTF-16 code unit）。
 *
 * **怎麼來的**（Task 5，2026-09-09 實測，**讀寫憑證、六支工具**——PR2 起讀寫憑證才是最壞
 * 情形，唯讀憑證只當對照）：當時實測 **15 362**（唯讀憑證四支對照組 9479，與 PR1 量到的
 * 數字相同）→ 向上取整到 1024 的倍數＝16 384 → ×1.3 ＝ 21 299.2 → 進位 **21 300**。1.3 是
 * 「schema 與 `.describe()` 正常增修」的餘地，形狀比照 `scripts/check-bundle-size.mjs` 的
 * `MAX_ENTRY_BYTES`；`edit_note`／`create_note` 兩支的 input／output schema 一起進脈絡，
 * 是這條線從 PR1 的 13 312 破線 2050 的直接原因。
 *
 * **基線：2026-10-08 實測（#93），讀寫憑證六支 wire ＝ 20 312**（#93 的 +1 360 來自 search_notes 的 output schema 多了每篇
 * matchedOn／matches 與頂層 matchesTruncated（含 `.describe()`）、description 改寫、`query` 的說明；唯讀憑證四支對照組 12 459）。
 * #93 與 #200 先合的那支依自身實測設定 N_LIST_MAX；#93 先合、20 312 未破 21 300，所以 #93 合併時門檻不動（spec §8.7 的合併順序規則）；
 * 後合的 #200 PR1 在 main 之上重量、依原配方重訂（下段）。
 *
 * **#200 PR1（2026-10-08，在 main @ 7e20a5e 之上實測，#93 PR1 已合）：讀寫憑證七支 wire ＝ 21 976**（相對 #93 基線 20 312 的
 * +1 664 來自 create_transfer_token 的 description、input／output schema，含終審把 purpose 的 `.describe()` 改成
 * 「stores … then reference it with edit_note」的 +38；唯讀憑證五支對照組 13 954）。依原配方（向上取整到
 * 1024 的倍數 ×1.3）重訂：22 528 × 1.3 ＝ 29 286.4 → 29 300。
 *
 * **#222（2026-10-08，在 main @ 0aec79b 之上實測，#200 PR1 已合）：讀寫憑證七支 wire ＝ 22 388**（+412 來自 edit_note／
 * create_note／read_note_section 的顏色敘述；唯讀憑證五支對照組 14 041）。依同一配方重推仍是 22 528 × 1.3 → 29 300，門檻不動。
 *
 * **#180＋#200 PR2（2026-10-10，整合分支，main 含 #236）：讀寫憑證十支 wire ＝ 29 437**（相對 #222 基線 22 388 的 +7 049：
 * #180 的 rename／move／copy／create_note 改鍵名 ＋5 707（spec 預估 +5 707；I-4 整合點量到 28 095）、#200 的 read_note_image 與
 * read_note_section 一句 ＋1 342（spec 預估 +1 392；唯讀憑證那邊同樣多 1 342）；唯讀憑證六支對照組 15 383）。實測比 spec §8 預期的 29 487
 * 少 50（#200 那一段預估 +1 392、實測 +1 342；#180 那一段與預估吻合）。這 −50 的原因：spec 的量測腳本給 `read_note_image` outputSchema 的 `noteId` 多掛了一句 `.describe`（+52），實碼的 `UPLOAD_ID_RE` 多一組捕獲括號（+2）；模型面字串與 spec 一致。已破 29 300，依原配方（向上取整到 1024 的倍數 ×1.3）重訂：29 696 × 1.3 ＝ 38 604.8 → 38 700。
 *
 * 之前：#177 後 18 952（2026-10-07；#177 的 +294 來自群組 `owner` 多了 `name` 的 `maxLength` 與 `nameTruncated`（四份 outputSchema 各展開一次）、heading `.describe()` 加 ` as written in JSON`（+19 × 兩支）；#175 PR5 後 18 658、#175 PR1 後 18 105、PR2／PR3 後
 * 18 144；#175 之前為 16 774，#145 時記為 16 763）。PR5 的 +Δ 來自 `create_note` 的 `groupId` 欄
 * （`.describe()`＋`format`）、description 首句與兩處 edit_note 限定、`title` 片語。PR1 的 +1 331 來自
 * `owner` 判別聯合（`{kind:"user"…}｜{kind:"group"…}`）的 JSON
 * Schema 在 list_notes／search_notes／create_note／read_note_outline 四份 outputSchema 各展開一次（加上
 * `list_notes` description 變長）。⚠ 上面那個 15 362 在 #148
 * （改寫模型面敘述那一輪）之後就過期了，而這段註解當時沒跟上——別再拿它去論證餘裕。對照組、
 * 百分比刻意不抄在這裡：案 11b 每次跑都 `console.log` 印出當下的值（剩餘字元一減就有）。
 *
 * Task 5 複量（2026-10-10，rebase 到 main @ f3017a7 之後）：讀寫憑證十支 W' ＝ 29 437（唯讀六支對照組 15 383），與整合分支上的實測相同；
 * 依原配方重推仍是 29 696 × 1.3 ＝ 38 604.8 → 38 700，門檻不動。
 *
 * **#239（2026-10-11，feat/239-notes-move-scope，Task 2 的改動（Task 1 之上））：被測改讀寫搬移憑證**（`move_note_to_group` 只在
 * notes:move 時註冊，讀寫憑證的 `copy_note` 換短版說明）。實測讀寫搬移十支 wire ＝ 29 437（與 #180＋#200 PR2 的讀寫十支同值——集合與字串皆同）、
 * 讀寫九支對照組 26 930、唯讀六支對照組 15 383。最壞情形仍是 29 437，依原配方重推 29 696 × 1.3 ＝ 38 604.8 → 38 700，門檻不動。
 * 合流複量（2026-10-11，rebase 到 main @ 666dbd6——#241 全面 `.strict()` 之後）：三個數字逐一相同（29 437／26 930／15 383），門檻不動。
 *
 * **#181 PR-2d（2026-10-26，feat/trash-mcp，T5 之上）：被測改讀寫搬移刪除憑證**（`delete_note`／`restore_note` 只在 notes:delete
 * 時註冊；`list_trash` 任何憑證都有）。實測讀寫搬移刪除十三支 wire ＝ **37 125**（現行門檻 38 700 的 95.9%）；對照組：讀寫刪除十二支
 * 34 618、讀寫搬移十一支 32 998、讀寫十支 30 491、唯讀七支 18 271（相對 #239 的 29 437／26 930／15 383：list_trash 讓每一組各多一支，
 * 兩支新工具讓 RWM → RWMD 再多 4 127）。依原配方重訂：37 125 向上取整到 1024 的倍數＝37 888 → ×1.3 ＝ 49 254.4 → 進位 **49 300**。
 *
 * **#folders PR-3d T6（2026-10-29，feat/folders-mcp，T5 之上）：讀寫搬移刪除憑證十七支**（T2 起 `noteSummarySchema` 多 `folder`、T3 `list_notes` 多
 * `pageCutShort`、T4 `list_trash` 多 `cursor`／`folderPath` 等欄、T5 加 `list_folders`、T6 加 `create_folder`／`rename_folder`／`move_folder`）。
 * 實測讀寫搬移刪除十七支 wire ＝ **52 043**（舊門檻 49 300 的 105.6%，破線，照 plan 讀碼發現 24 當場重訂）；對照組：讀寫刪除十六支 49 089、
 * 讀寫搬移十五支 47 338、讀寫十四支 44 384、唯讀八支 24 004（T5 後十四支是 44 777，三支資料夾寫入工具＋共用的 folder schema 讓它多 7 266）。
 * 依原配方重訂：52 043 向上取整到 1024 的倍數＝52 224 → ×1.3 ＝ 67 891.2 → 進位 **67 900**。T7（`move_note_to_folder` 與三支 `folder_id`）、
 * T8（`delete_folder`）還會再加；T9 做最後一次重訂與棚內突變。
 *
 * 最近一次依原配方重訂：2026-10-29（#folders PR-3d T6，見上；前一次 2026-10-26 是 #181 PR-2d）；下次逼近時同樣回頭重訂連同推導，不是逕自調大。
 *
 * **什麼樣的迴歸會撞牆**（**突變實跑，2026-09-09**）：把 `edit_note` 的 `if_match`
 * 欄位 `.describe()` 加長 6000 字元（`"x".repeat(6000)` 接在句尾）→ wire 變成 **21 362**，
 * 紅（`expected 21362 to be less than or equal to 21300`）；已 revert。這條迴歸只是拿來驗證
 * 餘裕確實存在、且沒有 D11 那種鏡像效應（`tools/list` 的 schema 只進脈絡一份，加長多少 wire
 * 就多長多少，不是 ×2.1）。撞牆時**先問「這段字非進 schema 不可嗎」**：`tools/list` 的每一個
 * 位元組每一次連線都進模型脈絡，而 `instructions` 與 `docs/mcp.md` 是更便宜的落點。
 * #200 PR1 追記（**突變實跑，2026-10-08**，門檻 28 000、基線 20 578）：同一條 +6000 的迴歸現在是 **26 578、不再撞牆**
 * （餘裕變大是重訂門檻的直接結果）；加長 7500 → **28 078**，紅（`expected 28078 to be less than or equal to 28000`）。
 * #180＋#200 PR2 追記（**突變實跑，2026-10-10**，門檻 38 700、基線 29 437；舊數字不得沿用，spec §8）：同一條 +6000 的迴歸現在是 **35 437、不再撞牆**
 * （用掉 91.6%）；要撞牆得加長 `N_LIST_MAX − W + 100` ＝ 9 363 → **38 800**，紅（`expected 38800 to be less than or equal to 38700`）。
 * 兩發都已 revert（棚內突變，md5 還原確認）。
 * #181 PR-2d 追記（**突變實跑，2026-10-26**，門檻 49 300、基線 37 125）：把 `delete_note` 的 description 加長
 * `N_LIST_MAX − W + 100` ＝ 12 275 字元（`x`，接在句尾）→ **49 400**，紅（`expected 49400 to be less than or equal to 49300`）；已 revert（棚內突變，md5 還原確認）。
 */
export const N_LIST_MAX = 67_900;

/**
 * 案 (vii) 第一發（#181 `list_trash` 最壞形）的下界哨兵。2026-10-26 實測 **236 598**（群組名 80 個 `"`；第二發 67＋13 形 247 498；
 * 恰好 100 篇時 `truncated:false` 比 `true` 多 1 字元、鏡像兩份再多 2 → **247 500**，餘裕 ×1.06，剩 14 644）。落到 230 000 以下代表
 * 測資沒造滿（刪除者或群組沒帶上、標題沒截到逃脫後 200），或 `truncateText` 截得比「逃脫後 200」還兇——回頭查 fixture，不要改這個數字遷就（用意同 MIN_WORST_GROUP_WIRE）。
 * 資料夾 PR-3d T4 起 `list_trash` 依預算截頁、每項另帶 `folderPath`（(vii) 每篇放在最壞的五層路徑），單頁不會再超過預算，所以改量
 * 「全部頁的 items 逐項 `wireCost` 合計」：101 項約 3 761 × 101 ≈ 38 萬，遠高於 230 000；低於它代表 fixture 沒造滿（同上）。
 */
const MIN_WORST_TRASH_WIRE = 230_000;

/**
 * 案 (iv) 第一發（#177 之後的群組形最壞情形）的下界哨兵。2026-10-07 實測 **247 056**（餘裕 ×1.06，剩 15 088）；
 * #177 之前同一欄位配置的合規形（標題 200 個 ASCII、群組名 80 個 `"`）是 211 556。落到 240 000 以下代表測資沒造滿，
 * 或 `truncateText` 截得比「逃脫後 200」還兇（例如把預算算成兩份逃脫）——回頭查，不要改這個數字遷就。
 * 資料夾 PR-3d T3 起 `list_notes` 依 wire 預算（`MCP_LIST_WIRE_BUDGET` 240 000）截頁，單頁回應不會再超過預算，所以改量
 * 「合併所有頁的 `notes` 後 `wireCost({ notes, nextCursor: null })`」（鏡像兩份、不含 JSON-RPC 信封）：100 篇加上 `folder: null`
 * 後預估約 25 萬（T2 單頁實測 250 056 含信封）。它仍是「fixture 夠壞」的證明——低於 240 000 就代表不截頁也放得下，(iv) 便量不到截頁。
 */
const MIN_WORST_GROUP_WIRE = 240_000;

interface Measured {
  label: string;
  wire: number;
}

const measured: Measured[] = [];

/** 量一發 `tools/call` 的完整 wire 回應，順手斷言它沒有變成錯誤結果。 */
async function callWire(
  app: FastifyInstance,
  token: string,
  label: string,
  name: string,
  args: unknown
): Promise<number> {
  const res = await mcpPost(app, rpc("tools/call", { name, arguments: args }), { token });
  expect(res.statusCode).toBe(200);
  const result = res.json().result as { isError?: true };
  // 錯誤結果都很小，會讓門檻假綠——被測的必須是成功路徑。
  expect(result.isError).toBeUndefined();
  const wire = res.body.length;
  measured.push({ label, wire });
  console.log(`[案 11c] ${label.padEnd(46)} wire=${String(wire).padStart(7)}  餘裕 ×${(MCP_MAX_WIRE / wire).toFixed(1)}`);
  expect(wire).toBeLessThanOrEqual(MCP_MAX_WIRE);
  return wire;
}

type ListNotesPage = { notes: Array<Record<string, unknown> & { id: string; updatedAt: string }>; nextCursor: string | null; pageCutShort?: true };

/** 資料夾 PR-3d T3：`list_notes` 從頭翻到 `nextCursor` 為 null；每頁都量 wire、斷 ≤ N（同 callWire）。 */
async function pageAllNotes(app: FastifyInstance, token: string, label: string, limit: number): Promise<ListNotesPage[]> {
  const pages: ListNotesPage[] = [];
  let cursor: string | undefined;
  for (let i = 1; i <= 20; i += 1) {
    const args = cursor === undefined ? { limit } : { limit, cursor };
    const res = await mcpPost(app, rpc("tools/call", { name: "list_notes", arguments: args }), { token });
    expect(res.statusCode).toBe(200);
    const result = res.json().result as { isError?: true; structuredContent: ListNotesPage };
    expect(result.isError).toBeUndefined();
    const wire = res.body.length;
    const pageLabel = `${label} 第 ${i} 頁`;
    measured.push({ label: pageLabel, wire });
    console.log(`[案 11c] ${pageLabel.padEnd(46)} wire=${String(wire).padStart(7)}  餘裕 ×${(MCP_MAX_WIRE / wire).toFixed(1)}`);
    expect(wire).toBeLessThanOrEqual(MCP_MAX_WIRE);
    // 生產端不變量（spec §5.12）：每頁的 payload（鏡像兩份）不超過預算；比哨兵嚴，守得住預算常數接錯或不截頁這類回歸。
    expect(wireCost(result.structuredContent)).toBeLessThanOrEqual(MCP_LIST_WIRE_BUDGET);
    pages.push(result.structuredContent);
    if (result.structuredContent.nextCursor === null) return pages;
    cursor = result.structuredContent.nextCursor;
  }
  throw new Error("list_notes 翻了 20 頁還沒到底");
}

type ListTrashPage = {
  items: Array<Record<string, unknown> & { id: string; folderPathTruncated?: true }>;
  truncated: boolean;
  nextCursor: string | null;
  pageCutShort?: true;
};

/** 資料夾 PR-3d T4：`list_trash` 從頭翻到 `nextCursor` 為 null；每頁 wire ≤ N、payload ≤ 預算、`truncated` ≡ `nextCursor !== null`。 */
async function pageAllTrash(app: FastifyInstance, token: string, label: string): Promise<{ pages: ListTrashPage[]; wires: number[] }> {
  const pages: ListTrashPage[] = [];
  const wires: number[] = [];
  let cursor: string | undefined;
  for (let i = 1; i <= 20; i += 1) {
    const res = await mcpPost(app, rpc("tools/call", { name: "list_trash", arguments: cursor === undefined ? {} : { cursor } }), { token });
    expect(res.statusCode).toBe(200);
    const result = res.json().result as { isError?: true; structuredContent: ListTrashPage };
    expect(result.isError).toBeUndefined();
    const wire = res.body.length;
    const pageLabel = `${label} 第 ${i} 頁`;
    measured.push({ label: pageLabel, wire });
    console.log(`[案 11c] ${pageLabel.padEnd(46)} wire=${String(wire).padStart(7)}  餘裕 ×${(MCP_MAX_WIRE / wire).toFixed(1)}`);
    expect(wire).toBeLessThanOrEqual(MCP_MAX_WIRE);
    expect(wireCost(result.structuredContent)).toBeLessThanOrEqual(MCP_LIST_WIRE_BUDGET);
    const page = result.structuredContent;
    expect(page.truncated).toBe(page.nextCursor !== null);
    pages.push(page);
    wires.push(wire);
    if (page.nextCursor === null) return { pages, wires };
    cursor = page.nextCursor;
  }
  throw new Error("list_trash 翻了 20 頁還沒到底");
}

/** 同一人 cookie 的 `GET /api/notes`（依微秒排；只比集合）。 */
async function restNoteIds(app: FastifyInstance, userId: string): Promise<string[]> {
  const res = await app.inject({ method: "GET", url: "/api/notes", cookies: await cookieOf(userId) });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as Array<{ id: string }>).map(n => n.id);
}

/**
 * 翻完的各頁：id 不重複、集合等於 REST、共 `total` 篇；序列依（`updatedAt` 毫秒 DESC, `id` DESC）——MCP 的 keyset 鍵。
 * REST 依微秒排，同一毫秒內順序可能不同，所以不比序列。
 */
function expectPagedSameAsRest(pages: ListNotesPage[], restIds: string[], total: number): ListNotesPage["notes"] {
  const all = pages.flatMap(p => p.notes);
  const ids = all.map(n => n.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(ids).toHaveLength(total);
  expect([...ids].sort()).toEqual([...restIds].sort());
  for (let i = 1; i < all.length; i += 1) {
    const a = all[i - 1]!;
    const b = all[i]!;
    expect(a.updatedAt > b.updatedAt || (a.updatedAt === b.updatedAt && a.id > b.id), `${i - 1}→${i}`).toBe(true);
  }
  return all;
}

/** owner ＋ 唯讀 PAT。 */
async function owner(ctx: CollabTestCtx): Promise<{ id: string; email: string; token: string }> {
  const email = `o-${randomUUID()}@example.com`;
  const user = await ctx.createUser({ email, password: PASSWORD });
  const { token } = await seedTokenForUser(ctx.db, user.id, "notes:read");
  return { id: user.id, email, token };
}

/** 測資 (iv) 的 `count`（預設 100）篇最壞群組筆記（說明見 (iv) 上方的長註解）；(iv)、(iv-b) 與 LN4 共用。 */
async function seedWorstGroupNotes(
  ctx: CollabTestCtx,
  count: number = MCP_PAGE_MAX,
): Promise<{ o: { id: string; email: string; token: string }; g: { id: string } }> {
  const o = await owner(ctx);
  const handle = `h${"a".repeat(31)}`; // 32 字元：讓 lastEdited.byHandle 也滿長，同 (iii)（gate r4 B-N2）
  await ctx.db.update(users).set({ handle }).where(eq(users.id, o.id));
  const name = `${'"'.repeat(67)}${"\u0001".repeat(13)}`;
  expect([...name]).toHaveLength(80); // `groups_name_chk` 的上限
  const g = await seedGroup(ctx.db, name, [{ userId: o.id, role: "member" }]);
  const agentLabel = "g".repeat(32);
  for (let i = 0; i < count; i += 1) {
    const n = String(i).padStart(4, "0");
    await seedMaxNote(ctx.db, { groupId: g.id }, o.id, { title: '"'.repeat(200), slug: `${n}-${"s".repeat(95)}`, agentLabel });
  }
  return { o, g };
}

async function firstSectionId(app: FastifyInstance, token: string, noteId: string, offset = 0): Promise<string> {
  const res = await mcpPost(
    app,
    rpc("tools/call", { name: "read_note_outline", arguments: { note_id: noteId, section_offset: offset } }),
    { token }
  );
  const payload = res.json().result.structuredContent as { sections: { sectionId: string; chars: number }[] };
  // 取最長的那一段——`read_note_section` 的最壞情形是「有東西可以截」。
  return payload.sections.reduce((a, b) => (a.chars >= b.chars ? a : b)).sectionId;
}

/**
 * `edit_note` 的 `if_match` 只能從**指紋**來，而 `read_note_outline` 依 M12 刻意不帶指紋
 * （`outline-page.ts` 檔頭）——量測要走 REST 的 `GET /content`，與 `mcp-edit-note.test.ts`
 * 的 `restOutline()` 同一個理由：獨立真相，不繞路去猜。
 */
async function sectionAt(
  app: FastifyInstance,
  token: string,
  noteId: string,
  index: number
): Promise<{ sectionId: string; fingerprint: string }> {
  const res = await getContent(app, noteId, token);
  expect(res.statusCode).toBe(200);
  const body = res.json() as { outline: Array<{ sectionId: string; fingerprint: string }> };
  return body.outline[index]!;
}

describe("#108 tools/list 的脈絡成本（案 11b）", () => {
  // PR1 量的是唯讀憑證（四支工具）；PR2 起讀寫憑證（六支工具）才是最壞情形——`edit_note`／
  // `create_note` 的 input／output schema 一起進脈絡。本案改打讀寫憑證，唯讀憑證只當對照
  // 一起印出來，門檻只釘在讀寫憑證那個數字上。
  // #239（spec §7.6）：最壞情形換成**讀寫搬移**憑證（`move_note_to_group` 只在 notes:move 時註冊，
  // `copy_note` 的說明是長版）——被測改它；讀寫與唯讀一起印出來當對照，門檻只釘在讀寫搬移那個數字上（支數見下方斷言；#181 起各多 list_trash）。
  // #181 PR-2d：最壞情形換成**讀寫搬移刪除**憑證（`delete_note`／`restore_note` 只在 notes:delete 時註冊）——被測改它；
  // 讀寫刪除、讀寫搬移、讀寫、唯讀一起印出來當對照，門檻只釘在 RWMD 那個數字上。
  it("讀寫搬移刪除憑證的 tools/list 完整 wire 回應 ≤ N_LIST_MAX（RWD、RWM、RW、R 當對照）", async () => {
    const ctx = await buildCollabTestApp();
    const o = await owner(ctx);
    const { token: rwToken } = await seedTokenForUser(ctx.db, o.id, "notes:read notes:write");
    const { token: rwmToken } = await seedTokenForUser(ctx.db, o.id, "notes:read notes:write notes:move");
    const { token: rwdToken } = await seedTokenForUser(ctx.db, o.id, "notes:read notes:write notes:delete");
    const { token: rwmdToken } = await seedTokenForUser(ctx.db, o.id, "notes:read notes:write notes:move notes:delete");

    const roRes = await mcpPost(ctx.app, rpc("tools/list"), { token: o.token });
    expect(roRes.statusCode).toBe(200);
    expect((roRes.json().result.tools as unknown[]).length).toBe(8);
    const roWire = roRes.body.length;

    const rwRes = await mcpPost(ctx.app, rpc("tools/list"), { token: rwToken });
    expect(rwRes.statusCode).toBe(200);
    expect((rwRes.json().result.tools as unknown[]).length).toBe(15);
    const rwWire = rwRes.body.length;

    const rwmRes = await mcpPost(ctx.app, rpc("tools/list"), { token: rwmToken });
    expect(rwmRes.statusCode).toBe(200);
    expect((rwmRes.json().result.tools as unknown[]).length).toBe(16);
    const rwmWire = rwmRes.body.length;

    const rwdRes = await mcpPost(ctx.app, rpc("tools/list"), { token: rwdToken });
    expect(rwdRes.statusCode).toBe(200);
    expect((rwdRes.json().result.tools as unknown[]).length).toBe(18);
    const rwdWire = rwdRes.body.length;

    const rwmdRes = await mcpPost(ctx.app, rpc("tools/list"), { token: rwmdToken });
    expect(rwmdRes.statusCode).toBe(200);
    expect((rwmdRes.json().result.tools as unknown[]).length).toBe(19);
    const rwmdWire = rwmdRes.body.length;

    console.log(
      `[案 11b] tools/list  唯讀憑證（八支，對照）wire=${roWire}  讀寫憑證（十五支，對照）wire=${rwWire}  ` +
        `讀寫搬移憑證（十六支，對照）wire=${rwmWire}  讀寫刪除憑證（十八支，對照）wire=${rwdWire}  ` +
        `讀寫搬移刪除憑證（十九支，被測）wire=${rwmdWire}  門檻=${N_LIST_MAX}  用掉 ${((rwmdWire / N_LIST_MAX) * 100).toFixed(1)}%`
    );
    expect(rwmdWire).toBeLessThanOrEqual(N_LIST_MAX);
  });
});

describe("#108 單次回應大小（案 11c／M16）", () => {
  // 測資 (i)：一顆 heading 260 000 字元、標題也 260 000 字元的筆記。
  // **殺掉的寫法（四條突變全部實跑過，2026-09-07；每一條都同時放寬對應的 `outputSchema`
  // 上限，否則先擋下它的是 SDK 的 `validateToolOutput` 而不是這條大小門檻）**：
  //   - `dto.ts` 的 `title` 不截 → `(i) list_notes` 520 644
  //   - `read-note-outline.ts` 的 `note.title` 不截（**與上一條是兩個呼叫點**）→ 521 294
  //   - `outline-page.ts` 的 `heading` 不截 → `(i) read_note_outline` 521 290
  //   - `read-note-section.ts` 的 `markdown` 不截 → `(i) read_note_section` 560 513
  // ⚠ **但這一案不是那四條的唯一守衛，別這樣宣稱**（reviewer 重跑）：`heading`／`markdown`
  //   不截 `mcp-content.test.ts` 也會紅（各一案／三案），`title` 那條由 `mcp-notes.test.ts`
  //   的 200 字元斷言直接守。**(i) 獨有的那一層是「病態筆記下 wire ≤ N」**——逐欄斷言看的是
  //   欄位值，看不到「整個回應加起來會不會爆」，而那正是 M16 最後一列要的東西。
  // Task 5 案 11c 補：`create_note` 的最壞情形是**回應裡的 `title` 被截到 200 字元 ＋ 多帶
  // `titleTruncated:true`**（`toNoteSummary`，`dto.ts`）——與這一案的 `hugeTitle` 同一個
  // 病態形，所以順手擺在 (i)：一發讀寫憑證的 `create_note`，帶一顆同樣 260 000 字元的標題。
  // ⚠ `create_note` 不寫 live doc（不帶 `content`），對這一案其他量測**零污染**。
  // #200 PR1：`create_transfer_token` 也在這一案量（spec §9.4(c) 要求每支工具都量）——upload／download 各一發。它的回應
  // 不帶標題或內容（只有 id、token、網址、curl、固定的 `next`），病態筆記對它不是最壞形，量的是「它也在 N 以內」這件事本身。
  // `edit_note` 在 (ii) 量（它的最壞形是一整頁逐段指紋）。
  it("(i) 一篇 heading／title 各 260 000 字元的筆記 → edit_note 的 rename 與其他工具（含 create_transfer_token 兩種 purpose）都 ≤ N", async () => {
    const ctx = await buildCollabTestApp();
    const o = await owner(ctx);
    const { token: rwToken } = await seedTokenForUser(ctx.db, o.id, "notes:read notes:write");
    const hugeTitle = `T${"i".repeat(259_999)}`;
    const note = await ctx.createNote(o.id, hugeTitle);
    const session = await ctx.loginAs(o.email, PASSWORD);
    const client = await seedContent(ctx, session, note.id, `# ${"H".repeat(260_000)}\n\n${"B".repeat(20_000)} tail`);

    await callWire(ctx.app, o.token, "(i) read_note_outline", "read_note_outline", { note_id: note.id });
    const sectionId = await firstSectionId(ctx.app, o.token, note.id);
    await callWire(ctx.app, o.token, "(i) read_note_section", "read_note_section", {
      note_id: note.id,
      section_id: sectionId,
    });
    await callWire(ctx.app, o.token, "(i) list_notes", "list_notes", { limit: MCP_PAGE_MAX });
    await callWire(ctx.app, o.token, "(i) search_notes", "search_notes", { query: "Tiii", limit: 50 });
    await callWire(ctx.app, rwToken, "(i) create_note", "create_note", { title: hugeTitle });
    await callWire(ctx.app, rwToken, "(i) create_transfer_token upload", "create_transfer_token", { note_id: note.id, purpose: "upload" });
    await callWire(ctx.app, rwToken, "(i) create_transfer_token download", "create_transfer_token", { note_id: note.id, purpose: "download" });
    // #180 §9-6：copy_note 的最壞形＝副本 title 截斷＋titleTruncated（同 create_note）；來源就是這篇 260 000 字元標題的筆記。
    await callWire(ctx.app, rwToken, "(i) copy_note", "copy_note", { note_id: note.id });
    // #180 §9-6：move_note_to_group 的最壞形＝搬後 title 截斷＋群組 owner。先建一個群組，把這篇病態筆記搬進去。
    // #239：move_note_to_group 只在 notes:move 時註冊——這一發改用讀寫搬移憑證（callWire 斷 isError 為 undefined）。
    const mg = await seedGroup(ctx.db, "Move target", [{ userId: o.id, role: "admin" }]);
    const { token: rwmToken } = await seedTokenForUser(ctx.db, o.id, "notes:read notes:write notes:move");
    await callWire(ctx.app, rwmToken, "(i) move_note_to_group", "move_note_to_group", { note_id: note.id, group_id: mg.id });
    // #180 §9-6／R9：rename 的最壞形＝回應 `title` 被截到逃脫後 200 ＋ titleTruncated（鏡像兩份），標題同樣 260 000 字元。
    // 擺在 (i) 最後：它會真的改標題（後面的量測若接在它之後，請排在它前面——copy／move 已排在這行之前）。
    await callWire(ctx.app, rwToken, "(i) edit_note rename", "edit_note", { note_id: note.id, op: "rename", title: `R${"i".repeat(259_999)}` });
    client.disconnect();
  });

  // 測資 (ii)：500 段、每段標題 1000 字元。**它只殺掉一種寫法：outline 不分頁**
  // （`buildOutlinePage` 的 `slice(offset, offset + MCP_PAGE_MAX)` 拿掉 → 第一頁 319 692，紅）。
  // ⚠ **它殺不掉「`heading` 不截」**（原本的註解這樣寫，實跑推翻）：100 段 × 1000 字元的
  //   heading 只到 216 904，**還在 262 144 以內**。那一條靠 (i)（一顆 260 000 的 heading）。
  //   最後一頁那一發是「分頁的邊界也在門檻內」，不是另一種寫法的守衛。
  it("(ii) 500 段、每段標題 1000 字元 → outline 的第一頁與最後一頁都 ≤ N", async () => {
    const ctx = await buildCollabTestApp();
    const o = await owner(ctx);
    const { token: rwToken } = await seedTokenForUser(ctx.db, o.id, "notes:read notes:write");
    const note = await ctx.createNote(o.id, "five hundred sections");
    const md = Array.from({ length: 500 }, (_, i) => `# ${String(i).padStart(4, "0")}${"h".repeat(994)}`).join("\n\n");
    const session = await ctx.loginAs(o.email, PASSWORD);
    const client = await seedContent(ctx, session, note.id, md);

    await callWire(ctx.app, o.token, "(ii) read_note_outline 第一頁", "read_note_outline", { note_id: note.id });
    await callWire(ctx.app, o.token, "(ii) read_note_outline 第五頁", "read_note_outline", {
      note_id: note.id,
      section_offset: 4 * MCP_PAGE_MAX,
    });
    const sectionId = await firstSectionId(ctx.app, o.token, note.id);
    await callWire(ctx.app, o.token, "(ii) read_note_section", "read_note_section", {
      note_id: note.id,
      section_id: sectionId,
    });

    // Task 5 案 11c 補：`edit_note` 的最壞情形是**成功回應帶一整頁（100 筆）逐段指紋的
    // outline**（`outline-page.ts` 的 `withFingerprints: true`，`read_note_outline` 完全
    // 沒有這個負擔）。⚠ 寫入落點刻意指在**後段**（第 250 段，遠離第一頁）：`replace_section`
    // 這族 op 的取頁規則是從落點（`afterSectionIndex`）起算（D-J），打第一段等於跟
    // `read_note_outline` 第一頁量到同一種形，量不到「取頁規則對任意落點都算得出一整頁」
    // 這件事——這一發放在該 it 的**最後**，因為它會真的寫進去，不得污染前面幾發的量測。
    const target = await sectionAt(ctx.app, o.token, note.id, 250);
    await callWire(ctx.app, rwToken, "(ii) edit_note replace_section@250", "edit_note", {
      note_id: note.id,
      op: "replace_section",
      section_id: target.sectionId,
      markdown: `# 0250-edited${"h".repeat(986)}`,
      if_match: target.fingerprint,
    });
    client.disconnect();
  });

  /**
   * 測資 (iii)：100 筆「每一格都合規但都滿長」的筆記。**所有工具裡最大的回應是它**——
   * 前兩組測資量不到（它們只有一兩筆列）。
   *
   * ⚠ **不能用 `ctx.createNote` 隨手造**：那樣造出來的列 `last_edited_at` 是 NULL，`lastEdited`
   * 恆為 `null`，那 32 字元 × 100 筆的 `agentLabel`／`byHandle` 根本不在回應裡，量到的值會
   * 明顯小於真正的最壞情形。四欄要一起補滿：`lastEditedAt`／`lastEditedBy`／
   * `lastEditedAgentLabel`（`lastEditedTokenId` 不進 DTO，不必補）。
   * **量到的值明顯小於 160 000 就是測資沒造滿，回頭查測資，不要調 N。**
   *
   * 2026-09-07 實測 **155 556**（餘裕 ×1.7）。⚠ **與規格 rev 5 的參考值 160 360 差 4804
   * （每列約 48 wire）的成因已查明，不是測資沒造滿**：這裡的 `title` 取**恰好 200、不觸發截斷**，
   * 而真正的最壞情形是 `title > 200` 被截到 200 **並多帶一把 `"titleTruncated":true`**
   * （鏡像兩份 ≈ 48 wire／列）。刻意照 plan 取 200，因為這一案要量的是「合規的最壞情形」；
   * 引用這個數字時要一併講這句，否則會被問「是不是還是沒造滿」。
   *
   * ⚠ **誠實記下：這一案殺不掉任何一種「漏截」的寫法**——每一格都恰好在上限之內，拿掉截斷
   * 對它零影響（那四條的守衛見 (i) 上面那段：`heading`／`markdown` 由 `mcp-content` 與 (i) 一起守、
   * `title` 由 `mcp-notes` 直接守）。它守的是另一件事：**「單次回應 ≤ N」在合規的最壞情形下
   * 是不是真的成立**。日後把 `MCP_PAGE_MAX` 調大、或往 `NoteSummary` 加欄位，紅的會是它。
   */
  it("(iii) 100 筆滿長筆記（handle 32／title 200／slug 100／agentLabel 32）＋ limit 100 → ≤ N", async () => {
    const ctx = await buildCollabTestApp();
    const o = await owner(ctx);
    const { token: rwToken } = await seedTokenForUser(ctx.db, o.id, "notes:read notes:write");
    const handle = `h${"a".repeat(31)}`; // 32 字元，`handles_handle_chk` 的上限
    expect(handle).toHaveLength(32);
    await ctx.db.update(users).set({ handle }).where(eq(users.id, o.id));

    const agentLabel = "g".repeat(32);
    for (let i = 0; i < MCP_PAGE_MAX; i += 1) {
      const n = String(i).padStart(4, "0");
      await seedMaxNote(ctx.db, { ownerId: o.id }, o.id, {
        title: `${n}${"t".repeat(196)}`,
        slug: `${n}-${"s".repeat(95)}`,
        agentLabel,
      });
    }

    const wire = await callWire(ctx.app, o.token, "(iii) list_notes limit=100", "list_notes", { limit: MCP_PAGE_MAX });
    // 「測資沒造滿」的哨兵（判準見上：應落在 160 000 上下）。
    // ⚠ **解析度只到「整組 `lastEdited` 落空」那一級**（reviewer 實測）：整組落空 → 129 756，紅；
    //   只把 `lastEditedAgentLabel` 設 null → 149 356，**綠**。也就是說它擋得住 gate r3 m3 警告的
    //   那個形（用 `ctx.createNote` 隨手造 → `last_edited_at` 是 NULL → 四欄全不在回應裡），
    //   **擋不住「四欄裡有一欄沒造滿」**。
    expect(wire).toBeGreaterThan(140_000);
    // `search_notes` 的 `limit` 上限是 50，所以它的最壞情形恰好是這一發的一半左右。
    await callWire(ctx.app, o.token, "(iii) search_notes limit=50", "search_notes", { query: "ttt", limit: 50 });

    // Task 5 案 11c 補：`create_note` 的另一半最壞情形——`owner.handle`（#175 前叫 `ownerHandle`）是這一案剛設的
    // 32 字元上限（(i) 那一發的 owner 是隨機 email 產生的短 handle，量不到這一格）。標題
    // 一樣給到會截斷的長度，兩案合起來才是 `create_note` 回應真正的最壞情形。
    await callWire(ctx.app, rwToken, "(iii) create_note", "create_note", { title: "c".repeat(300) });
  });

  /**
   * 測資 (iv)（#175 gate r1 B-M9；#177 改成真正的最壞形）：(iii) 的群組變體。群組筆記每列的 `owner` 是
   * `{"kind":"group","id":"<36>","name":"<80 code point>"}`、`url` 是 `/g/<36>/…`，都比個人形的
   * `{"kind":"user","handle":"<32>"}`／`/n/<32>/…` 長——(iii) 的 fixture 裡沒有群組筆記，量不到這一形。
   *
   * **#177 之後的最壞形怎麼來的**：`title`／`owner.name` 走 `truncateText`，預算是「JSON 逃脫後 200」。一個字
   * 在 wire 上的成本是兩份逃脫（structuredContent ＋ 鏡像 text 的再逃脫）：ASCII 2、`"`／`\` 6（`\"` ＋ `\\\"`）、
   * `\n` 5、U+0001 13（`\u0001` ＋ `\u0001`）；佔的預算分別是 1、2、2、6。所以「wire／預算」最大的是 `"`／`\`
   * （×3），C0 只有 ×2.17：
   * - `title`（DB 不限長）：任何以 101 個以上 `"` 開頭的標題都截成 100 個 `"`（wire 600）＋ `titleTruncated`
   *   （約 48）＝**每列 648**，比 200 個 ASCII（400）多 248。這裡用 200 個 `"`。
   * - `owner.name`（DB 上限 80 code point）：80 個 `"` 只用掉預算 160、不截（wire 480）；不截的最好是 70 個 `"` ＋ 10 個
   *   C0（預算恰好 200、wire 550）。截了會多帶 `nameTruncated`（約 46），所以最壞是**截過的**：**67 個 `"` ＋ 13 個
   *   U+0001** → 留 67＋11（預算恰好 200、wire 545）＋ 旗標 ≈ 每列 591。全 C0（80 個）反而只剩 33 個 ＋ 旗標 ≈ 475。
   *   ⚠ 這組是拿真的 `ownerForModel`／`toNoteSummary` 算兩層 `JSON.stringify` 的長度、對 `"`／U+0001／`\n`／ASCII／
   *   emoji／CJK 任三種的組合窮舉出來的（2026-10-07，一次性腳本、不進版控）；69＋11 比 67＋13 少 1。
   * 第一發（最壞形）實測見 `[案 11c]` 那行 log。
   *
   * 後兩發是**回到 #177 之前就會破 N 的兩形**：群組名改成 80 個 U+0001、標題改成 200 個 U+0001。資料夾 PR-3d T3 起 list_notes
   * 依預算截頁，它們只斷 ≤ N，不再是那兩條突變的守衛（見 it 內註解）。
   */
  it("(iv) #175／#177 群組形：100 筆最壞群組筆記（標題 200 個 `\"`、群組名 67 個 `\"`＋13 個 U+0001）＋ limit 100 → 依大小截頁、每頁 ≤ N、續翻與 REST 同一組", async () => {
    const ctx = await buildCollabTestApp();
    const { o, g } = await seedWorstGroupNotes(ctx);
    // 資料夾 PR-3d T3（m-3）：第一頁依 wire 預算截短；續翻到 null，每頁 ≤ N（pageAllNotes 內建），合計與 REST 同一組。
    const pages = await pageAllNotes(ctx.app, o.token, "(iv) list_notes limit=100（群組形最壞）", MCP_PAGE_MAX);
    expect(pages[0]!.pageCutShort).toBe(true);
    expect(pages[0]!.notes.length).toBeLessThan(MCP_PAGE_MAX);
    expect(pages[0]!.nextCursor).not.toBeNull();
    const all = expectPagedSameAsRest(pages, await restNoteIds(ctx.app, o.id), MCP_PAGE_MAX);
    // 「測資沒造滿／截過頭」的哨兵，見常數註解：合併各頁後的 100 篇放不進一頁。
    expect(wireCost({ notes: all, nextCursor: null })).toBeGreaterThan(MIN_WORST_GROUP_WIRE);
    const search = await callWire(ctx.app, o.token, "(iv) search_notes limit=50（群組形最壞）", "search_notes", { query: '""""', limit: 50 });
    expect(search).toBeGreaterThan(MIN_WORST_GROUP_WIRE / 2); // 確定 50 筆都命中，不是空結果的假綠

    // 下面兩發是 #177 之前會破 N 的兩形，只斷 ≤ N。⚠ T3 起 list_notes 依預算截頁，它們**不再是**「`ownerForModel` 不截群組名」
    // 「`truncateText` 退回按原長度」兩條突變的守衛（那樣寫時頁會被截得更短，照樣 ≤ N）；實際守衛是 `test/unit/mcp-limits.test.ts`
    // 的群組名與標題案。
    await ctx.db.update(groups).set({ name: "\u0001".repeat(80) }).where(eq(groups.id, g.id));
    await callWire(ctx.app, o.token, "(iv) list_notes 群組名 80 個 U+0001", "list_notes", { limit: MCP_PAGE_MAX });
    await ctx.db.update(notes).set({ title: "\u0001".repeat(200) }).where(eq(notes.groupId, g.id));
    await callWire(ctx.app, o.token, "(iv) list_notes 標題 200 個 U+0001", "list_notes", { limit: MCP_PAGE_MAX });

    // #175 PR5：`create_note` 的群組形（`groupId`）——回應的 `owner` 是上面改過的群組名。標題給 1000 個 `"`（會截）：
    // 260 000 個 `"` 逃脫後超過請求的 bodyLimit（413），而截斷後的形與長度無關。
    // 只靠 `callWire` 內建的 `≤ N` 與非錯誤；不加下界哨兵（create_note 回應本來就小）。
    const { token: rwToken } = await seedTokenForUser(ctx.db, o.id, "notes:read notes:write");
    await callWire(ctx.app, rwToken, "(iv) create_note（群組形）", "create_note", { title: '"'.repeat(1000), group_id: g.id });
  });

  // (iv-b)（T3 審查 I1）：多一篇讓 `limit + 1` 那列存在（hasMore = true），截頁這條路徑在「本來就還有下一頁」時也要走到。
  it("(iv-b) 101 篇最壞群組筆記、limit 100（查詢多取的那列存在）→ 第一頁照樣依大小截、有 nextCursor；續翻到底與 REST 同一組 101 篇", async () => {
    const ctx = await buildCollabTestApp();
    const { o } = await seedWorstGroupNotes(ctx, MCP_PAGE_MAX + 1);
    const pages = await pageAllNotes(ctx.app, o.token, "(iv-b) list_notes 101 篇 limit=100", MCP_PAGE_MAX);
    expect(pages[0]!.pageCutShort).toBe(true);
    expect(pages[0]!.notes.length).toBeLessThan(MCP_PAGE_MAX);
    expect(pages[0]!.nextCursor).not.toBeNull();
    expectPagedSameAsRest(pages, await restNoteIds(ctx.app, o.id), MCP_PAGE_MAX + 1);
  });

  /**
   * LN4（資料夾 PR-3d T3）：截頁的游標落在同一毫秒的一對上。先把 (iv) 的 100 篇依原順序各拉開 2 ms（內容不變），翻一次找出第一頁的截點 k；
   * 再把第 k、k+1 篇設成同一毫秒、差 1 µs，**µs 序與 id 序相反**（µs 較大的給 id 較小者）：REST（微秒）與 MCP（毫秒＋id）在這一對上順序相反，
   * 游標若用微秒或非排序鍵就會漏掉其中一篇。
   */
  it("LN4 毫秒邊界：第一頁末篇與第二頁首篇同一毫秒、µs 序與 id 序相反 → 續翻不漏不重", async () => {
    const ctx = await buildCollabTestApp();
    const { o, g } = await seedWorstGroupNotes(ctx);
    const pool = ctx.db.$client;
    const base = Date.UTC(2026, 9, 1);
    await pool.query(
      `with r as (select id, row_number() over (order by updated_at desc, id desc) as rn from notes where group_id = $1)
       update notes n set updated_at = $2::timestamptz - r.rn * interval '2 milliseconds' from r where n.id = r.id`,
      [g.id, new Date(base).toISOString()],
    );
    const before = await pageAllNotes(ctx.app, o.token, "LN4 拉開後", MCP_PAGE_MAX);
    const k = before[0]!.notes.length;
    expect(k).toBeLessThan(MCP_PAGE_MAX);
    const order = before.flatMap(p => p.notes).map(n => n.id);
    const [small, large] = [order[k - 1]!, order[k]!].sort() as [string, string];
    const ms = new Date(base - (2 * k + 1)).toISOString(); // 介於第 k−1 篇與第 k+2 篇之間
    await pool.query(`update notes set updated_at = $2::timestamptz + interval '501 microseconds' where id = $1`, [small, ms]);
    await pool.query(`update notes set updated_at = $2::timestamptz + interval '500 microseconds' where id = $1`, [large, ms]);

    // 前提：這一毫秒恰好兩篇；µs 序與 id 序相反（REST 先 small、MCP 先 large）。
    const same = await pool.query(`select count(*)::int as n from notes where date_trunc('milliseconds', updated_at) = $1::timestamptz`, [ms]);
    expect(same.rows[0].n).toBe(2);
    const rest = await restNoteIds(ctx.app, o.id);
    expect(rest.indexOf(small)).toBe(rest.indexOf(large) - 1);

    const pages = await pageAllNotes(ctx.app, o.token, "LN4", MCP_PAGE_MAX);
    expect(pages[0]!.notes).toHaveLength(k);
    expect(pages[0]!.notes.at(-1)!.id).toBe(large);
    expect(pages[1]!.notes[0]!.id).toBe(small);
    expectPagedSameAsRest(pages, rest, MCP_PAGE_MAX);
  });

  /**
   * 測資 (v)（#93 §8.4，M6）：50 篇 (iv) 形的群組筆記，每篇 5 段、heading 200 個 `"`、body 以 `"` 為主並含查詢字。
   * 沒有 wire 預算時約 328 000 > N（spec §8.4 的估算）；有預算 → ≤ N 且 `matchesTruncated: true`。
   * 對照組：同一批改成正常 heading 與內文 → 每篇 3 個 match、無 matchesTruncated。
   */
  it("(v) #93 search_notes：50 篇最壞群組筆記 × 5 段最壞 heading／內文 → ≤ N、matchesTruncated；正常內容 → 每篇 3 個", async () => {
    const ctx = await buildCollabTestApp();
    const o = await owner(ctx);
    const handle = `h${"a".repeat(31)}`;
    await ctx.db.update(users).set({ handle }).where(eq(users.id, o.id));
    const g = await seedGroup(ctx.db, `${'"'.repeat(67)}${"\u0001".repeat(13)}`, [{ userId: o.id, role: "member" }]);
    const ids: string[] = [];
    for (let i = 0; i < 50; i += 1) {
      const n = String(i).padStart(4, "0");
      const id = await seedMaxNote(ctx.db, { groupId: g.id }, o.id, { title: '"'.repeat(200), slug: `${n}-${"s".repeat(95)}`, agentLabel: "g".repeat(32) });
      ids.push(id);
      await ctx.db.insert(noteStates).values({ noteId: id, ydoc: Buffer.from(Y.encodeStateAsUpdate(new Y.Doc())), version: 1 });
      const rows = Array.from({ length: 5 }, (_, k) => ({
        sectionId: `${"s".repeat(62)}${String(k).padStart(2, "0")}`,
        ord: k + 1,
        heading: '"'.repeat(200),
        body: `${'"'.repeat(150)}""""${'"'.repeat(150)}`,
      }));
      await writeSearchIndex(ctx.db, id, 1, { rows, contentHash: `m6-${i}`, indexedUnits: rows.reduce((s, r) => s + r.body.length, 0), capped: false, extractorVersion: SEARCH_EXTRACTOR_VERSION });
    }
    const worst = await mcpPost(ctx.app, rpc("tools/call", { name: "search_notes", arguments: { query: '""""', limit: 50 } }), { token: o.token });
    console.log(`[案 11c] (v) search_notes 50×5 最壞 wire=${worst.body.length}`);
    expect(worst.body.length).toBeLessThanOrEqual(MCP_MAX_WIRE);
    const wp = worst.json().result.structuredContent as { notes: Array<{ matches: unknown[] }>; matchesTruncated?: true };
    expect(wp.notes).toHaveLength(50);
    expect(wp.matchesTruncated).toBe(true);

    await ctx.db.update(noteSearchSections).set({ heading: "Heading", body: 'plain text """" here' }).where(inArray(noteSearchSections.noteId, ids));
    const normal = await mcpPost(ctx.app, rpc("tools/call", { name: "search_notes", arguments: { query: '""""', limit: 50 } }), { token: o.token });
    const np = normal.json().result.structuredContent as { notes: Array<{ matches: unknown[] }>; matchesTruncated?: true };
    expect(np.notes).toHaveLength(50); // 下一行的 every 不得因空陣列而真
    expect(np.notes.every(n => n.matches.length === 3)).toBe(true);
    expect("matchesTruncated" in np).toBe(false);
  });

  /**
   * 測資 (vi)（#200 §7.5）：image block 是 N 的**唯一豁免**，上限由 `MCP_IMAGE_MAX_BYTES` 單獨管。
   * 剛好上限的圖：wire − image.data.length ≤ N（其餘部分照樣受哨兵管）、data.length ≤ 4·ceil(MAX/3)（base64 膨脹的精確上界）；
   * 上限＋1 → file_too_large（不讀檔）。
   */
  it("(vi) #200 read_note_image：剛好上限的圖符合兩條界線；上限＋1 → file_too_large", async () => {
    const ctx = await buildCollabTestApp();
    const o = await owner(ctx);
    const note = await ctx.createNote(o.id, "image cap");
    const atCap = await seedUpload(ctx.db, ctx.uploadsDir, note.id, o.id, Buffer.alloc(MCP_IMAGE_MAX_BYTES, 7));
    const res = await mcpPost(ctx.app, rpc("tools/call", { name: "read_note_image", arguments: { note_id: note.id, upload_id: atCap } }), { token: o.token });
    expect(res.statusCode).toBe(200);
    const result = res.json().result as { isError?: true; content: Array<{ type: string; data?: string }> };
    expect(result.isError).toBeUndefined();
    const data = result.content[1]!.data!;
    console.log(`[案 11c] (vi) read_note_image 上限 wire=${res.body.length}  非圖部分=${res.body.length - data.length}  data=${data.length}`);
    expect(res.body.length - data.length).toBeLessThanOrEqual(MCP_MAX_WIRE);
    expect(data.length).toBeLessThanOrEqual(4 * Math.ceil(MCP_IMAGE_MAX_BYTES / 3));
    const [over] = await ctx.db.insert(uploads).values({ noteId: note.id, uploaderId: o.id, mime: "image/png", size: MCP_IMAGE_MAX_BYTES + 1 }).returning({ id: uploads.id });
    const r2 = await mcpPost(ctx.app, rpc("tools/call", { name: "read_note_image", arguments: { note_id: note.id, upload_id: over!.id } }), { token: o.token });
    expect(r2.json().result.structuredContent.code).toBe("file_too_large");
  });

  /**
   * 測資 (vii)（#181 PR-2d，plan 讀碼發現 4）：`list_trash` 的最壞形。一頁 100 項（101 篇 → `truncated: true`），每項的
   * `title`（DB 不限長）與刪除者 `displayName`（DB 不限長）都以 300 個 `"` 截成 100 個 `"` ＋ `*Truncated`（理由同 (iv)：`"` 的
   * wire／預算比最大）、`handle` 32、群組形（`group` 物件）、`retentionDays` 3650（`purgeAt` 非 null）。
   * 第一發照 plan 用群組名 80 個 `"`（不截）；第二發換成 (iv) 的 67 個 `"` ＋ 13 個 U+0001（截過＋`nameTruncated`，群組名的真正最壞形）。
   * 突變（`toTrashItemForModel` 不截標題、outputSchema 同時放寬；2026-10-26 實跑）→ 第一發 351 998 > N，紅。
   * 資料夾 PR-3d T4：每篇放在五層 `[33,40,40,40,41]` 個 `"` 的群組資料夾鏈最深處（plan 讀碼發現 2 的嚴格最壞路徑），每項另帶 `folderPath`；
   * `list_trash` 依預算截頁，所以三發都翻到底：每頁 ≤ N 且 payload ≤ 預算、`truncated` ≡ `nextCursor !== null`，第一頁截點貼近預算
   * （wire > 預算 − 4 000＝fixture 夠壞）。第三發（LT-PC）把 31 篇還原成活筆記、剩 70 篇：被預算截但查詢沒有下一列（hasMore false），
   * 第一頁仍要 `truncated: true`、有 `nextCursor`（殺「`truncated` 改回 hasMore」）。
   * `delete_note`／`restore_note` 各量一發（同一篇、最壞標題；`restore_note` 回的是 noteSummary 形，群組名是第二發那個）。
   * 實測見 `[案 11c]` 那幾行 log。
   */
  it("(vii) #181 list_trash：101 篇最壞垃圾桶群組筆記（標題、刪除者名各 300 個 `\"`，handle 32，保留 3650 天，五層最壞路徑）→ 依大小截頁、每頁 ≤ N；delete_note／restore_note 最壞標題 → ≤ N", async () => {
    const ctx = await buildCollabTestApp();
    const o = await owner(ctx);
    const handle = `h${"a".repeat(31)}`;
    await ctx.db.update(users).set({ handle, displayName: '"'.repeat(300) }).where(eq(users.id, o.id));
    await ctx.db.$client.query(`update site_settings set trash_retention_days = 3650`);
    const g = await seedGroup(ctx.db, '"'.repeat(80), [{ userId: o.id, role: "admin" }]);
    const chain = await seedFolderChain(ctx.db, { group: g.id }, [33, 40, 40, 40, 41].map(n => '"'.repeat(n)));
    const ids: string[] = [];
    for (let i = 0; i < MCP_PAGE_MAX + 1; i += 1) {
      const n = String(i).padStart(4, "0");
      const id = await seedMaxNote(ctx.db, { groupId: g.id }, o.id, { title: '"'.repeat(300), slug: `${n}-${"s".repeat(95)}`, agentLabel: "g".repeat(32) });
      await setNoteFolder(ctx.db.$client, id, chain.at(-1)!);
      await markTrashed(ctx.db.$client, id, o.id);
      ids.push(id);
    }
    const shot = async (label: string, total: number) => {
      const { pages, wires } = await pageAllTrash(ctx.app, o.token, label);
      expect(pages[0]!.pageCutShort).toBe(true);
      expect(wires[0]!).toBeGreaterThan(MCP_LIST_WIRE_BUDGET - 4_000); // 截點貼近預算＝fixture 夠壞
      const items = pages.flatMap(p => p.items);
      expect(new Set(items.map(i => i.id)).size).toBe(total);
      expect(items[0]!.folderPathTruncated).toBe(true); // 前提：真的帶上最壞路徑
      return { pages, sum: items.reduce((s, i) => s + wireCost(i), 0) };
    };
    const first = await shot("(vii) list_trash 101 篇（群組名 80 個 \"）", MCP_PAGE_MAX + 1);
    expect(first.sum).toBeGreaterThan(MIN_WORST_TRASH_WIRE); // 「測資沒造滿／截過頭」的哨兵，見常數註解

    await ctx.db.update(groups).set({ name: `${'"'.repeat(67)}${"\u0001".repeat(13)}` }).where(eq(groups.id, g.id));
    const second = await shot("(vii) list_trash 101 篇（群組名 67+13）", MCP_PAGE_MAX + 1);
    // 群組名真的換成截過的形（沒換到就是重量第一發）。截頁後單頁 wire 都貼著預算，比不出差別，所以比全部項目的合計成本。
    expect(second.sum).toBeGreaterThan(first.sum);

    // LT-PC：剩 70 篇（> 一頁放得下的、≤ 100）→ 被預算截，但查詢沒有下一列；第一頁照樣 truncated＋nextCursor，翻到底時 truncated false。
    await ctx.db.$client.query(`update notes set deleted_at = null, deleted_by = null where id = any($1::uuid[])`, [ids.slice(70)]);
    const pc = await shot("(vii) LT-PC list_trash 70 篇", 70);
    expect([pc.pages[0]!.truncated, pc.pages[0]!.nextCursor !== null]).toEqual([true, true]);
    expect(pc.pages.at(-1)!.truncated).toBe(false);

    const { token: rwmdToken } = await seedTokenForUser(ctx.db, o.id, "notes:read notes:write notes:move notes:delete");
    await callWire(ctx.app, rwmdToken, "(vii) restore_note（最壞標題）", "restore_note", { note_id: ids[0] });
    await callWire(ctx.app, rwmdToken, "(vii) delete_note（最壞標題）", "delete_note", { note_id: ids[0] });
  });

  // 整張表印一次（PR 描述要貼）。**刻意是 hook 不是 `it`**：它只彙整前面幾案已經斷言過的
  // 值，寫成 `it` 會讓「只跑其中一案」變成假紅。
  afterAll(() => {
    console.log(
      `\n[案 11c 量測表] N=${MCP_MAX_WIRE}\n` +
        measured.map(m => `  ${m.label.padEnd(46)} ${String(m.wire).padStart(7)}  ×${(MCP_MAX_WIRE / m.wire).toFixed(1)}`).join("\n")
    );
  });
});

/**
 * 一列「每一格都合規但都滿長」的筆記；`lastEdited` 四欄一併補滿（見上面的 ⚠）。
 * 個人筆記給 `{ ownerId }`、群組筆記給 `{ groupId }`（XOR，#175）；`editorId` 是 `last_edited_by`。
 */
async function seedMaxNote(
  db: Db,
  owner: { ownerId: string } | { groupId: string },
  editorId: string,
  opts: { title: string; slug: string; agentLabel: string }
): Promise<string> {
  const [row] = await db
    .insert(notes)
    .values({
      ...("groupId" in owner ? { groupId: owner.groupId } : { ownerId: owner.ownerId }),
      title: opts.title,
      slug: opts.slug,
      lastEditedAt: new Date(),
      lastEditedBy: editorId,
      lastEditedAgentLabel: opts.agentLabel,
    })
    .returning({ id: notes.id });
  return row!.id;
}
