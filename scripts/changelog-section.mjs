#!/usr/bin/env node
// scripts/changelog-section.mjs
//
// 從 CHANGELOG.md 抽出某個版本的段落，印到 stdout——給 release workflow 當
// GitHub Release 的 notes 用（`node scripts/changelog-section.mjs 0.1.0 > notes.md`）。
//
// 段落邊界刻意定成「下一個任何 `## ` 標題」而非「下一個 `## [` 版本標題」：本 repo 的
// CHANGELOG 檔尾有 `## Documentation` 這種非版本章節，只認版本標題會把它一起吃進 notes。
//
// fail-closed：版本不存在、或該版段落是空的，一律 throw（CLI 以 exit 1 結束），
// 寧可讓 release workflow 紅掉，也不要發出一個 notes 空白的 release。

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const HEADING_PREFIX = '## ';

export function extractChangelogSection(changelogText, version) {
  const versionHeading = `${HEADING_PREFIX}[${version}]`;
  const lines = changelogText.split('\n');
  const start = lines.findIndex((line) => line.startsWith(versionHeading));

  if (start === -1) {
    throw new Error(`CHANGELOG.md 裡找不到版本 ${version} 的段落（預期標題形如 "${versionHeading} - YYYY-MM-DD"）`);
  }

  const rest = lines.slice(start + 1);
  const endOffset = rest.findIndex((line) => line.startsWith(HEADING_PREFIX));
  const body = (endOffset === -1 ? rest : rest.slice(0, endOffset)).join('\n').trim();

  if (body === '') {
    throw new Error(`CHANGELOG.md 裡版本 ${version} 的段落是空的——不發 notes 空白的 release`);
  }

  return body;
}

function main(argv) {
  const version = argv[2];

  if (!version) {
    throw new Error('用法：node scripts/changelog-section.mjs <version>（例：0.1.0）');
  }

  const changelogPath = new URL('../CHANGELOG.md', import.meta.url);

  process.stdout.write(`${extractChangelogSection(readFileSync(changelogPath, 'utf8'), version)}\n`);
}

// 直接執行時才跑 CLI；被 test import 時不跑（argv[1] 在 `node -e` 之類的情境會是 undefined）。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
