#!/usr/bin/env node
// scripts/generate-pwa-icons.mjs
//
// 產生安裝成 app 用的三張圖示（apps/web/public/icon-192.png、icon-512.png、icon-maskable-512.png）。
// 來源是 apps/web/public/favicon.svg 的 K 字形 path 與它的淺色填色（品牌色）：
//   - 底：整張方塊塗滿品牌色（不留透明邊，Android 的各種遮罩形狀才不會露出底色以外的東西）。
//   - 字：白色，以 64 單位方塊的中心縮放。
//     - icon-192／icon-512（purpose any）：0.79，與 apple-touch-icon.png 一致。
//     - icon-maskable-512（purpose maskable）：0.6，字形落在中心 80% 直徑的安全圓內。
// 用 Playwright 的 Chromium 點陣化（e2e 套件已經裝了），所以要先 `pnpm install`，
// 且裝過 Chromium（`pnpm --filter @knotebook/e2e exec playwright install chromium`）。
//
// 跑法：node scripts/generate-pwa-icons.mjs [--out <目錄>]
//   預設寫進 apps/web/public；給 --out 就寫到別處（例如先比對再決定要不要覆蓋）。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PUBLIC_DIR = join(REPO_ROOT, 'apps', 'web', 'public');

/** 字形畫在 favicon.svg 的 64×64 viewBox 裡。 */
const VIEWBOX = 64;

export const ICONS = [
  { file: 'icon-192.png', size: 192, scale: 0.79 },
  { file: 'icon-512.png', size: 512, scale: 0.79 },
  { file: 'icon-maskable-512.png', size: 512, scale: 0.6 },
];

/** favicon.svg 裡唯一一條 `<path d="…">` 的 d。找不到或不只一條就 throw。 */
export function extractGlyphPath(svg) {
  const matches = [...svg.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)];
  if (matches.length !== 1) throw new Error(`favicon.svg 應該恰有一條 <path d>，實際 ${matches.length} 條`);
  return matches[0][1];
}

/** favicon.svg 的 `<style>` 裡第一條 `path { fill: #xxxxxx; }`（淺色，深色版在 media 查詢裡）。 */
export function extractBrandFill(svg) {
  const match = /path\s*\{\s*fill:\s*(#[0-9a-f]{6})\s*;?\s*\}/i.exec(svg);
  if (!match) throw new Error('favicon.svg 找不到 `path { fill: #xxxxxx; }`');
  return match[1].toLowerCase();
}

/** 一張圖示的 SVG：品牌色滿版方塊，白色字形以中心縮放 `scale`。 */
export function iconSvg({ glyphPath, background, scale, size }) {
  const offset = (VIEWBOX * (1 - scale)) / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEWBOX} ${VIEWBOX}" width="${size}" height="${size}">` +
    `<rect width="${VIEWBOX}" height="${VIEWBOX}" fill="${background}"/>` +
    `<path transform="translate(${offset} ${offset}) scale(${scale})" fill="#ffffff" d="${glyphPath}"/>` +
    `</svg>`
  );
}

function parseArgs(argv) {
  const outIndex = argv.indexOf('--out');
  return { outDir: outIndex === -1 ? PUBLIC_DIR : resolve(argv[outIndex + 1] ?? '') };
}

async function main() {
  const { outDir } = parseArgs(process.argv.slice(2));
  const favicon = readFileSync(join(PUBLIC_DIR, 'favicon.svg'), 'utf8');
  const glyphPath = extractGlyphPath(favicon);
  const background = extractBrandFill(favicon);

  const requireFromE2e = createRequire(join(REPO_ROOT, 'e2e', 'package.json'));
  const { chromium } = requireFromE2e('@playwright/test');
  const browser = await chromium.launch();
  try {
    mkdirSync(outDir, { recursive: true });
    for (const icon of ICONS) {
      const page = await browser.newPage({ viewport: { width: icon.size, height: icon.size }, deviceScaleFactor: 1 });
      const svg = iconSvg({ glyphPath, background, scale: icon.scale, size: icon.size });
      await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`);
      const png = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: icon.size, height: icon.size } });
      writeFileSync(join(outDir, icon.file), png);
      await page.close();
      console.log(`${icon.file}：${icon.size}×${icon.size}，字形縮放 ${icon.scale}`);
    }
  } finally {
    await browser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
