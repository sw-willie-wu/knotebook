/**
 * #181 垃圾桶結構守衛（spec §6.2-10、A2-14）。逐行掃 `src/` 下所有 `.ts`（不含測試），`trim()` 後以 `//`、`*`、`/*` 開頭的
 * 註解行跳過，每行以 `matchAll` 計數。
 *
 * 守衛一：直接查 `notes` 表的位置（不分大小寫：`.from(notes)`、`(inner|left|right|full)?join(notes`、`.update(notes)`、
 * `.delete(notes)`、SQL 字面 `from notes`／`join notes`／`update notes`、`${notes}`），以「檔案 → 各處置的處數」登記，
 * 逐檔命中數與表上總和不同就紅；新檔沒登記、登記了但沒命中也紅。
 * 守衛二（AG6）：寫 `deleted_at` 的字面（`deletedAt:`、`deletedBy:`、`deleted_at\s*=`、`set deleted_at`）只准出現在
 * schema、`trashNotesInTx`／`restoreNotesInTx` 所在檔、垃圾桶清單查詢（含 DTO 映射）、MCP `list_trash`（outputSchema 與 DTO 映射）
 * 四檔，各登記處數。
 * 守衛二 b（資料夾 spec §5.8 末條、§5.13）：`trashFolderPath:`／`trash_folder_path` 字面只准 schema、`notes/tx/trash.ts`、
 * `folders/tx/delete-folder.ts`、`groups/tx/delete-group.ts`、垃圾桶清單查詢五檔，各登記處數（與守衛二分開兩張表）。
 * 守衛三（§5.13）：寫 `folders` 表（`.update|insert|delete(folders)`、SQL 字面 `update folders`／`delete from folders`／
 * `insert into folders`，表名也收引號識別字 `"folders"` 與 `sql` 樣板 `${folders}`）的檔只准在 `folders/tx/*.ts`、`groups/tx/delete-group.ts` 之內（spec §5.13 原列 `notes/tx/trash.ts`，
 * 實作經 `folders/tx/ensure-path.ts`，故不列；日後 trash.ts 真要直接寫再加回）。
 * 守衛三 b（§5.13）：寫 `note_placements` 表（同形，含 `"note_placements"`、`${notePlacements}`）的檔只准在 `folders/tx/*.ts` 之內。三與三 b 只比檔集合、不記處數。
 *
 * 選處數不選行內標記：行內標記要訂「命中前後幾行內要有標記」的視窗規則，查詢跨行、標記被格式化工具移位都會誤判；
 * 處數表是純計數，沒有視窗、沒有放置規則，任何處數變動都會讓這張表出現在 diff 裡，審查者一定看得到。
 * 代價：表只記處數，不記哪一處屬於哪一類。
 *
 * ⚠ 不宣稱（誠實）：
 *   - 同一檔裡「刪一處、加一處」處數不變時抓不到。
 *   - 逐處分類是否正確——靠審查與 spec §6.2-12 的測試，不靠守衛。
 *   - 以 note id 直接查子表、不碰 `notes` 的讀取（`uploads`、`note_states`、`note_versions`、`note_links`、`note_shares`、
 *     `note_search_*` 等）——由附錄 B 清單與 A2-5／A2-16 的測試負責。
 *   - 守衛一的 SQL 引號識別字 `"notes"` 與 import 別名（`import { notes as n }`）不在比對式內（目前零命中）。
 *   - 逐行比對：關鍵字與表名分在兩行的 SQL（`update⏎ folders`）抓不到（守衛一的字面 `from⏎ notes` 同此盲點；`${notes}` 不受影響）；
 *     drizzle 呼叫參數拆行（`.update(⏎ folders⏎ )`）也抓不到。
 *   - 守衛二／二 b 抓不到物件簡寫 `.set({ deletedAt })`、`.set({ trashFolderPath })`（沒有冒號）；各條守衛都不做括號解析。
 *   - FK 動作（`ON DELETE CASCADE`／`SET NULL`）造成的寫入不在比對式內：刪資料夾 SET NULL `notes.folder_id`、CASCADE 子資料夾
 *     與放置，刪筆記／撤分享 CASCADE 放置，刪群組 CASCADE 群組資料夾。
 *   - `sql.raw` 拼表名、表物件存進區域變數再寫（`const t = folders; tx.update(t)`）、別名 import、schema 限定的表名
 *     （`${schema.folders}`、`public.folders`）都抓不到（目前零命中）。
 *   - 守衛三／三 b 不記處數：允許檔裡多寫幾處、守衛二 b 同檔刪一處加一處，處數表都不變。
 *   - 寫 `notes.folder_id` 不歸守衛三管（那是 `notes` 的寫入，由守衛一的 `write`／`trashOnly` 登記）。
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [p] : [];
  });
}
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join("/");

/** 逐檔命中數（只列 > 0 的檔）。 */
function hits(re: RegExp): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of walk(SRC)) {
    let n = 0;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) continue;
      n += [...line.matchAll(re)].length;
    }
    if (n > 0) out[rel(p)] = n;
  }
  return out;
}

