/**
 * note-width：notes_public_width_chk 的允許值 ≡ NOTE_WIDTHS。讀 journal 最後一筆的 snapshot（migration 重編號也不必改這裡）。
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NOTE_WIDTHS } from "@knotebook/shared";

const drizzleDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../drizzle");
const journal = JSON.parse(readFileSync(path.join(drizzleDir, "meta/_journal.json"), "utf8")) as { entries: { idx: number }[] };
const lastIdx = journal.entries.at(-1)!.idx;
const snapshot = JSON.parse(
  readFileSync(path.join(drizzleDir, `meta/${String(lastIdx).padStart(4, "0")}_snapshot.json`), "utf8")
) as { tables: Record<string, { checkConstraints?: Record<string, { value: string }> }> };

describe("note-width：public_width CHECK ≡ NOTE_WIDTHS", () => {
  it("notes_public_width_chk ≡ NOTE_WIDTHS", () => {
    const value = snapshot.tables["public.notes"]!.checkConstraints!["notes_public_width_chk"]!.value;
    expect(value).toBe(`"notes"."public_width" in (${NOTE_WIDTHS.map(w => `'${w}'`).join(",")})`);
  });
});
