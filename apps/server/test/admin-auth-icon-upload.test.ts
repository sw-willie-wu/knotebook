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

describe("PUT /api/admin/auth/providers/:id/icon（spec §4.2、§8.1 S1–S4）", () => {
  it("S1：未登入 401、一般使用者（真 session）403、管理員的有效 PAT 401；DB 不變", async () => {
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

  it("S2：262145 位元組 → 413 file_too_large「圖檔不得超過 256 KB」、DB 不變；262144 位元組 → 200、kind upload、version +1、存的是原樣位元組", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedAuthProvider(db, { issuerUrl: "https://a.example" });
    const before = await providerRow(db, p.id);
    const tooBig = await putIcon(app, p.id, one(pngBytes(262145)), { cookies });
    expect(tooBig.statusCode).toBe(413);
    expect(tooBig.json().error).toEqual({ code: "file_too_large", message: "圖檔不得超過 256 KB" });
    expect(await providerRow(db, p.id)).toEqual(before);

    const exact = pngBytes(262144);
    const ok = await putIcon(app, p.id, one(exact), { cookies });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: p.id, iconKind: "upload", icon: { type: "upload", url: `/api/auth/providers/${p.id}/icon?v=1` } });
    expectNoIconBytes(ok.body);
    const row = await providerRow(db, p.id);
    expect(row).toMatchObject({ iconKind: "upload", iconMime: "image/png", iconVersion: 1, configVersion: before!.configVersion, enabled: before!.enabled });
    expect(Buffer.compare(row!.iconData!, exact)).toBe(0);

    // PUT 再一次：後到者的圖與 version 勝（spec §7.2 PUT ∥ PUT 的序列形）。
    const again = await putIcon(app, p.id, one(JPEG_BYTES, { filename: "b.jpg", contentType: "image/jpeg" }), { cookies });
    expect(again.json().icon).toEqual({ type: "upload", url: `/api/auth/providers/${p.id}/icon?v=2` });
    expect(await providerRow(db, p.id)).toMatchObject({ iconMime: "image/jpeg", iconVersion: 2 });
  });

  it("S3：以檔頭為準——宣稱 .png／image/png 的 GIF 與純文字 → 415「只接受 PNG、JPEG、WebP」；宣稱 .gif／image/gif 的 JPEG → 200 image/jpeg；WebP → 200", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedAuthProvider(db, { issuerUrl: "https://a.example" });
    const before = await providerRow(db, p.id);
    for (const [label, data] of [["gif", GIF_BYTES], ["text", TEXT_BYTES]] as const) {
      const res = await putIcon(app, p.id, one(data, { filename: "x.png", contentType: "image/png" }), { cookies });
      expect(res.statusCode, label).toBe(415);
      expect(res.json().error, label).toEqual({ code: "unsupported_media_type", message: "只接受 PNG、JPEG、WebP" });
    }
    expect(await providerRow(db, p.id)).toEqual(before);
    const jpeg = await putIcon(app, p.id, one(JPEG_BYTES, { filename: "x.gif", contentType: "image/gif" }), { cookies });
    expect(jpeg.statusCode).toBe(200);
    expect((await providerRow(db, p.id))!.iconMime).toBe("image/jpeg");
    const webp = await putIcon(app, p.id, one(WEBP_BYTES, { filename: "x.bin", contentType: "application/octet-stream" }), { cookies });
    expect(webp.statusCode).toBe(200);
    expect((await providerRow(db, p.id))!.iconMime).toBe("image/webp");
  });

  it("S4：application/json → 415；跨源 Origin → 403「Origin 驗證失敗」；同源 Origin 放行；沒有 file part → 400「缺少上傳檔案」；壞 multipart → 400「上傳格式錯誤」；非 UUID／不存在 → 404", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedAuthProvider(db, { issuerUrl: "https://a.example" });
    const json = await app.inject({ method: "PUT", url: `/api/admin/auth/providers/${p.id}/icon`, cookies, payload: { file: "x" } });
    expect(json.statusCode).toBe(415);
    expect(json.json().error.code).toBe("unsupported_media_type");
    const cross = await putIcon(app, p.id, one(pngBytes()), { cookies, headers: { origin: "https://evil.example" } });
    expect(cross.statusCode).toBe(403);
    expect(cross.json().error).toEqual({ code: "forbidden", message: "Origin 驗證失敗" });
    expect((await putIcon(app, p.id, one(pngBytes()), { cookies, headers: { origin: "http://localhost:80" } })).statusCode).toBe(200);
    const noFile = await putIcon(app, p.id, multipartBody([{ name: "note", data: "x" }]), { cookies });
    expect(noFile.statusCode).toBe(400);
    expect(noFile.json().error).toEqual({ code: "invalid_body", message: "缺少上傳檔案" });
    const broken = await app.inject({
      method: "PUT",
      url: `/api/admin/auth/providers/${p.id}/icon`,
      cookies,
      payload: one(pngBytes()),
      headers: { "content-type": "multipart/form-data" },
    });
    expect(broken.statusCode).toBe(400);
    expect(broken.json().error).toEqual({ code: "invalid_body", message: "上傳格式錯誤" });
    for (const id of ["not-a-uuid", "99999999-9999-4999-8999-999999999999"]) {
      const res = await putIcon(app, id, one(pngBytes()), { cookies });
      expect(res.statusCode, id).toBe(404);
      expect(res.json().error, id).toEqual({ code: "not_found", message: "找不到此登入服務" });
    }
  });

  it("RF2：兩個 file part 只看第一個——先 GIF 後 PNG → 415；先 PNG 後 GIF → 200 且存的是第一個", async () => {
    const { app, db, cookies } = await adminApp();
    const p = await seedAuthProvider(db, { issuerUrl: "https://a.example" });
    const gifFirst = multipartBody([iconFile(GIF_BYTES, { filename: "a.gif" }), iconFile(pngBytes(), { filename: "b.png" })]);
    expect((await putIcon(app, p.id, gifFirst, { cookies })).statusCode).toBe(415);
    const first = pngBytes(80);
    const pngFirst = multipartBody([{ name: "anything", data: "field-before" }, iconFile(first), iconFile(GIF_BYTES, { filename: "b.gif" })]);
    expect((await putIcon(app, p.id, pngFirst, { cookies })).statusCode).toBe(200);
    expect(Buffer.compare((await providerRow(db, p.id))!.iconData!, first)).toBe(0);
  });

  it("§7.2 PUT ∥ DELETE：holder（扮演別的管理員的刪除）持列鎖 → PUT 真的卡在 UPDATE → holder 刪列提交 → PUT 404、無列", async () => {
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

  it("非預期 DB 錯誤經 redactDbError：500，log 不含圖檔位元組（params 帶整個圖檔，spec §4.2 第 7 步）", async () => {
    const logs = captureLogs();
    const { app, db, cookies } = await adminApp({}, logs.options);
    const p = await seedAuthProvider(db, { issuerUrl: "https://a.example" });
    // 測試專用：讓這一句 UPDATE 撞上非預期的 CHECK（NOT VALID＝既有列不驗，新寫入才驗）。
    await db.execute(sql`alter table auth_providers add constraint test_block_icon_upload check (icon_kind <> 'upload') not valid`);
    const res = await putIcon(app, p.id, one(pngBytes()), { cookies });
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe("internal");
    // fastify 生命週期行（incoming request／request completed）在 logMethod hook 看到的是序列化前的原始 req／res（含 light-my-request 的
    // payload＝整個 multipart body），實際輸出經 `serializers.req` 不含 body——排除這兩種行（同 `admin-auth-probe.test.ts:136-138`）。
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
