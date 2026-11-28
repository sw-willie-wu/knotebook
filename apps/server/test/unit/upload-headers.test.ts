import { describe, expect, it } from "vitest";
import { contentDisposition, UPLOAD_CSP, UPLOAD_PDF_CSP, uploadResponseHeaders } from "../../src/uploads/service.js";

const CACHE = "private, max-age=31536000, immutable";
const OOXML = "application/vnd.openxmlformats-officedocument.";

describe("upload CSP constants", () => {
  it("are pinned verbatim", () => {
    expect(UPLOAD_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox");
    expect(UPLOAD_PDF_CSP).toBe("default-src 'none'; frame-ancestors 'self'");
  });
});

describe("contentDisposition", () => {
  it("sends an ASCII fallback with non-ASCII replaced and the real name RFC 5987-encoded", () => {
    expect(contentDisposition("attachment", "報告.docx")).toBe(
      "attachment; filename=\"__.docx\"; filename*=UTF-8''%E5%A0%B1%E5%91%8A.docx",
    );
  });

  it("drops quotes and backslashes from the fallback, percent-encodes them in filename*, and strips an RTL override from both", () => {
    const value = contentDisposition("inline", 'say "hi"\\x\u202Etxt.exe');
    expect(value).toBe("inline; filename=\"say hixtxt.exe\"; filename*=UTF-8''say%20%22hi%22%5Cxtxt.exe");
    expect(value).not.toContain("\u202E");
  });

  it("percent-encodes the characters encodeURIComponent leaves alone but RFC 5987 does not allow, and a literal %", () => {
    expect(contentDisposition("attachment", "a'(b)*100%.txt")).toBe(
      "attachment; filename=\"a'(b)*100%.txt\"; filename*=UTF-8''a%27%28b%29%2A100%25.txt",
    );
  });

  it("emits only printable ASCII even for control characters and lone surrogates", () => {
    const value = contentDisposition("attachment", "a\r\nb\uD800c.txt");
    expect(value).toMatch(/^[\x20-\x7e]*$/);
    expect(value).toBe("attachment; filename=\"ab_c.txt\"; filename*=UTF-8''ab%EF%BF%BDc.txt");
  });
});

describe("uploadResponseHeaders: exact header set per class", () => {
  it("audio: inline under UPLOAD_CSP", () => {
    expect(uploadResponseHeaders("audio/mpeg", "song.mp3")).toEqual({
      "x-content-type-options": "nosniff",
      "cache-control": CACHE,
      "content-type": "audio/mpeg",
      "content-security-policy": UPLOAD_CSP,
      "content-disposition": "inline; filename=\"song.mp3\"; filename*=UTF-8''song.mp3",
    });
  });

  it("video: inline under UPLOAD_CSP", () => {
    expect(uploadResponseHeaders("video/mp4", "clip.mp4")).toEqual({
      "x-content-type-options": "nosniff",
      "cache-control": CACHE,
      "content-type": "video/mp4",
      "content-security-policy": UPLOAD_CSP,
      "content-disposition": "inline; filename=\"clip.mp4\"; filename*=UTF-8''clip.mp4",
    });
  });

  it("PDF: inline with its own CSP, no sandbox, framable by this site only", () => {
    const headers = uploadResponseHeaders("application/pdf", "spec.pdf");
    expect(headers).toEqual({
      "x-content-type-options": "nosniff",
      "cache-control": CACHE,
      "content-type": "application/pdf",
      "content-security-policy": "default-src 'none'; frame-ancestors 'self'",
      "content-disposition": "inline; filename=\"spec.pdf\"; filename*=UTF-8''spec.pdf",
    });
    expect(headers["content-security-policy"]).not.toContain("sandbox");
  });

  it("docx: a download", () => {
    expect(uploadResponseHeaders(`${OOXML}wordprocessingml.document`, "report.docx")).toEqual({
      "x-content-type-options": "nosniff",
      "cache-control": CACHE,
      "content-type": `${OOXML}wordprocessingml.document`,
      "content-security-policy": UPLOAD_CSP,
      "content-disposition": "attachment; filename=\"report.docx\"; filename*=UTF-8''report.docx",
    });
  });

  it("odt: a download", () => {
    expect(uploadResponseHeaders("application/vnd.oasis.opendocument.text", "notes.odt")).toEqual({
      "x-content-type-options": "nosniff",
      "cache-control": CACHE,
      "content-type": "application/vnd.oasis.opendocument.text",
      "content-security-policy": UPLOAD_CSP,
      "content-disposition": "attachment; filename=\"notes.odt\"; filename*=UTF-8''notes.odt",
    });
  });

  it("UTF-8 CSV: served inline as text/plain, never as its stored text type", () => {
    expect(uploadResponseHeaders("text/csv; charset=utf-8", "data.csv")).toEqual({
      "x-content-type-options": "nosniff",
      "cache-control": CACHE,
      "content-type": "text/plain; charset=utf-8",
      "content-security-policy": UPLOAD_CSP,
      "content-disposition": "inline; filename=\"data.csv\"; filename*=UTF-8''data.csv",
    });
  });

  it("Latin-1 CSV (stored without a charset): a download with the stored mime", () => {
    expect(uploadResponseHeaders("text/csv", "data.csv")).toEqual({
      "x-content-type-options": "nosniff",
      "cache-control": CACHE,
      "content-type": "text/csv",
      "content-security-policy": UPLOAD_CSP,
      "content-disposition": "attachment; filename=\"data.csv\"; filename*=UTF-8''data.csv",
    });
  });

  it("UTF-16 log (stored without a charset): a download", () => {
    expect(uploadResponseHeaders("text/plain", "app.log")).toEqual({
      "x-content-type-options": "nosniff",
      "cache-control": CACHE,
      "content-type": "text/plain",
      "content-security-policy": UPLOAD_CSP,
      "content-disposition": "attachment; filename=\"app.log\"; filename*=UTF-8''app.log",
    });
  });

  it("a charset other than UTF-8 is not treated as UTF-8", () => {
    expect(uploadResponseHeaders("text/plain; charset=iso-8859-1", "a.txt")["content-disposition"]).toMatch(/^attachment;/);
  });

  it("PNG: inline under UPLOAD_CSP without Content-Disposition", () => {
    expect(uploadResponseHeaders("image/png", "photo.png")).toEqual({
      "x-content-type-options": "nosniff",
      "cache-control": CACHE,
      "content-type": "image/png",
      "content-security-policy": UPLOAD_CSP,
    });
  });

  it("SVG: inline as image/svg+xml under UPLOAD_CSP without Content-Disposition", () => {
    expect(uploadResponseHeaders("image/svg+xml", "drawing.svg")).toEqual({
      "x-content-type-options": "nosniff",
      "cache-control": CACHE,
      "content-type": "image/svg+xml",
      "content-security-policy": UPLOAD_CSP,
    });
  });

  it("an unlisted stored mime is never echoed: a legacy text/html row downloads as application/octet-stream", () => {
    const headers = uploadResponseHeaders("text/html; charset=utf-8", "page.html");
    expect(headers["content-type"]).toBe("application/octet-stream");
    expect(headers["content-disposition"]).toMatch(/^attachment;/);
  });
});
