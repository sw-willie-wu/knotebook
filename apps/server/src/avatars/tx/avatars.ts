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
 * OIDC 形的 `insertAvatarInTx`（輸入帶 `identityId`）：顯示圖與裁切為 NULL（待本人的瀏覽器補產），只算原圖的空間；
 * 自動選用＝`avatar_auto` 為 true 且此刻沒有目前頭貼，此時新候選就是目前頭貼、`avatar_auto` 維持 true；否則不是目前頭貼。
 * 這個形不改 `avatar_auto`（登入帶入不是使用者的選擇）。
 *
 * `replaceOidcAvatarInTx`：users 列鎖 → 重讀身分列（`FOR KEY SHARE`，不是這個人的或已不在 → `AvatarIdentityGone`，下載期間解除連結的情形）→
 * 該身分的候選 `FOR UPDATE`（不在 → 走 OIDC 形的 `insertAvatarInTx`）→ 原圖 sha256 相同：只改網址 → 不同：`assertSpaceRoomInTx`
 * （新原圖 − 舊原圖 − 舊顯示圖）、換原圖、清裁切與顯示圖、`version + 1`、「是否為目前頭貼」不動。回傳讓呼叫端在 commit 後刪對的檔。
 *
 * `updateAvatarDisplayInTx`：users 列鎖 → 測試縫 → 候選列 `FOR UPDATE`（不在或不是自己的 → `AvatarNotFound`）→ `version` 不符 → `AvatarOutdated`
 * → `assertSpaceRoomInTx`（新顯示圖 − 舊顯示圖；差額 ≤ 0 時該函式不取鎖，變小一定成功）→ UPDATE，`version + 1`。
 * `selectAvatarInTx`、`deleteAvatarInTx`：users 列鎖 → 測試縫 → 寫入；兩者都只讓用量減少或不變，不呼叫 `assertSpaceRoomInTx`。
 */
import { and, eq, sql } from "drizzle-orm";
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

/** OIDC 候選的寫入輸入（新增與替換共用）：只有原圖，沒有顯示圖與裁切。 */
export interface OidcAvatarInput {
  userId: string;
  identityId: string;
  /** 下載當下的 `picture` 值。 */
  oidcPictureUrl: string;
  /** 原圖在 uploads 目錄的檔名（新的 uuid）。 */
  originalFile: string;
  originalSha256: Buffer;
  originalMime: string;
  originalSize: number;
  lockTimeoutMs: number;
}

export type InsertOidcAvatarInput = OidcAvatarInput;
export type ReplaceOidcAvatarInput = OidcAvatarInput;

const isOidcInput = (input: InsertAvatarInput | InsertOidcAvatarInput): input is InsertOidcAvatarInput => "identityId" in input;

