import { expect, test, type BrowserContext, type Locator, type Page, type Response } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs } from "./helpers.js";
import { csvBytes, docxBytes, MARKER_PATH, mp3Bytes, mp4Bytes, pdfBytes } from "./upload-fixtures.js";

/**
 * Audio, video, PDF, Office and text uploads in a real browser: what each file does once it is in a note (plays, seeks,
 * downloads under its served name, shows as text), the public page, and an upload that finishes while its note is not on screen.
 * The server tests pin the exact header sets; this checks what the browser does with them.
 *
 * Files are pasted as a synthetic `ClipboardEvent` with a real `DataTransfer` (the same path as a drop), so no file chooser is involved.
 */

const UPLOADS = /\/api\/notes\/[^/]+\/uploads$/;
const isUploadPost = (r: Response) => UPLOADS.test(new URL(r.url()).pathname) && r.request().method() === "POST";

async function pasteFile(page: Page, name: string, type: string, bytes: Uint8Array): Promise<void> {
  const editor = editorLocator(page);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.evaluate(
    ({ name, type, base64 }) => {
      const data = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([data], name, { type }));
      const target = document.querySelector('[data-testid="note-editor"] [contenteditable="true"]');
      if (!target) throw new Error("editor not found");
      target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    { name, type, base64: Buffer.from(bytes).toString("base64") },
  );
}

const fileLink = (page: Page, name: string): Locator => editorLocator(page).locator(".bn-file-name a", { hasText: name });

// A selected file block shows a floating toolbar that can sit on top of its own name; moving focus to the title drops the selection.
async function clickFileLink(page: Page, name: string): Promise<void> {
  await page.getByLabel("Note title").click();
  await fileLink(page, name).click();
}

/** Resolves with the first download any page of the context starts (a link with `target="_blank"` downloads in its own page). */
function nextDownload(context: BrowserContext) {
  return new Promise<import("@playwright/test").Download>((resolve) => {
    const onDownload = (d: import("@playwright/test").Download) => {
      context.off("page", watch);
      resolve(d);
    };
    const watch = (p: Page) => p.once("download", onDownload);
    context.pages().forEach(watch);
    context.on("page", watch);
  });
}

