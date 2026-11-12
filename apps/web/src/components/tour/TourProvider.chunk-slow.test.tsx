import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import i18n from "@/i18n";
import { toast } from "@/components/ui/toast";
import { useTour, type TourApi } from "@/lib/tour-context";
import { START_TIMEOUT_MS, TourProvider } from "./TourProvider";

// 導覽 chunk 下載得很慢：到 15 秒上限時還沒載到。chunk 載到之後的流程在 TourProvider.test.tsx。
const chunk = vi.hoisted(() => {
  let release = () => {};
  const arrived = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { arrived, release: () => release() };
});
vi.mock("./TourLazy", async (importOriginal) => {
  await chunk.arrived;
  return importOriginal();
});

vi.mock("@/components/ui/toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/ui/toast")>();
  return { ...actual, toast: vi.fn(actual.toast) };
});
const toastSpy = vi.mocked(toast);
const toastTitles = () => toastSpy.mock.calls.map(([item]) => item.title);

let posts = 0;
let tour: TourApi | null = null;

function Probe() {
  tour = useTour();
  return null;
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  posts = 0;
  toastSpy.mockClear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "/api/notes" && (init?.method ?? "GET").toUpperCase() === "POST") posts += 1;
      // 建示範筆記一律失敗：這裡只要看到 chunk 載到之後開始流程真的跑了，不必走完。
      return new Response(JSON.stringify({ error: { code: "internal", message: "x" } }), {
        status: 500,
        headers: { "Content-Type": "application/json" },
      });
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("導覽 chunk 到上限時還沒載到", () => {
  it("一則載入失敗的提示；chunk 之後才到也不會自己開始；再按一次照常開始", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"], shouldAdvanceTime: true });
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={["/"]}>
          <TourProvider>
            <Probe />
          </TourProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const start = () => act(() => tour!.start({ returnTo: "/", returnFocus: () => null }));

    start();
    await new Promise((r) => setTimeout(r, 50));
    act(() => vi.advanceTimersByTime(START_TIMEOUT_MS + 10));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    expect(toastTitles()).toEqual([i18n.t("app.chunkLoadError")]);

    chunk.release();
    await new Promise((r) => setTimeout(r, 300));
    expect(posts).toBe(0);
    expect(toastTitles()).toEqual([i18n.t("app.chunkLoadError")]);
    expect(document.querySelector("[data-tour-overlay]")).toBeNull();

    start();
    await waitFor(() => expect(posts).toBe(1));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(2));
    expect(toastTitles()).toEqual([i18n.t("app.chunkLoadError"), "Couldn't create the sample note. Try again."]);
  });
});
