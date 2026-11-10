import { expect, test, type APIRequestContext } from "@playwright/test";
import { ADMIN, adminNav, loginAs, openSiteAdmin } from "./helpers.js";

/**
 * 站台管理「站台限制」分頁：改「解析時限」→ 儲存 → reload 後仍在、修改紀錄最新一列是這次的修改、
 * 「排隊最長等待」的自動值跟著變 → 「恢復預設」回預設（reload 後仍是預設）。
 *
 * 解析時限是整座疊共用的設定，所以每個案例前後都用 API 還原（不靠畫面）：前面讓起點確定是預設，後面不論案例怎麼結束都不留 5 秒。
 * 修改紀錄是這座疊累積的：重用的疊裡有先前留下的列，所以只看最新一列，不斷言總列數。
 */

async function resetParseTimeout(request: APIRequestContext): Promise<void> {
  const login = await request.post("/api/auth/login", { data: { email: ADMIN.email, password: ADMIN.password } });
  expect(login.status(), `POST /api/auth/login → HTTP ${login.status()}`).toBe(200);
  const res = await request.patch("/api/admin/limits", { data: { set: { parseTimeoutMs: null } } });
  expect(res.status(), `PATCH /api/admin/limits → HTTP ${res.status()} ${await res.text()}`).toBe(200);
}

test.beforeEach(async ({ request }) => {
  await resetParseTimeout(request);
});

test.afterEach(async ({ request }) => {
  await resetParseTimeout(request);
});

test("47-1 解析時限：改 5 秒存起來、reload 仍在、紀錄最新一列是它、排隊等待的自動值跟著變、恢復預設回 10", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await page.goto("/");
  const dialog = await openSiteAdmin(page);
  await adminNav(page, "Site limits");

  const row = dialog.getByRole("group", { name: "Parse time limit" });
  const input = row.getByRole("textbox", { name: "Parse time limit" });
  const queueRow = dialog.getByRole("group", { name: "Longest wait for a worker" });
  const parseGroup = dialog.getByRole("region", { name: "Parse workers" });

  // 起點是預設：時限 10 秒、排隊等待自動 45 秒。
  await expect(input).toHaveValue("10");
  await expect(queueRow.getByText("Auto: 45 seconds")).toBeVisible();

  await input.fill("5");
  await parseGroup.getByRole("button", { name: "Save", exact: true }).click();
  // 「已儲存」的提示是區塊外的 toast，這裡改看區塊內的結果：這一列出現「Adjusted」標記。
  await expect(row.getByText("Adjusted")).toBeVisible();

  await page.reload();
  await expect(input).toHaveValue("5");
  await expect(row.getByText("Adjusted")).toBeVisible();
  await expect(queueRow.getByText("Auto: 25 seconds")).toBeVisible();

  // 伺服器把紀錄新到舊排；第 0 列是表頭，第 1 列是最新的資料列。
  const newest = dialog.getByRole("table", { name: "Recent changes" }).getByRole("row").nth(1);
  await expect(newest).toContainText("Parse time limit");
  await expect(newest).toHaveText(/→ 5 seconds$/);

  await row.getByRole("button", { name: "Restore default" }).click();
  await expect(input).toHaveValue("10");
  await expect(row.getByText("Adjusted")).toHaveCount(0);
  await expect(queueRow.getByText("Auto: 45 seconds")).toBeVisible();

  await page.reload();
  await expect(input).toHaveValue("10");
});
