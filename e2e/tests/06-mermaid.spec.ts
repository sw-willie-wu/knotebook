import { test, expect, type Page } from "@playwright/test";
import { ADMIN, createNote, editorLocator, loginAs } from "./helpers.js";

/**
 * issue #94：mermaid 圖表 block 的端到端覆蓋。
 *
 * 這支存在的理由是**單元測試在結構上測不到的那幾件事**：
 * 1. mermaid 本體在 jsdom 跑不起來（`render()` 要往 body 插隱藏 div 做文字量測，
 *    jsdom 沒有 layout／`getBBox`），所以單元測試一律把它 mock 掉——「圖到底畫不畫得出來」
 *    只有這裡驗得到。
 * 2. lazy chunk 真的載得進來（`import("mermaid")` 在正式 build 下切成獨立 chunk）。
 * 3. **貼上轉換**：```mermaid 的純文字貼上會不會變成圖。開發期用合成 `ClipboardEvent`
 *    驗過但不穩定（游標落點不同結果就不同），只有真瀏覽器＋真剪貼簿算數。
 */

const DIAGRAM_SOURCE = "graph TD\n    A[Start] --> B[End]";
const PASTED_SOURCE = "```mermaid\ngraph LR\n    P[Pasted] --> Q[Diagram]\n```\n";

/** 只用來觀察「有沒有發出請求」的哨兵主機；`.invalid` 是保留 TLD，永遠解析不到。 */
const BEACON_HOST = "beacon.invalid";
/** 兩條 directive 攻擊面（themeCSS 的 CSS 資源、htmlLabels 打開後的 <img srcset>）寫在同一張圖裡。 */
const BEACON_DIAGRAM = [
  `%%{init: {"themeCSS": "* { background: url(http://${BEACON_HOST}/css.png) }", "htmlLabels": true}}%%`,
  "graph TD",
  `    A["Start<img src='#' srcset='http://${BEACON_HOST}/label.png 1x'>"] --> B[End]`,
].join("\n");
/** 目前筆記裡第一個 mermaid 圖的 svg。mermaid 產出的 svg 帶 `aria-roledescription`。 */
function diagramLocator(page: Page) {
  return editorLocator(page).locator("svg[aria-roledescription]").first();
}

test.describe.configure({ mode: "serial" });

test("/diagram 插入 → 輸入原始碼 → 畫出圖 → 編輯鈕進原始碼、Esc 回到圖", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.newPassword);
  await createNote(page, `E2E mermaid ${Date.now()}`);

  const editor = editorLocator(page);
  await editor.click();

  // slash 選單（我們接管的那個：內建項全數保留＋「Diagram」）。
  await editor.pressSequentially("/diagram");
  await page.getByText("Flowcharts and diagrams with Mermaid").click();

  // 空 block 的提示（`note.mermaid.empty`）＋ 尚未有圖。
  await expect(page.getByText("Click to add diagram source")).toBeVisible();
  await expect(diagramLocator(page)).toHaveCount(0);

  // 點一下進編輯態，填原始碼，Esc 提交。
  await page.getByRole("button", { name: "Edit diagram source" }).click();
  const source = page.getByRole("textbox", { name: "Mermaid source" });
  await source.fill(DIAGRAM_SOURCE);
  await source.press("Escape");

  // ⚠ 這一步是本檔的核心：mermaid chunk 真的被 lazy 載入、且圖真的畫出來了。
  await expect(diagramLocator(page)).toBeVisible({ timeout: 20_000 });
  await expect(diagramLocator(page)).toContainText("Start");

  // 錯誤態不得外洩：mermaid 在 parse 失敗時會把一張「Syntax error in text」的圖注入
  // `document.body`（開發期實測），`lib/mermaid.ts` 以「先 parse 再 render」擋掉。
  // 這裡順帶確認正常路徑下畫面上沒有那個字樣。
  await expect(page.getByText("Syntax error in text")).toHaveCount(0);

  // 工具列的「編輯」鈕：進原始碼的第二個入口（第一個是直接點圖）。
  // ⚠ **出路必須永遠在**。第一版把 block 換成 BlockNote 的 codeBlock，換過去就再也
  // 回不來（使用者實測第一件事就撞到）——這條是那個死路的迴歸守門，出路是 Esc。
  // `exact` 不可省：Playwright 的 name 預設是子字串比對，"Edit" 會同時命中點圖區的
  // "Edit diagram source"。
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Mermaid source" })).toHaveValue(DIAGRAM_SOURCE);
  await expect(diagramLocator(page)).toHaveCount(0);

  await page.getByRole("textbox", { name: "Mermaid source" }).press("Escape");
  await expect(diagramLocator(page)).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Mermaid source" })).toHaveCount(0);
});

