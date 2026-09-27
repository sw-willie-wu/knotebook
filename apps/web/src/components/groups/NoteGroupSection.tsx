import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { NoteDto, ShareRole } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useGroups } from "@/api/groups";
import { useConfirmNoteGroupUnchanged, useMoveNoteToGroup, useRemoveNoteGroup, useSetNoteGroupRole } from "@/api/note-group";
import { usePublicLink } from "@/api/public-link";
import { useShares } from "@/api/shares";
import { Button } from "@/components/ui/button";

/** ApiFail → errors.<code>；其餘 → errors.fallback（逐檔各寫一份是 repo 慣例，見 ShareDialog.tsx）。 */
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

const SELECT_CLASS =
  "h-8 min-w-0 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none " +
  "focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/** 確認中的目標：`""`＝移出群組（D15），群組 id＝搬進那個群組（D16）。`null`＝沒有確認懸掛。 */
type PendingTarget = string | null;

/**
 * 分享面板的「所屬群組」列（#103 PR3，spec §8.3）。三形：
 * - **個人筆記**：下拉「無」＋我所屬的群組；選群組 → D16 確認（列出逐人分享對象會失去個別邀請、
 *   有公開連結時註明會撤銷）→ `PUT …/group {groupId, role: "editor"}`。
 * - **群組筆記、我是該群組成員**：同一個下拉（目前群組被選中）＋「群組成員的權限」下拉。
 *   選「無」→ D15 確認 → `DELETE …/group`；選別的群組 → D16 確認 → `PUT`（role 一律 editor，
 *   規格落差 P27）；改權限 → 直接 `PUT` 同一個群組（server 只改 `group_role`、不清任何東西，不確認）。
 * - **群組筆記、我已不是成員（A1）**：群組名稱（唯讀）＋權限下拉＋「移出群組…」→ D15 確認。
 *
 * **個人筆記在「我所屬的群組」不是非空清單時整列不渲染**（Willie 2026-09-27 裁決 N4）：清單為空
 * 沒有東西可選；載入中與錯誤也不渲染，否則這一列會先閃出來再消失（側欄通常已經載好 `['groups']`，
 * 載入中的窗口很短；錯誤由側欄工作坊段顯示）。群組筆記一定有目前的群組，照常渲染（含 A1）。
 * **「成功」看的是手上有沒有資料，不是 `status`**（fix r1 Minor 2）：已載入過的 `['groups']` 重抓
 * 失敗時 react-query 把 `status` 改成 `error` 但保留 `data`。這時照舊用那份資料渲染整列——不隱藏
 * 個人筆記的列、群組筆記也不切到錯誤分支。否則送出前檢查不過（它會失效 `['groups']`）若恰好碰上重抓
 * 失敗，提示會跟著整列一起消失（違反下面的例外），懸掛中的確認列也會憑空不見。錯誤分支因此只在
 * 「從沒載入成功過」時出現；那時畫面上沒有任何控制項，不可能已有 `notice`／`error`，所以它不渲染訊息。
 * **例外：隱藏時若有提示或錯誤訊息，只渲染訊息那一段**（gate r3 I1）。典型情境：群組在別處被刪、
 * 我又沒有別的群組——送出前檢查把 note 對齊成個人筆記、`['groups']` 重抓成 `[]`，整列該隱藏了，但
 * 「已在別處被變更」的提示正是這時候要讓人看見的。`notice`／`error` 只由使用者的操作產生，所以不會
 * 違反「不閃現」；分享面板關閉時元件卸載，訊息跟著清掉。
 *
 * ⚠ **掛載位置是契約**（spec §8.3）：`ShareDialog` 的 `DialogContent` 內、`AccessSection` 的
 * **兄弟**、**不帶 key**。`AccessSection` 以 `note.group?.id` 為 key，搬家成功時整段重掛；
 * 這一段若跟著重掛，確認狀態與焦點會一起消失。成功後焦點由下面的 effect 還原到群組下拉。
 *
 * 確認列沿用 `AccessSection` 私人確認流的形（`role="alert"` 行內框，不另開 Dialog——分享面板本身
 * 已是 Dialog）。提交鈕：會撤掉任何人的存取或連結時 `destructive`，否則 `outline`（分享面板
 * 沒有唯一主角，不放實心主色鈕；`button.tsx` 檔頭）。
 * 確認文案裡的受邀者名單取自本面板已載入的 `['shares']`／`['public-link']` 快取——那是提示，
 * server 在交易裡刪的才是實際名單。**兩支 query 都成功之前群組下拉停用**（gate r1 I2）：資料不明時
 * 確認列會低報成「什麼都不會失去」，而搬家是不可逆的刪除。錯誤訊息由同面板的 `AccessSection` 顯示。
 *
 * **送出前檢查**（Willie 2026-09-27 裁決 M3）：三種送出（搬家、移出、改權限）都先
 * `useConfirmNoteGroupUnchanged` 重讀一次筆記；群組已在別處被改了就不送，面板重新載入並顯示一行提示。
 * 檢查到送出之間仍有 TOCTOU 窗口（見 plan 的【推】）。
 *
 * **焦點還原只走一個 effect**（gate r1 I1）：確認列的成功、失敗、取消、檢查不過，以及改權限的
 * 失敗與檢查不過，都只是舉旗，等
 * `!busy && pending === null` 的那次重繪之後才 `focus()`。在 catch 裡同步呼叫 `focus()` 是 no-op——
 * 那一刻 `isPending → false` 的通知還在 react-query 的 `setTimeout(0)` 批次裡，下拉仍是 `disabled`。
 * A1 的外層「移出群組…」鈕在確認懸掛期間也**不** disabled，否則取消後焦點同樣無處可去。
 */
