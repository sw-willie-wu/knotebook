/**
 * #175 S14 結構性守衛（spec §4.4 S14、§6 交易表 T1–T15）：**任何持有交易連線的路徑，不得在交易內 await 會向
 * pool 借連線的呼叫**。違反時不是 500，而是整台 server 永久不回應（pg-pool 預設 max 10、永不逾時；gate r3
 * A-10／A-11、r4 A-10 實跑）。主守衛是結構：交易本體是只收 `tx`／純資料／型別明示測試縫的 `*InTx`，放在
 * `src/**​/tx/` 目錄、不 import `Db`／`DbOrTx`、不碰 `deps`——錯的寫法寫不出來。本檔是**輔助**的源碼掃描：
 * ① `tx/` 目錄裡的檔（剝掉註解後）不得出現 `Db`、`DbOrTx`、`deps.`、`pool` 與閉包 helper 名（`DbOrTx` 放在任何
 *    參數位置、或 `type Tx = DbOrTx` 都會讓路由把 pool 傳進來——gate r2 B-I1 的 X4／X7）；
 * ② `*InTx` 只准宣告在 `tx/` 目錄——`function` 與 `const／let／var … =` 都算，**不論有沒有 export**（路由檔自宣告、
 *    不 export 的 `*InTx` 閉包是 X10 形）；
 * ③ `tx/` 裡的 `*InTx` 一律以 `function` 宣告，第一個參數字面上是 `tx: Tx`；
 * ④ `ROUTE_FILES` 裡的檔（#175 三支＋#187 的 `routes/oidc.ts`、`routes/oidc-pending.ts`、`routes/admin-auth.ts`＋#93 的 `notes/search-index.ts`、`notes/search-query.ts`＋#200 的 `mcp/tools/create-transfer-token.ts`＋儲存配額的 `routes/uploads.ts`），`.transaction(` 的 callback **整段**就是一個 `xInTx(tx, …)` 呼叫，而且 `xInTx`
 *    必須是以 `import { … } from "…/tx/…"` 引進的名字——無例外（PR2 起 T14 也抽成 `deleteNotesInTx`）；
 * ⑤ 那個呼叫的**引數**（callback 內求值、此時已持有交易連線）只准是識別字、屬性存取與物件字面：**不得有任何 `(`**
 *    （擋住所有以括號形式的呼叫，含 `Number(x)`、`String(x)` 這種轉型）、不得有裸 `db` 識別字（drizzle 的 lazy query）、
 *    `deps.db`、`await`、閉包（`=>`、`function`）與閉包 helper 名。測試縫一律以屬性存取傳入（`deps.groupTestHook`、
 *    `hooks.beforeLinkWrite`）。規則本身比守衛嚴（與 Global Constraints 的 S14 條同一個意思）：引數裡的值不得是 Promise、
 *    thenable 或 query builder——要 await 的，在 `.transaction(` 之前 await 完、存成純資料的區域變數（測試縫除外，它是
 *    函式；gate r3 B-M4、r4 B-N1）；後者本檔看不出來，見下。
 * ⚠ 守不到（誠實；gate r1 B-I1／B-N1、r2 B-I1）：
 *   - 把 pool 藏進另一個模組——從 `*InTx`（tx/ 檔內）呼叫別的模組的函式、tx/ 檔以 `export { helper as xInTx } from "…"`
 *     重新匯出（Y1r）、或 import 路徑寫成經過 `/tx/` 再跳出（`…/tx/../…`，Y5r）——只掃字面；行為面只有 `s14-pool.test.ts`
 *     接 T1 一形。後兩者屬刻意規避。
 *   - 以識別字傳入的**未求值** query builder 或 Promise（`const audit = deps.db.select()…;` 放在 `.transaction(` 之前、
 *     不 await，再以 `{ …, audit }` 傳進去、`*InTx` 在交易內 await 它——Y2）：引數字面乾淨，本檔看不到；型別寫成
 *     `PromiseLike<unknown>` 的話 ① 也看不到。靠 Global Constraints 的「await 完的純資料」規則與 review 守。
 *   - 沒有括號的呼叫：tagged template（``sql`…` ``，Y4b）、不加括號的 `new X`（Y7）、屬性存取觸發的 getter——⑤ 看不到；
 *     八個生產呼叫點都沒有這些形。
 *   - 以別名呼叫交易（`deps.db["transaction"].bind(…)` 之類，X5）——`.transaction(` 字面掃不到；屬刻意規避。
 *   - `code()` 剝註解是字面的：字串字面值裡出現 `//`（不是 `://`）時，同一行之後的程式碼會被當成註解剝掉而看不到（G10）；
 *     屬刻意規避。
 *   - 表外的交易（`auth/bootstrap.ts`、`notes/editing/apply.ts`／`revert.ts`、oauth…）不掃。
 *   - ⑥ 只凍結數量，不檢查範圍外交易的形——tx/ 以外那 9 處由 PR1 Task 10 review 逐一讀過、皆合規；表上第 10 處
 *     `notes/tx/write-slug.ts` 是 `writeSlugInTx` 內的巢狀 `tx.transaction`（savepoint），本身在 tx/ 裡受 ①③ 掃。
 *   - 在 `.transaction(` **之前** await 完的值當引數傳進去是合法的（那時還沒借交易連線），本檔不管那一段。
 *   - 括號配對不理會字串：字串裡的 `(`／`)` 會讓配對錯位——錯位的結果是 ④ 的計數紅或 ⑤ 紅，不會靜默放行
 *     （gate r2 B R3 的 X8／X9 實測）。
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
/** 剝掉區塊與行註解（守衛不得被自己的說明文字餵飽——memory knotebook-ui-chrome 的 toast 守衛教訓）。 */
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
  // `\s*`：`.transaction (tx => …)` 多一個空白也要算進 ④ 的計數（Task 10 review M1 的 X5d 形）。
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
const ROUTE_FILES = ["routes/notes.ts", "routes/groups.ts", "notes/links.ts", "routes/oidc.ts", "routes/oidc-pending.ts", "routes/admin-auth.ts", "routes/account.ts", "notes/search-index.ts", "notes/search-query.ts", "mcp/tools/create-transfer-token.ts", "routes/uploads.ts"];

