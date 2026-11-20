import { describe, expect, it } from "vitest";
import { createHeadlessNoteSchema } from "./note-schema-config.js";
import { NOTE_SCHEMA_VERSION } from "./note-schema-version.js";

// Red when the note schema changed but NOTE_SCHEMA_VERSION was not bumped.
// The stale-tab gate only recognises this integer: if the schema changes without a bump, tabs on both sides of the gate count as the same version and old tabs still strip the new attributes.
// Scope: only the headless schema's block / inline / style types, prop names and defaults; the web noteSchema's own set and PM-level attributes (blockContainer attrs, link mark attrs) are not in the digest.

/** The recorded schema version and digest. If the schema changed: bump NOTE_SCHEMA_VERSION and replace this with the new { version, digest }. */
const RECORDED = { version: 3, digest: "29ea2281" } as const;

type PropSpec = { default?: unknown; values?: unknown };
function propsOf(propSchema: unknown): string {
  if (typeof propSchema !== "object" || propSchema === null) return String(propSchema);
  const record = propSchema as Record<string, PropSpec>;
  return Object.keys(record)
    .sort()
    .map((name) => {
      const def = record[name]!;
      const values = Array.isArray(def.values) ? `|${JSON.stringify(def.values)}` : "";
      return `${name}=${JSON.stringify(def.default)}${values}`;
    })
    .join(",");
}

function canonical(schema: { blockSchema: object; inlineContentSchema: object; styleSchema: object }): string {
  const lines: string[] = [];
  const blocks = schema.blockSchema as Record<string, { content: string; propSchema: unknown }>;
  for (const name of Object.keys(blocks).sort()) lines.push(`B:${name}:${blocks[name]!.content}:${propsOf(blocks[name]!.propSchema)}`);
  const inline = schema.inlineContentSchema as Record<string, string | { content: string; propSchema: unknown }>;
  for (const name of Object.keys(inline).sort()) {
    const ic = inline[name]!;
    lines.push(typeof ic === "string" ? `I:${name}:${ic}` : `I:${name}:${ic.content}:${propsOf(ic.propSchema)}`);
  }
  const styles = schema.styleSchema as Record<string, { propSchema: unknown }>;
  for (const name of Object.keys(styles).sort()) lines.push(`S:${name}:${String(styles[name]!.propSchema)}`);
  return lines.join("\n");
}

/** FNV-1a 32-bit (plain JS; shared does not touch node:crypto). */
function fnv1a32(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

describe("NOTE_SCHEMA_VERSION and schema digest", () => {
  it("the schema digest matches the record (if not: bump NOTE_SCHEMA_VERSION and update RECORDED - the received value is the new digest)", () => {
    const digest = fnv1a32(canonical(createHeadlessNoteSchema("http://localhost/")));
    expect({ version: NOTE_SCHEMA_VERSION, digest }).toEqual(RECORDED);
  });
  it("the canonical form contains the wikilink's four props (guards against canonical itself missing inline content)", () => {
    expect(canonical(createHeadlessNoteSchema("http://localhost/"))).toContain('I:wikilink:none:anchorBlockId="",label="",snapshotTitle="",targetNoteId=""');
  });
  it("the canonical form contains the two column types", () => {
    const text = canonical(createHeadlessNoteSchema("http://localhost/"));
    expect(text).toContain("B:column:none:width=1");
    expect(text).toContain("B:columnList:none:");
  });
});
