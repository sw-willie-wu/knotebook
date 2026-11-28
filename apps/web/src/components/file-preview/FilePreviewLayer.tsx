import { useEffect, useState, type JSX } from "react";
import { SidebarLazyBoundary } from "@/components/sidebar/SidebarLazyBoundary";
import { isPhone } from "@/lib/layout-tiers";
import { loadedFilePreview, loadFilePreview, prefetchFilePreview } from "./file-preview-chunk";
import { FILE_NAME_LINK, filePreviewKind, isPlainClick, isSiteUploadUrl, type FilePreviewRequest } from "./file-preview-target";

function requestFor(target: EventTarget | null): FilePreviewRequest | null {
  const link = target instanceof Element ? target.closest<HTMLAnchorElement>(FILE_NAME_LINK) : null;
  if (!link) return null;
  const url = link.getAttribute("href") ?? "";
  const name = link.textContent ?? "";
  const kind = filePreviewKind(name);
  return kind !== null && isSiteUploadUrl(url) ? { kind, url, name, origin: link } : null;
}

/**
 * Mount in the React tree of the editor it serves: a modal rendered elsewhere counts as "outside" an enclosing Radix dialog
 * (the version compare dialog) and dismisses it.
 */
export function FilePreviewLayer({ container }: { container: HTMLElement | null }): JSX.Element | null {
  const [request, setRequest] = useState<FilePreviewRequest | null>(null);

  useEffect(() => {
    if (!container) return;
    let alive = true;
    const onClick = (event: MouseEvent) => {
      // An inner layer (a version preview inside the note column) already took it.
      if (event.defaultPrevented || !isPlainClick(event)) return;
      const found = requestFor(event.target);
      // Phone browsers render only a framed PDF's first page, or nothing.
      if (!found || (found.kind === "pdf" && isPhone())) return;
      event.preventDefault();
      loadFilePreview().then(
        () => {
          if (alive) setRequest(found);
        },
        () => {
          window.open(found.url, "_blank", "noopener");
        },
      );
    };
    const onApproach = (event: Event) => {
      if (requestFor(event.target)) prefetchFilePreview();
    };
    container.addEventListener("click", onClick);
    container.addEventListener("pointerover", onApproach);
    container.addEventListener("focusin", onApproach);
    return () => {
      alive = false;
      container.removeEventListener("click", onClick);
      container.removeEventListener("pointerover", onApproach);
      container.removeEventListener("focusin", onApproach);
    };
  }, [container]);

  // Rendered only once the chunk has loaded, so nothing suspends; the boundary is for render errors.
  const Dialog = request === null ? null : loadedFilePreview()?.FilePreviewDialog;
  if (request === null || !Dialog) return null;
  return (
    <SidebarLazyBoundary chunk="filePreview" fallback={null} errorClassName="p-2">
      <Dialog request={request} onClose={() => setRequest(null)} />
    </SidebarLazyBoundary>
  );
}
