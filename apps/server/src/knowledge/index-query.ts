import type { KnowledgeIndexDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { runKnowledgeIndexQueryInTx, type KnowledgeIndexQueryInput } from "./tx/index-query.js";

export type { KnowledgeIndexQueryInput };

// The `.transaction(` callback must be exactly `runKnowledgeIndexQueryInTx(tx, input)` with no second argument (test/unit/tx-nested-pool-borrow-structure.test.ts); the isolation level is in the body's first statement.
export async function loadKnowledgeIndex(db: Db, input: KnowledgeIndexQueryInput): Promise<KnowledgeIndexDto> {
  return db.transaction((tx) => runKnowledgeIndexQueryInTx(tx, input));
}
