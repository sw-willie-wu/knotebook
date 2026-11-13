import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { FolderDto, GroupDto, NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { PhoneBrowseContext } from "@/lib/phone-list";
import { adminRole, customRole, groupDto, memberRole, OWNER_PERMS } from "@/test/fixtures";
import { folderDto, groupFolder } from "@/test/folder-fixtures";
import { NoteBrowseBar } from "./NoteBrowseBar";

const data = vi.hoisted(() => ({ folders: [] as unknown[], groups: [] as unknown[] }));
vi.mock("@/api/folders", () => ({ useFolders: () => ({ data: data.folders }) }));
vi.mock("@/api/groups", () => ({ useGroups: () => ({ data: data.groups }) }));

function note(over: Partial<NoteDto> = {}): NoteDto {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    title: "Plan",
    ownerId: "u1",
    role: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    slug: "plan",
    slugIsCustom: false,
    prevSlug: null,
    ownerHandle: "alice",
    lastEdited: null,
    group: null,
    groupId: null,
    folderId: null,
    permissions: OWNER_PERMS,
    ...over,
  };
}

function groupNote(groupId: string, over: Partial<NoteDto> = {}): NoteDto {
  return note({ ownerId: null, ownerHandle: null, role: "editor", groupId, group: { id: groupId, name: "Team" }, ...over });
}

describe("NoteBrowseBar", () => {
  const openSearch = vi.fn();
  const createNote = vi.fn<(groupId?: string, folderId?: string) => Promise<void>>(() => Promise.resolve());

  function renderBar(n: NoteDto) {
    return render(
      <PhoneBrowseContext.Provider value={{ openSearch, createNote }}>
        <NoteBrowseBar note={n} />
      </PhoneBrowseContext.Provider>,
    );
  }

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    openSearch.mockClear();
    createNote.mockClear();
    data.folders = [];
    data.groups = [];
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("左邊是看起來像搜尋框的按鈕（44 高），按了開搜尋層", () => {
    renderBar(note());
    const search = screen.getByRole("button", { name: "Search notes" });
    expect(search).toHaveClass("h-11");
    expect(search).toHaveTextContent("Search…");
    fireEvent.click(search);
    expect(openSearch).toHaveBeenCalledTimes(1);
  });

  it("列高 56 加底部 safe area（class 斷言，jsdom 無版面）", () => {
    renderBar(note());
    const bar = screen.getByTestId("note-browse-bar");
    expect(bar).toHaveClass("pt-1.5");
    expect(bar.className).toContain("env(safe-area-inset-bottom)");
  });

  it("個人根層：「New note」→ createNote() 不帶參數", () => {
    renderBar(note());
    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    expect(createNote).toHaveBeenCalledWith(undefined, undefined);
  });

  it("個人資料夾：createNote(undefined, folderId)", () => {
    data.folders = [folderDto({ id: "f1", name: "Projects" })] as FolderDto[];
    renderBar(note({ folderId: "f1" }));
    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    expect(createNote).toHaveBeenCalledWith(undefined, "f1");
  });

  it("群組成員：createNote(groupId, folderId)", () => {
    data.groups = [groupDto({ id: "g1", name: "Team" }, memberRole())] as GroupDto[];
    data.folders = [groupFolder({ id: "gf1", name: "Specs", groupId: "g1" })];
    renderBar(groupNote("g1", { folderId: "gf1" }));
    fireEvent.click(screen.getByRole("button", { name: "New note" }));
    expect(createNote).toHaveBeenCalledWith("g1", "gf1");
  });

  it("管理員也有；檢視者、能建不能編的自訂角色、共享給我都沒有「New note」（搜尋仍在）", () => {
    data.groups = [groupDto({ id: "g1", name: "Team" }, adminRole())] as GroupDto[];
    const { unmount } = renderBar(groupNote("g1"));
    expect(screen.getByRole("button", { name: "New note" })).toBeInTheDocument();
    unmount();

    data.groups = [groupDto({ id: "g1", name: "Readers" }, customRole())] as GroupDto[];
    const second = renderBar(groupNote("g1"));
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
    expect(screen.getByRole("button", { name: "Search notes" })).toBeInTheDocument();
    second.unmount();

    data.groups = [];
    renderBar(note({ role: "viewer", ownerId: "u2", ownerHandle: "bob" }));
    expect(screen.queryByRole("button", { name: "New note" })).toBeNull();
    expect(screen.getByRole("button", { name: "Search notes" })).toBeInTheDocument();
  });

  it("建立中：「New note」停用，不會連點建兩篇", async () => {
    let resolve: () => void = () => {};
    createNote.mockImplementationOnce(() => new Promise<void>((done) => (resolve = done)));
    renderBar(note());
    const button = screen.getByRole("button", { name: "New note" });
    fireEvent.click(button);
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(createNote).toHaveBeenCalledTimes(1);
    await act(async () => resolve());
    await waitFor(() => expect(button).not.toBeDisabled());
  });

  describe("螢幕鍵盤", () => {
    let viewport: EventTarget & { height: number; offsetTop: number; scale: number };
    let frames: Array<() => void>;

    function setKeyboard(inset: number) {
      viewport.height = 800 - inset;
      act(() => {
        viewport.dispatchEvent(new Event("resize"));
        frames.splice(0).forEach((run) => run());
      });
    }

    beforeEach(() => {
      viewport = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
      vi.stubGlobal("innerHeight", 800);
      frames = [];
      vi.stubGlobal("requestAnimationFrame", (cb: () => void) => frames.push(cb));
      Object.defineProperty(window, "visualViewport", { value: viewport, configurable: true, writable: true });
    });
    afterEach(() => {
      Object.defineProperty(window, "visualViewport", { value: undefined, configurable: true, writable: true });
    });

    it("鍵盤開著（例如在改標題）：這條不在；收起後回來", () => {
      renderBar(note());
      expect(screen.getByTestId("note-browse-bar")).toBeInTheDocument();
      setKeyboard(300);
      expect(screen.queryByTestId("note-browse-bar")).toBeNull();
      setKeyboard(0);
      expect(screen.getByTestId("note-browse-bar")).toBeInTheDocument();
    });
  });
});
