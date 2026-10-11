import { describe, expect, it } from "vitest";
import { BASIC_STORAGE_QUOTA_BYTES, STORAGE_KINDS, STORAGE_PLAN_NAME_MAX, STORAGE_QUOTA_MAX_BYTES, emptyStorageByKind, formatBytes, kindOfMime } from "./storage.js";
import { ERROR_CODES } from "./index.js";

describe("storage 常數（spec §4.1、§7.4、A3）", () => {
  it("上限 1 PiB 是 JS 安全整數；Basic＝2 GiB；名稱上限 40", () => {
    expect(STORAGE_QUOTA_MAX_BYTES).toBe(2 ** 50);
    expect(Number.isSafeInteger(STORAGE_QUOTA_MAX_BYTES)).toBe(true);
    expect(BASIC_STORAGE_QUOTA_BYTES).toBe(2 * 1024 ** 3);
    expect(STORAGE_PLAN_NAME_MAX).toBe(40);
  });

  it("五個新錯誤碼都在 ERROR_CODES（§8.1）", () => {
    for (const code of ["storage_quota_exceeded", "storage_plan_in_use", "storage_plan_is_default", "storage_plan_name_taken", "storage_plan_not_found"]) {
      expect(ERROR_CODES).toContain(code);
    }
  });
});

describe("formatBytes（1024 進位；整數不帶 .0、其餘一位小數——Willie 2026-10-08；server 的 MCP 訊息與 web 共用這一份）", () => {
  it("0 → 0 B", () => expect(formatBytes(0)).toBe("0 B"));
  it("1023 → 1023 B（未滿 1 KB 印整數）", () => expect(formatBytes(1023)).toBe("1023 B"));
  it("1024 → 1 KB（整數不帶 .0）", () => expect(formatBytes(1024)).toBe("1 KB"));
  it("1536 → 1.5 KB", () => expect(formatBytes(1536)).toBe("1.5 KB"));
  it("2^31 → 2 GB（Basic 方案的上限）", () => expect(formatBytes(2 ** 31)).toBe("2 GB"));
  it("500 MiB → 500 MB", () => expect(formatBytes(500 * 1024 ** 2)).toBe("500 MB"));
  it("1288490189 → 1.2 GB（非整數一位小數）", () => expect(formatBytes(1288490189)).toBe("1.2 GB"));
  it("2^50 → 1024 TB（TB 是最大單位，配額上限 1125899906842624＝2^50）", () => expect(formatBytes(2 ** 50)).toBe("1024 TB"));
  it("1048575 → 1 MB（四捨五入進位到 1024 KB 時改用下一個單位）", () => expect(formatBytes(1048575)).toBe("1 MB"));
  it("1572864 → 1.5 MB（web toast 例子）", () => expect(formatBytes(1572864)).toBe("1.5 MB"));
  it("1048525 → 1 MB（1023.9502 KB 的 toFixed(1) 是「1024.0」→ 換單位；不得印成「1024 KB」——起草者 node 實算；1048524 是「1023.9」不進位）", () => expect(formatBytes(1048525)).toBe("1 MB"));
});

describe("kindOfMime（#247 §9.1：分類規則只有這一份，server 的 byKind 與 web 都用它）", () => {
  it("每條規則各一案", () => {
    const cases: Array<[string, string]> = [
      ["image/png", "image"],
      ["image/svg+xml", "image"],
      ["audio/mpeg", "audio"],
      ["video/mp4", "video"],
      ["application/pdf", "document"],
      ["text/plain", "document"],
      ["text/markdown", "document"],
      ["application/vnd.openxmlformats-officedocument.wordprocessingml.document", "document"],
      ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "document"],
      ["application/msword", "document"],
      ["application/vnd.ms-excel", "document"],
      ["application/vnd.ms-powerpoint", "document"],
      ["application/rtf", "document"],
    ];
    for (const [mime, kind] of cases) expect(kindOfMime(mime), mime).toBe(kind);
  });

  it("其餘一律 other：未知、空字串、只像前綴的、openxml 但不是 officedocument 子樹", () => {
    for (const mime of ["application/zip", "application/octet-stream", "", "imagex/png", "application/json", "application/vnd.openxmlformats-package.relationships+xml", "application/vnd.ms-word"]) {
      expect(kindOfMime(mime), JSON.stringify(mime)).toBe("other");
    }
  });

  it("Review Focus 1：大小寫與參數不影響分類（取 `;` 前、trim、小寫）", () => {
    expect(kindOfMime("IMAGE/PNG")).toBe("image");
    expect(kindOfMime("text/plain; charset=utf-8")).toBe("document");
    expect(kindOfMime("  Application/PDF ;x=1")).toBe("document");
    expect(kindOfMime("Audio/OGG")).toBe("audio");
  });

  it("STORAGE_KINDS 是 UI 的固定五列順序；emptyStorageByKind 每次回新物件、五鍵皆 0", () => {
    expect(STORAGE_KINDS).toEqual(["image", "audio", "video", "document", "other"]);
    const a = emptyStorageByKind();
    expect(a).toEqual({ image: 0, audio: 0, video: 0, document: 0, other: 0 });
    a.image = 5;
    expect(emptyStorageByKind().image).toBe(0);
  });
});
