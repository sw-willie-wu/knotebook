import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * `MermaidView` 的單元測試。
 *
 * ⚠ `lib/mermaid` 整支被 mock 掉——理由見該檔測試檔頭（mermaid 本體在 jsdom 跑不起來）。
 * 這裡驗的是**兩態切換、錯誤不吞、viewer 不可編輯、非同步競態**，不是圖畫得對不對。
 */

const renderMermaidMock = vi.hoisted(() => vi.fn());
const cachedMermaidMock = vi.hoisted(() => vi.fn());
const preloadMermaidMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/mermaid", () => ({
  renderMermaid: renderMermaidMock,
  cachedMermaid: cachedMermaidMock,
  preloadMermaid: preloadMermaidMock,
  nextMermaidId: () => "mermaid-test",
}));

const i18n = (await import("@/i18n")).default;
const { MERMAID_ROOT_MARGIN, MermaidView } = await import("./MermaidView");

beforeEach(async () => {
  await i18n.changeLanguage("en"); // 斷言用英文字面（repo 慣例，同 ConnectionBadge.test.tsx）
  renderMermaidMock.mockReset();
  renderMermaidMock.mockResolvedValue({ ok: true, svg: "<svg data-testid='diagram'></svg>" });
  cachedMermaidMock.mockReset();
  cachedMermaidMock.mockReturnValue(null);
  preloadMermaidMock.mockReset();
});

