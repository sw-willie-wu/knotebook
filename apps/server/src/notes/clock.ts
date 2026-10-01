import { sql } from "drizzle-orm";

/**
 * `notes.updated_at` 的**唯一**時鐘來源（#142）：DB 端 `now()`。PATCH 格 2 與 T1（`notes/tx/patch-slug.ts`）共用這一份——
 * `mcp/queries.ts` 的降精度論證、`list_notes` 的漏列成因、known-limitations 的分頁句都以「updated_at 全來自 DB 時鐘」為前提
 * （[[knotebook-timestamp-clocks]]）。勿改回 `new Date()`。
 */
export const UPDATED_AT_NOW = sql`now()`;
