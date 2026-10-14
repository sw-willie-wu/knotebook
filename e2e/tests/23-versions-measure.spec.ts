import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { ADMIN, editorLocator, loginAs, setAutoWait } from "./helpers.js";

/**
 * 量測（不是功能斷言）：spec §13-9【推】舊筆記第一下按鍵／開了就關是否多切一版；§13-5【推】2000 區塊在真瀏覽器的預覽耗時。
 * 數字印成 `MEASURE-…` 行，由 Task 16 寫進文件。§13-9 的期望（不多切）是 spec D9 的產品要求——成立就留著當守衛；
 * 不成立就是發現，停下交 Willie（見 plan Task 15 Step 4）。
 */
const COMPOSE = ["compose", "-p", "knotebook-e2e", "-f", "../docker-compose.yml", "-f", "../docker-compose.e2e.yml"];
const ORIGIN = "http://localhost:3100";
/** 40×40 灰色 PNG（1×1 在編輯器裡點不到）。 */
const PNG_40 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAACgAAAAoCAIAAAADnC86AAAAK0lEQVR4nO3NMQ0AAAwDoMqv7JpYsgcMkD6JWCwWi8VisVgsFovFYrFYfGcPqfaI6W3y9QAAAABJRU5ErkJggg==",
  "base64",
);
const SEED = readFileSync(fileURLToPath(new URL("./fixtures/seed-legacy-note.cjs", import.meta.url)), "utf8");

async function versionCount(request: APIRequestContext, id: string): Promise<number> {
  const res = await request.get(`/api/notes/${id}/versions?limit=100`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { versions: unknown[] }).versions.length;
}

/**
 * #272：等那篇的版本數穩定——離開後落盤（debounce 2 s）寫待切、停手 X（測試縫 2 s）後掃描器（e2e 疊每秒一輪）切；
 * 連續 6 秒不變才算穩定（X 2＋掃描 1＋落盤 2＋餘裕）。
 */
async function settledCount(request: APIRequestContext, id: string): Promise<number> {
  let last = -1;
  let stableSince = Date.now();
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const n = await versionCount(request, id);
    if (n !== last) {
      last = n;
      stableSince = Date.now();
    } else if (Date.now() - stableSince >= 6_000) return n;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`settledCount: 版本數 30 秒內沒有穩定（最後一次 ${last}）`);
}

// #272：23a 用測試縫把等待 X 壓成 2 秒；每一案結束一律設回站台設定（失敗中途也一樣——設定是整座疊共用的）。
test.afterEach(async ({ page }) => {
  await setAutoWait(page, null).catch(() => undefined);
});

async function openAndWait(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByRole("status").filter({ hasText: /^Connected/ })).toBeVisible({ timeout: 15_000 });
  await editorLocator(page).waitFor({ timeout: 15_000 });
}

