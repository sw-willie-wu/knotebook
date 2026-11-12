import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { useFavoriteLookup } from "@/api/favorites";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { personalNote } from "@/test/select-fixtures";
import { RowFavoriteStar } from "./RowFavoriteStar";

const A = personalNote({ id: "note-a", title: "Alpha" });
const B = personalNote({ id: "note-b", title: "Beta" });
const C = personalNote({ id: "note-c", title: "Gamma" });

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const hang = () => new Promise<Response>(() => {});

interface FavServer {
  favorites: string[];
  get: "ok" | "pending" | "error";
  put: "ok" | "pending" | 404;
  del: "ok" | "pending";
  calls: string[];
}

function stubServer(init: Partial<Omit<FavServer, "calls">> = {}): FavServer {
  const server: FavServer = { favorites: [], get: "ok", put: "ok", del: "ok", calls: [], ...init };
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, request?: RequestInit) => {
      const url = String(input);
      const method = (request?.method ?? "GET").toUpperCase();
      server.calls.push(`${method} ${url}`);
      if (url === "/api/favorites" && method === "GET") {
        if (server.get === "pending") return hang();
        if (server.get === "error") return Promise.resolve(jsonResponse({ error: { code: "internal", message: "boom" } }, 500));
        return Promise.resolve(jsonResponse(server.favorites.map((noteId) => ({ noteId, favoritedAt: "2026-03-01T00:00:00.000Z" }))));
      }
      const target = /^\/api\/favorites\/(.+)$/.exec(url)?.[1];
      if (target !== undefined && method === "PUT") {
        if (server.put === "pending") return hang();
        if (server.put === 404) return Promise.resolve(jsonResponse({ error: { code: "not_found", message: "Not found" } }, 404));
        server.favorites = [target, ...server.favorites];
        return Promise.resolve(jsonResponse({ noteId: target, favoritedAt: "2026-03-02T00:00:00.000Z" }));
      }
      if (target !== undefined && method === "DELETE") {
        if (server.del === "pending") return hang();
        server.favorites = server.favorites.filter((id) => id !== target);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(jsonResponse({ error: { code: "not_found", message: "unexpected" } }, 404));
    }),
  );
  return server;
}

const count = (server: FavServer, call: string) => server.calls.filter((c) => c === call).length;

/**
 * 列清單的最小替身：行為與 `NoteList` 相同——一次 `useFavoriteLookup`，未就緒不渲染星星；
 * `onlyFavorites` 時只列最愛（最愛 tab：移出後那一列卸載）。
 */
