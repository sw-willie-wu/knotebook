import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AGENT_LABEL_RE, deriveAgentLabel, OAUTH_APP_IDLE_DAYS, type ApiTokenDto, type TokenScope } from "@knotebook/shared";
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
import { SettingsTable, type SettingsTableColumn, type SettingsTableRow } from "@/components/management/SettingsTable";
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
import { Check, Pencil, Trash, X } from "@/components/ui/icons";
import { Input } from "@/components/ui/input";
import { RowIconButton } from "@/components/ui/row-icon-button";
import { toast } from "@/components/ui/toast";
import { copyText } from "@/lib/clipboard";
import { displayExpiry } from "@/lib/token-expiry";
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

/** 撤銷確認（比照 SettingsAiSection 的 DeleteProviderDialog）。觸發鈕是列尾的紅垃圾桶 `RowIconButton`（spec 2026-10-13 settings-table §2.7）。 */
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
        <RowIconButton label={t("settings.account.apiTokensRevoke")} tone="destructive" icon={<Trash className="h-4 w-4" aria-hidden="true" />} />
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

/** 一列的日期文字（純函式：列在 `ApiTokensSection` 的 map 裡建，不能呼叫 hook）。 */
function tokenDates(token: ApiTokenDto, t: (key: string, opts?: Record<string, unknown>) => string, language: string) {
  const formatDate = (iso: string): string => new Date(iso).toLocaleDateString(language);
  const expiresAt = displayExpiry(token, OAUTH_APP_IDLE_DAYS);
  const expired = expiresAt !== null && new Date(expiresAt).getTime() <= Date.now();
  const lastUsed = token.lastUsedAt === null ? t("settings.account.apiTokensNeverUsed") : formatDate(token.lastUsedAt);
  const expires =
    expiresAt === null
      ? t("settings.account.apiTokensNoExpiry")
      : expired
        ? t("settings.account.apiTokensExpired")
        : formatDate(expiresAt);
  return { lastUsed, expires, expired, created: t("settings.account.apiTokensCreated", { when: formatDate(token.createdAt) }) };
}

/**
 * 行內編輯的表單（§5.3；放進 `SettingsTable` 的 editing 列：主欄保留、其餘欄合併成這一格，spec 2026-10-13 settings-table §2.6）。
 * 名稱不可改，只有 label 一個輸入框＋兩個權限 toggle。label 改了才帶 `agentLabel`（清空＝`null`：把欄位清成 NULL、回到派生值；
 * server 的 `AGENT_LABEL_RE` 也不收空字串）、權限改了才帶 `scope`；都沒改就直接回顯示態。存檔／取消是表單最右的兩顆 icon 鈕（勾、叉）。
 * Enter＝儲存。**沒有 Esc 取消**：這一列坐在設定面板的 `DialogContent` 裡，Radix 在 document 的 capture 階段
 * 監聽 Escape，input 的 `onKeyDown`（bubble）永遠來不及擋，結果是整個面板被關掉——「取消」鈕是唯一的退路。
 */
function TokenEditForm({ token, onDone }: { token: ApiTokenDto; onDone: () => void }) {
  const { t } = useTranslation();
  const update = useUpdateApiToken();
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
    <div className="flex flex-wrap items-start gap-3">
      <div className="min-w-[14ch] flex-1 space-y-1">
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
        <p className="text-xs text-muted-foreground">{t("settings.authorization.tokens.editHint", { derived: derivedLabel })}</p>
        {error !== null && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
      <ScopeTogglesField value={checks} onChange={setChecks} disabled={update.isPending} />
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <RowIconButton
          label={t("settings.authorization.tokens.save")}
          icon={<Check className="h-4 w-4" aria-hidden="true" />}
          disabled={update.isPending}
          onClick={() => void save()}
        />
        <RowIconButton
          label={t("settings.account.apiTokensCancel")}
          icon={<X className="h-4 w-4" aria-hidden="true" />}
          disabled={update.isPending}
          onClick={onDone}
        />
      </div>
    </div>
  );
}

