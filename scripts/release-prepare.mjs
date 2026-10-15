#!/usr/bin/env node
// scripts/release-prepare.mjs
//
// 發版準備：`pnpm release:prepare X.Y.Z [--date YYYY-MM-DD]`。只改檔＋檢查，不碰 git 寫入：
//   - apps/server、apps/web、packages/shared 三個 package.json 的 version
//   - CHANGELOG.md：`## [Unreleased]` 的內容收成 `## [X.Y.Z] - <日期>`，上方留新的空 `[Unreleased]`
//   - README.md／README.zh-TW.md 的狀態行（最新版本與日期）
// 發版本身在 merge 進 main、CI 全綠後由 .github/workflows/release.yml 自動完成（見 docs/releasing.md）。
//
// 前置檢查任一不符就 throw（CLI exit 1），而且**先把所有新內容算好才寫檔**，所以失敗時不改任何檔。
// 各檔原本的行尾（CRLF／LF）照舊保留。

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PACKAGE_FILES = ['apps/server/package.json', 'apps/web/package.json', 'packages/shared/package.json'];
export const CHANGELOG_FILE = 'CHANGELOG.md';
export const README_FILES = {
  'README.md': {
    pattern: /the latest release is v\d+\.\d+\.\d+ \(\d{4}-\d{2}-\d{2}\)/g,
    replacement: (version, date) => `the latest release is v${version} (${date})`,
  },
  'README.zh-TW.md': {
    pattern: /最新版本為 v\d+\.\d+\.\d+（\d{4}-\d{2}-\d{2}）/g,
    replacement: (version, date) => `最新版本為 v${version}（${date}）`,
  },
};

const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TAG_RE = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOTHING_YET = '_Nothing yet._';
const UNRELEASED_HEADING = '## [Unreleased]';

function parseVersion(text) {
  const m = VERSION_RE.exec(text);
  return m ? m.slice(1, 4).map(Number) : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** 只認 vX.Y.Z 形的 tag（其他形如 v1.0.0-rc1、foo 一律略過），回傳 semver 最大者或 null。 */
export function maxReleaseTag(tags) {
  let max = null;
  for (const tag of tags) {
    if (!TAG_RE.test(tag)) continue;
    const parts = parseVersion(tag.slice(1));
    if (max === null || compareVersions(parts, max.parts) > 0) max = { tag, parts };
  }
  return max ? max.tag : null;
}

export function localDate(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function eolOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n';
}

function bumpPackageJson(path, text, version) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} 不是合法 JSON：${error.message}`);
  }
  if (typeof parsed.version !== 'string') {
    throw new Error(`${path} 沒有 "version" 欄位`);
  }
  // 只換第一個 "version"（頂層，位於 dependencies 之前），保留原格式與行尾。
  const next = text.replace(/"version"(\s*):(\s*)"[^"]*"/, `"version"$1:$2"${version}"`);
  if (JSON.parse(next).version !== version) {
    throw new Error(`${path} 的頂層 "version" 不是檔內第一個 "version"，不自動改`);
  }
  return next;
}

function rollChangelog(text, version, date) {
  const eol = eolOf(text);
  const lines = text.split(eol);
  const start = lines.findIndex((line) => line.trimEnd() === UNRELEASED_HEADING);
  if (start === -1) {
    throw new Error(`${CHANGELOG_FILE} 找不到 "${UNRELEASED_HEADING}" 標題`);
  }
  if (lines.some((line) => line.startsWith(`## [${version}]`))) {
    throw new Error(`${CHANGELOG_FILE} 已經有 ${version} 的段落`);
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  const body = (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
  if (body === '' || body === NOTHING_YET) {
    throw new Error(`${CHANGELOG_FILE} 的 [Unreleased] 是空的——沒有東西可以發版`);
  }
  const head = [UNRELEASED_HEADING, '', NOTHING_YET, '', `## [${version}] - ${date}`];
  return [...lines.slice(0, start), ...head, ...rest].join(eol);
}

