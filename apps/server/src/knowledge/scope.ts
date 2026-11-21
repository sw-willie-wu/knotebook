// The scope is decided before the index transaction; what the viewer may see inside it is decided again, in that transaction, by the visibility branches.
import { and, eq, sql } from "drizzle-orm";
import type { KnowledgeIndexScopeRef } from "@knotebook/shared";
import type { Db } from "../db/index.js";
import { groupMembers, groupRoles, groups } from "../db/schema.js";
import { resolveFolderAccess } from "../folders/queries.js";
import { folderPathJsonSql } from "../folders/sql.js";
import { UUID_RE } from "../notes/service.js";

type SpaceScope = { kind: "personal"; ownerId: string } | { kind: "group"; groupId: string; groupName: string };

export type KnowledgeScope =
  | { kind: "personal"; ownerId: string }
  | { kind: "group"; groupId: string; groupName: string }
  | { kind: "folder"; folderId: string; space: SpaceScope; path: string[] };

/** Null for everything the caller may not open, whatever the reason: callers answer all of them alike. */
export async function resolveKnowledgeScope(db: Db, userId: string, ref: KnowledgeIndexScopeRef): Promise<KnowledgeScope | null> {
  if (ref.kind === "personal") return { kind: "personal", ownerId: userId };
  if (ref.kind === "group") {
    const group = await readableGroup(db, userId, ref.groupId);
    return group === null ? null : { kind: "group", groupId: group.id, groupName: group.name };
  }
  // A group's membership check is part of `resolveFolderAccess`; a site admin who isn't a member gets no flags there and so no folder.
  const access = await resolveFolderAccess(db, userId, ref.folderId);
  if (access === null || access.space.kind === "shared") return null;
  const groupId = access.space.kind === "group" ? access.space.groupId : null;
  const {
    rows: [row],
  } = await db.execute<{ path: string[] | null; group_name: string | null }>(
    sql`select ${folderPathJsonSql(sql`${access.folder.id}::uuid`)} as path, (select g.name from ${groups} g where g.id = ${groupId}::uuid) as group_name`,
  );
  const path = row?.path ?? [];
  if (access.space.kind === "personal") {
    return { kind: "folder", folderId: access.folder.id, space: { kind: "personal", ownerId: access.space.ownerId }, path };
  }
  if (row?.group_name == null) return null;
  return { kind: "folder", folderId: access.folder.id, space: { kind: "group", groupId: access.space.groupId, groupName: row.group_name }, path };
}

async function readableGroup(db: Db, userId: string, groupId: string): Promise<{ id: string; name: string } | null> {
  if (!UUID_RE.test(groupId)) return null;
  const [row] = await db
    .select({ id: groups.id, name: groups.name })
    .from(groupMembers)
    .innerJoin(groupRoles, and(eq(groupRoles.id, groupMembers.roleId), eq(groupRoles.canRead, true)))
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .where(and(eq(groupMembers.groupId, groupId.toLowerCase()), eq(groupMembers.userId, userId)));
  return row ?? null;
}
