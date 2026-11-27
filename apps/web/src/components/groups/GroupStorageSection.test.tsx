import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { GroupDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts } from "@/components/ui/toast";
import { ADMIN_ROLE, EMPTY_GROUP_USAGE, GROUP_ADMIN, GROUP_MEMBER, ME, callsTo, groupFetch, member, ok, renderGroupRoute } from "./group-test-utils";

const USAGE = {
  // usedBytes deliberately differs from the sum of byKind (3 MB): the share denominator must be the byKind sum - when they are equal a wrong denominator would go undetected.
  usedBytes: 4 * 1048576,
  quotaBytes: 10 * 1048576,
  planName: "Team",
  byKind: { image: 2 * 1048576, audio: 0, video: 1048576, document: 0, other: 0 }, content: { noteBytes: 0, historyBytes: 0 },
  byMember: [
    { userId: "u-bob", handle: "bob", displayName: "Bob", bytes: 2 * 1048576 },
    { userId: null, handle: null, displayName: null, bytes: 1048576 },
  ],
};
const VERSIONS_NOTE = i18n.t("settings.storage.versionsNote", { lng: "en" });

async function openStorage(group: GroupDto, usage: unknown, extra: Parameters<typeof groupFetch>[2] = () => null) {
  const fetchMock = groupFetch(() => [group], () => [member(ME.id, ME.email, "Me", ADMIN_ROLE)], (url, method, init) =>
    extra(url, method, init) ?? (url === `/api/groups/${group.id}/storage` && method === "GET" ? ok(usage) : null),
  );
  renderGroupRoute(`/groups/${group.id}/storage`, fetchMock);
  const dialog = await screen.findByRole("dialog", { name: group.name });
  await within(dialog).findByRole("heading", { level: 1, name: "Storage" });
  return { dialog, fetchMock };
}

