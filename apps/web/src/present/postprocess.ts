import { renderMermaid, type MermaidTheme } from "@/lib/mermaid";

/**
 * #229 投影片後處理（spec §5.3）：在消毒**之後**、只用 DOM API。
 * - 媒體（所有 img/video/audio[src] 與檔案連結 `a[data-kn-media]`）一律走頁別的媒體解析
 *   （已登入 `safeMediaUrl`、公開 `publicMediaUrl(ref)`）；`data-kn-media` 標記只來自 presentationSchema
 *   （§5.2-2），用來把檔案連結與文字連結分開（兩者 HTML 上分不開，§2.6-7）。
 * - 文字連結只留 http(s)／mailto／相對網址；`href="#…"` 拿掉（reveal 會攔截並當跳頁，§2.11-15）。
 * - mermaid 只在這裡收成 job；繪製（唯一的 innerHTML）由 `runMermaidJob` 在插入文件之後做，信任
 *   `lib/mermaid.ts` 的 strict 設定，不再過一次消毒（§5.4-4）。
 */
export type WikilinkResolution = { kind: "pending" } | { kind: "found"; href: string; title: string } | { kind: "broken" };

export interface PostprocessContext {
  resolveMedia: (url: string) => string;
  /** member：`brokenLabel`＝`t("note.wikilinkBroken")`，斷鏈 span 的 title（滑過看得到原因）。 */
  wikilinks: { kind: "member"; resolve: (targetNoteId: string) => WikilinkResolution; brokenLabel: string } | { kind: "public" };
}

export interface MermaidJob {
  el: HTMLElement;
  code: string;
}

const mermaidSource = new WeakMap<Element, string>();

function isAllowedTextHref(raw: string): boolean {
  const value = raw.trim();
  if (value === "" || value.startsWith("#")) return false;
  let parsed: URL;
  try {
    parsed = new URL(value, window.location.href);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" || parsed.protocol === "mailto:";
}

function openInNewTab(a: HTMLAnchorElement): void {
  a.setAttribute("target", "_blank");
  a.setAttribute("rel", "noopener noreferrer");
}

function wikilinkNode(el: Element, ctx: PostprocessContext): Node {
  const targetId = el.getAttribute("data-target-note-id") ?? "";
  const snapshot = el.getAttribute("data-snapshot-title") ?? "";
  if (ctx.wikilinks.kind === "public") return document.createTextNode(snapshot);
  const resolution = ctx.wikilinks.resolve(targetId);
  if (resolution.kind === "broken") {
    const span = document.createElement("span");
    span.className = "kn-present-wikilink-broken";
    span.title = ctx.wikilinks.brokenLabel;
    span.textContent = snapshot;
    return span;
  }
  const a = document.createElement("a");
  a.setAttribute("href", resolution.kind === "found" ? resolution.href : `/notes/${encodeURIComponent(targetId)}`);
  a.textContent = resolution.kind === "found" ? resolution.title : snapshot;
  openInNewTab(a);
  return a;
}

export function postprocessSlide(root: ParentNode, ctx: PostprocessContext): MermaidJob[] {
  for (const el of root.querySelectorAll<HTMLElement>("img[src], video[src], audio[src]")) {
    el.setAttribute("src", ctx.resolveMedia(el.getAttribute("src") ?? ""));
  }
  for (const a of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    const href = a.getAttribute("href") ?? "";
    if (a.hasAttribute("data-kn-media")) a.setAttribute("href", ctx.resolveMedia(href));
    else if (!isAllowedTextHref(href)) a.removeAttribute("href");
  }
  for (const a of root.querySelectorAll<HTMLAnchorElement>("a[href]")) openInNewTab(a);
  for (const media of root.querySelectorAll("video, audio")) {
    media.setAttribute("controls", "");
    media.setAttribute("preload", "metadata");
  }
  for (const input of root.querySelectorAll('input[type="checkbox"]')) input.setAttribute("disabled", "");
  for (const details of root.querySelectorAll("details")) details.setAttribute("open", "");
  for (const table of root.querySelectorAll("table")) {
    if (table.parentElement?.classList.contains("kn-present-table")) continue;
    const wrap = document.createElement("div");
    wrap.className = "kn-present-table";
    wrap.setAttribute("data-prevent-swipe", "");
    table.replaceWith(wrap);
    wrap.append(table);
  }
  for (const el of root.querySelectorAll('[data-inline-content-type="wikilink"]')) el.replaceWith(wikilinkNode(el, ctx));

  const jobs: MermaidJob[] = [];
  for (const el of root.querySelectorAll<HTMLElement>("[data-kn-mermaid]")) {
    const code = el.textContent ?? "";
    if (code.trim() === "") {
      el.remove();
      continue;
    }
    el.textContent = "";
    el.classList.add("kn-present-mermaid");
    mermaidSource.set(el, code);
    jobs.push({ el, code });
  }
  return jobs;
}

/** root 底下所有 mermaid 標記元素的 job（主題切換、更新後重畫用）。 */
export function mermaidJobsIn(root: ParentNode): MermaidJob[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-kn-mermaid]")).flatMap((el) => {
    const code = mermaidSource.get(el);
    return code === undefined ? [] : [{ el, code }];
  });
}

export async function runMermaidJob(
  job: MermaidJob,
  theme: MermaidTheme,
  isCurrent: () => boolean,
  errorText: string,
): Promise<boolean> {
  const result = await renderMermaid(job.code, theme);
  if (!isCurrent()) return false;
  if (result.ok) {
    job.el.innerHTML = result.svg; // §5.4-4：唯一的 innerHTML，來源是 lib/mermaid.ts（strict＋DOMPurify＋不呼叫 bindFunctions）
    return true;
  }
  if (result.message === "") {
    job.el.remove();
    return true;
  }
  const note = document.createElement("p");
  note.className = "kn-present-mermaid-error";
  note.textContent = errorText;
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = job.code;
  pre.append(code);
  job.el.replaceChildren(note, pre);
  return true;
}
