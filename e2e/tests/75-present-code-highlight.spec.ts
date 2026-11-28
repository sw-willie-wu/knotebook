import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_ORIGIN } from "../ports.js";
import { ADMIN, clickEndOfParagraph, createNote, editorLocator, loginAs, waitForEditorSelection } from "./helpers.js";

/**
 * #232: code blocks in presentation mode are syntax-highlighted. Unit tests cover tokenizing, caching and the DOM writes;
 * this checks what only the real bundle and a real browser can show:
 * 1. the presentation chunk really reaches shiki through the dynamic import and the token colours resolve to distinct
 *    computed colours (undefined `--code-*` variables would leave every token one inherited colour);
 * 2. a light/dark switch recolours the same token nodes (CSS variables, no re-tokenizing);
 * 3. a plain-text block stays uncoloured;
 * 4. a live edit on the code slide keeps it coloured (cache hit, the new DOM is coloured synchronously).
 */

async function pasteMarkdown(page: Page, markdown: string): Promise<void> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: E2E_ORIGIN });
  const editor = editorLocator(page);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await waitForEditorSelection(page);
  await page.evaluate((text) => navigator.clipboard.writeText(text), markdown);
  await page.keyboard.press("ControlOrMeta+v");
}

/** Screenshots for visual inspection: taken only when `CODE_HIGHLIGHT_SCREENSHOT_DIR` is set; this file writes no absolute path. */
const shotDir = process.env.CODE_HIGHLIGHT_SCREENSHOT_DIR;
async function shot(page: Page, name: string): Promise<void> {
  if (shotDir) await page.screenshot({ path: path.join(shotDir, name) });
}

const tokenColors = (page: Page, selector: string) =>
  page.locator(selector).evaluateAll((els) => [...new Set(els.map((el) => getComputedStyle(el).color))]);

test("presentation code block: distinct token colours, theme switch recolours without re-tokenizing, text block uncoloured, live edit stays coloured", async ({ page }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ colorScheme: "light" });
  await loginAs(page, ADMIN.email, ADMIN.password);
  const title = `E2E present code ${Date.now()}`;
  await createNote(page, title);
  await pasteMarkdown(page, [
    "## Code slide",
    "",
    "code intro",
    "",
    "```ts",
    'const greeting: string = "hello"; // note',
    "function add(a: number) { return a + 1; }",
    "```",
    "",
    "```text",
    "plain words here",
    "```",
    "",
  ].join("\n"));
  await expect(editorLocator(page).getByText("plain words here")).toBeVisible({ timeout: 15_000 });
  const noteUrl = page.url();

  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Present" }).click();
  await expect(page.locator(".reveal.ready")).toBeVisible({ timeout: 15_000 });

  const tsCode = '.reveal .slides pre > code[data-kn-code-lang="typescript"]';
  const tsTokens = `${tsCode} > span[style]`;
  await expect(page.locator(tsTokens).first()).toBeAttached({ timeout: 20_000 });
  await expect(page.locator(tsCode)).toHaveText(/const greeting: string = "hello"; \/\/ note\nfunction add/);
  expect(await page.locator(`${tsTokens}[style*="--code-token-keyword"]`).count()).toBeGreaterThan(0);
  const lightColors = await tokenColors(page, tsTokens);
  expect(lightColors.length).toBeGreaterThan(2);

  const textCode = page.locator('.reveal .slides pre > code[data-kn-code-lang="text"]');
  await expect(textCode).toHaveText("plain words here");
  expect(await textCode.locator("span[style]").count()).toBe(0);

  // Tag the token nodes: after the theme switch the same nodes must still be there (recoloured by CSS, not rebuilt).
  await page.locator(tsTokens).evaluateAll((els) => els.forEach((el) => el.setAttribute("data-e2e-mark", "1")));
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(async () => (await tokenColors(page, tsTokens)).some((c) => lightColors.includes(c))).toBe(false);
  expect(await page.locator(`${tsTokens}:not([data-e2e-mark])`).count()).toBe(0);
  await page.emulateMedia({ colorScheme: "light" });

  // Live edit from a second tab (the presentation covers this tab's editor) re-renders the code slide; it must come back coloured.
  const editorTab = await page.context().newPage();
  await editorTab.goto(noteUrl);
  await clickEndOfParagraph(editorTab, editorLocator(editorTab).getByText("code intro"));
  await editorTab.keyboard.type(" edited");
  // As in 22-presentation E6: the presenting tab is in the background now, so nudge it the way a tab switch would.
  await expect(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event("visibilitychange")));
    await expect(page.locator(".reveal .slides").getByText("code intro edited")).toBeAttached({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(page.locator(`${tsTokens}[style*="--code-token-keyword"]`).first()).toBeAttached();
  expect(await page.locator(`${tsTokens}[data-e2e-mark]`).count()).toBe(0); // proves the slide really was rebuilt
});

test("presentation LaTeX code block: math tokens differ from plain text and follow the theme, a tex block stays uncoloured", async ({ page }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ colorScheme: "light" });
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E present latex ${Date.now()}`);
  const line = "Plain words $x_1^2$ then $$\\sum_i w_i$$ and \\begin{equation}a = b\\end{equation}";
  await pasteMarkdown(page, ["## Latex slide", "", "```latex", line, "```", "", "```tex", line, "```", ""].join("\n"));
  await expect(editorLocator(page).getByText("Latex slide")).toBeVisible({ timeout: 15_000 });

  await page.getByRole("button", { name: "More", exact: true }).click();
  await page.getByRole("menuitem", { name: "Present" }).click();
  await expect(page.locator(".reveal.ready")).toBeVisible({ timeout: 15_000 });

  const latexCodeSelector = '.reveal .slides pre > code[data-kn-code-lang="latex"]';
  const latexTokens = `${latexCodeSelector} > span[style]`;
  await expect(page.locator(latexTokens).first()).toBeAttached({ timeout: 20_000 });
  const colorOf = (text: string) =>
    page.locator(latexTokens, { hasText: text }).first().evaluate((el) => getComputedStyle(el).color);
  const snippets = ["x_1^2", "\\sum_i w_i", "a = b"];
  const plainLight = await colorOf("Plain words");
  const mathLight: string[] = [];
  for (const snippet of snippets) {
    const color = await colorOf(snippet);
    expect(color, `${snippet} must not share the plain-text colour`).not.toBe(plainLight);
    mathLight.push(color);
  }

  // tex is not a LaTeX alias, in presentation mode just as in the editor: the same line stays one plain run.
  const texCode = page.locator(".reveal .slides pre > code", { hasText: "a = b" }).last();
  await expect(texCode).toHaveAttribute("data-kn-code-lang", "tex");
  expect(await texCode.locator("span[style]").count()).toBe(0);
  // The title slide comes first: move to the slide that holds the code so the screenshots show it.
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(latexCodeSelector)).toBeVisible();
  await shot(page, "latex-present-light.png");

  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(async () => (await colorOf("a = b")) !== mathLight[2]).toBe(true);
  const plainDark = await colorOf("Plain words");
  for (const [i, snippet] of snippets.entries()) {
    const color = await colorOf(snippet);
    expect(color, `${snippet} in dark must not share the plain-text colour`).not.toBe(plainDark);
    expect(color, `${snippet} must follow the theme switch`).not.toBe(mathLight[i]);
  }
  await shot(page, "latex-present-dark.png");
});