describe("S14 結構性守衛（#175 §4.4）", () => {
  const files = walk(SRC);
  const txFiles = files.filter(inTxDir);

  it("tx/ 目錄存在且至少有 PR1 的七支交易本體檔", () => {
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
        "auth/tx/legacy-oidc-env.ts",
        "auth/tx/link-identity.ts",
        "auth/tx/oidc-login.ts",
        "auth/tx/admin-auth-providers.ts",
        "auth/tx/register.ts",
        "auth/tx/identities.ts",
        "auth/tx/admin-site-settings.ts",
        "auth/tx/issue-transfer-token.ts",
        "uploads/tx/insert-upload.ts",
        "storage/tx/quota.ts",
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
      { f: "routes/notes.ts", all: 5, inTx: 5 }, // T1 PATCH、T2 PUT shares、T3 move、T4 copy、T14 DELETE（PR2 抽出）
      { f: "routes/groups.ts", all: 8, inTx: 8 }, // T8 建群組、T9 加人、T10 換角色、T11 移人、T6 轉移、T7 全刪、T12 改角色、T13 刪角色（T5 PR4 退場）
      { f: "notes/links.ts", all: 1, inTx: 1 }, // T15
      { f: "routes/oidc.ts", all: 3, inTx: 3 }, // A1 登入、A2 SSO 證明、P3 手動連結（#187；A1 重投是同一個 runLogin 閉包呼叫兩次，字面只有一處）
      { f: "routes/oidc-pending.ts", all: 1, inTx: 1 }, // A2 密碼證明（#187 §7.5.4；SSO 證明那一處在 routes/oidc.ts）
      { f: "routes/admin-auth.ts", all: 3, inTx: 3 }, // B1 改、B2 刪登入服務（PR2）、P4 站台設定（PR3）
      { f: "routes/account.ts", all: 2, inTx: 2 }, // P1 註冊（#187 PR3 §9.1）、P2 解除連結（§8.2）
      { f: "notes/search-index.ts", all: 1, inTx: 1 }, // 全文索引寫入（#93 §5.2）
      { f: "notes/search-query.ts", all: 1, inTx: 1 }, // 搜尋快照讀取（#93 §7.3）
      { f: "mcp/tools/create-transfer-token.ts", all: 1, inTx: 1 }, // #200 簽發（spec §4.2）
      { f: "routes/uploads.ts", all: 1, inTx: 1 }, // 儲存配額 U-tx（insertUploadInTx）
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

  it("PR2：notes/tx 有四支新的交易本體檔", () => {
    expect(txFiles.map(rel)).toEqual(
      expect.arrayContaining(["notes/tx/copy.ts", "notes/tx/delete-notes.ts", "notes/tx/move.ts", "notes/tx/write-slug.ts"]),
    );
  });

  // 只有在 `ROUTE_FILES` 以外新增或刪掉 `.transaction(` 才改這張表；`ROUTE_FILES` 裡的交易由 ④ 計數。
  it("⑥ 全 src 的 `.transaction(` 白名單：`ROUTE_FILES` 之外，每個檔的呼叫數凍結（新增交易要先列進 spec §6 交易表或這張表）", () => {
    const counts: Record<string, number> = {};
    for (const p of files) {
      const r = rel(p);
      if (ROUTE_FILES.includes(r)) continue;
      const n = [...code(p).matchAll(/\.transaction\s*\(/g)].length;
      if (n > 0) counts[r] = n;
    }
    expect(counts).toEqual({
      "auth/bootstrap.ts": 1,
      "auth/legacy-oidc-env.ts": 1,
      "notes/editing/apply.ts": 1,
      "notes/editing/revert.ts": 1,
      "notes/tx/write-slug.ts": 1, // writeSlugInTx 的 savepoint（巢狀 tx.transaction）
      "routes/admin-ai.ts": 2,
      "routes/admin-users.ts": 1,
      "routes/auth.ts": 1,
      "routes/oauth.ts": 1,
    });
  });
});
