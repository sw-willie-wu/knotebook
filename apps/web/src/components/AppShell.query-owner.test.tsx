import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { NoteDto, UserDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { SESSION_QUERY_KEY } from "@/auth/useSession";
import { ActiveNoteProvider } from "@/lib/active-note";
import { SidebarQueryProvider } from "@/lib/sidebar-query";
import { ThemeProvider } from "@/theme";
import { dismissAllToasts } from "@/components/ui/toast";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { AppShell } from "./AppShell";

/**
 * #369：側欄搜尋字住在 App 層（跨首頁／筆記頁換殼保留），所以它屬於某個使用者——登出、換人登入後不能留給下一個人
 * （否則 B 的首頁搜尋框帶著 A 的字、還以 B 的身分送 body search）。AppShell 掛載且 session 有人時 `claim(user.id)`。
 */
const user = (id: string) => ({ id, email: `${id}@example.com`, handle: id, displayName: id, isAdmin: false, mustChangePassword: false, hasPassword: true, autoVersions: true }) as UserDto;
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const NOTES: NoteDto[] = [];

let gate: (show: boolean) => void = () => {};
function Harness() {
  const [show, setShow] = useState(true);
  gate = setShow;
  return show ? <AppShell>{null}</AppShell> : null;
}
const box = () => screen.getAllByRole("textbox", { name: "Search notes" })[0] as HTMLInputElement;

describe("搜尋字的擁有者（#369）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/auth/me") return Promise.resolve(json(user("u1")));
        if (url === "/api/groups") return Promise.resolve(json([]));
        if (url === "/api/folders") return Promise.resolve(json(FOLDER_LIST_EMPTY));
        if (url === "/api/notes") return Promise.resolve(json(NOTES));
        if (url.startsWith("/api/search?")) return Promise.resolve(json({ hits: [], nextCursor: null }));
        throw new Error(`unexpected fetch: ${url}`);
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  function setup() {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <ThemeProvider>
          <MemoryRouter>
            <ActiveNoteProvider>
              <SidebarQueryProvider>
                <Harness />
              </SidebarQueryProvider>
            </ActiveNoteProvider>
          </MemoryRouter>
        </ThemeProvider>
      </QueryClientProvider>,
    );
    return qc;
  }

  it("換人登入（登出 → B 登入，同一個分頁）→ B 的搜尋框是空的", async () => {
    const qc = setup();
    await waitFor(() => expect(qc.getQueryData(SESSION_QUERY_KEY)).toEqual(user("u1")));
    fireEvent.change(box(), { target: { value: "needle" } });
    expect(box().value).toBe("needle");
    act(() => gate(false)); // 離開有側欄的頁（登出導到 /login）
    act(() => void qc.setQueryData(SESSION_QUERY_KEY, null));
    act(() => void qc.setQueryData(SESSION_QUERY_KEY, user("u2"))); // B 登入
    act(() => gate(true));
    await waitFor(() => expect(box().value).toBe(""));
  });

  it("同一個人的 session 刷新（新物件、同 id）或回到有側欄的頁 → 搜尋字不清", async () => {
    const qc = setup();
    await waitFor(() => expect(qc.getQueryData(SESSION_QUERY_KEY)).toEqual(user("u1")));
    fireEvent.change(box(), { target: { value: "needle" } });
    act(() => void qc.setQueryData(SESSION_QUERY_KEY, { ...user("u1"), displayName: "renamed" }));
    expect(box().value).toBe("needle");
    act(() => gate(false));
    act(() => gate(true));
    await waitFor(() => expect(box().value).toBe("needle"));
  });
});
