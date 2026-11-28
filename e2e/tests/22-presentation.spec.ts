import { deflateSync } from "node:zlib";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { E2E_ORIGIN } from "../ports.js";
import { ADMIN, clickEndOfParagraph, createNote, editorLocator, loginAs, waitForEditorSelection } from "./helpers.js";

/**
 * - The "current slide" is always read from the DOM: `.reveal .slides section.present[data-kn-slide-id]` (the reveal
 *   instance is not exposed).
 * - Content is built by pasting markdown (the approach of 14-table-hover): headings -> `##` / `###`, tables -> markdown table.
 * - Fullscreen: behaviour under headless chromium; "the browser swallows Esc" is simulated with
 *   `document.exitFullscreen()`, then wait > 300 ms (the anti-double-exit window) before pressing Esc.
 */

const ORIGIN = E2E_ORIGIN;
const INVALID_LINK_TEXT = "This link doesn't exist or is no longer active.";

async function pasteMarkdown(page: Page, markdown: string): Promise<void> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: ORIGIN });
  const editor = editorLocator(page);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  // As with pasteMarkdown in 34-columns: after Ctrl+End wait for ProseMirror to read back the selection before pasting (E6 pastes a second time into a note that already has content; without the wait the paste lands at the click point)
  await waitForEditorSelection(page);
  await page.evaluate((text) => navigator.clipboard.writeText(text), markdown);
  await page.keyboard.press("ControlOrMeta+v");
}

const DECK = ["Intro paragraph", "", "## Chapter A", "", "alpha text", "", "### Section A2", "", "a2 text", "", "## Chapter B", "", "beta text", "", "### Section B2", "", "b2 text", ""].join("\n");

async function currentSlideId(page: Page): Promise<string | null> {
  return page.evaluate(() => document.querySelector(".reveal .slides section.present[data-kn-slide-id]")?.getAttribute("data-kn-slide-id") ?? null);
}

async function slideIdContaining(page: Page, text: string): Promise<string> {
  const id = await page.evaluate(
    (needle) => Array.from(document.querySelectorAll(".reveal .slides section[data-kn-slide-id]")).find((s) => s.textContent?.includes(needle))?.getAttribute("data-kn-slide-id") ?? null,
    text,
  );
  expect(id, `找不到含「${text}」的投影片`).not.toBeNull();
  return id!;
}

async function presentFromHeaderMenu(page: Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Present" }).click();
  await expect(page.getByRole("dialog", { name: `${title} — presentation` })).toBeVisible();
  await expect(page.locator(".reveal.ready")).toBeVisible({ timeout: 15_000 });
}

async function leaveFullscreenLikeBrowserEsc(page: Page): Promise<void> {
  await page.evaluate(async () => {
    if (document.fullscreenElement) await document.exitFullscreen();
  });
  await page.waitForTimeout(350); // the 300 ms anti-double-exit window
}

async function swipe(page: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  const steps = 10;
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y }] });
  for (let i = 1; i <= steps; i++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps }],
    });
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await cdp.detach();
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    let c = (crc ^ byte) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** A 10x3000 grey PNG: makes the slide overflow once loaded (E6's lazily loaded image). */
function tallPng(width = 10, height = 3000): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0x88)]);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk("IHDR", ihdr), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", Buffer.alloc(0))]);
}