describe("GroupStorageSection (/groups/:id/storage, #247)", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("by-kind shares include notes in the denominator while by-member shares use only the five file kinds", async () => {
    const { dialog } = await openStorage(GROUP_ADMIN, { ...USAGE, content: { noteBytes: 1048576, historyBytes: 0 } });
    await within(dialog).findByTestId("by-kind-image");
    // image 2 MB / (notes 1 MB + kinds 3 MB)
    expect(parseFloat((within(dialog).getByTestId("by-kind-bar-image") as HTMLElement).style.width)).toBeCloseTo(50, 2);
    // by-member ignores notes: bob's 2 MB / 3 MB
    const memberBar = within(dialog).getAllByTestId("by-member-row")[0]!.querySelector<HTMLElement>("[data-testid='by-member-bar']")!;
    expect(parseFloat(memberBar.style.width)).toBeCloseTo(66.667, 2);
  });

  it("usage plus the notes row and the four always-shown by-kind rows are present (including rows of 0)", async () => {
    const { dialog } = await openStorage(GROUP_ADMIN, USAGE);
    await waitFor(() => expect(within(dialog).getByTestId("storage-usage")).toHaveTextContent("4 MB"));
    expect(within(dialog).getByRole("heading", { name: "By type" })).toBeInTheDocument();
    // By-kind rows are found by data-testid (by-kind-* kept; not scoped by closest("section")).
    const kinds: Array<[string, string]> = [["note", "Notes"], ["image", "Images"], ["audio", "Audio"], ["video", "Video"], ["document", "Documents"]];
    expect(within(dialog).queryByTestId("by-kind-other")).not.toBeInTheDocument();
    for (const [kind, label] of kinds) {
      expect(within(within(dialog).getByTestId(`by-kind-${kind}`)).getByText(label)).toBeInTheDocument();
    }
  });

  it("notes sit first in by-type and the backup size shows in the version history group", async () => {
    const { dialog } = await openStorage(GROUP_ADMIN, { ...USAGE, content: { noteBytes: 1048576, historyBytes: 3 * 1048576 } });
    const note = await within(dialog).findByTestId("by-kind-note");
    expect(within(note).getByText("1 MB")).toBeInTheDocument();
    expect(note.compareDocumentPosition(within(dialog).getByTestId("by-kind-image")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const backups = within(dialog).getByTestId("versions-backup-bytes");
    expect(backups).toHaveTextContent("3 MB");
    expect(within(dialog).getByTestId("by-kind-image").compareDocumentPosition(backups) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(dialog).queryByRole("heading", { name: "Notes and history" })).not.toBeInTheDocument();
  });

  it("by member: only bytes>0 are listed; shows name plus grey @handle; deleted users are aggregated into one row; the share bar width uses the byKind sum as denominator", async () => {
    const { dialog } = await openStorage(GROUP_ADMIN, {
      ...USAGE,
      byMember: [...USAGE.byMember, { userId: "u-zero", handle: "zero", displayName: "Zero", bytes: 0 }],
    });
    await within(dialog).findByRole("heading", { name: "By member" });
    const rows = within(dialog).getAllByTestId("by-member-row");
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText("Bob")).toBeInTheDocument();
    expect(within(rows[0]).getByText("@bob")).toBeInTheDocument();
    expect(within(rows[0]).getByText("2 MB")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Deleted user")).toBeInTheDocument();
    expect(within(rows[1]).queryByText(/^@/)).not.toBeInTheDocument();
    // denominator = byKind sum (3 MB), not usedBytes: 2/3 -> 66.666...%
    const bar = rows[0].querySelector<HTMLElement>("[data-testid='by-member-bar']")!;
    expect(parseFloat(bar.style.width)).toBeCloseTo(66.667, 2);
    expect(within(dialog).queryByText("Zero")).not.toBeInTheDocument();
  });

  it("no by-member rows: \"This group's notes have no files yet.\"; the description is in the occupant sense (both languages); no NaN when the byKind sum is 0", async () => {
    const { dialog } = await openStorage(GROUP_ADMIN, EMPTY_GROUP_USAGE);
    await within(dialog).findByRole("heading", { name: "By member" });
    expect(within(dialog).getByText("This group's notes have no files yet.")).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "How much of this group's space each person has taken up: files they uploaded into its notes, plus the files that came with notes they moved or copied into the group.",
      ),
    ).toBeInTheDocument();
    expect(i18n.t("groups.storage.byMemberEmpty", { lng: "zh-TW" })).toBe("這個群組的筆記還沒有檔案");
    expect(i18n.t("groups.storage.byMemberDescription", { lng: "zh-TW" })).toBe(
      "每個人佔用了這個群組多少空間：在群組筆記裡上傳的檔案，加上他移入或複製進群組的筆記帶進來的檔案。",
    );
    expect(dialog.innerHTML).not.toContain("NaN");
  });

  it("an ordinary member (no canManageGroup) also sees usage; the versions switch is disabled with a note on who can change it; the description says versions do not count toward the quota", async () => {
    const { dialog, fetchMock } = await openStorage(GROUP_MEMBER, USAGE);
    await waitFor(() => expect(within(dialog).getByTestId("storage-usage")).toBeInTheDocument());
    expect(callsTo(fetchMock, "GET", `/api/groups/${GROUP_MEMBER.id}/storage`).length).toBeGreaterThanOrEqual(1);
    const sw = within(dialog).getByRole("switch", { name: "Automatic versions" });
    expect(sw).toBeDisabled();
    expect(within(dialog).getByText("Only members whose role can manage the group can change this.")).toBeInTheDocument();
    expect(within(dialog).getByText(VERSIONS_NOTE, { exact: false })).toBeInTheDocument();
    fireEvent.click(sw);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(callsTo(fetchMock, "PATCH", `/api/groups/${GROUP_MEMBER.id}`)).toHaveLength(0);
  });

  it("canManageGroup: the versions switch can be toggled, PATCH body is { autoVersions:false }", async () => {
    let group: GroupDto = { ...GROUP_ADMIN, autoVersions: true };
    const fetchMock = groupFetch(() => [group], () => [member(ME.id, ME.email, "Me", ADMIN_ROLE)], (url, method, init) => {
      if (url === `/api/groups/${GROUP_ADMIN.id}` && method === "PATCH") {
        group = { ...group, ...JSON.parse(String(init?.body)) };
        return ok(group);
      }
      return null;
    });
    renderGroupRoute(`/groups/${GROUP_ADMIN.id}/storage`, fetchMock);
    const sw = await screen.findByRole("switch", { name: "Automatic versions" });
    await waitFor(() => expect(sw).toBeEnabled());
    fireEvent.click(sw);
    await waitFor(() => expect(callsTo(fetchMock, "PATCH", `/api/groups/${GROUP_ADMIN.id}`)).toHaveLength(1));
    expect(JSON.parse(String(callsTo(fetchMock, "PATCH", `/api/groups/${GROUP_ADMIN.id}`)[0].body))).toEqual({ autoVersions: false });
    await waitFor(() => expect(screen.getByRole("switch", { name: "Automatic versions" })).toHaveAttribute("aria-checked", "false"));
  });

  it("site master switch off: even managers see it disabled + the site-disabled note", async () => {
    await openStorage(GROUP_ADMIN, USAGE, (url, method) =>
      url === "/api/auth/config" && method === "GET"
        ? ok({ providers: [], registration: { enabled: false, providerIds: [] }, passwordLogin: { enabled: true }, autoVersionsEnabled: false })
        : null,
    );
    const sw = screen.getByRole("switch", { name: "Automatic versions" });
    await waitFor(() => expect(sw).toBeDisabled());
    expect(screen.getByText("Automatic saving is turned off for the whole site")).toBeInTheDocument();
  });
});
