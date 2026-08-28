import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

/**
 * `MermaidView` 的單元測試。
 *
 * ⚠ `lib/mermaid` 整支被 mock 掉——理由見該檔測試檔頭（mermaid 本體在 jsdom 跑不起來）。
 * 這裡驗的是**兩態切換、錯誤不吞、viewer 不可編輯、非同步競態**，不是圖畫得對不對。
 */

const renderMermaidMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/mermaid", () => ({
  renderMermaid: renderMermaidMock,
  nextMermaidId: () => "mermaid-test",
}));

const i18n = (await import("@/i18n")).default;
const { MermaidView } = await import("./MermaidView");

beforeEach(async () => {
  await i18n.changeLanguage("en"); // 斷言用英文字面（repo 慣例，同 ConnectionBadge.test.tsx）
  renderMermaidMock.mockReset();
  renderMermaidMock.mockResolvedValue({ ok: true, svg: "<svg data-testid='diagram'></svg>" });
});

describe("MermaidView — 渲染態", () => {
  it("畫出 mermaid 回傳的 svg", async () => {
    render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
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
    await waitFor(() => expect(renderMermaidMock).toHaveBeenLastCalledWith("graph TD; A-->B;", "dark"));
  });

  it("非同步競態：舊的渲染結果不得覆蓋新的", async () => {
    // code 由 A 改成 B，但 A 的 render 比較慢才 resolve——畫面必須留在 B。
    let resolveSlow!: (v: unknown) => void;
    renderMermaidMock.mockImplementationOnce(() => new Promise((r) => (resolveSlow = r)));
    renderMermaidMock.mockResolvedValueOnce({ ok: true, svg: "<svg data-testid='new'></svg>" });

    const { rerender } = render(<MermaidView code="A" editable theme="light" onChange={vi.fn()} />);
    rerender(<MermaidView code="B" editable theme="light" onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("new")).toBeInTheDocument());

    resolveSlow({ ok: true, svg: "<svg data-testid='stale'></svg>" });
    await waitFor(() => expect(screen.getByTestId("new")).toBeInTheDocument());
    expect(screen.queryByTestId("stale")).not.toBeInTheDocument();
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

// ── 樣式載重的結構守衛（審查 I-5）──────────────────────────────────────────────
//
// 這兩件事 `MermaidView.tsx` 的註解都寫明是實測換來的，但突變實測（2026-08-28 審查）
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
    expect(button.className).not.toMatch(/(^|\s)hidden(\s|$)/);
  });

  it("外層帶 w-full（bn-block-content 是 flex 容器，沒宣告寬度整個 block 會被 shrink-wrap 成約 140px）", () => {
    const { container } = render(<MermaidView code="graph TD; A-->B;" editable theme="light" onChange={vi.fn()} />);
    expect(container.firstElementChild!.className).toContain("w-full");
  });
});