test("81-1 audio plays and video seeks (206); PDF, docx and csv are served as designed; the public page plays the audio", async ({ browser }) => {
  test.setTimeout(240_000);
  const ownerContext = await browser.newContext({ acceptDownloads: true });
  const anonContext = await browser.newContext();
  const markers: string[] = [];
  for (const c of [ownerContext, anonContext]) {
    c.on("request", (req) => {
      const path = new URL(req.url()).pathname;
      if (path.startsWith(MARKER_PATH)) markers.push(path);
    });
  }
  try {
    const owner = await ownerContext.newPage();
    await loginAs(owner, ADMIN.email, ADMIN.password);
    await createNote(owner, `E2E media ${Date.now()}`);
    const editor = editorLocator(owner);
    const ranged: Array<{ path: string; status: number }> = [];
    owner.on("response", (r) => {
      if (r.request().headers().range) ranged.push({ path: new URL(r.url()).pathname, status: r.status() });
    });

    // Audio: plays.
    const audioPosted = owner.waitForResponse(isUploadPost);
    await pasteFile(owner, "tone.mp3", "audio/mpeg", mp3Bytes());
    expect((await audioPosted).status()).toBe(201);
    const audio = editor.locator('audio[src*="/api/uploads/"]');
    await expect(audio).toHaveCount(1, { timeout: 20_000 });
    await expect.poll(() => audio.evaluate((el) => (el as HTMLAudioElement).readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    expect(await audio.evaluate((el) => (el as HTMLAudioElement).duration)).toBeGreaterThan(0.5);
    // Muted, so autoplay policy allows it without a user gesture.
    await audio.evaluate((el) => {
      (el as HTMLAudioElement).muted = true;
      return (el as HTMLAudioElement).play();
    });
    await expect.poll(() => audio.evaluate((el) => (el as HTMLAudioElement).currentTime), { timeout: 10_000 }).toBeGreaterThan(0);

    // Video: seeking past the start works and the server answered a range request with 206.
    const videoPosted = owner.waitForResponse(isUploadPost);
    await pasteFile(owner, "clip.mp4", "video/mp4", mp4Bytes());
    expect((await videoPosted).status()).toBe(201);
    const video = editor.locator('video[src*="/api/uploads/"]');
    await expect(video).toHaveCount(1, { timeout: 20_000 });
    await expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    expect(await video.evaluate((el) => (el as HTMLVideoElement).duration)).toBeGreaterThan(2);
    // `seeked` fires only once the browser has landed the seek. The file is small enough to be fully buffered after the first
    // ranged load, so no second request follows the seek and the 206 below is the one answered to that load.
    const landed = await video.evaluate(
      (el) =>
        new Promise<{ time: number; seekableEnd: number; readyState: number }>((resolve, reject) => {
          const v = el as HTMLVideoElement;
          const timer = setTimeout(() => reject(new Error("seeked never fired")), 10_000);
          v.addEventListener(
            "seeked",
            () => {
              clearTimeout(timer);
              resolve({ time: v.currentTime, seekableEnd: v.seekable.length > 0 ? v.seekable.end(0) : 0, readyState: v.readyState });
            },
            { once: true },
          );
          v.currentTime = 2;
        }),
    );
    expect(landed.seekableEnd).toBeGreaterThanOrEqual(2);
    expect(landed.time).toBeGreaterThanOrEqual(2);
    expect(landed.readyState).toBeGreaterThanOrEqual(2);
    const videoPath = new URL((await video.getAttribute("src"))!, owner.url()).pathname;
    expect(ranged.filter((r) => r.path === videoPath).map((r) => r.status)).toContain(206);

    // PDF, docx and csv become file blocks whose name opens the file.
    for (const [name, type, bytes] of [
      ["spec.pdf", "application/pdf", pdfBytes()],
      ["report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", docxBytes()],
      ["data.csv", "text/csv", csvBytes()],
    ] as const) {
      const posted = owner.waitForResponse(isUploadPost);
      await pasteFile(owner, name, type, bytes);
      expect((await posted).status()).toBe(201);
      await expect(fileLink(owner, name)).toBeVisible({ timeout: 20_000 });
    }

    const hrefOf = async (name: string) => new URL((await fileLink(owner, name).getAttribute("href"))!, owner.url()).pathname;

    // PDF: inline under its own CSP (no sandbox: it would disable the PDF viewer).
    const pdfUrl = await hrefOf("spec.pdf");
    const pdfRes = await owner.request.get(pdfUrl);
    expect(pdfRes.status()).toBe(200);
    expect(pdfRes.headers()["content-type"]).toBe("application/pdf");
    expect(pdfRes.headers()["content-security-policy"]).toBe("default-src 'none'; frame-ancestors 'none'");
    expect(pdfRes.headers()["x-content-type-options"]).toBe("nosniff");
    expect(pdfRes.headers()["content-disposition"]).toMatch(/^inline;/);
    // Headless Chromium usually downloads a PDF instead of rendering it; the marker check only means something when it renders.
    const pdfPage = await ownerContext.newPage();
    const rendered = await pdfPage.goto(pdfUrl).then(
      () => true,
      (err: Error) => (/Download is starting/.test(err.message) ? false : Promise.reject(err)),
    );
    test.info().annotations.push({ type: "pdf-rendered", description: String(rendered) });
    if (rendered) await pdfPage.waitForTimeout(2_000);
    await pdfPage.close();
    expect(markers).toEqual([]);

    // docx: a download under the served name.
    const download = nextDownload(ownerContext);
    await clickFileLink(owner, "report.docx");
    expect((await download).suggestedFilename()).toBe("report.docx");

    // csv: opens as plain text.
    const csvUrl = await hrefOf("data.csv");
    const csvRes = await owner.request.get(csvUrl);
    expect(csvRes.headers()["content-type"]).toBe("text/plain; charset=utf-8");
    expect(csvRes.headers()["content-disposition"]).toMatch(/^inline;/);
    const popupPromise = owner.waitForEvent("popup");
    await clickFileLink(owner, "data.csv");
    const popup = await popupPromise;
    await popup.waitForLoadState();
    expect(await popup.evaluate(() => document.contentType)).toBe("text/plain");
    await expect(popup.locator("body")).toContainText("alpha,1");
    await popup.close();

    // Public page: the audio plays for an anonymous visitor.
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
      expect(doc).toContain("/api/uploads/");
    }).toPass({ timeout: 20_000 });

    const anon = await anonContext.newPage();
    await anon.goto(`/p/${token}`);
    const publicAudio = anon.locator(`audio[src*="/api/public/notes/${token}/uploads/"]`);
    await expect(publicAudio).toHaveCount(1, { timeout: 20_000 });
    await expect.poll(() => publicAudio.evaluate((el) => (el as HTMLAudioElement).readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    expect(await publicAudio.evaluate((el) => (el as HTMLAudioElement).duration)).toBeGreaterThan(0.5);
    await publicAudio.evaluate((el) => {
      (el as HTMLAudioElement).muted = true;
      return (el as HTMLAudioElement).play();
    });
    await expect.poll(() => publicAudio.evaluate((el) => (el as HTMLAudioElement).currentTime), { timeout: 10_000 }).toBeGreaterThan(0);
    expect(markers).toEqual([]);
  } finally {
    await ownerContext.close();
    await anonContext.close();
  }
});

test("81-2 a video upload that finishes while another note is on screen is in its block when the note is reopened", async ({ browser }) => {
  test.setTimeout(120_000);
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await createNote(page, `E2E bg upload ${Date.now()}`);

    // Hold the upload request until the person has left the note.
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(UPLOADS, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await held;
      return route.continue();
    });

    await pasteFile(page, "slow.mp4", "video/mp4", mp4Bytes());
    await expect(editorLocator(page).locator("[data-upload-state]")).toBeVisible({ timeout: 15_000 });

    const first = page.url();
    await createNote(page, `E2E other ${Date.now()}`);
    expect(page.url()).not.toBe(first);

    const posted = page.waitForResponse(isUploadPost);
    release();
    expect((await posted).status()).toBe(201);

    await page.goBack();
    await page.waitForURL(first);
    await expect(page.getByLabel("Note title")).toBeVisible({ timeout: 15_000 });
    await expect(editorLocator(page).locator('video[src*="/api/uploads/"]')).toHaveCount(1, { timeout: 20_000 });
    await expect(editorLocator(page).locator("[data-upload-state]")).toHaveCount(0);
  } finally {
    await context.close();
  }
});