const NOTES_QUERY = new RegExp(
  [
    String.raw`\.from\(notes\)`,
    String.raw`\b(?:inner|left|right|full)?join\(notes\b`,
    String.raw`\.update\(notes\)`,
    String.raw`\.delete\(notes\)`,
    String.raw`\bfrom\s+notes\b`,
    String.raw`\bjoin\s+notes\b`,
    String.raw`\bupdate\s+notes\b`,
    String.raw`\$\{notes\}`,
  ].join("|"),
  "gi",
);
const DELETED_AT_WRITE = /deletedAt:|deletedBy:|deleted_at\s*=|set\s+deleted_at/gi;

type Disposition = { excludes?: number; trashOnly?: number; includes?: number; write?: number; why?: string };

// `excludes`＝帶 `deleted_at IS NULL`，或結果必經 §6.2 第 1／3 點閘口；`trashOnly`＝只看垃圾桶；`includes`＝刻意不分狀態（附理由）；`write`＝`UPDATE`／`DELETE`／寫入用 CTE，本句帶 `deleted_at IS NULL` 或受同交易先前帶條件的 `FOR UPDATE` 保護。
const REGISTRY: Record<string, Disposition> = {
  "collab/server.ts": { includes: 1, why: "落款寫進垃圾桶筆記（§6.4.1）" },
  "collab/store.ts": { includes: 1, why: "載入時 links_clock 鉗制，與存活無關" },
  // excludes：scanRound（scanDue）。
  "collab/versions.ts": { excludes: 1, includes: 7, why: "版本狀態隨落盤與套用版本後的基底寫回寫入；readVersionMeta 不改（M-G）；sweep 照常" },
  // 刪資料夾預讀子樹活筆記（資料夾 T8）。
  "folders/service.ts": { excludes: 1 },
  // includes：子樹筆記鎖讀；trashOnly：刷新子樹垃圾桶筆記的路徑快照（資料夾 T8）。
  "folders/tx/delete-folder.ts": { includes: 1, trashOnly: 1, why: "一段式依 id 鎖子樹全部筆記（不分狀態，spec m5）" },
  // excludes：放置的筆記鎖讀（個人／群組 FOR UPDATE、共享 FOR KEY SHARE 同一句，帶 deleted_at IS NULL）；write：UPDATE folder_id（受前一句的 FU 保護）（資料夾 T9）。
  "folders/tx/place-note.ts": { excludes: 1, write: 1 },
  "groups/queries.ts": { includes: 1, why: "群組全部筆記（踢線、刪群組 P0，§6.5）" },
  // 轉移的鎖、配額 innerJoin、轉移 UPDATE、全刪的鎖。
  "groups/tx/delete-group.ts": { includes: 4, why: "轉移／全刪含垃圾桶（§6.5）" },
  "mcp/tools/read-note-outline.ts": { excludes: 1 },
  "notes/editing/candidates.ts": { excludes: 3 },
  "notes/editing/read.ts": { excludes: 1 },
  "notes/editing/write-service.ts": { includes: 1, why: "帶 content 建立失敗清掉剛建的列" },
  // excludes：存活 meta；includes：backfill 群組分支。
  "notes/link-conversion.ts": { excludes: 1, includes: 1, why: "目標在垃圾桶照記（§6.2-4；總管裁定 M10）" },
  "notes/links.ts": { excludes: 3 },
  "notes/list-query.ts": { excludes: 3 },
  // GET :ref／by-path 重讀／搬移後／還原後都在閘口後；routes/notes.ts POST 帶 content 的建立後重讀不經閘口，
  // 讀的是本請求剛建的列，無洩漏。
  "notes/note-dto.ts": { excludes: 1 },
  "notes/public-links.ts": { excludes: 1 },
  "notes/rename-note.ts": { excludes: 2, write: 1 },
  // excludes：accessQuery、noteIsLive；trashOnly：trashedAccessQuery；includes：loadNoteAudience。
  "notes/service.ts": { excludes: 2, trashOnly: 1, includes: 1, why: "移入前抓名單（§6.2-4）" },
  "notes/site-link-resolver.ts": { excludes: 2 },
  // excludes：legacy ref（之後接授權）；includes：slug 探測。
  "notes/slug.ts": { excludes: 1, includes: 1, why: "slug 仍佔用（§6.1）" },
  "notes/tx/copy.ts": { excludes: 1 },
  "notes/tx/delete-notes.ts": { includes: 2, why: "集合由呼叫端決定（永久刪除只傳垃圾桶 id、全刪傳全部）" },
  "notes/tx/move.ts": { excludes: 1, write: 1 },
  "notes/tx/patch-slug.ts": { write: 2 },
  "notes/tx/search-index.ts": { includes: 1, why: "索引照寫（§6.4）" },
  "notes/tx/shares.ts": { excludes: 1 },
  // trashOnly：照路徑重建寫 folder_id（資料夾 T7）、還原 UPDATE、到期查詢；includes：lockNotes；write：移入 UPDATE。
  "notes/tx/trash.ts": { trashOnly: 3, includes: 1, write: 1, why: "先鎖再判（狀態在鎖後逐篇判）" },
  // excludes：切版鎖讀；includes：notBaseVersionSql、reset 兩句；write：cutVersionInTx 內三句 UPDATE。
  "notes/tx/versions.ts": { excludes: 1, includes: 3, write: 3, why: "版本清除照常、轉移 reset 不分狀態" },
  "notes/tx/write-links.ts": { includes: 4, why: "目標在垃圾桶照記（§6.2-4）、CAS 不加條件" },
  "routes/admin-storage.ts": { includes: 2, why: "容量照算（D-W4）" },
  // excludes：withCurrentBase（授權後讀）；includes：DELETE 版本的基底子查詢。
  "routes/note-versions.ts": { excludes: 1, includes: 1, why: "刪版本：授權後子表單句寫入不加條件（§6.2-11 M-I）" },
  // excludes：ownershipChanged、selectNotesWhere、GET public-link；includes：格 4 pre-read；write：公開連結五支。
  // GET public-link 與格 4 pre-read 同是「授權後、本句不帶條件」：前者是純讀，TOCTOU 下等同「先讀後移入」，歸 excludes；
  // 後者由 spec §6.2-11 指定登記為 includes。
  "routes/notes.ts": { excludes: 3, includes: 1, write: 5, why: "格 4 pre-read 不加條件，後面的 CTE 會擋（spec §6.2-11）" },
  "routes/public.ts": { excludes: 2 },
  "storage/tx/quota.ts": { includes: 1, why: "容量照算（D-W4）" },
  "storage/usage.ts": { includes: 4, why: "容量照算（D-W4）" },
  // trashOnly：清單兩支、loadTrashedMeta（delete_note 移入後的重讀）、loadTrashedPurgeAt（delete_folder 移入後的重讀，資料夾 PR-3d T8）。
  "trash/list.ts": { trashOnly: 4 },
  // 還原的預讀空間（資料夾 T7，spec 2026-10-22 §5.8-1）。
  "trash/service.ts": { trashOnly: 1 },
  "uploads/tx/insert-upload.ts": { excludes: 1 },
};

