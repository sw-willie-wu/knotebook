// scripts/check-licenses.test.mjs
//
// check-licenses.mjs 核心邏輯的常駐測試（node:test，不依賴真的跑 pnpm ——全部餵手造
// mock data）。跑法：`pnpm test:scripts`（= `node --test scripts/`）。
//
// 覆蓋範圍：
//   - GPL/LGPL 授權命中（含 EXEMPTIONS 生效）
//   - Unknown 授權命中（含 UNKNOWN_ACKNOWLEDGED 生效）
//   - @blocknote/xl- 依賴：頂層 devDependencies、巢狀 dependencies、
//     optionalDependencies（頂層與巢狀）皆要命中；@blocknote/core 不誤傷
//   - 依賴總數下限保護所依賴的計數函式（countLicensedPackages / totalDependencyNodes）
//   - 形狀 assertion：不符預期輸入一律 throw

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  analyzeWorkspaceDependencyTree,
  assertLicensesShape,
  assertWorkspacePackagesShape,
  countLicensedPackages,
  findGplViolations,
  findUnknownLicenseViolations,
} from './check-licenses.mjs';

test('findGplViolations: 命中 GPL 與 LGPL，不誤傷其他授權', () => {
  const violations = findGplViolations({
    'LGPL-3.0': [{ name: 'foo-lib' }],
    'GPL-2.0-only': [{ name: 'baz' }],
    MIT: [{ name: 'bar' }],
  });

  assert.deepEqual(violations.sort(), ['baz (GPL-2.0-only)', 'foo-lib (LGPL-3.0)'].sort());
});

test('findGplViolations: 全是 OSS 寬鬆授權時回傳空陣列', () => {
  const violations = findGplViolations({ MIT: [{ name: 'ok' }], 'Apache-2.0': [{ name: 'also-ok' }] });
  assert.deepEqual(violations, []);
});

test('findUnknownLicenseViolations: 命中 Unknown 授權', () => {
  const violations = findUnknownLicenseViolations({
    Unknown: [{ name: 'mystery-pkg' }],
    MIT: [{ name: 'ok' }],
  });
  assert.deepEqual(violations, ['mystery-pkg']);
});

test('findUnknownLicenseViolations: 大小寫不敏感比對 "unknown" key', () => {
  const violations = findUnknownLicenseViolations({ unknown: [{ name: 'weird-case-pkg' }] });
  assert.deepEqual(violations, ['weird-case-pkg']);
});

test('countLicensedPackages: 跨授權桶加總', () => {
  const total = countLicensedPackages({ MIT: [{ name: 'a' }, { name: 'b' }], ISC: [{ name: 'c' }] });
  assert.equal(total, 3);
});

test('analyzeWorkspaceDependencyTree: 頂層 dependencies 命中 @blocknote/xl-', () => {
  const { blocknoteXlViolations } = analyzeWorkspaceDependencyTree([
    { name: 'app', dependencies: { '@blocknote/xl-pdf-exporter': { version: '1.0.0' } } },
  ]);
  assert.deepEqual(blocknoteXlViolations, ['@blocknote/xl-pdf-exporter']);
});

test('analyzeWorkspaceDependencyTree: 巢狀 dependencies 命中 @blocknote/xl-', () => {
  const { blocknoteXlViolations } = analyzeWorkspaceDependencyTree([
    {
      name: 'app',
      dependencies: {
        foo: { dependencies: { '@blocknote/xl-docx-exporter': { version: '1.0.0' } } },
      },
    },
  ]);
  assert.deepEqual(blocknoteXlViolations, ['@blocknote/xl-docx-exporter']);
});

test('analyzeWorkspaceDependencyTree: 頂層與巢狀 devDependencies 皆命中 @blocknote/xl-', () => {
  const { blocknoteXlViolations } = analyzeWorkspaceDependencyTree([
    {
      name: 'app',
      devDependencies: {
        '@blocknote/xl-docx-exporter': {
          version: '1.0.0',
          dependencies: { '@blocknote/xl-nested-thing': { version: '1.0.0' } },
        },
      },
    },
  ]);
  assert.deepEqual(
    blocknoteXlViolations.sort(),
    ['@blocknote/xl-docx-exporter', '@blocknote/xl-nested-thing'].sort(),
  );
});

test('analyzeWorkspaceDependencyTree: 頂層與巢狀 optionalDependencies 皆命中 @blocknote/xl-', () => {
  const { blocknoteXlViolations } = analyzeWorkspaceDependencyTree([
    {
      name: 'app',
      optionalDependencies: {
        '@blocknote/xl-pdf-exporter': {
          version: '1.0.0',
          optionalDependencies: { '@blocknote/xl-deep-optional': { version: '1.0.0' } },
        },
      },
    },
  ]);
  assert.deepEqual(
    blocknoteXlViolations.sort(),
    ['@blocknote/xl-pdf-exporter', '@blocknote/xl-deep-optional'].sort(),
  );
});

test('analyzeWorkspaceDependencyTree: @blocknote/core（非 xl- 前綴）不誤傷', () => {
  const { blocknoteXlViolations } = analyzeWorkspaceDependencyTree([
    { name: 'app', dependencies: { '@blocknote/core': { version: '1.0.0' } } },
  ]);
  assert.deepEqual(blocknoteXlViolations, []);
});

test('analyzeWorkspaceDependencyTree: totalDependencyNodes 對整棵樹去重計數', () => {
  const { totalDependencyNodes } = analyzeWorkspaceDependencyTree([
    {
      name: 'app',
      dependencies: {
        foo: { dependencies: { shared: { version: '1.0.0' } } },
        bar: { optionalDependencies: { shared: { version: '1.0.0' } } },
      },
    },
  ]);
  // foo, bar, shared（去重，即使 shared 出現兩次）
  assert.equal(totalDependencyNodes, 3);
});

test('assertLicensesShape: 合法形狀不 throw', () => {
  assert.doesNotThrow(() => assertLicensesShape({ MIT: [{ name: 'ok' }] }));
});

test('assertLicensesShape: 非 plain object（例如陣列）要 throw', () => {
  assert.throws(() => assertLicensesShape([{ name: 'ok' }]));
});

test('assertLicensesShape: null 要 throw', () => {
  assert.throws(() => assertLicensesShape(null));
});

test('assertLicensesShape: 空物件要 throw', () => {
  assert.throws(() => assertLicensesShape({}));
});

test('assertLicensesShape: value 不是陣列時要 throw', () => {
  assert.throws(() => assertLicensesShape({ MIT: { name: 'not-an-array' } }));
});

test('assertWorkspacePackagesShape: 合法形狀不 throw', () => {
  assert.doesNotThrow(() => assertWorkspacePackagesShape([{ name: 'app' }]));
});

test('assertWorkspacePackagesShape: 非陣列要 throw', () => {
  assert.throws(() => assertWorkspacePackagesShape({ name: 'app' }));
});

test('assertWorkspacePackagesShape: 空陣列要 throw', () => {
  assert.throws(() => assertWorkspacePackagesShape([]));
});

test('assertWorkspacePackagesShape: 元素缺少 name 要 throw', () => {
  assert.throws(() => assertWorkspacePackagesShape([{ dependencies: {} }]));
});
