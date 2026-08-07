import { existsSync } from "node:fs";
import path from "node:path";
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

  // spec rev 5.6：trusted-LAN plain-http 是支援的拓撲之一（PUBLIC_URL=http://<lan-ip>:3000，
  // 不再拒絕啟動——見 config.ts 的 insecureHttpWarning 推導）。啟動時印一次警告，讓維運者
  // 自行評估風險；不在這裡擋下啟動，決定權留給使用者。
  //
  // 這個 logger 是裸 pino（無 pretty transport），輸出是 NDJSON——不用多行字串排版
  // （那樣只會變成 JSON 字串裡的跳脫 `\n`，在 `docker compose logs` 之類的原始輸出裡
  // 讀起來反而更雜）。改用一行大寫、講重點的 `msg`，細節放進結構化欄位；
  // README 對應說明也要講「一行 JSON 警告」而非「多行橫幅」，見那邊的用字。
  if (config.insecureHttpWarning) {
    logger.warn(
      {
        publicUrl: config.publicUrl.href,
        risk: "credentials and session cookies travel in cleartext; session cookie has no Secure flag",
        guidance: 'use only on a network where you trust every host; public deployments must use the reverse-proxy + TLS path — see README "Deployment prerequisites"',
      },
      "SECURITY WARNING: PUBLIC_URL uses plain http on a non-localhost host — credentials and session cookies travel in cleartext"
    );
  }

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
  const collab = createCollabServer({ db, config, gate, log: logger });

  // SPA fallback（Task 9，spec §11.5）：docker build 把前端建置產物放在 `web-dist`
  // （`process.cwd()` 相對——container 的 WORKDIR，見 Dockerfile）。啟動時檢查目錄
  // 是否存在——不存在（例如純 API 部署、還沒 build 前端）就 warn 後不傳 webDist，
  // `buildApp` 會維持未命中路由一律 JSON 404 的既有行為，不因為缺目錄而啟動失敗。
  const webDistCandidate = path.resolve(process.cwd(), "web-dist");
  const webDist = existsSync(webDistCandidate) ? webDistCandidate : undefined;
  if (webDist === undefined) {
    logger.warn({ webDistCandidate }, "web-dist 目錄不存在——停用 SPA fallback，未命中路由一律回 JSON 404");
  }

  const app = buildApp(
    {
      config,
      db,
      gate,
      throttle,
      collabHooks: createCollabHooks(collab, logger),
      collab,
      setupState,
    },
    { webDist }
  );

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
