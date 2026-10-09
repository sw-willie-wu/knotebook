import { beforeEach, describe, expect, it } from "vitest";
import { blocksToYDoc } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { createExportEditor, renderDeck, type RenderedSection } from "./render";
import type { PostprocessContext, WikilinkResolution } from "./postprocess";

const memberCtx = (resolve: (id: string) => WikilinkResolution = () => ({ kind: "pending" })): PostprocessContext => ({
  resolveMedia: (url) => (/^(https?:|\/|$)/.test(url) ? url : "about:blank"),
  wikilinks: { kind: "member", resolve, brokenLabel: "This linked note no longer exists." },
});
const publicCtx: PostprocessContext = {
  resolveMedia: (url) => {
    const m = /^\/api\/uploads\/([^/?#]+)$/.exec(url);
    return m ? `/api/public/notes/TOKEN/uploads/${m[1]}` : url;
  },
  wikilinks: { kind: "public" },
};

let editor: ReturnType<typeof createExportEditor>;
beforeEach(() => {
  editor = createExportEditor();
});

function deck(blocks: unknown[], title = "T", ctx: PostprocessContext = memberCtx(), previousKeys?: Map<string, string>): RenderedSection[] {
  const doc = blocksToYDoc(editor, blocks as never, YDOC_FRAGMENT);
  return renderDeck({ editor, doc, title, titlePlaceholder: "Untitled", ctx, previousKeys });
}

function slideHost(sections: RenderedSection[], h: number, v = 0): HTMLDivElement {
  const host = document.createElement("div");
  host.append(sections[h].slides[v].content!.fragment);
  return host;
}

describe("renderDeck：XSS 不變式（spec §13.1 渲染管線）", () => {
  it("wikilink snapshotTitle 是 <img src=x onerror=…> → 只是文字", () => {
    const sections = deck([{ type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: "n1", snapshotTitle: "<img src=x onerror=alert(1)>" } }] }]);
    const host = slideHost(sections, 0);
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("mermaid code 含 </code><script> → job 的 code 是原文、DOM 沒有 script", () => {
    const code = "graph TD\n</code><script>alert(1)</script>";
    const sections = deck([{ type: "mermaid", props: { code } }]);
    const host = slideHost(sections, 0);
    expect(host.querySelector("script")).toBeNull();
    expect(sections[0].slides[0].content!.mermaid.map((j) => j.code)).toEqual([code]);
  });

  it("caption／檔名含 HTML → 文字", () => {
    const sections = deck([
      { type: "image", props: { url: "https://e/i.png", caption: "<b>cap</b>" } },
      { type: "file", props: { url: "https://e/f.pdf", name: "<i>f</i>.pdf" } },
    ]);
    const host = slideHost(sections, 0);
    expect(host.querySelector("b, i")).toBeNull();
    expect(host.textContent).toContain("<b>cap</b>");
    expect(host.textContent).toContain("<i>f</i>.pdf");
  });

  it("codeBlock(language=mermaid) 不成圖：是 pre>code、沒有 mermaid job", () => {
    const sections = deck([{ type: "codeBlock", props: { language: "mermaid" }, content: "graph TD" }]);
    const host = slideHost(sections, 0);
    expect(host.querySelector("pre > code")!.textContent).toBe("graph TD");
    expect(sections[0].slides[0].content!.mermaid).toEqual([]);
  });

  it("javascript: 媒體 → img 還在、沒有 src 或 src 為 about:blank、絕不是 javascript:（Q6：§5.4-3 的 regexp 不收 about:blank，消毒器刪掉 src）", () => {
    const sections = deck([{ type: "image", props: { url: "javascript:alert(1)" } }]);
    const img = slideHost(sections, 0).querySelector("img");
    expect(img).not.toBeNull();
    const src = img!.getAttribute("src");
    expect(src === null || src === "about:blank").toBe(true);
    expect(src ?? "").not.toMatch(/^javascript:/i);
  });

  it("消毒層確實接在管線上：BlockNote 匯出的 class／style／data-language／data-node-view-wrapper 都被刪（r1-p1 M-2b）", () => {
    const sections = deck(
      [
        { type: "codeBlock", props: { language: "ts" }, content: "x" },
        { type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: "n1", snapshotTitle: "S" } }] },
      ],
      "T",
      publicCtx,
    );
    const host = slideHost(sections, 0);
    expect(host.querySelector("pre > code")).not.toBeNull();
    expect(host.querySelector("[class]:not(h1), [style], [data-language], [data-node-view-wrapper]")).toBeNull();
  });
});

