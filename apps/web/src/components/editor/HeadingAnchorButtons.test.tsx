import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { HeadingAnchorButtons } from "./HeadingAnchorButtons";

// spec 2026-10-13 site-links §10.3(b)。DOM 照 BlockNote 的結構手造：.bn-block-outer[data-id] > .bn-block > .bn-block-content[data-content-type] > .bn-inline-content。
const BLOCKS = `
  <div class="bn-block-outer" data-id="h1"><div class="bn-block"><div class="bn-block-content" data-content-type="heading"><h2 class="bn-inline-content">Title</h2></div></div></div>
  <div class="bn-block-outer" data-id="p1"><div class="bn-block"><div class="bn-block-content" data-content-type="paragraph"><p class="bn-inline-content">Body</p></div></div></div>
  <div class="bn-block-outer" data-id="li"><div class="bn-block"><div class="bn-block-content" data-content-type="bulletListItem"><p class="bn-inline-content">item</p></div>
    <div class="bn-block-group"><div class="bn-block-outer" data-id="h3"><div class="bn-block"><div class="bn-block-content" data-content-type="heading"><h3 class="bn-inline-content">Nested</h3></div></div></div></div></div></div>`;

/** jsdom 的 rect 全是 0：依 selector 墊幾何（其餘元素照舊回 0）。 */
function stubRects(rects: Array<[string, DOMRect]>) {
  return vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    return rects.find(([selector]) => this.matches(selector))?.[1] ?? new DOMRect(0, 0, 0, 0);
  });
}

function Host() {
  const [el, setEl] = useState<HTMLElement | null>(null);
  return (
    <div ref={setEl} className="relative" data-testid="col">
      <div dangerouslySetInnerHTML={{ __html: BLOCKS }} />
      <HeadingAnchorButtons container={el} linkBase={() => "https://kb.example.com/n/h/s"} />
      <Toaster />
    </div>
  );
}

describe("#269 標題「#」鈕", () => {
  const writeText = vi.fn(() => Promise.resolve());
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    writeText.mockClear();
  });
  let spies: Array<{ mockRestore: () => void }> = [];
  afterEach(() => {
    dismissAllToasts();
    for (const spy of spies) spy.mockRestore();
    spies = [];
  });

  it("「#」在標題文字右側 4px、在文字首行垂直置中（不在區塊左緣：可編輯時那裡被側邊選單蓋住）；不超出欄位右緣；版面變動（resize）時重算", () => {
    // 欄 (100,50) 寬 800；鈕 17×20；標題 inline box 兩行高 72，首行（Range 第一個 client rect）高 30。
    const text: [string, DOMRect] = ['[data-id="h1"] .bn-inline-content', new DOMRect(100, 78, 200, 72)];
    let firstLine = new DOMRect(100, 80, 150, 30);
    spies.push(
      stubRects([
        ['[data-testid="col"]', new DOMRect(100, 50, 800, 1000)],
        ['.bn-block-outer[data-id="h1"]', new DOMRect(100, 60, 700, 90)],
        ['button[aria-label="Copy link to this section"]', new DOMRect(0, 0, 17, 20)],
        text,
      ]),
      vi.spyOn(Range.prototype, "getClientRects").mockImplementation(() => [firstLine] as unknown as DOMRectList),
    );
    render(<Host />);
    fireEvent.pointerOver(screen.getByText("Title"));
    const button = screen.getByRole("button", { name: "Copy link to this section" });
    expect(button.style.left).toBe("204px"); // 文字右緣 300 − 欄左緣 100 + 4
    expect(button.style.top).toBe("35px"); // 首行上緣 80 − 欄上緣 50 + (首行高 30 − 鈕高 20) / 2
    text[1] = new DOMRect(100, 90, 300, 72);
    firstLine = new DOMRect(100, 94, 300, 24);
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(button.style.left).toBe("304px");
    expect(button.style.top).toBe("46px"); // 94 − 50 + (24 − 20) / 2
    text[1] = new DOMRect(100, 90, 800, 72); // 文字頂到欄位右緣
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(button.style.left).toBe("783px"); // min(900 − 100 + 4, 欄寬 800 − 鈕寬 17)
  });

  it("pointer 離開整個文章欄 → 「#」收起", () => {
    render(<Host />);
    fireEvent.pointerOver(screen.getByText("Title"));
    expect(screen.getByRole("button", { name: "Copy link to this section" })).toBeInTheDocument();
    fireEvent.pointerLeave(screen.getByTestId("col"));
    expect(screen.queryByRole("button", { name: "Copy link to this section" })).not.toBeInTheDocument();
  });

  it("pointer 進入標題 → 出現 #；點擊複製 <base>#b-<id> 並 toast；移到一般段落 → 消失", async () => {
    render(<Host />);
    expect(screen.queryByRole("button", { name: "Copy link to this section" })).not.toBeInTheDocument();
    fireEvent.pointerOver(screen.getByText("Title"));
    fireEvent.click(screen.getByRole("button", { name: "Copy link to this section" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://kb.example.com/n/h/s#b-h1"));
    expect(await screen.findByText("Block link copied")).toBeInTheDocument();
    fireEvent.pointerOver(screen.getByText("Body"));
    expect(screen.queryByRole("button", { name: "Copy link to this section" })).not.toBeInTheDocument();
  });

  it("巢狀標題（清單底下）照樣出現、複製的是最內層那顆的 id；pointer 移到 # 鈕本身不消失", async () => {
    render(<Host />);
    fireEvent.pointerOver(screen.getByText("Nested"));
    const button = screen.getByRole("button", { name: "Copy link to this section" });
    fireEvent.pointerOver(button);
    fireEvent.click(screen.getByRole("button", { name: "Copy link to this section" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://kb.example.com/n/h/s#b-h3"));
  });

  it("pointer 停在清單項目文字上（其子區塊是標題、自己不是）→ 沒有 #", () => {
    render(<Host />);
    fireEvent.pointerOver(screen.getByText("Title"));
    expect(screen.getByRole("button", { name: "Copy link to this section" })).toBeInTheDocument();
    fireEvent.pointerOver(screen.getByText("item"));
    expect(screen.queryByRole("button", { name: "Copy link to this section" })).not.toBeInTheDocument();
  });

  it("選取游標落在標題（鍵盤）→ 出現 #、複製該標題；游標移到一般段落 → 消失", async () => {
    render(<Host />);
    const caretTo = (text: string) => {
      act(() => {
        document.getSelection()!.collapse(screen.getByText(text).firstChild!, 1);
        document.dispatchEvent(new Event("selectionchange"));
      });
    };
    caretTo("Title");
    fireEvent.click(screen.getByRole("button", { name: "Copy link to this section" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://kb.example.com/n/h/s#b-h1"));
    caretTo("Body");
    expect(screen.queryByRole("button", { name: "Copy link to this section" })).not.toBeInTheDocument();
  });

  it("clipboard 失敗 → 錯誤 toast", async () => {
    writeText.mockImplementationOnce(() => Promise.reject(new Error("denied")));
    render(<Host />);
    fireEvent.pointerOver(screen.getByText("Title"));
    fireEvent.click(screen.getByRole("button", { name: "Copy link to this section" }));
    expect(await screen.findByText("Couldn't copy the link.")).toBeInTheDocument();
  });
});
