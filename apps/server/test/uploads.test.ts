import { mkdtempSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import http from "node:http";
import type { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { SESSION_COOKIE, MAX_UPLOAD_BYTES } from "@knotebook/shared";
import { buildTestApp, testConfig } from "./helpers.js";
import { notes, noteShares, uploads, users } from "../src/db/schema.js";
import type { Db } from "../src/db/index.js";
import { signSession } from "../src/auth/session.js";
import { FixedWindowLimiter } from "../src/http/rate-limit.js";

// ───────────────────────────── 共用 fixture helpers（比照 notes-links.test.ts／shares.test.ts 慣例）─────────────────────────────

async function insertUser(db: Db, overrides: Partial<{ email: string; displayName: string }> = {}) {
  const [u] = await db
    .insert(users)
    .values({
      email: overrides.email ?? `user-${Math.random().toString(36).slice(2)}@example.com`,
      displayName: overrides.displayName ?? "Test User",
    })
    .returning();
  return u;
}

async function cookieFor(userId: string): Promise<string> {
  return signSession(testConfig.appSecret, { userId, tv: 0 });
}

async function createNote(db: Db, ownerId: string, title?: string): Promise<{ id: string }> {
  const values = title === undefined ? { ownerId } : { ownerId, title };
  const [row] = await db.insert(notes).values(values).returning({ id: notes.id });
  return row;
}

async function share(db: Db, noteId: string, userId: string, role: "editor" | "viewer"): Promise<void> {
  await db.insert(noteShares).values({ noteId, userId, role });
}

// ───────────────────────────── multipart body 手組（不可字串往返，見 detectImageMimeType 之 magic bytes 皆為二進位）─────────────────────────────

interface BodyPart {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer | string;
}

const BOUNDARY = "knotebookTestBoundary";

/** 手組任意組合的 multipart/form-data body（file part／field part 皆可混搭）。 */
function buildMultipartBody(parts: BodyPart[], boundary = BOUNDARY): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const dispo =
      part.filename !== undefined
        ? `form-data; name="${part.name}"; filename="${part.filename}"`
        : `form-data; name="${part.name}"`;
    const headerLines = [`--${boundary}`, `Content-Disposition: ${dispo}`];
    if (part.contentType !== undefined) headerLines.push(`Content-Type: ${part.contentType}`);
    headerLines.push("", "");
    chunks.push(Buffer.from(headerLines.join("\r\n"), "utf-8"));
    chunks.push(typeof part.data === "string" ? Buffer.from(part.data, "utf-8") : part.data);
    chunks.push(Buffer.from("\r\n", "utf-8"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`, "utf-8"));
  return Buffer.concat(chunks);
}

// 完整 8-byte PNG signature（`detectImageMimeType` 要求完整簽章，不是任意前綴幾個 byte
// 就算數）+ 一些任意內容，讓「檔案不是空的」這件事本身也順帶被覆蓋到。
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02]);
const NOT_AN_IMAGE_BYTES = Buffer.from("this is definitely not an image, just plain text bytes", "utf-8");

function singleFileBody(data: Buffer, opts: { filename?: string; contentType?: string; boundary?: string } = {}): Buffer {
  return buildMultipartBody(
    [{ name: "file", filename: opts.filename ?? "test.png", contentType: opts.contentType ?? "image/png", data }],
    opts.boundary
  );
}

function manyFileParts(count: number): BodyPart[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `file${i}`,
    filename: `f${i}.bin`,
    contentType: "application/octet-stream",
    data: Buffer.from([0x00]),
  }));
}

function manyFieldParts(count: number): BodyPart[] {
  return Array.from({ length: count }, (_, i) => ({ name: `field${i}`, data: "x" }));
}

async function postUpload(
  app: Awaited<ReturnType<typeof buildTestApp>>["app"],
  noteId: string,
  body: Buffer,
  opts: { cookie?: string; boundary?: string; headers?: Record<string, string> } = {}
) {
  const headers: Record<string, string> = {
    "content-type": `multipart/form-data; boundary=${opts.boundary ?? BOUNDARY}`,
    ...opts.headers,
  };
  return app.inject({
    method: "POST",
    url: `/api/notes/${noteId}/uploads`,
    payload: body,
    cookies: opts.cookie !== undefined ? { [SESSION_COOKIE]: opts.cookie } : undefined,
    headers,
  });
}

// ───────────────────────────── 真 socket drain 驗證（Critical-2 review：`app.inject` 無真 socket，
// 量不出「body 未 drain 導致連線卡住、graceful shutdown 吊死」這類問題）─────────────────────────────

/**
 * 用 `node:http` 直接發一個真的 TCP 請求（而非 `app.inject`）——`app.inject` 走
 * light-my-request，整包 payload 在記憶體、沒有真的 socket，量不出「server 端沒把
 * request body 讀完，導致底層連線卡住」這種問題（該問題只在真 socket 上才會拖住
 * `server.close()`）。回傳值含 `socket`：呼叫端必須在斷言完 response 之後**先
 * `socket.destroy()` 再 `app.close()`**——否則即使 server 端行為完全正確，client 端
 * 自己維持住的 keep-alive 連線一樣會讓 `app.close()` 卡住等它自然關閉，造成偽陽性
 * （這條連線的生死本來就不是我們要驗證的東西）。
 *
 * **`clientErrors`（CI unhandled `write ECONNRESET` 事故後補）**：`drainWithCap`
 * 超過 cap 時對 `request.raw` 呼叫 `destroy()`（見 `src/http/drain.ts`），這是
 * server 端主動砍線，client 端若此時仍在寫入大 body，底層 socket 會收到
 * ECONNRESET／EPIPE（CI 實測過 `write ECONNRESET`，errno -104；本機 loopback 因為
 * 太快，通常整包已經寫完才收到，測不出來，見 Task 9 測試內的時序註解）——這是
 * `destroy()` 本來就預期的副作用，不是 bug，但**client 端必須有人接住**，否則
 * Node 對沒有 `error` listener 的 EventEmitter 丟未接住的 'error' 視同
 * uncaughtException，讓整個測試檔案炸掉（即使個別測試斷言全過）。舊版只在
 * `req.on("error", reject)` 掛了一個 listener——這只擋得住「回應完成前」的錯誤
 * （reject 會被呼叫，此時 Promise 還沒 settle）；回應完成、Promise 已經 resolve
 * 之後才發生的 socket 層級錯誤（例如這裡 CI 撞到的情況：回應早就送達，client 還在
 * 背景寫剩下的大 body），Node 官方文件明講 request-level 的 'error' proxy
 * 不保證涵蓋這個時間點之後、底層 socket 自己發的 'error'——所以額外直接在
 * `req.socket`（透過 `req.once("socket", …)` 拿到，比 `req.socket` 可能還沒賦值的
 * 時機更早更保險）上掛一個常駐 `error` listener，把錯誤記進 `clientErrors` 陣列
 * 而非裸吞：呼叫端可以視情境選擇性斷言（例如 over-cap 測試允許
 * ECONNRESET/EPIPE），其他測試若跑出非預期的 client 錯誤仍看得見（陣列不是空的），
 * 不會被靜音掉真正的迴歸。
 */
function rawSocketPost(opts: { port: number; path: string; headers: Record<string, string>; body: Buffer }): Promise<{
  status: number;
  body: string;
  socket: Socket;
  clientErrors: Error[];
}> {
  return new Promise((resolve, reject) => {
    const clientErrors: Error[] = [];
    const req = http.request(
      {
        host: "127.0.0.1",
        port: opts.port,
        path: opts.path,
        method: "POST",
        headers: { ...opts.headers, "content-length": String(opts.body.length) },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
            socket: req.socket!,
            clientErrors,
          });
        });
        res.on("error", reject);
      }
    );
    // 常駐在 socket 本身：涵蓋回應完成後（Promise 已 resolve）才發生的錯誤，這類
    // 錯誤不會、也不需要再改變已經 settle 的 Promise 結果。
    req.once("socket", socket => {
      socket.on("error", err => {
        clientErrors.push(err);
      });
    });
    // 涵蓋回應完成前發生的錯誤（例如根本連不上）——維持原本 reject 語意；Promise
    // 一旦已經 resolve，重複呼叫 reject 是標準 Promise 語意下的 no-op，不會出錯。
    req.on("error", err => {
      clientErrors.push(err);
      reject(err);
    });
    req.end(opts.body);
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

// ───────────────────────────── CSRF hook：multipart 豁免 + Origin 驗證（Task 10a，spec §12.4）─────────────────────────────
//
// Task 10b 落地真實路由後改掛真實 `POST /api/notes/:id/uploads`（Task 10a 的樁路由
// `withUploadStubRoute`／`/__test/not-exempt` 已刪除——同 URL 雙註冊會 FST_ERR_DUPLICATED_ROUTE，
// 見 task-10-brief）。essence／Origin 不符的分支在 CSRF hook 就被擋下，不需要真的登入或
// 真的有這篇筆記——用假 UUID 當 noteId 即可，因為這兩條早退發生在路由參數被解析、
// resolveRole 查 DB 之前。Origin 相符的正面案例則改成走完整真實流程（真登入 + 真筆記 +
// 合法 PNG bytes），直接斷言 201，一次覆蓋「CSRF 放行」與「真實路由確實能吃這個請求」
// 兩件事，不必再靠 Task 10a 那支只回字面 201 的樁路由。
//
// 白名單判定的 mutation 護欄（Task 10a 的 C1）不再需要專屬的 `/__test/not-exempt` 樁路由：
// `@fastify/multipart` 現在確實註冊在生產 app 的頂層（`app.ts`，Task 10b），這件事本身讓
// 下方「CSRF 迴歸」小節的既有測試（multipart body 打 `/api/auth/login` 仍 415）天然具備
// 同等的鑑別力——若 `isMultipartExemptRoute` 被 mutation 成「只看 essence、不比對白名單」，
// 這個請求會流進真正的 `/api/auth/login` handler（multipart 不會填 `request.body`，
// zod safeParse 落在 undefined 上失敗）→ 400，而非正確實作的 415，status code 本身就
// 足以讓測試變紅，不需要另外一支專門回 200 的樁路由才能觀察差異。
describe("CSRF hook：multipart 上傳路由豁免 + Origin 驗證（Task 10a，掛真實路由重驗）", () => {
  const FAKE_NOTE_ID = "11111111-1111-1111-1111-111111111111";

  it("essence 不是 multipart/form-data（打上傳端點，沒帶 Origin）→ 415 unsupported_media_type（essence 先於 Origin 檢查）", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/notes/${FAKE_NOTE_ID}/uploads`,
      payload: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe("unsupported_media_type");
  });

  it("essence 偽裝（text/plain）仍 415", async () => {
    const { app } = await buildTestApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/notes/${FAKE_NOTE_ID}/uploads`,
      payload: "x",
      headers: { "content-type": "text/plain" },
    });
    expect(res.statusCode).toBe(415);
  });

  describe("Origin 矩陣（essence 相符之後）", () => {
    it("Origin host 與 request.host 不符 → 403 forbidden", async () => {
      const { app } = await buildTestApp();
      const res = await postUpload(app, FAKE_NOTE_ID, singleFileBody(PNG_BYTES), {
        headers: { origin: "https://evil.example.com", host: "localhost:3000" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("forbidden");
    });

    it("同 host 不同 port（都非 80/443）→ 403（LAN 形狀下 port 差異不可被忽略）", async () => {
      const { app } = await buildTestApp();
      const res = await postUpload(app, FAKE_NOTE_ID, singleFileBody(PNG_BYTES), {
        headers: { origin: "http://192.168.3.22:9999", host: "192.168.3.22:8006" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("forbidden");
    });

    it("Origin: null（字面字串）→ 403", async () => {
      const { app } = await buildTestApp();
      const res = await postUpload(app, FAKE_NOTE_ID, singleFileBody(PNG_BYTES), {
        headers: { origin: "null", host: "localhost:3000" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe("forbidden");
    });

    it("含 port 的 LAN 形狀（192.168.x.x:8006）Origin 與 host 相符 → 通過 CSRF 閘門，走到真實路由（登入+真筆記後 201）", async () => {
      const { app, db } = await buildTestApp();
      const owner = await insertUser(db, { email: "owner-lan@example.com" });
      const cookie = await cookieFor(owner.id);
      const note = await createNote(db, owner.id);

      const res = await postUpload(app, note.id, singleFileBody(PNG_BYTES), {
        cookie,
        headers: { origin: "http://192.168.3.22:8006", host: "192.168.3.22:8006" },
      });
      expect(res.statusCode).toBe(201);
    });

    it("scheme 混合（https Origin vs http host）仍相符 → 通過（scheme 忽略）", async () => {
      const { app, db } = await buildTestApp();
      const owner = await insertUser(db, { email: "owner-scheme@example.com" });
      const cookie = await cookieFor(owner.id);
      const note = await createNote(db, owner.id);

      const res = await postUpload(app, note.id, singleFileBody(PNG_BYTES), {
        cookie,
        headers: { origin: "https://example.com", host: "example.com" },
      });
      expect(res.statusCode).toBe(201);
    });

    it("預設 port 正規化（example.com vs example.com:443）→ 通過", async () => {
      const { app, db } = await buildTestApp();
      const owner = await insertUser(db, { email: "owner-port443@example.com" });
      const cookie = await cookieFor(owner.id);
      const note = await createNote(db, owner.id);

      const res = await postUpload(app, note.id, singleFileBody(PNG_BYTES), {
        cookie,
        headers: { origin: "https://example.com", host: "example.com:443" },
      });
      expect(res.statusCode).toBe(201);
    });

    it("無 Origin header → 放行（不是 CSRF 閘門保護的向量，spec 明文）", async () => {
      const { app, db } = await buildTestApp();
      const owner = await insertUser(db, { email: "owner-noorigin@example.com" });
      const cookie = await cookieFor(owner.id);
      const note = await createNote(db, owner.id);

      const res = await postUpload(app, note.id, singleFileBody(PNG_BYTES), { cookie, headers: { host: "localhost:3000" } });
      expect(res.statusCode).toBe(201);
    });
  });

  describe("CSRF 迴歸：既有 JSON 守衛不受本次擴充影響", () => {
    it("非 multipart 路由（既有 /api/auth/login）content-type 非 JSON → 415 行為不變", async () => {
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

    it("multipart body 打非豁免路由（既有 /api/auth/login）→ 仍 415（白名單判定的 mutation 護欄，見上方 describe 說明）", async () => {
      const { app } = await buildTestApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        payload: singleFileBody(PNG_BYTES),
        headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}` },
      });
      expect(res.statusCode).toBe(415);
      expect(res.json().error.code).toBe("unsupported_media_type");
    });
  });
});

