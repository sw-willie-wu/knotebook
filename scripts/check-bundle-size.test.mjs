// node --test (same convention as changelog-section.test.mjs): tests the judgement logic of check-bundle-size against fake directories, no real build needed -
// the real dist is checked by check-bundle-size.mjs after the build in CI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { AVATAR_ENCODE_RE, GROUP_LAZY_DIALOGS, AVATAR_IMAGE_MARKER, BODY_SEARCH_MARKER, COMMENTS_I18N_MARKER, COMMENT_TOOLBAR_I18N_MARKER, NOTIFICATIONS_I18N_MARKER, FOLDER_I18N_MARKER, GROUPS_ADMIN_I18N_MARKER, HELP_I18N_MARKER, KNOWLEDGE_INDEX_I18N_MARKER, MANAGEMENT_I18N_MARKERS, MAX_ENTRY_BYTES, MOBILE_TOOLBAR_I18N_MARKER, SELECT_I18N_MARKER, SHORTCUTS_I18N_MARKER, TOUR_I18N_MARKER, VERSIONS_MARKERS, KATEX_CSS_MARKERS, KATEX_MARKER, KATEX_RE, MATH_I18N_PACK_SHAPE, MATH_I18N_MARKER, checkBundleSize } from './check-bundle-size.mjs';

// pins the default cap of 750 KiB (reason in the constant's comment in check-bundle-size.mjs; the next two cases pass 700 * 1024 explicitly to test the judgement itself, independent of the default).
test('default entry size cap is 750 KiB', () => {
  assert.equal(MAX_ENTRY_BYTES, 750 * 1024);
});

// Fake chunk for the site admin / settings string bundle: carries all MANAGEMENT_I18N_MARKERS (in a real build this bundle is management-strings-<hash>.js).
const MGMT_PACK = { 'management-strings-Mgt000.js': `const m={${MANAGEMENT_I18N_MARKERS.map(k => `${k}:"x"`).join(',')}}` };

// Fake chunk for the comments panel, carrying its string pack's marker (CommentsLazy-<hash>.js in a real build).
const COMMENTS_PACK = { 'CommentsLazy-Ccc000.js': `const c={${COMMENTS_I18N_MARKER}:"x"}` };

// Fake chunk for the notification list, carrying its string pack's marker (NotificationsLazy-<hash>.js in a real build).
const NOTIFICATIONS_PACK = { 'NotificationsLazy-Nnn000.js': `const n={${NOTIFICATIONS_I18N_MARKER}:"x"}` };

// Fake chunk for the avatar encoding module: carries the marker (encode-<hash>.js in a real build).
const AVATAR_PACK = { 'encode-Eee000.js': `class E extends Error{constructor(){super();this.name="${AVATAR_IMAGE_MARKER}"}}` };

// Fake chunks for three dialogs loaded only when opened: each carries its marker (in a real build GroupNameDialog / DeleteGroupDialog / GroupTransferDialog-<hash>.js).
const GROUP_DIALOG_PACK = Object.fromEntries(GROUP_LAZY_DIALOGS.map((d, i) => [`${d.name}-Ggg00${i}.js`, `t("${d.marker}")`]).concat([['icons-extra-Iii000.js', 'x']]));

// Fake chunks for the math block: the KaTeX engine (katex-<hash>.js, carrying its error-string marker) and the math string pack (any lazy chunk carrying MATH_I18N_MARKER).
const MATH_PACK = {
  'katex-Kkk000.js': `class P extends Error{constructor(m){super("${KATEX_MARKER}: "+m)}}export{P}`,
  'math-strings-Mmm000.js': `const m={${MATH_I18N_PACK_SHAPE}x"}`,
};

const MARKER_BASE = {
  ...MGMT_PACK, ...COMMENTS_PACK, ...NOTIFICATIONS_PACK,
  ...AVATAR_PACK, ...GROUP_DIALOG_PACK, ...MATH_PACK,
  'index-Abc123.js': 100, 'mermaid.core-Ghi789.js': 10, 'shiki-Jkl012.js': 10, 'AdminSections-Mno345.js': 10,
  'PresentationOverlay-Pqr678.js': 10, 'TrashLazy-Ttt000.js': 10, 'SelectLazy-Sss000.js': 10, 'FolderLazy-Fff000.js': 10,
  'ShortcutsLazy-Kkk000.js': 10,
  'TourLazy-Tou000.js': 10,
  'BodySearchLazy-Bbb000.js': 10,
};

