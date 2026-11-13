import { asc, desc, eq, sql } from "drizzle-orm";
import type { AvatarCandidateDto, AvatarListDto } from "@knotebook/shared";
import { enabledProvidersWithIssuer } from "../auth/sign-in-methods.js";
import type { DbOrTx } from "../db/tx.js";
import { userAvatars, userIdentities, users } from "../db/schema.js";

/** 組 `AvatarCandidateDto` 需要的欄位（不含顯示圖本體：`pending` 由呼叫端依 `display_data` 是否為 NULL 給）。 */
export interface AvatarRowForDto {
  id: string;
  source: string;
  version: number;
  pending: boolean;
  isCurrent: boolean;
  cropX: number | null;
  cropY: number | null;
  cropSize: number | null;
  originalWidth: number | null;
  originalHeight: number | null;
  originalSize: number;
  displaySize: number;
  createdAt: Date;
}

export function toCandidateDto(row: AvatarRowForDto, providerName: string | null): AvatarCandidateDto {
  return {
    id: row.id,
    source: row.source === "oidc" ? "oidc" : "upload",
    providerName,
    avatar: { id: row.id, v: row.version },
    pending: row.pending,
    current: row.isCurrent,
    crop: row.cropX !== null && row.cropY !== null && row.cropSize !== null ? { x: row.cropX, y: row.cropY, size: row.cropSize } : null,
    originalWidth: row.originalWidth,
    originalHeight: row.originalHeight,
    originalSize: row.originalSize,
    displaySize: row.displaySize,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * 我的候選（新到舊）、是否自動帶入 OIDC 頭貼，以及可手動重新抓取的身分。
 * 登入服務顯示名依「身分的 issuer ＝ 啟用中登入服務的 effective issuer」對（同 `GET /api/auth/identities`）；
 * 對不到的候選顯示名為 null，對不到的身分不列入 `refreshable`。
 */
export async function listAvatars(db: DbOrTx, userId: string): Promise<AvatarListDto> {
  const [me] = await db.select({ auto: users.avatarAuto }).from(users).where(eq(users.id, userId));
  const rows = await db
    .select({
      id: userAvatars.id,
      source: userAvatars.source,
      identityId: userAvatars.identityId,
      version: userAvatars.version,
      pending: sql<boolean>`${userAvatars.displayData} is null`,
      isCurrent: userAvatars.isCurrent,
      cropX: userAvatars.cropX,
      cropY: userAvatars.cropY,
      cropSize: userAvatars.cropSize,
      originalWidth: userAvatars.originalWidth,
      originalHeight: userAvatars.originalHeight,
      originalSize: userAvatars.originalSize,
      displaySize: userAvatars.displaySize,
      createdAt: userAvatars.createdAt,
    })
    .from(userAvatars)
    .where(eq(userAvatars.userId, userId))
    .orderBy(desc(userAvatars.createdAt), desc(userAvatars.id));
  const identities = await db
    .select({ id: userIdentities.id, issuer: userIdentities.issuer, lastPictureUrl: userIdentities.lastPictureUrl })
    .from(userIdentities)
    .where(eq(userIdentities.userId, userId))
    .orderBy(asc(userIdentities.createdAt), asc(userIdentities.id));
  const enabled = await enabledProvidersWithIssuer(db);
  const providerNameOf = (issuer: string): string | null => enabled.find(p => p.effectiveIssuer === issuer)?.displayName ?? null;
  const issuerOf = new Map(identities.map(i => [i.id, i.issuer]));
  const withCandidate = new Set(rows.flatMap(r => (r.identityId !== null ? [r.identityId] : [])));

  const refreshable: AvatarListDto["refreshable"] = [];
  for (const i of identities) {
    if (i.lastPictureUrl === null || withCandidate.has(i.id)) continue;
    const providerName = providerNameOf(i.issuer);
    if (providerName !== null) refreshable.push({ identityId: i.id, providerName });
  }
  return {
    candidates: rows.map(r => {
      const issuer = r.identityId !== null ? issuerOf.get(r.identityId) : undefined;
      return toCandidateDto(r, issuer !== undefined ? providerNameOf(issuer) : null);
    }),
    auto: me?.auto ?? true,
    refreshable,
  };
}
