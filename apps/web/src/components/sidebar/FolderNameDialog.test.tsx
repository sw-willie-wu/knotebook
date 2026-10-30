import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "@/i18n";
import { folderDto } from "@/test/folder-fixtures";
import { __resetCollapseForTests, isCollapsed, setCollapsed } from "./collapse";
import { __resetFolderSortForTests } from "./folder-sort";
import { FolderNameDialog, type FolderCreateParent } from "./FolderNameDialog";

afterEach(() => {
  localStorage.clear();
  __resetCollapseForTests();
  __resetFolderSortForTests();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** POST／PATCH /api/folders：`reply` 決定回應；每次的 method、url、body 記下。 */
function stubFolders(reply: () => Response = () => json(folderDto({ id: "new", name: "x" }), 201)) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      if (url.startsWith("/api/folders") && method !== "GET") return Promise.resolve(reply());
      return Promise.resolve(json({ folders: [] }));
    }),
  );
  return calls;
}

/** 框外的 opener 不歸 React 管，每案結束自己拆掉（不能清整個 body：Radix 的 portal 要留給 RTL cleanup 卸載）。 */
const openers: HTMLElement[] = [];

type HostProps =
  | { mode: "create"; parent: FolderCreateParent }
  | { mode: "rename"; folder: ReturnType<typeof folderDto>; stack?: { onClosed: (finalName: string) => void; focusTarget: () => HTMLElement | null } };

/** 比照 NoteList host：關閉就卸載。opener 是框外的一顆鈕（還焦點的對象）。 */
function renderDialog(props: HostProps, queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  const opener = document.createElement("button");
  opener.textContent = "opener";
  document.body.appendChild(opener);
  openers.push(opener);
  const ref = { current: opener as HTMLElement | null };
  function Host() {
    const [open, setOpen] = useState(true);
    return open ? <FolderNameDialog {...props} open onOpenChange={setOpen} returnFocusRef={ref} /> : null;
  }
  const view = render(
    <QueryClientProvider client={queryClient}>
      <Host />
    </QueryClientProvider>,
  );
  return { view, opener, queryClient };
}

const input = () => screen.getByRole("textbox", { name: "Folder name" });
const submit = (name: "Create" | "Save" = "Create") => screen.getByRole("button", { name });
const type = (value: string) => fireEvent.change(input(), { target: { value } });
const PERSONAL: FolderCreateParent = { space: { kind: "personal" } };
const posted = (calls: ReturnType<typeof stubFolders>) => calls.filter((c) => c.method !== "GET");

