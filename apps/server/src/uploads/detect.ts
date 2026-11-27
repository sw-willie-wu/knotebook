import { isUtf8 } from "node:buffer";
import { readFile } from "node:fs/promises";
import { fileTypeFromBuffer, fileTypeFromFile } from "file-type";
import {
  UPLOAD_TEXT_EXTENSIONS,
  UPLOAD_TYPES,
  textMimeForExtension,
  type UploadCategory,
} from "@knotebook/shared";
import { detectRasterImageMimeType } from "./magic-bytes.js";
import { validateSvgXml, type SvgValidationDetail, type SvgValidationResult } from "./svg.js";

/** file-type's own `reasonableDetectionSizeInBytes`. */
export const HEAD_BYTES = 4100;

export interface HeadVerdict {
  category: UploadCategory;
  mime: string;
  /** Formats the head cannot settle: the finished file gets a second check in `verifyWholeFile`. */
  whole: "ooxml" | "svg" | "text" | null;
  /** UTF-16 text is stored but only ever offered as a download. */
  textDownloadOnly?: true;
}

const OOXML_MIMES: readonly string[] = [
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
];
const ODF_MIMES: readonly string[] = [
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
];
const OLE_MIME_BY_EXT: Readonly<Record<string, string>> = {
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
};

function extensionOf(fileName: string | null): string {
  if (fileName === null) return "";
  const i = fileName.lastIndexOf(".");
  if (i <= 0 || i === fileName.length - 1) return "";
  return fileName.slice(i + 1).toLowerCase();
}

function hasUtf16Bom(head: Uint8Array): boolean {
  return head.length >= 2 && ((head[0] === 0xff && head[1] === 0xfe) || (head[0] === 0xfe && head[1] === 0xff));
}

/** Only the bytes decide the type; the extension just picks among text types and OLE candidates after the bytes allow them. */
export async function classifyUploadHead(head: Uint8Array, fileName: string | null): Promise<HeadVerdict | null> {
  if (head.length === 0) return null;
  const ext = extensionOf(fileName);
  // Raster only: the SVG check needs the whole document, so on the first bytes alone a large SVG would read as truncated XML.
  const raster = detectRasterImageMimeType(head);
  if (raster !== null) return { category: "image", mime: raster, whole: null };

  const found = await fileTypeFromBuffer(head);
  if (found !== undefined) {
    const mime = found.mime.split(";")[0]!.trim();
    const info = UPLOAD_TYPES[mime];
    if (info !== undefined && (info.category === "audio" || info.category === "video" || info.category === "pdf")) {
      return { category: info.category, mime, whole: null };
    }
    if (ODF_MIMES.includes(mime)) return { category: "office", mime, whole: null };
    if (mime === "application/zip" || OOXML_MIMES.includes(mime)) {
      return { category: "office", mime: OOXML_MIMES.includes(mime) ? mime : OOXML_MIMES[0]!, whole: "ooxml" };
    }
    if (mime === "application/x-cfb") {
      const oleMime = OLE_MIME_BY_EXT[ext];
      if (oleMime !== undefined) return { category: "office", mime: oleMime, whole: null };
    }
    // Any other detected format falls through: plain text can start with another format's signature ("BM", "SQLite", "MZ"). The text rule below still refuses a NUL, and the stored mime is always one of the three text mimes.
  }

  // SVG markup counts as SVG only under a `.svg` name; in any other file it is text, which is never served as markup.
  if (ext === "svg") return head.includes(0) ? null : { category: "image", mime: "image/svg+xml", whole: "svg" };

  if (!UPLOAD_TEXT_EXTENSIONS.includes(ext)) return null;
  const bom = hasUtf16Bom(head);
  if (!bom && head.includes(0)) return null;
  const verdict: HeadVerdict = { category: "text", mime: textMimeForExtension(ext), whole: "text" };
  if (bom) verdict.textDownloadOnly = true;
  return verdict;
}

export interface SvgRefusal {
  svg: Exclude<SvgValidationResult, "valid">;
  prefix?: string;
}

/** Second look at the finished temp file; `null` or an `SvgRefusal` means refuse. The stored mime may gain a charset. */
export async function verifyWholeFile(path: string, head: HeadVerdict): Promise<{ mime: string } | SvgRefusal | null> {
  if (head.whole === null) return { mime: head.mime };
  if (head.whole === "svg") {
    const detail: SvgValidationDetail = {};
    const svg = validateSvgXml(await readFile(path), detail);
    if (svg === "valid") return { mime: head.mime };
    return svg === "undeclared_prefix" ? { svg, prefix: detail.prefix } : { svg };
  }
  if (head.whole === "ooxml") {
    const found = await fileTypeFromFile(path);
    // Macro-enabled, template and slideshow variants have their own mimes and are refused.
    return found !== undefined && OOXML_MIMES.includes(found.mime) ? { mime: found.mime } : null;
  }
  if (head.textDownloadOnly) return { mime: head.mime };
  const bytes = await readFile(path);
  if (bytes.includes(0)) return null;
  return { mime: isUtf8(bytes) ? `${head.mime}; charset=utf-8` : head.mime };
}
