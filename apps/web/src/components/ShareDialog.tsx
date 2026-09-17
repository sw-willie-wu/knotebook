import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { normalizeSlug, publicAliasPath, validateSlug, type NoteDto, type ShareDto, type ShareRole } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useDeleteShare, usePutShare, useShares } from "@/api/shares";
import { useClearPublicSlug, useCreatePublicLink, useDeletePublicLink, usePublicLink, useSetPublicSlug } from "@/api/public-link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Globe, Lock, Share, Trash } from "@/components/ui/icons";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import { ManualCopyField } from "@/components/ManualCopyField";

/** ApiFail → errors.<code>；其餘 → errors.fallback。與 NoteList/TitleInput 同一套對映（各檔各自一份，
 * 是既有慣例——見那兩處的說明，這裡不再重複抽象）。 */
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

const SELECT_CLASS =
  "h-8 shrink-0 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none " +
  "focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/**
 * 分享面板的一組設定＝**一件事**。內部自訂網址下架後（Willie 2026-09-17）面板只剩
 * 「存取權」一組，這裡只負責標題與上下留白（原本多組時靠外層 `divide-y` 長出髮絲線，
 * 現在單組已不需要）。
 *
 * 改版前四個區塊是平的 `space-y-4`，而且標頭各寫各的（兩個 `h3`、一個裸按鈕、
 * 一個 `<label>`）——看起來就是一串不相干的控制項堆在一起。
 *
 * 刻意在本檔自己寫一份、不去 import `settings/SettingsLayout` 的同名元件：方向上
 * `components/` 不該依賴 `settings/`，而且這裡的密度要比設定面板緊（`py-4` 對
 * `py-8`）。逐檔各寫一份是這個 repo 的既有慣例（同檔 `errorMessage`、`SELECT_CLASS`）。
 */
function ShareGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 py-4 first:pt-0 last:pb-0">
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

/** 分享名單裡的一列：email/displayName、角色下拉（PUT 的 upsert 語意——改角色跟新增共用
 * 同一支 `usePutShare`）、移除鈕（DELETE，觸發 server 端 `onShareChanged` 重驗）。 */
function ShareRow({ noteId, share }: { noteId: string; share: ShareDto }) {
  const { t } = useTranslation();
  const putShare = usePutShare(noteId);
  const deleteShare = useDeleteShare(noteId);

  async function handleRoleChange(role: ShareRole): Promise<void> {
    try {
      await putShare.mutateAsync({ email: share.email, role });
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  async function handleRemove(): Promise<void> {
    try {
      await deleteShare.mutateAsync(share.userId);
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <li className="flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{share.displayName}</p>
        <p className="truncate text-xs text-muted-foreground">{share.email}</p>
      </div>
      <select
        aria-label={t("share.roleLabel", { email: share.email })}
        value={share.role}
        disabled={putShare.isPending}
        onChange={(event) => void handleRoleChange(event.target.value as ShareRole)}
        className={SELECT_CLASS}
      >
        <option value="viewer">{t("roles.viewer")}</option>
        <option value="editor">{t("roles.editor")}</option>
      </select>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        aria-label={t("share.remove", { email: share.email })}
        disabled={deleteShare.isPending}
        onClick={() => void handleRemove()}
      >
        <Trash className="h-4 w-4" />
      </Button>
    </li>
  );
}

/** 分享名單 + 新增列。名單載入中／空清單各自的文案，跟 NoteList 的三態慣例一致。 */
function SharesSection({ noteId, title }: { noteId: string; title: string }) {
  const { t } = useTranslation();
  const sharesQuery = useShares(noteId);
  const putShare = usePutShare(noteId);

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<ShareRole>("viewer");
  const [addError, setAddError] = useState<string | null>(null);

  async function handleAdd(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setAddError(null);
    const trimmed = email.trim();
    if (trimmed.length === 0) return;
    try {
      await putShare.mutateAsync({ email: trimmed, role });
      setEmail("");
      setRole("viewer");
    } catch (err) {
      setAddError(errorMessage(t, err));
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{title}</p>

      {sharesQuery.isPending ? (
        <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
      ) : sharesQuery.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(t, sharesQuery.error)}
        </p>
      ) : sharesQuery.data.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("share.noShares")}</p>
      ) : (
        <ul className="space-y-2">
          {sharesQuery.data.map((share) => (
            <ShareRow key={share.userId} noteId={noteId} share={share} />
          ))}
        </ul>
      )}

      <form onSubmit={(event) => void handleAdd(event)} className="flex items-center gap-2">
        <Input
          type="email"
          required
          placeholder={t("share.emailPlaceholder")}
          aria-label={t("share.emailPlaceholder")}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="min-w-0 flex-1"
        />
        <select
          aria-label={t("share.newRoleLabel")}
          value={role}
          onChange={(event) => setRole(event.target.value as ShareRole)}
          className={SELECT_CLASS}
        >
          <option value="viewer">{t("roles.viewer")}</option>
          <option value="editor">{t("roles.editor")}</option>
        </select>
        <Button type="submit" variant="outline" disabled={putShare.isPending}>
          {t("share.add")}
        </Button>
      </form>
      {addError && (
        <p role="alert" className="text-sm text-destructive">
          {addError}
        </p>
      )}
    </div>
  );
}

