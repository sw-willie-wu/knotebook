import { describe, expect, it } from "vitest";
import { sanitizeSlideFragment } from "./sanitize";
import { postprocessSlide, runMathJob, type PostprocessContext } from "./postprocess";
import { resetKatexForTests } from "@/lib/katex";

/** Real KaTeX (no mock): the safety claim is about what ends up in the slide DOM after sanitize -> postprocess -> runMathJob. */
const ctx: PostprocessContext = { resolveMedia: (u) => u, wikilinks: { kind: "public" } };

async function render(tex: string): Promise<HTMLElement> {
  resetKatexForTests();
  const holder = document.createElement("div");
  const marker = document.createElement("div");
  marker.setAttribute("data-kn-math", "");
  marker.textContent = tex;
  holder.append(marker);
  const fragment = sanitizeSlideFragment(holder.innerHTML);
  const { math } = postprocessSlide(fragment, ctx);
  const host = document.createElement("div");
  host.append(fragment);
  expect(math).toHaveLength(1);
  await runMathJob(math[0], () => true, "err");
  return host;
}

describe("presentation math with real KaTeX", () => {
  it("renders a formula into .katex markup", async () => {
    const host = await render("E = mc^2");
    expect(host.querySelector(".katex")).not.toBeNull();
  });

  it("\\href{javascript:...} produces no anchor or href in the slide DOM", async () => {
    const host = await render("\\href{javascript:alert(1)}{x}");
    expect(host.querySelector("a")).toBeNull();
    expect(host.querySelector("[href]")).toBeNull();
  });

  it("html-looking tex never becomes elements or event attributes", async () => {
    const host = await render("\\text{<img src=x onerror=alert(1)><script>alert(2)</script>}");
    host.querySelectorAll("annotation").forEach((n) => n.remove());
    expect(host.querySelector("img, script, iframe")).toBeNull();
    for (const el of host.querySelectorAll("*")) {
      for (const attr of Array.from(el.attributes)) expect(attr.name).not.toMatch(/^on/i);
    }
  });

  it("an \\htmlClass / \\htmlStyle request is ignored (trust:false)", async () => {
    const host = await render("\\htmlClass{evil}{x}\\htmlStyle{color:red}{y}");
    expect(host.querySelector(".evil")).toBeNull();
    expect(host.querySelector('[style*="color:red"], [style*="color: red"]')).toBeNull();
  });
});
