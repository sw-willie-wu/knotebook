import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { ADMIN, loginAs } from "./helpers.js";

test("PAT：設定頁建立 → 無 cookie 的 Bearer 請求可用 → PATCH 改 scope 後 tools/list 跟著變（#239）→ 撤銷後立即 401", async ({
  page,
  browser,
  baseURL,
}) => {
  await loginAs(page, ADMIN.email, ADMIN.password);

  // §14.5 隨機化：多 spec 共用一座疊、失敗時刻意不 down，固定名稱在重跑時會在
  // filter({ hasText }) 撞出 strict mode violation，把真正的回歸訊息蓋掉。
  const tokenName = `E2E script ${Date.now()}`;

  await page.goto("/settings/account");
  await page.getByRole("button", { name: "Create API token" }).click();
  // ⚠ `getByLabel` 預設是「不分大小寫的子字串比對」，而同頁 HandleSection 的
  // aria-label 是 "Username"——不加 exact 會同時命中兩個元素，strict mode violation。
  await page.getByLabel("Name", { exact: true }).fill(tokenName);
  // #239：存取權改成兩個勾選框（預設都不勾）；勾「編輯」＝notes:read notes:write。
  await page.getByRole("checkbox", { name: "Create and edit notes" }).click();
  await page.getByRole("button", { name: "Create token" }).click();

  // 明文只出現這一次，用它自己的 aria-label 讀出來（不要用模糊比對）
  const tokenField = page.getByLabel("New API token", { exact: true });
  await expect(tokenField).toBeVisible();
  const token = await tokenField.inputValue();
  expect(token).toMatch(/^knb_/);
  await page.getByRole("button", { name: "Done" }).click();

  // **無 cookie 的 context**——用瀏覽器 context 會因為 session cookie 而 200，
  // 那樣這一發對 Bearer 完全沒有鑑別力。try/finally 比照 02：斷言失敗時仍要釋放，
  // 否則失敗案例會在同一個 worker 累積殘留 context。
  const anonymous = await browser.newContext();
  try {
    const api = anonymous.request;
    const ok = await api.get(`${baseURL}/api/notes`, { headers: { Authorization: `Bearer ${token}` } });
    expect(ok.status()).toBe(200);
    // 同一支 token 也建得了筆記（勾的是 Create and edit notes＝notes:read notes:write）
    const created = await api.post(`${baseURL}/api/notes`, {
      headers: { Authorization: `Bearer ${token}` },
      data: { title: "E2E via token" },
    });
    expect(created.status()).toBe(201);

    // #239：PATCH /api/auth/tokens/:id 改 scope → 同一支 token 的 tools/list 下一個請求就跟著變。
    // W11：設定頁沒有改權限的 UI——用 page.request（與頁面共用 session cookie）直接打 cookie-only 的 PATCH。
    // ⚠ 刻意沿用這支 PAT、不另建：`PAT_CREATE_LIMIT`（`http/rate-limit.ts`）是每人每小時 10 支、存在 server
    //   行程記憶體，e2e 全用 ADMIN；髒疊重跑時映像沒變，`stack:up` 的 `up --build` 不會重建容器、計數還在——每輪多建一支，連跑幾輪就會撞 429 假紅
    //   （本檔與 13 號每輪各建一支，與 #239 之前相同）。
    const listed = await page.request.get("/api/auth/tokens");
    expect(listed.status()).toBe(200);
    const { tokens } = (await listed.json()) as { tokens: { id: string; name: string; scope: string }[] };
    const mine = tokens.find(t => t.name === tokenName);
    expect(mine?.scope).toBe("notes:read notes:write");
    const id = mine!.id;
    const toolNames = async (): Promise<string[]> => {
      const res = await api.post(`${baseURL}/api/mcp`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
        },
        data: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      });
      expect(res.status()).toBe(200);
      const body = (await res.json()) as { result: { tools: { name: string }[] } };
      return body.result.tools.map(t => t.name);
    };
    const setScope = async (scope: string): Promise<void> => {
      const res = await page.request.patch(`/api/auth/tokens/${id}`, { data: { scope } });
      expect(res.status()).toBe(200);
      expect(((await res.json()) as { scope: string }).scope).toBe(scope);
    };
    const before = await toolNames();
    // 對照：讀寫憑證確實列得到寫入工具，`move_note_to_group` 不在是因為少了 notes:move。
    expect(before).toContain("copy_note");
    expect(before).not.toContain("move_note_to_group");
    await setScope("notes:read notes:write notes:move");
    expect(await toolNames()).toContain("move_note_to_group");
    await setScope("notes:read notes:write");
    expect(await toolNames()).not.toContain("move_note_to_group");

    // 撤銷——鎖定這一輪建的那一列（名稱已隨機化，前一輪殘留不會同名）
    const row = page.getByRole("listitem").filter({ hasText: tokenName });
    await row.getByRole("button", { name: "Revoke", exact: true }).click();
    await page.getByRole("button", { name: "Revoke token" }).click();
    // 斷言「剛建的那筆消失」而不是「列表全空」——多 spec 共用一座疊，admin 帳號
    // 可能有前一輪殘留的 token（髒疊重跑時「全空」會假紅）。
    await expect(page.getByText(tokenName)).toHaveCount(0);

    const revoked = await api.get(`${baseURL}/api/notes`, { headers: { Authorization: `Bearer ${token}` } });
    expect(revoked.status()).toBe(401);
    // 「憑證無效」與「未帶憑證」是兩條不同的 challenge（RFC 6750 §3 vs §3.1），一起釘住
    expect(revoked.headers()["www-authenticate"]).toContain('error="invalid_token"');
    expect(revoked.headers()["www-authenticate"]).toContain("resource_metadata=");
  } finally {
    await anonymous.close();
    // 撤銷不依賴上面的斷言成功：中途紅了也要撤，否則髒疊重跑會累積憑證（每人上限 20）。
    // 正常路徑已經在上面經 UI 撤銷，這裡查不到就不動；清理本身失敗不得蓋掉原本的錯誤。
    try {
      const listed = (await (await page.request.get("/api/auth/tokens")).json()) as { tokens: { id: string; name: string }[] };
      const left = listed.tokens.find(t => t.name === tokenName);
      if (left) await page.request.delete(`/api/auth/tokens/${left.id}`);
    } catch {
      // 忽略：清理盡力而為。
    }
  }
});

