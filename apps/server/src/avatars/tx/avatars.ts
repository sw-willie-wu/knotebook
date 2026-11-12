/**
 * 頭貼的寫入交易。只收 `tx`／純資料／型別明示測試縫，交易內不碰 pool。
 *
 * 鎖序：`users` 列（`FOR NO KEY UPDATE`）一律最先。同一個人的頭貼寫入因此被序列化——之後取的空間鎖（個人空間的
 * advisory 鎖）與候選列鎖，先後才不會在兩條請求之間成環。
 *
 * `insertAvatarInTx`：users 列鎖 → 測試縫 → `assertSpaceRoomInTx`（原圖＋顯示圖）→ 清掉目前頭貼的旗標 → INSERT
 * （新的一張就是目前頭貼）→ `avatar_auto = false`。部分唯一索引不能 DEFERRABLE，所以切換目前頭貼一定是「先清舊、再設新」兩句。
 * 原圖檔已由路由寫好；本交易任何拋出都由路由 unlink。
 *
 * `updateAvatarDisplayInTx`：users 列鎖 → 測試縫 → 候選列 `FOR UPDATE`（不在或不是自己的 → `AvatarNotFound`）→ `version` 不符 → `AvatarOutdated`
 * → `assertSpaceRoomInTx`（新顯示圖 − 舊顯示圖；差額 ≤ 0 時該函式不取鎖，變小一定成功）→ UPDATE，`version + 1`。
 * `selectAvatarInTx`、`deleteAvatarInTx`：users 列鎖 → 測試縫 → 寫入；兩者都只讓用量減少或不變，不呼叫 `assertSpaceRoomInTx`。
 */
import { and, eq } from "drizzle-orm";
import type { Tx } from "../../db/tx.js";
import { userAvatars, userIdentities, users } from "../../db/schema.js";
import { TxAbort } from "../../http/tx-abort.js";
import { assertSpaceRoomInTx } from "../../storage/tx/quota.js";

/** 頭貼候選不存在，或不屬於這個人（兩者同形，不洩漏別人的候選存不存在）。 */
export class AvatarNotFound extends TxAbort {
  constructor() {
    super(404, "not_found", "No avatar with that id.");
    this.name = "AvatarNotFound";
  }
}

/** 送出的 `version` 已不是目前版本（另一個分頁先補好了，或原圖剛被替換）。 */
export class AvatarOutdated extends TxAbort {
  constructor() {
    super(409, "avatar_outdated", "This avatar changed since you loaded it. Reload and try again.");
    this.name = "AvatarOutdated";
  }
}

/** 整合測試的交錯縫；生產不注入。 */
export interface AvatarTestHooks {
  /** users 列鎖已取得、其餘寫入尚未發生。 */
  afterUserLock?: () => Promise<void>;
}

export interface InsertAvatarInput {
  userId: string;
  /** 原圖在 uploads 目錄的檔名（新的 uuid，與列 id 脫鉤）。 */
  originalFile: string;
  originalSha256: Buffer;
  originalMime: string;
  originalSize: number;
  originalWidth: number;
  originalHeight: number;
  crop: { x: number; y: number; size: number };
  displayData: Buffer;
  displayMime: string;
  lockTimeoutMs: number;
}

export async function insertAvatarInTx(tx: Tx, input: InsertAvatarInput, hooks?: AvatarTestHooks): Promise<typeof userAvatars.$inferSelect> {
  const locked = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).for("no key update");
  if (locked.length === 0) throw new TxAbort(404, "not_found", "No user with that id.");
  await hooks?.afterUserLock?.();
  await assertSpaceRoomInTx(tx, { kind: "user", id: input.userId }, input.originalSize + input.displayData.length, { lockTimeoutMs: input.lockTimeoutMs });
  await tx.update(userAvatars).set({ isCurrent: false }).where(and(eq(userAvatars.userId, input.userId), eq(userAvatars.isCurrent, true)));
  const [row] = await tx
    .insert(userAvatars)
    .values({
      userId: input.userId,
      source: "upload",
      originalFile: input.originalFile,
      originalSha256: input.originalSha256,
      originalMime: input.originalMime,
      originalSize: input.originalSize,
      originalWidth: input.originalWidth,
      originalHeight: input.originalHeight,
      cropX: input.crop.x,
      cropY: input.crop.y,
      cropSize: input.crop.size,
      displayData: input.displayData,
      displayMime: input.displayMime,
      displaySize: input.displayData.length,
      isCurrent: true,
    })
    .returning();
  await tx.update(users).set({ avatarAuto: false }).where(eq(users.id, input.userId));
  return row!;
}

