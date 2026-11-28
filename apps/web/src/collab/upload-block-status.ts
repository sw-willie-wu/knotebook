import "@/i18n/upload-block-strings";
import { formatBytes } from "@knotebook/shared";
import i18n from "@/i18n";
import { BLOCKED_MEDIA_URL } from "@/lib/media-url";
import { storageQuotaDescription } from "@/lib/storage-quota-text";
import { uploadErrorKey } from "@/lib/upload-error-text";
import { precheckMessage } from "@/uploads/precheck";
import { dropUnplaceableUpload, getUploadItems, subscribeUploads, type UploadItem } from "@/uploads/upload-queue-store";
import { isUploadRetryable, uploadRetryWaitMs } from "@/uploads/upload-rules";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- BlockNote generic triple; repo convention (as in shared note-schema-config.ts)
type AnyEditor = any;
type RenderOutput = { dom: HTMLElement | DocumentFragment; contentDOM?: HTMLElement; destroy?: () => void };
type FileBlockLike = { id: string; type: string; props: { url?: string; name?: string } };
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- same as above
type RenderableSpec = { implementation: { render: (this: any, block: any, editor: any) => any } };

const editorNotes = new WeakMap<object, string>();

/** Upload items name their note; a copied note keeps the same block ids, so the block id alone would match the original's uploads too. */
export function bindUploadNote(editor: object, noteId: string): void {
  editorNotes.set(editor, noteId);
}

const quietEditors = new WeakMap<object, AnyEditor>();

/**
 * BlockNote swaps a URL-less block's "add file" button for a fixed "Loading..." line when an upload starts and only a
 * re-render brings it back; uploads run in the background here and can fail with the block unchanged, so the queue item
 * draws the state instead.
 */
function withoutUploadPlaceholder(editor: AnyEditor): AnyEditor {
  if (typeof editor !== "object" || editor === null) return editor;
  let quiet = quietEditors.get(editor);
  if (!quiet) {
    quiet = new Proxy(editor, {
      get(target, prop) {
        if (prop === "onUploadStart") return () => () => {};
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    quietEditors.set(editor, quiet);
  }
  return quiet;
}

const SVG_NS = "http://www.w3.org/2000/svg";
type Shape = [tag: string, attrs: Record<string, string>];
const ICONS: Record<string, Shape[]> = {
  image: [["rect", { width: "18", height: "18", x: "3", y: "3", rx: "2" }], ["circle", { cx: "9", cy: "9", r: "2" }], ["path", { d: "m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" }]],
  audio: [["path", { d: "M9 18V5l12-2v13" }], ["circle", { cx: "6", cy: "18", r: "3" }], ["circle", { cx: "18", cy: "16", r: "3" }]],
  video: [["path", { d: "m22 8-6 4 6 4V8Z" }], ["rect", { x: "2", y: "6", width: "14", height: "12", rx: "2" }]],
  file: [["path", { d: "M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" }], ["path", { d: "M14 2v6h6" }]],
};

function icon(type: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "2", "aria-hidden": "true" })) svg.setAttribute(k, v);
  svg.setAttribute("class", "size-4 shrink-0 text-muted-foreground");
  for (const [tag, attrs] of ICONS[type] ?? ICONS.file!) {
    const shape = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) shape.setAttribute(k, v);
    svg.append(shape);
  }
  return svg;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const isActive = (item: UploadItem) => item.status === "uploading" || item.status === "writing";

function retry(id: string): void {
  // Only the runner creates items, so this resolves from a module that is already loaded.
  void import("@/uploads/upload-runner").then((m) => m.retryUpload(id)).catch(() => {});
}

function itemPercent(item: UploadItem): number {
  if (item.status === "writing" || item.size === 0) return 100;
  return Math.floor((Math.min(item.loaded, item.size) / item.size) * 100);
}

type T = typeof i18n.t;

function failureReason(item: UploadItem, t: T): string | undefined {
  if (item.precheck) return precheckMessage(item, item.precheck, t);
  if (item.error) return t(uploadErrorKey(item.error, { name: item.fileName, type: "" }) ?? "errors.fallback", { defaultValue: t("errors.fallback") });
  return undefined;
}

let announcer: HTMLElement | undefined;

/** Called when a file block first renders, so the region is in the page before it has anything to say: one added together with its text is often not read out. */
function ensureAnnouncer(): HTMLElement {
  if (!announcer?.isConnected) {
    announcer = el("div", "sr-only");
    announcer.setAttribute("role", "status");
    announcer.dataset.uploadAnnouncer = "";
    document.body.append(announcer);
  }
  return announcer;
}

/** Per note and block, not per node view: writing the URL re-creates the block's node view before the item leaves the queue. */
const heard = new Map<string, { item: UploadItem; key: string }>();

