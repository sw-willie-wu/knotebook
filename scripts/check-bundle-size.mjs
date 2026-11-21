#!/usr/bin/env node
// Fail closed: nothing to check must not count as a pass.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Headroom is a buffer; re-importing NotePage/BlockNote statically (+1 MB) still fails.
export const MAX_ENTRY_BYTES = 750 * 1024;
export const ENTRY_RE = /^index-[A-Za-z0-9_-]+\.js$/;
// Guards that the NotePage split itself isn't removed. If rollup changes chunk naming, update the pattern; don't delete the check.
export const NOTEPAGE_RE = /^NotePage-[A-Za-z0-9_-]+\.js$/;
// Presence of the mermaid chunk is the guard: a static import outside lib/mermaid.ts makes Rollup merge it back and the chunk disappears.
// Counting "mermaid" strings in entry/NotePage can't work: i18n keys and dynamic references match.
export const MERMAID_RE = /^mermaid\.core-[A-Za-z0-9_-]+\.js$/;
// Named shiki-* via chunkFileNames: its index.mjs would otherwise yield a second index-<hash>.js and break the single-entry check.
export const SHIKI_RE = /^shiki-[A-Za-z0-9_-]+\.js$/;
// A static import of AdminSections (or its re-exported sections) merges it into entry and the chunk disappears.
export const ADMINSECTIONS_RE = /^AdminSections-[A-Za-z0-9_-]+\.js$/;
// Presence only catches the whole group merging back or a rename. A static import of one component moves it into the
// caller's chunk (this chunk stays), which VERSIONS_MARKERS catches.
export const VERSIONS_RE = /^VersionsLazy-[A-Za-z0-9_-]+\.js$/;
// Presence misses a static import of reveal.js itself (reveal splits out, this chunk stays); REVEAL_MARKER covers that.
export const PRESENTATION_RE = /^PresentationOverlay-[A-Za-z0-9_-]+\.js$/;
// Presence only catches both mount points going static; a single static import moves the component into entry, which the size cap catches.
export const TRASHLAZY_RE = /^TrashLazy-[A-Za-z0-9_-]+\.js$/;
// Presence only catches all mount points going static or a rename; a single static import moves it into entry, caught by SELECT_I18N_MARKER.
export const SELECTLAZY_RE = /^SelectLazy-[A-Za-z0-9_-]+\.js$/;
// A select.*.json key in entry means the string pack (or a module importing it by value, e.g. lib/select-batch.ts) is statically imported.
export const SELECT_I18N_MARKER = 'deleteSelected_one';
// Presence only catches the whole group merging back or a rename; FOLDER_I18N_MARKER catches a single static import.
export const FOLDERLAZY_RE = /^FolderLazy-[A-Za-z0-9_-]+\.js$/;
// A folders.*.json key in entry means the string pack is statically imported.
export const FOLDER_I18N_MARKER = 'restoreRebuilds';
// Presence only catches the whole group merging back or a rename; SHORTCUTS_I18N_MARKER catches a static import of the list or strings.
export const SHORTCUTSLAZY_RE = /^ShortcutsLazy-[A-Za-z0-9_-]+\.js$/;
// Chosen over ids like heading/wikilink, which already appear in entry as block names.
export const SHORTCUTS_I18N_MARKER = 'columnBackspace';
// helpGuide key used only by the ShortcutsLazy chain.
export const HELP_I18N_MARKER = 'whatsNew';
// mobile-toolbar.*.json key: the string pack must stay in the NotePage chain.
export const MOBILE_TOOLBAR_I18N_MARKER = 'hideKeyboard';
// Presence only catches the whole group merging back or a rename; TOUR_I18N_MARKER catches a static import of a single tour module or the string pack.
export const TOURLAZY_RE = /^TourLazy-[A-Za-z0-9_-]+\.js$/;
// Chosen over keys like next/back, which already appear in entry.
export const TOUR_I18N_MARKER = 'keepOrDeleteSample';
// A tags.manage.* key that lives only in tags.en.json (lazy tag-management strings); in entry means tags-strings is statically imported.
export const TAGS_I18N_MARKER = 'mergeUnavailable';
// A knowledgeIndex.* key that lives only in knowledge-index.en.json (lazy index page strings); in entry means knowledge-index-strings is statically imported.
export const KNOWLEDGE_INDEX_I18N_MARKER = 'backfillNotice';
// Presence only catches the whole group merging back or a rename. The marker is the match rows' data-testid literal
// (unlike i18n copy it is stable; only BodySearchResults.tsx may use it).
export const BODYSEARCHLAZY_RE = /^BodySearchLazy-[A-Za-z0-9_-]+\.js$/;
export const BODY_SEARCH_MARKER = 'body-match';
// The marker is a string literal in the error class of avatars/encode.ts (class names get minified). It must appear only in
// encode-<hash>.js; in any other JS it means encode.ts was merged into that chunk.
export const AVATAR_IMAGE_MARKER = 'AvatarImageError';
export const AVATAR_ENCODE_RE = /^encode-[A-Za-z0-9_-]+\.js$/;
// Both markers are keys that exist only in the moved subtree; also require them in the management-strings chunk so the pack isn't lost.
export const MANAGEMENT_I18N_MARKERS = ['autoCreateConfirmKeep', 'actionBuiltinBadge'];
// Icons used only by lazy UI; a missing chunk means they were merged into entry or the naming changed.
export const ICONS_EXTRA_RE = /^icons-extra-[A-Za-z0-9_-]+.js$/;
export const MANAGEMENT_STRINGS_RE = /^management-strings-[A-Za-z0-9_-]+\.js$/;
// Dialogs mounted only when opened: each must be a lazy chunk whose marker is absent from entry. Presence only catches the whole group
// merging back or a rename; one static call site leaves the chunk in place, which the marker catches. MediaLightbox loads only via lightbox-chunk.ts.
export const GROUP_LAZY_DIALOGS = [
  { name: 'GroupNameDialog', re: /^GroupNameDialog-[A-Za-z0-9_-]+\.js$/, marker: 'groups.dialog.createDescription', source: 'components/groups/GroupNameDialog.tsx' },
  { name: 'DeleteGroupDialog', re: /^DeleteGroupDialog-[A-Za-z0-9_-]+\.js$/, marker: 'groups.delete.transferTrashNote', source: 'components/groups/DeleteGroupDialog.tsx' },
  { name: 'GroupTransferDialog', re: /^GroupTransferDialog-[A-Za-z0-9_-]+\.js$/, marker: 'share.move.openCopyAlt', source: 'components/share/GroupTransferDialog.tsx' },
  { name: 'MediaLightbox', re: /^MediaLightbox-[A-Za-z0-9_-]+\.js$/, marker: 'note.zoom.hint', source: 'components/media-zoom/MediaLightbox.tsx' },
];
// reveal.css's `.reveal-viewport` rule in entry CSS means reveal.css was imported statically.
export const ENTRY_CSS_RE = /^index-[A-Za-z0-9_-]+\.css$/;
// Class name reveal.js writes; only PresentationOverlay-*.js may contain it.
export const REVEAL_MARKER = 'reveal-viewport';
// shiki is renamed shiki-* in vite.config.ts; when imported statically Rollup also emits bundle-full-*, so block both
// from the presentation chunk's static import closure.
export const SHIKI_BUNDLE_RE = /^bundle-full-[A-Za-z0-9_-]+\.js$/;
// Strings unique to each VersionsLazy module. A static import of one component makes Rollup move it into the caller's chunk while
// VersionsLazy stays, so check that no other JS contains them. Keys must be exact: the NotePage Suspense fallback legitimately uses
// versions.preview.loading, versions.bubble and versions.crash.
// u{2DE}- is a regex literal from the `diff` package (survives tree-shaking, unlike its error strings); it also catches SelectionAiPreview, whose
// import of version-diff pulls `diff` along. DiffEditor needs no marker: it doesn't pull in `diff`.
export const VERSIONS_MARKERS = [
  'versions.menu.baseNotDeletable',
  'versions.sheet.backToList',
  'versions.preview.nonTextChanged',
  'versions.preview.split',
  'versions.dialog.applyDiscard',
  'u{2DE}-',
];
const STATIC_IMPORT_RE = /(?:\bfrom\s*|\bimport\s*)["']\.\/([^"']+\.js)["']/g;

