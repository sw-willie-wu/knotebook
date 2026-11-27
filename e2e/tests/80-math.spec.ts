import path from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { E2E_ORIGIN } from "../ports.js";
import { ADMIN, createNote, editorLocator, loginAs, noteIdFromUrl, waitForEditorSelection } from "./helpers.js";

/**
 * #338: end-to-end coverage of the math block, for what unit tests structurally cannot see:
 * 1. KaTeX really draws in a real browser, from the lazily loaded `katex-*.js` chunk, and only once a formula is shown;
 * 2. the typed ```math fence (an `appendTransaction` on top of BlockNote's own input rule) and the real clipboard;
 * 3. computed styles: the body font for Chinese inside formulas, and the phone's sideways-scroll fade;
 * 4. CSP: KaTeX's stylesheet and fonts (one of them inlined as a `data:` URI) load without a violation, in the editor and in presentation mode.
 */

/** Screenshots for visual inspection: taken only when `MATH_SCREENSHOT_DIR` is set; this file writes no absolute path. */
const shotDir = process.env.MATH_SCREENSHOT_DIR;
async function shot(page: Page, name: string): Promise<void> {
  if (shotDir) await page.screenshot({ path: path.join(shotDir, name) });
}

const KATEX_CHUNK = /\/assets\/katex-[^/]*\.js$/;

const mathBlocks = (page: Page) => page.locator('[data-testid="note-editor"] [data-content-type="math"]');
const codeBlocks = (page: Page) => page.locator('[data-testid="note-editor"] [data-content-type="codeBlock"]');
const sourceBox = (page: Page) => page.getByRole("textbox", { name: "LaTeX source" });
/** The drawn formula; `.katex-html` is the visible part, `.katex-mathml` the hidden MathML copy. */
const drawn = (block: Locator) => block.locator(".katex-display .katex-html");

async function pasteText(page: Page, text: string): Promise<void> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: E2E_ORIGIN });
  const editor = editorLocator(page);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await waitForEditorSelection(page);
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await page.keyboard.press("ControlOrMeta+v");
}

type Created = { id: string; title: string; slug: string; ownerHandle: string };
async function createNoteViaApi(page: Page, title: string, content: string): Promise<Created> {
  const res = await page.request.post("/api/notes", { data: { title, content } });
  expect(res.status(), `POST /api/notes → ${res.status()} ${await res.text()}`).toBe(201);
  return (await res.json()) as Created;
}
const pathOf = (n: Created) => `/n/${n.ownerHandle}/${n.slug}`;
async function openNote(page: Page, note: Created): Promise<void> {
  await page.goto(pathOf(note));
  await expect(page.getByRole("textbox", { name: "Note title" })).toHaveValue(note.title, { timeout: 15_000 });
}

async function insertFromSlashMenu(page: Page): Promise<Locator> {
  const editor = editorLocator(page);
  await editor.click();
  await editor.pressSequentially("/math");
  await page.getByText("Write a formula in LaTeX").click();
  return mathBlocks(page).last();
}

async function typeIntoNewFormula(page: Page, tex: string): Promise<Locator> {
  const block = await insertFromSlashMenu(page);
  await block.getByRole("button", { name: "Edit formula source" }).click();
  await sourceBox(page).fill(tex);
  await sourceBox(page).press("Escape");
  return block;
}

interface Violation {
  directive: string;
  blockedURI: string;
}
async function collectCspViolations(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as unknown as { __cspViolations: Violation[] }).__cspViolations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __cspViolations: Violation[] }).__cspViolations.push({ directive: event.violatedDirective, blockedURI: event.blockedURI });
    });
  });
}
const cspViolations = (page: Page) => page.evaluate(() => (window as unknown as { __cspViolations: Violation[] }).__cspViolations);

/** The zero-violation check is also green when no CSP is sent at all; an injected inline script must be blocked and reported. */
async function expectCspInForce(page: Page): Promise<void> {
  const ran = await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "window.__cspPositiveControl = true;";
    document.head.appendChild(script);
    return (window as unknown as { __cspPositiveControl?: boolean }).__cspPositiveControl ?? false;
  });
  expect(ran, "an injected inline script ran: CSP is not in force, so zero violations proves nothing").toBe(false);
  expect((await cspViolations(page)).some((v) => v.directive.startsWith("script-src"))).toBe(true);
}

/**
 * Uses every delimiter size (`\bigg` needs KaTeX_Size3, the font Vite inlines as a `data:` URI) and the script, fraktur and
 * blackboard faces, so the browser has to fetch several font files.
 */
