import { vi } from "vitest";
import type { CommentDto, CommentListDto } from "@knotebook/shared";

export const COMMENT_NOTE = "11111111-1111-4111-8111-111111111111";

export function cid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

export function comment(n: number, over: Partial<CommentDto> = {}): CommentDto {
  return {
    id: cid(n),
    noteId: COMMENT_NOTE,
    authorId: "u-bob",
    authorHandle: "bob",
    authorDisplayName: "Bob",
    authorAvatar: null,
    agentLabel: null,
    replyToId: null,
    replyTo: null,
    anchor: null,
    body: `comment ${n}`,
    mentions: [],
    createdAt: new Date(Date.UTC(2026, 0, 1, 0, n)).toISOString(),
    editedAt: null,
    canEdit: false,
    canDelete: false,
    ...over,
  };
}

export function page(ns: number[], olderCursor: string | null = null, newerCursor: string | null = null): CommentListDto {
  return { comments: ns.map((n) => comment(n)), olderCursor, newerCursor };
}

export const listUrl = (query: string) => `/api/notes/${COMMENT_NOTE}/comments?${query}`;
export const NEWEST_URL = listUrl("limit=50");

export function json(body: unknown, status = 200): Response {
  return status === 204 ? new Response(null, { status }) : new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export const notFound = (code: string) => json({ error: { code, message: "Not found" } }, 404);

/** `routes` maps "METHOD url" (or a bare url for GET) to a response or a function returning one; anything else throws. */
export function stubCommentFetch(routes: Record<string, Response | ((init?: RequestInit) => Response)>) {
  const calls: { method: string; url: string; body?: string }[] = [];
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    const hit = routes[`${method} ${url}`] ?? (method === "GET" ? routes[url] : undefined);
    if (hit === undefined) throw new Error(`unexpected fetch: ${method} ${url}`);
    const res = typeof hit === "function" ? hit(init) : hit;
    return Promise.resolve(res.clone());
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

/** Stand-in for the provider's `on` / `off` / `emit` of `stateless` and `synced`. */
export function createLiveSource() {
  const listeners = new Map<string, Set<(arg: never) => void>>();
  return {
    on(event: string, fn: (arg: never) => void) {
      let set = listeners.get(event);
      if (!set) listeners.set(event, (set = new Set()));
      set.add(fn);
    },
    off(event: string, fn: (arg: never) => void) {
      listeners.get(event)?.delete(fn);
    },
    emit(event: string, arg?: unknown) {
      listeners.get(event)?.forEach((fn) => fn(arg as never));
    },
    stateless(op: "created" | "edited" | "deleted" | "cleared", commentId: string) {
      this.emit("stateless", { payload: JSON.stringify({ type: "comment", op, commentId }) });
    },
    count(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
  };
}
