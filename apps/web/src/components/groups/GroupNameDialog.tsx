import { useState, type FormEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { GroupDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useCreateGroup, useRenameGroup } from "@/api/groups";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/** ApiFail → errors.<code>；其餘 → errors.fallback（逐檔各一份，repo 慣例）。 */
function errorMessage(t: (key: string, opts?: Record<string, unknown>) => string, err: unknown): string {
  if (err instanceof ApiFail) {
    return t(`errors.${err.code}`, { defaultValue: t("errors.fallback") });
  }
  return t("errors.fallback");
}

/** 與 server `validateGroupName` 同上限（1–80 個 code point）。`maxLength` 數的是 UTF-16 單元，
 * 對 emoji 會提早擋——那是體驗優化，server 才是裁決者（400 `invalid_name` 走下面的 alert）。 */
export const GROUP_NAME_MAX_LENGTH = 80;

type GroupNameDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 成功後（已 invalidate `['groups']`／`['notes']`）回傳 server 的 GroupDto。 */
  onSaved?: (group: GroupDto) => void;
  /** 關閉時把焦點還給誰（spec §8.2「焦點回工作坊「＋」」）。受控 Dialog 沒有 `DialogTrigger`，
   * Radix 自己不會還原焦點（它的 `onCloseAutoFocus` 預設只 `preventDefault`）——這裡手動做。 */
  returnFocusRef?: RefObject<HTMLElement | null>;
} & ({ mode: "create" } | { mode: "rename"; group: GroupDto });

/**
 * 新增／重新命名群組（spec §8.2，P11：Dialog 而非 Popover）。只問名稱：文字欄
 * `autoFocus`、`maxLength=80`；Enter 送出（form submit）、Escape 取消（Radix）。**受控**
 * （`open`／`onOpenChange`）——呼叫端（側欄工作坊「＋」、⋮ 的「重新命名」、設定頁）
 * 各自持有 open state；要「焦點回工作坊「＋」」的呼叫端傳 `returnFocusRef`（見該 prop）。
 *
 * ⚠ `useState` 的初值只在掛載時讀 `props.group.name`——呼叫端每次開啟都要重新掛載
 * （`{open && <GroupNameDialog … open />}`），否則改名對話框會帶著上一次的輸入。
 *
 * 錯誤（400 `invalid_name`、403、404…）留在對話框內 `role="alert"`，不關閉、不 toast。
 */
export function GroupNameDialog(props: GroupNameDialogProps) {
  const { t } = useTranslation();
  const { open, onOpenChange, onSaved, returnFocusRef } = props;
  const createGroup = useCreateGroup();
  const renameGroup = useRenameGroup();
  const [name, setName] = useState(props.mode === "rename" ? props.group.name : "");
  const [error, setError] = useState<string | null>(null);

  const trimmed = name.trim();
  const pending = createGroup.isPending || renameGroup.isPending;

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (trimmed.length === 0 || pending) return;
    setError(null);
    try {
      const saved =
        props.mode === "create"
          ? await createGroup.mutateAsync({ name: trimmed })
          : await renameGroup.mutateAsync({ id: props.group.id, name: trimmed });
      onSaved?.(saved);
      onOpenChange(false);
      if (props.mode === "create") setName("");
    } catch (err) {
      setError(errorMessage(t, err));
    }
  }

  const title = props.mode === "create" ? t("groups.dialog.createTitle") : t("groups.dialog.renameTitle");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent dismissOnOutside={false}
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef?.current;
          if (!target) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className={props.mode === "rename" ? "sr-only" : undefined}>
            {props.mode === "create" ? t("groups.dialog.createDescription") : t("groups.dialog.renameTitle")}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={(event) => void handleSubmit(event)} className="space-y-4">
          <div className="space-y-1">
            <label htmlFor="group-name-input" className="text-sm font-medium">
              {t("groups.dialog.nameLabel")}
            </label>
            <Input
              id="group-name-input"
              autoFocus
              maxLength={GROUP_NAME_MAX_LENGTH}
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-invalid={error !== null || undefined}
            />
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                {t("home.cancel")}
              </Button>
            </DialogClose>
            <Button type="submit" variant="brandDeep" disabled={trimmed.length === 0 || pending}>
              {props.mode === "create" ? t("groups.dialog.create") : t("groups.dialog.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
