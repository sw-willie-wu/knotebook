import type { UserDto } from "@knotebook/shared";
import { api } from "./client";

/** #286 §4.3：不消耗連結，回帳號 email 與到期時間。token 只走 POST body，不進網址與 queryKey。 */
export function inspectPasswordReset(token: string): Promise<{ email: string; expiresAt: string }> {
  return api<{ email: string; expiresAt: string }>("/api/auth/password-reset/inspect", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
}

/** #286 §4.3：設定新密碼；成功時 server 一併設好 session cookie。 */
export function completePasswordReset(token: string, newPassword: string): Promise<UserDto> {
  return api<UserDto>("/api/auth/password-reset", { method: "POST", body: JSON.stringify({ token, newPassword }) });
}
