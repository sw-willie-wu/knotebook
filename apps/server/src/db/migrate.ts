import { fileURLToPath } from "node:url";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Db } from "./index.js";
import { seedAiActions } from "./seed-ai.js";

// dist/db/migrate.js -> ../../drizzle  |  src/db/migrate.ts (via tsx) -> ../../drizzle
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
  await seedIdempotent(db);
}

// Plan 4：內建 AI 動作 seed（`ON CONFLICT (id) DO NOTHING`，見 `seed-ai.ts`）——
// 掛在既有 idempotent seed 流程尾端，每次啟動/每次測試 `freshDb()` 都會跑一次。
async function seedIdempotent(db: Db): Promise<void> {
  await seedAiActions(db);
}
