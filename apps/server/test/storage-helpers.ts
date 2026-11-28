// Uploads always go through the real route; the attachment size can be set exactly: PNG signature 8 bytes + padding (`detectRasterImageMimeType` accepts only the full signature).
import { readdir, writeFile } from "node:fs/promises";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Pool } from "pg";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/index.js";
import { groups, storagePlans, uploads, users } from "../src/db/schema.js";
import { uploadFilePath } from "../src/uploads/service.js";
import { cookieOf } from "./group-helpers.js";

export const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function pngOf(size: number): Buffer {
  if (size < PNG_SIG.length) throw new Error(`pngOf: size ${size} < 8`);
  return Buffer.concat([PNG_SIG, Buffer.alloc(size - PNG_SIG.length, 0x41)]);
}

export const QUOTA_BOUNDARY = "kbQuotaBoundary";

export function multipartFile(bytes: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(`--${QUOTA_BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`, "utf-8"),
    bytes,
    Buffer.from(`\r\n--${QUOTA_BOUNDARY}--\r\n`, "utf-8"),
  ]);
}

export async function upload(app: FastifyInstance, noteId: string, userId: string, size: number): Promise<LightMyRequestResponse> {
  return app.inject({
    method: "POST",
    url: `/api/notes/${noteId}/uploads`,
    payload: multipartFile(pngOf(size)),
    headers: { "content-type": `multipart/form-data; boundary=${QUOTA_BOUNDARY}` },
    cookies: await cookieOf(userId),
  });
}

export async function seedPlan(db: Db, name: string, quotaBytes: number | null): Promise<string> {
  const [p] = await db.insert(storagePlans).values({ name, quotaBytes }).returning({ id: storagePlans.id });
  return p!.id;
}

export async function basicPlanId(db: Db): Promise<string> {
  const [p] = await db.select({ id: storagePlans.id }).from(storagePlans).where(eq(storagePlans.name, "Basic"));
  return p!.id;
}

export async function setUserPlan(db: Db, userId: string, planId: string): Promise<void> {
  await db.update(users).set({ storagePlanId: planId }).where(eq(users.id, userId));
}

export async function setGroupPlan(db: Db, groupId: string, planId: string): Promise<void> {
  await db.update(groups).set({ storagePlanId: planId }).where(eq(groups.id, groupId));
}

export async function giveUserQuota(db: Db, userId: string, quotaBytes: number | null): Promise<string> {
  const id = await seedPlan(db, `u-${userId.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`, quotaBytes);
  await setUserPlan(db, userId, id);
  return id;
}
export async function giveGroupQuota(db: Db, groupId: string, quotaBytes: number | null): Promise<string> {
  const id = await seedPlan(db, `g-${groupId.slice(0, 8)}-${Math.random().toString(36).slice(2, 8)}`, quotaBytes);
  await setGroupPlan(db, groupId, id);
  return id;
}

/** Inserts an attachment row directly: DB `size` is arbitrary (the total can exceed 2 GiB), a small PNG is written to disk (unless `noFile`). Returns the upload id. */
export async function seedAttachment(
  db: Db, uploadsDir: string, noteId: string, uploaderId: string, size: number, opts: { noFile?: boolean } = {},
): Promise<string> {
  const [u] = await db.insert(uploads).values({ noteId, uploaderId, mime: "image/png", size }).returning({ id: uploads.id });
  if (!opts.noFile) await writeFile(uploadFilePath(uploadsDir, u!.id), pngOf(12));
  return u!.id;
}

/** Live usage (raw SQL, independent of the code under test). */
export async function usedOf(pool: Pool, space: { kind: "user" | "group"; id: string }): Promise<number> {
  const col = space.kind === "user" ? "owner_id" : "group_id";
  const { rows } = await pool.query<{ s: string }>(
    `select coalesce(sum(u.size), 0)::bigint::text s from uploads u join notes n on n.id = u.note_id where n.${col} = $1`, [space.id],
  );
  return Number(rows[0]!.s);
}

export const filesIn = async (dir: string): Promise<string[]> => (await readdir(dir)).sort();

export const quotaBody = (storage: Record<string, unknown>) => ({
  error: { code: "storage_quota_exceeded", message: "This space's storage quota is full." },
  storage,
});

export async function waitForAdvisoryWaiters(pool: Pool, n: number, timeoutMs = 5_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let seen = 0;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory'`,
    );
    seen = rows[0]!.n;
    if (seen >= n) return seen;
    await new Promise(r => setTimeout(r, 20));
  }
  return seen;
}
