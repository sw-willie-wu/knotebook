import { expect, test, type Page, type Request, type Response } from "@playwright/test";
import { RUN, apiCreateNote, createAccount, openAs, waitForNoteTitle } from "./knowledge-helpers.js";

test.use({ actionTimeout: 15_000 });

const DESKTOP = { width: 1440, height: 900 };
const LIVE = { timeout: 20_000 };

async function share(owner: Page, noteId: string, email: string): Promise<void> {
  const res = await owner.request.put(`/api/notes/${noteId}/shares`, { data: { email, role: "viewer" } });
  expect(res.status(), await res.text()).toBe(200);
}

async function comment(page: Page, noteId: string, body: string): Promise<string> {
  const res = await page.request.post(`/api/notes/${noteId}/comments`, { data: { body } });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

const bell = (page: Page) => page.getByTestId("notification-bell");
const badge = (page: Page) => page.getByTestId("notification-badge");
const isCountResponse = (res: Response) => res.url().endsWith("/api/notifications/unread-count") && res.status() === 200;
const popover = (page: Page) => page.getByTestId("notifications-popover");

// Reloads and resolves once the notification socket exists, every count request issued before it appeared has been answered, and the
// page has been idle for 500 ms (so an on-connect refetch, when one is issued, has finished too). That refetch is not awaited on its
// own: when the socket opens while the first count is still in flight, the invalidation joins that request and issues no new one.
async function reloadUntilSocketLive(page: Page): Promise<void> {
  let requests = 0;
  let responses = 0;
  const onRequest = (req: Request) => {
    if (req.url().endsWith("/api/notifications/unread-count")) requests += 1;
  };
  const onResponse = (res: Response) => {
    if (isCountResponse(res)) responses += 1;
  };
  page.on("request", onRequest);
  page.on("response", onResponse);
  try {
    const socket = page.waitForEvent("websocket", (ws) => ws.url().includes("/collab/notifications"));
    await page.reload();
    await socket;
    const issuedBeforeSocket = requests;
    await expect.poll(() => responses, { timeout: 20_000 }).toBeGreaterThanOrEqual(issuedBeforeSocket);
    await page.waitForLoadState("networkidle");
  } finally {
    page.off("request", onRequest);
    page.off("response", onResponse);
  }
}

test("79-1 a mention reaches the bell live; opening clears the badge for good; the row opens the comment", async ({ browser }) => {
  test.setTimeout(180_000);
  const alice = await createAccount(browser, "alice");
  const bob = await createAccount(browser, "bob");
  const a = await openAs(browser, alice, { viewport: DESKTOP });
  const b = await openAs(browser, bob, { viewport: DESKTOP });
  try {
    const title = `E2E bell ${RUN}`;
    const note = await apiCreateNote(a.page, title, "Something to discuss.");
    const aliceHandle = note.path.split("/")[2]!;
    await share(a.page, note.id, bob.email);

    await reloadUntilSocketLive(a.page);
    await expect(bell(a.page)).toBeVisible({ timeout: 15_000 });
    await expect(badge(a.page)).toHaveCount(0);

    // Alice's tab stays on the home page and is never reloaded: the badge arrives over the notification socket.
    const text = `please look at this ${RUN}`;
    const commentId = await comment(b.page, note.id, `@${aliceHandle} ${text}`);
    await expect(badge(a.page)).toHaveText("1", LIVE);

    await bell(a.page).click();
    const row = popover(a.page).getByTestId("notification").filter({ hasText: text });
    await expect(row).toBeVisible(LIVE);
    await expect(row).toContainText(`${bob.displayName} mentioned you`);
    await expect(row).toContainText(title);
    await expect(row.getByTestId("notification-new")).toBeVisible();
    await expect(badge(a.page)).toHaveCount(0);

    // Closed and reloaded: the server counts nothing unread.
    await a.page.keyboard.press("Escape");
    await expect(popover(a.page)).toHaveCount(0);
    const counted = a.page.waitForResponse(isCountResponse);
    await a.page.reload();
    await counted;
    await expect(bell(a.page)).toBeVisible({ timeout: 15_000 });
    await expect(badge(a.page)).toHaveCount(0);

    await bell(a.page).click();
    const again = popover(a.page).getByTestId("notification").filter({ hasText: text });
    await expect(again).toBeVisible(LIVE);
    await expect(again.getByTestId("notification-new")).toHaveCount(0);
    await again.getByRole("button", { name: /mentioned you/ }).click();

    await waitForNoteTitle(a.page, title);
    await expect(popover(a.page)).toHaveCount(0);
    const panel = a.page.getByTestId("comments-panel");
    await expect(panel.locator(`[data-comment-id="${commentId}"]`)).toBeVisible({ timeout: 15_000 });
    await expect(a.page).not.toHaveURL(/comment=/);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("79-2 deleting one notification and clearing all", async ({ browser }) => {
  test.setTimeout(180_000);
  const alice = await createAccount(browser, "alice");
  const bob = await createAccount(browser, "bob");
  const a = await openAs(browser, alice, { viewport: DESKTOP });
  const b = await openAs(browser, bob, { viewport: DESKTOP });
  try {
    const note = await apiCreateNote(a.page, `E2E clear ${RUN}`, "Body.");
    const aliceHandle = note.path.split("/")[2]!;
    await share(a.page, note.id, bob.email);
    await reloadUntilSocketLive(a.page);
    await expect(bell(a.page)).toBeVisible({ timeout: 15_000 });

    await comment(b.page, note.id, `@${aliceHandle} first ${RUN}`);
    await comment(b.page, note.id, `@${aliceHandle} second ${RUN}`);
    await expect(badge(a.page)).toHaveText("2", LIVE);

    await bell(a.page).click();
    const rows = popover(a.page).getByTestId("notification");
    await expect(rows).toHaveCount(2, LIVE);
    await rows.filter({ hasText: `first ${RUN}` }).getByRole("button", { name: "Delete this notification" }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText(`second ${RUN}`);

    await popover(a.page).getByRole("button", { name: "Clear all" }).click();
    const confirm = popover(a.page).getByRole("group", { name: "Clear all notifications?" });
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(rows).toHaveCount(1);

    await popover(a.page).getByRole("button", { name: "Clear all" }).click();
    await popover(a.page).getByRole("group", { name: "Clear all notifications?" }).getByRole("button", { name: "Clear", exact: true }).click();
    await expect(popover(a.page).getByText("No notifications yet.")).toBeVisible();

    await a.page.keyboard.press("Escape");
    await a.page.reload();
    await expect(bell(a.page)).toBeVisible({ timeout: 15_000 });
    await expect(badge(a.page)).toHaveCount(0);
    await bell(a.page).click();
    await expect(popover(a.page).getByText("No notifications yet.")).toBeVisible(LIVE);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test("79-3 seven tabs of one person each hold a live bell and the app still loads notes", async ({ browser }) => {
  test.setTimeout(240_000);
  const alice = await createAccount(browser, "alice");
  const bob = await createAccount(browser, "bob");
  const a = await openAs(browser, alice, { viewport: DESKTOP });
  const b = await openAs(browser, bob, { viewport: DESKTOP });
  try {
    const title = `E2E tabs ${RUN}`;
    const note = await apiCreateNote(a.page, title, "Tabs.");
    const aliceHandle = note.path.split("/")[2]!;
    await share(a.page, note.id, bob.email);

    const tabs: Page[] = [a.page];
    for (let i = 1; i < 7; i++) tabs.push(await a.context.newPage());
    for (const tab of tabs) {
      await tab.goto("/");
      await expect(bell(tab)).toBeVisible({ timeout: 20_000 });
    }

    await comment(b.page, note.id, `@${aliceHandle} to every tab ${RUN}`);
    for (const tab of tabs) await expect(badge(tab)).toHaveText("1", LIVE);

    // Every tab already holds a connection: a note still opens in the last one.
    const last = tabs[6]!;
    await last.goto(note.path);
    await waitForNoteTitle(last, title);
  } finally {
    await a.context.close();
    await b.context.close();
  }
});
