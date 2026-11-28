import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { stubLayoutTier, type LayoutTier } from "@/test/layout-tier";
import { ThemeProvider } from "@/theme";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { trashList } from "@/test/trash-fixtures";
import { putUpload, resetUploadQueueForTest } from "@/uploads/upload-queue-store";
import { SIDEBAR_PANEL_ANCHOR_ATTR } from "./ui/panel-shell";
import { AppShell } from "./AppShell";

const USER = { id: "u1", email: "alice@example.com", handle: "alice", displayName: "Alice", isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true, avatar: null } satisfies UserDto;

function fakeResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/auth/me") return Promise.resolve(fakeResponse(USER));
      if (url === "/api/groups") return Promise.resolve(fakeResponse([]));
      if (url === "/api/folders") return Promise.resolve(fakeResponse(FOLDER_LIST_EMPTY));
      if (url === "/api/notes") return Promise.resolve(fakeResponse([]));
      if (url === "/api/trash") return Promise.resolve(fakeResponse(trashList([], { retentionDays: 7 })));
      if (url === "/api/favorites") return Promise.resolve(fakeResponse([]));
      if (url === "/api/notifications/unread-count") return Promise.resolve(fakeResponse({ count: 0 }));
      return new Promise<Response>(() => {});
    }),
  );
}

function renderShell(tier: LayoutTier) {
  stubLayoutTier(tier);
  stubFetch();
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/"]}>
          <ActiveNoteProvider>
            <Routes>
              <Route path="*" element={<AppShell>{null}</AppShell>} />
            </Routes>
          </ActiveNoteProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

const uploading = () =>
  putUpload({ id: "a", noteId: "n", blockId: "b", fileName: "clip.mp4", size: 100, loaded: 40, expectedUrl: "", status: "uploading" });

const pill = () => {
  const el = document.querySelector<HTMLElement>("[data-upload-indicator]");
  if (el === null) throw new Error("no upload indicator");
  return el;
};

beforeEach(async () => {
  await i18n.changeLanguage("en");
});

afterEach(() => {
  act(() => resetUploadQueueForTest());
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("AppShell: where the upload indicator sits", () => {
  it("wide: in the sidebar's bottom row, just left of the bell, and only while the queue has items", async () => {
    renderShell("docked");
    const bell = await screen.findByTestId("notification-bell");
    expect(document.querySelector("[data-upload-indicator]")).toBeNull();
    act(uploading);
    const chip = pill();
    expect(chip.closest(`[${SIDEBAR_PANEL_ANCHOR_ATTR}]`)).toBe(bell.closest(`[${SIDEBAR_PANEL_ANCHOR_ATTR}]`));
    expect(chip.parentElement).toBe(bell.parentElement);
    expect(chip.nextElementSibling).toBe(bell);
    expect(chip).toHaveTextContent("1 · 40%");
  });

  it("phone: in the top bar, just left of the bell, ring and count only", async () => {
    act(uploading);
    const { container } = renderShell("phone");
    const bell = await screen.findByTestId("notification-bell");
    const bar = container.querySelector("[data-phone-top-bar]");
    const chip = pill();
    expect(bar?.contains(chip)).toBe(true);
    expect(chip.nextElementSibling).toBe(bell);
    expect(chip).toHaveTextContent(/^1$/);
  });
});
