import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { GroupDto, GroupMemberDto } from "@knotebook/shared";
import i18n from "@/i18n";
import { dismissAllToasts } from "@/components/ui/toast";
import { clickOutside } from "@/test/outside-click";
import {
  ADMIN_ROLE, GROUP_ADMIN, GROUP_MEMBER, ME, MEMBER_ROLE, ROLES, callsTo, fail, groupFetch, member, ok, renderGroupRoute,
} from "./group-test-utils";

// 成員批次加入：貼多個地址（逗號／分號／空白／換行）與「從其他群組匯入」，兩條都開同一個對話框（BulkAddDialog），
// 逐一 `PUT …/members`，進度（＋停止）與結果都在對話框裡。純函式（拆解、分類、停下、abort）由 bulk-add.test.ts 守。

const URL_MEMBERS = `/api/groups/${GROUP_ADMIN.id}/members`;
const SOURCE: GroupDto = { ...GROUP_MEMBER, name: "Team Source" };

function putBodies(fetchMock: ReturnType<typeof vi.fn>): Array<{ email: string; roleId?: string }> {
  return callsTo(fetchMock, "PUT", URL_MEMBERS).map((init) => JSON.parse(String(init.body)) as { email: string; roleId?: string });
}

type Extra = (url: string, method: string, body: { email: string; roleId?: string } | null) => Response | Promise<Response> | null;

/**
 * `PUT` 依 email 回：known 裡的 → 201 並加進名單；`dup@` → 409 already_member；`boom@` → 500；`slow@` → 429；
 * `nope403@` → 403 forbidden；`norole@` → 404 role_not_found；其他 → 404 user_not_found。`extra` 先比對（可回 Promise 控制時序）。
 */
function membersServer(initial: GroupMemberDto[], known: string[], extra: Extra = () => null) {
  let members = [...initial];
  const fetchMock = groupFetch(() => [GROUP_ADMIN, SOURCE], () => members, (url, method, init) => {
    const body = url === URL_MEMBERS && method === "PUT" ? (JSON.parse(String(init?.body)) as { email: string; roleId?: string }) : null;
    const custom = extra(url, method, body);
    if (custom) return custom;
    if (body) {
      if (body.email === "dup@example.com") return fail(409, "already_member");
      if (body.email === "boom@example.com") return fail(500, "internal");
      if (body.email === "slow@example.com") return fail(429, "too_many_requests");
      if (body.email === "nope403@example.com") return fail(403, "forbidden");
      if (body.email === "norole@example.com") return fail(404, "role_not_found");
      if (!known.includes(body.email)) return fail(404, "user_not_found");
      const role = ROLES.find((r) => r.id === body.roleId) ?? MEMBER_ROLE;
      const added = member(`u-${body.email}`, body.email, body.email.split("@")[0]!, role);
      members = [...members, added];
      return ok(added, 201);
    }
    return null;
  });
  return fetchMock;
}

/** 手動放行的回應：`release(res)` 之前那一發 `PUT` 一直掛著。 */
function deferred() {
  let release!: (res: Response) => void;
  const promise = new Promise<Response>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

async function openMembers(fetchMock: ReturnType<typeof vi.fn>) {
  const view = renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, fetchMock);
  const dialog = await screen.findByRole("dialog", { name: GROUP_ADMIN.name });
  const roleSelect = await within(dialog).findByLabelText("Role for new member");
  await waitFor(() => expect(roleSelect).toHaveValue(MEMBER_ROLE.id));
  await within(dialog).findByText(ME.email);
  return { dialog, view };
}

