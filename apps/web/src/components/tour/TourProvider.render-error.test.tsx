import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import i18n from "@/i18n";
import "@/i18n/tour-strings";
import { AppErrorBoundary } from "@/components/ErrorBoundary";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { useTour, type TourApi } from "@/lib/tour-context";
import { TourProvider } from "./TourProvider";

// 導覽元件 render 時拋錯，直到測試把開關關掉；之後的一輪正常 render：看出錯那一輪是否只收掉導覽、不拖垮整個 app。
const lazy = vi.hoisted(() => ({ crash: true }));
vi.mock("./TourLazy", () => ({
  TourLazy: () => {
    if (lazy.crash) throw new Error("tour render failed");
    return <div data-testid="tour-ok" />;
  },
}));

let tour: TourApi | null = null;
function Probe() {
  tour = useTour();
  return null;
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  lazy.crash = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  dismissAllToasts();
  vi.restoreAllMocks();
});

describe("導覽元件 render 拋錯", () => {
  it("app 其他部分仍在、不進兜底畫面；這一輪結束並跳一則提示，下一次開始照常", async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter initialEntries={["/"]}>
          <AppErrorBoundary>
            <TourProvider>
              <Probe />
              <p>app content</p>
            </TourProvider>
          </AppErrorBoundary>
          <Toaster />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const start = () => act(() => tour!.start({ returnTo: "/", returnFocus: () => null }));

    start();
    expect(await screen.findByText("The feature tour ran into a problem and was closed.")).toBeTruthy();
    expect(screen.getByText("app content")).toBeTruthy();
    expect(screen.queryByText(i18n.t("app.crashTitle"))).toBeNull();
    expect(screen.queryByTestId("tour-ok")).toBeNull();

    lazy.crash = false;
    // 這一輪已經結束：能再開始，而且是全新的一輪。
    start();
    await waitFor(() => expect(screen.getByTestId("tour-ok")).toBeTruthy());
    expect(screen.getByText("app content")).toBeTruthy();
  });
});
