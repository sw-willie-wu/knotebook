import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "./index.js";
import {
  VERSION_DAILY_UNTIL_DAYS_DEFAULT, VERSION_DAYS_MAX, VERSION_IDLE_MS, VERSION_KEEP_ALL_DAYS_DEFAULT,
  VERSION_LIST_LIMIT_DEFAULT, VERSION_LIST_LIMIT_MAX, VERSION_NAME_MAX, normalizeVersionName,
} from "./versions.js";

describe("versions 常數（spec A11、A12、§6.1、§6.3）", () => {
  it("安靜 5 分鐘、名稱 120、清單 50／100、天數 7／30／3650", () => {
    expect(VERSION_IDLE_MS).toBe(5 * 60_000);
    expect(VERSION_NAME_MAX).toBe(120);
    expect([VERSION_LIST_LIMIT_DEFAULT, VERSION_LIST_LIMIT_MAX]).toEqual([50, 100]);
    expect([VERSION_KEEP_ALL_DAYS_DEFAULT, VERSION_DAILY_UNTIL_DAYS_DEFAULT, VERSION_DAYS_MAX]).toEqual([7, 30, 3650]);
  });

  it("三個新錯誤碼都在 ERROR_CODES（§6）", () => {
    for (const code of ["version_is_base", "version_unsaved_changes", "version_mismatch"]) expect(ERROR_CODES).toContain(code);
  });
});

describe("normalizeVersionName（§6.3：去頭尾空白、空字串＝NULL、上限 120 字）", () => {
  it("null／空字串／只有空白（含全形空白）→ NULL", () => {
    expect(normalizeVersionName(null)).toEqual({ ok: true, name: null });
    expect(normalizeVersionName("")).toEqual({ ok: true, name: null });
    expect(normalizeVersionName(" \u3000\t ")).toEqual({ ok: true, name: null });
  });

  it("去頭尾空白、保留中間空白", () => {
    expect(normalizeVersionName("  初稿 v2  ")).toEqual({ ok: true, name: "初稿 v2" });
  });

  it("長度以 code point 計：120 個表情符號（.length 240）收下、121 個拒絕", () => {
    const smile = String.fromCodePoint(0x1f600);
    expect(normalizeVersionName(smile.repeat(120))).toEqual({ ok: true, name: smile.repeat(120) });
    expect(normalizeVersionName(smile.repeat(121))).toEqual({ ok: false });
    expect(normalizeVersionName("a".repeat(121))).toEqual({ ok: false });
  });

  it("NUL 與落單代理拒絕（PostgreSQL 存不下，§Global Constraints）；成對代理照收", () => {
    expect(normalizeVersionName(`a${String.fromCodePoint(0)}b`)).toEqual({ ok: false });
    expect(normalizeVersionName("a\uD800b")).toEqual({ ok: false });
    expect(normalizeVersionName("a\uDC00")).toEqual({ ok: false });
    expect(normalizeVersionName("\uD83D\uDE00")).toEqual({ ok: true, name: "\uD83D\uDE00" });
  });
});