function milestoneKey(item: UploadItem, t: T): string {
  return item.status === "failed" ? `${item.id} failed ${failureReason(item, t) ?? ""}` : `${item.id} ${item.status}`;
}

function blockUrl(editor: AnyEditor, blockId: string): string | undefined {
  try {
    return editor.getBlock(blockId)?.props?.url;
  } catch {
    return undefined;
  }
}

/** Starts, the last byte sent, landings and failures are announced; percent ticks are not. `initial`: what a block shows as it renders is not news. */
function hear(noteId: string, blockId: string, item: UploadItem | undefined, editor: AnyEditor, initial: boolean): void {
  const t = i18n.t.bind(i18n);
  const slot = `${noteId}\n${blockId}`;
  const before = heard.get(slot);
  const key = item && milestoneKey(item, t);
  if (item && key !== undefined) heard.set(slot, { item, key });
  else heard.delete(slot);
  if (initial || key === before?.key) return;
  const say = (text: string) => {
    ensureAnnouncer().textContent = text;
  };
  if (!item) {
    const gone = before !== undefined && !getUploadItems().some((i) => i.id === before.item.id);
    // Only the write changes the block's URL as its item leaves; a replaced or cleared item leaves the block as it was.
    const url = gone && before.item.status === "writing" ? blockUrl(editor, blockId) : undefined;
    if (before && url !== undefined && url !== before.item.expectedUrl) say(t("uploadBlock.announceDone", { name: before.item.fileName }));
    return;
  }
  if (item.status === "uploading") say(t("uploadBlock.announceStart", { name: item.fileName }));
  else if (item.status === "writing") say(t("uploadBlock.announce", { name: item.fileName, text: t("uploadBlock.saving") }));
  else {
    const reason = failureReason(item, t);
    if (reason !== undefined) say(t("uploadBlock.announce", { name: item.fileName, text: reason }));
  }
}

/** Returns how long until the countdown needs redrawing, or null. */
function drawStatus(root: HTMLElement, item: UploadItem, blockType: string): number | null {
  const t = i18n.t.bind(i18n);
  root.dataset.uploadState = item.status;
  const head = el("div", "flex min-w-0 items-center gap-2");
  head.append(icon(blockType), el("span", "min-w-0 flex-1 truncate font-medium", item.fileName));
  const children: HTMLElement[] = [head];
  let redrawIn: number | null = null;

  if (isActive(item)) {
    const percent = itemPercent(item);
    const loaded = item.status === "writing" ? item.size : Math.min(item.loaded, item.size);
    head.append(
      el("span", "shrink-0 tabular-nums text-muted-foreground", t("uploadBlock.progress", { percent, loaded: formatBytes(loaded), total: formatBytes(item.size) })),
    );
    const bar = el("div", "h-1 rounded-full bg-brand-soft");
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-label", t("uploadBlock.progressLabel", { name: item.fileName }));
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-valuenow", String(percent));
    const fill = el("div", "h-1 rounded-full bg-brand");
    fill.style.width = `${percent}%`;
    bar.append(fill);
    children.push(bar);
    if (item.status === "writing") children.push(el("p", "text-muted-foreground", t("uploadBlock.saving")));
  } else {
    const reason = failureReason(item, t);
    if (reason !== undefined) children.push(el("p", "text-destructive", reason));
    // The upload toast is skipped while this block is on screen, so the hint on whom to ask lives here.
    if (item.error?.code === "storage_quota_exceeded") children.push(el("p", "text-muted-foreground", storageQuotaDescription(item.error, t)));
    if (isUploadRetryable(item)) {
      const waitMs = uploadRetryWaitMs(item);
      const row = el("p", "text-muted-foreground");
      const button = el(
        "button",
        "rounded text-brand-on-soft underline underline-offset-2 hover:text-foreground disabled:no-underline disabled:opacity-60",
        item.retrying ? t("uploadBlock.checking") : waitMs > 0 ? t("uploadBlock.retryWait", { seconds: Math.ceil(waitMs / 1000) }) : t("uploadBlock.retry"),
      );
      button.type = "button";
      button.disabled = waitMs > 0 || item.retrying === true;
      if (!button.disabled) button.setAttribute("aria-label", t("uploadBlock.retryLabel", { name: item.fileName }));
      // The block is a ProseMirror node view: without this the press would select the block and move focus first.
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
      });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        retry(item.id);
      });
      row.append(button);
      if (!item.stored) row.append(" ", t("uploadBlock.startsOver"));
      children.push(row);
      if (waitMs > 0) redrawIn = waitMs % 1000 || 1000;
    }
  }
  root.replaceChildren(...children);
  return redrawIn;
}

