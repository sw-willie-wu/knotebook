import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import i18n from "@/i18n";
import { toast } from "@/components/ui/toast";
import { useTour, type TourApi } from "@/lib/tour-context";
import { TourProvider } from "./TourProvider";

// 導覽 chunk 第一次下載失敗、第二次成功（部署換版或網路斷一下之後重試）。chunk 載到之後的流程在 TourProvider.test.tsx。
const chunk = vi.hoisted(() => ({ attempts: 0 }));
vi.mock("./TourLazy", async (importOriginal) => {
  chunk.attempts += 1;
  if (chunk.attempts === 1) throw new TypeError("Failed to fetch dynamically imported module");
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("導覽 chunk 下載失敗", () => {
  it("一則載入失敗的提示、不建示範筆記；下一次開始重新下載，載到之後照常開始", async () => {
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
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 200));
    expect(toastTitles()).toEqual([i18n.t("app.chunkLoadError")]);
    expect(posts).toBe(0);

    start();
    await waitFor(() => expect(posts).toBe(1));
    expect(chunk.attempts).toBe(2);
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(2));
    // 第二則是 chunk 裡的流程自己跳的（建示範筆記失敗），不是又一則載入失敗。
    expect(toastTitles()).toEqual([i18n.t("app.chunkLoadError"), "Couldn't create the sample note. Try again."]);
  });
});