async function noteIdFromUrl(page: Page): Promise<string> {
  const [, , handle, slug] = new URL(page.url()).pathname.split("/");
  const res = await page.request.get(`/api/notes/by-path/${handle}/${slug}`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

async function adminPageWithNote(browser: Browser, title: string, markdown: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, title);
  await pasteMarkdown(page, markdown);
  return { context, page };
}

test("E1: enter from the more menu, page changes write the hash without adding history, O overview / Esc closes only the overview, two Esc presses return to the note, the editor is not remounted [sc:presentOverview] [sc:presentExit]", async ({ browser }) => {
  test.setTimeout(120_000);
  const title = `E2E present ${Date.now()}`;
  const { context, page } = await adminPageWithNote(browser, title, DECK);
  try {
    await expect(editorLocator(page).getByText("b2 text")).toBeVisible({ timeout: 15_000 });
    await editorLocator(page).getByText("b2 text").click();
    await page.keyboard.press("End");
    await waitForEditorSelection(page); // after click -> End wait for PM to read back the selection before typing (see the helpers comment: otherwise it types at the click point)
    await page.keyboard.type(" typed-before-present");
    await expect(editorLocator(page).getByText("b2 text typed-before-present")).toBeVisible();
    await page.evaluate(() => { (document.querySelector('[data-testid="note-editor"]') as HTMLElement & { __kn?: number }).__kn = 1; });

    // The editor's blocks carry data-id and the presentation's slides do not (control for the count of 0 below)
    expect(await page.locator('[data-testid="note-editor"] [data-id]').count()).toBeGreaterThan(0);

    await presentFromHeaderMenu(page, title);
    expect(new URL(page.url()).search).toBe("?present");
    expect(await page.locator(".reveal .slides section[id], .reveal .slides section[data-id]").count()).toBe(0);

    await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);

    const historyLength = await page.evaluate(() => history.length);
    await page.keyboard.press("ArrowRight");
    const chapterA = await slideIdContaining(page, "Chapter A");
    await expect.poll(() => currentSlideId(page)).toBe(chapterA);
    await expect.poll(() => new URL(page.url()).hash).toBe(`#/${chapterA}`);
    await page.keyboard.press("ArrowDown");
    const a2 = await slideIdContaining(page, "Section A2");
    await expect.poll(() => new URL(page.url()).hash).toBe(`#/${a2}`);
    expect(await page.evaluate(() => history.length)).toBe(historyLength);

    await page.keyboard.press("o");
    await expect(page.locator(".reveal.overview")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator(".reveal.overview")).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: `${title} — presentation` })).toBeVisible();

    await leaveFullscreenLikeBrowserEsc(page);
    // The first Esc only exits fullscreen; the presentation stays open
    await expect(page.getByRole("dialog", { name: `${title} — presentation` })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(new URL(page.url()).search).toBe("");
    await expect(editorLocator(page).getByText("b2 text typed-before-present")).toBeVisible();
    expect(await page.evaluate(() => (document.querySelector('[data-testid="note-editor"]') as HTMLElement & { __kn?: number }).__kn)).toBe(1);

    // Corroboration (not verification: it does not assert that reveal.css's html / body overflow rules were really applied): under print media the content is still visible.
    await page.emulateMedia({ media: "print" });
    await expect(editorLocator(page).getByText("b2 text")).toBeVisible();
    await page.emulateMedia({ media: "screen" });
  } finally {
    await context.close();
  }
});