function submitEmails(dialog: HTMLElement, value: string) {
  fireEvent.change(within(dialog).getByLabelText("Email address"), { target: { value } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
}

/** 結果畫面：等「Done」出現，回傳對話框。 */
async function resultDialog(name = "Add members") {
  const bulkDialog = await screen.findByRole("dialog", { name });
  await within(bulkDialog).findByRole("button", { name: "Done" });
  return bulkDialog;
}

/** 結果畫面看得到的那行說明（停下原因／留在輸入框）；live region 裡另有一份（sr-only），不算。 */
function resultMessage(bulkDialog: HTMLElement): HTMLElement | null {
  return bulkDialog.querySelector("[data-result-message]");
}

function outcomeRow(bulkDialog: HTMLElement, outcome: string): HTMLElement | null {
  return bulkDialog.querySelector(`[data-outcome="${outcome}"]`);
}

/** 某一類的標題與 email 清單（一行一個）；沒有這一類 → null。 */
function outcomeSummary(bulkDialog: HTMLElement, outcome: string): { label: string; emails: string[] } | null {
  const row = outcomeRow(bulkDialog, outcome);
  if (!row) return null;
  return {
    label: row.firstElementChild?.textContent ?? "",
    emails: within(row).queryAllByRole("listitem").map((li) => li.textContent ?? ""),
  };
}

const ME_ADMIN = () => member(ME.id, ME.email, "Me", ADMIN_ROLE);

describe("成員批次加入", () => {
  beforeEach(async () => {
    await i18n.changeLanguage("en");
    dismissAllToasts();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("貼多個地址 → 開「Add members」對話框：去重、已在名單的不送；逐一 PUT（同一個角色）；結果分類列出；沒加成的留在輸入框、角色不重設", async () => {
    const initial = [ME_ADMIN(), member("u-bob", "bob@example.com", "Bob", MEMBER_ROLE)];
    const fetchMock = membersServer(initial, ["carol@example.com", "dave@example.com"]);
    const { dialog } = await openMembers(fetchMock);

    fireEvent.change(within(dialog).getByLabelText("Role for new member"), { target: { value: ADMIN_ROLE.id } });
    const input = within(dialog).getByLabelText("Email address");
    submitEmails(dialog, "carol@example.com, ghost@example.com; Carol@Example.com BOB@example.com dave@example.com nope");

    const bulkDialog = await resultDialog();
    expect(within(bulkDialog).getByText("These addresses are added to this group as Admin.")).toBeInTheDocument();
    expect(putBodies(fetchMock)).toEqual([
      { email: "carol@example.com", roleId: ADMIN_ROLE.id },
      { email: "ghost@example.com", roleId: ADMIN_ROLE.id },
      { email: "dave@example.com", roleId: ADMIN_ROLE.id },
    ]);
    expect(outcomeSummary(bulkDialog, "added")).toEqual({ label: "Added (2):", emails: ["carol@example.com", "dave@example.com"] });
    expect(outcomeSummary(bulkDialog, "notFound")).toEqual({ label: "No account with this email (1):", emails: ["ghost@example.com"] });
    expect(outcomeSummary(bulkDialog, "alreadyMember")).toEqual({ label: "Already members (1):", emails: ["BOB@example.com"] });
    expect(outcomeSummary(bulkDialog, "invalid")).toEqual({ label: "Not an email address (1):", emails: ["nope"] });
    expect(resultMessage(bulkDialog)).toHaveTextContent(/^The addresses that weren't added are left in the email box/);
    // 沒有帳號與格式不對的留在輸入框（依原輸入順序），角色不重設（還要再加）
    expect(input).toHaveValue("ghost@example.com, nope");
    expect(within(dialog).getByLabelText("Role for new member")).toHaveValue(ADMIN_ROLE.id);
    // 失效後名單重抓：新成員出現，角色是選的那個
    await waitFor(() => expect(within(dialog).getByLabelText("Role for dave@example.com")).toHaveValue(ADMIN_ROLE.id));
    // 設定 modal 裡沒有結果框（只在對話框裡）
    expect(within(dialog).queryByText(/Added \(2\)/)).not.toBeInTheDocument();
  });

  it("live region：對話框一打開就在、跑完只播停下原因與各類人數（不含 email 清單）；完成 → 關閉、焦點回輸入框", async () => {
    const put = deferred();
    const fetchMock = membersServer([ME_ADMIN()], ["carol@example.com"], (_url, _method, body) =>
      body?.email === "carol@example.com" ? put.promise : null,
    );
    const { dialog } = await openMembers(fetchMock);
    submitEmails(dialog, "carol@example.com ghost@example.com");

    const bulkDialog = await screen.findByRole("dialog", { name: "Add members" });
    const live = within(bulkDialog).getByRole("status");
    expect(live).toHaveTextContent(/^$/);
    expect(within(bulkDialog).getByText("Processed 0 of 2")).toBeInTheDocument();
    await waitFor(() => expect(within(bulkDialog).getByRole("button", { name: "Stop" })).toHaveFocus());
    await act(async () => put.release(ok(member("u-carol", "carol@example.com", "Carol", MEMBER_ROLE), 201)));

    await resultDialog();
    // 同一個節點（常駐），內容換成摘要
    expect(within(bulkDialog).getByRole("status")).toBe(live);
    expect(live).toHaveTextContent(
      "The addresses that weren't added are left in the email box so you can fix them and try again. Added: 1. No account with this email: 1.",
    );
    expect(live).not.toHaveTextContent("@");
    expect(within(bulkDialog).getByRole("button", { name: "Done" })).toHaveFocus();

    fireEvent.click(within(bulkDialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add members" })).not.toBeInTheDocument());
    await waitFor(() => expect(within(dialog).getByLabelText("Email address")).toHaveFocus());
  });

  it("全部加成 → 輸入框清空、角色重設；沒有「留在輸入框」的說明", async () => {
    const fetchMock = membersServer([ME_ADMIN()], ["carol@example.com", "dave@example.com"]);
    const { dialog } = await openMembers(fetchMock);
    fireEvent.change(within(dialog).getByLabelText("Role for new member"), { target: { value: ADMIN_ROLE.id } });
    submitEmails(dialog, "carol@example.com\tdave@example.com");
    const bulkDialog = await resultDialog();
    expect(outcomeSummary(bulkDialog, "added")).toEqual({ label: "Added (2):", emails: ["carol@example.com", "dave@example.com"] });
    expect(resultMessage(bulkDialog)).toBeNull();
    expect(within(dialog).getByLabelText("Email address")).toHaveValue("");
    expect(within(dialog).getByLabelText("Role for new member")).toHaveValue(MEMBER_ROLE.id);
    // 說明文字用開跑時的角色（跑完角色重設了，說明不跟著變）
    expect(within(bulkDialog).getByText("These addresses are added to this group as Admin.")).toBeInTheDocument();
  });

  it("1 個有效地址＋1 個不像 email 的字 → 也走批次對話框（不是單人流程），格式不對的列在結果裡", async () => {
    const fetchMock = membersServer([ME_ADMIN()], ["carol@example.com"]);
    const { dialog } = await openMembers(fetchMock);
    submitEmails(dialog, "carol@example.com nope");
    const bulkDialog = await resultDialog();
    expect(outcomeSummary(bulkDialog, "added")).toEqual({ label: "Added (1):", emails: ["carol@example.com"] });
    expect(outcomeSummary(bulkDialog, "invalid")).toEqual({ label: "Not an email address (1):", emails: ["nope"] });
    expect(within(dialog).queryByRole("alert")).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText("Email address")).toHaveValue("nope");
  });

  it("跑的期間點對話框外面 → 不關、不中止（dismissOnOutside={false}）", async () => {
    const put = deferred();
    const fetchMock = membersServer([ME_ADMIN()], ["carol@example.com", "dave@example.com"], (_url, _method, body) =>
      body?.email === "carol@example.com" ? put.promise : null,
    );
    const { dialog } = await openMembers(fetchMock);
    submitEmails(dialog, "carol@example.com dave@example.com");
    const bulkDialog = await screen.findByRole("dialog", { name: "Add members" });
    await within(bulkDialog).findByRole("button", { name: "Stop" });
    // 完整的「點外面」序列（只送 pointerdown 在這版 Radix 不會有作用，見 test/outside-click.ts）
    await clickOutside();
    expect(screen.getByRole("dialog", { name: "Add members" })).toBeInTheDocument();
    expect(within(bulkDialog).getByRole("button", { name: "Stop" })).toBeInTheDocument();

    await act(async () => put.release(ok(member("u-carol", "carol@example.com", "Carol", MEMBER_ROLE), 201)));
    const result = await resultDialog();
    expect(outcomeSummary(result, "added")?.emails).toEqual(["carol@example.com", "dave@example.com"]);
    expect(putBodies(fetchMock).map((b) => b.email)).toEqual(["carol@example.com", "dave@example.com"]);
  });

  it("server 回 409 already_member（名單還沒更新到的人）→ 記「已是成員」、繼續下一個", async () => {
    const fetchMock = membersServer([ME_ADMIN()], ["carol@example.com"]);
    const { dialog } = await openMembers(fetchMock);
    submitEmails(dialog, "dup@example.com, carol@example.com");
    const bulkDialog = await resultDialog();
    expect(putBodies(fetchMock).map((b) => b.email)).toEqual(["dup@example.com", "carol@example.com"]);
    expect(outcomeSummary(bulkDialog, "alreadyMember")).toEqual({ label: "Already members (1):", emails: ["dup@example.com"] });
    expect(outcomeSummary(bulkDialog, "added")).toEqual({ label: "Added (1):", emails: ["carol@example.com"] });
    expect(within(dialog).getByLabelText("Email address")).toHaveValue("");
  });

  it("輸入框有 aria-describedby：說明可以一次輸入多個地址", async () => {
    const { dialog } = await openMembers(membersServer([ME_ADMIN()], []));
    expect(within(dialog).getByLabelText("Email address")).toHaveAccessibleDescription(
      "You can enter several addresses at once, separated by commas, semicolons, spaces or line breaks (full-width commas and semicolons and the enumeration comma “、” work too).",
    );
  });

  it("單一地址仍走原本的單人流程（錯誤是表單下的 alert、不開對話框）；單一個不像 email 的字不送出", async () => {
    const fetchMock = membersServer([ME_ADMIN()], []);
    const { dialog } = await openMembers(fetchMock);
    const input = within(dialog).getByLabelText("Email address");

    submitEmails(dialog, "ghost@example.com");
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("We couldn't find that user.");
    expect(screen.queryByRole("dialog", { name: "Add members" })).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: "nope" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Add" }));
    expect(await within(dialog).findByRole("alert")).toHaveTextContent("“nope” doesn't look like an email address.");
    expect(putBodies(fetchMock)).toHaveLength(1);
  });

  it("貼上含換行的一欄地址 → 換行變逗號（單行輸入框原本會把換行吃掉）", async () => {
    const { dialog } = await openMembers(membersServer([ME_ADMIN()], []));
    const input = within(dialog).getByLabelText("Email address") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "x@example.com, " } });
    input.setSelectionRange(input.value.length, input.value.length);
    fireEvent.paste(input, { clipboardData: { getData: () => "a@example.com\r\nb@example.com\n" } });
    expect(input).toHaveValue("x@example.com, a@example.com, b@example.com");
  });

  it("非預期錯誤（500）→ 停下：其後不送；沒加成的放回輸入框；對話框裡顯示原因", async () => {
    const fetchMock = membersServer([ME_ADMIN()], ["carol@example.com", "dave@example.com"]);
    const { dialog } = await openMembers(fetchMock);
    submitEmails(dialog, "carol@example.com, boom@example.com, dave@example.com");

    const bulkDialog = await resultDialog();
    expect(resultMessage(bulkDialog)).toHaveTextContent(/^Stopped: Something went wrong/);
    expect(putBodies(fetchMock).map((b) => b.email)).toEqual(["carol@example.com", "boom@example.com"]);
    expect(outcomeRow(bulkDialog, "failed")).toHaveTextContent("boom@example.com");
    expect(outcomeRow(bulkDialog, "notProcessed")).toHaveTextContent("dave@example.com");
    expect(within(dialog).getByLabelText("Email address")).toHaveValue("boom@example.com, dave@example.com");
  });

  it("403 forbidden（管理權被收回）與 404 role_not_found（角色被刪）→ 停下並說明原因", async () => {
    const fetchMock = membersServer([ME_ADMIN()], ["carol@example.com"]);
    const { dialog } = await openMembers(fetchMock);
    submitEmails(dialog, "nope403@example.com carol@example.com");
    let bulkDialog = await resultDialog();
    expect(resultMessage(bulkDialog)).toHaveTextContent("Stopped: You don't have permission to do that. The addresses that weren't added are back in the email box.");
    expect(outcomeRow(bulkDialog, "notProcessed")).toHaveTextContent("carol@example.com");
    fireEvent.click(within(bulkDialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add members" })).not.toBeInTheDocument());

    submitEmails(dialog, "norole@example.com carol@example.com");
    bulkDialog = await resultDialog();
    expect(resultMessage(bulkDialog)).toHaveTextContent(/^Stopped: We couldn't find that role\./);
    expect(putBodies(fetchMock).map((b) => b.email)).toEqual(["nope403@example.com", "norole@example.com"]);
    expect(within(dialog).getByLabelText("Email address")).toHaveValue("norole@example.com, carol@example.com");
  });

  it("429 → 停下並說明是節流、稍後再加其餘的", async () => {
    const fetchMock = membersServer([ME_ADMIN()], ["carol@example.com"]);
    const { dialog } = await openMembers(fetchMock);
    submitEmails(dialog, "carol@example.com slow@example.com later@example.com");
    const bulkDialog = await resultDialog();
    expect(resultMessage(bulkDialog)).toHaveTextContent(/server is limiting requests/);
    expect(putBodies(fetchMock).map((b) => b.email)).toEqual(["carol@example.com", "slow@example.com"]);
    expect(within(dialog).getByLabelText("Email address")).toHaveValue("slow@example.com, later@example.com");
  });

  it("停止鈕：正在送的那一筆跑完就停，其餘記「未處理」並放回輸入框；跑的期間輸入框 readOnly", async () => {
    const put = deferred();
    const fetchMock = membersServer([ME_ADMIN()], ["carol@example.com", "dave@example.com", "erin@example.com"], (_url, _method, body) =>
      body?.email === "dave@example.com" ? put.promise : null,
    );
    const { dialog } = await openMembers(fetchMock);
    const input = within(dialog).getByLabelText("Email address");
    submitEmails(dialog, "carol@example.com, dave@example.com, erin@example.com");

    const bulkDialog = await screen.findByRole("dialog", { name: "Add members" });
    expect(await within(bulkDialog).findByText("Processed 1 of 3")).toBeInTheDocument();
    expect(input).toHaveAttribute("readonly");
    // readOnly 時貼上（含換行，會走自訂的貼上處理）也不改值
    fireEvent.paste(input, { clipboardData: { getData: () => "x@example.com\ny@example.com" } });
    expect(input).toHaveValue("carol@example.com, dave@example.com, erin@example.com");
    fireEvent.click(within(bulkDialog).getByRole("button", { name: "Stop" }));
    expect(within(bulkDialog).getByRole("button", { name: "Stopping…" })).toHaveAttribute("aria-disabled", "true");
    await act(async () => put.release(ok(member("u-dave", "dave@example.com", "Dave", MEMBER_ROLE), 201)));

    await resultDialog();
    expect(putBodies(fetchMock).map((b) => b.email)).toEqual(["carol@example.com", "dave@example.com"]);
    expect(resultMessage(bulkDialog)).toHaveTextContent("Stopped. The addresses that weren't added are back in the email box.");
    expect(outcomeSummary(bulkDialog, "added")).toEqual({ label: "Added (2):", emails: ["carol@example.com", "dave@example.com"] });
    expect(outcomeSummary(bulkDialog, "notProcessed")).toEqual({ label: "Not processed (1):", emails: ["erin@example.com"] });
    expect(input).toHaveValue("erin@example.com");
    expect(input).not.toHaveAttribute("readonly");
  });

  it("跑到一半關掉對話框（✕）＝停止：不再送、沒處理的放回輸入框、焦點回輸入框；收尾期間不能再開匯入", async () => {
    const put = deferred();
    const fetchMock = membersServer([ME_ADMIN()], ["carol@example.com", "dave@example.com"], (_url, _method, body) =>
      body?.email === "carol@example.com" ? put.promise : null,
    );
    const { dialog } = await openMembers(fetchMock);
    submitEmails(dialog, "carol@example.com dave@example.com");
    const bulkDialog = await screen.findByRole("dialog", { name: "Add members" });
    await within(bulkDialog).findByRole("button", { name: "Stop" });

    fireEvent.click(within(bulkDialog).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add members" })).not.toBeInTheDocument());
    const input = within(dialog).getByLabelText("Email address");
    await waitFor(() => expect(input).toHaveFocus());
    // 還在等 carol 那一筆：匯入鈕擋著（aria-disabled，按了不開）
    const importButton = within(dialog).getByRole("button", { name: "Import from another group…" });
    expect(importButton).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(importButton);
    expect(screen.queryByRole("dialog", { name: "Import members from another group" })).not.toBeInTheDocument();

    await act(async () => put.release(ok(member("u-carol", "carol@example.com", "Carol", MEMBER_ROLE), 201)));
    await waitFor(() => expect(input).toHaveValue("dave@example.com"));
    expect(putBodies(fetchMock).map((b) => b.email)).toEqual(["carol@example.com"]);
    expect(screen.queryByRole("dialog", { name: "Add members" })).not.toBeInTheDocument();
    expect(importButton).not.toHaveAttribute("aria-disabled");
  });

  it("跑到一半卸載（群組 modal 關掉）→ 正在送的那一筆之後不再送", async () => {
    const put = deferred();
    const fetchMock = membersServer([ME_ADMIN()], ["carol@example.com", "dave@example.com"], (_url, _method, body) =>
      body?.email === "carol@example.com" ? put.promise : null,
    );
    const { dialog, view } = await openMembers(fetchMock);
    submitEmails(dialog, "carol@example.com dave@example.com");
    await within(await screen.findByRole("dialog", { name: "Add members" })).findByRole("button", { name: "Stop" });

    view.unmount();
    await act(async () => put.release(ok(member("u-carol", "carol@example.com", "Carol", MEMBER_ROLE), 201)));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(putBodies(fetchMock).map((b) => b.email)).toEqual(["carol@example.com"]);
  });

  it("防重入：同一個 tick 送出兩次 → 只跑一輪（每個地址只送一次，結果照常顯示）", async () => {
    const fetchMock = membersServer([ME_ADMIN()], ["carol@example.com", "dave@example.com"]);
    const { dialog } = await openMembers(fetchMock);
    fireEvent.change(within(dialog).getByLabelText("Email address"), { target: { value: "carol@example.com dave@example.com" } });
    const form = within(dialog).getByLabelText("Email address").closest("form")!;
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    const bulkDialog = await resultDialog();
    expect(outcomeSummary(bulkDialog, "added")?.emails).toEqual(["carol@example.com", "dave@example.com"]);
    expect(putBodies(fetchMock).map((b) => b.email)).toEqual(["carol@example.com", "dave@example.com"]);
  });

  it("結果清單：email 一行一個；超過 5 個的那一類才可捲動（tabIndex＋以類別標題命名），5 個以內不捲", async () => {
    const six = Array.from({ length: 6 }, (_, i) => `u${i + 1}@example.com`);
    const five = Array.from({ length: 5 }, (_, i) => `g${i + 1}@nowhere.test`);
    const fetchMock = membersServer([ME_ADMIN()], six);
    const { dialog } = await openMembers(fetchMock);
    submitEmails(dialog, [...six, ...five].join(" "));
    const bulkDialog = await resultDialog();

    expect(outcomeSummary(bulkDialog, "added")).toEqual({ label: "Added (6):", emails: six });
    expect(outcomeSummary(bulkDialog, "notFound")).toEqual({ label: "No account with this email (5):", emails: five });

    const scrolling = within(outcomeRow(bulkDialog, "added")!).getByRole("list");
    expect(scrolling).toHaveAttribute("tabindex", "0");
    expect(scrolling).toHaveAccessibleName("Added (6):");
    expect(scrolling.className).toContain("overflow-y-auto");
    expect(scrolling).toHaveClass("leading-5", "text-muted-foreground");

    const plain = within(outcomeRow(bulkDialog, "notFound")!).getByRole("list");
    expect(plain).not.toHaveAttribute("tabindex");
    expect(plain).not.toHaveAttribute("aria-labelledby");
    expect(plain.className).not.toContain("overflow-y-auto");
    expect(plain).toHaveClass("leading-5", "text-muted-foreground");
    // email 不進 live region
    expect(within(bulkDialog).getByRole("status")).not.toHaveTextContent("@");
  });

  it("從其他群組匯入：列其他群組 → 選一個 → 勾選清單（預設全勾，排除已在這裡的人與自己）→ 取消一位 → 確認 → 同一個對話框換成進度與結果 → 完成、焦點回匯入鈕", async () => {
    const initial = [ME_ADMIN(), member("u-bob", "bob@example.com", "Bob", MEMBER_ROLE)];
    const sourceMembers = [
      member(ME.id, ME.email, "Me", MEMBER_ROLE),
      member("u-bob", "bob@example.com", "Bob", MEMBER_ROLE),
      member("u-carol", "carol@example.com", "Carol", MEMBER_ROLE),
      member("u-dave", "dave@example.com", "Dave", MEMBER_ROLE),
      member("u-erin", "erin@example.com", "Erin", ADMIN_ROLE),
    ];
    const fetchMock = membersServer(initial, ["carol@example.com", "erin@example.com"], (url, method) =>
      url === `/api/groups/${SOURCE.id}/members` && method === "GET" ? ok(sourceMembers) : null,
    );
    const { dialog } = await openMembers(fetchMock);
    fireEvent.change(within(dialog).getByLabelText("Role for new member"), { target: { value: ADMIN_ROLE.id } });

    fireEvent.click(within(dialog).getByRole("button", { name: "Import from another group…" }));
    const importDialog = await screen.findByRole("dialog", { name: "Import members from another group" });
    expect(within(importDialog).getByText(/added to this group as Admin\. This is a one-time copy/)).toBeInTheDocument();
    const source = within(importDialog).getByLabelText("Group to import from");
    // 只列其他群組（不含目前這個）
    expect(within(source).getAllByRole("option").map((o) => o.textContent)).toEqual(["Choose a group…", "Team Source"]);
    fireEvent.change(source, { target: { value: SOURCE.id } });

    const list = await within(importDialog).findByRole("list", { name: "People to add" });
    const boxes = within(list).getAllByRole("checkbox");
    expect(boxes.map((b) => b.getAttribute("aria-label"))).toEqual(["carol@example.com", "dave@example.com", "erin@example.com"]);
    for (const box of boxes) expect(box).toBeChecked();
    expect(within(importDialog).getByRole("button", { name: "Add 3 people" })).toBeEnabled();

    fireEvent.click(within(list).getByRole("checkbox", { name: "dave@example.com" }));
    fireEvent.click(within(importDialog).getByRole("button", { name: "Add 2 people" }));

    // 對話框不關：同一個對話框換成結果
    const bulkDialog = await resultDialog("Import members from another group");
    expect(bulkDialog).toBe(importDialog);
    expect(outcomeSummary(bulkDialog, "added")?.emails).toEqual(["carol@example.com", "erin@example.com"]);
    expect(putBodies(fetchMock)).toEqual([
      { email: "carol@example.com", roleId: ADMIN_ROLE.id },
      { email: "erin@example.com", roleId: ADMIN_ROLE.id },
    ]);
    // 角色重設規則同輸入框那條：沒有東西放回輸入框 → 重設；說明文字仍是開跑時的角色
    expect(within(dialog).getByLabelText("Role for new member")).toHaveValue(MEMBER_ROLE.id);
    expect(within(bulkDialog).getByText(/added to this group as Admin\./)).toBeInTheDocument();
    await waitFor(() => expect(within(dialog).getByText("erin@example.com")).toBeInTheDocument());

    fireEvent.click(within(bulkDialog).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Import members from another group" })).not.toBeInTheDocument());
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "Import from another group…" })).toHaveFocus());
  });

  it("匯入路徑：確認後焦點移到「停止」；停下（500）→ 沒加成的接在輸入框原內容後面", async () => {
    const sourceMembers = [
      member("u-carol", "carol@example.com", "Carol", MEMBER_ROLE),
      member("u-boom", "boom@example.com", "Boom", MEMBER_ROLE),
      member("u-dave", "dave@example.com", "Dave", MEMBER_ROLE),
    ];
    const put = deferred();
    const fetchMock = membersServer([ME_ADMIN()], ["carol@example.com", "dave@example.com"], (url, method, body) => {
      if (url === `/api/groups/${SOURCE.id}/members` && method === "GET") return ok(sourceMembers);
      return body?.email === "carol@example.com" ? put.promise : null;
    });
    const { dialog } = await openMembers(fetchMock);
    fireEvent.change(within(dialog).getByLabelText("Email address"), { target: { value: "typed@example.com" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Import from another group…" }));
    const importDialog = await screen.findByRole("dialog", { name: "Import members from another group" });
    fireEvent.change(within(importDialog).getByLabelText("Group to import from"), { target: { value: SOURCE.id } });
    fireEvent.click(await within(importDialog).findByRole("button", { name: "Add 3 people" }));
    // 確認鈕被換掉：焦點不能掉到 body，移到「停止」
    await waitFor(() => expect(within(importDialog).getByRole("button", { name: "Stop" })).toHaveFocus());
    await act(async () => put.release(ok(member("u-carol", "carol@example.com", "Carol", MEMBER_ROLE), 201)));

    const bulkDialog = await resultDialog("Import members from another group");
    expect(resultMessage(bulkDialog)).toHaveTextContent(/^Stopped: Something went wrong/);
    expect(putBodies(fetchMock).map((b) => b.email)).toEqual(["carol@example.com", "boom@example.com"]);
    expect(within(dialog).getByLabelText("Email address")).toHaveValue("typed@example.com, boom@example.com, dave@example.com");
  });

  it("匯入全部成功、但輸入框還有使用者打的地址 → 不重設角色（那些還要用他選的角色加），輸入框原樣", async () => {
    const sourceMembers = [member("u-carol", "carol@example.com", "Carol", MEMBER_ROLE)];
    const fetchMock = membersServer([ME_ADMIN()], ["carol@example.com"], (url, method) =>
      url === `/api/groups/${SOURCE.id}/members` && method === "GET" ? ok(sourceMembers) : null,
    );
    const { dialog } = await openMembers(fetchMock);
    fireEvent.change(within(dialog).getByLabelText("Role for new member"), { target: { value: ADMIN_ROLE.id } });
    fireEvent.change(within(dialog).getByLabelText("Email address"), { target: { value: "typed@example.com " } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Import from another group…" }));
    const importDialog = await screen.findByRole("dialog", { name: "Import members from another group" });
    fireEvent.change(within(importDialog).getByLabelText("Group to import from"), { target: { value: SOURCE.id } });
    fireEvent.click(await within(importDialog).findByRole("button", { name: "Add 1 person" }));

    const bulkDialog = await resultDialog("Import members from another group");
    expect(outcomeSummary(bulkDialog, "added")).toEqual({ label: "Added (1):", emails: ["carol@example.com"] });
    expect(within(dialog).getByLabelText("Role for new member")).toHaveValue(ADMIN_ROLE.id);
    expect(within(dialog).getByLabelText("Email address")).toHaveValue("typed@example.com ");
  });

  it("匯入：來源群組的成員載入失敗 → 對話框裡顯示錯誤、沒有勾選清單", async () => {
    const fetchMock = membersServer([ME_ADMIN()], [], (url, method) =>
      url === `/api/groups/${SOURCE.id}/members` && method === "GET" ? fail(500, "internal") : null,
    );
    const { dialog } = await openMembers(fetchMock);
    fireEvent.click(within(dialog).getByRole("button", { name: "Import from another group…" }));
    const importDialog = await screen.findByRole("dialog", { name: "Import members from another group" });
    fireEvent.change(within(importDialog).getByLabelText("Group to import from"), { target: { value: SOURCE.id } });
    expect(await within(importDialog).findByRole("alert")).toHaveTextContent("An unexpected error occurred.");
    expect(within(importDialog).queryByRole("list", { name: "People to add" })).not.toBeInTheDocument();
  });

  it("匯入：全選框可全部取消（確認鈕 disabled）再全選；取消 → 關閉、不送", async () => {
    const sourceMembers = [member("u-carol", "carol@example.com", "Carol", MEMBER_ROLE), member("u-dave", "dave@example.com", "Dave", MEMBER_ROLE)];
    const fetchMock = membersServer([ME_ADMIN()], [], (url, method) =>
      url === `/api/groups/${SOURCE.id}/members` && method === "GET" ? ok(sourceMembers) : null,
    );
    const { dialog } = await openMembers(fetchMock);
    fireEvent.click(within(dialog).getByRole("button", { name: "Import from another group…" }));
    const importDialog = await screen.findByRole("dialog", { name: "Import members from another group" });
    fireEvent.change(within(importDialog).getByLabelText("Group to import from"), { target: { value: SOURCE.id } });
    const all = await within(importDialog).findByRole("checkbox", { name: "Select all (2)" });
    fireEvent.click(all);
    expect(within(importDialog).getByRole("button", { name: "Add 0 people" })).toBeDisabled();
    fireEvent.click(all);
    expect(within(importDialog).getByRole("button", { name: "Add 2 people" })).toBeEnabled();
    fireEvent.click(within(importDialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Import members from another group" })).not.toBeInTheDocument());
    expect(putBodies(fetchMock)).toHaveLength(0);
  });

  it("匯入：我不在其他群組 → 說明文字、沒有下拉", async () => {
    const fetchMock = groupFetch(() => [GROUP_ADMIN], () => [ME_ADMIN()]);
    renderGroupRoute(`/groups/${GROUP_ADMIN.id}`, fetchMock);
    const dialog = await screen.findByRole("dialog", { name: GROUP_ADMIN.name });
    fireEvent.click(await within(dialog).findByRole("button", { name: "Import from another group…" }));
    const importDialog = await screen.findByRole("dialog", { name: "Import members from another group" });
    expect(within(importDialog).getByText("You're not in any other group.")).toBeInTheDocument();
    expect(within(importDialog).queryByLabelText("Group to import from")).not.toBeInTheDocument();
  });

  it("沒有管理成員的權限 → 沒有匯入鈕", async () => {
    renderGroupRoute(`/groups/${GROUP_MEMBER.id}`, groupFetch(() => [GROUP_MEMBER], () => [member(ME.id, ME.email, "Me", MEMBER_ROLE)]));
    const dialog = await screen.findByRole("dialog", { name: GROUP_MEMBER.name });
    await within(dialog).findByText(ME.email);
    expect(within(dialog).queryByRole("button", { name: "Import from another group…" })).not.toBeInTheDocument();
  });
});
