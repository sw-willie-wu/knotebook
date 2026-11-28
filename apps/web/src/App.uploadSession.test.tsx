import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import { ThemeProvider } from "@/theme";
import { SESSION_QUERY_KEY } from "@/auth/useSession";
import type { UserDto } from "@knotebook/shared";
import {
  currentUploadUserId,
  getUploadItems,
  notifyUploadSessionExpired,
  putUpload,
  resetUploadQueueForTest,
} from "@/uploads/upload-queue-store";
import { AppRoutes } from "./App";

// A public route needs no session or fetch, so only the wiring under test runs.
vi.mock("./pages/PublicNotePage", () => ({ default: () => <p>public-note-page-stub</p> }));

const TOKEN = "abcDEF123_-".repeat(4).slice(0, 43);

afterEach(() => {
  resetUploadQueueForTest();
  vi.unstubAllGlobals();
});

function renderApp(queryClient: QueryClient) {
  return render(
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[`/p/${TOKEN}`]}>
          <AppRoutes />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

const userOf = (id: string) => ({ id, displayName: id }) as UserDto;
const anItem = () =>
  putUpload({ id: "x", noteId: "n", blockId: "b", fileName: "a.pdf", size: 1, loaded: 0, expectedUrl: "", status: "failed" });

describe("AppRoutes: the queue belongs to the signed-in person", () => {
  it("another account in the same tab clears it", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const queryClient = new QueryClient();
    queryClient.setQueryData(SESSION_QUERY_KEY, userOf("alice"));
    renderApp(queryClient);
    anItem();
    act(() => queryClient.setQueryData(SESSION_QUERY_KEY, userOf("bob")));
    expect(getUploadItems()).toEqual([]);
  });

  it("the session ending (null) clears it", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const queryClient = new QueryClient();
    queryClient.setQueryData(SESSION_QUERY_KEY, userOf("alice"));
    renderApp(queryClient);
    anItem();
    act(() => queryClient.setQueryData(SESSION_QUERY_KEY, null));
    expect(getUploadItems()).toEqual([]);
  });

  it("the same person's session refetched keeps it", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const queryClient = new QueryClient();
    queryClient.setQueryData(SESSION_QUERY_KEY, userOf("alice"));
    renderApp(queryClient);
    anItem();
    act(() => queryClient.setQueryData(SESSION_QUERY_KEY, { ...userOf("alice"), displayName: "Alice" }));
    expect(getUploadItems()).toHaveLength(1);
  });

  it("a failed refetch of the session (network) keeps it", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new TypeError("Failed to fetch"))));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData(SESSION_QUERY_KEY, userOf("alice"));
    renderApp(queryClient);
    anItem();
    await act(async () => {
      await queryClient.refetchQueries({ queryKey: SESSION_QUERY_KEY });
    });
    expect(queryClient.getQueryState(SESSION_QUERY_KEY)?.status).toBe("error");
    expect(getUploadItems()).toHaveLength(1);
  });

  it("a signed-in session appearing after a loading one keeps it", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const queryClient = new QueryClient();
    renderApp(queryClient);
    anItem();
    act(() => queryClient.setQueryData(SESSION_QUERY_KEY, userOf("alice")));
    expect(getUploadItems()).toHaveLength(1);
  });
});

describe("AppRoutes: an upload's 401 reaches the session query", () => {
  it("refetches the session (RequireAuth then confirms and redirects); unmounted, it no longer does", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { unmount } = render(
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <MemoryRouter initialEntries={[`/p/${TOKEN}`]}>
            <AppRoutes />
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );

    notifyUploadSessionExpired();
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: SESSION_QUERY_KEY });

    unmount();
    notifyUploadSessionExpired();
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});

describe("AppRoutes: who the queue's items belong to", () => {
  it("current() reads the cached session without a request; unmounted, the source is gone", () => {
    const fetchMock = vi.fn(() => new Promise(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const queryClient = new QueryClient();
    queryClient.setQueryData(SESSION_QUERY_KEY, userOf("alice"));
    const { unmount } = renderApp(queryClient);
    expect(currentUploadUserId()).toBe("alice");
    expect(fetchMock).not.toHaveBeenCalled();
    unmount();
    expect(currentUploadUserId()).toBeUndefined();
  });
});
