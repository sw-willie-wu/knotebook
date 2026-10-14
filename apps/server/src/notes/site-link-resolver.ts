/**
 * #269 §6.6：轉換工作的站內網址解析——在 mount **之前**、可以查 DB（不持 lease）。以 href 為鍵 memo；回 DB 現值 `{ id, title }`。
 * - `{ kind: "user", userId }`（個人筆記的 owner）：路徑 → 候選 id（`/n/`、`/g/` 走 `resolveNotePath`——含轉址表與 prev_slug；
 *   `/notes/<ref>` 走 `resolveNoteIdFromRef`——含 legacy slug）→ `resolveNoteAccess(owner, id).role !== "none"` 才收。
 * - `{ kind: "group", groupId }`（群組筆記，E9'）：同樣找候選，只收 `target.group_id === groupId`，不做使用者授權。
 */
import { eq } from "drizzle-orm";
import type { SiteLinkTarget, SiteNoteHref } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { notes, users } from "../db/schema.js";
import { groupNotePath, userNotePath } from "./redirects.js";
import { resolveNotePath, type PathRowSource } from "./resolve-path.js";
import { resolveNoteAccess } from "./service.js";
import { resolveNoteIdFromRef } from "./slug.js";

export type SiteLinkScope = { kind: "user"; userId: string } | { kind: "group"; groupId: string };

export interface SiteLinkResolver {
  resolve(href: string, parsed: SiteNoteHref): Promise<SiteLinkTarget | null>;
}

interface Row {
  id: string;
  title: string;
  groupId: string | null;
}

export function createSiteLinkResolver(db: Db, scope: SiteLinkScope): SiteLinkResolver {
  const cols = { id: notes.id, title: notes.title, groupId: notes.groupId };
  const rows: PathRowSource<Row> = {
    where: (cond, limit) => db.select(cols).from(notes).leftJoin(users, eq(users.id, notes.ownerId)).where(cond).limit(limit),
    byId: async noteId => (await db.select(cols).from(notes).where(eq(notes.id, noteId)).limit(1))[0],
  };

  async function candidate(parsed: SiteNoteHref): Promise<Row | undefined> {
    const p = parsed.path;
    if (p.kind === "n") return resolveNotePath(db, rows, eq(users.handle, p.handle), p.slug, userNotePath(p.handle, p.slug));
    if (p.kind === "g") return resolveNotePath(db, rows, eq(notes.groupId, p.groupId), p.slug, groupNotePath(p.groupId, p.slug));
    const id = await resolveNoteIdFromRef(db, p.ref);
    return id === null ? undefined : rows.byId(id);
  }

  async function lookup(parsed: SiteNoteHref): Promise<SiteLinkTarget | null> {
    const row = await candidate(parsed);
    if (!row) return null;
    if (scope.kind === "group") return row.groupId === scope.groupId ? { id: row.id, title: row.title } : null;
    const access = await resolveNoteAccess(db, scope.userId, row.id);
    return access.role !== "none" ? { id: row.id, title: row.title } : null;
  }

  const memo = new Map<string, Promise<SiteLinkTarget | null>>();
  return {
    resolve(href, parsed) {
      let hit = memo.get(href);
      if (!hit) {
        hit = lookup(parsed);
        memo.set(href, hit);
      }
      return hit;
    },
  };
}
