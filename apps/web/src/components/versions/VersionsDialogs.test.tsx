import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { VersionCurrentDto, VersionDto, VersionListDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { Toaster, dismissAllToasts } from "@/components/ui/toast";
import { clickOutside } from "@/test/outside-click";
import { VersionsProvider, useVersions, useVersionsController } from "@/lib/versions-context";
import { VersionsDialogs } from "./VersionsDialogs";
import { useApplyFlow } from "./use-apply-flow";

const NOTE = "n1";
const v = (seq: number, over: Partial<VersionDto> = {}): VersionDto => ({ id: `v-${seq}`, seq, kind: "auto", name: null, editors: [], baseSeq: null, createdAt: "2026-10-09T00:00:00.000Z", ...over });
const cur = (over: Partial<VersionCurrentDto> = {}): VersionCurrentDto => ({ baseSeq: 2, dirty: false, nextSeq: 3, autoEnabled: true, ...over });
const listBody = (current: VersionCurrentDto): VersionListDto => ({ versions: [v(2), v(1)], current, nextBefore: null });

type Handler = (url: string, init?: RequestInit) => { status: number; body?: unknown } | undefined;
function stub(handler: Handler) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const r = handler(url, init);
      if (!r) throw new Error(`unexpected fetch: ${method} ${url}`);
      return Promise.resolve({ ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) } as Response);
    }),
  );
  return calls;
}

function Harness({ target }: { target: VersionDto }) {
  const s = useVersions();
  const flow = useApplyFlow(NOTE);
  return (
    <div>
      <button type="button" onClick={() => s.startPreview({ seq: target.seq, id: target.id })}>h-preview</button>
      <button type="button" onClick={() => void flow.requestApply(target)}>h-apply</button>
      <button type="button" onClick={() => s.openSave()}>h-save</button>
      <button type="button" onClick={() => s.openDialog({ kind: "rename", version: target })}>h-rename</button>
      <button type="button" onClick={() => s.openDialog({ kind: "delete", version: target })}>h-delete</button>
      <span data-testid="h-state">{JSON.stringify({ preview: s.preview, dialog: s.dialog?.kind ?? null })}</span>
      {/* 編輯器替身（final I-2）：Ctrl+S 時焦點在 contenteditable 上。 */}
      <div data-testid="h-editor" contentEditable suppressContentEditableWarning tabIndex={-1}>
        editor
      </div>
    </div>
  );
}
function Host({ target }: { target: VersionDto }) {
  const value = useVersionsController({ noteId: NOTE, enabled: true });
  // final I-2 fallback：模擬頁首 ⋮——選單項按下（開儲存對話框）的同一批次就卸載；`fake-menu-trigger` 是交下來的 returnFocusRef。
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [menuOpen, setMenuOpen] = useState(true);
  return (
    <VersionsProvider value={value}>
      <Harness target={target} />
      <button ref={triggerRef} type="button">
        fake-menu-trigger
      </button>
      {menuOpen && (
        <button
          type="button"
          onClick={() => {
            setMenuOpen(false);
            value.openSave();
          }}
        >
          menu-item-save
        </button>
      )}
      {/* 照 NotePage 的掛法（final fix 2 I-A）：只在 dialog !== null 時掛，關閉即卸載。 */}
      {value.dialog !== null && <VersionsDialogs returnFocusRef={triggerRef} />}
    </VersionsProvider>
  );
}
function renderDialogs(target: VersionDto = v(1)) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <Host target={target} />
      <Toaster />
    </QueryClientProvider>,
  );
  return { queryClient };
}
const hState = () => JSON.parse(screen.getByTestId("h-state").textContent!);
const LIST = `/api/notes/${NOTE}/versions?limit=50`;
const CUR = `/api/notes/${NOTE}/versions?limit=1`;
const APPLY1 = `/api/notes/${NOTE}/versions/1/apply`;

