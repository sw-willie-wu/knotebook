import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import type { NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts, toast, Toaster } from "@/components/ui/toast";
import { AppShell, SidebarDrawerButton } from "./AppShell";
import { OWNER_PERMS } from "@/test/fixtures";

/**
 * 窄螢幕抽屜開著時跳出的 toast：抽屜是 modal Radix Dialog，開著時 `hideOthers` 把抽屜以外（含 `#root` 裡的 Toaster）
 * 標成 aria-hidden、FocusScope 把焦點鎖在抽屜裡——toast 若留在原處，螢幕閱讀器與鍵盤都碰不到它的「Undo」。
 * 修正：抽屜開著時 ToastViewport 搬進抽屜內容裡，關了再回原處。
 *
 * 掛法照 `App.tsx`：`<Toaster />` 是 Router 的**兄弟**（不在 AppShell 裡），兩者同在 render 容器（＝`#root`）下；
 * 抽屜內容由 Radix Portal 掛在 body，所以 hideOthers 會把 render 容器標成 aria-hidden，與真實 app 同形。
 */

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
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

const NOTE: NoteDto = {
  id: "66666666-6666-6666-6666-666666666666",
  title: "Drawer Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "drawer-note",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: OWNER_PERMS,
};

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/groups" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === "/api/auth/me") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
      }
      if (url === "/api/notes" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([NOTE]) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

function renderApp() {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/"]}>
          <ActiveNoteProvider>
            <Routes>
              <Route path="*" element={<AppShell><SidebarDrawerButton /></AppShell>} />
            </Routes>
          </ActiveNoteProvider>
        </MemoryRouter>
        <Toaster />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

/** 只用 role 查得到（＝不在 aria-hidden 子樹裡）的 Notifications 區。 */
function notificationsRegion(): HTMLElement {
  return screen.getByRole("region", { name: /^Notifications/ });
}

function hasAriaHiddenAncestor(el: HTMLElement): boolean {
  return el.closest('[aria-hidden="true"]') !== null;
}

async function openDrawer(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
  return screen.findByRole("dialog", { name: "Navigation" });
}

function raiseUndoToast(onUndo: () => void = () => {}) {
  act(() => {
    toast({ title: "Moved to the trash", durationMs: 60_000, action: { label: "Undo", onClick: onUndo } });
  });
}

describe("AppShell — 抽屜開著時的 toast（鍵盤與螢幕閱讀器碰得到）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    stubFetch();
  });

  afterEach(() => {
    act(() => dismissAllToasts());
    vi.unstubAllGlobals();
  });

  it("抽屜開著：Notifications 區在抽屜內容裡、沒有 aria-hidden 祖先", async () => {
    renderApp();
    const drawer = await openDrawer();

    const region = notificationsRegion();
    expect(drawer).toContainElement(region);
    expect(hasAriaHiddenAncestor(region)).toBe(false);
  });

  it("抽屜開著時跳的 toast：以 role 找得到、Undo 可聚焦且焦點留得住（在抽屜的 focus scope 內）", async () => {
    renderApp();
    const drawer = await openDrawer();
    raiseUndoToast();

    const item = await within(notificationsRegion()).findByRole("listitem");
    expect(within(item).getByText("Moved to the trash")).toBeInTheDocument();
    const undo = screen.getByRole("button", { name: "Undo" });
    expect(drawer).toContainElement(undo);

    act(() => undo.focus());
    expect(undo).toHaveFocus();
  });

  it("F8 把焦點交給 toast 區，抽屜的 focus trap 不會把它拉回去", async () => {
    renderApp();
    await openDrawer();
    raiseUndoToast();
    await screen.findByRole("button", { name: "Undo" });

    fireEvent.keyDown(document, { key: "F8", code: "F8" });
    const viewportList = within(notificationsRegion()).getByRole("list");
    expect(viewportList).toHaveFocus();
  });

  it("開抽屜前就在的 toast 跟著搬進抽屜（狀態保留、仍只有一則）", async () => {
    renderApp();
    raiseUndoToast();
    await screen.findByRole("button", { name: "Undo" });

    const drawer = await openDrawer();
    const region = notificationsRegion();
    expect(drawer).toContainElement(region);
    expect(within(region).getAllByRole("listitem")).toHaveLength(1);
    expect(within(region).getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("點 toast 與 Undo 不會關抽屜；Undo 照常呼叫並關掉 toast", async () => {
    const onUndo = vi.fn();
    renderApp();
    await openDrawer();
    raiseUndoToast(onUndo);

    const item = await within(notificationsRegion()).findByRole("listitem");
    fireEvent.pointerDown(item, { button: 0 });
    fireEvent.click(item);
    const undo = within(item).getByRole("button", { name: "Undo" });
    fireEvent.pointerDown(undo, { button: 0 });
    fireEvent.click(undo);

    expect(onUndo).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByText("Moved to the trash")).toBeNull());
    expect(screen.getByRole("dialog", { name: "Navigation" })).toBeInTheDocument();
  });

  it("抽屜關掉（點抽屜裡的筆記換頁）→ Notifications 區回到原處，toast 仍在、以 role 找得到", async () => {
    renderApp();
    const drawer = await openDrawer();
    raiseUndoToast();
    await within(drawer).findByRole("button", { name: "Undo" });

    fireEvent.click(await within(drawer).findByRole("link", { name: "Drawer Note" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument());

    const region = notificationsRegion();
    expect(region.closest("[data-sidebar-drawer]")).toBeNull();
    expect(hasAriaHiddenAncestor(region)).toBe(false);
    expect(within(region).getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });
});
