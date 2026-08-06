import { Pool } from "pg";
import pino from "pino";
import { loadConfig } from "./config.js";
import { createDb } from "./db/index.js";
import { runMigrations } from "./db/migrate.js";
import { SetupState } from "./auth/setup.js";
import { UserGate } from "./auth/session.js";
import { LoginThrottle } from "./auth/rate-limit.js";
import { createCollabHooks } from "./collab/hooks-impl.js";
import { createCollabServer } from "./collab/server.js";
import { buildApp } from "./app.js";

// 獨立的 pino instance：`SetupState.init` 在 `buildApp()` 之前就要跑（見下方
// main() 的呼叫順序），此時還沒有 Fastify app、也就還沒有 `app.log` 可用——
// 不能等 buildApp() 之後才建 logger。改建這個獨立 pino instance，同時傳給
// `SetupState.init`（讓 Setup token 印出來）與下面的 fail-fast 錯誤訊息；
// `buildApp()` 之後另外用自己預設的 fastify logger（`options.logger` 預設 true）
// ——兩個 pino instance 都直寫 stdout，`docker compose logs app` 能同時看到兩邊
// 的輸出，不需要共用同一個 instance。
const logger = pino();

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const pool = new Pool({ connectionString: config.databaseUrl });
  const db = createDb(pool);

  try {
    await runMigrations(db);
  } catch (err) {
    logger.error(
      { err },
      "資料庫 migration 失敗——請確認 DATABASE_URL 可連線、目標資料庫已存在，且該帳號有足夠權限（CREATE TABLE 等）；" +
        "解決後重新啟動 container 即可（migration 具冪等性，不需要手動清狀態）"
    );
    process.exit(1);
  }

  const setupState = await SetupState.init(db, logger);
  const gate = new UserGate(db);
  const throttle = new LoginThrottle();

  // 即時協作（Hocuspocus）。`collab` 與 `collabHooks` 必須是同一個 CollabServer 實例：
  // hooks 靠它的連線索引找出「哪些連線受這次權限變更影響」，指到別的實例等於撤權永遠
  // 找不到人。`limiters` 刻意不傳——`buildApp` 內建的生產預設即唯一真相來源
  // （`http/rate-limit.ts` 的 COLLAB_TOKEN_LIMIT/SLUG_PATCH_LIMIT）。
  const collab = createCollabServer({ db, config, gate });

  const app = buildApp({
    config,
    db,
    gate,
    throttle,
    collabHooks: createCollabHooks(collab, logger),
    collab,
    setupState,
  });

  try {
    await app.listen({ host: "0.0.0.0", port: 3000 });
  } catch (err) {
    app.log.error(err, "伺服器啟動失敗（listen 階段）");
    process.exit(1);
  }

  // Graceful shutdown：`docker compose stop`/`down`（以及手動 Ctrl-C）送的都是
  // SIGTERM/SIGINT——不接住的話 Fastify 會被硬殺，進行中的請求與尚未 flush 的
  // pg 連線可能被粗暴中斷。
  //
  // 順序不可調換：**`collab.destroy()` 必須在 `app.close()` 之前 await**。Fastify 的
  // `close()` 等的是「還在跑的 HTTP 請求 + listener 關閉」，它管不到已經 upgrade 成
  // WebSocket 的 socket——那些連線只要還開著，`app.close()` 就會一直等下去（compose
  // stop 只好等到 10s 的 SIGKILL 逾時）。`collab.destroy()` 會走正常斷線路徑關掉每條
  // socket（讓最後一條連線離開時把 pending store 落地），逾時未關的直接 terminate。
  // 全部做完（或任一步驟拋錯，被 `.finally` 接住）才 `process.exit(0)`——不做 exit code
  // 判斷是因為這是主動收到終止訊號的正常關機路徑，非錯誤情境。
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      void collab
        .destroy()
        .then(() => app.close())
        .then(() => pool.end())
        .finally(() => process.exit(0));
    });
  }
}

main().catch((err: unknown) => {
  logger.error({ err }, "伺服器啟動失敗");
  process.exit(1);
});
