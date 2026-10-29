import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { AdminInviteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useAuthConfig } from "@/api/authConfig";
import { ADMIN_INVITES_QUERY_KEY, useAdminInvites, useRevokeInvite } from "@/api/admin";
import { SettingsTable, type SettingsTableColumn, type SettingsTableRow } from "@/components/management/SettingsTable";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Trash } from "@/components/ui/icons";
import { RowIconButton } from "@/components/ui/row-icon-button";
import { toast } from "@/components/ui/toast";
import { SettingsGroup } from "./SettingsLayout";
import "@/i18n/management-strings";

/** 逐檔複製的既有慣例（同 SettingsUsersSection）。 */
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/** 撤銷確認（形同 ApiTokensSection 的 `RevokeDialog`）；只有 pending 列渲染。 */
function RevokeInviteDialog({ invite }: { invite: AdminInviteDto }) {
  const { t, i18n } = useTranslation();
  const revoke = useRevokeInvite();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);

  async function confirm(): Promise<void> {
    try {
      await revoke.mutateAsync(invite.id);
      setOpen(false);
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
      // 409 invite_used：這列已過時（其實用掉了），關掉確認框並重抓，讓它變成「已使用」。
      if (err instanceof ApiFail && err.code === "invite_used") {
        setOpen(false);
        void queryClient.invalidateQueries({ queryKey: ADMIN_INVITES_QUERY_KEY });
      }
    }
  }

  // 無備註時用建立時間（到秒）區分同表多顆鈕——同一分鐘連發的邀請也要不同名。
  const label =
    invite.label !== null
      ? t("admin.invites.revokeLabel", { name: invite.label })
      : t("admin.invites.revokeLabelUnlabeled", {
          when: new Date(invite.createdAt).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "medium" }),
        });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <RowIconButton label={label} tone="destructive" icon={<Trash className="h-4 w-4" aria-hidden="true" />} />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("admin.invites.revokeTitle")}</DialogTitle>
          <DialogDescription>{t("admin.invites.revokeDescription")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("home.cancel")}
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" disabled={revoke.isPending} onClick={() => void confirm()}>
            {t("admin.invites.revokeConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 使用者頁的邀請表（#285 spec §6.1）。帳密有效值關時表上方提示「未使用的邀請暫時不能用」（D2）。 */
export function InvitesGroup() {
  const { t, i18n } = useTranslation();
  const invitesQuery = useAdminInvites();
  const authConfig = useAuthConfig();
  const passwordLoginOff = authConfig.data?.passwordLogin.enabled === false;

  const columns: SettingsTableColumn[] = [
    { id: "invite", header: t("admin.invites.tableInvite"), kind: "primary", grow: 1 },
    { id: "status", header: t("admin.invites.tableStatus"), kind: "fixed" },
    { id: "expires", header: t("admin.invites.tableExpires"), kind: "fixed" },
    { id: "usedBy", header: t("admin.invites.tableUsedBy"), kind: "text", grow: 1.5 },
    { id: "actions", header: t("admin.invites.tableActions"), kind: "actions", buttons: 1 },
  ];
  const whenShort = (iso: string) => new Date(iso).toLocaleString(i18n.language, { dateStyle: "short", timeStyle: "short" });
  const rows: SettingsTableRow[] = (invitesQuery.data ?? []).map((invite) => ({
    id: invite.id,
    primary: {
      name: invite.label ?? t("admin.invites.noLabel"),
      subtitles: [
        invite.createdBy === null
          ? t("admin.invites.createdAtLine", { when: whenShort(invite.createdAt) })
          : t("admin.invites.createdByLine", { email: invite.createdBy.email, when: whenShort(invite.createdAt) }),
      ],
    },
    cells: {
      status: { content: t(`admin.invites.status.${invite.status}`), tone: invite.status === "pending" ? "default" : "muted" },
      expires: whenShort(invite.expiresAt),
      usedBy: invite.usedBy === null ? { content: "—", tone: "muted" } : invite.usedBy.email,
    },
    actions: invite.status === "pending" ? <RevokeInviteDialog invite={invite} /> : null,
  }));

  return (
    <SettingsGroup title={t("admin.invites.title")} description={t("admin.invites.tableDescription")}>
      {passwordLoginOff && (
        <p role="status" className="mb-3 text-sm text-muted-foreground">
          {t("admin.invites.suspendedNotice")}
        </p>
      )}
      {invitesQuery.isPending ? (
        <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
      ) : invitesQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(t, invitesQuery.error)}
        </p>
      ) : (
        <SettingsTable label={t("admin.invites.title")} nameColumn="invite" columns={columns} rows={rows} empty={t("admin.invites.empty")} />
      )}
    </SettingsGroup>
  );
}
