import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { UserMenu } from "./UserMenu";

// PR3 主題色選擇器：六個 RadioItem 渲染／role=menuitemradio／aria-checked、
// 點選→data-accent＋localStorage＋選單不關閉、鍵盤方向鍵移動焦點。
//
// Harness（比照 SettingsModal.test.tsx／NoteMenu.test.tsx 既有寫法）：
// QueryClientProvider＋MemoryRouter＋ThemeProvider＋i18n＋`/api/auth/me` stub；
// DropdownMenuTrigger 只掛 onPointerDown（Radix），純 click 開不了選單。

const ACCENT_STORAGE_KEY = "knotebook:accent";

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
  email: "plain@example.com",
  displayName: "Plain",
  isAdmin: false,
  mustChangePassword: false,
  hasPassword: true,
};

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/auth/me" && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(USER) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
}

function renderMenu() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter>
          <UserMenu />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

/** DropdownMenuTrigger（`UserMenu`）只掛 `onPointerDown`（Radix），純
 * `fireEvent.click` 開不了——見 SettingsModal.test.tsx 的 `openUserMenu`。 */
async function openMenu(): Promise<void> {
  await waitFor(() => expect(screen.getByRole("button", { name: "Plain" })).toBeInTheDocument());
  fireEvent.pointerDown(screen.getByRole("button", { name: "Plain" }), { button: 0 });
  await waitFor(() => expect(screen.getByRole("menu")).toBeInTheDocument());
}

describe("UserMenu 主題色選擇器（PR3）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.localStorage.removeItem(ACCENT_STORAGE_KEY);
    document.documentElement.removeAttribute("data-accent");
    stubFetch();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.removeItem(ACCENT_STORAGE_KEY);
    document.documentElement.removeAttribute("data-accent");
  });

  it("渲染六個色點：role=menuitemradio，aria-checked 對應目前 accent（預設 indigo）", async () => {
    renderMenu();
    await openMenu();

    const radios = screen.getAllByRole("menuitemradio");
    expect(radios).toHaveLength(6);

    const indigo = screen.getByRole("menuitemradio", { name: "Indigo" });
    expect(indigo).toHaveAttribute("aria-checked", "true");
    // title tooltip 也走 i18n 色名（跟 aria-label/textValue 同一個翻譯 key）。
    expect(indigo).toHaveAttribute("title", "Indigo");
    // 色點取色唯一守衛：真的讀 --brand-swatch-indigo，不是隨手寫死的 hex。
    expect(indigo.getAttribute("style")).toContain("var(--brand-swatch-indigo)");

    for (const name of ["Blue", "Teal", "Sage", "Rose", "Gold"]) {
      expect(screen.getByRole("menuitemradio", { name })).toHaveAttribute("aria-checked", "false");
    }
  });

  // B1（Wave 2 Review A blocking）：wrapper 的 outline-none 清掉了瀏覽器原生
  // focus ring，鍵盤在六點間移動時畫面必須靠 data-[highlighted]:ring-foreground
  // 補上可見指示——jsdom 不套用 CSS，這裡只能釘 class 字面量存在，行為級（真的
  // 顯示出一圈）留給視覺驗證。
  it("色點 class 含 data-[highlighted]:ring-foreground（鍵盤移動時的可見指示，補償 outline-none）", async () => {
    renderMenu();
    await openMenu();

    for (const radio of screen.getAllByRole("menuitemradio")) {
      expect(radio.className).toContain("data-[highlighted]:ring-2");
      expect(radio.className).toContain("data-[highlighted]:ring-foreground");
    }
  });

  it("點選色點 → 更新 <html> 的 data-accent 與 localStorage，且選單不關閉", async () => {
    renderMenu();
    await openMenu();

    fireEvent.click(screen.getByRole("menuitemradio", { name: "Teal" }));

    await waitFor(() => expect(document.documentElement.getAttribute("data-accent")).toBe("teal"));
    expect(window.localStorage.getItem(ACCENT_STORAGE_KEY)).toBe("teal");
    // 選色不關選單（onSelect preventDefault）——選單這時應該還在畫面上。
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitemradio", { name: "Teal" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: "Indigo" })).toHaveAttribute("aria-checked", "false");
  });

  // 這裡只驗證 document.activeElement 有沒有真的移動；移動當下畫面上是否看得見
  // （data-[highlighted]:ring-foreground，補償 wrapper 的 outline-none）是另一條
  // class 字面量案的職責，見上方 B1 那條測試。
  it("鍵盤 ArrowDown 依 DOM 序移動焦點（視覺上橫排，鍵盤仍走選單原生的上下）", async () => {
    renderMenu();
    await openMenu();

    const radios = screen.getAllByRole("menuitemradio");

    // pointerDown 開的選單不會自動把焦點帶進第一個項目（Radix 的 entry-focus
    // 只在鍵盤觸發時才生效）——這裡直接把焦點放上第一個色點，模擬「使用者已經
    // 用方向鍵導覽到這裡」的狀態，純粹測「再按一次 ArrowDown 會不會移動」。
    act(() => radios[0].focus());
    await waitFor(() => expect(document.activeElement).toBe(radios[0]));

    fireEvent.keyDown(radios[0], { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(radios[1]));

    fireEvent.keyDown(radios[1], { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(radios[2]));
  });
});
