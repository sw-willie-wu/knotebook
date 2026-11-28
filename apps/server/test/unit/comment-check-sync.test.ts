/**
 * The body and quote CHECKs use the shared length caps, the notification block id CHECK uses the shared anchor pattern, and the latest
 * migration that writes each says the same as schema.ts, so changing a cap or the schema without regenerating the migration fails here.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { BLOCK_ANCHOR_RE, COMMENT_BODY_MAX, COMMENT_QUOTE_MAX } from "@knotebook/shared";
import { noteComments, notifications } from "../../src/db/schema.js";

const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");

function schemaCheckSql(name: string, table: typeof noteComments | typeof notifications = noteComments): string {
  const check = getTableConfig(table).checks.find(c => c.name === name);
  expect(check, `${name} is declared`).toBeDefined();
  return new PgDialect().sqlToQuery(check!.value).sql;
}

/** The CHECK body of the last migration in journal order that adds the named constraint. */
function migrationCheckSql(name: string): string {
  const journal = JSON.parse(readFileSync(path.join(drizzleDir, "meta/_journal.json"), "utf8")) as { entries: { idx: number; tag: string }[] };
  const marker = `CONSTRAINT "${name}" CHECK (`;
  for (const entry of [...journal.entries].sort((a, b) => b.idx - a.idx)) {
    const text = readFileSync(path.join(drizzleDir, `${entry.tag}.sql`), "utf8");
    if (!text.includes(marker)) continue;
    const at = text.indexOf(marker) + marker.length;
    let depth = 1;
    let i = at;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
    }
    return text.slice(at, i - 1);
  }
  throw new Error(`no migration adds ${name}`);
}

describe("comment length CHECKs match the shared caps", () => {
  it("note_comments_body_chk allows exactly 1..COMMENT_BODY_MAX code points", () => {
    expect(schemaCheckSql("note_comments_body_chk")).toBe(`char_length("note_comments"."body") between 1 and ${COMMENT_BODY_MAX}`);
  });

  it("note_comments_quote_chk allows null or 1..COMMENT_QUOTE_MAX code points", () => {
    expect(schemaCheckSql("note_comments_quote_chk")).toBe(
      `"note_comments"."anchor_quote" is null or char_length("note_comments"."anchor_quote") between 1 and ${COMMENT_QUOTE_MAX}`,
    );
  });

  it.each(["note_comments_body_chk", "note_comments_quote_chk"])("the latest migration that writes %s has the same expression as schema.ts", name => {
    expect(migrationCheckSql(name)).toBe(schemaCheckSql(name));
  });
});

describe("notification block id CHECK matches the shared anchor pattern", () => {
  it("notifications_block_id_chk allows null or BLOCK_ANCHOR_RE", () => {
    expect(schemaCheckSql("notifications_block_id_chk", notifications)).toBe(
      `"notifications"."block_id" is null or "notifications"."block_id" ~ '${BLOCK_ANCHOR_RE.source}'`,
    );
  });

  it("the latest migration that writes it has the same expression as schema.ts", () => {
    expect(migrationCheckSql("notifications_block_id_chk")).toBe(schemaCheckSql("notifications_block_id_chk", notifications));
  });
});
