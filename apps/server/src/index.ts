import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import pino from "pino";
import { loadConfig, publicUrlIssuer, publicUrlPathWarning, testHooksStartupWarning } from "./config.js";
import { createDb } from "./db/index.js";
import { createPool } from "./db/pool.js";
import { runMigrations } from "./db/migrate.js";
import { initializeInstance, logInitFailure } from "./auth/bootstrap.js";
import { backfillLegacyOidcIdentities } from "./auth/legacy-identities.js";
import { warnPasswordLoginAtBoot } from "./auth/password-login.js";
import { backfillHandleRegistry } from "./auth/handle.js";
import { UserGate } from "./auth/session.js";
import { LoginThrottle } from "./auth/rate-limit.js";
import { createCollabHooks } from "./collab/hooks-impl.js";
import { createCollabServer } from "./collab/server.js";
import { SCAN_STOP_GRACE_MS } from "./collab/versions.js";
import { buildApp } from "./app.js";
import { createAiRuntime, selfCheckAiKeys } from "./ai/runtime.js";
import { backfillSearchIndex } from "./notes/search-index.js";
import { startKnowledgeIndexSweep } from "./knowledge/index-write.js";
import { logNotesOverCap, watchNotesOverCap } from "./notes/note-size-startup.js";
import { redactDbError } from "./lib/redact-db-error.js";
import { SiteLimits } from "./site-limits/store.js";
import { initCjkTrigramMode } from "./notes/search-sql.js";
import { parseSettingsLogFields } from "./site-limits/boot-log.js";

// Separate pino instance: migrations and instance init run before buildApp, when there is no app.log yet.
const logger = pino();

/** Shutdown bound for background jobs; the trash purge stops in app.ts onClose (after collab.destroy) with the same cap. */
const stopGrace = (): Promise<void> => new Promise(resolve => setTimeout(resolve, SCAN_STOP_GRACE_MS).unref());