describe("FolderNameDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    for (const opener of openers.splice(0)) opener.remove();
    await i18n.changeLanguage("en");
  });

  it("FN1 create：空白 → 送出 disabled；「  A  」→ body {name: A, space: personal}（送 trim 後的字串）", async () => {
    const calls = stubFolders();
    renderDialog({ mode: "create", parent: PERSONAL });
    expect(submit()).toBeDisabled();
    type("   ");
    expect(submit()).toBeDisabled();
    type("  A  ");
    fireEvent.click(submit());
    await waitFor(() => expect(posted(calls)).toEqual([{ method: "POST", url: "/api/folders", body: { name: "A", space: { kind: "personal" } } }]));
  });

  it("FN2 81 個中文字 → 行內上限錯誤、不送；80 個 emoji（160 code unit、80 code point）→ 可送", async () => {
    const calls = stubFolders();
    renderDialog({ mode: "create", parent: PERSONAL });
    type("字".repeat(81));
    expect(screen.getByRole("alert")).toHaveTextContent("Names can be at most 80 characters");
    expect(submit()).toBeDisabled();
    fireEvent.submit(input().closest("form")!);
    expect(posted(calls)).toEqual([]);
    const emoji = "😀".repeat(80);
    expect(emoji.length).toBe(160);
    type(emoji);
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(submit());
    await waitFor(() => expect(posted(calls)).toHaveLength(1));
    expect((posted(calls)[0]!.body as { name: string }).name).toBe(emoji);
  });

  it("FN3 字中控制字元（C0、U+2028、bidi）→ 行內錯誤逐字、不送；首尾的控制字元 trim 後可送", async () => {
    const calls = stubFolders();
    renderDialog({ mode: "create", parent: PERSONAL });
    for (const bad of ["A\u0007B", "A\u2028B", "A\u202EB"]) {
      type(bad);
      expect(screen.getByRole("alert")).toHaveTextContent("Names can't contain line breaks or control characters");
      expect(submit()).toBeDisabled();
    }
    fireEvent.submit(input().closest("form")!);
    expect(posted(calls)).toEqual([]);
    type("\tA\t");
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(submit());
    await waitFor(() => expect(posted(calls)).toEqual([{ method: "POST", url: "/api/folders", body: { name: "A", space: { kind: "personal" } } }]));
  });

  it("FN4 409 folder_name_taken → 行內錯誤、框仍開", async () => {
    stubFolders(() => json({ error: { code: "folder_name_taken", message: "x" } }, 409));
    renderDialog({ mode: "create", parent: PERSONAL });
    type("A");
    fireEvent.click(submit());
    expect(await screen.findByRole("alert")).toHaveTextContent("There's already a folder with this name here.");
    expect(screen.getByRole("dialog", { name: "New folder" })).toBeInTheDocument();
  });

  it("FN5 rename 預填原名、送 PATCH {name: B}", async () => {
    const calls = stubFolders(() => json(folderDto({ id: "f1", name: "B" })));
    renderDialog({ mode: "rename", folder: folderDto({ id: "f1", name: "A" }) });
    expect(input()).toHaveValue("A");
    type("B");
    fireEvent.click(submit("Save"));
    await waitFor(() => expect(posted(calls)).toEqual([{ method: "PATCH", url: "/api/folders/f1", body: { name: "B" } }]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("FN6 create（parent＝資料夾 P）成功 → ['folders'] 被失效、P 與祖先（取自快取裡的索引）的收合鍵被刪", async () => {
    stubFolders();
    setCollapsed("folder:P", true);
    setCollapsed("folder:GP", true);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(["folders"], [folderDto({ id: "GP", name: "GP" }), folderDto({ id: "P", name: "P", parentId: "GP" })]);
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    renderDialog({ mode: "create", parent: { folderId: "P" } }, queryClient);
    type("Child");
    fireEvent.click(submit());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(spy).toHaveBeenCalledWith({ queryKey: ["folders"] });
    expect(isCollapsed("folder:P")).toBe(false);
    expect(localStorage.getItem("sidebar.collapsed.folder:P")).toBeNull();
    expect(isCollapsed("folder:GP")).toBe(false);
  });

  it("FN7 關框焦點回 opener；opener 已卸載 → 不丟錯", async () => {
    stubFolders();
    const { opener } = renderDialog({ mode: "create", parent: PERSONAL });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(opener).toHaveFocus());

    const second = renderDialog({ mode: "create", parent: PERSONAL });
    second.opener.remove();
    expect(() => fireEvent.click(screen.getByRole("button", { name: "Cancel" }))).not.toThrow();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("FN8 zh：標題「新增資料夾」「重新命名資料夾」、欄名「資料夾名稱」", async () => {
    await i18n.changeLanguage("zh-TW");
    stubFolders();
    const first = renderDialog({ mode: "create", parent: PERSONAL });
    expect(screen.getByRole("dialog", { name: "新增資料夾" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "資料夾名稱" })).toBeInTheDocument();
    first.view.unmount();
    renderDialog({ mode: "rename", folder: folderDto({ id: "f1", name: "A" }) });
    expect(screen.getByRole("dialog", { name: "重新命名資料夾" })).toBeInTheDocument();
  });

  it("FN9 群組收合時從群組列建資料夾成功 → group:G 寫成展開", async () => {
    const calls = stubFolders();
    setCollapsed("group:G", true);
    renderDialog({ mode: "create", parent: { space: { kind: "group", groupId: "G" } } });
    type("Reports");
    fireEvent.click(submit());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posted(calls)[0]!.body).toEqual({ name: "Reports", space: { kind: "group", groupId: "G" } });
    expect(isCollapsed("group:G")).toBe(false);
  });
});

/** 疊資料夾改名形（資料夾 spec §6.6、§6.13 第 6 步；PR-3c T5）。 */
describe("FolderNameDialog 疊資料夾改名", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    for (const opener of openers.splice(0)) opener.remove();
  });

  const NEW2 = folderDto({ id: "n2", name: "New folder 2" });

  /** 框外的新資料夾列鈕（focusTarget 回它）。 */
  function stackHooks() {
    const row = document.createElement("button");
    row.textContent = "row";
    document.body.appendChild(row);
    openers.push(row);
    return { row, onClosed: vi.fn<(finalName: string) => void>(), focusTarget: vi.fn(() => row as HTMLElement | null) };
  }

  it("FN-S1 帶 stack、名稱「New folder 2」→ 開啟時輸入框全選（0–12）", () => {
    stubFolders();
    const hooks = stackHooks();
    renderDialog({ mode: "rename", folder: NEW2, stack: hooks });
    expect(input()).toHaveValue("New folder 2");
    expect((input() as HTMLInputElement).selectionStart).toBe(0);
    expect((input() as HTMLInputElement).selectionEnd).toBe(12);
  });

  it("FN-S2 改成「 Q3 」送出 → PATCH {name: Q3}；關閉後 onClosed(\"Q3\") 恰一次", async () => {
    const calls = stubFolders(() => json(folderDto({ id: "n2", name: "Q3" })));
    const hooks = stackHooks();
    renderDialog({ mode: "rename", folder: NEW2, stack: hooks });
    type(" Q3 ");
    fireEvent.click(submit("Save"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posted(calls)).toEqual([{ method: "PATCH", url: "/api/folders/n2", body: { name: "Q3" } }]);
    expect(hooks.onClosed).toHaveBeenCalledTimes(1);
    expect(hooks.onClosed).toHaveBeenCalledWith("Q3");
  });

  it("FN-S9 名稱沒改（含只加了首尾空白）直接 Save → 不送 PATCH、關框、onClosed(\"New folder 2\") 恰一次；不帶 stack 的 rename 照舊送 PATCH", async () => {
    const calls = stubFolders(() => json(NEW2));
    const hooks = stackHooks();
    const first = renderDialog({ mode: "rename", folder: NEW2, stack: hooks });
    type("  New folder 2 ");
    fireEvent.click(submit("Save"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posted(calls)).toEqual([]);
    expect(hooks.onClosed).toHaveBeenCalledTimes(1);
    expect(hooks.onClosed).toHaveBeenCalledWith("New folder 2");
    first.view.unmount();

    renderDialog({ mode: "rename", folder: NEW2 });
    fireEvent.click(submit("Save"));
    await waitFor(() => expect(posted(calls)).toEqual([{ method: "PATCH", url: "/api/folders/n2", body: { name: "New folder 2" } }]));
  });

  it("FN-S3 按 Cancel → 沒有 PATCH、onClosed(\"New folder 2\") 恰一次", async () => {
    const calls = stubFolders();
    const hooks = stackHooks();
    renderDialog({ mode: "rename", folder: NEW2, stack: hooks });
    type("Changed but cancelled");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(posted(calls)).toEqual([]);
    expect(hooks.onClosed).toHaveBeenCalledTimes(1);
    expect(hooks.onClosed).toHaveBeenCalledWith("New folder 2");
  });

  it("FN-S3 按 Esc → onClosed(\"New folder 2\") 恰一次", async () => {
    stubFolders();
    const hooks = stackHooks();
    renderDialog({ mode: "rename", folder: NEW2, stack: hooks });
    fireEvent.keyDown(input(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(hooks.onClosed).toHaveBeenCalledTimes(1);
    expect(hooks.onClosed).toHaveBeenCalledWith("New folder 2");
  });

  it("FN-S4 關閉後焦點到 focusTarget() 回的元素（不是 opener）", async () => {
    stubFolders();
    const hooks = stackHooks();
    const { opener } = renderDialog({ mode: "rename", folder: NEW2, stack: hooks });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(hooks.row).toHaveFocus());
    expect(opener).not.toHaveFocus();
    expect(hooks.focusTarget).toHaveBeenCalled();
  });

  it("FN-S5 PATCH 409 → 框仍開、onClosed 未被呼叫", async () => {
    stubFolders(() => json({ error: { code: "folder_name_taken", message: "x" } }, 409));
    const hooks = stackHooks();
    renderDialog({ mode: "rename", folder: NEW2, stack: hooks });
    type("Taken");
    fireEvent.click(submit("Save"));
    expect(await screen.findByRole("alert")).toHaveTextContent("There's already a folder with this name here.");
    expect(screen.getByRole("dialog", { name: "Rename folder" })).toBeInTheDocument();
    expect(hooks.onClosed).not.toHaveBeenCalled();
  });

  /** 送出「Q3」、PATCH 掛著時按 Esc 關框；回傳放行 PATCH 的函式（reply 決定回應）。 */
  async function escWhileRenaming(hooks: ReturnType<typeof stackHooks>, reply: () => Response) {
    let release: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? "GET").toUpperCase() === "GET") return Promise.resolve(json({ folders: [] }));
        return new Promise<Response>((resolve) => {
          release = () => resolve(reply());
        });
      }),
    );
    renderDialog({ mode: "rename", folder: NEW2, stack: hooks });
    type("Q3");
    fireEvent.click(submit("Save"));
    await waitFor(() => expect(release).toBeDefined());
    fireEvent.keyDown(input(), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    return async () => {
      await act(async () => {
        release!();
      });
    };
  }

  it("FN-S7 送出後 PATCH 還沒回就按 Esc → 先不回報；PATCH 成功後 onClosed(\"Q3\")（最後的名字）恰一次", async () => {
    const hooks = stackHooks();
    const release = await escWhileRenaming(hooks, () => json(folderDto({ id: "n2", name: "Q3" })));
    expect(hooks.onClosed).not.toHaveBeenCalled();

    await release();

    expect(hooks.onClosed).toHaveBeenCalledTimes(1);
    expect(hooks.onClosed).toHaveBeenCalledWith("Q3");
  });

  it("FN-S8 送出後 PATCH 還沒回就按 Esc、PATCH 之後 409 → onClosed(\"New folder 2\")（名稱沒變）恰一次", async () => {
    const hooks = stackHooks();
    const release = await escWhileRenaming(hooks, () => json({ error: { code: "folder_name_taken", message: "x" } }, 409));
    expect(hooks.onClosed).not.toHaveBeenCalled();

    await release();

    expect(hooks.onClosed).toHaveBeenCalledTimes(1);
    expect(hooks.onClosed).toHaveBeenCalledWith("New folder 2");
  });

  it("FN-S6 不帶 stack 的 rename：輸入框不全選（selectionStart === selectionEnd）；關閉焦點照舊回 opener", async () => {
    stubFolders();
    const { opener } = renderDialog({ mode: "rename", folder: NEW2 });
    const el = input() as HTMLInputElement;
    expect(el.selectionStart).toBe(el.selectionEnd);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(opener).toHaveFocus());
  });
});
