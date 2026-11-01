import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { SidebarTabProvider } from "@/lib/sidebar-tab";
import { NoteList } from "@/components/NoteList";
import { __resetCollapseForTests } from "@/components/sidebar/collapse";
import { personalNote } from "@/test/select-fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

// 一般 tab 選取模式的 lazy chunk（SelectLazy）還沒到時的佔位（PR-2c T4 NS12）：jsdom 下 import 幾乎即到、量不到佔位，
// 所以讓 SelectLazy 的載入卡在手動放行的 promise 上（照 AppShell.trash-lazy.test.tsx）。

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

const ME: UserDto = {
  id: "u1",
  email: "tester@example.com",
  handle: "tester",
  displayName: "Tester",
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
      if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      if (url === "/api/notes" && method === "GET") return Promise.resolve(fakeResponse(NOTES));
      if (url === "/api/groups" && method === "GET") return Promise.resolve(fakeResponse([]));
      if (url === "/api/auth/me" && method === "GET") return Promise.resolve(fakeResponse(ME));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

const panel = () => screen.getByRole("tabpanel");
const header = () => panel().querySelector("[data-sidebar-header]") as HTMLElement;

describe("一般 tab 選取模式 chunk 載入中的佔位", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("NS12 chunk 還沒到：清單仍是平常的列（p1 是連結）、標題列只有名稱；放行後換成勾選框、焦點在 Done", async () => {
    stubFetch();
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <ActiveNoteProvider>
            <SidebarTabProvider>
              <div data-sidebar-instance="">
                <div role="tabpanel">
                  <NoteList />
                </div>
              </div>
            </SidebarTabProvider>
          </ActiveNoteProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await within(panel()).findByRole("link", { name: "p1" });
    fireEvent.click(within(header()).getByRole("button", { name: "Select" }));
    await act(async () => {});

    expect(within(panel()).getByRole("link", { name: "p1" })).toBeInTheDocument();
    expect(within(panel()).queryAllByRole("checkbox")).toHaveLength(0);
    expect(header()).toHaveTextContent(/^My notes$/);
    expect(within(header()).queryAllByRole("button")).toHaveLength(0);

    await act(async () => {
      gate.release();
    });
    const done = await within(header()).findByRole("button", { name: "Done" });
    expect(await within(panel()).findAllByRole("checkbox")).toHaveLength(2);
    expect(within(panel()).queryAllByRole("link")).toHaveLength(0);
    expect(done).toHaveFocus();
  });
});