const FONT_HEAVY_TEX = String.raw`\mathcal{A} + \mathfrak{B} + \mathbb{C} = \big( \Big( \bigg( \Bigg( \sum_{i=1}^n \int_0^1 x_i \, dx \Bigg) \bigg) \Big) \big)`;

test("KaTeX is downloaded only once a formula is drawn: a note without math fetches no katex chunk", async ({ page }) => {
  const katexRequests: string[] = [];
  page.on("request", (request) => {
    if (KATEX_CHUNK.test(new URL(request.url()).pathname)) katexRequests.push(request.url());
  });

  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E math lazy ${Date.now()}`);
  const editor = editorLocator(page);
  await editor.click();
  await editor.pressSequentially("Plain text only");
  await expect(editor.getByText("Plain text only")).toBeVisible();
  await page.waitForTimeout(1500);
  expect(katexRequests, "a note without formulas must not load KaTeX").toEqual([]);

  const responsePromise = page.waitForResponse((response) => KATEX_CHUNK.test(new URL(response.url()).pathname));
  await page.keyboard.press("Enter");
  const block = await typeIntoNewFormula(page, "E = mc^2");
  const response = await responsePromise;
  expect(response.status()).toBe(200);
  expect(new URL(response.url()).origin, "KaTeX is served by this server, not a CDN").toBe(E2E_ORIGIN);
  await expect(drawn(block)).toBeVisible({ timeout: 20_000 });
});

test("/math inserts an empty formula -> source typed -> KaTeX draws it; Edit reopens the source", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E math slash ${Date.now()}`);

  const block = await insertFromSlashMenu(page);
  await expect(mathBlocks(page)).toHaveCount(1);
  await expect(block.getByText("Click to add a formula (LaTeX)")).toBeVisible();
  await expect(block.locator(".katex")).toHaveCount(0);

  await block.getByRole("button", { name: "Edit formula source" }).click();
  await sourceBox(page).fill("E = mc^2");
  await sourceBox(page).press("Escape");

  await expect(drawn(block)).toBeVisible({ timeout: 20_000 });
  // KaTeX's visible HTML renders "mc^2" as "mc" plus a superscript "2"; the MathML annotation keeps the source verbatim.
  await expect(drawn(block)).toContainText("mc");
  await expect(block.locator(".katex-display .katex-mathml annotation")).toHaveText("E = mc^2");
  await expect(sourceBox(page)).toHaveCount(0);
  await expect(block).toHaveAttribute("data-tex", "E = mc^2");

  await block.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(sourceBox(page)).toHaveValue("E = mc^2");
  await sourceBox(page).press("Escape");
  await expect(drawn(block)).toBeVisible();
});

test("typing ```math then Enter or Space makes a formula with its source open; Esc draws it; ```latex stays a code block", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E math typed ${Date.now()}`);
  const editor = editorLocator(page);
  await editor.click();

  await editor.pressSequentially("```math");
  await page.keyboard.press("Enter");
  await expect(mathBlocks(page)).toHaveCount(1);
  await expect(codeBlocks(page)).toHaveCount(0);
  await expect(sourceBox(page)).toBeFocused();
  await page.keyboard.type("a^2 + b^2 = c^2");
  await page.keyboard.press("Escape");
  await expect(drawn(mathBlocks(page).first())).toBeVisible({ timeout: 20_000 });
  await expect(mathBlocks(page).first()).toHaveAttribute("data-tex", "a^2 + b^2 = c^2");
  // Esc hands the caret back to the note, so typing goes on below the formula.
  await expect(editor).toBeFocused();

  await editor.pressSequentially("```math ");
  await expect(mathBlocks(page)).toHaveCount(2);
  await expect(sourceBox(page)).toBeFocused();
  await page.keyboard.type("x_1");
  await page.keyboard.press("Escape");
  await expect(drawn(mathBlocks(page).nth(1))).toBeVisible({ timeout: 20_000 });

  await editor.pressSequentially("```latex ");
  await expect(codeBlocks(page)).toHaveCount(1);
  await expect(codeBlocks(page).locator("select")).toHaveValue("latex");
  await expect(mathBlocks(page)).toHaveCount(2);
  await expect(sourceBox(page)).toHaveCount(0);
});

