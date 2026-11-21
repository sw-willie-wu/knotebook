import { lazy, Suspense, useEffect, useState, type ComponentType, type ReactElement, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { NoteTagDto } from "@knotebook/shared";
import type { TagSpaceRef } from "@/api/tags";
import { toast } from "@/components/ui/toast";

export interface CustomTagColorDialogProps {
  tag: NoteTagDto;
  space: TagSpaceRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A controlled Dialog has no `DialogTrigger`, so Radix doesn't restore focus on close. */
  returnFocusRef?: RefObject<HTMLElement | null>;
}

export const CUSTOM_SWATCH_STYLE = { backgroundImage: "conic-gradient(#e03e3e, #dfab01, #4d9a3a, #0e87bc, #6940a5, #ad1a72, #e03e3e)" };

function ChunkFailed({ open, onOpenChange }: CustomTagColorDialogProps): ReactElement | null {
  const { t } = useTranslation();
  useEffect(() => {
    if (!open) return;
    toast({ title: t("errors.fallback"), variant: "destructive" });
    onOpenChange(false);
    // Once per open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return null;
}

// The picker and react-colorful stay out of the menus' chunks until someone asks for a custom color; a chunk that can't be fetched only closes the request.
const CustomTagColorDialog = lazy<ComponentType<CustomTagColorDialogProps>>(() => import("./CustomTagColorDialog").catch(() => ({ default: ChunkFailed })));

/** Mounts the dialog on its first open and keeps it mounted, so closing animates and returns focus like any other dialog. */
export function CustomTagColorDialogLoader(props: CustomTagColorDialogProps) {
  const [wanted, setWanted] = useState(props.open);
  if (props.open && !wanted) setWanted(true);
  if (!wanted) return null;
  return (
    <Suspense fallback={null}>
      <CustomTagColorDialog {...props} />
    </Suspense>
  );
}
