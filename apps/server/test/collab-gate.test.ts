import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { SignJWT } from "jose";
import {
  COLLAB_CLOSE_REVOKED,
  COLLAB_REJECT_CLIENT_OUTDATED,
  COLLAB_REJECT_SERVER_ERROR,
  NOTE_SCHEMA_VERSION,
} from "@knotebook/shared";
import { signCollabToken } from "../src/collab/token.js";
import { waitFor } from "./editing-helpers.js";
import { buildCollabTestApp, COLLAB_TOKEN_INIT, testConfig } from "./helpers.js";

// spec 2026-10-13 site-links §5、§15.2 G1–G3：collab 連線的 note schema 版本閘門。
const PASSWORD = "correct-horse-battery";

describe("#269 舊分頁閘門（onAuthenticate）", () => {
  it("G1：沒帶 noteSchemaVersion 的 token（sv=0）→ 握手以 client-outdated 拒；帶了相符的照常連上；日誌 cause=client-outdated、info 級", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "gate-1@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("gate-1@example.com", PASSWORD);

    const bare = await session.fetch(`/api/notes/${note.id}/collab-token`, { method: "POST" });
    expect(bare.status).toBe(200);
    const bareToken = ((await bare.json()) as { token: string }).token;
    await expect(session.connect(note.id, { tokenOverride: bareToken })).rejects.toThrow(COLLAB_REJECT_CLIENT_OUTDATED);
    const line = ctx.collabLogs.find(l => (l.obj as { cause?: string }).cause === "client-outdated");
    expect(line?.level).toBe("info");
    expect(line?.obj).toMatchObject({ noteId: note.id, userId: owner.id, reason: COLLAB_REJECT_CLIENT_OUTDATED });

    const ok = await session.fetch(`/api/notes/${note.id}/collab-token`, COLLAB_TOKEN_INIT);
    const okToken = ((await ok.json()) as { token: string }).token;
    const client = await session.connect(note.id, { tokenOverride: okToken });
    expect(client.closes).toEqual([]);
  });

  it("G1：sv 比 server 大也拒（!== 不是 <）；body 的 noteSchemaVersion 非整數視為 0", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "gate-2@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("gate-2@example.com", PASSWORD);
    const newer = await signCollabToken(testConfig.appSecret, { noteId: note.id, userId: owner.id, role: "owner", tv: 0, sv: NOTE_SCHEMA_VERSION + 1 });
    await expect(session.connect(note.id, { tokenOverride: newer })).rejects.toThrow(COLLAB_REJECT_CLIENT_OUTDATED);
    const stringBody = await session.fetch(`/api/notes/${note.id}/collab-token`, { method: "POST", body: JSON.stringify({ noteSchemaVersion: String(NOTE_SCHEMA_VERSION) }) });
    expect(stringBody.status).toBe(200);
    const t = ((await stringBody.json()) as { token: string }).token;
    await expect(session.connect(note.id, { tokenOverride: t })).rejects.toThrow(COLLAB_REJECT_CLIENT_OUTDATED);
  });

  it("G1：DB 不可用時仍回 client-outdated（閘門在任何 DB 查詢之前）；對照：sv 相符時同一個壞 DB 回 server-error", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "gate-3@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("gate-3@example.com", PASSWORD);
    const stale = await signCollabToken(testConfig.appSecret, { noteId: note.id, userId: owner.id, role: "owner", tv: 0, sv: 0 });
    const fresh = await signCollabToken(testConfig.appSecret, { noteId: note.id, userId: owner.id, role: "owner", tv: 0, sv: NOTE_SCHEMA_VERSION });
    await ctx.db.execute(sql`alter table notes rename to notes_hidden`);
    try {
      await expect(session.connect(note.id, { tokenOverride: stale })).rejects.toThrow(COLLAB_REJECT_CLIENT_OUTDATED);
      await expect(session.connect(note.id, { tokenOverride: fresh })).rejects.toThrow(COLLAB_REJECT_SERVER_ERROR);
    } finally {
      await ctx.db.execute(sql`alter table notes_hidden rename to notes`);
    }
  });

  it("G2：升級前簽、仍在 TTL 內的 token（沒有 sv 這個 claim）被拒", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "gate-4@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("gate-4@example.com", PASSWORD);
    // 照 `collab/token.ts` 的鍵衍生（sha256(appSecret + ":collab")）手簽一份舊形 token——不經 signCollabToken（它一定帶 sv）。
    const key = createHash("sha256").update(`${testConfig.appSecret}:collab`).digest();
    const legacy = await new SignJWT({ noteId: note.id, role: "owner", tv: 0 })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(owner.id)
      .setIssuedAt()
      .setExpirationTime("120s")
      .sign(key);
    await expect(session.connect(note.id, { tokenOverride: legacy })).rejects.toThrow(COLLAB_REJECT_CLIENT_OUTDATED);
  });

  it("G3（現狀釘）：onTokenSync 重驗不讀 sv——重驗時送 sv=0 的 token，連線照樣活著", async () => {
    const ctx = await buildCollabTestApp();
    const owner = await ctx.createUser({ email: "gate-5@example.com", password: PASSWORD });
    const note = await ctx.createNote(owner.id);
    const session = await ctx.loginAs("gate-5@example.com", PASSWORD);
    let swapped = false;
    const client = await session.connect(note.id, {
      tokenFn: async () => {
        if (swapped) return signCollabToken(testConfig.appSecret, { noteId: note.id, userId: owner.id, role: "owner", tv: 0, sv: 0 });
        const res = await session.fetch(`/api/notes/${note.id}/collab-token`, COLLAB_TOKEN_INIT);
        return ((await res.json()) as { token: string }).token;
      },
    });
    swapped = true;
    const handle = [...ctx.collab.connectionsOf(owner.id)][0]!;
    let fired = false;
    ctx.collab.onNextTokenSync(handle, () => {
      fired = true;
    });
    handle.requestToken();
    await waitFor("重驗確實跑過", 3_000, () => fired);
    await new Promise(r => setTimeout(r, 300));
    expect(client.closes.some(c => c.reason === COLLAB_CLOSE_REVOKED)).toBe(false);
    expect([...ctx.collab.connectionsOf(owner.id)]).toHaveLength(1);
  });
});
