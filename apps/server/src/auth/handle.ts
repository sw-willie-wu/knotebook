import { eq, sql } from "drizzle-orm";
import type pino from "pino";
import { normalizeHandle } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { handles } from "../db/schema.js";

/**
 * #122 handle 派生與 registry 補登（spec §2b）。
 *
 * 配置紀律（spec §2a）：handle 的**唯一裁決者是 `handles` registry 的 PK**——這裡的
 * `deriveHandle` 內含 DB 探測（`WHILE EXISTS` 形），但那是**可用性探測、不是唯一性
 * 裁決**（明文特赦）：探測後真正寫入時仍可能撞唯一鍵，由各建帳路徑的重試契約處理
 * （bootstrap 不重試 fail-closed／OIDC 整 tx 重投一次／admin 整 tx 重跑 ≤3 後第 4 次
 * 退 user-<uuid8>）。重試時重新探測——這救得了 `handles_pkey` 的真競態；
 * `users_handle_unique` 的窗期形（探測看不見）是確定性再撞，各路徑的出口與收斂
 * 見呼叫點註解（oidc.ts／admin-users.ts）。
 */

const UUID_FORM_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 探測上限（plan gate M5-2）：探測是 O(同前綴數) 次索引查詢、建帳路徑無節流，
 * 上界必須有——超限直接退 `user-<uuid8>`。 */
const PROBE_LIMIT = 20;

/** db 或 tx 皆可（drizzle 的 transaction 物件有同一個 select 介面）。 */
type HandleQueryer = Pick<Db, "select">;

/**
 * 單一候選字串 → 基底（純函式段）：ASCII 小寫 → 非 `[a-z0-9]` 段轉 `-` → 去頭尾
 * dash → **空/uuid 形 → null（uuid 形判斷在截斷前**——截 30 後的 uuid 前綴已非
 * uuid 形、判不到，plan 注意事項 9）→ 截 30 再 trim 尾 dash。
 */
export function handleCandidateFrom(raw: string): string | null {
  let base = normalizeHandle(raw)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (base === "" || UUID_FORM_RE.test(base)) return null;
  base = base.slice(0, 30).replace(/-+$/, "");
  return base === "" ? null : base;
}

async function isTaken(q: HandleQueryer, handle: string): Promise<boolean> {
  const [row] = await q.select({ handle: handles.handle }).from(handles).where(eq(handles.handle, handle)).limit(1);
  return row !== undefined;
}

/**
 * 候選序（前者敗退後者；spec §2b：OIDC `preferred_username` → email local-part）＋
 * 探測選尾碼。全候選皆敗（空/非 ASCII 轉完全空/uuid 形）→ `user-<uuid8>`。
 * 探測含墓碑（released 列占 PK＝永不回收），`-2` 遞增、重截基底使總長 ≤32。
 */
export async function deriveHandle(
  q: HandleQueryer,
  candidates: Array<string | null | undefined>,
  userId: string,
): Promise<string> {
  const fallback = `user-${userId.slice(0, 8)}`;

  let base: string | null = null;
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    base = handleCandidateFrom(candidate);
    if (base !== null) break;
  }
  if (base === null) return fallback;

  let cand = base;
  let n = 1;
  while (await isTaken(q, cand)) {
    n += 1;
    if (n > PROBE_LIMIT) return fallback;
    const suffix = `-${n}`;
    cand = base.slice(0, 32 - suffix.length).replace(/-+$/, "") + suffix;
  }
  return cand;
}

/**
 * boot 冪等補登（spec §2a）：把回滾窗期由舊碼建立、無 registry 列的 users.handle
 * 補進 registry。**必須在 `app.listen` 之前呼叫**（否則補登與首個改名請求可交錯
 * ——index.ts 的呼叫順序由 handle.test.ts 的結構守衛釘住）。
 *
 * 補登後 warn 的判準（對 spec 字面的明示偏離）：spec §2a 寫「衝突（被吞列）數 >0 時
 * log warn」——但 `DO NOTHING` 對「已補登過的列」也吞（第二次 boot 起每列都吞），照
 * 字面每次重啟都會誤報全員。改為**事後 re-query**：仍缺 live 對應列（`h.handle=u.handle
 * AND h.user_id=u.id AND h.state='live'`）的使用者才 warn——涵蓋「名字被別人占」「列
 * 非 live」兩形；這些使用者的 handle 未進 registry、未受墓碑機制保護（live 名仍由
 * `users_handle_unique` 擋重複，但改名釋放語意對它們不完整）。
 */
export async function backfillHandleRegistry(db: Db, logger: pino.Logger): Promise<void> {
  await db.execute(
    sql`INSERT INTO handles (handle, user_id, state) SELECT handle, id, 'live' FROM users ON CONFLICT (handle) DO NOTHING`,
  );
  const missing = await db.execute(
    sql`SELECT u.id, u.handle FROM users u
        WHERE NOT EXISTS (SELECT 1 FROM handles h WHERE h.handle = u.handle AND h.user_id = u.id AND h.state = 'live')`,
  );
  if (missing.rows.length > 0) {
    logger.warn(
      { users: missing.rows },
      "handle registry 補登後仍有使用者缺 live 對應列（名字被他人占住或列非 live）——這些使用者的 handle 未進 registry、未受墓碑機制保護",
    );
  }
}
