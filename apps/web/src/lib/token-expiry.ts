import type { ApiTokenDto } from "@knotebook/shared";

/** 列表上「到期」欄用的時間（spec #298 §3.2）：PAT＝建立時選的期限；oauth＝最後使用（沒用過則建立時）＋idleDays。 */
export function displayExpiry(
  token: Pick<ApiTokenDto, "kind" | "lastUsedAt" | "createdAt" | "expiresAt">,
  idleDays: number
): string | null {
  if (token.kind === "pat") return token.expiresAt;
  return new Date(Date.parse(token.lastUsedAt ?? token.createdAt) + idleDays * 86_400_000).toISOString();
}
