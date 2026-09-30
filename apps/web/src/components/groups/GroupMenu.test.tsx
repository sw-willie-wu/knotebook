import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import type { GroupDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { GroupMenu } from "./GroupMenu";

const ME: UserDto = { id: "u-me", email: "me@example.com", handle: "me", displayName: "Me", isAdmin: false, mustChangePassword: false, hasPassword: true };
const ADMIN_GROUP: GroupDto = { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Workshop A", myRole: "admin", createdAt: "2026-09-01T00:00:00.000Z" };
const MEMBER_GROUP: GroupDto = { ...ADMIN_GROUP, id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "Workshop B", myRole: "member" };

function fakeResponse(status: number, body?: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)) } as unknown as Response;
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname}|{JSON.stringify(location.state)}</div>;
}

function renderMenu(group: GroupDto, handler: (method: string, url: string) => Response, size?: "sidebar" | "default") {
  const calls: Array<{ method: string; url: string }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url });
      if (url === "/api/auth/me" && method === "GET") return Promise.resolve(fakeResponse(200, ME));
      return Promise.resolve(handler(method, url));
    }),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { unmount } = render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/n/me/some-note"]}>
        <Routes>
          <Route path="*" element={<><GroupMenu group={group} size={size} /><LocationProbe /><Toaster /></>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { calls, queryClient, unmount };
}

async function openMenu(name: string) {
  // Radix DropdownMenu 的 trigger 只聽 onPointerDown（`NoteMenu.test.tsx:45-46,96`）。
  fireEvent.pointerDown(screen.getByRole("button", { name: `Group actions for ${name}` }), { button: 0 });
  return screen.findByRole("menu");
}