// ───────────────────────────── Task 10b：POST /api/notes/:id/uploads routes + limiter ─────────────────────────────

describe("POST /api/notes/:id/uploads", () => {
  it("201：DB 列 noteId/uploaderId/mime/size 正確，GET 往返位元組與原始上傳一致", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-201@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = await createNote(db, owner.id);

    const res = await postUpload(app, note.id, singleFileBody(PNG_BYTES), { cookie });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { id: string; url: string };
    expect(body.url).toBe(`/api/uploads/${body.id}`);

    const [row] = await db.select().from(uploads).where(eq(uploads.id, body.id)).limit(1);
    expect(row).toMatchObject({ noteId: note.id, uploaderId: owner.id, mime: "image/png", size: PNG_BYTES.length });

    const getRes = await app.inject({ method: "GET", url: body.url, cookies: { [SESSION_COOKIE]: cookie } });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.rawPayload.equals(PNG_BYTES)).toBe(true);
  });

  it("多 file part：只取第一個（mime/size 對應第一個），其餘 drain 不落地", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-multi@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = await createNote(db, owner.id);

    const body = buildMultipartBody([
      { name: "file", filename: "a.png", contentType: "image/png", data: PNG_BYTES },
      { name: "file2", filename: "b.jpg", contentType: "image/jpeg", data: JPEG_BYTES },
    ]);
    const res = await postUpload(app, note.id, body, { cookie });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };
    const [row] = await db.select().from(uploads).where(eq(uploads.id, id)).limit(1);
    expect(row?.mime).toBe("image/png");
    expect(row?.size).toBe(PNG_BYTES.length);
    // 只有一筆 uploads 列——第二個 file part 被忽略，沒有另外落地一筆紀錄。
    const allRows = await db.select().from(uploads).where(eq(uploads.noteId, note.id));
    expect(allRows).toHaveLength(1);
  });

  it("400 invalid_body：parts 超過上限（32，用多個 file part 湊，避開 fields 上限先觸發）", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-parts@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = await createNote(db, owner.id);

    const res = await postUpload(app, note.id, buildMultipartBody(manyFileParts(33)), { cookie });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_body");
  });

  it("400 invalid_body：fields 超過上限（16）", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-fields@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = await createNote(db, owner.id);

    const res = await postUpload(app, note.id, buildMultipartBody(manyFieldParts(17)), { cookie });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_body");
  });

  it("400 invalid_body：缺 boundary（Content-Type 是 multipart/form-data 但沒帶 boundary=）", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-noboundary@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = await createNote(db, owner.id);

    const res = await app.inject({
      method: "POST",
      url: `/api/notes/${note.id}/uploads`,
      payload: singleFileBody(PNG_BYTES),
      cookies: { [SESSION_COOKIE]: cookie },
      headers: { "content-type": "multipart/form-data" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_body");
  });

  it("401：未登入", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-401@example.com" });
    const note = await createNote(db, owner.id);

    const res = await postUpload(app, note.id, singleFileBody(PNG_BYTES));
    expect(res.statusCode).toBe(401);
  });

  it("未登入 + Origin 不符 → 403（不是 401——Origin 檢查在 CSRF hook 的 onRequest，早於 authenticate；測試禁區明列，不得斷言 401）", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-badorigin@example.com" });
    const note = await createNote(db, owner.id);

    const res = await postUpload(app, note.id, singleFileBody(PNG_BYTES), {
      headers: { origin: "https://evil.example.com", host: "localhost:3000" },
    });
    expect(res.statusCode).toBe(403);
  });

  it("404：筆記不存在（合法 UUID 格式但查無此筆記）", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-404@example.com" });
    const cookie = await cookieFor(owner.id);

    const res = await postUpload(app, "22222222-2222-2222-2222-222222222222", singleFileBody(PNG_BYTES), { cookie });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("404：noteId 不是合法 UUID 格式", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-notuuid@example.com" });
    const cookie = await cookieFor(owner.id);

    const res = await postUpload(app, "not-a-uuid", singleFileBody(PNG_BYTES), { cookie });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("403：viewer 沒有上傳權限", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-viewer403@example.com" });
    const viewer = await insertUser(db, { email: "viewer-403@example.com" });
    const viewerCookie = await cookieFor(viewer.id);
    const note = await createNote(db, owner.id);
    await share(db, note.id, viewer.id, "viewer");

    const res = await postUpload(app, note.id, singleFileBody(PNG_BYTES), { cookie: viewerCookie });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });

  it("editor 可以上傳（非僅 owner）", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-editor201@example.com" });
    const editor = await insertUser(db, { email: "editor-201@example.com" });
    const editorCookie = await cookieFor(editor.id);
    const note = await createNote(db, owner.id);
    await share(db, note.id, editor.id, "editor");

    const res = await postUpload(app, note.id, singleFileBody(PNG_BYTES), { cookie: editorCookie });
    expect(res.statusCode).toBe(201);
  });

  it("415：magic bytes 偽裝（宣稱 image/png，實際內容不是任何支援的圖片格式）", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-415@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = await createNote(db, owner.id);

    const res = await postUpload(app, note.id, singleFileBody(NOT_AN_IMAGE_BYTES, { contentType: "image/png" }), { cookie });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe("unsupported_media_type");
  });

  it("413：檔案超過 MAX_UPLOAD_BYTES → file_too_large，不落檔（磁碟上沒有殘留任何檔案，含暫名檔）", async () => {
    const { app, db, uploadsDir } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-413@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = await createNote(db, owner.id);

    const oversized = Buffer.concat([PNG_BYTES, Buffer.alloc(MAX_UPLOAD_BYTES, 0x41)]);
    const res = await postUpload(app, note.id, singleFileBody(oversized), { cookie });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("file_too_large");

    const allRows = await db.select().from(uploads).where(eq(uploads.noteId, note.id));
    expect(allRows).toHaveLength(0);
    expect(readdirSync(uploadsDir)).toHaveLength(0);
  }, 20_000);

  it("429：超過節流上限（per-user，覆寫成 limit:1 讓測試不必真的發 121 次請求）", async () => {
    const smallUploadLimiter = new FixedWindowLimiter({ limit: 1, windowMs: 600_000 });
    const { app, db } = await buildTestApp({
      limiters: {
        collabToken: new FixedWindowLimiter({ limit: 60, windowMs: 60_000 }),
        slugPatch: new FixedWindowLimiter({ limit: 10, windowMs: 600_000 }),
        upload: smallUploadLimiter,
        ai: new FixedWindowLimiter({ limit: 30, windowMs: 60_000 }),
        oidcLogin: new FixedWindowLimiter({ limit: 30, windowMs: 60_000 }),
        oidcCallback: new FixedWindowLimiter({ limit: 30, windowMs: 60_000 }),
        publicLink: new FixedWindowLimiter({ limit: 10, windowMs: 600_000 }),
      },
    });
    const owner = await insertUser(db, { email: "owner-429@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = await createNote(db, owner.id);

    const res1 = await postUpload(app, note.id, singleFileBody(PNG_BYTES), { cookie });
    expect(res1.statusCode).toBe(201);

    const res2 = await postUpload(app, note.id, singleFileBody(PNG_BYTES), { cookie });
    expect(res2.statusCode).toBe(429);
    expect(res2.json().error.code).toBe("too_many_requests");
  });

  // review 意見（Critical-1 附註）：這支用 `app.inject`（無真 socket），只能證明
  // 「早退 4xx 收到結構化 error body」——**不能**當成「連線沒有卡住」的證據（`inject`
  // 沒有真的 TCP 連線可以卡）。preHandler 這幾條早退分支（401/403/404/429）之所以在
  // 真 socket 上也沒事，是因為它們完全沒碰過 `request.parts()`，Node 自己的
  // `resOnFinish`／`_dump()` 機制會自動把未讀的 body 丟掉；真正需要真 socket 才量得出來
  // 的是「已經開始解析、又中途出錯」那條路徑，見下方「真 socket drain 驗證」。
  it("大 body + 早退 4xx（viewer 403，limiter/parts 都還沒碰到 body）仍收到結構化 error body", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-drain@example.com" });
    const viewer = await insertUser(db, { email: "viewer-drain@example.com" });
    const viewerCookie = await cookieFor(viewer.id);
    const note = await createNote(db, owner.id);
    await share(db, note.id, viewer.id, "viewer");

    // review fix round 1（M-1）：`2 * MAX_UPLOAD_BYTES` 剛好等於 cap，multipart 框線
    // 開銷（boundary/headers，實測約 147 bytes）會讓實際位元組數悄悄超過 cap，讓這支
    // 「under cap」迴歸測試意外跟 Task 9 的「over cap」測試撞在同一個分支——扣掉
    // 1 KiB 當緩衝，確定嚴格 under cap，讓新舊測試形成真正的 under/over 對照。
    const bigBody = singleFileBody(Buffer.alloc(2 * MAX_UPLOAD_BYTES - 1024, 0x42));
    const res = await postUpload(app, note.id, bigBody, { cookie: viewerCookie });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: "forbidden" } });
  }, 20_000);
});

