/**
 * bulk transfer spec 2026-11-02 §6.4：一篇檔案的 frontmatter（寫出半；讀入在 PR-2）。
 *
 * 鍵序固定（§6.4 的表）：`knotebook`、`id`、`title`、`role`、`base`、`url`。`title` 一律 `JSON.stringify`（逸出 `"`、`\`、
 * 換行，所以永遠單行；PR-2 的讀法以 `"` 開頭 → `JSON.parse`，逐字往返）。其餘值是 uuid／角色名／16 hex／站內路徑，原樣寫。
 * 本文原樣接在第二條 `---` 之後（就是整篇匯出原文，不正規化）。
 */

/** §21 D4：檔案格式版本。 */
export const TRANSFER_FILE_VERSION = 1;

export function writeNoteFile(fm: { id: string; title: string; role: string; base: string; url: string }, body: string): string {
  return (
    "---\n" +
    `knotebook: ${TRANSFER_FILE_VERSION}\n` +
    `id: ${fm.id}\n` +
    `title: ${JSON.stringify(fm.title)}\n` +
    `role: ${fm.role}\n` +
    `base: ${fm.base}\n` +
    `url: ${fm.url}\n` +
    "---\n" +
    body
  );
}
