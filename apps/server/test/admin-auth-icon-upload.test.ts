import { describe, expect, it } from "vitest";
import { Client } from "pg";
import { sql } from "drizzle-orm";
import { cookieOf, seedUser, waitForBlockedOrSettled } from "./group-helpers.js";
import { bearer, seedTokenForUser } from "./editing-helpers.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";
import { adminApp, captureLogs, providerRow } from "./helpers/admin-auth.js";
import {
  GIF_BYTES, ICON_MARKER, JPEG_BYTES, TEXT_BYTES, WEBP_BYTES,
  expectNoIconBytes, iconFile, multipartBody, pngBytes, putIcon,
} from "./helpers/provider-icon.js";

const one = (data: Buffer, opts?: { filename?: string; contentType?: string }) => multipartBody([iconFile(data, opts)]);

describe("PUT /api/admin/auth/providers/:id/icon", () => {
  it("not signed in 401, regular user (real session) 403, admin's valid PAT 401; DB unchanged", async () => {
    const { app, db, admin } = await adminApp();
    const p = await seedAuthProvider(db, { issuerUrl: "https://a.example" });
    const before = await providerRow(db, p.id);
    expect((await putIcon(app, p.id, one(pngBytes()))).statusCode).toBe(401);
    const plain = await seedUser(db);
    const asPlain = await putIcon(app, p.id, one(pngBytes()), { cookies: await cookieOf(plain.id) });
    expect(asPlain.statusCode).toBe(403);
    expect(asPlain.json().error.code).toBe("forbidden");
    const { token } = await seedTokenForUser(db, admin.id);
    expect((await putIcon(app, p.id, one(pngBytes()), { headers: bearer(token) })).statusCode).toBe(401);
    expect(await providerRow(db, p.id)).toEqual(before);
  });

  it("262145 bytes -> 413 file_too_large (The image can be at most 256 KB.), DB unchanged; 262144 bytes -> 200, kind upload, version +1, bytes stored verbatim", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedAuthProvider(db, { issuerUrl: "https://a.example" });
    const before = await providerRow(db, p.id);
    const tooBig = await putIcon(app, p.id, one(pngBytes(262145)), { cookies });
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json().error).toEqual({ code: "file_too_large", message: "The image can be at most 256 KB." });
    expect(await providerRow(db, p.id)).toEqual(before);

    const exact = pngBytes(262144);
    const ok = await putIcon(app, p.id, one(exact), { cookies });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: p.id, iconKind: "upload", icon: { type: "upload", url: `/api/auth/providers/${p.id}/icon?v=1` }, autoCreateEnabled: true });
    expectNoIconBytes(ok.body);
    const row = await providerRow(db, p.id);
    expect(row).toMatchObject({ iconKind: "upload", iconMime: "image/png", iconVersion: 1, configVersion: before!.configVersion, enabled: before!.enabled });
    expect(Buffer.compare(row!.iconData!, exact)).toBe(0);

    // PUT again: the later one wins on both image and version (the PUT || PUT serial shape).
    const again = await putIcon(app, p.id, one(JPEG_BYTES, { filename: "b.jpg", contentType: "image/jpeg" }), { cookies });
    expect(again.json().icon).toEqual({ type: "upload", url: `/api/auth/providers/${p.id}/icon?v=2` });
    expect(await providerRow(db, p.id)).toMatchObject({ iconMime: "image/jpeg", iconVersion: 2 });
  });

  it("magic bytes decide: GIF and plain text claiming .png/image/png -> 415 (Only PNG, JPEG and WebP images are accepted.); JPEG claiming .gif/image/gif -> 200 image/jpeg; WebP -> 200", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedAuthProvider(db, { issuerUrl: "https://a.example" });
    const before = await providerRow(db, p.id);
    const svgBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="16" height="16"/></svg>', "utf-8");
    for (const [label, data] of [["gif", GIF_BYTES], ["svg", svgBytes], ["text", TEXT_BYTES]] as const) {
      const res = await putIcon(app, p.id, one(data, { filename: "x.png", contentType: "image/png" }), { cookies });
      expect(res.statusCode, label).toBe(415);
      expect(res.json().error, label).toEqual({ code: "unsupported_media_type", message: "Only PNG, JPEG and WebP images are accepted." });
    }
    expect(await providerRow(db, p.id)).toEqual(before);
    const jpeg = await putIcon(app, p.id, one(JPEG_BYTES, { filename: "x.gif", contentType: "image/gif" }), { cookies });
    expect(jpeg.statusCode).toBe(200);
    expect((await providerRow(db, p.id))!.iconMime).toBe("image/jpeg");
    const webp = await putIcon(app, p.id, one(WEBP_BYTES, { filename: "x.bin", contentType: "application/octet-stream" }), { cookies });
    expect(webp.statusCode).toBe(200);
    expect((await providerRow(db, p.id))!.iconMime).toBe("image/webp");
  });

  it("application/json -> 415; cross-origin Origin -> 403 (Origin doesn't match Host); same-origin Origin allowed; no file part -> 400 (The upload has no file.); malformed multipart -> 400 (The upload isn't valid multipart/form-data.); non-UUID/nonexistent -> 404", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedAuthProvider(db, { issuerUrl: "https://a.example" });
    const json = await app.inject({ method: "PUT", url: `/api/admin/auth/providers/${p.id}/icon`, cookies, payload: { file: "x" } });
    expect(json.statusCode).toBe(415);
    expect(json.json().error.code).toBe("unsupported_media_type");
    const cross = await putIcon(app, p.id, one(pngBytes()), { cookies, headers: { origin: "https://evil.example" } });
    expect(cross.statusCode).toBe(403);
    expect(cross.json().error).toEqual({ code: "forbidden", message: "Origin check failed: the request's Origin doesn't match its Host." });
    expect((await putIcon(app, p.id, one(pngBytes()), { cookies, headers: { origin: "http://localhost:80" } })).statusCode).toBe(200);
    const noFile = await putIcon(app, p.id, multipartBody([{ name: "note", data: "x" }]), { cookies });
    expect(noFile.statusCode).toBe(400);
    expect(noFile.json().error).toEqual({ code: "invalid_body", message: "The upload has no file." });
    const broken = await app.inject({
      method: "PUT",
      url: `/api/admin/auth/providers/${p.id}/icon`,
      cookies,
      payload: one(pngBytes()),
      headers: { "content-type": "multipart/form-data" },
    });
    expect(broken.statusCode).toBe(400);
    expect(broken.json().error).toEqual({ code: "invalid_body", message: "The upload isn't valid multipart/form-data." });
    for (const id of ["not-a-uuid", "99999999-9999-4999-8999-999999999999"]) {
      const res = await putIcon(app, id, one(pngBytes()), { cookies });
      expect(res.statusCode, id).toBe(404);
      expect(res.json().error, id).toEqual({ code: "not_found", message: "No sign-in service with that id." });
    }
  });

  it("only the first of two file parts counts: GIF then PNG -> 415; PNG then GIF -> 200 and the first is stored", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedAuthProvider(db, { issuerUrl: "https://a.example" });
    const gifFirst = multipartBody([iconFile(GIF_BYTES, { filename: "a.gif" }), iconFile(pngBytes(), { filename: "b.png" })]);
    expect((await putIcon(app, p.id, gifFirst, { cookies })).statusCode).toBe(415);
    const first = pngBytes(80);
    const pngFirst = multipartBody([{ name: "anything", data: "field-before" }, iconFile(first), iconFile(GIF_BYTES, { filename: "b.gif" })]);
    expect((await putIcon(app, p.id, pngFirst, { cookies })).statusCode).toBe(200);
    expect(Buffer.compare((await providerRow(db, p.id))!.iconData!, first)).toBe(0);
  });

  it("PUT || DELETE: holder (acting as another admin's delete) holds the row lock -> PUT really blocks on the UPDATE -> holder deletes the row and commits -> PUT 404, no row", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedAuthProvider(db, { issuerUrl: "https://a.example", enabled: false });
    const [{ current_database: dbName }] = (await db.execute<{ current_database: string }>(sql`select current_database()`)).rows;
    const dsn = new URL(process.env.TEST_DATABASE_URL!);
    dsn.pathname = `/${dbName}`;
    const holder = new Client({ connectionString: dsn.toString() });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from auth_providers where id = $1 for update", [p.id]);
      const inFlight = putIcon(app, p.id, one(pngBytes()), { cookies });
      expect(await waitForBlockedOrSettled(db.$client, inFlight)).toBe("blocked");
      await holder.query("delete from auth_providers where id = $1", [p.id]);
      await holder.query("commit");
      const res = await inFlight;
      expect(res.statusCode).toBe(404);
      expect(res.json().error.code).toBe("not_found");
    } finally {
      await holder.end();
    }
    expect(await providerRow(db, p.id)).toBeUndefined();
  });

  it("unexpected DB error via redactDbError: 500, log has no image bytes (params carry the whole image)", async () => {
    const logs = captureLogs();
    const { app, db, cookies } = await adminApp({}, logs.options);
    const p = await seedAuthProvider(db, { issuerUrl: "https://a.example" });
    // Test-only: make this UPDATE hit an unexpected CHECK (NOT VALID = existing rows unchecked, only new writes validated).
    await db.execute(sql`alter table auth_providers add constraint test_block_icon_upload check (icon_kind <> 'upload') not valid`);
    const res = await putIcon(app, p.id, one(pngBytes()), { cookies });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("internal");
    // Fastify lifecycle lines (incoming request / request completed) are seen by the logMethod hook as the raw req/res before serialization (including light-my-request's
    // payload = the whole multipart body), while the real output goes through `serializers.req` and has no body; exclude those two lines (as in `admin-auth-probe.test.ts`).
    const relevant = logs.lines.filter(l => l.msg !== "incoming request" && l.msg !== "request completed");
    const dumped = JSON.stringify(
      relevant.map(l => ({ msg: l.msg, obj: l.obj })),
      (_k, v: unknown) => (v instanceof Error ? { message: v.message, stack: v.stack, cause: v.cause instanceof Error ? v.cause.message : v.cause } : v),
    );
    expect(dumped).not.toContain(ICON_MARKER);
    expect(relevant.some(l => l.msg === "unhandled error")).toBe(true);
    expect(logs.lines.some(l => typeof l.msg === "string" && l.msg.startsWith("上傳登入服務圖示時發生非預期的資料庫錯誤"))).toBe(true);
  });
});
