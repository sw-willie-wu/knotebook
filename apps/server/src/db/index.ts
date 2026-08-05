import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import * as schema from "./schema.js";

export function createDb(pool: Pool) {
  return drizzle(pool, { schema });
}

export type Db = ReturnType<typeof createDb>;
