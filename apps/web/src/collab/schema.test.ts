import { describe, expect, it } from "vitest";
import { defaultBlockSpecs } from "@blocknote/core";
import { containsMediaDataUrl, isBlockedMediaTransfer, noteSchema } from "./schema";

/** 最小的 DataTransfer 替身——jsdom 沒有可建構的 DataTransfer。 */
function transfer(options: { files?: number; html?: string; text?: string }): DataTransfer {
  const map: Record<string, string> = {};
  if (options.html !== undefined) map["text/html"] = options.html;
  if (options.text !== undefined) map["text/plain"] = options.text;
  return {
    files: { length: options.files ?? 0 } as unknown as FileList,
    getData: (type: string) => map[type] ?? "",
  } as unknown as DataTransfer;
}

describe("noteSchema（§11.1 不啟用 image block）", () => {
  it("沒有 image block", () => {
    expect(Object.keys(noteSchema.blockSpecs)).not.toContain("image");
    expect("image" in noteSchema.blockSchema).toBe(false);
  });

  it("其餘預設 block 全數保留", () => {
    const expected = Object.keys(defaultBlockSpecs).filter((key) => key !== "image");
    expect(Object.keys(noteSchema.blockSpecs).sort()).toEqual(expected.sort());
  });

  it("段落與標題這些基本 block 仍在（防止整份 schema 建錯）", () => {
    expect(Object.keys(noteSchema.blockSpecs)).toEqual(expect.arrayContaining(["paragraph", "heading", "table"]));
  });
});

describe("containsMediaDataUrl", () => {
  it("認得 img src 的 base64 data URL", () => {
    expect(containsMediaDataUrl('<img src="data:image/png;base64,iVBORw0KGgo=">')).toBe(true);
  });

  it("認得純文字貼上的 data URL（行首）", () => {
    expect(containsMediaDataUrl("data:image/gif;base64,R0lGOD")).toBe(true);
  });

  it("認得非 base64 的 data URL（逗號結尾的參數段）", () => {
    expect(containsMediaDataUrl('<img src="data:image/svg+xml,%3Csvg/%3E">')).toBe(true);
  });

  it("認得 video/audio", () => {
    expect(containsMediaDataUrl("data:video/mp4;base64,AAA")).toBe(true);
    expect(containsMediaDataUrl("data:audio/mpeg;base64,AAA")).toBe(true);
  });

  it("不誤擋一般文字裡的 data: 字樣與非媒體 data URL", () => {
    expect(containsMediaDataUrl("請參考 data structures 這一章")).toBe(false);
    expect(containsMediaDataUrl("data:text/plain;base64,aGk=")).toBe(false);
    expect(containsMediaDataUrl("mydata:image/png;base64,x")).toBe(false);
    expect(containsMediaDataUrl("")).toBe(false);
    expect(containsMediaDataUrl(null)).toBe(false);
  });
});

describe("isBlockedMediaTransfer", () => {
  it("有檔案就擋（截圖貼上／拖曳圖檔）", () => {
    expect(isBlockedMediaTransfer(transfer({ files: 1 }))).toBe(true);
  });

  it("HTML 片段帶 data URL 就擋（從網頁複製圖片常見形狀）", () => {
    expect(isBlockedMediaTransfer(transfer({ html: '<img src="data:image/png;base64,AAA">' }))).toBe(true);
  });

  it("純文字帶 data URL 就擋", () => {
    expect(isBlockedMediaTransfer(transfer({ text: "data:image/png;base64,AAA" }))).toBe(true);
  });

  it("純文字／一般 HTML 放行", () => {
    expect(isBlockedMediaTransfer(transfer({ text: "hello", html: "<p>hello</p>" }))).toBe(false);
    expect(isBlockedMediaTransfer(transfer({}))).toBe(false);
  });

  it("沒有 dataTransfer 一律放行", () => {
    expect(isBlockedMediaTransfer(null)).toBe(false);
    expect(isBlockedMediaTransfer(undefined)).toBe(false);
  });
});
