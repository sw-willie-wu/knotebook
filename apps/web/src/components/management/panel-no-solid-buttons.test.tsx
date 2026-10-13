import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { ApiTokenDto, GroupDto, IdentitiesDto, StorageUsageDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { AppRoutes } from "@/App";
import { adminRole, customRole, groupDto, memberRole } from "@/test/fixtures";

/**
 * #247 §4.8、§11.1：三個管理面板的右卡內不出現實心鈕（brandDeep／brandSolid／default）。渲染期掃描——
 * 每頁以真 AppRoutes 渲染、fixture 給到最大權限，等內容載入後取 [data-management-content] 內所有
 * `button`、`a[class]`、`[role="button"]`。由面板開出的巢狀對話框（送出鈕照原規則用 brandDeep）是 portal，
 * 本來就渲染在 content 之外；再過濾 `closest('[role="dialog"]')` 是面板本身的，只是保險。
 * 逐 token 精確比對：`hover:bg-brand-deep`、`bg-brand-soft`、`data-[state=checked]:bg-brand` 是別的 token，不受影響。
 * `minButtons` 防空真：該頁至少要掃到這麼多個面板層元素（button／a[class]／role=button）。
 *
 * Part 3 已擴充：PANEL_PAGES 尾端加了群組四頁、站台五頁（端點 fixture 在 `PANEL3_GETS`，由 panelFetch 精確比對 URL）。
 */
const SOLID_TOKENS = ["bg-brand-deep", "bg-brand", "bg-primary", "bg-destructive"];

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
const GROUP_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const T = "2026-01-01T00:00:00.000Z";
const PLAN = { id: "11111111-1111-4111-8111-111111111111", name: "Basic", quotaBytes: 2147483648, userCount: 1, groupCount: 1, overQuotaCount: 0, isDefaultForUsers: true, isDefaultForGroups: true, createdAt: T, updatedAt: T };
const PLAN_STORAGE = { planId: PLAN.id, planName: "Basic", usedBytes: 0, quotaBytes: 2147483648 };
const PROVIDER_ID = "22222222-2222-4222-8222-222222222222";
/** 群組／站台九頁的最大權限 fixture（admin、canManageGroup／canManageMembers 皆 true、各表至少一列）。 */
const PANEL3_GETS: Record<string, unknown> = {
  [`/api/groups/${GROUP_ID}/members`]: [
    { userId: "u-admin", email: "admin@example.com", displayName: "Admin", roleId: "r-admin", builtin: "admin" },
    { userId: "u-b", email: "b@example.com", displayName: "B", roleId: "r-member", builtin: "member" },
    // 第二位管理員：「關於」頁的 Leave 鈕只在「我不是唯一管理員」時渲染（`isLastAdmin`），少了它 Leave 永遠掃不到。
    { userId: "u-c", email: "c@example.com", displayName: "C", roleId: "r-admin", builtin: "admin" },
  ],
  [`/api/groups/${GROUP_ID}/roles`]: [adminRole(), memberRole(), customRole({ id: "r-custom", name: "Reader", memberCount: 0 })],
  [`/api/groups/${GROUP_ID}/storage`]: {
    usedBytes: 1048576, quotaBytes: 2147483648, planName: "Basic",
    byKind: { image: 1048576, audio: 0, video: 0, document: 0, other: 0 },
    byMember: [{ userId: "u-admin", handle: "admin", displayName: "Admin", bytes: 1048576 }],
  },
  "/api/admin/users": [
    { id: "u-admin", email: "admin@example.com", handle: "admin", displayName: "Admin", isAdmin: true, disabledAt: null, createdAt: T, lastLoginAt: T, lastActiveAt: T, storage: PLAN_STORAGE },
    { id: "u-b", email: "b@example.com", handle: "b", displayName: "B", isAdmin: false, disabledAt: null, createdAt: T, lastLoginAt: null, lastActiveAt: null, storage: PLAN_STORAGE },
  ],
  "/api/admin/storage-plans": { plans: [PLAN], defaults: { userPlanId: PLAN.id, groupPlanId: PLAN.id } },
  "/api/admin/groups": [{ id: GROUP_ID, name: "Team Alpha", createdAt: T, memberCount: 2, storage: PLAN_STORAGE }],
  "/api/admin/versions/settings": { keepAllDays: 7, dailyUntilDays: 30, autoVersionsEnabled: true },
  "/api/admin/auth/providers": {
    providers: [{
      id: PROVIDER_ID, template: "oidc", displayName: "SSO", issuerUrl: "https://idp.example", clientId: "kb", hasSecret: true,
      enabled: false, sortOrder: 0, legacyCallback: false, callbackUrl: "https://notes.example/api/auth/oidc/callback/x",
      insecureIssuer: false, issuerResolved: true, createdAt: T, iconKind: "template", icon: { type: "builtin", name: "generic" },
    }],
  },
  "/api/admin/auth/settings": { registrationEnabled: true, passwordLoginEnabled: true, passwordLoginForced: false, passwordLoginImpact: { usersWithoutSso: 0, actingAdminHasSso: true, enabledProviders: 1 } },
  [`/api/admin/auth/providers/${PROVIDER_ID}/impact`]: { linkedUsers: 1, lockedOutUsers: 0, issuerResolved: true, actingAdminLockedOut: false },
  "/api/admin/ai/providers": { providers: [{ id: "p1", name: "Claude", type: "anthropic", baseUrl: "https://api.anthropic.com", enabled: true, hasKey: true, degraded: false, createdAt: T }] },
  "/api/admin/ai/models": { models: [{ id: "m1", providerId: "p1", modelId: "claude", displayName: "Claude Sonnet", purpose: "chat", isDefault: true, enabled: true, createdAt: T }] },
  "/api/admin/ai/actions": { actions: [{ id: "a1", name: "Custom action", systemPrompt: "x", userTemplate: "{{text}}", modelId: null, applyMode: "preview", sortOrder: 1, enabled: true, builtin: false, kind: "quick" }] },
};

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
    if (url in PANEL3_GETS) return Promise.resolve(json(PANEL3_GETS[url]));
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

/**
 * 站台：登入——頂部開關（`/api/admin/auth/settings`）、服務列（`/providers`）、列內「已連結」格（每列一支 `/impact`）是三支各自到的請求；
 * 只等其中一支會在其他還在載入時就掃。發行者網址在寬／窄兩格各出現一次，所以以列 region 定位、等「已連結」格從「—」變成 1。
 */
async function adminLoginReady(): Promise<unknown> {
  await screen.findByRole("switch", { name: "Allow registration" });
  return within(await screen.findByRole("region", { name: "SSO" })).findByText("1");
}

/** 站台：AI 代理——供應商、模型、動作三支請求各自到；三者都等到才掃。 */
async function adminAiReady(): Promise<unknown> {
  await screen.findByRole("region", { name: "Claude" });
  await screen.findAllByText("Claude Sonnet"); // 模型名在供應商列的「模型」格與下方模型清單各出現一次
  return screen.findByText("Custom action");
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
  { name: "群組：成員", path: `/groups/${GROUP_ID}`, ready: () => screen.findByText("b@example.com"), minButtons: 4 }, // 實測 4：三列紅垃圾桶（Remove <email>）＋「Add」
  { name: "群組：角色", path: `/groups/${GROUP_ID}/roles`, ready: () => screen.findByRole("region", { name: "Reader" }), minButtons: 21 }, // 實測 21：New role＋三張角色卡各 6 個權限 switch＋自訂角色的鉛筆、紅垃圾桶
  { name: "群組：儲存空間", path: `/groups/${GROUP_ID}/storage`, ready: () => screen.findByText("@admin"), minButtons: 1 }, // 實測 1：自動版本 switch
  { name: "群組：關於", path: `/groups/${GROUP_ID}/about`, ready: async () => { await screen.findByRole("button", { name: "Delete group" }); return screen.findByRole("button", { name: "Leave group" }); }, minButtons: 3 }, // 實測 3：Save name、Leave group、Delete group（Leave 等成員清單到、且非唯一管理員才出現）
  { name: "站台：使用者", path: "/admin/users", ready: () => screen.findByText("b@example.com"), minButtons: 3 }, // 實測 3：Create user＋兩列啟用 switch
  { name: "站台：群組", path: "/admin/groups", ready: () => screen.findByRole("combobox", { name: "Storage plan for Team Alpha" }), minButtons: 0 }, // 實測 0：只有方案下拉（spec §7.0 不改、沒有刪除鈕），0 是真值
  { name: "站台：登入", path: "/admin/login", ready: adminLoginReady, minButtons: 9 }, // 實測 9：兩個存取 switch、Add sign-in service、列內插頭／鉛筆／圖示／紅垃圾桶、啟用 switch、明細區 Copy
  { name: "站台：儲存方案", path: "/admin/storage", ready: async () => { await screen.findByRole("button", { name: "Edit Basic" }); return screen.findByLabelText("Keep all for (days)"); }, minButtons: 6 }, // 實測 6：New plan、Edit／Delete Basic、Save defaults、自動版本 switch、版本設定 Save
  { name: "站台：AI 代理", path: "/admin/ai", ready: adminAiReady, minButtons: 15 }, // 實測 15：供應商（Add provider＋插頭／鉛筆／垃圾桶＋switch）、模型（Add model＋switch＋鉛筆／垃圾桶）、動作（Add action＋上移／下移＋switch＋鉛筆／垃圾桶）
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
