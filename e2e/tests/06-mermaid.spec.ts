import { test, expect, type Locator, type Page } from "@playwright/test";
import { E2E_ORIGIN } from "../ports.js";
import { ADMIN, createNote, editorLocator, loginAs, waitForEditorSelection } from "./helpers.js";

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
/**
 * 三條 directive 攻擊面寫在同一張圖裡：themeCSS 的 CSS 資源、htmlLabels 打開後的
 * `<img srcset>`、以及 `fontFamily` 夾帶宣告（實測 fontFamily 那條會連外）。
 */
const BEACON_DIAGRAM = [
  `%%{init: {"themeCSS": "* { background: url(http://${BEACON_HOST}/css.png) }", "htmlLabels": true, "fontFamily": "monospace; background-image: url(http://${BEACON_HOST}/ff.png)"}}%%`,
  "graph TD",
  `    A["Start<img src='#' srcset='http://${BEACON_HOST}/label.png 1x'>"] --> B[End]`,
].join("\n");
/** 目前筆記裡第一個 mermaid 圖的 svg。mermaid 產出的 svg 帶 `aria-roledescription`。 */
function diagramLocator(page: Page) {
  return editorLocator(page).locator("svg[aria-roledescription]").first();
}

test.describe.configure({ mode: "serial" });

test("/diagram 插入 → 輸入原始碼 → 畫出圖 → 編輯鈕進原始碼、Esc 回到圖", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.password);
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
  // `document.body`（開發期實測），`lib/mermaid.ts` 以 `suppressErrorRendering: true` 擋掉。
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
  await loginAs(page, ADMIN.email, ADMIN.password);
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
  // 它是 `render()` 拋錯路徑注入 body 的，逃得出元件邊界；`lib/mermaid.ts` 靠
  // `suppressErrorRendering: true` 讓 render 拋錯前先清掉暫時容器（#344 起不再先 parse）。
  // 這條紅了代表那個設定被拿掉了。
  await expectNoMermaidLeftovers(page);

  // 再錯一次（重繪不得一次多一張）。
  await page.getByRole("button", { name: "Edit diagram source" }).click();
  await page.getByRole("textbox", { name: "Mermaid source" }).fill("graph TD\n    B --> ))))");
  await page.getByRole("textbox", { name: "Mermaid source" }).press("Escape");
  await expect(editor.locator("pre")).toContainText("B --> ))))");
  await expectNoMermaidLeftovers(page);
});

/**
 * mermaid 在 body 留下的東西：錯誤圖（文字「Syntax error in text」、`aria-roledescription="error"`）、
 * 它做文字量測用的暫時容器 `#d<id>`（`dmermaid-N`），以及任何不在編輯器裡的 mermaid svg。
 */
async function expectNoMermaidLeftovers(page: Page): Promise<void> {
  await expect(page.getByText("Syntax error in text")).toHaveCount(0);
  await expect(page.locator('svg[aria-roledescription="error"]')).toHaveCount(0);
  await expect(page.locator('[id^="dmermaid-"]')).toHaveCount(0);
  const stray = await page.evaluate(
    () => Array.from(document.querySelectorAll("svg[aria-roledescription]")).filter((svg) => svg.closest('[data-testid="note-editor"]') === null).length,
  );
  expect(stray, "編輯器外不得有 mermaid 的 svg").toBe(0);
}

async function pasteMarkdown(page: Page, markdown: string): Promise<void> {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: E2E_ORIGIN });
  const editor = editorLocator(page);
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await waitForEditorSelection(page);
  await page.evaluate((text) => navigator.clipboard.writeText(text), markdown);
  await page.keyboard.press("ControlOrMeta+v");
}

/**
 * 目標頂端距「筆記捲動容器可見框底緣」多遠（筆記頁捲的是內層容器，不是視窗）。正值＝在底緣下方。
 * 從編輯器外面找起：並排欄 `.bn-block-column` 的 computed overflowY 也是 auto，但它不是捲動容器。
 */
async function gapBelowFold(target: Locator): Promise<number> {
  return target.evaluate((el) => {
    let scroller = el.closest(".bn-editor")?.parentElement ?? el.parentElement;
    while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const bottom = scroller ? scroller.getBoundingClientRect().bottom : window.innerHeight;
    return el.getBoundingClientRect().top - bottom;
  });
}

