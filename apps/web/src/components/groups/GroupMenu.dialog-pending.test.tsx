import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import i18n from "@/i18n";
import { adminRole, groupDto } from "@/test/fixtures";
import { FOLDER_LIST_EMPTY } from "@/test/folder-fixtures";
import { GroupMenu } from "./GroupMenu";

// 改名對話框的 chunk 還沒到時，使用者又選了刪除：最後只該剩刪除對話框（一次只開一個）。
// 改名 chunk 卡在手動放行的 promise 上；vi.mock 整檔生效，所以獨立成檔。
const gate = vi.hoisted(() => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
});
vi.mock("./GroupNameDialog", async (importOriginal) => {
  await gate.promise;
  return importOriginal();
});

const GROUP = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Workshop A" }, adminRole());

describe("GroupMenu — 對話框一次只開一個", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/api/folders") return json(FOLDER_LIST_EMPTY);
        if (url === "/api/notes") return json([]);
        if (url.endsWith("/members")) return json([{ userId: "u-me", email: "me@example.com", displayName: "Me", roleId: "r-admin", builtin: "admin", avatar: null }]);
        return Promise.resolve(new Response("{}", { status: 500 }));
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("改名 chunk 還沒到就選刪除 → 只剩刪除對話框，放行後改名也不會冒出來", async () => {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <GroupMenu group={GROUP} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    const open = async () => {
      fireEvent.pointerDown(screen.getByRole("button", { name: "Group actions for Workshop A" }), { button: 0 });
      return screen.findByRole("menu");
    };
    fireEvent.click(within(await open()).getByRole("menuitem", { name: "Rename" }));
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    fireEvent.click(within(await open()).getByRole("menuitem", { name: "Delete group" }));
    expect(await screen.findByRole("dialog", { name: "Delete group?" })).toBeInTheDocument();
    gate.release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByRole("dialog", { name: "Rename group" })).toBeNull();
    expect(screen.getByRole("dialog", { name: "Delete group?" })).toBeInTheDocument();
  });
});
