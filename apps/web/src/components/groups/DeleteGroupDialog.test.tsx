import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GroupDto, GroupMemberDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { clickOutside } from "@/test/outside-click";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { adminRole, groupDto, memberRole } from "@/test/fixtures";
import { DeleteGroupDialog } from "./DeleteGroupDialog";

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

interface Setup {
  members?: () => Response | Promise<Response>;
  notes?: () => Response | Promise<Response>;
  del?: () => Response;
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
      if (method === "GET" && url === "/api/notes") return Promise.resolve((setup.notes ?? (() => fakeResponse(200, NOTES)))());
      if (method === "DELETE" && url === `/api/groups/${GROUP.id}`) return Promise.resolve((setup.del ?? (() => fakeResponse(204)))());
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  const onOpenChange = props.onOpenChange ?? vi.fn();
  const onDeleted = props.onDeleted ?? vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  // 呼叫端的掛載形：`open && <DeleteGroupDialog …/>`——onOpenChange(false) 後卸載
  function Host() {
    return <DeleteGroupDialog group={GROUP} onOpenChange={onOpenChange} onDeleted={onDeleted} />;
  }
  render(
    <QueryClientProvider client={queryClient}>
      <Host />
      <Toaster />
    </QueryClientProvider>,
  );
  return { calls, onOpenChange, onDeleted };
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
    expect(screen.getByText(/^The group's notes, their attachments and their edit history are permanently deleted/)).toBeInTheDocument();
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