/** 手動觸發的假 IntersectionObserver（jsdom 沒有這個 API）。 */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = [];
  readonly observe = vi.fn();
  readonly unobserve = vi.fn();
  readonly disconnect = vi.fn();
  readonly takeRecords = () => [];
  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    FakeIntersectionObserver.instances.push(this);
  }
  fire(isIntersecting: boolean): void {
    act(() => {
      this.callback([{ isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver);
    });
  }
}

/** 目前（最後建立的）那個 observer。 */
function observer(): FakeIntersectionObserver {
  const last = FakeIntersectionObserver.instances.at(-1);
  if (last === undefined) throw new Error("沒有建立 IntersectionObserver");
  return last;
}

/** 讓排進 microtask／macrotask 的 effect 與 promise 都跑完。 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("MermaidView — 渲染態", () => {
  it("畫出 mermaid 回傳的 svg", async () => {
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
  });

  it("最外層帶功能導覽的目標屬性（導覽挖亮筆記裡的流程圖用）", async () => {
    const { container } = render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    expect(container.firstElementChild).toHaveAttribute("data-kb-tour-target", "flowchart");
  });

  it("原始碼為空時顯示提示、不顯示錯誤", async () => {
    renderMermaidMock.mockResolvedValue({ ok: false, message: "" });
    render(<MermaidView code="" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Click to add diagram source")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("語法錯時同時顯示錯誤訊息**與原始碼**（否則使用者改不回來）", async () => {
    renderMermaidMock.mockResolvedValue({ ok: false, message: "Parse error on line 2" });
    render(<MermaidView code="not a diagram" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Parse error on line 2"));
    expect(screen.getByText("not a diagram")).toBeInTheDocument();
  });

  it("主題換手時重新渲染", async () => {
    const { rerender } = render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(renderMermaidMock).toHaveBeenCalledTimes(1));
    rerender(<MermaidView code="graph TD; A-->B;" editable theme="dark" onChange={vi.fn()} />);
    await waitFor(() => expect(renderMermaidMock).toHaveBeenLastCalledWith("graph TD; A-->B;", "dark", expect.anything()));
  });

  it("renderMermaid 意外 reject（不是取消）：轉成錯誤態，不永遠停在佔位", async () => {
    renderMermaidMock.mockRejectedValue(new Error("unexpected boom"));
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("unexpected boom"));
    expect(screen.queryByText("Rendering diagram…")).not.toBeInTheDocument();
    expect(screen.getByText("graph TD; A-->B;")).toBeInTheDocument();
  });

  it("非同步競態：舊的渲染結果不得覆蓋新的", async () => {
    // code 由 A 改成 B，但 A 的 render 比較慢才 resolve——畫面必須留在 B。
    let resolveSlow!: (v: unknown) => void;
    renderMermaidMock.mockImplementationOnce(() => new Promise((r) => (resolveSlow = r)));
    renderMermaidMock.mockResolvedValueOnce({ ok: true, svg: "<svg data-testid='new'></svg>" });

    const { rerender } = render(<MermaidView code="A" editable theme="light" onChange={vi.fn()} />);
    rerender(<MermaidView code="B" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("new")).toBeInTheDocument());

    // ⚠ 不可用 `waitFor(new)`：它第一次檢查就成立、立刻返回，舊結果的 setState 還沒 flush 就斷言，
    // 拿掉閘門也只有約一半機率紅。在 act 裡 resolve、再讓 microtask／macrotask 跑完才斷言。
    await act(async () => {
      resolveSlow({ ok: true, svg: "<svg data-testid='stale'></svg>" });
    });
    await settle();
    expect(screen.getByTestId("new")).toBeInTheDocument();
    expect(screen.queryByTestId("stale")).not.toBeInTheDocument();
  });
});

describe("MermaidView — 載入中佔位（#344 D）", () => {
  it("還沒畫出來時顯示固定最小高度的「渲染中」佔位，不是一片空白", async () => {
    renderMermaidMock.mockImplementation(() => new Promise(() => {})); // 永遠畫不完
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    const placeholder = screen.getByText("Rendering diagram…");
    expect(placeholder.className.split(/\s+/)).toContain("min-h-40");
    expect(placeholder).toHaveAttribute("aria-busy", "true");
  });

  it("畫出來之後佔位消失", async () => {
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    expect(screen.queryByText("Rendering diagram…")).not.toBeInTheDocument();
  });

  it("已經有圖時改 code：舊圖留著直到新圖出來（不退回佔位）", async () => {
    const { rerender } = render(<MermaidView code="A" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());

    let resolveNext!: (v: unknown) => void;
    renderMermaidMock.mockImplementationOnce(() => new Promise((r) => (resolveNext = r)));
    rerender(<MermaidView code="B" editable theme="light" onChange={vi.fn()} />);
    await settle();
    expect(screen.getByTestId("diagram")).toBeInTheDocument();
    expect(screen.queryByText("Rendering diagram…")).not.toBeInTheDocument();

    resolveNext({ ok: true, svg: "<svg data-testid='next'></svg>" });
    await waitFor(() => expect(screen.getByTestId("next")).toBeInTheDocument());
  });

  it("空原始碼直接顯示提示，不閃佔位、不打 renderMermaid", () => {
    render(<MermaidView code="" editable theme="light" onChange={vi.fn()} />);
    expect(screen.getByText("Click to add diagram source")).toBeInTheDocument();
    expect(screen.queryByText("Rendering diagram…")).not.toBeInTheDocument();
    expect(renderMermaidMock).not.toHaveBeenCalled();
  });
});

describe("MermaidView — 快取（#344 B）", () => {
  it("掛載時快取命中：當下就有圖（不閃佔位、不再請求渲染）", async () => {
    cachedMermaidMock.mockReturnValue("<svg data-testid='cached'></svg>");
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    expect(screen.getByTestId("cached")).toBeInTheDocument(); // 同步，不必 waitFor
    expect(cachedMermaidMock).toHaveBeenCalledWith("graph TD; A-->B;", "light");
    await settle();
    expect(renderMermaidMock).not.toHaveBeenCalled();
  });
});

describe("MermaidView — 預熱（#344 E）", () => {
  it("一掛上就暖 mermaid chunk", () => {
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    expect(preloadMermaidMock).toHaveBeenCalled();
  });

  it("空 block 不暖（新建的空 block 是常態，不該為它拉進一整包相依）", () => {
    render(<MermaidView code="  " editable theme="light" onChange={vi.fn()} />);
    expect(preloadMermaidMock).not.toHaveBeenCalled();
  });
});

describe("MermaidView — 只畫視窗附近的圖（#344 C）", () => {
  beforeEach(() => {
    FakeIntersectionObserver.instances = [];
    vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it(`觀察外層、rootMargin 是 ${MERMAID_ROOT_MARGIN}`, () => {
    const { container } = render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    expect(observer().observe).toHaveBeenCalledWith(container.firstElementChild);
    expect(observer().options?.rootMargin).toBe(MERMAID_ROOT_MARGIN);
  });

  it("root 是最近的可捲動祖先（筆記頁捲的是內層容器；用視窗當 root 時 rootMargin 不生效）", () => {
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    const inner = document.createElement("div");
    scroller.append(inner);
    document.body.append(scroller);
    try {
      render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />, { container: inner });
      expect(observer().options?.root).toBe(scroller);
    } finally {
      scroller.remove();
    }
  });

  it("沒有可捲動祖先時 root 是視窗（null）", () => {
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    expect(observer().options?.root).toBeNull();
  });

  it("不在視窗附近就不請求渲染（顯示佔位）；進來才請求", async () => {
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    observer().fire(false);
    await settle();
    expect(renderMermaidMock).not.toHaveBeenCalled();
    expect(screen.getByText("Rendering diagram…")).toBeInTheDocument();
    // 預熱不等視窗
    expect(preloadMermaidMock).toHaveBeenCalled();

    observer().fire(true);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    expect(renderMermaidMock).toHaveBeenCalledTimes(1);
  });

  it("請求被取消後才 reject（AbortError）：不動畫面、不出錯誤態", async () => {
    let rejectIt!: (e: unknown) => void;
    renderMermaidMock.mockImplementation(() => new Promise((_, reject) => (rejectIt = reject)));
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    observer().fire(true);
    await waitFor(() => expect(renderMermaidMock).toHaveBeenCalledTimes(1));
    observer().fire(false);
    rejectIt(new DOMException("aborted", "AbortError"));
    await settle();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByText("Rendering diagram…")).toBeInTheDocument();
  });

  it("請求還沒開始就離開視窗：取消那次請求（signal aborted）", async () => {
    renderMermaidMock.mockImplementation(() => new Promise(() => {}));
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    observer().fire(true);
    await waitFor(() => expect(renderMermaidMock).toHaveBeenCalledTimes(1));
    const { signal } = renderMermaidMock.mock.calls[0]![2] as { signal: AbortSignal };
    expect(signal.aborted).toBe(false);

    observer().fire(false);
    expect(signal.aborted).toBe(true);
  });

  it("卸載時取消還在排隊的請求", async () => {
    renderMermaidMock.mockImplementation(() => new Promise(() => {}));
    const { unmount } = render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    observer().fire(true);
    await waitFor(() => expect(renderMermaidMock).toHaveBeenCalledTimes(1));
    const { signal } = renderMermaidMock.mock.calls[0]![2] as { signal: AbortSignal };
    unmount();
    expect(signal.aborted).toBe(true);
    expect(observer().disconnect).toHaveBeenCalled();
  });

  it("畫過之後捲出捲進不重畫；捲出去時原始碼換了照常重畫", async () => {
    const { rerender } = render(<MermaidView code="A" editable theme="light" onChange={vi.fn()} />);
    observer().fire(true);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    observer().fire(false);
    observer().fire(true);
    observer().fire(false);
    await settle();
    expect(renderMermaidMock).toHaveBeenCalledTimes(1);

    rerender(<MermaidView code="B" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(renderMermaidMock).toHaveBeenCalledTimes(2));
    expect(renderMermaidMock).toHaveBeenLastCalledWith("B", "light", expect.anything());
  });

  it("捲出去時只換了主題：先留著舊圖，進到附近才用新主題重畫（畫面上的圖先換）", async () => {
    const { rerender } = render(<MermaidView code="A" editable theme="light" onChange={vi.fn()} />);
    observer().fire(true);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    observer().fire(false);

    rerender(<MermaidView code="A" editable theme="dark" onChange={vi.fn()} />);
    await settle();
    expect(renderMermaidMock).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("diagram")).toBeInTheDocument(); // 舊主題的圖還在，不退回佔位

    observer().fire(true);
    await waitFor(() => expect(renderMermaidMock).toHaveBeenCalledTimes(2));
    expect(renderMermaidMock).toHaveBeenLastCalledWith("A", "dark", expect.anything());
  });

  it("在附近時換主題照常立刻重畫", async () => {
    const { rerender } = render(<MermaidView code="A" editable theme="light" onChange={vi.fn()} />);
    observer().fire(true);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    rerender(<MermaidView code="A" editable theme="dark" onChange={vi.fn()} />);
    await waitFor(() => expect(renderMermaidMock).toHaveBeenLastCalledWith("A", "dark", expect.anything()));
  });

  it("⚠ 在編輯器裡時 root 從編輯器外面找起：並排欄（overflow-x:auto ⇒ 算出來 overflowY 也是 auto）不是捲動根", () => {
    // 真瀏覽器裡 `.bn-block-column{overflow-x:auto}` 的 computed overflowY 是 "auto"（CSS 規則：另一軸
    // visible 會被算成 auto）；jsdom 不做這個換算，這裡直接寫成兩軸都 auto 來模擬。
    const scroller = document.createElement("div");
    scroller.style.overflowY = "auto";
    const editor = document.createElement("div");
    editor.className = "bn-editor";
    const column = document.createElement("div");
    column.className = "bn-block-column";
    column.style.overflowX = "auto";
    column.style.overflowY = "auto";
    const inner = document.createElement("div");
    column.append(inner);
    editor.append(column);
    scroller.append(editor);
    document.body.append(scroller);
    try {
      render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />, { container: inner });
      expect(observer().options?.root).toBe(scroller);
    } finally {
      scroller.remove();
    }
  });

  it("沒有 IntersectionObserver 的環境（jsdom、舊瀏覽器）退回掛上就畫", async () => {
    vi.unstubAllGlobals();
    expect(typeof IntersectionObserver).toBe("undefined");
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
  });
});

/** 點開編輯態，回傳那個 textarea。 */
function openEditor(): HTMLTextAreaElement {
  fireEvent.click(screen.getByRole("button", { name: "Edit diagram source" }));
  return screen.getByRole("textbox") as HTMLTextAreaElement;
}

describe("MermaidView — 編輯態", () => {
  it("點一下切到原始碼編輯", () => {
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    expect(openEditor()).toHaveValue("graph TD; A-->B;");
  });

  it("失焦時把新原始碼交出去並回到圖", async () => {
    const onChange = vi.fn();
    render(<MermaidView code="A" editable theme="light" onChange={onChange} />);
    const box = openEditor();
    fireEvent.change(box, { target: { value: "graph TD; X-->Y;" } });
    fireEvent.blur(box);
    expect(onChange).toHaveBeenCalledWith("graph TD; X-->Y;");
    await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());
  });

  it("Esc 一樣提交並回到圖", async () => {
    const onChange = vi.fn();
    render(<MermaidView code="A" editable theme="light" onChange={onChange} />);
    const box = openEditor();
    fireEvent.change(box, { target: { value: "B" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect(onChange).toHaveBeenCalledWith("B");
    await waitFor(() => expect(screen.queryByRole("textbox")).not.toBeInTheDocument());
  });

  it("原始碼沒變就不呼叫 onChange（避免在共編文件上製造無意義的 Yjs 更新）", () => {
    const onChange = vi.fn();
    render(<MermaidView code="A" editable theme="light" onChange={onChange} />);
    fireEvent.blur(openEditor());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Enter 不離開編輯態（圖的原始碼本來就是多行）", () => {
    render(<MermaidView code="A" editable theme="light" onChange={vi.fn()} />);
    const box = openEditor();
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });
});

describe("MermaidView — viewer", () => {
  it("editable=false 時沒有編輯入口", async () => {
    render(<MermaidView code="graph TD; A-->B;" editable={false} theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Edit diagram source" })).not.toBeInTheDocument();
  });

  it("editable=false 時語法錯仍看得到原始碼（不然 viewer 只看到一句錯誤）", async () => {
    renderMermaidMock.mockResolvedValue({ ok: false, message: "Parse error" });
    render(<MermaidView code="broken" editable={false} theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("broken")).toBeInTheDocument());
  });
});

describe("MermaidView — 工具列", () => {
  it("圖的狀態提供一顆「編輯」鈕", async () => {
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Edit" })).toBeInTheDocument();
  });

  it("按「編輯」進入原始碼狀態", async () => {
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("textbox")).toHaveValue("graph TD; A-->B;");
  });

  it("⚠ 原始碼狀態**一定**回得去（死路 bug 的迴歸守門），且畫面有告訴使用者怎麼出來", async () => {
    // 舊設計把 block 換成 BlockNote 的 codeBlock，換過去就再也回不來——
    // 使用者實測時第一件事就是撞到。出路可以不是按鈕，但必須存在且說得出來。
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByText("Press Esc or click elsewhere to finish")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
  });

  it("編輯中沒有第二顆鈕（出路是 Esc／點別處，不是切換鈕）", async () => {
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("工具列鈕不巢狀在點圖區裡（巢狀 button 不合法，且點擊會同時觸發兩者）", async () => {
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    const toolbarButton = screen.getByRole("button", { name: "Edit" });
    const clickArea = screen.getByRole("button", { name: "Edit diagram source" });
    expect(clickArea.contains(toolbarButton)).toBe(false);
  });

  it("viewer 用同一顆鈕看原始碼（唯讀），標籤是「顯示原始碼」", async () => {
    render(<MermaidView code="graph TD; A-->B;" editable={false} theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Edit" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Show source" }));
    expect(screen.getByRole("textbox")).toHaveAttribute("readonly");

    // viewer 一樣要回得去。
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
  });
});

// ── 樣式載重的結構守衛──────────────────────────────────────────────
//
// 這兩件事 `MermaidView.tsx` 的註解都寫明是實測換來的，但突變實測
// 顯示兩者被改掉時測試全綠。jsdom 沒有 layout／Tab 順序，只能用 class 字串做結構守衛
// ——同 `theme.scrollbar-guard.test.ts`／`theme.block-selection-guard.test.ts` 的既有手法。

describe("MermaidView — 樣式載重", () => {
  it("工具列鈕用 opacity 隱藏而非 hidden（hidden 會讓它退出 Tab 順序，鍵盤使用者構不到）", async () => {
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());

    const button = screen.getByRole("button", { name: "Edit" });
    expect(button.className).toContain("opacity-0");
    expect(button.className).toContain("group-hover:opacity-100");
    expect(button.className).toContain("focus-visible:opacity-100");
    // 方塊內有焦點（Tab 到「點圖進編輯」那顆）時也現身——與 codeBlock「游標在程式碼裡就現身」同語意。
    expect(button.className).toContain("group-focus-within:opacity-100");
    expect(button.className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });

  it("控制鈕疊在方塊內右上角：直接掛在 relative 外層底下，沒有 #111 那條 h-7 保留列", async () => {
    const { container } = render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());

    const root = container.firstElementChild as HTMLElement;
    const button = screen.getByRole("button", { name: "Edit" });
    // 位置由 `.block-control`（index.css）給——它是 absolute，containing block 就是這個外層。
    expect(button.className).toContain("block-control");
    // 位置只在 `.block-control`（與語言下拉同一條規則）：鈕自己不得再帶任何定位 utility——那是兩份位置真相。
    // 看渲染後的 token（不看順序、不受原始碼註解干擾）：`top-1`、`right-[4px]`、`inset-0`、`absolute`… 都算。
    const positional = button.className
      .split(/\s+/)
      .filter((t) => /^-?(?:absolute|relative|fixed|sticky|inset|top|right|bottom|left)(?:-|$)/.test(t.replace(/^.*:/, "")));
    expect(positional, `控制鈕不得自帶定位 class：${positional.join(" ")}`).toEqual([]);
    expect(root.className.split(/\s+/), "外層要 relative，控制鈕才疊得在方塊內").toContain("relative");
    expect(button.parentElement, "控制鈕外面不得再包一層工具列（那就是保留列）").toBe(root);
    expect(root.querySelector('[class*="h-7"]'), "不得再有 h-7 的保留列").toBeNull();
  });

  it("編輯中：控制鈕不渲染，提示放在 textarea 下方（不疊在原始碼上）", async () => {
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Edit" }));

    const textarea = screen.getByRole("textbox");
    const hint = screen.getByText("Press Esc or click elsewhere to finish");
    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(textarea.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING, "提示要在 textarea 之後").toBeTruthy();
    expect(hint.className, "提示不得疊上去（absolute）").not.toMatch(/\babsolute\b/);
  });

  it("外層帶 w-full（bn-block-content 是 flex 容器，沒宣告寬度整個 block 會被 shrink-wrap 成約 140px）", () => {
    const { container } = render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    expect(container.firstElementChild!.className).toContain("w-full");
  });
});

