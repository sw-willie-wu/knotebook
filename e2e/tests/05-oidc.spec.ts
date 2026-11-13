import { randomUUID } from "node:crypto";
import { test, expect, type Page } from "@playwright/test";
import { IDP_CONTROL_ORIGIN } from "../ports.js";
import { ADMIN, createNote, createUserViaInvite, loginAs, randomEmail } from "./helpers.js";

/**
 * 流程 5（#187 改寫）：SSO 兩情境（fake-idp）。e2e 疊的 `global-setup.ts` 以管理 API 建一個名為「SSO」的登入服務（指向 fake-idp 根 issuer、已啟用、
 * 開自動建帳），所以按鈕是「Sign in with SSO」。舊回呼網址（legacy_callback）管理 API 建不出來，只由 server 整合測試涵蓋。
 *
 * control endpoint 走 `IDP_CONTROL_ORIGIN`（`e2e/ports.ts`）下的 `/control/next-login`（`request` fixture 不吃瀏覽器的 host-resolver-rules）。
 * 識別值一律隨機化（sub、email）：腳本失敗時不 down 疊，重跑會吃到髒資料。
 * 另有一支量登入頁控制項高度（44px）：jsdom 不套 CSS，只能借這支的 SSO 按鈕在真瀏覽器量。
 */

const CONTROL_URL = `${IDP_CONTROL_ORIGIN}/control/next-login`;
const SSO_BUTTON = "Sign in with SSO";

