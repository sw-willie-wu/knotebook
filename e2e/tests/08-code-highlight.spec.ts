import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { E2E_ORIGIN } from "../ports.js";
import { ADMIN, createNote, editorLocator, loginAs } from "./helpers.js";

/**
 * issue #96: end-to-end check of code block syntax highlighting. Unit tests already cover the highlighter contract, the schema
 * wiring and the CSS-variable guard; this checks three things only a real browser can show:
 * 1. the shiki chunk is really lazy-loaded and decorations really draw (a jsdom green cannot prove the real bundle's
 *    `import("shiki")` resolves);
 * 2. the CSS variables really resolve to **different colours** (computed style; when the variables are undefined all tokens
 *    silently inherit one foreground colour while the DOM structure looks completely normal);
 * 3. the colours follow the light/dark switch (the :root / .dark variable sets in index.css).
 */

/** Screenshots for visual inspection: taken only when `CODE_HIGHLIGHT_SCREENSHOT_DIR` is set; this file writes no absolute path. */
const shotDir = process.env.CODE_HIGHLIGHT_SCREENSHOT_DIR;
async function shot(page: Page, name: string): Promise<void> {
  if (shotDir) await page.screenshot({ path: path.join(shotDir, name) });
}

const codeBlock = (page: import("@playwright/test").Page) =>
  page.locator('[data-testid="note-editor"] [data-content-type="codeBlock"]');

test("```ts fence -> highlighting appears and token colours are distinct -> light/dark switch changes colours -> language dropdown works", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E code highlight ${Date.now()}`);

  const editor = editorLocator(page);
  await editor.click();

  // ``` fence input rule (triggered by the trailing space); "ts" goes through the alias mapping in SUPPORTED_LANGUAGES.
  await editor.pressSequentially("```ts ");
  await expect(codeBlock(page)).toHaveCount(1);
  await expect(codeBlock(page).locator("select")).toHaveValue("typescript");

  await editor.pressSequentially('const greeting = "hello" // 註解');

  // 1. Core: shiki chunk lazy load -> grammar load -> decoration redraw. The first run fetches two chunks (shiki core +
  // typescript grammar), hence the generous timeout.
  const tokens = codeBlock(page).locator(".shiki");
  await expect(tokens.first()).toBeVisible({ timeout: 20_000 });

  // 2. Token colours are CSS variables and **resolve to distinct colours**. The inline-style assertion pins "the
  // css-variables theme is used"; the computed-colour count pins "the variables really have values" (when undefined, var()
  // fails to resolve and every token falls back to the inherited colour, leaving 1 distinct colour).
  const keywordToken = codeBlock(page).locator('.shiki[style*="--code-token-keyword"]');
  await expect(keywordToken.first()).toBeVisible();
  const lightColors = await tokens.evaluateAll((els) => [...new Set(els.map((el) => getComputedStyle(el).color))]);
  expect(lightColors.length).toBeGreaterThan(1);

  // Light-mode background: --code-background #f6f8fa (no longer the built-in hard-coded dark #161616 block).
  // resolvedTheme must be light: Playwright's default colorScheme is light, pinned explicitly here so a future config
  // change cannot make this assertion test dark while looking like light.
  await page.emulateMedia({ colorScheme: "light" });
  const lightBg = await codeBlock(page).evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(lightBg).toBe("rgb(246, 248, 250)");

  // The app follows the system theme by default, so emulateMedia flips it
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(async () => {
    const darkBg = await codeBlock(page).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(darkBg).toBe("rgb(21, 24, 30)");
  }).toPass({ timeout: 5_000 });
  const darkColors = await tokens.evaluateAll((els) => [...new Set(els.map((el) => getComputedStyle(el).color))]);
  expect(darkColors.length).toBeGreaterThan(1);
  // The two colour sets must not intersect (GitHub Light and Dark token colours are entirely different); an overlap means a
  // variable lacks a dark version and silently reuses the light colour.
  for (const color of darkColors) expect(lightColors).not.toContain(color);

  const options = codeBlock(page).locator("select option");
  expect(await options.count()).toBeGreaterThanOrEqual(20);
  await expect(codeBlock(page).locator('select option[value="python"]')).toHaveText("Python");
});

