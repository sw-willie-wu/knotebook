import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient } from "@tanstack/react-query";
import { canonicalNotePath, type NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { ApiFail } from "@/api/client";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { EDITOR_PERMS, OWNER_PERMS } from "@/test/fixtures";
import { folderDto } from "@/test/folder-fixtures";
import { __resetCollapseForTests, isCollapsed, setCollapsed } from "@/components/sidebar/collapse";
import { __resetFolderSortForTests } from "@/components/sidebar/folder-sort";
import { showTrashedToast } from "./trash-undo";

afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
  __resetFolderSortForTests();
});

// 「已移到垃圾桶」toast 與「復原」（spec §6.10.4／§6.10.7）。真的 QueryClient、navigate 用 vi.fn()。

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const PERSONAL: NoteDto = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "My Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "my-note",
  slugIsCustom: true,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  group: null,
  groupId: null,
  permissions: OWNER_PERMS,
  folderId: null,
};

const GROUP_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
function groupNote(id: string, perms: NoteDto["permissions"]): NoteDto {
  return {
    ...PERSONAL,
    id,
    slug: `g-${id.slice(0, 4)}`,
    ownerId: null,
    ownerHandle: null,
    role: "editor",
    groupId: GROUP_ID,
    group: { id: GROUP_ID, name: "Workshop A" },
    permissions: perms,
  };
}
const GROUP_DELETE_ONLY = groupNote("22222222-2222-2222-2222-222222222222", { ...EDITOR_PERMS, edit: false, delete: true });
const GROUP_EDIT_DELETE = groupNote("33333333-3333-3333-3333-333333333333", { ...EDITOR_PERMS, edit: true, delete: true });

const HINT = "Members of the group whose role can both edit and delete notes can restore it.";

type RestoreReply = { status: 200; body: unknown } | { status: number; body: unknown };

