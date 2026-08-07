import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import fastifyMultipart from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import { buildTestApp } from "./helpers.js";

// ───────────────────────────── Task 10a：CSRF hook（multipart 豁免 + Origin 驗證）─────────────────────────────
//
// 白名單命中的路由固定是 `POST /api/notes/:id/uploads`（見 `app.ts` 的
// `MULTIPART_EXEMPT_ROUTES`，比對 `request.routeOptions.url` 這個 route pattern，不是
// 實際請求路徑，故任何 `:id` 值都算命中）——本檔尚未有真實的 uploads 路由（Task 10b
// 才落地），這裡先掛一支樁路由讓 CSRF hook 的白名單判定有東西可命中：未命中路由時
// `is404` 為真、豁免不成立，任何 multipart body 會直接吃既有 JSON 415，Origin 矩陣一個
// 案例都觀察不到。

const NOTE_ID = "11111111-1111-1111-1111-111111111111";
const UPLOAD_URL = `/api/notes/${NOTE_ID}/uploads`;
/** C1 mutation 護欄專用（見 `withUploadStubRoute` 說明）：白名單**不含**這條路由。 */
const NOT_EXEMPT_URL = "/__test/not-exempt";

/**
 * 樁路由**僅存活於本 task**：Task 10b 落地真實 `POST /api/notes/:id/uploads` 時必須
 * 刪除這支樁並把下面的 Origin/essence 矩陣改掛真實路由重驗——同 URL 雙重註冊會
 * `FST_ERR_DUPLICATED_ROUTE`。
 *
 * 註冊順序明訂（task-10-brief）：`void app.register(fastifyMultipart)` →
 * `app.post(...)` → `await app.ready()`；不得 `await register()` 再加路由（await
 * register 觸發 avvio boot，之後 `route()` 呼叫丟 "Cannot add route!"）。
 *
 * 樁本身不驗證任何欄位（無 auth、無 magic bytes、無 limiter——那些是 Task 10b 的範圍）；
 * 唯一職責是「若有檔案 part 就真的讀完它」，比照真實路由最終會做的事，讓通過 CSRF
 * 檢查的 multipart 請求能被 `@fastify/multipart` 正常解析、不會因為 body 沒被消費而
 * 掛住。
 *
 * 順帶掛上 `POST /__test/not-exempt`（C1 mutation 護欄，審查回報方案②）：白名單判定
 * 的正確性不能只靠「essence 不符就 415」這條規則的既有測試觀察——如果把
 * `isMultipartExemptRoute` 誤改成單純的 Content-Type essence 判定（不比對
 * 路由白名單，等於「只要 essence 是 multipart/form-data 就當作豁免」），既有那組
 * 「multipart body 打 /api/auth/login 仍 415」regression 測試**看不出來**：那個
 * app 沒註冊 `fastifyMultipart`，即使 hook 被 mutation 誤放行，request 仍會在
 * Fastify 的 content-type parser 那層自己因為「沒有 multipart parser」而丟
 * `FST_ERR_CTP_INVALID_MEDIA_TYPE`（同樣映射成 415/unsupported_media_type）——
 * 「hook 擋」與「body parser 擋」在該測試下產出完全相同的 status/code，mutation 因此
 * 存活。要讓白名單邏輯本身（而非其他任何後備機制）被迫成為唯一的守門者，必須讓
 * multipart parser **確實可用**、但目標路由**不在白名單**：`@fastify/multipart`
 * 註冊在頂層 `app` 上（非 encapsulated plugin），對這個 app 內任何路由都生效，故
 * `/__test/not-exempt` 收到合法 multipart body 時，parser 不會報錯——若白名單判定
 * 正確擋下（essence 檢查要求 `application/json`），才會是本函式的 415；一旦白名單
 * 判定被 mutation 破壞而誤判它豁免，request 會直接流進這支 handler 拿到 200。
 */
