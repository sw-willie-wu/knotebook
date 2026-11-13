import { describe, expect, it } from "vitest";
import { formatBytes } from "@knotebook/shared";
import i18n from "@/i18n";
import { ApiFail } from "@/api/client";
import { storageQuotaDescription } from "./storage-quota-text";
import { storageQuotaDescription as reExported } from "@/uploads/upload-file";

const t = (key: string, opts?: Record<string, unknown>) => i18n.t(key, opts) as string;

function quotaError(storage?: Record<string, unknown>): ApiFail {
  const err = new ApiFail(409, "storage_quota_exceeded", "x");
  err.storage = storage as never;
  return err;
}

describe("storageQuotaDescription", () => {
  it("有用量與上限：用量說明句（en）", async () => {
    await i18n.changeLanguage("en");
    const text = storageQuotaDescription(quotaError({ incomingBytes: 1, usedBytes: 2048, quotaBytes: 4096 }), t);
    expect(text).toBe(`${formatBytes(2048)} of ${formatBytes(4096)} used. Ask a site admin for more space.`);
  });

  it("有用量與上限：用量說明句（zh-TW）", async () => {
    await i18n.changeLanguage("zh-TW");
    const text = storageQuotaDescription(quotaError({ incomingBytes: 1, usedBytes: 2048, quotaBytes: 4096 }), t);
    expect(text).toBe(`已使用 ${formatBytes(2048)}／${formatBytes(4096)}，請洽站台管理員增加空間`);
  });

  it("沒有用量、或上限為 null：通用句", async () => {
    await i18n.changeLanguage("en");
    const generic = "This space has no room for the file. Ask its owner or a site admin.";
    expect(storageQuotaDescription(quotaError(), t)).toBe(generic);
    expect(storageQuotaDescription(quotaError({ incomingBytes: 1, usedBytes: 5, quotaBytes: null }), t)).toBe(generic);
  });

  it("uploads/upload-file 原地轉出同一支函式", () => {
    expect(reExported).toBe(storageQuotaDescription);
  });
});