// One line holding every math form the LaTeX grammar colours: inline $…$, display $$…$$ and an equation environment, around plain words.
const LATEX_LINE = "Plain words $x_1^2$ then $$\\sum_i w_i$$ and \\begin{equation}a = b\\end{equation}";
const MATH_SNIPPETS = ["x_1^2", "\\sum_i w_i", "a = b"];

const tokenColor = (page: Page, text: string) =>
  codeBlock(page)
    .locator(".shiki", { hasText: text })
    .first()
    .evaluate((el) => getComputedStyle(el).color);

test("```latex fence -> stays a code block with LaTeX selected -> math tokens differ from plain text in light and dark", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E latex highlight ${Date.now()}`);

  const editor = editorLocator(page);
  await editor.click();
  await editor.pressSequentially("```latex ");
  // A latex fence is a code block and maps to the "latex" entry of SUPPORTED_LANGUAGES.
  await expect(codeBlock(page)).toHaveCount(1);
  await expect(codeBlock(page).locator("select")).toHaveValue("latex");
  await expect(codeBlock(page).locator('select option[value="latex"]')).toHaveText("LaTeX");

  await editor.pressSequentially(LATEX_LINE);
  await expect(codeBlock(page).locator(".shiki").first()).toBeVisible({ timeout: 20_000 });
  // Wait for the last math snippet: decorations are drawn after the grammar loads, and the line is typed character by character.
  await expect(codeBlock(page).locator('.shiki[style*="--code-token-constant"]', { hasText: "a = b" })).toBeVisible();

  const plainLight = await tokenColor(page, "Plain words");
  const mathLight = new Map<string, string>();
  for (const snippet of MATH_SNIPPETS) {
    const color = await tokenColor(page, snippet);
    expect(color, `${snippet} must not share the plain-text colour`).not.toBe(plainLight);
    mathLight.set(snippet, color);
  }

  await page.emulateMedia({ colorScheme: "dark" });
  await expect(async () => {
    expect(await codeBlock(page).evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(21, 24, 30)");
  }).toPass({ timeout: 5_000 });
  const plainDark = await tokenColor(page, "Plain words");
  for (const snippet of MATH_SNIPPETS) {
    const color = await tokenColor(page, snippet);
    expect(color, `${snippet} must not share the plain-text colour in dark`).not.toBe(plainDark);
    expect(color, `${snippet} must follow the theme switch`).not.toBe(mathLight.get(snippet));
  }
});

test("pasted latex fence is coloured and a tex fence is not", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: E2E_ORIGIN });
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E latex tex ${Date.now()}`);

  const editor = editorLocator(page);
  await editor.click();
  await page.evaluate((text) => navigator.clipboard.writeText(text), ["```latex", LATEX_LINE, "```", "", "```tex", LATEX_LINE, "```", ""].join("\n"));
  await page.keyboard.press("ControlOrMeta+v");

  await expect(codeBlock(page)).toHaveCount(2);
  const [latexBlock, texBlock] = [codeBlock(page).nth(0), codeBlock(page).nth(1)];
  await expect(latexBlock.locator("select")).toHaveValue("latex");
  // tex is not an alias of latex: the editor would colour it with shiki's separate TeX grammar, a presentation with LaTeX's.
  await expect(texBlock).toHaveAttribute("data-language", "tex");
  await expect(texBlock.locator("select")).not.toHaveValue("latex");
  await expect(texBlock.locator("select option[value=\"tex\"]")).toHaveCount(0);
  await expect(latexBlock.locator('.shiki[style*="--code-token-constant"]', { hasText: "a = b" })).toBeVisible({ timeout: 20_000 });
  // The tex block is drawn in the same pass as the latex block, so by now its decorations would be there too.
  await expect(texBlock).toContainText("a = b");
  expect(await texBlock.locator(".shiki").count()).toBe(0);
  await shot(page, "latex-editor-light.png");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(async () => {
    expect(await latexBlock.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(21, 24, 30)");
  }).toPass({ timeout: 5_000 });
  await shot(page, "latex-editor-dark.png");
});
