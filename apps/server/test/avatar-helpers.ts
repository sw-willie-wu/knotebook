/**
 * 頭貼整合測試共用的種子。直插只在測試裡；真路由的行為由各自的測試檔守。
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Db } from "../src/db/index.js";
import { userAvatars } from "../src/db/schema.js";
import { cookieOf } from "./group-helpers.js";
import { ICON_BOUNDARY, WEBP_BYTES, multipartBody, type IconPart } from "./helpers/provider-icon.js";
import { pngOf } from "./storage-helpers.js";

export interface SeedAvatarOpts {
  userId: string;
  /** 原圖位元組數（落在 `original_size` 的 CHECK 範圍內：1 ~ 10 MiB）。 */
  originalSize: number;
  /** 顯示圖位元組數；0＝顯示圖尚未補產（只有 OIDC 候選有這個狀態）。 */
  displaySize: number;
  isCurrent?: boolean;
  /** OIDC 候選（`displaySize` 為 0）的來源身分。 */
  identityId?: string;
}

/** 直插一列頭貼；回列 id。顯示圖大於 0 → 上傳來源；等於 0 → OIDC 候選（待補產）。 */
export async function seedAvatarRow(db: Db, o: SeedAvatarOpts): Promise<string> {
  const pending = o.displaySize === 0;
  const [row] = await db
    .insert(userAvatars)
    .values({
      userId: o.userId,
      source: pending ? "oidc" : "upload",
      identityId: pending ? (o.identityId ?? null) : null,
      oidcPictureUrl: pending ? `https://idp.example.com/pic/${randomUUID()}` : null,
      originalFile: randomUUID(),
      originalSha256: randomBytes(32),
      originalMime: "image/png",
      originalSize: o.originalSize,
      displayData: pending ? null : Buffer.alloc(o.displaySize, 0x41),
      displayMime: pending ? null : "image/webp",
      displaySize: o.displaySize,
      isCurrent: o.isCurrent ?? false,
    })
    .returning({ id: userAvatars.id });
  return row!.id;
}

/** 恰 `size` bytes、可被偵測為 WebP 的顯示圖（`WEBP_BYTES` 加填充）。 */
export function webpOf(size: number): Buffer {
  if (size < WEBP_BYTES.length) throw new Error(`webpOf: size ${size} < ${WEBP_BYTES.length}`);
  return Buffer.concat([WEBP_BYTES, Buffer.alloc(size - WEBP_BYTES.length, 0x42)]);
}

export const DEFAULT_CROP = { x: 4, y: 8, size: 64, width: 128, height: 96 };

export interface AvatarUploadOpts {
  /** 原圖位元組；`null`＝不送這個 part。預設 2000 bytes 的 PNG。 */
  original?: Buffer | null;
  /** 顯示圖位元組；`null`＝不送這個 part。預設 300 bytes 的 WebP。 */
  display?: Buffer | null;
  /** 物件→JSON 字串；字串→原樣；`null`＝不送 `crop` 欄。 */
  crop?: Record<string, unknown> | string | null;
  /** `null`＝不帶 cookie（未登入）。 */
  cookies?: Record<string, string> | null;
  headers?: Record<string, string>;
}

export function avatarUploadBody(opts: AvatarUploadOpts = {}): Buffer {
  const parts: IconPart[] = [];
  const original = opts.original === undefined ? pngOf(2000) : opts.original;
  const display = opts.display === undefined ? webpOf(300) : opts.display;
  const crop = opts.crop === undefined ? DEFAULT_CROP : opts.crop;
  if (original !== null) parts.push({ name: "original", filename: "photo.png", contentType: "image/png", data: original });
  if (display !== null) parts.push({ name: "display", filename: "avatar.webp", contentType: "image/webp", data: display });
  if (crop !== null) parts.push({ name: "crop", data: typeof crop === "string" ? crop : JSON.stringify(crop) });
  return multipartBody(parts);
}

/** `POST /api/auth/avatars`（真路由）；`userId` 以該人的 session 送出。 */
export async function uploadAvatar(app: FastifyInstance, userId: string, opts: AvatarUploadOpts = {}) {
  const cookies = opts.cookies === undefined ? await cookieOf(userId) : opts.cookies;
  return app.inject({
    method: "POST",
    url: "/api/auth/avatars",
    payload: avatarUploadBody(opts),
    ...(cookies !== null ? { cookies } : {}),
    headers: { "content-type": `multipart/form-data; boundary=${ICON_BOUNDARY}`, ...opts.headers },
  });
}
