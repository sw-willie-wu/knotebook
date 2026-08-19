import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { Toaster } from "@/components/ui/toast";
import { TITLE_DEBOUNCE_MS, TitleInput } from "./TitleInput";

interface FakeResponseInit {
  ok: boolean;
  status: number;
  json?: () => Promise<unknown>;
}

function fakeResponse({ ok, status, json }: FakeResponseInit): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}

const NOTE: NoteDto = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "Old title",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: null,
};

function renderTitle(props: Partial<{ note: NoteDto; readOnly: boolean; cacheRef: string }> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <TitleInput note={props.note ?? NOTE} readOnly={props.readOnly ?? false} cacheRef={props.cacheRef ?? NOTE.id} />
      <Toaster />
    </QueryClientProvider>,
  );
  return queryClient;
}

/** PATCH 回應：server 回的是整份更新後的 NoteDto。 */
function patchOk(title: string, slug: string | null = null) {
  return fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ ...NOTE, title, slug }) });
}

describe("TitleInput", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    vi.useFakeTimers({ shouldAdvanceTime: true });
    window.history.replaceState(null, "", "/notes/old-title-11111111-1111-1111-1111-111111111111");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("PATCHes the new title after the 800ms debounce", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(patchOk("New title")));
    vi.stubGlobal("fetch", fetchMock);

    renderTitle();
    fireEvent.change(screen.getByLabelText("Note title"), { target: { value: "New title" } });

    // 還沒到 800ms：什麼都不該送出。
    act(() => void vi.advanceTimersByTime(TITLE_DEBOUNCE_MS - 50));
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => void vi.advanceTimersByTime(60));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/notes/${NOTE.id}`);
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ title: "New title" });
  });

  it("只送最後一次——連續輸入不會每個字元都打一次 PATCH", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(patchOk("abc")));
    vi.stubGlobal("fetch", fetchMock);

    renderTitle();
    const input = screen.getByLabelText("Note title");
    fireEvent.change(input, { target: { value: "a" } });
    act(() => void vi.advanceTimersByTime(200));
    fireEvent.change(input, { target: { value: "ab" } });
    act(() => void vi.advanceTimersByTime(200));
    fireEvent.change(input, { target: { value: "abc" } });
    act(() => void vi.advanceTimersByTime(TITLE_DEBOUNCE_MS + 10));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({
      title: "abc",
    });
  });

  it("blur 立刻沖出待存的修改，不等計時器", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(patchOk("Blurred")));
    vi.stubGlobal("fetch", fetchMock);

    renderTitle();
    const input = screen.getByLabelText("Note title");
    fireEvent.change(input, { target: { value: "Blurred" } });
    fireEvent.blur(input);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // 沖出去之後計時器不該再補送一次。
    act(() => void vi.advanceTimersByTime(TITLE_DEBOUNCE_MS + 100));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("存檔成功後 replaceState 到新的 canonical 網址並更新本頁的 ['note', ref] 快取", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(patchOk("Brand New"))),
    );

    const queryClient = renderTitle({ cacheRef: NOTE.id });
    fireEvent.change(screen.getByLabelText("Note title"), { target: { value: "Brand New" } });
    fireEvent.blur(screen.getByLabelText("Note title"));

    await waitFor(() => expect(window.location.pathname).toBe(`/notes/Brand-New-${NOTE.id}`));
    expect(queryClient.getQueryData<NoteDto>(["note", NOTE.id])?.title).toBe("Brand New");
  });

  it("標題沒有實際改變時不送 PATCH", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(patchOk(NOTE.title)));
    vi.stubGlobal("fetch", fetchMock);

    renderTitle();
    const input = screen.getByLabelText("Note title");
    fireEvent.change(input, { target: { value: `  ${NOTE.title}  ` } });
    fireEvent.blur(input);

    act(() => void vi.advanceTimersByTime(TITLE_DEBOUNCE_MS + 100));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("清空標題後 blur → 不送 PATCH（server 端 min(1)），還原成原標題", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(patchOk(NOTE.title)));
    vi.stubGlobal("fetch", fetchMock);

    renderTitle();
    const input = screen.getByLabelText("Note title");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.blur(input);

    act(() => void vi.advanceTimersByTime(TITLE_DEBOUNCE_MS + 100));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(input).toHaveValue(NOTE.title);
  });

  it("PATCH 失敗 → toast 顯示對應錯誤並還原輸入框", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          fakeResponse({
            ok: false,
            status: 403,
            json: () => Promise.resolve({ error: { code: "forbidden", message: "nope" } }),
          }),
        ),
      ),
    );

    renderTitle();
    const input = screen.getByLabelText("Note title");
    fireEvent.change(input, { target: { value: "Nope" } });
    fireEvent.blur(input);

    await waitFor(() => expect(screen.getByText("You don't have permission to do that.")).toBeInTheDocument());
    expect(input).toHaveValue(NOTE.title);
  });

  /** 送出後停在飛行中的 PATCH：回傳「讓這次請求落地」的函式，讓測試能在往返期間插入輸入。 */
  function pendingPatch() {
    let settle!: (response: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => (settle = resolve)));
    vi.stubGlobal("fetch", fetchMock);
    return {
      fetchMock,
      settle: (response: Response) => settle(response),
    };
  }

  it("PATCH 失敗 → 使用者在請求往返期間繼續打的字不被還原蓋掉", async () => {
    const { fetchMock, settle } = pendingPatch();

    renderTitle();
    const input = screen.getByLabelText("Note title");
    fireEvent.change(input, { target: { value: "Nope" } });
    fireEvent.blur(input); // 送出 "Nope"
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.change(input, { target: { value: "Still typing" } }); // 請求還在路上時繼續打
    settle(
      fakeResponse({
        ok: false,
        status: 403,
        json: () => Promise.resolve({ error: { code: "forbidden", message: "nope" } }),
      }),
    );

    await waitFor(() => expect(screen.getByText("You don't have permission to do that.")).toBeInTheDocument());
    expect(input).toHaveValue("Still typing");
  });

  it("PATCH 成功 → 使用者在請求往返期間繼續打的字不被伺服器回應蓋掉", async () => {
    const { fetchMock, settle } = pendingPatch();

    renderTitle();
    const input = screen.getByLabelText("Note title");
    fireEvent.change(input, { target: { value: "Saved" } });
    fireEvent.blur(input);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    fireEvent.change(input, { target: { value: "Saved and more" } });
    settle(patchOk("Saved"));

    await waitFor(() => expect(window.location.pathname).toContain("Saved-"));
    expect(input).toHaveValue("Saved and more");
  });

  it("readOnly（viewer）→ 顯示純文字，沒有輸入框", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("should not fetch"))),
    );

    renderTitle({ readOnly: true });

    expect(screen.queryByLabelText("Note title")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: NOTE.title })).toBeInTheDocument();
  });

  it("外部（別人改的）標題變動會同步到輸入框", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.reject(new Error("should not fetch"))),
    );

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <TitleInput note={NOTE} readOnly={false} cacheRef={NOTE.id} />
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText("Note title")).toHaveValue("Old title");

    rerender(
      <QueryClientProvider client={queryClient}>
        <TitleInput note={{ ...NOTE, title: "Changed elsewhere" }} readOnly={false} cacheRef={NOTE.id} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByLabelText("Note title")).toHaveValue("Changed elsewhere"));
  });
});
