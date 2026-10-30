import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GroupDto, GroupMemberDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { clickOutside } from "@/test/outside-click";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { adminRole, customRole, groupDto, memberRole } from "@/test/fixtures";
import { trashItem, trashList } from "@/test/trash-fixtures";
import { DeleteGroupDialog } from "./DeleteGroupDialog";
import { FOLDER_LIST_EMPTY, folderDto, groupFolder } from "@/test/folder-fixtures";

const GROUP: GroupDto = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Workshop A" }, adminRole({ memberCount: 2 }));
const ADMIN = adminRole();
const MEMBER = memberRole();

function member(userId: string, displayName: string, role: typeof ADMIN): GroupMemberDto {
  return { userId, email: `${displayName.toLowerCase()}@example.com`, displayName, roleId: role.id, builtin: role.builtin };
}

/** server 排序：內建管理員在前。 */
const MEMBERS: GroupMemberDto[] = [member("u-me", "Me", ADMIN), member("u-bob", "Bob", ADMIN), member("u-cat", "Cat", MEMBER)];

function note(id: string, groupId: string | null) {
  return { id, groupId };
}
/** 三篇、其中兩篇屬於 GROUP。 */
const NOTES = [note("n1", GROUP.id), note("n2", GROUP.id), note("n3", null)];

function fakeResponse(status: number, body?: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)) } as unknown as Response;
}

type Calls = Array<{ method: string; url: string; body: unknown }>;

