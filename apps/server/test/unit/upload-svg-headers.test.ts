import { describe, expect, it } from "vitest";
import { UPLOAD_CSP, uploadResponseHeaders } from "../../src/uploads/service.js";
import { toolResultWithText } from "../../src/mcp/tool-result.js";
import {
  READ_NOTE_IMAGE_DESCRIPTION_SESSION,
  READ_NOTE_IMAGE_DESCRIPTION_TOKEN,
  readNoteImageOutput,
} from "../../src/mcp/tools/read-note-image.js";
import { UPLOAD_NEXT } from "../../src/mcp/tools/create-transfer-token.js";

describe("upload response headers (#389)", () => {
  it("serves an SVG inline under the sandbox CSP that allows inline styles and data: images and fonts, with nosniff and immutable cache-control", () => {
    expect(UPLOAD_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox");
    expect(uploadResponseHeaders("image/svg+xml", "drawing.svg")).toEqual({
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=31536000, immutable",
      "content-type": "image/svg+xml",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox",
    });
  });
});

describe("MCP SVG output helpers and schemas (#389)", () => {
  it("toolResultWithText mirrors structuredContent in content[0] and places the raw text in content[1] without an image block", () => {
    const meta = { noteId: "n1", uploadId: "u1", mimeType: "image/svg+xml" as const, bytes: 42 };
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    const result = toolResultWithText(meta, svg);

    expect(result.structuredContent).toEqual(meta);
    expect(result.content).toEqual([
      { type: "text", text: JSON.stringify(meta) },
      { type: "text", text: svg },
    ]);
  });

  it("readNoteImageOutput accepts image/svg+xml and tool descriptions document SVG text return and cap", () => {
    expect(readNoteImageOutput.mimeType.safeParse("image/svg+xml").success).toBe(true);
    expect(READ_NOTE_IMAGE_DESCRIPTION_TOKEN).toContain("SVGs up to 102400 bytes as UTF-8 XML text");
    expect(READ_NOTE_IMAGE_DESCRIPTION_SESSION).toContain("SVGs up to 102400 bytes as UTF-8 XML text");
    expect(UPLOAD_NEXT).toContain("415: not a supported type — an image (PNG, JPEG, GIF, WebP or SVG)");
  });
});