test("OAuth：未登入開 authorize → 登入 → 同意 → 本機 callback 收到 code → 換發 token 可用", async ({
  page,
  browser,
  baseURL,
}) => {
  // 測試程式扮演 MCP client：本機 callback server 收 code。Playwright 與 chromium 都在
  // WSL 主機同一個 network namespace，loopback 直達。
  const received: URLSearchParams[] = [];
  // 只收 `/cb`：瀏覽器在 callback 頁可能另抓 `/favicon.ico` 之類，混進來會讓 `received[n]` 錯位。
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/cb") received.push(url.searchParams);
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("ok");
  });

  try {
    // listen(0)：chromium 封鎖 port 1 之類的低位埠，一律讓 OS 給隨機埠。
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const redirectUri = `http://127.0.0.1:${port}/cb`;

    const anonymous = await browser.newContext();
    const api = anonymous.request;
    try {
      const registered = await api.post(`${baseURL}/oauth/register`, {
        data: { client_name: `E2E client ${Date.now()}`, redirect_uris: [redirectUri] },
      });
      expect(registered.status()).toBe(201);
      const { client_id: clientId } = await registered.json();

      const verifier = randomBytes(32).toString("base64url");
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const state = `st-${Date.now()}`;
      // #239：要求三個 scope（MCP 的 challenge 就是這三個），同意頁才會出現兩個勾選框。
      const authorizeUrlFor = (s: string): string =>
        `${baseURL}/oauth/authorize?${new URLSearchParams({
          response_type: "code",
          client_id: clientId,
          redirect_uri: redirectUri,
          code_challenge: challenge,
          code_challenge_method: "S256",
          resource: `${baseURL}/api/mcp`,
          scope: "notes:read notes:write notes:move",
          state: s,
        }).toString()}`;
      const authorizeUrl = authorizeUrlFor(state);

      // **未登入**進來：#131 的 return-to 應該把我們送到登入頁再送回同意頁。
      // ⚠ 不能用 `loginAs`——它第一行就 `page.goto("/login")`，會把 `?next=` 沖掉，
      // 然後登入完落在 `/`。要在**這一頁原地**填表送出。
      await page.goto(authorizeUrl);
      await expect(page).toHaveURL(/\/login\?next=/);
      await page.locator("#login-email").fill(ADMIN.email);
      await page.locator("#login-password").fill(ADMIN.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page).toHaveURL(/\/authorize\?req=/);

      await expect(page.getByText(`127.0.0.1:${port}`)).toBeVisible();
      // #239 W4'：第一次授權兩框預設都不勾——直接按 Allow 只拿到 notes:read。勾「編輯」再 Allow。
      const edit = page.getByRole("checkbox", { name: "Create and edit notes" });
      const move = page.getByRole("checkbox", { name: "Move or copy notes into groups" });
      await expect(edit).not.toBeChecked();
      await expect(move).not.toBeChecked();
      await edit.click();
      await page.getByRole("button", { name: "Allow" }).click();

      await expect.poll(() => received.length).toBeGreaterThan(0);
      const callback = received[0]!;
      expect(callback.get("state")).toBe(state);
      expect(callback.get("iss")).toBe(baseURL);
      expect(callback.get("error")).toBeNull();
      const code = callback.get("code")!;
      expect(code).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const tokenRes = await api.post(`${baseURL}/oauth/token`, {
        form: {
          grant_type: "authorization_code",
          code,
          code_verifier: verifier,
          client_id: clientId,
          redirect_uri: redirectUri,
          resource: `${baseURL}/api/mcp`,
        },
      });
      expect(tokenRes.status()).toBe(200);
      const tokenBody = await tokenRes.json();
      expect(tokenBody.scope).toBe("notes:read notes:write");
      const token = tokenBody.access_token as string;

      const notes = await api.get(`${baseURL}/api/notes`, { headers: { Authorization: `Bearer ${token}` } });
      expect(notes.status()).toBe(200);

      // 同一份清單看得到這個 App 列（名稱是 client 自述、標成 App）
      await page.goto("/settings/account");
      await expect(page.getByRole("listitem").filter({ hasText: `E2E client` }).first()).toBeVisible();

      // #239 W8：同一個 client 再授權一次——編輯框沿用目前已授予的權限（預設勾）並標「Currently
      // granted」，搬移框仍不勾。按 Deny，不留第二支憑證（舊憑證不受影響：deny 不碰 api_tokens）。
      const state2 = `st2-${Date.now()}`;
      await page.goto(authorizeUrlFor(state2));
      await expect(page).toHaveURL(/\/authorize\?req=/);
      await expect(edit).toBeChecked();
      await expect(move).not.toBeChecked();
      await expect(page.getByText("Currently granted")).toHaveCount(1);
      await page.getByRole("button", { name: "Deny" }).click();
      await expect.poll(() => received.length).toBeGreaterThan(1);
      expect(received[1]!.get("state")).toBe(state2);
      expect(received[1]!.get("error")).toBe("access_denied");
    } finally {
      await anonymous.close();
    }
  } finally {
    // 不關就是 open handle，worker 不會退出。
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