test("情境一：SSO 登入未知 email → 自動建帳並登入", async ({ request, browser }) => {
  const email = randomEmail();
  const controlResponse = await request.put(CONTROL_URL, {
    data: { sub: `e2e-new-${randomUUID()}`, email, email_verified: true, name: "E2E New User" },
  });
  expect(controlResponse.ok()).toBe(true);

  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto("/login");
    await page.getByRole("link", { name: SSO_BUTTON }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
    await expect(page.getByRole("button", { name: "E2E New User", exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

/**
 * 情境二（#187 改寫，#285 起改走邀請）：admin 以邀請建帳密帳號（自設密碼、不強制改密碼）→ 同 email 的 SSO 首登**不再自動連結**
 * → `/link-account` 輸入該帳號的密碼 → 連結成功後**直接進站**；之後 SSO 直接進站；
 * 結尾的「雙路承諾」是邀請時設的密碼可登、SSO 也可登。
 * fake-idp 的 `name` claim 刻意與邀請時填的顯示名不同——UserMenu 顯示哪一個，就是「連到既有帳號」與「誤建新帳號」的分野。
 */
test("情境二：SSO 首登 email 命中邀請建的帳號 → 輸入該帳號密碼連結 → 直接進站 → 之後 SSO 與密碼都能登", async ({ request, browser }) => {
  const linkedEmail = randomEmail();
  const password = "e2e-oidc-linked-user-pw";
  const displayName = "E2E OIDC Linked User";
  const idpNameClaim = "IdP Claimed Name (must not appear)";
  const sub = `e2e-linked-${randomUUID()}`;

  // ── admin 建邀請、另一個 context 兌換（自建，不依賴其他 spec 的帳號）──────────────────
  const adminContext = await browser.newContext();
  try {
    const adminPage = await adminContext.newPage();
    await loginAs(adminPage, ADMIN.email, ADMIN.password);
    await expect(adminPage).toHaveURL(/\/$/);
    await createUserViaInvite(adminPage, { email: linkedEmail, password, displayName });
  } finally {
    await adminContext.close();
  }

  const putLogin = async () => {
    const res = await request.put(CONTROL_URL, { data: { sub, email: linkedEmail, email_verified: true, name: idpNameClaim } });
    expect(res.ok()).toBe(true);
  };

  // ── SSO 首登 → 連結頁 → 以帳號密碼確認 → 直接進站 ──────────────────────────────
  await putLogin();
  const ssoContext = await browser.newContext();
  try {
    const page = await ssoContext.newPage();
    await page.goto("/login");
    await page.getByRole("link", { name: SSO_BUTTON }).click();
    await expect(page).toHaveURL(/\/link-account$/, { timeout: 20_000 });
    await expect(page.getByText(`This email (${linkedEmail}) already has an account.`, { exact: false })).toBeVisible();
    await page.getByLabel("Password for this account").fill(password);
    await page.getByRole("button", { name: "Confirm with password and link" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("button", { name: displayName, exact: true })).toBeVisible();
    await expect(page.getByText(idpNameClaim)).toHaveCount(0);
  } finally {
    await ssoContext.close();
  }

  // ── 之後同一個 IdP 身分 SSO 直接進站（已連結）──────────────
  await putLogin();
  const againContext = await browser.newContext();
  try {
    const page = await againContext.newPage();
    await page.goto("/login");
    await page.getByRole("link", { name: SSO_BUTTON }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
    await expect(page.getByRole("button", { name: displayName, exact: true })).toBeVisible();
  } finally {
    await againContext.close();
  }

  // ── 雙路承諾：邀請時設的密碼可登、SSO 也可登，顯示名不變 ───────────────────
  const passwordContext = await browser.newContext();
  try {
    const page = await passwordContext.newPage();
    await loginAs(page, linkedEmail, password);
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("button", { name: displayName, exact: true })).toBeVisible();
  } finally {
    await passwordContext.close();
  }
});

/**
 * 情境三：IdP 的 `picture` → 首登後背景下載成 OIDC 候選並自動選用，再由瀏覽器補產顯示圖 → 側欄帳號按鈕出現圖；
 * 刪掉它之後再登入不會被補回，設定頁的「Use my SSO picture」才把它拿回來。
 * 圖放在 fake-idp 自己的 `/avatar.png`（與 issuer 同主機名同埠），下載器的位址檢查因此放行；不靠任何 e2e 專用放行縫。
 */
test("情境三：SSO 首登帶 picture → 自動成為候選並選用 → 補產顯示圖後側欄有圖；刪除後不被補回，手動「Use my SSO picture」才取回", async ({ request, browser }) => {
  test.setTimeout(180_000);
  const email = randomEmail();
  const sub = `e2e-picture-${randomUUID()}`;
  const displayName = "E2E Picture User";
  const picture = "http://fake-idp:9400/avatar.png";

  const putLogin = async () => {
    const res = await request.put(CONTROL_URL, { data: { sub, email, email_verified: true, name: displayName, picture } });
    expect(res.ok()).toBe(true);
  };
  const ssoLogin = async (page: Page) => {
    await putLogin();
    await page.goto("/login");
    await page.getByRole("link", { name: SSO_BUTTON }).click();
    await expect(page).toHaveURL(/\/$/, { timeout: 20_000 });
  };
  type Candidate = { id: string; source: string; providerName: string | null; pending: boolean; current: boolean };
  type AvatarList = { candidates: Candidate[]; auto: boolean; refreshable: { identityId: string; providerName: string }[] };
  const readList = async (page: Page) => (await (await page.request.get("/api/auth/avatars")).json()) as AvatarList;

  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    await ssoLogin(page);
    const accountButton = page.getByRole("button", { name: displayName, exact: true });
    await expect(accountButton).toBeVisible({ timeout: 15_000 });

    // 背景下載：候選出現且是目前這張（登入回應不等它，所以輪詢）。
    await expect.poll(async () => (await readList(page)).candidates.length, { timeout: 35_000 }).toBe(1);
    const first = (await readList(page)).candidates[0]!;
    expect(first.source).toBe("oidc");
    expect(first.providerName).toBe("SSO");
    expect(first.current).toBe(true);

    // 圖可能在首頁讀 /me 之後才到；重新整理＝再開一次 Knotebook，補產器才看得到 pending。
    await page.reload();
    await expect(accountButton).toBeVisible({ timeout: 15_000 });

    // 補產顯示圖由本人瀏覽器做（掛在 AppShell，人還停在首頁就會補；設定頁自己也會補，所以先不進去）：pending 變 false。
    await expect.poll(async () => (await readList(page)).candidates[0]?.pending, { timeout: 35_000 }).toBe(false);

    await page.goto("/settings/account");
    const group = page.getByRole("radiogroup", { name: "Picture options" });
    await expect(group.getByRole("radio", { name: "Picture from SSO", exact: true })).toHaveAttribute("aria-checked", "true", { timeout: 15_000 });

    // 側欄帳號按鈕內有載入完成的 <img>（回筆記頁看；先等標題框，lazy 頁換完殼才碰側欄）。
    await page.goto("/");
    await createNote(page, `E2E OIDC avatar ${Date.now()}`);
    await expect(page.getByLabel("Note title")).toBeVisible({ timeout: 15_000 });
    const accountImg = accountButton.locator("img");
    await expect(accountImg).toHaveCount(1, { timeout: 15_000 });
    await expect.poll(() => accountImg.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 15_000 }).toBeGreaterThan(0);

    // 刪掉它 → 再 SSO 登入一次：同一張圖不會被補回。
    const del = await page.request.delete(`/api/auth/avatars/${first.id}`);
    expect(del.status(), await del.text()).toBeLessThan(300);
    await page.request.post("/api/auth/logout");
    await ssoLogin(page);
    await expect(accountButton).toBeVisible({ timeout: 15_000 });
    // 沒有「會補回」的事件可等，只能給背景工作一個完整的視窗再確認仍沒有候選。
    await page.waitForTimeout(3_000);
    expect((await readList(page)).candidates).toHaveLength(0);

    // 設定頁的「Use my SSO picture」手動取回 → 又成為候選並選用。
    await page.goto("/settings/account");
    await page.getByRole("button", { name: "Use my SSO picture", exact: true }).click({ timeout: 15_000 });
    await expect(group.getByRole("radio", { name: "Picture from SSO", exact: true })).toHaveAttribute("aria-checked", "true", { timeout: 20_000 });
    const after = await readList(page);
    expect(after.candidates).toHaveLength(1);
    expect(after.candidates[0]!.current).toBe(true);
    expect(after.refreshable).toHaveLength(0);
  } finally {
    await context.close();
  }
});

/**
 * 同款卡片頁（登入、註冊、重設密碼、連結帳號、強制改密、OAuth 授權）的控制項是預設 32px 規則的例外：登入頁的「Sign in」與 SSO 鈕 44px（`size="lg"`），
 * 兩個輸入框跟著 44px，才好快速點中（見 `apps/web/src/components/ui/button.tsx` 規範）。jsdom 不套 CSS、算不出高度，只能在這裡量。
 */
test("登入頁：Sign in 鈕、SSO 鈕與兩個輸入框都是 44px 高", async ({ browser }) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto("/login");
    const targets = [
      { label: "Sign in", locator: page.getByRole("button", { name: "Sign in", exact: true }) },
      { label: SSO_BUTTON, locator: page.getByRole("link", { name: SSO_BUTTON }) },
      { label: "#login-email", locator: page.locator("#login-email") },
      { label: "#login-password", locator: page.locator("#login-password") },
    ];
    for (const { label, locator } of targets) {
      await expect(locator).toBeVisible();
      const box = await locator.boundingBox();
      expect(box, `${label} 應有 bounding box`).not.toBeNull();
      expect(Math.round(box!.height), `${label} 高度`).toBe(44);
    }
  } finally {
    await context.close();
  }
});
