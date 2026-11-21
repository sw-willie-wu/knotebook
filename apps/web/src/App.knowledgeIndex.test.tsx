import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { AppRoutes } from "./App";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

/** Wiring of the three `/knowledge/...` routes: they mount the lazy index page inside the sidebar layout, with their own chunk-reload quota. The page itself is covered in KnowledgeIndexPage.test.tsx. */

const mockPage = vi.hoisted(() => ({ mode: "ok" as "ok" | "throw" }));

vi.mock("./pages/KnowledgeIndexPage", () => ({
  default: function KnowledgeIndexPageMock() {
    if (mockPage.mode === "throw") throw new Error("Failed to fetch dynamically imported module: https://x/assets/KnowledgeIndexPage-abc.js");
    return <p>knowledge-index-mock</p>;
  },
}));

const FLAG_KEY = "knotebook:chunk-reload:knowledge-index";
const USER: UserDto = {
  id: "u1",
  email: "a@example.com",
  handle: "tester",
  displayName: "Ann",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
  avatar: null,
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/me") return Promise.resolve(json(USER));
      if (url === "/api/folders") return Promise.resolve(json(FOLDER_LIST_EMPTY));
      if (url === "/api/groups" || url === "/api/notes" || url === "/api/favorites") return Promise.resolve(json([]));
      return Promise.resolve(new Response("{}", { status: 404 }));
    }),
  );
}

function renderAt(path: string) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[path]}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(async () => {
  sessionStorage.clear();
  mockPage.mode = "ok";
  await i18n.changeLanguage("en");
  stubFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("App route tree - knowledge index routes", () => {
  it.each(["/knowledge/me", "/knowledge/g/9f3c", "/knowledge/f/9f3c"])("%s mounts the index page and clears the reload flag", async (path) => {
    sessionStorage.setItem(FLAG_KEY, "1");
    renderAt(path);
    await waitFor(() => expect(screen.getByText("knowledge-index-mock")).toBeInTheDocument());
    expect(sessionStorage.getItem(FLAG_KEY)).toBeNull();
  });

  it("/knowledge alone is not an index route", async () => {
    renderAt("/knowledge");
    await waitFor(() => expect(screen.getByRole("tablist")).toBeInTheDocument());
    expect(screen.queryByText("knowledge-index-mock")).toBeNull();
  });

  it("a chunk error with the reload flag already set shows the chunk-error screen with a retry button", async () => {
    sessionStorage.setItem(FLAG_KEY, "1");
    mockPage.mode = "throw";
    vi.stubGlobal("location", { ...window.location, reload: vi.fn() });
    renderAt("/knowledge/me");
    await waitFor(() =>
      expect(screen.getByText("Couldn't load this page — check your connection, or a new version may have been deployed.")).toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});
