import { beforeEach, describe, expect, it } from "vitest";
import { KATEX_OPTIONS, renderMath, resetKatexForTests } from "./katex";

/** KaTeX produces a plain string and needs no layout, so these tests use the real KaTeX (unlike lib/mermaid.test.ts, which mocks it entirely). */
beforeEach(() => resetKatexForTests());

/** Strips the MathML <annotation>: it keeps the raw input as a text node, which would fool "output contains this string" assertions. */
const withoutAnnotation = (html: string) => html.replace(/<annotation[\s\S]*?<\/annotation>/g, "");

/** Puts the output into a real DOM and checks the executable surface: elements and attributes, not strings. Escaped text (&lt;img …&gt;) is not an element and does not count. */
function dangerousNodes(html: string): string[] {
  const host = document.createElement("div");
  host.innerHTML = html;
  host.querySelectorAll("annotation").forEach((n) => n.remove());
  const hits: string[] = [];
  for (const el of host.querySelectorAll("*")) {
    const tag = el.tagName.toLowerCase();
    if (["a", "img", "script", "iframe"].includes(tag)) hits.push(`<${tag}>`);
    for (const attr of Array.from(el.attributes)) {
      if (/^on/i.test(attr.name) || attr.name === "href" || attr.name === "src") hits.push(`${tag}[${attr.name}]`);
    }
    if (el.classList.contains("evil")) hits.push(`${tag}.evil`);
    if (/color:\s*red/i.test(el.getAttribute("style") ?? "")) hits.push(`${tag}[style*=red]`);
  }
  return hits;
}

describe("renderMath", () => {
  it("a valid formula returns ok with KaTeX markup", async () => {
    const r = await renderMath("E = mc^2");
    expect(r.ok).toBe(true);
    expect(r.ok && r.html).toContain('class="katex-display"');
  });

  it("blank input returns ok:false with an empty message (the caller shows a hint, not an error)", async () => {
    expect(await renderMath("   \n ")).toEqual({ ok: false, message: "" });
  });

  it("a tex that is not a string (a misbehaving client can write any value into the prop) resolves as blank instead of rejecting", async () => {
    for (const tex of [42, null, undefined, { a: 1 }]) {
      await expect(renderMath(tex as unknown as string)).resolves.toEqual({ ok: false, message: "" });
    }
  });

  it("a syntax error does not throw: throwOnError:false gives ok with a katex-error element", async () => {
    const r = await renderMath("\\frac{");
    expect(r.ok).toBe(true);
    expect(r.ok && r.html).toContain("katex-error");
  });

  it("pins every option key", () => {
    expect(KATEX_OPTIONS).toEqual({ displayMode: true, throwOnError: false, trust: false, strict: "ignore", maxSize: 10, maxExpand: 1000, output: "htmlAndMathml" });
  });
});

describe("renderMath security", () => {
  it.each([
    ["\\href{javascript:alert(1)}{x}"],
    ["\\url{javascript:alert(1)}"],
    ["\\htmlClass{evil}{y}"],
    ["\\htmlStyle{color:red}{y}"],
    ["\\text{<img src=x onerror=alert(1)>}"],
  ])("%s produces no <a href, <img, event attributes, or injected class or style", async (tex) => {
    const r = await renderMath(tex);
    expect(r.ok).toBe(true);
    expect(dangerousNodes(r.ok ? r.html : "")).toEqual([]);
  });

  it("positive control: with trust:true, \\href produces an href (shows the detection above works)", async () => {
    const katex = (await import("katex")).default;
    const html = withoutAnnotation(katex.renderToString("\\href{https://e.invalid}{x}", { ...KATEX_OPTIONS, trust: true }));
    expect(dangerousNodes(html)).toContain("a[href]");
  });

  it("positive control: dangerousNodes catches real dangerous elements and attributes", () => {
    const hits = dangerousNodes('<span><img src="x" onerror="alert(1)"><a href="javascript:x">y</a><b class="evil" style="color:red">z</b><script>x</script><iframe src="y"></iframe></span>');
    expect(new Set(hits)).toEqual(new Set(["<img>", "img[src]", "img[onerror]", "<a>", "a[href]", "b.evil", "b[style*=red]", "<script>", "<iframe>", "iframe[src]"]));
  });

  it("\\rule{500em}{500em} is clamped to 10em by maxSize", async () => {
    const r = await renderMath("\\rule{500em}{500em}");
    const html = withoutAnnotation(r.ok ? r.html : "");
    expect(html).toContain("10em");
    expect(html).not.toContain("500em");
  });

  it("infinite macro recursion is stopped by maxExpand (asserts KaTeX's expansion-limit message, not just any syntax error)", async () => {
    const r = await renderMath("\\def\\a{\\a\\a}\\a");
    expect(r.ok && r.html).toContain("Too many expansions");
  });

  it("positive control: with trust:true, \\htmlClass produces .evil (real output)", async () => {
    const katex = (await import("katex")).default;
    expect(dangerousNodes(katex.renderToString("\\htmlClass{evil}{y}", { ...KATEX_OPTIONS, trust: true }))).toContain("span.evil");
  });

  it("positive control: with trust:true, \\htmlStyle produces style color:red (real output)", async () => {
    const katex = (await import("katex")).default;
    expect(dangerousNodes(katex.renderToString("\\htmlStyle{color:red}{y}", { ...KATEX_OPTIONS, trust: true }))).toContain("span[style*=red]");
  });
});
