/**
 * #200 spec §4.2、§4.3a、§4.6：簽發交易本體（`auth/tx/issue-transfer-token.ts`）與過期清理。直接呼叫交易本體——
 * MCP 那層（scope、角色、扣桶、錯誤映射、測試縫）在 `mcp-transfer*.test.ts`。
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { hashToken } from "../src/auth/api-token.js";
import { deleteExpiredTransferTokens } from "../src/auth/transfer-cleanup.js";
import {
  MAX_PENDING_UPLOAD_TOKENS,
  TRANSFER_TOKENS_EXPIRY_CHK,
  TRANSFER_TOKENS_NOTE_FK,
  generateTransferToken,
  type TransferPurpose,
} from "../src/auth/transfer-token.js";
import { issueTransferTokenInTx } from "../src/auth/tx/issue-transfer-token.js";
import { apiTokens, transferTokens } from "../src/db/schema.js";
import { checkViolationConstraint, pgErrorSummary } from "../src/db/pg-errors.js";
import type { Db } from "../src/db/index.js";
import { freshDb } from "./helpers.js";
import { seedNote } from "./group-helpers.js";
import { expireToken, issueDirect, ownerWithPat } from "./transfer-helpers.js";

function issue(db: Db, parentTokenId: string, noteId: string, purpose: TransferPurpose) {
  return db.transaction(tx =>
    issueTransferTokenInTx(tx, {
      tokenHash: hashToken(generateTransferToken()),
      parentTokenId,
      noteId,
      purpose,
      maxPendingUploads: MAX_PENDING_UPLOAD_TOKENS,
    }),
  );
}

/** DB 的 `now()`（epoch 毫秒，可能帶小數）。每次是獨立交易，所以是「這一刻」的時間。 */
async function dbNowMs(db: Db): Promise<number> {
  const { rows } = await db.$client.query<{ ms: string }>("select extract(epoch from now()) * 1000 as ms");
  return Number(rows[0]!.ms);
}

describe("issueTransferTokenInTx（spec §4.2）", () => {
  it("簽出：一列、noteId 是 DB 小寫形（輸入大寫也一樣）、expiresAt ≈ now＋10 分", async () => {
    const { db } = await freshDb();
    const o = await ownerWithPat(db);
    // 上下界都取 DB 時鐘（與 `expires_at` 同一個 `now()`），不受 WSL 與 Windows 主機時鐘漂移影響。
    const before = await dbNowMs(db);
    const r = await issue(db, o.patId, o.noteId.toUpperCase(), "upload");
    const after = await dbNowMs(db);
    expect(r.kind).toBe("issued");
    if (r.kind !== "issued") return;
    expect(r.noteId).toBe(o.noteId);
    // ±1 ms：node-postgres 把微秒截成毫秒，DB 端 epoch 毫秒帶小數。
    expect(r.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 10 * 60_000 - 1);
    expect(r.expiresAt.getTime()).toBeLessThanOrEqual(after + 10 * 60_000 + 1);
    expect(await db.select().from(transferTokens)).toHaveLength(1);
  });

  it("母憑證不存在 → revoked，零列", async () => {
    const { db } = await freshDb();
    const o = await ownerWithPat(db);
    expect(await issue(db, randomUUID(), o.noteId, "download")).toEqual({ kind: "revoked" });
    expect(await db.select().from(transferTokens)).toHaveLength(0);
  });

  it("母憑證只剩 60 秒 → expiresAt 截在母憑證的 access_expires_at（least）", async () => {
    const { db } = await freshDb();
    const o = await ownerWithPat(db);
    const parentExp = new Date(Date.now() + 60_000);
    await db.update(apiTokens).set({ accessExpiresAt: parentExp }).where(eq(apiTokens.id, o.patId));
    const r = await issue(db, o.patId, o.noteId, "download");
    expect(r.kind === "issued" && r.expiresAt.getTime()).toBe(parentExp.getTime());
  });

  it("母憑證已過期 → INSERT 撞 transfer_tokens_expiry_chk（23514），呼叫端據此判 revoked", async () => {
    const { db } = await freshDb();
    const o = await ownerWithPat(db);
    // DB 時鐘、留 1 分鐘餘裕（不用 `Date.now()`：WSL 的 pg 與 Windows 主機時鐘可能漂移數秒）。
    await db.update(apiTokens).set({ accessExpiresAt: sql`now() - interval '1 minute'` }).where(eq(apiTokens.id, o.patId));
    const err = await issue(db, o.patId, o.noteId, "upload").then(() => null, (e: unknown) => e);
    expect(checkViolationConstraint(err)).toBe(TRANSFER_TOKENS_EXPIRY_CHK);
  });

  it("筆記不存在 → 23503，約束名＝TRANSFER_TOKENS_NOTE_FK（呼叫端據此判 note_gone）", async () => {
    const { db } = await freshDb();
    const o = await ownerWithPat(db);
    const err = await issue(db, o.patId, randomUUID(), "upload").then(() => null, (e: unknown) => e);
    expect(pgErrorSummary(err)).toEqual({ code: "23503", constraint: TRANSFER_TOKENS_NOTE_FK });
  });
});

