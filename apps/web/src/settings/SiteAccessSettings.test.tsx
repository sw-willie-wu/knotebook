import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AdminAuthSettingsDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { SiteAccessSettings } from "./SiteAccessSettings";

function fakeResponse(status: number, body?: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: body === undefined ? () => Promise.reject(new Error("no body")) : () => Promise.resolve(body) } as unknown as Response;
}
const BASE: AdminAuthSettingsDto = {
  registrationEnabled: true,
  passwordLoginEnabled: true,
  passwordLoginForced: false,
  passwordLoginImpact: { usersWithoutSso: 3, actingAdminHasSso: true, enabledProviders: 1 },
};

function setup(initial: AdminAuthSettingsDto, onPatch: (body: Record<string, boolean>) => Response | AdminAuthSettingsDto) {
  const state = { settings: initial };
  const patches: Array<Record<string, boolean>> = [];
  const gets: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url === "/api/admin/auth/settings" && method === "GET") {
      gets.push(url);
      return fakeResponse(200, state.settings);
    }
    if (url === "/api/admin/auth/settings" && method === "PATCH") {
      const body = JSON.parse(String(init!.body));
      patches.push(body);
      const r = onPatch(body);
      if (typeof (r as Response).status === "number" && "ok" in r) return r as Response;
      state.settings = r as AdminAuthSettingsDto;
      return fakeResponse(200, state.settings);
    }
    if (url === "/api/auth/config") return fakeResponse(200, { providers: [], registration: { enabled: true }, passwordLogin: { enabled: true } });
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <SiteAccessSettings />
      <Toaster />
    </QueryClientProvider>,
  );
  return { patches, gets, state };
}
const pwSwitch = () => screen.getByRole("switch", { name: "Allow password sign-in" });

