import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sweepUploadTemps, UPLOAD_TEMP_MAX_AGE_MS } from "../../src/uploads/service.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function freshDir(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), "kb-sweep-"));
  dirs.push(d);
  return d;
}

function fileAged(dir: string, name: string, ageMs: number, now: number): void {
  const p = path.join(dir, name);
  writeFileSync(p, "x");
  const t = (now - ageMs) / 1000;
  utimesSync(p, t, t);
}

describe("sweepUploadTemps", () => {
  it("deletes *.tmp files older than the age, keeps fresh .tmp files and every non-.tmp file", async () => {
    const dir = freshDir();
    const now = Date.now();
    fileAged(dir, "11111111-1111-4111-8111-111111111111.tmp", UPLOAD_TEMP_MAX_AGE_MS + 60_000, now);
    fileAged(dir, "22222222-2222-4222-8222-222222222222.tmp", 5_000, now);
    fileAged(dir, "33333333-3333-4333-8333-333333333333", UPLOAD_TEMP_MAX_AGE_MS * 3, now);
    fileAged(dir, "44444444-4444-4444-8444-444444444444.tmp.keep", UPLOAD_TEMP_MAX_AGE_MS * 3, now);
    const log = { warn: vi.fn() };

    const deleted = await sweepUploadTemps(dir, { olderThanMs: UPLOAD_TEMP_MAX_AGE_MS, now, log });

    expect(deleted).toBe(1);
    expect(readdirSync(dir).sort()).toEqual([
      "22222222-2222-4222-8222-222222222222.tmp",
      "33333333-3333-4333-8333-333333333333",
      "44444444-4444-4444-8444-444444444444.tmp.keep",
    ]);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("the age is one hour", () => {
    expect(UPLOAD_TEMP_MAX_AGE_MS).toBe(3_600_000);
  });

  it("leaves a directory named *.tmp alone", async () => {
    const dir = freshDir();
    const now = Date.now();
    const sub = path.join(dir, "old.tmp");
    mkdirSync(sub);
    const t = (now - UPLOAD_TEMP_MAX_AGE_MS * 2) / 1000;
    utimesSync(sub, t, t);
    const deleted = await sweepUploadTemps(dir, { olderThanMs: UPLOAD_TEMP_MAX_AGE_MS, now, log: { warn: vi.fn() } });
    expect(deleted).toBe(0);
    expect(readdirSync(dir)).toEqual(["old.tmp"]);
  });

  it("a missing directory rejects (the caller logs it)", async () => {
    const dir = path.join(freshDir(), "gone");
    await expect(sweepUploadTemps(dir, { olderThanMs: UPLOAD_TEMP_MAX_AGE_MS, log: { warn: vi.fn() } })).rejects.toThrow();
  });
});
