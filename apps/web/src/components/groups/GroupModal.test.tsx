import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import i18n from "@/i18n";
import { dismissAllToasts } from "@/components/ui/toast";
import {
  BG_NOTE,
  GROUP_ADMIN,
  GROUP_MEMBER,
  ME,
  ADMIN_ROLE,
  fail,
  groupFetch,
  locationText,
  member,
  ok,
  renderGroupRoute,
} from "./group-test-utils";

const NOT_FOUND = "We couldn't find what you were looking for.";

describe("GroupModal（/groups/:id/*，#247 §6.0、§6.1）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("G1 四項導覽（nav 的可及名稱＝群組名，§8）：Members／Roles／Storage／About，href 依序；在 /groups/:id 時 Members 是 aria-current", async () => {
    renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, groupFetch(() => [GROUP_ADMIN], () => [member(ME.id, ME.email, "Me", ADMIN_ROLE)]));
    const dialog = await screen.findByRole("dialog", { name: "Team Alpha" });
    const nav = within(dialog).getByRole("navigation", { name: "Team Alpha" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Members", `/groups/${GROUP_ADMIN.id}`],
      ["Roles", `/groups/${GROUP_ADMIN.id}/roles`],
      ["Storage", `/groups/${GROUP_ADMIN.id}/storage`],
      ["About", `/groups/${GROUP_ADMIN.id}/about`],
    ]);
    expect(within(nav).getByRole("link", { name: "Members" })).toHaveAttribute("aria-current", "page");
  });

  it("G2 Members 帶 end：在 /groups/:id/roles 時 Members 不是 aria-current（Roles 才是）", async () => {
    renderGroupRoute(`/groups/${GROUP_ADMIN.id}/roles`, groupFetch(() => [GROUP_ADMIN]));
    const dialog = await screen.findByRole("dialog", { name: "Team Alpha" });
    // 先等角色頁的 h1：證明 roles route 已掛上（沒有它會被 splat 轉回成員頁；轉址前那一瞬 aria-current 也會暫時對）。
    await within(dialog).findByRole("heading", { level: 1, name: "Roles" });
    const nav = within(dialog).getByRole("navigation", { name: "Team Alpha" });
    expect(within(nav).getByRole("link", { name: "Roles" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Members" })).not.toHaveAttribute("aria-current");
  });

  it("G3 標題＝群組名、副文字＝我的角色（roleLabel：內建一般成員顯示 Member）；成員頁 h1 是 Members", async () => {
    renderGroupRoute(`/groups/${GROUP_MEMBER.id}`, groupFetch(() => [GROUP_MEMBER]));
    const dialog = await screen.findByRole("dialog", { name: "Team Beta" });
    expect(within(dialog).getByText("Member", { selector: "span, p, div" })).toBeInTheDocument();
    expect(await within(dialog).findByRole("heading", { level: 1, name: "Members" })).toBeInTheDocument();
  });

  it("G4 找不到（非成員／不存在／id 不合法同形，S4）：右卡 errors.not_found、標題是備用字「Group」、無副文字；外殼與導覽照常", async () => {
    for (const path of [`/groups/${GROUP_MEMBER.id}`, "/groups/not-a-real-id"]) {
      const view = renderGroupRoute(path, groupFetch(() => [GROUP_ADMIN]));
      const dialog = await screen.findByRole("dialog", { name: "Group" });
      await waitFor(() => expect(within(dialog).getByRole("alert")).toHaveTextContent(NOT_FOUND));
      expect(within(dialog).getByRole("navigation", { name: "Group" })).toBeInTheDocument();
      expect(within(dialog).queryByText("Admin")).not.toBeInTheDocument();
      expect(dialog.querySelector("[data-management-content]")).toContainElement(within(dialog).getByRole("alert"));
      view.unmount();
      vi.unstubAllGlobals();
    }
  });

  it("G5 群組清單載入中：右卡「Loading…」、標題「Group」；載入失敗（首次就 500）：右卡錯誤字、標題「Group」", async () => {
    const view = renderGroupRoute(
      `/groups/${GROUP_ADMIN.id}`,
      groupFetch(() => [GROUP_ADMIN], () => [], (url, method) => (url === "/api/groups" && method === "GET" ? new Promise<Response>(() => {}) : null)),
    );
    const loading = await screen.findByRole("dialog", { name: "Group" });
    expect(within(loading).getByText("Loading…")).toBeInTheDocument();
    view.unmount();
    vi.unstubAllGlobals();

    renderGroupRoute(
      `/groups/${GROUP_ADMIN.id}`,
      groupFetch(() => [GROUP_ADMIN], () => [], (url, method) => (url === "/api/groups" && method === "GET" ? fail(500, "internal") : null)),
    );
    const errored = await screen.findByRole("dialog", { name: "Group" });
    await waitFor(() => expect(within(errored).getByRole("alert")).toBeInTheDocument());
    expect(within(errored).queryByRole("heading", { level: 1, name: "Members" })).not.toBeInTheDocument();
  });

  it("G6 /groups/:id 渲染成員頁、網址不變（不是轉址迴圈）；/groups/:id/xyz → /groups/:id 並轉傳 backgroundLocation", async () => {
    const view = renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, groupFetch(() => [GROUP_ADMIN]));
    const dialog = await screen.findByRole("dialog", { name: "Team Alpha" });
    expect(await within(dialog).findByRole("heading", { level: 1, name: "Members" })).toBeInTheDocument();
    expect(locationText()).toBe(`/groups/${GROUP_ADMIN.id}|null`);
    view.unmount();
    vi.unstubAllGlobals();

    renderGroupRoute({ pathname: `/groups/${GROUP_ADMIN.id}/xyz`, state: { backgroundLocation: BG_NOTE } }, groupFetch(() => [GROUP_ADMIN]));
    await waitFor(() => expect(locationText().startsWith(`/groups/${GROUP_ADMIN.id}|`)).toBe(true));
    expect(JSON.parse(locationText().split("|")[1])).toEqual({ backgroundLocation: BG_NOTE });
  });

  it("G7 Esc 與 ✕ 關閉 → navigate(backgroundLocation)；深連結（無 state）→ /", async () => {
    const view = renderGroupRoute({ pathname: `/groups/${GROUP_ADMIN.id}`, state: { backgroundLocation: BG_NOTE } }, groupFetch(() => [GROUP_ADMIN]));
    const dialog = await screen.findByRole("dialog", { name: "Team Alpha" });
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(locationText().startsWith(`${BG_NOTE.pathname}|`)).toBe(true));
    view.unmount();
    vi.unstubAllGlobals();

    renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, groupFetch(() => [GROUP_ADMIN]));
    const deep = await screen.findByRole("dialog", { name: "Team Alpha" });
    fireEvent.click(within(deep).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(locationText().startsWith("/|")).toBe(true));
  });

  it("G8（Review Focus 2）網址的群組 id 是大寫 → 仍解析到同一個群組（不分大小寫比對）", async () => {
    renderGroupRoute(`/groups/${GROUP_ADMIN.id.toUpperCase()}`, groupFetch(() => [GROUP_ADMIN]));
    expect(await screen.findByRole("dialog", { name: "Team Alpha" })).toBeInTheDocument();
  });

  it("G9（Review Focus 1）已顯示群組後 ['groups'] refetch 失敗 → 右卡內容留著（不換成錯誤字）", async () => {
    let failGroups = false;
    const fetchMock = groupFetch(() => [GROUP_ADMIN], () => [member(ME.id, ME.email, "Me", ADMIN_ROLE)], (url, method) =>
      url === "/api/groups" && method === "GET" && failGroups ? fail(500, "internal") : null,
    );
    renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog", { name: "Team Alpha" });
    await within(dialog).findByRole("heading", { level: 1, name: "Members" });
    failGroups = true;
    // 加人觸發 ['groups'] 失效重抓（useAddMember → invalidate）
    fetchMock.mockImplementationOnce(() => Promise.resolve(ok(member("u-x", "x@example.com", "X", ADMIN_ROLE), 201)));
    fireEvent.change(within(dialog).getByLabelText("Email address"), { target: { value: "x@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([u]) => String(u) === "/api/groups").length).toBeGreaterThanOrEqual(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole("dialog", { name: "Team Alpha" })).toBeInTheDocument();
    expect(within(dialog).getByRole("heading", { level: 1, name: "Members" })).toBeInTheDocument();
  });
});
