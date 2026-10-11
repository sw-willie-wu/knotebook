import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AGENT_LABEL_RE, deriveAgentLabel, type ApiTokenDto, type TokenScope } from "@knotebook/shared";
import {
  useApiTokens,
  useCreateApiToken,
  useRevokeApiToken,
  useUpdateApiToken,
  type CreateApiTokenInput,
  type UpdateApiTokenPatch,
} from "@/api/apiTokens";
import { ApiFail } from "@/api/client";
import { Pill } from "@/components/management/Pill";
import { ROW_ICON_BUTTON, ROW_ICON_DANGER } from "@/components/management/row-actions";
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
import { Pencil, Trash } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import { checksFromScope, scopeFromChecks, type ScopeChecks } from "@/lib/token-scope";
import { cn } from "@/lib/utils";
import { ScopeTogglesField } from "./ScopeTogglesField";
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
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={ROW_ICON_DANGER}
          title={t("settings.account.apiTokensRevoke")}
          aria-label={t("settings.account.apiTokensRevoke")}
        >
          <Trash className="h-4 w-4" aria-hidden="true" />
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
  // #239 W7'：兩個開關預設都關（＝唯讀）；#247 W22 起用 toggle（ScopeTogglesField）。
  const [checks, setChecks] = useState<ScopeChecks>({ write: false, move: false });
  const [expiresInDays, setExpiresInDays] = useState<CreateApiTokenInput["expiresInDays"]>(null);
  const [issued, setIssued] = useState<string | null>(null);

  function reset(): void {
    setName("");
    setChecks({ write: false, move: false });
    setExpiresInDays(null);
    setIssued(null);
  }

  async function submit(): Promise<void> {
    try {
      const created = await create.mutateAsync({
        name: name.trim(),
        scope: scopeFromChecks(checks.write, checks.move),
        expiresInDays,
      });
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
        // 表單畫面與明文畫面都擋點外面（表單型一律擋）。
        dismissOnOutside={false}
        // 明文只出現這一次（I2）：明文畫面擋掉 Esc 與點外面，誤觸會讓這支 token 直接報銷
        // （還吃掉 I1 的 20 額度）。只留 Done 與右上 X 這兩個明確的關閉動作。
        // 加了 dismissOnOutside 後，點外面已被它全程擋下；下方 onPointerDownOutside 與它重疊，
        // 只剩 onEscapeKeyDown 那支有獨立作用（表單畫面 Esc 仍可關、明文畫面 Esc 擋住）。
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
              <fieldset aria-label={t("settings.account.apiTokensScopeLabel")} className="space-y-2">
                <p className="text-sm">{t("settings.account.apiTokensScopeReadFixed")}</p>
                <ScopeTogglesField value={checks} onChange={setChecks} />
              </fieldset>
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

/** 權限 pill（只列有的）：讀取每列都有；編輯＝含 notes:write；搬移＝第三形（destructive 淡底）。 */
function TokenScopePills({ scope }: { scope: TokenScope }) {
  const { t } = useTranslation();
  const checks = checksFromScope(scope);
  return (
    <div className="flex flex-wrap gap-1">
      <Pill>{t("settings.authorization.tokens.pillRead")}</Pill>
      {checks.write && <Pill>{t("settings.authorization.tokens.pillEdit")}</Pill>}
      {checks.move && <Pill tone="destructive">{t("settings.authorization.tokens.pillMove")}</Pill>}
    </div>
  );
}

function useTokenDates(token: ApiTokenDto) {
  const { t, i18n } = useTranslation();
  const formatDate = (iso: string): string => new Date(iso).toLocaleDateString(i18n.language);
  const expired = token.expiresAt !== null && new Date(token.expiresAt).getTime() <= Date.now();
  const lastUsed = token.lastUsedAt === null ? t("settings.account.apiTokensNeverUsed") : formatDate(token.lastUsedAt);
  const expires =
    token.expiresAt === null
      ? t("settings.account.apiTokensNoExpiry")
      : expired
        ? t("settings.account.apiTokensExpired")
        : formatDate(token.expiresAt);
  return { lastUsed, expires, expired, created: t("settings.account.apiTokensCreated", { when: formatDate(token.createdAt) }) };
}

/**
 * 名稱欄（不可改）。名稱是外部字串（oauth 列是 client 自述）——bidi 隔離，避免 U+202E 之類的覆寫字元
 * 把下面那行「未經驗證」旁註在視覺上推走；oauth 列標「未經驗證」。
 */
function TokenNameCell({ token }: { token: ApiTokenDto }) {
  const { t } = useTranslation();
  const { created } = useTokenDates(token);
  return (
    <td className="py-2 pr-3">
      <div className="flex items-center gap-2">
        <span dir="ltr" className="truncate font-medium [unicode-bidi:isolate]">
          {token.name}
        </span>
        <span className="shrink-0 rounded border border-border px-1 text-xs text-muted-foreground">
          {token.kind === "oauth" ? t("settings.account.apiTokensKindOauth") : t("settings.account.apiTokensKindPat")}
        </span>
      </div>
      {token.kind === "oauth" && <p className="text-xs text-muted-foreground">{t("settings.account.apiTokensUnverifiedName")}</p>}
      <p className="text-xs text-muted-foreground">{created}</p>
    </td>
  );
}

function TokenViewRow({ token, locked, onEdit }: { token: ApiTokenDto; locked: boolean; onEdit: () => void }) {
  const { t } = useTranslation();
  const { lastUsed, expires, expired } = useTokenDates(token);
  // 灰字＝顯示的是從名稱派生的值（§5.3、§9.6）。接受的誤判：手動設成恰等於派生值時也灰——對外效果相同。
  const derived = token.agentLabel === deriveAgentLabel(token.name);
  return (
    <tr className="border-t border-border align-top">
      <TokenNameCell token={token} />
      <td className="py-2 pr-3">
        <span dir="ltr" className={cn("[unicode-bidi:isolate]", derived && "text-muted-foreground")}>
          {token.agentLabel}
        </span>
      </td>
      <td className="py-2 pr-3">
        <TokenScopePills scope={token.scope} />
      </td>
      <td className="py-2 pr-3 text-xs text-muted-foreground">{lastUsed}</td>
      <td className={cn("py-2 pr-3 text-xs", expired ? "text-destructive" : "text-muted-foreground")}>{expires}</td>
      <td className="whitespace-nowrap py-2 text-right">
        {/* 一次只編一列：別列在編輯時鉛筆停用（aria-disabled＋點不到＋不可聚焦）。 */}
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(ROW_ICON_BUTTON, locked && "pointer-events-none opacity-35")}
          title={t("settings.authorization.tokens.edit")}
          aria-label={t("settings.authorization.tokens.edit")}
          aria-disabled={locked || undefined}
          tabIndex={locked ? -1 : undefined}
          onClick={() => {
            if (!locked) onEdit();
          }}
        >
          <Pencil className="h-4 w-4" aria-hidden="true" />
        </Button>
        <RevokeDialog token={token} />
      </td>
    </tr>
  );
}

/**
 * 行內編輯態（§5.3）。名稱不可改，只有 label 一個輸入框＋兩個權限 toggle。label 改了才帶 `agentLabel`
 * （清空＝`null`：把欄位清成 NULL、回到派生值；server 的 `AGENT_LABEL_RE` 也不收空字串）、權限改了才帶
 * `scope`；都沒改就直接回顯示態。
 * Enter＝儲存。**沒有 Esc 取消**：這一列坐在設定面板的 `DialogContent` 裡，Radix 在 document 的 capture 階段
 * 監聽 Escape，input 的 `onKeyDown`（bubble）永遠來不及擋，結果是整個面板被關掉——「取消」鈕是唯一的退路。
 */
function TokenEditRow({ token, onDone }: { token: ApiTokenDto; onDone: () => void }) {
  const { t } = useTranslation();
  const update = useUpdateApiToken();
  const { lastUsed, expires, expired } = useTokenDates(token);
  const derivedLabel = deriveAgentLabel(token.name);
  const [label, setLabel] = useState(token.agentLabel);
  const [checks, setChecks] = useState<ScopeChecks>(() => checksFromScope(token.scope));
  const [error, setError] = useState<string | null>(null);

  async function save(): Promise<void> {
    // 一列同時只有一個請求在飛：輸入框與兩顆鈕在 pending 時都 disabled，這裡再擋一次（Enter 連按）。
    if (update.isPending) return;
    const trimmed = label.trim();
    const nextLabel = trimmed === "" ? null : trimmed;
    if (nextLabel !== null && !AGENT_LABEL_RE.test(nextLabel)) {
      setError(t("settings.authorization.tokens.labelInvalid"));
      return;
    }
    const patch: UpdateApiTokenPatch = {};
    // 清空：只有現值不是派生值（＝有覆寫）時才需要送 null。
    const labelChanged = nextLabel === null ? token.agentLabel !== derivedLabel : nextLabel !== token.agentLabel;
    if (labelChanged) patch.agentLabel = nextLabel;
    const scope = scopeFromChecks(checks.write, checks.move);
    if (scope !== token.scope) patch.scope = scope;
    if (Object.keys(patch).length === 0) {
      onDone();
      return;
    }
    setError(null);
    try {
      await update.mutateAsync({ id: token.id, patch });
      onDone();
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  return (
    <tr className="border-t border-border bg-brand-soft align-top">
      <TokenNameCell token={token} />
      <td className="py-2 pr-3">
        <Input
          autoFocus
          value={label}
          aria-label={t("settings.authorization.tokens.label")}
          maxLength={32}
          disabled={update.isPending}
          onFocus={event => event.currentTarget.select()}
          onChange={event => setLabel(event.target.value)}
          onKeyDown={event => {
            if (event.key === "Enter") void save();
          }}
        />
        <p className="mt-1 text-xs text-muted-foreground">
          {t("settings.authorization.tokens.editHint", { derived: derivedLabel })}
        </p>
        {error !== null && (
          <p role="alert" className="mt-1 text-xs text-destructive">
            {error}
          </p>
        )}
      </td>
      <td className="py-2 pr-3">
        <ScopeTogglesField value={checks} onChange={setChecks} disabled={update.isPending} />
      </td>
      <td className="py-2 pr-3 text-xs text-muted-foreground">{lastUsed}</td>
      <td className={cn("py-2 pr-3 text-xs", expired ? "text-destructive" : "text-muted-foreground")}>{expires}</td>
      <td className="whitespace-nowrap py-2 text-right">
        <Button type="button" variant="outline" size="sm" disabled={update.isPending} onClick={() => void save()}>
          {t("settings.authorization.tokens.save")}
        </Button>{" "}
        <Button type="button" variant="ghost" size="sm" disabled={update.isPending} onClick={onDone}>
          {t("settings.account.apiTokensCancel")}
        </Button>
      </td>
    </tr>
  );
}

/**
 * 設定→授權的「API token」段（#107；#247 §5.3 起是表格＋行內編輯）。
 *
 * **位置**：與 `HandleSection` 同層、在 `hasPassword` 三元式**之外**——SSO-only
 * 帳號也要能建 PAT（他們沒有密碼可用，更需要 token 這條路）。
 * 「一次只編一列」：`editingId` 持有正在編的那列；其餘列的鉛筆停用。
 */
export function ApiTokensSection() {
  const { t } = useTranslation();
  const tokens = useApiTokens();
  const [editingIdState, setEditingId] = useState<string | null>(null);
  // 正在編的那列被重抓掉了（別的分頁撤銷了它）：視為沒有在編，否則其餘列的鉛筆會永遠停用。衍生值即可，不必 effect。
  const editingId =
    editingIdState !== null && tokens.data?.some(token => token.id === editingIdState) === true ? editingIdState : null;

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
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="py-2 pr-3 font-medium">{t("settings.authorization.tokens.name")}</th>
                <th className="py-2 pr-3 font-medium">{t("settings.authorization.tokens.label")}</th>
                <th className="py-2 pr-3 font-medium">{t("settings.authorization.tokens.permissions")}</th>
                <th className="py-2 pr-3 font-medium">{t("settings.authorization.tokens.lastUsed")}</th>
                <th className="py-2 pr-3 font-medium">{t("settings.authorization.tokens.expires")}</th>
                <th className="py-2" />
              </tr>
            </thead>
            <tbody>
              {tokens.data.map(token =>
                token.id === editingId ? (
                  <TokenEditRow key={token.id} token={token} onDone={() => setEditingId(null)} />
                ) : (
                  <TokenViewRow
                    key={token.id}
                    token={token}
                    locked={editingId !== null}
                    onEdit={() => setEditingId(token.id)}
                  />
                )
              )}
            </tbody>
          </table>
        )}
        {/* 名稱與 label 的分野、清理提示都是看完自己有哪些 token 之後才用得上的附註，放在表格後面當註腳。 */}
        <p className="pt-1 text-xs text-muted-foreground">{t("settings.authorization.tokens.footnote")}</p>
        <p className="text-xs text-muted-foreground">{t("settings.account.apiTokensCleanupHint")}</p>
      </div>
    </SettingsGroup>
  );
}
