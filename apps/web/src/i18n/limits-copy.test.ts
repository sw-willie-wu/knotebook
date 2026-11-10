import { describe, expect, it } from "vitest";
import { SITE_LIMIT_KEYS, SITE_LIMITS } from "@knotebook/shared";
import enRaw from "./en.json?raw";
import zhTWRaw from "./zh-TW.json?raw";
import managementEn from "./management.en.json";
import managementZhTW from "./management.zh-TW.json";

/** 站台限制頁文案守衛：註冊表每一項、每個分類都有中英文案；`errors.limit_locked_by_env` 逐字。 */

function get(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

const bundles = [
  ["en", managementEn],
  ["zh-TW", managementZhTW],
] as const;

describe.each(bundles)("站台限制文案（%s）", (_lang, bundle) => {
  it.each(SITE_LIMIT_KEYS.map((k) => [k]))("%s 有 label 與 description", (key) => {
    for (const field of ["label", "description"]) {
      const v = get(bundle, `admin.limits.items.${key}.${field}`);
      expect(typeof v, `${key}.${field}`).toBe("string");
      expect((v as string).trim().length).toBeGreaterThan(0);
    }
  });

  it.each(SITE_LIMIT_KEYS.map((k) => [k]))("%s 的名稱與說明是該語系的文字（zh-TW 含中文、en 不含）", (key) => {
    const cjk = /[一-鿿]/;
    for (const field of ["label", "description"]) {
      const v = get(bundle, `admin.limits.items.${key}.${field}`) as string;
      if (_lang === "zh-TW") expect(cjk.test(v), `${key}.${field}`).toBe(true);
      else expect(cjk.test(v), `${key}.${field}`).toBe(false);
    }
  });

  it("每個用到的分類都有名稱", () => {
    const categories = new Set(Object.values(SITE_LIMITS).map((d) => d.category));
    for (const c of categories) {
      const v = get(bundle, `admin.limits.categories.${c}`);
      expect(typeof v, c).toBe("string");
      expect((v as string).length).toBeGreaterThan(0);
    }
  });

  it("頁標題、說明、儲存鈕、調低後果與「數值不在可調範圍內」都有", () => {
    for (const path of [
      "admin.limits.title",
      "admin.limits.description",
      "admin.limits.actions.save",
      "admin.limits.actions.resetDefault",
      "admin.limits.actions.resetAuto",
      "admin.limits.consequences.parseTimeoutMs",
      "admin.limits.consequences.parseWorkerMemoryMb",
      "admin.limits.consequences.parseQueueWaitMs",
      "admin.limits.memoryWarning_one",
      "admin.limits.memoryWarning_other",
      "admin.limits.invalidRange",
      "admin.limits.validation.notInteger",
      "admin.limits.validation.outOfRange",
      "admin.limits.changes.heading",
      "admin.limits.changes.actorGone",
    ]) {
      expect(typeof get(bundle, path), path).toBe("string");
    }
  });
});

describe("主檔", () => {
  it("admin.nav.limits 兩語", () => {
    expect(get(JSON.parse(enRaw), "admin.nav.limits")).toBe("Site limits");
    expect(get(JSON.parse(zhTWRaw), "admin.nav.limits")).toBe("站台限制");
  });

  it("errors.limit_locked_by_env 逐字", () => {
    expect(get(JSON.parse(enRaw), "errors.limit_locked_by_env")).toBe("This setting is set in the server's .env file. Change it there and restart the server.");
    expect(get(JSON.parse(zhTWRaw), "errors.limit_locked_by_env")).toBe("這一項由伺服器的 .env 設定，請改 .env 並重啟伺服器。");
  });
});

/** 名稱逐字（key → [en, zh-TW]）；兩個項目對調名稱或說明就紅。 */
const LABELS: Record<string, [string, string]> = {
  uploadMaxBytes: ["Upload size limit", "上傳檔案大小上限"],
  noteMaxBytes: ["Note size limit", "筆記大小上限"],
  parseWorkers: ["Number of parse workers","解析 worker 數"],
  parseWorkerMemoryMb: ["Memory per worker", "每個 worker 記憶體上限"],
  parseTimeoutMs: ["Parse time limit", "解析時限"],
  parseQueueWaitMs: ["Longest wait for a worker", "排隊最長等待"],
  rateTokenRead: ["API and MCP reads", "API／MCP 讀取次數"],
  rateTokenWrite: ["API and MCP writes", "API／MCP 寫入次數"],
  rateContentRead: ["Note content reads", "讀筆記內容次數"],
  rateEdit: ["Note content writes", "寫筆記內容次數"],
  rateSearch: ["Searches", "全文搜尋次數"],
  rateUpload: ["Uploads and copies", "上傳與複製次數"],
  rateAi: ["AI actions", "站內 AI 次數"],
  rateTransferExport: ["Bulk downloads", "批次下載次數"],
  rateTransferWrite: ["Bulk write-backs", "批次寫回次數"],
  sessionTtlSeconds: ["Web sign-in lasts", "網頁登入有效期"],
  apiTokensPerUser: ["Active API tokens per person", "每人有效 API token 上限"],
};

/** 每項說明裡該項獨有（同分類其他項的說明沒有）的一個詞（key → [en, zh-TW]）。 */
const DESCRIPTION_MARKERS: Record<string, [string, string]> = {
  uploadMaxBytes: ["upload", "檔案"],
  noteMaxBytes: ["note's", "單篇"],
  parseWorkers: ["same time", "Markdown"],
  parseWorkerMemoryMb: ["Memory each worker", "記憶體"],
  parseTimeoutMs: ["conversion may run", "轉換"],
  parseQueueWaitMs: ["free worker", "空閒"],
  rateTokenRead: ["Read requests", "MCP 讀取"],
  rateTokenWrite: ["Write requests", "MCP 寫入"],
  rateContentRead: ["Note content reads", "讀取筆記內容"],
  rateEdit: ["Note content writes", "寫入筆記內容"],
  rateSearch: ["Full-text", "全文搜尋"],
  rateUpload: ["Files uploaded", "上傳檔案"],
  rateAi: ["AI requests", "站內 AI"],
  rateTransferExport: ["Bulk downloads", "批次下載"],
  rateTransferWrite: ["write-back", "批次寫回"],
  sessionTtlSeconds: ["sign-in", "網頁登入"],
  apiTokensPerUser: ["revoke", "撤銷"],
};

describe("名稱與說明逐項釘住", () => {
  it("表涵蓋註冊表每一項", () => {
    expect(Object.keys(LABELS).sort()).toEqual([...SITE_LIMIT_KEYS].sort());
    expect(Object.keys(DESCRIPTION_MARKERS).sort()).toEqual([...SITE_LIMIT_KEYS].sort());
  });

  describe.each([
    ["en", managementEn, 0],
    ["zh-TW", managementZhTW, 1],
  ] as const)("%s", (_lang, bundle, col) => {
    it.each(SITE_LIMIT_KEYS.map((k) => [k]))("%s 名稱逐字", (key) => {
      expect(get(bundle, `admin.limits.items.${key}.label`)).toBe(LABELS[key]![col]);
    });

    it.each(SITE_LIMIT_KEYS.map((k) => [k]))("%s 的說明含自己的詞、不含同分類別項的詞", (key) => {
      const desc = (k: string) => get(bundle, `admin.limits.items.${k}.description`) as string;
      const category = SITE_LIMITS[key].category;
      expect(desc(key), key).toContain(DESCRIPTION_MARKERS[key]![col]);
      for (const other of SITE_LIMIT_KEYS) {
        if (other === key || SITE_LIMITS[other].category !== category) continue;
        expect(desc(other), `${other} 不該含 ${key} 的詞`).not.toContain(DESCRIPTION_MARKERS[key]![col]);
      }
    });
  });

  it("調低後果（zh-TW）逐字", () => {
    expect(get(managementZhTW, "admin.limits.consequences.parseTimeoutMs")).toBe(
      "調低後，整段密集格式（例如大量換行分隔的字）的寫入可能被拒；讀出與批次下載的時限是這個值的 3 倍，太低時大筆記可能讀不出來。",
    );
    expect(get(managementZhTW, "admin.limits.consequences.parseWorkerMemoryMb")).toBe(
      "調低後，整段密集格式（量過的要 640–768 MiB）與巢狀很深的格式可能被拒，大筆記的讀出也可能因記憶體不足失敗；worker 也會更常換新，處理速度可能變慢。",
    );
    expect(get(managementZhTW, "admin.limits.consequences.parseQueueWaitMs")).toBe(
      "比「4 × 解析時限＋5 秒」短時，排在一件慢工作後面的請求可能先收到忙碌錯誤。",
    );
  });

  it("範圍小字的分隔是「 · 」", () => {
    expect(get(managementZhTW, "admin.limits.defaultAndRange")).toBe("預設 {{default}} · 範圍 {{min}}–{{max}}");
    expect(get(managementZhTW, "admin.limits.defaultAndRangeWindow")).toBe("預設 {{default}} · 範圍 {{min}}–{{max}} · 每 {{window}}");
  });
});