test("#344 長筆記：視窗附近（600px 內）的圖不必捲就先畫；更遠的捲到之前不畫（顯示佔位），捲到後畫出來", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E mermaid lazy ${Date.now()}`);
  const filler = (from: number, n: number) => Array.from({ length: n }, (_, i) => `Filler paragraph ${from + i}\n`);
  await pasteMarkdown(
    page,
    [
      "```mermaid", "graph TD\n    T1[TopNode] --> T2[TopEnd]", "```", "",
      ...filler(0, 25),
      "```mermaid", "graph TD\n    N1[NearNode] --> N2[NearEnd]", "```", "",
      ...filler(25, 60),
      "```mermaid", "graph TD\n    F1[FarAwayNode] --> F2[FarEnd]", "```", "",
    ].join("\n"),
  );

  const blocks = page.locator('[data-content-type="mermaid"]');
  await expect(blocks).toHaveCount(3, { timeout: 15_000 });
  await expect(editorLocator(page).getByText("Filler paragraph 84")).toBeVisible();
  // 等存檔落地後重開：貼上後游標在底部、底部那張已經在視窗裡畫過了，要看的是「開筆記」的情境。
  await page.waitForTimeout(1500);
  await page.reload();

  const top = blocks.first().locator("svg[aria-roledescription]");
  const near = blocks.nth(1);
  const far = blocks.nth(2);
  await expect(top).toBeVisible({ timeout: 20_000 });
  await expect(top).toContainText("TopNode");

  // 中間那張：在可見框底緣下方、但在 600px 預先範圍內——不捲動也要畫出來
  // （守 `MermaidView` 的 `root` 用捲動容器：用預設的視窗當 root 時 rootMargin 不生效，這張會一直是佔位）。
  const nearGap = await gapBelowFold(near);
  expect(nearGap, "前提：中間那張在可見框之外").toBeGreaterThan(0);
  expect(nearGap, "前提：中間那張在 600px 預先範圍內").toBeLessThan(500);
  await expect(near.locator("svg[aria-roledescription]")).toHaveCount(1, { timeout: 20_000 });
  await expect(near.locator("svg[aria-roledescription]")).toContainText("NearNode");

  // 最底那張在預先範圍之外：再給一段時間，仍不得被畫（只有佔位）。
  expect(await gapBelowFold(far), "前提：最底那張在可見框下方 600px 以外").toBeGreaterThan(600);
  await page.waitForTimeout(1500);
  await expect(far.locator("svg[aria-roledescription]")).toHaveCount(0);
  await expect(far.getByText("Rendering diagram…")).toBeAttached();

  await far.scrollIntoViewIfNeeded();
  await expect(far.locator("svg[aria-roledescription]")).toBeVisible({ timeout: 20_000 });
  await expect(far.locator("svg[aria-roledescription]")).toContainText("FarAwayNode");
  await expect(far.getByText("Rendering diagram…")).toHaveCount(0);
});

test("#344 並排欄裡的遠處圖：一樣捲到之前不畫（欄的 overflow-x:auto 不得被當成捲動根）", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E mermaid lazy columns ${Date.now()}`);
  const filler = (from: number, n: number) => Array.from({ length: n }, (_, i) => `Column filler ${from + i}\n`);
  // 34-columns 的正規形：右欄一長串文字後面才是圖。
  const column = (body: string) => ['<div data-kb-column style="flex:1">', "", body, "", "</div>"];
  await pasteMarkdown(
    page,
    [
      "```mermaid", "graph TD\n    T1[TopNode] --> T2[TopEnd]", "```", "",
      '<div data-kb-columns style="display:flex;gap:16px">',
      ...column("Left column"),
      ...column([...filler(0, 70), "```mermaid", "graph TD\n    C1[ColumnFarNode] --> C2[ColumnFarEnd]", "```"].join("\n")),
      "</div>",
      "",
    ].join("\n"),
  );

  const blocks = page.locator('[data-content-type="mermaid"]');
  await expect(blocks).toHaveCount(2, { timeout: 15_000 });
  const far = blocks.nth(1);
  // 前提：那張圖真的在欄裡。
  expect(await far.evaluate((el) => el.closest(".bn-block-column") !== null), "前提：第二張圖在並排欄裡").toBe(true);
  await page.waitForTimeout(1500);
  await page.reload();

  await expect(blocks.first().locator("svg[aria-roledescription]")).toBeVisible({ timeout: 20_000 });
  expect(await gapBelowFold(far), "前提：欄裡那張在可見框下方 600px 以外").toBeGreaterThan(600);
  await page.waitForTimeout(1500);
  await expect(far.locator("svg[aria-roledescription]"), "欄裡的遠處圖不得先畫").toHaveCount(0);

  await far.scrollIntoViewIfNeeded();
  await expect(far.locator("svg[aria-roledescription]")).toContainText("ColumnFarNode", { timeout: 20_000 });
});

