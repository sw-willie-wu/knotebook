// Only targets with a custom public URL (public_slug and public_token): token-only (secret) links must never appear in a public payload; group notes have no alias. Same predicates as the alias lookup in `routes/public.ts`. Excludes the note itself and trashed targets, caps at `MAX_LINK_TARGETS`; token-only targets are excluded even in the same space.
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import * as Y from "yjs";
import { MAX_LINK_TARGETS, extractLinkTargets, publicAliasPath, type PublicLinkDto } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { notes, users } from "../db/schema.js";

export async function publicLinksFor(db: Db, noteId: string, doc: Y.Doc | null): Promise<PublicLinkDto[]> {
  if (doc === null) return [];
  const self = noteId.toLowerCase();
  const ids = [...new Set(extractLinkTargets(doc).map(id => id.toLowerCase()))].filter(id => id !== self).slice(0, MAX_LINK_TARGETS);
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: notes.id, title: notes.title, handle: users.handle, publicSlug: notes.publicSlug })
    .from(notes)
    .innerJoin(users, eq(users.id, notes.ownerId))
    .where(and(inArray(notes.id, ids), isNotNull(notes.publicSlug), isNotNull(notes.publicToken), isNull(notes.deletedAt)));
  return rows.map(r => ({ id: r.id, title: r.title, path: publicAliasPath({ handle: r.handle, slug: r.publicSlug! }) }));
}
