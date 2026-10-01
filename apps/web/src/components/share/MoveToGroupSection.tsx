import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { canonicalNotePath, type NoteDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useGroups } from "@/api/groups";
import { useConfirmNoteStillPersonal, useCopyNote, useMoveNoteToGroup } from "@/api/note-move";
import { usePublicLink } from "@/api/public-link";
import { useShares } from "@/api/shares";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";

/** ApiFail → errors.<code>；其餘 → errors.fallback（逐檔各寫一份是 repo 慣例，見 ShareDialog.tsx）。 */
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

/** 與 `ShareDialog.tsx` 的 `SELECT_CLASS` 同形（`ui/` 沒有共用 select 樣式；逐檔一份是既有慣例），這裡多 `flex-1`。 */
const SELECT_CLASS =
  "h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none " +
  "focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/**
 * 分享面板的「移動或複製到群組」列（#175 PR2，spec §8.4）。只由 `ShareDialog` 在**個人筆記**、
 * `note.permissions.moveToGroup` 為真時掛在 `AccessSection` 之後。v2 沒有「移出群組」（W4）。
 *
 * PR1 交接的六條不變量（①②⑥在 `api/note-move.ts` 的 hook 層，③④⑤在這裡）：
 * - **⑤** 候選＝`useGroups()` 中 `myRole.permissions.create` 為真者。清單載入中、從沒成功過、或候選為空 →
 *   整列不渲染（不閃現），**只**剩下面的訊息節點。
 * - **④** 訊息節點常駐（`key="messages"`、`role="status"`），不論整列隱藏與否都在同一個位置、不重建——
 *   送出失敗時（`refetchAfterFailure` 會失效 `['groups']`），整列可能正好隱藏，錯誤仍要留在同一個 live region
 *   裡被看見。`error` 只由使用者的操作產生。
 * - **③** 移動走行內確認（`role="alert"`，比照 `AccessSection` 私人確認流）：列出會失去存取的逐人分享對象、
 *   有 token 時說公開連結會關、恆說網址會變與擁有權移交；提交鈕 `destructive`。取消 → 焦點回下拉。
 *   **shares 與 public-link 兩支都成功之前下拉停用**：資料不明時確認文案會低報被移除的人（v1 gate r1 I2）。
 * - 送出前檢查（`useConfirmNoteStillPersonal`）：重讀到已不是我能移動的個人筆記 → 不送、發 `changedElsewhere`
 *   **toast**（不是本元件的訊息節點）：那支 hook 回 false 之前已把重讀到的筆記寫進 `['note', id]`，`ShareDialog`
 *   會換成群組版（本元件卸載）、或因 `moveToGroup` 假卸載本列、甚至因 `manageShares` 假整個不渲染——元件內的
 *   state 在這幾形全都看不到；toast 是模組層 store，元件卸載照樣顯示。
 *   ⚠ 那支 hook 每次 render 回傳新函式——只在送出 handler 裡直接呼叫，**不得**放進任何 effect 的 deps。
 * - 移動成功：hook 把回應寫進 `['note', id]`，`ShareDialog` 依那份 `NoteDto` 換成群組版面板、本元件卸載。
 *   之後的面板、觸發鈕、編輯器、⋮ 都只讀回應的 `role`／`permissions`——「能新建、不能編輯」的角色搬完是
 *   `viewer`，本元件不假設、也不宣稱搬完能編輯（主檔規格落差 17）。
 * - 複製：行內確認（提交鈕 `outline`——不破壞任何東西）；成功 toast 附「前往副本」、再呼叫 `onDone`（分享面板傳
 *   `onClose`：與群組版「複製到我的筆記」一致，關掉模態，鍵盤才摸得到 toast 的動作鈕；未傳則面板留著、焦點回下拉）。
 *
 * **焦點還原只走一個 effect**（v1 gate r1 I1）：取消、失敗、檢查不過、複製成功都只舉旗，等重繪之後才 `focus()`——
 * 在 catch 裡同步 `focus()` 時 DOM 上的下拉還是 `disabled`（`submitting` 歸零的那次重繪還沒提交），是 no-op（實測：
 * 改成在 catch 裡同步 focus，「移動失敗 409」案的焦點斷言紅）。effect 裡的 `busy` 閘門是**防禦性的**：舉旗與
 * `submitting` 歸零在同一批次提交，mutation 的 `isPending` 在 render 時已是最新值（`useMutation` 的 snapshot 是
 * `getCurrentResult()`），所以 effect 跑時 `busy` 一向是假，沒有案能區分（拿掉閘門全綠，實測）。
 * 整列隱藏時放下旗子，焦點留在 Dialog 容器（Radix focus trap）。
 */