function Rows({ notes, onlyFavorites = false }: { notes: NoteDto[]; onlyFavorites?: boolean }) {
  const lookup = useFavoriteLookup();
  const shown = onlyFavorites ? notes.filter((n) => lookup.ids.has(n.id)) : notes;
  return (
    <div data-sidebar-instance="">
      <div role="tabpanel" tabIndex={0} aria-label="panel">
        <ul>
          {shown.map((note) => (
            <li key={note.id} data-node-kind="note" data-node-id={note.id} className="group/noterow">
              <a href={`/notes/${note.id}`}>{note.title}</a>
              {lookup.ready && <RowFavoriteStar note={note} favorite={lookup.ids.has(note.id)} pending={lookup.pendingIds.has(note.id)} />}
              <button type="button">menu</button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function setup(notes: NoteDto[] = [A], opts: { onlyFavorites?: boolean } = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <Rows notes={notes} onlyFavorites={opts.onlyFavorites} />
      <Toaster />
    </QueryClientProvider>,
  );
  return { queryClient };
}

const rowOf = (note: NoteDto) => document.querySelector(`[data-node-id="${note.id}"]`) as HTMLElement;
const starOf = (note: NoteDto) => within(rowOf(note)).getByRole("button", { name: "Favorite" });
const star = () => starOf(A);
/** 清單到了（星星才會渲染）。 */
const ready = () => waitFor(() => expect(star()).toBeInTheDocument());

describe("RowFavoriteStar", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("在最愛：名稱固定 Favorite、aria-pressed=true、title 是移出、實心星、沒有浮出 class", async () => {
    stubServer({ favorites: [A.id] });
    setup();
    await waitFor(() => expect(star()).toHaveAttribute("aria-pressed", "true"));
    expect(star()).toHaveAttribute("title", "Remove from favorites");
    expect(star().querySelector("svg")).toHaveAttribute("fill", "currentColor");
    expect(star().className).not.toContain("opacity-0");
    expect(star().className).not.toContain("hidden");
    expect(star().className).toContain("text-brand");
  });

  it("不在最愛：名稱仍是 Favorite、aria-pressed=false、title 是加入、空心星、帶浮出 class（觸控隱藏）", async () => {
    stubServer();
    setup();
    await ready();
    expect(star()).toHaveAttribute("aria-pressed", "false");
    expect(star()).toHaveAttribute("title", "Add to favorites");
    expect(star().querySelector("svg")).toHaveAttribute("fill", "none");
    const classes = star().className.split(/\s+/);
    expect(classes).toContain("opacity-0");
    expect(classes).toContain("[@media(hover:none)]:hidden");
    expect(classes).toContain("[@media(pointer:coarse)]:hidden");
    expect(classes).toContain("group-hover/noterow:opacity-100");
  });

  it("24px 圖示鈕、不加 aria-describedby、原生 button", async () => {
    stubServer();
    setup();
    await ready();
    expect(star().tagName).toBe("BUTTON");
    expect(star()).toHaveAttribute("type", "button");
    expect(star().className).toContain("h-6");
    expect(star().className).toContain("w-6");
    expect(star().className).toContain("shrink-0");
    expect(star()).not.toHaveAttribute("aria-describedby");
  });

  it("清單還沒到或讀取失敗 → 不渲染星星", async () => {
    stubServer({ get: "pending" });
    setup();
    expect(screen.queryByRole("button", { name: "Favorite" })).toBeNull();
    cleanup();
    stubServer({ get: "error" });
    setup();
    await waitFor(() => expect(screen.getByRole("link", { name: "Alpha" })).toBeInTheDocument());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.queryByRole("button", { name: "Favorite" })).toBeNull();
  });

  it("未加入時點下：樂觀變成 pressed、PUT 一次、不開框、不出 toast", async () => {
    const server = stubServer();
    setup();
    await ready();
    fireEvent.click(star());
    await waitFor(() => expect(star()).toHaveAttribute("aria-pressed", "true"));
    expect(count(server, `PUT /api/favorites/${A.id}`)).toBe(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(star()).not.toHaveAttribute("aria-disabled"));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("PUT 失敗 → 出錯誤 toast、回到 not pressed", async () => {
    stubServer({ put: 404 });
    setup();
    await ready();
    fireEvent.click(star());
    expect(await screen.findByText("We couldn't find what you were looking for.")).toBeInTheDocument();
    await waitFor(() => expect(star()).toHaveAttribute("aria-pressed", "false"));
  });

  it("已加入時點下：開確認框、尚無 DELETE；Cancel 與 Esc 都沒送、焦點回星星", async () => {
    const server = stubServer({ favorites: [A.id] });
    setup();
    await waitFor(() => expect(star()).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(star());
    const dialog = await screen.findByRole("dialog", { name: "Remove from favorites?" });
    expect(count(server, `DELETE /api/favorites/${A.id}`)).toBe(0);
    expect(dialog).toHaveTextContent(`"${A.title}" will be removed`);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(star()).toHaveFocus());

    fireEvent.click(star());
    const again = await screen.findByRole("dialog");
    fireEvent.keyDown(again, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(star()).toHaveFocus());
    expect(count(server, `DELETE /api/favorites/${A.id}`)).toBe(0);
    expect(star()).toHaveAttribute("aria-pressed", "true");
  });

  it("確認移出（星星還在的 tab）→ DELETE 一次、not pressed、沒有 toast、焦點回星星", async () => {
    const server = stubServer({ favorites: [A.id] });
    setup();
    await waitFor(() => expect(star()).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(star());
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(count(server, `DELETE /api/favorites/${A.id}`)).toBe(1);
    expect(star()).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByRole("status")).toBeNull();
    await waitFor(() => expect(star()).toHaveFocus());
  });

  it("最愛 tab：列卸載後焦點落到下一列的連結；沒有下一列 → 上一列；只剩一列 → tabpanel", async () => {
    stubServer({ favorites: [A.id, B.id, C.id] });
    setup([A, B, C], { onlyFavorites: true });
    await waitFor(() => expect(starOf(B)).toBeInTheDocument());

    fireEvent.click(starOf(B));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(rowOf(B)).toBeNull());
    await waitFor(() => expect(within(rowOf(C)).getByRole("link", { name: "Gamma" })).toHaveFocus());

    fireEvent.click(starOf(C));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(rowOf(C)).toBeNull());
    await waitFor(() => expect(within(rowOf(A)).getByRole("link", { name: "Alpha" })).toHaveFocus());

    fireEvent.click(starOf(A));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(rowOf(A)).toBeNull());
    await waitFor(() => expect(screen.getByRole("tabpanel")).toHaveFocus());
  });

  it("送出中：aria-disabled=true、沒有 disabled 屬性、焦點仍在星星、連點只送一次", async () => {
    const server = stubServer({ put: "pending" });
    setup();
    await ready();
    star().focus();
    fireEvent.click(star());
    await waitFor(() => expect(star()).toHaveAttribute("aria-disabled", "true"));
    expect(star()).not.toHaveAttribute("disabled");
    expect(star()).toHaveFocus();
    fireEvent.click(star());
    fireEvent.click(star());
    expect(count(server, `PUT /api/favorites/${A.id}`)).toBe(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(server.calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
  });

  it("同一份清單裡只有送出中的那一篇是 aria-disabled", async () => {
    stubServer({ put: "pending" });
    setup([A, B]);
    await waitFor(() => expect(starOf(A)).toBeInTheDocument());
    fireEvent.click(starOf(A));
    await waitFor(() => expect(starOf(A)).toHaveAttribute("aria-disabled", "true"));
    expect(starOf(B)).not.toHaveAttribute("aria-disabled");
  });
});
