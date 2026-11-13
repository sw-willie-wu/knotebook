/**
 * #175 S14 結構性守衛：**任何持有交易連線的路徑，不得在交易內 await 會向
 * pool 借連線的呼叫**。違反時不是 500，而是整台 server 永久不回應（pg-pool 預設 max 10、永不逾時；
 * 實跑）。主守衛是結構：交易本體是只收 `tx`／純資料／型別明示測試縫的 `*InTx`，放在
 * `src/**​/tx/` 目錄、不 import `Db`／`DbOrTx`、不碰 `deps`——錯的寫法寫不出來。本檔是**輔助**的源碼掃描：
 * ① `tx/` 目錄裡的檔（剝掉註解後）不得出現 `Db`、`DbOrTx`、`deps.`、`pool` 與閉包 helper 名（`DbOrTx` 放在任何
 *    參數位置、或 `type Tx = DbOrTx` 都會讓路由把 pool 傳進來）；
 * ② `*InTx` 只准宣告在 `tx/` 目錄——`function` 與 `const／let／var … =` 都算，**不論有沒有 export**（路由檔自宣告、
 *    不 export 的 `*InTx` 閉包是這個形）；
 * ③ `tx/` 裡的 `*InTx` 一律以 `function` 宣告，第一個參數字面上是 `tx: Tx`；
 * ④ `ROUTE_FILES` 裡的檔（#175 三支＋#187 的 `routes/oidc.ts`、`routes/oidc-pending.ts`、`routes/admin-auth.ts`、`routes/account.ts`＋#93 的 `notes/search-index.ts`、`notes/search-query.ts`＋#200 的 `mcp/tools/create-transfer-token.ts`＋儲存配額的 `routes/uploads.ts`＋#236 版本歷史的 `collab/versions.ts`、`routes/admin-versions.ts`＋#180 的 `notes/copy-note.ts`、`notes/move-note.ts`＋#286 的 `routes/admin-password-reset.ts`、`routes/password-reset.ts`＋#181 的 `trash/service.ts`＋資料夾的 `folders/service.ts`），`.transaction(` 的 callback **整段**就是一個 `xInTx(tx, …)` 呼叫，而且 `xInTx`
 *    必須是以 `import { … } from "…/tx/…"` 引進的名字——無例外（刪筆記也抽成 `deleteNotesInTx`）；
 * ⑤ 那個呼叫的**引數**（callback 內求值、此時已持有交易連線）只准是識別字、屬性存取與物件字面：**不得有任何 `(`**
 *    （擋住所有以括號形式的呼叫，含 `Number(x)`、`String(x)` 這種轉型）、不得有裸 `db` 識別字（drizzle 的 lazy query）、
 *    `deps.db`、`await`、閉包（`=>`、`function`）與閉包 helper 名。測試縫一律以屬性存取傳入（`deps.groupTestHook`、
 *    `hooks.beforeLinkWrite`）。規則本身比守衛嚴（與 Global Constraints 的 S14 條同一個意思）：引數裡的值不得是 Promise、
 *    thenable 或 query builder——要 await 的，在 `.transaction(` 之前 await 完、存成純資料的區域變數（測試縫除外，它是
 *    函式）；後者本檔看不出來，見下。
 * ⚠ 守不到（誠實）：
 *   - 把 pool 藏進另一個模組——從 `*InTx`（tx/ 檔內）呼叫別的模組的函式、tx/ 檔以 `export { helper as xInTx } from "…"`
 *     重新匯出、或 import 路徑寫成經過 `/tx/` 再跳出（`…/tx/../…`）——只掃字面；行為面只有 `s14-pool.test.ts`
 *     接 `patchSlugInTx` 一形。後兩者屬刻意規避。
 *   - 以識別字傳入的**未求值** query builder 或 Promise（`const audit = deps.db.select()…;` 放在 `.transaction(` 之前、
 *     不 await，再以 `{ …, audit }` 傳進去、`*InTx` 在交易內 await 它）：引數字面乾淨，本檔看不到；型別寫成
 *     `PromiseLike<unknown>` 的話 ① 也看不到。靠 Global Constraints 的「await 完的純資料」規則與 review 守。
 *   - 沒有括號的呼叫：tagged template（``sql`…` ``）、不加括號的 `new X`、屬性存取觸發的 getter——⑤ 看不到；
 *     八個生產呼叫點都沒有這些形。
 *   - 以別名呼叫交易（`deps.db["transaction"].bind(…)` 之類）——`.transaction(` 字面掃不到；屬刻意規避。
 *   - `code()` 剝註解是字面的：字串字面值裡出現 `//`（不是 `://`）時，同一行之後的程式碼會被當成註解剝掉而看不到；
 *     屬刻意規避。
 *   - 表外的交易（`auth/bootstrap.ts`、`notes/editing/apply.ts`／`revert.ts`、oauth…）不掃。
 *   - ⑥ 只凍結數量，不檢查範圍外交易的形——tx/ 以外那 9 處已逐一讀過、皆合規；表上第 10 處
 *     `notes/tx/write-slug.ts` 是 `writeSlugInTx` 內的巢狀 `tx.transaction`（savepoint），本身在 tx/ 裡受 ①③ 掃。
 *   - 在 `.transaction(` **之前** await 完的值當引數傳進去是合法的（那時還沒借交易連線），本檔不管那一段。
 *   - 括號配對不理會字串：字串裡的 `(`／`)` 會讓配對錯位——錯位的結果是 ④ 的計數紅或 ⑤ 紅，不會靜默放行
 *     （實測如此）。
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.name.endsWith(".ts") ? [p] : [];
  });
}
/** 剝掉區塊與行註解（守衛不得被自己的說明文字餵飽）。 */
function code(p: string): string {
  return readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join("/");
const inTxDir = (p: string) => rel(p).split("/").includes("tx");

/** `src[open]` 是 `(`：回傳配對的 `)` 之前的內文（不含兩端括號）。 */
function balanced(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error(`括號不配對：位置 ${open}`);
}

/** 每個 `.transaction(` 的 callback：是否整段就是 `tx => [await] xInTx(tx, …)`，以及那個呼叫的引數文字。 */
function txCallbacks(src: string): Array<{ inTx: boolean; args: string }> {
  const imported = new Set(
    [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]*\/tx\/[^"]*"/g)].flatMap(m =>
      m[1]!.split(",").map(x => x.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean)),
  );
  // `\s*`：`.transaction (tx => …)` 多一個空白也要算進 ④ 的計數。
  return [...src.matchAll(/\.transaction\s*\(/g)].map(m => {
    const body = balanced(src, m.index! + m[0].length - 1);
    const head = /^\s*(?:async\s*)?\(?\s*tx\s*\)?\s*=>\s*(?:await\s+)?(\w+InTx)(?=\()/.exec(body);
    if (!head || !imported.has(head[1]!)) return { inTx: false, args: "" };
    const args = balanced(body, head[0].length);
    const rest = body.slice(head[0].length + args.length + 2);
    return { inTx: /^\s*tx\b/.test(args) && /^\s*$/.test(rest), args };
  });
}

const HELPERS: Array<[string, RegExp]> = [
  ["ownerHandleOf(", /\bownerHandleOf\(/],
  ["editorHandleOf(", /\beditorHandleOf\(/],
  ["groupNameOf(", /\bgroupNameOf\(/],
  ["loadNoteWithOwner(", /\bloadNoteWithOwner\(/],
  ["loadNoteAudience(", /\bloadNoteAudience\(/],
  ["loadNoteDoc(", /\bloadNoteDoc\(/],
  ["resolveNoteAccess(", /\bresolveNoteAccess\(/],
  ["resolveRole(", /\bresolveRole\(/],
  ["beforeNoteDeleted(", /\bbeforeNoteDeleted\(/],
  ["onGroupAccessChanged(", /\bonGroupAccessChanged\(/],
];
const BANNED: Array<[string, RegExp]> = [
  ["Db 型別／值", /\bDb\b/],
  ["DbOrTx", /\bDbOrTx\b/],
  ["deps.", /\bdeps\./],
  ["pool", /\bpool\b/i],
  ...HELPERS,
];
const ARG_BANNED: Array<[string, RegExp]> = [
  ["呼叫（任何括號）", /\(/],
  ["db 識別字", /\bdb\b/],
  ["deps.db", /\bdeps\.db\b/],
  ["pool", /\bpool\b/i],
  ["await", /\bawait\b/],
  ["閉包 =>", /=>/],
  ["閉包 function", /\bfunction\b/],
  ...HELPERS,
];
const ROUTE_FILES = ["routes/notes.ts", "routes/groups.ts", "notes/links.ts", "routes/oidc.ts", "routes/oidc-pending.ts", "routes/admin-auth.ts", "routes/account.ts", "notes/search-index.ts", "notes/search-query.ts", "mcp/tools/create-transfer-token.ts", "mcp/tools/open-notes-as-files.ts", "routes/uploads.ts", "collab/versions.ts", "routes/admin-versions.ts", "notes/copy-note.ts", "notes/move-note.ts", "routes/admin-password-reset.ts", "routes/password-reset.ts", "trash/service.ts", "routes/admin-trash.ts", "trash/purge.ts", "folders/service.ts", "notes/editing/write-service.ts", "site-limits/store.ts", "routes/avatars.ts", "avatars/oidc-job.ts"];

describe("S14 結構性守衛（#175）", () => {
  const files = walk(SRC);
  const txFiles = files.filter(inTxDir);

  it("tx/ 目錄存在且至少有七支交易本體檔", () => {
    expect(txFiles.map(rel).sort()).toEqual(
      expect.arrayContaining([
        "groups/tx/create-group.ts",
        "groups/tx/delete-group.ts",
        "groups/tx/members.ts",
        "groups/tx/roles.ts",
        "notes/tx/patch-slug.ts",
        "notes/tx/redirects.ts",
        "notes/tx/shares.ts",
        "notes/tx/write-links.ts",
        "auth/tx/link-identity.ts",
        "auth/tx/oidc-login.ts",
        "auth/tx/admin-auth-providers.ts",
        "auth/tx/register.ts",
        "auth/tx/identities.ts",
        "auth/tx/admin-site-settings.ts",
        "auth/tx/issue-transfer-token.ts",
        "auth/tx/issue-bulk-transfer-token.ts",
        "auth/tx/admin-demote.ts",
        "auth/tx/password-reset.ts",
        "auth/tx/disable-user.ts",
        "auth/tx/accept-invite.ts",
        "auth/tx/change-password.ts",
        "auth/tx/sessions.ts",
        "uploads/tx/insert-upload.ts",
        "storage/tx/quota.ts",
        "transfer/tx/record-file-sync.ts",
        "auth/tx/admin-site-limits.ts",
      ]),
    );
  });

  it("① tx/ 檔（剝註解後）不出現 Db／DbOrTx／deps./pool 與閉包 helper 名", () => {
    const offenders = txFiles.flatMap(p => BANNED.filter(([, re]) => re.test(code(p))).map(([name]) => `${rel(p)}: ${name}`));
    expect(offenders).toEqual([]);
  });

  it("② `*InTx` 只宣告在 tx/ 目錄（不論有沒有 export）", () => {
    const outside = files
      .filter(p => !inTxDir(p))
      .filter(p => /\bfunction\s+\w+InTx\b|\b(?:const|let|var)\s+\w+InTx\s*=/.test(code(p)))
      .map(rel);
    expect(outside).toEqual([]);
  });

  it("③ tx/ 的 `*InTx` 以 function 宣告、第一個參數是 `tx: Tx`", () => {
    const bad = txFiles.flatMap(p => {
      const src = code(p);
      const consts = [...src.matchAll(/\b(?:const|let|var)\s+(\w+InTx)\s*=/g)].map(m => `${rel(p)}: ${m[1]} 不是 function 宣告`);
      const params = [...src.matchAll(/\bfunction\s+(\w+InTx)\s*(?:<[^>]*>)?\s*\(\s*([^,)]*)/g)]
        .filter(m => !/^tx\s*:\s*Tx$/.test(m[2]!.trim()))
        .map(m => `${rel(p)}: ${m[1]}(${m[2]!.trim()} …)`);
      return [...consts, ...params];
    });
    expect(bad).toEqual([]);
  });

  it("④ `ROUTE_FILES` 每個檔的交易 callback 整段是 `tx => xInTx(tx, …)`、xInTx 由 tx/ import（無例外）", () => {
    const perFile = ROUTE_FILES.map(f => {
      const cbs = txCallbacks(code(path.join(SRC, f)));
      return { f, all: cbs.length, inTx: cbs.filter(c => c.inTx).length };
    });
    expect(perFile).toEqual([
      { f: "routes/notes.ts", all: 2, inTx: 2 }, // PATCH（patchSlugInTx）、PUT shares（#180：移動、複製搬到 notes/move-note.ts、notes/copy-note.ts；#181：DELETE 改成移入、搬到 trash/service.ts）
      { f: "routes/groups.ts", all: 8, inTx: 8 }, // 建群組、加人、換角色、移人、轉移、全刪、改角色、刪角色
      { f: "notes/links.ts", all: 1, inTx: 1 }, // 寫連結（writeLinksInTx）
      { f: "routes/oidc.ts", all: 3, inTx: 3 }, // 登入、SSO 證明、手動連結（#187；登入重投是同一個 runLogin 閉包呼叫兩次，字面只有一處）
      { f: "routes/oidc-pending.ts", all: 1, inTx: 1 }, // 密碼證明（#187；SSO 證明那一處在 routes/oidc.ts）
      { f: "routes/admin-auth.ts", all: 3, inTx: 3 }, // 改登入服務、刪登入服務、站台設定
      { f: "routes/account.ts", all: 4, inTx: 4 }, // 註冊（#187）、解除連結、接受邀請（#285，acceptInviteInTx）、#388 加上密碼（setPasswordInTx）
      { f: "notes/search-index.ts", all: 1, inTx: 1 }, // 全文索引寫入（#93）
      { f: "notes/search-query.ts", all: 1, inTx: 1 }, // 搜尋快照讀取（#93）
      { f: "mcp/tools/create-transfer-token.ts", all: 1, inTx: 1 }, // #200 簽發
      { f: "mcp/tools/open-notes-as-files.ts", all: 1, inTx: 1 }, // bulk transfer 簽發
      { f: "routes/uploads.ts", all: 1, inTx: 1 }, // 儲存配額上傳（insertUploadInTx）
      { f: "collab/versions.ts", all: 1, inTx: 1 }, // 版本歷史：切版（cutVersionInTx）
      { f: "routes/admin-versions.ts", all: 1, inTx: 1 }, // 版本歷史：站台清除設定（updateVersionSettingsInTx）
      { f: "notes/copy-note.ts", all: 1, inTx: 1 }, // #180 複製
      { f: "notes/move-note.ts", all: 1, inTx: 1 }, // #180 移動
      { f: "routes/admin-password-reset.ts", all: 2, inTx: 2 }, // #286 產生、取消
      { f: "routes/password-reset.ts", all: 1, inTx: 1 }, // #286 完成重設
      { f: "trash/service.ts", all: 3, inTx: 3 }, // #181 移入（trashNotesInTx）、還原（restoreNotesInTx）、永久刪除（purgeTrashedNotesInTx）
      { f: "routes/admin-trash.ts", all: 1, inTx: 1 }, // #181 垃圾桶保留天數（updateTrashSettingsInTx）
      { f: "trash/purge.ts", all: 1, inTx: 1 }, // #181 保留期清理一批（purgeExpiredBatchInTx）
      { f: "folders/service.ts", all: 4, inTx: 4 }, // 資料夾建立（createFolderInTx）、改名／搬移（updateFolderInTx）、刪除（deleteFolderInTx）、放置（placeNoteInTx）
      { f: "notes/editing/write-service.ts", all: 1, inTx: 1 }, // bulk transfer：syncFile 的紀錄交易（recordFileSyncInTx）
      { f: "site-limits/store.ts", all: 1, inTx: 1 }, // #397 站台限制 PATCH（updateSiteLimitsInTx）
      { f: "routes/avatars.ts", all: 4, inTx: 4 }, // 頭貼：上傳（insertAvatarInTx）、重新裁切（updateAvatarDisplayInTx）、選用（selectAvatarInTx）、刪除（deleteAvatarInTx）
      { f: "avatars/oidc-job.ts", all: 1, inTx: 1 }, // 登入帶入 IdP 頭貼的背景工作（replaceOidcAvatarInTx）
    ]);
  });

  it("⑤ 那些 `xInTx(` 呼叫的引數只有識別字／屬性存取／物件字面（無任何呼叫、db、await、閉包）", () => {
    const offenders = ROUTE_FILES.flatMap(f =>
      txCallbacks(code(path.join(SRC, f)))
        .filter(c => c.inTx)
        .flatMap(c => ARG_BANNED.filter(([, re]) => re.test(c.args)).map(([name]) => `${f}: ${name}: ${c.args.replace(/\s+/g, " ").slice(0, 100)}`)),
    );
    expect(offenders).toEqual([]);
  });

  it("notes/tx 有四支新的交易本體檔", () => {
    expect(txFiles.map(rel)).toEqual(
      expect.arrayContaining(["notes/tx/copy.ts", "notes/tx/delete-notes.ts", "notes/tx/move.ts", "notes/tx/write-slug.ts"]),
    );
  });

  // 只有在 `ROUTE_FILES` 以外新增或刪掉 `.transaction(` 才改這張表；`ROUTE_FILES` 裡的交易由 ④ 計數。
  it("⑥ 全 src 的 `.transaction(` 白名單：`ROUTE_FILES` 之外，每個檔的呼叫數凍結（新增交易要先列進這張表）", () => {
    const counts: Record<string, number> = {};
    for (const p of files) {
      const r = rel(p);
      if (ROUTE_FILES.includes(r)) continue;
      const n = [...code(p).matchAll(/\.transaction\s*\(/g)].length;
      if (n > 0) counts[r] = n;
    }
    expect(counts).toEqual({
      "auth/bootstrap.ts": 1,
      "notes/editing/apply.ts": 1,
      "notes/editing/revert.ts": 1,
      "notes/tx/write-slug.ts": 1, // writeSlugInTx 的 savepoint（巢狀 tx.transaction）
      "routes/admin-ai.ts": 2,
      "routes/admin-users.ts": 2, // #247 降級（demoteSiteAdminInTx）＋ #286 停用（disableUserInTx）
      "routes/auth.ts": 2, // 改 handle 的 profile 交易＋ #388 改密碼（changePasswordInTx：bump tv 與換 session 列同交易）
      "routes/oauth.ts": 1,
    });
  });
});
