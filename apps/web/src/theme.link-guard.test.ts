import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 筆記內容裡連結樣式的結構守門（issue #153，比照 `theme.block-selection-guard.test.ts`）。
 *
 * 這一族的失效**全都是靜默的**，jsdom／單元測試／肉眼 review 都看不到：
 * - 少了 `.bn-editor` 祖先錨 ⇒ 選擇器掉回 (0,1,0)，BlockNote 的 CSS 在 NotePage
 *   lazy chunk、載入必晚於 `index.css`，同 specificity 我們必輸。
 * - 顏色寫成 `--primary` ⇒ 這個 repo 的 `--primary` 是**中性高對比**（淺色近黑），
 *   連結看起來跟正文一樣，等於這條 issue 沒修。
 * - 底線被拿掉 ⇒ 連結只靠顏色區分（WCAG 1.4.1）。
 * - 圖示的 `mask-image` 被換成寫死顏色的 `background-image` ⇒ 六個主題色 × 明暗
 *   一共十二種情況裡，圖示與文字顏色就開始各走各的。
 * - **圖示整個不見**：`content: ""` 的 inline-block 沒有 `width`/`height` 就是一個
 *   0×0 的盒子，拿掉 `display: inline-block` 亦然——兩種都不會報錯、也不會讓任何
 *   其他測試變紅（審查實測：刪掉那兩行尺寸，本檔原本 6/6 照綠）。
 * - **`--color-brand` 被宣告在 `:root` 以外**（例如有人在 `.dark` 裡補一行）⇒ 深色
 *   模式下編輯器內的 `.bn-root.dark` 會再次奪回它，主題色又退回 indigo，也就是
 *   靜默復原 #153 繞過的那個 bug。`theme.accent-vars.test.ts` 的 (d) 只要求它在
 *   `@theme inline` 裡出現過，擋不住多一處宣告。
 */

