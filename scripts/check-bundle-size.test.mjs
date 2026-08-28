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
  for (const [name, bytes] of Object.entries(files)) {
    writeFileSync(join(assets, name), Buffer.alloc(bytes));
  }
  return { assets, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('entry 在上限內且 NotePage chunk 存在 → 通過並回報摘要', () => {
  const { assets, cleanup } = fakeAssets({
    'index-Abc123.js': 500_000,
    'NotePage-Def456.js': 1_000_000,
    'mermaid.core-Ghi789.js': 700_000,
    'index-Abc123.css': 50_000, // css 不是 entry chunk，pattern 只認 .js
  });
  try {
    const result = checkBundleSize(assets, { maxEntryBytes: 700 * 1024 });
    assert.equal(result.entryName, 'index-Abc123.js');
    assert.equal(result.entryBytes, 500_000);
    assert.deepEqual(result.notePageChunks, ['NotePage-Def456.js']);
    assert.deepEqual(result.mermaidChunks, ['mermaid.core-Ghi789.js']);
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
