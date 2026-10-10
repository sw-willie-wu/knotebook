/**
 * #239 S2：三條 scope CHECK 的允許值 ≡ TOKEN_SCOPES。讀 journal 最後一筆的 snapshot（migration 重編號也不必改這裡）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOKEN_SCOPES } from "@knotebook/shared";

const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");
const journal = JSON.parse(readFileSync(path.join(drizzleDir, "meta/_journal.json"), "utf8")) as { entries: { idx: number }[] };
const lastIdx = journal.entries.at(-1)!.idx;
const snapshot = JSON.parse(
  readFileSync(path.join(drizzleDir, `meta/${String(lastIdx).padStart(4, "0")}_snapshot.json`), "utf8")
) as { tables: Record<string, { checkConstraints?: Record<string, { value: string }> }> };

describe("#239 S2：scope CHECK ≡ TOKEN_SCOPES", () => {
  it.each(["api_tokens", "oauth_requests", "oauth_codes"])("%s", table => {
    const value = snapshot.tables[`public.${table}`]!.checkConstraints![`${table}_scope_chk`]!.value;
    expect(value).toBe(`"${table}"."scope" in (${TOKEN_SCOPES.map(s => `'${s}'`).join(",")})`);
  });
});
