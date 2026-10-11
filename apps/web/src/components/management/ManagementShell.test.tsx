import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation, type Location } from "react-router";
import i18n from "@/i18n";
import { settle } from "@/test/outside-click";
import { ManagementShell, type ManagementNavItemSpec } from "./ManagementShell";

// #247 §4、§11.1。jsdom 不套 Tailwind：`hidden`／`flex` 只能以 class 斷言，真實顯示由 Part 3 的 e2e 截圖驗。
// matchMedia：`src/test/setup.ts:28-40` 的全域 stub 恆回 matches:false（＝窄視窗）；寬視窗案自己 stubGlobal。

const ITEMS: ManagementNavItemSpec[] = [
  { to: "/settings/account", label: "Account info" },
  { to: "/settings/login", label: "Sign-in" },
  { to: "/settings/storage", label: "Storage", count: 7 },
];

const BG = { pathname: "/n/tester/my-note", search: "", hash: "", state: null, key: "bg" } as Location;

function LocationProbe() {
  const location = useLocation();
  const bg = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;
  return (
    <div data-testid="location" data-bg={bg?.pathname ?? ""}>
      {location.pathname}
    </div>
  );
}

function renderShell(opts: { path?: string; state?: unknown; items?: ManagementNavItemSpec[]; subtitle?: string } = {}) {
  const onOpenChange = vi.fn();
  render(
    <MemoryRouter initialEntries={[{ pathname: opts.path ?? "/settings/login", state: opts.state ?? null }]}>
      <Routes>
        <Route
          path="*"
          element={
            <>
              <ManagementShell
                title="Settings"
                subtitle={opts.subtitle}
                description="Panel description"
                items={opts.items ?? ITEMS}
                onOpenChange={onOpenChange}
              >
                <p>slot content</p>
              </ManagementShell>
              <LocationProbe />
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );
  return { onOpenChange };
}

const itemsCard = () => document.querySelector<HTMLElement>('[data-management-card="items"]')!;
const contentCard = () => document.querySelector<HTMLElement>('[data-management-card="content"]')!;
const contentBox = () => document.querySelector<HTMLElement>("[data-management-content]")!;

function stubWideViewport() {
  vi.stubGlobal(
    "matchMedia",
    vi.fn((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })),
  );
}

