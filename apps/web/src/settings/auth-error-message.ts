import { ApiFail } from "@/api/client";

/** ApiFail → errors.<code>；其餘 → errors.fallback。`/admin/auth` 的頁與 dialog 兩檔共用（各自 import，不互相 import）。 */
export function authErrorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}