export function MoveToGroupSection({ note, onDone }: { note: NoteDto; onDone?: () => void }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const groupsQuery = useGroups();
  const sharesQuery = useShares(note.id);
  const linkQuery = usePublicLink(note.id);
  const move = useMoveNoteToGroup(note.id);
  const copy = useCopyNote(note.id);
  const confirmStillPersonal = useConfirmNoteStillPersonal(note.id);

  const [groupId, setGroupId] = useState("");
  const [pending, setPending] = useState<"move" | "copy" | null>(null);
  /** 送出中（含送出前檢查），在 handler 開頭同步舉起，提交鈕從按下那一刻就停用。兩段窗口：
   * ① 移動的送出前檢查那段 await——還沒有 mutation 在跑（`isPending` 為假）。由「移動送出掛著時再按」案釘住
   *    （拿掉這個 state、或只把它從 `busy` 拿掉，該案都紅——實測）。
   * ② mutation 已開始、`isPending` 的重繪通知還在 react-query 的批次（setTimeout 0）裡。這段是**防禦性的**：
   *    「複製送出掛著時再按」案在拿掉這個 state 時仍綠（同一次點擊裡另有重繪讀到已是 pending 的 `isPending`；
   *    那次重繪的來源是 `submitCopy` 開頭的 `setError(null)`——值沒變、React 仍排了重繪；實測：連它一起拿掉，
   *    複製案 3/3 紅，只拿掉它則綠），它守的是 `busy` 涵蓋複製（`busy` 只看 `move.isPending` 時紅——實測）。
   * 複製在 server 交易裡做檔案 I/O、可能很慢，重送就是第二份副本。 */
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refocus, setRefocus] = useState(false);
  const selectRef = useRef<HTMLSelectElement>(null);

  const candidates = (groupsQuery.data ?? []).filter((group) => group.myRole?.permissions.create === true);
  const hidden = candidates.length === 0;
  const dataKnown = sharesQuery.isSuccess && linkQuery.isSuccess;
  const busy = submitting || move.isPending || copy.isPending;
  const target = candidates.find((group) => group.id === groupId);
  const shares = sharesQuery.data ?? [];
  const token = linkQuery.data?.token ?? null;

  useEffect(() => {
    if (!refocus || busy) return;
    if (hidden || !selectRef.current) {
      setRefocus(false);
      return;
    }
    setRefocus(false);
    selectRef.current.focus();
  }, [refocus, busy, hidden]);

  function choose(value: string): void {
    setGroupId(value);
    setPending(null);
    setError(null);
  }

  function cancel(): void {
    setPending(null);
    setRefocus(true);
  }

  async function submitMove(): Promise<void> {
    if (!target) return;
    setError(null);
    setSubmitting(true);
    try {
      const stillPersonal = await confirmStillPersonal();
      if (!stillPersonal) {
        // 非 destructive：沒有東西壞掉，只是沒做。本元件此時多半已經（或即將）卸載，見檔頭。
        toast({ title: t("share.move.changedElsewhere") });
        setPending(null);
        setRefocus(true);
        return;
      }
      await move.mutateAsync(target.id);
      // 成功：note 已換成群組形，ShareDialog 會換面板、本元件卸載；不還原焦點（留在 Dialog 容器）。
    } catch (err) {
      setError(errorMessage(t, err));
      setPending(null);
      setRefocus(true);
    } finally {
      setSubmitting(false);
    }
  }

  async function submitCopy(): Promise<void> {
    if (!target) return;
    const group = target.name;
    setError(null);
    setSubmitting(true);
    try {
      const created = await copy.mutateAsync(target.id);
      toast({
        title: t("share.move.copiedToGroup", { group }),
        action: {
          label: t("share.move.openCopy"),
          altText: t("share.move.openCopyAlt"),
          onClick: () => void navigate(canonicalNotePath(created)),
        },
      });
      onDone?.();
    } catch (err) {
      setError(errorMessage(t, err));
    } finally {
      setSubmitting(false);
      setPending(null);
      setRefocus(true);
    }
  }

  const names = new Intl.ListFormat(i18n.language, { style: "long", type: "conjunction" }).format(
    shares.map((share) => share.displayName),
  );

  const hasMessage = error !== null;
  // 版面：`DialogContent` 是 `grid gap-4`，隱藏時若 section 仍是一個空的 grid item，面板底部會多 16px——所以隱藏且
  // 沒有訊息時 section 用 `sr-only`（絕對定位、不佔 grid 軌道，但 live region 仍在無障礙樹裡，之後長出訊息照樣播報）。
  // 子節點之間用各自的 `mt-2`、不用 `space-y-*`：空的訊息節點排在最後，`space-y` 會替前一個兄弟多掛一段間距。
  const sectionClass = hidden ? (hasMessage ? "" : "sr-only") : "py-4 first:pt-0 last:pb-0";

  // 單一 return、子節點一律帶 key：隱藏與完整兩形之間切換時，訊息節點（④）依 key 對帳、是同一個 DOM 節點（不重建
  // live region——重建會重唸或漏唸）。
  return (
    <section className={sectionClass}>
      {[
        !hidden && (
          <h3 key="title" className="text-sm font-semibold">
            {t("share.move.title")}
          </h3>
        ),
        !hidden && (
          <div key="row" className="mt-2 flex items-center gap-2">
            <select
              ref={selectRef}
              aria-label={t("share.move.groupLabel")}
              value={groupId}
              disabled={busy || !dataKnown}
              onChange={(event) => choose(event.target.value)}
              className={SELECT_CLASS}
            >
              <option value="" disabled>
                {t("share.move.choose")}
              </option>
              {candidates.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
            {target && (
              <>
                <Button type="button" variant="outline" disabled={busy} onClick={() => setPending("move")}>
                  {t("share.move.move")}
                </Button>
                <Button type="button" variant="outline" disabled={busy} onClick={() => setPending("copy")}>
                  {t("share.move.copy")}
                </Button>
              </>
            )}
          </div>
        ),
        !hidden && pending === "move" && target && (
          <div key="confirm-move" role="alert" className="mt-2 space-y-2 rounded-md border border-destructive/40 p-2">
            <p className="text-sm">{t("share.move.moveLead", { group: target.name })}</p>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {shares.length > 0 && <li>{t("share.move.moveRemovesPeople", { count: shares.length, names })}</li>}
              {token && <li>{t("share.move.moveClosesPublicLink")}</li>}
              <li>{t("share.move.moveUrlChange")}</li>
              <li>{t("share.move.moveOwnership")}</li>
            </ul>
            <div className="flex gap-2">
              <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => void submitMove()}>
                {t("share.move.moveSubmit")}
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={cancel}>
                {t("share.move.cancel")}
              </Button>
            </div>
          </div>
        ),
        !hidden && pending === "copy" && target && (
          <div key="confirm-copy" role="alert" className="mt-2 space-y-2 rounded-md border p-2">
            <p className="text-sm">{t("share.move.copyLead", { group: target.name })}</p>
            <div className="flex gap-2">
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void submitCopy()}>
                {t("share.move.copySubmit")}
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={busy} onClick={cancel}>
                {t("share.move.cancel")}
              </Button>
            </div>
          </div>
        ),
        <div key="messages" role="status" aria-live="polite" data-move-messages="">
          {error && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {error}
            </p>
          )}
        </div>,
      ]}
    </section>
  );
}
