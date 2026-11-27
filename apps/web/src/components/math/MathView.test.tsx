import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const renderMathMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/katex", () => ({ renderMath: renderMathMock }));

const i18n = (await import("@/i18n")).default;
const { MathView } = await import("./MathView");
const { MATH_SCROLL_ATTR } = await import("@/lib/table-scroll-hint");

beforeEach(async () => {
  await i18n.changeLanguage("en");
  renderMathMock.mockReset();
  renderMathMock.mockResolvedValue({ ok: true, html: '<span data-testid="formula" class="katex-display"></span>' });
});

describe("MathView rendering", () => {
  it("draws the html returned by renderMath", async () => {
    render(<MathView tex="E=mc^2" editable onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("formula")).toBeInTheDocument());
  });

  it("blank source shows the hint, not an error", async () => {
    renderMathMock.mockResolvedValue({ ok: false, message: "" });
    render(<MathView tex="" editable onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Click to add a formula (LaTeX)")).toBeInTheDocument());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("a load failure shows the error and the source, not a blank block", async () => {
    renderMathMock.mockResolvedValue({ ok: false, message: "Failed to fetch dynamically imported module" });
    render(<MathView tex={"\\int_0^1 x\\,dx"} editable={false} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("The formula couldn't be shown"));
    expect(screen.getByText("\\int_0^1 x\\,dx")).toBeInTheDocument();
  });

  it("a late result from an older renderMath must not overwrite a newer one", async () => {
    let resolveOld!: (v: unknown) => void;
    renderMathMock.mockImplementationOnce(() => new Promise((r) => { resolveOld = r; }));
    renderMathMock.mockResolvedValueOnce({ ok: true, html: '<span data-testid="new"></span>' });
    const { rerender } = render(<MathView tex="a" editable onChange={vi.fn()} />);
    rerender(<MathView tex="b" editable onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("new")).toBeInTheDocument());
    await act(async () => {
      resolveOld({ ok: true, html: '<span data-testid="old"></span>' });
    });
    expect(screen.queryByTestId("old")).not.toBeInTheDocument();
  });
});

