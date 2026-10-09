// node --test（同 changelog-section.test.mjs 慣例）：對假目錄測 check-bundle-size 的
// 判斷邏輯，不必真的 build——真 dist 的檢查在 CI 的 build 之後跑 check-bundle-size.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkBundleSize } from './check-bundle-size.mjs';

function fakeAssets(files) {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-check-'));
  const assets = join(dir, 'assets');
  mkdirSync(assets);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(assets, name), typeof content === 'string' ? content : Buffer.alloc(content));
  }
  return { assets, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('entry 在上限內且 NotePage chunk 存在 → 通過並回報摘要', () => {
  const { assets, cleanup } = fakeAssets({
    'index-Abc123.js': 500_000,
    'NotePage-Def456.js': 1_000_000,
    'mermaid.core-Ghi789.js': 700_000,
    'shiki-Jkl012.js': 150_000,
    'AdminPage-Mno345.js': 60_000,
    'PresentationOverlay-Pqr678.js': 200_000,
    'index-Abc123.css': 50_000, // css 不是 entry chunk，pattern 只認 .js
  });
  try {
    const result = checkBundleSize(assets, { maxEntryBytes: 700 * 1024 });
    assert.equal(result.entryName, 'index-Abc123.js');
    assert.equal(result.entryBytes, 500_000);
    assert.deepEqual(result.notePageChunks, ['NotePage-Def456.js']);
    assert.deepEqual(result.mermaidChunks, ['mermaid.core-Ghi789.js']);
    assert.deepEqual(result.shikiChunks, ['shiki-Jkl012.js']);
    assert.deepEqual(result.adminPageChunks, ['AdminPage-Mno345.js']);
    assert.deepEqual(result.presentationChunks, ['PresentationOverlay-Pqr678.js']);
  } finally {
    cleanup();
  }
});

test('entry 超過上限 → throw，訊息含實際 bytes 與迴歸提示', () => {
  const { assets, cleanup } = fakeAssets({
    'index-Fat999.js': 1_700_000,
    'NotePage-Def456.js': 10,
  });
  try {
    assert.throws(() => checkBundleSize(assets, { maxEntryBytes: 700 * 1024 }), /1700000[\s\S]*issue #19/);
  } finally {
    cleanup();
  }
});

test('NotePage chunk 不存在（split 被拿掉）→ throw', () => {
  const { assets, cleanup } = fakeAssets({ 'index-Abc123.js': 100 });
  try {
    assert.throws(() => checkBundleSize(assets), /NotePage/);
  } finally {
    cleanup();
  }
});

test('fail-closed：dist 不存在 → throw（不是靜默通過）', () => {
  assert.throws(() => checkBundleSize(join(tmpdir(), 'no-such-dir-bundle-check')), /pnpm build/);
});

test('fail-closed：多個 entry chunk（build 產物形狀不符預期）→ throw', () => {
  const { assets, cleanup } = fakeAssets({
    'index-Aaa111.js': 100,
    'index-Bbb222.js': 100,
    'NotePage-Ccc333.js': 100,
  });
  try {
    assert.throws(() => checkBundleSize(assets), /恰一個 entry/);
  } finally {
    cleanup();
  }
});

// issue #94：mermaid 必須留在自己的 chunk。這條擋的是「有人在 lib/mermaid.ts 以外靜態
// import 了 mermaid」——那會讓它被併進 NotePage/entry，獨立 chunk 就消失。
test('mermaid chunk 不存在（被靜態 import 併回去）→ throw', () => {
  const { assets, cleanup } = fakeAssets({
    'index-Abc123.js': 100,
    'NotePage-Def456.js': 100,
  });
  try {
    assert.throws(() => checkBundleSize(assets), /mermaid/);
  } finally {
    cleanup();
  }
});

// issue #96：shiki 必須留在自己的 chunk（同 mermaid 那條的理由——唯一允許 import 它的
// 地方是 lib/code-highlight.ts 的 `import("shiki")`）。它的核心 ~150KB，被靜態 import
// 併回 entry 的話 entry 會貼著 700KB 上限，症狀是「時而超標」而不是穩定紅。
// ⚠ chunk 名叫 shiki-<hash> 是 vite.config.ts 的 chunkFileNames 改的：shiki 的套件
// 入口檔叫 index.mjs，Rollup 預設用檔名命名 chunk，會產出第二個 index-<hash>.js、
// 撞上 entry 偵測（上面「恰一個 entry」那條 fail-closed 就是這樣抓到它的）。
test('shiki chunk 不存在（被靜態 import 併回去）→ throw', () => {
  const { assets, cleanup } = fakeAssets({
    'index-Abc123.js': 100,
    'NotePage-Def456.js': 100,
    'mermaid.core-Ghi789.js': 100,
  });
  try {
    assert.throws(() => checkBundleSize(assets), /shiki/);
  } finally {
    cleanup();
  }
});

// issue #201：站台管理頁必須是自己的 lazy chunk（App.tsx 的 `lazy(() => import("./pages/AdminPage"))`
// 是唯一 import 點）——有人靜態 import 它，Rollup 會把整頁連同三個子區塊併回 entry、這個 chunk 消失。
test('AdminPage chunk 不存在（被靜態 import 併回 entry）→ throw', () => {
  const { assets, cleanup } = fakeAssets({
    'index-Abc123.js': 100,
    'NotePage-Def456.js': 100,
    'mermaid.core-Ghi789.js': 100,
    'shiki-Jkl012.js': 100,
  });
  try {
    assert.throws(() => checkBundleSize(assets), /AdminPage[\s\S]*issue #201/);
  } finally {
    cleanup();
  }
});

test('簡報層 chunk 不存在（#229 迴歸：PresentationOverlay 被靜態 import）→ throw', () => {
  const { assets, cleanup } = fakeAssets({
    'index-Abc123.js': 100, 'NotePage-Def456.js': 10, 'mermaid.core-Ghi789.js': 10, 'shiki-Jkl012.js': 10, 'AdminPage-Mno345.js': 10,
  });
  try {
    assert.throws(() => checkBundleSize(assets), /PresentationOverlay[\s\S]*#229/);
  } finally {
    cleanup();
  }
});

test('entry CSS 含 .reveal-viewport（reveal.css 進了首包）→ throw；lazy chunk 的 CSS 含它不算', () => {
  const base = {
    'index-Abc123.js': 100, 'NotePage-Def456.js': 10, 'mermaid.core-Ghi789.js': 10, 'shiki-Jkl012.js': 10,
    'AdminPage-Mno345.js': 10, 'PresentationOverlay-Pqr678.js': 10,
  };
  const bad = fakeAssets({ ...base, 'index-Css111.css': '.x{}.reveal-viewport{color:#000}' });
  try {
    assert.throws(() => checkBundleSize(bad.assets), /reveal-viewport[\s\S]*#229/);
  } finally {
    bad.cleanup();
  }
  const ok = fakeAssets({ ...base, 'index-Css111.css': '.x{}', 'PresentationOverlay-Css222.css': '.reveal-viewport{color:#000}' });
  try {
    assert.doesNotThrow(() => checkBundleSize(ok.assets));
  } finally {
    ok.cleanup();
  }
});

test('reveal-viewport 字串只准在 PresentationOverlay-*.js：在 overlay 裡通過、在 NotePage 裡 throw（reveal.js 被靜態 import 進 NotePage）', () => {
  const base = {
    'index-Abc123.js': 100, 'mermaid.core-Ghi789.js': 10, 'shiki-Jkl012.js': 10, 'AdminPage-Mno345.js': 10,
  };
  const ok = fakeAssets({ ...base, 'NotePage-Def456.js': 'x', 'PresentationOverlay-Pqr678.js': 'e.classList.add("reveal-viewport")' });
  try {
    assert.doesNotThrow(() => checkBundleSize(ok.assets));
  } finally {
    ok.cleanup();
  }
  const bad = fakeAssets({ ...base, 'NotePage-Def456.js': 'e.classList.add("reveal-viewport")', 'PresentationOverlay-Pqr678.js': 'x' });
  try {
    assert.throws(() => checkBundleSize(bad.assets), /NotePage-Def456\.js[\s\S]*reveal-viewport[\s\S]*#229/);
  } finally {
    bad.cleanup();
  }
});

test('Q1：簡報 chunk 的靜態 import 閉包（含間接）碰到 shiki → throw；只有動態 import("./shiki-…") 不算', () => {
  const base = {
    'index-Abc123.js': 100, 'NotePage-Def456.js': 10, 'mermaid.core-Ghi789.js': 10, 'AdminPage-Mno345.js': 10,
    'shiki-Jkl012.js': 'export const s=1', 'bundle-full-Zz9.js': 'export const b=1',
  };
  const indirect = fakeAssets({ ...base, 'PresentationOverlay-Pqr678.js': 'import{a}from"./mid-Q1.js";', 'mid-Q1.js': 'import{b}from"./bundle-full-Zz9.js";export const a=1' });
  try {
    assert.throws(() => checkBundleSize(indirect.assets), /bundle-full-Zz9\.js[\s\S]*Q1/);
  } finally {
    indirect.cleanup();
  }
  const direct = fakeAssets({ ...base, 'PresentationOverlay-Pqr678.js': 'import"./shiki-Jkl012.js";' });
  try {
    assert.throws(() => checkBundleSize(direct.assets), /shiki-Jkl012\.js[\s\S]*Q1/);
  } finally {
    direct.cleanup();
  }
  const dynamicOnly = fakeAssets({ ...base, 'PresentationOverlay-Pqr678.js': 'import{x}from"./index-Abc123.js";const l=()=>import("./shiki-Jkl012.js")' });
  try {
    assert.doesNotThrow(() => checkBundleSize(dynamicOnly.assets));
  } finally {
    dynamicOnly.cleanup();
  }
});
