import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import type { GroupDto, NoteDto, ShareDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { groupDto, memberRole, OWNER_PERMS, EDITOR_PERMS } from "@/test/fixtures";
import { MoveToGroupSection } from "./MoveToGroupSection";

// 同 ShareDialog.test.tsx 的約定：mock 全域 fetch，讓真正的 react-query hook 打到假回應。

function fakeResponse({ ok, status, json }: { ok: boolean; status: number; json?: () => Promise<unknown> }): Response {
  return { ok, status, json: json ?? (() => Promise.reject(new Error("no body"))) } as unknown as Response;
}
const okJson = (body: unknown, status = 200) => fakeResponse({ ok: true, status, json: () => Promise.resolve(body) });
const failJson = (status: number, code: string) =>
  fakeResponse({ ok: false, status, json: () => Promise.resolve({ error: { code, message: "x" } }) });

const NOTE: NoteDto = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "My Note",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "my-note",
  slugIsCustom: false,
  prevSlug: null,
  ownerHandle: "tester",
  lastEdited: null,
  groupId: null,
  group: null,
  permissions: { ...OWNER_PERMS },
};

const GA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const GB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const GROUP_A = groupDto({ id: GA, name: "Workshop A" }, memberRole());
/** 成員但角色沒有新建旗標——不得出現在候選裡。 */
const GROUP_B = groupDto(
  { id: GB, name: "Readers" },
  memberRole({ permissions: { ...memberRole().permissions, create: false, edit: false } }),
);

const BOB: ShareDto = { userId: "22222222-2222-2222-2222-222222222222", email: "bob@example.com", displayName: "Bob", role: "viewer" };
const CAROL: ShareDto = { userId: "33333333-3333-3333-3333-333333333333", email: "carol@example.com", displayName: "Carol", role: "editor" };
const TOKEN = "T".repeat(43);

const BASE = `/api/notes/${NOTE.id}`;
const URLS = {
  groups: "/api/groups",
  shares: `${BASE}/shares`,
  link: `${BASE}/public-link`,
  note: BASE,
  move: `${BASE}/move`,
  copy: `${BASE}/copy`,
};

const MOVED: NoteDto = {
  ...NOTE,
  ownerId: null,
  ownerHandle: null,
  role: "editor",
  groupId: GA,
  group: { id: GA, name: "Workshop A" },
  permissions: { ...EDITOR_PERMS },
};
const COPY: NoteDto = { ...MOVED, id: "44444444-4444-4444-4444-444444444444", title: "My Note", slug: "my-note-2" };

interface Server {
  groups: GroupDto[] | "error";
  shares: ShareDto[];
  token: string | null;
  latest: NoteDto;
  /** 這些 URL 的 GET 懸置，直到測試呼叫 `release(url, response)`。 */
  pending: Set<string>;
  /** 回傳懸置的 promise＝送出掛著。 */
  move?: () => Response | Promise<Response>;
  copy?: () => Response | Promise<Response>;
}

function stub(init: Partial<Server> = {}) {
  const server: Server = {
    groups: [GROUP_A],
    shares: [],
    token: null,
    latest: NOTE,
    pending: new Set(),
    ...init,
  };
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const waiting = new Map<string, (r: Response) => void>();
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, reqInit?: RequestInit) => {
      const url = String(input);
      const method = (reqInit?.method ?? "GET").toUpperCase();
      calls.push({ method, url, body: reqInit?.body === undefined ? undefined : JSON.parse(String(reqInit.body)) });
      if (method === "GET" && server.pending.has(url)) {
        return new Promise<Response>((resolve) => waiting.set(url, resolve));
      }
      if (method === "GET" && url === URLS.groups) {
        return Promise.resolve(server.groups === "error" ? failJson(500, "internal") : okJson(server.groups));
      }
      if (method === "GET" && url === URLS.shares) return Promise.resolve(okJson([...server.shares]));
      if (method === "GET" && url === URLS.link) return Promise.resolve(okJson({ token: server.token, slug: null }));
      if (method === "GET" && url === URLS.note) return Promise.resolve(okJson(server.latest));
      if (method === "POST" && url === URLS.move) return Promise.resolve(server.move ? server.move() : okJson(MOVED));
      if (method === "POST" && url === URLS.copy) {
        return Promise.resolve(server.copy ? server.copy() : okJson(COPY, 201));
      }
      return Promise.reject(new Error(`unexpected fetch: ${method} ${url}`));
    }),
  );
  return {
    server,
    calls,
    release(url: string, response: Response) {
      server.pending.delete(url);
      waiting.get(url)?.(response);
    },
  };
}

