#!/usr/bin/env node
// scripts/check-bundle-size.mjs
//
// CI bundle 尺寸檢查（issue #19）：`pnpm build` 之後對 apps/web/dist/assets 驗兩件事——
//   1. entry chunk（index-<hash>.js）的未壓縮尺寸 ≤ MAX_ENTRY_BYTES。lazy split 前
//      entry 是 1,629 KB（BlockNote＋共編整條鏈都在首包）；切出去後 ~540 KB。上限取
//      700 KB：留 ~30% 正常成長餘地，但任何「把 NotePage/BlockNote 又靜態 import 回
//      首包」的迴歸（+1MB 級）必然撞牆。
//   2. NotePage 的 lazy chunk（NotePage-<hash>.js）存在——entry 上限擋「胖回去」，
//      這條擋「切分本身被拿掉」（若某天 rollup 改了 chunk 命名慣例，這裡會紅，
//      屆時把 pattern 跟著改，別直接刪檢查）。
//
// 全程 fail-closed：dist 不存在、找不到 entry、找到多個 entry，一律 throw 而非放行
// ——「沒東西可檢查」不等於「檢查通過」（比照 check-licenses.mjs 的紀律）。
//
// 任一檢查失敗 exit 1 並列出實際尺寸/檔名。

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const MAX_ENTRY_BYTES = 700 * 1024;
export const ENTRY_RE = /^index-[A-Za-z0-9_-]+\.js$/;
export const NOTEPAGE_RE = /^NotePage-[A-Za-z0-9_-]+\.js$/;
// issue #94：mermaid 必須留在自己的 chunk 裡。它連同相依（cytoscape／katex／langium…）
// 是這個 app 最大的單一相依，靜態 import 會把它整包壓進 NotePage chunk，讓每個開筆記的人
// 都付這個代價，即使整份筆記一張圖都沒有。`lib/mermaid.ts` 是唯一允許 import 它的地方，
// 且必須是 `import("mermaid")`。實測（2026-08-27）：entry 與 NotePage chunk 內 mermaid
// 標記數為 0，NotePage 只留下對這個 chunk 的動態 import 參照。
export const MERMAID_RE = /^mermaid\.core-[A-Za-z0-9_-]+\.js$/;

/**
 * 對指定 assets 目錄跑檢查。回傳檢查通過的摘要；違規 throw（訊息含實際數字）。
 * 抽成函式供 `check-bundle-size.test.mjs` 以假目錄直接測邏輯，不必真的 build。
 */
export function checkBundleSize(assetsDir, { maxEntryBytes = MAX_ENTRY_BYTES } = {}) {
  let names;
  try {
    names = readdirSync(assetsDir);
  } catch {
    throw new Error(`讀不到 ${assetsDir}——先跑 pnpm build（本檢查只能在 build 產物上執行）`);
  }

  const entries = names.filter(name => ENTRY_RE.test(name));
  if (entries.length !== 1) {
    throw new Error(`預期恰一個 entry chunk（index-<hash>.js），實得 ${entries.length}：[${entries.join(', ')}]`);
  }
  const entryName = entries[0];
  const entryBytes = statSync(join(assetsDir, entryName)).size;
  if (entryBytes > maxEntryBytes) {
    throw new Error(
      `entry chunk ${entryName} 是 ${entryBytes} bytes，超過上限 ${maxEntryBytes}——` +
        `最可能的原因是 NotePage/BlockNote 被靜態 import 回首包（issue #19 的迴歸）`
    );
  }

  const notePageChunks = names.filter(name => NOTEPAGE_RE.test(name));
  if (notePageChunks.length === 0) {
    throw new Error(
      `找不到 NotePage 的 lazy chunk（NotePage-<hash>.js）——lazy split 被拿掉了，` +
        `或 rollup 改了 chunk 命名慣例（後者請更新本檢查的 pattern，不要刪檢查）`
    );
  }

  const mermaidChunks = names.filter(name => MERMAID_RE.test(name));
  if (mermaidChunks.length === 0) {
    throw new Error(
      `找不到 mermaid 的 lazy chunk（mermaid.core-<hash>.js）——最可能的原因是有人在 ` +
        `\`lib/mermaid.ts\` 以外的地方靜態 import 了 mermaid，使它被併進 NotePage/entry chunk ` +
        `（issue #94 的迴歸）；若是 rollup 改了 chunk 命名慣例，請更新本檢查的 pattern，不要刪檢查`
    );
  }

  return { entryName, entryBytes, notePageChunks, mermaidChunks };
}

// 直接執行（非被 import）時跑真的 dist。
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const assetsDir = join(process.cwd(), 'apps', 'web', 'dist', 'assets');
  try {
    const result = checkBundleSize(assetsDir);
    console.log(
      `bundle OK：entry ${result.entryName} = ${result.entryBytes} bytes（上限 ${MAX_ENTRY_BYTES}）；` +
        `lazy chunk：${result.notePageChunks.join(', ')}、${result.mermaidChunks.join(', ')}`
    );
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
}
