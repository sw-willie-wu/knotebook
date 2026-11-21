/**
 * The sweep starts after `app.listen` (before listen, the first boot after an upgrade would wait for every note to decode), the shutdown handler stops it before collab is destroyed,
 * and its failure log carries only the error summary.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.resolve(here, "../../src/index.ts"), "utf8");
const sweepSrc = readFileSync(path.resolve(here, "../../src/knowledge/index-write.ts"), "utf8");

describe("knowledge index sweep wiring in index.ts", () => {
  it("startKnowledgeIndexSweep is called after app.listen", () => {
    const callAt = src.indexOf("startKnowledgeIndexSweep(db");
    const listenAt = src.indexOf(".listen(");
    expect(callAt).toBeGreaterThan(-1);
    expect(listenAt).toBeGreaterThan(-1);
    expect(callAt).toBeGreaterThan(listenAt);
  });
  it("the shutdown handler calls knowledgeSweep.stop() before collab.destroy()", () => {
    const onceAt = src.indexOf("process.once(");
    const stopAt = src.indexOf("knowledgeSweep.stop()", onceAt);
    const destroyAt = src.indexOf(".destroy()", onceAt);
    expect(onceAt).toBeGreaterThan(-1);
    expect(stopAt).toBeGreaterThan(onceAt);
    expect(destroyAt).toBeGreaterThan(-1);
    expect(stopAt).toBeLessThan(destroyAt);
  });
  it("the sweep's catch logs the error summary, not the raw err", () => {
    const at = sweepSrc.indexOf('"knowledge index backfill aborted");');
    expect(at).toBeGreaterThan(-1);
    const line = sweepSrc.slice(sweepSrc.lastIndexOf("log.warn(", at), at);
    expect(line).toContain("knowledgeErrorFields(err)");
    expect(line).not.toMatch(/\{\s*err\b/);
  });
});
