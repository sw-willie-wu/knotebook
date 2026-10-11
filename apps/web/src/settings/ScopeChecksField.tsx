import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";
import type { ScopeChecks } from "@/lib/token-scope";

/**
 * #239：「編輯」「移動或複製到群組」兩框（spec §9.1）。同意頁與建立 token 對話框共用同一套
 * 標籤（W10：`settings.account.apiTokensScopeEdit`／`apiTokensScopeMove`——MCP 模型面字串引用的
 * 就是這兩句，server 單元 `scope-labels-sync.test.ts` 逐字比對）與同一套連動：
 * 取消編輯 → 搬移 disabled 且清掉勾選。
 */
export function ScopeChecksField({
  value,
  onChange,
  showWrite = true,
  showMove = true,
  granted,
}: {
  value: ScopeChecks;
  onChange: (next: ScopeChecks) => void;
  showWrite?: boolean;
  showMove?: boolean;
  /** 同意頁 W8：已授予的項目旁標「目前已授予」。 */
  granted?: ScopeChecks;
}) {
  const { t } = useTranslation();
  const writeId = useId();
  const moveId = useId();
  const moveHintId = useId();
  return (
    <div className="space-y-2">
      {showWrite && (
        <div className="flex items-center gap-2">
          <Checkbox
            id={writeId}
            checked={value.write}
            onCheckedChange={c => onChange({ write: c === true, move: c === true ? value.move : false })}
          />
          <label htmlFor={writeId} className="text-sm">
            {t("settings.account.apiTokensScopeEdit")}
          </label>
          {granted?.write && <span className="text-xs text-muted-foreground">{t("authorize.currentlyGranted")}</span>}
        </div>
      )}
      {showMove && (
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Checkbox
              id={moveId}
              checked={value.move}
              disabled={!value.write}
              aria-describedby={moveHintId}
              onCheckedChange={c => onChange({ ...value, move: c === true && value.write })}
            />
            {/* Checkbox 本體帶 `peer`（ui/checkbox.tsx）：框 disabled 時標籤跟著變淡，與框的 disabled:opacity-50 一致。 */}
            <label htmlFor={moveId} className="text-sm peer-disabled:cursor-not-allowed peer-disabled:opacity-50">
              {t("settings.account.apiTokensScopeMove")}
            </label>
            {granted?.move && <span className="text-xs text-muted-foreground">{t("authorize.currentlyGranted")}</span>}
          </div>
          <p id={moveHintId} className="max-w-prose text-xs text-muted-foreground">
            {t("settings.account.apiTokensScopeMoveHint")}
          </p>
        </div>
      )}
    </div>
  );
}