type AccessLevel = "private" | "members" | "public";

/** 三態的 derive（僅供 latch 初值與顯式重算點——不是持續同步）。 */
function deriveAccess(token: string | null, shares: ShareDto[]): AccessLevel {
  return token ? "public" : shares.length > 0 ? "members" : "private";
}

/**
 * 分享三態（#72，spec §4）：私人🔒／限定成員👥／公開連結🌐。
 *
 * **radio 是 sticky 的 UI state（latch）**：兩個 query（shares＋public-link）首次
 * 都拿到資料時 derive 一次初值；之前顯示 loading、**不選中任何 radio**——dialog
 * 內容是開啟才掛載、query 開啟當下必為 undefined，字面的「開啟時 derive」會讓
 * 已公開的筆記永遠顯示私人（安全性誤述，spec B4）。之後**使用者的選擇活到
 * dialog 關閉為止**（關閉即 unmount、重開重新 latch——由 ShareDialog 的
 * `open &&` 掛載結構保證，有測試釘住），沒有「資料變動時重算」的全域規則
 * （有的話「公開→限定成員（零成員）」與「移除最後一位成員」都會被 refetch 彈回
 * 私人）。
 *
 * **顯式重算點只有三個**（除此之外選擇不被覆寫）：
 *   ① mutation 失敗的復原（`recoverFromError`）：radio 已樂觀切走、動作卻沒成——
 *      不復原就是「畫面說已撤銷、連結還活著」的安全性誤述，且 sticky 讓它永遠
 *      不會自己修正；
 *   ② 私人確認流的取消鈕：什麼都沒動，radio 回實況；
 *   ③ 私人確認流中止（部分失敗）：refetch 後依新資料重算。
 *
 * 成員名單與加人表單在**三態都渲染**（SharesSection 原樣）——radio 只是動作
 * 觸發器：在「私人」態加人不會重算 selection（刻意）。**確認流懸掛中**成員被
 * 名單那側清空時，effect 會替使用者把剩下的「撤連結」做完（否則動作憑空蒸發：
 * radio 顯示私人、連結還活著——審查探針實測過的路徑）。
 *
 * 私人確認流（D3）：行內確認列出將移除成員數；確認後**先 DELETE public-link、
 * 再循序 DELETE shares**（順序承重：中止時最壞是「還剩幾位成員」，不是「連結
 * 還開著」）。
 */
