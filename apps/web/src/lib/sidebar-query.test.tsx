import { describe, expect, it } from "vitest";
import { act, render } from "@testing-library/react";
import { SidebarQueryProvider, useSidebarQuery } from "./sidebar-query";

describe("SidebarQueryProvider（#369）", () => {
  let api!: ReturnType<typeof useSidebarQuery>;
  function Probe({ tag }: { tag: string }) {
    api = useSidebarQuery();
    return <span data-testid={tag}>{api.query}</span>;
  }

  it("換殼（舊的 Probe 卸載、新的掛上）後搜尋字還在；沒有 provider 時退回本地 state", () => {
    const view = render(
      <SidebarQueryProvider>
        <Probe tag="a" />
      </SidebarQueryProvider>,
    );
    act(() => api.setQuery("needle"));
    view.rerender(
      <SidebarQueryProvider>
        <Probe tag="b" />
      </SidebarQueryProvider>,
    );
    expect(view.getByTestId("b").textContent).toBe("needle");
    view.unmount();

    const solo = render(<Probe tag="c" />);
    act(() => api.setQuery("x"));
    expect(solo.getByTestId("c").textContent).toBe("x");
    solo.unmount();
    expect(render(<Probe tag="d" />).getByTestId("d").textContent).toBe("");
  });

  it("claim：同一個擁有者不清、換人才清；release（登出）清掉並放掉擁有者", () => {
    const view = render(
      <SidebarQueryProvider>
        <Probe tag="a" />
      </SidebarQueryProvider>,
    );
    act(() => api.claim("u1"));
    act(() => api.setQuery("needle"));
    act(() => api.claim("u1"));
    expect(view.getByTestId("a").textContent).toBe("needle");
    act(() => api.claim("u2"));
    expect(view.getByTestId("a").textContent).toBe("");
    act(() => api.setQuery("again"));
    act(() => api.release());
    expect(view.getByTestId("a").textContent).toBe("");
  });
});
