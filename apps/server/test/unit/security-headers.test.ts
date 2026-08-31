import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { securityHeaders } from "../../src/http/security-headers.js";

/**
 * issue #101：CSP 與同批安全標頭。
 *
 * 這一族守的都是「壞掉不會有任何測試紅、只有使用者遇到」的形：
 *
 * - **script-src 的 hash 與實際送出的 HTML 不同步** → 深色首屏防閃的 inline script
 *   被 CSP 擋掉，症狀是**每次開頁閃白**。所以 hash 一律**從當下要送出的那份 HTML
 *   推導**（不是啟動時算一次、更不是寫死常數），下面第一條就是在釘這件事。
 * - **directive 被放寬**（例如有人為了讓某個東西動起來加了 `'unsafe-inline'` 到
 *   script-src）→ 防線靜默失效。逐條釘值。
 * - **directive 被收緊**（img/media）→ 已出貨的功能靜默變破圖：外部圖片以 URL 內嵌、
 *   audio/video/file block **只有** embed-by-URL（見 docs/known-limitations.md）。
 *   #94 的安全政策定案（`lib/mermaid.ts` 檔頭）也明講圖表可引用遠端圖片。
 *
 * 期望值刻意**不從被測程式碼推導**：hash 在測試裡用 node:crypto 自己算一份當 oracle。
 */

/** 獨立 oracle：CSP 的 `'sha256-…'` 是「script 元素內文」的 sha256、base64 編碼。 */
function sha256Base64(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("base64");
}

