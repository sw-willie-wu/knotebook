/**
 * #397：筆記大小上限、上傳大小上限、`/api/auth/config` 都現讀 `siteLimits`；
 * `watchNotesOverCap` 在 `noteMaxBytes` 變動時重記超過上限的筆記。actor 一律是本測試在同一個 DB 建的 admin。
 */
import { describe, expect, it, vi } from "vitest";
import { SESSION_COOKIE } from "@knotebook/shared";
import { logNotesOverCap, watchNotesOverCap } from "../src/notes/note-size-startup.js";
import { buildCollabTestApp, buildTestApp, signTestSession } from "./helpers.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { seedNote, seedUser } from "./group-helpers.js";
import { seedMd } from "./bulk-transfer-helpers.js";

const MIB = 1_048_576;
const BOUNDARY = "sizesBoundary";
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const paras = (n: number, tag = "p") => Array.from({ length: n }, (_, k) => `${tag} ${k} lorem ipsum dolor sit amet consectetur adipiscing elit`).join("\n\n");

function pngBody(totalBytes: number): Buffer {
  const data = Buffer.concat([PNG_HEAD, Buffer.alloc(totalBytes - PNG_HEAD.length, 0x41)]);
  return Buffer.concat([
    Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`, "utf-8"),
    data,
    Buffer.from(`\r\n--${BOUNDARY}--\r\n`, "utf-8"),
  ]);
}

describe("noteMaxBytes 立即生效", () => {
  it("update 之後下一次會長過新上限的寫入 413（limitBytes＝新值）；/api/auth/config 同步", async () => {
    const ctx = await buildCollabTestApp({});
    const admin = await seedUser(ctx.db, { isAdmin: true });
    const u = await seedUser(ctx.db);
    const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
    const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "N" });
    const edit = (markdown: string) => ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(pat.token), payload: { op: "append", markdown } });
    // 直接塞一篇狀態超過 1 MiB 的筆記（約 270 位元組／段）；預設上限 5 MiB 下還能寫。
    await seedMd(ctx.db, note.id, paras(5000));
    expect((await edit(paras(2, "ok"))).statusCode).toBe(201);

    await ctx.siteLimits.update(admin.id, { noteMaxBytes: MIB });
    expect(ctx.siteLimits.get("noteMaxBytes")).toBe(MIB);
    const after = await edit(paras(20, "more"));
    expect(after.statusCode).toBe(413);
    expect(after.json().error).toMatchObject({ code: "note_too_large", limitBytes: MIB });

    const cfg = await ctx.app.inject({ method: "GET", url: "/api/auth/config" });
    expect(cfg.json().noteMaxBytes).toBe(MIB);
    await ctx.destroy();
  });
});

describe("uploadMaxBytes 立即生效", () => {
  it("update 之後 1.5 MiB 上傳 413 file_too_large、0.9 MiB 成功；/api/auth/config 的 maxUploadBytes 同步", async () => {
    const ctx = await buildTestApp();
    const admin = await seedUser(ctx.db, { isAdmin: true });
    const owner = await seedUser(ctx.db);
    const note = await seedNote(ctx.db, { ownerId: owner.id }, { title: "U" });
    const cookie = `${SESSION_COOKIE}=${await signTestSession({ userId: owner.id, tv: 0 })}`;
    const post = (bytes: number) =>
      ctx.app.inject({
        method: "POST",
        url: `/api/notes/${note.id}/uploads`,
        payload: pngBody(bytes),
        headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}`, cookie },
      });

    // 預設 10 MiB：1.5 MiB 收得下。
    expect((await post(Math.round(1.5 * MIB))).statusCode).toBe(201);

    await ctx.siteLimits.update(admin.id, { uploadMaxBytes: MIB });
    const tooBig = await post(Math.round(1.5 * MIB));
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json().error.code).toBe("file_too_large");
    expect((await post(Math.round(0.9 * MIB))).statusCode).toBe(201);

    const cfg = await ctx.app.inject({ method: "GET", url: "/api/auth/config" });
    expect(cfg.json().maxUploadBytes).toBe(MIB);
  });
});

describe("watchNotesOverCap", () => {
  it("noteMaxBytes 變動時重記超過上限的筆記（limitBytes＝新值）；unsubscribe 之後不再記", async () => {
    const ctx = await buildCollabTestApp({});
    const admin = await seedUser(ctx.db, { isAdmin: true });
    const lines: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const log = {
      info: (obj: object, msg: string) => void lines.push({ obj: obj as Record<string, unknown>, msg }),
      warn: (obj: object, msg: string) => void lines.push({ obj: obj as Record<string, unknown>, msg }),
      error: (obj: object, msg: string) => void lines.push({ obj: obj as Record<string, unknown>, msg }),
    };
    const unsubscribe = watchNotesOverCap(ctx.siteLimits, ctx.db, log);
    try {
      await ctx.siteLimits.update(admin.id, { noteMaxBytes: MIB });
      await vi.waitFor(() => expect(lines.some(l => l.obj.limitBytes === MIB)).toBe(true));
    } finally {
      unsubscribe();
    }
    const n = lines.length;
    await ctx.siteLimits.update(admin.id, { noteMaxBytes: 2 * MIB });
    await new Promise(r => setTimeout(r, 200));
    expect(lines.length).toBe(n);
    // 直接呼叫仍可用（開機那次）。
    await logNotesOverCap(ctx.db, ctx.siteLimits.get("noteMaxBytes"), log);
    expect(lines.at(-1)!.obj.limitBytes).toBe(2 * MIB);
    await ctx.destroy();
  });
});
