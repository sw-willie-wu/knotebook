import "@/i18n/file-preview-strings";
import { useEffect, useLayoutEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";
import { hideOthers } from "aria-hidden";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { cardSurface } from "@/components/ui/card";
import { Dialog, DialogClose, DialogContent, DialogPortal, DialogTitle, dialogOverlayClass } from "@/components/ui/dialog";
import { managementCardPhone, managementCardPhoneInset, managementTray, panelCloseHit } from "@/components/management/tray";
import { cn } from "@/lib/utils";
import { focusReturnTarget } from "@/components/media-zoom/focus-return";
import { lockRootScroll } from "@/components/media-zoom/root-scroll-lock";
import { X } from "@/components/ui/icons";
import { Download, ExternalLink } from "@/components/ui/icons-extra";
import type { FilePreviewRequest } from "./file-preview-target";
import { loadTextPreview, type TextPreview } from "./text-preview";

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
    <Dialog
      open
      modal={modal}
      onOpenChange={open => {
        if (!open) onClose();
      }}
    >
      {/* Radix renders its Overlay only in modal mode (where it also carries the scroll lock), so the non-modal form draws the same backdrop. */}
      {!modal && (
        <DialogPortal>
          <div aria-hidden="true" data-state="open" className={cn(dialogOverlayClass, "kb-sheet-overlay touch-none")} />
        </DialogPortal>
      )}
      <DialogContent
        ref={setContentNode}
        size="panel"
        aria-modal="true"
        aria-describedby={undefined}
        data-file-preview=""
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
        <div className={managementTray}>
          <div className={cn(cardSurface, "relative flex min-w-0 flex-1 flex-col overflow-hidden", managementCardPhone, managementCardPhoneInset)}>
            <div data-file-preview-header="" className="flex h-12 shrink-0 touch-none items-center gap-1 border-b pr-12 pl-4">
              <DialogTitle className="min-w-0 flex-1 truncate text-[15px] leading-tight font-semibold tracking-normal max-sm:text-lg">{name}</DialogTitle>
              <FileActions url={url} compact />
            </div>
            <DialogClose asChild>
              <Button ref={closeRef} type="button" variant="ghost" size="icon" className={cn("absolute top-2 right-2 z-10 h-7 w-7 bg-card max-sm:bg-popover", panelCloseHit)} aria-label={t("note.zoom.close")}>
                <X className="h-4 w-4" aria-hidden="true" />
              </Button>
            </DialogClose>
            <div className="relative min-h-0 flex-1">
              {kind === "pdf" ? (
                // No `sandbox`: it disables the browsers' PDF viewers.
                <iframe src={url} title={t("filePreview.frameTitle", { name })} className="absolute inset-0 block h-full w-full border-0" />
              ) : (
                <TextBody url={url} />
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