describe("MathView editing", () => {
  it("clicking the block starts editing; Esc commits; onChange is called only when the source changed", async () => {
    const onChange = vi.fn();
    render(<MathView tex="a" editable onChange={onChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit formula source" }));
    const area = screen.getByRole("textbox", { name: "LaTeX source" });
    fireEvent.keyDown(area, { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled(); // unchanged
    fireEvent.click(await screen.findByRole("button", { name: "Edit formula source" }));
    fireEvent.change(screen.getByRole("textbox", { name: "LaTeX source" }), { target: { value: "b" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "LaTeX source" }), { key: "Escape" });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("b");
  });

  it("viewer (editable=false): no edit-area button; \"Show source\" opens a read-only textarea", async () => {
    render(<MathView tex="a" editable={false} onChange={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Edit formula source" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show source" }));
    expect(screen.getByRole("textbox", { name: "LaTeX source" })).toHaveAttribute("readonly");
  });
});

describe("MathView commit paths", () => {
  it("blurring after a change calls onChange exactly once with the new value", async () => {
    const onChange = vi.fn();
    render(<MathView tex="a" editable onChange={onChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit formula source" }));
    const area = screen.getByRole("textbox", { name: "LaTeX source" });
    fireEvent.change(area, { target: { value: "c" } });
    fireEvent.blur(area);
    expect(onChange).toHaveBeenCalledExactlyOnceWith("c");
  });

  it("Esc inside the textarea must not bubble to an outer onKeyDown", async () => {
    const outer = vi.fn();
    render(
      <div onKeyDown={outer}>
        <MathView tex="a" editable onChange={vi.fn()} />
      </div>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Edit formula source" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "LaTeX source" }), { key: "Escape" });
    expect(outer).not.toHaveBeenCalled();
  });
});

describe("MathView control group visibility", () => {
  const GROUP_TOKENS = [
    "opacity-0",
    "group-hover:opacity-100",
    "group-focus-within:opacity-100",
    "[@media(hover:none)]:opacity-60",
    "[@media(hover:none)]:group-focus-within:opacity-100",
  ];

  it.each([
    ["editable", true, "Edit"],
    ["read-only", false, "Show source"],
  ])("%s: the button sits in a block-control-group that is a direct child of the relative outer element, dimly visible on touch", async (_label, editable, name) => {
    const { container } = render(<MathView tex="a" editable={editable} onChange={vi.fn()} />);
    const root = container.firstElementChild as HTMLElement;
    const button = await screen.findByRole("button", { name });
    const group = button.parentElement as HTMLElement;
    expect(group.className.split(/\s+/)).toContain("block-control-group");
    expect(group.parentElement).toBe(root);
    expect(root.className.split(/\s+/)).toContain("relative");
    expect(root.className.split(/\s+/)).toContain("group");
    expect(button.className).toBe("block-control");
    for (const token of GROUP_TOKENS) expect(group.className.split(/\s+/)).toContain(token);
    expect(group.className.split(/\s+/).filter((t) => t === "hidden" || t.endsWith(":hidden"))).toEqual([]);
  });
});

describe("MathView strings", () => {
  it("shows the zh-TW hint without the test having registered the math bundle itself", async () => {
    await i18n.changeLanguage("zh-TW");
    renderMathMock.mockResolvedValue({ ok: false, message: "" });
    render(<MathView tex="" editable onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("點一下輸入數學式（LaTeX）")).toBeInTheDocument());
  });
});

describe("MathView scroll marker", () => {
  it("marks the formula scroller so the phone right-edge hint can find it", async () => {
    const { container } = render(<MathView tex="E=mc^2" editable onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("formula")).toBeInTheDocument());
    const scroller = screen.getByTestId("formula").parentElement!;
    expect(scroller).toHaveAttribute(MATH_SCROLL_ATTR);
    expect(scroller).toHaveClass("overflow-x-auto");
    expect(container.querySelectorAll(`[${MATH_SCROLL_ATTR}]`)).toHaveLength(1);
  });

  it("the viewer (editable=false) gets the marker too", async () => {
    render(<MathView tex="E=mc^2" editable={false} onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("formula")).toBeInTheDocument());
    expect(screen.getByTestId("formula").parentElement).toHaveAttribute(MATH_SCROLL_ATTR);
  });

  it("the blank and error states have no marker", async () => {
    renderMathMock.mockResolvedValue({ ok: false, message: "" });
    const blank = render(<MathView tex="" editable onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Click to add a formula (LaTeX)")).toBeInTheDocument());
    expect(blank.container.querySelector(`[${MATH_SCROLL_ATTR}]`)).toBeNull();
    blank.unmount();
    renderMathMock.mockResolvedValue({ ok: false, message: "Failed to fetch dynamically imported module" });
    const failed = render(<MathView tex="\\bad" editable onChange={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(failed.container.querySelector(`[${MATH_SCROLL_ATTR}]`)).toBeNull();
  });
});

describe("MathView source safety", () => {
  it("a peer's change while the source is open but untouched is not written back on blur", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<MathView tex="a" editable onChange={onChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit formula source" }));
    rerender(<MathView tex="b" editable onChange={onChange} />);
    fireEvent.blur(screen.getByRole("textbox", { name: "LaTeX source" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("the viewer's read-only source never writes, by blur or Esc, even after a peer's change", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<MathView tex="a" editable={false} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "Show source" }));
    rerender(<MathView tex="b" editable={false} onChange={onChange} />);
    fireEvent.blur(screen.getByRole("textbox", { name: "LaTeX source" }));
    fireEvent.click(screen.getByRole("button", { name: "Show source" }));
    rerender(<MathView tex="c" editable={false} onChange={onChange} />);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "LaTeX source" }), { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("an edit made while a peer also changed the source is written as typed (the last writer wins)", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<MathView tex="a" editable onChange={onChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit formula source" }));
    fireEvent.change(screen.getByRole("textbox", { name: "LaTeX source" }), { target: { value: "c" } });
    rerender(<MathView tex="b" editable onChange={onChange} />);
    fireEvent.blur(screen.getByRole("textbox", { name: "LaTeX source" }));
    expect(onChange).toHaveBeenCalledExactlyOnceWith("c");
  });

  it("reopening the source starts from the source as it is then, so a peer's earlier change is not written back either", async () => {
    const onChange = vi.fn();
    const { rerender } = render(<MathView tex="a" editable onChange={onChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit formula source" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "LaTeX source" }), { key: "Escape" });
    rerender(<MathView tex="b" editable onChange={onChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit formula source" }));
    rerender(<MathView tex="c" editable onChange={onChange} />);
    fireEvent.blur(screen.getByRole("textbox", { name: "LaTeX source" }));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("a read-only empty formula shows no hint asking to click it", async () => {
    renderMathMock.mockResolvedValue({ ok: false, message: "" });
    const { container } = render(<MathView tex="" editable={false} onChange={vi.fn()} />);
    await waitFor(() => expect(renderMathMock).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByText("Click to add a formula (LaTeX)")).not.toBeInTheDocument();
    expect(container.textContent).toBe("Show source");
  });

  it("a tex that is not a string (a misbehaving client wrote a number) is drawn and edited as an empty formula, without throwing", async () => {
    renderMathMock.mockResolvedValue({ ok: false, message: "" });
    const onChange = vi.fn();
    render(<MathView tex={42 as unknown as string} editable onChange={onChange} />);
    await waitFor(() => expect(renderMathMock).toHaveBeenCalledWith(""));
    fireEvent.click(await screen.findByRole("button", { name: "Edit formula source" }));
    const area = screen.getByRole("textbox", { name: "LaTeX source" });
    expect(area).toHaveValue("");
    fireEvent.blur(area);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("Esc that ends an input method composition does not close the source", async () => {
    const onChange = vi.fn();
    render(<MathView tex="a" editable onChange={onChange} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit formula source" }));
    const area = screen.getByRole("textbox", { name: "LaTeX source" });
    fireEvent.change(area, { target: { value: "a+b" } });
    fireEvent.keyDown(area, { key: "Escape", isComposing: true });
    expect(screen.getByRole("textbox", { name: "LaTeX source" })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(area, { key: "Escape" });
    expect(onChange).toHaveBeenCalledExactlyOnceWith("a+b");
  });
});