test("語法錯誤：顯示錯誤訊息與原始碼，且不注入 mermaid 自己的錯誤圖", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.newPassword);
  await createNote(page, `E2E mermaid error ${Date.now()}`);

  const editor = editorLocator(page);
  await editor.click();
  await editor.pressSequentially("/diagram");
  await page.getByText("Flowcharts and diagrams with Mermaid").click();

  await page.getByRole("button", { name: "Edit diagram source" }).click();
  const source = page.getByRole("textbox", { name: "Mermaid source" });
  await source.fill("graph TD\n    A --> ((((");
  await source.press("Escape");

  // 我們自己的錯誤態：訊息 ＋ **可讀的原始碼**（沒有原始碼使用者就改不回來）。
  // ⚠ 斷言必須鎖到 `<pre>`：mermaid 的錯誤訊息**本身也會回述原始碼**，用純文字選擇器
  // 會同時命中 `role="alert"` 的訊息與 `<pre>`，撞上 Playwright 的 strict mode
  // （第一次跑就是這樣紅的——產品是對的，選擇器不夠精確）。
  await expect(page.getByRole("alert")).toContainText("Diagram error");
  await expect(editor.locator("pre")).toContainText("A --> ((((");

  // ⚠ 迴歸守門：mermaid 的炸彈錯誤圖**不得**出現在頁面任何角落。
  // 它是 `render()` 拋錯路徑注入 body 的，逃得出元件邊界；`lib/mermaid.ts` 先 parse 再
  // render 就是為了擋這個。這條紅了代表那個順序被調換了。
  await expect(page.getByText("Syntax error in text")).toHaveCount(0);
});

test("貼上 ```mermaid 純文字 → 自動變成圖", async ({ page, context }) => {
  // 真剪貼簿需要權限；`clipboard-read` 給 `navigator.clipboard` 用，貼上本身是
  // 鍵盤事件走瀏覽器原生路徑（跟使用者實際操作同一條）。
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://localhost:3100" });

  await loginAs(page, ADMIN.email, ADMIN.newPassword);
  await createNote(page, `E2E mermaid paste ${Date.now()}`);

  const editor = editorLocator(page);
  await editor.click();

  await page.evaluate((text) => navigator.clipboard.writeText(text), PASTED_SOURCE);
  await page.keyboard.press("ControlOrMeta+v");

  // `collab/mermaid-paste.ts`：貼上產生的是 `codeBlock{language:"mermaid"}`，
  // 由我們在**貼上完成後**轉成 mermaid block（且只轉這次新插入的）。
  await expect(diagramLocator(page)).toBeVisible({ timeout: 20_000 });
  await expect(diagramLocator(page)).toContainText("Pasted");
  await expect(editor.locator("pre code")).toHaveCount(0);
});

test("貼上帶 text/html 的 ```mermaid（從 GitHub README／AI 對話複製的形狀）→ 自動變成圖", async ({ page, context }) => {
  // 為什麼要有這一條：`docs/diagrams.md` 主打的情境是「從 AI 對話或 GitHub README 複製」，
  // 那種剪貼簿**同時帶 text/plain 與 text/html**，走的是 `collab/paste.ts` 的**預設 handler**
  // 出口（`decideMarkdownPaste` 回 null），跟上面那條純文字走的是不同分支。單元測試用假的
  // `defaultPasteHandler` 只能驗接線，真剪貼簿的形狀只有這裡驗得到（第 2 輪審查 N-11）。
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://localhost:3100" });

  await loginAs(page, ADMIN.email, ADMIN.newPassword);
  await createNote(page, `E2E mermaid html paste ${Date.now()}`);

  const editor = editorLocator(page);
  await editor.click();

  await page.evaluate(
    async ({ html, text }) => {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([text], { type: "text/plain" }),
        }),
      ]);
    },
    { html: '<pre><code class="language-mermaid">graph LR\n    H[Html] --&gt; P[Paste]</code></pre>', text: "graph LR\n    H[Html] --> P[Paste]" },
  );
  await page.keyboard.press("ControlOrMeta+v");

  await expect(diagramLocator(page)).toBeVisible({ timeout: 20_000 });
  await expect(diagramLocator(page)).toContainText("Html");
  await expect(editor.locator("pre code")).toHaveCount(0);
});

test("圖表的 init directive 不能讓瀏覽器對外部主機發請求", async ({ page }) => {
  // ⚠ 這條**只有真瀏覽器驗得到**，而且是三輪審查裡最重要的一條（第 3 輪 I-A／I-B）：
  // `mermaid.render()` 會把圖（含 `<style>`）插進活的 document 做文字量測，瀏覽器當場
  // 套用 CSS 並發出請求——輸出端再怎麼清洗都**來不及**（審查者實測：渲染後完全不把 SVG
  // 插進頁面，themeCSS 裡的 url() 照樣命中）。擋得住的是 `lib/mermaid.ts` 的 `secure`
  // 鎖定清單：themeCSS／htmlLabels／flowchart 不接受圖裡的 directive 覆寫。
  const requested: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes(BEACON_HOST)) requested.push(request.url());
  });

  await loginAs(page, ADMIN.email, ADMIN.newPassword);
  await createNote(page, `E2E mermaid beacon ${Date.now()}`);

  const editor = editorLocator(page);
  await editor.click();
  await editor.pressSequentially("/diagram");
  await page.getByText("Flowcharts and diagrams with Mermaid").click();

  await page.getByRole("button", { name: "Edit diagram source" }).click();
  const source = page.getByRole("textbox", { name: "Mermaid source" });
  await source.fill(BEACON_DIAGRAM);
  await source.press("Escape");

  // 圖照樣要畫得出來（directive 被忽略，不是整張圖失敗）。
  await expect(diagramLocator(page)).toBeVisible({ timeout: 20_000 });
  await expect(diagramLocator(page)).toContainText("Start");

  expect(requested, `不該對 ${BEACON_HOST} 發任何請求`).toEqual([]);
});
