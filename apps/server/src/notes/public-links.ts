/**
 * #269 §11.1（E8'）：公開頁的 `links`——只收有**自訂公開網址**的目標（`public_slug IS NOT NULL AND public_token IS NOT NULL`，
 * INNER JOIN `users` 取 handle：與 `routes/public.ts` 別名形 lookup 同一組述詞，殘留別名讀不到）。只有 token 形公開的目標一律
 * 不收、不論與來源是否同空間 ⇒ 秘密連結永不出現在任何公開 payload。群組筆記沒有別名（`notes_group_no_public_slug_chk`）⇒ 永不收。
 * 去掉本篇自己（`extractLinkTargets` 不濾自身）；截 `MAX_LINK_TARGETS`；一句 SQL。
 */
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import * as Y from "yjs";
import { MAX_LINK_TARGETS, extractLinkTargets, publicAliasPath, type PublicLinkDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { notes, users } from "../db/schema.js";

export async function publicLinksFor(db: Db, noteId: string, ydoc: Uint8Array | null): Promise<PublicLinkDto[]> {
  if (ydoc === null) return [];
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, ydoc);
  } catch {
    return []; // 快照壞掉：公開頁照樣回內容（client 解碼失敗另有錯誤卡），links 給空
  }
  const self = noteId.toLowerCase();
  const ids = [...new Set(extractLinkTargets(doc).map(id => id.toLowerCase()))].filter(id => id !== self).slice(0, MAX_LINK_TARGETS);
  doc.destroy();
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: notes.id, title: notes.title, handle: users.handle, publicSlug: notes.publicSlug })
    .from(notes)
    .innerJoin(users, eq(users.id, notes.ownerId))
    .where(and(inArray(notes.id, ids), isNotNull(notes.publicSlug), isNotNull(notes.publicToken)));
  return rows.map(r => ({ id: r.id, title: r.title, path: publicAliasPath({ handle: r.handle, slug: r.publicSlug! }) }));
}
