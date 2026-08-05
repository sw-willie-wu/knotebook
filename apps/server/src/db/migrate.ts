import { fileURLToPath } from "node:url";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Db } from "./index.js";

// dist/db/migrate.js -> ../../drizzle  |  src/db/migrate.ts (via tsx) -> ../../drizzle
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");

export async function runMigrations(db: Db): Promise<void> {
  await migrate(db, { migrationsFolder });
  await seedIdempotent(db);
}

// Plan 4: AI 內建動作 seed（本 plan 為空實作）
async function seedIdempotent(db: Db): Promise<void> {
  void db;
}