// ───────────────────────────── Task 10b：GET /api/uploads/:id ─────────────────────────────

describe("GET /api/uploads/:id", () => {
  async function uploadOne(
    app: Awaited<ReturnType<typeof buildTestApp>>["app"],
    noteId: string,
    cookie: string
  ): Promise<{ id: string; url: string }> {
    const res = await postUpload(app, noteId, singleFileBody(PNG_BYTES), { cookie });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string; url: string };
  }

  it("200：Content-Type 為 DB mime、帶 nosniff + Cache-Control，位元組與原檔一致", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-get200@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = await createNote(db, owner.id);
    const { url } = await uploadOne(app, note.id, cookie);

    const res = await app.inject({ method: "GET", url, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("image/png");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["cache-control"]).toBe("private, max-age=31536000, immutable");
    expect(res.rawPayload.equals(PNG_BYTES)).toBe(true);
  });

  it("401：未登入", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-getunauth@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = await createNote(db, owner.id);
    const { url } = await uploadOne(app, note.id, cookie);

    const res = await app.inject({ method: "GET", url });
    expect(res.statusCode).toBe(401);
  });

  it("403：登入使用者對該筆記無權限（DB 有列，只是不能看）", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-get403@example.com" });
    const stranger = await insertUser(db, { email: "stranger-get403@example.com" });
    const ownerCookie = await cookieFor(owner.id);
    const strangerCookie = await cookieFor(stranger.id);
    const note = await createNote(db, owner.id);
    const { url } = await uploadOne(app, note.id, ownerCookie);

    const res = await app.inject({ method: "GET", url, cookies: { [SESSION_COOKIE]: strangerCookie } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("forbidden");
  });

  it("404：非 UUID 格式的 id", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-getnotuuid@example.com" });
    const cookie = await cookieFor(owner.id);

    const res = await app.inject({ method: "GET", url: "/api/uploads/not-a-uuid", cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("404：合法 UUID 但查無此上傳紀錄", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-getmissing@example.com" });
    const cookie = await cookieFor(owner.id);

    const res = await app.inject({
      method: "GET",
      url: "/api/uploads/33333333-3333-3333-3333-333333333333",
      cookies: { [SESSION_COOKIE]: cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("404：DB 有列但磁碟找不到對應檔案", async () => {
    const { app, db } = await buildTestApp();
    const owner = await insertUser(db, { email: "owner-getdiskmissing@example.com" });
    const cookie = await cookieFor(owner.id);
    const note = await createNote(db, owner.id);

    // 直接插一筆 uploads DB 列，不經過真實 POST（不落地任何磁碟檔案），模擬「DB 有紀錄、
    // 磁碟沒有對應檔案」（例如 volume 被清過、手動誤刪）。
    const [row] = await db
      .insert(uploads)
      .values({ noteId: note.id, uploaderId: owner.id, mime: "image/png", size: PNG_BYTES.length })
      .returning();

    const res = await app.inject({ method: "GET", url: `/api/uploads/${row.id}`, cookies: { [SESSION_COOKIE]: cookie } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });
});

// ───────────────────────────── Task 10b：真 socket drain 驗證（Critical-2 review）─────────────────────────────
//
// 這個 describe 專門補 `app.inject` 量不出來的那類 bug：`request.parts()` 已經開始消費
// （`request.pipe(bb)` 真的跑過），中途因為 parts/fields 超限而錯誤收尾——busboy 的
// `cleanup(err)` 只 `request.unpipe(bb)`，不會 `resume()` 剩餘 body。一旦解析真的開始過，
// Node 認定「應用層已接手消費這個 request」（`req._consuming`），關閉回應時的自動
// `_dump()`（丟棄未讀 body）機制就不會生效——這與「preHandler 完全沒碰過 body 就早退」
// （401/403/404/429）是不同的路徑：那幾條在真 socket 上也沒事（Node 自己會 dump），只有
// 「已經開始解析、又中途出錯」這條路徑需要我們自己補 `resume()`（見 `routes/uploads.ts`
// 的 catch 分支）。真 socket 才量得出「body 沒被讀完 → 連線卡住 → graceful shutdown
// （`app.close()`）吊死」，`app.inject` 的 payload 整包在記憶體、沒有真 TCP 連線可卡。
describe("Task 10b：真 socket drain 驗證（parts 超限走到 catch 分支，Critical-2 review）", () => {
  it(
    "400 invalid_body（33 個小 file part 觸發 parts 超限，後面還接一個 20MB 沒被解析到的 part）：" +
      "client 收到結構化 error body，且 server graceful shutdown（app.close()）在合理時間內完成——" +
      "不因為剩餘 body 未被 drain 而卡住（先 destroy client socket 才 close，避免 keep-alive 連線本身造成偽陽性）",
    async () => {
      const { app, db } = await buildTestApp();
      const owner = await insertUser(db, { email: "owner-realsocket-drain@example.com" });
      const cookie = await cookieFor(owner.id);
      const note = await createNote(db, owner.id);

      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("app.listen 後取不到 TCP 位址——真 socket 測試需要真的 port");
      }

      // 33 個小 file part（parts 上限 32，第 33 個觸發 partsLimit）+ 一個略小於 20MB 的
      // file part（絕對不會被解析到——parts 超限一觸發，busboy 立刻 unpipe，這個
      // part 的位元組原封不動留在 request 裡）。~20MB 是刻意選的量級：太小的話即使
      // 完全沒有 resume()，OS/Node 的 buffer 也可能剛好裝得下，觀察不到卡住。
      //
      // review fix round 1（M-1）：`20 * 1024 * 1024` 剛好等於 cap（`MAX_UPLOAD_BYTES *
      // 2`），33 個小 part 的 multipart 框線開銷（實測約 4.6 KB）會讓整包實際位元組數
      // 悄悄超過 cap，讓這支「under cap」regression 意外撞進 Task 9 的「over cap」分支
      // ——扣掉 64 KiB 當緩衝（遠大於實測開銷），確定嚴格 under cap。
      const bigTail = {
        name: "big",
        filename: "big.bin",
        contentType: "application/octet-stream",
        data: Buffer.alloc(20 * 1024 * 1024 - 64 * 1024, 0x41),
      };
      const body = buildMultipartBody([...manyFileParts(33), bigTail]);

      let socket: Socket | undefined;
      try {
        const res = await rawSocketPost({
          port: address.port,
          path: `/api/notes/${note.id}/uploads`,
          headers: { "content-type": `multipart/form-data; boundary=${BOUNDARY}`, cookie: `${SESSION_COOKIE}=${cookie}` },
          body,
        });
        socket = res.socket;

        expect(res.status).toBe(400);
        expect(JSON.parse(res.body)).toMatchObject({ error: { code: "invalid_body" } });
      } finally {
        // review 意見 2：先關 client 端連線，再關 server——否則即使 server 端完全正確
        // drain 了 body，client 自己留著的 keep-alive 連線一樣會讓 app.close() 卡住等它
        // 自然結束，把「與本測試無關的 keep-alive 存活」誤判成我們要抓的那個 bug。
        socket?.destroy();
      }

      const closeStart = Date.now();
      const CLOSE_TIMEOUT_MS = 10_000;
      await Promise.race([
        app.close(),
        new Promise((_resolve, reject) =>
          setTimeout(
            () => reject(new Error(`app.close() 逾時（${CLOSE_TIMEOUT_MS}ms）——剩餘 request body 未被 drain，連線卡住`)),
            CLOSE_TIMEOUT_MS
          )
        ),
      ]);
      expect(Date.now() - closeStart).toBeLessThan(CLOSE_TIMEOUT_MS);
    },
    30_000
  );
});

// ───────────────────────────── Task 9：drainWithCap 位元組上限（安全 backlog ③，spec §13.2）─────────────────────────────
//
// `app.inject` 量不出這裡要驗證的東西（沒有真 socket，`request.raw.destroy()` 對它
// 而言只是銷毀一個記憶體內的假流）——必須用真 socket。
//
// **實測過的時序（不是猜測）**：`drainWithCap(request)` 與緊接著的 `sendError(...)`
// 在同一個同步呼叫堆疊內執行、中間沒有 `await`；而掛 `data` listener 到真的開始收到
// 位元組（進而累計超過 cap、呼叫 `destroy()`）至少要等一輪事件迴圈。這代表「回應」
// 幾乎總是搶先「累計超限」完成寫入——**client 仍會收到完整、結構化的 403 body**（12.4
// 的承諾在這條早退分支上並未被破壞），這點與「body < cap」的既有迴歸測試結果一致，
// 不因為 body 超過 cap 而改變。
//
// 真正能觀察到的差異在**回應之後**：cap 的存在意義是避免對送出異常巨量 body 的 client
// 繼續無上限地耗用 server 資源——`destroy()` 讓這個連線**不維持 keep-alive**，client
// 端的 socket 會在很短時間內自己關閉，不像下方「body < cap」的既有測試那樣需要測試
// 自己主動 `socket.destroy()`（那些測試的既有註解明講：不這樣做的話 client 自己留著
// 的 keep-alive 連線會讓 `app.close()` 卡住等它自然結束）。這支測試斷言的就是這個
// 「自己關閉」的行為，並限定在遠低於 Node 預設 `keepAliveTimeout`（5000ms）的時間窗
// 內發生，藉此與「keep-alive 自然到期」區隔開來。
describe("Task 9：drainWithCap 位元組上限（真 socket，超過 cap 的早退 body）", () => {
  it(
    "viewer 403 早退（preHandler，尚未進入 multipart 解析）＋ body 明顯超過 cap（cap + 8MiB）：" +
      "回應仍完整送達（結構化 403 body，早於 drain 的非同步 destroy() 之前已送出），" +
      "但連線隨後被 server 端 destroy()、不維持 keep-alive——client 端 socket 在遠短於" +
      "keepAliveTimeout 的時間內自行關閉，不需要（也不是）測試主動 destroy",
    async () => {
      const { app, db } = await buildTestApp();
      const owner = await insertUser(db, { email: "owner-drain-overcap@example.com" });
      const viewer = await insertUser(db, { email: "viewer-drain-overcap@example.com" });
      const viewerCookie = await cookieFor(viewer.id);
      const note = await createNote(db, owner.id);
      await share(db, note.id, viewer.id, "viewer");

      await app.listen({ port: 0, host: "127.0.0.1" });
      const address = app.server.address();
      if (address === null || typeof address === "string") {
        throw new Error("app.listen 後取不到 TCP 位址——真 socket 測試需要真的 port");
      }

      // cap = MAX_UPLOAD_BYTES * 2（20 MiB）。這裡送一個明顯超過 cap 的 body
      // （cap + 8 MiB，留足夠 margin，不踩邊界湊巧值）。
      const overCapBody = singleFileBody(Buffer.alloc(2 * MAX_UPLOAD_BYTES + 8 * 1024 * 1024, 0x42));

      const res = await rawSocketPost({
        port: address.port,
        path: `/api/notes/${note.id}/uploads`,
        headers: {
          "content-type": `multipart/form-data; boundary=${BOUNDARY}`,
          cookie: `${SESSION_COOKIE}=${viewerCookie}`,
        },
        body: overCapBody,
      });

      // 回應本身：與「body < cap」的既有迴歸測試（526 行）同一條分支、同樣的斷言——
      // 超過 cap 不改變「早退仍收到結構化 error body」這個既有承諾。
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toMatchObject({ error: { code: "forbidden" } });

      // 連線隨後被 drainWithCap 的 destroy() 砍斷：client socket 應在遠短於 Node 預設
      // keepAliveTimeout（5000ms）的時間內自行 close——不是測試呼叫 socket.destroy()。
      // review fix round 1（L-2）：通過側實測 close 只要 ~22ms，800ms 仍留 20 倍以上
      // margin；同時把「真的卡住沒 destroy」這種失敗情境的偵測時間從原本 ~3s 壓到
      // ~800ms（4 倍），不必為了容錯犧牲太多回饋速度。
      const CLIENT_CLOSE_TIMEOUT_MS = 800;
      await new Promise<void>((resolve, reject) => {
        if (res.socket.destroyed) {
          resolve();
          return;
        }
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `client socket 未在 ${CLIENT_CLOSE_TIMEOUT_MS}ms 內自行關閉——drainWithCap 疑似沒有真的 destroy() 底層連線`
              )
            ),
          CLIENT_CLOSE_TIMEOUT_MS
        );
        res.socket.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      expect(res.socket.destroyed).toBe(true);

      // server 端的 destroy() 對 client 而言是硬中斷：如果 client 此時仍在寫入剩餘的
      // 大 body（CI 實測過的時序——本機 loopback 太快，通常整包已寫完才收到 destroy，
      // 這裡量不出來，見 rawSocketPost 的 `clientErrors` 註解），底層 socket 會收到
      // ECONNRESET／EPIPE。這是 destroy() 預期中的副作用，不是要擋下來的迴歸；只要
      // 真的發生，種類必須落在這個白名單內——其他錯誤代碼代表別的、意外的問題，
      // 不該被這支測試靜音掉。
      for (const err of res.clientErrors) {
        expect(["ECONNRESET", "EPIPE"]).toContain((err as NodeJS.ErrnoException).code);
      }

      // client 端此時已經自己關閉，不需要再 `socket.destroy()`；`app.close()` 應該
      // 立刻完成（沒有殘留連線可等）。
      const closeStart = Date.now();
      const CLOSE_TIMEOUT_MS = 10_000;
      await Promise.race([
        app.close(),
        new Promise((_resolve, reject) =>
          setTimeout(
            () => reject(new Error(`app.close() 逾時（${CLOSE_TIMEOUT_MS}ms）`)),
            CLOSE_TIMEOUT_MS
          )
        ),
      ]);
      expect(Date.now() - closeStart).toBeLessThan(CLOSE_TIMEOUT_MS);
    },
    30_000
  );
});
