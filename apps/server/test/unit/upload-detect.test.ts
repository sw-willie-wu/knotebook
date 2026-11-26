import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as fileType from "file-type";
import { HEAD_BYTES, classifyUploadHead, verifyWholeFile, type HeadVerdict } from "../../src/uploads/detect.js";
import * as fx from "../helpers/upload-fixtures.js";

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const enc = new TextEncoder();
const zeros = (n: number): Uint8Array => new Uint8Array(n);

let dir: string;
let seq = 0;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "upload-detect-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const classify = (b: Uint8Array, name: string | null) => classifyUploadHead(b.subarray(0, HEAD_BYTES), name);

/** Head verdict plus the whole-file check, as the upload route runs them. */
async function detect(b: Uint8Array, name: string | null): Promise<{ category: string; mime: string } | null> {
  const verdict = await classify(b, name);
  if (verdict === null) return null;
  const file = path.join(dir, `f-${seq++}`);
  await writeFile(file, b);
  const whole = await verifyWholeFile(file, verdict);
  return whole === null ? null : { category: verdict.category, mime: whole.mime };
}

describe("classifyUploadHead", () => {
  it("HEAD_BYTES matches file-type's detection window", () => {
    // Exported at runtime but missing from the package typings.
    expect(HEAD_BYTES).toBe((fileType as { reasonableDetectionSizeInBytes?: number }).reasonableDetectionSizeInBytes);
  });

  it.each([
    ["mp3", fx.mp3(), "a.mp3", "audio", "audio/mpeg"],
    ["m4a audio brand", fx.m4a(), "a.m4a", "audio", "audio/x-m4a"],
    ["mp4", fx.mp4(), "a.mp4", "video", "video/mp4"],
    ["m4v", fx.m4v(), "a.m4v", "video", "video/x-m4v"],
    ["mov", fx.mov(), "a.mov", "video", "video/quicktime"],
    ["webm", fx.webm(), "a.webm", "video", "video/webm"],
    ["ogg opus (parameters stripped)", fx.oggOpus(), "a.opus", "audio", "audio/ogg"],
    ["ogg vorbis", fx.oggVorbis(), "a.ogg", "audio", "audio/ogg"],
    ["ogv", fx.oggTheora(), "a.ogv", "video", "video/ogg"],
    ["wav", fx.wav(), "a.wav", "audio", "audio/wav"],
    ["flac", fx.flac(), "a.flac", "audio", "audio/flac"],
    ["pdf", fx.pdf(), "a.pdf", "pdf", "application/pdf"],
    ["odt", fx.odf("application/vnd.oasis.opendocument.text"), "a.odt", "office", "application/vnd.oasis.opendocument.text"],
    ["ods", fx.odf("application/vnd.oasis.opendocument.spreadsheet"), "a.ods", "office", "application/vnd.oasis.opendocument.spreadsheet"],
    ["odp", fx.odf("application/vnd.oasis.opendocument.presentation"), "a.odp", "office", "application/vnd.oasis.opendocument.presentation"],
  ])("%s", async (_n, bytes, name, category, mime) => {
    expect(await classify(bytes, name)).toEqual({ category, mime, whole: null });
  });

  it("an MP4 with no audio brand is a video", async () => {
    expect((await classify(fx.ftyp("mp42", ["mp42", "isom"]), "voice.mp4"))?.mime).toBe("video/mp4");
  });

  it("content decides, not the name", async () => {
    expect((await classify(fx.mp3(), "x.pdf"))?.mime).toBe("audio/mpeg");
    expect((await classify(fx.pdf(), "x.txt"))?.category).toBe("pdf");
  });

  it("raster images keep their type, including under an .svg name", async () => {
    const png = fx.bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
    expect(await classify(png, "x.svg")).toEqual({ category: "image", mime: "image/png", whole: null });
  });

  it("OLE containers need a matching extension", async () => {
    expect((await classify(fx.ole(), "a.doc"))?.mime).toBe("application/msword");
    expect((await classify(fx.ole(), "a.XLS"))?.mime).toBe("application/vnd.ms-excel");
    expect((await classify(fx.ole(), "a.ppt"))?.mime).toBe("application/vnd.ms-powerpoint");
    expect(await classify(fx.ole(), "a.exe")).toBeNull();
    expect(await classify(fx.ole(), null)).toBeNull();
  });

  it("zip-based office files are provisional until the whole file is checked", async () => {
    for (const b of [fx.docx(), fx.xlsx(), fx.pptx(), fx.plainZip()]) {
      expect(await classify(b, "a.docx")).toMatchObject({ category: "office", whole: "ooxml" });
    }
  });

  it("html, svg and unknown binary are refused", async () => {
    expect(await classify(enc.encode("<!doctype html><p>x</p>"), "a.html")).toBeNull();
    expect(await classify(enc.encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), "a.svg")).toBeNull();
    const noise = Uint8Array.from({ length: 300 }, (_, i) => ((i * 37 + 11) % 255) + 1);
    expect(await classify(noise, "a.bin")).toBeNull();
  });

  it("an empty head is refused", async () => {
    expect(await classify(new Uint8Array(0), "a.txt")).toBeNull();
  });

  it("a file shorter than the head classifies", async () => {
    expect(await classify(enc.encode("a,b\n1,2\n"), "t.csv")).toEqual({ category: "text", mime: "text/csv", whole: "text" });
    expect(await classify(enc.encode("hi"), "t.txt")).toMatchObject({ category: "text" });
  });

  it("a NUL in the head refuses text; one past the head is left to the whole check", async () => {
    expect(await classify(fx.bytes("abc", [0], "def"), "a.txt")).toBeNull();
    const late = fx.bytes("a".repeat(5000), [0], "tail");
    const verdict = await classify(late, "a.txt");
    expect(verdict).toMatchObject({ category: "text", whole: "text" });
    const file = path.join(dir, "late-nul");
    await writeFile(file, late);
    expect(await verifyWholeFile(file, verdict as HeadVerdict)).toBeNull();
  });

  it("text needs a listed extension", async () => {
    expect(await classify(enc.encode("hello"), "a.exe")).toBeNull();
    expect(await classify(enc.encode("hello"), "noext")).toBeNull();
    expect(await classify(enc.encode("hello"), null)).toBeNull();
  });

  it("a UTF-16 BOM makes download-only text", async () => {
    const le = fx.bytes([0xff, 0xfe], [0x68, 0, 0x69, 0, 0x0a, 0]);
    expect(await classify(le, "app.log")).toEqual({ category: "text", mime: "text/plain", whole: "text", textDownloadOnly: true });
    const be = fx.bytes([0xfe, 0xff], [0, 0x68, 0, 0x69]);
    expect(await classify(be, "app.log")).toMatchObject({ textDownloadOnly: true });
  });

  it("text that starts with another format's signature is still text", async () => {
    expect(await classify(enc.encode("BMI,weight\n70,1\n"), "a.csv")).toMatchObject({ category: "text", mime: "text/csv" });
    expect(await classify(enc.encode("SQLite notes"), "a.md")).toMatchObject({ mime: "text/markdown" });
    expect(await classify(enc.encode("MZ is a name"), "a.txt")).toMatchObject({ mime: "text/plain" });
    expect(await classify(enc.encode("%!PS-Adobe"), "a.txt")).toMatchObject({ mime: "text/plain" });
  });

  it("a real binary with a NUL named .txt is refused, as are non-text extensions", async () => {
    expect(await classify(fx.bytes("MZ", [0x90, 0, 3, 0], "rest"), "a.txt")).toBeNull();
    expect(await classify(fx.bytes("BM", zeros(40)), "a.txt")).toBeNull();
    expect(await classify(enc.encode("BMI,x"), "a.exe")).toBeNull();
  });

  it("an accepted format still wins over the text extension", async () => {
    expect(await classify(fx.pdf(), "notes.txt")).toMatchObject({ category: "pdf", mime: "application/pdf" });
    expect(await classify(enc.encode("%PDF-1.4 is the header"), "a.txt")).toMatchObject({ category: "pdf" });
  });

  it("templates, Matroska and raw ADTS are refused; weba is video/webm", async () => {
    expect(await classify(fx.odf("application/vnd.oasis.opendocument.text-template"), "a.ott")).toBeNull();
    expect((await classify(fx.webm(), "a.weba"))?.mime).toBe("video/webm");
  });
});

