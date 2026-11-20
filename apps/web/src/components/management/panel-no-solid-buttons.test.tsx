import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { ApiTokenDto, GroupDto, IdentitiesDto, SiteLimitsDto, StorageUsageDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ThemeProvider } from "@/theme";
import { AppRoutes } from "@/App";
import { adminRole, customRole, groupDto, memberRole } from "@/test/fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { siteLimitChange, siteLimitsDto } from "@/test/site-limits-fixtures";

/**
 * #247: the right card of the three management panels contains no solid button (brandDeep / brandSolid / default). Scanned at render time:
 * each page renders through the real AppRoutes with fixtures granting maximum permission, and after the content loads takes every
 * `button`, `a[class]` and `[role="button"]` inside [data-management-content]. Nested dialogs opened from a panel (their submit button uses brandDeep per
 * the usual rule) are portals and render outside content anyway; the extra filter on `closest('[role="dialog"]')` for the panel's own is only a safeguard.
 * Matching is per token exactly: `hover:bg-brand-deep`, `bg-brand-soft` and `data-[state=checked]:bg-brand` are different tokens and unaffected.
 * `minButtons` guards against vacuous passes: the page must scan at least this many panel-level elements (button / a[class] / role=button).
 *
 * PANEL_PAGES ends with the four group pages and six site pages (endpoint fixtures in `PANEL3_GETS`, matched on exact URL by panelFetch).
 */
const SOLID_TOKENS = ["bg-brand-deep", "bg-brand", "bg-primary", "bg-destructive"];

const ADMIN: UserDto = {
  id: "u-admin", email: "admin@example.com", handle: "admin", displayName: "Admin",
  isAdmin: true, mustChangePassword: false, hasPassword: true, autoVersions: true,
  avatar: null,
};
const SSO_ADMIN: UserDto = { ...ADMIN, id: "u-sso", hasPassword: false };

