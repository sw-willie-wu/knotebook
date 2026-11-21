// Kept apart from `tags.ts` so the first bundle can use the key without pulling in every tag hook.
export type TagSpaceRef = { kind: "personal" } | { kind: "group"; groupId: string };

export function spaceTagsKey(space: TagSpaceRef): readonly unknown[] {
  return space.kind === "personal" ? ["tags", "personal"] : ["tags", "group", space.groupId];
}
