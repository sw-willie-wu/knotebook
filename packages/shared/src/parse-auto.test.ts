import { describe, expect, it } from "vitest";
import { defaultParseWorkers, memoryParseWorkers } from "./parse-auto.js";

describe("parse-auto", () => {
  it("defaultParseWorkers：留 1 核、至少 1、至多 4", () => {
    expect(defaultParseWorkers(1)).toBe(1);
    expect(defaultParseWorkers(2)).toBe(1);
    expect(defaultParseWorkers(5)).toBe(4);
    expect(defaultParseWorkers(64)).toBe(4);
  });

  it("memoryParseWorkers：一半記憶體 ÷ 每個 worker 上限，至少 1", () => {
    expect(memoryParseWorkers(2 * 2 ** 30, 1024)).toBe(1);
    expect(memoryParseWorkers(16 * 2 ** 30, 1024)).toBe(8);
    expect(memoryParseWorkers(256 * 2 ** 20, 1024)).toBe(1);
  });
});