/** 抽出某個 directive 的值（不含 directive 名）。 */
function directive(csp: string, name: string): string | undefined {
  return csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `))
    ?.slice(name.length)
    .trim();
}

const INLINE_A = 'document.documentElement.classList.add("dark");';
const INLINE_B = 'document.documentElement.setAttribute("data-accent", "teal");';

function htmlWith(...scripts: string[]): string {
  const tags = scripts.map((s) => `<script>${s}</script>`).join("\n");
  return `<!doctype html><html><head>${tags}</head><body><div id="root"></div></body></html>`;
}

describe("securityHeaders（issue #101）", () => {
  it("script-src 的 hash 從**當下這份 HTML** 推導——換一段 inline script，hash 就跟著換", () => {
    const cspA = securityHeaders(htmlWith(INLINE_A))["content-security-policy"]!;
    const cspB = securityHeaders(htmlWith(INLINE_B))["content-security-policy"]!;

    expect(directive(cspA, "script-src")).toContain(`'sha256-${sha256Base64(INLINE_A)}'`);
    expect(directive(cspB, "script-src")).toContain(`'sha256-${sha256Base64(INLINE_B)}'`);
    // 同一段 script 的 hash 不該出現在另一份的政策裡——那代表 hash 是寫死的常數，
    // 而寫死的常數就是「改了 index.html 卻沒改 hash → 首屏閃白」那個失效形。
    expect(directive(cspB, "script-src")).not.toContain(sha256Base64(INLINE_A));
  });

  it("外部 script 不算——只有會被執行的 inline script 才進 hash 清單", () => {
    const html = `<!doctype html><head><script type="module" src="/assets/main.js"></script>${
      `<script>${INLINE_A}</script>`
    }</head>`;
    const scriptSrc = directive(securityHeaders(html)["content-security-policy"]!, "script-src")!;

    expect(scriptSrc).toContain(`'sha256-${sha256Base64(INLINE_A)}'`);
    // 外部 chunk 走 `'self'`；若把它的**路徑字串**也拿去 hash，清單會多出一個永遠用不到
    // 的雜湊（無害但誤導），更糟的是暗示「有 src 的也要 hash」這個錯誤心智模型。
    expect(scriptSrc.match(/sha256-/g) ?? []).toHaveLength(1);
  });

  it("CRLF 的 inline script 要用**正規化成 LF 之後**的內容算 hash（HTML parser 先正規化換行）", () => {
    // 實測（e2e 09-csp 首跑抓到）：Windows checkout 的 `index.html` 帶 CRLF，對原始字串
    // 算出來的 hash 與瀏覽器算的**不同**——HTML 解析規範要求把 CR／CRLF 正規化成 LF 之後
    // 才進 tokenizer，所以 script 元素的 textContent 只有 LF。不正規化的症狀是防閃
    // script 每次都被擋＝**深色模式每次開頁閃白**，而且 server 端所有測試都會是綠的。
    const lf = 'var a = 1;\nvar b = 2;\n';
    const expected = `'sha256-${sha256Base64(lf)}'`;

    for (const [label, source] of [
      ["CRLF", 'var a = 1;\r\nvar b = 2;\r\n'],
      ["單獨 CR（舊 Mac 行尾）", 'var a = 1;\rvar b = 2;\r'],
      ["LF", lf],
    ] as const) {
      const csp = securityHeaders(htmlWith(source))["content-security-policy"]!;
      expect(directive(csp, "script-src"), `${label} 的 hash 與 LF 版不一致`).toContain(expected);
    }
  });

  it("政策內容逐條釘死：該緊的緊、**該寬的也不准被收緊**", () => {
    const csp = securityHeaders(htmlWith(INLINE_A))["content-security-policy"]!;

    // 收緊的那半：XSS 主線與老攻擊面。
    expect(directive(csp, "default-src")).toBe("'self'");
    expect(directive(csp, "object-src")).toBe("'none'");
    expect(directive(csp, "base-uri")).toBe("'self'");
    expect(directive(csp, "frame-ancestors")).toBe("'none'");
    expect(directive(csp, "form-action")).toBe("'self'");
    // 共編 WebSocket 是同源（`collabUrl()` 由 window.location 推導），`'self'` 涵蓋得到。
    expect(directive(csp, "connect-src")).toBe("'self'");
    expect(directive(csp, "font-src")).toBe("'self' data:");

    // script-src 不得出現 `'unsafe-inline'`／`'unsafe-eval'`——有 hash 就不需要，
    // 加了等於整條 directive 失效（有 hash 時 `'unsafe-inline'` 會被瀏覽器忽略，
    // 但 `'unsafe-eval'` 不會，而且兩者都是「為了讓某個東西動起來」最常見的鬆綁）。
    expect(directive(csp, "script-src")).not.toContain("unsafe-");

    // style-src 的 `'unsafe-inline'` 是**無法避免**的：shiki 的 token 顏色、mermaid 產出的
    // SVG、BlockNote 浮層都在注入 inline style。至少擋掉外部 stylesheet。
    expect(directive(csp, "style-src")).toBe("'self' 'unsafe-inline'");

    // 放寬的那半（issue #101 定案，守 #94 的政策）：收緊會讓已出貨的功能靜默變破圖。
    // img：外部圖片以 URL 內嵌（圖片 block 的 Embed 分頁、從網頁直接拖圖、mermaid 的
    // `A@{ img: … }`）。media：audio/video block **只有** embed-by-URL，沒有上傳路徑。
    // ⚠ **http: 不能少**（gate 審查抓到）：`lib/media-url.ts` 的守衛對 http/https 都放行，
    // 而 `docs/self-hosting.md` 的 topology (a) 就是純 http 的信任 LAN 部署。只放 https:
    // 的話，LAN 自架者既有筆記裡的 `http://intranet/logo.png` 會靜默變破圖（https 部署
    // 上這些本來就被 mixed-content 擋掉，所以受害的只有 http 部署）。
    expect(directive(csp, "img-src")).toBe("'self' data: blob: http: https:");
    expect(directive(csp, "media-src")).toBe("'self' http: https:");
  });

  it("同批的另外兩個標頭：nosniff 與 no-referrer（後者讓外部圖片載入但不洩漏在看哪一篇）", () => {
    const headers = securityHeaders(htmlWith(INLINE_A));

    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("no-referrer");
  });
});
