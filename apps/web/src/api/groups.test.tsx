import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type { GroupDto, GroupMemberDto } from "@knotebook/shared";
import {
  GROUPS_QUERY_KEY,
  groupMembersKey,
  useAddMember,
  useCreateGroup,
  useDeleteGroup,
  useGroupMembers,
  useGroups,
  useRemoveMember,
  useRenameGroup,
  useSetMemberRole,
} from "./groups";
import { useCreateNote } from "./notes";

const GROUP: GroupDto = { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "工作坊", myRole: "admin", createdAt: "2026-09-26T00:00:00.000Z" };
const MEMBER: GroupMemberDto = { userId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", email: "bob@example.com", displayName: "Bob", role: "member" };

function fakeResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)),
  } as unknown as Response;
}

/** 記錄每次呼叫的 method/url/body，依表分派回應；未列的 throw（慣例）。 */
function stubFetch(routes: Record<string, () => Response>) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      const handler = routes[`${method} ${url}`];
      if (!handler) throw new Error(`unexpected fetch: ${method} ${url}`);
      return Promise.resolve(handler());
    }),
  );
  return calls;
}

function wrapper(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe("api/groups", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("useGroups 打 GET /api/groups，key 是 ['groups']", async () => {
    stubFetch({ "GET /api/groups": () => fakeResponse(200, [GROUP]) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useGroups(), { wrapper: wrapper(queryClient) });
    await waitFor(() => expect(result.current.data).toEqual([GROUP]));
    expect(queryClient.getQueryData(GROUPS_QUERY_KEY)).toEqual([GROUP]);
  });

  it("useGroupMembers 打 GET /api/groups/:id/members；enabled:false 時不打", async () => {
    const calls = stubFetch({ [`GET /api/groups/${GROUP.id}/members`]: () => fakeResponse(200, [MEMBER]) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const disabled = renderHook(() => useGroupMembers(GROUP.id, { enabled: false }), { wrapper: wrapper(queryClient) });
    expect(disabled.result.current.fetchStatus).toBe("idle");
    expect(calls).toHaveLength(0);

    const { result } = renderHook(() => useGroupMembers(GROUP.id), { wrapper: wrapper(queryClient) });
    await waitFor(() => expect(result.current.data).toEqual([MEMBER]));
    expect(queryClient.getQueryData(groupMembersKey(GROUP.id))).toEqual([MEMBER]);
  });

  it("useCreateGroup：POST {name}，成功後 invalidate ['groups'] 與 ['notes']", async () => {
    const calls = stubFetch({ "POST /api/groups": () => fakeResponse(201, GROUP) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useCreateGroup(), { wrapper: wrapper(queryClient) });
    await expect(result.current.mutateAsync({ name: "工作坊" })).resolves.toEqual(GROUP);
    expect(calls[0]).toEqual({ method: "POST", url: "/api/groups", body: { name: "工作坊" } });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["groups"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["notes"] });
  });

  it("useRenameGroup：PATCH /api/groups/:id {name}；useDeleteGroup：DELETE /api/groups/:id；兩者都 invalidate 兩把 key", async () => {
    const calls = stubFetch({
      [`PATCH /api/groups/${GROUP.id}`]: () => fakeResponse(200, { ...GROUP, name: "新名" }),
      [`DELETE /api/groups/${GROUP.id}`]: () => fakeResponse(204),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const rename = renderHook(() => useRenameGroup(), { wrapper: wrapper(queryClient) });
    await expect(rename.result.current.mutateAsync({ id: GROUP.id, name: "新名" })).resolves.toMatchObject({ name: "新名" });
    expect(calls[0]).toEqual({ method: "PATCH", url: `/api/groups/${GROUP.id}`, body: { name: "新名" } });
    const del = renderHook(() => useDeleteGroup(), { wrapper: wrapper(queryClient) });
    await expect(del.result.current.mutateAsync(GROUP.id)).resolves.toBeUndefined();
    expect(calls[1]).toEqual({ method: "DELETE", url: `/api/groups/${GROUP.id}`, body: undefined });
    expect(invalidate.mock.calls.filter(([arg]) => JSON.stringify(arg?.queryKey) === '["groups"]')).toHaveLength(2);
    expect(invalidate.mock.calls.filter(([arg]) => JSON.stringify(arg?.queryKey) === '["notes"]')).toHaveLength(2);
  });

  it("成員三支：PUT {email,role}／PATCH :userId {role}／DELETE :userId，成功後 invalidate ['groups'] 與 ['notes']", async () => {
    const calls = stubFetch({
      [`PUT /api/groups/${GROUP.id}/members`]: () => fakeResponse(200, MEMBER),
      [`PATCH /api/groups/${GROUP.id}/members/${MEMBER.userId}`]: () => fakeResponse(200, { ...MEMBER, role: "admin" }),
      [`DELETE /api/groups/${GROUP.id}/members/${MEMBER.userId}`]: () => fakeResponse(204),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const add = renderHook(() => useAddMember(GROUP.id), { wrapper: wrapper(queryClient) });
    await expect(add.result.current.mutateAsync({ email: MEMBER.email })).resolves.toEqual(MEMBER);
    // role 未給就不送鍵——server body `.strict()`，這裡釘住不送多餘鍵
    expect(calls[0].body).toEqual({ email: MEMBER.email });
    const addWithRole = renderHook(() => useAddMember(GROUP.id), { wrapper: wrapper(queryClient) });
    await expect(addWithRole.result.current.mutateAsync({ email: MEMBER.email, role: "admin" })).resolves.toEqual(MEMBER);
    // role 有給就照樣送出（不是被固定省略掉）
    expect(calls[1].body).toEqual({ email: MEMBER.email, role: "admin" });
    const setRole = renderHook(() => useSetMemberRole(GROUP.id), { wrapper: wrapper(queryClient) });
    await expect(setRole.result.current.mutateAsync({ userId: MEMBER.userId, role: "admin" })).resolves.toMatchObject({ role: "admin" });
    expect(calls[2]).toEqual({ method: "PATCH", url: `/api/groups/${GROUP.id}/members/${MEMBER.userId}`, body: { role: "admin" } });
    const remove = renderHook(() => useRemoveMember(GROUP.id), { wrapper: wrapper(queryClient) });
    await expect(remove.result.current.mutateAsync(MEMBER.userId)).resolves.toBeUndefined();
    expect(calls[3]).toEqual({ method: "DELETE", url: `/api/groups/${GROUP.id}/members/${MEMBER.userId}`, body: undefined });
    // ['groups'] 是 ['groups', id, 'members'] 的前綴，一次 invalidate 同時涵蓋成員名單
    expect(invalidate.mock.calls.filter(([arg]) => JSON.stringify(arg?.queryKey) === '["groups"]')).toHaveLength(4);
    expect(invalidate.mock.calls.filter(([arg]) => JSON.stringify(arg?.queryKey) === '["notes"]')).toHaveLength(4);
  });

  it("useCreateNote 帶 groupId 時 body 含 groupId；不帶時 body 是 {}", async () => {
    const note = { id: "n1", title: "x" };
    const calls = stubFetch({ "POST /api/notes": () => fakeResponse(201, note) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useCreateNote(), { wrapper: wrapper(queryClient) });
    await result.current.mutateAsync({ groupId: GROUP.id });
    await result.current.mutateAsync(undefined);
    expect(calls[0].body).toEqual({ groupId: GROUP.id });
    expect(calls[1].body).toEqual({});
  });
});
