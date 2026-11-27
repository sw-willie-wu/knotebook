import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { MENTION_CANDIDATES_MAX, type CommentDto, type CommentListDto, type CommentUnreadCountDto, type MentionCandidateDto, type UserDto } from "@knotebook/shared";
import { SESSION_QUERY_KEY } from "@/auth/useSession";
import { api, ApiFail } from "./client";

export const COMMENTS_PAGE_SIZE = 50;

/**
 * Under `['notes']`, like versions: a move that clears history invalidates `['notes']`, which reloads an open thread.
 * The user id is in the key because logout doesn't clear the cache and the comments carry per-viewer `canEdit` / `canDelete`.
 */
export function commentsKey(noteId: string, userId: string | null) {
  return ["notes", noteId, "comments", userId] as const;
}

export function commentListsKey(noteId: string, userId: string | null) {
  return [...commentsKey(noteId, userId), "list"] as const;
}

/** `around` null = the newest page. */
export function commentListKey(noteId: string, userId: string | null, around: string | null) {
  return [...commentListsKey(noteId, userId), around ?? "newest"] as const;
}

export function commentUnreadKey(noteId: string, userId: string | null) {
  return [...commentsKey(noteId, userId), "unread"] as const;
}

export function sessionUserId(queryClient: QueryClient): string | null {
  return queryClient.getQueryData<UserDto | null>(SESSION_QUERY_KEY)?.id ?? null;
}

export type CommentPageParam =
  | { kind: "newest" }
  | { kind: "around"; commentId: string }
  | { kind: "before"; cursor: string }
  | { kind: "after"; cursor: string };

export type CommentPages = InfiniteData<CommentListDto, CommentPageParam>;

const noteBase = (noteId: string) => `/api/notes/${encodeURIComponent(noteId)}/comments`;
const commentBase = (commentId: string) => `/api/comments/${encodeURIComponent(commentId)}`;

export function fetchCommentPage(noteId: string, param: CommentPageParam, limit = COMMENTS_PAGE_SIZE, signal?: AbortSignal): Promise<CommentListDto> {
  const params = new URLSearchParams();
  if (param.kind === "around") params.set("around", param.commentId);
  else if (param.kind === "before") params.set("before", param.cursor);
  else if (param.kind === "after") params.set("after", param.cursor);
  params.set("limit", String(limit));
  return api<CommentListDto>(`${noteBase(noteId)}?${params.toString()}`, { signal });
}

export function fetchComment(commentId: string): Promise<CommentDto> {
  return api<CommentDto>(commentBase(commentId));
}

export function postComment(
  noteId: string,
  body: { body: string; replyToId?: string | null; anchor?: { blockId: string; quote: string | null } },
): Promise<CommentDto> {
  return api<CommentDto>(noteBase(noteId), { method: "POST", body: JSON.stringify(body) });
}

export function editComment(commentId: string, body: string): Promise<CommentDto> {
  return api<CommentDto>(commentBase(commentId), { method: "PATCH", body: JSON.stringify({ body }) });
}

export function deleteComment(commentId: string): Promise<void> {
  return api<void>(commentBase(commentId), { method: "DELETE" });
}

export function markCommentsRead(noteId: string): Promise<void> {
  return api<void>(`${noteBase(noteId)}/read`, { method: "POST" });
}

export function useCommentList(noteId: string, around: string | null, enabled: boolean) {
  const queryClient = useQueryClient();
  const base = queryClient.getDefaultOptions().queries?.retry ?? 3;
  const userId = sessionUserId(queryClient);
  return useInfiniteQuery({
    queryKey: commentListKey(noteId, userId, around),
    queryFn: ({ pageParam, signal }) => fetchCommentPage(noteId, pageParam, COMMENTS_PAGE_SIZE, signal),
    initialPageParam: (around === null ? { kind: "newest" } : { kind: "around", commentId: around }) as CommentPageParam,
    getPreviousPageParam: (first): CommentPageParam | undefined => (first.olderCursor === null ? undefined : { kind: "before", cursor: first.olderCursor }),
    getNextPageParam: (last): CommentPageParam | undefined => (last.newerCursor === null ? undefined : { kind: "after", cursor: last.newerCursor }),
    enabled: enabled && noteId.length > 0,
    // A comment that no longer exists stays missing: the panel falls back to the newest page at once instead of after the backoff.
    retry: (count, error) => {
      if (error instanceof ApiFail && error.status === 404) return false;
      if (typeof base === "function") return base(count, error);
      return typeof base === "number" ? count < base : base;
    },
  });
}

