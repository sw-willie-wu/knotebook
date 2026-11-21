import { lazy, Suspense, useId, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { isCustomColor, type NoteTagDto, type TagCustomColor } from "@knotebook/shared";
import { ApiFail } from "@/api/client";
import "@/i18n/tags-strings";
import { useUpdateTag, type TagSpaceRef } from "@/api/tags";
import { parseHexInput } from "@/components/editor/colors/hex-input";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { pushRecentColor, readRecentColors } from "@/lib/recent-colors";
import type { CustomTagColorDialogProps } from "./CustomTagColorDialogLoader";
import { TagPill } from "./TagPill";
import { isTagGone, refreshAfterTagGone } from "./tag-gone";

const ColorfulPicker = lazy(() => import("@/components/editor/colors/ColorfulPicker"));

function CustomColorForm({ tag, space, onDone }: { tag: NoteTagDto; space: TagSpaceRef; onDone: () => void }) {
  const { t } = useTranslation();
  const update = useUpdateTag(space);
  const queryClient = useQueryClient();
  const errorId = useId();
  const [text, setText] = useState(() => (isCustomColor(tag.color) ? tag.color : (readRecentColors()[0] ?? "#")));
  const [shown, setShown] = useState<TagCustomColor | undefined>(() => (parseHexInput(text) as TagCustomColor | null) ?? undefined);
  const [recent] = useState(readRecentColors);
  const [error, setError] = useState<string | null>(null);
  const parsed = parseHexInput(text) as TagCustomColor | null;
  // Only "#" or blank means nothing typed yet: not flagged as an error, but can't be applied.
  const invalid = parsed === null && text.trim() !== "" && text.trim() !== "#";

  const choose = (value: string) => {
    setText(value);
    const hex = parseHexInput(value) as TagCustomColor | null;
    if (hex) setShown(hex);
  };

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (parsed === null) return;
    setError(null);
    if (parsed === tag.color) {
      pushRecentColor(parsed);
      return onDone();
    }
    try {
      await update.mutateAsync({ tagId: tag.id, color: parsed });
      pushRecentColor(parsed);
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

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      {/* kb-color-panel: the picker's pointer and inset rules in panel.css are scoped to it. */}
      <div className="kb-color-panel flex justify-center">
        <Suspense fallback={<div className="h-[200px] w-[200px]" />}>
          <ColorfulPicker color={shown} onChange={choose} saturationLabel={t("colors.saturation_label")} hueLabel={t("colors.hue_label")} />
        </Suspense>
      </div>
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-1 basis-0 justify-center" aria-hidden="true">
          <TagPill tag={{ ...tag, color: parsed ?? shown ?? tag.color }} />
        </div>
        <Input
          value={text}
          onChange={(e) => choose(e.target.value)}
          aria-label={t("colors.hex_label")}
          placeholder={t("colors.hex_placeholder")}
          aria-invalid={invalid ? true : undefined}
          aria-describedby={invalid ? errorId : undefined}
          spellCheck={false}
          autoComplete="off"
          className={invalid ? "w-32 border-destructive" : "w-32"}
        />
      </div>
      {invalid && (
        <p id={errorId} className="text-xs text-destructive">
          {t("colors.hex_invalid")}
        </p>
      )}
      {recent.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs text-muted-foreground">{t("colors.recent")}</p>
          <div className="flex flex-wrap gap-1">
            {recent.map((hex) => (
              <button
                key={hex}
                type="button"
                aria-label={hex}
                title={hex}
                onClick={() => choose(hex)}
                className="size-6 cursor-pointer rounded-sm border border-input focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                style={{ backgroundColor: hex }}
              />
            ))}
          </div>
        </div>
      )}
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
        <Button type="submit" variant="brandDeep" disabled={parsed === null || update.isPending}>
          {t("colors.apply")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The form mounts only while the dialog is open, so each open starts from the tag's current color. */
export default function CustomTagColorDialog({ tag, space, open, onOpenChange, returnFocusRef }: CustomTagColorDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        dismissOnOutside={false}
        className="max-w-sm"
        onCloseAutoFocus={(event) => {
          const target = returnFocusRef?.current;
          if (!target) return;
          event.preventDefault();
          target.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t("tagColor.title")}</DialogTitle>
          <DialogDescription>{t("tagColor.description", { name: tag.name })}</DialogDescription>
        </DialogHeader>
        <CustomColorForm tag={tag} space={space} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}
