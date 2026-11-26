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

describe("noteMaxBytes takes effect immediately", () => {
  it("after update, the next write that would grow past the new limit is 413 (limitBytes = new value); /api/auth/config follows", async () => {
    const ctx = await buildCollabTestApp({});
    const admin = await seedUser(ctx.db, { isAdmin: true });
    const u = await seedUser(ctx.db);
    const pat = await seedTokenForUser(ctx.db, u.id, "notes:read notes:write");
    const note = await seedNote(ctx.db, { ownerId: u.id }, { title: "N" });
    const edit = (markdown: string) => ctx.app.inject({ method: "POST", url: `/api/notes/${note.id}/edits`, headers: bearer(pat.token), payload: { op: "append", markdown } });
    // Insert a note whose state exceeds 1 MiB directly (about 270 bytes per paragraph); it still fits under the default 5 MiB cap.
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

describe("uploadMaxBytes takes effect immediately", () => {
  it("after update, a 1.5 MiB upload is 413 file_too_large and 0.9 MiB succeeds; maxUploadBytes in /api/auth/config follows", async () => {
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

describe("uploadMediaMaxMib is wired into /api/auth/config in bytes", () => {
  it("defaults to 100 MiB and follows an update; the stored MiB value round-trips at both ends of the range", async () => {
    const ctx = await buildTestApp();
    const admin = await seedUser(ctx.db, { isAdmin: true });
    const config = async () => (await ctx.app.inject({ method: "GET", url: "/api/auth/config" })).json();
    expect((await config()).maxMediaUploadBytes).toBe(104_857_600);

    await ctx.siteLimits.update(admin.id, { uploadMediaMaxMib: 10 });
    expect((await config()).maxMediaUploadBytes).toBe(10 * MIB);

    await ctx.siteLimits.update(admin.id, { uploadMediaMaxMib: 2048 });
    expect((await config()).maxMediaUploadBytes).toBe(2048 * MIB);

    await ctx.siteLimits.update(admin.id, { uploadMediaMaxMib: 1_048_576 });
    expect(ctx.siteLimits.get("uploadMediaMaxMib")).toBe(1_048_576);
    expect((await config()).maxMediaUploadBytes).toBe(1_048_576 * MIB);
  });
});

describe("watchNotesOverCap", () => {
  it("changing noteMaxBytes re-logs notes over the limit (limitBytes = new value); no more logging after unsubscribe", async () => {
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
    // A direct call still works (the boot-time one).
    await logNotesOverCap(ctx.db, ctx.siteLimits.get("noteMaxBytes"), log);
    expect(lines.at(-1)!.obj.limitBytes).toBe(2 * MIB);
    await ctx.destroy();
  });
});
