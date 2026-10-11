import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { ApiTokenDto, GroupDto, IdentitiesDto, StorageUsageDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { AppRoutes } from "@/App";
import { adminRole, groupDto } from "@/test/fixtures";

/**
 * #247 §4.8、§11.1：三個管理面板的右卡內不出現實心鈕（brandDeep／brandSolid／default）。渲染期掃描——
 * 每頁以真 AppRoutes 渲染、fixture 給到最大權限，等內容載入後取 [data-management-content] 內所有
 * `button`、`a[class]`、`[role="button"]`。由面板開出的巢狀對話框（送出鈕照原規則用 brandDeep）是 portal，
 * 本來就渲染在 content 之外；再過濾 `closest('[role="dialog"]')` 是面板本身的，只是保險。
 * 逐 token 精確比對：`hover:bg-brand-deep`、`bg-brand-soft`、`data-[state=checked]:bg-brand` 是別的 token，不受影響。
 * `minButtons` 防空真：該頁至少要掃到這麼多個面板層元素（button／a[class]／role=button）。
 *
 * 擴充（Part 3）：在 PANEL_PAGES 尾端加群組四頁、站台五頁，並在 panelFetch 補端點。
 */
const SOLID_TOKENS = ["bg-brand-deep", "bg-brand", "bg-primary"];

const ADMIN: UserDto = {
  id: "u-admin", email: "admin@example.com", handle: "admin", displayName: "Admin",
  isAdmin: true, mustChangePassword: false, hasPassword: true, autoVersions: true,
};
const SSO_ADMIN: UserDto = { ...ADMIN, id: "u-sso", hasPassword: false };

const IDENTITIES: IdentitiesDto = {
  identities: [
    { id: "i1", issuer: "https://gitlab.example", providers: [{ id: "p1", displayName: "GitLab", icon: { type: "builtin", name: "gitlab" } }], createdAt: "2026-10-01T00:00:00.000Z", lastLoginAt: null, unlinkable: true },
  ],
  linkable: [{ providerId: "p2", displayName: "Google", template: "google", icon: { type: "builtin", name: "google" } }],
  hasPassword: true,
  passwordLoginEnabled: true,
};
const TOKEN: ApiTokenDto = {
  id: "t-1", kind: "pat", name: "Script", agentLabel: "script", scope: "notes:read notes:write",
  createdAt: "2026-09-01T00:00:00.000Z", lastUsedAt: null, expiresAt: null, clientId: null,
};
const STORAGE: StorageUsageDto = {
  usedBytes: 1048576, quotaBytes: 2147483648, planName: "Basic",
  byKind: { image: 1048576, audio: 0, video: 0, document: 0, other: 0 },
};
const GROUPS: GroupDto[] = [groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Team Alpha" }, adminRole())];

function json(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

/**
 * 回傳 `{ fetch, unexpected }`：沒 stub 的請求記進 `unexpected` 再 reject。只 throw 的話那個 query
 * 只會進錯誤態、測試不會紅；每案在掃描前斷言 `unexpected` 為空（ready 逾時時也先報它，才看得出缺哪支端點）。
 */
export function panelFetch(user: UserDto) {
  const unexpected: string[] = [];
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const reject = () => {
      unexpected.push(`${method} ${url}`);
      return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
    };
    if (method !== "GET") return reject();
    if (url === "/api/auth/me") return Promise.resolve(json(user));
    if (url === "/api/auth/config")
      return Promise.resolve(json({ providers: [], registration: { enabled: false }, passwordLogin: { enabled: true }, autoVersionsEnabled: true }));
    if (url === "/api/auth/identities") return Promise.resolve(json({ ...IDENTITIES, hasPassword: user.hasPassword }));
    if (url === "/api/auth/tokens") return Promise.resolve(json({ tokens: [TOKEN] }));
    if (url === "/api/storage") return Promise.resolve(json(STORAGE));
    if (url === "/api/groups") return Promise.resolve(json(GROUPS));
    if (url === "/api/notes") return Promise.resolve(json([]));
    return reject();
  });
  return { fetch, unexpected };
}

export interface PanelPageCase {
  name: string;
  path: string;
  user?: UserDto;
  ready: () => Promise<unknown>;
  minButtons: number;
}

/**
 * 登入頁的密碼表單只看 `/api/auth/me`（先到），已連結登入方式那組看 `/api/auth/identities`（後到）——
 * 只等密碼鈕會在 identities 還在載入時就掃（實測只掃到 1 顆）。所以兩邊都等：「Unlink」列內鈕＋「Link Google」。
 */
async function loginReady(passwordButton: string): Promise<unknown> {
  await screen.findByRole("button", { name: "Unlink" });
  await screen.findByRole("button", { name: /Link Google/ });
  return screen.findByRole("button", { name: passwordButton });
}

export const PANEL_PAGES: PanelPageCase[] = [
  { name: "個人：帳戶資訊", path: "/settings/account", ready: () => screen.findByRole("button", { name: "Save URL name" }), minButtons: 2 },
  { name: "個人：登入（有密碼）", path: "/settings/login", ready: () => loginReady("Change password"), minButtons: 3 },
  { name: "個人：登入（SSO-only）", path: "/settings/login", user: SSO_ADMIN, ready: () => loginReady("Add password"), minButtons: 3 },
  { name: "個人：授權", path: "/settings/authorization", ready: () => screen.findByText("Script"), minButtons: 7 }, // token 區三顆（建立＋列內鉛筆＋紅垃圾桶，#247 Task 16 起；之前是建立＋改名＋撤銷，數目相同）＋MCP 教學三顆「Copy」＋一個 docs 外連 <a class>
  // 開關只看 config；用量那組（無 button，但同頁）要等 `/api/storage` 到才算載完。
  { name: "個人：儲存空間", path: "/settings/storage", ready: async () => { await screen.findByRole("switch"); return screen.findByText(/\(Basic\)/); }, minButtons: 1 },
  { name: "個人：群組", path: "/settings/groups", ready: async () => within(await screen.findByRole("dialog")).findByText("Team Alpha"), minButtons: 0 }, // 背景 NoteList 側欄也有同名群組
  { name: "個人：關於", path: "/settings/about", ready: () => screen.findByText("LICENSE"), minButtons: 3 }, // 三個外連 <a class>（repo、docs/、LICENSE）
];

describe("面板內無實心鈕（#247 §4.8、§11.1；渲染期）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(PANEL_PAGES)("$name（$path）", async ({ path, user, ready, minButtons }) => {
    const { fetch, unexpected } = panelFetch(user ?? ADMIN);
    vi.stubGlobal("fetch", fetch);
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ThemeProvider>
          <MemoryRouter initialEntries={[path]}>
            <AppRoutes />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
    try {
      await ready();
    } catch (err) {
      expect(unexpected, "ready 沒等到；先看是不是缺 stub").toEqual([]);
      throw err;
    }
    expect(unexpected, "有請求沒在 panelFetch 裡 stub").toEqual([]);
    const content = document.querySelector<HTMLElement>("[data-management-content]");
    expect(content, "找不到 [data-management-content]——這頁沒有坐在 ManagementShell 裡").not.toBeNull();
    const panel = content!.closest('[role="dialog"]');
    // `a[class]`：`<Button asChild><Link/></Button>` 渲染成帶 class 的 <a>，也要掃。
    const buttons = Array.from(content!.querySelectorAll<HTMLElement>('button, a[class], [role="button"]')).filter(
      (b) => b.closest('[role="dialog"]') === panel,
    );
    expect(buttons.length).toBeGreaterThanOrEqual(minButtons);
    // 每顆列出命中的 token、可及名稱（aria-label 或 textContent 前 40 字）與 outerHTML 前段，紅了才看得出是哪顆。
    const offenders = buttons
      .map((b) => ({ b, hits: SOLID_TOKENS.filter((token) => b.classList.contains(token)) }))
      .filter(({ hits }) => hits.length > 0)
      .map(({ b, hits }) => ({
        tokens: hits,
        name: b.getAttribute("aria-label") ?? (b.textContent ?? "").trim().slice(0, 40),
        html: b.outerHTML.slice(0, 160),
      }));
    expect(offenders).toEqual([]);
  });
});