/** #181：垃圾桶項目——GROUP 的、別群組的、個人的。 */
const inGroup = (id: string) => trashItem({ id, title: id, group: { id: GROUP.id, name: GROUP.name } });
const OTHER_GROUP_TRASH = trashItem({ id: "t-other", title: "t-other", group: { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", name: "Other" } });
const PERSONAL_TRASH = trashItem({ id: "t-mine", title: "t-mine" });

/** 能管群組、能刪但不能編輯（自訂角色）：看不到群組垃圾桶（spec §6.5 ①）。 */
const NO_TRASH_GROUP: GroupDto = groupDto(
  { id: GROUP.id, name: GROUP.name },
  customRole({ permissions: { ...customRole().permissions, manageGroup: true, edit: false, delete: true } }),
);

interface Setup {
  members?: () => Response | Promise<Response>;
  notes?: () => Response | Promise<Response>;
  trash?: () => Response | Promise<Response>;
  del?: () => Response;
  group?: GroupDto;
  /** `GET /api/folders`（預設空清單）。 */
  folders?: () => Response | Promise<Response>;
}

function renderDialog(setup: Setup = {}, props: { onDeleted?: () => void; onOpenChange?: (open: boolean) => void } = {}) {
  const calls: Calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      if (method === "GET" && url === `/api/groups/${GROUP.id}/members`) return Promise.resolve((setup.members ?? (() => fakeResponse(200, MEMBERS)))());
      if (url === "/api/folders") {
        if (setup.folders) return Promise.resolve(setup.folders());
        return Promise.resolve(new Response(JSON.stringify(FOLDER_LIST_EMPTY), { status: 200, headers: { "Content-Type": "application/json" } }));
      }
      if (method === "GET" && url === "/api/notes") return Promise.resolve((setup.notes ?? (() => fakeResponse(200, NOTES)))());
      if (method === "GET" && url === "/api/trash") return Promise.resolve((setup.trash ?? (() => fakeResponse(200, trashList([]))))());
      if (method === "DELETE" && url === `/api/groups/${GROUP.id}`) return Promise.resolve((setup.del ?? (() => fakeResponse(204)))());
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  const onOpenChange = props.onOpenChange ?? vi.fn();
  const onDeleted = props.onDeleted ?? vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // 呼叫端的掛載形：`open && <DeleteGroupDialog …/>`——onOpenChange(false) 後卸載
  const group = setup.group ?? GROUP;
  function Host() {
    return <DeleteGroupDialog group={group} onOpenChange={onOpenChange} onDeleted={onDeleted} />;
  }
  render(
    <QueryClientProvider client={queryClient}>
      <Host />
      <Toaster />
    </QueryClientProvider>,
  );
  return { calls, onOpenChange, onDeleted, queryClient };
}

/**
 * 等某支 query 離開 pending、再讓 react-query 的通知批次（setTimeout 0）跑完：不可信（NoCount）與「還沒載到」畫面相同，
 * 不先等它落定，斷言會在載入前就過。
 */
async function settled(queryClient: QueryClient, key: readonly string[]): Promise<void> {
  await waitFor(() => expect(queryClient.getQueryState(key)?.status).not.toBe("pending"));
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const deleteCalls = (calls: Calls) => calls.filter((c) => c.method === "DELETE");
const confirmButton = () => screen.getByRole("button", { name: "Delete group" });

describe("DeleteGroupDialog（#175 PR4，spec §8.6）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("點對話框外面不關閉、已選的接手者仍在（表單型守衛）", async () => {
    const { onOpenChange } = renderDialog();
    const select = await screen.findByLabelText("Admin who gets the notes");
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(2));
    fireEvent.change(select, { target: { value: "u-bob" } });
    await clickOutside();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Admin who gets the notes")).toHaveValue("u-bob");
  });

  it("預設：轉移選中、下拉只列兩位內建管理員且第一位選中（可以是自己）；說明句帶篇數 2 與選中者名字；確認鈕可按", async () => {
    renderDialog();
    const select = await screen.findByLabelText("Admin who gets the notes");
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(2));
    expect(within(select).getAllByRole("option").map((o) => o.textContent)).toEqual(["Me (me@example.com)", "Bob (bob@example.com)"]);
    expect(select).toHaveValue("u-me");
    expect(screen.getByRole("radio", { name: "Give them to an admin" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Delete everything" })).not.toBeChecked();
    await waitFor(() => expect(screen.getByText(/^2 notes will become Me's personal notes\./)).toBeInTheDocument());
    expect(confirmButton()).not.toBeDisabled();
  });

  it("選 Bob → 送 DELETE {mode:'transfer', transferTo: Bob 的 userId} → 成功：對話框關閉（onOpenChange(false)）、onDeleted 呼叫一次", async () => {
    const { calls, onOpenChange, onDeleted } = renderDialog();
    const select = await screen.findByLabelText("Admin who gets the notes");
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(2));
    fireEvent.change(select, { target: { value: "u-bob" } });
    await waitFor(() => expect(screen.getByText(/^2 notes will become Bob's personal notes\./)).toBeInTheDocument());
    fireEvent.click(confirmButton());
    await waitFor(() => expect(deleteCalls(calls)).toHaveLength(1));
    expect(deleteCalls(calls)[0].body).toEqual({ mode: "transfer", transferTo: "u-bob" });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onDeleted).toHaveBeenCalledTimes(1);
  });

  it("切到全部刪除：確認鈕 disabled 直到勾「我了解…」；送出 {mode:'delete'}", async () => {
    const { calls, onDeleted } = renderDialog();
    await screen.findByLabelText("Admin who gets the notes");
    fireEvent.click(screen.getByRole("radio", { name: "Delete everything" }));
    expect(screen.getByText(/^2 notes, their attachments and their edit history are permanently deleted/)).toBeInTheDocument();
    expect(confirmButton()).toBeDisabled();
    fireEvent.click(confirmButton());
    expect(deleteCalls(calls)).toHaveLength(0);
    fireEvent.click(screen.getByRole("checkbox", { name: "I understand the notes will be permanently deleted" }));
    expect(confirmButton()).not.toBeDisabled();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(deleteCalls(calls)).toHaveLength(1));
    expect(deleteCalls(calls)[0].body).toEqual({ mode: "delete" });
    await waitFor(() => expect(onDeleted).toHaveBeenCalledTimes(1));
  });

  it("勾了再切回轉移、再切回全刪：勾選已清掉、確認鈕又是 disabled", async () => {
    renderDialog();
    await screen.findByLabelText("Admin who gets the notes");
    fireEvent.click(screen.getByRole("radio", { name: "Delete everything" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "I understand the notes will be permanently deleted" }));
    expect(confirmButton()).not.toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "Give them to an admin" }));
    fireEvent.click(screen.getByRole("radio", { name: "Delete everything" }));
    expect(screen.getByRole("checkbox", { name: "I understand the notes will be permanently deleted" })).not.toBeChecked();
    expect(confirmButton()).toBeDisabled();
  });

  it("409 not_admin → toast errors.not_admin、對話框留著、重抓成員名單（members GET 第二次）", async () => {
    const { calls, onOpenChange, onDeleted } = renderDialog({
      del: () => fakeResponse(409, { error: { code: "not_admin", message: "x" } }),
    });
    const select = await screen.findByLabelText("Admin who gets the notes");
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(2));
    const membersGets = () => calls.filter((c) => c.method === "GET" && c.url === `/api/groups/${GROUP.id}/members`).length;
    expect(membersGets()).toBe(1);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByText("The notes can only be handed to one of the group's admins. Pick someone who is still an admin.")).toBeInTheDocument());
    await waitFor(() => expect(membersGets()).toBe(2));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Delete group?" })).toBeInTheDocument();
  });

  it("409 server_busy → toast errors.server_busy、對話框留著、確認鈕可再按", async () => {
    const { calls, onOpenChange } = renderDialog({
      del: () => fakeResponse(409, { error: { code: "server_busy", message: "x" } }),
    });
    const select = await screen.findByLabelText("Admin who gets the notes");
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(2));
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByText("The server is busy. Please try again shortly.")).toBeInTheDocument());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Delete group?" })).toBeInTheDocument();
    await waitFor(() => expect(confirmButton()).not.toBeDisabled());
    // 不重抓成員名單（只有 not_admin 才重抓）
    expect(calls.filter((c) => c.method === "GET" && c.url === `/api/groups/${GROUP.id}/members`)).toHaveLength(1);
    fireEvent.click(confirmButton());
    await waitFor(() => expect(deleteCalls(calls)).toHaveLength(2));
  });

  it("404 not_found → toast、對話框留著", async () => {
    const { onOpenChange, onDeleted } = renderDialog({
      del: () => fakeResponse(404, { error: { code: "not_found", message: "x" } }),
    });
    const select = await screen.findByLabelText("Admin who gets the notes");
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(2));
    fireEvent.click(confirmButton());
    await waitFor(() => expect(screen.getByText(i18n.t("errors.not_found"))).toBeInTheDocument());
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Delete group?" })).toBeInTheDocument();
  });

  it("['notes'] 還沒載入：說明句用不含數字的版本；群組 0 篇：顯示「這個群組沒有筆記」，兩個模式照常可選、預設轉移", async () => {
    // 篇數未載入：notes 請求懸著
    const never = new Promise<Response>(() => {});
    renderDialog({ notes: () => never as unknown as Response });
    const select = await screen.findByLabelText("Admin who gets the notes");
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(2));
    expect(screen.getByText(/^The group's notes will become Me's personal notes\./)).toBeInTheDocument();
    expect(screen.queryByText(/\b0 notes?\b/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Delete everything" }));
    expect(screen.getByText(/^The group's notes \(including those in its trash\), their attachments and their edit history are permanently deleted — they don't go to the trash\./)).toBeInTheDocument();
  });

  it("群組 0 篇：說明句是「This group has no notes.」，預設轉移，兩模式仍可選", async () => {
    renderDialog({ notes: () => fakeResponse(200, [note("n3", null)]) });
    await screen.findByLabelText("Admin who gets the notes");
    await waitFor(() => expect(screen.getByText("This group has no notes.")).toBeInTheDocument());
    expect(screen.getByRole("radio", { name: "Give them to an admin" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Delete everything" }));
    expect(screen.getByText("This group has no notes.")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "I understand the notes will be permanently deleted" })).toBeInTheDocument();
  });

  it("成員名單錯誤：顯示 adminsUnavailable、轉移模式的確認鈕 disabled；切到全刪勾選後可送出", async () => {
    const { calls } = renderDialog({ members: () => fakeResponse(500, { error: { code: "internal", message: "x" } }) });
    await waitFor(() => expect(screen.getByText("Couldn't load the group's admins.")).toBeInTheDocument());
    expect(within(screen.getByLabelText("Admin who gets the notes")).queryAllByRole("option")).toHaveLength(0);
    expect(confirmButton()).toBeDisabled();
    fireEvent.click(screen.getByRole("radio", { name: "Delete everything" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "I understand the notes will be permanently deleted" }));
    expect(confirmButton()).not.toBeDisabled();
    fireEvent.click(confirmButton());
    await waitFor(() => expect(deleteCalls(calls)).toHaveLength(1));
    expect(deleteCalls(calls)[0].body).toEqual({ mode: "delete" });
  });

  it("對話框的 accessible description 就是後果說明句（兩個模式、兩個語系；zh 轉移句寫「若有公開連結也會關閉」）", async () => {
    renderDialog();
    await screen.findByLabelText("Admin who gets the notes");
    const dialog = screen.getByRole("dialog", { name: "Delete group?" });
    await waitFor(() => expect(dialog).toHaveAccessibleDescription(/^2 notes will become Me's personal notes\..*any public links on them are turned off\.$/));
    fireEvent.click(screen.getByRole("radio", { name: "Delete everything" }));
    expect(dialog).toHaveAccessibleDescription(/^2 notes, their attachments and their edit history are permanently deleted/);
    await i18n.changeLanguage("zh-TW");
    fireEvent.click(await screen.findByRole("radio", { name: "轉移給管理員" }));
    await waitFor(() => expect(dialog).toHaveAccessibleDescription(/^2 篇筆記會變成 Me 的個人筆記.*其他成員會失去存取，若有公開連結也會關閉。$/));
  });

  it("radiogroup 有可讀名稱、兩個 radio 與 checkbox 都以 label 取得", async () => {
    renderDialog();
    await screen.findByLabelText("Admin who gets the notes");
    expect(screen.getByRole("radiogroup", { name: "What happens to the notes in this group" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Give them to an admin" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: "Delete everything" }));
    expect(screen.getByRole("checkbox", { name: "I understand the notes will be permanently deleted" })).toBeInTheDocument();
  });
});

const TRASH_NOTE =
  /^Group notes in the trash go to Me's personal trash, and their retention period still counts from when they were deleted; their public links are turned off too\.$/;
const queryTrashNote = () => screen.queryByText(/^Group notes in the trash go to /);
const DELETE_NO_COUNT =
  /^The group's notes \(including those in its trash\), their attachments and their edit history are permanently deleted — they don't go to the trash\. This can't be undone\.$/;
const TRANSFER_NO_COUNT = /^The group's notes will become Me's personal notes\./;

async function adminsLoaded(): Promise<void> {
  const select = await screen.findByLabelText("Admin who gets the notes");
  await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(2));
}
const toDeleteMode = () => fireEvent.click(screen.getByRole("radio", { name: "Delete everything" }));

describe("DeleteGroupDialog：垃圾桶篇數與轉移說明（#181 PR-2b T8，spec §6.5）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("DG-T1 群組垃圾桶 1 篇（別群組、個人的不計）＋活 2：轉移「3 notes」＋垃圾桶句；全刪「3 notes (including 1 in the trash)」", async () => {
    renderDialog({ trash: () => fakeResponse(200, trashList([inGroup("t1"), OTHER_GROUP_TRASH, PERSONAL_TRASH])) });
    await adminsLoaded();
    await waitFor(() => expect(screen.getByText(/^3 notes will become Me's personal notes\./)).toBeInTheDocument());
    expect(screen.getByText(TRASH_NOTE)).toBeInTheDocument();
    toDeleteMode();
    expect(
      screen.getByText(/^3 notes \(including 1 in the trash\), their attachments and their edit history are permanently deleted — they don't go to the trash\. This can't be undone\.$/),
    ).toBeInTheDocument();
  });

  it("DG-T2 群組垃圾桶 0（只有別群組、個人的）＋活 2：轉移沒有垃圾桶句；全刪「2 notes, … — they don't go to the trash.」", async () => {
    const { queryClient } = renderDialog({ trash: () => fakeResponse(200, trashList([OTHER_GROUP_TRASH, PERSONAL_TRASH])) });
    await adminsLoaded();
    await settled(queryClient, ["trash"]);
    await waitFor(() => expect(screen.getByText(/^2 notes will become Me's personal notes\./)).toBeInTheDocument());
    expect(queryTrashNote()).not.toBeInTheDocument();
    toDeleteMode();
    expect(
      screen.getByText(/^2 notes, their attachments and their edit history are permanently deleted — they don't go to the trash\. This can't be undone\.$/),
    ).toBeInTheDocument();
  });

  it("DG-T3 能管群組、能刪但不能編輯（看不到群組垃圾桶）：不帶數字——轉移「The group's notes will become…」＋垃圾桶句；全刪「(including those in its trash)」", async () => {
    // server 對這種角色不回群組垃圾桶的項目（spec §6.3.1），清單裡只有自己的個人項目
    const { queryClient } = renderDialog({ group: NO_TRASH_GROUP, trash: () => fakeResponse(200, trashList([PERSONAL_TRASH])) });
    await adminsLoaded();
    await settled(queryClient, ["notes"]);
    await settled(queryClient, ["trash"]);
    expect(screen.getByText(TRANSFER_NO_COUNT)).toBeInTheDocument();
    expect(screen.getByText(TRASH_NOTE)).toBeInTheDocument();
    toDeleteMode();
    expect(screen.getByText(DELETE_NO_COUNT)).toBeInTheDocument();
  });

  it("DG-T3b 能管群組、能編輯但不能刪（看不到群組垃圾桶）：不帶數字——轉移＋垃圾桶句；全刪「(including those in its trash)」", async () => {
    const group = groupDto(
      { id: GROUP.id, name: GROUP.name },
      customRole({ permissions: { ...customRole().permissions, manageGroup: true, edit: true, delete: false } }),
    );
    const { queryClient } = renderDialog({ group, trash: () => fakeResponse(200, trashList([PERSONAL_TRASH])) });
    await adminsLoaded();
    await settled(queryClient, ["notes"]);
    await settled(queryClient, ["trash"]);
    expect(screen.getByText(TRANSFER_NO_COUNT)).toBeInTheDocument();
    expect(screen.getByText(TRASH_NOTE)).toBeInTheDocument();
    toDeleteMode();
    expect(screen.getByText(DELETE_NO_COUNT)).toBeInTheDocument();
  });

  it("非成員的站台管理員（myRole: null；['notes'] 不含該群組筆記）：不帶數字，不說「This group has no notes.」", async () => {
    const group = groupDto({ id: GROUP.id, name: GROUP.name }, null);
    const { queryClient } = renderDialog({
      group,
      notes: () => fakeResponse(200, [note("n3", null)]),
      trash: () => fakeResponse(200, trashList([PERSONAL_TRASH])),
    });
    await adminsLoaded();
    await settled(queryClient, ["notes"]);
    await settled(queryClient, ["trash"]);
    expect(screen.queryByText("This group has no notes.")).not.toBeInTheDocument();
    expect(screen.getByText(TRANSFER_NO_COUNT)).toBeInTheDocument();
    expect(screen.getByText(TRASH_NOTE)).toBeInTheDocument();
    toDeleteMode();
    expect(screen.queryByText("This group has no notes.")).not.toBeInTheDocument();
    expect(screen.getByText(DELETE_NO_COUNT)).toBeInTheDocument();
  });

  it("DG-T4 垃圾桶清單 truncated：不帶數字（同 DG-T3）", async () => {
    const { queryClient } = renderDialog({ trash: () => fakeResponse(200, trashList([inGroup("t1")], { truncated: true })) });
    await adminsLoaded();
    await settled(queryClient, ["notes"]);
    await settled(queryClient, ["trash"]);
    expect(screen.getByText(TRANSFER_NO_COUNT)).toBeInTheDocument();
    expect(screen.getByText(TRASH_NOTE)).toBeInTheDocument();
    toDeleteMode();
    expect(screen.getByText(DELETE_NO_COUNT)).toBeInTheDocument();
  });

  it("DG-T5 垃圾桶載入失敗（500）：不帶數字", async () => {
    const { queryClient } = renderDialog({ trash: () => fakeResponse(500, { error: { code: "internal", message: "x" } }) });
    await adminsLoaded();
    await settled(queryClient, ["notes"]);
    await settled(queryClient, ["trash"]);
    expect(queryClient.getQueryState(["trash"])?.status).toBe("error");
    expect(screen.getByText(TRANSFER_NO_COUNT)).toBeInTheDocument();
    expect(screen.getByText(TRASH_NOTE)).toBeInTheDocument();
    toDeleteMode();
    expect(screen.getByText(DELETE_NO_COUNT)).toBeInTheDocument();
  });

  it("DG-T5 垃圾桶還在載入（請求懸著）：不帶數字，不出「0 notes」也不出「This group has no notes.」", async () => {
    const never = new Promise<Response>(() => {});
    const { queryClient } = renderDialog({ trash: () => never });
    await adminsLoaded();
    await settled(queryClient, ["notes"]);
    expect(queryClient.getQueryState(["trash"])?.status).toBe("pending");
    expect(screen.getByText(TRANSFER_NO_COUNT)).toBeInTheDocument();
    expect(screen.getByText(TRASH_NOTE)).toBeInTheDocument();
    toDeleteMode();
    expect(screen.getByText(DELETE_NO_COUNT)).toBeInTheDocument();
    expect(screen.queryByText(/\b0 notes?\b/)).not.toBeInTheDocument();
    expect(screen.queryByText("This group has no notes.")).not.toBeInTheDocument();
  });

  describe("DG-T6 活筆記 0", () => {
    const noLive = () => fakeResponse(200, [note("n3", null)]);

    it("垃圾桶可信且 0 → 「This group has no notes.」（兩模式），轉移沒有垃圾桶句", async () => {
      const { queryClient } = renderDialog({ notes: noLive });
      await adminsLoaded();
      await settled(queryClient, ["trash"]);
      await waitFor(() => expect(screen.getByText("This group has no notes.")).toBeInTheDocument());
      expect(queryTrashNote()).not.toBeInTheDocument();
      toDeleteMode();
      expect(screen.getByText("This group has no notes.")).toBeInTheDocument();
    });

    it("垃圾桶不可信（看不到群組垃圾桶）→ 不說「This group has no notes.」，改用不帶數字＋垃圾桶句", async () => {
      const { queryClient } = renderDialog({ group: NO_TRASH_GROUP, notes: noLive });
      await adminsLoaded();
      await settled(queryClient, ["notes"]);
      await settled(queryClient, ["trash"]);
      expect(screen.queryByText("This group has no notes.")).not.toBeInTheDocument();
      expect(screen.getByText(TRANSFER_NO_COUNT)).toBeInTheDocument();
      expect(screen.getByText(TRASH_NOTE)).toBeInTheDocument();
      toDeleteMode();
      expect(screen.queryByText("This group has no notes.")).not.toBeInTheDocument();
      expect(screen.getByText(DELETE_NO_COUNT)).toBeInTheDocument();
    });

    it("垃圾桶 2 篇 → 全刪「2 notes (including 2 in the trash)」；轉移「2 notes」＋垃圾桶句", async () => {
      renderDialog({ notes: noLive, trash: () => fakeResponse(200, trashList([inGroup("t1"), inGroup("t2")])) });
      await adminsLoaded();
      await waitFor(() => expect(screen.getByText(/^2 notes will become Me's personal notes\./)).toBeInTheDocument());
      expect(screen.getByText(TRASH_NOTE)).toBeInTheDocument();
      toDeleteMode();
      expect(screen.getByText(/^2 notes \(including 2 in the trash\), their attachments and their edit history are permanently deleted/)).toBeInTheDocument();
      expect(screen.queryByText("This group has no notes.")).not.toBeInTheDocument();
    });

    it("垃圾桶 1 篇 → 全刪用單數「1 note (including 1 in the trash), its attachments … — it doesn't go to the trash.」", async () => {
      renderDialog({ notes: noLive, trash: () => fakeResponse(200, trashList([inGroup("t1")])) });
      await adminsLoaded();
      await waitFor(() => expect(screen.getByText(/^1 note will become Me's personal note\./)).toBeInTheDocument());
      toDeleteMode();
      expect(
        screen.getByText(/^1 note \(including 1 in the trash\), its attachments and its edit history are permanently deleted — it doesn't go to the trash\. This can't be undone\.$/),
      ).toBeInTheDocument();
    });
  });
});

// 資料夾 PR-3b-2 T7（spec §6.16 最後一列、§6.12 D5）：轉移模式、群組有資料夾時多一句去向說明。
describe("DeleteGroupDialog：群組資料夾的轉移說明（資料夾 spec §6.16）", () => {
  const OTHER_GROUP_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const FOLDERS_NOTE_EN = "The group's folders move into Me's notes, under a folder named after the group.";
  const FOLDERS_NOTE_ZH = "群組的資料夾會放進 Me 的「我的筆記」，在一個以群組名命名的資料夾底下。";
  const foldersReply = (folders: unknown[]) => () => fakeResponse(200, { folders });
  const WITH_GROUP_FOLDER = foldersReply([groupFolder({ id: "gf1", name: "Reports", groupId: GROUP.id }), folderDto({ id: "pf1", name: "Mine" })]);
  const queryFoldersNote = () => screen.queryByText(/^The group's folders move into /);

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    await i18n.changeLanguage("en");
  });

  it("DG-F1 群組有資料夾、轉移模式 → 句子逐字（en）", async () => {
    renderDialog({ folders: WITH_GROUP_FOLDER });
    await adminsLoaded();
    expect(await screen.findByText(FOLDERS_NOTE_EN, { exact: true })).toBeInTheDocument();
    // 原有的轉移說明照常
    expect(screen.getByText(/^2 notes will become Me's personal notes\./)).toBeInTheDocument();
  });

  it("DG-F1 群組有資料夾、轉移模式 → 句子逐字（zh-TW）", async () => {
    await i18n.changeLanguage("zh-TW");
    renderDialog({ folders: WITH_GROUP_FOLDER });
    const select = await screen.findByRole("combobox");
    await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(2));
    expect(await screen.findByText(FOLDERS_NOTE_ZH, { exact: true })).toBeInTheDocument();
  });

  it("DG-F2 只有別群組與個人的資料夾 → 沒有那句", async () => {
    const { queryClient } = renderDialog({
      folders: foldersReply([groupFolder({ id: "of1", name: "Other", groupId: OTHER_GROUP_ID }), folderDto({ id: "pf1", name: "Mine" })]),
    });
    await adminsLoaded();
    await settled(queryClient, ["folders"]);
    expect(queryFoldersNote()).not.toBeInTheDocument();
  });

  it("DG-F3 群組有資料夾、全刪模式 → 沒有那句", async () => {
    const { queryClient } = renderDialog({ folders: WITH_GROUP_FOLDER });
    await adminsLoaded();
    await settled(queryClient, ["folders"]);
    expect(screen.getByText(FOLDERS_NOTE_EN, { exact: true })).toBeInTheDocument();
    toDeleteMode();
    expect(queryFoldersNote()).not.toBeInTheDocument();
  });

  it("DG-F4 GET /api/folders 失敗（500）→ 沒有那句、其餘照常", async () => {
    const { queryClient } = renderDialog({ folders: () => fakeResponse(500, { error: { code: "internal", message: "x" } }) });
    await adminsLoaded();
    await settled(queryClient, ["folders"]);
    expect(queryClient.getQueryState(["folders"])?.status).toBe("error");
    expect(queryFoldersNote()).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/^2 notes will become Me's personal notes\./)).toBeInTheDocument());
    expect(confirmButton()).not.toBeDisabled();
  });
});