function AccessSection({ note }: { note: NoteDto }) {
  const noteId = note.id;
  const { t } = useTranslation();
  const sharesQuery = useShares(noteId);
  const linkQuery = usePublicLink(noteId);
  const createLink = useCreatePublicLink(noteId);
  const deleteLink = useDeletePublicLink(noteId);
  const deleteShare = useDeleteShare(noteId);

  const [selection, setSelection] = useState<AccessLevel | null>(null); // null＝尚未 latch
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const latched = selection !== null;
  const token = linkQuery.data?.token ?? null;
  const shares = sharesQuery.data ?? [];
  const queriesFailed = linkQuery.isError || sharesQuery.isError;

  useEffect(() => {
    if (selection === null && linkQuery.data !== undefined && sharesQuery.data !== undefined) {
      setSelection(deriveAccess(linkQuery.data.token, sharesQuery.data));
    }
  }, [selection, linkQuery.data, sharesQuery.data]);

  /** 顯式重算點①：mutation 失敗——toast、refetch 兩個 query、radio 依新資料重算。 */
  async function recoverFromError(err: unknown): Promise<void> {
    toast({ title: errorMessage(t, err), variant: "destructive" });
    const [freshShares, freshLink] = await Promise.all([sharesQuery.refetch(), linkQuery.refetch()]);
    setSelection(deriveAccess(freshLink.data?.token ?? null, freshShares.data ?? []));
  }

  /** 撤銷公開連結（失敗即復原——裸 mutate 的靜默失敗是審查抓到的安全性誤述）。 */
  async function revokeLink(): Promise<void> {
    try {
      await deleteLink.mutateAsync();
    } catch (err) {
      await recoverFromError(err);
    }
  }

  /** 產生／重生公開連結（失敗即復原，同上）。回傳是否成功——OFF 態「重新產生」
   * （B1）需要知道換 token 這步有沒有成功，才能決定要不要接著換 slug：失敗時
   * 這裡已經 toast＋復原過一次，呼叫端不必也不該再顯示第二個錯誤，只需要中止、
   * 不得拿舊 token 硬換出一個新 slug。 */
  async function mintLink(): Promise<boolean> {
    try {
      await createLink.mutateAsync();
      return true;
    } catch (err) {
      await recoverFromError(err);
      return false;
    }
  }

  // 確認流懸掛中成員被名單那側清空（同面板兩公分外的移除鈕）→ 替使用者把
  // 「撤連結」補完，不讓動作蒸發。sharesQuery.data 檢查：refetch 期間 shares 的
  // fallback [] 不算「清空了」。
  useEffect(() => {
    if (!confirming || sharesQuery.data === undefined || sharesQuery.data.length > 0) return;
    setConfirming(false);
    if (token) void revokeLink();
    // revokeLink/token 刻意不進 deps：這個 effect 只該在「確認中＋名單變空」的
    // 邊緣觸發一次，token 翻 null（撤銷完成）不該再跑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [confirming, sharesQuery.data]);

  function pick(next: AccessLevel): void {
    if (!latched || busy) return;
    setConfirming(false);
    if (next === "public") {
      setSelection("public");
      // token 已存在不重生（PUT＝重生、非冪等——重生只走 Regenerate 鈕）。
      if (!token) void mintLink();
      return;
    }
    if (next === "members") {
      setSelection("members");
      if (token) void revokeLink();
      return;
    }
    setSelection("private");
    if (shares.length > 0) {
      setConfirming(true); // 有成員：行內確認後才動手
    } else if (token) {
      void revokeLink();
    }
  }

  async function confirmPrivate(): Promise<void> {
    setBusy(true);
    try {
      // 順序承重：先撤連結再清成員——中止時最壞是「還剩幾位成員」。
      if (token) await deleteLink.mutateAsync();
      for (const share of shares) {
        await deleteShare.mutateAsync(share.userId);
      }
      setConfirming(false);
    } catch (err) {
      // 顯式重算點③：中止＋依 refetch 後資料重算，殘餘名單如實呈現。
      await recoverFromError(err);
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  }

  const options: Array<{ value: AccessLevel; label: string; desc: string }> = [
    { value: "private", label: t("share.access.private"), desc: t("share.access.privateDesc") },
    { value: "members", label: t("share.access.members"), desc: t("share.access.membersDesc") },
    { value: "public", label: t("share.access.public"), desc: t("share.access.publicDesc") },
  ];

  return (
    <ShareGroup title={t("share.access.title")}>

      {queriesFailed && (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage(t, linkQuery.error ?? sharesQuery.error)}
        </p>
      )}

      <div role="radiogroup" aria-label={t("share.access.title")} aria-busy={!latched} className="space-y-1">
        {options.map((option) => (
          <label
            key={option.value}
            className="flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/60"
          >
            <input
              type="radio"
              name="share-access"
              className="mt-1"
              checked={selection === option.value}
              disabled={!latched || busy}
              onChange={() => pick(option.value)}
            />
            <span className="flex flex-col">
              <span className="text-sm">{option.label}</span>
              <span className="text-xs text-muted-foreground">{option.desc}</span>
            </span>
          </label>
        ))}
      </div>

      {!latched && !queriesFailed && <p className="text-sm text-muted-foreground">{t("app.loading")}</p>}

      {confirming && shares.length > 0 && (
        // role="alert"：破壞性確認憑空長出來，鍵盤/AT 使用者按下 radio 後要被告知。
        <div role="alert" className="space-y-2 rounded-md border border-destructive/40 p-2">
          <p className="text-sm">
            {token
              ? t("share.access.confirmHintWithLink", { count: shares.length })
              : t("share.access.confirmHint", { count: shares.length })}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => void confirmPrivate()}>
              {t("share.access.confirmPrivate", { count: shares.length })}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => {
                // 顯式重算點②：取消＝什麼都沒動，radio 回實況（沒有這行會停在
                // 「私人」而連結還活著——載重，別當成可省的糖）。
                setConfirming(false);
                setSelection(deriveAccess(token, shares));
              }}
            >
              {t("share.access.confirmCancel")}
            </Button>
          </div>
        </div>
      )}

      {/* 情境面板：**選了哪一層，就只看到那一層需要的東西**。
          改版前成員名單是跟「存取權」平級的獨立區塊，看起來像不管選什麼都適用；
          公開連結的細節則另外藏在下面。兩者其實都只屬於某一個選項，收進來之後
          「這些設定屬於我剛剛選的那個」才看得出來，同時畫面上的輸入框也少一半。
          ⚠ 副作用：私人狀態下不再直接出現邀請表單（要先選「限定成員」）——
          `e2e/tests/03-share-revoke.spec.ts` 因此多一步點選，那條刻意的捷徑
          由 Willie 2026-09-17 裁定換掉。 */}
      {latched && selection === "members" && (
        <div className="rounded-md bg-muted/40 p-3">
          <SharesSection noteId={note.id} title={t("share.membersPanelTitle")} />
        </div>
      )}

      {selection === "public" && token && (
        <PublicLinkPanel
          noteId={note.id}
          ownerHandle={note.ownerHandle}
          token={token}
          slug={linkQuery.data?.slug ?? null}
          onRegenerateToken={mintLink}
          regenerateTokenPending={createLink.isPending}
        />
      )}
    </ShareGroup>
  );
}

