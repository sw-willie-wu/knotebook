import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";

// vitest 預設用 forks pool 執行測試檔——每個 worker 是獨立 process，globalThis 不共享。
// 這裡在 globalSetup（跑在 vitest 主 process）把連線字串寫進 process.env；
// 主 process 之後才 fork 出的 worker 會繼承此時的 env，故子 process 讀得到 TEST_DATABASE_URL。
export default async function setup(): Promise<() => Promise<void>> {
  const container: StartedPostgreSqlContainer = await new PostgreSqlContainer("pgvector/pgvector:pg17").start();
  process.env.TEST_DATABASE_URL = container.getConnectionUri();

  return async () => {
    await container.stop();
  };
}
