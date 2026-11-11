import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { SidebarTabProvider, useSidebarTabState } from "@/lib/sidebar-tab";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import * as toastModule from "@/components/ui/toast";
import { OWNER_PERMS } from "@/test/fixtures";
import { InTrashCard } from "./InTrashCard";

// 筆記頁「在垃圾桶裡」卡片（IC-T*）。接進 NotePage 的部分在 NotePage.test.tsx。

afterEach(() => {
  localStorage.clear();
});

const NOTE_ID = "n1";

const RESTORED: NoteDto = {
  id: NOTE_ID,
  title: "Trashed",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "trashed",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  group: null,
  groupId: null,
  permissions: OWNER_PERMS,
  folderId: null,
};

function fakeResponse(body: unknown, status = 200): Response {
  return { ok: status < 400, status, json: () => Promise.resolve(body) } as unknown as Response;
}

/** `POST /api/trash/restore` 的回應；`hold` 有給時等它 resolve 才回（測送出中的狀態）。 */
function stubRestore(reply: { status: number; body: unknown }, hold?: Promise<void>) {
  const posts: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (url === "/api/trash/restore" && method === "POST") {
        posts.push(JSON.parse(String(init?.body)));
        const make = () => fakeResponse(reply.body, reply.status);
        return hold ? hold.then(make) : Promise.resolve(make());
      }
      // 還原後 invalidateTrashRelated 失效的 key 都沒有掛載的 observer，不會打請求；打了就是意外。
      throw new Error(`unexpected fetch: ${method} ${url}`);
    }),
  );
  return { posts };
}

function TabProbe() {
  const { tab } = useSidebarTabState();
  return <span data-testid="tab-probe">{tab}</span>;
}

function renderCard() {
  const onRestored = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <SidebarTabProvider>
        <InTrashCard noteId={NOTE_ID} onRestored={onRestored} />
        <TabProbe />
      </SidebarTabProvider>
      <Toaster />
    </QueryClientProvider>,
  );
  return { onRestored };
}

/** Radix Toast Root（`<li>`）——variant 的 class 掛在它身上。 */
function toastRoot(title: string): HTMLElement {
  return screen.getByText(title, { exact: true }).closest("li") as HTMLElement;
}

const restoreButton = () => screen.getByRole("button", { name: "Restore" });

describe("InTrashCard", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("IC-T1 標題與兩顆鈕", () => {
    stubRestore({ status: 200, body: { restored: [], skipped: [] } });
    renderCard();
    expect(screen.getByRole("heading", { level: 2, name: "This note is in the trash" })).toBeInTheDocument();
    expect(restoreButton()).toBeEnabled();
    expect(screen.getByRole("button", { name: "Go to trash" })).toBeEnabled();
  });

  it("IC-T2 還原成功：送 {ids:[n1]}、onRestored 一次、沒有 toast", async () => {
    const { posts } = stubRestore({ status: 200, body: { restored: [RESTORED], skipped: [] } });
    const toastSpy = vi.spyOn(toastModule, "toast");
    onTestFinished(() => toastSpy.mockRestore());
    const { onRestored } = renderCard();

    fireEvent.click(restoreButton());

    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    expect(posts).toEqual([{ ids: [NOTE_ID] }]);
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("IC-T2b 送出中「還原」disabled，回來後恢復", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    stubRestore({ status: 200, body: { restored: [RESTORED], skipped: [] } }, hold);
    const { onRestored } = renderCard();

    fireEvent.click(restoreButton());
    await waitFor(() => expect(restoreButton()).toBeDisabled());
    expect(onRestored).not.toHaveBeenCalled();

    release();
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(restoreButton()).toBeEnabled());
  });

  it("IC-T3 全略過：toast 結果句（destructive），onRestored 仍呼叫（重抓）", async () => {
    stubRestore({ status: 200, body: { restored: [], skipped: [{ id: NOTE_ID, reason: "not_in_trash" }] } });
    const { onRestored } = renderCard();

    fireEvent.click(restoreButton());

    const title = "Restored 0 notes, 1 no longer in the trash";
    expect(await screen.findByText(title, { exact: true })).toBeInTheDocument();
    expect(toastRoot(title)).toHaveClass("bg-destructive");
    await waitFor(() => expect(onRestored).toHaveBeenCalledTimes(1));
  });

  it("IC-T4 失敗（500）：錯誤 toast、onRestored 不呼叫、按鈕恢復可按", async () => {
    stubRestore({ status: 500, body: { error: { code: "internal", message: "x" } } });
    const { onRestored } = renderCard();

    fireEvent.click(restoreButton());

    const title = "Something went wrong. Please try again.";
    expect(await screen.findByText(title, { exact: true })).toBeInTheDocument();
    expect(toastRoot(title)).toHaveClass("bg-destructive");
    await waitFor(() => expect(restoreButton()).toBeEnabled());
    expect(onRestored).not.toHaveBeenCalled();
  });

  it("IC-T5 前往垃圾桶：經 actions 的 showTab——localStorage 與同一 provider 的 state 都是 trash", async () => {
    stubRestore({ status: 200, body: { restored: [], skipped: [] } });
    renderCard();
    expect(screen.getByTestId("tab-probe")).toHaveTextContent("myNotes");

    fireEvent.click(screen.getByRole("button", { name: "Go to trash" }));

    expect(localStorage.getItem("sidebar.tab")).toBe("trash");
    await waitFor(() => expect(screen.getByTestId("tab-probe")).toHaveTextContent("trash"));
  });
});