test("pasting a ```math fence makes a formula; a ```latex fence stays a coloured code block; both survive a reload and read back as Markdown", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E math paste ${Date.now()}`);
  const tex = String.raw`\int_0^1 x\,dx`;
  const latexLine = String.raw`Plain words $x_1^2$ here`;
  await pasteText(page, ["```math", tex, "```", "", "```latex", latexLine, "```", ""].join("\n"));

  await expect(mathBlocks(page)).toHaveCount(1, { timeout: 15_000 });
  await expect(drawn(mathBlocks(page).first())).toBeVisible({ timeout: 20_000 });
  await expect(mathBlocks(page).first()).toHaveAttribute("data-tex", tex);
  await expect(codeBlocks(page)).toHaveCount(1);
  await expect(codeBlocks(page).locator("select")).toHaveValue("latex");
  await expect(codeBlocks(page).locator('.shiki[style*="--code-token-constant"]', { hasText: "x_1^2" })).toBeVisible({ timeout: 20_000 });
  await expect(codeBlocks(page).locator(".katex")).toHaveCount(0);
  await shot(page, "math-editor-desktop-light.png");

  // Wait for the save to reach the server, then reopen: the formula comes back from the stored document.
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(drawn(mathBlocks(page).first())).toBeVisible({ timeout: 20_000 });
  await expect(mathBlocks(page)).toHaveCount(1);
  await expect(mathBlocks(page).first()).toHaveAttribute("data-tex", tex);
  await expect(codeBlocks(page)).toHaveCount(1);

  const noteId = await noteIdFromUrl(page);
  const res = await page.request.get(`/api/notes/${noteId}/content`);
  expect(res.status()).toBe(200);
  const { markdown } = (await res.json()) as { markdown: string };
  expect(markdown).toContain(["```math", tex, "```"].join("\n"));
  expect(markdown).toContain(["```latex", latexLine, "```"].join("\n"));

  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
  await shot(page, "math-editor-desktop-dark.png");
});

test("a syntax error shows KaTeX's red source with the message on hover; \\href draws no link", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E math errors ${Date.now()}`);
  const editor = editorLocator(page);
  await editor.click();
  await editor.pressSequentially("Intro");
  await page.keyboard.press("Enter");

  const broken = await typeIntoNewFormula(page, String.raw`\frac{`);
  const error = broken.locator(".katex-error");
  await expect(error).toBeVisible({ timeout: 20_000 });
  await expect(error).toHaveText(String.raw`\frac{`);
  await expect(error).toHaveAttribute("title", /ParseError/);
  await expect(broken.locator(".katex-html")).toHaveCount(0);

  // A formula block has no caret of its own: go back to the paragraph above it to insert the next one.
  await editor.getByText("Intro").click();
  await page.keyboard.press("End");
  await waitForEditorSelection(page, 10_000);
  await page.keyboard.press("Enter");
  await editor.pressSequentially("/math");
  await page.getByText("Write a formula in LaTeX").click();
  await expect(mathBlocks(page)).toHaveCount(2);
  const link = mathBlocks(page).first();
  await link.getByRole("button", { name: "Edit formula source" }).click();
  await sourceBox(page).fill(String.raw`\href{https://example.com}{x} + y`);
  await sourceBox(page).press("Escape");
  await expect(drawn(link)).toBeVisible({ timeout: 20_000 });
  await expect(drawn(link)).toContainText("y");
  await expect(link.locator("a")).toHaveCount(0);
  await expect(page.locator('a[href^="https://example.com"]')).toHaveCount(0);
  // The broken formula next to it did not take the page down: the note still takes text.
  await editor.getByText("Intro").click();
  await page.keyboard.press("End");
  await waitForEditorSelection(page, 10_000);
  await page.keyboard.type(" still editable");
  await expect(editor.getByText("Intro still editable")).toBeVisible();
});

