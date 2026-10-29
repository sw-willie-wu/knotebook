import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEME_COLOR } from "./theme";

// #336 PWA 最小可行方案：能加到主畫面、以 standalone 開啟；不含 service worker／離線。
// 這裡只驗「交出去的檔案本身」——manifest 欄位、圖示檔與實際尺寸、index.html 的 link／meta。
// server 是否以正確 MIME 送出 manifest、且不被 SPA fallback 吞掉，見 apps/server/test/spa.test.ts。

const publicDir = `${process.cwd()}/public`;
const indexHtml = readFileSync(`${process.cwd()}/index.html`, "utf8");
// 先去掉 HTML 註解：被註解掉的 <link>／<meta> 在瀏覽器裡不存在，不能讓它們算數。
const head = indexHtml.slice(indexHtml.indexOf("<head>"), indexHtml.indexOf("</head>")).replace(/<!--[\s\S]*?-->/g, "");
// index.css 的 --background 行尾**註解**記著淺／深兩組 hex（:root 與 :root.dark 各一條）。⚠ 這裡比對的是註解，
// 不是 oklch 實際值：改了 oklch 卻沒改註解，這組測試照樣綠——hex 註解與 theme-color 都是人工同步。
const backgroundHexes = [...readFileSync(`${process.cwd()}/src/index.css`, "utf8").matchAll(/(?<![\w-])--background:[^;]*;\s*\/\*\s*(#[0-9a-f]{6})/gi)].map((m) => m[1].toLowerCase());

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}
interface Manifest {
  id: string;
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  theme_color: string;
  background_color: string;
  icons: ManifestIcon[];
}

function readManifest(): Manifest {
  return JSON.parse(readFileSync(`${publicDir}/manifest.webmanifest`, "utf8")) as Manifest;
}

/** PNG 檔頭：8 bytes 簽章，接著 IHDR chunk（長度 4、型別 4），寬高各 4 bytes big-endian 在 offset 16／20。 */
function pngSize(file: string): { width: number; height: number } {
  const buf = readFileSync(file);
  expect(buf.subarray(0, 8).toString("hex"), `${file} 不是 PNG`).toBe("89504e470d0a1a0a");
  expect(buf.subarray(12, 16).toString("ascii")).toBe("IHDR");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const HEX = /^#[0-9a-f]{6}$/i;

describe("pngSize（量測工具本身）", () => {
  it("正控：既有的 apple-touch-icon.png 量得 180×180", () => {
    expect(pngSize(`${publicDir}/apple-touch-icon.png`)).toEqual({ width: 180, height: 180 });
  });
  it("負控：非 PNG 檔（favicon.svg）會被判失敗", () => {
    expect(() => pngSize(`${publicDir}/favicon.svg`)).toThrow();
  });
});

describe("manifest.webmanifest（#336）", () => {
  it("檔案存在且是合法 JSON", () => {
    expect(existsSync(`${publicDir}/manifest.webmanifest`)).toBe(true);
    expect(() => readManifest()).not.toThrow();
  });

  it("可安裝的必要欄位：name／short_name、start_url 與 scope 為站根、display standalone", () => {
    const m = readManifest();
    expect(m.name).toBe("Knotebook");
    expect(m.short_name).toBe("Knotebook");
    // id 固定 app 身分：未設時瀏覽器以 start_url 代替，日後改 start_url 會讓已安裝的變成另一個 app（#336，Chrome DevTools 建議值）
    expect(m.id).toBe("/");
    expect(m.start_url).toBe("/");
    expect(m.scope).toBe("/");
    expect(m.display).toBe("standalone");
  });

  it("theme_color／background_color 是 6 碼 hex", () => {
    const m = readManifest();
    expect(m.theme_color).toMatch(HEX);
    expect(m.background_color).toMatch(HEX);
  });

  it("圖示：192 與 512 的 PNG（purpose any），另有一張 maskable", () => {
    const icons = readManifest().icons;
    const any = icons.filter((i) => (i.purpose ?? "any").split(" ").includes("any"));
    expect(any.map((i) => i.sizes).sort()).toEqual(["192x192", "512x512"]);
    expect(icons.some((i) => (i.purpose ?? "").split(" ").includes("maskable"))).toBe(true);
    for (const icon of icons) expect(icon.type).toBe("image/png");
  });

  it("每張圖示檔都存在於 public/，實際像素尺寸與 sizes 宣告一致", () => {
    for (const icon of readManifest().icons) {
      expect(icon.src.startsWith("/"), icon.src).toBe(true);
      const file = `${publicDir}${icon.src}`;
      expect(existsSync(file), file).toBe(true);
      const [w, h] = icon.sizes.split("x").map(Number);
      expect(pngSize(file), icon.src).toEqual({ width: w, height: h });
    }
  });
});

describe("index.html 的 PWA 標記（#336）", () => {
  it("恰有一個 <link rel=\"manifest\" href=\"/manifest.webmanifest\">", () => {
    const links = head.match(/<link\s+rel="manifest"[^>]*>/g) ?? [];
    expect(links).toHaveLength(1);
    expect(links[0]).toContain('href="/manifest.webmanifest"');
  });

  it("index.css 的 --background 註解恰有淺、深兩組 hex（下一條的比對來源；抓不到就紅，不靜默略過）", () => {
    expect(backgroundHexes).toHaveLength(2);
  });

  it("theme-color 有淺／深兩組（prefers-color-scheme），淺色＝manifest theme_color＝頁底色註解 hex，深色＝深色頁底色註解 hex", () => {
    const metas = head.match(/<meta\s+name="theme-color"[^>]*>/g) ?? [];
    expect(metas).toHaveLength(2);
    const light = metas.find((m) => m.includes("(prefers-color-scheme: light)"));
    const dark = metas.find((m) => m.includes("(prefers-color-scheme: dark)"));
    expect(light, "缺淺色 theme-color").toBeDefined();
    expect(dark, "缺深色 theme-color").toBeDefined();
    expect(light).toContain(`content="${readManifest().theme_color}"`);
    expect(readManifest().theme_color.toLowerCase()).toBe(backgroundHexes[0]);
    expect(dark?.toLowerCase()).toContain(`content="${backgroundHexes[1]}"`);
  });

  it("theme.tsx 的 THEME_COLOR＝index.html 兩個 theme-color 的初始 content＝manifest theme_color（淺色）——執行期同步與首屏標記不得各說各話", () => {
    const metas = head.match(/<meta\s+name="theme-color"[^>]*>/g) ?? [];
    const contentOf = (media: string) => metas.find((m) => m.includes(media))?.match(/content="([^"]*)"/)?.[1];
    expect(contentOf("(prefers-color-scheme: light)")).toBe(THEME_COLOR.light);
    expect(contentOf("(prefers-color-scheme: dark)")).toBe(THEME_COLOR.dark);
    expect(readManifest().theme_color).toBe(THEME_COLOR.light);
  });

  it("原始 head（含註解）裡 `<script` 恰出現一次——security-headers.ts 的 INLINE_SCRIPT 對未剝註解的 HTML 算 hash，註解裡的 `<script …>` 字面也會被吃進去", () => {
    const rawHead = indexHtml.slice(indexHtml.indexOf("<head>"), indexHtml.indexOf("</head>"));
    expect(rawHead.match(/<script/gi) ?? []).toHaveLength(1);
  });

  it("仍只有一段 inline script（theme.test.tsx 只抓第一段驗防閃；新增 PWA 標記不得多出 inline script）", () => {
    const inline = head.match(/<script(?![^>]*\ssrc=)[^>]*>/g) ?? [];
    expect(inline).toHaveLength(1);
  });
});