function findItem(editor: AnyEditor, blockId: string): UploadItem | undefined {
  const noteId = editorNotes.get(editor);
  if (noteId === undefined) return undefined;
  let found: UploadItem | undefined;
  for (const item of getUploadItems()) {
    // An upload whose place is gone belongs to the list only; this block shows something else now.
    if (item.noteId === noteId && item.blockId === blockId && item.status !== "unplaced") found = item;
  }
  return found;
}

const FILE_BLOCK_TYPES = new Set(["image", "audio", "video", "file"]);

/** Called once the node view is destroyed. A move or a re-render destroys it too, and leaving the note destroys the views with the block still in the editor's document. */
function dropIfBlockGone(editor: AnyEditor, blockId: string): void {
  const noteId = editorNotes.get(editor);
  if (noteId === undefined) return;
  queueMicrotask(() => {
    let block: { type: string } | undefined;
    try {
      block = editor.getBlock(blockId);
    } catch {
      return;
    }
    if (block && FILE_BLOCK_TYPES.has(block.type)) return;
    for (const item of getUploadItems()) if (item.noteId === noteId && item.blockId === blockId) dropUnplaceableUpload(item.id);
  });
}

function attachUploadStatus(dom: HTMLElement, block: FileBlockLike, editor: AnyEditor): () => void {
  const wrapper = dom.querySelector<HTMLElement>(".bn-file-block-content-wrapper") ?? dom;
  const status = el("div", "kn-upload-status w-full space-y-1 py-1 text-xs");
  status.style.display = "none";
  wrapper.append(status);
  const addButton = wrapper.querySelector<HTMLElement>(".bn-add-file-button");
  const noteId = editorNotes.get(editor);
  if (noteId !== undefined) ensureAnnouncer();

  let shown: UploadItem | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const update = (force = false, initial = false) => {
    let item = findItem(editor, block.id);
    // The block got a file another way (the Embed tab, another person): an old failure no longer describes it.
    if (item && !isActive(item) && item.expectedUrl !== (block.props.url ?? "")) {
      const stale = item.id;
      queueMicrotask(() => dropUnplaceableUpload(stale));
      item = undefined;
    }
    if (noteId !== undefined && (item !== shown || initial)) hear(noteId, block.id, item, editor, initial);
    if (item === shown && !force && !initial) return;
    shown = item;
    clearTimeout(timer);
    timer = undefined;
    if (addButton) addButton.style.display = item && isActive(item) ? "none" : "";
    if (!item) {
      status.style.display = "none";
      status.replaceChildren();
      delete status.dataset.uploadState;
      return;
    }
    status.style.display = "";
    const redrawIn = drawStatus(status, item, block.type);
    if (redrawIn !== null) timer = setTimeout(() => update(true), redrawIn);
  };
  update(false, true);
  const unsubscribe = subscribeUploads(() => update());
  return () => {
    unsubscribe();
    clearTimeout(timer);
  };
}

// BlockNote's file block has no way to open the file. No `download` attribute: the server's Content-Disposition names
// the download, not a block name anyone can edit.
function linkFileName(dom: HTMLElement, block: FileBlockLike, editor: AnyEditor): () => void {
  const url = block.props.url ?? "";
  const nameEl = dom.querySelector<HTMLElement>(".bn-file-name");
  if (block.type !== "file" || url === "" || !nameEl) return () => {};
  let alive = true;
  const resolve: (raw: string) => Promise<string> = typeof editor?.resolveFileUrl === "function" ? (raw) => editor.resolveFileUrl(raw) : (raw) => Promise.resolve(raw);
  void resolve(url).then(
    (href) => {
      if (!alive || href === "" || href === BLOCKED_MEDIA_URL) return;
      const a = document.createElement("a");
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener";
      a.className = "underline underline-offset-2";
      a.textContent = block.props.name || url;
      nameEl.replaceChildren(a);
    },
    () => {},
  );
  return () => {
    alive = false;
  };
}

export function withUploadStatus<Spec extends RenderableSpec>(spec: Spec): Spec {
  const render = spec.implementation.render;
  return {
    ...spec,
    implementation: {
      ...spec.implementation,
      render(this: { renderType?: string } | undefined, block: FileBlockLike, editor: AnyEditor) {
        const output: RenderOutput = render.call(this, block, withoutUploadPlaceholder(editor));
        // "dom" renders (HTML export) have no destroy call to end a subscription.
        if (this?.renderType !== "nodeView" || !(output.dom instanceof HTMLElement)) return output;
        const detachStatus = attachUploadStatus(output.dom, block, editor);
        const detachLink = linkFileName(output.dom, block, editor);
        return {
          ...output,
          destroy: () => {
            detachStatus();
            detachLink();
            output.destroy?.();
            dropIfBlockGone(editor, block.id);
          },
        };
      },
    },
  } as Spec;
}
