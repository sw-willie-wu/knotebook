import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { canonicalNotePath, type NoteDto, type UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { AppShell } from "./AppShell";

// Task 12 review 指派給 Task 13 的第三項待辦：`/notes/:ref` 這條路由存在之後，
// 「新增筆記 → 導向新筆記頁」這件事才驗得起來（在此之前所有連結都落在 catch-all）。

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const USER: UserDto = { id: "u1", email: "a@example.com", displayName: "Ann", isAdmin: false };

const CREATED: NoteDto = {
  id: "33333333-3333-3333-3333-333333333333",
  title: "Untitled",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: null,
};

/** 停在 `/notes/:ref` 的替身頁——只把解析到的 ref 印出來，讓斷言看得到落點。 */
function NoteRouteProbe() {
  const { ref } = useParams<{ ref: string }>();
  return <div data-testid="note-route">{ref}</div>;
}

describe("AppShell — new note", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("navigates to the created note's canonical path after POST /api/notes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/auth/me") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
        }
        if (url === "/api/notes" && method === "POST") {
          return Promise.resolve(fakeResponse({ ok: true, status: 201, json: () => Promise.resolve(CREATED) }));
        }
        if (url === "/api/notes" && method === "GET") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <Routes>
              <Route path="/" element={<AppShell>home</AppShell>} />
              <Route path="/notes/:ref" element={<NoteRouteProbe />} />
            </Routes>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "New note" }));

    // 新筆記沒有自訂 slug、標題是 "Untitled" → canonical 是 `Untitled-<uuid>`。
    const expectedRef = canonicalNotePath(CREATED).replace("/notes/", "");
    await waitFor(() => expect(screen.getByTestId("note-route")).toHaveTextContent(expectedRef));
  });

  it("shows an error toast and stays put when POST /api/notes fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/notes" && method === "POST") {
          return Promise.resolve(
            fakeResponse({
              ok: false,
              status: 500,
              json: () => Promise.resolve({ error: { code: "internal", message: "boom" } }),
            }),
          );
        }
        if (url === "/api/auth/me") {
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
        }
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }),
    );

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={["/"]}>
            <Routes>
              <Route path="/" element={<AppShell>home</AppShell>} />
              <Route path="/notes/:ref" element={<NoteRouteProbe />} />
            </Routes>
          </MemoryRouter>
          <Toaster />
        </ThemeProvider>
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "New note" }));

    await waitFor(() => expect(screen.getByText("Something went wrong. Please try again.")).toBeInTheDocument());
    expect(screen.queryByTestId("note-route")).not.toBeInTheDocument();
  });
});
