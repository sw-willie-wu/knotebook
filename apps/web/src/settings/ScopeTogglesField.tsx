import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "@/components/ui/switch";
import type { ScopeChecks } from "@/lib/token-scope";
import "@/i18n/management-strings";

/**
 * token 權限的三個細 toggle（#247 §5.3、W22；#181 加「刪除」）：行內編輯與建立對話框共用。「讀取」一律包含，不列。
 * - switch 的可及名稱逐字用 `settings.account.apiTokensScopeEdit`／`apiTokensScopeMove`／`apiTokensScopeDelete`（模型面字串引用它們，§12）。
 * - 關掉「編輯」→「搬移」「刪除」disabled 並清為關（與 `scopeFromChecks(false, …) === "notes:read"` 同向）。
 * - 「搬移」用 `tone="destructive"`（不可逆）；「刪除」用預設 tone（移到垃圾桶可還原）。各自開著時下方顯示後果說明
 *   （`apiTokensScopeMoveHint`／`apiTokensScopeDeleteHintRequiresEdit`，兩者都以「需同時勾選編輯」收尾）並 aria-describedby，關著時不顯示。
 * 建立對話框「按送出才生效」卻用 toggle 是 W22 的明文例外（見 ui/switch.tsx 檔頭）。OAuth 同意頁仍用 `ScopeChecksField`。
 */
export function ScopeTogglesField({
  value,
  onChange,
  disabled = false,
}: {
  value: ScopeChecks;
  onChange: (next: ScopeChecks) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  const editId = useId();
  const moveId = useId();
  const hintId = useId();
  const deleteId = useId();
  const deleteHintId = useId();
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <Switch
          id={editId}
          className="mt-1"
          checked={value.write}
          disabled={disabled}
          aria-label={t("settings.account.apiTokensScopeEdit")}
          onCheckedChange={(on) =>
            onChange({ write: on, move: on ? value.move : false, delete: on ? value.delete : false })
          }
        />
        <label htmlFor={editId} className="text-sm">
          <span className="font-medium">{t("settings.authorization.tokens.pillEdit")}</span>{" "}
          <span className="text-muted-foreground">{t("settings.account.apiTokensScopeEdit")}</span>
        </label>
      </div>
      <div className="flex items-start gap-2">
        <Switch
          id={moveId}
          className="mt-1"
          tone="destructive"
          checked={value.move}
          disabled={disabled || !value.write}
          aria-label={t("settings.account.apiTokensScopeMove")}
          aria-describedby={value.move ? hintId : undefined}
          onCheckedChange={(on) => onChange({ ...value, move: on && value.write })}
        />
        <label htmlFor={moveId} className="text-sm">
          <span className="font-medium">{t("settings.authorization.tokens.pillMove")}</span>{" "}
          <span className="text-muted-foreground">{t("settings.account.apiTokensScopeMove")}</span>
        </label>
      </div>
      {value.move && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {t("settings.account.apiTokensScopeMoveHint")}
        </p>
      )}
      <div className="flex items-start gap-2">
        <Switch
          id={deleteId}
          className="mt-1"
          checked={value.delete}
          disabled={disabled || !value.write}
          aria-label={t("settings.account.apiTokensScopeDelete")}
          aria-describedby={value.delete ? deleteHintId : undefined}
          onCheckedChange={(on) => onChange({ ...value, delete: on && value.write })}
        />
        <label htmlFor={deleteId} className="text-sm">
          <span className="font-medium">{t("settings.authorization.tokens.pillDelete")}</span>{" "}
          <span className="text-muted-foreground">{t("settings.account.apiTokensScopeDelete")}</span>
        </label>
      </div>
      {value.delete && (
        <p id={deleteHintId} className="text-xs text-muted-foreground">
          {t("settings.account.apiTokensScopeDeleteHintRequiresEdit", {
            hint: t("settings.account.apiTokensScopeDeleteHint"),
          })}
        </p>
      )}
    </div>
  );
}
