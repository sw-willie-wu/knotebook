import { afterEach, describe, expect, it, vi } from "vitest";
import { attrValue, knowledgeIconPlace } from "./placement";

const BLOCK = (id: string, inline: string) =>
  `<div class="bn-block-outer" data-id="${id}"><div class="bn-block"><div class="bn-block-content" data-content-type="heading">${inline}</div></div></div>`;

function setup(inlineHtml = '<h2 class="bn-inline-content">Title</h2>') {
  const column = document.createElement("div");
  column.innerHTML = BLOCK("h1", inlineHtml);
  document.body.append(column);
  return { column, outer: column.querySelector<HTMLElement>(".bn-block-outer")! };
}

/** jsdom lays nothing out: every rect is stubbed by selector, and Range rects are stubbed globally. */
function stub(rects: Array<[string, DOMRect]>, lines: DOMRect[]) {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return rects.find(([selector]) => this.matches(selector))?.[1] ?? new DOMRect(0, 0, 0, 0);
  });
  vi.spyOn(Range.prototype, "getClientRects").mockImplementation(() => lines as unknown as DOMRectList);
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

describe("knowledgeIconPlace", () => {
  it("the icon sits 8px after the end of the heading's last line, centred on that line", () => {
    const { column, outer } = setup();
    stub(
      [
        ["div:not([class])", new DOMRect(100, 50, 800, 1000)],
        [".bn-inline-content", new DOMRect(100, 80, 700, 60)],
      ],
      [new DOMRect(100, 80, 700, 30), new DOMRect(100, 110, 240, 30)],
    );
    expect(knowledgeIconPlace(outer, column)).toEqual({ left: 248, top: 67 });
  });

  it("the icon never passes the column's right edge", () => {
    const { column, outer } = setup();
    stub(
      [
        ["div:not([class])", new DOMRect(100, 50, 800, 1000)],
        [".bn-inline-content", new DOMRect(100, 80, 800, 30)],
      ],
      [new DOMRect(100, 80, 796, 30)],
    );
    expect(knowledgeIconPlace(outer, column)?.left).toBe(800 - 16);
  });

  it("a heading with empty text puts the icon at the start of its line", () => {
    const { column, outer } = setup('<h2 class="bn-inline-content"></h2>');
    stub(
      [
        ["div:not([class])", new DOMRect(100, 50, 800, 1000)],
        [".bn-inline-content", new DOMRect(100, 80, 600, 30)],
      ],
      [],
    );
    expect(knowledgeIconPlace(outer, column)).toEqual({ left: 0, top: 37 });
  });

  it("a toggleable heading's text inside .bn-toggle-wrapper is found", () => {
    const { column, outer } = setup('<div class="bn-toggle-wrapper"><button class="bn-toggle-button"></button><h2 class="bn-inline-content">Title</h2></div>');
    stub(
      [
        ["div:not([class])", new DOMRect(100, 50, 800, 1000)],
        [".bn-inline-content", new DOMRect(130, 80, 600, 30)],
      ],
      [new DOMRect(130, 80, 120, 30)],
    );
    expect(knowledgeIconPlace(outer, column)).toEqual({ left: 158, top: 37 });
  });

  it("an inline element with no size has no place", () => {
    const { column, outer } = setup();
    stub([["div:not([class])", new DOMRect(100, 50, 800, 1000)]], []);
    expect(knowledgeIconPlace(outer, column)).toBeNull();
  });
});

describe("attrValue", () => {
  it("produces a selector that matches ids containing quotes, backslashes and newlines", () => {
    const id = 'a"b\\c\nd';
    const el = document.createElement("div");
    el.dataset.id = id;
    document.body.append(el);
    expect(document.querySelector(`[data-id="${attrValue(id)}"]`)).toBe(el);
    el.remove();
  });
});