function renderSection(note: NoteDto = NOTE) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/notes/${note.id}`]}>
        <Routes>
          <Route path="/notes/:id" element={<MoveToGroupSection note={note} />} />
          <Route path="/g/:groupId/:slug" element={<p>copy page</p>} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return queryClient;
}

/** 本區塊的訊息節點（Radix toast 也會長出 `role="status"`，所以以 data 屬性鎖定本元件那一個）。 */
function messages(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-move-messages]');
  if (!el) throw new Error("messages node missing");
  return el;
}

/** 整列隱藏且沒有訊息時：section 是 `sr-only`（不佔版面、但仍在無障礙樹裡，之後長出的訊息照樣播報），不是
 * `hidden`（display:none 會把 live region 拿出無障礙樹）。斷言 class 而不是 `toBeVisible()`：jsdom 不套 Tailwind，
 * 兩個 class 在這裡算出來的 display 一樣（實測：連 import index.css 也分不出），`toBeVisible()` 守不住。 */
function expectHiddenButAnnounced(): void {
  const section = messages().closest("section");
  expect(section).toHaveClass("sr-only");
  expect(section).not.toHaveClass("hidden");
}

async function readyCombobox(): Promise<HTMLSelectElement> {
  const select = (await screen.findByRole("combobox", { name: "Group" })) as HTMLSelectElement;
  await waitFor(() => expect(select).not.toBeDisabled());
  return select;
}

async function chooseGroupA(): Promise<HTMLSelectElement> {
  const select = await readyCombobox();
  fireEvent.change(select, { target: { value: GA } });
  return select;
}

describe("MoveToGroupSection（#175 PR2）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    act(() => dismissAllToasts());
    vi.unstubAllGlobals();
  });

  it("⑤ 群組清單載入中、錯誤、或沒有能新建的群組 → 整列不渲染；訊息節點仍在", async () => {
    // 載入中
    const s1 = stub({ pending: new Set([URLS.groups]) });
    renderSection();
    await waitFor(() => expect(s1.calls).toContainEqual({ method: "GET", url: URLS.groups, body: undefined }));
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Move" })).toBeNull();
    expect(messages()).toHaveAttribute("role", "status");
    expectHiddenButAnnounced();
    cleanup();
    vi.unstubAllGlobals();

    // 錯誤（從沒成功過）
    stub({ groups: "error" });
    const qc2 = renderSection();
    await waitFor(() => expect(qc2.getQueryState(["groups"])?.status).toBe("error"));
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(messages()).toHaveAttribute("role", "status");
    expectHiddenButAnnounced();
    cleanup();
    vi.unstubAllGlobals();

    // 有群組、但沒有一個角色能新建
    stub({ groups: [GROUP_B] });
    const qc3 = renderSection();
    await waitFor(() => expect(qc3.getQueryState(["groups"])?.status).toBe("success"));
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByText("Move or copy into a group")).toBeNull();
    expect(messages()).toHaveAttribute("role", "status");
    expectHiddenButAnnounced();
  });

  it("候選只列 myRole.permissions.create 為真的群組", async () => {
    stub({ groups: [GROUP_A, GROUP_B] });
    renderSection();
    const select = await readyCombobox();
    const options = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Choose a group…", "Workshop A"]);
  });

  it("shares 或 public-link 尚未成功之前下拉 disabled", async () => {
    for (const url of [URLS.shares, URLS.link]) {
      const s = stub({ pending: new Set([url]) });
      renderSection();
      const select = await screen.findByRole("combobox", { name: "Group" });
      // 群組清單已到、另一支也到了，只差懸置的那一支。
      await waitFor(() => expect(s.calls.some((c) => c.url === url)).toBe(true));
      await waitFor(() => expect(within(select).getAllByRole("option")).toHaveLength(2));
      expect(select).toBeDisabled();
      s.release(url, url === URLS.shares ? okJson([]) : okJson({ token: null, slug: null }));
      await waitFor(() => expect(select).not.toBeDisabled());
      cleanup();
      vi.unstubAllGlobals();
    }
  });

  it("③ 移動確認：列出被移除的人名、有 token 時提到公開連結關閉、提到網址與擁有權；提交鈕是 destructive 變體", async () => {
    stub({ shares: [BOB, CAROL], token: TOKEN });
    renderSection();
    await chooseGroupA();
    fireEvent.click(screen.getByRole("button", { name: "Move" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent('Move this note into "Workshop A"?');
    expect(alert).toHaveTextContent("Per-person sharing with 2 people is removed: Bob and Carol. Anyone not in the group loses access.");
    expect(alert).toHaveTextContent("Its public link will be turned off.");
    expect(alert).toHaveTextContent("Its address changes to /g/…");
    expect(alert).toHaveTextContent("You will no longer own it");
    const submit = within(alert).getByRole("button", { name: "Move into group" });
    expect(submit).toHaveClass("bg-destructive");
  });

  it("③ 沒有逐人分享、沒有 token → 不提被移除的人與公開連結（仍提網址與擁有權）", async () => {
    stub({ shares: [], token: null });
    renderSection();
    await chooseGroupA();
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    const alert = await screen.findByRole("alert");
    expect(alert).not.toHaveTextContent("Per-person sharing");
    expect(alert).not.toHaveTextContent("public link");
    expect(alert).toHaveTextContent("Its address changes to /g/…");
    expect(alert).toHaveTextContent("You will no longer own it");
  });

  it("③ 取消 → 確認框消失、焦點回群組下拉", async () => {
    stub();
    renderSection();
    const select = await chooseGroupA();
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    const alert = await screen.findByRole("alert");
    const cancel = within(alert).getByRole("button", { name: "Cancel" });
    cancel.focus();
    fireEvent.click(cancel);

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    await waitFor(() => expect(select).toHaveFocus());
  });

  it("送出前檢查不過（重讀到群組筆記）→ 不發 /move、發 changedElsewhere toast（不寫進本元件的訊息節點）", async () => {
    const s = stub();
    renderSection();
    await chooseGroupA();
    s.server.latest = MOVED;
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Move into group" }));

    expect(await screen.findByText("This note was changed elsewhere, so nothing was moved.")).toBeInTheDocument();
    // 提示走 toast：在 ShareDialog 裡本元件此時會被卸載（換群組版），元件內的節點看不到——見 ShareDialog.test 的整合案。
    expect(messages()).toBeEmptyDOMElement();
    expect(s.calls.filter((c) => c.url === URLS.move)).toEqual([]);
    expect(s.calls).toContainEqual({ method: "GET", url: URLS.note, body: undefined });
  });

  it("④ 移動失敗 409、群組清單重抓後變空（整列隱藏）→ 錯誤留在同一個訊息節點（未重建）", async () => {
    const s = stub({
      move: () => {
        // 失敗的對帳（refetchAfterFailure）會失效 ['groups']：這時群組已在別處刪光，重抓回來整列該隱藏。
        s.server.groups = [];
        return failJson(409, "conflict");
      },
    });
    const qc = renderSection();
    await chooseGroupA();
    const before = messages();
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Move into group" }));

    await waitFor(() =>
      expect(messages()).toHaveTextContent("Something changed while you were doing that. Reload and try again."),
    );
    await waitFor(() => expect(qc.getQueryData(["groups"])).toEqual([]));
    await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
    expect(messages()).toBe(before);
    expect(within(messages()).getByRole("alert")).toHaveTextContent("Something changed while you were doing that.");
    // 有訊息時 section 不再是 sr-only（看得見）。
    expect(messages().closest("section")).not.toHaveClass("sr-only");
    expect(messages().closest("section")).not.toHaveClass("hidden");
  });

  it("移動成功 → 先重讀筆記、再 POST /move 帶 { groupId }", async () => {
    const s = stub();
    renderSection();
    await chooseGroupA();
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Move into group" }));

    await waitFor(() => expect(s.calls.some((c) => c.url === URLS.move)).toBe(true));
    const noteRead = s.calls.findIndex((c) => c.method === "GET" && c.url === URLS.note);
    const moveCall = s.calls.findIndex((c) => c.method === "POST" && c.url === URLS.move);
    expect(noteRead).toBeGreaterThanOrEqual(0);
    expect(moveCall).toBeGreaterThan(noteRead);
    expect(s.calls[moveCall].body).toEqual({ groupId: GA });
  });

  it("移動失敗 409 → 顯示 errors.conflict、確認框收起、焦點回下拉", async () => {
    stub({ move: () => failJson(409, "conflict") });
    renderSection();
    const select = await chooseGroupA();
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Move into group" }));

    const err = await within(messages()).findByRole("alert");
    expect(err).toHaveTextContent("Something changed while you were doing that. Reload and try again.");
    expect(screen.queryByRole("button", { name: "Move into group" })).toBeNull();
    await waitFor(() => expect(select).toHaveFocus());
  });

  it("複製確認是 outline 提交鈕；成功 → toast「已複製到〈群組〉」附「前往副本」（帶 altText），點了導到副本的 /g/ 網址", async () => {
    const s = stub();
    renderSection();
    const select = await chooseGroupA();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent('This creates a copy in "Workshop A"; the original stays as it is.');
    const submit = within(alert).getByRole("button", { name: "Copy into group" });
    expect(submit).not.toHaveClass("bg-destructive");
    expect(submit).toHaveClass("border-input", "bg-transparent");
    fireEvent.click(submit);

    await waitFor(() => expect(s.calls.some((c) => c.url === URLS.copy)).toBe(true));
    expect(s.calls.find((c) => c.url === URLS.copy)?.body).toEqual({ groupId: GA });
    expect(await screen.findByText('Copied into "Workshop A"')).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy into group" })).toBeNull();
    await waitFor(() => expect(select).toHaveFocus());
    expect(
      document.querySelector('[data-radix-toast-announce-alt="You can also open the copy from the sidebar."]'),
    ).not.toBeNull();
    // 複製不是移動：不重讀筆記、不發 /move。
    expect(s.calls.filter((c) => c.url === URLS.move || (c.method === "GET" && c.url === URLS.note))).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Open copy" }));
    expect(await screen.findByText("copy page")).toBeInTheDocument();
  });

  it("移動送出掛著時（送出前檢查中、POST 掛著）再按提交鈕 → 鈕停用、POST /move 仍只 1 次", async () => {
    const s = stub({ move: () => new Promise<Response>(() => {}) });
    renderSection();
    await chooseGroupA();
    fireEvent.click(screen.getByRole("button", { name: "Move" }));
    const submit = within(await screen.findByRole("alert")).getByRole("button", { name: "Move into group" });
    fireEvent.click(submit);
    fireEvent.click(submit); // 送出前檢查還在飛
    await waitFor(() => expect(s.calls.filter((c) => c.url === URLS.move)).toHaveLength(1));
    expect(submit).toBeDisabled();
    fireEvent.click(submit); // POST 掛著
    await act(async () => {});
    expect(s.calls.filter((c) => c.url === URLS.move)).toHaveLength(1);
    expect(s.calls.filter((c) => c.method === "GET" && c.url === URLS.note)).toHaveLength(1);
  });

  // 守的是 `busy` 涵蓋複製（`busy` 只看 `move.isPending` 時紅）；拿掉 `submitting` 這案仍綠——見元件裡那段註解的窗口②。
  it("複製送出掛著時再按提交鈕 → 鈕停用、POST /copy 仍只 1 次", async () => {
    const s = stub({ copy: () => new Promise<Response>(() => {}) });
    renderSection();
    await chooseGroupA();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    const submit = within(await screen.findByRole("alert")).getByRole("button", { name: "Copy into group" });
    fireEvent.click(submit);
    fireEvent.click(submit);
    await waitFor(() => expect(s.calls.filter((c) => c.url === URLS.copy)).toHaveLength(1));
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    await act(async () => {});
    expect(s.calls.filter((c) => c.url === URLS.copy)).toHaveLength(1);
  });

  it("複製失敗 → 錯誤訊息、確認框收起", async () => {
    stub({ copy: () => failJson(404, "group_not_found") });
    renderSection();
    await chooseGroupA();
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    fireEvent.click(within(await screen.findByRole("alert")).getByRole("button", { name: "Copy into group" }));
    expect(await within(messages()).findByRole("alert")).toHaveTextContent("We couldn't find that group.");
    expect(screen.queryByRole("button", { name: "Copy into group" })).toBeNull();
  });
});
