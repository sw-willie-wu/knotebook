import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { selectVersionsToDelete, type VersionPolicyRow } from "../../src/collab/version-policy.js";

const NOW = new Date("2026-10-09T12:00:00Z"); // 週五
const at = (iso: string) => new Date(iso);
const auto = (seq: number, iso: string): VersionPolicyRow => ({ seq, kind: "auto", createdAt: at(iso) });
const manual = (seq: number, iso: string): VersionPolicyRow => ({ seq, kind: "manual", createdAt: at(iso) });
const run = (rows: VersionPolicyRow[], o: { f?: number; d?: number; base?: number | null } = {}) =>
  selectVersionsToDelete(rows, { now: NOW, keepAllDays: o.f ?? 7, dailyUntilDays: o.d ?? 30, baseSeq: o.base ?? null });

describe("selectVersionsToDelete（spec §10.1：F 天內全留、F–D 天每 UTC 日一版、D 天以上每 UTC 週一版）", () => {
  it("F 天內全留（同一天兩版也留）", () => {
    expect(run([auto(1, "2026-10-05T01:00:00Z"), auto(2, "2026-10-05T23:00:00Z"), auto(3, "2026-10-09T11:00:00Z")])).toEqual([]);
  });

  it("F–D 天：同一 UTC 日只留 createdAt 最新的一版；不同日各留", () => {
    const rows = [auto(1, "2026-09-20T01:00:00Z"), auto(2, "2026-09-20T23:00:00Z"), auto(3, "2026-09-21T10:00:00Z"), auto(9, "2026-10-09T11:00:00Z")];
    expect(run(rows)).toEqual([1]);
  });

  it("D 天以上：同一 UTC 週（週一 00:00 起）只留最新；跨週一 00:00 是不同週", () => {
    // 2026-07-27 是週一：s1（週六）、s2（週日 23:59:59）同一週；s3 是下一週的週一 00:00。
    const rows = [auto(1, "2026-08-01T10:00:00Z"), auto(2, "2026-08-02T23:59:59Z"), auto(3, "2026-08-03T00:00:00Z"), auto(9, "2026-10-09T11:00:00Z")];
    expect(run(rows)).toEqual([1]);
  });

  it("跨 F 邊界的同一日：F 內那版不跟 F 外那版比——F 外那版是它所在區間當日唯一的一版，留", () => {
    // F=7 的界線是 2026-10-02T12:00Z：r1 在界線外（7 天 1 小時）、r2 在界線內。
    const rows = [auto(1, "2026-10-02T11:00:00Z"), auto(2, "2026-10-02T13:00:00Z"), auto(9, "2026-10-09T11:00:00Z")];
    expect(run(rows)).toEqual([]);
  });

  it("跨 D 邊界的同一週：週桶只在 D 以上的列之間比", () => {
    // D=30 的界線是 2026-09-09T12:00Z（週三）；同週（2026-09-07 週一起）：r3 在 D 內（日桶）、r1／r2 在 D 外（週桶）。
    const rows = [auto(1, "2026-09-08T10:00:00Z"), auto(2, "2026-09-09T11:00:00Z"), auto(3, "2026-09-09T13:00:00Z"), auto(9, "2026-10-09T11:00:00Z")];
    expect(run(rows)).toEqual([1]);
  });

  it("恰好 F 天、恰好 D 天：落進較舊的那個區間（F ≤ age、D ≤ age）", () => {
    const rows = [auto(1, "2026-10-02T11:00:00Z"), auto(2, "2026-10-02T12:00:00Z"), auto(3, "2026-09-09T12:00:00Z"), auto(4, "2026-09-08T01:00:00Z"), auto(9, "2026-10-09T11:00:00Z")];
    // s2 恰 7 天 → 日桶，與 s1 同日且較新 → s1 刪；s3 恰 30 天 → 週桶，與 s4 同週（2026-09-07 起）且較新 → s4 刪。
    expect(run(rows)).toEqual([1, 4]);
  });

  it("F = D：沒有日桶，F 以外直接按週", () => {
    const rows = [auto(1, "2026-09-28T01:00:00Z"), auto(2, "2026-09-30T01:00:00Z"), auto(9, "2026-10-09T11:00:00Z")];
    expect(run(rows, { f: 7, d: 7 })).toEqual([1]); // 2026-09-28 是週一，兩列同週
  });

  it("手動、基底、最新一版永遠留；同一列滿足多條規則照樣只算一次", () => {
    const rows = [manual(1, "2026-08-01T00:00:00Z"), auto(2, "2026-08-01T01:00:00Z"), auto(3, "2026-08-01T02:00:00Z"), auto(4, "2026-08-01T03:00:00Z")];
    // s4 是最新（seq 最大）；s2 是基底；s1 手動；同週的自動只剩 s3 與 s4 競爭——s4 已因最新而留，s3 是週桶裡唯一的候選 → 留。
    expect(run(rows, { base: 2 })).toEqual([]);
    expect(run([...rows, auto(5, "2026-08-01T04:00:00Z")], { base: 2 })).toEqual([3]); // s5 成為最新，s4 與 s3 同週競爭、s4 較新
  });

  it("同一 createdAt：留 seq 較大者；空輸入回空；回傳遞增排序", () => {
    // seq 小的排前面（DB 的自然順序）——拿掉 tie-break 時先見到的 seq 3 會被留下、得 [5]（gate r1 實跑 NC4）。
    expect(run([auto(3, "2026-09-20T01:00:00Z"), auto(5, "2026-09-20T01:00:00Z"), auto(9, "2026-10-09T11:00:00Z")])).toEqual([3]);
    expect(run([])).toEqual([]);
    const many = [auto(7, "2026-09-20T01:00:00Z"), auto(2, "2026-09-20T02:00:00Z"), auto(4, "2026-09-20T03:00:00Z"), auto(9, "2026-10-09T11:00:00Z")];
    expect(run(many)).toEqual([2, 7]);
  });

  it("時間一律外部注入：檔內（剝註解後）沒有 Date.now 與 new Date(", () => {
    const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/collab/version-policy.ts");
    const code = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toMatch(/Date\.now|new Date\(/);
  });
});