async function withUploadStubRoute(app: FastifyInstance): Promise<void> {
  void app.register(fastifyMultipart);
  app.post(UPLOAD_URL.replace(NOTE_ID, ":id"), async (request, reply) => {
    const file = await request.file();
    if (file) await file.toBuffer();
    return reply.code(201).send({ ok: true });
  });
  app.post(NOT_EXEMPT_URL, async (_request, reply) => reply.code(200).send({ ok: true }));
  await app.ready();
}

/** 手組最小合法的 multipart/form-data body（單一 file part），回傳 Buffer——不可用字串往返（二進位內容會被破壞）。 */
function buildMultipartBody(boundary: string): Buffer {
  const header = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.png"\r\nContent-Type: image/png\r\n\r\n`,
    "utf-8"
  );
  const fileBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`, "utf-8");
  return Buffer.concat([header, fileBytes, footer]);
}

const BOUNDARY = "knotebookTestBoundary";

async function postMultipart(app: FastifyInstance, headers: Record<string, string>) {
  return app.inject({
    method: "POST",
    url: UPLOAD_URL,
    payload: buildMultipartBody(BOUNDARY),
    headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}`, ...headers },
  });
}

describe("uploadsDir 啟動期可寫性探測（Task 9，AppDeps.uploadsDir）", () => {
  it("uploadsDir 的父路徑其實是一般檔案（非目錄）→ buildApp 同步 throw、fail-fast（與 mode 無關）", async () => {
    // fixture：先建一個真實存在的父目錄，裡面放一個「一般檔案」，再把
    // `<該檔案>/uploads` 當成 uploadsDir 傳進去——任何試圖在它底下寫入探針檔的
    // 動作都會因為路徑上有一段其實是檔案（ENOTDIR）而失敗，與該檔案的權限
    // mode 完全無關（即使 chmod 777 依然是「檔案」不是「目錄」）。
    const parentDir = mkdtempSync(path.join(os.tmpdir(), "knotebook-uploads-fixture-"));
    const regularFile = path.join(parentDir, "not-a-directory");
    writeFileSync(regularFile, "");
    const bogusUploadsDir = path.join(regularFile, "uploads");

    try {
      await expect(buildTestApp({ uploadsDir: bogusUploadsDir })).rejects.toThrow(/uploads 目錄不可寫/);
    } finally {
      rmSync(parentDir, { recursive: true, force: true });
    }
  });
});