const RANDOM_SLUG_ATTEMPTS = 5;

/** 匿名態公開連結網址的前綴（N3）：組完整網址（`linkUrl`）與畫面上顯示的前綴
 * 文字兩處都要用這個常數——各自拼一份字面 `"/p/"` 就是這個檔案自己在
 * `publicAliasPath` 那段 JSDoc 裡明令禁止的漂移形，這裡是同一份紀律套在匿名分支
 * （OFF 態的前綴走 `publicAliasPath({ handle, slug: "" })`，本來就只有一處）。 */
const ANONYMOUS_LINK_PREFIX = "/p/";

/**
 * 隨機 slug（16 位小寫十六進位＝64 bits，`crypto.getRandomValues`）：切匿名 OFF
 * 的預設候選、以及 OFF 態按「重新產生」的候選。⚠ **這不是安全邊界**——匿名模式
 * 真正的安全邊界在另一側的 256-bit token（server 產生）；這裡的隨機性只是避免
 * 「今天新建的第幾篇筆記」這種好記慣用名而已，不是防猜測強度考量，日後別誤用
 * 在任何真的需要抗猜測的地方。
 *
 * hex charset（`0-9a-f`）本就是 `validateSlug` charset（`\p{L}\p{N}-`）的子集、
 * 16 字元落在長度 1–100 內、不含 `-` 所以 dash 分支必過、不是保留字、不含 `-`
 * 也就不可能符合 `UUID_RE`／`UUID_SUFFIX_RE`（兩者都要求 dash 分段）——但**仍在
 * 產生後呼叫 `validateSlug` 斷言**，不假設建構方式一定過（交辦明令）；斷言失敗
 * 就重產，重試上限次數後放棄並回 null 讓呼叫端顯示錯誤。
 */