/**
 * 設定→授權的「API token」段（#107；#247 §5.3 起是表格＋行內編輯；spec 2026-10-13 settings-table §3 #9 起是 `SettingsTable`）。
 *
 * **位置**：與 `HandleSection` 同層、在 `hasPassword` 三元式**之外**——SSO-only
 * 帳號也要能建 PAT（他們沒有密碼可用，更需要 token 這條路）。
 * 「一次只編一列」：`editingId` 持有正在編的那列；其餘列的鉛筆 softDisabled＋原因（可聚焦，spec §2.7）。
 * 欄：名稱（kind 標籤；副標＝建立日、oauth 的「未驗證名稱」）｜Label（派生值灰字）｜權限｜最後使用｜到期（過期紅；oauth 列以 `displayExpiry` 計算，#298）｜操作（編輯、撤銷）。
 */
export function ApiTokensSection() {
  const { t, i18n } = useTranslation();
  const tokens = useApiTokens();
  const [editingIdState, setEditingId] = useState<string | null>(null);
  // 正在編的那列被重抓掉了（別的分頁撤銷了它）：視為沒有在編，否則其餘列的鉛筆會永遠停用。衍生值即可，不必 effect。
  const editingId =
    editingIdState !== null && tokens.data?.some(token => token.id === editingIdState) === true ? editingIdState : null;

  const columns: SettingsTableColumn[] = [
    { id: "name", header: t("settings.authorization.tokens.name"), kind: "primary" },
    { id: "label", header: t("settings.authorization.tokens.label"), kind: "text" },
    { id: "permissions", header: t("settings.authorization.tokens.permissions"), kind: "text" },
    { id: "lastUsed", header: t("settings.authorization.tokens.lastUsed"), kind: "fixed" },
    { id: "expires", header: t("settings.authorization.tokens.expires"), kind: "fixed" },
    { id: "actions", header: t("settings.authorization.tokens.actions"), kind: "actions", buttons: 2 },
  ];
  const rows: SettingsTableRow[] = (tokens.data ?? []).map(token => {
    const dates = tokenDates(token, t, i18n.language);
    // 灰字＝顯示的是從名稱派生的值（§5.3、§9.6）。接受的誤判：手動設成恰等於派生值時也灰——對外效果相同。
    const derived = token.agentLabel === deriveAgentLabel(token.name);
    return {
      id: token.id,
      primary: {
        // 名稱是外部字串（oauth 列是 client 自述）——SettingsTable 一律 bidi 隔離；oauth 列另標「未經驗證」。
        name: token.name,
        weight: "medium",
        badges: (
          <span className="shrink-0 rounded border border-border px-1 text-xs text-muted-foreground">
            {token.kind === "oauth" ? t("settings.account.apiTokensKindOauth") : t("settings.account.apiTokensKindPat")}
          </span>
        ),
        subtitles: token.kind === "oauth" ? [dates.created, t("settings.account.apiTokensUnverifiedName")] : [dates.created],
      },
      cells: {
        label: (
          <span dir="ltr" className={cn("[unicode-bidi:isolate]", derived && "text-muted-foreground")}>
            {token.agentLabel}
          </span>
        ),
        permissions: <TokenScopePills scope={token.scope} />,
        lastUsed: { content: dates.lastUsed, tone: "muted" },
        expires: { content: dates.expires, tone: dates.expired ? "danger" : "muted" },
      },
      actions: (
        <>
          <RowIconButton
            label={t("settings.authorization.tokens.edit")}
            icon={<Pencil className="h-4 w-4" aria-hidden="true" />}
            softDisabled={editingId !== null}
            softDisabledReason={t("settings.authorization.tokens.editLocked")}
            onClick={() => setEditingId(token.id)}
          />
          <RevokeDialog token={token} />
        </>
      ),
      editing: token.id === editingId ? <TokenEditForm token={token} onDone={() => setEditingId(null)} /> : undefined,
    };
  });

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
        {tokens.data !== undefined && (
          <SettingsTable label={t("settings.account.apiTokensTitle")} columns={columns} rows={rows} empty={t("settings.account.apiTokensEmpty")} />
        )}
        {/* 名稱與 label 的分野、清理提示都是看完自己有哪些 token 之後才用得上的附註，放在表格後面當註腳。 */}
        <p className="pt-1 text-xs text-muted-foreground">{t("settings.authorization.tokens.footnote")}</p>
        <p className="text-xs text-muted-foreground">{t("settings.authorization.tokens.oauthExpiryNote", { days: OAUTH_APP_IDLE_DAYS })}</p>
        <p className="text-xs text-muted-foreground">{t("settings.account.apiTokensCleanupHint")}</p>
      </div>
    </SettingsGroup>
  );
}