async function main(): Promise<void> {
  const config = loadConfig(process.env);

  logger.info({ trustProxy: config.trustProxy }, "trustProxy setting in effect");

  // An https PUBLIC_URL means a proxy in front (the app never terminates TLS); without TRUST_PROXY every client
  // shares its IP. Checked at startup because nginx doesn't send X-Forwarded-For by default, so the per-request
  // warning can miss exactly these deployments.
  if (!config.trustProxy && config.publicUrl.protocol === "https:") {
    logger.warn(
      {
        publicUrl: config.publicUrl.href,
        risk: "every visitor is seen as the proxy's address, so all of them share one rate-limit and lockout bucket",
        guidance: 'set TRUST_PROXY to your proxy address/CIDR (and make sure the proxy sends X-Forwarded-For) — see docs/self-hosting.md "Deployment prerequisites"',
      },
      "SECURITY WARNING: PUBLIC_URL is https (so something proxies this app) but TRUST_PROXY is not set — per-IP rate limiting and login lockout will treat every visitor as one client"
    );
  }

  if (config.insecureHttpWarning) {
    logger.warn(
      {
        publicUrl: config.publicUrl.href,
        risk: "credentials and session cookies travel in cleartext; session cookie has no Secure flag",
        guidance: 'use only on a network where you trust every host; public deployments must use the reverse-proxy + TLS path — see docs/self-hosting.md "Deployment prerequisites"',
      },
      "SECURITY WARNING: PUBLIC_URL uses plain http on a non-localhost host — credentials and session cookies travel in cleartext"
    );
  }

  const testHooksWarning = testHooksStartupWarning(config);
  if (testHooksWarning !== null) logger.warn({ publicUrl: config.publicUrl.href }, testHooksWarning);

  const pathWarning = publicUrlPathWarning(config.publicUrl);
  if (pathWarning !== null) {
    logger.warn(
      {
        publicUrl: config.publicUrl.href,
        issuer: publicUrlIssuer(config.publicUrl),
        guidance: "set PUBLIC_URL to just scheme://host:port",
      },
      pathWarning
    );
  }

  const pool = createPool(config);
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

  // pg_trgm's word characters depend on the database locale; the search path choice reads the result (see `usesTrigramPath`).
  // A failed check keeps the fallback and never blocks startup.
  await initCjkTrigramMode(db, logger);

  // Fails boot like migrations. `limitEnv` must be `config.limitEnv` (the only source of env-locked limits).
  let siteLimits: SiteLimits;
  try {
    siteLimits = await SiteLimits.load(db, { limitEnv: config.limitEnv, machine: config.machine, log: logger });
  } catch (err) {
    // Not the whole err: DrizzleQueryError's message and params carry query parameters.
    redactDbError(logger, err, "載入站台限制");
    logger.error("請確認 DATABASE_URL 可連線，且 migration 0039（site_limits）已執行");
    process.exit(1);
  }
  logger.info(parseSettingsLogFields(siteLimits), "parse worker settings in effect");

  try {
    await initializeInstance(
      db,
      config.adminEmail && config.adminPassword ? { email: config.adminEmail, password: config.adminPassword } : undefined
    );
  } catch (err) {
    logInitFailure(logger, err); // not the whole err: DrizzleQueryError's params carry the admin email and password hash
    process.exit(1);
  }

  // Before listen, so it finishes before any sign-in (guarded in test/unit/config.test.ts).
  await backfillLegacyOidcIdentities(db, logger);
  await warnPasswordLoginAtBoot(db, config, logger);

  // Before listen, or the backfill could interleave with the first handle change (guarded in handle.test.ts).
  await backfillHandleRegistry(db, logger);
  await logNotesOverCap(db, siteLimits.get("noteMaxBytes"), logger);
  // Subscribed only here, not in buildApp.
  watchNotesOverCap(siteLimits, db, logger);

  const gate = new UserGate(db);
  const throttle = new LoginThrottle();

  // `collabHooks` must wrap this same instance: it finds the connections affected by a permission change through its index.
  const collab = createCollabServer({ db, config, gate, log: logger });

  const webDistCandidate = path.resolve(process.cwd(), "web-dist");
  const webDist = existsSync(webDistCandidate) ? webDistCandidate : undefined;
  if (webDist === undefined) {
    logger.warn({ webDistCandidate }, "web-dist 目錄不存在——停用 SPA fallback，未命中路由一律回 JSON 404");
  }

  const uploadsDir = path.resolve(process.cwd(), "uploads");
  mkdirSync(uploadsDir, { recursive: true });

  // Self-check before serving, so keys broken by an APP_SECRET change are degraded up front; never blocks startup.
  const ai = createAiRuntime();
  await selfCheckAiKeys(db, config.appSecret, ai, logger);

  const app = buildApp(
    {
      config,
      db,
      siteLimits,
      gate,
      throttle,
      collabHooks: createCollabHooks(collab, logger),
      collab,
      uploadsDir,
      ai,
      startVersionJobs: true,
      startTrashPurge: true,
      ...(config.testHooks ? { versionAutoScanIntervalMs: 1000 } : {}),
    },
    { webDist }
  );

  try {
    await app.listen({ host: "0.0.0.0", port: 3000 });
  } catch (err) {
    app.log.error(err, "伺服器啟動失敗（listen 階段）");
    process.exit(1);
  }

  // After listen, in the background: before listen, the first boot after an upgrade would wait for every note to decode.
  const backfillAbort = new AbortController();
  void backfillSearchIndex(db, logger, { signal: backfillAbort.signal }).catch((err: unknown) =>
    logger.error({ err }, "全文索引回填中止"),
  );
  const knowledgeSweep = startKnowledgeIndexSweep(db, logger);

  app.linkConversion.start();

  // Collab must be destroyed before app.close(): Fastify's close can't end upgraded WebSockets and would hang
  // until SIGKILL; destroying collab disconnects them normally so pending stores are flushed. Aborting the backfill
  // only stops new writes; an in-flight one holds its own connection and pool.end() waits for it.
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.once(sig, () => {
      backfillAbort.abort();
      knowledgeSweep.stop();
      // Link conversion writes through direct Hocuspocus connections, so it must drain before collab.destroy().
      // The scan just stops; destroy flushes unsaved changes into pending and the scanner resumes after restart.
      // Bounded so a note stuck on a lock can't eat docker stop's grace period, which collab needs to flush.
      void Promise.race([Promise.all([collab.versions.stopScan(), app.linkConversion.stop()]), stopGrace()])
        .then(() => collab.destroy())
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
