import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n/groups-admin-strings";
import { ApiFail } from "@/api/client";
import { useGroupMembers, useGroups } from "@/api/groups";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import { isRateLimited, type BulkAddOutcome, type BulkAddReport } from "./bulk-add";

export type BulkAddMode = "input" | "import";

/** `report` is null while the run is in progress. */
export interface BulkAddState {
  done: number;
  total: number;
  /** Captured at start: the add form's role resets once the run ends. */
  roleName: string;
  /** Stop was pressed; waiting for the request in flight. */
  stopping: boolean;
  /** Whether any addresses were put back into (or left in) the input box. */
  keptInBox: boolean;
  report: BulkAddReport | null;
}

type BulkAddDialogProps = {
  open: boolean;
  mode: BulkAddMode;
  /** null = import is still picking people (only `import` has this step). */
  bulk: BulkAddState | null;
  groupId: string;
  /** Source-group members already in this group aren't listed. */
  currentMemberIds: ReadonlySet<string>;
  /** Not listed; always already in this group unless a non-member site admin. */
  myUserId: string | undefined;
  roleName: string;
  /** Emails to add, in source-list order. The dialog stays open and switches to progress. */
  onImport: (emails: string[]) => void;
  onStop: () => void;
  /** Close (done, cancel, Esc, X). Closing mid-run means stop: the caller aborts. */
  onClose: () => void;
  /** The controlled Dialog has no `DialogTrigger`, so Radix won't restore focus itself. */
  returnFocusRef: RefObject<HTMLElement | null>;
};

const OUTCOMES: BulkAddOutcome[] = ["added", "alreadyMember", "notFound", "invalid", "failed", "notProcessed"];

/** Emails shown per outcome before that outcome's own list scrolls. */
const RESULT_VISIBLE_ROWS = 5;

/**
 * `dismissOnOutside={false}`: the pick step is a form, and a stray click while running would abort.
 * Results stay here: the settings modal shows no separate result and no toast.
 * The email lists sit outside the sr-only `role="status"` so they aren't read out.
 */
export function BulkAddDialog(props: BulkAddDialogProps) {
  const { t } = useTranslation();
  const listId = useId();
  const { open, mode, bulk, onClose, returnFocusRef } = props;
  const phase = bulk === null ? "pick" : bulk.report === null ? "running" : "result";
  const stopRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);

  // On open use `onOpenAutoFocus`: the Portal content isn't mounted on the first commit, so this effect would see a null ref; without it Radix
  // focuses the first focusable element, which only happens to be Stop.
  // Phase changes while open: the replaced button takes focus with it, so move focus to the new one here.
  function phaseFocusTarget(): HTMLButtonElement | null {
    if (phase === "running") return stopRef.current;
    if (phase === "result") return doneRef.current;
    return null;
  }

  useEffect(() => {
    if (phase === "running") stopRef.current?.focus();
    if (phase === "result") doneRef.current?.focus();
  }, [phase]);

  const roleName = bulk?.roleName ?? props.roleName;
  const report = bulk?.report ?? null;
  const message = report === null || bulk === null ? null : resultMessage(t, report, bulk.keptInBox);
  const groups = report === null ? [] : OUTCOMES.map((outcome) => ({
    outcome,
    emails: report.results.filter((r) => r.outcome === outcome).map((r) => r.email),
  })).filter((group) => group.emails.length > 0);
  const announcement = report === null
    ? ""
    : [message?.text, ...groups.map((group) => t(`groups.bulk.summary.${group.outcome}`, { count: group.emails.length }))]
        .filter(Boolean)
        .join(" ");

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        dismissOnOutside={false}
        onOpenAutoFocus={(event) => {
          const target = phaseFocusTarget();
          if (!target) return; // pick phase: Radix default (first focusable)
          event.preventDefault();
          target.focus();
        }}
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef.current;
          if (!target?.isConnected) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{mode === "import" ? t("groups.bulk.importTitle") : t("groups.bulk.addTitle")}</DialogTitle>
          <DialogDescription>
            {mode === "import" ? t("groups.bulk.importDescription", { role: roleName }) : t("groups.bulk.addDescription", { role: roleName })}
          </DialogDescription>
        </DialogHeader>

        {phase === "pick" && <ImportPicker {...props} />}

        {phase === "running" && bulk && (
          <div className="space-y-3">
            <p className="text-sm">{t("groups.bulk.progress", { done: bulk.done, total: bulk.total })}</p>
            <DialogFooter>
              <Button
                ref={stopRef}
                type="button"
                variant="outline"
                aria-disabled={bulk.stopping || undefined}
                className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                // Pressing again while stopping is harmless: abort and `stopping` are idempotent
                onClick={props.onStop}
              >
                {bulk.stopping ? t("groups.bulk.stopping") : t("groups.bulk.stop")}
              </Button>
            </DialogFooter>
          </div>
        )}

        {phase === "result" && (
          <div className="space-y-3">
            {message && (
              <p data-result-message className={message.tone === "error" ? "text-sm text-destructive" : "text-sm"}>
                {message.text}
              </p>
            )}
            {/* Outer cap is only a safety net (6 outcomes x 5 rows still won't push Done off screen): DialogContent itself doesn't scroll */}
            <ul className="max-h-[50vh] space-y-3 overflow-y-auto rounded-md border border-input p-3 text-sm">
              {groups.map((group) => {
                const labelId = `${listId}-${group.outcome}`;
                const scrolls = group.emails.length > RESULT_VISIBLE_ROWS;
                return (
                  <li key={group.outcome} data-outcome={group.outcome}>
                    <div
                      id={labelId}
                      className={group.outcome === "added" || group.outcome === "alreadyMember" ? "font-medium" : "font-medium text-destructive"}
                    >
                      {t(`groups.bulk.outcome.${group.outcome}`, { count: group.emails.length })}
                    </div>
                    {/* Scrolls past 5 rows (fixed 1.25rem rows, 5 rows = 6.25rem; long emails wrap, hence about 5); only a scrollable list is focusable and named by its heading, so keyboard users can reach it */}
                    <ul
                      tabIndex={scrolls ? 0 : undefined}
                      aria-labelledby={scrolls ? labelId : undefined}
                      className={
                        "leading-5 text-muted-foreground " +
                        (scrolls ? "max-h-[6.25rem] overflow-y-auto focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" : "")
                      }
                    >
                      {group.emails.map((email, index) => (
                        <li key={`${index}-${email}`} className="wrap-anywhere">
                          {email}
                        </li>
                      ))}
                    </ul>
                  </li>
                );
              })}
            </ul>
            <DialogFooter>
              <Button ref={doneRef} type="button" variant="brandDeep" onClick={onClose}>
                {t("groups.bulk.done")}
              </Button>
            </DialogFooter>
          </div>
        )}

        {/* Mounted from the start: a live region inserted later may not be announced */}
        <p role="status" aria-live="polite" aria-atomic="true" className="sr-only">
          {announcement}
        </p>
      </DialogContent>
    </Dialog>
  );
}

