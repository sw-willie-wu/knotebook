const enc = new TextEncoder();

export function bytes(...parts: Array<number[] | Uint8Array | string>): Uint8Array {
  const chunks = parts.map(p => (typeof p === "string" ? enc.encode(p) : Uint8Array.from(p)));
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const zeros = (n: number): Uint8Array => new Uint8Array(n);
const u32be = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
const u32le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
const u16le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];

export function mp3(): Uint8Array {
  // MPEG-1 Layer III, 128 kbps, 44.1 kHz frame header followed by an empty frame body.
  return bytes([0xff, 0xfb, 0x90, 0x00], zeros(413));
}

/** An ISO base media file with an `ftyp` box naming `brand` (4 chars); `compat` lists compatible brands. */
export function ftyp(brand: string, compat: string[] = []): Uint8Array {
  const body = bytes(brand, u32be(0), ...compat);
  return bytes(u32be(8 + body.length), "ftyp", body, zeros(64));
}

export const m4a = (): Uint8Array => ftyp("M4A ", ["M4A ", "mp42", "isom"]);
export const mp4 = (): Uint8Array => ftyp("isom", ["isom", "mp42"]);
export const m4v = (): Uint8Array => ftyp("M4V ", ["M4V ", "mp42"]);
export const mov = (): Uint8Array => ftyp("qt  ", ["qt  "]);

export function webm(): Uint8Array {
  const docType = bytes([0x42, 0x82, 0x84], "webm");
  const header = bytes([0x42, 0x86, 0x81, 0x01], [0x42, 0xf7, 0x81, 0x01], docType);
  return bytes([0x1a, 0x45, 0xdf, 0xa3, 0x80 | header.length], header, zeros(32));
}

function oggPage(firstPacket: Uint8Array): Uint8Array {
  return bytes("OggS", [0, 0x02], zeros(8), u32le(1), u32le(0), u32le(0), [1, firstPacket.length], firstPacket);
}

export const oggOpus = (): Uint8Array => oggPage(bytes("OpusHead", [1, 2], zeros(11)));
export const oggVorbis = (): Uint8Array => oggPage(bytes([0x01], "vorbis", zeros(23)));
export const oggTheora = (): Uint8Array => oggPage(bytes([0x80], "theora", zeros(35)));

export function wav(): Uint8Array {
  return bytes("RIFF", u32le(36), "WAVE", "fmt ", u32le(16), u16le(1), u16le(1), u32le(8000), u32le(16000), u16le(2), u16le(16), "data", u32le(0));
}

export const flac = (): Uint8Array => bytes("fLaC", [0x00, 0x00, 0x00, 0x22], zeros(34));

export const pdf = (): Uint8Array => bytes("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");

export const ole = (): Uint8Array => bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], zeros(512));

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

/** A zip of STORED entries, in the given order. */
export function zip(entries: Array<[name: string, content: string]>): Uint8Array {
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = enc.encode(content);
    const crc = crc32(data);
    const common = [...u16le(20), ...u16le(0x0800), ...u16le(0), ...u16le(0), ...u16le(0x21), ...u32le(crc), ...u32le(data.length), ...u32le(data.length), ...u16le(enc.encode(name).length), ...u16le(0)];
    const local = bytes([0x50, 0x4b, 0x03, 0x04], common, name, data);
    central.push(bytes([0x50, 0x4b, 0x01, 0x02, 20, 0], common, u16le(0), u16le(0), u16le(0), u32le(0), u32le(offset), name));
    locals.push(local);
    offset += local.length;
  }
  const dir = bytes(...central);
  return bytes(...locals, dir, [0x50, 0x4b, 0x05, 0x06], u16le(0), u16le(0), u16le(entries.length), u16le(entries.length), u32le(dir.length), u32le(offset), u16le(0));
}

const CT = "[Content_Types].xml";
const ctXml = (main: string, contentType: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${main}" ContentType="${contentType}"/></Types>`;

const MAIN = "application/vnd.openxmlformats-officedocument.";
const DOC_PART = "word/document.xml";

export const docx = (): Uint8Array =>
  zip([[CT, ctXml(DOC_PART, `${MAIN}wordprocessingml.document.main+xml`)], [DOC_PART, "<w:document/>"]]);
export const xlsx = (): Uint8Array =>
  zip([[CT, ctXml("xl/workbook.xml", `${MAIN}spreadsheetml.sheet.main+xml`)], ["xl/workbook.xml", "<workbook/>"]]);
export const pptx = (): Uint8Array =>
  zip([[CT, ctXml("ppt/presentation.xml", `${MAIN}presentationml.presentation.main+xml`)], ["ppt/presentation.xml", "<p:presentation/>"]]);
export const docm = (): Uint8Array =>
  zip([[CT, ctXml(DOC_PART, "application/vnd.ms-word.document.macroEnabled.main+xml")], [DOC_PART, "<w:document/>"]]);
export const plainZip = (): Uint8Array => zip([["a.txt", "hello"], ["b/c.txt", "world"]]);

export function odf(mimetype: string): Uint8Array {
  return zip([["mimetype", mimetype], ["content.xml", "<office:document-content/>"]]);
}
