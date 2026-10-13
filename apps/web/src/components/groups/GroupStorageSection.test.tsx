import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { GroupDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts } from "@/components/ui/toast";
import { ADMIN_ROLE, EMPTY_GROUP_USAGE, GROUP_ADMIN, GROUP_MEMBER, ME, callsTo, groupFetch, member, ok, renderGroupRoute } from "./group-test-utils";

const USAGE = {
  // usedBytes 刻意與 byKind 之和（3 MB）不同：佔比分母必須取 byKind 之和（§9.1），兩者相同時「分母取錯」測不出來。
  usedBytes: 4 * 1048576,
  quotaBytes: 10 * 1048576,
  planName: "Team",
  byKind: { image: 2 * 1048576, audio: 0, video: 1048576, document: 0, other: 0 },
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

describe("GroupStorageSection（/groups/:id/storage，#247 §6.4）", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("S1 用量＋依類型五列恆在（含 0 的列）", async () => {
    const { dialog } = await openStorage(GROUP_ADMIN, USAGE);
    await waitFor(() => expect(within(dialog).getByTestId("storage-usage")).toHaveTextContent("4 MB"));
    expect(within(dialog).getByRole("heading", { name: "By type" })).toBeInTheDocument();
    // 依類型的列以 data-testid 取（spec 2026-10-13 settings-table §4 保留 by-kind-*；§5.2 不再以 closest("section") 圈範圍）。
    const kinds: Array<[string, string]> = [["image", "Images"], ["audio", "Audio"], ["video", "Video"], ["document", "Documents"], ["other", "Other"]];
    for (const [kind, label] of kinds) {
      expect(within(within(dialog).getByTestId(`by-kind-${kind}`)).getByText(label)).toBeInTheDocument();
    }
  });

  it("S2 依成員：只列 bytes>0；顯示名稱＋灰字 @handle；已刪除使用者彙總成一列；佔比條寬度以 byKind 之和為分母", async () => {
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
    // 分母＝byKind 之和（3 MB），不是 usedBytes：2/3 → 66.666…%
    const bar = rows[0].querySelector<HTMLElement>("[data-testid='by-member-bar']")!;
    expect(parseFloat(bar.style.width)).toBeCloseTo(66.667, 2);
    expect(within(dialog).queryByText("Zero")).not.toBeInTheDocument();
  });

  it("S3 依成員沒有任何列 → 「This group's notes have no files yet.」；說明是佔用者語意（§9.2 rev 10，兩語言）；byKind 和為 0 時不 NaN", async () => {
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

  it("S4 一般成員（無 canManageGroup）也看得到用量（§9.2 放寬）；版本開關 disabled＋只有…可以變更；說明含「版本不佔額度」", async () => {
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

  it("S5 canManageGroup → 版本開關可切換，PATCH body 恰為 { autoVersions:false }（自 main 版 SettingsGroupDetailSection.test.tsx:634 搬來）", async () => {
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

  it("S6 站台總開關關閉 → 管理者也 disabled＋站台已關閉（自 main 版 :672 搬來）", async () => {
    await openStorage(GROUP_ADMIN, USAGE, (url, method) =>
      url === "/api/auth/config" && method === "GET"
        ? ok({ providers: [], registration: { enabled: false }, passwordLogin: { enabled: true }, autoVersionsEnabled: false })
        : null,
    );
    const sw = screen.getByRole("switch", { name: "Automatic versions" });
    await waitFor(() => expect(sw).toBeDisabled());
    expect(screen.getByText("Automatic saving is turned off for the whole site")).toBeInTheDocument();
  });
});
