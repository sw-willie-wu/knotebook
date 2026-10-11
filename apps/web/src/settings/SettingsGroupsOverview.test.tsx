import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { GroupDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { adminRole, customRole, groupDto, memberRole } from "@/test/fixtures";
import { SettingsGroupsOverview } from "./SettingsGroupsOverview";

function fakeResponse(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

function renderOverview(groups: GroupDto[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      if (String(input) === "/api/groups") return Promise.resolve(fakeResponse(groups));
      throw new Error(`unexpected fetch: ${String(input)}`);
    }),
  );
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter>
        <SettingsGroupsOverview />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const pillsOf = (row: HTMLElement) => Array.from(row.querySelectorAll("[data-pill]")).map((p) => p.textContent);

const ADMIN_G = groupDto({ id: "g-admin", name: "WRATB" }, adminRole());
const MEMBER_G = groupDto({ id: "g-member", name: "RD Weekly" }, memberRole());
const CUSTOM_G = groupDto({ id: "g-custom", name: "Book club" }, customRole({ name: "Reader" }));
const NULL_G = groupDto({ id: "g-null", name: "Orphan" }, null);

describe("SettingsGroupsOverview（#247 §5.5，唯讀）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("標題、說明、「你在 N 個群組裡」", async () => {
    renderOverview([ADMIN_G, MEMBER_G, CUSTOM_G]);
    expect(screen.getByRole("heading", { level: 1, name: "Groups" })).toBeInTheDocument();
    expect(screen.getByText("Groups you belong to, and your role in each. Create or manage groups from the sidebar.")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { level: 2, name: "You're in 3 groups" })).toBeInTheDocument();
  });

  it("單數：「You're in 1 group」", async () => {
    renderOverview([MEMBER_G]);
    expect(await screen.findByRole("heading", { level: 2, name: "You're in 1 group" })).toBeInTheDocument();
  });

  it("我的角色走 roleLabel：內建 admin→Admin、內建 member→Member（不是空白）、自訂→其名", async () => {
    renderOverview([ADMIN_G, MEMBER_G, CUSTOM_G]);
    const admin = (await screen.findByText("WRATB")).closest("tr")!;
    expect(within(admin).getByText("Admin")).toBeInTheDocument();
    expect(within(screen.getByText("RD Weekly").closest("tr")!).getByText("Member")).toBeInTheDocument();
    expect(within(screen.getByText("Book club").closest("tr")!).getByText("Reader")).toBeInTheDocument();
  });

  it("權限 pill：每列先一顆 Read，其餘只列 true 的旗標、順序同 GROUP_ROLE_FLAGS", async () => {
    renderOverview([ADMIN_G, MEMBER_G, CUSTOM_G]);
    const admin = (await screen.findByText("WRATB")).closest("tr")!;
    expect(pillsOf(admin)).toEqual(["Read", "Create", "Edit", "Delete", "Manage public links", "Manage members", "Manage roles & group"]);
    expect(pillsOf(screen.getByText("RD Weekly").closest("tr")!)).toEqual(["Read", "Create", "Edit"]);
    expect(pillsOf(screen.getByText("Book club").closest("tr")!)).toEqual(["Read"]);
  });

  it("myRole: null（型別上可能）→ 角色「—」、只有 Read pill、不 throw", async () => {
    renderOverview([NULL_G]);
    const row = (await screen.findByText("Orphan")).closest("tr")!;
    expect(within(row).getByText("—")).toBeInTheDocument();
    expect(pillsOf(row)).toEqual(["Read"]);
  });

  it("沒有任何連結、沒有任何按鈕（無 ⋮、無「新增群組」、群組名不是連結；W11／W26）", async () => {
    renderOverview([ADMIN_G, MEMBER_G]);
    await screen.findByText("WRATB");
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("零個群組 → 空狀態句", async () => {
    renderOverview([]);
    expect(await screen.findByText("You're not in any group yet.")).toBeInTheDocument();
  });
});
