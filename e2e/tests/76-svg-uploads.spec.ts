import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";
import { E2E_ORIGIN } from "../ports.js";
import { ADMIN, createNote, editorLocator, loginAs, noteIdFromUrl, waitForEditorSelection } from "./helpers.js";

/**
 * #389: SVG uploads. Server tests pin the headers; this checks in a real browser that:
 * 1. an SVG with `<script>`, `onload`, `<foreignObject>` and an external `<image href>` runs nothing and fetches nothing,
 *    shown in the note, the presentation and the public page (`<img>`), and when its upload URL is opened directly
 *    (`Content-Security-Policy: …; sandbox`);
 * 2. the detector works: the same SVG served without that header does fire it (positive control);
 * 3. an SVG animated with embedded `<style>` + `@keyframes` really animates inside `<img>`.
 *
 * Detection: every active part of the hostile SVG requests `/e2e-svg-marker/<part>` on the app origin (a 404 is fine) or
 * calls `alert`; the test records those requests (except ones the CSP blocked) and dialogs on the whole browser context.
 */

const ORIGIN = E2E_ORIGIN;
const MARKER = "/e2e-svg-marker/";

const HOSTILE_SVG = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="40" height="40" onload="fetch('${ORIGIN}${MARKER}onload');alert('onload')">
<rect width="40" height="40" fill="#3a7"/>
<script>fetch('${ORIGIN}${MARKER}script'); alert('script');</script>
<foreignObject width="40" height="40"><body xmlns="http://www.w3.org/1999/xhtml"><img src="${ORIGIN}${MARKER}foreign-img" onerror="fetch('${ORIGIN}${MARKER}onerror')"/></body></foreignObject>
<image href="${ORIGIN}${MARKER}external-image" width="10" height="10"/>
</svg>`;

// Alternates between two solid fills every 300 ms, so two samples ~150 ms apart within a second must differ.
const ANIMATED_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40">
<style>@keyframes flip { 0%, 49% { fill: #d00 } 50%, 100% { fill: #00d } } rect { animation: flip 0.6s steps(1) infinite }</style>
<rect width="40" height="40"/>
</svg>`;

