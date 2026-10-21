import { memo, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { NARROW_QUERY, SidebarDrawerContext } from "@/lib/sidebar-drawer";
import {
  DEFAULT_SIDEBAR_TAB,
  SIDEBAR_TABS,
  SidebarTabProvider,
  readSidebarTab,
  useSidebarTabActions,
  useSidebarTabState,
  writeSidebarTab,
  type SidebarTab,
  type SidebarTabActions,
} from "./sidebar-tab";

afterEach(() => {
  localStorage.removeItem("sidebar.tab");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

function Probe() {
  const { tab } = useSidebarTabState();
  const { showTab } = useSidebarTabActions();
  return (
    <>
      <span data-testid="tab">{tab}</span>
      {SIDEBAR_TABS.map((t) => (
        <button key={t} type="button" onClick={() => showTab(t)}>
          go-{t}
        </button>
      ))}
    </>
  );
}

describe("常數", () => {
  it("tab 列順序、窄螢幕判準", () => {
    expect(SIDEBAR_TABS).toEqual(["recent", "myNotes", "workspace", "shared"]);
    expect(NARROW_QUERY).toBe("(width < 48rem)");
  });
});

describe("readSidebarTab", () => {
  it("缺鍵 → 預設", () => {
    expect(readSidebarTab()).toBe("myNotes");
  });

  it.each(SIDEBAR_TABS)("合法值 %s 回自己", (tab) => {
    localStorage.setItem("sidebar.tab", tab);
    expect(readSidebarTab()).toBe(tab);
  });

  it.each(["trash", "bogus", ""])("無效值 %j → 預設（trash 在步驟 1 視同無效）", (raw) => {
    localStorage.setItem("sidebar.tab", raw);
    expect(readSidebarTab()).toBe("myNotes");
  });

  it("getItem 丟例外 → 預設", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readSidebarTab()).toBe("myNotes");
  });
});

describe("writeSidebarTab", () => {
  it("setItem 丟例外時不 throw", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => writeSidebarTab("workspace")).not.toThrow();
  });

  it("正常寫入", () => {
    writeSidebarTab("workspace");
    expect(localStorage.getItem("sidebar.tab")).toBe("workspace");
  });
});

describe("SidebarTabProvider", () => {
  it("預存 shared → probe 顯示 shared；showTab 切換並寫入 storage", () => {
    localStorage.setItem("sidebar.tab", "shared");
    render(
      <SidebarTabProvider>
        <Probe />
      </SidebarTabProvider>,
    );
    expect(screen.getByTestId("tab")).toHaveTextContent("shared");
    fireEvent.click(screen.getByRole("button", { name: "go-recent" }));
    expect(screen.getByTestId("tab")).toHaveTextContent("recent");
    expect(localStorage.getItem("sidebar.tab")).toBe("recent");
  });

  it("setItem 丟例外時 showTab 仍切換", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    let actions: SidebarTabActions | null = null;
    const Grab = () => {
      actions = useSidebarTabActions();
      return null;
    };
    render(
      <SidebarTabProvider>
        <Grab />
        <Probe />
      </SidebarTabProvider>,
    );
    // 直接呼叫：同步丟出的例外會從 act 冒出來，不會被 jsdom 當成 window error 吞掉。
    act(() => {
      (actions as SidebarTabActions | null)?.showTab("workspace");
    });
    expect(screen.getByTestId("tab")).toHaveTextContent("workspace");
  });
});

describe("無 provider", () => {
  it("actions 兩次 render 同一物件、showTab 不 throw；state 為預設", () => {
    const { result, rerender } = renderHook(() => useSidebarTabActions());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    expect(() => result.current.showTab("shared")).not.toThrow();
    expect(renderHook(() => useSidebarTabState()).result.current.tab).toBe("myNotes");
    expect(DEFAULT_SIDEBAR_TAB).toBe("myNotes");
  });
});

describe("actions 穩定", () => {
  it("provider 重繪、切 tab 後，只消費 actions 的 memo 元件不重繪、actions 同一物件", () => {
    let renders = 0;
    const seen: SidebarTabActions[] = [];
    const Counter = memo(function Counter() {
      renders += 1;
      seen.push(useSidebarTabActions());
      return null;
    });
    function Harness() {
      const [n, setN] = useState(0);
      const { showTab } = useSidebarTabActions();
      return (
        <>
          <button type="button" onClick={() => setN(n + 1)}>
            rerender
          </button>
          <button type="button" onClick={() => showTab(n % 2 ? "recent" : "shared")}>
            switch
          </button>
        </>
      );
    }
    function Outer() {
      const [n, setN] = useState(0);
      return (
        <SidebarTabProvider>
          <span data-n={n} />
          <button type="button" onClick={() => setN(n + 1)}>
            outer
          </button>
          <Harness />
          <Counter />
        </SidebarTabProvider>
      );
    }
    render(<Outer />);
    const mounted = renders;
    for (let i = 0; i < 3; i += 1) {
      fireEvent.click(screen.getByRole("button", { name: "outer" }));
      fireEvent.click(screen.getByRole("button", { name: "rerender" }));
      fireEvent.click(screen.getByRole("button", { name: "switch" }));
    }
    expect(renders).toBe(mounted);
    expect(seen.length).toBe(mounted);
    for (const actions of seen) expect(actions).toBe(seen[0]);
  });
});

function withDrawer(spy: (open: boolean) => void, children: ReactNode) {
  return <SidebarDrawerContext.Provider value={{ setOpen: spy }}>{children}</SidebarDrawerContext.Provider>;
}

describe("showTab 窄螢幕開抽屜", () => {
  it("窄 → setOpen(true) 恰一次", () => {
    stubMatchMedia(true);
    const spy = vi.fn();
    render(
      withDrawer(
        spy,
        <SidebarTabProvider>
          <Probe />
        </SidebarTabProvider>,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "go-workspace" }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(true);
  });

  it("寬 → 不呼叫", () => {
    stubMatchMedia(false);
    const spy = vi.fn();
    render(
      withDrawer(
        spy,
        <SidebarTabProvider>
          <Probe />
        </SidebarTabProvider>,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "go-workspace" }));
    expect(spy).not.toHaveBeenCalled();
  });

  it("抽屜 context 換物件：actions 仍同一個、showTab 呼叫新的 setOpen", () => {
    stubMatchMedia(true);
    const spy = vi.fn();
    const spy2 = vi.fn();
    let actions: SidebarTabActions | null = null;
    const Grab = () => {
      const a = useSidebarTabActions();
      if (actions === null) actions = a;
      else expect(a).toBe(actions);
      return null;
    };
    const tree = (s: (open: boolean) => void) =>
      withDrawer(
        s,
        <SidebarTabProvider>
          <Grab />
          <Probe />
        </SidebarTabProvider>,
      );
    const { rerender } = render(tree(spy));
    rerender(tree(spy2));
    act(() => {
      (actions as SidebarTabActions | null)?.showTab("shared" satisfies SidebarTab);
    });
    expect(spy2).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
  });
});
