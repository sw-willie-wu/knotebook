import { useState, type FormEvent, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { normalizeTagName, type NoteTagDto } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import { useUpdateTag, type TagSpaceRef } from "@/api/tags";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { isTagGone, refreshAfterTagGone } from "./tag-gone";

function RenameForm({ tag, space, onDone }: { tag: NoteTagDto; space: TagSpaceRef; onDone: () => void }) {
  const { t } = useTranslation();
  const update = useUpdateTag(space);
  const queryClient = useQueryClient();
  const [name, setName] = useState(tag.name);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    const normalized = normalizeTagName(name);
    if (normalized === null) return setError(t("tags.nameInvalid"));
    if (normalized === tag.name) return onDone();
    try {
      await update.mutateAsync({ tagId: tag.id, name: normalized });
      onDone();
    } catch (err) {
      if (isTagGone(err)) {
        refreshAfterTagGone(queryClient, space);
        toast({ title: t("errors.tag_not_found"), variant: "destructive" });
        return onDone();
      }
      setError(err instanceof ApiFail ? t(`errors.${err.code}`, { defaultValue: t("errors.fallback") }) : t("errors.fallback"));
    }
  }

  const inputId = `rename-tag-${tag.id}`;
  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      <div className="space-y-1">
        <label htmlFor={inputId} className="text-sm font-medium">
          {t("tags.inputLabel")}
        </label>
        <Input id={inputId} value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
      </div>
      {error !== null && (
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
        <Button type="submit" variant="brandDeep" disabled={update.isPending}>
          {t("tags.manage.rename")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The form mounts only while the dialog is open, so each open starts from the current name. */
export function RenameTagDialog({
  tag,
  space,
  open,
  onOpenChange,
  returnFocusRef,
}: {
  tag: NoteTagDto;
  space: TagSpaceRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A controlled Dialog has no `DialogTrigger`, so Radix doesn't restore focus on close. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        dismissOnOutside={false}
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef?.current;
          if (!target) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("tags.manage.renameTitle")}</DialogTitle>
          <DialogDescription>{t("tags.manage.renameDescription")}</DialogDescription>
        </DialogHeader>
        <RenameForm tag={tag} space={space} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
