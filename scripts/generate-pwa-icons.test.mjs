// scripts/generate-pwa-icons.test.mjs
//
// generate-pwa-icons.mjs 不開瀏覽器的部分：從 favicon.svg 取字形與填色、組 SVG、
// 產出的檔名與尺寸和 manifest 宣告的一致。跑法：`pnpm test:scripts`。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { ICONS, extractBrandFill, extractGlyphPath, iconSvg } from './generate-pwa-icons.mjs';

const favicon = readFileSync(new URL('../apps/web/public/favicon.svg', import.meta.url), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('../apps/web/public/manifest.webmanifest', import.meta.url), 'utf8'));

test('extractGlyphPath：favicon.svg 恰有一條 path，取出它的 d', () => {
  const d = extractGlyphPath(favicon);
  assert.match(d, /^M[\d.]+ [\d.]+/);
  assert.throws(() => extractGlyphPath('<svg></svg>'), /恰有一條/);
  assert.throws(() => extractGlyphPath('<svg><path d="M0 0"/><path d="M1 1"/></svg>'), /恰有一條/);
});

test('extractBrandFill：取淺色填色（style 裡的第一條），不取深色 media 查詢裡的', () => {
  assert.equal(extractBrandFill(favicon), '#676f97');
  assert.throws(() => extractBrandFill('<svg></svg>'));
});

test('iconSvg：滿版底色，字形以 64 方塊中心縮放', () => {
  const svg = iconSvg({ glyphPath: 'M0 0', background: '#123456', scale: 0.6, size: 512 });
  assert.match(svg, /width="512" height="512"/);
  assert.match(svg, /<rect width="64" height="64" fill="#123456"\/>/);
  // (64 - 64 × 0.6) / 2 = 12.8
  assert.match(svg, /transform="translate\(12\.8 12\.8\) scale\(0\.6\)"/);
  assert.match(svg, /fill="#ffffff" d="M0 0"/);
});

test('ICONS 與 manifest 的 icons 一一對應（檔名、尺寸）；maskable 那張縮得比較小', () => {
  const declared = manifest.icons.map((i) => `${i.src.slice(1)} ${i.sizes}`).sort();
  const generated = ICONS.map((i) => `${i.file} ${i.size}x${i.size}`).sort();
  assert.deepEqual(generated, declared);
  const maskable = manifest.icons.find((i) => i.purpose === 'maskable');
  const maskableIcon = ICONS.find((i) => `/${i.file}` === maskable.src);
  for (const icon of ICONS) if (icon !== maskableIcon) assert.ok(maskableIcon.scale < icon.scale);
});
