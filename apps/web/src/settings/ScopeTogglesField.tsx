import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "@/components/ui/switch";
import type { ScopeChecks } from "@/lib/token-scope";

/**
 * token 權限的兩個細 toggle（#247 §5.3、W22）：行內編輯與建立對話框共用。「讀取」一律包含，不列。
 * - switch 的可及名稱逐字用 #239 的 `settings.account.apiTokensScopeEdit`／`apiTokensScopeMove`（模型面字串引用它們，§12）。
 * - 關掉「編輯」→「搬移」disabled 並清為關（與 `scopeFromChecks(false, true) === "notes:read"` 同向）。
 * - 「搬移」用 `tone="destructive"`；開著時下方顯示 `apiTokensScopeMoveHint`（不可逆後果，#239 W10），關著時不顯示。
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
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2">
        <Switch
          id={editId}
          className="mt-1"
          checked={value.write}
          disabled={disabled}
          aria-label={t("settings.account.apiTokensScopeEdit")}
          onCheckedChange={(on) => onChange({ write: on, move: on ? value.move : false })}
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
    </div>
  );
}