test("Chinese inside \\text, \\textsf and \\mathbf uses the note's body font, while Latin letters keep KaTeX's", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E math cjk ${Date.now()}`);
  const editor = editorLocator(page);
  await editor.click();
  await editor.pressSequentially("Body text");
  await page.keyboard.press("Enter");
  const block = await typeIntoNewFormula(page, String.raw`v = \text{速度} + \textsf{速} + \mathbf{速}`);
  await expect(drawn(block)).toBeVisible({ timeout: 20_000 });

  const bodyFont = await editor.getByText("Body text").evaluate((el) => getComputedStyle(el).fontFamily);
  expect(bodyFont).not.toMatch(/KaTeX/);
  const fonts = await drawn(block).evaluate((root) => {
    const out: Array<{ text: string; font: string }> = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? "";
      if (/[速度v]/.test(text)) out.push({ text, font: getComputedStyle(node.parentElement!).fontFamily });
    }
    return out;
  });
  const cjk = fonts.filter((f) => /[速度]/.test(f.text));
  // 速度 in \text, 速 in \textsf and 速 in \mathbf: KaTeX may split or join runs, but every CJK character must be covered.
  expect(cjk.map((f) => f.text).join(""), JSON.stringify(fonts)).toBe("速度速速");
  for (const run of cjk) expect(run.font, `font of "${run.text}"`).toBe(bodyFont);
  const latin = fonts.find((f) => f.text === "v");
  expect(latin?.font, JSON.stringify(fonts)).toMatch(/KaTeX_Math/);
});

test.describe("phone width", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("a long formula scrolls sideways inside its block with a fading edge; the page itself does not scroll sideways", async ({ page }) => {
    await loginAs(page, ADMIN.email, ADMIN.password);
    const long = Array.from({ length: 30 }, (_, i) => `x_{${i}}`).join(" + ");
    const note = await createNoteViaApi(page, `E2E math phone ${Date.now()}`, ["Before the formula", "", "```math", long, "```", "", "After the formula", ""].join("\n"));
    await openNote(page, note);

    const scroller = mathBlocks(page).first().locator("[data-kb-math-scroll]");
    await expect(scroller.locator(".katex-html")).toBeVisible({ timeout: 20_000 });
    const metrics = () =>
      scroller.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        overflowX: getComputedStyle(el).overflowX,
        mask: getComputedStyle(el).maskImage,
        fade: getComputedStyle(el).getPropertyValue("--kb-table-fade"),
        pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }));
    const start = await metrics();
    expect(start.scrollWidth, "precondition: the formula is wider than the block").toBeGreaterThan(start.clientWidth + 100);
    expect(start.overflowX).toBe("auto");
    expect(start.mask).toContain("linear-gradient");
    expect(start.fade, "the edge fades while there is more to the right").toBe("24px");
    expect(start.pageOverflow, "the page must not scroll sideways").toBeLessThanOrEqual(0);
    await shot(page, "math-phone-390.png");

    await scroller.evaluate((el) => el.scrollTo({ left: el.scrollWidth }));
    await expect.poll(async () => (await metrics()).fade, { message: "the fade goes away at the right end" }).toBe("0px");
    expect(await scroller.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
  });
});

test("desktop width: a formula that fits has no fading edge", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.password);
  const note = await createNoteViaApi(page, `E2E math desktop ${Date.now()}`, ["```math", "a + b", "```", ""].join("\n"));
  await openNote(page, note);
  const scroller = mathBlocks(page).first().locator("[data-kb-math-scroll]");
  await expect(scroller.locator(".katex-html")).toBeVisible({ timeout: 20_000 });
  expect(await scroller.evaluate((el) => getComputedStyle(el).maskImage)).toBe("none");
});

/**
 * Puts a word only in a formula's source, under a "Formula" heading with filler around it, searches for it from the sidebar and
 * clicks the result. Returns the formula block and the ids of the blocks the jump highlighted (`.kn-anchor-flash`, recorded by an
 * init script because the highlight lasts only 2 s).
 */
async function searchFormulaWord(page: Page): Promise<{ formula: Locator; heading: Locator; flashes: () => Promise<string[]> }> {
  await page.addInitScript(() => {
    const flashes: string[] = [];
    (window as unknown as { __flashes: string[] }).__flashes = flashes;
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (node instanceof HTMLElement && node.classList.contains("kn-anchor-flash")) flashes.push(node.getAttribute("data-anchor-flash") ?? "");
    }).observe(document, { childList: true, subtree: true });
  });
  await loginAs(page, ADMIN.email, ADMIN.password);
  const kw = `kw${Date.now()}`;
  const filler = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `${prefix} filler ${i + 1}`).join("\n\n");
  const note = await createNoteViaApi(
    page,
    `E2E math search ${Date.now()}`,
    ["## Intro", "", filler("intro", 30), "", "## Formula", "", "```math", String.raw`\text{${kw}} = 1`, "```", "", filler("tail", 30), ""].join("\n"),
  );
  await expect
    .poll(
      async () => {
        const res = await page.request.get(`/api/search?q=${encodeURIComponent(kw)}&match=body`);
        if (res.status() !== 200) return false;
        return ((await res.json()) as { hits: Array<{ note: { id: string } }> }).hits.some((h) => h.note.id === note.id);
      },
      { intervals: [500, 1000], timeout: 20_000 },
    )
    .toBe(true);

  await page.goto("/");
  const search = page.getByRole("complementary").getByRole("textbox", { name: "Search notes" });
  await expect(search).toBeVisible();
  await search.fill(kw);
  const results = page.getByRole("complementary").getByRole("region", { name: "Search results" });
  const snippet = results.locator(`a[href^="${pathOf(note)}#b-"]`);
  await expect(snippet).toHaveCount(1, { timeout: 15_000 });
  await expect(snippet.locator("mark")).toHaveText(kw);
  await snippet.click();
  await page.waitForURL((u) => u.pathname === pathOf(note), { timeout: 15_000 });

  const formula = mathBlocks(page).first();
  await expect(drawn(formula)).toBeVisible({ timeout: 20_000 });
  const heading = page.locator(".bn-block-outer", { has: page.getByRole("heading", { name: "Formula" }) }).last();
  return { formula, heading, flashes: () => page.evaluate(() => (window as unknown as { __flashes: string[] }).__flashes) };
}

test("search finds a word that is only in a formula's source, and the result opens that section of the note", async ({ page }) => {
  test.setTimeout(120_000);
  const { formula, heading, flashes } = await searchFormulaWord(page);
  const headingId = await heading.getAttribute("data-id");
  expect(new URL(page.url()).hash, "the result links to the section holding the formula").toBe(`#b-${headingId}`);
  await expect.poll(flashes, { timeout: 15_000 }).not.toEqual([]);
  await expect(formula).toBeInViewport();
});

