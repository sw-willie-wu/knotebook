import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation, type Location } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ActiveNoteProvider } from "@/lib/active-note";
import { ThemeProvider } from "@/theme";
import { AppRoutes } from "@/App";

// 站台管理 modal（`/admin/*`，#247 §7）：真 `AppRoutes`（驗的是 guard 串接、兩棵樹與 layout route 有沒有接對）。
// 前身 `pages/AdminPage.test.tsx`（#174、#201）——本檔取代它。

function fakeResponse(status: number, body?: unknown): Response {
  return { ok: status < 400, status, json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)) } as unknown as Response;
}

const ADMIN_USER: UserDto = { id: "u-admin", email: "admin@example.com", handle: "admin", displayName: "Admin", isAdmin: true, mustChangePassword: false, hasPassword: true, autoVersions: true };
const PLAIN_USER: UserDto = { ...ADMIN_USER, id: "u-plain", handle: "plain", displayName: "Plain", isAdmin: false };
const BG = { pathname: "/n/admin/some-note", search: "", hash: "", state: null, key: "bg1" } as Location;

function mockFetch(getUser: () => UserDto | null) {
  return vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/auth/me" && method === "GET") {
      const user = getUser();
      return Promise.resolve(user ? fakeResponse(200, user) : fakeResponse(401, { error: { code: "unauthorized", message: "no" } }));
    }
    if (url === "/api/auth/config" && method === "GET") {
      return Promise.resolve(fakeResponse(200, { providers: [], registration: { enabled: true, providerIds: [] }, passwordLogin: { enabled: true }, autoVersionsEnabled: true }));
    }
    if ((url === "/api/groups" || url === "/api/notes" || url === "/api/admin/users" || url === "/api/admin/invites" || url === "/api/admin/groups") && method === "GET") {
      return Promise.resolve(fakeResponse(200, []));
    }
    if (url === "/api/admin/storage-plans" && method === "GET") return Promise.resolve(fakeResponse(200, { plans: [], defaults: { userPlanId: "", groupPlanId: "" } }));
    if (url === "/api/admin/versions/settings" && method === "GET") return Promise.resolve(fakeResponse(200, { keepAllDays: 7, dailyUntilDays: 30, autoVersionsEnabled: true, autoWaitMinutes: 5 }));
    if (url.startsWith("/api/admin/ai/") && method === "GET") {
      const key = url.slice("/api/admin/ai/".length);
      return Promise.resolve(fakeResponse(200, { [key]: [] }));
    }
    if (url === "/api/admin/auth/providers" && method === "GET") return Promise.resolve(fakeResponse(200, { providers: [] }));
    if (url === "/api/admin/auth/settings" && method === "GET") {
      return Promise.resolve(
        fakeResponse(200, {
          registrationEnabled: true,
          passwordLoginEnabled: true,
          passwordLoginForced: false,
          passwordLoginImpact: { usersWithoutSso: 0, actingAdminHasSso: true, enabledProviders: 1 },
        }),
      );
    }
    throw new Error(`unexpected fetch: ${method} ${url}`);
  });
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}|${JSON.stringify(location.state)}`}</div>;
}
const path = () => (screen.getByTestId("location").textContent ?? "").split("|")[0];

function renderAt(entry: string | { pathname: string; state?: unknown }, fetchMock: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetchMock);
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[entry]}>
          <ActiveNoteProvider>
            <AppRoutes />
            <LocationProbe />
          </ActiveNoteProvider>
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

/**
 * §5.1 的「不閃設定面板」負面判準：轉址過程中掛進 DOM 的任何 `[role=dialog]`，可及名稱（`aria-labelledby` 指到的
 * `DialogTitle` 文字）不得是設定面板的標題「Settings」。只記錄、不判斷「必須等於目的地」（群組 modal 會先是備用標題）。
 * 記 `addedNodes`（含子孫）而不是回呼當下 `querySelectorAll`——閃一下的節點可能在回呼跑之前就被移除了（同本檔
 * 「不先閃一下 modal」那案）；標題也先在被加入的子樹裡找（節點已脫離 document 時 `getElementById` 找不到）。
 */
function watchDialogTitles() {
  const titles = new Set<string>();
  const titleOf = (dialog: Element): string => {
    const labelId = dialog.getAttribute("aria-labelledby");
    if (!labelId) return "";
    const inSubtree = [...dialog.querySelectorAll("[id]")].find((el) => el.id === labelId);
    return (inSubtree ?? document.getElementById(labelId))?.textContent ?? "";
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (!(node instanceof Element)) continue;
        const dialogs = node.matches('[role="dialog"]') ? [node] : [];
        dialogs.push(...node.querySelectorAll('[role="dialog"]'));
        for (const dialog of dialogs) titles.add(titleOf(dialog));
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
  return { titles, stop: () => observer.disconnect() };
}

describe("AdminModal（/admin/*，#247 §7）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("M1 五項（nav 可及名稱 Site admin，§8）：Users／Groups／Sign-in／Storage plans／AI agents；沒有「Back to notes」；/admin/users 是 aria-current", async () => {
    renderAt("/admin/users", mockFetch(() => ADMIN_USER));
    const dialog = await screen.findByRole("dialog", { name: "Site admin" });
    const nav = within(dialog).getByRole("navigation", { name: "Site admin" });
    expect(within(nav).getAllByRole("link").map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["Users", "/admin/users"],
      ["Groups", "/admin/groups"],
      ["Sign-in", "/admin/login"],
      ["Storage plans", "/admin/storage"],
      ["AI agents", "/admin/ai"],
    ]);
    expect(within(nav).getByRole("link", { name: "Users" })).toHaveAttribute("aria-current", "page");
    expect(screen.queryByRole("link", { name: "Back to notes" })).not.toBeInTheDocument();
    expect(await within(dialog).findByRole("heading", { level: 1, name: "User management" })).toBeInTheDocument();
  });

  it.each([
    ["/admin", "/admin/users"],
    ["/admin/auth", "/admin/login"],
    ["/admin/versions", "/admin/storage"],
    ["/admin/xyz", "/admin/users"],
  ])("M2 轉址 %s → %s（在 AdminModal 外、RequireAdmin 內）", async (from, to) => {
    renderAt(from, mockFetch(() => ADMIN_USER));
    await waitFor(() => expect(path()).toBe(to));
    expect(await screen.findByRole("dialog", { name: "Site admin" })).toBeInTheDocument();
  });

  it("M3 守衛：非 admin 深連結 /admin/ai → /（不打任何 admin API、不出現站台 modal）；未登入 → /login?next=%2Fadmin%2Fai；mustChangePassword 的 admin → /change-password", async () => {
    const plain = mockFetch(() => PLAIN_USER);
    const v1 = renderAt("/admin/ai", plain);
    await waitFor(() => expect(path()).toBe("/"));
    await waitFor(() => expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument());
    expect(screen.queryByRole("dialog", { name: "Site admin" })).not.toBeInTheDocument();
    expect(plain.mock.calls.some(([input]) => String(input).startsWith("/api/admin/"))).toBe(false);
    v1.unmount();
    vi.unstubAllGlobals();

    const v2 = renderAt("/admin/ai", mockFetch(() => null));
    await waitFor(() => expect(path()).toBe("/login?next=%2Fadmin%2Fai"));
    v2.unmount();
    vi.unstubAllGlobals();

    renderAt("/admin/users", mockFetch(() => ({ ...ADMIN_USER, mustChangePassword: true })));
    await waitFor(() => expect(path()).toBe("/change-password"));
  });

  it("M4 背景：深連結 /admin/users 時主樹落在 /* 的 HomePage（New note 在背景）；Esc → /", async () => {
    renderAt("/admin/users", mockFetch(() => ADMIN_USER));
    const dialog = await screen.findByRole("dialog", { name: "Site admin" });
    expect(screen.getByRole("button", { name: "New note", hidden: true })).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(path()).toBe("/"));
  });

  it.each([["/settings/users"], ["/admin"], ["/admin/auth"], ["/admin/versions"]])(
    "M5（Review Focus 5）%s 轉到站台 modal 的過程不閃設定面板（中途掛進的 dialog 標題從不是 Settings）",
    async (from) => {
      const watcher = watchDialogTitles();
      try {
        renderAt(from, mockFetch(() => ADMIN_USER));
        await screen.findByRole("dialog", { name: "Site admin" });
        await waitFor(() => expect(path().startsWith("/admin/")).toBe(true));
        expect([...watcher.titles]).not.toContain("Settings");
        expect([...watcher.titles]).toContain("Site admin");
      } finally {
        watcher.stop();
      }
    },
  );

  it("M6 帶 backgroundLocation 開啟 → 切項次後 state 仍在 → ✕ 關閉回背景頁", async () => {
    renderAt({ pathname: "/admin/users", state: { backgroundLocation: BG } }, mockFetch(() => ADMIN_USER));
    const dialog = await screen.findByRole("dialog", { name: "Site admin" });
    fireEvent.click(within(within(dialog).getByRole("navigation", { name: "Site admin" })).getByRole("link", { name: "Groups" }));
    await waitFor(() => expect(path()).toBe("/admin/groups"));
    expect(JSON.parse((screen.getByTestId("location").textContent ?? "").split("|")[1])).toEqual({ backgroundLocation: BG });
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(path()).toBe(BG.pathname));
  });

  it("M7 各項次的內容：Groups／Sign-in／Storage plans／AI agents 點了都換成該區塊（h1）", async () => {
    renderAt("/admin/users", mockFetch(() => ADMIN_USER));
    const dialog = await screen.findByRole("dialog", { name: "Site admin" });
    const nav = within(within(dialog).getByRole("navigation", { name: "Site admin" }));
    for (const [link, url, heading] of [
      ["Groups", "/admin/groups", "Groups"],
      ["Sign-in", "/admin/login", "Sign-in"],
      ["Storage plans", "/admin/storage", "Storage plans"],
      ["AI agents", "/admin/ai", "AI providers & actions"],
    ] as const) {
      fireEvent.click(nav.getByRole("link", { name: link }));
      await waitFor(() => expect(path()).toBe(url));
      expect(await within(dialog).findByRole("heading", { level: 1, name: heading })).toBeInTheDocument();
    }
  });

  it("M8 「Storage plans」頁同時有方案表、版本總開關與保留政策表單（§7.0）", async () => {
    renderAt("/admin/storage", mockFetch(() => ADMIN_USER));
    const dialog = await screen.findByRole("dialog", { name: "Site admin" });
    expect(await within(dialog).findByRole("heading", { level: 1, name: "Storage plans" })).toBeInTheDocument();
    expect(await within(dialog).findByRole("switch", { name: "Automatic versions" })).toBeInTheDocument();
    expect(within(dialog).getByLabelText("Keep all for (days)")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "New plan" })).toBeInTheDocument();
  });
});
