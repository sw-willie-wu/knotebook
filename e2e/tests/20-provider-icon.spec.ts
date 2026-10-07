import path from "node:path";
import { deflateSync } from "node:zlib";
import { test, expect } from "@playwright/test";
import { ADMIN, loginAs } from "./helpers.js";

/**
 * 登入服務圖示 E1（spec 2026-10-07-provider-icon §8.3）：管理員在 /admin/auth 以 UI 對 e2e 疊既有的「SSO」（OIDC_* 匯入的 legacy）上傳 PNG →
 * 未登入的登入頁「Sign in with SSO」內有 <img>，src 帶 ?v=，而且是真瀏覽器 canvas 縮過的結果（256×128 → 128×64）。
 * 不新增服務（05 等以名稱定位 SSO 鈕）。測前斷言 iconKind === "template"（不是就失敗，不猜怎麼還原——PATCH 不收 upload）；finally 一律還原成 template。
 *
 * 目視用截圖：設了 `PROVIDER_ICON_SCREENSHOT_DIR` 才截登入頁 SSO 按鈕區，未設就略過；本檔不寫任何絕對路徑。
 */

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** 單色 RGBA PNG（不靠 fixture 檔——repo 內不放樣本）。 */
function solidPng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const row = Buffer.alloc(1 + width * 4); // 第一個位元組是 filter 0
  for (let x = 0; x < width; x++) row.set([0xe2, 0x43, 0x29, 0xff], 1 + x * 4);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

test("20-1：管理員上傳「SSO」的圖示 → 登入頁 SSO 鈕出現縮成 128×64 的上傳圖", async ({ browser }) => {
  const shotDir = process.env.PROVIDER_ICON_SCREENSHOT_DIR;
  const adminContext = await browser.newContext();
  try {
    const page = await adminContext.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await expect(page).toHaveURL(/\/$/);
    const list = (await (await page.request.get("/api/admin/auth/providers")).json()) as {
      providers: Array<{ id: string; displayName: string; legacyCallback: boolean; iconKind: string }>;
    };
    const sso = list.providers.find(p => p.legacyCallback);
    expect(sso, "e2e 疊應有 OIDC_* 匯入的 SSO").toBeDefined();
    // 還原目標固定是 template：前置若不是 template，finally 的還原會把原狀改壞，所以不是就直接失敗（也不嘗試還原——PATCH 不收 upload，spec §8.3）。
    // 若某次執行在上傳後、還原前被中斷，髒疊會一直卡在這個前置檢查紅；救法是 stack:down（帶 -v 清 volume）再重起。adminContext 仍由外層 finally 關閉。
    expect(sso!.iconKind).toBe("template");

    // 還原失敗不得蓋掉本體的原錯：本體已失敗時只 console.error 還原錯、rethrow 原錯；本體成功時才丟還原錯。
    let failure: unknown;
    try {
      await page.goto("/admin/auth");
      const card = page.getByRole("region", { name: sso!.displayName, exact: true });
      await card.getByRole("button", { name: "Icon", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "Sign-in service icon" });
      await dialog.getByRole("radio", { name: "Upload an image" }).check();
      await dialog.locator('input[type="file"]').setInputFiles({ name: "wide.png", mimeType: "image/png", buffer: solidPng(256, 128) });
      await expect(dialog.locator('img[data-provider-icon="upload"]')).toHaveAttribute("src", /^blob:/);
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog).not.toBeVisible();
      await expect(card.locator('img[data-provider-icon="upload"]')).toHaveAttribute("src", new RegExp(`^/api/auth/providers/${sso!.id}/icon\\?v=\\d+$`));

      const anon = await browser.newContext();
      try {
        const p = await anon.newPage();
        await p.goto("/login");
        const ssoLink = p.getByRole("link", { name: "Sign in with SSO", exact: true });
        const img = ssoLink.locator('img[data-provider-icon="upload"]');
        await expect(img).toHaveAttribute("src", /\?v=\d+$/);
        await expect
          .poll(() => img.evaluate((el: HTMLImageElement) => (el.complete ? `${el.naturalWidth}x${el.naturalHeight}` : "loading")), {
            message: "登入頁 SSO 鈕的上傳圖應載入完成且為瀏覽器縮過的 128×64（naturalWidth×naturalHeight）",
          })
          .toBe("128x64");
        if (shotDir) await ssoLink.locator("..").screenshot({ path: path.join(shotDir, "20-login-sso-icon.png") });
      } finally {
        await anon.close();
      }
    } catch (error) {
      failure = error;
    }

    let restoreError: unknown;
    try {
      const res = await page.request.patch(`/api/admin/auth/providers/${sso!.id}`, { data: { iconKind: "template" } });
      if (!res.ok()) restoreError = new Error(`還原 iconKind=template 失敗：HTTP ${res.status()} ${await res.text()}`);
    } catch (error) {
      restoreError = error;
    }
    if (failure !== undefined) {
      if (restoreError !== undefined) console.error("還原 iconKind=template 也失敗（以下為還原錯；拋出的是測試本體的原錯）：", restoreError);
      throw failure;
    }
    if (restoreError !== undefined) throw restoreError;
  } finally {
    await adminContext.close();
  }
});
