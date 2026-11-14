import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { AppErrorBoundary } from "@/components/ErrorBoundary";
import { groupDto, memberRole, OWNER_PERMS } from "@/test/fixtures";
import { indexFolders } from "@/components/sidebar/folder-index";
import { NoteMenu } from "@/components/NoteMenu";
import type { DestinationPick } from "@/components/share/GroupTransfer";

// 移動／複製確認框的 lazy chunk 載入失敗：只在原位顯示 inline 錯誤，⋮ 鈕與整個 app 不崩。
// `vi.mock` 整檔生效，所以獨立成檔（照 NoteList.folder-lazy-error.test.tsx）。選單項換成一顆按鈕直接餵 pick（照 NoteMenu.pick.test.tsx）。
vi.mock("@/components/share/GroupTransferDialog", () =>
  Promise.reject(new TypeError("Failed to fetch dynamically imported module: http://localhost/assets/GroupTransferDialog-abc.js")),
);

const GROUP = groupDto({ id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", name: "Known" }, memberRole());
const PICK: DestinationPick = {
  kind: "move",
  target: { kind: "place", space: { kind: "group", groupId: GROUP.id, name: "Known" }, folder: null },
  groups: [GROUP],
  index: indexFolders([]),
};

vi.mock("@/components/share/GroupTransfer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/components/share/GroupTransfer")>();
  return {
    ...actual,
    GroupTransferMenuItems: ({ onPick }: { onPick: (pick: DestinationPick) => void }) => (
      <button type="button" onClick={() => onPick(PICK)}>
        fake-pick
      </button>
    ),
  };
});

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
  folderId: null,
  permissions: { ...OWNER_PERMS },
};

describe("NoteMenu — 移動／複製確認框 chunk 載入失敗", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    sessionStorage.clear();
    sessionStorage.setItem("knotebook:chunk-reload:transferDialog", "1");
    vi.stubGlobal("location", { ...window.location, reload: vi.fn() });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }))));
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    sessionStorage.clear();
  });

  it("選定群組後出現 inline 錯誤，⋮ 鈕還在、app 沒崩", async () => {
    render(
      <AppErrorBoundary reload={vi.fn()}>
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <MemoryRouter>
            <NoteMenu note={NOTE} state={{ phase: "connected", role: "owner" }} leavingRef={{ current: false }} onOpenEdits={() => {}} />
          </MemoryRouter>
        </QueryClientProvider>
      </AppErrorBoundary>,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "More" }), { button: 0 });
    fireEvent.click(await screen.findByRole("button", { name: "fake-pick" }));
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(i18n.t("app.chunkLoadError"));
    expect(screen.getByRole("button", { name: "More", hidden: true })).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).toBeNull();
  });
});
