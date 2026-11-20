/**
 * A path holding a transaction connection must not await a call that borrows another connection from the pool: with pg-pool's
 * defaults (max 10, no acquire timeout) the server would stop answering for good; `createPool` (src/db/pool.ts) sets an acquire
 * timeout, so those requests fail with 500s instead.
 * The main guard is structural: transaction bodies are `*InTx` functions that take only `tx`, plain data and typed test hooks,
 * live in `tx/` directories under `src/`, import neither `Db` nor `DbOrTx` and never touch `deps`, so the bad form can't be written.
 * This file is a supplementary source scan:
 * - Files under `tx/` (comments stripped) must not contain `Db`, `DbOrTx`, `deps.`, `pool` or closure helper names (`DbOrTx` in any
 *   parameter position, or `type Tx = DbOrTx`, would let a route pass the pool in).
 * - `*InTx` may be declared only under `tx/`, as `function` or `const/let/var … =`, exported or not (a route file's own
 *   unexported `*InTx` closure has this shape).
 * - Under `tx/`, every `*InTx` is a `function` declaration whose first parameter is literally `tx: Tx`.
 * - In each file of `ROUTE_FILES`, the whole `.transaction(` callback is one `xInTx(tx, …)` call, and `xInTx` is a name imported
 *   from `"…/tx/…"`; no exceptions (even note deletion is extracted into `deleteNotesInTx`).
 * - That call's arguments are evaluated inside the callback, where the transaction connection is already held, so they may only be
 *   identifiers, property accesses and object literals: no `(` at all (blocks every call, including casts like `Number(x)` and
 *   `String(x)`), no bare `db` identifier (a lazy drizzle query), no `deps.db`, `await`, closures (`=>`, `function`) or closure helper
 *   names. Test hooks are passed as property accesses (`deps.groupTestHook`, `hooks.beforeLinkWrite`). The actual rule is stricter than
 *   the guard: values in the arguments must not be a Promise, thenable or query builder; anything that needs awaiting is awaited
 *   before `.transaction(` and stored as a plain-data local (test hooks excepted, they are functions). That part can't be seen here.
 * Not caught:
 *   - Hiding the pool in another module: calling another module's function from an `*InTx` in `tx/`, re-exporting with
 *     `export { helper as xInTx } from "…"` from a `tx/` file, or an import path that goes through `/tx/` and back out
 *     (`…/tx/../…`). Only literals are scanned; the small-pool behaviour tests (`tx-nested-pool-borrow.test.ts` for `patchSlugInTx`, the small-pool
 *     block in `storage-quota-race.test.ts`) catch it only on the paths they exercise. The last two
 *     are deliberate evasions.
 *   - An unevaluated query builder or Promise passed as an identifier (`const audit = deps.db.select()…;` before `.transaction(`,
 *     not awaited, passed in as `{ …, audit }` and awaited inside `*InTx`): the arguments look clean, and if the type is written as
 *     `PromiseLike<unknown>` the `tx/` scan can't see it either. Left to the "await first, pass plain data" rule and review.
 *   - Calls without parentheses: tagged templates (``sql`…` ``), `new X` without parentheses, getters triggered by property access. No current call site passes a tagged template or `new`.
 *   - Calling the transaction through an alias (`deps.db["transaction"].bind(…)` and the like): the `.transaction(` literal
 *     doesn't match; a deliberate evasion.
 *   - `code()` strips comments literally: a `//` inside a string literal (not `://`) makes the rest of that line look like a
 *     comment and disappear; a deliberate evasion.
 *   - Transactions outside the table (`auth/bootstrap.ts`, `notes/editing/apply.ts` and `revert.ts`, oauth…) are not scanned.
 *   - The whitelist test freezes counts only and does not check the shape of transactions outside `ROUTE_FILES`; the one in
 *     `notes/tx/write-slug.ts` is a nested `tx.transaction` (savepoint) inside `writeSlugInTx`, which the `tx/` rules do scan.
 *   - A value awaited before `.transaction(` and then passed as an argument is legal (no transaction connection is held yet);
 *     this file doesn't look at that part.
 *   - Parenthesis matching ignores strings: a `(` or `)` inside a string misaligns the match, which shows up as a failing
 *     count or argument check, not a silent pass.
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
/** Strips block and line comments so the guard can't be satisfied by its own explanatory text. */
function code(p: string): string {
  return readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const rel = (p: string) => path.relative(SRC, p).split(path.sep).join("/");
const inTxDir = (p: string) => rel(p).split("/").includes("tx");

/** `src[open]` must be `(`: returns the text up to the matching `)`, parentheses excluded. */
function balanced(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open + 1, i);
  }
  throw new Error(`括號不配對：位置 ${open}`);
}

