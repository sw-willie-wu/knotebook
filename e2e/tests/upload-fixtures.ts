import { E2E_ORIGIN } from "../ports.js";

/** Tiny valid files for the upload specs. */

const enc = new TextEncoder();

/** 3 s, 32x32, 5 fps, a keyframe every second. VP9 in MP4: Playwright's Chromium decodes it without proprietary codecs. */
// Regenerate: ffmpeg -f lavfi -i color=c=blue:s=32x32:r=5:d=3 -c:v libvpx-vp9 -g 5 -b:v 10k -movflags +faststart clip.mp4, then base64 -w0.
const MP4_BASE64 =
  "AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAA1Ztb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAALuAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACgXRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAALuAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAIAAAACAAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAC7gAAAAAAAEAAAAAAfltZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAACgAAAB4AFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAGkbWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABZHN0YmwAAACoc3RzZAAAAAAAAAABAAAAmHZwMDkAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAIAAgAEgAAABIAAAAAAAAAAEXTGF2YzYzLjEuMTAyIGxpYnZweC12cDkAAAAAAAAAAAAY//8AAAAUdnBjQwEAAAAACoICAgIAAAAAAApmaWVsAQAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAAnEAAAAAAAAAAYc3R0cwAAAAAAAAABAAAADwAACAAAAAAcc3RzcwAAAAAAAAADAAAAAQAAAAYAAAALAAAAHHN0c2MAAAAAAAAAAQAAAAEAAAAPAAAAAQAAAFBzdHN6AAAAAAAAAAAAAAAPAAAAKAAAAA8AAAAPAAAADwAAAA8AAAAoAAAADwAAAA8AAAAPAAAADwAAACgAAAAPAAAADwAAAA8AAAAPAAAAFHN0Y28AAAAAAAAAAQAAA4IAAABhdWR0YQAAAFltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAACxpbHN0AAAAJKl0b28AAAAcZGF0YQAAAAEAAAAATGF2ZjYzLjEuMTAyAAAACGZyZWUAAAE0bWRhdIJJg0IAAfAB9gA4JBwYQgAAMGAAABDf//zUzf////+xTB////+OgACGAECSnABJQAADIAAAQ0CGAECSnABKwAADIAAAQ0CGAECSnABJwAADIAAAQ0CGAECSnABIoAADIAAAQ0CCSYNCAAHwAfYAOCQcGEIAADBgAAAQ3//81M3/////sUwf////joAAhgBAkpwAR4AAAyAAAENAhgBAkpwARuAAAyAAAENAhgBAkpwARkAAAyAAAENAhgBAkpwARcAAAyAAAENAgkmDQgAB8AH2ADgkHBhCAAAwYAAAEN///NTN/////7FMH////46AAIYAQJKcAEVAAAMgAABDQIYAQJKcAETgAAMgAABDQIYAQJKcAERgAAMgAABDQIYAQJKcAEQAAAMgAABDQA==";

export const mp4Bytes = (): Uint8Array => Uint8Array.from(Buffer.from(MP4_BASE64, "base64"));

/** MPEG-1 Layer III, 128 kbps, 44.1 kHz: 417-byte silent frames, about 26 ms each. */
export function mp3Bytes(frames = 40): Uint8Array {
  const out = new Uint8Array(frames * 417);
  for (let i = 0; i < frames; i++) out.set([0xff, 0xfb, 0x90, 0x00], i * 417);
  return out;
}

export const MARKER_PATH = "/e2e-pdf-marker/";

/**
 * A PDF whose open action, link and form submit would each request a marker URL on the app origin if a viewer ran them.
 */
export const pdfBytes = (): Uint8Array =>
  enc.encode(
    [
      "%PDF-1.4",
      `1 0 obj << /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS (app.launchURL("${E2E_ORIGIN}${MARKER_PATH}open"); this.getField("x");) >> /AcroForm << /Fields [5 0 R] >> >> endobj`,
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      `3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Annots [4 0 R 5 0 R] >> endobj`,
      `4 0 obj << /Type /Annot /Subtype /Link /Rect [0 0 200 100] /A << /S /URI /URI (javascript:fetch('${E2E_ORIGIN}${MARKER_PATH}link')) >> >> endobj`,
      `5 0 obj << /Type /Annot /Subtype /Widget /FT /Btn /Ff 65536 /T (x) /Rect [0 100 200 200] /A << /S /SubmitForm /F (${E2E_ORIGIN}${MARKER_PATH}submit) >> >> endobj`,
      "trailer << /Root 1 0 R >>",
      "%%EOF",
      "",
    ].join("\n"),
  );

let crcTable: Uint32Array | undefined;
function crc32(data: Uint8Array): number {
  if (crcTable === undefined) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (const b of data) crc = crcTable[(crc ^ b) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const le16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const le32 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];

function zip(entries: Array<[name: string, content: string]>): Uint8Array {
  const parts: number[] = [];
  const central: number[] = [];
  for (const [name, content] of entries) {
    const data = enc.encode(content);
    const nameBytes = enc.encode(name);
    const common = [...le16(20), ...le16(0x0800), ...le16(0), ...le16(0), ...le16(0x21), ...le32(crc32(data)), ...le32(data.length), ...le32(data.length), ...le16(nameBytes.length), ...le16(0)];
    central.push(0x50, 0x4b, 0x01, 0x02, 20, 0, ...common, ...le16(0), ...le16(0), ...le16(0), ...le32(0), ...le32(parts.length), ...nameBytes);
    parts.push(0x50, 0x4b, 0x03, 0x04, ...common, ...nameBytes, ...data);
  }
  const end = [0x50, 0x4b, 0x05, 0x06, ...le16(0), ...le16(0), ...le16(entries.length), ...le16(entries.length), ...le32(central.length), ...le32(parts.length), ...le16(0)];
  return Uint8Array.from([...parts, ...central, ...end]);
}

export const docxBytes = (): Uint8Array =>
  zip([
    [
      "[Content_Types].xml",
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    ],
    ["word/document.xml", "<w:document/>"],
  ]);

export const csvBytes = (): Uint8Array => enc.encode("name,count\nalpha,1\nbeta,2\n");