/** 守衛二：只准這四檔，值＝處數。 */
const DELETED_AT_WRITERS: Record<string, number> = {
  "db/schema.ts": 2, // 欄位定義 deleted_at、deleted_by
  "mcp/tools/list-trash.ts": 4, // outputSchema 兩鍵、DTO 映射一鍵、型別註記 `let deletedBy:` 一處（都是讀取，非寫入）
  "notes/tx/trash.ts": 5, // 鎖讀選欄、移入 set 兩欄、還原 set 兩欄
  "trash/list.ts": 3, // 清單選欄、DTO 映射兩欄
};

/** 守衛二 b：`trash_folder_path` 字面，只准這五檔，值＝處數（字面比對，讀寫不分：清單讀快照、鎖讀選欄也算）。 */
const TRASH_FOLDER_PATH_WRITE = /trashFolderPath:|trash_folder_path/gi;
const TRASH_FOLDER_PATH_WRITERS: Record<string, number> = {
  "db/schema.ts": 3, // 欄位定義（鍵、欄名）、CHECK 名 notes_trash_folder_path_chk
  "folders/tx/delete-folder.ts": 1, // 刪資料夾刷新子樹垃圾桶筆記的快照
  "groups/tx/delete-group.ts": 1, // 轉移：快照前接新頂層名
  "notes/tx/trash.ts": 3, // lockNotes 選欄、移入 set、還原清掉
  "trash/list.ts": 1, // 清單 folderPath 讀快照
};