export async function insertAvatarInTx(tx: Tx, input: InsertAvatarInput | InsertOidcAvatarInput, hooks?: AvatarTestHooks): Promise<typeof userAvatars.$inferSelect> {
  const locked = await tx.select({ id: users.id, avatarAuto: users.avatarAuto }).from(users).where(eq(users.id, input.userId)).for("no key update");
  if (locked.length === 0) throw new TxAbort(404, "not_found", "No user with that id.");
  await hooks?.afterUserLock?.();
  // OIDC 形只有原圖（顯示圖待補），上傳形是原圖加顯示圖；空間判定只有這一處。
  const incoming = isOidcInput(input) ? input.originalSize : input.originalSize + input.displayData.length;
  await assertSpaceRoomInTx(tx, { kind: "user", id: input.userId }, incoming, { lockTimeoutMs: input.lockTimeoutMs });
  if (isOidcInput(input)) {
    // users 列鎖保證「此刻沒有目前頭貼」的判斷到 INSERT 之間沒有別人插進來。
    const [current] = await tx
      .select({ id: userAvatars.id })
      .from(userAvatars)
      .where(and(eq(userAvatars.userId, input.userId), eq(userAvatars.isCurrent, true)))
      .limit(1);
    const [oidcRow] = await tx
      .insert(userAvatars)
      .values({
        userId: input.userId,
        source: "oidc",
        identityId: input.identityId,
        oidcPictureUrl: input.oidcPictureUrl,
        originalFile: input.originalFile,
        originalSha256: input.originalSha256,
        originalMime: input.originalMime,
        originalSize: input.originalSize,
        isCurrent: locked[0]!.avatarAuto && current === undefined,
      })
      .returning();
    return oidcRow!;
  }
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

/** 來源身分已不在（下載期間被解除連結），或不是這個人的。 */
export class AvatarIdentityGone extends TxAbort {
  constructor() {
    super(404, "not_found", "That sign-in is no longer linked.");
    this.name = "AvatarIdentityGone";
  }
}

export type ReplaceOidcAvatarResult =
  /** 這個身分原本沒有候選，新插入一張。 */
  | { outcome: "inserted" }
  /** 原圖位元組不同，原地替換；`oldFile` 是被換掉的原圖檔名，commit 後刪。 */
  | { outcome: "replaced"; oldFile: string }
  /** 原圖位元組相同，只更新了網址；呼叫端刪掉剛寫的新檔。 */
  | { outcome: "same_bytes" }
  /** 沒有候選，而這個網址是使用者在下載期間刪掉的（`picture_dismissed_url`）：不插入，呼叫端刪掉新檔。 */
  | { outcome: "dismissed" };

/**
 * 登入帶入的 IdP 頭貼：這個身分已有候選就原地更新，沒有就新增。原圖檔已由呼叫端寫好；本交易任何拋出都由呼叫端 unlink 新檔。
 * 空間判定只在「換了原圖」的分支；沒有候選的分支交給 `insertAvatarInTx`（它自己判定）。
 */
export async function replaceOidcAvatarInTx(tx: Tx, input: ReplaceOidcAvatarInput, hooks?: AvatarTestHooks): Promise<ReplaceOidcAvatarResult> {
  const locked = await tx.select({ id: users.id }).from(users).where(eq(users.id, input.userId)).for("no key update");
  if (locked.length === 0) throw new TxAbort(404, "not_found", "No user with that id.");
  await hooks?.afterUserLock?.();
  // 重讀身分列並以 KEY SHARE 鎖住：之後的解除連結要等本交易結束，插入／更新候選的外鍵也不會撞上被刪的列。
  const identity = await tx
    .select({ id: userIdentities.id, pictureDismissedUrl: userIdentities.pictureDismissedUrl })
    .from(userIdentities)
    .where(and(eq(userIdentities.id, input.identityId), eq(userIdentities.userId, input.userId)))
    .for("key share");
  if (identity.length === 0) throw new AvatarIdentityGone();
  const [row] = await tx
    .select({ id: userAvatars.id, originalFile: userAvatars.originalFile, originalSize: userAvatars.originalSize, originalSha256: userAvatars.originalSha256, displaySize: userAvatars.displaySize })
    .from(userAvatars)
    .where(and(eq(userAvatars.identityId, input.identityId), eq(userAvatars.userId, input.userId)))
    .for("update");
  if (row === undefined) {
    // 下載期間使用者可能已重新取得又刪掉同一張：網址在身分列上，這裡重讀才看得到。
    if (identity[0]!.pictureDismissedUrl === input.oidcPictureUrl) return { outcome: "dismissed" };
    await insertAvatarInTx(tx, input);
    return { outcome: "inserted" };
  }
  if (row.originalSha256.equals(input.originalSha256)) {
    await tx
      .update(userAvatars)
      .set({ oidcPictureUrl: input.oidcPictureUrl })
      .where(and(eq(userAvatars.id, row.id), eq(userAvatars.userId, input.userId), eq(userAvatars.identityId, input.identityId)));
    return { outcome: "same_bytes" };
  }
  await assertSpaceRoomInTx(tx, { kind: "user", id: input.userId }, input.originalSize - row.originalSize - row.displaySize, { lockTimeoutMs: input.lockTimeoutMs });
  await tx
    .update(userAvatars)
    .set({
      oidcPictureUrl: input.oidcPictureUrl,
      originalFile: input.originalFile,
      originalSha256: input.originalSha256,
      originalMime: input.originalMime,
      originalSize: input.originalSize,
      originalWidth: null,
      originalHeight: null,
      cropX: null,
      cropY: null,
      cropSize: null,
      displayData: null,
      displayMime: null,
      displaySize: 0,
      version: sql`${userAvatars.version} + 1`,
    })
    .where(and(eq(userAvatars.id, row.id), eq(userAvatars.userId, input.userId), eq(userAvatars.identityId, input.identityId)));
  return { outcome: "replaced", oldFile: row.originalFile };
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