describe("renderDeck：頁別處理", () => {
  it("公開變體：file block 連到 /api/uploads/<id> 映射到公開端點；同頁 mailto: 文字連結保留", () => {
    const sections = deck(
      [
        { type: "file", props: { url: "/api/uploads/abc", name: "a.pdf" } },
        { type: "paragraph", content: [{ type: "link", href: "mailto:a@example.com", content: "mail me" }] },
      ],
      "T",
      publicCtx,
    );
    const links = Array.from(slideHost(sections, 0).querySelectorAll("a"));
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/api/public/notes/TOKEN/uploads/abc", "mailto:a@example.com"]);
    expect(links[0].hasAttribute("data-kn-media")).toBe(true);
    expect(links[1].hasAttribute("data-kn-media")).toBe(false);
  });

  it("video／audio 有 controls；checkbox disabled；表格包裝層帶 data-prevent-swipe", () => {
    const sections = deck([
      { type: "video", props: { url: "https://e/v.mp4" } },
      { type: "audio", props: { url: "https://e/a.mp3" } },
      { type: "checkListItem", props: { checked: true }, content: "done" },
      { type: "table", content: { type: "tableContent", rows: [{ cells: ["a", "b"] }] } },
    ]);
    const host = slideHost(sections, 0);
    expect(host.querySelector("video")!.hasAttribute("controls")).toBe(true);
    expect(host.querySelector("audio")!.hasAttribute("controls")).toBe(true);
    expect(host.querySelector('input[type="checkbox"]')!.hasAttribute("disabled")).toBe(true);
    expect(host.querySelector(".kn-present-table")!.hasAttribute("data-prevent-swipe")).toBe(true);
  });

  it("已登入 wikilink 三態（未就緒 href 以 encodeURIComponent 組）", () => {
    const blocks = [{ type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: "a b", snapshotTitle: "Snap" } }] }];
    expect(slideHost(deck(blocks, "T", memberCtx(() => ({ kind: "pending" }))), 0).querySelector("a")!.getAttribute("href")).toBe("/notes/a%20b");
    const found = slideHost(deck(blocks, "T", memberCtx(() => ({ kind: "found", href: "/n/u/x", title: "Now" }))), 0).querySelector("a")!;
    expect([found.getAttribute("href"), found.textContent]).toEqual(["/n/u/x", "Now"]);
    expect(slideHost(deck(blocks, "T", memberCtx(() => ({ kind: "broken" }))), 0).querySelector(".kn-present-wikilink-broken")!.textContent).toBe("Snap");
  });
});

describe("renderDeck：封面、比對鍵", () => {
  it("RF3：標題含標記 → 封面 <h1> 只有文字", () => {
    const host = slideHost(deck([], "<img src=x onerror=alert(1)>"), 0);
    expect(host.querySelector("h1")!.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(host.querySelector("img")).toBeNull();
  });

  it.each(["", "   "])("RF3：空／空白標題 %j → note.titlePlaceholder＋kn-present-untitled", (title) => {
    const h1 = slideHost(deck([], title), 0).querySelector("h1")!;
    expect(h1.textContent).toBe("Untitled");
    expect(h1.className).toBe("kn-present-untitled");
  });

  it("previousKeys 與本次相同的張 content 為 null（沿用 DOM）；改了的張重建", () => {
    const blocks = [{ id: "h2a", type: "heading", props: { level: 2 }, content: "A" }, { id: "p1", type: "paragraph", content: "one" }];
    const first = deck(blocks);
    const keys = new Map(first.flatMap((s) => s.slides.map((sl) => [sl.id, sl.key] as const)));
    const again = deck(blocks, "T", memberCtx(), keys);
    expect(again.flatMap((s) => s.slides.map((sl) => sl.content))).toEqual([null, null]);
    const changed = deck([blocks[0], { id: "p1", type: "paragraph", content: "two" }], "T", memberCtx(), keys);
    expect(changed[1].slides[0].content).not.toBeNull();
    expect(changed[0].slides[0].content).toBeNull();
  });

  it("標題改了只重建封面", () => {
    const blocks = [{ id: "h2a", type: "heading", props: { level: 2 }, content: "A" }];
    const first = deck(blocks, "Old");
    const keys = new Map(first.flatMap((s) => s.slides.map((sl) => [sl.id, sl.key] as const)));
    const next = deck(blocks, "New", memberCtx(), keys);
    expect(next[0].slides[0].content).not.toBeNull();
    expect(next[1].slides[0].content).toBeNull();
  });

  it("titleOnly：只有標題的 heading 張為 true；有內文為 false；空封面為 true", () => {
    const sections = deck([
      { id: "h1", type: "heading", props: { level: 2 }, content: "A" },
      { id: "h2", type: "heading", props: { level: 2 }, content: "B" },
      { id: "p", type: "paragraph", content: "x" },
    ]);
    expect(sections.map((s) => s.slides[0].titleOnly)).toEqual([true, true, false]);
  });
});
