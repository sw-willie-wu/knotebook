import { expect, test } from "@playwright/test";
import { ADMIN, createNote, loginAs, noteIdFromUrl } from "./helpers.js";

/**
 * 換篇空窗：在筆記 A 按 New note，react-router 先換網址、畫面在 startTransition 裡才換。
 * 空窗裡 A 的標題框仍可打字；修好前 blur 會把字存進 A（A 被改名）。
 * CPU 節流拉長空窗；捕獲階段的 input 監聽確認字真的打進了 A 的標題框（沒打進＝沒重現，測試直接紅，不假綠）。
 * ⚠ 紅在「沒重現空窗」那句＝環境太快、節流不夠拉出空窗，不是產品回歸（調高 THROTTLE_RATE）；產品回歸紅在最後讀 A 標題那句。
 */

const THROTTLE_RATE = 20;

test("29 換篇空窗：在 A 按 New note 後立刻對標題框打字＋blur，A 不得被改名；新筆記照常命名", async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, ADMIN.email, ADMIN.password);
  const stamp = Date.now();
  const titleA = `E2E stale title A ${stamp}`;
  await createNote(page, titleA);
  const idA = await noteIdFromUrl(page);

  const titleInput = page.getByLabel("Note title");
  // 標記 A 的標題框，並記下空窗裡打到它的 input 事件
  await titleInput.evaluate((el) => {
    el.setAttribute("data-e2e-note-a", "");
    document.addEventListener(
      "input",
      (event) => {
        if ((event.target as Element | null)?.hasAttribute?.("data-e2e-note-a")) {
          (window as unknown as { __e2eTypedIntoA?: boolean }).__e2eTypedIntoA = true;
        }
      },
      true,
    );
  });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE_RATE });
  try {
    await page.getByRole("button", { name: "New note", exact: true }).click();
    await page.waitForURL(/\/n\/[^/]+\/untitled-[0-9a-f]{8}$/, { timeout: 30_000 });
    await titleInput.fill(`E2E hijack ${stamp}`);
    await titleInput.blur();
  } finally {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  }

  const typedIntoA = await page.evaluate(() => (window as unknown as { __e2eTypedIntoA?: boolean }).__e2eTypedIntoA === true);
  expect(typedIntoA, "沒重現空窗：字沒打進 A 的標題框").toBe(true);

  // 新筆記照常命名：等新的標題框（不是 A 那個）掛上，值是 Untitled
  const newInput = page.locator('input[aria-label="Note title"]:not([data-e2e-note-a])');
  await expect(newInput).toHaveValue("Untitled", { timeout: 15_000 });
  const titleB = `E2E stale title B ${stamp}`;
  await newInput.fill(titleB);
  await newInput.blur();
  await page.waitForURL(
    (url) => /^\/n\/[^/]+\/[^/]+$/.test(url.pathname) && !/\/untitled-[0-9a-f]{8}$/.test(url.pathname),
    { timeout: 15_000 },
  );
  const idB = await noteIdFromUrl(page);
  expect(idB).not.toBe(idA);
  const resB = await page.request.get(`/api/notes/${idB}`);
  expect(((await resB.json()) as { title: string }).title).toBe(titleB);

  // A 的標題沒變。放在 B 命名之後讀：空窗那次 blur 若送了 PATCH，早在 B 的存檔與網址收斂之前就落地了
  const resA = await page.request.get(`/api/notes/${idA}`);
  expect(resA.status()).toBe(200);
  expect(((await resA.json()) as { title: string }).title).toBe(titleA);
});