describe("VersionsDialogs＋useApplyFlow（spec §8.5）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("儲存：描述帶 v{nextSeq}；名稱去頭尾空白送出；toast「Saved as v3」；關閉", async () => {
    const calls = stub((url, init) => {
      if (url === LIST) return { status: 200, body: listBody(cur({ dirty: true })) };
      if (url === `/api/notes/${NOTE}/versions` && init?.method === "POST") return { status: 201, body: { ...v(3, { kind: "manual", name: "里程碑" }), upgraded: false } };
      return undefined;
    });
    renderDialogs();
    fireEvent.click(screen.getByText("h-save"));
    const dialog = await screen.findByRole("dialog", { name: "Save current version" });
    expect(await within(dialog).findByText("Creates version v3 from the current content.")).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("Version name (optional)"), { target: { value: "  里程碑 " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved as v3")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "POST")?.body).toEqual({ name: "里程碑" });
    await waitFor(() => expect(hState().dialog).toBeNull());
  });

  it("M-3：儲存對話框點外面不關（表單型 dismissOnOutside={false}）、已填的名稱還在", async () => {
    stub((url) => (url === LIST ? { status: 200, body: listBody(cur({ dirty: true })) } : undefined));
    renderDialogs();
    fireEvent.click(screen.getByText("h-save"));
    const dialog = await screen.findByRole("dialog", { name: "Save current version" });
    fireEvent.change(within(dialog).getByLabelText("Version name (optional)"), { target: { value: "草稿" } });
    await clickOutside();
    expect(screen.getByRole("dialog", { name: "Save current version" })).toBeInTheDocument();
    expect(within(screen.getByRole("dialog")).getByLabelText("Version name (optional)")).toHaveValue("草稿");
  });

  it("儲存遇到內容與基底相同（upgraded:true）→ toast 依回應的 seq，不用快取的 baseSeq（r7 N-3）", async () => {
    stub((url, init) => {
      if (url === LIST) return { status: 200, body: listBody(cur({ baseSeq: 9 })) };
      if (url === `/api/notes/${NOTE}/versions` && init?.method === "POST") return { status: 201, body: { ...v(2, { kind: "manual" }), upgraded: true } };
      return undefined;
    });
    renderDialogs();
    fireEvent.click(screen.getByText("h-save"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Same content as v2 — v2 is now a manual version")).toBeInTheDocument();
  });

  it("套用：重抓 current 不 dirty → 直接 POST apply（discardUnsaved:false、帶 versionId）、不跳對話框、toast、離開預覽", async () => {
    const calls = stub((url) => {
      if (url === CUR) return { status: 200, body: listBody(cur({ dirty: false })) };
      if (url === APPLY1) return { status: 200, body: { current: cur({ baseSeq: 1 }) } };
      if (url === LIST) return { status: 200, body: listBody(cur()) };
      return undefined;
    });
    renderDialogs();
    fireEvent.click(screen.getByText("h-preview"));
    fireEvent.click(screen.getByText("h-apply"));
    expect(await screen.findByText("Applied v1")).toBeInTheDocument();
    expect(calls.find((c) => c.url === APPLY1)?.body).toEqual({ versionId: "v-1", discardUnsaved: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(hState().preview).toBeNull();
  });

  it("面板快取寫著乾淨、但按套用前重抓到 dirty → 跳三選一（spec §8.2：一律重抓）", async () => {
    const calls = stub((url) => {
      if (url === CUR) return { status: 200, body: listBody(cur({ dirty: true })) };
      return undefined;
    });
    const { queryClient } = renderDialogs();
    queryClient.setQueryData(["notes", NOTE, "versions"], { pages: [listBody(cur({ dirty: false }))], pageParams: [undefined] });
    fireEvent.click(screen.getByText("h-apply"));
    const dialog = await screen.findByRole("dialog", { name: "Apply v1" });
    expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Apply without saving" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Save current version" })).toBeInTheDocument();
    expect(calls.some((c) => c.url === APPLY1)).toBe(false);
  });

  it("三選一：取消 → 不打 apply；不儲存直接套用 → discardUnsaved:true", async () => {
    const calls = stub((url) => {
      if (url === CUR) return { status: 200, body: listBody(cur({ dirty: true })) };
      if (url === APPLY1) return { status: 200, body: { current: cur({ baseSeq: 1 }) } };
      return undefined;
    });
    renderDialogs();
    fireEvent.click(screen.getByText("h-apply"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(calls.some((c) => c.url === APPLY1)).toBe(false);
    fireEvent.click(screen.getByText("h-apply"));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Apply without saving" }));
    expect(await screen.findByText("Applied v1")).toBeInTheDocument();
    expect(calls.find((c) => c.url === APPLY1)?.body).toEqual({ versionId: "v-1", discardUnsaved: true });
  });

  it("三選一：儲存當前版本 → 開儲存對話框；存完自動接著套用（discardUnsaved:false），POST 順序是先存後套用", async () => {
    const calls = stub((url, init) => {
      if (url === CUR) return { status: 200, body: listBody(cur({ dirty: true })) };
      if (url === LIST) return { status: 200, body: listBody(cur({ dirty: true })) };
      if (url === `/api/notes/${NOTE}/versions` && init?.method === "POST") return { status: 201, body: { ...v(3, { kind: "manual" }), upgraded: false } };
      if (url === APPLY1) return { status: 200, body: { current: cur({ baseSeq: 1 }) } };
      return undefined;
    });
    renderDialogs();
    fireEvent.click(screen.getByText("h-apply"));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Apply v1" })).getByRole("button", { name: "Save current version" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Save current version" })).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Applied v1")).toBeInTheDocument();
    const posts = calls.filter((c) => c.method === "POST").map((c) => c.url);
    expect(posts).toEqual([`/api/notes/${NOTE}/versions`, APPLY1]);
    expect(calls.find((c) => c.url === APPLY1)?.body).toEqual({ versionId: "v-1", discardUnsaved: false });
  });

  it("直接套用收到 409 version_unsaved_changes → 改跳三選一", async () => {
    stub((url) => {
      if (url === CUR) return { status: 200, body: listBody(cur({ dirty: false })) };
      if (url === APPLY1) return { status: 409, body: { error: { code: "version_unsaved_changes", message: "目前有未儲存的修改" } } };
      return undefined;
    });
    renderDialogs();
    fireEvent.click(screen.getByText("h-apply"));
    expect(await screen.findByRole("dialog", { name: "Apply v1" })).toBeInTheDocument();
  });

  it("409 version_mismatch → toast errors.version_mismatch、invalidate 清單、離開預覽、沒有對話框", async () => {
    const calls = stub((url) => {
      if (url === CUR) return { status: 200, body: listBody(cur({ dirty: false })) };
      if (url === APPLY1) return { status: 409, body: { error: { code: "version_mismatch", message: "x" } } };
      return undefined;
    });
    const { queryClient } = renderDialogs();
    const spy = vi.spyOn(queryClient, "invalidateQueries");
    fireEvent.click(screen.getByText("h-preview"));
    fireEvent.click(screen.getByText("h-apply"));
    expect(await screen.findByText(i18n.t("errors.version_mismatch"))).toBeInTheDocument();
    expect(spy).toHaveBeenCalledWith({ queryKey: ["notes", NOTE, "versions"] });
    expect(hState().preview).toBeNull();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(calls.filter((c) => c.url === APPLY1)).toHaveLength(1);
  });

  it("改名：自動版顯示「會轉為手動」提示；送出 PATCH { name }；全空白送 null", async () => {
    const calls = stub((url, init) => {
      if (url === `/api/notes/${NOTE}/versions/1` && init?.method === "PATCH") return { status: 200, body: v(1, { kind: "manual" }) };
      return undefined;
    });
    renderDialogs(v(1, { kind: "auto", name: "舊名" }));
    fireEvent.click(screen.getByText("h-rename"));
    const dialog = await screen.findByRole("dialog", { name: "Edit name of v1" });
    expect(within(dialog).getByText("Naming an automatic version makes it a manual version, which is kept until you delete it.")).toBeInTheDocument();
    const input = within(dialog).getByLabelText("Version name (optional)");
    expect(input).toHaveValue("舊名");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Version name updated")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PATCH")?.body).toEqual({ name: null });
  });

  it("刪除：成功 → DELETE、toast；刪的是預覽中那版 → 離開預覽", async () => {
    stub((url, init) => {
      if (url === `/api/notes/${NOTE}/versions/1` && init?.method === "DELETE") return { status: 204 };
      return undefined;
    });
    renderDialogs();
    fireEvent.click(screen.getByText("h-preview"));
    fireEvent.click(screen.getByText("h-delete"));
    const dialog = await screen.findByRole("dialog", { name: "Delete v1?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await screen.findByText("Deleted v1")).toBeInTheDocument();
    expect(hState().preview).toBeNull();
  });

  it("final I-2：編輯器有焦點 → 開儲存對話框 → 取消／存完關閉 → 焦點都回到編輯器（受控 Dialog 沒有 Trigger，Radix 不會自己還原）", async () => {
    stub((url, init) => {
      if (url === LIST) return { status: 200, body: listBody(cur({ dirty: true })) };
      if (url === `/api/notes/${NOTE}/versions` && init?.method === "POST") return { status: 201, body: { ...v(3, { kind: "manual" }), upgraded: false } };
      return undefined;
    });
    renderDialogs();
    const editor = screen.getByTestId("h-editor");
    editor.focus();
    expect(document.activeElement).toBe(editor);
    fireEvent.click(screen.getByText("h-save"));
    let dialog = await screen.findByRole("dialog", { name: "Save current version" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(editor));
    // 第二輪：送出成功關閉也一樣。
    fireEvent.click(screen.getByText("h-save"));
    dialog = await screen.findByRole("dialog", { name: "Save current version" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Saved as v3")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(editor));
  });

  it("final I-2 fallback：從 ⋮ 選單開儲存對話框（記到的選單項已卸載）→ 取消 → 焦點退回 ⋮ 觸發鈕", async () => {
    stub((url) => (url === LIST ? { status: 200, body: listBody(cur({ dirty: true })) } : undefined));
    renderDialogs();
    const item = screen.getByText("menu-item-save");
    item.focus();
    expect(document.activeElement).toBe(item);
    fireEvent.click(item);
    const dialog = await screen.findByRole("dialog", { name: "Save current version" });
    expect(screen.queryByText("menu-item-save")).not.toBeInTheDocument();
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "fake-menu-trigger" })));
  });

  it("final fix 2 M-A：開對話框時焦點在 body（沒有可還的元素）→ 關閉後退回 ⋮ 觸發鈕，不是還給 body", async () => {
    stub((url) => (url === LIST ? { status: 200, body: listBody(cur({ dirty: true })) } : undefined));
    renderDialogs();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(document.activeElement).toBe(document.body);
    fireEvent.click(screen.getByText("h-save"));
    const dialog = await screen.findByRole("dialog", { name: "Save current version" });
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "fake-menu-trigger" })));
  });

  it("final I-2：三選一 → 「儲存當前版本」換成儲存對話框時焦點留在新對話框裡（不被拉回編輯器）；存完套用後才回到編輯器", async () => {
    stub((url, init) => {
      if (url === CUR) return { status: 200, body: listBody(cur({ dirty: true })) };
      if (url === LIST) return { status: 200, body: listBody(cur({ dirty: true })) };
      if (url === `/api/notes/${NOTE}/versions` && init?.method === "POST") return { status: 201, body: { ...v(3, { kind: "manual" }), upgraded: false } };
      if (url === APPLY1) return { status: 200, body: { current: cur({ baseSeq: 1 }) } };
      return undefined;
    });
    renderDialogs();
    const editor = screen.getByTestId("h-editor");
    editor.focus();
    fireEvent.click(screen.getByText("h-apply"));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Apply v1" })).getByRole("button", { name: "Save current version" }));
    const save = await screen.findByRole("dialog", { name: "Save current version" });
    await waitFor(() => expect(save.contains(document.activeElement)).toBe(true));
    // 舊對話框卸載時 FocusScope 的還原事件在 setTimeout 0 送出——等過那一拍，焦點仍要在新對話框裡。
    await new Promise((r) => setTimeout(r, 50));
    expect(save.contains(document.activeElement)).toBe(true);
    fireEvent.click(within(save).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Applied v1")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(editor));
  });

  it("final M-4：存完再套用——存檔成功到套用完成之間，送出鈕不可再按（第二次點擊不觸發第二次 POST）", async () => {
    let releaseApply: () => void = () => {};
    const calls: Array<{ method: string; url: string }> = [];
    const res = (status: number, body?: unknown) => ({ ok: status < 400, status, json: () => Promise.resolve(body) }) as Response;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push({ method, url });
        if (url === CUR || url === LIST) return Promise.resolve(res(200, listBody(cur({ dirty: true }))));
        if (url === `/api/notes/${NOTE}/versions` && method === "POST") return Promise.resolve(res(201, { ...v(3, { kind: "manual" }), upgraded: false }));
        if (url === APPLY1) return new Promise<Response>((resolve) => (releaseApply = () => resolve(res(200, { current: cur({ baseSeq: 1 }) }))));
        throw new Error(`unexpected fetch: ${method} ${url}`);
      }),
    );
    renderDialogs();
    fireEvent.click(screen.getByText("h-apply"));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "Apply v1" })).getByRole("button", { name: "Save current version" }));
    const save = await screen.findByRole("dialog", { name: "Save current version" });
    const submit = within(save).getByRole("button", { name: "Save" });
    fireEvent.click(submit);
    // 存檔已成功（toast 出現）、套用 POST 還沒回來。
    expect(await screen.findByText("Saved as v3")).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.url === APPLY1)).toBe(true));
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    fireEvent.submit(submit.closest("form")!);
    await new Promise((r) => setTimeout(r, 50));
    expect(calls.filter((c) => c.method === "POST" && c.url === `/api/notes/${NOTE}/versions`)).toHaveLength(1);
    expect(calls.filter((c) => c.url === APPLY1)).toHaveLength(1);
    releaseApply();
    expect(await screen.findByText("Applied v1")).toBeInTheDocument();
  });

  it("刪除遇到 409 version_is_base → 對話框內行內錯誤、對話框留著", async () => {
    stub((url, init) => {
      if (url === `/api/notes/${NOTE}/versions/1` && init?.method === "DELETE") return { status: 409, body: { error: { code: "version_is_base", message: "x" } } };
      return undefined;
    });
    renderDialogs();
    fireEvent.click(screen.getByText("h-delete"));
    const dialog = await screen.findByRole("dialog", { name: "Delete v1?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent(i18n.t("errors.version_is_base"));
    expect(screen.getByRole("dialog", { name: "Delete v1?" })).toBeInTheDocument();
  });
});
