type FilePreviewModule = typeof import("./FilePreviewDialog");

let pending: Promise<FilePreviewModule> | null = null;
let loaded: FilePreviewModule | null = null;

/** The only `import()` of the modal (`scripts/check-bundle-size.mjs` guards it as its own chunk); cleared on failure so the next click can retry. */
export function loadFilePreview(): Promise<FilePreviewModule> {
  pending ??= import("./FilePreviewDialog").then(
    m => {
      loaded = m;
      return m;
    },
    (error: unknown) => {
      pending = null;
      throw error;
    },
  );
  return pending;
}

export function loadedFilePreview(): FilePreviewModule | null {
  return loaded;
}

/** On hover or focus; a failure is ignored here, the click retries. */
export function prefetchFilePreview(): void {
  if (loaded !== null || pending !== null) return;
  void loadFilePreview().catch(() => undefined);
}
