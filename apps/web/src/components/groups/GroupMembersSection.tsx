import { useEffect, useId, useRef, useState, type ClipboardEvent, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n/groups-admin-strings";
import { useLocation, useNavigate, type Location } from "react-router";
import { normalizeEmail, type GroupDto, type GroupMemberDto, type GroupRoleDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import {
  addGroupMember, useAddMember, useGroupMembers, useGroupRoles, useInvalidateGroupsAndNotes, useRemoveMember, useSetMemberRole,
} from "@/api/groups";
import { useSession } from "@/auth/useSession";
import { SettingsTable, type SettingsTableColumn, type SettingsTableRow } from "@/components/management/SettingsTable";
import { Avatar } from "@/components/Avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Trash } from "@/components/ui/icons";
import { Select } from "@/components/ui/select";
import { RowIconButton } from "@/components/ui/row-icon-button";
import { toast } from "@/components/ui/toast";
import { UserEmailCombobox } from "@/components/UserEmailCombobox";
import { roleLabel } from "@/lib/group-role";
import { SettingsGroup, SettingsPage } from "@/settings/SettingsLayout";
import { useGroupOutlet } from "./group-outlet";
import { afterLeaveTarget } from "./GroupAboutSection";
import { BulkAddDialog, type BulkAddMode, type BulkAddState } from "./BulkAddDialog";
import { parseEmailList, runBulkAdd, type BulkAddOutcome, type BulkAddResult } from "./bulk-add";

/** Outcomes worth fixing or retrying go back into the box after a run. */
const KEEP_IN_BOX: ReadonlySet<BulkAddOutcome> = new Set(["invalid", "notFound", "failed", "notProcessed"]);

function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

function countAdmins(members: GroupMemberDto[]): number {
  return members.filter((member) => member.builtin === "admin").length;
}

/** Prefers the `GET …/roles` row (a custom role needs its `name`); falls back to `builtin` until roles load. */
function memberRoleLabel(t: (key: string) => string, roles: GroupRoleDto[], member: GroupMemberDto): string {
  return roleLabel(t, roles.find((role) => role.id === member.roleId) ?? { builtin: member.builtin, name: null });
}

/**
 * Role select options and values are role ids from `GET …/roles` (the normal member role id is only available there,
 * e.g. in a group with two admins and no normal members). All roles are listed, including builtin admin (no escalation
 * guard here). Long emails wrap in the table's text column and scroll inside the box instead of widening the panel (#183).
 */
function MembersSection({ group, canManageMembers }: { group: GroupDto; canManageMembers: boolean }) {
  const { t } = useTranslation();
  const membersQuery = useGroupMembers(group.id);
  const rolesQuery = useGroupRoles(group.id);
  const setRole = useSetMemberRole(group.id);
  const removeMember = useRemoveMember(group.id);
  const addMember = useAddMember(group.id);
  const [email, setEmail] = useState("");
  // null = never picked: use the builtin normal member's id; without roles loaded no roleId is sent (server defaults it).
  const [pickedRoleId, setPickedRoleId] = useState<string | null>(null);
  const [addError, setAddError] = useState<string | null>(null);
  // `mode` is kept after close so the title doesn't change at the moment of closing. Radix unmounts immediately (no
  // animate-out keyframes); if a close animation is added, `closeDialog`'s `setBulk(null)` would flash the picker.
  const [dialog, setDialog] = useState<{ open: boolean; mode: BulkAddMode }>({ open: false, mode: "input" });
  const [bulk, setBulk] = useState<BulkAddState | null>(null);
  // A run is still sending (even after the dialog closed, waiting for the last request): lock the box and block another run.
  // The ref guards re-entry: state is still stale for a second click in the same tick.
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  // Bumped on every dialog open/close: a run that finishes after the dialog closed (or reopened) writes no progress or results.
  const dialogSessionRef = useRef(0);
  const emailInputRef = useRef<HTMLInputElement>(null);
  const importButtonRef = useRef<HTMLButtonElement>(null);
  const emailHintId = useId();
  const invalidateAfterBulk = useInvalidateGroupsAndNotes();
  const myUserId = useSession().user?.id;
  const navigate = useNavigate();
  const backgroundLocation = (useLocation().state as { backgroundLocation?: Location } | null)?.backgroundLocation;
  // Remove asks for confirmation first, like leaving a group (#395); null = not confirming.
  const [pendingRemove, setPendingRemove] = useState<GroupMemberDto | null>(null);

  // Unmount stops the run: the in-flight request finishes, no more are sent.
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

  /** Removing yourself = leaving the group: on success navigate away like leaving does (`afterLeaveTarget`). */
  async function handleRemove(member: GroupMemberDto): Promise<void> {
    try {
      await removeMember.mutateAsync(member.userId);
      setPendingRemove(null);
      if (member.userId === myUserId) navigate(afterLeaveTarget(group.id, backgroundLocation));
    } catch (err) {
      setPendingRemove(null);
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  function openDialog(mode: BulkAddMode): void {
    dialogSessionRef.current += 1;
    setBulk(null);
    setDialog({ open: true, mode });
  }

  /** Closing mid-run stops it: the in-flight request finishes, the rest go back to the box. */
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
   * Caches are invalidated once at the end (same keys as a single add).
   * Addresses not added (invalid, no account, failed, not processed) go back to the box in `order` (the original input
   * order on the box path) for fixing or retrying:
   * the box path replaces the box (it is locked during the run, so its content is this batch), the import path appends.
   * As with a single add, the role resets to the default only if the box is empty afterwards; on the import path the
   * addresses already typed in the box count, since they still need the picked role.
   * Re-entry is blocked by both entry points (`handleAdd`, the import button) before the dialog opens: `runningRef` is set
   * synchronously so a second call in the same tick can't enter; the check at the top is defensive (the import confirm
   * button only changes on the next render).
   */
  async function runBulk(emails: string[], pre: BulkAddResult[], mode: BulkAddMode, order: readonly string[] = emails): Promise<void> {
    if (runningRef.current) return;
    runningRef.current = true;
    // The box is readOnly during the run, so this value holds until it ends.
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

  /** A column pasted from a spreadsheet or mail: the single-line input would drop the newlines and glue addresses, so use commas. */
  function handlePaste(event: ClipboardEvent<HTMLInputElement>): void {
    const text = event.clipboardData.getData("text");
    // readOnly during a run: the browser still fires paste, so don't rewrite the value here.
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
      primary: { name: member.displayName, icon: <Avatar name={member.displayName} avatar={member.avatar ?? null} size={24} /> },
      cells: {
        // Members can see each other's emails. To withdraw that, delete this column (and move nameColumn back to the main
        // column), and also withdraw the server's same-group-member lookup (see routes/users.ts).
        email: { content: member.email, tone: "muted" },
        role: canManageMembers ? (
          <Select
            variant="inline"
            aria-label={t("groups.detail.roleLabel", { email: member.email })}
            value={member.roleId}
            // Roles not loaded: only the current role's option can render, so lock.
            disabled={locked || setRole.isPending || roles.length === 0}
            title={locked ? t("groups.detail.lastAdminHint") : undefined}
            onValueChange={(roleId) => void handleRole(member, roleId)}
            options={
              roles.length === 0
                ? [{ value: member.roleId, label: memberRoleLabel(t, roles, member) }]
                : roles.map((role) => ({ value: role.id, label: roleLabel(t, role) }))
            }
          />
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
          onClick={() => setPendingRemove(member)}
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

      <Dialog open={pendingRemove !== null} onOpenChange={(open) => { if (!open) setPendingRemove(null); }}>
        {pendingRemove && (
          <DialogContent>
            <DialogHeader>
              <DialogTitle>
                {pendingRemove.userId === myUserId ? t("groups.removeMember.selfTitle") : t("groups.removeMember.title")}
              </DialogTitle>
              <DialogDescription>
                {t(pendingRemove.userId === myUserId ? "groups.removeMember.selfDescription" : "groups.removeMember.description", {
                  email: pendingRemove.email,
                  name: group.name,
                })}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  {t("home.cancel")}
                </Button>
              </DialogClose>
              <Button
                type="button"
                variant="destructive"
                disabled={removeMember.isPending}
                onClick={() => void handleRemove(pendingRemove)}
              >
                {pendingRemove.userId === myUserId ? t("groups.removeMember.selfConfirm") : t("groups.removeMember.confirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      {/* Visible text: the remove button is `aria-disabled` so its `title` shows, but the role select is natively disabled and its `title` doesn't. */}
      {canManageMembers && adminCount === 1 && !membersQuery.isPending && (
        <p className="mt-2 text-xs text-muted-foreground">{t("groups.detail.lastAdminHint")}</p>
      )}

      {canManageMembers && (
        <>
          <form onSubmit={(event) => void handleAdd(event)} className="mt-4 flex items-center gap-2">
            {/* Takes several addresses (comma, semicolon, space or newline separated), so multiple, and type text (not email: native email validation rejects several addresses). "People you know" suggestions only query and replace the address at the cursor, skipping members and addresses already in the box. */}
            {/* readOnly, not disabled: typing during a run would be overwritten by the write-back, and focus returns here if the dialog closes mid-run, and disabled can't take focus. No suggestion list while readOnly. */}
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
            <Select
              variant="field"
              aria-label={t("groups.detail.addRoleLabel")}
              value={newRoleId ?? ""}
              disabled={roles.length === 0 || running}
              onValueChange={setPickedRoleId}
              options={roles.map((role) => ({ value: role.id, label: roleLabel(t, role) }))}
              className="shrink-0"
            />
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
            {/* aria-disabled, not disabled: focus returns here if the import dialog closes mid-run. */}
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
