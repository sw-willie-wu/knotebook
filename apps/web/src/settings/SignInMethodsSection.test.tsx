import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";
import type { IdentitiesDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { SignInMethodsSection } from "./SignInMethodsSection";

function fakeResponse(status: number, body?: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: body === undefined ? () => Promise.reject(new Error("no body")) : () => Promise.resolve(body) } as unknown as Response;
}
function LocationProbe() {
  const l = useLocation();
  return <div data-testid="location">{`${l.pathname}${l.search}`}</div>;
}
const BASE: IdentitiesDto = {
  identities: [
    { id: "i1", issuer: "https://gitlab.example", providers: [{ id: "p1", displayName: "<b>GitLab</b>" }], createdAt: "2026-10-01T00:00:00.000Z", lastLoginAt: "2026-10-05T00:00:00.000Z", unlinkable: true },
    { id: "i2", issuer: "https://gone.example/realms/x", providers: [], createdAt: "2026-10-02T00:00:00.000Z", lastLoginAt: null, unlinkable: false },
  ],
  linkable: [{ providerId: "p2", displayName: "Google", template: "google" }],
  hasPassword: true,
  passwordLoginEnabled: true,
};

function setup(data: IdentitiesDto, path = "/settings/account", extra: (m: string, u: string) => Response | null = () => null) {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url, body: typeof init?.body === "string" ? init.body : undefined });
    const r = extra(method, url);
    if (r) return r;
    if (method === "GET" && url === "/api/auth/identities") return fakeResponse(200, data);
    throw new Error(`unexpected fetch: ${method} ${url}`);
  }));
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <MemoryRouter initialEntries={[path]}>
        <SignInMethodsSection />
        <LocationProbe />
      </MemoryRouter>
      <Toaster />
    </QueryClientProvider>,
  );
  return { calls };
}