function updateStatusLine(path, text, { pattern, replacement }, version, date) {
  const matches = text.match(pattern) ?? [];
  if (matches.length !== 1) {
    throw new Error(`${path} 的狀態行應恰好 1 處，實際 ${matches.length} 處（樣式 ${pattern}）`);
  }
  return text.replace(pattern, replacement(version, date));
}

/**
 * 算出所有要寫的新內容（不寫檔）。files：{相對路徑: 原內容}；tags：既有 tag 清單。
 * 回傳 {相對路徑: 新內容}；任何檢查不過就 throw。
 */
export function planRelease({ version, date, files, tags }) {
  const parts = parseVersion(version ?? '');
  if (!parts) {
    throw new Error(`版號形式不符 X.Y.Z（不帶 v、無前導零）：${version}`);
  }
  if (!DATE_RE.test(date ?? '')) {
    throw new Error(`日期形式不符 YYYY-MM-DD：${date}`);
  }
  const latest = maxReleaseTag(tags);
  if (latest && compareVersions(parts, parseVersion(latest.slice(1))) <= 0) {
    throw new Error(`版號 ${version} 必須大於既有最大 tag ${latest}`);
  }

  const out = {};
  for (const path of PACKAGE_FILES) {
    out[path] = bumpPackageJson(path, files[path], version);
  }
  out[CHANGELOG_FILE] = rollChangelog(files[CHANGELOG_FILE], version, date);
  for (const [path, rule] of Object.entries(README_FILES)) {
    out[path] = updateStatusLine(path, files[path], rule, version, date);
  }
  return out;
}

function gitTags(root) {
  return execFileSync('git', ['tag', '-l', 'v*'], { cwd: root, encoding: 'utf8' })
    .split(/\r?\n/)
    .filter(Boolean);
}

/** 讀檔→planRelease→全部算好才寫檔。tags 未給時唯讀呼叫 `git tag -l 'v*'`。 */
export function runReleasePrepare({ root, version, date = localDate(), tags }) {
  const paths = [...PACKAGE_FILES, CHANGELOG_FILE, ...Object.keys(README_FILES)];
  const files = {};
  for (const path of paths) {
    files[path] = readFileSync(join(root, path), 'utf8');
  }
  const out = planRelease({ version, date, files, tags: tags ?? gitTags(root) });
  for (const path of paths) {
    writeFileSync(join(root, path), out[path], 'utf8');
  }
  return { version, date, paths };
}

export function parseArgs(argv) {
  const args = argv.slice(2);
  let version;
  let date;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--date') {
      date = args[i + 1];
      if (date === undefined || date.startsWith('-')) {
        throw new Error('--date 後面要接日期（YYYY-MM-DD）');
      }
      i += 1;
    } else if (version === undefined) {
      version = args[i];
    } else {
      throw new Error(`多餘的參數：${args[i]}`);
    }
  }
  if (!version) {
    throw new Error('用法：pnpm release:prepare X.Y.Z [--date YYYY-MM-DD]');
  }
  return { version, date };
}

function main(argv) {
  const { version, date } = parseArgs(argv);
  const root = fileURLToPath(new URL('..', import.meta.url));
  const result = runReleasePrepare({ root, version, ...(date ? { date } : {}) });
  const branch = `chore/release-v${version}`;
  console.log(`已更新到 v${version}（${result.date}）：\n${result.paths.map((p) => `  ${p}`).join('\n')}`);
  console.log(`
版號是跟「本機」的 tag 比的；若沒 fetch 過，先 \`git fetch --tags\` 再確認一次。
還要自己看過：README 功能描述與升級提示、docs/self-hosting.md 的升級段、CHANGELOG 該版內容。
接著（範例）：
  git switch -c ${branch}
  git add ${result.paths.join(' ')}
  git commit -m "chore(release): v${version}"
  git push -u origin ${branch}
  gh pr create --base main --title "chore(release): v${version}" --body "發版 v${version}。"
PR merge 進 main、CI（含 e2e）全綠後，release workflow 會自動打 tag v${version}、發 GitHub Release、推 GHCR 映像。`);
}

// 直接執行時才跑 CLI；被 test import 時不跑。
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
