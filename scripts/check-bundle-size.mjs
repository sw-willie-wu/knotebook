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
//   3. 其餘 lazy chunk 存在：mermaid（#94）、shiki（#96）、AdminPage（#201）、簡報層（#229）——理由各見常數註解。
//
// 全程 fail-closed：dist 不存在、找不到 entry、找到多個 entry，一律 throw 而非放行
// ——「沒東西可檢查」不等於「檢查通過」（比照 check-licenses.mjs 的紀律）。
//
// 任一檢查失敗 exit 1 並列出實際尺寸/檔名。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// #201（2026-10-07）：#187 登入服務圖示曾讓首包到 725,101 bytes、上限暫調 720 KiB；站台管理、
// 設定 modal 各區、登入流程四頁（註冊／帳號連結／改密碼／OAuth 同意）改 lazy 後首包約 616 KB，
// 上限調回 700 KiB。再逼近時先找下一批可 lazy 的頁面，不要再調高上限。
export const MAX_ENTRY_BYTES = 700 * 1024;
export const ENTRY_RE = /^index-[A-Za-z0-9_-]+\.js$/;
export const NOTEPAGE_RE = /^NotePage-[A-Za-z0-9_-]+\.js$/;
// issue #94：mermaid 必須留在自己的 chunk 裡。它連同相依（cytoscape／katex／langium…）
// 是這個 app 最大的單一相依，靜態 import 會把它整包壓進 NotePage chunk，讓每個開筆記的人
// 都付這個代價，即使整份筆記一張圖都沒有。`lib/mermaid.ts` 是唯一允許 import 它的地方，
// 且必須是 `import("mermaid")`。
// ⚠ 這條守衛的判準是**「mermaid.core chunk 存在」**，不是「entry/NotePage 裡沒有 mermaid
// 字樣」——後者本來就不會是 0（i18n key、block type、對 chunk 的動態 import 參照都會命中；
// 2026-08-28 實測 entry 6 次、NotePage 19 次）。存在性之所以夠用：只要有人在 `lib/mermaid.ts`
// 以外靜態 import mermaid，Rollup 就會把它併回引用它的 chunk，這個獨立 chunk 隨即消失。
export const MERMAID_RE = /^mermaid\.core-[A-Za-z0-9_-]+\.js$/;
// issue #96：shiki 同 mermaid 的理由必須留在自己的 chunk（唯一允許 import 它的地方是
// `lib/code-highlight.ts` 的 `import("shiki")`）。chunk 名 shiki-<hash> 來自
// vite.config.ts 的 chunkFileNames：shiki 套件入口檔叫 index.mjs，Rollup 預設以檔名
// 命名 chunk 會產出第二個 index-<hash>.js、撞上上面 ENTRY_RE 的「恰一個 entry」偵測。
export const SHIKI_RE = /^shiki-[A-Za-z0-9_-]+\.js$/;
// issue #201：站台管理頁（連同 users／ai／auth 三個子區塊）必須是自己的 lazy chunk——
// 大多數使用者從不打開它，卻曾佔首包約 60 KB。App.tsx 的 `lazy(() => import("./pages/AdminPage"))`
// 是唯一允許 import 它的地方；子區塊只被 AdminPage.tsx 靜態 import（它們的 route 是 AdminPage
// 裡的 descendant <Routes>）。判準同 mermaid：任何靜態 import 都會讓 Rollup 把它併回 entry，
// 這個 chunk 隨即消失。
export const ADMINPAGE_RE = /^AdminPage-[A-Za-z0-9_-]+\.js$/;
// issue #229：簡報層（reveal.js、reveal.css、DOMPurify 的使用端、presentationSchema、present.css）必須是自己的
// lazy chunk——只有按「簡報模式」的人才付這個代價。`apps/web/src/present/lazy.ts` 的
// `lazy(() => import("./PresentationOverlay"))` 是唯一允許 import 它的地方：PresentationOverlay 被別處靜態 import
// 時 Rollup 把它併回引用它的 chunk，這個獨立 chunk 消失（gate r1-p3 C 案實跑）。⚠ 這條**抓不到** reveal.js 本身被
// 別處靜態 import——那時 reveal 被拆進引用者或共用 chunk（gate r2-p3 實測拆成獨立的 reveal-*.js）、overlay chunk
// 縮小但仍在（r1-p3 B 案）；那一形由下面的
// REVEAL_MARKER 檢查負責。
export const PRESENTATION_RE = /^PresentationOverlay-[A-Za-z0-9_-]+\.js$/;
// 首包 CSS：reveal.css 的 `.reveal-viewport` 規則（寫死黑字白底）若出現在這裡＝reveal.css 被靜態 import 進首包。
export const ENTRY_CSS_RE = /^index-[A-Za-z0-9_-]+\.css$/;
// reveal.js 的 JS 會寫 `reveal-viewport` 這個 class 名；入口側的外殼與其他程式碼都不用它。這個字串只准出現在
// PresentationOverlay-*.js——出現在別的 JS chunk＝reveal.js 被簡報 lazy 鏈以外的地方靜態 import（spec §6.2）。
export const REVEAL_MARKER = 'reveal-viewport';
// #229 Q1：shiki 的 chunk 名（index 形由 vite.config.ts 改名成 shiki-*；正常 build 全量已併進 shiki-*，只有 shiki 被
// 靜態 import 時才會另拆出 bundle-full-*——gate r2-p3 實測，所以兩個都要擋）。簡報 chunk 的
// **靜態** import 閉包不得碰到它們——shiki 只能經 lib/code-highlight.ts 的 import("shiki") 動態載入。
export const SHIKI_BUNDLE_RE = /^bundle-full-[A-Za-z0-9_-]+\.js$/;
// Vite 產物裡同目錄 chunk 的靜態 import 形：`from"./X.js"`、`import"./X.js"`（不含動態的 `import("./X.js")`——
// `import` 後面緊接引號才算）。
const STATIC_IMPORT_RE = /(?:\bfrom\s*|\bimport\s*)["']\.\/([^"']+\.js)["']/g;

