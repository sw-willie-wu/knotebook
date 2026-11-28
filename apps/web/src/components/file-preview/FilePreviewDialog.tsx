import "@/i18n/file-preview-strings";
import { useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { hideOthers } from "aria-hidden";
import { Dialog as DialogPrimitive } from "radix-ui";
import { useTranslation } from "react-i18next";
import { focusReturnTarget } from "@/components/media-zoom/focus-return";
import { lockRootScroll } from "@/components/media-zoom/root-scroll-lock";
import { X } from "@/components/ui/icons";
import { Download, ExternalLink } from "@/components/ui/icons-extra";
import type { FilePreviewRequest } from "./file-preview-target";
import { loadTextPreview, type TextPreview } from "./text-preview";

/** Max movement (px) from press to release on the backdrop that still counts as a click, as in the image lightbox. */
const TAP_SLOP = 4;

const OVERLAY = "fixed inset-0 z-50 bg-black/80";

const ACTION =
  "inline-flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

function FileActions({ url, compact = false }: { url: string; compact?: boolean }): JSX.Element {
  const { t } = useTranslation();
  const label = compact ? "max-sm:sr-only" : undefined;
  return (
    <>
      <a href={url} target="_blank" rel="noopener" className={ACTION}>
        <ExternalLink className="size-4" />
        <span className={label}>{t("filePreview.openInNewTab")}</span>
      </a>
      {/* No value: the server's Content-Disposition names the file. */}
      <a href={url} download className={ACTION}>
        <Download className="size-4" />
        <span className={label}>{t("filePreview.download")}</span>
      </a>
    </>
  );
}

function Notice({ url, text }: { url: string; text: string }): JSX.Element {
  return (
    <div data-file-preview-notice="" className="flex shrink-0 flex-wrap items-center gap-x-2 gap-y-1 border-b px-4 py-2 text-sm">
      <span className="min-w-0">{text}</span>
      <FileActions url={url} />
    </div>
  );
}

function TextBody({ url }: { url: string }): JSX.Element {
  const { t } = useTranslation();
  const [state, setState] = useState<TextPreview | "loading" | "error">("loading");
  useEffect(() => {
    const controller = new AbortController();
    loadTextPreview(url, controller.signal).then(
      result => setState(result),
      () => {
        if (!controller.signal.aborted) setState("error");
      },
    );
    return () => controller.abort();
  }, [url]);

  if (state === "loading") return <p role="status" className="p-4 text-sm text-muted-foreground">{t("filePreview.loading")}</p>;
  if (state === "error") return <Notice url={url} text={t("filePreview.error")} />;
  return (
    <div className="flex h-full flex-col">
      {state.truncated && <Notice url={url} text={t("filePreview.truncated")} />}
      <div
        data-file-preview-body=""
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto overscroll-contain focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {/* A text child is set as textContent: the file is never parsed as markup. */}
        <pre className="m-0 whitespace-pre-wrap [overflow-wrap:anywhere] p-4 font-mono text-sm">{state.text}</pre>
      </div>
    </div>
  );
}

/** Loaded only through `file-preview-chunk.ts`. */
export function FilePreviewDialog({ request, onClose }: { request: FilePreviewRequest; onClose: () => void }): JSX.Element {
  const { t } = useTranslation();
  const { kind, url, name, origin } = request;
  // Inside another dialog only a modal one takes over its scroll lock and focus trap. Elsewhere non-modal, like the image
  // lightbox: Radix's modal mode restyles the whole document on open and close, which is slow on long notes.
  const [modal] = useState(() => origin.closest('[role="dialog"]') !== null);
  const [contentNode, setContentNode] = useState<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const backdropPress = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => (modal || contentNode === null ? undefined : hideOthers(contentNode)), [modal, contentNode]);
  // Layout effect: lock before first paint so the scrollbar doesn't flash.
  useLayoutEffect(() => (modal ? undefined : lockRootScroll()), [modal]);

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    // Focus on the content itself (after a click on the panel): Shift+Tab would leave for the page behind.
    if (event.key === "Tab" && event.shiftKey && event.target === event.currentTarget) {
      event.preventDefault();
      closeRef.current?.focus();
    }
  }

  return (
    <DialogPrimitive.Root
      open
      modal={modal}
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        {/* Radix keeps a modal dialog's scroll lock on its Overlay, so the modal form needs the real one. */}
        {modal ? <DialogPrimitive.Overlay className={OVERLAY} /> : <div aria-hidden="true" className={OVERLAY} />}
        {/* Full screen, so the backdrop click is a click on the content itself: closing on that click, not on press, leaves no
            click to land on the page underneath. */}
        <DialogPrimitive.Content
          ref={setContentNode}
          aria-modal="true"
          aria-describedby={undefined}
          data-file-preview=""
          className="fixed inset-0 z-50 flex justify-center outline-none sm:p-6"
          onPointerDown={event => {
            backdropPress.current = event.target === event.currentTarget ? { x: event.clientX, y: event.clientY } : null;
          }}
          onClick={event => {
            const press = backdropPress.current;
            backdropPress.current = null;
            // A click also lands here when a text selection or a scrollbar drag starts in the panel and ends on the backdrop.
            if (event.target !== event.currentTarget || press === null) return;
            if (Math.hypot(event.clientX - press.x, event.clientY - press.y) <= TAP_SLOP) onClose();
          }}
          onKeyDown={handleKeyDown}
          onOpenAutoFocus={event => {
            event.preventDefault();
            closeRef.current?.focus();
          }}
          onPointerDownOutside={event => {
            // A press on the scrollbar (or its reserved space) targets `<html>`: not a request to close.
            if (event.detail.originalEvent.target === document.documentElement) event.preventDefault();
          }}
          onFocusOutside={event => {
            event.preventDefault();
            closeRef.current?.focus();
          }}
          onCloseAutoFocus={event => {
            event.preventDefault();
            focusReturnTarget(origin, origin)?.focus();
          }}
        >
          <div className="flex h-full w-full max-w-5xl flex-col overflow-hidden bg-card text-card-foreground shadow-xl sm:rounded-lg">
            <div
              data-file-preview-header=""
              className="flex shrink-0 touch-none items-center gap-1 border-b pt-[max(0.5rem,env(safe-area-inset-top))] pr-[max(0.5rem,env(safe-area-inset-right))] pb-2 pl-[max(1rem,env(safe-area-inset-left))]"
            >
              <DialogPrimitive.Title className="min-w-0 flex-1 truncate text-sm font-medium">{name}</DialogPrimitive.Title>
              <FileActions url={url} compact />
              <DialogPrimitive.Close
                ref={closeRef}
                aria-label={t("note.zoom.close")}
                className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:p-2.5"
              >
                <X className="h-5 w-5" />
              </DialogPrimitive.Close>
            </div>
            <div className="relative min-h-0 flex-1">
              {kind === "pdf" ? (
                // No `sandbox`: it disables the browsers' PDF viewers.
                <iframe src={url} title={t("filePreview.frameTitle", { name })} className="absolute inset-0 block h-full w-full border-0" />
              ) : (
                <TextBody url={url} />
              )}
            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
