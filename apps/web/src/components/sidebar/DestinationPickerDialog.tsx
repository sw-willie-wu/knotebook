import "@/i18n/select-strings";
import { useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { ApiFail } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ChevronRight, Folder, Share, User, Users } from "@/components/ui/icons";
import type { DestItem, DestMode, DestPathStep, DestTarget } from "./destination-level";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** ApiFail → errors.<code>；其餘 → errors.fallback（各檔各自一份，是既有慣例）。 */
function errorMessage(t: Translate, err: unknown): string {
  if (err instanceof ApiFail) return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  return t("errors.fallback");
}

/**
 * 選取模式「移動到」「複製到」的目的地選擇框（資料夾 spec §6.10「批次的目的地」F16；沿用 PR-2c 的框）。
 * 一次只顯示**一層**：項目由 `buildDestinationLevel`（§6.11.1，與筆記 ⋮ 的逐層子選單共用）產生，path 由呼叫端持有，
 * 傳進來的是這一層的 `level` 與它的識別 `levelKey`。每項一顆按鈕（不做 tree 方向鍵，鍵盤用 Tab 走）：
 * 帶 `>` 的項目＝`onDrill`（框內換成下一層）、「‹ 返回」＝`onBack`、其他＝`onPick`（選定目的地）。
 * 只有 `levelKey` 變了（換層）才把清單捲回頂端、焦點給新層第一個未停用的項目；同一層重繪（資料夾重抓）不搬（總管裁定 2026-10-29 M2、M3）。
 * 選了就呼叫 `onPick`，關框與焦點交接由呼叫端決定（選了交給確認框、取消才還給開框鈕）。只准經 `SelectLazy` 引用。
 */
export function DestinationPickerDialog({
  mode,
  count,
  hasFolders,
  level,
  levelKey,
  error,
  open,
  onDrill,
  onBack,
  onPick,
  onOpenChange,
  onCloseAutoFocus,
}: {
  mode: DestMode;
  count: number;
  /** 選取含資料夾：描述用「{{count}} 項」（pickerDescriptionItems），否則「{{count}} 篇筆記」（pickerDescription）。 */
  hasFolders: boolean;
  /** null＝群組載入中。 */
  level: readonly DestItem[] | null;
  /** 目前這一層的識別（path 序列化，例如 JSON.stringify(path)）；只有它變了才搬焦點與捲回頂端（總管裁定 2026-10-29 M2）。 */
  levelKey: string;
  error: unknown;
  open: boolean;
  onDrill: (step: DestPathStep) => void;
  onBack: () => void;
  onPick: (target: DestTarget) => void;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const { t } = useTranslation();
  // 這一層有跨空間反灰的項目（選了資料夾、下半部的空間）：描述下方多一行同字，螢幕閱讀器看得到原因（disabled 鈕的 title 讀不到）。
  const crossSpace = level?.some((item) => item.kind !== "separator" && item.kind !== "back" && item.disabled === "crossSpace") ?? false;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t(mode === "move" ? "select.moveTo" : "select.copyTo")}</DialogTitle>
          <DialogDescription>{t(hasFolders ? "select.pickerDescriptionItems" : "select.pickerDescription", { count })}</DialogDescription>
          {crossSpace && <p className="text-sm text-muted-foreground">{t("select.foldersOnlyWithinSpace")}</p>}
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {errorMessage(t, error)}
          </p>
        ) : level === null ? (
          <p className="text-sm text-muted-foreground">{t("app.loading")}</p>
        ) : (
          <DestinationLevelList level={level} levelKey={levelKey} onDrill={onDrill} onBack={onBack} onPick={onPick} />
        )}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t("share.move.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 項目前導圖示：空間項依空間（個人 `User`、群組 `Users`、共享 `Share`）、資料夾項 `Folder`；返回、根目錄、放進這裡、建立副本不放。 */
function itemIcon(item: DestItem): typeof Folder | null {
  if (item.kind === "folder") return Folder;
  if (item.kind !== "space" || item.target.kind !== "place") return null;
  const { space } = item.target;
  if (space.kind === "personal") return User;
  return space.kind === "group" ? Users : Share;
}

/**
 * 一層的清單。掛在對話框內容裡（關框即卸載），掛上那次不搬焦點（交給 Radix 開框的自動聚焦）；之後 `levelKey` 每變一次，
 * 清單捲回頂端、焦點給第一個未停用的項目（第二層起即「‹ 返回」）。「‹ 」是 `aria-hidden` 的字：畫面「‹ 返回」、可及名稱「返回」。
 */
function DestinationLevelList({
  level,
  levelKey,
  onDrill,
  onBack,
  onPick,
}: {
  level: readonly DestItem[];
  levelKey: string;
  onDrill: (step: DestPathStep) => void;
  onBack: () => void;
  onPick: (target: DestTarget) => void;
}) {
  const { t } = useTranslation();
  const listRef = useRef<HTMLUListElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);
  const prevKey = useRef(levelKey);
  useLayoutEffect(() => {
    if (prevKey.current === levelKey) return;
    prevKey.current = levelKey;
    if (listRef.current) listRef.current.scrollTop = 0;
    firstRef.current?.focus();
  }, [levelKey]);
  const firstEnabled = level.findIndex((item) => item.kind === "back" || (item.kind !== "separator" && item.disabled === null));
  return (
    <ul ref={listRef} className="max-h-80 space-y-0.5 overflow-y-auto">
      {level.map((item, position) => {
        if (item.kind === "separator") return <li key={item.key} role="separator" className="my-1 h-px bg-border" />;
        const drill = item.kind === "folder" || item.kind === "space" ? item.drill : null;
        const disabled = item.kind === "back" ? null : item.disabled;
        const Icon = itemIcon(item);
        return (
          <li key={item.key}>
            <Button
              ref={position === firstEnabled ? firstRef : undefined}
              type="button"
              variant="ghost"
              className="w-full justify-start gap-2"
              aria-label={item.accessibleName}
              disabled={disabled !== null}
              title={disabled === "crossSpace" ? t("select.foldersOnlyWithinSpace") : undefined}
              onClick={() => {
                if (item.kind === "back") onBack();
                else if (drill !== null) onDrill(drill);
                else onPick(item.target);
              }}
            >
              {Icon !== null && <Icon aria-hidden="true" className="h-4 w-4 shrink-0" />}
              <span className="truncate">
                {item.kind === "back" && <span aria-hidden="true">‹ </span>}
                {item.label}
              </span>
              {drill !== null && <ChevronRight aria-hidden="true" className="ml-auto h-4 w-4 shrink-0" />}
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
