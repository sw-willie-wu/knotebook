import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { GroupDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { GroupNameDialog } from "./GroupNameDialog";
import { adminRole, groupDto } from "@/test/fixtures";

const GROUP: GroupDto = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Old" }, adminRole());

function fakeResponse(status: number, body?: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: () => (body === undefined ? Promise.reject(new Error("no body")) : Promise.resolve(body)) } as unknown as Response;
}

function stubFetch(handler: (method: string, url: string, body: unknown) => Response) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ method, url, body });
      return Promise.resolve(handler(method, url, body));
    }),
  );
  return calls;
}

function renderCreate(onSaved = vi.fn(), onOpenChange = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <GroupNameDialog mode="create" open onOpenChange={onOpenChange} onSaved={onSaved} />
    </QueryClientProvider>,
  );
  return { onSaved, onOpenChange, queryClient };
}

describe("GroupNameDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("建立：Enter 送出 trim 後的名稱（POST /api/groups）、成功後 onSaved(group) 且 onOpenChange(false)", async () => {
    const calls = stubFetch(() => fakeResponse(201, { ...GROUP, name: "Team" }));
    const { onSaved, onOpenChange } = renderCreate();
    const input = screen.getByLabelText("Group name");
    expect(input).toHaveFocus();
    expect(input).toHaveAttribute("maxlength", "80");
    fireEvent.change(input, { target: { value: "  Team  " } });
    fireEvent.submit(input.closest("form")!);
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ name: "Team" })));
    expect(calls[0]).toEqual({ method: "POST", url: "/api/groups", body: { name: "Team" } });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("RF1：全空白不送出（建立鈕 disabled、submit 無 fetch）；server 400 invalid_name → 對話框內 alert、不關閉", async () => {
    const calls = stubFetch(() => fakeResponse(400, { error: { code: "invalid_name", message: "x" } }));
    const { onOpenChange } = renderCreate();
    const input = screen.getByLabelText("Group name");
    fireEvent.change(input, { target: { value: "   " } });
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
    fireEvent.submit(input.closest("form")!);
    expect(calls).toHaveLength(0);

    fireEvent.change(input, { target: { value: "x".repeat(80) } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Group names must be 1–80 characters."));
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(screen.getByRole("dialog", { name: "New group" })).toBeInTheDocument();
  });

  it("改名：預填舊名、標題「Rename group」、送 PATCH /api/groups/:id", async () => {
    const calls = stubFetch(() => fakeResponse(200, { ...GROUP, name: "New" }));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const onSaved = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <GroupNameDialog mode="rename" group={GROUP} open onOpenChange={vi.fn()} onSaved={onSaved} />
      </QueryClientProvider>,
    );
    expect(screen.getByRole("dialog", { name: "Rename group" })).toBeInTheDocument();
    const input = screen.getByLabelText("Group name");
    expect(input).toHaveValue("Old");
    fireEvent.change(input, { target: { value: "New" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ name: "New" })));
    expect(calls[0]).toEqual({ method: "PATCH", url: `/api/groups/${GROUP.id}`, body: { name: "New" } });
  });

  it("Escape → onOpenChange(false)；取消鈕同", () => {
    stubFetch(() => fakeResponse(500));
    const { onOpenChange } = renderCreate();
    fireEvent.keyDown(screen.getByLabelText("Group name"), { key: "Escape" });
    expect(onOpenChange).toHaveBeenCalledWith(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onOpenChange).toHaveBeenCalledTimes(2);
  });
});
