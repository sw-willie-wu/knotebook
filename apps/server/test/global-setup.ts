import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

// vitest 預設用 forks pool 執行測試檔——每個 worker 是獨立 process，globalThis 不共享。
// 這裡在 globalSetup（跑在 vitest 主 process）把連線字串寫進 process.env；
// 主 process 之後才 fork 出的 worker 會繼承此時的 env，故子 process 讀得到 TEST_DATABASE_URL。
export default async function setup(): Promise<() => Promise<void>> {
  // 覆寫 testcontainers 預設的 CMD-SHELL healthcheck：機器忙時它逾時、留下孤兒 pg_isready，
  // 孤兒 exit 2 會被 postmaster 當成 backend 崩潰而重啟整座 cluster（57P03）。改 CMD 形（不經 shell）並放寬逾時。
  // 帳號與資料庫沿用預設值（test／test）；保留 --host localhost 是為了走 TCP（避開 initdb 階段 unix socket 假就緒）。
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer("pgvector/pgvector:pg17")
    .withHealthCheck({
      test: ["CMD", "pg_isready", "--host", "localhost", "--username", "test", "--dbname", "test"],
      interval: 1000,
      timeout: 5000,
      retries: 120,
    })
    .start();
  process.env.TEST_DATABASE_URL = container.getConnectionUri();

  return async () => {
    await container.stop();
  };
}
