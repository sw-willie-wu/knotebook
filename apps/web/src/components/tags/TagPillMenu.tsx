import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TAG_COLORS, isTagColor, type NoteTagDto } from "@knotebook/shared";
import { useQueryClient } from "@tanstack/react-query";
import { errorMessage } from "@/api/favorites";
import { useUpdateTag, type TagSpaceRef } from "@/api/tags";
import { Check } from "@/components/ui/icons";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuItemIndicator,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toast } from "@/components/ui/toast";
import "@/i18n/tags-strings";
import { RenameTagDialog } from "./RenameTagDialog";
import { TagPill } from "./TagPill";
import { isTagGone, refreshAfterTagGone } from "./tag-gone";

export interface TagPillMenuProps {
  tag: NoteTagDto;
  space: TagSpaceRef;
  /** Rename and recolor change the space's list, which only its managers may do. */
  canManage: boolean;
  onRemove: () => void;
  removeDisabled?: boolean;
}

/** The pill of a tag the viewer can detach, with the menu behind its name. Lazy: the dialog and the strings stay out of the entry bundle. */
export default function TagPillMenu({ tag, space, canManage, onRemove, removeDisabled }: TagPillMenuProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const update = useUpdateTag(space);
  const [renameOpen, setRenameOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const colorLabelId = useId();

  function recolor(value: string): void {
    if (!isTagColor(value) || value === tag.color) return;
    update.mutate(
      { tagId: tag.id, color: value },
      {
        onError: (err) => {
          if (isTagGone(err)) refreshAfterTagGone(queryClient, space);
          toast({ title: isTagGone(err) ? t("errors.tag_not_found") : errorMessage(t, err), variant: "destructive" });
        },
      },
    );
  }

  return (
    <>
      <DropdownMenu phoneSheet>
        <TagPill
          tag={tag}
          onRemove={onRemove}
          removeDisabled={removeDisabled}
          wrapLabel={(label) => (
            <DropdownMenuTrigger asChild ref={triggerRef}>
              {label}
            </DropdownMenuTrigger>
          )}
        />
        <DropdownMenuContent align="start" sheetTitle={tag.name} onCloseAutoFocus={(event) => (renameOpen ? event.preventDefault() : undefined)}>
          {canManage && (
            <>
              <DropdownMenuItem onSelect={() => setRenameOpen(true)}>{t("tagPillMenu.rename")}</DropdownMenuItem>
              <DropdownMenuLabel id={colorLabelId} className="text-xs font-normal text-muted-foreground">
                {t("tagPillMenu.color")}
              </DropdownMenuLabel>
              <DropdownMenuRadioGroup value={tag.color} onValueChange={recolor} aria-labelledby={colorLabelId} className="flex flex-wrap gap-2 px-2 py-1.5 pointer-coarse:gap-4">
                {TAG_COLORS.map((color) => (
                  <DropdownMenuRadioItem
                    key={color}
                    value={color}
                    data-tag-color={color}
                    textValue={t(`tags.colors.${color}`)}
                    aria-label={t(`tags.colors.${color}`)}
                    title={t(`tags.colors.${color}`)}
                    // Keep the menu open so colors can be compared.
                    onSelect={(event) => event.preventDefault()}
                    className="relative flex size-4 items-center justify-center rounded-full bg-[var(--tag-dot)] ring-offset-2 ring-offset-popover data-[highlighted]:ring-2 data-[highlighted]:ring-foreground pointer-coarse:size-7 pointer-coarse:after:absolute pointer-coarse:after:-inset-2 pointer-coarse:after:content-['']"
                  >
                    <DropdownMenuItemIndicator>
                      <Check aria-hidden className="size-3 text-popover" />
                    </DropdownMenuItemIndicator>
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <p className="px-2 pb-1 text-xs text-muted-foreground">{t("tagPillMenu.appliesAll")}</p>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem disabled={removeDisabled} onSelect={onRemove}>
            {t("tagPillMenu.removeHere")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {canManage && <RenameTagDialog tag={tag} space={space} open={renameOpen} onOpenChange={setRenameOpen} returnFocusRef={triggerRef} />}
    </>
  );
}
