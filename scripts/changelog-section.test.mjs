// scripts/changelog-section.test.mjs
//
// changelog-section.mjs 的常駐測試（node:test，餵手造 CHANGELOG 字串，不讀真檔）。
// 跑法：`pnpm test:scripts`（= `node --test scripts/*.test.mjs`）。
//
// 覆蓋範圍：
//   - 抽出指定版本段落（不含 `## [x.y.z]` 標題行本身）
//   - 段落止於下一個版本標題
//   - 段落止於「非版本」的 `## ` 檔尾章節（真的踩過：CHANGELOG 檔尾有 `## Documentation`）
//   - 版本不存在一律 throw（fail-closed：不讓 CI 發出 notes 空白的 release）
//   - `[Unreleased]` 不會被當成某個版本的內容誤抓

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { extractChangelogSection } from './changelog-section.mjs';

const CHANGELOG = [
  '# Changelog',
  '',
  'All notable changes to this project are documented here.',
  '',
  '## [Unreleased]',
  '',
  '- 尚未發版的東西。',
  '',
  '## [0.2.0] - 2026-09-01',
  '',
  '### Added',
  '- 新東西 B。',
  '',
  '## [0.1.0] - 2026-08-14',
  '',
  '### Added',
  '- 新東西 A。',
  '',
  '### Security',
  '- 安全性修補 A。',
  '',
  '## Documentation',
  '',
  '- [README](README.md) — 檔尾章節，不屬於任何版本。',
  '',
].join('\n');

test('extractChangelogSection: 抽出指定版本內容，不含標題行', () => {
  const section = extractChangelogSection(CHANGELOG, '0.1.0');

  assert.equal(section, ['### Added', '- 新東西 A。', '', '### Security', '- 安全性修補 A。'].join('\n'));
});

test('extractChangelogSection: 段落止於下一個版本標題', () => {
  const section = extractChangelogSection(CHANGELOG, '0.2.0');

  assert.equal(section, ['### Added', '- 新東西 B。'].join('\n'));
  assert.ok(!section.includes('0.1.0'));
  assert.ok(!section.includes('新東西 A'));
});

test('extractChangelogSection: 段落止於非版本的 `## ` 檔尾章節', () => {
  const section = extractChangelogSection(CHANGELOG, '0.1.0');

  assert.ok(!section.includes('Documentation'));
  assert.ok(!section.includes('檔尾章節'));
});

test('extractChangelogSection: 版本不存在時 throw（訊息帶版本號）', () => {
  assert.throws(() => extractChangelogSection(CHANGELOG, '9.9.9'), /9\.9\.9/);
});

test('extractChangelogSection: 不把 [Unreleased] 內容算進任何版本', () => {
  const section = extractChangelogSection(CHANGELOG, '0.2.0');

  assert.ok(!section.includes('尚未發版'));
});

test('extractChangelogSection: 版本存在但內容為空時也 throw', () => {
  const emptySection = ['# Changelog', '', '## [0.3.0] - 2026-10-01', '', '## [0.2.0] - 2026-09-01', '', '- x。', ''].join('\n');

  assert.throws(() => extractChangelogSection(emptySection, '0.3.0'), /0\.3\.0/);
});