describe("CSRF hook：multipart 上傳路由豁免 + Origin 驗證（Task 10a，spec §12.4）", () => {
  it("essence 不是 multipart/form-data（打上傳端點，沒帶 Origin）→ 415 unsupported_media_type（essence 先於 Origin 檢查——沒帶 Origin 若走到 Origin 分支會放行 201，這裡驗證的正是它先被 essence 擋下）", async () => {
    const { app } = await buildTestApp();
    await withUploadStubRoute(app);
    const res = await app.inject({
      method: "POST",
      url: UPLOAD_URL,
      payload: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe("unsupported_media_type");
  });

  it("essence 偽裝（text/plain;charset=multipart/form-data 這種 essence 不符的變體）仍 415", async () => {
    const { app } = await buildTestApp();
    await withUploadStubRoute(app);
    const res = await app.inject({
      method: "POST",
      url: UPLOAD_URL,
      payload: "x",
      headers: { "content-type": "text/plain" },
    });
    expect(res.statusCode).toBe(415);
  });

  describe("Origin 矩陣（essence 相符之後）", () => {
    it("Origin host 與 request.host 不符 → 403 forbidden", async () => {
      const { app } = await buildTestApp();
      await withUploadStubRoute(app);
      const res = await postMultipart(app, { origin: "https://evil.example.com", host: "localhost:3000" });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("forbidden");
    });

    it("含 port 的 LAN 形狀（192.168.x.x:8006）Origin 與 host 相符 → 通過（不是 403/415）", async () => {
      const { app } = await buildTestApp();
      await withUploadStubRoute(app);
      const res = await postMultipart(app, { origin: "http://192.168.3.22:8006", host: "192.168.3.22:8006" });
      expect(res.statusCode).toBe(201);
    });

    // I1：兩者都帶明確 port，但 port 本身不同（都非 80/443，不會被 stripDefaultPort
    // 消掉）→ 必須不符。護住「比對邏輯不小心把 port 整段剝掉、只比 hostname」這種
    // mutation——上面「LAN 相符」與「預設 port 正規化」兩案例都是「port 相同／消去後
    // 相同」的正面案例，缺一個「port 不同就該判不符」的反例時，就算把 port 比較這段
    // 邏輯整段刪掉（等同剝 port 比 hostname），這些既有案例仍然全線綠。
    it("同 host 不同 port（都非 80/443）→ 403（LAN 形狀下 port 差異不可被忽略）", async () => {
      const { app } = await buildTestApp();
      await withUploadStubRoute(app);
      const res = await postMultipart(app, { origin: "http://192.168.3.22:9999", host: "192.168.3.22:8006" });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("forbidden");
    });

    it("scheme 混合（https Origin vs http host）仍相符 → 通過（scheme 忽略）", async () => {
      const { app } = await buildTestApp();
      await withUploadStubRoute(app);
      const res = await postMultipart(app, { origin: "https://example.com", host: "example.com" });
      expect(res.statusCode).toBe(201);
    });

    it("預設 port 正規化（example.com vs example.com:443）→ 通過", async () => {
      const { app } = await buildTestApp();
      await withUploadStubRoute(app);
      const res = await postMultipart(app, { origin: "https://example.com", host: "example.com:443" });
      expect(res.statusCode).toBe(201);
    });

    it("Origin: null（字面字串，沙箱化 iframe 等情境）→ 403", async () => {
      const { app } = await buildTestApp();
      await withUploadStubRoute(app);
      const res = await postMultipart(app, { origin: "null", host: "localhost:3000" });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("forbidden");
    });

    it("無 Origin header → 放行（不是 CSRF 閘門保護的向量，spec 明文）", async () => {
      const { app } = await buildTestApp();
      await withUploadStubRoute(app);
      const res = await postMultipart(app, { host: "localhost:3000" });
      expect(res.statusCode).toBe(201);
    });
  });

  describe("白名單判定護欄（C1：mutation 護欄，審查回報方案②）", () => {
    it("multipart parser 已註冊、但目標路由不在白名單（POST /__test/not-exempt）→ 仍 415，且訊息是白名單分支專屬文案（雙保險：光 415/unsupported_media_type 這組 status/code 不足以證明是白名單判定本身擋下的——見 withUploadStubRoute 說明）", async () => {
      const { app } = await buildTestApp();
      await withUploadStubRoute(app);
      const res = await app.inject({
        method: "POST",
        url: NOT_EXEMPT_URL,
        payload: buildMultipartBody(BOUNDARY),
        headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      });
      expect(res.statusCode).toBe(415);
      expect(res.json()).toMatchObject({ error: { code: "unsupported_media_type", message: "此請求需要 application/json" } });
    });
  });

  describe("CSRF 迴歸：既有 JSON 守衛不受本次擴充影響", () => {
    it("非 multipart 路由（既有 /api/auth/login，此 app 未註冊 multipart parser）content-type 非 JSON → 415 行為不變", async () => {
      const { app } = await buildTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: "x",
        headers: { "content-type": "text/plain" },
      });
      expect(res.statusCode).toBe(415);
      expect(res.json().error.code).toBe("unsupported_media_type");
    });

    it("multipart body 打非豁免路由（既有 /api/auth/login，此 app 未註冊 multipart parser）→ 仍 415——注意：這條不足以單獨證明白名單判定正確，未註冊 parser 時 Fastify 自己也會用同一組 status/code 拒絕，見上方「白名單判定護欄」那組才是能鑑別 mutation 的版本", async () => {
      const { app } = await buildTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: buildMultipartBody(BOUNDARY),
        headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      });
      expect(res.statusCode).toBe(415);
      expect(res.json().error.code).toBe("unsupported_media_type");
    });
  });
});