test("23a §13-9：舊 schema 形的筆記——開了就關、在 heading／paragraph／清單項各打一字再刪、圖片 caption 改了再清空，各多切幾版", async ({ page }) => {
  // 四輪 roundTrip（加開了就關一輪）各含載入／離開與 settle 等待（#272 起穩定窗 6 s），留餘裕。
  test.setTimeout(240_000);
  await loginAs(page, ADMIN.email, ADMIN.password);
  await setAutoWait(page, 2);
  const created = await page.request.post("/api/notes", { data: { title: `E2E legacy ${Date.now()}` } });
  expect(created.ok()).toBe(true);
  const note = (await created.json()) as { id: string; ownerHandle: string; slug: string };
  // 圖：走 API 真上傳（同 22-presentation），url 交給 seed 寫進 image 區塊。
  const upload = await page.request.post(`/api/notes/${note.id}/uploads`, {
    headers: { Origin: ORIGIN },
    multipart: { file: { name: "legacy.png", mimeType: "image/png", buffer: PNG_40 } },
  });
  expect(upload.status()).toBe(201);
  const { url: imageUrl } = (await upload.json()) as { url: string };
  execFileSync("docker", [...COMPOSE, "exec", "-T", "-e", `NOTE_ID=${note.id}`, "-e", `IMAGE_URL=${imageUrl}`, "app", "node", "-e", SEED], {
    stdio: "inherit",
  });
  const path = `/n/${note.ownerHandle}/${note.slug}`;
  expect(await settledCount(page.request, note.id)).toBe(0);

  await openAndWait(page, path);
  await expect(editorLocator(page)).toContainText("Legacy paragraph");
  await expect(editorLocator(page).locator(`img[src*="${imageUrl}"]`)).toBeVisible({ timeout: 15_000 });
  // 等 WS 把更新送到 server 再離開（沒有可等待的訊號，只能固定等）。
  await page.waitForTimeout(3_000);
  await page.goto("/");
  const openClose = await settledCount(page.request, note.id);

  /** 開那篇 → 做一件「做完等於沒做」的事 → 離開，回傳這一輪多切的版本數。 */
  let before = openClose;
  async function roundTrip(act: () => Promise<void>): Promise<number> {
    await openAndWait(page, path);
    await act();
    // 等 WS 把更新送到 server 再離開（沒有可等待的訊號，只能固定等）。
    await page.waitForTimeout(3_000);
    await page.goto("/");
    const after = await settledCount(page.request, note.id);
    const delta = after - before;
    before = after;
    return delta;
  }
  const typeAndDelete = (text: string) => async () => {
    await editorLocator(page).getByText(text).click();
    await page.keyboard.press("End");
    await page.keyboard.type("x");
    await page.keyboard.press("Backspace");
  };
  const heading = await roundTrip(typeAndDelete("Legacy heading"));
  const paragraph = await roundTrip(typeAndDelete("Legacy paragraph"));
  const numbered = await roundTrip(typeAndDelete("Legacy numbered"));
  // 圖片沒有文字可打：點選圖片 → formatting toolbar 的「Edit caption」改成 x → 再開一次清空，最後 caption 回到預設 ""。
  const image = await roundTrip(async () => {
    const editCaption = async (value: string) => {
      await editorLocator(page).locator(`img[src*="${imageUrl}"]`).click();
      await page.getByRole("button", { name: "Edit caption" }).click();
      const input = page.getByPlaceholder("Edit caption");
      await input.fill(value);
      await input.press("Enter");
    };
    await editCaption("x");
    await expect(editorLocator(page).getByText("x", { exact: true })).toBeVisible();
    await editCaption("");
    await expect(editorLocator(page).getByText("x", { exact: true })).toHaveCount(0);
  });
  const typeDelete = heading + paragraph + numbered + image;

  console.log(
    `MEASURE-13-9 openClose=${openClose} typeDelete=${typeDelete} heading=${heading} paragraph=${paragraph} numberedListItem=${numbered} image=${image}`,
  );
  expect(openClose).toBe(0);
  expect(typeDelete).toBe(0);
});

test("23b §13-5：2000 區塊筆記，點版本列到 diff 標記出現的耗時（真瀏覽器）", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await loginAs(page, ADMIN.email, ADMIN.password);
  const content = Array.from({ length: 2000 }, (_, i) => `第 ${i} 段 measure 內容內容內容內容`).join("\n\n");
  const created = await page.request.post("/api/notes", { data: { title: `E2E 2000 ${Date.now()}`, content } });
  expect(created.ok()).toBe(true);
  const note = (await created.json()) as { id: string; ownerHandle: string; slug: string };
  // #272：帶 content 建立不再立刻切出 v1——先手動存一版「created」，作為「建立時的內容」那一版。
  const saved = await page.request.post(`/api/notes/${note.id}/versions`, { headers: { Origin: ORIGIN }, data: { name: "created" } });
  expect(saved.status()).toBe(201);
  await openAndWait(page, `/n/${note.ownerHandle}/${note.slug}`);
  await editorLocator(page).getByText("第 0 段 measure", { exact: false }).click();
  await page.keyboard.type(" edited");
  await page.keyboard.press("Control+s");
  const dialog = page.getByRole("dialog", { name: "Save current version" });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByTestId("versions-bubble").click();
  const panel = page.getByTestId("versions-panel");
  // 點 created 而不是剛存的那一版：rev 10 起比較是左右一對，點列只換左邊、右邊預設是目前狀態（Current state）。剛存的那一版
  // 內容與目前狀態相同，兩邊沒有差異；created（建立時的內容）與目前狀態差在第 0 段。
  const row = panel.getByRole("button", { name: /^created \(/ });
  await expect(row).toBeVisible({ timeout: 15_000 });
  const t0 = Date.now();
  await row.click();
  // 看並排（diff-split）而不是單欄：1400 px 視窗開著面板時預覽區約 774 px，≥ 720 px 門檻就自動並排，DOM 上沒有 diff-single。
  // 等並排欄內第一個非 context 的 data-diff 標記可見（並排兩側各自標記，不一定是 "changed"）。
  await expect(page.locator('[data-testid="diff-split"] [data-diff]:not([data-diff="context"])').first()).toBeVisible({
    timeout: 60_000,
  });
  const previewMs = Date.now() - t0;
  console.log(`MEASURE-13-5 blocks=2000 previewMs=${previewMs} mode=split left=created right=current`);
  expect(previewMs).toBeGreaterThan(0);
});
