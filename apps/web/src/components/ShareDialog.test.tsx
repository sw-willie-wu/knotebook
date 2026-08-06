import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NoteDto, ShareDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { ShareDialog } from "./ShareDialog";

// 同一套約定：mock 全域 fetch，讓真正的 useShares/usePutShare/useDeleteShare/useUpdateNote
// （react-query）打到假回應，不 mock hook 本身——見 NoteList.test.tsx/TitleInput.test.tsx 的說明。

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
  title: "My Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: null,
};

const SHARE: ShareDto = {
  userId: "22222222-2222-2222-2222-222222222222",
  email: "bob@example.com",
  displayName: "Bob",
  role: "viewer",
};

const SHARES_URL = `/api/notes/${NOTE.id}/shares`;

function renderDialog(note: NoteDto = NOTE, cacheRef = NOTE.id) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <ShareDialog note={note} cacheRef={cacheRef} />
      <Toaster />
    </QueryClientProvider>,
  );
  return queryClient;
}

async function openDialog() {
  fireEvent.click(screen.getByRole("button", { name: "Share" }));
  await waitFor(() => expect(screen.getByText("People with access")).toBeInTheDocument());
}

describe("ShareDialog", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    window.history.replaceState(null, "", `/notes/${NOTE.id}`);
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("非 owner（editor/viewer）不渲染分享鈕與 dialog", () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error("should not fetch")));
    vi.stubGlobal("fetch", fetchMock);

    renderDialog({ ...NOTE, role: "editor" });

    expect(screen.queryByRole("button", { name: "Share" })).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("owner 看得到分享鈕，點開後渲染 dialog", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) })),
    );
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();
    expect(screen.getByRole("button", { name: "Share" })).toBeInTheDocument();

    await openDialog();
    expect(screen.getByRole("heading", { name: "Share note" })).toBeInTheDocument();
  });

  it("輸入保留字 'New' → 立即顯示保留字錯誤（shared validateSlug，不打網路）", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === SHARES_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();
    await openDialog();

    const slugInput = screen.getByRole("textbox", { name: "Custom link" });
    fireEvent.change(slugInput, { target: { value: "New" } });

    await waitFor(() =>
      expect(screen.getByText("This word is reserved and can't be used.")).toBeInTheDocument(),
    );
    // 只有開 dialog 時那一次 GET shares；驗證錯誤純本地計算，完全沒打第二支請求。
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Save 鈕在本地驗證失敗時應被停用，點了也不該送出。
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("PATCH 回 409 slug_taken → 顯示對應文案", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === SHARES_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === `/api/notes/${NOTE.id}` && method === "PATCH") {
        return Promise.resolve(
          fakeResponse({
            ok: false,
            status: 409,
            json: () => Promise.resolve({ error: { code: "slug_taken", message: "taken" } }),
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();
    await openDialog();

    const slugInput = screen.getByRole("textbox", { name: "Custom link" });
    fireEvent.change(slugInput, { target: { value: "taken-slug" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText("That URL is already taken.")).toBeInTheDocument());
  });

  it("PATCH 回 429 too_many_requests → 顯示稍後再試文案", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === SHARES_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === `/api/notes/${NOTE.id}` && method === "PATCH") {
        return Promise.resolve(
          fakeResponse({
            ok: false,
            status: 429,
            json: () => Promise.resolve({ error: { code: "too_many_requests", message: "slow down" } }),
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();
    await openDialog();

    const slugInput = screen.getByRole("textbox", { name: "Custom link" });
    fireEvent.change(slugInput, { target: { value: "some-slug" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.getByText("Too many requests. Please slow down.")).toBeInTheDocument());
  });

  it("成功變更 slug → replaceState 到新的 canonical 網址並寫回本頁快取", async () => {
    const updated: NoteDto = { ...NOTE, slug: "brand-new" };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === SHARES_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === `/api/notes/${NOTE.id}` && method === "PATCH") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(updated) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const queryClient = renderDialog();
    await openDialog();

    const slugInput = screen.getByRole("textbox", { name: "Custom link" });
    fireEvent.change(slugInput, { target: { value: "brand-new" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(window.location.pathname).toBe("/notes/brand-new"));
    expect(queryClient.getQueryData<NoteDto>(["note", NOTE.id])?.slug).toBe("brand-new");

    const [, patchInit] = fetchMock.mock.calls.find(
      ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
    ) as [RequestInfo, RequestInit];
    expect(JSON.parse(String(patchInit.body))).toEqual({ slug: "brand-new" });
  });

  it("清除按鈕送出 slug:null", async () => {
    const noteWithSlug: NoteDto = { ...NOTE, slug: "existing-slug" };
    const cleared: NoteDto = { ...noteWithSlug, slug: null };
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === SHARES_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === `/api/notes/${NOTE.id}` && method === "PATCH") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(cleared) }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDialog(noteWithSlug);
    await openDialog();

    fireEvent.click(screen.getByRole("button", { name: "Clear" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
      expect(call).toBeDefined();
      const [, init] = call as [RequestInfo, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({ slug: null });
    });
  });

  it("新增分享送出 PUT {email, role}", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === SHARES_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === SHARES_URL && method === "PUT") {
        return Promise.resolve(
          fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ ...SHARE, role: "editor" }) }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();
    await openDialog();

    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "bob@example.com" } });
    fireEvent.change(screen.getByLabelText("Role for new share"), { target: { value: "editor" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
      expect(call).toBeDefined();
      const [url, init] = call as [RequestInfo, RequestInit];
      expect(String(url)).toBe(SHARES_URL);
      expect(JSON.parse(String(init.body))).toEqual({ email: "bob@example.com", role: "editor" });
    });
  });

  it("新增分享失敗（user_not_found）→ 顯示對應文案", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === SHARES_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) }));
      }
      if (url === SHARES_URL && method === "PUT") {
        return Promise.resolve(
          fakeResponse({
            ok: false,
            status: 404,
            json: () => Promise.resolve({ error: { code: "user_not_found", message: "nope" } }),
          }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();
    await openDialog();

    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "ghost@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() => expect(screen.getByText("We couldn't find that user.")).toBeInTheDocument());
  });

  it("移除分享送出 DELETE /shares/:userId", async () => {
    let listed = [SHARE];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === SHARES_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve(listed) }));
      }
      if (url === `${SHARES_URL}/${SHARE.userId}` && method === "DELETE") {
        listed = [];
        return Promise.resolve(fakeResponse({ ok: true, status: 204 }));
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();
    await openDialog();

    await waitFor(() => expect(screen.getByText(SHARE.email)).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: `Remove ${SHARE.email}` }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "DELETE");
      expect(call).toBeDefined();
      expect(String((call as [RequestInfo, RequestInit])[0])).toBe(`${SHARES_URL}/${SHARE.userId}`);
    });
    await waitFor(() => expect(screen.getByText("No one else has access yet.")).toBeInTheDocument());
  });

  it("改角色送出 PUT {email, role} 至同一支端點", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === SHARES_URL && method === "GET") {
        return Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([SHARE]) }));
      }
      if (url === SHARES_URL && method === "PUT") {
        return Promise.resolve(
          fakeResponse({ ok: true, status: 200, json: () => Promise.resolve({ ...SHARE, role: "editor" }) }),
        );
      }
      throw new Error(`unexpected fetch: ${method} ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    renderDialog();
    await openDialog();

    await waitFor(() => expect(screen.getByText(SHARE.email)).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText(`Role for ${SHARE.email}`), { target: { value: "editor" } });

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
      expect(call).toBeDefined();
      const [, init] = call as [RequestInfo, RequestInit];
      expect(JSON.parse(String(init.body))).toEqual({ email: SHARE.email, role: "editor" });
    });
  });

  it("複製連結：呼叫 navigator.clipboard.writeText 並 toast 確認", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(fakeResponse({ ok: true, status: 200, json: () => Promise.resolve([]) })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });

    renderDialog();
    await openDialog();

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/notes/My-Note-${NOTE.id}`),
    );
    await waitFor(() => expect(screen.getByText("Link copied to clipboard.")).toBeInTheDocument());
  });
});