// Follows file names only: a shared chunk's __vite__mapDeps lists unrelated file names.
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

  const adminSectionsChunks = names.filter(name => ADMINSECTIONS_RE.test(name));
  if (adminSectionsChunks.length === 0) {
    throw new Error(
      `找不到站台管理區塊的 lazy chunk（AdminSections-<hash>.js）——最可能的原因是有人在 App.tsx 的 ` +
        `\`lazy(() => import("./components/admin/AdminSections"))\` 以外靜態 import 了它或它重新匯出的區塊元件，使它們被併回 entry ` +
        `（issue #201／#247 的迴歸）；若是 rollup 改了 chunk 命名慣例，請更新本檢查的 pattern，不要刪檢查`
    );
  }

  const versionsChunks = names.filter(name => VERSIONS_RE.test(name));
  if (versionsChunks.length === 0) {
    throw new Error(
      `找不到版本歷史的 lazy chunk（VersionsLazy-<hash>.js）——最可能的原因是 ` +
        `整組版本歷史（含 diff 套件）被併回 NotePage／entry，或 rollup 改了 chunk 命名慣例（請更新本檢查的 pattern，不要刪檢查）；` +
        `單一元件被靜態 import 不會讓這個 chunk 消失，那一形由 VERSIONS_MARKERS 檢查負責`
    );
  }

  const presentationChunks = names.filter(name => PRESENTATION_RE.test(name));
  if (presentationChunks.length === 0) {
    throw new Error(
      `找不到簡報層的 lazy chunk（PresentationOverlay-<hash>.js）——最可能的原因是有人在 present/lazy.ts 以外 ` +
        `靜態 import 了 PresentationOverlay（issue #229 的迴歸）；若是 rollup 改了 chunk 命名慣例，請更新本檢查的 pattern，不要刪檢查`
    );
  }

  const trashChunks = names.filter(name => TRASHLAZY_RE.test(name));
  if (trashChunks.length === 0) {
    throw new Error(
      `找不到垃圾桶 tab 的 lazy chunk（TrashLazy-<hash>.js）——最可能的原因是 TrashPanel／TrashFooter 被 ` +
        `\`lazy(() => import("@/components/sidebar/TrashLazy"))\` 以外的地方靜態 import、整組併回 entry（#181）；` +
        `若是 rollup 改了 chunk 命名慣例，請更新本檢查的 pattern，不要刪檢查`
    );
  }

  const selectChunks = names.filter(name => SELECTLAZY_RE.test(name));
  if (selectChunks.length === 0) {
    throw new Error(
      `找不到一般 tab 選取模式的 lazy chunk（SelectLazy-<hash>.js）——最可能的原因是選取 UI 被 ` +
        `\`lazy(() => import("@/components/sidebar/SelectLazy"))\` 以外的地方靜態 import、整組併回 entry（#181 PR-2c）；` +
        `若是 rollup 改了 chunk 命名慣例，請更新本檢查的 pattern，不要刪檢查`
    );
  }
  if (readFileSync(join(assetsDir, entryName), 'utf8').includes(SELECT_I18N_MARKER)) {
    throw new Error(
      `entry chunk ${entryName} 含選取字串包的鍵名 ${SELECT_I18N_MARKER}——\`@/i18n/select-strings\`（或 import 它的選取模組）` +
        `被首包靜態 import；選取 UI 只能經 SelectLazy 載入（#181 PR-2c）`
    );
  }
  const entrySource = readFileSync(join(assetsDir, entryName), 'utf8');
  const managementHit = MANAGEMENT_I18N_MARKERS.find(marker => entrySource.includes(marker));
  if (managementHit) {
    throw new Error(
      `entry chunk ${entryName} 含站台管理／設定字串包的鍵名 ${managementHit}——\`@/i18n/management-strings\`（或 import 它的設定／管理模組）` +
        `被首包靜態 import；這些 UI 只能經 lazy chunk 載入（首包瘦身）`
    );
  }
  const managementChunks = names.filter(name => MANAGEMENT_STRINGS_RE.test(name));
  if (managementChunks.length === 0) {
    throw new Error(
      `找不到站台管理／設定字串包的 lazy chunk（management-strings-<hash>.js）——最可能的原因是字串包被併進別的 chunk，` +
        `或 \`@/i18n/management-strings\` 沒人 import；若是 rollup 改了 chunk 命名慣例，請更新本檢查的 pattern，不要刪檢查`
    );
  }
  const managementMissing = MANAGEMENT_I18N_MARKERS.filter(
    marker => !managementChunks.some(name => readFileSync(join(assetsDir, name), 'utf8').includes(marker))
  );
  if (managementMissing.length > 0) {
    throw new Error(`字串包 chunk [${managementChunks.join(', ')}] 不含鍵名 [${managementMissing.join(', ')}]——management.*.json 的內容沒進包（或鍵改名了，請同步更新 MANAGEMENT_I18N_MARKERS）`);
  }

  const folderChunks = names.filter(name => FOLDERLAZY_RE.test(name));
  if (folderChunks.length === 0) {
    throw new Error(
      `找不到資料夾對話框的 lazy chunk（FolderLazy-<hash>.js）——最可能的原因是對話框被 ` +
        `\`lazy(() => import("@/components/sidebar/FolderLazy"))\` 以外的地方靜態 import、整組併回 entry（資料夾 PR-3b）；` +
        `若是 rollup 改了 chunk 命名慣例，請更新本檢查的 pattern，不要刪檢查`
    );
  }
  if (readFileSync(join(assetsDir, entryName), 'utf8').includes(FOLDER_I18N_MARKER)) {
    throw new Error(
      `entry chunk ${entryName} 含資料夾字串包的鍵名 ${FOLDER_I18N_MARKER}——\`@/i18n/folder-strings\`（或 import 它的資料夾對話框模組）` +
        `被首包靜態 import；資料夾對話框只能經 FolderLazy 載入（資料夾 PR-3b）`
    );
  }

  const shortcutsChunks = names.filter(name => SHORTCUTSLAZY_RE.test(name));
  if (shortcutsChunks.length === 0) {
    throw new Error(
      `找不到快捷鍵介紹頁的 lazy chunk（ShortcutsLazy-<hash>.js）——最可能的原因是清單／字串包／鍵面被 ` +
        `\`lazy(() => import("@/components/shortcuts/ShortcutsLazy"))\` 以外的地方靜態 import、整組併回 entry（快捷鍵介紹）；` +
        `若是 rollup 改了 chunk 命名慣例，請更新本檢查的 pattern，不要刪檢查`
    );
  }
  if (readFileSync(join(assetsDir, entryName), 'utf8').includes(SHORTCUTS_I18N_MARKER)) {
    throw new Error(
      `entry chunk ${entryName} 含快捷鍵字串包的鍵名 ${SHORTCUTS_I18N_MARKER}——\`@/i18n/shortcuts-strings\`（或 import 它的清單／內容模組）` +
        `被首包靜態 import；快捷鍵介紹頁的內容只能經 ShortcutsLazy 載入（快捷鍵介紹）`
    );
  }

  const tourChunks = names.filter(name => TOURLAZY_RE.test(name));
  if (tourChunks.length === 0) {
    throw new Error(
      `找不到功能導覽的 lazy chunk（TourLazy-<hash>.js）——最可能的原因是導覽模組被 ` +
        `TourProvider 的 \`import("./TourLazy")\` 以外的地方靜態 import、整組併回 entry（功能導覽）；` +
        `若是 rollup 改了 chunk 命名慣例，請更新本檢查的 pattern，不要刪檢查`
    );
  }
  if (readFileSync(join(assetsDir, entryName), 'utf8').includes(TOUR_I18N_MARKER)) {
    throw new Error(
      `entry chunk ${entryName} 含導覽字串包的鍵名 ${TOUR_I18N_MARKER}——\`@/i18n/tour-strings\`（或 import 它的導覽模組）` +
        `被首包靜態 import；功能導覽只能經 TourLazy 載入（功能導覽）`
    );
  }

  if (entrySource.includes(TAGS_I18N_MARKER)) {
    throw new Error(
      `entry chunk ${entryName} 含標籤管理字串包的鍵名 ${TAGS_I18N_MARKER}——\`@/i18n/tags-strings\`（或 import 它的標籤管理模組）被首包靜態 import；標籤管理字串只能經 lazy chunk 載入`
    );
  }

  if (entrySource.includes(KNOWLEDGE_INDEX_I18N_MARKER)) {
    throw new Error(
      `entry chunk ${entryName} 含知識索引頁字串包的鍵名 ${KNOWLEDGE_INDEX_I18N_MARKER}——\`@/i18n/knowledge-index-strings\`（或 import 它的索引頁模組）被首包靜態 import；索引頁字串只能經 lazy chunk 載入`
    );
  }

  if (entrySource.includes(HELP_I18N_MARKER)) {
    throw new Error(
      `entry chunk ${entryName} 含說明頁的字串鍵名 ${HELP_I18N_MARKER}——說明頁的內容與字串包只能經 ShortcutsLazy 載入`
    );
  }
  // Static import closure instead of the file alone: the tour string pack is shared with TourLazy, so rollup extracts a shared chunk
  // and ShortcutsLazy keeps only an import line.
  for (const chunk of shortcutsChunks) {
    for (const reached of staticImportClosure(assetsDir, chunk)) {
      const leaked = TOURLAZY_RE.test(reached) ? reached : readFileSync(join(assetsDir, reached), 'utf8').includes(TOUR_I18N_MARKER) ? TOUR_I18N_MARKER : undefined;
      if (leaked !== undefined) {
        throw new Error(
          `說明視窗的 chunk ${chunk} 靜態 import 到導覽的東西（${leaked}，經 ${reached}）——說明視窗只能經首包的 \`useTour()\` 開始導覽，` +
            `不得 import 導覽模組或導覽字串包（\`@/i18n/tour-strings\`）`
        );
      }
    }
  }

  if (readFileSync(join(assetsDir, entryName), 'utf8').includes(MOBILE_TOOLBAR_I18N_MARKER)) {
    throw new Error(
      `entry chunk ${entryName} 含手機編輯工具列字串包的鍵名 ${MOBILE_TOOLBAR_I18N_MARKER}——\`@/i18n/mobile-toolbar-strings\`（或 import 它的工具列模組）` +
        `被首包靜態 import；手機編輯工具列只能放在 NotePage chunk`
    );
  }

  const bodySearchChunks = names.filter(name => BODYSEARCHLAZY_RE.test(name));
  if (bodySearchChunks.length === 0) {
    throw new Error(
      `找不到側欄內文搜尋區的 lazy chunk（BodySearchLazy-<hash>.js）——最可能的原因是內文搜尋區被 ` +
        `\`lazy(() => import("@/components/sidebar/BodySearchLazy"))\` 以外的地方靜態 import、整組併回 entry（#93 PR2）；` +
        `若是 rollup 改了 chunk 命名慣例，請更新本檢查的 pattern，不要刪檢查`
    );
  }
  if (readFileSync(join(assetsDir, entryName), 'utf8').includes(BODY_SEARCH_MARKER)) {
    throw new Error(
      `entry chunk ${entryName} 含內文搜尋區的 marker ${BODY_SEARCH_MARKER}——BodySearchResults（或 import 它的模組）` +
        `被首包靜態 import；內文搜尋區只能經 BodySearchLazy 載入（#93 PR2）`
    );
  }

  if (!names.some(name => ICONS_EXTRA_RE.test(name))) {
    throw new Error(`找不到 icons-extra-<hash>.js——只被 lazy UI 用的圖示被併回 entry，或 rollup 改了 chunk 命名慣例（請更新本檢查的 pattern，不要刪檢查）`);
  }
  const groupDialogChunks = {};
  for (const dialog of GROUP_LAZY_DIALOGS) {
    const chunks = names.filter(name => dialog.re.test(name));
    if (chunks.length === 0) {
      throw new Error(
        `找不到 ${dialog.name} 的 lazy chunk（${dialog.name}-<hash>.js）——最可能的原因是它被 lazy() 動態 import 以外的地方靜態 import、併回 entry；` +
          `若是 rollup 改了 chunk 命名慣例，請更新本檢查的 pattern，不要刪檢查`
      );
    }
    if (readFileSync(join(assetsDir, entryName), 'utf8').includes(dialog.marker)) {
      throw new Error(
        `entry chunk ${entryName} 含 ${dialog.name} 的 marker ${dialog.marker}——${dialog.name}（或 import 它的模組）被首包靜態 import；它只能經 lazy 載入`
      );
    }
    const missing = !chunks.some(name => readFileSync(join(assetsDir, name), 'utf8').includes(dialog.marker));
    if (missing) {
      throw new Error(`${dialog.name} chunk [${chunks.join(', ')}] 不含 marker ${dialog.marker}——對話框的內容沒進這個 chunk（或 marker 改名了，請同步更新 GROUP_LAZY_DIALOGS）`);
    }
    groupDialogChunks[dialog.name] = chunks;
  }

  if (readFileSync(join(assetsDir, entryName), 'utf8').includes(AVATAR_IMAGE_MARKER)) {
    throw new Error(
      `entry chunk ${entryName} 含頭貼影像模組的 marker ${AVATAR_IMAGE_MARKER}——\`avatars/encode.ts\`（或 import 它的模組）` +
        `被首包靜態 import；解碼／編碼不得進首包`
    );
  }
  const avatarMarkerHits = names.filter(n => n.endsWith('.js') && readFileSync(join(assetsDir, n), 'utf8').includes(AVATAR_IMAGE_MARKER));
  const avatarStray = avatarMarkerHits.filter(n => !AVATAR_ENCODE_RE.test(n));
  if (avatarStray.length > 0) {
    throw new Error(
      `${avatarStray.join(', ')} 含頭貼影像模組的 marker ${AVATAR_IMAGE_MARKER}——\`avatars/encode.ts\` 被 \`import("@/avatars/encode")\` 以外的地方靜態 import，` +
        `併進了這個 chunk（解碼／編碼不再是按儲存才下載的獨立 chunk）`
    );
  }
  const avatarEncodeChunks = avatarMarkerHits.filter(n => AVATAR_ENCODE_RE.test(n));
  if (avatarEncodeChunks.length === 0) {
    throw new Error(
      `找不到含 ${AVATAR_IMAGE_MARKER} 的 encode-<hash>.js——頭貼的解碼／編碼模組沒有成為獨立 chunk（裁切框的動態 import 被拿掉，或被靜態 import 併走）；` +
        `若是 rollup 改了 chunk 命名慣例，請更新本檢查的 pattern，不要刪檢查`
    );
  }

  // The marker misses encode becoming a shared chunk (two or more static users): it keeps the name encode-<hash>.js but downloads on page open.
  for (const name of names.filter(n => n.endsWith('.js'))) {
    const source = readFileSync(join(assetsDir, name), 'utf8');
    const staticEncode = [...source.matchAll(STATIC_IMPORT_RE)].map(m => m[1]).filter(n => avatarEncodeChunks.includes(n));
    if (staticEncode.length > 0) {
      throw new Error(
        `${name} 靜態 import 了 ${[...new Set(staticEncode)].join(', ')}——頭貼的解碼／編碼 chunk 只能經 \`import("@/avatars/encode")\` 在按儲存時才載入`
      );
    }
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

  for (const name of names.filter(n => n.endsWith('.js') && !VERSIONS_RE.test(n))) {
    const source = readFileSync(join(assetsDir, name), 'utf8');
    const hit = VERSIONS_MARKERS.find(marker => source.includes(marker));
    if (hit) {
      throw new Error(
        `${name} 含版本歷史模組的字串 ${hit}——VersionsLazy 的元件被 \`lazy(() => import("@/components/versions/VersionsLazy"))\` ` +
          `以外的地方靜態 import，Rollup 把它搬進了這個 chunk（版本歷史＋diff 套件不再是按需下載）`
      );
    }
  }

  for (const cssName of names.filter(name => ENTRY_CSS_RE.test(name))) {
    if (readFileSync(join(assetsDir, cssName), 'utf8').includes('.reveal-viewport')) {
      throw new Error(`entry CSS ${cssName} 含 .reveal-viewport——reveal.css 被靜態 import 進首包（issue #229 的迴歸）`);
    }
  }

  return { entryName, entryBytes, notePageChunks, mermaidChunks, shikiChunks, adminSectionsChunks, versionsChunks, presentationChunks, trashChunks, selectChunks, folderChunks, shortcutsChunks, tourChunks, managementChunks, bodySearchChunks, avatarEncodeChunks, groupDialogChunks };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const assetsDir = join(process.cwd(), 'apps', 'web', 'dist', 'assets');
  try {
    const result = checkBundleSize(assetsDir);
    console.log(
      `bundle OK：entry ${result.entryName} = ${result.entryBytes} bytes（上限 ${MAX_ENTRY_BYTES}）；` +
        `lazy chunk：${result.notePageChunks.join(', ')}、${result.mermaidChunks.join(', ')}、${result.shikiChunks.join(', ')}、` +
        `${result.adminSectionsChunks.join(', ')}、${result.versionsChunks.join(', ')}、${result.presentationChunks.join(', ')}、${result.trashChunks.join(', ')}、` +
        `${result.selectChunks.join(', ')}（entry 不含 ${SELECT_I18N_MARKER}）、` +
        `${result.folderChunks.join(', ')}（entry 不含 ${FOLDER_I18N_MARKER}）、` +
        `${result.shortcutsChunks.join(', ')}（entry 不含 ${SHORTCUTS_I18N_MARKER}）、` +
        `${result.tourChunks.join(', ')}（entry 不含 ${TOUR_I18N_MARKER}）、` +
        `${result.managementChunks.join(', ')}（entry 不含 ${MANAGEMENT_I18N_MARKERS.join('、')}）、` +
        `${result.bodySearchChunks.join(', ')}（entry 不含 ${BODY_SEARCH_MARKER}）、` +
        GROUP_LAZY_DIALOGS.map(d => `${result.groupDialogChunks[d.name].join(', ')}（entry 不含 ${d.marker}）、`).join('') +
        `${result.avatarEncodeChunks.join(', ')}（${AVATAR_IMAGE_MARKER} 只在這個 chunk，entry 與其他 chunk 都不含）`
    );
  } catch (err) {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(1);
  }
}