function resultMessage(
  t: (key: string, opts?: Record<string, unknown>) => string,
  report: BulkAddReport,
  keptInBox: boolean,
): { text: string; tone: "error" | "info" } | null {
  const cause = report.stopped?.cause;
  if (report.stopped) {
    if (isRateLimited(cause)) return { text: t("groups.bulk.stoppedRateLimit"), tone: "error" };
    const reason = cause instanceof ApiFail ? t(`errors.${cause.code}`, { defaultValue: t("errors.fallback") }) : t("errors.fallback");
    return { text: t("groups.bulk.stopped", { reason }), tone: "error" };
  }
  if (report.cancelled) return { text: t("groups.bulk.cancelled"), tone: "info" };
  if (keptInBox) return { text: t("groups.bulk.keptInBox"), tone: "info" };
  return null;
}

/**
 * `GET /api/groups` returns only groups I belong to; `GET .../members` is readable by any member.
 * A one-time copy: no link between the groups is kept, so later changes in the source group don't carry over. Each open starts over
 * (unmounted on close).
 */
function ImportPicker({ groupId, currentMemberIds, myUserId, onImport }: BulkAddDialogProps) {
  const { t } = useTranslation();
  const groupsQuery = useGroups();
  const [sourceId, setSourceId] = useState("");
  // Tracks unchecked rather than checked, so a late-arriving list is all checked by default; cleared when the source group changes.
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const membersQuery = useGroupMembers(sourceId);

  const sources = (groupsQuery.data ?? []).filter((group) => group.id !== groupId);
  const candidates = sourceId === "" ? [] : (membersQuery.data ?? []).filter((m) => !currentMemberIds.has(m.userId) && m.userId !== myUserId);
  const picked = candidates.filter((m) => !unchecked.has(m.userId));
  const allChecked = candidates.length > 0 && picked.length === candidates.length;

  function toggle(userId: string, checked: boolean): void {
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (checked) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  return (
    <>
      <div className="space-y-3">
        {groupsQuery.isPending ? (
          <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
        ) : sources.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("groups.bulk.importNoGroups")}</p>
        ) : (
          <Select
            variant="field"
            aria-label={t("groups.bulk.importSourceLabel")}
            value={sourceId}
            onValueChange={(value) => {
              setSourceId(value);
              setUnchecked(new Set());
            }}
            placeholder={t("groups.bulk.importSourcePlaceholder")}
            options={sources.map((group) => ({ value: group.id, label: group.name }))}
            className="w-full"
          />
        )}

        {sourceId !== "" &&
          (membersQuery.isPending ? (
            <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
          ) : membersQuery.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {t("errors.fallback")}
            </p>
          ) : candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("groups.bulk.importNobody")}</p>
          ) : (
            <div className="space-y-2">
              <label className="flex items-center gap-2 text-sm font-medium">
                <Checkbox
                  checked={allChecked ? true : picked.length === 0 ? false : "indeterminate"}
                  onCheckedChange={() => setUnchecked(allChecked ? new Set(candidates.map((m) => m.userId)) : new Set())}
                />
                {t("groups.bulk.importSelectAll", { count: candidates.length })}
              </label>
              <ul aria-label={t("groups.bulk.importListLabel")} className="max-h-64 space-y-1 overflow-y-auto rounded-md border border-input p-2">
                {candidates.map((m) => (
                  <li key={m.userId}>
                    <label className="flex min-w-0 items-center gap-2 py-1 text-sm">
                      <Checkbox
                        aria-label={m.email}
                        checked={!unchecked.has(m.userId)}
                        onCheckedChange={(checked) => toggle(m.userId, checked === true)}
                      />
                      <span className="truncate">{m.displayName}</span>
                      <span className="min-w-0 truncate text-muted-foreground">{m.email}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">{t("groups.bulk.importExcludedHint")}</p>
            </div>
          ))}
      </div>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="outline">
            {t("home.cancel")}
          </Button>
        </DialogClose>
        <Button type="button" variant="brandDeep" disabled={picked.length === 0} onClick={() => onImport(picked.map((m) => m.email))}>
          {t("groups.bulk.importConfirm", { count: picked.length })}
        </Button>
      </DialogFooter>
    </>
  );
}
