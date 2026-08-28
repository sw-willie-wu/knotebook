#!/usr/bin/env node
// scripts/check-licenses.mjs
//
// CI 授權檢查：
//   1. `pnpm licenses list --json` 掃全部（prod + dev，不加 --prod）依賴的授權，
//      任何授權名稱含 GPL（含 LGPL，從嚴比對）一律擋下，除非明列在 EXEMPTIONS。
//   2. 同一份輸出裡歸在 "Unknown" 授權的套件也一律擋下，除非明列在 UNKNOWN_ACKNOWLEDGED。
//   3. `pnpm ls -r --depth Infinity --json` 掃整個 workspace 的完整依賴樹
//      （dependencies + devDependencies + optionalDependencies，含巢狀），
//      拒絕任何 `@blocknote/xl-` 前綴的套件（BlockNote 商業版擴充，非 OSS 授權）。
//
// 全程 fail-closed：兩支 pnpm 指令的輸出形狀不符預期（例如 pnpm 版本升級改了輸出格式、
// --depth 沒吃到、CLI 印出非預期的警告污染 stdout 導致 JSON 截斷等）一律 throw 而非放行；
// 另外用「掃到的依賴總數」下限檢查擋「指令跑起來但實際上沒掃到東西」這種靜默退化。
//
// 任一檢查失敗都會列出違規套件名稱並以 exit 1 結束。

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const IS_WINDOWS = process.platform === 'win32';

// 掃到的依賴總數低於此值視為異常（--depth 沒吃到、輸出被截斷、workspace 讀空等），
// 直接 throw 而非放行。這份 repo 目前實測 licenses 條目與 ls 依賴節點數都遠超過百，
// 20 是刻意抓低的下限，只用來擋「明顯退化」而非追蹤真實數量。
const MIN_EXPECTED_DEPENDENCY_COUNT = 20;

// 授權豁免清單：預設留空。若要豁免某個 GPL 系列套件，加入套件名稱字串，並在旁以
// 行內註解附上理由與審查依據，例如：
//   const EXEMPTIONS = ['some-lgpl-lib' /* 僅建置期工具，不隨產出物散布，法務 2026-08-06 核准 */];
// 不得只是把套件名稱塞進陣列就算數——理由是必要的，且必須經人工審查。
/** @type {string[]} */
const EXEMPTIONS = [];

// Unknown 授權（pnpm 無法辨識授權欄位）確認清單：預設留空。初始清單＝實際跑
// `pnpm licenses list --json` 當下 "Unknown" 桶內的套件集合；目前該桶是空的，
// 所以留空陣列。若之後真的出現 Unknown 授權的套件且經人工確認可接受，比照
// EXEMPTIONS 的規則，加入套件名稱並附行內註解理由。
/** @type {string[]} */
const UNKNOWN_ACKNOWLEDGED = [
  // khroma 是 mermaid（#94 圖表 block）的直接相依。它的 package.json **沒有 license 欄位**
  // （npm registry 上同樣沒有），所以 pnpm 只能歸進 Unknown 桶——但套件內含一份 `license`
  // 檔，內容是完整的 MIT（"The MIT License (MIT)" + 標準 "Permission is hereby granted,
  // free of charge" 條款，Copyright 2019-present Fabio Spampinato, Andrew Maney）。
  // 也就是說這是 **metadata 缺漏，不是授權不明**。MIT 與本專案（MIT）相容且無傳染性。
  // 2026-08-27 人工核對 khroma@2.1.0 的 license 檔全文後由 Willie 核可。
  // ⚠ 升級 mermaid 導致 khroma 換版時，要重新確認新版仍附 MIT license 檔。
  'khroma',
];

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {unknown}
 */
export function runJson(command, args) {
  // Windows 上 pnpm 是 .cmd shim，`execFileSync` 需要 `shell: true` 才能找到並執行它；
  // 為避免 Node 對「shell:true + args 陣列」的棄用警告，改用單一字串下指令。
  // command/args 皆為腳本內寫死的常數（非外部輸入），無注入風險。
  const output = execFileSync(IS_WINDOWS ? `${command} ${args.join(' ')}` : command, IS_WINDOWS ? [] : args, {
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 64,
    shell: IS_WINDOWS,
  });
  return JSON.parse(output);
}

/**
 * 驗證 `pnpm licenses list --json` 輸出形狀：非空 plain object，且每個 value 是陣列。
 * 不符合就 throw（fail-closed）——形狀跑掉代表 pnpm 版本／輸出格式變了，
 * 不能默默放行讓授權檢查形同虛設。
 * @param {unknown} value
 * @returns {asserts value is Record<string, Array<{ name: string; license?: string }>>}
 */
