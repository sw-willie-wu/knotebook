import { describe, expect, it } from "vitest";
import { SITE_LIMIT_KEYS, siteLimitDef } from "@knotebook/shared";
import { loadConfig } from "../../src/config.js";

const base = { DATABASE_URL: "postgres://u:p@localhost:5432/db", APP_SECRET: "a".repeat(64), PUBLIC_URL: "https://notes.example.com" };
const withEnv = SITE_LIMIT_KEYS.filter(k => siteLimitDef(k).env);
const ALL_ENV = { NOTE_MAX_BYTES: "2097152", PARSE_WORKERS: "2", PARSE_WORKER_MEMORY_MB: "512", PARSE_TIMEOUT_MS: "5000", PARSE_QUEUE_WAIT_MS: "5000" };

describe("loadConfig 的 limitEnv（#397）", () => {
  it("每個有 env 的項目：設了 → limitEnv 有；空字串 → 沒有", () => {
    expect(withEnv.length).toBe(5);
    for (const key of withEnv) {
      const env = siteLimitDef(key).env!;
      const v = key === "parseQueueWaitMs" ? 5000 : siteLimitDef(key).min;
      expect(loadConfig({ ...base, [env]: String(v) }).limitEnv[key], key).toBe(v);
      expect(Object.hasOwn(loadConfig({ ...base, [env]: "" }).limitEnv, key), key).toBe(false);
      expect(Object.hasOwn(loadConfig(base).limitEnv, key), key).toBe(false);
    }
  });
  it("沒有 env 的項目永遠不在 limitEnv", () => {
    const c = loadConfig({ ...base, ...ALL_ENV });
    expect(Object.keys(c.limitEnv).sort()).toEqual(withEnv.slice().sort());
  });
  it("env 可超出管理頁範圍", () => {
    expect(loadConfig({ ...base, NOTE_MAX_BYTES: "104857600" }).limitEnv.noteMaxBytes).toBe(104857600);
    expect(loadConfig({ ...base, PARSE_TIMEOUT_MS: "60000" }).limitEnv.parseTimeoutMs).toBe(60000);
  });
  it("越界照舊開機失敗（訊息不變）", () => {
    expect(() => loadConfig({ ...base, PARSE_WORKERS: "0" })).toThrow("設定錯誤：PARSE_WORKERS 必須是 1 到 32 的整數：0");
    expect(() => loadConfig({ ...base, NOTE_MAX_BYTES: "0" })).toThrow(/NOTE_MAX_BYTES 必須是正整數（最大 1073741824）：0/);
  });
  it("machine 有 cpus／memoryBytes 與來源", () => {
    const m = loadConfig(base).machine;
    expect(m.cpus).toBeGreaterThan(0);
    expect(m.memoryBytes).toBeGreaterThan(0);
    expect(["cgroup-v2", "cgroup-v1", "os"]).toContain(m.cpuSource);
    expect(["cgroup-v2", "cgroup-v1", "os"]).toContain(m.memorySource);
  });
});