// The heading appears before the formula's React node view renders its source, so the jump has to wait for the formula.
test("search result for a formula's word highlights the formula block, not the section heading", async ({ page }) => {
  test.setTimeout(120_000);
  const { formula, flashes } = await searchFormulaWord(page);
  const formulaId = await formula.evaluate((el) => el.closest(".bn-block-outer")!.getAttribute("data-id"));
  await expect.poll(flashes, { timeout: 15_000 }).toContain(formulaId);
});

test("editor: KaTeX's stylesheet and fonts (one inlined as data:) load with zero CSP violations (with positive control)", async ({ page }) => {
  await collectCspViolations(page);
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E math csp ${Date.now()}`);
  const block = await typeIntoNewFormula(page, FONT_HEAVY_TEX);
  await expect(drawn(block)).toBeVisible({ timeout: 20_000 });
  // `document.fonts.load` resolves to the faces that loaded; Size3 is the one Vite inlined as a data: URI.
  for (const family of ["KaTeX_Main", "KaTeX_Size3", "KaTeX_Size4", "KaTeX_Fraktur", "KaTeX_AMS"]) {
    const loaded = await page.evaluate((f) => document.fonts.load(`16px ${f}`).then((faces) => faces.length), family);
    expect(loaded, `${family} loaded`).toBeGreaterThan(0);
  }
  expect(await cspViolations(page)).toEqual([]);
  await expectCspInForce(page);
});

test("presentation mode draws formulas with zero CSP violations (with positive control)", async ({ page }) => {
  test.setTimeout(120_000);
  await collectCspViolations(page);
  await loginAs(page, ADMIN.email, ADMIN.password);
  const title = `E2E math present ${Date.now()}`;
  await createNote(page, title);
  await pasteText(page, ["## Formula slide", "", "```math", FONT_HEAVY_TEX, "```", "", "```math", String.raw`v = \text{速度}`, "```", ""].join("\n"));
  await expect(mathBlocks(page)).toHaveCount(2, { timeout: 15_000 });

  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Present" }).click();
  await expect(page.locator(".reveal.ready")).toBeVisible({ timeout: 15_000 });

  const formulas = page.locator(".reveal .slides .kn-present-math");
  await expect(formulas).toHaveCount(2);
  await expect(formulas.first().locator(".katex-display .katex-html")).toBeAttached({ timeout: 20_000 });
  await expect(formulas.nth(1).locator(".katex-display .katex-html")).toBeAttached();
  await expect(formulas.nth(1).locator(".katex-mathml annotation")).toHaveText(String.raw`v = \text{速度}`);
  // The title slide comes first: move to the slide with the formulas so the screenshot shows them.
  await page.keyboard.press("ArrowRight");
  await expect(formulas.first()).toBeVisible();
  await page.waitForTimeout(500); // let the font requests happen before collecting violations
  await shot(page, "math-present-light.png");
  await page.emulateMedia({ colorScheme: "dark" });
  await page.waitForTimeout(500);
  await shot(page, "math-present-dark.png");

  expect(await cspViolations(page)).toEqual([]);
  await expectCspInForce(page);
});