export interface UpdateAvatarDisplayInput {
  userId: string;
  avatarId: string;
  /** 呼叫端載入候選時看到的版本；與列上的不同＝期間有人換過原圖或顯示圖。 */
  version: number;
  crop: { x: number; y: number; size: number };
  originalWidth: number;
  originalHeight: number;
  displayData: Buffer;
  displayMime: string;
  lockTimeoutMs: number;
}

/** 重新裁切，或替待補顯示圖的候選補產顯示圖。原圖與「是否為目前頭貼」都不動。 */
export async function updateAvatarDisplayInTx(tx: Tx, input: UpdateAvatarDisplayInput, hooks?: AvatarTestHooks): Promise<void> {
  const locked = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).for("no key update");
  if (locked.length === 0) throw new TxAbort(404, "not_found", "No user with that id.");
  await hooks?.afterUserLock?.();
  const [row] = await tx
    .select({ version: userAvatars.version, displaySize: userAvatars.displaySize })
    .from(userAvatars)
    .where(and(eq(userAvatars.id, input.avatarId), eq(userAvatars.userId, input.userId)))
    .for("update");
  if (row === undefined) throw new AvatarNotFound();
  if (row.version !== input.version) throw new AvatarOutdated();
  await assertSpaceRoomInTx(tx, { kind: "user", id: input.userId }, input.displayData.length - row.displaySize, { lockTimeoutMs: input.lockTimeoutMs });
  await tx
    .update(userAvatars)
    .set({
      cropX: input.crop.x,
      cropY: input.crop.y,
      cropSize: input.crop.size,
      originalWidth: input.originalWidth,
      originalHeight: input.originalHeight,
      displayData: input.displayData,
      displayMime: input.displayMime,
      displaySize: input.displayData.length,
      version: row.version + 1,
    })
    .where(and(eq(userAvatars.id, input.avatarId), eq(userAvatars.userId, input.userId)));
}

export interface SelectAvatarInput {
  userId: string;
  /** `null`＝不使用任何候選。 */
  candidateId: string | null;
}

/** 選用一張候選（或 `null`＝都不用）。目標不是自己的候選 → `AvatarNotFound`，整筆回滾（原本的目前頭貼不變）。 */
export async function selectAvatarInTx(tx: Tx, input: SelectAvatarInput, hooks?: AvatarTestHooks): Promise<void> {
  const locked = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).for("no key update");
  if (locked.length === 0) throw new TxAbort(404, "not_found", "No user with that id.");
  await hooks?.afterUserLock?.();
  await tx.update(userAvatars).set({ isCurrent: false }).where(and(eq(userAvatars.userId, input.userId), eq(userAvatars.isCurrent, true)));
  if (input.candidateId !== null) {
    const set = await tx
      .update(userAvatars)
      .set({ isCurrent: true })
      .where(and(eq(userAvatars.id, input.candidateId), eq(userAvatars.userId, input.userId)))
      .returning({ id: userAvatars.id });
    if (set.length === 0) throw new AvatarNotFound();
  }
  await tx.update(users).set({ avatarAuto: false }).where(eq(users.id, input.userId));
}

export interface DeleteAvatarInput {
  userId: string;
  avatarId: string;
}

/**
 * 刪一張候選。OIDC 候選順便把它的圖片網址記進來源身分（之後登入帶同一個網址就不再自動下載）；刪的是目前那張 →
 * `avatar_auto = false`，不自動改選別張。回原圖檔名，由路由在 commit 後 best-effort 刪檔。
 */
export async function deleteAvatarInTx(tx: Tx, input: DeleteAvatarInput, hooks?: AvatarTestHooks): Promise<{ originalFile: string }> {
  const locked = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).for("no key update");
  if (locked.length === 0) throw new TxAbort(404, "not_found", "No user with that id.");
  await hooks?.afterUserLock?.();
  const [row] = await tx
    .delete(userAvatars)
    .where(and(eq(userAvatars.id, input.avatarId), eq(userAvatars.userId, input.userId)))
    .returning({ originalFile: userAvatars.originalFile, isCurrent: userAvatars.isCurrent, identityId: userAvatars.identityId, oidcPictureUrl: userAvatars.oidcPictureUrl });
  if (row === undefined) throw new AvatarNotFound();
  if (row.identityId !== null && row.oidcPictureUrl !== null) {
    await tx
      .update(userIdentities)
      .set({ pictureDismissedUrl: row.oidcPictureUrl })
      .where(and(eq(userIdentities.id, row.identityId), eq(userIdentities.userId, input.userId)));
  }
  if (row.isCurrent) await tx.update(users).set({ avatarAuto: false }).where(eq(users.id, input.userId));
  return { originalFile: row.originalFile };
}