/** 只接受 `POST /api/trash/restore`；記下 body。 */
function stubRestore(reply: RestoreReply) {
  const bodies: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/trash/restore" && method === "POST") {
        bodies.push(JSON.parse(String(init?.body)));
        return Promise.resolve(fakeResponse({ ok: reply.status < 400, status: reply.status, json: () => Promise.resolve(reply.body) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return bodies;
}

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const navigate = vi.fn();
  render(createElement(Toaster));
  return { queryClient, navigate, t: i18n.t.bind(i18n) };
}

/** Radix Toast Root（`<li>`）——variant 的 class 掛在它身上。 */
function toastRoot(title: string): HTMLElement {
  return screen.getByText(title, { exact: true }).closest("li") as HTMLElement;
}

describe("showTrashedToast／undoTrash", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    act(() => dismissAllToasts());
  });

  it("TU1 個人筆記：標題「Moved to the trash」、有 Undo、沒有 hint 句", async () => {
    const { queryClient, navigate, t } = setup();
    act(() => showTrashedToast({ notes: [PERSONAL], queryClient, navigate, t, reopen: false }));

    expect(await screen.findByText("Moved to the trash", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(screen.queryByText(HINT, { exact: true })).toBeNull();
  });

  it("TU2 群組筆記 delete-only（edit 假）：沒有 Undo、有 hint 句", async () => {
    const { queryClient, navigate, t } = setup();
    act(() => showTrashedToast({ notes: [GROUP_DELETE_ONLY], queryClient, navigate, t, reopen: false }));

    expect(await screen.findByText("Moved to the trash", { exact: true })).toBeInTheDocument();
    expect(screen.getByText(HINT, { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("TU3 多篇：混合（一篇 delete-only）→ 沒有 Undo；兩篇都可 → 有 Undo，按下送兩個 id", async () => {
    const { queryClient, navigate, t } = setup();
    act(() => showTrashedToast({ notes: [PERSONAL, GROUP_DELETE_ONLY], queryClient, navigate, t, reopen: false }));
    expect(await screen.findByText("Moved to the trash", { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
    act(() => dismissAllToasts());

    const bodies = stubRestore({ status: 200, body: { restored: [PERSONAL, GROUP_EDIT_DELETE], skipped: [] } });
    act(() => showTrashedToast({ notes: [PERSONAL, GROUP_EDIT_DELETE], queryClient, navigate, t, reopen: false }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(bodies).toEqual([{ ids: [PERSONAL.id, GROUP_EDIT_DELETE.id] }]));
  });

  it("TU4 復原成功＋reopen：toast「Restored 1 note」（非 destructive）、navigate(canonical) 一次", async () => {
    const { queryClient, navigate, t } = setup();
    stubRestore({ status: 200, body: { restored: [PERSONAL], skipped: [] } });
    act(() => showTrashedToast({ notes: [PERSONAL], queryClient, navigate, t, reopen: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    expect(await screen.findByText("Restored 1 note", { exact: true })).toBeInTheDocument();
    expect(toastRoot("Restored 1 note")).not.toHaveClass("bg-destructive");
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith(canonicalNotePath(PERSONAL));
  });

  it("TU5 復原成功、reopen false：不導頁", async () => {
    const { queryClient, navigate, t } = setup();
    stubRestore({ status: 200, body: { restored: [PERSONAL], skipped: [] } });
    act(() => showTrashedToast({ notes: [PERSONAL], queryClient, navigate, t, reopen: false }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    expect(await screen.findByText("Restored 1 note", { exact: true })).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("TU6 已不在垃圾桶（全略過）：toast「Restored 0 notes, 1 no longer in the trash」destructive、不導頁", async () => {
    const { queryClient, navigate, t } = setup();
    stubRestore({ status: 200, body: { restored: [], skipped: [{ id: PERSONAL.id, reason: "not_found" }] } });
    act(() => showTrashedToast({ notes: [PERSONAL], queryClient, navigate, t, reopen: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    const title = "Restored 0 notes, 1 no longer in the trash";
    expect(await screen.findByText(title, { exact: true })).toBeInTheDocument();
    expect(toastRoot(title)).toHaveClass("bg-destructive");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("TU8 seed 早於導頁：navigate 當下常駐層 [\"note\", id] 已是 success（移入時留下的 404 error 態被蓋掉）", async () => {
    const { queryClient, navigate, t } = setup();
    // 讀碼發現 27 的起點：常駐層有舊 data、停在 404 in_trash 的 error 態。
    queryClient.setQueryData(["note", PERSONAL.id], PERSONAL);
    await queryClient
      .fetchQuery({ queryKey: ["note", PERSONAL.id], queryFn: () => Promise.reject(new ApiFail(404, "in_trash", "x")), retry: false })
      .catch(() => {});
    expect(queryClient.getQueryState(["note", PERSONAL.id])?.status).toBe("error");

    const statusAtNavigate: (string | undefined)[] = [];
    navigate.mockImplementation(() => {
      statusAtNavigate.push(queryClient.getQueryState(["note", PERSONAL.id])?.status);
    });
    stubRestore({ status: 200, body: { restored: [PERSONAL], skipped: [] } });
    act(() => showTrashedToast({ notes: [PERSONAL], queryClient, navigate, t, reopen: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(statusAtNavigate).toEqual(["success"]);
  });

  it("TU7 復原失敗（500）：toast errors.fallback、不導頁、[\"trash\"] 照樣失效", async () => {
    const { queryClient, navigate, t } = setup();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    // code 不在 errors.* 裡 → errors.fallback（errors.internal 另有自己的字）。
    stubRestore({ status: 500, body: { error: { code: "unexpected_failure", message: "x" } } });
    act(() => showTrashedToast({ notes: [PERSONAL], queryClient, navigate, t, reopen: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    expect(await screen.findByText("An unexpected error occurred.", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["trash"] }));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("TU9 復原失敗（409 server_busy）：toast 依錯誤碼顯示 errors.server_busy 的字（不是通用字）、destructive、不導頁", async () => {
    const { queryClient, navigate, t } = setup();
    // restoreTrashIds 把錯誤包成 TrashBatchError——要解包（trashErrorCause）才拿得到 code。
    stubRestore({ status: 409, body: { error: { code: "server_busy", message: "x" } } });
    act(() => showTrashedToast({ notes: [PERSONAL], queryClient, navigate, t, reopen: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    const title = "The server is busy. Please try again shortly.";
    expect(await screen.findByText(title, { exact: true })).toBeInTheDocument();
    expect(toastRoot(title)).toHaveClass("bg-destructive");
    expect(screen.queryByText("An unexpected error occurred.", { exact: true })).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
  });

  // PR-2c 多選刪除用的四個可選欄（plan 的 TU9–TU12；本檔 TU9 已被 server_busy 佔用，順延成 TU10–TU13）。
  it("TU10 title：標題逐字、仍有 Undo", async () => {
    const { queryClient, navigate, t } = setup();
    act(() => showTrashedToast({ notes: [PERSONAL], queryClient, navigate, t, reopen: false, title: "Moved 2 notes to the trash" }));

    expect(await screen.findByText("Moved 2 notes to the trash", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText("Moved to the trash", { exact: true })).toBeNull();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("TU11 不可復原＋description：描述是「X 」接 hint、沒有 Undo", async () => {
    const { queryClient, navigate, t } = setup();
    act(() => showTrashedToast({ notes: [GROUP_DELETE_ONLY], queryClient, navigate, t, reopen: false, description: "X" }));

    expect(await screen.findByText(`X ${HINT}`, { exact: true })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("TU12 reopenId 覆蓋推算：兩篇、reopenId=b → 復原後以 b 的 canonical 路徑導回一次", async () => {
    const { queryClient, navigate, t } = setup();
    stubRestore({ status: 200, body: { restored: [PERSONAL, GROUP_EDIT_DELETE], skipped: [] } });
    act(() =>
      showTrashedToast({ notes: [PERSONAL, GROUP_EDIT_DELETE], queryClient, navigate, t, reopen: false, reopenId: GROUP_EDIT_DELETE.id }),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledTimes(1));
    expect(navigate).toHaveBeenCalledWith(canonicalNotePath(GROUP_EDIT_DELETE));
  });

  it("TU13 variant destructive：toast 根節點 bg-destructive", async () => {
    const { queryClient, navigate, t } = setup();
    act(() => showTrashedToast({ notes: [PERSONAL], queryClient, navigate, t, reopen: false, variant: "destructive" }));

    expect(await screen.findByText("Moved to the trash", { exact: true })).toBeInTheDocument();
    expect(toastRoot("Moved to the trash")).toHaveClass("bg-destructive");
  });

  it("TU-F1（plan TU13）undoIds 併進復原 body、去重；notes: []＋undoIds → 帶 Undo", async () => {
    const { queryClient, navigate, t } = setup();
    const bodies = stubRestore({ status: 200, body: { restored: [PERSONAL], skipped: [] } });
    act(() => showTrashedToast({ notes: [PERSONAL], undoIds: [PERSONAL.id, "x2"], queryClient, navigate, t, reopen: false }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(bodies).toEqual([{ ids: [PERSONAL.id, "x2"] }]));
    act(() => dismissAllToasts());

    act(() => showTrashedToast({ notes: [], undoIds: ["y1"], queryClient, navigate, t, reopen: false, title: "Folder gone" }));
    expect(await screen.findByText("Folder gone", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("TU-F2（plan TU14）分批中途失敗、partial 已還原 200 篇 → 錯誤 toast 的描述「Restored 200 notes」", async () => {
    const { queryClient, navigate, t } = setup();
    const ids = Array.from({ length: 250 }, (_, i) => `n${i}`);
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const batch = (JSON.parse(String(init?.body)) as { ids: string[] }).ids;
        call += 1;
        if (String(input) !== "/api/trash/restore") throw new Error(`unexpected fetch: ${String(input)}`);
        if (call === 1) return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ restored: batch.map((id) => ({ ...PERSONAL, id })), skipped: [] }) }));
        return Promise.resolve(fakeResponse({ ok: false, status: 429, json: () => Promise.resolve({ error: { code: "rate_limited", message: "x" } }) }));
      }),
    );
    act(() => showTrashedToast({ notes: [], undoIds: ids, queryClient, navigate, t, reopen: false }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Restored 200 notes", { exact: true })).toBeInTheDocument();
  });

  // 資料夾 PR-3b-2 T7（spec §6.8 還原後展開）：本檔 TU-F1／TU-F2 已被 PR-3b-1 佔用，T7 brief 的 TU-F1 記成 TU-R1／TU-R2。
  /** `POST /api/trash/restore` 依序取 `restoreReplies`（用完重複最後一個）；`GET /api/folders` 回 `folders`。 */
  function stubRestoreAndFolders(restoreReplies: Array<(batch: string[]) => Response>, folders: unknown[]) {
    const folderGets: string[] = [];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        if (url === "/api/folders" && method === "GET") {
          folderGets.push(url);
          return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ folders }) }));
        }
        if (url === "/api/trash/restore" && method === "POST") {
          const batch = (JSON.parse(String(init?.body)) as { ids: string[] }).ids;
          const reply = restoreReplies[Math.min(call, restoreReplies.length - 1)]!;
          call += 1;
          return Promise.resolve(reply(batch));
        }
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
    return folderGets;
  }
  const ok = (body: unknown) => fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(body) });

  it("TU-R1（brief TU-F1）復原成功 → 先收合的 folder:A 被展開", async () => {
    const { queryClient, navigate, t } = setup();
    const inA = { ...PERSONAL, folderId: "A" };
    const folderGets = stubRestoreAndFolders([() => ok({ restored: [inA], skipped: [] })], [folderDto({ id: "A", name: "A" })]);
    setCollapsed("folder:A", true);
    act(() => showTrashedToast({ notes: [PERSONAL], queryClient, navigate, t, reopen: false }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Restored 1 note", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(isCollapsed("folder:A")).toBe(false));
    expect(folderGets).toHaveLength(1);
  });

  it("TU-R2（brief TU-F1 後半）分批中途失敗 → 已還原那幾篇的資料夾展開、其餘不動", async () => {
    const { queryClient, navigate, t } = setup();
    const ids = Array.from({ length: 250 }, (_, i) => `n${i}`);
    const folderGets = stubRestoreAndFolders(
      [
        (batch) => ok({ restored: batch.map((id, i) => ({ ...PERSONAL, id, folderId: i === 0 ? "A" : null })), skipped: [] }),
        () => fakeResponse({ ok: false, status: 429, json: () => Promise.resolve({ error: { code: "rate_limited", message: "x" } }) }),
      ],
      [folderDto({ id: "A", name: "A" }), folderDto({ id: "B", name: "B" })],
    );
    setCollapsed("folder:A", true);
    setCollapsed("folder:B", true);
    act(() => showTrashedToast({ notes: [], undoIds: ids, queryClient, navigate, t, reopen: false }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Restored 200 notes", { exact: true })).toBeInTheDocument();
    await waitFor(() => expect(isCollapsed("folder:A")).toBe(false));
    expect(isCollapsed("folder:B")).toBe(true);
    expect(folderGets).toHaveLength(1);
  });

  it("TU14 可復原＋description：描述照原字顯示（不接 hint）、仍有 Undo", async () => {
    const { queryClient, navigate, t } = setup();
    act(() => showTrashedToast({ notes: [PERSONAL], queryClient, navigate, t, reopen: false, description: "X" }));

    expect(await screen.findByText("X", { exact: true })).toBeInTheDocument();
    expect(screen.queryByText(`X ${HINT}`, { exact: true })).toBeNull();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });
});
