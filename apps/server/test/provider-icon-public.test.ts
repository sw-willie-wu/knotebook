import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { authProviders } from "../src/db/schema.js";
import { seedAuthProvider } from "./helpers/oidc-provider.js";
import { adminApp } from "./helpers/admin-auth.js";
import { JPEG_BYTES, iconFile, multipartBody, pngBytes, putIcon } from "./helpers/provider-icon.js";

const IMMUTABLE = "public, max-age=31536000, immutable";

async function uploaded() {
  const built = await adminApp();
  const p = await seedAuthProvider(built.db, { issuerUrl: "https://a.example" });
  const bytes = pngBytes(100);
  const put = await putIcon(built.app, p.id, multipartBody([iconFile(bytes)]), { cookies: built.cookies });
  expect(put.statusCode).toBe(200);
  return { ...built, p, bytes };
}
const get = (app: Awaited<ReturnType<typeof uploaded>>["app"], path: string) => app.inject({ method: "GET", url: path });

describe("GET /api/auth/providers/:id/icon（spec §4.4、§8.1 S6）", () => {
  it("S6：免登入 200、原樣位元組、content-type＝偵測值、nosniff、CSP default-src 'none'; sandbox；v＝現版本 → immutable", async () => {
    const { app, p, bytes } = await uploaded();
    const res = await get(app, `/api/auth/providers/${p.id}/icon?v=1`);
    expect(res.statusCode).toBe(200);
    expect(Buffer.compare(res.rawPayload, bytes)).toBe(0);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBe("default-src 'none'; sandbox");
    expect(res.headers["cache-control"]).toBe(IMMUTABLE);
  });

  it("S6：v 不等、缺、非數字 → no-cache（仍回現行圖）", async () => {
    const { app, p, bytes } = await uploaded();
    for (const q of ["?v=0", "?v=2", "", "?v=abc", "?v="]) {
      const res = await get(app, `/api/auth/providers/${p.id}/icon${q}`);
      expect(res.statusCode, q).toBe(200);
      expect(res.headers["cache-control"], q).toBe("no-cache");
      expect(Buffer.compare(res.rawPayload, bytes), q).toBe(0);
    }
  });

  it("RF3：v 必須字串完全相等——01、1.0、+1、空白、重複兩次都 no-cache", async () => {
    const { app, p } = await uploaded();
    for (const q of ["?v=01", "?v=1.0", "?v=%2B1", "?v=%201", "?v=1&v=1"]) {
      expect((await get(app, `/api/auth/providers/${p.id}/icon${q}`)).headers["cache-control"], q).toBe("no-cache");
    }
  });

  it("S6：停用中服務 200；JPEG 的 content-type 是 image/jpeg；大寫 UUID 也找得到", async () => {
    const { app, db, cookies, p } = await uploaded();
    await db.update(authProviders).set({ enabled: false }).where(eq(authProviders.id, p.id));
    expect((await get(app, `/api/auth/providers/${p.id}/icon?v=1`)).statusCode).toBe(200);
    expect((await putIcon(app, p.id, multipartBody([iconFile(JPEG_BYTES)]), { cookies })).statusCode).toBe(200);
    const jpeg = await get(app, `/api/auth/providers/${p.id.toUpperCase()}/icon?v=2`);
    expect(jpeg.statusCode).toBe(200);
    expect(jpeg.headers["content-type"]).toBe("image/jpeg");
    expect(jpeg.headers["cache-control"]).toBe(IMMUTABLE);
  });

  it("S6：icon_kind≠upload → 404「找不到此圖示」；改成 gitlab 後 → 404；刪除有上傳圖的服務後同網址 200 → 404；非 UUID → 404", async () => {
    const { app, db, cookies, p } = await uploaded();
    const plain = await seedAuthProvider(db, { issuerUrl: "https://b.example" });
    const notUpload = await get(app, `/api/auth/providers/${plain.id}/icon?v=0`);
    expect(notUpload.statusCode).toBe(404);
    expect(notUpload.json().error).toEqual({ code: "not_found", message: "找不到此圖示" });
    const patched = await app.inject({ method: "PATCH", url: `/api/admin/auth/providers/${p.id}`, cookies, payload: { iconKind: "gitlab" } });
    expect(patched.statusCode).toBe(200);
    expect((await get(app, `/api/auth/providers/${p.id}/icon?v=1`)).statusCode).toBe(404);
    // spec §2.2-4／D10：刪服務，圖跟著刪——被刪的列原本**有**上傳圖。
    const doomed = await seedAuthProvider(db, { issuerUrl: "https://c.example" });
    expect((await putIcon(app, doomed.id, multipartBody([iconFile(pngBytes())]), { cookies })).statusCode).toBe(200);
    const doomedUrl = `/api/auth/providers/${doomed.id}/icon?v=1`;
    expect((await get(app, doomedUrl)).statusCode).toBe(200);
    await db.delete(authProviders).where(eq(authProviders.id, doomed.id));
    expect((await get(app, doomedUrl)).statusCode).toBe(404);
    expect((await get(app, "/api/auth/providers/not-a-uuid/icon")).statusCode).toBe(404);
  });
});
