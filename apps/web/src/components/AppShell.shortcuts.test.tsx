import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { useShortcutsDialog } from "@/lib/shortcuts-dialog";
import { NARROW_QUERY } from "@/lib/sidebar-drawer";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts } from "@/components/ui/toast";
import { AppShell, SidebarDrawerButton } from "./AppShell";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";

/**
 * Ctrl/Cmd+/ 開關快捷鍵介紹頁（plan 2026-11-02-shortcuts-modal T6）：判準（K3）、讓路（K4）、焦點回歸（K11）、context（K1）。
 * 對話框內容換成替身（內容自己的行為在 ShortcutsLazy.test.tsx；lazy 載入失敗在 AppShell.shortcuts-lazy-error.test.tsx）。
 */

vi.mock("@/components/shortcuts/ShortcutsLazy", () => ({ ShortcutsContent: () => <p>stub shortcuts content</p> }));

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
      if (url === "/api/ai/actions") return Promise.resolve(fakeResponse({ actions: [] }));
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

/** S13：經 context 開對話框的消費端。 */
function OpenViaContext() {
  const shortcuts = useShortcutsDialog();
  return (
    <button type="button" onClick={() => shortcuts!.open()}>
      open via context
    </button>
  );
}

function renderShell(children: ReactNode = <button type="button">probe</button>) {
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={["/"]}>
          <ActiveNoteProvider>
            <AppShell>{children}</AppShell>
          </ActiveNoteProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

const dialog = () => screen.queryByRole("dialog", { name: "Keyboard shortcuts" });
const press = (init: KeyboardEventInit & { key: string }) => fireEvent.keyDown(window, init);

/** 等外殼畫完（有 probe 鈕），再開始按鍵。 */
async function ready(): Promise<void> {
  await screen.findByRole("button", { name: "probe" });
}

const extras: HTMLElement[] = [];
function addToBody(html: string): void {
  const host = document.createElement("div");
  host.innerHTML = html;
  document.body.appendChild(host);
  extras.push(host);
}

beforeEach(async () => {
  await i18n.changeLanguage("en");
  dismissAllToasts();
  stubFetch();
});

afterEach(() => {
  for (const el of extras.splice(0)) el.remove();
  vi.unstubAllGlobals();
});

describe("AppShell — Ctrl/Cmd+/ 快捷鍵介紹", () => {
  it("S1 Ctrl+/ 被 preventDefault 且開出 dialog", async () => {
    renderShell();
    await ready();
    const notCanceled = press({ key: "/", ctrlKey: true });
    expect(notCanceled).toBe(false);
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

  it("S2 Cmd+/（metaKey）也開", async () => {
    renderShell();
    await ready();
    press({ key: "/", metaKey: true });
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

  it("S3 Ctrl+Alt+/ 不開、也不 preventDefault", async () => {
    renderShell();
    await ready();
    const notCanceled = press({ key: "/", ctrlKey: true, altKey: true });
    expect(notCanceled).toBe(true);
    expect(dialog()).toBeNull();
  });

  it("S4 Ctrl+Shift+?（key 是 ?）不開；Ctrl+Shift+/（key 是 /，K3：不看 shift）開", async () => {
    renderShell();
    await ready();
    press({ key: "?", ctrlKey: true, shiftKey: true });
    expect(dialog()).toBeNull();
    press({ key: "/", ctrlKey: true, shiftKey: true });
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

  it("S5 事件已被別人 preventDefault（例如 BlockNote 的鍵）→ 讓路，不開", async () => {
    renderShell();
    await ready();
    const event = new KeyboardEvent("keydown", { key: "/", ctrlKey: true, bubbles: true, cancelable: true });
    event.preventDefault();
    act(() => {
      window.dispatchEvent(event);
    });
    expect(dialog()).toBeNull();
  });

  it("S6 頁上另有 role=dialog → 不開、不 preventDefault", async () => {
    renderShell();
    await ready();
    addToBody('<div role="dialog" aria-label="other"></div>');
    const notCanceled = press({ key: "/", ctrlKey: true });
    expect(notCanceled).toBe(true);
    expect(dialog()).toBeNull();
  });

  // D7：選單開著也讓路（比照 Ctrl+S；Radix 選單與 Dialog 共用 FocusScope 會搶焦點）。與 Ctrl+K「menu 照觸發」刻意不同。
  it("S7 頁上有 role=menu → 不開、不 preventDefault", async () => {
    renderShell();
    await ready();
    addToBody('<div role="menu"></div>');
    const notCanceled = press({ key: "/", ctrlKey: true });
    expect(notCanceled).toBe(true);
    expect(dialog()).toBeNull();
  });

  it("S8 只有側欄抽屜（role=dialog 且 data-sidebar-drawer）→ 照開", async () => {
    renderShell();
    await ready();
    addToBody('<div role="dialog" data-sidebar-drawer="" aria-label="drawer"></div>');
    press({ key: "/", ctrlKey: true });
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });

  it("S9 開著再按一次 → 關（D6 切換）、被 preventDefault", async () => {
    renderShell();
    await ready();
    press({ key: "/", ctrlKey: true });
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    const notCanceled = press({ key: "/", ctrlKey: true });
    expect(notCanceled).toBe(false);
    await waitFor(() => expect(dialog()).toBeNull());
  });

  it("S10 按住不放的重複事件（repeat）不開", async () => {
    renderShell();
    await ready();
    press({ key: "/", ctrlKey: true, repeat: true });
    expect(dialog()).toBeNull();
  });

  // 本案同時守鍵盤路徑與 ShortcutsDialog 的 onCloseAutoFocus：無 Trigger 的受控 Dialog，Radix 關閉時不還焦點、落 body（gate r1 I1）。
  it("S11 關閉後焦點回到開啟前的元素", async () => {
    renderShell();
    const probe = await screen.findByRole("button", { name: "probe" });
    probe.focus();
    press({ key: "/", ctrlKey: true });
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(dialog()).toBeNull());
    await waitFor(() => expect(probe).toHaveFocus());
  });

  it("S12 快捷鍵頁開著時 Ctrl+K：搜尋框不取得焦點（既有 dialog 讓路，兩支監聽器互不干擾）", async () => {
    renderShell();
    await ready();
    press({ key: "/", ctrlKey: true });
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search notes"]')!;
    expect(search).not.toBeNull();
    press({ key: "k", ctrlKey: true });
    expect(search).not.toHaveFocus();
  });

  it("S13 context：消費端呼叫 open() → 開", async () => {
    renderShell(<OpenViaContext />);
    fireEvent.click(await screen.findByRole("button", { name: "open via context" }));
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeInTheDocument();
  });
});

/** Radix 的 DropdownMenuTrigger 只掛 onPointerDown，純 click 開不了。 */
async function openUserMenu(scope?: HTMLElement): Promise<void> {
  const trigger = await (scope ? within(scope) : screen).findByRole("button", { name: "Ann" });
  fireEvent.pointerDown(trigger, { button: 0 });
  await screen.findByRole("menu");
}

describe("AppShell — 從使用者選單開快捷鍵介紹", () => {
  it("S14 選單開 → dialog 出現；Esc 關 → 焦點回 UserMenu 觸發鈕", async () => {
    renderShell();
    await ready();
    const trigger = await screen.findByRole("button", { name: "Ann" });
    await openUserMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Keyboard shortcuts" }));
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(dialog()).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  // 抽屜開著時，快捷鍵頁疊在抽屜上、抽屜不關（K12）。快捷鍵頁開著時抽屜被 Radix 標成 aria-hidden（預期行為），
  // 所以那段不用 getByRole 找抽屜，改用 [data-sidebar-drawer]；Esc 關掉快捷鍵頁後才用 getByRole 確認抽屜恢復可及。
  it("S15 窄視窗：抽屜裡的 UserMenu 開快捷鍵頁，抽屜仍在；Esc 只關快捷鍵頁，焦點回抽屜裡的觸發鈕", async () => {
    const mql = {
      matches: true,
      media: NARROW_QUERY,
      addEventListener: () => {},
      removeEventListener: () => {},
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    };
    vi.stubGlobal("matchMedia", vi.fn((query: string) => (query === NARROW_QUERY ? mql : { ...mql, matches: false })));
    renderShell(
      <>
        <SidebarDrawerButton />
        <button type="button">probe</button>
      </>,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open navigation" }));
    const drawer = await screen.findByRole("dialog", { name: "Navigation" });
    const drawerTrigger = await within(drawer).findByRole("button", { name: "Ann" });
    await openUserMenu(drawer);
    fireEvent.click(await screen.findByRole("menuitem", { name: "Keyboard shortcuts" }));
    await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(document.querySelector("[data-sidebar-drawer]")).not.toBeNull();

    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(dialog()).toBeNull());
    expect(await screen.findByRole("dialog", { name: "Navigation" })).toBeInTheDocument();
    await waitFor(() => expect(drawerTrigger).toHaveFocus());
  });
});
