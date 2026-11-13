import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import i18n from "@/i18n";
import { SidebarDrawerContext } from "@/lib/sidebar-drawer";
import { stubLayoutTier } from "@/test/layout-tier";
import HomePage from "./HomePage";

function renderHome() {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) } as unknown as Response)),
  );
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <SidebarDrawerContext.Provider value={{ setOpen: () => {} }}>
          <HomePage />
        </SidebarDrawerContext.Provider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("HomePage 手機", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("手機：不渲染空狀態卡與頂列（清單蓋滿畫面）", async () => {
    stubLayoutTier("phone");
    const { container } = renderHome();
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it.each(["overlay", "docked"] as const)("%s：照舊顯示空狀態", async (tier) => {
    stubLayoutTier(tier);
    renderHome();
    expect(await screen.findByText("No notes yet.")).toBeInTheDocument();
  });
});
