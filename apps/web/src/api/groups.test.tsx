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
  useGroupRoles,
  useGroups,
  useRemoveMember,
  useRenameGroup,
  useSetMemberRole,
} from "./groups";
import { useCreateNote } from "./notes";
import { adminRole, groupDto, memberRole } from "@/test/fixtures";

const ADMIN_ROLE = adminRole({ id: "dddddddd-dddd-dddd-dddd-000000000001" });
const MEMBER_ROLE = memberRole({ id: "dddddddd-dddd-dddd-dddd-000000000002" });
const GROUP: GroupDto = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "工作坊", createdAt: "2026-09-26T00:00:00.000Z" }, ADMIN_ROLE);
const MEMBER: GroupMemberDto = {
  userId: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  email: "bob@example.com",
  displayName: "Bob",
  roleId: MEMBER_ROLE.id,
  builtin: "member",
};

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

  it("#175 useGroupRoles 打 GET /api/groups/:id/roles，key 是 ['groups', id, 'roles']（在 ['groups'] 前綴下，群組 mutation 的失效一併涵蓋）", async () => {
    const calls = stubFetch({ [`GET /api/groups/${GROUP.id}/roles`]: () => fakeResponse(200, [ADMIN_ROLE, MEMBER_ROLE]) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useGroupRoles(GROUP.id), { wrapper: wrapper(queryClient) });
    await waitFor(() => expect(result.current.data).toEqual([ADMIN_ROLE, MEMBER_ROLE]));
    expect(calls).toEqual([{ method: "GET", url: `/api/groups/${GROUP.id}/roles`, body: undefined }]);
    expect(queryClient.getQueryData(["groups", GROUP.id, "roles"])).toEqual([ADMIN_ROLE, MEMBER_ROLE]);
    // 前綴比對：`['groups']` 的失效會命中這把 key
    expect(queryClient.getQueryCache().findAll({ queryKey: GROUPS_QUERY_KEY }).map((q) => q.queryKey)).toContainEqual(["groups", GROUP.id, "roles"]);
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

  it("useRenameGroup 另外 invalidate 單篇筆記三把 key ['note']、['note-by-path']、['note-by-group-path']（開著的那篇要拿到新群組名）", async () => {
    stubFetch({ [`PATCH /api/groups/${GROUP.id}`]: () => fakeResponse(200, { ...GROUP, name: "新名" }) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useRenameGroup(), { wrapper: wrapper(queryClient) });
    await result.current.mutateAsync({ id: GROUP.id, name: "新名" });
    const keys = invalidate.mock.calls.map(([arg]) => JSON.stringify(arg?.queryKey));
    expect(keys).toEqual(expect.arrayContaining(['["note"]', '["note-by-path"]', '["note-by-group-path"]', '["groups"]', '["notes"]']));
  });

  it("#175 PR1 useDeleteGroup 只失效 ['groups']、['notes']：只刪空群組（B9），沒有筆記換歸屬，不碰 shares／public-link／單篇 note", async () => {
    stubFetch({ [`DELETE /api/groups/${GROUP.id}`]: () => fakeResponse(204) });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useDeleteGroup(), { wrapper: wrapper(queryClient) });
    await result.current.mutateAsync(GROUP.id);
    const keys = invalidate.mock.calls.map(([arg]) => JSON.stringify(arg?.queryKey));
    expect([...keys].sort()).toEqual(['["groups"]', '["notes"]']);
  });

  it("#175 useSetMemberRole 另外失效單篇筆記三把 key：改到自己的角色時，開著那篇群組筆記的 permissions 要重抓（review r1 M-4）", async () => {
    stubFetch({
      [`PATCH /api/groups/${GROUP.id}/members/${MEMBER.userId}`]: () => fakeResponse(200, { ...MEMBER, roleId: ADMIN_ROLE.id, builtin: "admin" }),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = renderHook(() => useSetMemberRole(GROUP.id), { wrapper: wrapper(queryClient) });
    await result.current.mutateAsync({ userId: MEMBER.userId, roleId: ADMIN_ROLE.id });
    const keys = invalidate.mock.calls.map(([arg]) => JSON.stringify(arg?.queryKey));
    expect(keys).toEqual(expect.arrayContaining(['["note"]', '["note-by-path"]', '["note-by-group-path"]', '["groups"]', '["notes"]']));
  });

  it("成員三支：PUT {email,roleId?}／PATCH :userId {roleId}／DELETE :userId，成功後 invalidate ['groups'] 與 ['notes']", async () => {
    const promoted: GroupMemberDto = { ...MEMBER, roleId: ADMIN_ROLE.id, builtin: "admin" };
    const calls = stubFetch({
      [`PUT /api/groups/${GROUP.id}/members`]: () => fakeResponse(200, MEMBER),
      [`PATCH /api/groups/${GROUP.id}/members/${MEMBER.userId}`]: () => fakeResponse(200, promoted),
      [`DELETE /api/groups/${GROUP.id}/members/${MEMBER.userId}`]: () => fakeResponse(204),
    });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const add = renderHook(() => useAddMember(GROUP.id), { wrapper: wrapper(queryClient) });
    await expect(add.result.current.mutateAsync({ email: MEMBER.email })).resolves.toEqual(MEMBER);
    // roleId 未給就不送鍵——server body `.strict()`，這裡釘住不送多餘鍵（server 預設內建一般成員）
    expect(calls[0].body).toEqual({ email: MEMBER.email });
    const addWithRole = renderHook(() => useAddMember(GROUP.id), { wrapper: wrapper(queryClient) });
    await expect(addWithRole.result.current.mutateAsync({ email: MEMBER.email, roleId: ADMIN_ROLE.id })).resolves.toEqual(MEMBER);
    // roleId 有給就照樣送出（不是被固定省略掉）；鍵名是 roleId，不是 v1 的 role（server 對 role 鍵回 400）
    expect(calls[1].body).toEqual({ email: MEMBER.email, roleId: ADMIN_ROLE.id });
    const setRole = renderHook(() => useSetMemberRole(GROUP.id), { wrapper: wrapper(queryClient) });
    await expect(setRole.result.current.mutateAsync({ userId: MEMBER.userId, roleId: ADMIN_ROLE.id })).resolves.toEqual(promoted);
    expect(calls[2]).toEqual({ method: "PATCH", url: `/api/groups/${GROUP.id}/members/${MEMBER.userId}`, body: { roleId: ADMIN_ROLE.id } });
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