export function useCommentUnreadCount(noteId: string | null, enabled: boolean) {
  const userId = sessionUserId(useQueryClient());
  return useQuery({
    queryKey: commentUnreadKey(noteId ?? "", userId),
    queryFn: () => api<CommentUnreadCountDto>(`${noteBase(noteId!)}/unread-count`),
    enabled: enabled && noteId !== null,
  });
}

function sortKey(c: CommentDto): string {
  return `${c.createdAt}\u0000${c.id}`;
}

function mapLists(queryClient: QueryClient, noteId: string, fn: (data: CommentPages) => CommentPages): void {
  queryClient.setQueriesData<CommentPages>({ queryKey: commentListsKey(noteId, sessionUserId(queryClient)) }, (data) => (data === undefined ? data : fn(data)));
}

/** A list refetch already in flight resolves with what the server had before this change; restarting it makes it include the change. */
function restartListRefetches(queryClient: QueryClient, noteId: string): void {
  const queryKey = commentListsKey(noteId, sessionUserId(queryClient));
  if (queryClient.isFetching({ queryKey }) === 0) return;
  void queryClient.invalidateQueries({ queryKey });
  // A first load has no data to keep, so invalidating returns the running fetch instead of restarting it.
  const firstLoad = { queryKey, predicate: (q: { state: { data: unknown; fetchStatus: string } }) => q.state.data === undefined && q.state.fetchStatus === "fetching" };
  if (queryClient.isFetching(firstLoad) > 0) void queryClient.cancelQueries(firstLoad).then(() => queryClient.refetchQueries({ ...firstLoad, predicate: (q) => q.state.data === undefined, type: "active" }));
}

const DELETED_MEMORY_MS = 60_000;
const deletedByClient = new WeakMap<QueryClient, Map<string, number>>();

function recentlyDeleted(queryClient: QueryClient): Map<string, number> {
  let ids = deletedByClient.get(queryClient);
  if (ids === undefined) deletedByClient.set(queryClient, (ids = new Map()));
  return ids;
}

function wasDeleted(queryClient: QueryClient, commentId: string): boolean {
  const ids = recentlyDeleted(queryClient);
  const now = Date.now();
  for (const [id, at] of ids) if (now - at > DELETED_MEMORY_MS) ids.delete(id);
  return ids.has(commentId);
}

function version(c: CommentDto): number {
  return Date.parse(c.editedAt ?? c.createdAt);
}

function mapComments(data: CommentPages, fn: (c: CommentDto) => CommentDto | null): CommentPages {
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      comments: page.comments.flatMap((c) => {
        const next = fn(c);
        return next === null ? [] : [next];
      }),
    })),
  };
}

function contains(data: CommentPages, id: string): boolean {
  return data.pages.some((p) => p.comments.some((c) => c.id === id));
}

/** A new comment belongs at the end only of a range that reaches the newest one. */
export function reachesNewest(data: CommentPages | undefined): boolean {
  const last = data?.pages[data.pages.length - 1];
  return last !== undefined && last.newerCursor === null;
}

/** Live messages trigger one fetch each, with no ordering: a response older than what is cached, or for a comment already deleted, is dropped. */
export function mergeComment(queryClient: QueryClient, comment: CommentDto, { append }: { append: boolean }): void {
  if (wasDeleted(queryClient, comment.id)) return;
  mapLists(queryClient, comment.noteId, (data) => {
    if (contains(data, comment.id)) return mapComments(data, (c) => (c.id === comment.id ? (version(comment) < version(c) ? c : comment) : c));
    if (!append || !reachesNewest(data)) return data;
    const pages = data.pages.slice();
    const last = pages[pages.length - 1]!;
    const comments = [...last.comments, comment].sort((a, b) => (sortKey(a) < sortKey(b) ? -1 : sortKey(a) > sortKey(b) ? 1 : 0));
    pages[pages.length - 1] = { ...last, comments };
    return { ...data, pages };
  });
  restartListRefetches(queryClient, comment.noteId);
}

/** A reply left with `replyToId` but no `replyTo` reads as answering a deleted comment. */
export function removeComment(queryClient: QueryClient, noteId: string, commentId: string): void {
  recentlyDeleted(queryClient).set(commentId, Date.now());
  mapLists(queryClient, noteId, (data) =>
    mapComments(data, (c) => (c.id === commentId ? null : c.replyTo?.id === commentId ? { ...c, replyTo: null } : c)),
  );
  restartListRefetches(queryClient, noteId);
}

