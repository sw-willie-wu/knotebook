import { beforeEach, describe, expect, it } from "vitest";
import { blocksToYDoc } from "@blocknote/core/yjs";
import { YDOC_FRAGMENT } from "@knotebook/shared";
import { P, row } from "@/test/columns-fixtures";
import { safeMediaUrl } from "@/lib/media-url";
import { publicMediaUrl } from "@/lib/public-media-url";
import { resetCodeHighlightForTests } from "./code-highlight";
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
  resetCodeHighlightForTests();
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

describe("renderDeck: XSS invariants (render pipeline)", () => {
  it("wikilink snapshotTitle of <img src=x onerror=...> -> only text", () => {
    const sections = deck([{ type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: "n1", snapshotTitle: "<img src=x onerror=alert(1)>" } }] }]);
    const host = slideHost(sections, 0);
    expect(host.querySelector("img")).toBeNull();
    expect(host.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("mermaid code containing </code><script> -> the job's code is the original, the DOM has no script", () => {
    const code = "graph TD\n</code><script>alert(1)</script>";
    const sections = deck([{ type: "mermaid", props: { code } }]);
    const host = slideHost(sections, 0);
    expect(host.querySelector("script")).toBeNull();
    expect(sections[0].slides[0].content!.mermaid.map((j) => j.code)).toEqual([code]);
  });

  it("caption / file name containing HTML -> text", () => {
    const sections = deck([
      { type: "image", props: { url: "https://e/i.png", caption: "<b>cap</b>" } },
      { type: "file", props: { url: "https://e/f.pdf", name: "<i>f</i>.pdf" } },
    ]);
    const host = slideHost(sections, 0);
    expect(host.querySelector("b, i")).toBeNull();
    expect(host.textContent).toContain("<b>cap</b>");
    expect(host.textContent).toContain("<i>f</i>.pdf");
  });

  it("codeBlock(language=mermaid) isn't drawn as a diagram: it's pre>code with no mermaid or code highlight job", () => {
    const sections = deck([{ type: "codeBlock", props: { language: "mermaid" }, content: "graph TD" }]);
    const host = slideHost(sections, 0);
    expect(host.querySelector("pre > code")!.textContent).toBe("graph TD");
    expect(sections[0].slides[0].content!.mermaid).toEqual([]);
    expect(sections[0].slides[0].content!.code).toEqual([]);
  });

  it("codeBlock(language=ts) collects a canonical typescript highlight job while language=text collects none", () => {
    const sections = deck([
      { type: "codeBlock", props: { language: "ts" }, content: "const x = 1;" },
      { type: "codeBlock", props: { language: "text" }, content: "plain text" },
    ]);
    const content = sections[0].slides[0].content!;
    expect(content.code).toHaveLength(1);
    expect(content.code[0]).toMatchObject({ lang: "typescript", code: "const x = 1;" });
  });

  it("javascript: media -> img remains with no src or src about:blank, never javascript: (the regexp doesn't accept about:blank, the sanitizer drops src)", () => {
    const sections = deck([{ type: "image", props: { url: "javascript:alert(1)" } }]);
    const img = slideHost(sections, 0).querySelector("img");
    expect(img).not.toBeNull();
    const src = img!.getAttribute("src");
    expect(src === null || src === "about:blank").toBe(true);
    expect(src ?? "").not.toMatch(/^javascript:/i);
  });

  it("the sanitizer is really in the pipeline: BlockNote export's class / style / data-language / data-node-view-wrapper are all removed", () => {
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

describe("renderDeck: member vs public pages", () => {
  it("public variant: a file block link to /api/uploads/<id> maps to the public endpoint; a mailto: text link on the same page is kept", () => {
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

  it("uploaded SVG image block renders as <img> (never inline <svg>) in both member and public slides (#389)", () => {
    const memberHost = slideHost(deck([{ type: "image", props: { url: "/api/uploads/svg-1", name: "anim.svg" } }], "T", memberCtx()), 0);
    expect(memberHost.querySelector("img")!.getAttribute("src")).toBe("/api/uploads/svg-1");
    expect(memberHost.querySelector("svg")).toBeNull();

    const publicHost = slideHost(deck([{ type: "image", props: { url: "/api/uploads/svg-1", name: "anim.svg" } }], "T", publicCtx), 0);
    expect(publicHost.querySelector("img")!.getAttribute("src")).toBe("/api/public/notes/TOKEN/uploads/svg-1");
    expect(publicHost.querySelector("svg")).toBeNull();
  });

  it("video / audio have controls; checkbox disabled; table wrapper carries data-prevent-swipe", () => {
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

  it.each([
    ["member", { ...memberCtx(), resolveMedia: (url: string) => safeMediaUrl(url) }, "/api/uploads"],
    ["public", { resolveMedia: publicMediaUrl({ kind: "token", token: "TOKEN" }), wikilinks: { kind: "public" } } as PostprocessContext, "/api/public/notes/TOKEN/uploads"],
  ])("%s presentation: uploaded audio and video play with controls, a file block is a working link (new tab, no download attribute)", (_label, ctx, base) => {
    const host = slideHost(
      deck(
        [
          { type: "audio", props: { url: "/api/uploads/a1", name: "talk.m4a" } },
          { type: "video", props: { url: "/api/uploads/v1", name: "clip.mp4" } },
          { type: "file", props: { url: "/api/uploads/f1", name: "quote.pdf" } },
        ],
        "T",
        ctx,
      ),
      0,
    );
    expect(host.querySelector("audio")!.getAttribute("src")).toBe(`${base}/a1`);
    expect(host.querySelector("audio")!.hasAttribute("controls")).toBe(true);
    expect(host.querySelector("video")!.getAttribute("src")).toBe(`${base}/v1`);
    expect(host.querySelector("video")!.hasAttribute("controls")).toBe(true);
    const link = host.querySelector("a")!;
    expect(link.getAttribute("href")).toBe(`${base}/f1`);
    expect(link.textContent).toBe("quote.pdf");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.hasAttribute("download")).toBe(false);
    expect(host.innerHTML).not.toContain("blob:");
  });

  it("signed-in wikilink three states (the not-ready href is built with encodeURIComponent)", () => {
    const blocks = [{ type: "paragraph", content: [{ type: "wikilink", props: { targetNoteId: "a b", snapshotTitle: "Snap" } }] }];
    expect(slideHost(deck(blocks, "T", memberCtx(() => ({ kind: "pending" }))), 0).querySelector("a")!.getAttribute("href")).toBe("/notes/a%20b");
    const found = slideHost(deck(blocks, "T", memberCtx(() => ({ kind: "found", href: "/n/u/x", title: "Now" }))), 0).querySelector("a")!;
    expect([found.getAttribute("href"), found.textContent]).toEqual(["/n/u/x", "Now"]);
    expect(slideHost(deck(blocks, "T", memberCtx(() => ({ kind: "broken" }))), 0).querySelector(".kn-present-wikilink-broken")!.textContent).toBe("Snap");
  });
});

describe("renderDeck: cover and comparison keys", () => {
  it("title containing markup -> cover <h1> is text only", () => {
    const host = slideHost(deck([], "<img src=x onerror=alert(1)>"), 0);
    expect(host.querySelector("h1")!.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(host.querySelector("img")).toBeNull();
  });

  it.each(["", "   "])("empty / blank title %j -> note.titlePlaceholder plus kn-present-untitled", (title) => {
    const h1 = slideHost(deck([], title), 0).querySelector("h1")!;
    expect(h1.textContent).toBe("Untitled");
    expect(h1.className).toBe("kn-present-untitled");
  });

  it("slides whose previousKeys match this run have content null (reuse the DOM); changed slides are rebuilt", () => {
    const blocks = [{ id: "h2a", type: "heading", props: { level: 2 }, content: "A" }, { id: "p1", type: "paragraph", content: "one" }];
    const first = deck(blocks);
    const keys = new Map(first.flatMap((s) => s.slides.map((sl) => [sl.id, sl.key] as const)));
    const again = deck(blocks, "T", memberCtx(), keys);
    expect(again.flatMap((s) => s.slides.map((sl) => sl.content))).toEqual([null, null]);
    const changed = deck([blocks[0], { id: "p1", type: "paragraph", content: "two" }], "T", memberCtx(), keys);
    expect(changed[1].slides[0].content).not.toBeNull();
    expect(changed[0].slides[0].content).toBeNull();
  });

  it("title changed -> only the cover is rebuilt", () => {
    const blocks = [{ id: "h2a", type: "heading", props: { level: 2 }, content: "A" }];
    const first = deck(blocks, "Old");
    const keys = new Map(first.flatMap((s) => s.slides.map((sl) => [sl.id, sl.key] as const)));
    const next = deck(blocks, "New", memberCtx(), keys);
    expect(next[0].slides[0].content).not.toBeNull();
    expect(next[1].slides[0].content).toBeNull();
  });

  it("titleOnly: a heading slide with only a title is true; with body text false; an empty cover is true", () => {
    const sections = deck([
      { id: "h1", type: "heading", props: { level: 2 }, content: "A" },
      { id: "h2", type: "heading", props: { level: 2 }, content: "B" },
      { id: "p", type: "paragraph", content: "x" },
    ]);
    expect(sections.map((s) => s.slides[0].titleOnly)).toEqual([true, true, false]);
  });
});

describe("renderDeck: columns", () => {
  it("Y.Doc with a row -> the slide has [data-kb-columns], row and column canonical-form styles kept, no data-nesting-level", () => {
    const host = slideHost(deck([row([[P("L", "l")], [P("R", "r")]], "row", [1.5, 1])]), 0);
    const list = host.querySelector("[data-kb-columns]");
    expect(list).not.toBeNull();
    expect(list!.getAttribute("style")).toBe("display:flex;gap:16px");
    const cols = Array.from(list!.querySelectorAll(":scope > [data-kb-column]"));
    expect(cols.map((col) => [col.getAttribute("style"), col.textContent])).toEqual([["flex:1.5", "L"], ["flex:1", "R"]]);
    expect(host.querySelector("[data-nesting-level]")).toBeNull();
  });
});
