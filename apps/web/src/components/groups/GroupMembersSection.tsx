import { useEffect, useId, useRef, useState, type ClipboardEvent, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { normalizeEmail, type GroupDto, type GroupMemberDto, type GroupRoleDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import {
  addGroupMember, useAddMember, useGroupMembers, useGroupRoles, useInvalidateGroupsAndNotes, useRemoveMember, useSetMemberRole,
} from "@/api/groups";
import { useSession } from "@/auth/useSession";
import { SettingsTable, type SettingsTableColumn, type SettingsTableRow } from "@/components/management/SettingsTable";
import { Button } from "@/components/ui/button";
import { Trash } from "@/components/ui/icons";
import { RowIconButton } from "@/components/ui/row-icon-button";
import { toast } from "@/components/ui/toast";
import { UserEmailCombobox } from "@/components/UserEmailCombobox";
import { roleLabel } from "@/lib/group-role";
import { SettingsGroup, SettingsPage } from "@/settings/SettingsLayout";
import { useGroupOutlet } from "./group-outlet";
import { BulkAddDialog, type BulkAddMode, type BulkAddState } from "./BulkAddDialog";
import { parseEmailList, runBulkAdd, type BulkAddOutcome, type BulkAddResult } from "./bulk-add";

/** 跑完後放回（或留在）輸入框的：沒加成、可以修正或再試的。已加入與已是成員的不放回。 */
const KEEP_IN_BOX: ReadonlySet<BulkAddOutcome> = new Set(["invalid", "notFound", "failed", "notProcessed"]);

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

const SELECT_CLASS =
  "h-8 shrink-0 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none " +
  "focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/** 名單裡掛內建管理員角色的人數（spec §8.5「看 `builtin === "admin"` 計數」）。 */
function countAdmins(members: GroupMemberDto[]): number {
  return members.filter((member) => member.builtin === "admin").length;
}

/** 成員目前角色的顯示名：優先用 `GET …/roles` 的那一列（自訂角色要它的 `name`）；roles 還沒到時退回 `builtin`。 */
function memberRoleLabel(t: (key: string) => string, roles: GroupRoleDto[], member: GroupMemberDto): string {
  return roleLabel(t, roles.find((role) => role.id === member.roleId) ?? { builtin: member.builtin, name: null });
}

/**
 * 成員表（spec 2026-10-13 settings-table §3 #8）：名稱｜Email｜角色（`canManageMembers` 時是下拉，否則純文字）｜操作（移除；只在有管理權時有這欄）。
 * 列名以 email 為準（`nameColumn="email"`）；移除鈕與角色下拉的名稱也帶 email（各自的 aria-label）。最後一位管理員那列：角色下拉原生 disabled＋title、
 * 移除鈕 softDisabled＋原因（spec §2.7）。角色下拉的選項與送出的值都是 `GET …/roles` 的**角色 id**（spec §8.5；gate r2 M-7：
 * 兩位管理員、沒有一般成員的群組，一般成員角色的 id 只拿得到那裡）。下拉列全部角色、含內建管理員（不防升權，Q9）。
 * #183：很長的 email 交給表格的 text 欄（wrap-anywhere、14ch 下限）與框內橫向捲動，不再把面板撐寬；移除鈕的可見文字不帶 email。
 */
function MembersSection({ group, canManageMembers }: { group: GroupDto; canManageMembers: boolean }) {
  const { t } = useTranslation();
  const membersQuery = useGroupMembers(group.id);
  const rolesQuery = useGroupRoles(group.id);
  const setRole = useSetMemberRole(group.id);
  const removeMember = useRemoveMember(group.id);
  const addMember = useAddMember(group.id);
  const [email, setEmail] = useState("");
  // null＝還沒選過：用內建一般成員那一個的 id；roles 還沒到時不送 roleId（server 預設內建一般成員）
  const [pickedRoleId, setPickedRoleId] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  // 批次加入的對話框（`BulkAddDialog`）：`mode` 在關閉後保留，免得關閉那一刻標題先換掉
  // （專案目前沒有 animate-out 的 keyframes，Radix 立即卸載；日後加了關閉動畫，`closeDialog` 的 `setBulk(null)` 會讓內容閃回挑人畫面，要一起改）
  const [dialog, setDialog] = useState<{ open: boolean; mode: BulkAddMode }>({ open: false, mode: "input" });
  const [bulk, setBulk] = useState<BulkAddState | null>(null);
  // 一輪批次還在送（含對話框已關、正在等最後那一筆）：鎖輸入框、擋再開一輪。ref 版給防重入（同一個 tick 連按時 state 還沒更新）
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // 每開／關一次對話框加一：一輪跑完時對話框已關（或已是另一次打開），就不再寫進度與結果
  const dialogSessionRef = useRef(0);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const importButtonRef = useRef<HTMLButtonElement>(null);
  const emailHintId = useId();
  const invalidateAfterBulk = useInvalidateGroupsAndNotes();
  const myUserId = useSession().user?.id;

  // 卸載（關掉群組 modal、換頁）＝停止：正在送的那一筆跑完就不再送
  useEffect(() => {
    const abort = abortRef;
    return () => abort.current?.abort();
  }, []);

  const members = membersQuery.data ?? [];
  const roles = rolesQuery.data ?? [];
  const adminCount = countAdmins(members);
  const isLastAdmin = (member: GroupMemberDto) => member.builtin === "admin" && adminCount === 1;
  const newRoleId = pickedRoleId ?? roles.find((role) => role.builtin === "member")?.id;
  const newRole = roles.find((role) => role.id === newRoleId);
  const newRoleName = newRole ? roleLabel(t, newRole) : roleLabel(t, { builtin: "member", name: null });

  async function handleRole(member: GroupMemberDto, roleId: string): Promise<void> {
    try {
      await setRole.mutateAsync({ userId: member.userId, roleId });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  async function handleRemove(member: GroupMemberDto): Promise<void> {
    try {
      await removeMember.mutateAsync(member.userId);
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  function openDialog(mode: BulkAddMode): void {
    dialogSessionRef.current += 1;
    setBulk(null);
    setDialog({ open: true, mode });
  }

  /** 完成、取消、Esc、✕ 都走這裡；跑到一半關掉＝停止（正在送的那一筆跑完，其餘放回輸入框）。 */
  function closeDialog(): void {
    abortRef.current?.abort();
    dialogSessionRef.current += 1;
    setDialog((prev) => ({ ...prev, open: false }));
    setBulk(null);
  }

  function stopBulk(): void {
    abortRef.current?.abort();
    setBulk((prev) => (prev && prev.report === null ? { ...prev, stopping: true } : prev));
  }

  /**
   * 批次加入（貼多個地址、或從其他群組匯入），進度與結果都在 `BulkAddDialog`：已在名單裡的先記「已是成員」不送；
   * 其餘依序 `PUT`（`bulk-add.ts`），全部用加人表單目前選的角色。整批結束才失效一次快取（同單人加入的三把 key）。
   * 跑完後沒加成的（格式不對、沒有帳號、失敗、未處理）依原順序放回輸入框方便修正或再試：輸入框那條路徑取代原內容
   * （跑的期間輸入框鎖住，內容就是這一批），匯入那條接在原內容後面。角色重設的規則與單人加入一致：
   * 跑完後輸入框是空的才重設回預設角色（匯入那條也算進輸入框原有、使用者還沒送出的地址：那些還要用他選的角色加）。
   * `order`＝放回時的順序（輸入框那條是原輸入順序）。
   * 防重入由兩個入口在開對話框之前擋（`handleAdd`、匯入鈕）：`runningRef` 在這裡同步設起來，同一個 tick 的第二次就進不來；
   * 開頭再擋一次是防禦（匯入確認鈕靠下一次 render 換掉）。
   */
  async function runBulk(emails: string[], pre: BulkAddResult[], mode: BulkAddMode, order: readonly string[] = emails): Promise<void> {
    if (runningRef.current) return;
    runningRef.current = true;
    // 跑的期間輸入框 readOnly，這個值到跑完都不會變
    const boxBefore = email.trim();
    setRunning(true);
    const session = dialogSessionRef.current;
    const showing = () => dialogSessionRef.current === session;
    const controller = new AbortController();
    abortRef.current = controller;
    const existing = new Set(members.map((member) => normalizeEmail(member.email)));
    const already = emails.filter((address) => existing.has(normalizeEmail(address)));
    const toSend = emails.filter((address) => !existing.has(normalizeEmail(address)));
    const skipped: BulkAddResult[] = [...pre, ...already.map((address) => ({ email: address, outcome: "alreadyMember" as const }))];
    const roleId = newRoleId;
    const roleName = newRoleName;
    setAddError(null);
    setBulk({ done: 0, total: toSend.length, roleName, stopping: false, keptInBox: false, report: null });
    let report;
    try {
      report = await runBulkAdd(
        toSend,
        (address) => addGroupMember(group.id, roleId === undefined ? { email: address } : { email: address, roleId }),
        (done, total) => {
          if (showing()) setBulk((prev) => prev && { ...prev, done, total });
        },
        controller.signal,
      );
    } finally {
      if (toSend.length > 0) invalidateAfterBulk();
      if (abortRef.current === controller) abortRef.current = null;
      runningRef.current = false;
      setRunning(false);
    }
    const results = [...skipped, ...report.results];
    const keepKeys = new Set(results.filter((r) => KEEP_IN_BOX.has(r.outcome)).map((r) => normalizeEmail(r.email)));
    const kept = order.filter((address) => keepKeys.has(normalizeEmail(address))).join(", ");
    const boxAfter = mode === "input" || boxBefore === "" ? kept : kept === "" ? boxBefore : `${boxBefore}, ${kept}`;
    if (mode === "input" || kept !== "") setEmail(boxAfter);
    if (boxAfter === "") setPickedRoleId(null);
    if (showing()) {
      setBulk({ done: toSend.length, total: toSend.length, roleName, stopping: false, keptInBox: kept !== "", report: { ...report, results } });
    }
  }

  /** 從試算表或信件貼一欄地址：單行輸入框會把換行吃掉（地址黏在一起），這裡改成逗號。 */
  function handlePaste(event: ClipboardEvent<HTMLInputElement>): void {
    const text = event.clipboardData.getData("text");
    // 跑的期間輸入框 readOnly：瀏覽器照樣送 paste 事件，這裡不能替它改值
    if (event.currentTarget.readOnly || !/[\r\n]/.test(text)) return;
    event.preventDefault();
    const input = event.currentTarget;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    setEmail(input.value.slice(0, start) + text.trim().split(/[\r\n]+/).join(", ") + input.value.slice(end));
  }

  async function handleAdd(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (runningRef.current) return;
    setAddError(null);
    const parsed = parseEmailList(email);
    if (parsed.all.length > 1) {
      openDialog("input");
      await runBulk(parsed.emails, parsed.invalid.map((token) => ({ email: token, outcome: "invalid" as const })), "input", parsed.all);
      return;
    }
    if (parsed.invalid.length === 1) {
      setAddError(t("groups.bulk.invalidSingle", { value: parsed.invalid[0] }));
      return;
    }
    const trimmed = parsed.emails[0];
    if (trimmed === undefined) return;
    try {
      await addMember.mutateAsync(newRoleId === undefined ? { email: trimmed } : { email: trimmed, roleId: newRoleId });
      setEmail("");
      setPickedRoleId(null);
    } catch (err) {
      setAddError(errorMessage(t, err));
    }
  }

  const columns: SettingsTableColumn[] = [
    { id: "name", header: t("groups.detail.tableName"), kind: "primary", grow: 1 },
    { id: "email", header: t("groups.detail.tableEmail"), kind: "text", grow: 1.5 },
    { id: "role", header: t("groups.detail.tableRole"), kind: canManageMembers ? "control" : "fixed" },
  ];
  if (canManageMembers) columns.push({ id: "actions", header: t("groups.detail.tableActions"), kind: "actions", buttons: 1 });
  const rows: SettingsTableRow[] = members.map((member) => {
    const locked = isLastAdmin(member);
    return {
      id: member.userId,
      primary: { name: member.displayName },
      cells: {
        // A8：成員彼此看得到 email——要收回就刪這一欄（連同 nameColumn 改回主欄；server 建議的 ① 同群組成員也要一起收，見 routes/users.ts）
        email: { content: member.email, tone: "muted" },
        role: canManageMembers ? (
          <select
            aria-label={t("groups.detail.roleLabel", { email: member.email })}
            value={member.roleId}
            // roles 還沒到：只有目前角色那一個選項可顯示，先鎖住
            disabled={locked || setRole.isPending || roles.length === 0}
            title={locked ? t("groups.detail.lastAdminHint") : undefined}
            onChange={(event) => void handleRole(member, event.target.value)}
            className={SELECT_CLASS}
          >
            {roles.length === 0 ? (
              <option value={member.roleId}>{memberRoleLabel(t, roles, member)}</option>
            ) : (
              roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {roleLabel(t, role)}
                </option>
              ))
            )}
          </select>
        ) : (
          memberRoleLabel(t, roles, member)
        ),
      },
      actions: canManageMembers ? (
        <RowIconButton
          label={t("groups.detail.remove", { email: member.email })}
          tone="destructive"
          icon={<Trash className="h-4 w-4" />}
          softDisabled={locked}
          softDisabledReason={t("groups.detail.lastAdminHint")}
          disabled={removeMember.isPending}
          onClick={() => void handleRemove(member)}
        />
      ) : undefined,
    };
  });

  return (
    <SettingsGroup>
      {membersQuery.isPending ? (
        <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
      ) : membersQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(t, membersQuery.error)}
        </p>
      ) : (
        <SettingsTable label={t("groups.nav.members")} nameColumn="email" columns={columns} rows={rows} />
      )}

      {/* 最後一位管理員的提示：移除鈕是 `aria-disabled`（`title` 浮得出來），但角色下拉仍是原生 disabled、
          `title` 浮不出來——所以照留看得見的文字。 */}
      {canManageMembers && adminCount === 1 && !membersQuery.isPending && (
        <p className="mt-2 text-xs text-muted-foreground">{t("groups.detail.lastAdminHint")}</p>
      )}

      {canManageMembers && (
        <>
          <form onSubmit={(event) => void handleAdd(event)} className="mt-4 flex items-center gap-2">
            {/* 收多個地址（逗號／分號／空白／換行分隔），所以是 multiple（text 而不是 email：後者的原生驗證會擋下多個地址）；
                「認識的人」建議只查、只換游標所在的那一個地址，已是成員與框裡已有的不再建議 */}
            {/* 跑的期間 readOnly（不是 disabled）：跑完要把沒加成的地址寫回來，使用者這時打的字會被蓋掉；
                對話框跑到一半被關掉時焦點還回這裡，disabled 收不到焦點。唯讀時也不開建議清單 */}
            <UserEmailCombobox
              ref={emailInputRef}
              multiple
              readOnly={running}
              label={t("groups.detail.addEmailLabel")}
              placeholder={t("groups.bulk.addEmailsPlaceholder")}
              aria-describedby={emailHintId}
              value={email}
              onChange={setEmail}
              onPaste={handlePaste}
              excludeUserIds={members.map((member) => member.userId)}
              className="min-w-0 max-w-md flex-1"
            />
            <span id={emailHintId} className="sr-only">
              {t("groups.bulk.addEmailsHint")}
            </span>
            <select
              aria-label={t("groups.detail.addRoleLabel")}
              value={newRoleId ?? ""}
              disabled={roles.length === 0 || running}
              onChange={(event) => setPickedRoleId(event.target.value)}
              className={SELECT_CLASS}
            >
              {roles.map((role) => (
                <option key={role.id} value={role.id}>
                  {roleLabel(t, role)}
                </option>
              ))}
            </select>
            <Button type="submit" variant="outline" disabled={addMember.isPending || running}>
              {t("groups.detail.add")}
            </Button>
          </form>
          {addError && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {addError}
            </p>
          )}
          <div className="mt-2">
            {/* 跑的期間用 aria-disabled（不是 disabled）：匯入對話框跑到一半被關掉時焦點還回這顆 */}
            <Button
              ref={importButtonRef}
              type="button"
              variant="outline"
              disabled={membersQuery.isPending}
              aria-disabled={running || undefined}
              className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
              onClick={() => {
                if (!runningRef.current) openDialog("import");
              }}
            >
              {t("groups.bulk.importOpen")}
            </Button>
          </div>
          <BulkAddDialog
            open={dialog.open}
            mode={dialog.mode}
            bulk={bulk}
            groupId={group.id}
            currentMemberIds={new Set(members.map((member) => member.userId))}
            myUserId={myUserId}
            roleName={newRoleName}
            onImport={(emails) => void runBulk(emails, [], "import")}
            onStop={stopBulk}
            onClose={closeDialog}
            returnFocusRef={dialog.mode === "import" ? importButtonRef : emailInputRef}
          />
        </>
      )}
    </SettingsGroup>
  );
}

/**
 * 群組 modal「成員」（`/groups/:id`，#247 §6.2）：成員表（`canManageMembers` 有角色下拉、紅垃圾桶移除、加人；否則唯讀）。
 * 最後一位管理員那列：角色下拉 disabled、移除鈕 `aria-disabled`＋`opacity-40`＋`title`（§4.9）。名稱、用量、危險區不在這頁。
 */
export function GroupMembersSection() {
  const { t } = useTranslation();
  const group = useGroupOutlet();
  return (
    <SettingsPage
      title={t("groups.nav.members")}
      description={group.canManageMembers ? t("groups.detail.membersDescriptionAdmin") : t("groups.detail.membersDescriptionMember")}
    >
      <MembersSection group={group} canManageMembers={group.canManageMembers} />
    </SettingsPage>
  );
}
