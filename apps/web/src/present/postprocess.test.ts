import { beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeSlideFragment } from "./sanitize";
import {
  codeHighlightJobsIn,
  mathJobsIn,
  mermaidJobsIn,
  postprocessSlide,
  runCodeHighlightJob,
  runMathJob,
  runMermaidJob,
  type PostprocessContext,
  type WikilinkResolution,
} from "./postprocess";

const renderMermaid = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mermaid", () => ({ renderMermaid }));
const renderMath = vi.hoisted(() => vi.fn());
vi.mock("@/lib/katex", () => ({ renderMath }));
const codeHighlight = vi.hoisted(() => ({
  tokenizeCode: vi.fn(),
  cachedCodeTokens: vi.fn(() => null),
}));
vi.mock("./code-highlight", async (importOriginal) => {
  const real = await importOriginal<typeof import("./code-highlight")>();
  return {
    ...real,
    tokenizeCode: codeHighlight.tokenizeCode,
    cachedCodeTokens: codeHighlight.cachedCodeTokens,
  };
});

const member = (resolve: (id: string) => WikilinkResolution = () => ({ kind: "pending" })): PostprocessContext => ({
  resolveMedia: (url) => (url.startsWith("javascript:") ? "about:blank" : url),
  wikilinks: { kind: "member", resolve, brokenLabel: "This linked note no longer exists." },
});
const publicCtx: PostprocessContext = {
  resolveMedia: (url) => url.replace(/^\/api\/uploads\//, "/api/public/notes/TOKEN/uploads/"),
  wikilinks: { kind: "public" },
};

function run(html: string, ctx: PostprocessContext) {
  const fragment = sanitizeSlideFragment(html);
  const { mermaid: jobs, code: codeJobs, math: mathJobs } = postprocessSlide(fragment, ctx);
  const host = document.createElement("div");
  host.append(fragment);
  return { host, jobs, codeJobs, mathJobs };
}

const WIKILINK = '<p>see <span data-inline-content-type="wikilink" data-target-note-id="n 1" data-snapshot-title="Old &lt;b&gt;title"><span>[[Old]]</span></span></p>';

describe("postprocessSlide", () => {
  beforeEach(() => {
    renderMermaid.mockReset();
    codeHighlight.tokenizeCode.mockReset();
    codeHighlight.cachedCodeTokens.mockReset();
    codeHighlight.cachedCodeTokens.mockReturnValue(null);
  });

  it("all img/video/audio[src] go through resolveMedia (the public variant maps to the public endpoint)", () => {
    const { host } = run('<img src="/api/uploads/a" alt=""><video src="/api/uploads/v"></video><audio src="/api/uploads/s"></audio>', publicCtx);
    expect(host.querySelector("img")!.getAttribute("src")).toBe("/api/public/notes/TOKEN/uploads/a");
    expect(host.querySelector("video")!.getAttribute("src")).toBe("/api/public/notes/TOKEN/uploads/v");
    expect(host.querySelector("audio")!.getAttribute("src")).toBe("/api/public/notes/TOKEN/uploads/s");
  });

  it("a[data-kn-media] (file link) goes through resolveMedia; /api/uploads/ in text links isn't mapped", () => {
    const { host } = run('<a href="/api/uploads/f" data-kn-media="">f.pdf</a><a href="/api/uploads/g">text</a>', publicCtx);
    const [file, text] = Array.from(host.querySelectorAll("a"));
    expect(file.getAttribute("href")).toBe("/api/public/notes/TOKEN/uploads/f");
    expect(text.getAttribute("href")).toBe("/api/uploads/g");
  });

  it("text links: http(s), mailto and relative are kept; #... loses its href (reveal would intercept it as a slide jump); other schemes are dropped", () => {
    const { host } = run('<a href="https://e/x">1</a><a href="mailto:a@b">2</a><a href="/n/a/b">3</a><a href="#/abc">4</a><a href="ftp://e">5</a>', member());
    expect(Array.from(host.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toEqual(["https://e/x", "mailto:a@b", "/n/a/b", null, null]);
  });

  it("postprocessSlide fed directly without the sanitizer: ftp: / tel: / javascript: hrefs are removed by the protocol allowlist (the allowlist is load-bearing here)", () => {
    const template = document.createElement("template");
    template.innerHTML = '<a href="ftp://e/f">1</a><a href="tel:+886123">2</a><a href="javascript:alert(1)">3</a><a href="https://e/x">4</a><a href="mailto:a@b">5</a>';
    postprocessSlide(template.content, member());
    expect(Array.from(template.content.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toEqual([null, null, null, "https://e/x", "mailto:a@b"]);
  });

  it("every kept a gets target=_blank, rel=noopener noreferrer", () => {
    const { host } = run('<a href="https://e/x">1</a>', member());
    const a = host.querySelector("a")!;
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("video / audio get controls and preload=metadata; checkbox disabled; details open", () => {
    const { host } = run('<video src="https://e/v.mp4"></video><audio src="https://e/a.mp3"></audio><ul><li><input type="checkbox" checked><p>x</p></li></ul><details><summary>s</summary><p>c</p></details>', member());
    for (const media of host.querySelectorAll("video, audio")) {
      expect(media.hasAttribute("controls")).toBe(true);
      expect(media.getAttribute("preload")).toBe("metadata");
    }
    expect(host.querySelector("input")!.hasAttribute("disabled")).toBe(true);
    expect(host.querySelector("details")!.hasAttribute("open")).toBe(true);
  });

  it("table wrapped in div.kn-present-table[data-prevent-swipe]", () => {
    const { host } = run("<table><tbody><tr><td>c</td></tr></tbody></table>", member());
    const wrap = host.querySelector("table")!.parentElement!;
    expect(wrap.className).toBe("kn-present-table");
    expect(wrap.hasAttribute("data-prevent-swipe")).toBe(true);
  });

  it("wikilink (signed in) not ready: <a href=/notes/<encodeURIComponent(id)>> plus snapshotTitle (text), new tab, no [[ ]] shown", () => {
    const { host } = run(WIKILINK, member(() => ({ kind: "pending" })));
    const a = host.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("/notes/n%201");
    expect(a.textContent).toBe("Old <b>title");
    expect(a.querySelector("b")).toBeNull();
    expect(a.getAttribute("target")).toBe("_blank");
    expect(host.textContent).not.toContain("[[");
  });

  it("wikilink (signed in) hit: canonical href plus current title", () => {
    const { host } = run(WIKILINK, member(() => ({ kind: "found", href: "/n/tester/new", title: "New title" })));
    const a = host.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("/n/tester/new");
    expect(a.textContent).toBe("New title");
  });

  it("wikilink (signed in) list loaded but note missing: broken-link style plain text (not a link)", () => {
    const { host } = run(WIKILINK, member(() => ({ kind: "broken" })));
    expect(host.querySelector("a")).toBeNull();
    const span = host.querySelector(".kn-present-wikilink-broken")!;
    expect(span.textContent).toBe("Old <b>title");
    expect(span.getAttribute("title")).toBe("This linked note no longer exists.");
  });

  it("wikilink (public): plain-text snapshotTitle, no element wraps it", () => {
    const { host } = run(WIKILINK, publicCtx);
    expect(host.querySelector("a, span")).toBeNull();
    expect(host.textContent).toBe("see Old <b>title");
  });

  it("mermaid: marker element emptied and collected as a job (original code); blank code is removed directly", () => {
    const { host, jobs } = run('<div data-kn-mermaid="">graph TD; A--&gt;B</div><div data-kn-mermaid="">   </div>', member());
    expect(jobs).toHaveLength(1);
    expect(jobs[0].code).toBe("graph TD; A-->B");
    expect(jobs[0].el.textContent).toBe("");
    expect(host.querySelectorAll("[data-kn-mermaid]")).toHaveLength(1);
    expect(mermaidJobsIn(host)).toEqual(jobs);
  });

  it("code blocks: supported non-text languages are collected with plain text preserved; text/unknown/blank are skipped", () => {
    const { host, codeJobs } = run(
      '<pre><code data-kn-code-lang="ts">const x = 1;</code></pre>' +
        '<pre><code data-kn-code-lang="text">plain</code></pre>' +
        '<pre><code data-kn-code-lang="unknown">foo</code></pre>' +
        '<pre><code data-kn-code-lang="ts">   </code></pre>',
      member(),
    );
    expect(codeJobs).toHaveLength(1);
    expect(codeJobs[0]).toMatchObject({ lang: "typescript", code: "const x = 1;" });
    expect(codeJobs[0].el.textContent).toBe("const x = 1;");
    expect(codeHighlightJobsIn(host)).toEqual(codeJobs);
  });

  it("code blocks: cache hit applies tokens synchronously without queueing an async job", () => {
    codeHighlight.cachedCodeTokens.mockReturnValueOnce([
      [
        { content: "const", color: "var(--code-token-keyword)", fontStyle: 0 },
        { content: " x = 1;", color: "var(--code-foreground)", fontStyle: 0 },
      ],
    ] as never);
    const { host, codeJobs } = run('<pre><code data-kn-code-lang="ts">const x = 1;</code></pre>', member());
    expect(codeJobs).toHaveLength(0);
    expect(codeHighlightJobsIn(host)).toEqual([]);
    const spans = Array.from(host.querySelectorAll<HTMLSpanElement>("pre > code > span"));
    expect(spans).toHaveLength(2);
    expect(spans[0]!.style.color).toBe("var(--code-token-keyword)");
    expect(host.querySelector("pre > code")!.textContent).toBe("const x = 1;");
  });

  const WL = (attrs: string) => `<p><span data-inline-content-type="wikilink" data-target-note-id="n1" data-snapshot-title="Snap"${attrs}><a href="/notes/n1">x</a></span></p>`;
  it("#269 member: hit -> text label preferred, href = canonical + #b-anchor; not ready -> /notes/<id> + anchor, label preferred; broken -> label-preferred plain text", () => {
    const found = member(() => ({ kind: "found", href: "/n/h/x", title: "Live" }));
    let a = run(WL(' data-label="L" data-anchor-block-id="b1"'), found).host.querySelector("a")!;
    expect([a.getAttribute("href"), a.textContent]).toEqual(["/n/h/x#b-b1", "L"]);
    a = run(WL(""), found).host.querySelector("a")!;
    expect([a.getAttribute("href"), a.textContent]).toEqual(["/n/h/x", "Live"]);
    a = run(WL(' data-label="L" data-anchor-block-id="b1"'), member()).host.querySelector("a")!;
    expect([a.getAttribute("href"), a.textContent]).toEqual(["/notes/n1#b-b1", "L"]);
    const span = run(WL(' data-label="L"'), member(() => ({ kind: "broken" }))).host.querySelector(".kn-present-wikilink-broken")!;
    expect(span.textContent).toBe("L");
  });
  it("#269 public: plain-text label || snapshotTitle (doesn't link to a public target)", () => {
    expect(run(WL(' data-label="L"'), publicCtx).host.textContent).toBe("L");
    expect(run(WL(""), publicCtx).host.textContent).toBe("Snap");
    expect(run(WL(' data-label="L"'), publicCtx).host.querySelector("a")).toBeNull();
  });
});

describe("runMermaidJob", () => {
  beforeEach(() => renderMermaid.mockReset());

  it("success -> SVG in innerHTML; returns true", async () => {
    renderMermaid.mockResolvedValue({ ok: true, svg: '<svg data-x="1"></svg>' });
    const el = document.createElement("div");
    expect(await runMermaidJob({ el, code: "graph TD" }, "dark", () => true, "err")).toBe(true);
    expect(renderMermaid).toHaveBeenCalledWith("graph TD", "dark");
    expect(el.querySelector("svg[data-x]")).not.toBeNull();
  });

  it("error -> hint plus source <pre> (textContent, not HTML)", async () => {
    renderMermaid.mockResolvedValue({ ok: false, message: "Parse error" });
    const el = document.createElement("div");
    await runMermaidJob({ el, code: "<img src=x onerror=alert(1)>" }, "light", () => true, "Diagram error");
    expect(el.querySelector(".kn-present-mermaid-error")!.textContent).toBe("Diagram error");
    expect(el.querySelector("pre")!.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(el.querySelector("img")).toBeNull();
  });

  it("empty (message is an empty string) -> element removed", async () => {
    renderMermaid.mockResolvedValue({ ok: false, message: "" });
    const parent = document.createElement("div");
    const el = document.createElement("div");
    parent.append(el);
    await runMermaidJob({ el, code: "x" }, "light", () => true, "err");
    expect(parent.childElementCount).toBe(0);
  });

  it("stale generation (isCurrent returns false) -> result dropped, returns false", async () => {
    renderMermaid.mockResolvedValue({ ok: true, svg: "<svg></svg>" });
    const el = document.createElement("div");
    expect(await runMermaidJob({ el, code: "graph TD" }, "light", () => false, "err")).toBe(false);
    expect(el.innerHTML).toBe("");
  });
});

describe("math jobs", () => {
  beforeEach(() => renderMath.mockReset());

  it("math: marker element emptied and collected as a job (original tex); blank tex is removed directly", () => {
    const { host, mathJobs } = run('<div data-kn-math="">E=mc^2 &lt;b&gt;</div><div data-kn-math="">   </div>', member());
    expect(mathJobs).toHaveLength(1);
    expect(mathJobs[0].tex).toBe("E=mc^2 <b>");
    expect(mathJobs[0].el.textContent).toBe("");
    expect(mathJobs[0].el.classList.contains("kn-present-math")).toBe(true);
    expect(host.querySelectorAll("[data-kn-math]")).toHaveLength(1);
    expect(mathJobsIn(host)).toEqual(mathJobs);
  });

  it("a div[data-kn-math] without a recorded source is not turned into a job by mathJobsIn", () => {
    const host = document.createElement("div");
    host.innerHTML = '<div data-kn-math="">x</div>';
    expect(mathJobsIn(host)).toEqual([]);
  });

  it("a mermaid marker does not produce a math job", () => {
    const { mathJobs, jobs } = run('<div data-kn-mermaid="">graph TD</div>', member());
    expect(mathJobs).toEqual([]);
    expect(jobs).toHaveLength(1);
  });
});

describe("runMathJob", () => {
  beforeEach(() => renderMath.mockReset());

  it("success -> KaTeX html in innerHTML; returns true", async () => {
    renderMath.mockResolvedValue({ ok: true, html: '<span class="katex" data-x="1"></span>' });
    const el = document.createElement("div");
    expect(await runMathJob({ el, tex: "x^2" }, () => true, "err")).toBe(true);
    expect(renderMath).toHaveBeenCalledWith("x^2");
    expect(el.innerHTML).toBe('<span class="katex" data-x="1"></span>');
  });

  it("error -> hint plus source <pre> (textContent, not HTML)", async () => {
    renderMath.mockResolvedValue({ ok: false, message: "boom" });
    const el = document.createElement("div");
    await runMathJob({ el, tex: "<img src=x onerror=alert(1)>" }, () => true, "Formula error");
    expect(el.querySelector(".kn-present-math-error")!.textContent).toBe("Formula error");
    expect(el.querySelector("pre > code")!.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(el.querySelector("img")).toBeNull();
  });

  it("empty (message is an empty string) -> element removed", async () => {
    renderMath.mockResolvedValue({ ok: false, message: "" });
    const parent = document.createElement("div");
    const el = document.createElement("div");
    parent.append(el);
    await runMathJob({ el, tex: "x" }, () => true, "err");
    expect(parent.childElementCount).toBe(0);
  });

  it("stale generation (isCurrent returns false) -> result dropped, returns false", async () => {
    renderMath.mockResolvedValue({ ok: true, html: "<span>late</span>" });
    const el = document.createElement("div");
    expect(await runMathJob({ el, tex: "x" }, () => false, "err")).toBe(false);
    expect(el.innerHTML).toBe("");
  });
});

describe("runCodeHighlightJob", () => {
  beforeEach(() => {
    codeHighlight.tokenizeCode.mockReset();
    codeHighlight.cachedCodeTokens.mockReset();
    codeHighlight.cachedCodeTokens.mockReturnValue(null);
  });

  it("success -> replaces children with spans via textContent/style.color (XSS-safe) and returns true", async () => {
    const payload = "<img src=x onerror=alert(1)>";
    codeHighlight.tokenizeCode.mockResolvedValue([
      [{ content: payload, color: "var(--code-token-string)", fontStyle: 0 }],
    ]);
    const { host, codeJobs } = run(
      `<pre><code data-kn-code-lang="ts">${payload.replace(/</g, "&lt;")}</code></pre>`,
      member(),
    );
    expect(await runCodeHighlightJob(codeJobs[0]!, () => true)).toBe(true);
    expect(codeHighlight.tokenizeCode).toHaveBeenCalledWith("typescript", payload);
    expect(host.querySelector("img")).toBeNull();
    const span = host.querySelector("pre > code > span") as HTMLSpanElement;
    expect(span.textContent).toBe(payload);
    expect(span.style.color).toBe("var(--code-token-string)");
    expect(codeHighlightJobsIn(host)).toEqual([]);
  });

  it("failure (tokenizeCode returns null) -> leaves plain text intact and returns false", async () => {
    codeHighlight.tokenizeCode.mockResolvedValue(null);
    const el = document.createElement("code");
    el.textContent = "const x = 1;";
    expect(await runCodeHighlightJob({ el, lang: "typescript", code: "const x = 1;" }, () => true)).toBe(false);
    expect(el.textContent).toBe("const x = 1;");
    expect(el.querySelector("span")).toBeNull();
  });

  it("stale generation (isCurrent returns false) -> drops tokens and returns false", async () => {
    codeHighlight.tokenizeCode.mockResolvedValue([
      [{ content: "const", color: "var(--code-token-keyword)", fontStyle: 0 }],
    ]);
    const el = document.createElement("code");
    el.textContent = "const";
    expect(await runCodeHighlightJob({ el, lang: "typescript", code: "const" }, () => false)).toBe(false);
    expect(el.querySelector("span")).toBeNull();
    expect(el.textContent).toBe("const");
  });
});