function generateRandomSlugCandidate(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function generateValidatedRandomSlug(): string | null {
  for (let attempt = 0; attempt < RANDOM_SLUG_ATTEMPTS; attempt++) {
    const candidate = generateRandomSlugCandidate();
    if (validateSlug(candidate) === null) return candidate;
  }
  return null;
}

/**
 * 公開連結面板（Willie 2026-09-17 產品決定，取代舊「token 唯讀連結」＋「公開別名
 * 欄位」兩個並列區塊）：**一個匿名 toggle ＋ 一條連結 ＋ 最多三顆鈕**。只在公開態
 * 渲染（呼叫端已鎖在 `selection === "public" && token` 內）。
 *
 * **模式由既有資料推導，不是獨立 state**：`slug` 為 `null` ⇔ 匿名 ON（網址
 * `/p/<token>`，不可編輯，鈕只有複製／重新產生）；`slug` 有值 ⇔ 匿名 OFF（網址
 * `/p/<handle>/<slug>`，多一顆「儲存」＋可猜警語）。`anonymous` 直接 `slug ===
 * null`，**不是另開一份 optimistic toggle state**——好處是失敗復原不必額外寫
 * 「彈回」邏輯：mutation 沒成功，`slug` prop 就沒變，toggle 呈現的模式自然還是
 * 原本那個（裸 `mutate()` 才會製造「畫面先切、失敗後卡住」的假象）。
 *
 * - **切 OFF**＝`useSetPublicSlug` 寫入前端產生的隨機 slug；**切 ON**＝
 *   `useClearPublicSlug`。「重新產生」在 ON 態＝換 token（呼叫端傳入的
 *   `onRegenerateToken`，即 `AccessSection.mintLink`，其 `useCreatePublicLink`
 *   已是 mutateAsync＋recoverFromError）；在 OFF 態（B1 修正，2026-09-17）＝
 *   **同時換 token 與 slug**——先換 token 再換 slug，任一步失敗都中止並走既有
 *   錯誤呈現。理由：OFF 態的網址是 `/p/<handle>/<slug>`，不含 token，但 token
 *   仍是唯一的安全邊界；只換 slug、不換 token 的話，外洩過的 256-bit token
 *   永遠沒有輪替的入口——即使使用者以為自己按了「重新產生連結」。
 *   `onRegenerateToken` 回傳是否成功（`Promise<boolean>`），失敗時 `mintLink`
 *   已經自己 toast＋復原過一次，這裡不重複顯示、只中止，不得拿舊 token 換出
 *   一個新 slug。
 * - **一律 `mutateAsync` ＋ catch → `setError`**：toggle／regenerate／save 三個
 *   動作共用同一顆 `error` state（同時只會有一個在跑，`busy` 互斥），裸 `mutate()`
 *   的靜默失敗＝安全性誤述（見 `突變驗證`：把 catch 拿掉會讓失敗復原測試翻紅）。
 * - OFF 態沿用 #122 PR3 的別名輸入慣例：`normalizeSlug`→`validateSlug` 本地先擋、
 *   `share.slugError.*` 文案、`#share-public-slug-prefix`／`#share-public-slug-hint`
 *   兩個 id（e2e 11-public-share 讀前綴，別改名）。a11y 名字契約沿用：input＝
 *   "Custom public link"、存鈕 aria-label＝"Save custom URL"（⊃ "Save"，e2e 查裸
 *   "Save" 需 `exact: true`）。
 * - ⚠ props 變、state 不變的皺褶（`value` 只在掛載與本元件自己的 mutation 成功
 *   後更新；跨分頁 focus refetch 換了 slug 不會自動流進 `value`）——沿用舊
 *   `PublicAliasField` 就有的已知限制，範圍外不修。
 */
function PublicLinkPanel({
  noteId,
  ownerHandle,
  token,
  slug,
  onRegenerateToken,
  regenerateTokenPending,
}: {
  noteId: string;
  ownerHandle: string;
  token: string;
  slug: string | null;
  onRegenerateToken: () => Promise<boolean>;
  regenerateTokenPending: boolean;
}) {
  const { t } = useTranslation();
  const setSlug = useSetPublicSlug(noteId);
  const clearSlug = useClearPublicSlug(noteId);

  const anonymous = slug === null;
  const [value, setValue] = useState(slug ?? "");
  const [error, setError] = useState<string | null>(null);

  const trimmed = value.trim();
  const normalized = trimmed.length > 0 ? normalizeSlug(trimmed) : "";
  const localReason = trimmed.length > 0 ? validateSlug(normalized) : null;
  const localError = localReason ? t(`share.slugError.${localReason}`) : null;
  const dirty = trimmed !== (slug ?? "");
  const busy = setSlug.isPending || clearSlug.isPending || regenerateTokenPending;

  const linkUrl = anonymous
    ? `${window.location.origin}${ANONYMOUS_LINK_PREFIX}${token}`
    : `${window.location.origin}${publicAliasPath({ handle: ownerHandle, slug: slug ?? "" })}`;

  /** OFF 態的隨機 slug 動作（切 OFF、與 OFF 態按重新產生）共用這段：產生→驗證
   * →mutateAsync→catch。產生失敗（極端邊界，理論上不會發生）與 mutation 失敗
   * 共用同一個 `error` 呈現面，不特別區分成因。 */
  async function applyRandomSlug(): Promise<void> {
    const candidate = generateValidatedRandomSlug();
    if (candidate === null) {
      setError(t("share.publicSlug.randomSlugFailed"));
      return;
    }
    try {
      const updated = await setSlug.mutateAsync(candidate);
      setValue(updated.slug ?? candidate);
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  /** 匿名 toggle：ON→OFF 切隨機 slug；OFF→ON 清 slug 退回 token 網址。失敗即
   * 復原——`slug` prop 沒變，`anonymous` 直接派生，畫面自然停在原模式。 */
  async function handleToggle(): Promise<void> {
    if (busy) return;
    setError(null);
    if (anonymous) {
      await applyRandomSlug();
      return;
    }
    try {
      await clearSlug.mutateAsync();
      setValue("");
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  async function handleRegenerate(): Promise<void> {
    if (busy) return;
    setError(null);
    if (anonymous) {
      await onRegenerateToken();
      return;
    }
    // OFF 態（B1 修正）：同時換 token 與 slug——先換 token，成功才接著換 slug。
    // token 失敗就地中止：`mintLink` 已經走 `AccessSection` 既有的錯誤呈現
    // （toast＋selection 復原），這裡不重複顯示，也不得拿舊 token 換出一個新 slug。
    const tokenRegenerated = await onRegenerateToken();
    if (!tokenRegenerated) return;
    await applyRandomSlug();
  }

  async function handleSave(): Promise<void> {
    if (localError || trimmed.length === 0 || !dirty || busy) return;
    setError(null);
    try {
      const updated = await setSlug.mutateAsync(normalized);
      setValue(updated.slug ?? "");
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <div role="group" aria-label={t("share.publicPanelTitle")} className="space-y-2 rounded-md bg-muted/40 p-3">
      <p className="text-sm font-medium">{t("share.publicPanelTitle")}</p>

      <div className="flex items-center gap-2">
        <Switch
          id="share-anonymous-toggle"
          checked={anonymous}
          disabled={busy}
          onCheckedChange={() => void handleToggle()}
        />
        <label htmlFor="share-anonymous-toggle" className="text-sm font-medium">
          {t("share.anonymous.label")}
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{t("share.anonymous.desc")}</p>

      {/* 兩種型態共用同一個形狀：**前綴文字 ＋ 輸入框**。匿名態的輸入框唯讀
          （那條網址不可自訂），但仍是輸入框——可以選取、可以手動複製，而且切換
          toggle 時版面不會從「一段文字」跳成「一排欄位」。 */}
      <div className="flex items-center gap-2">
        {/* 前綴走 publicAliasPath（slug 留空恰得 `/p/<handle>/`）——與複製網址同一
            組字點，兩處各自拼字串就是 shared JSDoc 明令禁止的漂移形。匿名態沒有
            handle 這一段，前綴就是 `/p/`。 */}
        <span id="share-public-slug-prefix" className="shrink-0 text-xs text-muted-foreground">
          {anonymous ? ANONYMOUS_LINK_PREFIX : publicAliasPath({ handle: ownerHandle, slug: "" })}
        </span>
        <Input
          id="share-public-slug"
          readOnly={anonymous}
          aria-label={anonymous ? t("share.access.publicUrlLabel") : t("share.publicSlug.label")}
          aria-describedby="share-public-slug-prefix share-public-slug-hint"
          value={anonymous ? token : value}
          disabled={!anonymous && busy}
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
          className="min-w-0 flex-1 text-xs"
        />
      </div>

      <div className="flex flex-wrap gap-2">
        <PublicCopyButton url={linkUrl} />
        {/* 與「複製連結」平級（同一排、都是這個面板的主要動作），所以是 `outline` 不是
            `ghost`——ghost 沒有邊框與底色，單獨站著看不出來是按鈕（使用者回報）。
            `ghost` 留給「附屬在某一列、跟在主動作後面」的還原型動作（清除、回自動）。 */}
        <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void handleRegenerate()}>
          {t("share.access.regenerate")}
        </Button>
        {!anonymous && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={t("share.publicSlug.saveLabel")}
            onClick={() => void handleSave()}
            disabled={!dirty || trimmed.length === 0 || localError !== null || busy}
          >
            {t("share.publicSlug.save")}
          </Button>
        )}
      </div>

      {!anonymous && (
        <p id="share-public-slug-hint" className="text-xs text-muted-foreground">
          {t("share.publicSlug.hint")}
        </p>
      )}

      {localError && (
        <p role="alert" className="text-sm text-destructive">
          {localError}
        </p>
      )}
      {!localError && error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** 複製公開連結（`lib/clipboard.ts` 的 clipboard 三段退路，語意分明：這顆複製
 * 的是免登入的 /p/ 連結，匿名 ON/OFF 兩態共用同一顆——只有一條連結，不需要
 * 兩個不同名字）。`label` 保留為選用參數（過去多連結並存時用來分名），目前
 * 唯一呼叫點不傳、落回 `share.copyPublicLink` 預設文案。 */
function PublicCopyButton({ url, label }: { url: string; label?: string }) {
  const { t } = useTranslation();
  const [manualUrl, setManualUrl] = useState<string | null>(null);

  async function handleCopy(): Promise<void> {
    if (await copyText(url)) {
      setManualUrl(null);
      toast({ title: t("share.linkCopied") });
      return;
    }
    setManualUrl(url);
  }

  return (
    <div className="flex flex-col gap-2">
      {/* ⚠ 不要用 `variant="secondary"`：`--secondary` 在淺色是 oklch(0.97)、和
          面板底（`--popover`＝白）幾乎同色，在深色則與 `--accent` **同值**——也就是
          ghost 按鈕的 hover 底色。結果是這顆鈕看起來像一塊 hover 高亮而不是按鈕
          （使用者回報）。`outline` 有邊框，任何主題下都看得出是可按的東西。 */}
      <Button type="button" variant="outline" size="sm" onClick={() => void handleCopy()}>
        {label ?? t("share.copyPublicLink")}
      </Button>
      {manualUrl !== null && <ManualCopyField value={manualUrl} />}
    </div>
  );
}

export interface ShareDialogProps {
  note: NoteDto;
}

/**
 * 分享管理 dialog（spec：owner-only）。非 owner（editor/viewer）完全不渲染——連觸發鈕
 * 都不出現，不只是「按了也沒用」而已。
 *
 * 觸發鈕圖示需要知道目前的分享狀態才能選對圖示（私人🔒／限定成員／公開🌐），
 * 所以 `useShares`／`usePublicLink` 這兩支 query 在 owner 的筆記頁**一載入就會發**，
 * 不等 dialog 開啟（見下方 hook 呼叫旁的說明）。**面板內容仍只在實際開啟時掛載**
 * （`open && <AccessSection ...>`）——提前的只有這兩支狀態查詢，不是整個面板；
 * `AccessSection` 內部的 `useShares`／`usePublicLink` 與這裡共用同一份 react-query
 * 快取（同 key 去重），所以不會因此多打第三支請求。
 *
 * PR2（D.3）：觸發鈕改成 icon-only（原本是帶文字的按鈕）——`aria-label={t("share.button")}`
 * 頂住 accessible name，`ShareDialog.test.tsx` 既有的 `getByRole("button",{name:"Share"})`
 * 查詢不受影響（文字不變，只是從內容搬進 aria-label）。面板內容（`DialogContent` 以下）
 * 零改動。
 */
export function ShareDialog({ note }: ShareDialogProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const isOwner = note.role === "owner";

  // 觸發鈕圖示要跟著分享狀態變（私人=鎖／限定成員=分享圖示／公開=地球，
  // UI 改版設計、#72 收尾）。react-query 同 key 去重——這裡跟 `AccessSection`
  // 內既有的呼叫共用快取，不會多打請求；但提前呼叫讓對話框**關著**時也能
  // 拿到狀態，這是唯一的目的。⚠ 不動 `AccessSection` 的 latch effect 一行：
  // 那個 effect 只管 `selection` 這個 sticky UI state，跟這裡選圖示用的
  // 「目前資料」是兩件事——latch 的 selection 有可能因為使用者操作而跟目前
  // 資料暫時不同步（sticky 設計），觸發鈕圖示不追那個、只反映實際資料。
  // ⚠ Hook 呼叫本身必須無條件（react-hooks/rules-of-hooks）——不能真的把
  // 呼叫包在 `!isOwner` 早退之後。非 owner 時傳空字串 noteId，讓兩支 hook
  // 內建的 `enabled: noteId.length > 0` 守衛頂住，query 不會發（維持
  // 「非 owner 完全零 fetch」的既有測試斷言）。
  const sharesQuery = useShares(isOwner ? note.id : "");
  const linkQuery = usePublicLink(isOwner ? note.id : "");

  if (!isOwner) return null;

  const triggerLoading = sharesQuery.data === undefined || linkQuery.data === undefined;
  const triggerAccess: AccessLevel | null = triggerLoading
    ? null
    : deriveAccess(linkQuery.data.token, sharesQuery.data);
  // 載入中一律用既有的 Share 圖示，不閃爍、不猜狀態。
  const TriggerIcon = triggerAccess === "private" ? Lock : triggerAccess === "public" ? Globe : Share;
  const triggerTitle =
    triggerAccess === "private"
      ? t("share.state.private")
      : triggerAccess === "members"
        ? t("share.state.members")
        : triggerAccess === "public"
          ? t("share.state.public")
          : undefined;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {/* text-brand 必須放在 Button 的 className（不是掛在 <Share/> icon 上）：
            twMerge 對 ghost variant 的 hover:text-accent-foreground 互斥掉這裡的
            hover:text-brand，只在同一次 cn() 呼叫內才成立——掛在 icon 上是不同
            元素、不同 cn() 呼叫，機制不會生效。hover:bg-accent 底變化沿用 ghost
            variant，不動。
            ⚠ 狀態用 `title`（tooltip），不是 aria-label——`aria-label` 在場時
            `title` 不會改變可及名稱，`aria-label={t("share.button")}` 必須維持
            固定的 "Share"（e2e `03-share-revoke.spec.ts` 與單元測試都靠這個
            名字找按鈕）。 */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t("share.button")}
          title={triggerTitle}
          className="text-brand hover:text-brand"
        >
          <TriggerIcon className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      {/* 448px 時「email ＋ 角色下拉 ＋ 新增」擠成一排放不下，加大到 512px
          （＝`DialogContent` default variant 本來的寬度，這裡不再另外收窄）。 */}
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("share.title")}</DialogTitle>
          <DialogDescription>{t("share.description")}</DialogDescription>
        </DialogHeader>
        {/* 內部自訂網址（原「連結」區塊：CopyLinkButton／SlugField）已下架
            （Willie 2026-09-17 產品決定）——要連到某篇筆記用 `[[標題]]` wikilink，
            協作者本來就會在自己的工作區看到那篇筆記，不需要傳連結。分享面板
            現在只剩一組「存取權」，不再需要 `divide-y` 分隔多組。 */}
        {open && <AccessSection note={note} />}
      </DialogContent>
    </Dialog>
  );
}