const IDENTITIES: IdentitiesDto = {
  identities: [
    { id: "i1", issuer: "https://gitlab.example", providers: [{ id: "p1", displayName: "GitLab", icon: { type: "builtin", name: "generic" } }], createdAt: "2026-10-01T00:00:00.000Z", lastLoginAt: null, unlinkable: true },
  ],
  linkable: [{ providerId: "p2", displayName: "Google", template: "google", icon: { type: "builtin", name: "generic" } }],
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
/** Site limits: all 17 items present; two adjusted (each with an extra "restore default" / "back to auto" button), one locked by env, one change-log row. */
const SITE_LIMITS_FIXTURE: SiteLimitsDto = siteLimitsDto(
  {
    noteMaxBytes: { value: 5242881, source: "env", locked: true, stored: 2097152 },
    parseWorkers: { value: 2, source: "admin", stored: 2 },
    rateEdit: { value: 20, source: "admin", stored: 20 },
  },
  { changes: [siteLimitChange()] },
);
const TAG_LIST = [
  { id: "tag-work", name: "Work", color: "blue", noteCount: 2 },
  { id: "tag-ideas", name: "Ideas", color: "purple", noteCount: 0 },
];
/** Maximum-permission fixtures for the ten group/site pages (admin, canManageGroup/canManageMembers both true, at least one row per table). */
const PANEL3_GETS: Record<string, unknown> = {
  [`/api/groups/${GROUP_ID}/members`]: [
    { userId: "u-admin", email: "admin@example.com", displayName: "Admin", roleId: "r-admin", builtin: "admin" },
    { userId: "u-b", email: "b@example.com", displayName: "B", roleId: "r-member", builtin: "member" },
    // A second admin: the About page's Leave button renders only when I am not the only admin (`isLastAdmin`); without it Leave would never be scanned.
    { userId: "u-c", email: "c@example.com", displayName: "C", roleId: "r-admin", builtin: "admin" },
  ],
  [`/api/groups/${GROUP_ID}/roles`]: [adminRole(), memberRole(), customRole({ id: "r-custom", name: "Reader", memberCount: 0 })],
  "/api/tags": TAG_LIST,
  [`/api/groups/${GROUP_ID}/tags`]: TAG_LIST,
  [`/api/groups/${GROUP_ID}/storage`]: {
    usedBytes: 1048576, quotaBytes: 2147483648, planName: "Basic",
    byKind: { image: 1048576, audio: 0, video: 0, document: 0, other: 0 },
    byMember: [{ userId: "u-admin", handle: "admin", displayName: "Admin", bytes: 1048576 }],
  },
  "/api/admin/users": [
    { id: "u-admin", email: "admin@example.com", handle: "admin", displayName: "Admin", isAdmin: true, disabledAt: null, createdAt: T, lastLoginAt: T, lastActiveAt: T, hasPassword: true, passwordResetExpiresAt: null, storage: PLAN_STORAGE },
    { id: "u-b", email: "b@example.com", handle: "b", displayName: "B", isAdmin: false, disabledAt: null, createdAt: T, lastLoginAt: null, lastActiveAt: null, hasPassword: true, passwordResetExpiresAt: null, storage: PLAN_STORAGE },
  ],
  "/api/admin/invites": [
    { id: "i-1", label: "Alice", status: "pending", createdAt: T, expiresAt: T, usedAt: null, revokedAt: null, createdBy: { id: "u-admin", email: "admin@example.com" }, usedBy: null },
    { id: "i-2", label: null, status: "pending", createdAt: T, expiresAt: T, usedAt: null, revokedAt: null, createdBy: null, usedBy: null },
  ],
  "/api/admin/storage-plans": { plans: [PLAN], defaults: { userPlanId: PLAN.id, groupPlanId: PLAN.id } },
  "/api/admin/groups": [{ id: GROUP_ID, name: "Team Alpha", createdAt: T, memberCount: 2, storage: PLAN_STORAGE }],
  "/api/admin/versions/settings": { keepAllDays: 7, dailyUntilDays: 30, autoVersionsEnabled: true, autoWaitMinutes: 5 },
  "/api/admin/trash/settings": { retentionDays: 7 },
  "/api/admin/auth/providers": {
    providers: [{
      id: PROVIDER_ID, template: "oidc", displayName: "SSO", issuerUrl: "https://idp.example", clientId: "kb", hasSecret: true,
      enabled: false, autoCreateEnabled: false, sortOrder: 0, legacyCallback: false, callbackUrl: "https://notes.example/api/auth/oidc/callback/x",
      insecureIssuer: false, issuerResolved: true, createdAt: T, iconKind: "template", icon: { type: "builtin", name: "generic" },
    }],
  },
  "/api/admin/auth/settings": { registrationEnabled: true, passwordLoginEnabled: true, passwordLoginForced: false, passwordLoginImpact: { usersWithoutSso: 0, actingAdminHasSso: true, enabledProviders: 1 } },
  [`/api/admin/auth/providers/${PROVIDER_ID}/impact`]: { linkedUsers: 1, lockedOutUsers: 0, issuerResolved: true, actingAdminLockedOut: false },
  "/api/admin/ai/providers": { providers: [{ id: "p1", name: "Claude", type: "anthropic", baseUrl: "https://api.anthropic.com", enabled: true, hasKey: true, degraded: false, createdAt: T }] },
  "/api/admin/ai/models": { models: [{ id: "m1", providerId: "p1", modelId: "claude", displayName: "Claude Sonnet", purpose: "chat", isDefault: true, enabled: true, createdAt: T }] },
  "/api/admin/ai/actions": { actions: [{ id: "a1", name: "Custom action", systemPrompt: "x", userTemplate: "{{text}}", modelId: null, applyMode: "preview", sortOrder: 1, enabled: true, builtin: false, kind: "quick" }] },
  "/api/admin/limits": SITE_LIMITS_FIXTURE,
};

function json(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response;
}

/**
 * Returns `{ fetch, unexpected }`: requests with no stub are recorded in `unexpected` and then rejected. Throwing alone would only put that query
 * in the error state and the test would stay green; each case asserts `unexpected` is empty before scanning (also reported first when ready times out, so the missing endpoint is visible).
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
      return Promise.resolve(json({ providers: [], registration: { enabled: false, providerIds: [] }, passwordLogin: { enabled: true }, autoVersionsEnabled: true }));
    if (url === "/api/auth/identities") return Promise.resolve(json({ ...IDENTITIES, hasPassword: user.hasPassword }));
    if (url === "/api/auth/tokens") return Promise.resolve(json({ tokens: [TOKEN] }));
    if (url === "/api/storage") return Promise.resolve(json(STORAGE));
    if (url === "/api/auth/avatars") return Promise.resolve(json({ candidates: [], auto: false, refreshable: [] }));
    if (url === "/api/groups") return Promise.resolve(json(GROUPS));
    if (url === "/api/folders") return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
    if (url === "/api/notes") return Promise.resolve(json([]));
    if (url === "/api/favorites") return Promise.resolve(json([]));
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
 * The login page's password form depends only on `/api/auth/me` (arrives first), the linked sign-in methods on `/api/auth/identities` (arrives later) -
 * waiting only for the password button would scan while identities is still loading (once only 1 button was scanned). So wait for both: the "Unlink" in-row button + "Link Google".
 */
async function loginReady(passwordButton: string): Promise<unknown> {
  await screen.findByRole("button", { name: "Unlink" });
  await screen.findByRole("button", { name: /Link Google/ });
  return screen.findByRole("button", { name: passwordButton });
}

/**
 * Site: sign-in - the top switch (`/api/admin/auth/settings`), the provider rows (`/providers`) and the in-row "linked" cell (one `/impact` per row) are three separately arriving requests;
 * waiting for only one would scan while the others are still loading. Locates the sign-in provider data row and waits for the "linked" cell to change from a dash to 1;
 * the "sign-in period and token" group is drawn separately from `/api/admin/limits`, so wait for its save button too.
 */
async function adminLoginReady(): Promise<unknown> {
  await screen.findByRole("switch", { name: "Allow self-registration with a password" });
  await within(await screen.findByRole("region", { name: "Session and tokens" })).findByRole("button", { name: "Save" });
  return within(await screen.findByRole("row", { name: "SSO" })).findByText("1");
}

/** Site: AI agents - the providers, models and actions requests arrive separately; wait for all three before scanning. */
async function adminAiReady(): Promise<unknown> {
  await screen.findByRole("row", { name: "Claude" });
  await screen.findAllByText("Claude Sonnet"); // the model name appears once in the provider row's model cell and once in the details row's model sub-table
  return screen.findByText("Custom action");
}

export const PANEL_PAGES: PanelPageCase[] = [
  { name: "personal: account info", path: "/settings/account", ready: () => screen.findByRole("button", { name: "Save URL name" }), minButtons: 2 },
  { name: "personal: sign-in (with password)", path: "/settings/login", ready: () => loginReady("Change password"), minButtons: 3 },
  { name: "personal: sign-in (SSO-only)", path: "/settings/login", user: SSO_ADMIN, ready: () => loginReady("Add password"), minButtons: 3 },
  { name: "personal: authorization", path: "/settings/authorization", ready: () => screen.findByText("Script"), minButtons: 7 }, // token section three (create + in-row pencil + red trash, #247; same count as the earlier create + rename + revoke) + three "Copy" in the MCP guide + one external docs <a class>
  // The switch depends only on config; the usage group (no button, but on the same page) counts as loaded only once `/api/storage` arrives.
  { name: "personal: storage", path: "/settings/storage", ready: async () => { await screen.findByRole("switch"); return screen.findByText(/\(Basic\)/); }, minButtons: 1 },
  { name: "personal: tags", path: "/settings/tags", ready: () => screen.findByRole("row", { name: "Work" }), minButtons: 8 }, // 8: two tags, each with a color dropdown trigger and three icon buttons (rename, merge, red trash)
  { name: "personal: groups", path: "/settings/groups", ready: async () => within(await screen.findByRole("dialog")).findByText("Team Alpha"), minButtons: 0 }, // the background NoteList sidebar also has a group with the same name
  { name: "personal: about", path: "/settings/about", ready: () => screen.findByText("LICENSE"), minButtons: 3 }, // three external <a class> links (repo, docs/, LICENSE)
  { name: "group: members", path: `/groups/${GROUP_ID}`, ready: () => screen.findByText("b@example.com"), minButtons: 9 }, // 9: three red trash (Remove <email>) + "Add" + three row role dropdown triggers + the add-member role dropdown trigger (a Select trigger is a button with no solid background)
  { name: "group: roles", path: `/groups/${GROUP_ID}/roles`, ready: () => screen.findByRole("region", { name: "Reader" }), minButtons: 21 }, // 21: New role + three role cards with 6 permission switches each + the custom role's pencil and red trash
  { name: "group: tags", path: `/groups/${GROUP_ID}/tags`, ready: () => screen.findByRole("row", { name: "Work" }), minButtons: 8 }, // same table as the personal page; the admin role has canManageGroup
  { name: "group: storage", path: `/groups/${GROUP_ID}/storage`, ready: () => screen.findByText("@admin"), minButtons: 1 }, // 1: the auto-versions switch
  { name: "group: about", path: `/groups/${GROUP_ID}/about`, ready: async () => { await screen.findByRole("button", { name: "Delete group" }); return screen.findByRole("button", { name: "Leave group" }); }, minButtons: 3 }, // 3: Save name, Leave group, Delete group (Leave appears only once the member list has arrived and I am not the only admin)
  { name: "site: users", path: "/admin/users", ready: async () => { await screen.findByText("b@example.com"); return screen.findByText("Alice"); }, minButtons: 11 }, // 11: Create invitation + two reset buttons + two enable switches + two revoke trashes (two pending rows in the invite table) + four role/plan dropdown triggers
  { name: "site: groups", path: "/admin/groups", ready: () => screen.findByRole("combobox", { name: "Storage plan for Team Alpha" }), minButtons: 1 }, // 1: the plan dropdown trigger (no delete button)
  { name: "site: sign-in", path: "/admin/login", ready: adminLoginReady, minButtons: 11 }, // 11: two access switches, Save of the "sign-in period and token" group (both items at default, so no restore-default button), Add sign-in service, the in-row auto-create-account switch, plug/pencil/icon/red trash, enable switch, details Copy
  { name: "site: storage plans", path: "/admin/storage", ready: async () => { await screen.findByRole("button", { name: "Edit Basic" }); await screen.findByLabelText("Keep all for (days)"); return screen.findByRole("switch", { name: "Delete automatically" }); }, minButtons: 10 }, // 10: New plan, Edit/Delete Basic, Save defaults, two default-plan dropdown triggers, the auto-versions switch, versions settings Save, trash switch, trash Save
  { name: "site: AI agents", path: "/admin/ai", ready: adminAiReady, minButtons: 15 }, // 15: providers (Add provider + plug/pencil/trash + switch), models (Add model + switch + pencil/trash), actions (Add action + move up/down + switch + pencil/trash)
  { name: "site: site limits", path: "/admin/limits", ready: async () => within(await screen.findByRole("region", { name: "Rate limits" })).findByRole("button", { name: "Save" }), minButtons: 5 }, // 5: one Save in each of the three blocks, Back to auto for the parse worker count, Restore default for the note write count
];

describe("no solid buttons inside panels (#247, at render time)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(PANEL_PAGES)("$name ($path)", async ({ path, user, ready, minButtons }) => {
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
    // `a[class]`: `<Button asChild><Link/></Button>` renders as an <a> with a class, which must be scanned too.
    const buttons = Array.from(content!.querySelectorAll<HTMLElement>('button, a[class], [role="button"]')).filter(
      (b) => b.closest('[role="dialog"]') === panel,
    );
    expect(buttons.length).toBeGreaterThanOrEqual(minButtons);
    // For each, list the matched token, accessible name (aria-label or the first 40 chars of textContent) and the start of outerHTML, so a failure shows which one.
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