describe("SiteAccessSettings（#187 §9.4、§9.5）", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); dismissAllToasts(); });
  afterEach(() => vi.unstubAllGlobals());

  it("註冊 Switch：切換即 PATCH {registrationEnabled}（W21 說明在旁）", async () => {
    const { patches } = setup(BASE, body => ({ ...BASE, ...body }));
    const sw = await screen.findByRole("switch", { name: "Allow registration" });
    expect(screen.getByText(/neither by registering with a password nor by signing in through a sign-in service for the first time/)).toBeInTheDocument();
    fireEvent.click(sw);
    await waitFor(() => expect(sw).toHaveAttribute("aria-checked", "false"));
    expect(patches).toEqual([{ registrationEnabled: false }]);
  });

  it("成功 PATCH 後重抓 settings（invalidate）", async () => {
    const { gets } = setup(BASE, body => ({ ...BASE, ...body }));
    const sw = await screen.findByRole("switch", { name: "Allow registration" });
    expect(gets).toHaveLength(1);
    fireEvent.click(sw);
    await waitFor(() => expect(gets).toHaveLength(2));
  });

  it("關閉帳密 → 先開確認 dialog 顯示 usersWithoutSso（不送 PATCH）；確認 → PATCH {passwordLoginEnabled:false}", async () => {
    const { patches } = setup(BASE, body => ({ ...BASE, ...body }));
    fireEvent.click(await screen.findByRole("switch", { name: "Allow password sign-in" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Turn off password sign-in?" }));
    expect(dialog.getByText("Accounts with no usable sign-in service: 3")).toBeInTheDocument();
    expect(patches).toEqual([]);
    fireEvent.click(dialog.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(pwSwitch()).toHaveAttribute("aria-checked", "false"));
    expect(patches).toEqual([{ passwordLoginEnabled: false }]);
  });

  it("開啟帳密：不經 dialog、直接 PATCH true", async () => {
    const { patches } = setup({ ...BASE, passwordLoginEnabled: false }, body => ({ ...BASE, ...body }));
    fireEvent.click(await screen.findByRole("switch", { name: "Allow password sign-in" }));
    await waitFor(() => expect(patches).toEqual([{ passwordLoginEnabled: true }]));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each([
    [{ enabledProviders: 0, actingAdminHasSso: true, usersWithoutSso: 0 }, "Turn on at least one sign-in service first."],
    [{ enabledProviders: 1, actingAdminHasSso: false, usersWithoutSso: 0 }, "Link a sign-in service in your own settings first."],
  ])("開著但關不了（%o）→ Switch disabled＋原因（aria-describedby）", async (impact, reason) => {
    setup({ ...BASE, passwordLoginImpact: impact }, () => BASE);
    const sw = await screen.findByRole("switch", { name: "Allow password sign-in" });
    expect(sw).toBeDisabled();
    expect(document.getElementById(sw.getAttribute("aria-describedby")!)).toHaveTextContent(reason);
  });

  it("可以關時（有啟用服務、本人有 SSO）→ Switch 可操作、沒有原因文字", async () => {
    setup(BASE, () => BASE);
    const sw = await screen.findByRole("switch", { name: "Allow password sign-in" });
    expect(sw).not.toBeDisabled();
    expect(sw).not.toHaveAttribute("aria-describedby");
    expect(screen.queryByText("Turn on at least one sign-in service first.")).not.toBeInTheDocument();
    expect(screen.queryByText("Link a sign-in service in your own settings first.")).not.toBeInTheDocument();
  });

  it("帳密已關：即使 enabledProviders=0 也不 disabled（要能開回來）", async () => {
    setup({ ...BASE, passwordLoginEnabled: false, passwordLoginImpact: { enabledProviders: 0, actingAdminHasSso: false, usersWithoutSso: 0 } }, () => BASE);
    const sw = await screen.findByRole("switch", { name: "Allow password sign-in" });
    expect(sw).not.toBeDisabled();
    expect(sw).toHaveAttribute("aria-checked", "false");
  });

  it("passwordLoginForced → 頂部警告；Switch 仍可操作", async () => {
    setup({ ...BASE, passwordLoginForced: true, passwordLoginEnabled: false }, body => ({ ...BASE, ...body }));
    expect(await screen.findByText(/forced on by the environment variable PASSWORD_LOGIN_FORCE_ENABLE/)).toBeInTheDocument();
    expect(pwSwitch()).not.toBeDisabled();
  });

  it("沒有 forced → 沒有環境變數警告", async () => {
    setup(BASE, () => BASE);
    await screen.findByRole("switch", { name: "Allow password sign-in" });
    expect(screen.queryByText(/PASSWORD_LOGIN_FORCE_ENABLE/)).not.toBeInTheDocument();
  });

  it("開確認 dialog 時重抓：人數是開 dialog 當下的（頁面載入後 server 值變了）", async () => {
    const { state, gets } = setup(BASE, () => BASE);
    const sw = await screen.findByRole("switch", { name: "Allow password sign-in" });
    state.settings = { ...BASE, passwordLoginImpact: { ...BASE.passwordLoginImpact, usersWithoutSso: 7 } };
    fireEvent.click(sw);
    const dialog = within(await screen.findByRole("dialog", { name: "Turn off password sign-in?" }));
    expect(await dialog.findByText("Accounts with no usable sign-in service: 7")).toBeInTheDocument();
    expect(gets).toHaveLength(2);
  });

  it("409 後重抓 settings：快照過期 → 第二次 GET 回 actingAdminHasSso:false，原因文字出現、Switch 變 disabled", async () => {
    const { state, gets } = setup(BASE, () => {
      // server 端狀態在頁面載入後變了；PATCH 因此 409
      state.settings = { ...BASE, passwordLoginImpact: { ...BASE.passwordLoginImpact, actingAdminHasSso: false } };
      return fakeResponse(409, { error: { code: "admin_sso_link_required", message: "x" } });
    });
    const sw = await screen.findByRole("switch", { name: "Allow password sign-in" });
    expect(sw).not.toBeDisabled();
    fireEvent.click(sw);
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Turn off" }));
    expect(await screen.findByText("Link a sign-in service in your own settings first.")).toBeInTheDocument();
    expect(pwSwitch()).toBeDisabled();
    expect(pwSwitch()).toHaveAttribute("aria-checked", "true");
    expect(gets.length).toBeGreaterThanOrEqual(3);
  });

  it("409 → toast 錯誤文案、Switch 維持原狀", async () => {
    setup(BASE, () => fakeResponse(409, { error: { code: "admin_sso_link_required", message: "x" } }));
    fireEvent.click(await screen.findByRole("switch", { name: "Allow password sign-in" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Turn off" }));
    expect(await screen.findByText(/before turning off password sign-in/)).toBeInTheDocument();
    expect(pwSwitch()).toHaveAttribute("aria-checked", "true");
  });
});
