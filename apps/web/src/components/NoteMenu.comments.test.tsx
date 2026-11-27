import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";
import type { NoteDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { VIEWER_PERMS } from "@/test/fixtures";
import { stubLayoutTier, type LayoutTier } from "@/test/layout-tier";
import { pressTrigger } from "@/test/menu-trigger";
import { NoteMenu } from "./NoteMenu";

const NOTE: NoteDto = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "Shared",
  ownerId: "u-bob",
  role: "viewer",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  slug: "shared",
  slugIsCustom: true,
  prevSlug: null,
  ownerHandle: "bob",
  lastEdited: null,
  group: null,
  groupId: null,
  folderId: null,
  permissions: VIEWER_PERMS,
};

function renderMenu(onOpenComments?: () => void) {
  vi.stubGlobal("fetch", vi.fn(() => Promise.reject(new Error("unexpected fetch"))));
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/notes/shared"]}>
        <NoteMenu note={NOTE} state={{ phase: "connected", role: "viewer" }} leavingRef={{ current: false }} onOpenEdits={() => {}} onOpenComments={onOpenComments} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function openMenu(): Promise<HTMLElement> {
  pressTrigger(screen.getByRole("button", { name: "More" }));
  return screen.findByRole("menu");
}

describe("NoteMenu - comments", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
  });
  afterEach(() => vi.unstubAllGlobals());

  it("phone: a viewer gets 'Comments', which closes the menu and opens the comments", async () => {
    stubLayoutTier("phone");
    const onOpen = vi.fn();
    renderMenu(onOpen);
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Comments" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  });

  it.each(["compact", "overlay", "docked"] as LayoutTier[])("%s (the bubble is the entry there): no 'Comments' item", async (tier) => {
    stubLayoutTier(tier);
    renderMenu(() => {});
    const menu = await openMenu();
    expect(within(menu).queryByRole("menuitem", { name: "Comments" })).toBeNull();
  });

  it("without onOpenComments (sidebar rows, comments off): no item", async () => {
    stubLayoutTier("phone");
    renderMenu();
    const menu = await openMenu();
    expect(within(menu).queryByRole("menuitem", { name: "Comments" })).toBeNull();
  });
});
