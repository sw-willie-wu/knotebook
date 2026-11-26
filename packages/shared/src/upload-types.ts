export type UploadKind = "image" | "audio" | "video" | "file";

export interface UploadResponseDto {
  id: string;
  url: string;
  mime: string;
  kind: UploadKind;
}

export type UploadCategory = "image" | "audio" | "video" | "pdf" | "office" | "text";

/** Audio and video share the media size limit; everything else uses the document limit. */
export function uploadLimitClass(c: UploadCategory): "media" | "document" {
  return c === "audio" || c === "video" ? "media" : "document";
}

export interface UploadTypeInfo {
  category: UploadCategory;
  kind: UploadKind;
  canonicalExt: string;
  exts: readonly string[];
}

const OOXML = "application/vnd.openxmlformats-officedocument.";
const ODF = "application/vnd.oasis.opendocument.";

function t(category: UploadCategory, canonicalExt: string, ...more: string[]): UploadTypeInfo {
  const kind: UploadKind = category === "image" || category === "audio" || category === "video" ? category : "file";
  return { category, kind, canonicalExt, exts: [canonicalExt, ...more] };
}

export const UPLOAD_TEXT_EXTENSIONS: readonly string[] = [
  "txt", "md", "markdown", "csv", "tsv", "json", "log", "yaml", "yml", "xml", "ini", "toml", "conf", "sql",
  "py", "js", "ts", "java", "c", "cpp", "h", "cs", "go", "rs", "rb", "php", "sh", "ps1", "css",
];

/** Extensions a text upload keeps in its served name; any other gets `.txt` appended so it never downloads as a script. */
export const UPLOAD_TEXT_KEEP_EXTENSIONS: readonly string[] = ["txt", "csv", "tsv", "md", "markdown", "log", "json"];

/** Keyed by the stored mime, without parameters. */
export const UPLOAD_TYPES: Readonly<Record<string, UploadTypeInfo>> = {
  "image/png": t("image", "png"),
  "image/jpeg": t("image", "jpg", "jpeg", "jpe"),
  "image/gif": t("image", "gif"),
  "image/webp": t("image", "webp"),
  "audio/mpeg": t("audio", "mp3"),
  "audio/x-m4a": t("audio", "m4a", "aac", "m4b"),
  "audio/mp4": t("audio", "m4a", "aac", "m4b"),
  "audio/ogg": t("audio", "ogg", "opus", "oga"),
  "audio/wav": t("audio", "wav"),
  "audio/flac": t("audio", "flac"),
  "video/mp4": t("video", "mp4"),
  "video/x-m4v": t("video", "m4v"),
  "video/webm": t("video", "webm", "weba"),
  "video/ogg": t("video", "ogv"),
  "video/quicktime": t("video", "mov"),
  "application/pdf": t("pdf", "pdf"),
  [`${OOXML}wordprocessingml.document`]: t("office", "docx"),
  [`${OOXML}spreadsheetml.sheet`]: t("office", "xlsx"),
  [`${OOXML}presentationml.presentation`]: t("office", "pptx"),
  "application/msword": t("office", "doc"),
  "application/vnd.ms-excel": t("office", "xls"),
  "application/vnd.ms-powerpoint": t("office", "ppt"),
  [`${ODF}text`]: t("office", "odt"),
  [`${ODF}spreadsheet`]: t("office", "ods"),
  [`${ODF}presentation`]: t("office", "odp"),
  "text/plain": t("text", "txt", ...UPLOAD_TEXT_EXTENSIONS.filter(e => !["txt", "csv", "md", "markdown"].includes(e))),
  "text/csv": t("text", "csv"),
  "text/markdown": t("text", "md", "markdown"),
};

function extensionOf(name: string): string | null {
  const i = name.lastIndexOf(".");
  // A leading dot alone (".bashrc") or a trailing dot ("a.") is not an extension.
  if (i <= 0 || i === name.length - 1) return null;
  return name.slice(i + 1).toLowerCase();
}

export function uploadCategoryOfName(name: string): UploadCategory | null {
  const ext = extensionOf(name);
  if (ext === null) return null;
  if (UPLOAD_TEXT_EXTENSIONS.includes(ext)) return "text";
  for (const info of Object.values(UPLOAD_TYPES)) {
    if (info.category !== "text" && info.exts.includes(ext)) return info.category;
  }
  return null;
}

export function textMimeForExtension(ext: string): "text/plain" | "text/csv" | "text/markdown" {
  const e = ext.toLowerCase();
  if (e === "csv") return "text/csv";
  if (e === "md" || e === "markdown") return "text/markdown";
  return "text/plain";
}

export function uploadKindOfMime(mime: string): UploadKind {
  const m = (mime.split(";")[0] ?? "").trim().toLowerCase();
  const known = UPLOAD_TYPES[m];
  if (known) return known.kind;
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("audio/")) return "audio";
  if (m.startsWith("video/")) return "video";
  return "file";
}

// Must equal the 200 in the uploads_file_name_len_chk CHECK.
const FILE_NAME_MAX_BYTES = 200;

export function sanitizeUploadFileName(raw: string): string | null {
  // Strip before normalizing: removing a format character between a base and a combining mark would otherwise leave a non-NFC result.
  const cleaned = raw.replace(/[\p{Cc}\p{Cf}\p{Cs}/\\]/gu, "").normalize("NFC").trim();
  const encoder = new TextEncoder();
  const byteLen = (t: string) => encoder.encode(t).length;
  // Cutting only the stem keeps the extension, which classification of text and legacy Office files depends on.
  const dot = cleaned.lastIndexOf(".");
  const tail = dot > 0 && /^\.[A-Za-z0-9]{1,15}$/.test(cleaned.slice(dot)) ? cleaned.slice(dot) : "";
  const stem = tail === "" ? cleaned : cleaned.slice(0, dot);
  const room = FILE_NAME_MAX_BYTES - byteLen(tail);
  let out = "";
  let bytes = 0;
  for (const ch of stem) {
    const n = byteLen(ch);
    if (bytes + n > room) break;
    out += ch;
    bytes += n;
  }
  out = out.trim() + tail;
  return out === "" ? null : out;
}

export function uploadServedName(stored: string | null, mime: string, id: string): string {
  const m = (mime.split(";")[0] ?? "").trim().toLowerCase();
  const info = UPLOAD_TYPES[m];
  // Fail closed: an unlisted mime never keeps a client-chosen extension.
  if (!info) return id;
  if (stored === null) return `${id}.${info.canonicalExt}`;
  const ext = extensionOf(stored);
  if (info.category === "text") {
    return ext !== null && UPLOAD_TEXT_KEEP_EXTENSIONS.includes(ext) ? stored : `${stored}.txt`;
  }
  if (ext !== null && info.exts.includes(ext)) return stored;
  const base = ext === null ? stored.replace(/\.$/, "") : stored.slice(0, stored.lastIndexOf("."));
  return `${base}.${info.canonicalExt}`;
}

/** Slack for multipart boundaries and part headers on top of the file limit when capping a request body. */
export const UPLOAD_FRAMING_ALLOWANCE_BYTES = 65_536;
