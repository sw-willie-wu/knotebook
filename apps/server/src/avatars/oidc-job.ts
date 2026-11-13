/**
 * 登入後的 IdP 頭貼背景工作：把 `picture` 下載成這個身分的 OIDC 候選（新增，或原地更新）。
 *
 * - 登入流程只呼叫 `scheduleOidcAvatarJob`：它同步回傳、不等下載，任何失敗都不影響登入（下載、解碼、配額都可能失敗，
 *   結果只是沒有頭貼）。
 * - `runOidcAvatarJob` 是實際流程，匯出供測試直接 await。同一使用者同一身分同時只跑一個（行程內去重）；後來的略過。
 * - 順序：查身分列 → 記下 `last_picture_url`（先於去重判斷，被略過的呼叫也會記）→ 沒有 `picture` 就結束 → 已有候選且網址相同就結束；沒有候選但這個網址是使用者
 *   刪掉過的（`picture_dismissed_url`）就結束 → 個人空間已滿就結束 → 下載 → 先落檔（`.tmp` 再 rename）→ 交易
 *   （`replaceOidcAvatarInTx`；交易內也會重查「刪掉過的網址」，下載期間才刪掉的不會被補回來）→ commit 後刪不再需要的檔（被換掉的舊原圖，或位元組相同時剛寫的新檔）。任何失敗都刪新檔。
 * - 記錄只寫 `{ userId, identityId, reason }`：圖片網址可能帶 token，連同底層錯誤的訊息都不進 log、不進回傳值；
 *   資料庫錯誤只留 `name` 與 SQLSTATE（原始錯誤會帶 SQL 參數）。
 * - 檢查之後、下載之前與之後使用者都可能解除連結：交易內重讀身分列，不在就丟棄（`unlinked`），不留候選也不留檔。
 */
import { createHash, randomUUID } from "node:crypto";
import { rename, unlink, writeFile } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import type { UserGate } from "../auth/session.js";
import type { Db } from "../db/index.js";
import { pgErrorSummary } from "../db/pg-errors.js";
import { userAvatars, userIdentities } from "../db/schema.js";
import { StorageQuotaExceeded } from "../storage/tx/quota.js";
import { isSpaceFull, readSpaceUsage } from "../storage/usage.js";
import { uploadFilePath } from "../uploads/service.js";
import { fetchOidcAvatar, PRODUCTION_AVATAR_FETCH_POLICY, type AvatarFetchFailure, type AvatarFetchPolicy } from "./oidc-fetch.js";
import { AvatarIdentityGone, replaceOidcAvatarInTx, type AvatarTestHooks, type ReplaceOidcAvatarResult } from "./tx/avatars.js";

export type OidcAvatarJobReason =
  | AvatarFetchFailure
  | "no_identity"
  | "no_picture"
  | "same_url"
  | "dismissed"
  | "in_flight"
  | "quota"
  | "unlinked"
  | "error";

export interface OidcAvatarJobResult {
  userId: string;
  identityId: string | null;
  outcome: ReplaceOidcAvatarResult["outcome"] | "skipped" | "failed";
  reason?: OidcAvatarJobReason;
}

export interface OidcAvatarJobHooks {
  /** 工作結束（成功、略過或失敗）時呼叫；只給測試等待用，生產不注入。 */
  onSettled?: (result: OidcAvatarJobResult) => void;
}

export interface OidcAvatarJobDeps {
  db: Db;
  /** commit 後讓 `UserDto.avatar` 的快取失效。 */
  gate: Pick<UserGate, "invalidate">;
  uploadsDir: string;
  storageLockTimeoutMs: number;
  /** 預設 `PRODUCTION_AVATAR_FETCH_POLICY`；只有測試會換。 */
  avatarFetchPolicy?: AvatarFetchPolicy;
  avatarJobHooks?: OidcAvatarJobHooks;
  /** 交易交錯縫；生產不注入。 */
  avatarTestHooks?: AvatarTestHooks;
  log: { info(obj: object, msg: string): void };
}

export interface OidcAvatarJobArgs {
  userId: string;
  issuer: string;
  sub: string;
  /** 已過 `parsePictureClaim` 的網址；沒有就 `null`。 */
  picture: string | null;
}

/** 行程內進行中的工作，鍵＝`${userId}:${identityId}`。 */
const inFlight = new Map<string, Promise<OidcAvatarJobResult>>();

/** 登入流程用：只排程、不 await；失敗與例外都不外洩。 */
export function scheduleOidcAvatarJob(deps: OidcAvatarJobDeps, args: OidcAvatarJobArgs): void {
  setImmediate(() => {
    runOidcAvatarJob(deps, args).catch(() => {
      // 內部已把所有失敗收成結果並記錄；這裡只擋住 `onSettled` 之類測試縫丟出的例外。
    });
  });
}

