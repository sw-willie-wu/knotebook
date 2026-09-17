import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApiTokenDto } from "@knotebook/shared";
import {
  useApiTokens,
  useCreateApiToken,
  useRenameApiToken,
  useRevokeApiToken,
  type CreateApiTokenInput,
} from "@/api/apiTokens";
import { ApiFail } from "@/api/client";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import { SettingsGroup } from "./SettingsLayout";

/** 逐檔複製的既有慣例（無共用 helper——比照 ShareDialog／SettingsAccountSection）。 */
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/**
 * repo 沒有 `ui/select.tsx`——原生 `<select>` 加一條 tailwind 字串是既有慣例，
 * 每個用到的檔案各自宣告一份（`ShareDialog.tsx`、`SettingsAiSection.tsx` 同形）。
 * 刻意不抽共用常數：那幾處的尺寸各自跟著所在版面調過，抽出來會變成「改一處動三處」。
 */
const SELECT_CLASS =
  "h-8 shrink-0 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus-visible:outline-none " +
  "focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

/** 撤銷確認（比照 SettingsAiSection 的 DeleteProviderDialog）。 */
function RevokeDialog({ token }: { token: ApiTokenDto }) {
  const { t } = useTranslation();
  const revoke = useRevokeApiToken();
  const [open, setOpen] = useState(false);

  async function confirm(): Promise<void> {
    try {
      await revoke.mutateAsync(token.id);
      setOpen(false);
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          {t("settings.account.apiTokensRevoke")}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings.account.apiTokensRevokeTitle")}</DialogTitle>
          <DialogDescription>{t("settings.account.apiTokensRevokeDescription", { name: token.name })}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              {t("settings.account.apiTokensCancel")}
            </Button>
          </DialogClose>
          <Button type="button" variant="destructive" disabled={revoke.isPending} onClick={() => void confirm()}>
            {t("settings.account.apiTokensRevokeConfirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 建立表單。成功後**在同一個對話框內**切換成「一次性顯示明文」畫面——明文只會
 * 出現這一次，而 toast 5 秒就消失、也不可選取複製，不適合承載它。
 */
function CreateTokenDialog() {
  const { t } = useTranslation();
  const create = useCreateApiToken();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [scope, setScope] = useState<CreateApiTokenInput["scope"]>("notes:read");
  const [expiresInDays, setExpiresInDays] = useState<CreateApiTokenInput["expiresInDays"]>(null);
  const [issued, setIssued] = useState<string | null>(null);

  function reset(): void {
    setName("");
    setScope("notes:read");
    setExpiresInDays(null);
    setIssued(null);
  }

  async function submit(): Promise<void> {
    try {
      const created = await create.mutateAsync({ name: name.trim(), scope, expiresInDays });
      setIssued(created.token);
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          {t("settings.account.apiTokensCreate")}
        </Button>
      </DialogTrigger>
      <DialogContent
        // 明文只出現這一次（I2）：明文畫面擋掉 Esc 與點外面，誤觸會讓這支 token 直接報銷
        // （還吃掉 I1 的 20 額度）。只留 Done 與右上 X 這兩個明確的關閉動作。
        onEscapeKeyDown={event => {
          if (issued !== null) event.preventDefault();
        }}
        onPointerDownOutside={event => {
          if (issued !== null) event.preventDefault();
        }}
      >
        {issued === null ? (
          <form
            onSubmit={event => {
              event.preventDefault();
              void submit();
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("settings.account.apiTokensCreate")}</DialogTitle>
              {/* 刻意用專屬短句，不重複區塊本體那段長說明（同一頁出現兩次會讓
                  getByText 撞多重匹配，讀起來也囉唆）。 */}
              <DialogDescription>{t("settings.account.apiTokensCreateHint")}</DialogDescription>
            </DialogHeader>
            <div className="space-y-3 py-3">
              <Input
                value={name}
                aria-label={t("settings.account.apiTokensNameLabel")}
                placeholder={t("settings.account.apiTokensNamePlaceholder")}
                maxLength={64}
                onChange={event => setName(event.target.value)}
              />
              <select
                className={SELECT_CLASS}
                aria-label={t("settings.account.apiTokensScopeLabel")}
                value={scope}
                onChange={event => setScope(event.target.value as CreateApiTokenInput["scope"])}
              >
                <option value="notes:read">{t("settings.account.apiTokensScopeRead")}</option>
                <option value="notes:write">{t("settings.account.apiTokensScopeWrite")}</option>
              </select>
              <select
                className={SELECT_CLASS}
                aria-label={t("settings.account.apiTokensExpiryLabel")}
                value={expiresInDays === null ? "never" : String(expiresInDays)}
                onChange={event =>
                  setExpiresInDays(event.target.value === "never" ? null : (Number(event.target.value) as 30 | 90 | 365))
                }
              >
                <option value="never">{t("settings.account.apiTokensExpiryNever")}</option>
                {[30, 90, 365].map(days => (
                  <option key={days} value={days}>
                    {t("settings.account.apiTokensExpiryDays", { days })}
                  </option>
                ))}
              </select>
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  {t("settings.account.apiTokensCancel")}
                </Button>
              </DialogClose>
              <Button type="submit" variant="brandDeep" disabled={create.isPending || name.trim() === ""}>
                {t("settings.account.apiTokensSubmit")}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("settings.account.apiTokensTitle")}</DialogTitle>
              <DialogDescription>{t("settings.account.apiTokensOnceWarning")}</DialogDescription>
            </DialogHeader>
            {/* 明文永遠可選取複製——不靠 toast（5 秒就消失、不可選取），也不假設
                剪貼簿 API 一定成功。**刻意不複用 ManualCopyField**：它硬寫的說明是
                「自動複製失敗，請手動選取」（share.copyFailed），語意不對；而且它內含
                自己的 DialogDescription，放進這裡會讓同一個 DialogContent 出現兩個，
                Radix 的 aria-describedby 會重複。 */}
            <Input
              readOnly
              value={issued}
              aria-label={t("settings.account.apiTokensValueLabel")}
              className="font-mono"
              autoFocus
              onFocus={event => event.currentTarget.select()}
            />
            <DialogFooter>
              <Button
                type="button"
                // ⚠ 不用 `secondary`：`--secondary` 淺色是 oklch(0.97)、與面板底幾乎同色，
                // 深色則與 `--accent`（ghost 的 hover 底）同值——看起來像 hover 高亮不像按鈕。
                variant="outline"
                onClick={() => {
                  void copyText(issued).then(ok => {
                    // 失敗不攤 ManualCopyField（理由見上）：明文本來就在欄位裡可選取，提示即可
                    toast(
                      ok
                        ? { title: t("settings.account.apiTokensCopied") }
                        : { title: t("settings.account.apiTokensCopyFailed"), variant: "destructive" }
                    );
                  });
                }}
              >
                {t("settings.account.apiTokensCopy")}
              </Button>
              <DialogClose asChild>
                <Button type="button" variant="brandDeep">{t("settings.account.apiTokensDone")}</Button>
              </DialogClose>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * agent 名稱（#106 D7）：AI 名牌與修改紀錄上顯示的短名。
 *
 * - 顯示值恆非 null——欄位為 NULL 時 server 回 `deriveAgentLabel(name)` 的派生值。
 * - **清空＝送 `null`**（不是空字串）：那是「把欄位清成 NULL、回到派生值」，server
 *   端的 `AGENT_LABEL_RE` 也不收空字串。
 * - Enter 送出；**沒有 Esc 取消**——這個欄位在 `SettingsModal` 的 `DialogContent` 裡，
 *   Radix 在 **document 的 capture 階段**監聽 Escape，這個 input 上的 `onKeyDown`（bubble
 *   階段）永遠來不及擋下它，`stopPropagation` 也無效（capture 已經跑完才輪到 bubble）。
 *   結果是整個設定 dialog 被關掉，不是「取消改名、留在設定頁」。`CreateTokenDialog` 的
 *   `onEscapeKeyDown`（掛在 `DialogContent` 本身）是這個元件庫支援的正確逃生路徑，但那個
 *   屬性要往上掛到 `SettingsModal` 的 `DialogContent`（本棒 17 個路徑之外），不在這棒範圍。
 *   **Cancel 按鈕是這個欄位自己就能給的逃生路徑**：不碰 Radix 的 Escape 監聽，欄位自己
 *   持有 `editing`／`draft` 兩個 state，按下去只是把 `editing` 撥回 `false`，不送請求、
 *   不動 `draft`——下次重新進入編輯時 `draft` 會被起始值蓋掉，不會殘留這次放棄的字串。
 */
function AgentLabelField({ token }: { token: ApiTokenDto }) {
  const { t } = useTranslation();
  const rename = useRenameApiToken();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(token.agentLabel);

  async function save(): Promise<void> {
    const trimmed = draft.trim();
    try {
      await rename.mutateAsync({ id: token.id, agentLabel: trimmed === "" ? null : trimmed });
      setEditing(false);
    } catch (err) {
      toast({ title: errorMessage(t, err), variant: "destructive" });
    }
  }

  if (!editing) {
    return (
      <>
        <span dir="ltr" className="shrink-0 text-xs text-muted-foreground [unicode-bidi:isolate]">
          ({token.agentLabel})
        </span>
        {/* 介面選擇的刻意偏離：這裡用文字按鈕，不是圖示按鈕——「更改 agent 名稱」不是
            一眼認得出圖示的動作，兩語系都用文字更不容易誤按。spec 與 plan 都不進版控，
            這行註解是這個偏離唯一留得下來的紀錄（比照 presence.ts 的 insert_after 偏離
            注記）。 */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setDraft(token.agentLabel);
            setEditing(true);
          }}
        >
          {t("settings.account.apiTokensRename")}
        </Button>
      </>
    );
  }

  return (
    <span className="flex min-w-0 flex-1 flex-col gap-1">
      <span className="flex items-center gap-1">
        <Input
          autoFocus
          value={draft}
          aria-label={t("settings.account.apiTokensAgentLabel")}
          maxLength={32}
          disabled={rename.isPending}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Enter") void save();
          }}
        />
        {/* 沒有 Esc（見檔頭）——這顆按鈕是這個欄位自己能給的退路，見上方 save() 旁的說明。
            N9：這裡坐在清單列裡，跟同列的 rename 鈕（ghost size="sm"）同一套視覺層級——
            outline 在列內會突兀地重一階，改回 ghost/sm 才跟同列一致。 */}
        <Button type="button" variant="ghost" size="sm" disabled={rename.isPending} onClick={() => setEditing(false)}>
          {t("settings.account.apiTokensCancel")}
        </Button>
      </span>
      <span className="text-xs text-muted-foreground">{t("settings.account.apiTokensRenameHint")}</span>
    </span>
  );
}

function TokenRow({ token }: { token: ApiTokenDto }) {
  const { t, i18n } = useTranslation();
  const expired = token.expiresAt !== null && new Date(token.expiresAt).getTime() <= Date.now();
  const formatDate = (iso: string): string => new Date(iso).toLocaleDateString(i18n.language);

  return (
    <li className="flex items-start justify-between gap-3 rounded-md border border-border p-2">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          {/* 名稱是外部字串（oauth 列是 client 自述）——bidi 隔離，避免 U+202E 之類
              的覆寫字元把下面那行「未經驗證」旁註在視覺上推走。 */}
          <span dir="ltr" className="truncate font-medium [unicode-bidi:isolate]">
            {token.name}
          </span>
          <AgentLabelField token={token} />
          <span className="shrink-0 rounded border border-border px-1 text-xs text-muted-foreground">
            {token.kind === "oauth" ? t("settings.account.apiTokensKindOauth") : t("settings.account.apiTokensKindPat")}
          </span>
        </div>
        {token.kind === "oauth" && (
          <p className="text-xs text-muted-foreground">{t("settings.account.apiTokensUnverifiedName")}</p>
        )}
        <p className="text-xs text-muted-foreground">
          {token.scope === "notes:read notes:write"
            ? t("settings.account.apiTokensScopeWrite")
            : t("settings.account.apiTokensScopeRead")}
          {" · "}
          {token.lastUsedAt === null
            ? t("settings.account.apiTokensNeverUsed")
            : t("settings.account.apiTokensLastUsed", { when: formatDate(token.lastUsedAt) })}
        </p>
        <p className="text-xs text-muted-foreground">
          {t("settings.account.apiTokensCreated", { when: formatDate(token.createdAt) })}
        </p>
        <p className={`text-xs ${expired ? "text-destructive" : "text-muted-foreground"}`}>
          {token.expiresAt === null
            ? t("settings.account.apiTokensNoExpiry")
            : expired
              ? t("settings.account.apiTokensExpired")
              : t("settings.account.apiTokensExpires", { when: formatDate(token.expiresAt) })}
        </p>
      </div>
      <RevokeDialog token={token} />
    </li>
  );
}

/**
 * 設定→帳號的「API token」段（#107）。
 *
 * **位置**：與 `HandleSection` 同層、在 `hasPassword` 三元式**之外**——SSO-only
 * 帳號也要能建 PAT（他們沒有密碼可用，更需要 token 這條路）。
 */
export function ApiTokensSection() {
  const { t } = useTranslation();
  const tokens = useApiTokens();

  return (
    <SettingsGroup
      title={t("settings.account.apiTokensTitle")}
      description={t("settings.account.apiTokensDescription")}
      // 建立鈕掛在這一組的標題列，不再墊在清單底下——動作要跟它所屬的那件事同一行，
      // 才看得出來它建的是 token 而不是別的東西。
      action={<CreateTokenDialog />}
    >
      <div className="space-y-2">
        {tokens.isError && (
          <p role="alert" className="text-sm text-destructive">
            {t("errors.fallback")}
          </p>
        )}
        {tokens.data !== undefined && tokens.data.length === 0 && (
          <p className="text-sm text-muted-foreground">{t("settings.account.apiTokensEmpty")}</p>
        )}
        {tokens.data !== undefined && tokens.data.length > 0 && (
          <ul className="space-y-2">
            {tokens.data.map(token => (
              <TokenRow key={token.id} token={token} />
            ))}
          </ul>
        )}
        {/* 清理提示是看完自己有哪些 token 之後才用得上的附註，所以放在清單後面當註腳，
            不擠在說明下面跟它搶同一個位置。 */}
        <p className="max-w-prose pt-1 text-justify text-xs text-muted-foreground hyphens-auto">
          {t("settings.account.apiTokensCleanupHint")}
        </p>
      </div>
    </SettingsGroup>
  );
}