function readIndexCssWithoutComments(): string {
  return readFileSync(`${process.cwd()}/src/index.css`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * 從 `pattern` 命中處起，用花括號配對切出整個區塊的**內容**（比照
 * `theme.scrollbar-guard.test.ts` 的同名 helper）。找不到就回空字串，由呼叫端斷言。
 */
function extractBlock(css: string, pattern: RegExp): string {
  const match = pattern.exec(css);
  if (!match) return "";
  let i = css.indexOf("{", match.index);
  const from = i + 1;
  for (let depth = 1; depth > 0; ) {
    i += 1;
    expect(i, `區塊花括號不配對：${pattern.source}`).toBeLessThan(css.length);
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") depth -= 1;
  }
  return css.slice(from, i);
}

/** `index.css` 裡所有提到 link inline content 型別的規則。 */
function linkRules(): Array<{ selectors: string[]; body: string }> {
  const css = readIndexCssWithoutComments();
  return [...css.matchAll(/([^{}]*data-inline-content-type[^{}]*)\{([^}]*)\}/g)]
    .map((m) => ({
      // ⚠ 逗號清單必拆開逐一判（repo 慣例，見 `theme.scrollbar-guard.test.ts` 的註解）：
      // 整串 `test()` 會被「合法選擇器 ＋ 沒錨點的選擇器併成一條」的形同時騙過。
      selectors: m[1]!
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
      body: m[2]!,
    }))
    .filter((r) => r.selectors.some((s) => /data-inline-content-type\s*=\s*"link"/.test(s)));
}

const baseRule = () => linkRules().filter((r) => r.selectors.every((s) => !s.includes("::after")));
const afterRule = () => linkRules().filter((r) => r.selectors.every((s) => s.includes("::after")));

describe("筆記內連結的樣式（issue #153）", () => {
  it("恰好兩條規則：本體一條、開新分頁圖示（::after）一條，且沒有混合 ::after 與本體的規則", () => {
    // 混合形（`a, a::after { … }`）會讓下面每一條斷言的語意變糊——本體與偽元素該設的
    // 屬性不同集合。先擋掉。
    expect(linkRules(), "index.css 找不到 link inline content 的樣式規則").toHaveLength(2);
    expect(baseRule(), "應有且只有一條連結本體的規則").toHaveLength(1);
    expect(afterRule(), "應有且只有一條 ::after 圖示的規則").toHaveLength(1);
  });

  it("每個選擇器都以 .bn-editor 為錨（specificity 要贏晚載入的 BlockNote CSS）", () => {
    for (const rule of linkRules()) {
      for (const selector of rule.selectors) {
        expect(selector, `少了 .bn-editor 錨點：${selector}`).toMatch(/^\.bn-editor\s/);
      }
    }
  });

  it("用 data-inline-content-type=\"link\" 而不是裸 a（別命中編輯器 chrome 裡的連結）", () => {
    for (const rule of linkRules()) {
      for (const selector of rule.selectors) {
        expect(selector, `選擇器要用 link mark 的 data 屬性：${selector}`).toMatch(
          /\[data-inline-content-type\s*=\s*"link"\]/,
        );
        // 裸 `a` 會一路命中浮層／工具列／自訂 block 裡的 anchor。
        expect(selector, `選擇器不得含裸 a：${selector}`).not.toMatch(/(?:^|[\s>+~])a(?=[\s>+~:.[]|$)/);
      }
    }
  });

  it("本體：主題色 --brand ＋ 實線底線（不得只靠顏色區分連結）", () => {
    const { body } = baseRule()[0]!;
    expect(body, "顏色要走 var(--color-brand)").toContain("var(--color-brand)");
    // `--primary` 在這個 repo 是中性高對比（淺色近黑）——拿它當連結色等於沒改。
    expect(body, "不得用 --color-primary（中性色，看起來跟正文一樣）").not.toContain("var(--color-primary)");
    expect(body, "顏色不得寫字面值（就不跟使用者選的主題色走了）").not.toMatch(/#[0-9a-f]{3,8}|oklch\(|rgb\(/i);
    expect(body, "底線是 WCAG 1.4.1 的載體，不得拿掉").toMatch(/text-decoration(?:-line)?:\s*[^;]*underline/);
    expect(body).not.toMatch(/text-decoration(?:-line)?:\s*none/);
  });

  it("圖示：CSS mask ＋ currentColor（自動跟主題色走），不引入 icon 套件／不寫死顏色", () => {
    const { body } = afterRule()[0]!;
    expect(body, "偽元素要有 content").toMatch(/content:\s*""/);
    expect(body, "圖形走 mask-image ＋ 內嵌 SVG data URI").toMatch(/mask-image:\s*url\("data:image\/svg\+xml,/);
    // 顏色由 background-color 提供、取 currentColor ⇒ 跟著本體那條的 --brand 走，
    // 不必為六色 × 明暗各寫一份 data URI。
    expect(body, "顏色要取 currentColor").toMatch(/background-color:\s*currentColor/);
    // `background-image` 那條路會把顏色編進 SVG，主題一換圖示就對不上。
    expect(body, "不得改用 background-image（顏色會被編進 SVG）").not.toContain("background-image:");
    expect(body, "圖示不得寫字面色").not.toMatch(/(?:background-)?color:\s*(?:#[0-9a-f]{3,8}|oklch\(|rgb\()/i);
    // ⚠ 刻意**不**在這裡釘 `pointer-events: none`：headed 實測（Chrome 152）加與不加，
    // hover／點擊／拖曳選取三者行為完全相同（唯一差異是 `caretRangeFromPoint` 的回傳，
    // 而上游的 `handleClick` 回 true，那個差異在使用者操作上到不了），所以這個 repo 沒有
    // 那條規則，也不該用測試把一個量不到效果的宣稱固定下來。量測明細在 index.css 註解。
  });

  it("圖示要真的畫得出來、也要真的有留白：inline-block ＋ 尺寸與兩側 margin 皆非零", () => {
    const { body } = afterRule()[0]!;
    // `content: ""` 的替代內容是空的，所以盒子大小完全由 width/height 決定——兩者任一
    // 缺席（或被寫成 0）圖示就**完全不見**，而其他每一條斷言都還是綠的（審查實測）。
    expect(body, "圖示盒子要 inline-block（inline 的 width/height 無效）").toMatch(
      /display:\s*inline-block/,
    );
    // 一律判 `parseFloat(…) > 0`：一次關掉 `0`／`0px`／`0.0em`／`-0px`，以及 `auto`／
    // `max-content`／`initial` 這些 `parseFloat` 給 `NaN` 的形（`auto` 在這裡渲染出來與
    // `0.0em` 逐像素相同，是這條真正要擋的東西）。**取最後一個命中**——CSS 取最後一條，
    // 只看第一個的話在區塊尾端補 `width: 0` 就全綠（審查實測）。
    const declaration = (prop: string) =>
      [...body.matchAll(new RegExp(`(?:^|[;{])\\s*${prop}:\\s*([^;]+)`, "g"))].at(-1)?.[1]?.trim();

    // 尺寸與兩側留白都**只擋「缺席或非正值」，不釘具體數值**——值是視覺判斷，釘死只會
    // 在合理微調時製造假紅。
    for (const prop of ["width", "height", "margin-inline-start", "margin-inline-end"] as const) {
      const value = declaration(prop);
      expect(value, `圖示缺 ${prop}`).toBeDefined();
      expect(parseFloat(value!), `圖示的 ${prop} 不是正值：${value}`).toBeGreaterThan(0);
    }
    // 簡寫會整組覆蓋上面那兩個 longhand（尾端補一條 `margin-inline: 0` 即可繞過）。
    expect(body, "這個區塊不得用 margin／margin-inline 簡寫（會覆蓋兩側 longhand）").not.toMatch(
      /(?:^|[;{])\s*margin(?:-inline)?:/,
    );
  });

  it("`--color-brand:` 只准宣告在 `@theme inline` 內——那是深色模式主題色繞法的前提", () => {
    // `.bn-root` 在深色模式下帶著 `dark` class；#154 之前它會命中 `index.css` 的裸 `.dark`
    // 基底塊而把 `--brand` 重設回 indigo（#154 已把基底塊錨到 `:root.dark`，守衛是
    // `theme.accent-vars.test.ts` (h)；這條是第二道防線）。連結與 wikilink 都走 `--color-brand`（只宣告在
    // `@theme inline`，Tailwind 編譯成 `:root,:host` 一處，在那裡算完值再繼承）來繞過
    // 它。⚠ 只要有人在 `.dark`／`[data-accent]`／任何其他
    // 選擇器裡再宣告一次 `--color-brand:`，那個繞法就靜默失效、bug 原樣回來，而
    // `theme.accent-vars.test.ts` 的 (d) 只檢查它在 `@theme inline` 裡出現過，擋不住。
    const css = readIndexCssWithoutComments();
    const themeInline = extractBlock(css, /@theme\s+inline\s*\{/);
    expect(themeInline, "index.css 找不到 @theme inline 區塊").toContain("--color-brand:");

    const outside = css.replace(themeInline, "");
    const offenders = [...outside.matchAll(/([^{}]*)\{([^}]*)\}/g)]
      .filter((m) => /(?:^|[;{])\s*--color-brand:/.test(m[2]!))
      .map((m) => m[1]!.trim());
    expect(
      offenders,
      "`--color-brand:` 只能宣告在 @theme inline 內；多一處宣告就會讓 .bn-root.dark 奪回主題色",
    ).toEqual([]);
  });

  it("圖示只掛在 http(s) 連結上——wikilink 與 mailto:／tel: 這類都不得有 ::after 圖示", () => {
    const css = readIndexCssWithoutComments();
    const wikilinkAfter = [...css.matchAll(/([^{}]*data-inline-content-type\s*=\s*"wikilink"[^{}]*)\{/g)]
      .map((m) => m[1]!.trim())
      .filter((s) => s.includes("::after"));
    expect(wikilinkAfter, "wikilink 是 <button> ＋ 同分頁導航，掛開新分頁圖示就是說謊").toEqual([]);
    // 反面：::after 那條的**每個**選擇器都要同時帶 link 型別與 href 前綴限定。少了型別
    // 限定會命中 wikilink；少了前綴限定會命中 `mailto:`／`tel:`／`sms:`（那些是 link mark
    // 但不開在分頁裡），「開新分頁」就成了錯標。前綴只准是下面這份白名單（#156 的判準）。
    const ALLOWED_PREFIXES = [
      String.raw`[href^="http:" i]`,
      String.raw`[href^="https:" i]`,
      String.raw`[href^="//"]`,
      String.raw`[href^="\\\\"]`,
      String.raw`[href^="/\\"]`,
      String.raw`[href^="\\/"]`,
    ];
    for (const selector of afterRule()[0]!.selectors) {
      expect(selector, `::after 選擇器缺 link 型別限定（會命中 wikilink）：${selector}`).toMatch(
        /\[data-inline-content-type\s*=\s*"link"\]/,
      );
      const hrefParts = selector.match(/\[href[^\]]*\]/g) ?? [];
      expect(hrefParts, `::after 選擇器要恰好一個 href 前綴限定：${selector}`).toHaveLength(1);
      expect(ALLOWED_PREFIXES, `::after 選擇器的 href 限定不在 #156 的白名單裡：${selector}`).toContain(hrefParts[0]);
    }
    // 白名單每一項都要有人蓋到（少一條＝那種寫法的外連沒有圖示，#156 原貌）。
    for (const prefix of ALLOWED_PREFIXES) {
      expect(
        afterRule()[0]!.selectors.some((s) => s.includes(prefix)),
        `沒有任何 ::after 選擇器蓋到 ${prefix}`,
      ).toBe(true);
    }
  });

  describe("#156：圖示判準要與瀏覽器的 URL 剖析一致（選擇器拿去真的比對 href）", () => {
    // 站在一個 http 頁面上（demo 是明文 http；https 頁面見下方 SAME_SCHEME 的說明）。
    const PAGE = "http://knotebook.local/n/some-note";
    // 一律從 index.css 現行的選擇器拿（去掉 `.bn-editor ` 祖先與 `::after`），不自抄一份。
    const iconMatches = (href: string) => {
      const a = document.createElement("a");
      a.setAttribute("data-inline-content-type", "link");
      a.setAttribute("href", href);
      return afterRule()[0]!.selectors.some((s) =>
        a.matches(s.replace(/^\.bn-editor\s+/, "").replace(/::after$/, "")),
      );
    };
    const resolvesToAnotherHttpOrigin = (href: string) => {
      const url = new URL(href, PAGE);
      return (url.protocol === "http:" || url.protocol === "https:") && url.origin !== new URL(PAGE).origin;
    };

    // 會開到**另一個 http(s) 來源**的寫法：一律要有圖示。
    const EXTERNAL = [
      "https://x.com",
      "http://x.com/a?b#c",
      "HTTPS://X.COM",
      "Http://x.com",
      "hTtPs://x.com",
      "//evil.com",
      "//evil.com/path",
      String.raw`\\evil.com`,
      String.raw`/\evil.com`,
      String.raw`\/evil.com`,
      String.raw`https:\\x.com`,
      String.raw`HTTPS:/\x.com`,
      "https:x.com", // 跨協定（頁面是 http）：剖析器忽略任意個斜線，主機是 x.com
    ];
    it.each(EXTERNAL)("外連 %s → 有圖示", (href) => {
      expect(resolvesToAnotherHttpOrigin(href), `測資前提：${href} 應解析成另一個 http(s) 來源`).toBe(true);
      expect(iconMatches(href), `${href} 是外連卻沒有開新分頁圖示`).toBe(true);
    });

    // 不開在分頁裡的協定（交給協定處理程式）與站內連結：一律沒有圖示。大小寫變體也要擋。
    const NO_ICON = [
      "mailto:a@b.com",
      "MAILTO:a@b.com",
      "tel:+886212345678",
      "sms:+886912345678",
      "callto:someone",
      "xmpp:a@b.com",
      "httpfoo:x", // 別的協定，只是名字以 http 開頭
      "/n/other-note",
      "other-note",
      "#heading",
      "?q=1",
    ];
    it.each(NO_ICON)("非外連 %s → 沒有圖示", (href) => {
      expect(resolvesToAnotherHttpOrigin(href), `測資前提：${href} 不應解析成另一個 http(s) 來源`).toBe(false);
      expect(iconMatches(href), `${href} 不開到別的網站卻掛了開新分頁圖示`).toBe(false);
    });

    it("同協定的 `http:foo` 是站內相對路徑：有圖示也不是錯標（target=_blank，確實開新分頁）", () => {
      // 剖析器：協定與頁面相同、後面不是 `//` ⇒ 相對路徑。圖示宣稱的是「開新分頁」，
      // 這仍成立；這格只是把「判準刻意比 `http:` 而非 `http://`」的後果釘成明文。
      expect(new URL("http:foo", PAGE).origin).toBe(new URL(PAGE).origin);
      expect(iconMatches("http:foo")).toBe(true);
    });

    it("已知蓋不到（只會少標、不會錯標；舉例非窮舉）：開頭空白／控制字元、網址任何位置夾 tab 或換行", () => {
      // 字面前綴比不到、剖析器卻會剝掉（tab／換行在**任何位置**都被整個刪除）。寫成測試是為了：
      // 哪天真的蓋到了，這格會紅，提醒去更新 `docs/known-limitations.md` 與 index.css 註解裡的
      // 「仍蓋不到」說明。
      for (const href of [
        " https://x.com",
        "\thttps://x.com",
        "ht\ttps://x.com",
        "https\n://x.com",
        "/\t/x.com", // 剝掉 tab 後是 `//x.com`（protocol-relative）
        "/\n/x.com",
        // 反例提醒：`https:/\n/x.com` **有**圖示（字面前綴 `https:` 就已命中），所以不在這份清單裡。
      ]) {
        expect(resolvesToAnotherHttpOrigin(href), `測資前提：${JSON.stringify(href)} 是外連`).toBe(true);
        expect(iconMatches(href), `${JSON.stringify(href)} 現在有圖示了——更新已知限制`).toBe(false);
      }
    });
  });
});