export function NoteGroupSection({ note }: { note: NoteDto }) {
  const { t } = useTranslation();
  const groupsQuery = useGroups();
  const sharesQuery = useShares(note.id);
  const linkQuery = usePublicLink(note.id);
  const move = useMoveNoteToGroup(note.id);
  const setRole = useSetNoteGroupRole(note.id);
  const remove = useRemoveNoteGroup(note.id);
  const confirmUnchanged = useConfirmNoteGroupUnchanged(note.id);

  const [pending, setPending] = useState<PendingTarget>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const selectRef = useRef<HTMLSelectElement>(null);
  const removeRef = useRef<HTMLButtonElement>(null);
  const roleRef = useRef<HTMLSelectElement>(null);
  /** 待還原焦點：`"select"`＝一定要落在群組下拉（只給確認列的成功路徑，可能要等 A1 那排換成下拉；
   * 下拉不在場時旗子留著不放）；
   * `"any"`＝下拉或 A1 的外層鈕，哪個在就給哪個（確認列的失敗、取消、檢查不過，以及改權限的檢查不過）；
   * `"role"`＝權限下拉（改權限失敗；它不在了就退到 `"any"` 的順序）。
   * 改權限的檢查不過**不能**舉 `"select"`（gate r4 M1）：對齊後若仍是 A1 形，沒有後續動作會讓下拉
   * 出現，旗子會一直掛著，直到某次背景重抓讓下拉出現時把焦點從別處搶走。 */
  const [refocus, setRefocus] = useState<"select" | "any" | "role" | null>(null);

  const current = note.group;
  const groups = groupsQuery.data ?? [];
  /** 手上有群組清單（含「重抓失敗但保留舊資料」）；見檔頭 fix r1 Minor 2。 */
  const groupsKnown = groupsQuery.data !== undefined;
  const isMember = current !== null && groups.some((group) => group.id === current.id);
  const busy = checking || move.isPending || setRole.isPending || remove.isPending;
  const shares = sharesQuery.data ?? [];
  const token = linkQuery.data?.token ?? null;
  const dataKnown = sharesQuery.isSuccess && linkQuery.isSuccess;
  const hidden = current === null && !(groupsKnown && groups.length > 0);

  // 見檔頭「焦點還原只走一個 effect」。成功路徑要等到下拉真的在場：A1 移出成功時，mutation 的
  // `isPending → false` 可能比 note 換成個人筆記那次重繪先到，那一刻畫面上還是 A1 的外層鈕（稍後
  // 卸載）——所以 `"select"` 在下拉出現前不動手，`current?.id` 進 deps 讓 note 換了之後再跑一次。
  // 整列不渲染（或只剩訊息那一段）時沒有可聚焦的控制項，放下旗子：焦點留在 Dialog 容器，由 Radix 的
  // focus trap 接住；訊息本身是 `role="status"`／`role="alert"`，由輔助技術播報。下拉停用時（同上，或 shares／public-link 重抓失敗使 `dataKnown` 變 false）
  // `focus()` 是 no-op，焦點同樣留在容器。
  const currentId = current?.id;
  useEffect(() => {
    if (refocus === null || busy || pending !== null) return;
    if (hidden) {
      setRefocus(null);
      return;
    }
    const target =
      refocus === "select"
        ? selectRef.current
        : refocus === "role"
          ? (roleRef.current ?? selectRef.current ?? removeRef.current)
          : (selectRef.current ?? removeRef.current);
    if (!target) return;
    setRefocus(null);
    target.focus();
  }, [refocus, busy, pending, currentId, isMember, hidden]);

  /** 送出前重讀筆記（見檔頭）。回傳 false＝群組已在別處被改、面板已重新載入，呼叫端不得送出。 */
  async function stillCurrent(): Promise<boolean> {
    setChecking(true);
    try {
      if (await confirmUnchanged(currentId ?? null)) return true;
      setNotice(t("share.group.changedElsewhere"));
      return false;
    } finally {
      setChecking(false);
    }
  }

  function choose(value: string): void {
    // 搬進群組要先知道會清掉什麼（I2）。A1 的移出鈕不看分享與連結；下拉整體仍受 `dataKnown` 閘。
    if (value !== "" && !dataKnown) return;
    setError(null);
    setNotice(null);
    setPending(value === (currentId ?? "") ? null : value);
  }

  function cancel(): void {
    setPending(null);
    setRefocus("any");
  }

  async function confirm(): Promise<void> {
    if (pending === null) return;
    setError(null);
    setNotice(null);
    try {
      if (!(await stillCurrent())) {
        setRefocus("any");
        return;
      }
      if (pending === "") await remove.mutateAsync();
      else await move.mutateAsync({ groupId: pending, role: "editor" });
      setRefocus("select");
    } catch (err) {
      setError(errorMessage(t, err));
      setRefocus("any");
    } finally {
      setPending(null);
    }
  }

  async function changeRole(role: ShareRole): Promise<void> {
    if (!current) return;
    setError(null);
    setNotice(null);
    try {
      if (!(await stillCurrent())) {
        // 檢查不過時 note 已被對齊、權限下拉多半即將卸載（例如已成個人筆記）——焦點給群組下拉或 A1 的
        // 外層鈕，哪個在給哪個。不用 "select"：對齊後仍是 A1 形時它會殘留、日後搶焦點（gate r4 M1）。
        setRefocus("any");
        return;
      }
      await setRole.mutateAsync({ groupId: current.id, role });
    } catch (err) {
      setError(errorMessage(t, err));
      setRefocus("role");
    }
  }

  // `key="messages"`（gate r4 N1）：hidden 分支與完整列裡，訊息在 `<section>` 子節點中的位置不同；
  // 不帶 key 的話 React 依位置對帳，在兩形之間切換時會卸載再重掛 `role="status"`／`role="alert"`
  // 節點（live region 被重建，可能重唸或不唸）。帶 key 則依 key 對帳，同一個節點被保留。
  // 沒有訊息時不渲染這個 div——空 div 在 `space-y-2` 裡會替前一個兄弟多掛一段間距。
  const messages =
    notice || error ? (
      <div key="messages" className="space-y-2">
        {notice && (
          <p role="status" className="text-sm text-muted-foreground">
            {notice}
          </p>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    ) : null;

  if (hidden) {
    return notice || error ? <section className="space-y-2 py-4 first:pt-0 last:pb-0">{messages}</section> : null;
  }

  const title = <h3 className="text-sm font-semibold">{t("share.group.sectionTitle")}</h3>;

  if (groupsQuery.isPending) {
    return (
      <section className="space-y-2 py-4 first:pt-0 last:pb-0">
        {title}
        <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
      </section>
    );
  }
  if (groupsQuery.isError && !groupsKnown) {
    return (
      <section className="space-y-2 py-4 first:pt-0 last:pb-0">
        {title}
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(t, groupsQuery.error)}
        </p>
      </section>
    );
  }

  const roleSelect = current && (
    <select
      ref={roleRef}
      aria-label={t("share.group.roleLabel")}
      value={current.role}
      disabled={busy || pending !== null}
      onChange={(event) => void changeRole(event.target.value as ShareRole)}
      className={`${SELECT_CLASS} shrink-0`}
    >
      <option value="editor">{t("share.group.roleEditor")}</option>
      <option value="viewer">{t("share.group.roleViewer")}</option>
    </select>
  );

  const target = pending ? groups.find((group) => group.id === pending) : undefined;
  const losesSomething = pending === "" || current !== null || shares.length > 0 || token !== null;

  return (
    <section className="space-y-2 py-4 first:pt-0 last:pb-0">
      {title}

      {current && !isMember ? (
        // A1：我已不是這個群組的成員——不能從這裡搬去別的群組（規格落差 P31），只能改權限或移出。
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-sm">{t("share.group.formerGroup", { name: current.name })}</p>
          {roleSelect}
          {/* 與權限下拉同列 → default size（`button.tsx` 檔頭：「與輸入框同列」用 default）。 */}
          <Button ref={removeRef} type="button" variant="outline" disabled={busy} onClick={() => choose("")}>
            {t("share.group.removeFromGroupStart")}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <select
            ref={selectRef}
            aria-label={t("share.group.selectLabel")}
            value={pending ?? current?.id ?? ""}
            disabled={busy || !dataKnown}
            onChange={(event) => choose(event.target.value)}
            className={`${SELECT_CLASS} flex-1`}
          >
            <option value="">{t("share.group.none")}</option>
            {groups.map((group) => (
              <option key={group.id} value={group.id}>
                {group.name}
              </option>
            ))}
          </select>
          {roleSelect}
        </div>
      )}

      {pending !== null && (
        // role="alert"：確認列憑空長出來，選完下拉的鍵盤／AT 使用者要被告知（同 AccessSection）。
        <div role="alert" className="space-y-2 rounded-md border border-destructive/40 p-2">
          {pending === "" && current ? (
            <p className="text-sm">{t("share.group.confirmLeave", { name: current.name })}</p>
          ) : (
            <>
              <p className="text-sm">{t("share.group.confirmMoveIn", { name: target?.name ?? "" })}</p>
              {current && (
                <p className="text-sm">{t("share.group.confirmMoveFrom", { from: current.name, to: target?.name ?? "" })}</p>
              )}
              {shares.length > 0 && (
                <>
                  <p className="text-sm">
                    {t("share.group.confirmRevokeShares", { count: shares.length, name: target?.name ?? "" })}
                  </p>
                  <ul className="list-disc pl-5 text-sm">
                    {shares.map((share) => (
                      <li key={share.userId}>
                        {share.displayName} <span className="text-muted-foreground">{share.email}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {token && <p className="text-sm">{t("share.group.confirmRevokeLink")}</p>}
            </>
          )}
          <div className="flex gap-2">
            <Button
              type="button"
              variant={losesSomething ? "destructive" : "outline"}
              size="sm"
              disabled={busy}
              onClick={() => void confirm()}
            >
              {pending === "" ? t("share.group.removeFromGroup") : t("share.group.confirmMove")}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={cancel}>
              {t("home.cancel")}
            </Button>
          </div>
        </div>
      )}

      {messages}
    </section>
  );
}