// Slide-diagram SVG with only `viewBox` and no explicit `width`/`height` attributes (#389).
const VIEWBOX_ONLY_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 450">
<rect width="800" height="450" fill="#2563eb"/>
<circle cx="400" cy="225" r="120" fill="#f8fafc"/>
</svg>`;

function watchActivity(context: BrowserContext): { markers: string[]; dialogs: string[] } {
  const seen = { markers: [] as string[], dialogs: [] as string[] };
  const marker = (url: string) => (new URL(url).pathname.startsWith(MARKER) ? new URL(url).pathname : null);
  // Chromium still emits `request` for loads the CSP blocks (failure "csp"); only loads that went out count.
  context.on("requestfinished", (req) => { const path = marker(req.url()); if (path) seen.markers.push(path); });
  context.on("requestfailed", (req) => {
    const path = marker(req.url());
    if (path && req.failure()?.errorText !== "csp") seen.markers.push(path);
  });
  context.on("page", (p) => p.on("dialog", (d) => { seen.dialogs.push(d.message()); void d.dismiss(); }));
  return seen;
}

async function pasteMarkdown(page: Page, markdown: string): Promise<void> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
  const editor = editorLocator(page);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await waitForEditorSelection(page);
  await page.evaluate((text) => navigator.clipboard.writeText(text), markdown);
  await page.keyboard.press("ControlOrMeta+v");
}

async function expectLoaded(img: Locator): Promise<void> {
  await expect(img).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).complete && (el as HTMLImageElement).naturalWidth)).toBe(40);
}

/** Samples the image's pixels a few times; an animating image yields more than one distinct sample. */
async function expectAnimating(img: Locator): Promise<void> {
  await expect(async () => {
    const samples = new Set<string>();
    for (let i = 0; i < 8; i++) {
      samples.add((await img.screenshot({ animations: "allow" })).toString("base64"));
      await img.page().waitForTimeout(150);
    }
    expect(samples.size).toBeGreaterThan(1);
  }).toPass({ timeout: 15_000 });
}

test("SVG upload: hostile SVG inert in the note, presentation, public page and when opened directly; @keyframes animation runs", async ({ browser }) => {
  test.setTimeout(180_000);
  const ownerContext = await browser.newContext();
  const anonContext = await browser.newContext();
  const ownerSeen = watchActivity(ownerContext);
  const anonSeen = watchActivity(anonContext);
  try {
    const owner = await ownerContext.newPage();
    await loginAs(owner, ADMIN.email, ADMIN.password);
    const title = `E2E svg ${Date.now()}`;
    await createNote(owner, title);
    const noteId = await noteIdFromUrl(owner);

    // Hostile SVG through the editor's real Upload tab (the path users take).
    const editor = editorLocator(owner);
    await editor.click();
    await editor.pressSequentially("svg note");
    await owner.keyboard.press("Enter");
    await editor.pressSequentially("/image");
    await owner.getByText("Resizable image with caption").click();
    await owner.getByText("Add image", { exact: true }).click();
    await owner.getByLabel("Choose an image file to upload").setInputFiles({ name: "hostile.svg", mimeType: "image/svg+xml", buffer: Buffer.from(HOSTILE_SVG) });
    const hostileImg = editor.locator('img[src*="/api/uploads/"]').first();
    await expectLoaded(hostileImg);
    const hostileUrl = new URL((await hostileImg.getAttribute("src"))!, ORIGIN).pathname;

    // Animated SVG through the upload API, placed on its own slide with markdown.
    const upload = await owner.request.post(`/api/notes/${noteId}/uploads`, {
      headers: { Origin: ORIGIN },
      multipart: { file: { name: "anim.svg", mimeType: "image/svg+xml", buffer: Buffer.from(ANIMATED_SVG) } },
    });
    expect(upload.status()).toBe(201);
    const { url: animUrl } = (await upload.json()) as { url: string };
    await pasteMarkdown(owner, ["## Anim slide", "", `![anim](${animUrl})`, ""].join("\n"));
    const animImg = editor.locator(`img[src*="${animUrl}"]`);
    await expectLoaded(animImg);
    await expectAnimating(animImg);

    // Headers on both upload responses.
    for (const url of [hostileUrl, animUrl]) {
      const res = await owner.request.get(url);
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toBe("image/svg+xml");
      expect(res.headers()["content-security-policy"]).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox");
      expect(res.headers()["x-content-type-options"]).toBe("nosniff");
    }

    // Presentation: both images shown, animation running.
    await owner.getByRole("button", { name: "More", exact: true }).click();
    await owner.getByRole("menuitem", { name: "Present" }).click();
    await expect(owner.locator(".reveal.ready")).toBeVisible({ timeout: 15_000 });
    await owner.evaluate(async () => { if (document.fullscreenElement) await document.exitFullscreen(); });
    await expectLoaded(owner.locator(`.reveal .slides img[src*="${hostileUrl}"]`));
    await owner.keyboard.press("ArrowRight");
    const presentAnim = owner.locator(`.reveal .slides section.present img[src*="${animUrl}"]`);
    await expectLoaded(presentAnim);
    await expectAnimating(presentAnim);
    await owner.waitForTimeout(350);
    await owner.keyboard.press("Escape");
    await expect(owner.getByRole("dialog")).toHaveCount(0);

    // Direct navigation to the upload URL: rendered as a document, but sandboxed with no fetches.
    const direct = await ownerContext.newPage();
    const directRes = await direct.goto(hostileUrl);
    expect(directRes?.status()).toBe(200);
    await direct.waitForTimeout(1_000);
    expect(await direct.evaluate(() => document.documentElement.localName)).toBe("svg");
    await direct.close();

    // Public page and public presentation for an anonymous visitor.
    await owner.getByRole("button", { name: "Share", exact: true }).click();
    const dialog = owner.getByRole("dialog", { name: "Share note" });
    const publicRadio = dialog.getByRole("radio", { name: /^Public link/ });
    await expect(publicRadio).toBeEnabled();
    await publicRadio.check();
    const token = await dialog.getByLabel("Public link URL").inputValue();
    await owner.keyboard.press("Escape");
    await expect(async () => {
      const res = await owner.request.get(`/api/public/notes/${token}`);
      expect(res.status()).toBe(200);
      const doc = Buffer.from(((await res.json()) as { ydoc: string }).ydoc, "base64").toString("utf8");
      expect(doc).toContain(animUrl);
      expect(doc).toContain(hostileUrl);
    }).toPass({ timeout: 20_000 });

    const anon = await anonContext.newPage();
    await anon.goto(`/p/${token}`);
    const publicImgs = anon.locator(`img[src*="/api/public/notes/${token}/uploads/"]`);
    await expect(publicImgs).toHaveCount(2, { timeout: 15_000 });
    // Public URLs keep the upload id; match by it, since block order isn't what this test pins.
    const uploadId = (url: string) => url.split("/").pop()!;
    const publicHostile = `/api/public/notes/${token}/uploads/${uploadId(hostileUrl)}`;
    const publicAnim = anon.locator(`img[src$="/api/public/notes/${token}/uploads/${uploadId(animUrl)}"]`);
    await expectLoaded(anon.locator(`img[src$="${publicHostile}"]`));
    await expectLoaded(publicAnim);
    await expectAnimating(publicAnim);
    const publicRes = await anon.request.get(publicHostile);
    expect(publicRes.headers()["content-security-policy"]).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox");

    await anon.getByRole("button", { name: "Present" }).click();
    await expect(anon.locator(".reveal.ready")).toBeVisible({ timeout: 15_000 });
    await expectLoaded(anon.locator(`.reveal .slides img[src*="/api/public/notes/${token}/uploads/"]`).first());

    const anonDirect = await anonContext.newPage();
    expect((await anonDirect.goto(publicHostile))?.status()).toBe(200);
    await anonDirect.waitForTimeout(1_000);
    await anonDirect.close();

    await owner.waitForTimeout(500);
    expect(ownerSeen.markers).toEqual([]);
    expect(ownerSeen.dialogs).toEqual([]);
    expect(anonSeen.markers).toEqual([]);
    expect(anonSeen.dialogs).toEqual([]);
  } finally {
    await ownerContext.close();
    await anonContext.close();
  }
});

test("positive control: the same hostile SVG served without the upload CSP does fire the detector", async ({ browser }) => {
  const context = await browser.newContext();
  const seen = watchActivity(context);
  try {
    const page = await context.newPage();
    await page.route(`${ORIGIN}/e2e-svg-unprotected.svg`, (route) => route.fulfill({ status: 200, contentType: "image/svg+xml", body: HOSTILE_SVG }));
    await page.route(`${ORIGIN}${MARKER}**`, (route) => route.fulfill({ status: 204 }));
    await page.goto(`${ORIGIN}/e2e-svg-unprotected.svg`);
    await expect.poll(() => seen.markers.length, { timeout: 10_000 }).toBeGreaterThan(0);
    await expect.poll(() => seen.dialogs.length, { timeout: 10_000 }).toBeGreaterThan(0);
  } finally {
    await context.close();
  }
});

test("viewBox-only SVG without width/height renders at a visible default size and opens in lightbox zoom (#389)", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createNote(page, `E2E svg viewBox ${Date.now()}`);
    const noteId = await noteIdFromUrl(page);

    const upload = await page.request.post(`/api/notes/${noteId}/uploads`, {
      headers: { Origin: ORIGIN },
      multipart: { file: { name: "diagram.svg", mimeType: "image/svg+xml", buffer: Buffer.from(VIEWBOX_ONLY_SVG) } },
    });
    expect(upload.status()).toBe(201);
    const { url } = (await upload.json()) as { url: string };
    await pasteMarkdown(page, `![diagram](${url})\n`);

    const img = editorLocator(page).locator(`img[src*="${url}"]`);
    await expect(img).toBeVisible({ timeout: 15_000 });
    await expect.poll(
      () => img.evaluate((el) => ((el as HTMLImageElement).complete ? (el as HTMLImageElement).naturalWidth : 0)),
      { timeout: 15_000 },
    ).toBeGreaterThan(0);
    const natural = await img.evaluate((el) => ({
      w: (el as HTMLImageElement).naturalWidth,
      h: (el as HTMLImageElement).naturalHeight,
    }));
    expect(natural.w).toBeGreaterThan(0);
    expect(natural.h).toBeGreaterThan(0);

    const box = await img.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(0);
    expect(box!.height).toBeGreaterThan(0);
    expect(Math.abs(box!.width / box!.height - 800 / 450)).toBeLessThan(0.05);
    // Precondition for the lightbox check below: the note renders it wider than the browser's fallback natural width.
    expect(box!.width).toBeGreaterThan(natural.w + 1);

    // Lightbox zoom: hover reveals Zoom in button, clicking opens the dialog with a zoomable <img>.
    await img.hover();
    const zoomButton = page.locator("[data-kb-zoom-layer]").getByRole("button", { name: "Zoom in", exact: true });
    await expect(zoomButton).toBeVisible();
    await zoomButton.click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    const zoomed = dialog.locator("img");
    await expect(zoomed).toBeVisible();
    const beforeZoom = (await zoomed.boundingBox())!;
    expect(beforeZoom.width).toBeGreaterThanOrEqual(box!.width - 1);
    expect(beforeZoom.height).toBeGreaterThan(0);
    await page.keyboard.press("+");
    await expect.poll(async () => (await zoomed.boundingBox())!.width).toBeGreaterThan(beforeZoom.width + 1);
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  } finally {
    await context.close();
  }
});
