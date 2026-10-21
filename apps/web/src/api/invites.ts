import type { UserDto } from "@knotebook/shared";
import { api } from "./client";

/** #285 §5：不消耗邀請，回到期時間。token 只走 POST body，不進網址與 queryKey。 */
export function inspectInvite(token: string): Promise<{ expiresAt: string }> {
  return api<{ expiresAt: string }>("/api/auth/invite/inspect", { method: "POST", body: JSON.stringify({ token }) });
}

/** #285 §5：兌換邀請建立帳號；成功時 server 一併設好 session cookie。 */
export function acceptInvite(body: { token: string; email: string; password: string; displayName?: string }): Promise<UserDto> {
  return api<UserDto>("/api/auth/invite/accept", { method: "POST", body: JSON.stringify(body) });
}
