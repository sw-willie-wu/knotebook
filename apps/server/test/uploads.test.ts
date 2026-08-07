import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { buildTestApp } from "./helpers.js";

describe("uploadsDir 啟動期可寫性探測（Task 9，AppDeps.uploadsDir）", () => {
  it("uploadsDir 的父路徑其實是一般檔案（非目錄）→ buildApp 同步 throw、fail-fast（與 mode 無關）", async () => {
    // fixture：先建一個真實存在的父目錄，裡面放一個「一般檔案」，再把
    // `<該檔案>/uploads` 當成 uploadsDir 傳進去——任何試圖在它底下寫入探針檔的
    // 動作都會因為路徑上有一段其實是檔案（ENOTDIR）而失敗，與該檔案的權限
    // mode 完全無關（即使 chmod 777 依然是「檔案」不是「目錄」）。
    const parentDir = mkdtempSync(path.join(os.tmpdir(), "knotebook-uploads-fixture-"));
    const regularFile = path.join(parentDir, "not-a-directory");
    writeFileSync(regularFile, "");
    const bogusUploadsDir = path.join(regularFile, "uploads");

    try {
      await expect(buildTestApp({ uploadsDir: bogusUploadsDir })).rejects.toThrow(/uploads 目錄不可寫/);
    } finally {
      rmSync(parentDir, { recursive: true, force: true });
    }
  });
});
