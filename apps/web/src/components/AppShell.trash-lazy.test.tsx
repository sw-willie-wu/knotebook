import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { ThemeProvider } from "@/theme";
import { AppShell } from "./AppShell";
import { trashList } from "@/test/trash-fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

// 垃圾桶 tab 的 lazy chunk（TrashLazy）還沒到時的兩個 Suspense 佔位（T9 fix r2 N-1）：jsdom 下 import 幾乎即到、量不到佔位，
// 所以讓 TrashLazy 的載入卡在手動放行的 promise 上。

const gate = vi.hoisted(() => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
});

vi.mock("@/components/sidebar/TrashLazy", async (importOriginal) => {
  await gate.promise;
  return importOriginal();
});

afterEach(() => {
  localStorage.clear();
});

function fakeResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

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

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse([]));
      if (url === "/api/auth/me") return Promise.resolve(fakeResponse(USER));
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse([]));
      if (url === "/api/trash" && method === "GET") return Promise.resolve(fakeResponse(trashList([], { retentionDays: 7 })));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

const aside = () => document.querySelector("aside") as HTMLElement;

describe("AppShell — 垃圾桶 chunk 載入中的佔位", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("TL1 chunk 還沒到：tabpanel 是「Trash＋Loading…」、底部是同高空位（沒有 New note）；放行後換成真面板與保留天數說明", async () => {
    stubFetch();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <ActiveNoteProvider>
              <Routes>
                <Route path="/" element={<AppShell>{null}</AppShell>} />
              </Routes>
            </ActiveNoteProvider>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
    fireEvent.click(await within(aside()).findByRole("tab", { name: "Trash" }));

    // TrashPanelFallback（X4：改成 null → 紅）
    const panel = within(aside()).getByRole("tabpanel");
    expect(within(panel).getByText("Trash", { exact: true })).toBeInTheDocument();
    expect(within(panel).getByText("Loading…", { exact: true })).toBeInTheDocument();
    expect(panel.querySelector("[data-sidebar-header]")).toBeNull();
    // SidebarFooter 的佔位（X3：改成 null → 紅）：底部是 h-7 的空位，不是「新增筆記」也不是說明句
    expect(aside().querySelector(":scope > div.h-7")).not.toBeNull();
    expect(within(aside()).queryByRole("button", { name: "New note" })).toBeNull();
    expect(within(aside()).queryByTestId("trash-footer")).toBeNull();

    await act(async () => {
      gate.release();
    });
    expect(await within(panel).findByText("The trash is empty.", { exact: true })).toBeInTheDocument();
    expect(panel.querySelector("[data-sidebar-header]")).toHaveTextContent("Trash · 0 notes");
    expect(await within(aside()).findByTestId("trash-footer")).toHaveTextContent("Permanently deleted 7 days after deletion");
    expect(aside().querySelector(":scope > div.h-7")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
