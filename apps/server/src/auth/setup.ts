import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/index.js";
import { instanceSetup, users } from "../db/schema.js";
import { hashPassword } from "./password.js";

/** `SetupState.init` 需要的最小 logger 介面——`fastify.log` 與測試用 spy 皆滿足。 */
export interface SetupLogger {
  info: (msg: string) => void;
}

/**
 * `ADMIN_EMAIL`/`ADMIN_PASSWORD` env bootstrap 的輸入（spec rev 5.7）——`config.ts` 的
 * `loadConfig` 已保證兩者「同時存在或同時不存在」且密碼長度/email 格式合法，這裡不重
 * 複驗證，只管「要不要、如何」建立。
 */
export interface EnvAdminBootstrap {
  email: string;
  password: string;
}

/**
 * SetupState：一次性 setup 流程的狀態機。
 *
 * - `init()`：啟動時查 `instance_setup` 是否已有資料列。未完成 → 產生一次性 setup token
 *   （`crypto.randomBytes(32).toString("hex")`，64 hex 字元）並透過 `log.info` 印出——
 *   production（Task 14 的 `index.ts`）靠這行日誌讓操作者取得 token，本 class 不負責
 *   任何輸出以外的分發管道。已完成 → 不產生 token，之後 `verifyToken` 恆為 false。
 *
 *   **spec rev 5.7 env bootstrap admin**：呼叫時額外傳入 `envAdmin`（`ADMIN_EMAIL`/
 *   `ADMIN_PASSWORD` 皆有值時才會傳，見 `index.ts`）——僅在「未完成」這個分支生效
 *   （已完成時，如上，env 直接被忽略，不進這段邏輯，對映 spec「僅首次初始化生效」）。
 *   此時不產生 setup token，改為原子性建立該 admin（複用 `instance_setup` singleton
 *   的 `INSERT ... ON CONFLICT DO NOTHING` 當並發/重試保護，語意同 `routes/setup.ts`
 *   的 `POST /api/setup` 交易），建立後直接視為「已完成」（`markCompleted` 語意），
 *   之後 `verifyToken` 恆為 false、`token` 恆為 null。
 * - `isNeeded()`：**每次呼叫都重新查 DB**，不可只回傳快取在 `init()` 當下算出的結論——
 *   setup 一旦完成（不論透過本 process 的 `POST /api/setup` 或其他管道寫入該表）都必須
 *   立刻反映為 false。
 * - `verifyToken()`：timing-safe 比較（`crypto.timingSafeEqual`）。已完成
 *   （`markCompleted()` 已呼叫，或 `init()` 當下就已完成）或本來就沒有 token 時恆為
 *   false——長度不同時直接判否（timingSafeEqual 要求等長 buffer，且 token 長度固定，
 *   此處提前 return 不構成有意義的時序側channel）。
 * - `markCompleted()`：`POST /api/setup` 交易成功提交後呼叫；之後 `verifyToken` 永遠
 *   false——即使呼叫方手上還握著同一份合法 token 也不能再用第二次（token 是一次性的）。
 */
export class SetupState {
  // 用真正的 ECMAScript private field（`#`），不是 TS 的 `private` 關鍵字——後者只在
  // 編譯期擋存取，執行期仍是一般可列舉屬性，`JSON.stringify(state)` 或
  // `Object.keys(state)` 會把 token 明文洩漏出去。`#` field 執行期就不存在於物件的
  // 一般屬性列舉裡，也無法從 class 外部以任何方式讀到，才是真正的結構性含斂。
  readonly #db: Db;
  #completed: boolean;
  readonly #token: string | null;

  private constructor(db: Db, completed: boolean, token: string | null) {
    this.#db = db;
    this.#completed = completed;
    this.#token = token;
  }

  static async init(db: Db, log: SetupLogger, envAdmin?: EnvAdminBootstrap): Promise<SetupState> {
    const completed = await SetupState.checkCompleted(db);
    if (completed) return new SetupState(db, true, null);

    if (envAdmin) {
      await SetupState.bootstrapAdminFromEnv(db, envAdmin);
      // 不論這次是本 process 真的建立、還是與另一個並發嘗試（或先前一次啟動）競爭輸了
      // （instance_setup 早就有列了）——只要走到這裡，instance_setup 必已落地，
      // 一律視為「已完成」，不產生 setup token（spec：「setup token 不產生」）。
      return new SetupState(db, true, null);
    }

    const token = randomBytes(32).toString("hex");
    log.info(`Setup token: ${token}`);
    return new SetupState(db, false, token);
  }

  /**
   * 原子性建立 env bootstrap admin：與 `routes/setup.ts` 的 `POST /api/setup` 同一套
   * `instance_setup` singleton guard——`INSERT ... ON CONFLICT DO NOTHING RETURNING *`
   * 拿不到列就代表已經有人（另一次並發呼叫，或先前一次啟動）完成過，直接靜默返回，
   * 不重複建立第二個 admin（「啟動重試不可建出第二個 admin」）。
   *
   * displayName 預設取 email 的 local-part（`@` 之前那段）；理論上不可能是空字串
   * （`config.ts` 的 `loadConfig` 已用 `z.string().email()` 驗過格式，合法 email 一定
   * 有非空 local-part），`|| envAdmin.email` 純粹是防禦性回退，不依賴這個前提也不出錯。
   */
  private static async bootstrapAdminFromEnv(db: Db, envAdmin: EnvAdminBootstrap): Promise<void> {
    const passwordHash = await hashPassword(envAdmin.password);
    const displayName = envAdmin.email.split("@")[0] || envAdmin.email;

    await db.transaction(async tx => {
      const [setupRow] = await tx.insert(instanceSetup).values({ singleton: true }).onConflictDoNothing().returning();
      if (!setupRow) return; // 已有人完成——不重複建立

      // mustChangePassword: true——env 密碼是操作者自己選的、寫在 .env 裡，首登應強制
      // 改掉（spec rev 5.7；與 setup 頁自建 admin 刻意不同，見 routes/setup.ts）。
      await tx.insert(users).values({ email: envAdmin.email, passwordHash, displayName, isAdmin: true, mustChangePassword: true });
    });
  }

  /**
   * 測試用：讀出 `init()` 產生的一次性 token。production 路徑不透過此屬性分發 token——
   * 一律靠 `log.info`（見 class 註解）；此 getter 只是讓整合測試不必去 parse log 輸出。
   */
  get token(): string | null {
    return this.#token;
  }

  async isNeeded(): Promise<boolean> {
    return !(await SetupState.checkCompleted(this.#db));
  }

  verifyToken(t: string): boolean {
    if (this.#completed || this.#token === null) return false;
    const expected = Buffer.from(this.#token, "utf8");
    const actual = Buffer.from(t, "utf8");
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  markCompleted(): void {
    this.#completed = true;
  }

  private static async checkCompleted(db: Db): Promise<boolean> {
    const rows = await db.select().from(instanceSetup).limit(1);
    return rows.length > 0;
  }
}
