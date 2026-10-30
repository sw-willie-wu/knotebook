import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { __resetCollapseForTests, isCollapsed, setCollapsed, useCollapsed, useCollapseVersion, type SidebarSectionKey } from "./collapse";

// 覆蓋層與訂閱者是模組層，跨案殘留（亂序跑時尤其）。
afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  __resetCollapseForTests();
});

function Probe({ id, sectionKey = "group:g1" }: { id: string; sectionKey?: SidebarSectionKey }) {
  const [expanded, toggle] = useCollapsed(sectionKey);
  return (
    <button type="button" data-testid={id} onClick={toggle}>
      {expanded ? "expanded" : "collapsed"}
    </button>
  );
}

function throwQuota(): never {
  throw new DOMException("quota", "QuotaExceededError");
}

describe("collapse store", () => {
  it("CO1 沒存過：isCollapsed 為 false、useCollapsed 回展開", () => {
    render(<Probe id="a" />);
    expect(isCollapsed("group:g1")).toBe(false);
    expect(screen.getByTestId("a")).toHaveTextContent("expanded");
  });

  it("CO2 toggle 寫 \"1\"、再 toggle 刪鍵", () => {
    render(<Probe id="a" />);
    fireEvent.click(screen.getByTestId("a"));
    expect(localStorage.getItem("sidebar.collapsed.group:g1")).toBe("1");
    expect(screen.getByTestId("a")).toHaveTextContent("collapsed");
    fireEvent.click(screen.getByTestId("a"));
    expect(localStorage.getItem("sidebar.collapsed.group:g1")).toBeNull();
    expect(screen.getByTestId("a")).toHaveTextContent("expanded");
  });

  it("CO3 同一把鍵的兩個元件：第一個 toggle，第二個同一次 act 內跟著變", () => {
    render(
      <>
        <Probe id="a" />
        <Probe id="b" />
      </>,
    );
    act(() => {
      screen.getByTestId("a").click();
    });
    expect(screen.getByTestId("a")).toHaveTextContent("collapsed");
    expect(screen.getByTestId("b")).toHaveTextContent("collapsed");
  });

  it("CO4 getItem、setItem、removeItem 都丟例外：toggle 不丟錯、之後讀到收合；再 toggle 回展開", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(throwQuota);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(throwQuota);
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(throwQuota);
    render(<Probe id="a" />);
    expect(() => fireEvent.click(screen.getByTestId("a"))).not.toThrow();
    expect(isCollapsed("group:g1")).toBe(true);
    expect(screen.getByTestId("a")).toHaveTextContent("collapsed");
    fireEvent.click(screen.getByTestId("a")); // removeItem 也丟例外 → 覆蓋層記「展開」
    expect(isCollapsed("group:g1")).toBe(false);
    expect(screen.getByTestId("a")).toHaveTextContent("expanded");
  });

  it("CO4b 只有 setItem 丟例外（getItem 正常、沒有該鍵）：toggle 後收合，再 toggle 回展開", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(throwQuota);
    render(<Probe id="a" />);
    fireEvent.click(screen.getByTestId("a"));
    expect(localStorage.getItem("sidebar.collapsed.group:g1")).toBeNull();
    expect(isCollapsed("group:g1")).toBe(true);
    expect(screen.getByTestId("a")).toHaveTextContent("collapsed");
    fireEvent.click(screen.getByTestId("a"));
    expect(isCollapsed("group:g1")).toBe(false);
    expect(screen.getByTestId("a")).toHaveTextContent("expanded");
  });

  it("CO4c setItem 失敗記進覆蓋層後恢復正常：再 toggle 寫進 localStorage、覆蓋層該鍵刪掉（外部改動讀得到）", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(throwQuota);
    render(<Probe id="a" />);
    fireEvent.click(screen.getByTestId("a")); // 覆蓋層：收合
    fireEvent.click(screen.getByTestId("a")); // removeItem 成功 → 覆蓋層刪鍵、展開
    setItem.mockRestore();
    fireEvent.click(screen.getByTestId("a")); // setItem 成功 → 寫入、覆蓋層刪鍵
    expect(localStorage.getItem("sidebar.collapsed.group:g1")).toBe("1");
    expect(isCollapsed("group:g1")).toBe(true);
    localStorage.removeItem("sidebar.collapsed.group:g1");
    expect(isCollapsed("group:g1")).toBe(false);
  });

  it("CO-F1 資料夾鍵：setCollapsed(\"folder:a\", true) 寫 sidebar.collapsed.folder:a=\"1\"；與 group:a 互不影響", () => {
    setCollapsed("folder:a", true);
    expect(localStorage.getItem("sidebar.collapsed.folder:a")).toBe("1");
    expect(isCollapsed("folder:a")).toBe(true);
    expect(isCollapsed("group:a")).toBe(false);
    setCollapsed("group:a", true);
    setCollapsed("folder:a", false);
    expect(localStorage.getItem("sidebar.collapsed.folder:a")).toBeNull();
    expect(isCollapsed("folder:a")).toBe(false);
    expect(isCollapsed("group:a")).toBe(true);
  });

  it("CO5 useCollapseVersion：任一鍵 toggle 後重繪，別的鍵的元件不受影響", () => {
    let versionRenders = 0;
    let otherRenders = 0;
    function VersionProbe() {
      versionRenders += 1;
      return <span data-testid="version">{useCollapseVersion()}</span>;
    }
    function OtherProbe() {
      otherRenders += 1;
      const [expanded] = useCollapsed("group:g2");
      return <span>{expanded ? "open" : "closed"}</span>;
    }
    render(
      <>
        <Probe id="a" />
        <VersionProbe />
        <OtherProbe />
      </>,
    );
    const versionBefore = versionRenders;
    const otherBefore = otherRenders;
    const shown = Number(screen.getByTestId("version").textContent);
    fireEvent.click(screen.getByTestId("a"));
    expect(versionRenders).toBe(versionBefore + 1);
    expect(Number(screen.getByTestId("version").textContent)).toBeGreaterThan(shown);
    expect(otherRenders).toBe(otherBefore);
  });
});