export type CommentChangeOp = "created" | "edited" | "deleted" | "cleared";

/** Fetches the comment only when a thread is loaded; the unread count is refetched either way. */
export async function applyCommentChange(queryClient: QueryClient, noteId: string, op: CommentChangeOp, commentId: string): Promise<void> {
  const userId = sessionUserId(queryClient);
  void queryClient.invalidateQueries({ queryKey: commentUnreadKey(noteId, userId) });
  if (op === "cleared") {
    void queryClient.invalidateQueries({ queryKey: commentListsKey(noteId, userId) });
    return;
  }
  const lists = queryClient.getQueriesData<CommentPages>({ queryKey: commentListsKey(noteId, userId) }).filter(([, data]) => data !== undefined);
  if (lists.length === 0) {
    restartListRefetches(queryClient, noteId);
    return;
  }
  if (op === "deleted") {
    removeComment(queryClient, noteId, commentId);
    return;
  }
  if (op === "edited" && !lists.some(([, data]) => contains(data!, commentId))) return;
  let comment: CommentDto;
  try {
    comment = await fetchComment(commentId);
  } catch (err) {
    // Deleted again before we asked; anything else waits for the next refetch.
    if (err instanceof ApiFail && err.status === 404) removeComment(queryClient, noteId, commentId);
    return;
  }
  if (comment.noteId !== noteId) return;
  mergeComment(queryClient, comment, { append: op === "created" });
}

export function listHasComment(queryClient: QueryClient, noteId: string, around: string | null, commentId: string): boolean {
  const data = queryClient.getQueryData<CommentPages>(commentListKey(noteId, sessionUserId(queryClient), around));
  return data !== undefined && contains(data, commentId);
}

export function usePostComment(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof postComment>[1]) => postComment(noteId, body),
    onSuccess: (comment) => mergeComment(queryClient, comment, { append: true }),
  });
}

export function useEditComment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ commentId, body }: { commentId: string; body: string }) => editComment(commentId, body),
    onSuccess: (comment) => mergeComment(queryClient, comment, { append: false }),
  });
}

export function useDeleteComment(noteId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (commentId: string) => deleteComment(commentId),
    onSuccess: (_void, commentId) => removeComment(queryClient, noteId, commentId),
  });
}

export function mentionCandidatesKey(noteId: string, userId: string | null, q: string) {
  return [...commentsKey(noteId, userId), "candidates", q] as const;
}

export async function fetchMentionCandidates(noteId: string, q: string): Promise<MentionCandidateDto[]> {
  const res = await api<{ candidates: MentionCandidateDto[] }>(`/api/notes/${encodeURIComponent(noteId)}/mention-candidates?q=${encodeURIComponent(q)}`);
  return res.candidates;
}

function mentionCandidatesOptions(noteId: string, userId: string | null, q: string) {
  return {
    queryKey: mentionCandidatesKey(noteId, userId, q),
    queryFn: () => fetchMentionCandidates(noteId, q),
    staleTime: 30_000,
    retry: false,
  };
}

/** A failed query just means no list. */
export function useMentionCandidates(noteId: string, q: string | null, enabled: boolean) {
  const queryClient = useQueryClient();
  const userId = sessionUserId(queryClient);
  return useQuery({
    ...mentionCandidatesOptions(noteId, userId, q ?? ""),
    enabled: enabled && q !== null,
    placeholderData: (previous: MentionCandidateDto[] | undefined) => previous,
  });
}

/** Handles that no candidate query returned: nobody is notified for them. A handle whose query failed is not reported. */
export function useUnmatchedHandles(noteId: string, handles: readonly string[]): string[] {
  const queryClient = useQueryClient();
  const userId = sessionUserId(queryClient);
  const result = useQuery({
    queryKey: [...commentsKey(noteId, userId), "unmatched", handles.join(",")],
    queryFn: async () => {
      const unmatched: string[] = [];
      for (const h of handles) {
        try {
          const found = await queryClient.fetchQuery(mentionCandidatesOptions(noteId, userId, h));
          // A full page may have cut the exact handle off, so only a short list is a verdict.
          if (found.length < MENTION_CANDIDATES_MAX && !found.some((c) => c.handle.toLowerCase() === h)) unmatched.push(h);
        } catch {
          // No answer is not a verdict.
        }
      }
      return unmatched;
    },
    enabled: handles.length > 0,
    staleTime: 30_000,
    retry: false,
    placeholderData: (previous: string[] | undefined) => previous,
  });
  return (result.data ?? []).filter((h) => handles.includes(h));
}