describe("ManagementShell（#247 §4）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("slot：標題是唯一的 DialogTitle、副文字、描述、計數、children 落在 [data-management-content]", async () => {
    renderShell({ subtitle: "Admin" });
    const dialog = await screen.findByRole("dialog", { name: "Settings" });
    const headings = within(dialog).getAllByRole("heading");
    expect(headings).toHaveLength(1);
    expect(headings[0]!.id).toBe(dialog.getAttribute("aria-labelledby"));
    expect(dialog).toHaveAccessibleDescription("Panel description");
    expect(within(dialog).getByText("Admin")).toBeInTheDocument();
    expect(within(dialog).getByText("7")).toHaveAttribute("aria-hidden", "true");
    expect(within(dialog).getByRole("link", { name: "Storage" })).toBeInTheDocument(); // 計數不進可及名稱
    expect(within(dialog).getByRole("navigation", { name: "Settings" })).toBeInTheDocument();
    expect(contentBox()).toContainElement(screen.getByText("slot content"));
    expect(contentBox()).toHaveAttribute("tabindex", "-1");
  });

  it("項次轉傳 backgroundLocation（突變：拿掉 state 轉傳要紅）", async () => {
    renderShell({ state: { backgroundLocation: BG } });
    fireEvent.click(await screen.findByRole("link", { name: "Account info" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/settings/account"));
    expect(screen.getByTestId("location")).toHaveAttribute("data-bg", "/n/tester/my-note");
  });

  it("沒有 backgroundLocation 時不帶 state（深連結）", async () => {
    renderShell();
    fireEvent.click(await screen.findByRole("link", { name: "Account info" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/settings/account"));
    expect(screen.getByTestId("location")).toHaveAttribute("data-bg", "");
  });

  it("end 生效：/groups/g1/roles 時帶 end 的「Members」沒有 aria-current", async () => {
    renderShell({
      path: "/groups/g1/roles",
      items: [
        { to: "/groups/g1", label: "Members", end: true },
        { to: "/groups/g1/roles", label: "Roles" },
      ],
    });
    expect(await screen.findByRole("link", { name: "Roles" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Members" })).not.toHaveAttribute("aria-current");
  });

  it("✕ 呼叫 onOpenChange(false)", async () => {
    const { onOpenChange } = renderShell();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("Esc 呼叫 onOpenChange(false)", async () => {
    const { onOpenChange } = renderShell();
    await settle();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("面板內恰一顆 Close（突變：拿掉 dialog.tsx 的 size==='panel' 判斷要紅）", async () => {
    renderShell();
    await settle();
    expect(screen.getAllByRole("button", { name: "Close" })).toHaveLength(1);
  });

  it("右卡 DOM 順序：返回鈕 → ✕ → 內容容器", async () => {
    renderShell();
    await screen.findByRole("dialog");
    const kids = Array.from(contentCard().children);
    expect(kids[0]).toBe(screen.getByRole("button", { name: "Back to sections" }));
    expect(kids[1]).toBe(screen.getByRole("button", { name: "Close" }));
    expect(kids[2]).toBe(contentBox());
  });

  it("開啟後焦點在返回鈕、不是任何項次（§4.7：Radix removeLinks；突變：加 onOpenAutoFocus 聚焦項次要紅）", async () => {
    renderShell();
    const back = await screen.findByRole("button", { name: "Back to sections" });
    await waitFor(() => expect(document.activeElement).toBe(back));
    expect(back).toHaveClass("md:hidden", "bg-card");
    for (const link of screen.getAllByRole("link")) expect(document.activeElement).not.toBe(link);
  });

  it("雙層初始＝內容層：左卡 hidden＋md:flex（不含裸 flex）、右卡 flex", async () => {
    renderShell();
    await screen.findByRole("dialog");
    expect(itemsCard().classList).toContain("hidden");
    expect(itemsCard().classList).toContain("md:flex");
    expect(itemsCard().classList).not.toContain("flex");
    expect(contentCard().classList).toContain("flex");
    expect(contentCard().classList).not.toContain("hidden");
  });

  it("按返回：左卡顯示、右卡隱藏（不含裸 flex）、網址不變、焦點在 aria-current 的項次", async () => {
    renderShell();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Back to sections" }));
    await waitFor(() => expect(itemsCard().classList).toContain("flex"));
    expect(itemsCard().classList).not.toContain("hidden");
    expect(contentCard().classList).toContain("hidden");
    expect(contentCard().classList).toContain("md:flex");
    expect(contentCard().classList).not.toContain("flex");
    expect(screen.getByTestId("location")).toHaveTextContent("/settings/login");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("link", { name: "Sign-in" })));
  });

  it("返回後點「目前所在」的項次：pathname 不變也要回內容層，焦點在 [data-management-content]", async () => {
    renderShell();
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Back to sections" }));
    await waitFor(() => expect(contentCard().classList).toContain("hidden"));
    fireEvent.click(screen.getByRole("link", { name: "Sign-in" }));
    await waitFor(() => expect(contentCard().classList).toContain("flex"));
    expect(itemsCard().classList).toContain("hidden");
    await waitFor(() => expect(document.activeElement).toBe(contentBox()));
    expect(screen.getByTestId("location")).toHaveTextContent("/settings/login");
  });

  it("連續兩次「返回→點同一項」都會把焦點送到內容容器（seq 遞增，不是只觸發一次）", async () => {
    renderShell();
    await settle();
    for (let i = 0; i < 2; i += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Back to sections" }));
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("link", { name: "Sign-in" })));
      fireEvent.click(screen.getByRole("link", { name: "Sign-in" }));
      await waitFor(() => expect(document.activeElement).toBe(contentBox()));
    }
  });

  it("寬視窗（matchMedia matches:true）：點項次不搬焦點", async () => {
    stubWideViewport();
    renderShell();
    await settle();
    fireEvent.click(screen.getByRole("link", { name: "Account info" }));
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent("/settings/account"));
    await settle();
    expect(document.activeElement).not.toBe(contentBox());
    expect(window.matchMedia).toHaveBeenCalledWith("(min-width: 768px)");
  });
});
