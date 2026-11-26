import { describe, expect, it } from "vitest";
import {
  sanitizeUploadFileName,
  textMimeForExtension,
  uploadCategoryOfName,
  uploadKindOfMime,
  uploadLimitClass,
  uploadServedName,
  UPLOAD_TYPES,
} from "./upload-types.js";
import { kindOfMime } from "./storage.js";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

describe("uploadServedName", () => {
  it.each([
    [null, "application/pdf", "u1.pdf"],
    ["report.jar", DOCX, "report.docx"],
    ["report.DOCX", DOCX, "report.DOCX"],
    ["build.ps1", "text/plain", "build.ps1.txt"],
    ["data.csv", "text/csv", "data.csv"],
    ["notes.tsv", "text/plain", "notes.tsv"],
    ["README", "text/plain", "README.txt"],
    ["song.mp3", "audio/mpeg", "song.mp3"],
    ["song", "audio/mpeg", "song.mp3"],
    ["song.", "audio/mpeg", "song.mp3"],
    [".hidden", "application/pdf", ".hidden.pdf"],
    ["a.b.exe", "audio/mpeg; codecs=x", "a.b.mp3"],
  ])("%s as %s", (stored, mime, want) => {
    expect(uploadServedName(stored, mime, "u1")).toBe(want);
  });
});

describe("uploadServedName with an unlisted mime", () => {
  it("never keeps the stored extension", () => {
    expect(uploadServedName("evil.html", "image/svg+xml", "u1")).toBe("u1");
    expect(uploadServedName(null, "application/x-unknown", "u1")).toBe("u1");
  });
});

describe("sanitizeUploadFileName", () => {
  it("drops bidi controls and separators", () => {
    expect(sanitizeUploadFileName("a\u202Egnp.exe")).not.toContain("\u202E");
    expect(sanitizeUploadFileName("x/y\\z.txt")).toBe("xyz.txt");
  });
  it("normalizes to NFC", () => {
    expect(sanitizeUploadFileName("e\u0301.txt")).toBe("\u00E9.txt");
  });
  it("cuts at a code point boundary within 200 bytes", () => {
    const out = sanitizeUploadFileName("\u4F60".repeat(100))!;
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(200);
    expect(out).toBe("\u4F60".repeat(66));
    expect(sanitizeUploadFileName("\u{1F600}".repeat(100))).toBe("\u{1F600}".repeat(50));
  });
  it("keeps the extension when the stem is cut", () => {
    const out = sanitizeUploadFileName("報".repeat(70) + ".txt")!;
    expect(out.endsWith(".txt")).toBe(true);
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(200);
    expect(uploadCategoryOfName(out)).toBe("text");
  });
  it("caps a name whose extension alone is huge", () => {
    const out = sanitizeUploadFileName("a." + "x".repeat(500))!;
    expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(200);
    const out2 = sanitizeUploadFileName("a".repeat(300) + "." + "x".repeat(40))!;
    expect(new TextEncoder().encode(out2).length).toBeLessThanOrEqual(200);
  });
  it("strips lone surrogates and normalizes after stripping", () => {
    expect(sanitizeUploadFileName("\uD800abc.txt")).toBe("abc.txt");
    const r = sanitizeUploadFileName("e\u200B\u0301.txt")!;
    expect(r).toBe("\u00E9.txt");
    expect(r).toBe(r.normalize("NFC"));
  });
  it("returns null when nothing is left", () => {
    expect(sanitizeUploadFileName("\u200B")).toBeNull();
    expect(sanitizeUploadFileName("  ")).toBeNull();
  });
});

describe("categories and mimes", () => {
  it("uploadCategoryOfName", () => {
    expect(uploadCategoryOfName("A.MP4")).toBe("video");
    expect(uploadCategoryOfName("x.html")).toBeNull();
    expect(uploadCategoryOfName("x.svg")).toBeNull();
    expect(uploadCategoryOfName("x.ps1")).toBe("text");
    expect(uploadCategoryOfName("x.xlsx")).toBe("office");
    expect(uploadCategoryOfName("noext")).toBeNull();
  });
  it("textMimeForExtension", () => {
    expect(textMimeForExtension("tsv")).toBe("text/plain");
    expect(textMimeForExtension("CSV")).toBe("text/csv");
    expect(textMimeForExtension("md")).toBe("text/markdown");
  });
  it("kinds", () => {
    expect(uploadKindOfMime("video/mp4; x=1")).toBe("video");
    expect(uploadKindOfMime("application/pdf")).toBe("file");
    expect(uploadKindOfMime("image/png")).toBe("image");
    expect(uploadLimitClass("audio")).toBe("media");
    expect(uploadLimitClass("pdf")).toBe("document");
  });
  it("storage kind of the ODF mimes is document", () => {
    for (const m of ["text", "spreadsheet", "presentation"]) {
      expect(kindOfMime(`application/vnd.oasis.opendocument.${m}`)).toBe("document");
    }
  });
  it("refused types are not in the table", () => {
    for (const m of ["audio/aac", "video/x-matroska", "image/svg+xml", "application/vnd.ms-word.document.macroEnabled.12"]) {
      expect(UPLOAD_TYPES[m]).toBeUndefined();
    }
  });
});