function fakeAssets(files) {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-check-'));
  const assets = join(dir, 'assets');
  mkdirSync(assets);
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(assets, name), typeof content === 'string' ? content : Buffer.alloc(content));
  }
  return { assets, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('entry within the cap and a NotePage chunk present -> passes and reports a summary', () => {
  const { assets, cleanup } = fakeAssets({
    'index-Abc123.js': 500_000,
    'NotePage-Def456.js': 1_000_000,
    'mermaid.core-Ghi789.js': 700_000,
    'shiki-Jkl012.js': 150_000,
    'AdminSections-Mno345.js': 60_000,
    'VersionsLazy-Pqr678.js': 40_000,
    'PresentationOverlay-Pqr678.js': 200_000,
    'TrashLazy-Ttt000.js': 10_000,
    'SelectLazy-Sss000.js': 20_000,
    'FolderLazy-Fff000.js': 15_000,
    'ShortcutsLazy-Kkk000.js': 10_000,
    'TourLazy-Tou000.js': 12_000,
    'BodySearchLazy-Bbb000.js': 8_000,
    ...MGMT_PACK, ...COMMENTS_PACK, ...NOTIFICATIONS_PACK,
    ...AVATAR_PACK, ...GROUP_DIALOG_PACK, ...MATH_PACK,
    'index-Abc123.css': 50_000, // css is not an entry chunk; the pattern only matches .js
  });
  try {
    const result = checkBundleSize(assets, { maxEntryBytes: 700 * 1024 });
    assert.equal(result.entryName, 'index-Abc123.js');
    assert.equal(result.entryBytes, 500_000);
    assert.deepEqual(result.notePageChunks, ['NotePage-Def456.js']);
    assert.deepEqual(result.mermaidChunks, ['mermaid.core-Ghi789.js']);
    assert.deepEqual(result.shikiChunks, ['shiki-Jkl012.js']);
    assert.deepEqual(result.adminSectionsChunks, ['AdminSections-Mno345.js']);
    assert.deepEqual(result.versionsChunks, ['VersionsLazy-Pqr678.js']);
    assert.deepEqual(result.presentationChunks, ['PresentationOverlay-Pqr678.js']);
    assert.deepEqual(result.trashChunks, ['TrashLazy-Ttt000.js']);
    assert.deepEqual(result.selectChunks, ['SelectLazy-Sss000.js']);
    assert.deepEqual(result.folderChunks, ['FolderLazy-Fff000.js']);
    assert.deepEqual(result.shortcutsChunks, ['ShortcutsLazy-Kkk000.js']);
    assert.deepEqual(result.tourChunks, ['TourLazy-Tou000.js']);
    assert.deepEqual(result.bodySearchChunks, ['BodySearchLazy-Bbb000.js']);
    assert.deepEqual(result.avatarEncodeChunks, ['encode-Eee000.js']);
  } finally {
    cleanup();
  }
});

test('entry over the cap -> throws, message contains the actual bytes and a regression hint', () => {
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

test('NotePage chunk missing (split removed) -> throws', () => {
  const { assets, cleanup } = fakeAssets({ 'index-Abc123.js': 100 });
  try {
    assert.throws(() => checkBundleSize(assets), /NotePage/);
  } finally {
    cleanup();
  }
});

test('fail-closed: dist missing -> throws (not a silent pass)', () => {
  assert.throws(() => checkBundleSize(join(tmpdir(), 'no-such-dir-bundle-check')), /pnpm build/);
});

test('fail-closed: several entry chunks (build output shape not as expected) -> throws', () => {
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

// issue #94: mermaid must stay in its own chunk. This guards against someone statically importing mermaid outside lib/mermaid.ts -
// it would be merged into NotePage/entry and the separate chunk would disappear.
test('mermaid chunk missing (merged back by a static import) -> throws', () => {
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

// issue #96: shiki must stay in its own chunk (same reason as mermaid - the only place allowed to import it is the `import("shiki")` in lib/code-highlight.ts).
// Its core is ~150KB; if a static import merged it back into the entry, the entry would sit right at the cap and the symptom would be "sometimes over" rather than stably red.
// The chunk is named shiki-<hash> by chunkFileNames in vite.config.ts: shiki's package entry file is index.mjs and Rollup names chunks after the file by default,
// which would produce a second index-<hash>.js and collide with entry detection (the fail-closed "exactly one entry" case above catches this).
test('shiki chunk missing (merged back by a static import) -> throws', () => {
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

// issue #201 / #247: the site-admin sections must be their own lazy chunk (the `lazy(() => import("./components/admin/AdminSections"))` calls in App.tsx are the only import point) -
// if someone statically imports it or a section it re-exports, Rollup merges them back into the entry and this chunk disappears.
test('AdminSections chunk missing (merged back into the entry by a static import) -> throws', () => {
  const { assets, cleanup } = fakeAssets({
    'index-Abc123.js': 100,
    'NotePage-Def456.js': 100,
    'mermaid.core-Ghi789.js': 100,
    'shiki-Jkl012.js': 100,
  });
  try {
    assert.throws(() => checkBundleSize(assets), /AdminSections[\s\S]*#247/);
  } finally {
    cleanup();
  }
});

// the version history UI (including the diff package) must be its own lazy chunk
test('VersionsLazy chunk missing (merged back into NotePage/entry by a static import) -> throws', () => {
  const { assets, cleanup } = fakeAssets({
    'index-Abc123.js': 100, 'NotePage-Def456.js': 10, 'mermaid.core-Ghi789.js': 10, 'shiki-Jkl012.js': 10,
    'AdminSections-Mno345.js': 10, 'PresentationOverlay-Pqr678.js': 10,
  });
  try {
    assert.throws(() => checkBundleSize(assets), /VersionsLazy[\s\S]*diff/);
  } finally {
    cleanup();
  }
});

test('presentation layer chunk missing (#229 regression: PresentationOverlay was statically imported) -> throws', () => {
  const { assets, cleanup } = fakeAssets({
    'index-Abc123.js': 100, 'NotePage-Def456.js': 10, 'mermaid.core-Ghi789.js': 10, 'shiki-Jkl012.js': 10, 'AdminSections-Mno345.js': 10,
    'VersionsLazy-Vvv000.js': 10,
  });
  try {
    assert.throws(() => checkBundleSize(assets), /PresentationOverlay[\s\S]*#229/);
  } finally {
    cleanup();
  }
});

// #181: the trash tab's panel and footer must be their own lazy chunk (TrashLazy is the only entry)
test('TrashLazy chunk missing (both mount points changed to static imports, the whole group merged back into the entry) -> throws', () => {
  const { assets, cleanup } = fakeAssets({
    'index-Abc123.js': 100, 'NotePage-Def456.js': 10, 'mermaid.core-Ghi789.js': 10, 'shiki-Jkl012.js': 10, 'AdminSections-Mno345.js': 10,
    'VersionsLazy-Vvv000.js': 10, 'PresentationOverlay-Pqr678.js': 10,
  });
  try {
    assert.throws(() => checkBundleSize(assets), /TrashLazy[\s\S]*#181/);
  } finally {
    cleanup();
  }
});

// #181: the general tab's selection mode must be its own lazy chunk (SelectLazy is the only entry)
test('SelectLazy chunk missing (the whole group merged back into the entry) -> throws', () => {
  const { assets, cleanup } = fakeAssets({
    'index-Abc123.js': 100, 'NotePage-Def456.js': 10, 'mermaid.core-Ghi789.js': 10, 'shiki-Jkl012.js': 10, 'AdminSections-Mno345.js': 10,
    'VersionsLazy-Vvv000.js': 10, 'PresentationOverlay-Pqr678.js': 10, 'TrashLazy-Ttt000.js': 10,
  });
  try {
    assert.throws(() => checkBundleSize(assets), /SelectLazy[\s\S]*PR-2c/);
  } finally {
    cleanup();
  }
});

test('entry contains the select string bundle\'s key names (the bundle, or a module importing it, is statically imported by the entry) -> throws', () => {
  const { assets, cleanup } = fakeAssets({
    ...MARKER_BASE, 'index-Abc123.js': `const s={${SELECT_I18N_MARKER}:"Delete 1 selected item"}`, 'NotePage-Def456.js': 'x',
    'VersionsLazy-Vvv000.js': 'x',
  });
  try {
    assert.throws(() => checkBundleSize(assets), /index-Abc123\.js[\s\S]*deleteSelected_one[\s\S]*PR-2c/);
  } finally {
    cleanup();
  }
});

test('key names only inside SelectLazy -> passes, returns selectChunks', () => {
  const { assets, cleanup } = fakeAssets({
    ...MARKER_BASE, 'SelectLazy-Sss000.js': `const s={${SELECT_I18N_MARKER}:"Delete 1 selected item"}`, 'NotePage-Def456.js': 'x',
    'VersionsLazy-Vvv000.js': 'x',
  });
  try {
    assert.deepEqual(checkBundleSize(assets).selectChunks, ['SelectLazy-Sss000.js']);
  } finally {
    cleanup();
  }
});

// A renamed marker silently stops working - bind it back to select.en.json (as VERSIONS_MARKERS below is bound to en.json).
test('SELECT_I18N_MARKER is a select.* key in select.en.json', () => {
  const bundle = JSON.parse(readFileSync(fileURLToPath(new URL('../apps/web/src/i18n/select.en.json', import.meta.url)), 'utf8'));
  let node = bundle;
  for (const part of `select.${SELECT_I18N_MARKER}`.split('.')) node = node?.[part];
  assert.equal(typeof node, 'string', `select.${SELECT_I18N_MARKER} 不在 select.en.json——鍵改名了，請同步更新 SELECT_I18N_MARKER`);
});

test('entry contains the mobile edit toolbar string bundle\'s key names -> throws', () => {
  const { assets, cleanup } = fakeAssets({
    ...MARKER_BASE, 'index-Abc123.js': `const s={${MOBILE_TOOLBAR_I18N_MARKER}:"Hide keyboard"}`, 'NotePage-Def456.js': 'x',
    'VersionsLazy-Vvv000.js': 'x',
  });
  try {
    assert.throws(() => checkBundleSize(assets), /index-Abc123\.js[\s\S]*hideKeyboard[\s\S]*NotePage chunk/);
  } finally {
    cleanup();
  }
});

test('key names only inside NotePage -> passes', () => {
  const { assets, cleanup } = fakeAssets({
    ...MARKER_BASE, 'NotePage-Def456.js': `const s={${MOBILE_TOOLBAR_I18N_MARKER}:"Hide keyboard"}`,
    'VersionsLazy-Vvv000.js': 'x',
  });
  try {
    assert.doesNotThrow(() => checkBundleSize(assets));
  } finally {
    cleanup();
  }
});

test('MOBILE_TOOLBAR_I18N_MARKER is a mobileToolbar.* key in mobile-toolbar.en.json, not in the main en.json', () => {
  const dir = new URL('../apps/web/src/i18n/', import.meta.url);
  const bundle = JSON.parse(readFileSync(fileURLToPath(new URL('mobile-toolbar.en.json', dir)), 'utf8'));
  assert.equal(typeof bundle.mobileToolbar?.[MOBILE_TOOLBAR_I18N_MARKER], 'string');
  const main = JSON.parse(readFileSync(fileURLToPath(new URL('en.json', dir)), 'utf8'));
  assert.equal(main.mobileToolbar, undefined);
});

test('entry contains the comment toolbar string pack key -> throws; only inside NotePage -> passes', () => {
  for (const [where, throws] of [['index-Abc123.js', true], ['NotePage-Def456.js', false]]) {
    const { assets, cleanup } = fakeAssets({
      ...MARKER_BASE, 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x', [where]: `const s={${COMMENT_TOOLBAR_I18N_MARKER}:{comment:"Comment"}}`,
    });
    try {
      if (throws) assert.throws(() => checkBundleSize(assets), /index-Abc123\.js[\s\S]*commentToolbar[\s\S]*NotePage chunk/);
      else assert.doesNotThrow(() => checkBundleSize(assets));
    } finally {
      cleanup();
    }
  }
});

test('COMMENT_TOOLBAR_I18N_MARKER is the top-level key of comment-toolbar.en.json, not in the main en.json', () => {
  const dir = new URL('../apps/web/src/i18n/', import.meta.url);
  const bundle = JSON.parse(readFileSync(fileURLToPath(new URL('comment-toolbar.en.json', dir)), 'utf8'));
  assert.deepEqual(Object.keys(bundle), [COMMENT_TOOLBAR_I18N_MARKER]);
  const main = JSON.parse(readFileSync(fileURLToPath(new URL('en.json', dir)), 'utf8'));
  assert.equal(main[COMMENT_TOOLBAR_I18N_MARKER], undefined);
});

// Folders: the folder dialogs must be their own lazy chunk (FolderLazy is the only entry)
test('FolderLazy chunk missing (the whole group merged back into the entry) -> throws', () => {
  const files = { ...MARKER_BASE, 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x' };
  delete files['FolderLazy-Fff000.js'];
  const { assets, cleanup } = fakeAssets(files);
  try {
    assert.throws(() => checkBundleSize(assets), /FolderLazy[\s\S]*PR-3b/);
  } finally {
    cleanup();
  }
});

test('entry contains the folder string bundle\'s key names (the bundle, or a module importing it, is statically imported by the entry) -> throws', () => {
  const { assets, cleanup } = fakeAssets({
    ...MARKER_BASE, 'index-Abc123.js': `const s={${FOLDER_I18N_MARKER}:"Restoring from the trash rebuilds the folders"}`, 'NotePage-Def456.js': 'x',
    'VersionsLazy-Vvv000.js': 'x',
  });
  try {
    assert.throws(() => checkBundleSize(assets), /index-Abc123\.js[\s\S]*restoreRebuilds[\s\S]*PR-3b/);
  } finally {
    cleanup();
  }
});

test('key names only inside FolderLazy -> passes, returns folderChunks', () => {
  const { assets, cleanup } = fakeAssets({
    ...MARKER_BASE, 'FolderLazy-Fff000.js': `const s={${FOLDER_I18N_MARKER}:"Restoring from the trash rebuilds the folders"}`, 'NotePage-Def456.js': 'x',
    'VersionsLazy-Vvv000.js': 'x',
  });
  try {
    assert.deepEqual(checkBundleSize(assets).folderChunks, ['FolderLazy-Fff000.js']);
  } finally {
    cleanup();
  }
});

// #93: the body area of the sidebar search must be its own lazy chunk (BodySearchLazy is the only entry)
test('BodySearchLazy chunk missing (statically imported, the whole group merged back into the entry) -> throws', () => {
  const files = { ...MARKER_BASE, 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x' };
  delete files['BodySearchLazy-Bbb000.js'];
  const { assets, cleanup } = fakeAssets(files);
  try {
    assert.throws(() => checkBundleSize(assets), /BodySearchLazy[\s\S]*#93/);
  } finally {
    cleanup();
  }
});

test('entry contains the body area\'s marker (body-match) -> throws', () => {
  const { assets, cleanup } = fakeAssets({
    ...MARKER_BASE, 'index-Abc123.js': `e("section",{"data-testid":"${BODY_SEARCH_MARKER}"})`, 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x',
  });
  try {
    assert.throws(() => checkBundleSize(assets), /index-Abc123\.js[\s\S]*body-match[\s\S]*#93/);
  } finally {
    cleanup();
  }
});

test('marker only inside BodySearchLazy -> passes, returns bodySearchChunks', () => {
  const { assets, cleanup } = fakeAssets({
    ...MARKER_BASE, 'BodySearchLazy-Bbb000.js': `e("section",{"data-testid":"${BODY_SEARCH_MARKER}"})`, 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x',
  });
  try {
    assert.deepEqual(checkBundleSize(assets).bodySearchChunks, ['BodySearchLazy-Bbb000.js']);
  } finally {
    cleanup();
  }
});

test('BODY_SEARCH_MARKER appears only in BodySearchResults.tsx (SearchResults / gate / fallback in the entry must not use this word)', () => {
  const src = fileURLToPath(new URL('../apps/web/src/components/sidebar/', import.meta.url));
  assert.ok(readFileSync(join(src, 'BodySearchResults.tsx'), 'utf8').includes(`"${BODY_SEARCH_MARKER}"`));
  for (const name of ['SearchResults.tsx', 'body-search-gate.ts', 'SidebarLazyBoundary.tsx', 'BodySearchLazy.tsx']) {
    assert.ok(!readFileSync(join(src, name), 'utf8').includes(BODY_SEARCH_MARKER), `${name} 不得含 ${BODY_SEARCH_MARKER}`);
  }
});

test('entry contains the knowledge index string bundle key names -> throws', () => {
  const { assets, cleanup } = fakeAssets({
    ...MARKER_BASE, 'index-Abc123.js': `const s={${KNOWLEDGE_INDEX_I18N_MARKER}:"Older notes are still being indexed"}`, 'NotePage-Def456.js': 'x',
    'VersionsLazy-Vvv000.js': 'x',
  });
  try {
    assert.throws(() => checkBundleSize(assets), /index-Abc123\.js[\s\S]*backfillNotice/);
  } finally {
    cleanup();
  }
});

test('KNOWLEDGE_INDEX_I18N_MARKER is a knowledgeIndex.* key in knowledge-index.en.json, not in the main en.json', () => {
  const read = name => JSON.parse(readFileSync(fileURLToPath(new URL(`../apps/web/src/i18n/${name}`, import.meta.url)), 'utf8'));
  assert.equal(typeof read('knowledge-index.en.json').knowledgeIndex?.[KNOWLEDGE_INDEX_I18N_MARKER], 'string');
  assert.equal(read('en.json').knowledgeIndex?.[KNOWLEDGE_INDEX_I18N_MARKER], undefined);
});

test('entry contains the group settings string bundle key names -> throws', () => {
  const { assets, cleanup } = fakeAssets({
    ...MARKER_BASE, 'index-Abc123.js': `const s={${GROUPS_ADMIN_I18N_MARKER}:"No files yet"}`, 'NotePage-Def456.js': 'x',
    'VersionsLazy-Vvv000.js': 'x',
  });
  try {
    assert.throws(() => checkBundleSize(assets), /index-Abc123\.js[\s\S]*byMemberEmpty/);
  } finally {
    cleanup();
  }
});

test('GROUPS_ADMIN_I18N_MARKER is a groups.storage.* key in groups-admin.en.json, not in the main en.json', () => {
  const read = name => JSON.parse(readFileSync(fileURLToPath(new URL(`../apps/web/src/i18n/${name}`, import.meta.url)), 'utf8'));
  assert.equal(typeof read('groups-admin.en.json').groups?.storage?.[GROUPS_ADMIN_I18N_MARKER], 'string');
  assert.equal(read('en.json').groups?.storage, undefined);
});

// A renamed marker silently stops working - bind it back to folders.en.json (as for the select marker above).
test('FOLDER_I18N_MARKER is a folderDialogs.* key in folders.en.json', () => {
  const bundle = JSON.parse(readFileSync(fileURLToPath(new URL('../apps/web/src/i18n/folders.en.json', import.meta.url)), 'utf8'));
  let node = bundle;
  for (const part of `folderDialogs.${FOLDER_I18N_MARKER}`.split('.')) node = node?.[part];
  assert.equal(typeof node, 'string', `folderDialogs.${FOLDER_I18N_MARKER} 不在 folders.en.json——鍵改名了，請同步更新 FOLDER_I18N_MARKER`);
});

// shortcuts guide: the list, string bundle and key faces must be their own lazy chunk (ShortcutsLazy is the only entry, via the lazy import in ShortcutsDialog)
test('ShortcutsLazy chunk missing (the whole group merged back into the entry) -> throws', () => {
  const files = { ...MARKER_BASE, 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x' };
  delete files['ShortcutsLazy-Kkk000.js'];
  const { assets, cleanup } = fakeAssets(files);
  try {
    assert.throws(() => checkBundleSize(assets), /ShortcutsLazy/);
  } finally {
    cleanup();
  }
});

test('entry contains the shortcuts string bundle\'s key names (the bundle or the list is statically imported by the entry) -> throws', () => {
  const { assets, cleanup } = fakeAssets({
    ...MARKER_BASE, 'index-Abc123.js': `const s={${SHORTCUTS_I18N_MARKER}:"Backspace at the start of a column"}`, 'NotePage-Def456.js': 'x',
    'VersionsLazy-Vvv000.js': 'x',
  });
  try {
    assert.throws(() => checkBundleSize(assets), /index-Abc123\.js[\s\S]*columnBackspace[\s\S]*ShortcutsLazy/);
  } finally {
    cleanup();
  }
});

test('key names only inside ShortcutsLazy -> passes, returns shortcutsChunks', () => {
  const { assets, cleanup } = fakeAssets({
    ...MARKER_BASE, 'ShortcutsLazy-Kkk000.js': `const s={${SHORTCUTS_I18N_MARKER}:"Backspace at the start of a column"}`, 'NotePage-Def456.js': 'x',
    'VersionsLazy-Vvv000.js': 'x',
  });
  try {
    assert.deepEqual(checkBundleSize(assets).shortcutsChunks, ['ShortcutsLazy-Kkk000.js']);
  } finally {
    cleanup();
  }
});

// A renamed marker silently stops working - bind it back to shortcuts.en.json (as for the select marker above); it must not be a key of the main en.json.
test('SHORTCUTS_I18N_MARKER is a shortcutsGuide.items.* key in shortcuts.en.json, not in the main en.json', () => {
  const bundle = JSON.parse(readFileSync(fileURLToPath(new URL('../apps/web/src/i18n/shortcuts.en.json', import.meta.url)), 'utf8'));
  let node = bundle;
  for (const part of `shortcutsGuide.items.${SHORTCUTS_I18N_MARKER}`.split('.')) node = node?.[part];
  assert.equal(typeof node, 'object', `shortcutsGuide.items.${SHORTCUTS_I18N_MARKER} 不在 shortcuts.en.json——鍵改名了，請同步更新 SHORTCUTS_I18N_MARKER`);
  const main = readFileSync(fileURLToPath(new URL('../apps/web/src/i18n/en.json', import.meta.url)), 'utf8');
  assert.ok(!main.includes(`"${SHORTCUTS_I18N_MARKER}"`), `${SHORTCUTS_I18N_MARKER} 不該在主 en.json`);
});

// feature tour: the overlay, cards, site table, sample notes and string bundle must be their own lazy chunk (TourLazy is the only entry, via import() in TourProvider)
test('TourLazy chunk missing (the whole group merged back into the entry) -> throws', () => {
  const files = { ...MARKER_BASE, 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x' };
  delete files['TourLazy-Tou000.js'];
  const { assets, cleanup } = fakeAssets(files);
  try {
    assert.throws(() => checkBundleSize(assets), /TourLazy/);
  } finally {
    cleanup();
  }
});

test('entry contains the tour string bundle\'s key names (the bundle or tour modules are statically imported by the entry) -> throws', () => {
  const { assets, cleanup } = fakeAssets({
    ...MARKER_BASE, 'index-Abc123.js': `const s={${TOUR_I18N_MARKER}:"Keep the sample note, or move it to the trash?"}`, 'NotePage-Def456.js': 'x',
    'VersionsLazy-Vvv000.js': 'x',
  });
  try {
    assert.throws(() => checkBundleSize(assets), /index-Abc123\.js[\s\S]*keepOrDeleteSample[\s\S]*TourLazy/);
  } finally {
    cleanup();
  }
});

test('key names only inside TourLazy -> passes, returns tourChunks', () => {
  const { assets, cleanup } = fakeAssets({
    ...MARKER_BASE, 'TourLazy-Tou000.js': `const s={${TOUR_I18N_MARKER}:"Keep the sample note, or move it to the trash?"}`, 'NotePage-Def456.js': 'x',
    'VersionsLazy-Vvv000.js': 'x',
  });
  try {
    assert.deepEqual(checkBundleSize(assets).tourChunks, ['TourLazy-Tou000.js']);
  } finally {
    cleanup();
  }
});

test('TOUR_I18N_MARKER is a tourGuide.* key in tour.en.json, not in the main en.json', () => {
  const tour = JSON.parse(readFileSync(fileURLToPath(new URL('../apps/web/src/i18n/tour.en.json', import.meta.url)), 'utf8'));
  assert.equal(typeof tour.tourGuide?.[TOUR_I18N_MARKER], 'string', `tourGuide.${TOUR_I18N_MARKER} 不在 tour.en.json——鍵改名了，請同步更新 TOUR_I18N_MARKER`);
  const main = readFileSync(fileURLToPath(new URL('../apps/web/src/i18n/en.json', import.meta.url)), 'utf8');
  assert.ok(!main.includes(`"${TOUR_I18N_MARKER}"`), `${TOUR_I18N_MARKER} 不該在主 en.json`);
});

// help dialog: the entry must not contain the help page's strings; the help dialog's chunk must not carry the tour string bundle or reference the tour's chunk
test('entry contains the help page\'s string keys -> throws', () => {
  const { assets, cleanup } = fakeAssets({
    ...MARKER_BASE, 'index-Abc123.js': `const s={${HELP_I18N_MARKER}:{}}`, 'NotePage-Def456.js': 'x',
    'VersionsLazy-Vvv000.js': 'x',
  });
  try {
    assert.throws(() => checkBundleSize(assets), /index-Abc123\.js[\s\S]*whatsNew[\s\S]*ShortcutsLazy/);
  } finally {
    cleanup();
  }
});

test('the help dialog chunk contains the tour string bundle\'s key names -> throws', () => {
  const { assets, cleanup } = fakeAssets({
    ...MARKER_BASE, 'ShortcutsLazy-Kkk000.js': `const s={${TOUR_I18N_MARKER}:"x",${HELP_I18N_MARKER}:{}}`, 'NotePage-Def456.js': 'x',
    'VersionsLazy-Vvv000.js': 'x',
  });
  try {
    assert.throws(() => checkBundleSize(assets), /ShortcutsLazy-Kkk000\.js[\s\S]*keepOrDeleteSample/);
  } finally {
    cleanup();
  }
});

test('the help dialog chunk statically references the TourLazy chunk (key names are in another file) -> throws', () => {
  const { assets, cleanup } = fakeAssets({
    ...MARKER_BASE, 'ShortcutsLazy-Kkk000.js': 'import{T}from"./TourLazy-Tou000.js";export{T}', 'NotePage-Def456.js': 'x',
    'VersionsLazy-Vvv000.js': 'x',
  });
  try {
    assert.throws(() => checkBundleSize(assets), /ShortcutsLazy-Kkk000\.js[\s\S]*TourLazy-Tou000\.js/);
  } finally {
    cleanup();
  }
});

test('the tour string bundle is extracted into a shared chunk and the help dialog chunk keeps only a static import line -> throws', () => {
  const { assets, cleanup } = fakeAssets({
    ...MARKER_BASE, 'ShortcutsLazy-Kkk000.js': 'import"./tour-strings-Zzz999.js";export{};', 'tour-strings-Zzz999.js': `const s={${TOUR_I18N_MARKER}:"x"}`,
    'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x',
  });
  try {
    assert.throws(() => checkBundleSize(assets), /ShortcutsLazy-Kkk000\.js[\s\S]*tour-strings-Zzz999\.js/);
  } finally {
    cleanup();
  }
});

test('the help dialog chunk only dynamically imports the tour chunk (parenthesised form) -> passes', () => {
  const { assets, cleanup } = fakeAssets({
    ...MARKER_BASE, 'ShortcutsLazy-Kkk000.js': 'const load=()=>import("./TourLazy-Tou000.js");export{load};',
    'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x',
  });
  try {
    assert.deepEqual(checkBundleSize(assets).shortcutsChunks, ['ShortcutsLazy-Kkk000.js']);
  } finally {
    cleanup();
  }
});

test('the help page\'s key names only inside ShortcutsLazy and the tour\'s only inside TourLazy -> passes', () => {
  const { assets, cleanup } = fakeAssets({
    ...MARKER_BASE, 'ShortcutsLazy-Kkk000.js': `const s={${HELP_I18N_MARKER}:{}}`, 'TourLazy-Tou000.js': `const s={${TOUR_I18N_MARKER}:"x"}`,
    'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x',
  });
  try {
    assert.deepEqual(checkBundleSize(assets).shortcutsChunks, ['ShortcutsLazy-Kkk000.js']);
  } finally {
    cleanup();
  }
});

test('HELP_I18N_MARKER is a key under helpGuide in shortcuts.en.json, not in the main en.json', () => {
  const bundle = JSON.parse(readFileSync(fileURLToPath(new URL('../apps/web/src/i18n/shortcuts.en.json', import.meta.url)), 'utf8'));
  assert.equal(typeof bundle.helpGuide?.[HELP_I18N_MARKER], 'object', `helpGuide.${HELP_I18N_MARKER} 不在 shortcuts.en.json——鍵改名了，請同步更新 HELP_I18N_MARKER`);
  const main = readFileSync(fileURLToPath(new URL('../apps/web/src/i18n/en.json', import.meta.url)), 'utf8');
  assert.ok(!main.includes(`"${HELP_I18N_MARKER}"`), `${HELP_I18N_MARKER} 不該在主 en.json`);
});

test('MANAGEMENT_I18N_MARKERS are all keys of the subtree moved out of management.en.json, and not among the keys the entry keeps', () => {
  const bundle = JSON.parse(readFileSync(fileURLToPath(new URL('../apps/web/src/i18n/management.en.json', import.meta.url)), 'utf8'));
  const found = [];
  const walk = (node, path) => {
    for (const [key, value] of Object.entries(node)) {
      if (typeof value === 'object') walk(value, [...path, key]);
      else if (MANAGEMENT_I18N_MARKERS.includes(key)) found.push(key);
    }
  };
  walk(bundle, []);
  assert.deepEqual([...found].sort(), [...MANAGEMENT_I18N_MARKERS].sort(), 'marker 必須各自恰在 management.en.json 出現一次——鍵改名或重複了，請同步更新 MANAGEMENT_I18N_MARKERS');
  const main = readFileSync(fileURLToPath(new URL('../apps/web/src/i18n/en.json', import.meta.url)), 'utf8');
  for (const marker of MANAGEMENT_I18N_MARKERS) assert.ok(!main.includes(`"${marker}"`), `${marker} 不該在主 en.json`);
});

test('entry contains a string bundle marker -> throws; no management-strings chunk -> throws; a chunk missing a marker -> throws', () => {
  const { 'management-strings-Mgt000.js': _pack, ...withoutPack } = MARKER_BASE;
  const leak = fakeAssets({ ...MARKER_BASE, 'index-Abc123.js': `const s={${MANAGEMENT_I18N_MARKERS[1]}:"Built-in"}`, 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x' });
  try {
    assert.throws(() => checkBundleSize(leak.assets), /index-Abc123\.js[\s\S]*actionBuiltinBadge[\s\S]*首包瘦身/);
  } finally {
    leak.cleanup();
  }
  const missing = fakeAssets({ ...withoutPack, 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x' });
  try {
    assert.throws(() => checkBundleSize(missing.assets), /management-strings/);
  } finally {
    missing.cleanup();
  }
  const partial = fakeAssets({ ...MARKER_BASE, 'management-strings-Mgt000.js': `const m={${MANAGEMENT_I18N_MARKERS[0]}:"x"}`, 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x' });
  try {
    assert.throws(() => checkBundleSize(partial.assets), /不含鍵名 \[actionBuiltinBadge\]/);
  } finally {
    partial.cleanup();
  }
});

test('entry CSS contains .reveal-viewport (reveal.css entered the entry) -> throws; a lazy chunk\'s CSS containing it does not count', () => {
  const base = {
    'index-Abc123.js': 100, 'NotePage-Def456.js': 10, 'mermaid.core-Ghi789.js': 10, 'shiki-Jkl012.js': 10,
    'AdminSections-Mno345.js': 10, 'VersionsLazy-Vvv000.js': 10, 'PresentationOverlay-Pqr678.js': 10, 'TrashLazy-Ttt000.js': 10,
    'SelectLazy-Sss000.js': 10, 'FolderLazy-Fff000.js': 10, 'ShortcutsLazy-Kkk000.js': 10, 'TourLazy-Tou000.js': 10, 'BodySearchLazy-Bbb000.js': 10, ...MGMT_PACK, ...COMMENTS_PACK, ...NOTIFICATIONS_PACK, ...AVATAR_PACK, ...GROUP_DIALOG_PACK, ...MATH_PACK,
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

test('the reveal-viewport string is only allowed in PresentationOverlay-*.js: inside the overlay passes, inside NotePage throws (reveal.js statically imported into NotePage)', () => {
  const base = {
    'index-Abc123.js': 100, 'mermaid.core-Ghi789.js': 10, 'shiki-Jkl012.js': 10, 'AdminSections-Mno345.js': 10, 'VersionsLazy-Vvv000.js': 10,
    'TrashLazy-Ttt000.js': 10, 'SelectLazy-Sss000.js': 10, 'FolderLazy-Fff000.js': 10, 'ShortcutsLazy-Kkk000.js': 10, 'TourLazy-Tou000.js': 10, 'BodySearchLazy-Bbb000.js': 10, ...MGMT_PACK, ...COMMENTS_PACK, ...NOTIFICATIONS_PACK, ...AVATAR_PACK, ...GROUP_DIALOG_PACK, ...MATH_PACK,
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

test('the static import closure (including indirect) of the presentation chunk reaching shiki -> throws; only a dynamic import("./shiki-...") does not count', () => {
  const base = {
    'index-Abc123.js': 100, 'NotePage-Def456.js': 10, 'mermaid.core-Ghi789.js': 10, 'AdminSections-Mno345.js': 10, 'VersionsLazy-Vvv000.js': 10,
    'shiki-Jkl012.js': 'export const s=1', 'bundle-full-Zz9.js': 'export const b=1', 'TrashLazy-Ttt000.js': 10,
    'SelectLazy-Sss000.js': 10, 'FolderLazy-Fff000.js': 10, 'ShortcutsLazy-Kkk000.js': 10, 'TourLazy-Tou000.js': 10, 'BodySearchLazy-Bbb000.js': 10, ...MGMT_PACK, ...COMMENTS_PACK, ...NOTIFICATIONS_PACK, ...AVATAR_PACK, ...GROUP_DIALOG_PACK, ...MATH_PACK,
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

test('VersionsLazy containing the marker itself -> passes', () => {
  const { assets, cleanup } = fakeAssets({ ...MARKER_BASE, 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': VERSIONS_MARKERS.join(' ') });
  try {
    assert.doesNotThrow(() => checkBundleSize(assets));
  } finally {
    cleanup();
  }
});

for (const marker of VERSIONS_MARKERS) {
  test(`a chunk other than VersionsLazy contains marker ${marker} (the component was moved into NotePage by a static import) -> throws, message contains VersionsLazy`, () => {
    const { assets, cleanup } = fakeAssets({ ...MARKER_BASE, 'NotePage-Def456.js': `x("${marker}")`, 'VersionsLazy-Vvv000.js': 'x' });
    try {
      assert.throws(() => checkBundleSize(assets), /NotePage-Def456\.js[\s\S]*VersionsLazy/);
    } finally {
      cleanup();
    }
  });
}

// A renamed marker silently stops working - bind the i18n-key markers back to en.json (the `diff` package's literal is not a key; only one such is allowed).
test('every i18n-key marker exists in en.json; the only non-key one is the diff package\'s', () => {
  const en = JSON.parse(readFileSync(fileURLToPath(new URL('../apps/web/src/i18n/en.json', import.meta.url)), 'utf8'));
  const nonKeys = [];
  for (const marker of VERSIONS_MARKERS) {
    if (!marker.startsWith('versions.')) {
      nonKeys.push(marker);
      continue;
    }
    let node = en;
    for (const part of marker.split('.')) node = node?.[part];
    assert.equal(typeof node, 'string', `${marker} 不在 en.json——key 改名了，請同步更新 VERSIONS_MARKERS`);
  }
  assert.deepEqual(nonKeys, ['u{2DE}-']);
});

// The `u{2DE}-` marker comes from extendedWordChars in the diff package's word.js; if a diff upgrade rewrites that literal this case goes red, as a reminder to pick another marker.
test('the diff package\'s word.js still contains the marker literal u{2DE}-', () => {
  const wordJs = fileURLToPath(new URL('../apps/web/node_modules/diff/libesm/diff/word.js', import.meta.url));
  assert.ok(readFileSync(wordJs, 'utf8').includes('u{2DE}-'), 'diff 的 word.js 不再含 u{2DE}-——請改挑新的 diff 獨有字面並更新 VERSIONS_MARKERS');
});

// the avatar decoding/encoding module (avatars/encode.ts) must not enter the entry.
test('entry contains the avatar image module\'s marker (statically imported into the entry) -> throws', () => {
  const { assets, cleanup } = fakeAssets({
    ...MARKER_BASE, 'index-Abc123.js': `class E extends Error{constructor(){super();this.name="${AVATAR_IMAGE_MARKER}"}}`, 'NotePage-Def456.js': 'x',
    'VersionsLazy-Vvv000.js': 'x',
  });
  try {
    assert.throws(() => checkBundleSize(assets), /index-Abc123\.js[\s\S]*AvatarImageError/);
  } finally {
    cleanup();
  }
});

test('marker only in encode-*.js -> passes, returns avatarEncodeChunks', () => {
  const { assets, cleanup } = fakeAssets({ ...MARKER_BASE, 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x' });
  try {
    assert.deepEqual(checkBundleSize(assets).avatarEncodeChunks, ['encode-Eee000.js']);
  } finally {
    cleanup();
  }
});

test('marker statically imported into another lazy chunk (the crop dialog\'s chunk carries it) -> throws, message names that chunk', () => {
  const marker = `this.name="${AVATAR_IMAGE_MARKER}"`;
  for (const stray of ['AvatarCropDialog-Ccc000.js', 'SettingsAccountSection-Sss111.js', 'NotePage-Def456.js']) {
    const { assets, cleanup } = fakeAssets({ ...MARKER_BASE, 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x', [stray]: marker });
    try {
      assert.throws(() => checkBundleSize(assets), new RegExp(`${stray.replace('.', '[.]')}[^]*${AVATAR_IMAGE_MARKER}`), stray);
    } finally {
      cleanup();
    }
  }
});

test('after a static import encode is no longer its own chunk (marker only in another chunk, no encode-*.js) -> throws', () => {
  const { 'encode-Eee000.js': _encode, ...withoutEncode } = MARKER_BASE;
  const { assets, cleanup } = fakeAssets({ ...withoutEncode, 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x', 'AvatarCropDialog-Ccc000.js': `this.name="${AVATAR_IMAGE_MARKER}"` });
  try {
    assert.throws(() => checkBundleSize(assets), /AvatarCropDialog-Ccc000\.js[\s\S]*AvatarImageError/);
  } finally {
    cleanup();
  }
});

test('no encode-*.js at all (dynamic import removed, module not bundled) -> throws (fail-closed)', () => {
  const { 'encode-Eee000.js': _encode, ...withoutEncode } = MARKER_BASE;
  const { assets, cleanup } = fakeAssets({ ...withoutEncode, 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x' });
  try {
    assert.throws(() => checkBundleSize(assets), /找不到含 AvatarImageError 的 encode-<hash>\.js/);
  } finally {
    cleanup();
  }
});

test('encode-*.js exists but has no marker (right file name, wrong content) -> throws', () => {
  const { assets, cleanup } = fakeAssets({ ...MARKER_BASE, 'encode-Eee000.js': 'x', 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x' });
  try {
    assert.throws(() => checkBundleSize(assets), /找不到含 AvatarImageError 的 encode-<hash>\.js/);
  } finally {
    cleanup();
  }
});

test('AVATAR_ENCODE_RE matches only encode-<hash>.js', () => {
  assert.ok(AVATAR_ENCODE_RE.test('encode-Abc_123-x.js'));
  for (const bad of ['encode.js', 'encode-Abc.css', 'xencode-Abc.js', 'AvatarEncode-Abc.js', 'encode-Abc.js.map']) assert.ok(!AVATAR_ENCODE_RE.test(bad), bad);
});

test('two chunks statically import a shared encode-*.js (shared-chunk shape, the marker still only inside encode) -> throws, message names the importer', () => {
  for (const [stray, code] of [
    ['NotePage-Def456.js', 'import{r as a}from"./encode-Eee000.js";x'],
    ['SettingsAccountSection-Sss111.js', 'import"./encode-Eee000.js";x'],
    ['AvatarCropDialog-Ccc000.js', 'export{a}from"./encode-Eee000.js"'],
  ]) {
    const { assets, cleanup } = fakeAssets({ ...MARKER_BASE, 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x', [stray]: code });
    try {
      assert.throws(() => checkBundleSize(assets), new RegExp(`${stray.replace('.', '[.]')} 靜態 import 了 encode-Eee000[.]js`), stray);
    } finally {
      cleanup();
    }
  }
});

test('dynamic import("./encode-*.js") (including the mapDeps list entry) -> passes', () => {
  const { assets, cleanup } = fakeAssets({
    ...MARKER_BASE,
    'NotePage-Def456.js': 'x',
    'VersionsLazy-Vvv000.js': 'x',
    'AvatarCropDialog-Ccc000.js': 'const f=()=>import("./encode-Eee000.js");const d=["assets/encode-Eee000.js"]',
  });
  try {
    assert.deepEqual(checkBundleSize(assets).avatarEncodeChunks, ['encode-Eee000.js']);
  } finally {
    cleanup();
  }
});

test('another module is also named encode-*.js and is statically imported (no avatar marker) -> no false report', () => {
  const { assets, cleanup } = fakeAssets({
    ...MARKER_BASE,
    'encode-Zzz999.js': 'export const e=1',
    'NotePage-Def456.js': 'import{e as a}from"./encode-Zzz999.js";x',
    'VersionsLazy-Vvv000.js': 'x',
  });
  try {
    assert.deepEqual(checkBundleSize(assets).avatarEncodeChunks, ['encode-Eee000.js']);
  } finally {
    cleanup();
  }
});

// A renamed marker silently stops working - bind it back to the this.name string literal in encode.ts.
test('AVATAR_IMAGE_MARKER is the string literal of this.name in avatars/encode.ts', () => {
  const source = readFileSync(fileURLToPath(new URL('../apps/web/src/avatars/encode.ts', import.meta.url)), 'utf8');
  assert.ok(source.includes(`this.name = "${AVATAR_IMAGE_MARKER}"`), `encode.ts 沒有 this.name = "${AVATAR_IMAGE_MARKER}"——marker 或類別改名了，請同步更新 AVATAR_IMAGE_MARKER`);
});

test('any group / move-copy dialog\'s lazy chunk missing -> throws, message names that dialog', () => {
  for (const dialog of GROUP_LAZY_DIALOGS) {
    const files = { ...MARKER_BASE, 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x' };
    for (const name of Object.keys(files)) if (name.startsWith(`${dialog.name}-`)) delete files[name];
    const { assets, cleanup } = fakeAssets(files);
    try {
      assert.throws(() => checkBundleSize(assets), new RegExp(`找不到 ${dialog.name} 的 lazy chunk`));
    } finally {
      cleanup();
    }
  }
});

test('entry contains any dialog\'s marker -> throws, message contains that marker', () => {
  for (const dialog of GROUP_LAZY_DIALOGS) {
    const { assets, cleanup } = fakeAssets({
      ...MARKER_BASE, 'index-Abc123.js': `t("${dialog.marker}")`, 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x',
    });
    try {
      assert.throws(() => checkBundleSize(assets), (err) => err.message.includes('index-Abc123.js') && err.message.includes(dialog.marker));
    } finally {
      cleanup();
    }
  }
});

test('markers only inside their own lazy chunks -> passes, returns groupDialogChunks', () => {
  const { assets, cleanup } = fakeAssets({ ...MARKER_BASE, 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x' });
  try {
    const result = checkBundleSize(assets);
    assert.deepEqual(Object.keys(result.groupDialogChunks), GROUP_LAZY_DIALOGS.map((d) => d.name));
  } finally {
    cleanup();
  }
});

// A renamed marker silently stops working - bind it back to each dialog's source file (the literal t("...")).
test('the GROUP_LAZY_DIALOGS markers are all written in their source files and not in the files the entry loads synchronously', () => {
  const src = fileURLToPath(new URL('../apps/web/src/', import.meta.url));
  for (const dialog of GROUP_LAZY_DIALOGS) {
    assert.ok(readFileSync(join(src, dialog.source), 'utf8').includes(`"${dialog.marker}"`), `${dialog.source} 沒有 "${dialog.marker}"`);
  }
  for (const name of ['components/groups/GroupMenu.tsx', 'components/NoteList.tsx', 'components/NoteMenu.tsx', 'components/share/GroupTransfer.tsx']) {
    const source = readFileSync(join(src, name), 'utf8');
    for (const dialog of GROUP_LAZY_DIALOGS) assert.ok(!source.includes(dialog.marker), `${name} 不得含 ${dialog.marker}`);
  }
});

test('icons-extra chunk missing -> throws', () => {
  const files = { ...MARKER_BASE, 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x' };
  delete files['icons-extra-Iii000.js'];
  const { assets, cleanup } = fakeAssets(files);
  try {
    assert.throws(() => checkBundleSize(assets), /找不到 icons-extra/);
  } finally {
    cleanup();
  }
});

test('dialog chunk exists but does not contain its own marker -> throws', () => {
  for (const dialog of GROUP_LAZY_DIALOGS) {
    const files = { ...MARKER_BASE, 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x' };
    for (const name of Object.keys(files)) if (name.startsWith(`${dialog.name}-`)) files[name] = 'export const x=1';
    const { assets, cleanup } = fakeAssets(files);
    try {
      assert.throws(() => checkBundleSize(assets), (err) => err.message.includes(dialog.name) && err.message.includes(dialog.marker));
    } finally {
      cleanup();
    }
  }
});

// #338: KaTeX and the math strings stay out of the entry. Presence of katex-*.js proves nothing (mermaid imports KaTeX too), so the checks read the marker's position and the static imports.
const MATH_BASE = { ...MARKER_BASE, 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x' };

test('KaTeX only in katex-*.js, math strings only in a lazy chunk -> passes, returns katexChunks', () => {
  const { assets, cleanup } = fakeAssets(MATH_BASE);
  try {
    assert.deepEqual(checkBundleSize(assets).katexChunks, ['katex-Kkk000.js']);
  } finally {
    cleanup();
  }
});

test('the KaTeX marker in the entry or any other chunk (static import merged it in) -> throws, message names that chunk and lib/katex.ts', () => {
  for (const stray of ['index-Abc123.js', 'NotePage-Def456.js', 'PublicNotePage-Ppp000.js', 'PresentationOverlay-Pqr678.js', 'SettingsAccountSection-Sss111.js']) {
    const { assets, cleanup } = fakeAssets({ ...MATH_BASE, [stray]: `throw Error("${KATEX_MARKER}: x")` });
    try {
      assert.throws(() => checkBundleSize(assets), new RegExp(`${stray.replace('.', '[.]')}[^]*KaTeX[^]*lib/katex.ts`), stray);
    } finally {
      cleanup();
    }
  }
});

test('no katex-*.js carries the marker (chunk missing, or present without the marker) -> throws (fail-closed)', () => {
  const { 'katex-Kkk000.js': _katex, ...withoutKatex } = MATH_BASE;
  for (const files of [withoutKatex, { ...withoutKatex, 'katex-Kkk000.js': 'export const x=1' }]) {
    const { assets, cleanup } = fakeAssets(files);
    try {
      assert.throws(() => checkBundleSize(assets), /找不到含 KaTeX parse error 的 katex-<hash>\.js/);
    } finally {
      cleanup();
    }
  }
});

test('a chunk statically importing katex-*.js (shared-chunk shape, the marker still only inside katex) -> throws; the entry, NotePage, PublicNotePage and the presentation chunk are all covered', () => {
  for (const [stray, code] of [
    ['index-Abc123.js', 'import{P as a}from"./katex-Kkk000.js";x'],
    ['NotePage-Def456.js', 'import"./katex-Kkk000.js";x'],
    ['PublicNotePage-Ppp000.js', 'export{P}from"./katex-Kkk000.js"'],
    ['PresentationOverlay-Pqr678.js', 'import{P as a}from"./katex-Kkk000.js";x'],
  ]) {
    const { assets, cleanup } = fakeAssets({ ...MATH_BASE, [stray]: code });
    try {
      assert.throws(() => checkBundleSize(assets), new RegExp(`${stray.replace('.', '[.]')} 的靜態 import 閉包碰到 KaTeX：\\[katex-Kkk000[.]js`), stray);
    } finally {
      cleanup();
    }
  }
});

test('KaTeX reached through an intermediate chunk\'s static imports from NotePage -> throws', () => {
  const { assets, cleanup } = fakeAssets({ ...MATH_BASE, 'NotePage-Def456.js': 'import{a}from"./mid-Q1.js";x', 'mid-Q1.js': 'import"./katex-Kkk000.js";export const a=1' });
  try {
    assert.throws(() => checkBundleSize(assets), /NotePage-Def456\.js 的靜態 import 閉包碰到 KaTeX：\[katex-Kkk000\.js\]/);
  } finally {
    cleanup();
  }
});

test('dynamic import("./katex-*.js") (lib/katex.ts, mermaid, including the mapDeps list entry) -> passes', () => {
  const { assets, cleanup } = fakeAssets({
    ...MATH_BASE,
    'NotePage-Def456.js': 'const f=()=>import("./katex-Kkk000.js");const d=["assets/katex-Kkk000.js","assets/katex-Ccc111.css"]',
    'mermaid.core-Ghi789.js': 'const g=async()=>await import("./katex-Kkk000.js")',
  });
  try {
    assert.doesNotThrow(() => checkBundleSize(assets));
  } finally {
    cleanup();
  }
});

test('KATEX_RE matches only katex-<hash>.js', () => {
  assert.ok(KATEX_RE.test('katex-HP8lGamR.js'));
  for (const bad of ['katex.js', 'katex-HP8lGamR.css', 'xkatex-HP8lGamR.js', 'KaTeX_Main-Regular-B22Nviop.woff2', 'katex-HP8lGamR.js.map']) assert.ok(!KATEX_RE.test(bad), bad);
});

test('entry CSS containing KaTeX\'s classes or fonts -> throws; our own .katex rule and a lazy CSS carrying KaTeX do not count', () => {
  for (const marker of KATEX_CSS_MARKERS) {
    const bad = fakeAssets({ ...MATH_BASE, 'index-Css111.css': `.x{}${marker}{display:block}` });
    try {
      assert.throws(() => checkBundleSize(bad.assets), new RegExp(`index-Css111\\.css[^]*${marker.replace('.', '[.]')}`), marker);
    } finally {
      bad.cleanup();
    }
  }
  const ok = fakeAssets({
    ...MATH_BASE,
    'index-Css111.css': '.katex .cjk_fallback.cjk_fallback{font-family:var(--font-body)}',
    'katex-Css222.css': '.katex-display{display:block}@font-face{font-family:KaTeX_Main}',
  });
  try {
    assert.doesNotThrow(() => checkBundleSize(ok.assets));
  } finally {
    ok.cleanup();
  }
});

test('entry containing the math string pack\'s key -> throws, message names the entry and the key', () => {
  const { assets, cleanup } = fakeAssets({ ...MATH_BASE, 'index-Abc123.js': `const s={${MATH_I18N_MARKER}:"x"}` });
  try {
    assert.throws(() => checkBundleSize(assets), (err) => err.message.includes('index-Abc123.js') && err.message.includes(MATH_I18N_MARKER) && err.message.includes('math-strings'));
  } finally {
    cleanup();
  }
});

test('no lazy chunk carries the math string pack\'s key (pack lost, or key renamed) -> throws (fail-closed); only the entry carrying it does not count as lazy', () => {
  const { 'math-strings-Mmm000.js': _pack, ...withoutPack } = MATH_BASE;
  const { assets, cleanup } = fakeAssets(withoutPack);
  try {
    assert.throws(() => checkBundleSize(assets), /沒有任何 lazy chunk 含數學式字串包的鍵值 sourceFallback:"/);
  } finally {
    cleanup();
  }
});

test('a lazy chunk that only calls t("note.math.sourceFallback") does not count as the string pack -> throws (fail-closed)', () => {
  const { 'math-strings-Mmm000.js': _pack, ...withoutPack } = MATH_BASE;
  const { assets, cleanup } = fakeAssets({ ...withoutPack, 'PresentationOverlay-Pqr678.js': `x(t("note.math.${MATH_I18N_MARKER}"))` });
  try {
    assert.throws(() => checkBundleSize(assets), /沒有任何 lazy chunk 含數學式字串包的鍵值/);
  } finally {
    cleanup();
  }
});

// A renamed or moved marker silently stops working - bind each one back to the real file it was taken from.
test('KATEX_MARKER is the string literal in the installed katex package, and MATH_I18N_MARKER a key only math.*.json has', () => {
  const katexSource = readFileSync(fileURLToPath(new URL('../apps/web/node_modules/katex/dist/katex.mjs', import.meta.url)), 'utf8');
  assert.ok(katexSource.includes(`"${KATEX_MARKER}: "`), 'katex.mjs 不再含 "KaTeX parse error: "——請改挑新的 KaTeX 獨有字面並更新 KATEX_MARKER');
  const katexCss = readFileSync(fileURLToPath(new URL('../apps/web/node_modules/katex/dist/katex.min.css', import.meta.url)), 'utf8');
  assert.deepEqual(KATEX_CSS_MARKERS, ['.katex-display', 'KaTeX_Main']);
  for (const marker of KATEX_CSS_MARKERS) assert.ok(katexCss.includes(marker), `katex.min.css 不再含 ${marker}——請同步更新 KATEX_CSS_MARKERS`);
  const i18n = (name) => readFileSync(fileURLToPath(new URL(`../apps/web/src/i18n/${name}`, import.meta.url)), 'utf8');
  for (const name of ['math.en.json', 'math.zh-TW.json']) assert.ok(JSON.parse(i18n(name)).note.math[MATH_I18N_MARKER], `${name} 沒有 note.math.${MATH_I18N_MARKER}`);
  for (const name of ['en.json', 'zh-TW.json']) assert.ok(!i18n(name).includes(`"${MATH_I18N_MARKER}"`), `${name} 含 ${MATH_I18N_MARKER}——它不再是只在 math.*.json 的鍵`);
});

test('comments panel chunk missing -> throws', () => {
  const files = { ...MARKER_BASE, 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x' };
  delete files['CommentsLazy-Ccc000.js'];
  const { assets, cleanup } = fakeAssets(files);
  try {
    assert.throws(() => checkBundleSize(assets), /CommentsLazy/);
  } finally {
    cleanup();
  }
});

test('comments string pack key in entry or NotePage -> throws', () => {
  for (const at of ['index-Abc123.js', 'NotePage-Def456.js']) {
    const { assets, cleanup } = fakeAssets({ ...MARKER_BASE, 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x', [at]: `const s={${COMMENTS_I18N_MARKER}:"x"}` });
    try {
      assert.throws(() => checkBundleSize(assets), (err) => err.message.startsWith(at) && err.message.includes(COMMENTS_I18N_MARKER));
    } finally {
      cleanup();
    }
  }
});

test('comments string pack reachable only through a chunk the panel imports -> passes; not reachable at all -> throws', () => {
  const shared = { ...MARKER_BASE, 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x' };
  let fixture = fakeAssets({ ...shared, 'CommentsLazy-Ccc000.js': 'import{a}from"./comments-strings-Qqq000.js";', 'comments-strings-Qqq000.js': `const c={${COMMENTS_I18N_MARKER}:"x"}` });
  try {
    assert.deepEqual(checkBundleSize(fixture.assets).commentsChunks, ['CommentsLazy-Ccc000.js']);
  } finally {
    fixture.cleanup();
  }
  fixture = fakeAssets({ ...shared, 'CommentsLazy-Ccc000.js': 'x' });
  try {
    assert.throws(() => checkBundleSize(fixture.assets), /CommentsLazy-Ccc000\.js[\s\S]*answeredDeleted/);
  } finally {
    fixture.cleanup();
  }
});

test('COMMENTS_I18N_MARKER is a comments.* key in comments.en.json, not in the main en.json', () => {
  const read = name => JSON.parse(readFileSync(fileURLToPath(new URL(`../apps/web/src/i18n/${name}`, import.meta.url)), 'utf8'));
  assert.equal(typeof read('comments.en.json').comments?.[COMMENTS_I18N_MARKER], 'string');
  assert.equal(read('en.json').comments, undefined);
});

test('notification list chunk missing -> throws', () => {
  const files = { ...MARKER_BASE, 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x' };
  delete files['NotificationsLazy-Nnn000.js'];
  const { assets, cleanup } = fakeAssets(files);
  try {
    assert.throws(() => checkBundleSize(assets), /NotificationsLazy/);
  } finally {
    cleanup();
  }
});

test('notification string pack key in entry or NotePage -> throws', () => {
  for (const at of ['index-Abc123.js', 'NotePage-Def456.js']) {
    const { assets, cleanup } = fakeAssets({ ...MARKER_BASE, 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x', [at]: `const s={${NOTIFICATIONS_I18N_MARKER}:"x"}` });
    try {
      assert.throws(() => checkBundleSize(assets), (err) => err.message.startsWith(at) && err.message.includes(NOTIFICATIONS_I18N_MARKER));
    } finally {
      cleanup();
    }
  }
});

test('notification string pack reachable only through a chunk the list imports -> passes; not reachable at all -> throws', () => {
  const shared = { ...MARKER_BASE, 'NotePage-Def456.js': 'x', 'VersionsLazy-Vvv000.js': 'x' };
  let fixture = fakeAssets({ ...shared, 'NotificationsLazy-Nnn000.js': 'import{a}from"./notifications-strings-Qqq000.js";', 'notifications-strings-Qqq000.js': `const c={${NOTIFICATIONS_I18N_MARKER}:"x"}` });
  try {
    assert.deepEqual(checkBundleSize(fixture.assets).notificationsChunks, ['NotificationsLazy-Nnn000.js']);
  } finally {
    fixture.cleanup();
  }
  fixture = fakeAssets({ ...shared, 'NotificationsLazy-Nnn000.js': 'x' });
  try {
    assert.throws(() => checkBundleSize(fixture.assets), /NotificationsLazy-Nnn000\.js[\s\S]*cantOpen/);
  } finally {
    fixture.cleanup();
  }
});

test('NOTIFICATIONS_I18N_MARKER is a notifications.* key in notifications.en.json, not in the main en.json', () => {
  const read = name => JSON.parse(readFileSync(fileURLToPath(new URL(`../apps/web/src/i18n/${name}`, import.meta.url)), 'utf8'));
  assert.equal(typeof read('notifications.en.json').notifications?.[NOTIFICATIONS_I18N_MARKER], 'string');
  assert.equal(read('en.json').notifications, undefined);
});
