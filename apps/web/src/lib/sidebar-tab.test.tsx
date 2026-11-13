import { memo, useRef, useState, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { OVERLAY_QUERY } from "@/lib/layout-tiers";
import { SidebarDrawerContext } from "@/lib/sidebar-drawer";
import { onSearchMarkClear } from "@/hooks/search-mark";
import { EMPTY_SELECTION } from "./sidebar-selection";
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
      matches: query === OVERLAY_QUERY ? matches : false,
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
  it("tab 列順序", () => {
    expect(SIDEBAR_TABS).toEqual(["recent", "favorites", "myNotes", "workspace", "shared", "trash"]);
  });

  it("預設 tab 仍是我的筆記（最愛排第二，不是預設）", () => {
    expect(DEFAULT_SIDEBAR_TAB).toBe("myNotes");
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

  it("ST1b：trash 是合法值", () => {
    localStorage.setItem("sidebar.tab", "trash");
    expect(readSidebarTab()).toBe("trash");
  });

  it.each(["bogus", ""])("無效值 %j → 預設", (raw) => {
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

  it("選了最愛 → 寫進 storage；卸載重掛後仍是最愛", () => {
    const first = render(
      <SidebarTabProvider>
        <Probe />
      </SidebarTabProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "go-favorites" }));
    expect(screen.getByTestId("tab")).toHaveTextContent("favorites");
    expect(localStorage.getItem("sidebar.tab")).toBe("favorites");
    first.unmount();
    render(
      <SidebarTabProvider>
        <Probe />
      </SidebarTabProvider>,
    );
    expect(screen.getByTestId("tab")).toHaveTextContent("favorites");
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

function SelectionProbe() {
  const { selection } = useSidebarTabState();
  const { showTab, updateSelection } = useSidebarTabActions();
  return (
    <>
      <span data-testid="active">{String(selection.active)}</span>
      <span data-testid="keys">{[...selection.keys].join(",")}</span>
      <button type="button" onClick={() => updateSelection({ type: "start" })}>
        start
      </button>
      <button type="button" onClick={() => updateSelection({ type: "toggle", key: "note:a" })}>
        toggle-a
      </button>
      <button type="button" onClick={() => showTab("myNotes")}>
        show-myNotes
      </button>
      <button type="button" onClick={() => showTab("recent")}>
        show-recent
      </button>
    </>
  );
}

describe("選取狀態", () => {
  function startWithA() {
    render(
      <SidebarTabProvider>
        <SelectionProbe />
      </SidebarTabProvider>,
    );
    expect(screen.getByTestId("active")).toHaveTextContent("false");
    fireEvent.click(screen.getByRole("button", { name: "start" }));
    fireEvent.click(screen.getByRole("button", { name: "toggle-a" }));
    expect(screen.getByTestId("active")).toHaveTextContent("true");
    expect(screen.getByTestId("keys")).toHaveTextContent("note:a");
  }

  it("ST8a：選取在 provider；點目前所在的 tab 不結束選取", () => {
    startWithA(); // 預設在 myNotes
    fireEvent.click(screen.getByRole("button", { name: "show-myNotes" }));
    expect(screen.getByTestId("active")).toHaveTextContent("true");
    expect(screen.getByTestId("keys")).toHaveTextContent("note:a");
  });

  it("ST8b：換到別的 tab 才結束選取", () => {
    startWithA();
    fireEvent.click(screen.getByRole("button", { name: "show-recent" }));
    expect(screen.getByTestId("active")).toHaveTextContent("false");
    expect(screen.getByTestId("keys")).toBeEmptyDOMElement();
  });

  it("ST9：endSelectionIfActive 選取中回 true 並結束；再呼叫回 false", () => {
    let actions: SidebarTabActions | null = null;
    const Grab = () => {
      actions = useSidebarTabActions();
      return null;
    };
    render(
      <SidebarTabProvider>
        <Grab />
        <SelectionProbe />
      </SidebarTabProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "start" }));
    fireEvent.click(screen.getByRole("button", { name: "toggle-a" }));
    let first: boolean | undefined;
    act(() => {
      first = (actions as SidebarTabActions | null)?.endSelectionIfActive();
    });
    expect(first).toBe(true);
    expect(screen.getByTestId("active")).toHaveTextContent("false");
    let second: boolean | undefined;
    act(() => {
      second = (actions as SidebarTabActions | null)?.endSelectionIfActive();
    });
    expect(second).toBe(false);
    expect(screen.getByTestId("active")).toHaveTextContent("false");
  });

  it("ST10：start、toggle 三次、end 之後，只消費 actions 的 memo 元件不重繪、actions 同一物件", () => {
    let renders = 0;
    const seen: SidebarTabActions[] = [];
    const Counter = memo(function Counter() {
      renders += 1;
      seen.push(useSidebarTabActions());
      return null;
    });
    let actions: SidebarTabActions | null = null;
    const Grab = () => {
      actions = useSidebarTabActions();
      return null;
    };
    render(
      <SidebarTabProvider>
        <Grab />
        <SelectionProbe />
        <Counter />
      </SidebarTabProvider>,
    );
    const mounted = renders;
    fireEvent.click(screen.getByRole("button", { name: "start" }));
    for (let i = 0; i < 3; i += 1) fireEvent.click(screen.getByRole("button", { name: "toggle-a" }));
    expect(screen.getByTestId("keys")).toHaveTextContent("note:a");
    act(() => {
      (actions as SidebarTabActions | null)?.endSelectionIfActive();
    });
    expect(screen.getByTestId("active")).toHaveTextContent("false");
    expect(renders).toBe(mounted);
    expect(seen.length).toBe(mounted);
    for (const a of seen) expect(a).toBe(seen[0]);
    expect(actions).toBe(seen[0]);
  });

  it("ST11：actionsRef 指向 useSidebarTabActions() 的同一物件，重繪後不變", () => {
    let fromHook: SidebarTabActions | null = null;
    let ref: { current: SidebarTabActions | null } | null = null;
    const Grab = () => {
      fromHook = useSidebarTabActions();
      return null;
    };
    function Host() {
      const actionsRef = useRef<SidebarTabActions | null>(null);
      ref = actionsRef;
      const [n, setN] = useState(0);
      return (
        <SidebarTabProvider actionsRef={actionsRef}>
          <button type="button" data-n={n} onClick={() => setN(n + 1)}>
            host-rerender
          </button>
          <Grab />
          <SelectionProbe />
        </SidebarTabProvider>
      );
    }
    render(<Host />);
    const current = () => (ref as { current: SidebarTabActions | null } | null)?.current;
    expect(fromHook).not.toBeNull();
    expect(current()).toBe(fromHook);
    const first = current();
    fireEvent.click(screen.getByRole("button", { name: "host-rerender" }));
    fireEvent.click(screen.getByRole("button", { name: "start" }));
    expect(current()).toBe(first);
    expect(current()).toBe(fromHook);
  });

  it("ST12：無 provider → endSelectionIfActive 回 false 不 throw；selection 是 EMPTY_SELECTION", () => {
    const actions = renderHook(() => useSidebarTabActions()).result.current;
    expect(actions.endSelectionIfActive()).toBe(false);
    expect(() => actions.updateSelection({ type: "start" })).not.toThrow();
    expect(renderHook(() => useSidebarTabState()).result.current.selection).toBe(EMPTY_SELECTION);
  });

  it("ST13：getSelectionSession 非選取中為 null；start 後為 n、toggle 不變、end 後 null；再 start 是不同的 n+1", () => {
    let actions: SidebarTabActions | null = null;
    const Grab = () => {
      actions = useSidebarTabActions();
      return null;
    };
    render(
      <SidebarTabProvider>
        <Grab />
        <SelectionProbe />
      </SidebarTabProvider>,
    );
    const session = () => (actions as SidebarTabActions | null)?.getSelectionSession();
    expect(session()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "start" }));
    const n = session();
    expect(typeof n).toBe("number");
    fireEvent.click(screen.getByRole("button", { name: "toggle-a" }));
    expect(session()).toBe(n);
    act(() => {
      (actions as SidebarTabActions | null)?.endSelectionIfActive();
    });
    expect(session()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "start" }));
    expect(session()).toBe((n as number) + 1);
    expect(renderHook(() => useSidebarTabActions()).result.current.getSelectionSession()).toBeNull();
  });
});

describe("搜尋跳轉的常駐標記：切到別的 tab ＝離開搜尋 → 清", () => {
  it("showTab 切到不同的 tab → 清一次；切到同一個 tab → 不清", () => {
    stubMatchMedia(false);
    const cleared = vi.fn();
    const off = onSearchMarkClear(cleared);
    try {
      render(
        <SidebarTabProvider>
          <Probe />
        </SidebarTabProvider>,
      );
      const current = screen.getByTestId("tab").textContent as SidebarTab;
      fireEvent.click(screen.getByText(`go-${current}`));
      expect(cleared).not.toHaveBeenCalled();
      const other = SIDEBAR_TABS.find((t) => t !== current)!;
      fireEvent.click(screen.getByText(`go-${other}`));
      expect(cleared).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });
});
