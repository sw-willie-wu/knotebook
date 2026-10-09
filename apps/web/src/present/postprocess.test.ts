import { beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeSlideFragment } from "./sanitize";
import { mermaidJobsIn, postprocessSlide, runMermaidJob, type PostprocessContext, type WikilinkResolution } from "./postprocess";

const renderMermaid = vi.hoisted(() => vi.fn());
vi.mock("@/lib/mermaid", () => ({ renderMermaid }));

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
  const jobs = postprocessSlide(fragment, ctx);
  const host = document.createElement("div");
  host.append(fragment);
  return { host, jobs };
}

const WIKILINK = '<p>see <span data-inline-content-type="wikilink" data-target-note-id="n 1" data-snapshot-title="Old &lt;b&gt;title"><span>[[Old]]</span></span></p>';

describe("postprocessSlide（spec §5.3）", () => {
  beforeEach(() => renderMermaid.mockReset());

  it("所有 img/video/audio[src] 走 resolveMedia（公開變體映射到公開端點）", () => {
    const { host } = run('<img src="/api/uploads/a" alt=""><video src="/api/uploads/v"></video><audio src="/api/uploads/s"></audio>', publicCtx);
    expect(host.querySelector("img")!.getAttribute("src")).toBe("/api/public/notes/TOKEN/uploads/a");
    expect(host.querySelector("video")!.getAttribute("src")).toBe("/api/public/notes/TOKEN/uploads/v");
    expect(host.querySelector("audio")!.getAttribute("src")).toBe("/api/public/notes/TOKEN/uploads/s");
  });

  it("a[data-kn-media]（檔案連結）走 resolveMedia；文字連結的 /api/uploads/ 不映射", () => {
    const { host } = run('<a href="/api/uploads/f" data-kn-media="">f.pdf</a><a href="/api/uploads/g">text</a>', publicCtx);
    const [file, text] = Array.from(host.querySelectorAll("a"));
    expect(file.getAttribute("href")).toBe("/api/public/notes/TOKEN/uploads/f");
    expect(text.getAttribute("href")).toBe("/api/uploads/g");
  });

  it("文字連結：http(s)、mailto、相對留下；#… 拿掉 href（reveal 會攔截當跳頁，§2.11-15）；其他 scheme 拿掉", () => {
    const { host } = run('<a href="https://e/x">1</a><a href="mailto:a@b">2</a><a href="/n/a/b">3</a><a href="#/abc">4</a><a href="ftp://e">5</a>', member());
    expect(Array.from(host.querySelectorAll("a")).map((a) => a.getAttribute("href"))).toEqual(["https://e/x", "mailto:a@b", "/n/a/b", null, null]);
  });

  it("留下的 a 一律 target=_blank、rel=noopener noreferrer", () => {
    const { host } = run('<a href="https://e/x">1</a>', member());
    const a = host.querySelector("a")!;
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("video／audio 加 controls 與 preload=metadata；checkbox disabled；details open", () => {
    const { host } = run('<video src="https://e/v.mp4"></video><audio src="https://e/a.mp3"></audio><ul><li><input type="checkbox" checked><p>x</p></li></ul><details><summary>s</summary><p>c</p></details>', member());
    for (const media of host.querySelectorAll("video, audio")) {
      expect(media.hasAttribute("controls")).toBe(true);
      expect(media.getAttribute("preload")).toBe("metadata");
    }
    expect(host.querySelector("input")!.hasAttribute("disabled")).toBe(true);
    expect(host.querySelector("details")!.hasAttribute("open")).toBe(true);
  });

  it("table 外包 div.kn-present-table[data-prevent-swipe]（§6.8 ①）", () => {
    const { host } = run("<table><tbody><tr><td>c</td></tr></tbody></table>", member());
    const wrap = host.querySelector("table")!.parentElement!;
    expect(wrap.className).toBe("kn-present-table");
    expect(wrap.hasAttribute("data-prevent-swipe")).toBe(true);
  });

  it("wikilink（已登入）未就緒：<a href=/notes/<encodeURIComponent(id)>>＋snapshotTitle（文字）、新分頁、不顯示 [[ ]]", () => {
    const { host } = run(WIKILINK, member(() => ({ kind: "pending" })));
    const a = host.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("/notes/n%201");
    expect(a.textContent).toBe("Old <b>title");
    expect(a.querySelector("b")).toBeNull();
    expect(a.getAttribute("target")).toBe("_blank");
    expect(host.textContent).not.toContain("[[");
  });

  it("wikilink（已登入）命中：canonical href＋現行標題", () => {
    const { host } = run(WIKILINK, member(() => ({ kind: "found", href: "/n/tester/new", title: "New title" })));
    const a = host.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("/n/tester/new");
    expect(a.textContent).toBe("New title");
  });

  it("wikilink（已登入）清單有但沒這篇：斷鏈樣式純文字（不是連結）", () => {
    const { host } = run(WIKILINK, member(() => ({ kind: "broken" })));
    expect(host.querySelector("a")).toBeNull();
    const span = host.querySelector(".kn-present-wikilink-broken")!;
    expect(span.textContent).toBe("Old <b>title");
    expect(span.getAttribute("title")).toBe("This linked note no longer exists.");
  });

  it("wikilink（公開）：純文字 snapshotTitle，沒有任何元素包它", () => {
    const { host } = run(WIKILINK, publicCtx);
    expect(host.querySelector("a, span")).toBeNull();
    expect(host.textContent).toBe("see Old <b>title");
  });

  it("mermaid：標記元素清空、收成 job（code 原文）；空白 code 的直接移除", () => {
    const { host, jobs } = run('<div data-kn-mermaid="">graph TD; A--&gt;B</div><div data-kn-mermaid="">   </div>', member());
    expect(jobs).toHaveLength(1);
    expect(jobs[0].code).toBe("graph TD; A-->B");
    expect(jobs[0].el.textContent).toBe("");
    expect(host.querySelectorAll("[data-kn-mermaid]")).toHaveLength(1);
    expect(mermaidJobsIn(host)).toEqual(jobs);
  });
});

describe("runMermaidJob", () => {
  beforeEach(() => renderMermaid.mockReset());

  it("成功 → innerHTML 放 SVG；回 true", async () => {
    renderMermaid.mockResolvedValue({ ok: true, svg: '<svg data-x="1"></svg>' });
    const el = document.createElement("div");
    expect(await runMermaidJob({ el, code: "graph TD" }, "dark", () => true, "err")).toBe(true);
    expect(renderMermaid).toHaveBeenCalledWith("graph TD", "dark");
    expect(el.querySelector("svg[data-x]")).not.toBeNull();
  });

  it("錯誤 → 提示＋原始碼 <pre>（textContent，不是 HTML）", async () => {
    renderMermaid.mockResolvedValue({ ok: false, message: "Parse error" });
    const el = document.createElement("div");
    await runMermaidJob({ el, code: "<img src=x onerror=alert(1)>" }, "light", () => true, "Diagram error");
    expect(el.querySelector(".kn-present-mermaid-error")!.textContent).toBe("Diagram error");
    expect(el.querySelector("pre")!.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(el.querySelector("img")).toBeNull();
  });

  it("空（message 為空字串）→ 移除元素", async () => {
    renderMermaid.mockResolvedValue({ ok: false, message: "" });
    const parent = document.createElement("div");
    const el = document.createElement("div");
    parent.append(el);
    await runMermaidJob({ el, code: "x" }, "light", () => true, "err");
    expect(parent.childElementCount).toBe(0);
  });

  it("世代過期（isCurrent 回 false）→ 結果丟掉、回 false", async () => {
    renderMermaid.mockResolvedValue({ ok: true, svg: "<svg></svg>" });
    const el = document.createElement("div");
    expect(await runMermaidJob({ el, code: "graph TD" }, "light", () => false, "err")).toBe(false);
    expect(el.innerHTML).toBe("");
  });
});