test("E1b: overview (O) also has content on far slides at distance >= 3; after leaving the overview far slides are display:none again (#390)", async ({ browser }) => {
  test.setTimeout(120_000);
  const title = `E2E overview ${Date.now()}`;
  // Cover + 6 chapters: the last chapter is >= 4 from the cover, beyond the normal viewDistance (3); the overview's viewDistance is 10
  const deck = [1, 2, 3, 4, 5, 6].flatMap((n) => [`## Chapter ${n}`, "", `text ${n}`, ""]).join("\n");
  const { context, page } = await adminPageWithNote(browser, title, deck);
  try {
    await expect(editorLocator(page).getByText("text 6")).toBeVisible({ timeout: 15_000 });
    await presentFromHeaderMenu(page, title);
    const far = page.locator(".reveal .slides section[data-kn-slide-id]").last();
    const farState = () => far.evaluate((s) => {
      const r = s.getBoundingClientRect();
      return { display: getComputedStyle(s).display, sized: r.width > 0 && r.height > 0 };
    });
    await expect.poll(async () => (await farState()).display).toBe("none");

    await page.keyboard.press("o");
    await expect(page.locator(".reveal.overview")).toBeVisible();
    // Overview: a far slide's display is not none and it has a size (Tailwind preflight's [hidden] important once overrode reveal's inline display)
    await expect.poll(async () => { const st = await farState(); return st.display !== "none" && st.sized; }).toBe(true);

    await page.keyboard.press("Escape");
    await expect(page.locator(".reveal.overview")).toHaveCount(0);
    await expect.poll(async () => (await farState()).display).toBe("none");
    await expect(page.getByRole("dialog", { name: `${title} — presentation` })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("E2: A presenting and B editing - A sees the change within 3 s and stays on the same slide; B deletes the starting heading of A's current slide -> A moves to the previous slide", async ({ browser }) => {
  test.setTimeout(150_000);
  const title = `E2E present live ${Date.now()}`;
  const { context: contextA, page: pageA } = await adminPageWithNote(browser, title, DECK);
  const contextB = await browser.newContext();
  try {
    await expect(editorLocator(pageA).getByText("b2 text")).toBeVisible({ timeout: 15_000 });
    const noteUrl = pageA.url();
    const pageB = await contextB.newPage();
    await loginAs(pageB, ADMIN.email, ADMIN.password);
    await pageB.goto(noteUrl);
    await expect(editorLocator(pageB).getByText("b2 text")).toBeVisible({ timeout: 15_000 });

    await presentFromHeaderMenu(pageA, title);
    const fullscreenBefore = await pageA.evaluate(() => document.fullscreenElement !== null);
    await pageA.keyboard.press("ArrowRight");
    await pageA.keyboard.press("ArrowRight");
    await pageA.keyboard.press("ArrowDown");
    const b2 = await slideIdContaining(pageA, "Section B2");
    await expect.poll(() => currentSlideId(pageA)).toBe(b2);

    // B adds text in the first chapter. B has just opened the note and the editor has no focus: click -> End ->
    // waitForEditorSelection is not enough, since a focus-acquisition timer may pull the caret back to the click point (PM and
    // DOM still agree) and " plus" would be typed in the middle of the word. clickEndOfParagraph confirms the caret is at the
    // paragraph end.
    await clickEndOfParagraph(pageB, editorLocator(pageB).getByText("alpha text"));
    await pageB.keyboard.type(" plus");
    await expect(pageA.locator(".reveal .slides").getByText("alpha text plus")).toBeAttached({ timeout: 3_000 });
    expect(await currentSlideId(pageA)).toBe(b2);

    await editorLocator(pageB).getByText("Section B2").click();
    await pageB.keyboard.press("Home");
    await waitForEditorSelection(pageB);
    // Backspace at the block start turns the heading into a paragraph (used instead of Ctrl+Alt+0, which seemed flaky in headless
    // Chromium). Either key acts on PM's state.selection; without the wait above it would still sit in the previous paragraph, so
    // the key would act there (Ctrl+Alt+0 changes nothing, Backspace deletes a character).
    await pageB.keyboard.press("Backspace");
    await expect(editorLocator(pageB).locator('[data-content-type="heading"]', { hasText: "Section B2" })).toHaveCount(0);
    const chapterB = await slideIdContaining(pageA, "Chapter B");
    await expect.poll(() => currentSlideId(pageA), { timeout: 5_000 }).toBe(chapterB);
    expect(await pageA.evaluate(() => document.fullscreenElement !== null)).toBe(fullscreenBefore);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

test("E3: anonymous opens the public-link presentation - wikilink as plain text, image loads, update after refocus refetch keeps position, after revoke the overlay closes and shows the dead-link card", async ({ browser }) => {
  test.setTimeout(180_000);
  const ownerContext = await browser.newContext();
  const anonContext = await browser.newContext();
  try {
    const owner = await ownerContext.newPage();
    await loginAs(owner, ADMIN.email, ADMIN.password);
    const stamp = String(Date.now());
    const targetTitle = `E2E wikitarget ${stamp}`; // the query types only the stamp: an old wikitarget note on a dirty stack is not picked
    await createNote(owner, targetTitle);
    const title = `E2E present public ${Date.now()}`;
    await createNote(owner, title);
    const noteId = await noteIdFromUrl(owner);

    // Image: real upload through the API (the "real upload" requirement of 11-public-share), then placed into the note with markdown image syntax.
    const upload = await owner.request.post(`/api/notes/${noteId}/uploads`, {
      headers: { Origin: ORIGIN },
      multipart: { file: { name: "tall.png", mimeType: "image/png", buffer: tallPng(40, 40) } },
    });
    expect(upload.status()).toBe(201);
    const { url: imageUrl } = (await upload.json()) as { url: string };
    await pasteMarkdown(owner, ["## Slide One", "", "one text", "", `![pic](${imageUrl})`, "", "## Slide Two", "", "two text", ""].join("\n"));
    await expect(editorLocator(owner).getByText("two text")).toBeVisible({ timeout: 15_000 });

    await editorLocator(owner).getByText("two text").click();
    await owner.keyboard.press("End");
    await waitForEditorSelection(owner);
    await owner.keyboard.type(" see [[");
    await owner.keyboard.type(stamp);
    await expect(owner.locator(".bn-suggestion-menu")).toBeVisible({ timeout: 10_000 });
    // First wait for the target to appear in the menu: until the ['notes'] cache has it, the first item is "create and link"
    await expect(owner.locator(".bn-suggestion-menu").getByText(targetTitle, { exact: true })).toBeVisible({ timeout: 10_000 });
    await owner.keyboard.press("Enter");
    // #269: give this wikilink its own text (label); the public presentation must show the label and still as plain text
    const labelText = `E2E label ${stamp}`;
    const wikilink = editorLocator(owner).locator('[data-inline-content-type="wikilink"]');
    await expect(wikilink).toHaveCount(1, { timeout: 10_000 });
    await wikilink.hover(); // in edit mode hover shows the toolbar (a click would navigate)
    const toolbar = owner.getByRole("dialog", { name: "Note link" });
    await toolbar.getByRole("button", { name: "Edit text" }).click();
    await toolbar.getByRole("textbox", { name: "Link text" }).fill(labelText);
    await toolbar.getByRole("button", { name: "Save" }).click();
    await expect(wikilink).toHaveText(labelText, { timeout: 10_000 });

    await owner.getByRole("button", { name: "Share", exact: true }).click();
    const dialog = owner.getByRole("dialog", { name: "Share note" });
    const publicRadio = dialog.getByRole("radio", { name: /^Public link/ });
    await expect(publicRadio).toBeEnabled();
    await publicRadio.check();
    const token = await dialog.getByLabel("Public link URL").inputValue();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await owner.keyboard.press("Escape");
    await expect(async () => {
      const res = await owner.request.get(`/api/public/notes/${token}`);
      expect(res.status()).toBe(200);
      expect(Buffer.from(((await res.json()) as { ydoc: string }).ydoc, "base64").toString("utf8")).toContain(labelText);
    }).toPass({ timeout: 20_000 });

    const anon = await anonContext.newPage();
    await anon.goto(`/p/${token}`);
    await anon.getByRole("button", { name: "Present" }).click();
    await expect(anon.locator(".reveal.ready")).toBeVisible({ timeout: 15_000 });
    expect(new URL(anon.url()).search).toBe("?present");
    const twoId = await slideIdContaining(anon, "Slide Two");
    await expect(anon.locator(".reveal .slides").getByText(labelText, { exact: false })).toBeAttached();
    expect(await anon.locator(".reveal .slides a", { hasText: labelText }).count()).toBe(0);
    expect(await anon.locator(".reveal .slides").getByText(targetTitle, { exact: false }).count()).toBe(0);
    const img = anon.locator(`.reveal .slides img[src*="/api/public/notes/${token}/uploads/"]`);
    await expect(img).toBeAttached();
    await expect.poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);

    await anon.keyboard.press("ArrowRight");
    await anon.keyboard.press("ArrowRight");
    await expect.poll(() => currentSlideId(anon)).toBe(twoId);
    // The editor has no focus now (after Escape in the Share dialog focus is on the Share button): the click's focus schedules
    // PM's 20 ms selectionToDOM, which may pull End back to the click point (both runs typed "one updated text") -
    // clickEndOfParagraph confirms the caret is really at the end of this paragraph, see helpers.ts.
    await clickEndOfParagraph(owner, editorLocator(owner).getByText("one text"));
    await owner.keyboard.type(" updated");
    await expect(async () => {
      await anon.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
      await expect(anon.locator(".reveal .slides").getByText("one text updated")).toBeAttached({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
    expect(await currentSlideId(anon)).toBe(twoId);

    await anon.goto(`/p/${token}?present`);
    await expect(anon.locator(".reveal.ready")).toBeVisible({ timeout: 15_000 });
    expect(new URL(anon.url()).search).toBe("?present");

    await owner.getByRole("button", { name: "Share", exact: true }).click();
    await owner.getByRole("dialog", { name: "Share note" }).getByRole("radio", { name: /^Members only/ }).check();
    await owner.keyboard.press("Escape");
    await expect(async () => {
      await anon.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
      await expect(anon.getByText(INVALID_LINK_TEXT)).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
    await expect(anon.getByRole("dialog")).toHaveCount(0);
  } finally {
    await ownerContext.close();
    await anonContext.close();
  }
});

test("E4: presentation chunk/CSS, mermaid, code, overview, fullscreen toggle -> zero CSP violations (with positive control)", async ({ page }) => {
  test.setTimeout(120_000);
  interface Violation { directive: string; blockedURI: string }
  await page.addInitScript(() => {
    (window as unknown as { __cspViolations: Violation[] }).__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __cspViolations: Violation[] }).__cspViolations.push({ directive: event.violatedDirective, blockedURI: event.blockedURI });
    });
  });
  await loginAs(page, ADMIN.email, ADMIN.password);
  const title = `E2E present csp ${Date.now()}`;
  await createNote(page, title);
  await pasteMarkdown(page, ["## Code", "", "```ts", 'const x = "hi";', "```", "", "## Diagram", "", "## Video", ""].join("\n"));
  const editor = editorLocator(page);
  await editor.getByText("Diagram").click();
  await page.keyboard.press("End");
  await waitForEditorSelection(page); // without the wait, Enter lands at the click point and splits the heading in the middle (see "which slide the video lands on" below)
  await page.keyboard.press("Enter");
  await editor.pressSequentially("/diagram");
  await page.getByText("Flowcharts and diagrams with Mermaid").click();
  await page.getByRole("button", { name: "Edit diagram source" }).click();
  const source = page.getByRole("textbox", { name: "Mermaid source" });
  await source.fill("flowchart TD\n  A[Start] --> B[End]");
  await source.press("Escape");
  await expect(editor.locator("svg[aria-roledescription]").first()).toBeVisible({ timeout: 20_000 });

  // Video: video has no upload path, only an embed URL - use the same-origin png just uploaded (it only has to load without a
  // CSP violation, not play; media-src is 'self' http: https:). The panel is this app's components/FilePanel.tsx.
  const noteId = await noteIdFromUrl(page);
  const upload = await page.request.post(`/api/notes/${noteId}/uploads`, {
    headers: { Origin: ORIGIN },
    multipart: { file: { name: "v.png", mimeType: "image/png", buffer: tallPng(40, 40) } },
  });
  expect(upload.status()).toBe(201);
  const { url: mediaUrl } = (await upload.json()) as { url: string };
  // The floating formatting toolbar left by the earlier mermaid step may cover the "Video" heading and intercept the click; Escape closes it.
  await page.keyboard.press("Escape");
  await editor.getByText("Video").click();
  await page.keyboard.press("End");
  await waitForEditorSelection(page);
  await page.keyboard.press("Enter");
  await editor.pressSequentially("/video");
  await page.getByText("Resizable video with caption").click();
  // After a slash insert BlockNote opens the file panel by itself, on its Upload tab; the URL field is behind the Embed link tab
  await page.getByRole("tab", { name: "Embed link" }).click();
  await page.getByPlaceholder("Paste a link…").fill(`${ORIGIN}${mediaUrl}`);
  await page.getByRole("button", { name: "Embed", exact: true }).click();
  await expect(editor.locator("video").first()).toBeAttached({ timeout: 10_000 });

  await presentFromHeaderMenu(page, title);
  await expect(page.locator(".reveal .slides svg[aria-roledescription]").first()).toBeAttached({ timeout: 20_000 });
  await page.keyboard.press("o");
  await expect(page.locator(".reveal.overview")).toBeVisible();
  await page.keyboard.press("o");
  await page.keyboard.press("f");
  await page.keyboard.press("f");
  // Which slide the video lands on depends on where the earlier click put the caret in the text (on repeat runs the heading gets
  // split and the block order changes), so do not assume "the slide containing the word Video": find "the slide containing
  // <video>" and walk right to it (this deck is all H2, no vertical stacks).
  // (The heading split is mostly click -> End with PM not yet having read back the selection and Enter landing at the click
  // point; waitForEditorSelection was added above, and this position-agnostic lookup is kept.)
  const videoSlide = await page.evaluate(() => document.querySelector(".reveal .slides section[data-kn-slide-id]:has(video)")?.getAttribute("data-kn-slide-id") ?? null);
  expect(videoSlide, "簡報裡找不到含 <video> 的投影片").not.toBeNull();
  for (let i = 0; i < 8 && (await currentSlideId(page)) !== videoSlide; i++) await page.keyboard.press("ArrowRight");
  await expect.poll(() => currentSlideId(page)).toBe(videoSlide);
  await expect(page.locator(`section[data-kn-slide-id="${videoSlide}"] video[controls]`)).toBeAttached();
  await page.waitForTimeout(500); // let the video's load attempt happen before collecting violations

  const violations = await page.evaluate(() => (window as unknown as { __cspViolations: Violation[] }).__cspViolations);
  expect(violations, `CSP 擋到了自己的東西：${JSON.stringify(violations)}`).toEqual([]);
  const pwned = await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "window.__cspPositiveControl = true;";
    document.head.appendChild(script);
    return (window as unknown as { __cspPositiveControl?: boolean }).__cspPositiveControl ?? false;
  });
  expect(pwned).toBe(false);
});

test("E5: renaming during playback -> URL switches slug, ?present + hash kept, same slide, same presentation layer instance", async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, ADMIN.email, ADMIN.password);
  const title = `E2E present rename ${Date.now()}`;
  await createNote(page, title);
  await pasteMarkdown(page, DECK);
  await expect(editorLocator(page).getByText("b2 text")).toBeVisible({ timeout: 15_000 });
  const noteId = await noteIdFromUrl(page);
  await presentFromHeaderMenu(page, title);
  await page.keyboard.press("ArrowRight");
  const chapterA = await slideIdContaining(page, "Chapter A");
  await expect.poll(() => new URL(page.url()).hash).toBe(`#/${chapterA}`);
  await page.evaluate(() => { (document.querySelector(".reveal") as HTMLElement & { __kn?: number }).__kn = 1; });
  const oldPath = new URL(page.url()).pathname;

  const renamed = `${title} renamed`;
  const res = await page.request.patch(`/api/notes/${noteId}`, { headers: { Origin: ORIGIN }, data: { title: renamed } });
  expect(res.ok()).toBe(true);
  await expect(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    expect(new URL(page.url()).pathname).not.toBe(oldPath);
  }).toPass({ timeout: 15_000 });
  const url = new URL(page.url());
  expect(url.search).toBe("?present");
  expect(url.hash).toBe(`#/${chapterA}`);
  expect(await currentSlideId(page)).toBe(chapterA);
  expect(await page.evaluate(() => (document.querySelector(".reveal") as HTMLElement & { __kn?: number }).__kn)).toBe(1);
});

test("E6: touch - swiping on a non-overflowing slide changes slide; finger scrolling on an overflowing slide or table does not change slide; a lazily loaded image makes it overflow; control arrow changes slide", async ({ browser }) => {
  test.setTimeout(180_000);
  const title = `E2E present touch ${Date.now()}`;
  const longLines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join("\n\n");
  const cols = 20;
  const table = [
    `| ${Array.from({ length: cols }, (_, i) => `WideHeader${i + 1}`).join(" | ")} |`,
    `| ${Array.from({ length: cols }, () => "---").join(" | ")} |`,
    `| ${Array.from({ length: cols }, (_, i) => `W1C${i + 1}`).join(" | ")} |`,
  ].join("\n");
  const { context: desktop, page: owner } = await adminPageWithNote(browser, title, ["## Short", "", "short text", "", "## Long", "", longLines, "", "## Table", "", table, "", "## Code", "", "```ts", "const shortCode = 1;", "```", "", "## Wide", "", "```ts", `const wideCode = "${"x".repeat(300)}";`, "```", "", "## Stack", "", "stack text", "", "### Child", "", "child text", "", "## Picture", ""].join("\n"));
  const mobile = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 640 } });
  try {
    await expect(editorLocator(owner).getByText("line 60")).toBeVisible({ timeout: 15_000 });
    const noteId = await noteIdFromUrl(owner);
    const upload = await owner.request.post(`/api/notes/${noteId}/uploads`, {
      headers: { Origin: ORIGIN },
      multipart: { file: { name: "tall.png", mimeType: "image/png", buffer: tallPng() } },
    });
    expect(upload.status()).toBe(201);
    const { url: imageUrl } = (await upload.json()) as { url: string };
    await pasteMarkdown(owner, `![tall](${imageUrl})\n`);
    await expect(editorLocator(owner).locator(`img[src*="${imageUrl}"]`)).toBeVisible({ timeout: 15_000 });
    const noteUrl = owner.url();

    const page = await mobile.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    // The image response is held and released only after reaching Picture (img load recompute) - controlled with a deferred, assuming no timing
    let releaseImage: () => void = () => {};
    const imageGate = new Promise<void>((resolve) => {
      releaseImage = resolve;
    });
    await page.route("**/api/uploads/**", async (route) => {
      await imageGate;
      await route.continue();
    });
    await page.goto(`${noteUrl}?present`);
    await expect(page.locator(".reveal.ready")).toBeVisible({ timeout: 20_000 });
    const short = await slideIdContaining(page, "short text");
    const long = await slideIdContaining(page, "line 60");
    const tableSlide = await slideIdContaining(page, "WideHeader1");
    const codeSlide = await slideIdContaining(page, "shortCode");
    const wideSlide = await slideIdContaining(page, "wideCode");
    const stack = await slideIdContaining(page, "stack text");
    const child = await slideIdContaining(page, "child text");
    const picture = await slideIdContaining(page, "Picture");

    await page.keyboard.press("ArrowRight");
    await expect.poll(() => currentSlideId(page)).toBe(short);
    await swipe(page, { x: 330, y: 320 }, { x: 60, y: 320 });
    await expect.poll(() => currentSlideId(page)).toBe(long);

    await expect(page.locator(`section[data-kn-slide-id="${long}"]`)).toHaveAttribute("data-prevent-swipe", "");
    await swipe(page, { x: 200, y: 520 }, { x: 200, y: 160 });
    await expect.poll(() => page.locator(`section[data-kn-slide-id="${long}"]`).evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await currentSlideId(page)).toBe(long);

    await page.locator(".reveal .controls .navigate-right").tap();
    await expect.poll(() => currentSlideId(page)).toBe(tableSlide);
    const wrap = page.locator(`section[data-kn-slide-id="${tableSlide}"] .kn-present-table`);
    const box = (await wrap.boundingBox())!;
    await swipe(page, { x: box.x + box.width - 20, y: box.y + box.height / 2 }, { x: box.x + 20, y: box.y + box.height / 2 });
    await expect.poll(() => wrap.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    expect(await currentSlideId(page)).toBe(tableSlide);

    // Short code block (<pre> is an overflow-x:auto scroll container even when the content fits): a horizontal swipe starting on it must change slide, not be a dead zone
    await page.locator(".reveal .controls .navigate-right").tap();
    await expect.poll(() => currentSlideId(page)).toBe(codeSlide);
    const shortPre = page.locator(`section[data-kn-slide-id="${codeSlide}"] pre`);
    expect(await shortPre.getAttribute("data-prevent-swipe")).toBeNull();
    const shortBox = (await shortPre.boundingBox())!;
    await swipe(page, { x: shortBox.x + shortBox.width - 20, y: shortBox.y + shortBox.height / 2 }, { x: shortBox.x + 20, y: shortBox.y + shortBox.height / 2 });
    await expect.poll(() => currentSlideId(page)).toBe(wideSlide);

    const widePre = page.locator(`section[data-kn-slide-id="${wideSlide}"] pre`);
    await expect(widePre).toHaveAttribute("data-prevent-swipe", "");
    const wideBox = (await widePre.boundingBox())!;
    await swipe(page, { x: wideBox.x + wideBox.width - 20, y: wideBox.y + wideBox.height / 2 }, { x: wideBox.x + 20, y: wideBox.y + wideBox.height / 2 });
    await expect.poll(() => widePre.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
    expect(await currentSlideId(page)).toBe(wideSlide);

    // A chapter with vertical sub-slides: no overflow, swiping up with a finger -> goes to the next vertical slide (guarded by the app's touch-action:none fix; pan-y would break this step)
    await page.locator(".reveal .controls .navigate-right").tap();
    await expect.poll(() => currentSlideId(page)).toBe(stack);
    expect(await page.locator(`section[data-kn-slide-id="${stack}"]`).getAttribute("data-prevent-swipe")).toBeNull();
    await swipe(page, { x: 200, y: 520 }, { x: 200, y: 160 });
    await expect.poll(() => currentSlideId(page)).toBe(child);

    await page.locator(".reveal .controls .navigate-right").tap();
    await expect.poll(() => currentSlideId(page)).toBe(picture);
    const pictureSection = page.locator(`section[data-kn-slide-id="${picture}"]`);
    expect(await pictureSection.getAttribute("data-prevent-swipe")).toBeNull();
    releaseImage();
    await expect.poll(() => pictureSection.locator("img").evaluate((el) => (el as HTMLImageElement).naturalHeight), { timeout: 40_000 }).toBeGreaterThan(0);
    await expect(pictureSection).toHaveAttribute("data-prevent-swipe", "");
    await swipe(page, { x: 200, y: 520 }, { x: 200, y: 160 });
    await expect.poll(() => pictureSection.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await currentSlideId(page)).toBe(picture);
  } finally {
    await mobile.close();
    await desktop.close();
  }
});

test("E7: sidebar more menu of another note, \"Present\" -> opens that note's presentation directly; Esc (fullscreen) -> lands on that note's regular note page", async ({ page }) => {
  test.setTimeout(120_000);
  await loginAs(page, ADMIN.email, ADMIN.password);
  const target = `E2E present target ${Date.now()}`;
  await createNote(page, target);
  await pasteMarkdown(page, "## Target chapter\n\ntarget text\n");
  await expect(editorLocator(page).getByText("target text")).toBeVisible({ timeout: 15_000 });
  const targetPath = new URL(page.url()).pathname;
  await createNote(page, `E2E present other ${Date.now()}`);

  const row = page.getByRole("button", { name: `Note actions for ${target}` }).first();
  await row.locator("xpath=ancestor::li[1]").hover();
  await row.click();
  await page.getByRole("menuitem", { name: "Present" }).click();
  await expect(page.getByRole("dialog", { name: `${target} — presentation` })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".reveal.ready")).toBeVisible({ timeout: 15_000 });
  expect(new URL(page.url()).pathname).toBe(targetPath);
  expect(new URL(page.url()).search).toBe("?present");

  await leaveFullscreenLikeBrowserEsc(page);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe(targetPath);
  expect(new URL(page.url()).search).toBe("");
  await expect(page.getByLabel("Note title")).toHaveValue(target);
});

test("E8 (#235): touch - two-finger pinch zooms a non-overflowing slide, a short code block and a vertical sub-slide without changing slide; with touch-action:none (positive control) the same pinch does not zoom", async ({ browser }) => {
  test.setTimeout(120_000);
  const title = `E2E present pinch ${Date.now()}`;
  const { context: desktop, page: owner } = await adminPageWithNote(browser, title, ["## Short", "", "short text", "", "## Code", "", "```ts", "const shortCode = 1;", "```", "", "## Stack", "", "stack text", "", "### Child", "", "child text", ""].join("\n"));
  const mobile = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 640 } });
  try {
    await expect(editorLocator(owner).getByText("shortCode")).toBeVisible({ timeout: 15_000 });
    const noteUrl = owner.url();
    const page = await mobile.newPage();
    await loginAs(page, ADMIN.email, ADMIN.password);
    await page.goto(`${noteUrl}?present`);
    await expect(page.locator(".reveal.ready")).toBeVisible({ timeout: 20_000 });
    const cdp = await page.context().newCDPSession(page);
    const scale = () => page.evaluate(() => window.visualViewport?.scale ?? 1);
    const resetZoom = async () => {
      await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
      await expect.poll(scale).toBe(1);
    };
    // Raw two-finger spread: CDP's synthesizePinchGesture doesn't zoom in headless Chromium even with touch-action:auto everywhere.
    const pinchOn = async (target: import("@playwright/test").Locator) => {
      const box = (await target.boundingBox())!;
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x - 15, y, id: 1 }, { x: x + 15, y, id: 2 }] });
      for (let i = 1; i <= 10; i++) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x - 15 - 8 * i, y, id: 1 }, { x: x + 15 + 8 * i, y, id: 2 }] });
      }
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };

    const short = await slideIdContaining(page, "short text");
    await page.locator(".reveal .controls .navigate-right").tap();
    await expect.poll(() => currentSlideId(page)).toBe(short);
    const shortSection = page.locator(`section[data-kn-slide-id="${short}"]`);
    expect(await shortSection.getAttribute("data-prevent-swipe")).toBeNull();
    expect(await shortSection.evaluate((el) => getComputedStyle(el).touchAction)).toBe("pinch-zoom");

    // Positive control: the old touch-action:none blocks the same gesture, so a zoom below is really due to pinch-zoom.
    await shortSection.evaluate((el) => { (el as HTMLElement).style.touchAction = "none"; });
    await pinchOn(shortSection.getByText("short text"));
    await page.waitForTimeout(300);
    expect(await scale()).toBe(1);
    await shortSection.evaluate((el) => { (el as HTMLElement).style.touchAction = ""; });

    await pinchOn(shortSection.getByText("short text"));
    await expect.poll(scale).toBeGreaterThan(1.2);
    expect(await currentSlideId(page)).toBe(short);
    await resetZoom();

    const codeSlide = await slideIdContaining(page, "shortCode");
    await page.locator(".reveal .controls .navigate-right").tap();
    await expect.poll(() => currentSlideId(page)).toBe(codeSlide);
    const shortPre = page.locator(`section[data-kn-slide-id="${codeSlide}"] pre`);
    expect(await shortPre.getAttribute("data-prevent-swipe")).toBeNull();
    expect(await shortPre.evaluate((el) => getComputedStyle(el).touchAction)).toBe("pinch-zoom");
    await pinchOn(shortPre);
    await expect.poll(scale).toBeGreaterThan(1.2);
    expect(await currentSlideId(page)).toBe(codeSlide);
    await resetZoom();

    // A vertical sub-slide: reveal marks .reveal with is-vertical-slide (touch-action:none), which the app widens to pinch-zoom.
    const child = await slideIdContaining(page, "child text");
    await page.locator(".reveal .controls .navigate-right").tap();
    await page.locator(".reveal .controls .navigate-down").tap();
    await expect.poll(() => currentSlideId(page)).toBe(child);
    await expect(page.locator(".reveal")).toHaveClass(/is-vertical-slide/);
    await pinchOn(page.locator(`section[data-kn-slide-id="${child}"]`).getByText("child text"));
    await expect.poll(scale).toBeGreaterThan(1.2);
    expect(await currentSlideId(page)).toBe(child);
    await cdp.detach();
  } finally {
    await mobile.close();
    await desktop.close();
  }
});