describe("未消費 upload token 上限（spec §4.3a）", () => {
  it("同一母憑證 5 支未消費 upload 之後第 6 支 too_many_pending；download 不受限；另一支母憑證不受影響", async () => {
    const { db } = await freshDb();
    const o = await ownerWithPat(db);
    for (let i = 0; i < 5; i++) expect((await issue(db, o.patId, o.noteId, "upload")).kind).toBe("issued");
    expect(await issue(db, o.patId, o.noteId, "upload")).toEqual({ kind: "too_many_pending" });
    expect((await issue(db, o.patId, o.noteId, "download")).kind).toBe("issued");
    const other = await ownerWithPat(db);
    expect((await issue(db, other.patId, other.noteId, "upload")).kind).toBe("issued");
  });

  it("同一母憑證先簽 5 支 download，upload 照樣簽得出——計數只算 purpose='upload'", async () => {
    const { db } = await freshDb();
    const o = await ownerWithPat(db);
    for (let i = 0; i < 5; i++) expect((await issue(db, o.patId, o.noteId, "download")).kind).toBe("issued");
    expect((await issue(db, o.patId, o.noteId, "upload")).kind).toBe("issued");
  });

  it("RF4：5 支分散在 5 篇不同筆記也算滿——上限是每支母憑證，不是每篇", async () => {
    const { db } = await freshDb();
    const o = await ownerWithPat(db);
    for (let i = 0; i < 5; i++) {
      const n = await seedNote(db, { ownerId: o.userId });
      expect((await issue(db, o.patId, n.id, "upload")).kind).toBe("issued");
    }
    expect(await issue(db, o.patId, o.noteId, "upload")).toEqual({ kind: "too_many_pending" });
  });

  it("用掉一支或過期一支就騰出一個名額", async () => {
    const { db } = await freshDb();
    const o = await ownerWithPat(db);
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await issueDirect(db, o.patId, o.noteId, "upload")).id);
    await db.update(transferTokens).set({ consumedAt: sql`now()` }).where(eq(transferTokens.id, ids[0]!));
    expect((await issue(db, o.patId, o.noteId, "upload")).kind).toBe("issued");
    expect(await issue(db, o.patId, o.noteId, "upload")).toEqual({ kind: "too_many_pending" });
    await expireToken(db, ids[1]!);
    expect((await issue(db, o.patId, o.noteId, "upload")).kind).toBe("issued");
  });
});

describe("deleteExpiredTransferTokens（spec §4.6）", () => {
  it("只刪已過期的列", async () => {
    const { db } = await freshDb();
    const o = await ownerWithPat(db);
    const live = await issueDirect(db, o.patId, o.noteId, "download");
    const dead = await issueDirect(db, o.patId, o.noteId, "download");
    await expireToken(db, dead.id);
    await deleteExpiredTransferTokens(db);
    const ids = (await db.select({ id: transferTokens.id }).from(transferTokens)).map(r => r.id);
    expect(ids).toEqual([live.id]);
  });

  it("skip locked：別的交易鎖著的過期列被跳過，清理不等鎖、其餘照刪", async () => {
    const { db, pool } = await freshDb();
    const o = await ownerWithPat(db);
    const held = await issueDirect(db, o.patId, o.noteId, "download");
    const other = await issueDirect(db, o.patId, o.noteId, "download");
    await expireToken(db, held.id);
    await expireToken(db, other.id);
    const holder = await pool.connect();
    try {
      await holder.query("begin");
      await holder.query("select id from transfer_tokens where id = $1 for update", [held.id]);
      const outcome = await Promise.race([
        deleteExpiredTransferTokens(db).then(() => "done" as const),
        new Promise<"blocked">(resolve => setTimeout(() => resolve("blocked"), 3_000)),
      ]);
      expect(outcome).toBe("done");
      const ids = (await db.select({ id: transferTokens.id }).from(transferTokens)).map(r => r.id);
      expect(ids).toEqual([held.id]);
    } finally {
      await holder.query("rollback");
      holder.release();
    }
  });
});