test("#344 同一頁兩張相同原始碼的圖：都畫得出來、id 不衝突、箭頭與樣式指向自己那張", async ({ page }) => {
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E mermaid twins ${Date.now()}`);
  const twin = ["```mermaid", "graph LR\n    A[TwinStart] --> B[TwinEnd]", "```", ""].join("\n");
  await pasteMarkdown(page, [twin, "between", "", twin].join("\n"));

  const svgs = editorLocator(page).locator("svg[aria-roledescription]");
  await expect(svgs).toHaveCount(2, { timeout: 20_000 });
  await expect(svgs.nth(0)).toContainText("TwinStart");
  await expect(svgs.nth(1)).toContainText("TwinStart");

  // 開筆記（第二張走快取命中＋改寫 id 的路徑）與切走再回來（兩張都走快取）各驗一次。
  for (const step of ["reload", "spa-return"] as const) {
    if (step === "reload") {
      await page.waitForTimeout(1500);
      await page.reload();
    } else {
      await page.evaluate(() => {
        history.pushState(null, "", "/");
        window.dispatchEvent(new PopStateEvent("popstate"));
      });
      await expect(page.locator('[data-content-type="mermaid"]')).toHaveCount(0, { timeout: 15_000 });
      await page.goBack();
    }
    await expect(svgs).toHaveCount(2, { timeout: 20_000 });
    await expect(svgs.nth(1)).toContainText("TwinEnd");

    const report = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll('[data-testid="note-editor"] svg[aria-roledescription]')) as SVGSVGElement[];
      // 只看帶 `mermaid-N` 前綴的 id（`rewriteMermaidId` 負責的那一類）。flowchart 沒有別種 id；sankey／sequence／
      // architecture 另有 mermaid 全域計數器產生、不帶前綴的 id，快取副本裡會重複——已知殘留，見 `lib/mermaid.ts`。
      const ids = Array.from(document.querySelectorAll("[id]"), (el) => el.id).filter((id) => /mermaid-\d/.test(id));
      return {
        rootIds: all.map((svg) => svg.id),
        duplicateIds: ids.filter((id, i) => ids.indexOf(id) !== i),
        perSvg: all.map((svg) => {
          const refs = Array.from(svg.querySelectorAll("[marker-end], [marker-start]")).flatMap((el) =>
            ["marker-end", "marker-start"].map((a) => el.getAttribute(a)).filter((v): v is string => v !== null && v.startsWith("url(")),
          );
          const targets = refs.map((ref) => /url\(#([^)]+)\)/.exec(ref)?.[1] ?? "");
          const style = svg.querySelector("style")?.textContent ?? "";
          const rect = svg.querySelector(".node rect, .node polygon, .node path");
          return {
            markerRefs: targets.length,
            markersInOwnSvg: targets.every((id) => id !== "" && svg.querySelector(`[id="${id}"]`) !== null),
            styleScopedToSelf: style.includes(`#${svg.id}`),
            nodeFill: rect ? getComputedStyle(rect).fill : null,
          };
        }),
      };
    });
    expect(new Set(report.rootIds).size, `${step}：兩張的根 id 要不同 ${JSON.stringify(report.rootIds)}`).toBe(2);
    expect(report.duplicateIds, `${step}：頁面上不得有重複的 mermaid id`).toEqual([]);
    for (const svg of report.perSvg) {
      expect(svg.markerRefs, `${step}：每張圖都有箭頭`).toBeGreaterThan(0);
      expect(svg.markersInOwnSvg, `${step}：箭頭 marker 要指向自己那張圖裡的元素`).toBe(true);
      expect(svg.styleScopedToSelf, `${step}：樣式選擇器要指向自己那張圖`).toBe(true);
    }
    // 兩張的節點樣式一致（都吃到了自己那份 style），且不是沒套樣式的預設黑。
    expect(report.perSvg[0]!.nodeFill).toBe(report.perSvg[1]!.nodeFill);
    expect(report.perSvg[0]!.nodeFill).not.toBe("rgb(0, 0, 0)");
  }
});

