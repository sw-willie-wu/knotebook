import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useLocation } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { useSidebarQuery } from "@/lib/sidebar-query";
import { useTour } from "@/lib/tour-context";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import App from "./App";

// 包住真的 TourProvider：照常提供導覽，另在它底下放一個探針，確認它掛在 App 裡、位置在 router 與側欄搜尋字的 provider 裡面。
// 沒有側欄搜尋字的 provider 時 useSidebarQuery() 退回自己的空字串，所以要在側欄打字、看探針讀到同一個字才分得出來。
const probe = vi.hoisted(() => ({ mounted: 0, hasTour: false, path: "", query: null as string | null }));
vi.mock("@/components/tour/TourProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/tour/TourProvider")>();
  function Probe() {
    probe.hasTour = useTour() !== null;
    probe.path = useLocation().pathname;
    probe.query = useSidebarQuery().query;
    return null;
  }
  return {
    ...actual,
    TourProvider: ({ children }: { children: ReactNode }) => {
      probe.mounted += 1;
      return (
        <actual.TourProvider>
          {children}
          <Probe />
        </actual.TourProvider>
      );
    },
  };
});

const USER: UserDto = {
  id: "u1",
  email: "a@example.com",
  handle: "tester",
  displayName: "Ann",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
};

interface Call {
  method: string;
  url: string;
}
let calls: Call[] = [];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url });
      if (url === "/api/auth/me") return json(USER);
      if (url === "/api/groups") return json([]);
      if (url === "/api/folders") return json(FOLDER_LIST_EMPTY);
      if (url === "/api/notes" && method === "GET") return json([]);
      return json({ error: { code: "not_found", message: url } }, 404);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App 掛著功能導覽，但它不會自己出現", () => {
  it("登入後停在首頁：不建示範筆記、不讀 AI 動作、沒有遮罩；導覽的 context 在 router 與側欄搜尋字的 provider 裡面", async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <App />
      </QueryClientProvider>,
    );
    await screen.findByRole("button", { name: USER.displayName });
    await new Promise((r) => setTimeout(r, 300));
    expect(calls.filter((c) => c.method === "POST" && c.url === "/api/notes")).toEqual([]);
    expect(calls.filter((c) => c.url === "/api/ai/actions")).toEqual([]);
    expect(document.querySelector("[data-tour-overlay]")).toBeNull();
    expect(probe.mounted).toBeGreaterThan(0);
    expect(probe.hasTour).toBe(true);
    expect(probe.path).toBe("/");
    expect(probe.query).toBe("");

    fireEvent.change(screen.getAllByRole("textbox", { name: "Search notes" })[0]!, { target: { value: "needle" } });
    await waitFor(() => expect(probe.query).toBe("needle"));
  });
});