function txCallbacks(src: string): Array<{ inTx: boolean; args: string }> {
  const imported = new Set(
    [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"[^"]*\/tx\/[^"]*"/g)].flatMap(m =>
      m[1]!.split(",").map(x => x.trim().split(/\s+as\s+/).pop()!.trim()).filter(Boolean)),
  );
  // `\s*`: `.transaction (tx => …)` with an extra space must still count toward the per-file count.
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
const ROUTE_FILES = ["routes/notes.ts", "routes/note-content.ts", "routes/note-sharing.ts", "routes/groups.ts", "notes/links.ts", "routes/oidc.ts", "routes/oidc-pending.ts", "routes/admin-auth.ts", "routes/account.ts", "notes/search-index.ts", "notes/search-query.ts", "mcp/tools/create-transfer-token.ts", "mcp/tools/open-notes-as-files.ts", "routes/uploads.ts", "collab/versions.ts", "routes/admin-versions.ts", "notes/copy-note.ts", "notes/move-note.ts", "routes/admin-password-reset.ts", "routes/password-reset.ts", "trash/service.ts", "routes/admin-trash.ts", "trash/purge.ts", "folders/service.ts", "notes/editing/write-service.ts", "site-limits/store.ts", "routes/avatars.ts", "avatars/oidc-job.ts", "routes/tags.ts"];