test("貼上 ```mermaid 純文字 → 自動變成圖", async ({ page, context }) => {
  // 真剪貼簿需要權限；`clipboard-read` 給 `navigator.clipboard` 用，貼上本身是
  // 鍵盤事件走瀏覽器原生路徑（跟使用者實際操作同一條）。
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: E2E_ORIGIN });

  await loginAs(page, ADMIN.email, ADMIN.password);
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
  // `defaultPasteHandler` 只能驗接線，真剪貼簿的形狀只有這裡驗得到。
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: E2E_ORIGIN });

  await loginAs(page, ADMIN.email, ADMIN.password);
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
  // ⚠ 這條**只有真瀏覽器驗得到**，而且是其中最重要的一條：
  // `mermaid.render()` 會把圖（含 `<style>`）插進活的 document 做文字量測，瀏覽器當場
  // 套用 CSS 並發出請求——輸出端再怎麼清洗都**來不及**（實測：渲染後完全不把 SVG
  // 插進頁面，themeCSS 裡的 url() 照樣命中）。擋得住的是 `lib/mermaid.ts` 的 `secure`
  // 鎖定清單：themeCSS／htmlLabels／flowchart 不接受圖裡的 directive 覆寫。
  const requested: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes(BEACON_HOST)) requested.push(request.url());
  });

  await loginAs(page, ADMIN.email, ADMIN.password);
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

test("合法的多行 label 照常畫出來（不得被圖片守衛誤擋）", async ({ page }) => {
  // mermaid 的 lexer 會把雙引號字串裡的換行轉成 `<br/>`，所以這是**合法**語法。
  // 前一版在 render 之前解析原始碼的預檢會把它誤判成「解不出來」而擋掉，並且顯示
  // 「這張圖引用了外部圖片」——一張根本沒有 img 的圖。改成攔
  // `new Image()` 之後，判斷只看實際要發出去的 URL，這一類誤擋整個消失。
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E mermaid multiline label ${Date.now()}`);

  const editor = editorLocator(page);
  await editor.click();
  await editor.pressSequentially("/diagram");
  await page.getByText("Flowcharts and diagrams with Mermaid").click();

  await page.getByRole("button", { name: "Edit diagram source" }).click();
  const source = page.getByRole("textbox", { name: "Mermaid source" });
  await source.fill('graph TD\n    A@{ shape: rect, label: "line one\n    line two" } --> B[End]');
  await source.press("Escape");

  await expect(diagramLocator(page)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("click X href 的圖照常畫出來，連結保留", async ({ page }) => {
  // 曾經有一版把 SVG `<a href>` 當成外部資源擋掉，於是任何有 `click X href`
  // 的圖**整張畫不出來**、還顯示一段對不上的錯誤訊息。從 GitHub README 貼進來的圖很常
  // 帶這一行，這條守著它。
  await loginAs(page, ADMIN.email, ADMIN.password);
  await createNote(page, `E2E mermaid click href ${Date.now()}`);

  const editor = editorLocator(page);
  await editor.click();
  await editor.pressSequentially("/diagram");
  await page.getByText("Flowcharts and diagrams with Mermaid").click();

  await page.getByRole("button", { name: "Edit diagram source" }).click();
  const source = page.getByRole("textbox", { name: "Mermaid source" });
  await source.fill('graph TD\n    A[Start] --> B[End]\n    click A href \"https://example.com/page\"');
  await source.press("Escape");

  await expect(diagramLocator(page)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(diagramLocator(page).locator('a[*|href="https://example.com/page"]')).toHaveCount(1);
});