/** 守衛三／三 b：寫 `folders`／`note_placements` 的檔集合。 */
const FOLDERS_WRITE = /\.(?:update|insert|delete)\(folders\)|\b(?:update|delete\s+from|insert\s+into)\s+(?:"?folders"?(?!\w)|\$\{folders\})/gi;
const PLACEMENTS_WRITE =
  /\.(?:update|insert|delete)\(notePlacements\)|\b(?:update|delete\s+from|insert\s+into)\s+(?:"?note_placements"?(?!\w)|\$\{notePlacements\})/gi;
const inFoldersTx = (f: string) => /^folders\/tx\/[^/]+\.ts$/.test(f);
// groups/tx/delete-group.ts：轉移改整棵。還原照路徑重建經 folders/tx/ensure-path.ts，notes/tx/trash.ts 不列。
const FOLDERS_WRITE_OTHERS = new Set(["groups/tx/delete-group.ts"]);

const total = (d: Disposition) => (d.excludes ?? 0) + (d.trashOnly ?? 0) + (d.includes ?? 0) + (d.write ?? 0);

describe("垃圾桶結構守衛（#181 §6.2-10）", () => {
  const actual = hits(NOTES_QUERY);

  it("守衛一 ① 直查 notes 的檔集合＝登記表的鍵", () => {
    expect(Object.keys(actual).sort()).toEqual(Object.keys(REGISTRY).sort());
  });

  it("守衛一 ② 每檔處數＝登記表四項總和", () => {
    for (const [f, d] of Object.entries(REGISTRY)) expect.soft(actual[f] ?? 0, f).toBe(total(d));
  });

  it("守衛一 ③ 有 includes 的條目一定附理由", () => {
    const missing = Object.entries(REGISTRY).filter(([, d]) => (d.includes ?? 0) > 0 && !d.why?.trim()).map(([f]) => f);
    expect(missing).toEqual([]);
  });

  it("守衛二（AG6）寫 deleted_at 的字面只在四檔、處數凍結", () => {
    expect(hits(DELETED_AT_WRITE)).toEqual(DELETED_AT_WRITERS);
  });

  it("守衛二 b trash_folder_path 字面只在五檔、處數凍結", () => {
    expect(hits(TRASH_FOLDER_PATH_WRITE)).toEqual(TRASH_FOLDER_PATH_WRITERS);
  });

  it("守衛三 寫 folders 只在 folders/tx/*、groups/tx/delete-group.ts", () => {
    const outside = Object.keys(hits(FOLDERS_WRITE)).filter(f => !inFoldersTx(f) && !FOLDERS_WRITE_OTHERS.has(f));
    expect(outside).toEqual([]);
  });

  it("守衛三 b 寫 note_placements 只在 folders/tx/*", () => {
    expect(Object.keys(hits(PLACEMENTS_WRITE)).filter(f => !inFoldersTx(f))).toEqual([]);
  });
});
