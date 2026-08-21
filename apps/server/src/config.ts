import { isIP } from "node:net";
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
  // issue #13：反向代理信任設定。比照上面幾組「空字串視同未設」的模式；值本身的
  // 語法交給 `parseTrustProxy` 手動驗證（錯誤訊息要能指出是哪一段不合法）。
  TRUST_PROXY: z.string().min(1).optional().or(z.literal("").transform(() => undefined)),
});

/** `parseTrustProxy` 認得的具名網段（proxy-addr 的內建關鍵字，fastify 直接轉交）。 */
const TRUST_PROXY_KEYWORDS = new Set(["loopback", "linklocal", "uniquelocal"]);

/**
 * `TRUST_PROXY` 環境變數 → fastify 的 `trustProxy` 選項（issue #13）。
 *
 * **未設＝ `false`＝不採信 `X-Forwarded-For`**。這是「client 能直接連到 app」那種拓撲
 * （自架很常見，本專案的 LAN 模式就是）唯一安全的預設：採信一個任何人都能自己填的
 * header，等於所有 per-IP 節流（登入退避、OIDC 端點）都可以換一個假 IP 繞過。
 *
 * ⚠ **反代拓撲一定要設**：沒設的話 `request.ip` 會是反代的位址，於是**所有使用者共用
 * 同一個 IP 軌**——任何人連續打錯 5 次密碼就會把整個站的人一起鎖進退避窗口。這個方向
 * 的失效是「拒絕服務」而不是「被繞過」，所以預設值選在安全那一側、由部署者明確打開。
 * 為了不讓它靜默發生有兩道提示：`index.ts` 在**啟動時**檢查「PUBLIC_URL 是 https 卻沒設
 * TRUST_PROXY」（app 從不自己終結 TLS，https 就代表前面一定有代理），`buildApp` 則在
 * **第一個帶轉發 header 的請求**上印一次警告。
 *
 * 收的值：`false`（預設）／`true`（採信任何來源，等同修這條 issue 之前的行為）／
 * 非負整數（信任的 hop 數）／逗號分隔的 IP、CIDR 或具名網段（`loopback`、
 * `linklocal`、`uniquelocal`）。語法錯誤一律在啟動時就丟錯，不留到每個請求才炸。
 */
export function parseTrustProxy(raw: string | undefined): boolean | number | string[] {
  if (raw === undefined) return false;
  const value = raw.trim();
  if (value === "" || value.toLowerCase() === "false") return false;
  if (value.toLowerCase() === "true") return true;
  // `0` 正規化成 `false`：fastify 對 hop 數 0 的行為本來就等同不信任，而寫 `0` 的人
  // 表達的是「關掉」——留著 0 只會讓下游多一種要記得處理的 falsy 值。
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    return hops === 0 ? false : hops;
  }

  const entries = value.split(",").map(entry => entry.trim()).filter(entry => entry !== "");
  const normalized: string[] = [];
  if (entries.length === 0) {
    throw new Error(`設定錯誤：TRUST_PROXY 的值無法解析：${raw}`);
  }
  for (const entry of entries) {
    // ⚠ 收下小寫版本：proxy-addr 對具名網段是 `Object.hasOwn(IP_RANGES, value)` 的**精確**
    // 比對，只認全小寫。這裡若原樣收下 `Loopback`，fastify 會在建構子丟
    // `invalid IP address: Loopback`——一個既不是我們的錯誤格式、也指不出是哪個環境
    // 變數的訊息（審查實測）。
    const keyword = entry.toLowerCase();
    if (TRUST_PROXY_KEYWORDS.has(keyword)) {
      normalized.push(keyword);
      continue;
    }
    const [address, prefix, ...rest] = entry.split("/");
    const family = isIP(address ?? "");
    if (family === 0 || rest.length > 0) {
      throw new Error(
        `設定錯誤：TRUST_PROXY 的「${entry}」不是合法的 IP／CIDR／具名網段（loopback、linklocal、uniquelocal）`
      );
    }
    if (prefix !== undefined) {
      const bits = Number(prefix);
      const max = family === 4 ? 32 : 128;
      // 下限是 1 而不是 0：proxy-addr 對 `/0` 直接丟 `invalid range on address`
      // （`range <= 0` 就拒），所以 `0.0.0.0/0` 這種「我要信任全部」的直覺寫法必須在
      // 這裡就擋掉並指向正確的寫法，不能讓它變成 fastify 建構子的英文例外（審查實測）。
      if (!/^\d+$/.test(prefix) || bits < 1 || bits > max) {
        throw new Error(
          `設定錯誤：TRUST_PROXY 的「${entry}」網段長度必須是 1-${max} 的整數（要信任任何來源請直接寫 TRUST_PROXY=true）`
        );
      }
    }
    normalized.push(entry);
  }
  return normalized;
}
export interface AppConfig {
  databaseUrl: string;
  appSecret: string;
  publicUrl: URL;
  cookieSecure: boolean;
  /** fastify 的 `trustProxy` 選項（issue #13）。預設 `false`，見 `parseTrustProxy`。 */
  trustProxy: boolean | number | string[];
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
           trustProxy: parseTrustProxy(r.data.TRUST_PROXY),
           adminEmail, adminPassword, oidc };
}