describe("transaction structure guard (#175)", () => {
  const files = walk(SRC);
  const txFiles = files.filter(inTxDir);

  it("tx/ directories exist and contain the expected transaction body files", () => {
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

  it("tx/ files (comments stripped) contain no Db, DbOrTx, deps., pool or closure helper names", () => {
    const offenders = txFiles.flatMap(p => BANNED.filter(([, re]) => re.test(code(p))).map(([name]) => `${rel(p)}: ${name}`));
    expect(offenders).toEqual([]);
  });

  it("`*InTx` is declared only under tx/ (exported or not)", () => {
    const outside = files
      .filter(p => !inTxDir(p))
      .filter(p => /\bfunction\s+\w+InTx\b|\b(?:const|let|var)\s+\w+InTx\s*=/.test(code(p)))
      .map(rel);
    expect(outside).toEqual([]);
  });

  it("every `*InTx` under tx/ is a function declaration whose first parameter is `tx: Tx`", () => {
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

  it("each ROUTE_FILES transaction callback is entirely `tx => xInTx(tx, ...)` with xInTx imported from tx/ (no exceptions)", () => {
    const perFile = ROUTE_FILES.map(f => {
      const cbs = txCallbacks(code(path.join(SRC, f)));
      return { f, all: cbs.length, inTx: cbs.filter(c => c.inTx).length };
    });
    expect(perFile).toEqual([
      { f: "routes/notes.ts", all: 1, inTx: 1 }, // PATCH (patchSlugInTx)
      { f: "routes/note-content.ts", all: 0, inTx: 0 }, // the routes open no transaction themselves; the write transactions live in notes/editing/apply.ts and revert.ts, frozen by the whitelist test below
      { f: "routes/note-sharing.ts", all: 1, inTx: 1 }, // PUT shares (upsertShareInTx)
      { f: "routes/groups.ts", all: 8, inTx: 8 }, // create group, add member, change member role, remove member, transfer, delete all, change role, delete role
      { f: "notes/links.ts", all: 1, inTx: 1 }, // write links (writeLinksInTx)
      { f: "routes/oidc.ts", all: 3, inTx: 3 }, // login, SSO proof, manual link (the login retry is the same runLogin closure called twice, so only one literal)
      { f: "routes/oidc-pending.ts", all: 1, inTx: 1 }, // password proof (the SSO proof one is in routes/oidc.ts)
      { f: "routes/admin-auth.ts", all: 3, inTx: 3 }, // update sign-in provider, delete sign-in provider, site settings
      { f: "routes/account.ts", all: 4, inTx: 4 }, // register, unlink, accept invite (acceptInviteInTx), set password (setPasswordInTx)
      { f: "notes/search-index.ts", all: 1, inTx: 1 }, // full-text index write
      { f: "notes/search-query.ts", all: 1, inTx: 1 }, // search snapshot read
      { f: "mcp/tools/create-transfer-token.ts", all: 1, inTx: 1 }, // token issuance
      { f: "mcp/tools/open-notes-as-files.ts", all: 1, inTx: 1 }, // bulk transfer token issuance
      { f: "routes/uploads.ts", all: 1, inTx: 1 }, // quota-checked upload (insertUploadInTx)
      { f: "collab/versions.ts", all: 1, inTx: 1 }, // version history: cut a version (cutVersionInTx)
      { f: "routes/admin-versions.ts", all: 1, inTx: 1 }, // version history: site prune settings (updateVersionSettingsInTx)
      { f: "notes/copy-note.ts", all: 1, inTx: 1 }, // copy
      { f: "notes/move-note.ts", all: 1, inTx: 1 }, // move
      { f: "routes/admin-password-reset.ts", all: 2, inTx: 2 }, // create, cancel
      { f: "routes/password-reset.ts", all: 1, inTx: 1 }, // complete the reset
      { f: "trash/service.ts", all: 3, inTx: 3 }, // move to trash (trashNotesInTx), restore (restoreNotesInTx), permanent delete (purgeTrashedNotesInTx)
      { f: "routes/admin-trash.ts", all: 1, inTx: 1 }, // trash retention days (updateTrashSettingsInTx)
      { f: "trash/purge.ts", all: 1, inTx: 1 }, // purge one batch past retention (purgeExpiredBatchInTx)
      { f: "folders/service.ts", all: 4, inTx: 4 }, // create folder (createFolderInTx), rename/move (updateFolderInTx), delete (deleteFolderInTx), place note (placeNoteInTx)
      { f: "notes/editing/write-service.ts", all: 1, inTx: 1 }, // bulk transfer: syncFile's record transaction (recordFileSyncInTx)
      { f: "site-limits/store.ts", all: 1, inTx: 1 }, // site limits PATCH (updateSiteLimitsInTx)
      { f: "routes/avatars.ts", all: 5, inTx: 5 }, // avatars: upload (insertAvatarInTx), re-crop (updateAvatarDisplayInTx), select (selectAvatarInTx), delete (deleteAvatarInTx), manual refetch (refreshOidcAvatarInTx)
      { f: "avatars/oidc-job.ts", all: 1, inTx: 1 }, // background job that imports the IdP avatar after login (replaceOidcAvatarInTx)
      { f: "routes/tags.ts", all: 2, inTx: 2 }, // add a tag to a note (addNoteTagInTx), remove one (removeNoteTagInTx)
    ]);
  });

  it("`xInTx(` call arguments are only identifiers, property accesses and object literals (no calls, db, await or closures)", () => {
    const offenders = ROUTE_FILES.flatMap(f =>
      txCallbacks(code(path.join(SRC, f)))
        .filter(c => c.inTx)
        .flatMap(c => ARG_BANNED.filter(([, re]) => re.test(c.args)).map(([name]) => `${f}: ${name}: ${c.args.replace(/\s+/g, " ").slice(0, 100)}`)),
    );
    expect(offenders).toEqual([]);
  });

  it("notes/tx contains its transaction body files", () => {
    expect(txFiles.map(rel)).toEqual(
      expect.arrayContaining(["notes/tx/copy.ts", "notes/tx/delete-notes.ts", "notes/tx/move.ts", "notes/tx/write-slug.ts"]),
    );
  });

  // Change this table only when a `.transaction(` is added or removed outside `ROUTE_FILES`; transactions inside `ROUTE_FILES` are counted by the per-file test above.
  it("`.transaction(` whitelist across src: outside ROUTE_FILES each file's call count is frozen (a new transaction must be listed here first)", () => {
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
      "notes/tx/write-slug.ts": 1, // savepoint inside writeSlugInTx (nested tx.transaction)
      "routes/admin-ai.ts": 2,
      "routes/admin-users.ts": 2, // demote (demoteSiteAdminInTx) + disable (disableUserInTx)
      "routes/auth.ts": 2, // profile transaction for changing the handle + change password (changePasswordInTx: the tv bump and the session-row swap share one transaction)
      "routes/oauth.ts": 1,
    });
  });
});
