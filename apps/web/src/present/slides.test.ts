import { describe, expect, it } from "vitest";
import { COVER_ID, noteToSlides, type Section, type SlideBlock } from "./slides";

// 測資：只有 noteToSlides 會讀的欄位（type、props.level、content、children）。
const p = (id: string, text = "t", children: SlideBlock[] = []): SlideBlock => ({
  id, type: "paragraph", props: {}, content: text === "" ? [] : [{ type: "text", text, styles: {} }], children,
});
const blank = (id: string): SlideBlock => ({ id, type: "paragraph", props: {}, content: [{ type: "text", text: "  ", styles: {} }], children: [] });
const h = (id: string, level: number, children: SlideBlock[] = [], extra: Record<string, unknown> = {}): SlideBlock => ({
  id, type: "heading", props: { level, ...extra }, content: [{ type: "text", text: id, styles: {} }], children,
});
const d = (id: string): SlideBlock => ({ id, type: "divider", props: {}, children: [] });

/** `章:[張(該張除標題外的 block id…), …]`，章與章以兩個空白分隔——與 spec §4.3 表同形（封面章一律列出，Q4）。 */
function show(sections: Section[]): string {
  return sections
    .map((s) => `${s.id}:[${s.slides
      .map((slide) => {
        const rest = slide.blocks.filter((b) => b.id !== slide.id).map((b) => b.id);
        return rest.length > 0 ? `${slide.id}(${rest.join(",")})` : slide.id;
      })
      .join(", ")}]`)
    .join("  ");
}

describe("noteToSlides：spec §4.3 表（封面章一律保留，§4.2-5／-7）", () => {
  it.each<[string, SlideBlock[], string]>([
    ["段落 a；H2 x；段落 b；H3 y；H4 z；段落 c", [p("a"), h("x", 2), p("b"), h("y", 3), h("z", 4), p("c")], "_title:[_title(a)]  x:[x(b), y(z,c)]"],
    ["H1 x；H2 y；H3 z", [h("x", 1), h("y", 2), h("z", 3)], "_title:[_title]  x:[x, y(z)]"],
    ["H3 x；H3 y", [h("x", 3), h("y", 3)], "_title:[_title]  x:[x]  y:[y]"],
    ["H2 s；H1 x（章標題前的次層標題掛封面章）", [h("s", 2), h("x", 1)], "_title:[_title, s]  x:[x]"],
    ["H1 x；divider d；段落 a；divider e；空段落（e 整章空，略過）", [h("x", 1), d("d"), p("a"), d("e"), blank("b0")], "_title:[_title]  x:[x]  d:[d(a)]"],
    ["H2 a；divider d；H3 y；段落 b（d 空、略過，章 ID 變 y）", [h("a", 2), d("d"), h("y", 3), p("b")], "_title:[_title]  a:[a]  y:[y(b)]"],
    ["H1 x；H3 z（無 H2，F3：次一層＝第二高）", [h("x", 1), h("z", 3)], "_title:[_title]  x:[x, z]"],
    ["toggle H1 x（含子 block）", [h("x", 1, [p("c1"), p("c2")], { isToggleable: true })], "_title:[_title]  x:[x]"],
    ["無標題、無 divider", [p("a"), p("b")], "_title:[_title(a,b)]"],
  ])("%s", (_name, blocks, expected) => {
    expect(show(noteToSlides("T", blocks))).toBe(expected);
  });

  it("toggle 標題的子 block 跟父 block 走（只看頂層，§4.2-1）：子 block 在 blocks[0].children、不在該張的 blocks 裡", () => {
    const sections = noteToSlides("T", [h("x", 1, [p("c1")], { isToggleable: true })]);
    const slide = sections[1].slides[0];
    expect(slide.blocks.map((b) => b.id)).toEqual(["x"]);
    expect((slide.blocks[0].children ?? []).length).toBe(1);
  });

  it("一般段落有子 block：整個留在同一張，子 block 不另開張", () => {
    expect(show(noteToSlides("T", [h("x", 2), p("a", "t", [h("nested", 2)])]))).toBe("_title:[_title]  x:[x(a)]");
  });

  it("只有 divider：每個 divider 都整章空 → 只剩封面", () => {
    expect(show(noteToSlides("T", [d("d1"), d("d2")]))).toBe("_title:[_title]");
  });

  it("連續 divider 之間有內容：只有帶內容的那章留下", () => {
    expect(show(noteToSlides("T", [d("d1"), d("d2"), p("a")]))).toBe("_title:[_title]  d2:[d2(a)]");
  });

  it("只有空段落：封面帶著它們（封面永不略過）", () => {
    expect(show(noteToSlides("T", [blank("b1"), p("b2", "")]))).toBe("_title:[_title(b1,b2)]");
  });

  it("空標題字串不影響切頁（標題由渲染層補，§4.2-3）", () => {
    expect(show(noteToSlides("", [h("x", 2)]))).toBe("_title:[_title]  x:[x]");
  });

  it("heading 頁永不空：只有標題、內文全空也保留", () => {
    expect(show(noteToSlides("T", [h("x", 2), blank("b")]))).toBe("_title:[_title]  x:[x(b)]");
  });

  it("封面 ID 恆為 _title、kind cover；divider 張 kind divider 且 divider 本身不在 blocks", () => {
    const sections = noteToSlides("T", [d("d"), p("a")]);
    expect(sections[0].slides[0]).toMatchObject({ id: COVER_ID, kind: "cover" });
    expect(sections[1].slides[0]).toMatchObject({ id: "d", kind: "divider" });
    expect(sections[1].slides[0].blocks.map((b) => b.id)).toEqual(["a"]);
  });

  it("含 link／wikilink 的段落不算空白（inline content 不只文字）", () => {
    const withLink: SlideBlock = { id: "l", type: "paragraph", props: {}, content: [{ type: "link", href: "https://x", content: [] }], children: [] };
    expect(show(noteToSlides("T", [d("d"), withLink]))).toBe("_title:[_title]  d:[d(l)]");
  });
});
