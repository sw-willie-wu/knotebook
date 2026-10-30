import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";
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
import { isRateLimited, type BulkAddOutcome, type BulkAddReport } from "./bulk-add";

/** 輸入框一次貼多個地址（`input`），或「從其他群組匯入」（`import`）。 */
export type BulkAddMode = "input" | "import";

/** 一輪批次加入的狀態：`report` 為 null＝還在跑。 */
export interface BulkAddState {
  done: number;
  total: number;
  /** 開跑那一刻的角色名：跑完後加人表單的角色會重設，說明文字不能跟著變。 */
  roleName: string;
  /** 按了「停止」、還在等正在送的那一筆。 */
  stopping: boolean;
  /** 跑完後有沒有地址放回（或留在）輸入框。 */
  keptInBox: boolean;
  report: BulkAddReport | null;
}

type BulkAddDialogProps = {
  open: boolean;
  mode: BulkAddMode;
  /** null＝匯入還在挑人（只有 `import` 會有這一段）。 */
  bulk: BulkAddState | null;
  /** 目前這個群組（不列在來源清單裡）。 */
  groupId: string;
  /** 目前這個群組的成員 userId：來源群組裡已在這裡的人不列出。 */
  currentMemberIds: ReadonlySet<string>;
  /** 自己（不列出；自己一定已在這個群組裡，除非是非成員的站台管理員）。 */
  myUserId: string | undefined;
  /** 加人表單目前選的角色名（挑人那一段的說明文字用）。 */
  roleName: string;
  /** 匯入按下確認：要加的 email（依來源名單的順序）。對話框不關，換成進度。 */
  onImport: (emails: string[]) => void;
  onStop: () => void;
  /** 關閉（完成、取消、Esc、✕）。跑到一半關掉＝停止：呼叫端負責中止。 */
  onClose: () => void;
  /** 關閉時把焦點還給誰（受控 Dialog 沒有 `DialogTrigger`，Radix 不會自己還）。 */
  returnFocusRef: RefObject<HTMLElement | null>;
};

/** 結果的分類與顯示順序。 */
const OUTCOMES: BulkAddOutcome[] = ["added", "alreadyMember", "notFound", "invalid", "failed", "notProcessed"];

/** 結果裡每一類的 email 清單最多直接露出幾列，超過就在該類自己的清單裡捲動。 */
const RESULT_VISIBLE_ROWS = 5;

const SELECT_CLASS =
  "h-8 w-full rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none " +
  "focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/**
 * 批次加入的對話框（群組 modal 之上的第三層）：兩條路徑共用。
 * - `import`：挑人（來源群組 → 勾選清單）→ 按「加入 n 人」→ 同一個對話框換成進度。
 * - `input`：在加人輸入框一次填多個地址按「加入」→ 直接開在進度。
 * 進度是「已處理 n／共 m」＋「停止」（正在送的那一筆跑完就停，其餘記「未處理」）；跑完換成結果（停下的原因、
 * 各類的 email 一行一個，超過 5 個的那一類在自己的清單裡捲動；外層另有高度上限當保險）＋「完成」。設定 modal 裡不再另外顯示結果，也不發 toast。
 *
 * 無障礙：一個常駐的 `role="status"`（sr-only）從對話框打開就在，跑完才填入「停下的原因＋各類人數」；
 * email 清單放在 live region 外（不會整串念出來）。進入進度時焦點移到「停止」，進入結果時移到「完成」。
 * 點對話框外面不關（`dismissOnOutside={false}`：挑人那一段是表單、跑的那一段誤點會中止）。
 */
export function BulkAddDialog(props: BulkAddDialogProps) {
  const { t } = useTranslation();
  const listId = useId();
  const { open, mode, bulk, onClose, returnFocusRef } = props;
  const phase = bulk === null ? "pick" : bulk.report === null ? "running" : "result";
  const stopRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef<HTMLButtonElement>(null);

  // 焦點分兩種時機：
  // - 打開那一刻（輸入框那條直接開在進度）：交給 `onOpenAutoFocus` 指定。這裡的 effect 在那一刻沒用——Radix Portal
  //   第一次 commit 時內容還沒掛上，ref 是 null；不指定的話 Radix 聚焦第一個可聚焦元素，只是剛好是「停止」。
  // - 對話框開著時換段（挑人 → 進度、進度 → 結果）：被換掉的按鈕帶走焦點，這個 effect 把焦點移到新的那一顆。
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
          if (!target) return; // 挑人那一段：照 Radix 預設（第一個可聚焦元素）
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
                // 停止中再按也無妨：abort 與 `stopping` 都是冪等的
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
            {/* 外層的上限只是保險（6 類各 5 列也不會把「完成」推出畫面）：DialogContent 本身不捲動 */}
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
                    {/* 每類各自捲動：超過 5 個才捲（列高固定 1.25rem，5 列＝6.25rem；長 email 折行會多佔列，所以是「約 5 列」）；
                        會捲才可聚焦並以類別標題命名，鍵盤使用者才捲得到 */}
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

        {/* 常駐的 live region：跑完才填入摘要（一開始就在，新插入的 live region 不一定會被念） */}
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
 * 挑人：列出我所在的其他群組（`GET /api/groups` 只回我是成員的群組）→ 選一個 → 抓它的成員
 * （`GET …/members`，任一成員可讀）→ 勾選清單（預設全勾；已在這個群組的人與自己不列）→ 確認交給呼叫端依序加入。
 * 一次性複製：不建立任何「兩個群組的關聯」，來源群組之後的增減不會帶過來。每次打開都從頭選（關閉時卸載）。
 */
function ImportPicker({ groupId, currentMemberIds, myUserId, onImport }: BulkAddDialogProps) {
  const { t } = useTranslation();
  const groupsQuery = useGroups();
  const [sourceId, setSourceId] = useState("");
  // 記「取消勾選的」而不是「勾選的」：名單晚到也自然是全勾（預設全勾），換來源群組時清空。
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
          <select
            aria-label={t("groups.bulk.importSourceLabel")}
            value={sourceId}
            onChange={(event) => {
              setSourceId(event.target.value);
              setUnchecked(new Set());
            }}
            className={SELECT_CLASS}
          >
            <option value="" disabled>
              {t("groups.bulk.importSourcePlaceholder")}
            </option>
            {sources.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
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