describe("GroupMenu", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("admin 形：成員與設定／重新命名／刪除群組（danger）", async () => {
    renderMenu(ADMIN_GROUP, () => fakeResponse(500));
    const menu = await openMenu("Workshop A");
    expect(within(menu).getByRole("menuitem", { name: "Members & settings" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Rename" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Delete group" })).toHaveClass("text-destructive");
    expect(within(menu).queryByRole("menuitem", { name: "Leave group" })).not.toBeInTheDocument();
  });

  it("member 形：查看成員／退出群組；沒有改名與刪除", async () => {
    renderMenu(MEMBER_GROUP, () => fakeResponse(500));
    const menu = await openMenu("Workshop B");
    expect(within(menu).getByRole("menuitem", { name: "View members" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Leave group" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Rename" })).not.toBeInTheDocument();
    expect(within(menu).queryByRole("menuitem", { name: "Delete group" })).not.toBeInTheDocument();
  });

  it("成員與設定 → navigate /settings/groups/:id 並帶 backgroundLocation", async () => {
    renderMenu(ADMIN_GROUP, () => fakeResponse(500));
    const menu = await openMenu("Workshop A");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Members & settings" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(`/settings/groups/${ADMIN_GROUP.id}|`));
    expect(screen.getByTestId("location").textContent).toContain('"backgroundLocation"');
    expect(screen.getByTestId("location").textContent).toContain("/n/me/some-note");
  });

  it("size：預設是標準 32px icon 鈕（h-8 w-8）；sidebar 是 24px（h-6 w-6）", () => {
    const first = renderMenu(ADMIN_GROUP, () => fakeResponse(500));
    const standard = screen.getByRole("button", { name: "Group actions for Workshop A" });
    expect(standard).toHaveClass("h-8", "w-8");
    expect(standard).not.toHaveClass("h-6");
    // 設定頁的 ⋮ 常駐，不套 hover 浮出
    expect(standard).not.toHaveClass("opacity-0");
    first.unmount();
    renderMenu(ADMIN_GROUP, () => fakeResponse(500), "sidebar");
    const compact = screen.getByRole("button", { name: "Group actions for Workshop A" });
    expect(compact).toHaveClass("h-6", "w-6");
    expect(compact).not.toHaveClass("h-8");
    // class 斷言，不是行為斷言：jsdom 沒有 CSS，hover 浮出要在瀏覽器看
    expect(compact).toHaveClass("opacity-0", "data-[state=open]:opacity-100");
  });

  // Radix 契約的斷言（trigger 開啟時帶 data-state="open"）；CSS 是否生效要瀏覽器看。
  it("側欄版開選單時 trigger 帶 data-state=open（hover 浮出的「開著不消失」靠它）", async () => {
    renderMenu(ADMIN_GROUP, () => fakeResponse(500), "sidebar");
    const before = screen.getByRole("button", { name: "Group actions for Workshop A" });
    expect(before).toHaveAttribute("data-state", "closed");
    await openMenu("Workshop A");
    // modal 選單開著時其他元素被 aria-hidden，取 trigger 要 hidden: true
    expect(screen.getByRole("button", { name: "Group actions for Workshop A", hidden: true })).toHaveAttribute(
      "data-state",
      "open",
    );
  });

  it("⋮ → 重新命名 → 取消：焦點回到 ⋮ 觸發鈕（不是掉到 body）", async () => {
    renderMenu(ADMIN_GROUP, () => fakeResponse(500));
    const menu = await openMenu("Workshop A");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename group" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename group" })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Group actions for Workshop A" })).toHaveFocus());
  });

  it("⋮ → 刪除群組 → 取消：焦點回到 ⋮ 觸發鈕", async () => {
    renderMenu(ADMIN_GROUP, () => fakeResponse(500));
    const menu = await openMenu("Workshop A");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete group" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete group?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete group?" })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("button", { name: "Group actions for Workshop A" })).toHaveFocus());
  });

  it("重新命名 → 開對話框預填舊名；儲存送 PATCH", async () => {
    const { calls } = renderMenu(ADMIN_GROUP, (method) => (method === "PATCH" ? fakeResponse(200, { ...ADMIN_GROUP, name: "Renamed" }) : fakeResponse(500)));
    const menu = await openMenu("Workshop A");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Rename" }));
    const dialog = await screen.findByRole("dialog", { name: "Rename group" });
    expect(within(dialog).getByLabelText("Group name")).toHaveValue("Workshop A");
    fireEvent.change(within(dialog).getByLabelText("Group name"), { target: { value: "Renamed" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.url === `/api/groups/${ADMIN_GROUP.id}`)).toBe(true));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Rename group" })).not.toBeInTheDocument());
  });

  it("刪除群組 → 二次確認文案（筆記變個人筆記、原成員保留存取）→ DELETE /api/groups/:id", async () => {
    const { calls } = renderMenu(ADMIN_GROUP, (method) => (method === "DELETE" ? fakeResponse(204) : fakeResponse(500)));
    const menu = await openMenu("Workshop A");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete group" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete group?" });
    expect(dialog).toHaveTextContent('Notes in "Workshop A" become personal notes. Current members keep their access at their current role.');
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete group" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === `/api/groups/${ADMIN_GROUP.id}`)).toBe(true));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Delete group?" })).not.toBeInTheDocument());
  });

  it("退出群組 → 二次確認 → DELETE /api/groups/:id/members/<me>；409 last_admin → toast errors.last_admin、對話框關閉", async () => {
    const { calls } = renderMenu(MEMBER_GROUP, (method) =>
      method === "DELETE" ? fakeResponse(409, { error: { code: "last_admin", message: "x" } }) : fakeResponse(500),
    );
    const menu = await openMenu("Workshop B");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Leave group" }));
    const dialog = await screen.findByRole("dialog", { name: "Leave group?" });
    expect(dialog).toHaveTextContent('You will lose access to the notes in "Workshop B".');
    // 確認鈕 disabled 到 session 載完（`!user`）——先等它可按，不跟 /api/auth/me 賽跑
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Leave group" })).not.toBeDisabled());
    fireEvent.click(within(dialog).getByRole("button", { name: "Leave group" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE" && c.url === `/api/groups/${MEMBER_GROUP.id}/members/${ME.id}`)).toBe(true));
    await waitFor(() =>
      expect(screen.getByText("A group needs at least one admin. Make someone else an admin first, or delete the group.", { exact: true })).toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Leave group?" })).not.toBeInTheDocument());
  });
});