export function assertLicensesShape(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      'check-licenses: `pnpm licenses list --json` 輸出形狀不符預期（應為非空 plain object，key 為授權名稱）。',
    );
  }

  const entries = Object.entries(value);
  if (entries.length === 0) {
    throw new Error('check-licenses: `pnpm licenses list --json` 輸出是空物件，疑似掃描退化，拒絕放行。');
  }

  for (const [licenseName, packages] of entries) {
    if (!Array.isArray(packages)) {
      throw new Error(
        `check-licenses: \`pnpm licenses list --json\` 輸出形狀不符預期（key "${licenseName}" 的 value 不是陣列）。`,
      );
    }
  }
}

/**
 * 驗證 `pnpm ls -r --depth Infinity --json` 輸出形狀：非空陣列，且每個元素帶 name。
 * 不符合就 throw（fail-closed）。
 * @param {unknown} value
 * @returns {asserts value is Array<{ name: string; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; optionalDependencies?: Record<string, unknown> }>}
 */
export function assertWorkspacePackagesShape(value) {
  if (!Array.isArray(value)) {
    throw new Error(
      'check-licenses: `pnpm ls -r --depth Infinity --json` 輸出形狀不符預期（應為陣列，一個 workspace package 一個元素）。',
    );
  }

  if (value.length === 0) {
    throw new Error('check-licenses: `pnpm ls -r --depth Infinity --json` 輸出是空陣列，疑似 workspace 讀空，拒絕放行。');
  }

  for (const [index, pkg] of value.entries()) {
    if (typeof pkg !== 'object' || pkg === null || typeof pkg.name !== 'string' || pkg.name.length === 0) {
      throw new Error(
        `check-licenses: \`pnpm ls -r --depth Infinity --json\` 輸出形狀不符預期（索引 ${index} 的元素缺少 name）。`,
      );
    }
  }
}

/**
 * pnpm licenses list --json 輸出以「授權名稱」為 key 的物件：
 *   { "MIT": [{ name, versions, paths, license, ... }], "GPL-3.0": [...], ... }
 * @param {Record<string, Array<{ name: string; license?: string }>>} licensesByName
 */
export function findGplViolations(licensesByName) {
  /** @type {string[]} */
  const violations = [];

  for (const [licenseName, packages] of Object.entries(licensesByName)) {
    if (!/GPL/i.test(licenseName)) continue;

    for (const pkg of packages) {
      if (EXEMPTIONS.includes(pkg.name)) continue;
      violations.push(`${pkg.name} (${licenseName})`);
    }
  }

  return violations;
}

/**
 * pnpm 對辨識不出授權欄位的套件會歸在 "Unknown" 這個 key 底下；一律擋下除非在
 * UNKNOWN_ACKNOWLEDGED 白名單內。
 * @param {Record<string, Array<{ name: string; license?: string }>>} licensesByName
 */
export function findUnknownLicenseViolations(licensesByName) {
  /** @type {string[]} */
  const violations = [];

  for (const [licenseName, packages] of Object.entries(licensesByName)) {
    if (licenseName.trim().toLowerCase() !== 'unknown') continue;

    for (const pkg of packages) {
      if (UNKNOWN_ACKNOWLEDGED.includes(pkg.name)) continue;
      violations.push(pkg.name);
    }
  }

  return violations;
}

/**
 * 統計 licenses list 輸出裡總共列出多少套件條目（跨所有授權桶加總），
 * 用來配合 MIN_EXPECTED_DEPENDENCY_COUNT 擋掃描退化。
 * @param {Record<string, Array<{ name: string; license?: string }>>} licensesByName
 */
export function countLicensedPackages(licensesByName) {
  return Object.values(licensesByName).reduce((sum, packages) => sum + packages.length, 0);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; optionalDependencies?: Record<string, unknown> }>}
 */
function isDependencyMap(value) {
  return typeof value === 'object' && value !== null;
}

/**
 * 遞迴走訪一份依賴子樹（--depth Infinity 使每個依賴項目自身可能再帶巢狀
 * dependencies / devDependencies / optionalDependencies）。
 * @param {Record<string, unknown>} depMap
 * @param {Set<string>} blocknoteXlFound
 * @param {Set<string>} allNodeNames
 */
function walkDependencyTree(depMap, blocknoteXlFound, allNodeNames) {
  for (const [depName, depInfo] of Object.entries(depMap)) {
    allNodeNames.add(depName);

    if (depName.startsWith('@blocknote/xl-')) {
      blocknoteXlFound.add(depName);
    }

    if (isDependencyMap(depInfo)) {
      const nested = depInfo;
      if (nested.dependencies) walkDependencyTree(nested.dependencies, blocknoteXlFound, allNodeNames);
      if (nested.devDependencies) walkDependencyTree(nested.devDependencies, blocknoteXlFound, allNodeNames);
      if (nested.optionalDependencies) walkDependencyTree(nested.optionalDependencies, blocknoteXlFound, allNodeNames);
    }
  }
}

