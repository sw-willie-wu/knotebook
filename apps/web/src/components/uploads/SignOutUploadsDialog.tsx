import "@/i18n/upload-list-strings";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export interface SignOutUploadsDialogProps {
  /** Must not reject: it reports its own failure. */
  onConfirm: () => Promise<void>;
  onCancel: () => void;
  onCloseAutoFocus: (event: Event) => void;
}

/** Cancel is the first footer child so the safe action gets initial focus. */
export function SignOutUploadsDialog({ onConfirm, onCancel, onCloseAutoFocus }: SignOutUploadsDialogProps) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !pending) onCancel();
      }}
    >
      <DialogContent onCloseAutoFocus={onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t("uploadList.signOutTitle")}</DialogTitle>
          <DialogDescription>{t("uploadList.signOutDescription")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={pending}>
              {t("home.cancel")}
            </Button>
          </DialogClose>
          <Button
            type="button"
            variant="destructive"
            disabled={pending}
            onClick={() => {
              setPending(true);
              void onConfirm().finally(() => setPending(false));
            }}
          >
            {t("userMenu.logout")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
