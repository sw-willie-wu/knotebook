import { describe, expect, it } from "vitest";
import { createHeadlessNoteSchema } from "./note-schema-config.js";
import { NOTE_SCHEMA_VERSION } from "./note-schema-version.js";

// spec 2026-10-13 site-links §4.5／§15.1 S3：note schema 變了而 NOTE_SCHEMA_VERSION 沒升 ⇒ 紅。
// 舊分頁閘門（§5）只認這個整數；schema 改了卻沒升，閘門前後的分頁會被當成同版，舊分頁照樣剝掉新屬性。
// 起草時（新 props 加上之後）以同一份正規化實算：digest = 3467380a（BlockNote 0.52.1）。
// 守衛範圍（§4.5）：只看 headless schema 的 block／inline／style 型別、prop 名與預設值；web noteSchema 的另組、PM 層屬性（blockContainer attrs、link mark attrs）不在 digest 內。

/** 已記錄的 schema 版本與 digest。schema 改了：升 NOTE_SCHEMA_VERSION，並把這裡換成新的 { version, digest }。 */
const RECORDED = { version: 1, digest: "3467380a" } as const;

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

/** 型別名＋各 prop 名＋預設值（＋列舉值），排序後逐行。 */
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

/** FNV-1a 32-bit（純 JS，shared 不碰 node:crypto）。 */
function fnv1a32(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

describe("S3 NOTE_SCHEMA_VERSION 與 schema digest", () => {
  it("schema 的 digest 與記錄相符（不符：升 NOTE_SCHEMA_VERSION 並更新 RECORDED——received 就是新的 digest）", () => {
    const digest = fnv1a32(canonical(createHeadlessNoteSchema("http://localhost/")));
    expect({ version: NOTE_SCHEMA_VERSION, digest }).toEqual(RECORDED);
  });
  it("正規化形含 wikilink 的四個 props（守 canonical 本身沒漏掉 inline content）", () => {
    expect(canonical(createHeadlessNoteSchema("http://localhost/"))).toContain('I:wikilink:none:anchorBlockId="",label="",snapshotTitle="",targetNoteId=""');
  });
});
