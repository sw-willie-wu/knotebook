import type { QueryClient } from "@tanstack/react-query";
import { ApiFail } from "@/api/client";
import { spaceTagsKey, type TagSpaceRef } from "@/api/tags";

/** A write that finds the tag already gone (merged away or deleted by someone else) leaves the cached list showing it, and nothing else would refetch. */
export function isTagGone(err: unknown): boolean {
  return err instanceof ApiFail && err.code === "tag_not_found";
}

export function refreshAfterTagGone(queryClient: QueryClient, space: TagSpaceRef): void {
  void queryClient.invalidateQueries({ queryKey: spaceTagsKey(space) });
  void queryClient.invalidateQueries({ queryKey: ["notes"] });
}