/**
 * 走訪整個 workspace 的依賴樹（每個 package 的 dependencies / devDependencies /
 * optionalDependencies，含巢狀），回傳 @blocknote/xl- 違規清單與掃到的依賴節點總數
 * （去重後，用於 MIN_EXPECTED_DEPENDENCY_COUNT 下限檢查）。
 * @param {Array<{ name?: string; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; optionalDependencies?: Record<string, unknown> }>} packages
 */
export function analyzeWorkspaceDependencyTree(packages) {
  const blocknoteXlFound = new Set();
  const allNodeNames = new Set();

  for (const pkg of packages) {
    if (pkg.dependencies) walkDependencyTree(pkg.dependencies, blocknoteXlFound, allNodeNames);
    if (pkg.devDependencies) walkDependencyTree(pkg.devDependencies, blocknoteXlFound, allNodeNames);
    if (pkg.optionalDependencies) walkDependencyTree(pkg.optionalDependencies, blocknoteXlFound, allNodeNames);
  }

  return {
    blocknoteXlViolations: [...blocknoteXlFound],
    totalDependencyNodes: allNodeNames.size,
  };
}

export function main() {
  let hasViolations = false;

  const licensesByNameRaw = runJson('pnpm', ['--loglevel', 'error', 'licenses', 'list', '--json']);
  assertLicensesShape(licensesByNameRaw);
  const licensesByName = licensesByNameRaw;

  const totalLicensedPackages = countLicensedPackages(licensesByName);
  if (totalLicensedPackages < MIN_EXPECTED_DEPENDENCY_COUNT) {
    throw new Error(
      `check-licenses: \`pnpm licenses list --json\` 只掃到 ${totalLicensedPackages} 個套件條目，` +
        `低於下限 ${MIN_EXPECTED_DEPENDENCY_COUNT}，疑似掃描退化，拒絕放行。`,
    );
  }

  const gplViolations = findGplViolations(licensesByName);
  if (gplViolations.length > 0) {
    hasViolations = true;
    console.error('GPL 系列授權（含 LGPL）依賴被禁止使用：');
    for (const violation of gplViolations) {
      console.error(`  - ${violation}`);
    }
    console.error(
      '若確認可豁免，須於 scripts/check-licenses.mjs 的 EXEMPTIONS 附上套件名稱與理由，並經人工審查。',
    );
  }

  const unknownViolations = findUnknownLicenseViolations(licensesByName);
  if (unknownViolations.length > 0) {
    hasViolations = true;
    console.error('授權無法辨識（Unknown）的依賴被禁止使用：');
    for (const pkgName of unknownViolations) {
      console.error(`  - ${pkgName}`);
    }
    console.error(
      '若確認可接受，須於 scripts/check-licenses.mjs 的 UNKNOWN_ACKNOWLEDGED 附上套件名稱與理由，並經人工審查。',
    );
  }

  const workspacePackagesRaw = runJson('pnpm', ['--loglevel', 'error', 'ls', '-r', '--depth', 'Infinity', '--json']);
  assertWorkspacePackagesShape(workspacePackagesRaw);
  const workspacePackages = workspacePackagesRaw;

  const { blocknoteXlViolations, totalDependencyNodes } = analyzeWorkspaceDependencyTree(workspacePackages);
  if (totalDependencyNodes < MIN_EXPECTED_DEPENDENCY_COUNT) {
    throw new Error(
      `check-licenses: \`pnpm ls -r --depth Infinity --json\` 只掃到 ${totalDependencyNodes} 個依賴節點，` +
        `低於下限 ${MIN_EXPECTED_DEPENDENCY_COUNT}，疑似 --depth 沒吃到或掃描退化，拒絕放行。`,
    );
  }

  if (blocknoteXlViolations.length > 0) {
    hasViolations = true;
    console.error('禁止的 @blocknote/xl- 前綴（商業版）依賴：');
    for (const violation of blocknoteXlViolations) {
      console.error(`  - ${violation}`);
    }
  }

  if (hasViolations) {
    process.exit(1);
  }

  console.log(
    `check-licenses: OK（${totalLicensedPackages} 個授權條目、${totalDependencyNodes} 個依賴節點；` +
      '無 GPL/LGPL、無 Unknown 授權、無 @blocknote/xl- 依賴）',
  );
}

const isMainModule = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  main();
}
