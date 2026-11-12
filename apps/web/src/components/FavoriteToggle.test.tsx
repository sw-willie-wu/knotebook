import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts, Toaster } from "@/components/ui/toast";
import { OWNER_PERMS } from "@/test/fixtures";
import { FavoriteToggle } from "./FavoriteToggle";

const NOTE: NoteDto = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "Alpha",
  ownerId: "u1",
  role: "owner",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "alpha",
  slugIsCustom: true,
  prevSlug: null,
  ownerHandle: "alice",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: OWNER_PERMS,
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const hang = () => new Promise<Response>(() => {});

interface FavServer {
  favorites: string[];
  get: "ok" | "pending";
  put: "ok" | "pending" | 404;
  del: "ok" | "pending" | 429;
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
        if (server.del === 429) return Promise.resolve(jsonResponse({ error: { code: "too_many_requests", message: "slow" } }, 429));
        server.favorites = server.favorites.filter((id) => id !== target);
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      return Promise.resolve(jsonResponse({ error: { code: "not_found", message: "unexpected" } }, 404));
    }),
  );
  return server;
}

const count = (server: FavServer, call: string) => server.calls.filter((c) => c === call).length;

function setup() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <FavoriteToggle note={NOTE} />
      <Toaster />
    </QueryClientProvider>,
  );
  return { queryClient };
}

const star = () => screen.getByRole("button", { name: "Favorite" });
/** 清單到了（鈕不再 disabled）。 */
const ready = () => waitFor(() => expect(star()).not.toBeDisabled());

describe("FavoriteToggle", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("在最愛：可及名稱仍是 Favorite、aria-pressed=true、title 是移出、實心星", async () => {
    stubServer({ favorites: [NOTE.id] });
    setup();
    await waitFor(() => expect(star()).toHaveAttribute("aria-pressed", "true"));
    expect(star()).toHaveAttribute("title", "Remove from favorites");
    expect(star().querySelector("svg")).toHaveAttribute("fill", "currentColor");
  });

  it("不在最愛：aria-pressed=false、title 是加入、空心星", async () => {
    stubServer();
    setup();
    await ready();
    expect(star()).toHaveAttribute("aria-pressed", "false");
    expect(star()).toHaveAttribute("title", "Add to favorites");
    expect(star().querySelector("svg")).toHaveAttribute("fill", "none");
  });

  it("清單還沒到 → disabled、aria-pressed=false", () => {
    stubServer({ get: "pending" });
    setup();
    expect(star()).toBeDisabled();
    expect(star()).toHaveAttribute("aria-pressed", "false");
  });

  it("未加入時點下：樂觀變成 pressed、送 PUT、不開框、不出 toast", async () => {
    const server = stubServer();
    setup();
    await ready();
    fireEvent.click(star());
    await waitFor(() => expect(star()).toHaveAttribute("aria-pressed", "true"));
    expect(count(server, `PUT /api/favorites/${NOTE.id}`)).toBe(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(star()).not.toHaveAttribute("aria-disabled"));
    expect(screen.queryByText("Added to favorites")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("PUT 回 404 → 回到 not pressed、出錯誤 toast", async () => {
    stubServer({ put: 404 });
    setup();
    await ready();
    fireEvent.click(star());
    expect(await screen.findByText("We couldn't find what you were looking for.")).toBeInTheDocument();
    await waitFor(() => expect(star()).toHaveAttribute("aria-pressed", "false"));
  });

  it("已加入時點下：開確認框、還沒送任何請求；Cancel → 沒送、焦點回星號", async () => {
    const server = stubServer({ favorites: [NOTE.id] });
    setup();
    await waitFor(() => expect(star()).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(star());
    const dialog = await screen.findByRole("dialog", { name: "Remove from favorites?" });
    expect(count(server, `DELETE /api/favorites/${NOTE.id}`)).toBe(0);
    expect(dialog).toHaveTextContent(`"${NOTE.title}" will be removed`);
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(count(server, `DELETE /api/favorites/${NOTE.id}`)).toBe(0);
    expect(star()).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(star()).toHaveFocus());
  });

  it("確認移出 → 送 DELETE、成功後 not pressed、框關、沒有 toast、焦點回星號", async () => {
    const server = stubServer({ favorites: [NOTE.id] });
    setup();
    await waitFor(() => expect(star()).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(star());
    const dialog = await screen.findByRole("dialog", { name: "Remove from favorites?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(count(server, `DELETE /api/favorites/${NOTE.id}`)).toBe(1);
    expect(star()).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("Removed from favorites")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    await waitFor(() => expect(star()).toHaveFocus());
  });

  it("DELETE 回 429 → 框關、錯誤 toast、仍是 pressed、焦點回星號", async () => {
    stubServer({ favorites: [NOTE.id], del: 429 });
    setup();
    await waitFor(() => expect(star()).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(star());
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    expect(await screen.findByText("Too many requests. Please slow down.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(star()).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(star()).toHaveFocus());
  });

  it("送出中：aria-disabled=true、沒有 disabled 屬性、焦點仍在星號、連點兩次只送一次", async () => {
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
    expect(count(server, `PUT /api/favorites/${NOTE.id}`)).toBe(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("加入送出中再點（此時已是 pressed）：不開確認框、不送 DELETE", async () => {
    const server = stubServer({ put: "pending" });
    setup();
    await ready();
    fireEvent.click(star());
    await waitFor(() => expect(star()).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(star());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(server.calls.filter((c) => c.startsWith("DELETE"))).toEqual([]);
  });

  it("移出送出中：確認框不關、Esc 無效、DELETE 只送一次、星號是 aria-disabled", async () => {
    const server = stubServer({ favorites: [NOTE.id], del: "pending" });
    setup();
    await waitFor(() => expect(star()).toHaveAttribute("aria-pressed", "true"));
    fireEvent.click(star());
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(count(server, `DELETE /api/favorites/${NOTE.id}`)).toBe(1));
    // 框開著時 Radix 把框外標成 aria-hidden，所以用 hidden 查。
    const hiddenStar = screen.getByRole("button", { name: "Favorite", hidden: true });
    await waitFor(() => expect(hiddenStar).toHaveAttribute("aria-disabled", "true"));
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(count(server, `DELETE /api/favorites/${NOTE.id}`)).toBe(1);
  });

  it("className：shrink-0 與 @max-[18rem]:hidden，沒有獨立的 hidden class", async () => {
    stubServer();
    setup();
    await ready();
    const classes = star().className.split(/\s+/);
    expect(classes).toContain("shrink-0");
    expect(classes).toContain("@max-[18rem]:hidden");
    expect(classes).not.toContain("hidden");
    expect(classes.some((c) => c.startsWith("@min-"))).toBe(false);
  });
});
