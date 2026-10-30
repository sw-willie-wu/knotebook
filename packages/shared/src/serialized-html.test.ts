import { describe, expect, it } from "vitest";
import * as shared from "./index.js";
import { unescapeAttributeAngles } from "./serialized-html.js";

// 屬性值的 `<`／`>` 序列化差異（Chromium 151／Firefox 153／WebKit 26.5 跳脫、jsdom 30 不跳脫；並排 PR-2 T5 探針實測）：兩種輸入都要得到 jsdom 的形。
describe("unescapeAttributeAngles", () => {
  it("UA1 瀏覽器形的屬性值換回字面，與 jsdom 形相同（golden G2-img-escape）", () => {
    const browser = '<figure><img alt="a &quot;b&quot; &amp; &lt;c&gt;" src="/api/uploads/u5?a=1&amp;b=2" width="300"><figcaption>x &amp; "y"</figcaption></figure>';
    const jsdom = '<figure><img alt="a &quot;b&quot; &amp; <c>" src="/api/uploads/u5?a=1&amp;b=2" width="300"><figcaption>x &amp; "y"</figcaption></figure>';
    expect(unescapeAttributeAngles(browser)).toBe(jsdom);
    expect(unescapeAttributeAngles(jsdom)).toBe(jsdom);
  });

  it("UA2 文字裡的 &lt;／&gt; 不動，即使長得像屬性", () => {
    const html = '<p>k="&lt;b&gt;" &lt;i x="&lt;"&gt;</p><td colwidth="120">&lt;a&gt; &amp; "q"</td>';
    expect(unescapeAttributeAngles(html)).toBe(html);
  });

  it("UA3 屬性值裡字面的 &amp;lt; 不被誤換；多個屬性、多個標籤都換", () => {
    expect(unescapeAttributeAngles('<img alt="&amp;lt; &lt;" src="/x?q=&gt;"><a href="/y&lt;">t &lt;</a>')).toBe('<img alt="&amp;lt; <" src="/x?q=>"><a href="/y<">t &lt;</a>');
  });

  it("UA4 含 raw-text 元素時原樣回傳（內容不經跳脫，換了會造出新標記）", () => {
    const html = '<style><a x="&lt;/style&gt;&lt;img src=x onerror=alert(1)&gt;"></style>';
    expect(unescapeAttributeAngles(html)).toBe(html);
  });

  it.each(["script", "style", "xmp", "iframe", "noembed", "noframes", "noscript", "plaintext", "textarea", "title"])(
    "UA4 %s：含這個 raw-text 元素時原樣回傳",
    (tag) => {
      const html = `<img alt="&lt;"><${tag}><a x="&lt;"></${tag}>`;
      expect(unescapeAttributeAngles(html)).toBe(html);
    },
  );

  it("UA5 含註解時原樣回傳（註解內容原樣序列化）", () => {
    const html = '<img alt="&lt;"><!--<b x="&lt;">-->';
    expect(unescapeAttributeAngles(html)).toBe(html);
  });

  it("UA6 不是 @knotebook/shared 的公開 export（前提只對 toBlockHTML 的輸入成立）", () => {
    expect("unescapeAttributeAngles" in shared).toBe(false);
  });
});
