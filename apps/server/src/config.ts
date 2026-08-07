import { z } from "zod";
const schema = z.object({
  DATABASE_URL: z.string().url("DATABASE_URL 必須是有效的 PostgreSQL URL（如 postgres://user:pass@host:5432/dbname）").refine(
    url => url.startsWith("postgres://") || url.startsWith("postgresql://"),
    "DATABASE_URL 必須以 postgres:// 或 postgresql:// 開頭"
  ),
  APP_SECRET: z.string().regex(/^[0-9a-fA-F]{64,}$/, "APP_SECRET 需 ≥64 hex 字元；用 `openssl rand -hex 32` 產生"),
  PUBLIC_URL: z.string().url("PUBLIC_URL 必須是有效的 http/https URL"),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional().or(z.literal("").transform(() => undefined)),
});
export interface AppConfig { databaseUrl: string; appSecret: string; publicUrl: URL; cookieSecure: boolean; insecureHttpWarning: boolean; bootstrapAdminEmail?: string }
export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const r = schema.safeParse(env);
  if (!r.success) throw new Error("設定錯誤：" + r.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join("; "));
  const publicUrl = new URL(r.data.PUBLIC_URL);
  if (!["http:", "https:"].includes(publicUrl.protocol))
    throw new Error("PUBLIC_URL 必須是 http/https URL");
  // spec rev 5.6：非 localhost 的 http:// PUBLIC_URL 不再拒絕啟動——trusted-LAN
  // plain-http 是支援的部署拓撲之一（bind 0.0.0.0，PUBLIC_URL=http://<lan-ip>:3000）。
  // 改成回傳 insecureHttpWarning=true，讓 index.ts 在啟動時印一次醒目警告；
  // cookieSecure 的推導不變（http 一律 non-Secure，不論 host）。
  const isLocalHttp = publicUrl.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(publicUrl.hostname);
  const insecureHttpWarning = publicUrl.protocol === "http:" && !isLocalHttp;
  return { databaseUrl: r.data.DATABASE_URL, appSecret: r.data.APP_SECRET, publicUrl,
           cookieSecure: publicUrl.protocol === "https:", insecureHttpWarning, bootstrapAdminEmail: r.data.BOOTSTRAP_ADMIN_EMAIL };
}
