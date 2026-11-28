import { UPLOAD_TEXT_KEEP_EXTENSIONS } from "@knotebook/shared";

export type FilePreviewKind = "text" | "pdf";

export interface FilePreviewRequest {
  kind: FilePreviewKind;
  url: string;
  name: string;
  origin: HTMLAnchorElement;
}

/** The name link `collab/upload-block-status.ts` puts on file blocks; its text is the block's name. */
export const FILE_NAME_LINK = '.bn-block-content[data-content-type="file"] .bn-file-name a[href]';

// Same shapes as the member and public upload routes; one segment per path part, so nothing else under /api/ matches.
const UPLOAD_PATH = /^\/api\/(?:uploads|public\/notes\/[^/]+(?:\/[^/]+)?\/uploads)\/[^/]+$/;

export function isSiteUploadUrl(href: string, base: string = window.location.href): boolean {
  if (href === "") return false;
  let url: URL;
  try {
    url = new URL(href, base);
  } catch {
    return false;
  }
  return url.origin === new URL(base).origin && UPLOAD_PATH.test(url.pathname);
}

export function filePreviewKind(name: string): FilePreviewKind | null {
  const trimmed = name.trim();
  const dot = trimmed.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = trimmed.slice(dot + 1).toLowerCase();
  if (ext === "pdf") return "pdf";
  return UPLOAD_TEXT_KEEP_EXTENSIONS.includes(ext) ? "text" : null;
}

/** Ctrl/Cmd/Shift/Alt and non-primary clicks keep the browser's own handling (new tab, new window, download). */
export function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
}