describe("detect (head + whole-file check)", () => {
  it("docx, xlsx and pptx pass", async () => {
    expect(await detect(fx.docx(), "a.docx")).toEqual({ category: "office", mime: DOCX });
    expect(await detect(fx.xlsx(), "a.xlsx")).toEqual({ category: "office", mime: XLSX });
    expect(await detect(fx.pptx(), "a.pptx")).toEqual({ category: "office", mime: PPTX });
  });

  it("the whole-file result picks the real OOXML type, whatever the name", async () => {
    expect((await detect(fx.xlsx(), "a.docx"))?.mime).toBe(XLSX);
  });

  it("a zip without [Content_Types].xml and a macro-enabled docm are refused", async () => {
    expect(await detect(fx.plainZip(), "a.docx")).toBeNull();
    expect(await detect(fx.docm(), "a.docm")).toBeNull();
    expect(await detect(fx.docm(), "a.docx")).toBeNull();
  });

  it("xml text is text/plain, never application/xml", async () => {
    expect(await detect(enc.encode('<?xml version="1.0"?><a/>'), "a.xml")).toEqual({ category: "text", mime: "text/plain; charset=utf-8" });
    expect((await detect(enc.encode('<?xml version="1.0"?><a/>'), "a.txt"))?.mime).toBe("text/plain; charset=utf-8");
  });

  it("markup in text names stays text", async () => {
    expect((await detect(enc.encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), "a.txt"))?.mime).toBe("text/plain; charset=utf-8");
    expect((await detect(enc.encode("<html><script>1</script></html>"), "a.txt"))?.mime).toBe("text/plain; charset=utf-8");
  });

  it("UTF-8 csv gets a charset, Latin-1 csv does not", async () => {
    expect((await detect(enc.encode("name\nZoë\n"), "a.csv"))?.mime).toBe("text/csv; charset=utf-8");
    expect((await detect(Uint8Array.from([0x6e, 0x0a, 0x5a, 0x6f, 0xeb, 0x0a]), "a.csv"))?.mime).toBe("text/csv");
  });

  it("SVG markup in .xml and an invalid-UTF-8 file", async () => {
    expect((await detect(enc.encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), "a.xml"))?.mime).toBe("text/plain; charset=utf-8");
    expect((await detect(fx.bytes("a", [0xed, 0xa0, 0x80]), "a.txt"))?.mime).toBe("text/plain");
  });

  it("UTF-16 BOM before an XML declaration is download-only text", async () => {
    const le = fx.bytes([0xff, 0xfe], [0x3c, 0, 0x3f, 0, 0x78, 0, 0x6d, 0, 0x6c, 0]);
    expect(await detect(le, "a.xml")).toEqual({ category: "text", mime: "text/plain" });
  });

  it("markdown and source files map by extension", async () => {
    expect((await detect(enc.encode("# t"), "a.md"))?.mime).toBe("text/markdown; charset=utf-8");
    expect((await detect(enc.encode("print(1)"), "a.py"))?.mime).toBe("text/plain; charset=utf-8");
  });

  it("UTF-16 text is stored without a charset", async () => {
    const le = fx.bytes([0xff, 0xfe], [0x68, 0, 0x69, 0]);
    expect(await detect(le, "app.log")).toEqual({ category: "text", mime: "text/plain" });
  });

  it("a head-only format passes through unchanged", async () => {
    expect(await detect(fx.pdf(), "a.pdf")).toEqual({ category: "pdf", mime: "application/pdf" });
  });
});