/** 從 start 起遞迴收集同目錄 chunk 的靜態 import 閉包（以檔名判斷，不看內容字串：共用 chunk 的 __vite__mapDeps 會列出別的檔名）。 */
export function staticImportClosure(assetsDir, start) {
  const seen = new Set();
  const queue = [start];
  while (queue.length > 0) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    let source;
    try {
      source = readFileSync(join(assetsDir, name), 'utf8');
    } catch {
      continue;
    }
    for (const match of source.matchAll(STATIC_IMPORT_RE)) queue.push(match[1]);
  }
  return seen;
}

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

  const shikiChunks = names.filter(name => SHIKI_RE.test(name));
  if (shikiChunks.length === 0) {
    throw new Error(
      `找不到 shiki 的 lazy chunk（shiki-<hash>.js）——最可能的原因是有人在 ` +
        `\`lib/code-highlight.ts\` 以外的地方靜態 import 了 shiki，使它被併回 entry/NotePage ` +
        `（issue #96 的迴歸）；若是 chunk 命名變了（vite.config.ts 的 chunkFileNames），請同步更新 pattern，不要刪檢查`
    );
  }

  const adminPageChunks = names.filter(name => ADMINPAGE_RE.test(name));
  if (adminPageChunks.length === 0) {
    throw new Error(
      `找不到站台管理頁的 lazy chunk（AdminPage-<hash>.js）——最可能的原因是有人在 App.tsx 的 ` +
        `\`lazy(() => import("./pages/AdminPage"))\` 以外靜態 import 了 AdminPage，使它被併回 entry ` +
        `（issue #201 的迴歸）；若是 rollup 改了 chunk 命名慣例，請更新本檢查的 pattern，不要刪檢查`
    );
  }

  const presentationChunks = names.filter(name => PRESENTATION_RE.test(name));
  if (presentationChunks.length === 0) {
    throw new Error(
      `找不到簡報層的 lazy chunk（PresentationOverlay-<hash>.js）——最可能的原因是有人在 present/lazy.ts 以外 ` +
        `靜態 import 了 PresentationOverlay（issue #229 的迴歸）；若是 rollup 改了 chunk 命名慣例，請更新本檢查的 pattern，不要刪檢查`
    );
  }

  for (const name of names.filter(n => n.endsWith('.js') && !PRESENTATION_RE.test(n))) {
    if (readFileSync(join(assetsDir, name), 'utf8').includes(REVEAL_MARKER)) {
      throw new Error(
        `${name} 含 ${REVEAL_MARKER}——reveal.js 被簡報 lazy 鏈以外的地方靜態 import（issue #229：reveal 只能經 ` +
          `present/lazy.ts → PresentationOverlay 載入）`
      );
    }
  }

  for (const chunk of presentationChunks) {
    const shikiHits = [...staticImportClosure(assetsDir, chunk)].filter(n => SHIKI_RE.test(n) || SHIKI_BUNDLE_RE.test(n));
    if (shikiHits.length > 0) {
      throw new Error(
        `簡報層 chunk ${chunk} 的靜態 import 閉包碰到 shiki：[${shikiHits.join(', ')}]——shiki 只能經 ` +
          `lib/code-highlight.ts 的 import("shiki") 動態載入（issue #229 Q1）`
      );
    }
  }

  for (const cssName of names.filter(name => ENTRY_CSS_RE.test(name))) {
    if (readFileSync(join(assetsDir, cssName), 'utf8').includes('.reveal-viewport')) {
      throw new Error(`entry CSS ${cssName} 含 .reveal-viewport——reveal.css 被靜態 import 進首包（issue #229 的迴歸）`);
    }
  }

  return { entryName, entryBytes, notePageChunks, mermaidChunks, shikiChunks, adminPageChunks, presentationChunks };
}

// 直接執行（非被 import）時跑真的 dist。
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const assetsDir = join(process.cwd(), 'apps', 'web', 'dist', 'assets');
  try {
    const result = checkBundleSize(assetsDir);
    console.log(
      `bundle OK：entry ${result.entryName} = ${result.entryBytes} bytes（上限 ${MAX_ENTRY_BYTES}）；` +
        `lazy chunk：${result.notePageChunks.join(', ')}、${result.mermaidChunks.join(', ')}、${result.shikiChunks.join(', ')}、` +
        `${result.adminPageChunks.join(', ')}、${result.presentationChunks.join(', ')}`
    );
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
}