export async function runOidcAvatarJob(deps: OidcAvatarJobDeps, args: OidcAvatarJobArgs): Promise<OidcAvatarJobResult> {
  let identityId: string | null = null;
  let result: OidcAvatarJobResult;
  try {
    const [identity] = await deps.db
      .select({ id: userIdentities.id, pictureDismissedUrl: userIdentities.pictureDismissedUrl })
      .from(userIdentities)
      .where(and(eq(userIdentities.issuer, args.issuer), eq(userIdentities.sub, args.sub), eq(userIdentities.userId, args.userId)));
    if (identity === undefined) {
      result = { userId: args.userId, identityId: null, outcome: "skipped", reason: "no_identity" };
    } else {
      identityId = identity.id;
      // 每次登入都記，連同被去重略過的那次：進行中的工作與後到的各寫一次，最後寫的就是最新的值。
      await deps.db
        .update(userIdentities)
        .set({ lastPictureUrl: args.picture })
        .where(and(eq(userIdentities.id, identity.id), eq(userIdentities.userId, args.userId)));
      const key = `${args.userId}:${identity.id}`;
      if (inFlight.has(key)) {
        result = { userId: args.userId, identityId, outcome: "skipped", reason: "in_flight" };
      } else {
        // `has` 與 `set` 之間沒有 await：後到的呼叫一定看得到這一筆。
        const running = processJob(deps, args, identity.id, identity.pictureDismissedUrl);
        inFlight.set(key, running);
        try {
          result = await running;
        } finally {
          inFlight.delete(key);
        }
      }
    }
  } catch (err) {
    result = fail(deps, args.userId, identityId, "error", err);
  }
  deps.avatarJobHooks?.onSettled?.(result);
  return result;
}

function fail(deps: OidcAvatarJobDeps, userId: string, identityId: string | null, reason: OidcAvatarJobReason, err?: unknown): OidcAvatarJobResult {
  const extra = reason === "error" ? { name: err instanceof Error ? err.name : typeof err, code: pgErrorSummary(err).code } : {};
  deps.log.info({ userId, identityId, reason, ...extra }, "頭貼背景工作沒有完成");
  return { userId, identityId, outcome: "failed", reason };
}

async function processJob(deps: OidcAvatarJobDeps, args: OidcAvatarJobArgs, identityId: string, dismissedUrl: string | null): Promise<OidcAvatarJobResult> {
  const { userId, picture } = args;
  const skipped = (reason: OidcAvatarJobReason): OidcAvatarJobResult => ({ userId, identityId, outcome: "skipped", reason });
  if (picture === null) return skipped("no_picture");

  const [candidate] = await deps.db
    .select({ id: userAvatars.id, oidcPictureUrl: userAvatars.oidcPictureUrl })
    .from(userAvatars)
    .where(and(eq(userAvatars.identityId, identityId), eq(userAvatars.userId, userId)));
  if (candidate !== undefined && candidate.oidcPictureUrl === picture) return skipped("same_url");
  if (candidate === undefined && picture === dismissedUrl) return skipped("dismissed");

  if (isSpaceFull(await readSpaceUsage(deps.db, { kind: "user", id: userId }))) return fail(deps, userId, identityId, "quota");

  const fetched = await fetchOidcAvatar(picture, { issuer: args.issuer, policy: deps.avatarFetchPolicy ?? PRODUCTION_AVATAR_FETCH_POLICY });
  if (!fetched.ok) return fail(deps, userId, identityId, fetched.reason);

  const originalFile = randomUUID();
  const finalPath = uploadFilePath(deps.uploadsDir, originalFile);
  const tempPath = `${finalPath}.tmp`;
  const removeNewFile = async (): Promise<void> => {
    await unlink(tempPath).catch(() => {});
    await unlink(finalPath).catch(() => {});
  };
  try {
    await writeFile(tempPath, fetched.bytes);
    await rename(tempPath, finalPath);
  } catch (err) {
    await removeNewFile();
    return fail(deps, userId, identityId, "error", err);
  }

  let outcome: ReplaceOidcAvatarResult;
  try {
    const input = {
      userId,
      identityId,
      oidcPictureUrl: picture,
      originalFile,
      originalSha256: createHash("sha256").update(fetched.bytes).digest(),
      originalMime: fetched.mime,
      originalSize: fetched.bytes.length,
      lockTimeoutMs: deps.storageLockTimeoutMs,
    };
    outcome = await deps.db.transaction(tx => replaceOidcAvatarInTx(tx, input, deps.avatarTestHooks));
  } catch (err) {
    await removeNewFile();
    if (err instanceof AvatarIdentityGone) return fail(deps, userId, identityId, "unlinked");
    if (err instanceof StorageQuotaExceeded) return fail(deps, userId, identityId, "quota");
    return fail(deps, userId, identityId, "error", err);
  }

  // commit 之後：位元組相同就丟掉剛寫的新檔；原地替換就刪被換掉的舊檔。刪不掉只是多一個孤兒檔。
  if (outcome.outcome === "dismissed") {
    await removeNewFile();
    return skipped("dismissed");
  }
  if (outcome.outcome === "same_bytes") await removeNewFile();
  else if (outcome.outcome === "replaced") await unlink(uploadFilePath(deps.uploadsDir, outcome.oldFile)).catch(() => {});
  if (outcome.outcome !== "same_bytes") deps.gate.invalidate(userId);
  return { userId, identityId, outcome: outcome.outcome };
}