describe("SignInMethodsSection（#187 §8.5）", () => {
  beforeEach(async () => { await i18n.changeLanguage("en"); dismissAllToasts(); });
  afterEach(() => vi.unstubAllGlobals());

  it("已連結列：provider 名（HTML 形渲染為字面）、對不到 provider 時顯示 issuer host、日期；可連結列：Link X", async () => {
    setup(BASE);
    const row1 = within(await screen.findByRole("listitem", { name: "<b>GitLab</b>" }));
    expect(row1.getByText(/^Linked /)).toBeInTheDocument();
    expect(row1.getByText(/^Last used /)).toBeInTheDocument();
    expect(document.querySelector("b")).toBeNull();
    const row2 = within(screen.getByRole("listitem", { name: /gone\.example/ }));
    expect(row2.getByText("Removed or turned-off sign-in service")).toBeInTheDocument();
    expect(row2.getByText("Never used")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Link Google" })).toBeInTheDocument();
  });

  it("對不到 provider 的列只顯示 issuer 的 host（不含 scheme 與 path）", async () => {
    setup(BASE);
    const row2 = await screen.findByRole("listitem", { name: /gone\.example/ });
    expect(document.getElementById(row2.getAttribute("aria-labelledby")!)).toHaveTextContent(/^gone\.example$/);
  });

  it("unlinkable=false → 解除鈕 disabled，原因以可見文字＋aria-describedby 說明", async () => {
    setup(BASE);
    const row2 = within(await screen.findByRole("listitem", { name: /gone\.example/ }));
    const button = row2.getByRole("button", { name: "Unlink" });
    expect(button).toBeDisabled();
    const hint = document.getElementById(button.getAttribute("aria-describedby")!);
    expect(hint).toHaveTextContent("This is your only way to sign in, so it can't be unlinked.");
  });

  it("解除 → 確認 dialog（destructive）→ DELETE、重抓列表", async () => {
    let current = BASE;
    const { calls } = setup(BASE, "/settings/account", (m, u) => {
      if (m === "DELETE" && u === "/api/auth/identities/i1") { current = { ...BASE, identities: [BASE.identities[1]!] }; return fakeResponse(204); }
      if (m === "GET" && u === "/api/auth/identities") return fakeResponse(200, current);
      return null;
    });
    const row1 = within(await screen.findByRole("listitem", { name: "<b>GitLab</b>" }));
    fireEvent.click(row1.getByRole("button", { name: "Unlink" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Unlink this sign-in service?" }));
    fireEvent.click(dialog.getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(screen.queryByRole("listitem", { name: "<b>GitLab</b>" })).not.toBeInTheDocument());
    expect(calls.some(c => c.method === "DELETE" && c.url === "/api/auth/identities/i1")).toBe(true);
  });

  it("解除 409 last_login_method → toast 錯誤文案、列表仍在", async () => {
    setup(BASE, "/settings/account", (m, u) =>
      m === "DELETE" && u === "/api/auth/identities/i1" ? fakeResponse(409, { error: { code: "last_login_method", message: "x" } }) : null);
    const row1 = within(await screen.findByRole("listitem", { name: "<b>GitLab</b>" }));
    fireEvent.click(row1.getByRole("button", { name: "Unlink" }));
    const dialog = within(await screen.findByRole("dialog", { name: "Unlink this sign-in service?" }));
    fireEvent.click(dialog.getByRole("button", { name: "Unlink" }));
    expect(await screen.findByText("This is the account's only way to sign in, so it can't be unlinked.")).toBeInTheDocument();
    // 失敗時 dialog 維持開著（列表被 modal 設為 aria-hidden，故以 hidden:true 取列）。
    expect(screen.getByRole("dialog", { name: "Unlink this sign-in service?" })).toBeInTheDocument();
    expect(screen.getByRole("listitem", { name: "<b>GitLab</b>", hidden: true })).toBeInTheDocument();
  });

  it("連結 → POST /api/auth/oidc/link/p2 帶 JSON {} → location.assign(url)", async () => {
    const assign = vi.fn();
    const { calls } = setup(BASE, "/settings/account", (m, u) => (m === "POST" && u === "/api/auth/oidc/link/p2" ? fakeResponse(200, { url: "https://idp.example/authorize?x=1" }) : null));
    vi.stubGlobal("location", { ...window.location, assign });
    fireEvent.click(await screen.findByRole("button", { name: "Link Google" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("https://idp.example/authorize?x=1"));
    expect(calls.find(c => c.method === "POST")!.body).toBe("{}");
  });

  it("?linked= → toast 成功；只刪 linked／link_error 兩鍵、其餘參數保留", async () => {
    setup(BASE, "/settings/account?linked=p2&keep=1");
    expect(await screen.findByText("Sign-in service linked.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/settings\/account\?keep=1$/));
  });

  it("?link_error= 帶 keep=1 → 只刪 link_error，keep 保留", async () => {
    setup(BASE, "/settings/account?link_error=identity_taken&keep=1");
    expect(await screen.findByText("This sign-in identity is already linked to a different account.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/settings\/account\?keep=1$/));
  });

  it("回程參數：?link_error= 是 __proto__ → fallback 文案、不炸、參數被清掉", async () => {
    setup(BASE, "/settings/account?link_error=__proto__");
    expect(await screen.findByText("An unexpected error occurred.")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId("location")).toHaveTextContent(/^\/settings\/account$/));
  });

  it("回程參數：?link_error=forbidden（是合法 errors 鍵、但不在白名單）→ fallback 文案，不渲染該鍵的文案", async () => {
    setup(BASE, "/settings/account?link_error=forbidden");
    expect(await screen.findByText("An unexpected error occurred.")).toBeInTheDocument();
    expect(screen.queryByText("You don't have permission to do that.")).not.toBeInTheDocument();
  });

  it.each([
    ["identity_taken", "This sign-in identity is already linked to a different account."],
    ["oidc_state_mismatch", "Your sign-in session expired or is invalid. Please try signing in again."],
    ["oidc_claim_too_long", "Your identity provider sent an email address or account ID that is too long to use."],
  ])("?link_error=%s → 對應文案", async (code, text) => {
    setup(BASE, `/settings/account?link_error=${code}`);
    expect(await screen.findByText(text)).toBeInTheDocument();
  });
});
