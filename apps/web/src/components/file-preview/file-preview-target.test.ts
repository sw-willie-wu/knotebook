import { describe, expect, it } from "vitest";
import { filePreviewKind, isPlainClick, isSiteUploadUrl } from "./file-preview-target";

const BASE = "https://notes.example/notes/n1";

describe("filePreviewKind", () => {
  it.each(["a.txt", "a.csv", "a.tsv", "a.md", "a.markdown", "a.log", "a.json", "UPPER.CSV", " spaced.md "])("%s is text", (name) => {
    expect(filePreviewKind(name)).toBe("text");
  });

  it.each(["spec.pdf", "SPEC.PDF"])("%s is a PDF", (name) => {
    expect(filePreviewKind(name)).toBe("pdf");
  });

  it.each(["report.docx", "sheet.xlsx", "slides.pptx", "notes.odt", "build.ps1", "config.yaml", "script.js", "pdf", "txt", "", "/api/uploads/u1"])(
    "%s has no preview",
    (name) => {
      expect(filePreviewKind(name)).toBeNull();
    },
  );
});

describe("isSiteUploadUrl", () => {
  it.each([
    "/api/uploads/u1",
    "https://notes.example/api/uploads/u1",
    "/api/public/notes/TOKEN/uploads/u1",
    "/api/public/notes/alice/my-note/uploads/u1",
  ])("%s is one of this site's upload URLs", (href) => {
    expect(isSiteUploadUrl(href, BASE)).toBe(true);
  });

  it.each([
    "https://other.example/api/uploads/u1",
    "//other.example/api/uploads/u1",
    "https://files.example/report.pdf",
    "/api/uploads/u1/finished",
    "/api/uploads/",
    "/api/public/notes/TOKEN",
    "/api/public/notes/a/b/c/uploads/u1",
    "/uploads/u1",
    "javascript:alert(1)",
    "",
  ])("%s is not", (href) => {
    expect(isSiteUploadUrl(href, BASE)).toBe(false);
  });
});

describe("isPlainClick", () => {
  const click = (init: MouseEventInit) => new MouseEvent("click", init);

  it("a primary click without modifiers is plain; keyboard Enter on a link dispatches the same click", () => {
    expect(isPlainClick(click({ button: 0 }))).toBe(true);
    expect(isPlainClick(click({ button: 0, detail: 0 }))).toBe(true);
  });

  it.each([
    ["Ctrl", { ctrlKey: true }],
    ["Cmd", { metaKey: true }],
    ["Shift", { shiftKey: true }],
    ["Alt", { altKey: true }],
    ["middle button", { button: 1 }],
  ] as const)("%s keeps the browser's default", (_label, init) => {
    expect(isPlainClick(click({ button: 0, ...init }))).toBe(false);
  });
});
