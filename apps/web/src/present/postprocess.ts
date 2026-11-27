import { normalizeAnchor } from "@knotebook/shared";
import { renderMath } from "@/lib/katex";
import { renderMermaid, type MermaidTheme } from "@/lib/mermaid";
import { applyHighlightTokens, cachedCodeTokens, resolveHighlightLanguage, tokenizeCode } from "./code-highlight";

/**
 * Runs after sanitizing, DOM API only.
 * - Media always goes through the page kind's resolution (`safeMediaUrl` / `publicMediaUrl(ref)`); the `data-kn-media`
 *   marker comes only from presentationSchema and tells file links from text links (identical in the HTML).
 * - Text links keep only http(s) / mailto / relative URLs; `href="#…"` is removed (reveal would intercept it as a page jump).
 * - mermaid is only collected into a job; drawing (the only innerHTML) happens in `runMermaidJob` after insertion, trusting
 *   the strict config of `lib/mermaid.ts` without sanitizing again.
 * - math is collected the same way; `runMathJob` draws the KaTeX HTML (the second innerHTML) after insertion, trusting
 *   `lib/katex.ts` (`trust: false`) without sanitizing again.
 * - code blocks: cached token lists are applied synchronously via `textContent`/`style` (zero flicker on live updates);
 *   uncached ones keep their plain text and are highlighted asynchronously in `runCodeHighlightJob` (#232).
 */
export type WikilinkResolution = { kind: "pending" } | { kind: "found"; href: string; title: string } | { kind: "broken" };

export interface PostprocessContext {
  resolveMedia: (url: string) => string;
  wikilinks: { kind: "member"; resolve: (targetNoteId: string) => WikilinkResolution; brokenLabel: string } | { kind: "public" };
}

export interface MermaidJob {
  el: HTMLElement;
  code: string;
}

export interface MathJob {
  el: HTMLElement;
  tex: string;
}

export interface CodeHighlightJob {
  el: HTMLElement;
  lang: string;
  code: string;
}

export interface PostprocessJobs {
  mermaid: MermaidJob[];
  math: MathJob[];
  code: CodeHighlightJob[];
}

const mermaidSource = new WeakMap<Element, string>();
const mathSource = new WeakMap<Element, string>();
const codeHighlightSource = new WeakMap<Element, { lang: string; code: string }>();

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
  // #269: label takes priority; with the default (empty) value BlockNote does not output these two attributes.
  const label = el.getAttribute("data-label") ?? "";
  const anchor = normalizeAnchor(el.getAttribute("data-anchor-block-id") ?? "");
  const hash = anchor ? `#b-${anchor}` : "";
  if (ctx.wikilinks.kind === "public") return document.createTextNode(label || snapshot);
  const resolution = ctx.wikilinks.resolve(targetId);
  if (resolution.kind === "broken") {
    const span = document.createElement("span");
    span.className = "kn-present-wikilink-broken";
    span.title = ctx.wikilinks.brokenLabel;
    span.textContent = label || snapshot;
    return span;
  }
  const a = document.createElement("a");
  a.setAttribute("href", `${resolution.kind === "found" ? resolution.href : `/notes/${encodeURIComponent(targetId)}`}${hash}`);
  a.textContent = label || (resolution.kind === "found" ? resolution.title : snapshot);
  openInNewTab(a);
  return a;
}

export function postprocessSlide(root: ParentNode, ctx: PostprocessContext): PostprocessJobs {
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

  const mermaid: MermaidJob[] = [];
  for (const el of root.querySelectorAll<HTMLElement>("[data-kn-mermaid]")) {
    const code = el.textContent ?? "";
    if (code.trim() === "") {
      el.remove();
      continue;
    }
    el.textContent = "";
    el.classList.add("kn-present-mermaid");
    mermaidSource.set(el, code);
    mermaid.push({ el, code });
  }

  const math: MathJob[] = [];
  for (const el of root.querySelectorAll<HTMLElement>("[data-kn-math]")) {
    const tex = el.textContent ?? "";
    if (tex.trim() === "") {
      el.remove();
      continue;
    }
    el.textContent = "";
    el.classList.add("kn-present-math");
    mathSource.set(el, tex);
    math.push({ el, tex });
  }

  const code: CodeHighlightJob[] = [];
  for (const el of root.querySelectorAll<HTMLElement>("pre > code[data-kn-code-lang]")) {
    const lang = resolveHighlightLanguage(el.getAttribute("data-kn-code-lang"));
    if (lang === null) continue;
    const source = el.textContent ?? "";
    if (source.trim() === "") continue;
    const cached = cachedCodeTokens(lang, source);
    if (cached !== null) {
      applyHighlightTokens(el, cached);
      continue;
    }
    codeHighlightSource.set(el, { lang, code: source });
    code.push({ el, lang, code: source });
  }

  return { mermaid, math, code };
}

export function mermaidJobsIn(root: ParentNode): MermaidJob[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-kn-mermaid]")).flatMap((el) => {
    const code = mermaidSource.get(el);
    return code === undefined ? [] : [{ el, code }];
  });
}

export function mathJobsIn(root: ParentNode): MathJob[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-kn-math]")).flatMap((el) => {
    const tex = mathSource.get(el);
    return tex === undefined ? [] : [{ el, tex }];
  });
}

export function codeHighlightJobsIn(root: ParentNode): CodeHighlightJob[] {
  return Array.from(root.querySelectorAll<HTMLElement>("pre > code[data-kn-code-lang]")).flatMap((el) => {
    const entry = codeHighlightSource.get(el);
    return entry === undefined ? [] : [{ el, ...entry }];
  });
}

export async function runCodeHighlightJob(job: CodeHighlightJob, isCurrent: () => boolean): Promise<boolean> {
  const lines = await tokenizeCode(job.lang, job.code);
  if (!isCurrent() || lines === null) return false;
  applyHighlightTokens(job.el, lines);
  codeHighlightSource.delete(job.el);
  return true;
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
    job.el.innerHTML = result.svg; // the only innerHTML; the source is lib/mermaid.ts (strict + DOMPurify + bindFunctions not called)
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

export async function runMathJob(job: MathJob, isCurrent: () => boolean, errorText: string): Promise<boolean> {
  const result = await renderMath(job.tex);
  if (!isCurrent()) return false;
  if (result.ok) {
    job.el.innerHTML = result.html; // the second innerHTML; the source is lib/katex.ts (trust:false), produced after sanitizing
    return true;
  }
  if (result.message === "") {
    job.el.remove();
    return true;
  }
  const note = document.createElement("p");
  note.className = "kn-present-math-error";
  note.textContent = errorText;
  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = job.tex;
  pre.append(code);
  job.el.replaceChildren(note, pre);
  return true;
}
