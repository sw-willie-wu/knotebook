import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { ThemeProvider } from "@/theme";
import { __resetCollapseForTests } from "@/components/sidebar/collapse";
import { personalNote } from "@/test/select-fixtures";
import { AppShell } from "./AppShell";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

// 一般 tab 選取模式的 lazy chunk（SelectLazy）還沒到時，AppShell 裡清單與底部的佔位（#181 PR-2c T6 AL1）：讓 SelectLazy 的
// 載入卡在手動放行的 promise 上（照 AppShell.trash-lazy.test.tsx）。
// ⚠ gate 只擋得住 SidebarFooter 與 NoteList 的第一支 import（標題列）：NoteList 同一次 render 對 SelectLazy 發兩支 `import()`，
// vitest 3.2.7 同一個 importer 的並發 import 有一支繞過 factory、直接載真模組（同 AppShell.select-lazy-error.test.tsx 檔頭），
// 所以清單那支**不受 gate 控制**。放行前「清單是平常的列」成立，只是因為真 import 要走好幾輪才到、撐不過一次 act flush——
// **放行前不要加任何等待（waitFor／find*／計時）**，否則清單會先換成勾選樹，斷言變紅或變成空真。

const gate = vi.hoisted(() => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
});

vi.mock("@/components/sidebar/SelectLazy", async (importOriginal) => {
  await gate.promise;
  return importOriginal();
});

afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
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

const NOTES = [personalNote({ id: "p1", title: "p1" }), personalNote({ id: "p2", title: "p2" })];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse([]));
      if (url === "/api/auth/me") return Promise.resolve(fakeResponse(USER));
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse(NOTES));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

const aside = () => document.querySelector("aside") as HTMLElement;
const header = () => aside().querySelector("[data-sidebar-header]") as HTMLElement;

describe("AppShell — 一般 tab 選取 chunk 載入中的佔位", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("AL1 chunk 還沒到：清單是平常的列、底部是同高空位（沒有 New note）；放行後換成勾選框與動作列", async () => {
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
    await within(aside()).findByRole("link", { name: "p1" });
    fireEvent.click(within(header()).getByRole("button", { name: "Select" }));
    // 只 flush 一次（見檔頭 ⚠）：清單那支 import 繞過 gate，多等就會載到真的勾選樹。
    await act(async () => {});

    const panel = within(aside()).getByRole("tabpanel");
    expect(within(panel).getByRole("link", { name: "p1" })).toBeInTheDocument();
    expect(within(panel).getByRole("link", { name: "p2" })).toBeInTheDocument();
    expect(within(panel).queryAllByRole("checkbox")).toHaveLength(0);
    expect(within(header()).queryByRole("button", { name: "Done" })).toBeNull();
    // SidebarFooter 的佔位：與動作列同高的空位，不是「新增筆記」
    expect(aside().querySelector(":scope > div.m-2.h-8")).not.toBeNull();
    expect(within(aside()).queryByRole("button", { name: "New note" })).toBeNull();

    await act(async () => {
      gate.release();
    });
    expect(await within(panel).findAllByRole("checkbox")).toHaveLength(2);
    expect(await within(aside()).findByRole("button", { name: "Copy to" })).toBeInTheDocument();
    expect(aside().querySelector(":scope > div.m-2.h-8")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
