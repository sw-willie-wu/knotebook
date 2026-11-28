import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { pressTrigger } from "@/test/menu-trigger";
import { getUploadItems, putUpload, resetUploadQueueForTest } from "@/uploads/upload-queue-store";
import { UserMenu } from "./UserMenu";

// The uploads chunk (the log-out prompt and its strings) fails to load.
vi.mock("@/components/uploads/UploadsLazy", () =>
  Promise.reject(new TypeError("Failed to fetch dynamically imported module: http://localhost/assets/UploadsLazy-abc.js")),
);

const USER: UserDto = {
  id: "u1",
  email: "plain@example.com",
  handle: "alice",
  displayName: "Alice",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
  autoVersions: true,
  avatar: null,
};

function fakeResponse(status: number, body?: unknown): Response {
  return { ok: status < 400, status, json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)) } as unknown as Response;
}

afterEach(() => {
  resetUploadQueueForTest();
  vi.unstubAllGlobals();
});

it("with uploads running, a prompt that can't load doesn't strand the person: Log out still logs out, once", async () => {
  await i18n.changeLanguage("en");
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/api/auth/me") return Promise.resolve(fakeResponse(200, USER));
    if (url === "/api/auth/logout" && init?.method === "POST") return Promise.resolve(fakeResponse(204));
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  putUpload({ id: "x", noteId: "n", blockId: "b", fileName: "clip.mp4", size: 10, loaded: 2, expectedUrl: "", status: "uploading" });
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter>
          <Routes>
            <Route path="/" element={<UserMenu />} />
            <Route path="/login" element={<p>login page</p>} />
          </Routes>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "Alice" })).toBeInTheDocument());
  pressTrigger(screen.getByRole("button", { name: "Alice" }));
  await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("menuitem", { name: "Log out" }));

  await screen.findByText("login page");
  expect(getUploadItems()).toEqual([]);
  expect(fetchMock.mock.calls.filter(([url]) => String(url) === "/api/auth/logout")).toHaveLength(1);
  expect(screen.queryByRole("alert")).toBeNull();
});
