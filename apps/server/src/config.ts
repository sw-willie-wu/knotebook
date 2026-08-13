import { z } from "zod";
import { MIN_PASSWORD_LENGTH } from "./auth/constants.js";
const schema = z.object({
  DATABASE_URL: z.string().url("DATABASE_URL 必須是有效的 PostgreSQL URL（如 postgres://user:pass@host:5432/dbname）").refine(
    url => url.startsWith("postgres://") || url.startsWith("postgresql://"),
    "DATABASE_URL 必須以 postgres:// 或 postgresql:// 開頭"
  ),
  APP_SECRET: z.string().regex(/^[0-9a-fA-F]{64,}$/, "APP_SECRET 需 ≥64 hex 字元；用 `openssl rand -hex 32` 產生"),
  PUBLIC_URL: z.string().url("PUBLIC_URL 必須是有效的 http/https URL"),
  // spec rev 5.7 / §14.2：ADMIN_EMAIL/ADMIN_PASSWORD 是實例初始化的唯一（env-only）
  // 管道——這裡故意只驗「有沒有值」（空字串視同未設），格式（email 合法性）與長度
  // （密碼下限）留到下面手動驗證——原因是「兩者必須成對」與「密碼太短」都需要在單一
  // Error 訊息裡講清楚是哪個條件失敗，塞進 zod schema 本身的錯誤聚合格式反而不利閱讀
  // （PUBLIC_URL 的 scheme 檢查也是同一套手動驗證風格，見下方）。
  // `.min(1)` 而非裸 `z.string()`：讓空字串在第一個分支就驗證失敗，才會落到後面
  // `z.literal("")` 那個分支正規化成 undefined——裸 `z.string()` 連空字串都算合法，
  // 空字串會直接留在第一分支變成值為 "" 的已設欄位，不會被當成「未設」處理。
  ADMIN_EMAIL: z.string().min(1).optional().or(z.literal("").transform(() => undefined)),
  ADMIN_PASSWORD: z.string().min(1).optional().or(z.literal("").transform(() => undefined)),
  // Plan 5 §5：OIDC 三件組（issuer/clientId/clientSecret）比照 ADMIN_EMAIL 的
  // 「空字串轉 undefined」模式——同樣的理由（環境變數在某些部署方式下會被設成空字串
  // 而非完全不存在，不能讓空字串被當成「已設」）。
  OIDC_ISSUER_URL: z.string().min(1).optional().or(z.literal("").transform(() => undefined)),
  OIDC_CLIENT_ID: z.string().min(1).optional().or(z.literal("").transform(() => undefined)),
  OIDC_CLIENT_SECRET: z.string().min(1).optional().or(z.literal("").transform(() => undefined)),
});
export interface AppConfig {
  databaseUrl: string;
  appSecret: string;
  publicUrl: URL;
  cookieSecure: boolean;
  insecureHttpWarning: boolean;
  /** env bootstrap admin（spec rev 5.7 / §14.2）：兩者必為同時存在或同時不存在（見下方
   * loadConfig 的 fail-fast 檢查），這兩個欄位永遠同時 defined 或同時 undefined，不會
   * 半套。是否真的據此建立帳號、以及「僅首次初始化生效」的判斷，交給執行期的
   * `initializeInstance`（見 `auth/bootstrap.ts`）——loadConfig 本身不碰 DB。 */
  adminEmail?: string;
  adminPassword?: string;
  /** OIDC 登入（Plan 5 §5）：三件組全有或全無（見下方 loadConfig 的 fail-fast 檢查），
   * 三欄永遠同時 defined 或同時 undefined，不會半套。`issuerUrl` 的 http/https scheme
   * 檢查與 `PUBLIC_URL` 同一套手動驗證風格；http issuer 的啟動警告不落這個欄位——
   * `index.ts` 直接對 `oidc.issuerUrl` 判斷是否印警告（二輪 MINOR-6：加一個
   * `oidcInsecureWarning` 欄位會讓 config.test.ts 的 `toEqual` 精確比對紅——`toEqual`
   * 忽略 undefined 但不忽略 `false`）。 */
  oidc?: { issuerUrl: string; clientId: string; clientSecret: string };
}
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

  // spec rev 5.7：ADMIN_EMAIL/ADMIN_PASSWORD 只設其中一個 → 半套設定必為誤設，
  // 啟動時 fail-fast（兩者是成對欄位，不像一般獨立可選欄位）。
  const adminEmail = r.data.ADMIN_EMAIL;
  const adminPassword = r.data.ADMIN_PASSWORD;
  if ((adminEmail === undefined) !== (adminPassword === undefined)) {
    throw new Error(
      "設定錯誤：ADMIN_EMAIL 與 ADMIN_PASSWORD 必須同時設定，或同時不設定——只設定其中一個視為誤設"
    );
  }
  if (adminEmail !== undefined && adminPassword !== undefined) {
    // 順序：密碼長度優先於 email 格式（雖然這裡兩者都是 fail-fast，順序本身不影響
    // 行為，只是維持一致的檢查習慣）。
    if (adminPassword.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`設定錯誤：ADMIN_PASSWORD 至少需要 ${MIN_PASSWORD_LENGTH} 字元`);
    }
    const emailCheck = z.string().email().safeParse(adminEmail);
    if (!emailCheck.success) {
      throw new Error("設定錯誤：ADMIN_EMAIL 格式錯誤");
    }
  }

  // Plan 5 §5：OIDC_ISSUER_URL/OIDC_CLIENT_ID/OIDC_CLIENT_SECRET 只設其中一到兩個 →
  // 半套設定必為誤設，啟動時 fail-fast（三者是成組欄位，比照上面 ADMIN_EMAIL/
  // ADMIN_PASSWORD 那組的檢查風格）。
  const oidcIssuerUrl = r.data.OIDC_ISSUER_URL;
  const oidcClientId = r.data.OIDC_CLIENT_ID;
  const oidcClientSecret = r.data.OIDC_CLIENT_SECRET;
  const oidcValuesSet = [oidcIssuerUrl, oidcClientId, oidcClientSecret].filter(v => v !== undefined).length;
  if (oidcValuesSet !== 0 && oidcValuesSet !== 3) {
    throw new Error(
      "設定錯誤：OIDC_ISSUER_URL、OIDC_CLIENT_ID、OIDC_CLIENT_SECRET 必須同時設定，或同時不設定——只設定其中一部分視為誤設"
    );
  }
  let oidc: AppConfig["oidc"];
  if (oidcIssuerUrl !== undefined && oidcClientId !== undefined && oidcClientSecret !== undefined) {
    let issuerUrlParsed: URL;
    try {
      issuerUrlParsed = new URL(oidcIssuerUrl);
    } catch {
      throw new Error("設定錯誤：OIDC_ISSUER_URL 必須是有效的 http/https URL");
    }
    if (!["http:", "https:"].includes(issuerUrlParsed.protocol)) {
      throw new Error("設定錯誤：OIDC_ISSUER_URL 必須是 http/https URL");
    }
    oidc = { issuerUrl: oidcIssuerUrl, clientId: oidcClientId, clientSecret: oidcClientSecret };
  }

  return { databaseUrl: r.data.DATABASE_URL, appSecret: r.data.APP_SECRET, publicUrl,
           cookieSecure: publicUrl.protocol === "https:", insecureHttpWarning,
           adminEmail, adminPassword, oidc };
}
